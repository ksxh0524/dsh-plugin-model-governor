/** probe.test.ts —— S5 探测纯函数层单测（零宿主调用，打判定语义）：
 *  ① 参数归一/校验（缺省回填、越界逐条中文、未知键拒收）；
 *  ② 终端块分类（error/RATE_LIMIT→限流，QUOTA→失败，aborted→取消，stop→成功；
 *     文本型 429 回退识别）；
 *  ③ 抛错路径分类（abort 优先、码优先）；
 *  ④ 汇总（触顶=窗内成功数，未触顶只给下限、绝不编上限）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyFinishReason, classifyThrown, isQuotaFailure, isRateLimitFailure, normalizeProbeSpec, summarizeProbe, PROBE_DEFAULTS } from "../src/probe.ts";

const HAS_CHINESE = /[一-鿿]/;

test("normalizeProbeSpec：缺省回填 + provider 必填", () => {
  const good = normalizeProbeSpec({ provider: "  opencode " });
  assert.equal(good.errors.length, 0);
  assert.equal(good.spec?.provider, "opencode");
  assert.equal(good.spec?.phaseA, PROBE_DEFAULTS.phaseA);
  assert.deepEqual(good.spec?.bursts, [...PROBE_DEFAULTS.bursts]);
  assert.equal(good.spec?.model, undefined);
  // maxTokens 缺省 16（远端网关常拒 max_completion_tokens:1，见 400 回归）。
  assert.equal(good.spec?.maxTokens, 16);
  const custom = normalizeProbeSpec({ provider: "p", maxTokens: 5 });
  assert.equal(custom.errors.length, 0);
  assert.equal(custom.spec?.maxTokens, 5);
  const missing = normalizeProbeSpec({});
  assert.ok(missing.errors.length > 0);
  for (const message of missing.errors) assert.match(message, HAS_CHINESE);
  const empty = normalizeProbeSpec({ provider: "  " });
  assert.ok(empty.errors.length > 0);
});

test("normalizeProbeSpec：越界与未知键逐条中文拒收", () => {
  const bad = normalizeProbeSpec({ provider: "p", phaseA: 0, bursts: [8, 999], bogus: 1, durationMs: 1000, maxTokens: 0 });
  assert.ok(bad.errors.length >= 5, `期望≥5 条，实得：${JSON.stringify(bad.errors)}`);
  for (const message of bad.errors) assert.match(message, HAS_CHINESE);
  assert.match(bad.errors.join("；"), /未知探测参数/);
  assert.match(bad.errors.join("；"), /maxTokens/);
  // 空 bursts 合法（跳过 B 阶段）。
  assert.equal(normalizeProbeSpec({ provider: "p", bursts: [] }).errors.length, 0);
});

test("isRateLimitFailure：码优先、文本回退（宿主 pi-ai 同款正则）", () => {
  assert.equal(isRateLimitFailure("RATE_LIMIT", "anything"), true);
  assert.equal(isRateLimitFailure("SERVER", "request failed with 429"), true);
  assert.equal(isRateLimitFailure("SERVER", "Rate limit exceeded"), true);
  assert.equal(isRateLimitFailure("SERVER", "ratelimited"), true);
  assert.equal(isRateLimitFailure("AUTH", "invalid api key"), false);
  assert.equal(isRateLimitFailure(undefined, undefined), false);
});

test("isQuotaFailure：配额见底另算（绝不能当 RPM）", () => {
  assert.equal(isQuotaFailure("QUOTA", "x"), true);
  assert.equal(isQuotaFailure("SERVER", "insufficient quota"), true);
  assert.equal(isQuotaFailure("SERVER", "out of credits"), true);
  assert.equal(isQuotaFailure("RATE_LIMIT", "rate limit"), false);
});

test("classifyFinishReason：终端块四路判定", () => {
  assert.deepEqual(classifyFinishReason({ kind: "stop" }), { outcome: "success" });
  assert.deepEqual(classifyFinishReason({ kind: "max-tokens" }), { outcome: "success" });
  assert.deepEqual(classifyFinishReason({ kind: "aborted", failure: { code: "ABORTED", message: "x" } }), { outcome: "cancelled" });
  assert.deepEqual(classifyFinishReason({ kind: "error", failure: { code: "RATE_LIMIT", message: "slow down" } }), { outcome: "rateLimited" });
  assert.deepEqual(classifyFinishReason({ kind: "error", failure: { code: "SERVER", message: "boom 429" } }), { outcome: "rateLimited" });
  const quota = classifyFinishReason({ kind: "error", failure: { code: "QUOTA", message: "out of credits" } });
  assert.equal(quota.outcome, "failed");
  if (quota.outcome === "failed") assert.equal(quota.code, "QUOTA");
});

test("classifyThrown：abort 优先于码", () => {
  assert.deepEqual(classifyThrown(new Error("whatever"), true), { outcome: "cancelled" });
  assert.deepEqual(classifyThrown(Object.assign(new Error("slow"), { code: "RATE_LIMIT" }), false), { outcome: "rateLimited" });
  const failed = classifyThrown(new Error("nope"), false);
  assert.equal(failed.outcome, "failed");
});

test("summarizeProbe：触顶=触顶时刻前 60s 窗内成功数", () => {
  // 成功时刻 0/11s/20s，70s 处触顶：0s 的掉出窗，估计=2。
  const topped = summarizeProbe({ successTimes: [0, 11_000, 20_000], limitedAt: 70_000, startedAt: 0, now: 70_000 });
  assert.equal(topped.topped, true);
  assert.equal(topped.estimate, 2);
  // 探测 <60s：累计即窗内。
  const quick = summarizeProbe({ successTimes: [1000, 2000, 3000], limitedAt: 5000, startedAt: 0, now: 5000 });
  assert.equal(quick.estimate, 3);
});

test("summarizeProbe：未触顶只给下限（耗时折算、不超累计）", () => {
  // 60 个全过、用 15s：折算 240，但累计只有 60 → 下限 60（绝不编 240 当上限）。
  const fast = summarizeProbe({ successTimes: Array.from({ length: 60 }, (_, i) => i * 250), limitedAt: null, startedAt: 0, now: 15_000 });
  assert.equal(fast.topped, false);
  assert.equal(fast.lowerBound, 60);
  assert.equal(fast.estimate, undefined);
  // 慢速：10 个用 60s → 下限 10。
  const slow = summarizeProbe({ successTimes: Array.from({ length: 10 }, (_, i) => i * 6000), limitedAt: null, startedAt: 0, now: 60_000 });
  assert.equal(slow.lowerBound, 10);
});
