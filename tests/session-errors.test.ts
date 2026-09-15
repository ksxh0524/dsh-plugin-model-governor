/** S3 单测：session 兼容头机制 + 错误翻译文案 + 思考强度纯合并。
 *
 * 设计意图：header 部分用真 AsyncLocalStorage 断“函数级真实语义”（已有头不覆盖、
 * 无 store 透传、uuid 进程内稳定、withStore 的 return/throw 透传进下游生成器）；
 * provider 过滤由 cordis 层保证，不在此测。错误翻译断三类中文可行动文案 + 未知码
 * 直通；thinking 断覆盖优先级与非法默认档丢弃记 issue、mutate 双路由分支形态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { SESSION_HEADER, headerValueFor, patchFetch, withStore, type SessionHeaderStore } from "../src/session-header.ts";
import { translateLlmError } from "../src/errors.ts";
import { buildDescribeInput, buildMutations, mergeThinking } from "../src/thinking.ts";

type Seen = { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] | undefined };

function stubFetch(seen: Seen[]): typeof fetch {
  // 以 fetch 同形签名承接补丁转调，杜绝 any 桩。
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seen.push({ input, init });
    return new Response("ok");
  }) as typeof fetch;
}

test("patchFetch：store 活跃且无头时并入会话头", async () => {
  const seen: Seen[] = [];
  const als = new AsyncLocalStorage<SessionHeaderStore>();
  const patched = patchFetch(stubFetch(seen), als);
  await als.run({ value: "sess-1" }, () => patched("https://relay.test/v1", {}));
  assert.equal(seen.length, 1);
  assert.equal(new Headers(seen[0].init?.headers).get(SESSION_HEADER), "sess-1");
});

test("patchFetch：已有头不覆盖（init.headers 与 Request 两种携带位）", async () => {
  const seen: Seen[] = [];
  const als = new AsyncLocalStorage<SessionHeaderStore>();
  const patched = patchFetch(stubFetch(seen), als);
  await als.run({ value: "sess-new" }, async () => {
    await patched("https://relay.test/v1", { headers: { [SESSION_HEADER]: "keep-me" } });
    await patched(new Request("https://relay.test/v1", { headers: { [SESSION_HEADER]: "keep-req" } }));
  });
  assert.equal(seen.length, 2);
  assert.equal(new Headers(seen[0].init?.headers).get(SESSION_HEADER), "keep-me");
  // Request 自带头时补丁整体透传，不合成新 init。
  assert.equal(seen[1].init, undefined);
  assert.equal(seen[1].input instanceof Request, true);
  assert.equal((seen[1].input as Request).headers.get(SESSION_HEADER), "keep-req");
});

test("patchFetch：无 store 时原样透传（非目标 provider 由 cordis 层跳过，此处等价）", async () => {
  const seen: Seen[] = [];
  const als = new AsyncLocalStorage<SessionHeaderStore>();
  const patched = patchFetch(stubFetch(seen), als);
  await patched("https://other.test/v1", {});
  assert.equal(seen.length, 1);
  assert.equal(new Headers(seen[0].init?.headers).has(SESSION_HEADER), false);
});

test("headerValueFor：session-id 复用原 id，空串不产值", () => {
  const table = new Map<string, string>();
  assert.equal(headerValueFor("conv-42", "session-id", table), "conv-42");
  assert.equal(headerValueFor("", "session-id", table), undefined);
  assert.equal(table.size, 0);
});

test("headerValueFor：uuid 模式进程内按会话稳定、跨会话隔离", () => {
  const table = new Map<string, string>();
  const first = headerValueFor("s1", "uuid", table);
  const second = headerValueFor("s1", "uuid", table);
  const other = headerValueFor("s2", "uuid", table);
  assert.ok(first !== undefined && second !== undefined && other !== undefined);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("withStore：next 透传值且拉取发生在 store 内，return 透传下游收尾", async () => {
  const als = new AsyncLocalStorage<SessionHeaderStore>();
  let cleaned = false;
  let observed: string | undefined;
  async function* downstream(): AsyncGenerator<number> {
    try {
      observed = als.getStore()?.value;
      yield 1;
      yield 2;
    } finally {
      cleaned = true;
    }
  }
  const wrapped = withStore(downstream(), { value: "sess-9" }, als);
  assert.equal((await wrapped.next()).value, 1);
  assert.equal(observed, "sess-9");
  assert.equal((await wrapped.next()).value, 2);
  const fin = await wrapped.return();
  assert.equal(fin.done, true);
  assert.equal(cleaned, true);
});

test("withStore：throw 透传进下游生成器", async () => {
  const als = new AsyncLocalStorage<SessionHeaderStore>();
  async function* downstream(): AsyncGenerator<string> {
    try {
      yield "live";
    } catch (error) {
      yield `caught:${(error as Error).message}`;
    }
  }
  const wrapped = withStore(downstream(), { value: "sess-7" }, als);
  assert.equal((await wrapped.next()).value, "live");
  const after = await wrapped.throw(new Error("boom"));
  assert.equal(after.done, false);
  assert.equal(after.value, "caught:boom");
});

test("translateLlmError：UNKNOWN_MODEL 给查路由与改名指引", () => {
  const advice = translateLlmError("UNKNOWN_MODEL", { provider: "buzz", model: "nope-1" });
  assert.ok(advice.title.includes("buzz/nope-1"));
  assert.ok(advice.body.includes("modelOverrides"));
  assert.ok(advice.body.includes("models[]"));
  assert.ok(advice.actions.length >= 2);
  assert.ok(advice.actions.some((a) => a.includes("buzz")));
});

test("translateLlmError：UNSUPPORTED_REASONING_EFFORT 列出该模型支持档", () => {
  const advice = translateLlmError("UNSUPPORTED_REASONING_EFFORT", {
    provider: "buzz",
    model: "m-1",
    efforts: ["low", "medium", "xhigh"],
  });
  assert.ok(advice.body.includes("low、medium、xhigh"));
  assert.ok(advice.body.includes("静默丢弃"));
  assert.ok(advice.actions.some((a) => a.includes("low / medium / xhigh")));
  const nonReasoning = translateLlmError("UNSUPPORTED_REASONING_EFFORT", { provider: "p", model: "m" });
  assert.ok(nonReasoning.body.includes("非推理模型"));
});

test("translateLlmError：RATE_LIMIT 提示配 RPM", () => {
  const advice = translateLlmError("RATE_LIMIT", { provider: "buzz", model: "m-1" });
  assert.ok(advice.body.includes("429"));
  assert.ok(advice.body.includes("RPM"));
  assert.ok(advice.actions.some((a) => a.includes("RPM")));
});

test("translateLlmError：未知 code 原文直通", () => {
  assert.deepEqual(translateLlmError("SOME_WEIRD_CODE", { provider: "p", model: "m" }), {
    title: "SOME_WEIRD_CODE",
    body: "SOME_WEIRD_CODE",
    actions: [],
  });
});

test("buildDescribeInput：归一化去空（缺省=查全部）", () => {
  assert.deepEqual(buildDescribeInput(undefined, undefined), {});
  assert.deepEqual(buildDescribeInput("  buzz  ", "  "), { provider: "buzz" });
  assert.deepEqual(buildDescribeInput(42, null), {});
  assert.deepEqual(buildDescribeInput("p", "m"), { provider: "p", model: "m" });
});

test("mergeThinking：无覆盖跟随自带；覆盖档位与默认档优先", () => {
  const info = { efforts: ["low", "high"], defaultEffort: "low" };
  const plain = mergeThinking(info, {});
  assert.deepEqual(plain.efforts, ["low", "high"]);
  assert.equal(plain.defaultEffort, "low");
  assert.deepEqual(plain.issues, []);
  const covered = mergeThinking(info, { efforts: ["low", "medium", "xhigh"], defaultEffort: "xhigh" });
  assert.deepEqual(covered.efforts, ["low", "medium", "xhigh"]);
  assert.equal(covered.defaultEffort, "xhigh");
  assert.deepEqual(covered.issues, []);
});

test("mergeThinking：生效默认档不在生效档位内则丢弃并记 issue", () => {
  const dropped = mergeThinking({ efforts: ["low", "high"], defaultEffort: "xhigh" }, { efforts: ["low", "medium"] });
  assert.deepEqual(dropped.efforts, ["low", "medium"]);
  assert.equal(dropped.defaultEffort, undefined);
  assert.equal(dropped.issues.length, 1);
  assert.ok(dropped.issues[0].includes("xhigh"));
  assert.ok(dropped.issues[0].includes("UNSUPPORTED_REASONING_EFFORT"));
});

test("buildMutations：目录路由走 modelOverrides，默认档走路由级 reasoning", () => {
  const ops = buildMutations({
    provider: "buzz",
    model: "m-1",
    routeKind: "catalog",
    efforts: ["low", "high"],
    defaultEffort: "low",
  });
  assert.deepEqual(ops, [
    { op: "set", path: ["providers", "buzz", "reasoning"], value: "low" },
    {
      op: "set",
      path: ["providers", "buzz", "modelOverrides", "m-1", "reasoningEfforts"],
      value: { low: "low", high: "high" },
    },
  ]);
  assert.deepEqual(buildMutations({ provider: "buzz", model: "m-1", routeKind: "catalog", efforts: null }), [
    { op: "unset", path: ["providers", "buzz", "modelOverrides", "m-1", "reasoningEfforts"] },
  ]);
  assert.deepEqual(buildMutations({ provider: "buzz", model: "m-1", routeKind: "catalog", efforts: false }), [
    { op: "set", path: ["providers", "buzz", "modelOverrides", "m-1", "reasoningEfforts"], value: false },
  ]);
});

test("buildMutations：自定义路由整数组 set，他行不动；清除即删键", () => {
  const models = [{ id: "m-1", reasoningEfforts: { low: "low" } }, { id: "m-2" }];
  const ops = buildMutations({ provider: "tok", model: "m-2", routeKind: "custom", models, efforts: ["high"] });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "set");
  assert.deepEqual(ops[0].path, ["providers", "tok", "models"]);
  const next = ops[0].value as Record<string, unknown>[];
  assert.equal(next.length, 2);
  assert.deepEqual(next[0], { id: "m-1", reasoningEfforts: { low: "low" } });
  assert.deepEqual(next[1], { id: "m-2", reasoningEfforts: { high: "high" } });
  // 入传入组不被别名污染。
  assert.deepEqual(models[1], { id: "m-2" });

  const cleared = buildMutations({ provider: "tok", model: "m-1", routeKind: "custom", models, efforts: null });
  const clearedModels = cleared[0].value as Record<string, unknown>[];
  assert.deepEqual(clearedModels[0], { id: "m-1" });
});

test("buildMutations：非法输入 fail-loud（缺全量/id 失配/空数组）", () => {
  assert.throws(() => buildMutations({ provider: "tok", model: "m-9", routeKind: "custom", efforts: ["low"] }), /models\[\] 全量/);
  assert.throws(() => buildMutations({ provider: "tok", model: "ghost", routeKind: "custom", models: [{ id: "m-1" }], efforts: ["low"] }), /不在自定义路由/);
  assert.throws(() => buildMutations({ provider: "buzz", model: "m-1", routeKind: "catalog", efforts: [] }), /空数组/);
});
