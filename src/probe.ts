/** model-governor RPM 探测纯函数层（S5）：参数归一/校验 + 终端块分类 + 估计值汇总。
 *
 * 设计意图：
 * - 本文件是纯数据/纯判定层：零依赖（不 import 任何包），不碰宿主 llm 服务、不碰
 *   时间源（调用方传入 `now`），编排（发请求、 pacer 调度、旁路 ALS、自动填入）归
 *   cordis.ts，方便单测把“判定”与“发包”分开断。
 * - 探测语义（v2 RPS 爬坡，2026-09 取代旧两阶段）：pacer 按**发送速率**爬坡——起始
 *   `rampStartRps`，每 `rampStepMs` 加 `rampStepRps`，封顶 `maxRps`——累计发送数
 *   `C(t) ≈ r0·t + k·t²/2` 自然逼近窗口值。旧方案（A 阶段单发串行 + B 阶段 burst）
 *   把发送速率绑死在 `1/RTT` 上：RTT=1s 时串行一秒一个、一分钟最多 60 发，大 RPM
 *   永远够不着；burst 又是瞬时尖峰（32 发挤在 1.6s 里 ≈20 RPS），先撞上的往往是
 *   服务商的“秒级毛刺墙”而不是 60 秒 RPM 窗，估计值就张冠李戴了。爬坡的每次发送
 *   在时间上均匀摊开，单位时间发送数与 RTT 无关（并发度 = RPS × RTT，由 pacer
 *   按 `maxInflight` 限幅），RPM 30 约 6 秒定论、RPM 60 约 9 秒、RPM 300 约 23 秒，
 *   全程 <60 秒——`durationMs` 缺省 60 秒即一整窗，不再需要 120 秒。
 * - 并发上限听用户的：`maxInflight` 硬顶 50（缺省 32）——50 并发已经不得了，再大
 *   就是去压垮人家网关，不是测 RPM 了。pacer 待发而 inflight 已满时只等最先落定的
 *   那个，不再开新发。
 * - 窗口语义：RPM 窗数的是**发送时刻**（服务商收到请求的时刻），不是完成时刻。
 *   `successTimes` 存每次成功请求的**开始时刻**（`singleProbeCall` 入口的 `Date.now()`）。
 *   旧实现存完成时刻：RTT 大或探测拖过 60 秒时，早期的成功会整体右移、掉出
 *   `(limitedAt-60s, limitedAt]` 窗口，估计值系统性偏小。本层只管数窗内个数，不管
 *   时刻是谁记的——调用方必须传开始时刻。
 * - 分类口径照抄宿主实证：`failure.code === "RATE_LIMIT"`（宿主标准码，
 *   llm/pi-ai 按 `/\b429\b|rate.?limit/i` 归一）优先，文本回退只认同一正则；
 *   `QUOTA` 另算失败（配额见底 ≠ 速率上限，探测必须停、不得当 RPM 写）。
 * - 估计值绝不编数：触顶（亲眼见到 429）→ 估计 = 触顶时刻前 60 秒窗内成功数
 *   （爬坡通常 <60 秒，即累计成功数）；未触顶 → 只给下限（按实际耗时折算，
 *   向上取整封顶为累计成功数——发送速率本就是远端接受速率的真下限）。
 */

export interface ProbeSpec {
  /** 服务商路由 id（必填，非空）。 */
  provider: string;
  /** 模型 id（缺省 = 该服务商 listModels 首个）。 */
  model?: string;
  /** 爬坡起始发送速率 RPS（1–20，缺省 2：头一秒只发 2 个，轻得像正常流量）。 */
  rampStartRps: number;
  /** 每步增加的 RPS（1–10，缺省 1：即“隔一秒多发一个”，用户原话直译）。 */
  rampStepRps: number;
  /** 爬坡步长毫秒（500–5000，缺省 1000）。 */
  rampStepMs: number;
  /** 发送速率封顶 RPS（1–50，缺省 20：20 RPS × 60s = 1200，RPM 600 以内都够；再大先撞秒级墙）。 */
  maxRps: number;
  /** 最大在飞请求数（1–50，缺省 32：50 并发已经不得了，硬顶防压垮网关）。 */
  maxInflight: number;
  /** 见 429 后暂停毫秒数（1000–30000，缺省 2000，等窗口稍滑再确认；旧缺省 5000 太久）。 */
  confirmPauseMs: number;
  /** 确认阶段单并发补发数（1–10，缺省 3；旧缺省 5，3 发足够分清 RPM 满 vs 并发墙）。 */
  confirmCount: number;
  /** 全程请求数硬上限（1–600，缺省 300：300 发覆盖到 ~300 RPM，花费 ≈300×16 token 可忽略）。 */
  maxRequests: number;
  /** 全程时长硬上限毫秒（5000–180000，缺省 60000：一整窗，爬坡最慢 30 秒出数，60 秒是天花板）。 */
  durationMs: number;
  /** 单次探测请求的 maxTokens（1–200 的整数，缺省 16：远端网关常对
   *  max_completion_tokens 设下限（如 >2），1 会吃 400；16 仍极便宜）。 */
  maxTokens: number;
}

export const PROBE_DEFAULTS = {
  rampStartRps: 2,
  rampStepRps: 1,
  rampStepMs: 1000,
  maxRps: 20,
  maxInflight: 32,
  confirmPauseMs: 2000,
  confirmCount: 3,
  maxRequests: 300,
  durationMs: 60_000,
  maxTokens: 16,
} as const;

/** 旧两阶段参数（phaseA/bursts/staggerMs）v2 已移除：串行速率绑死 1/RTT 测不出大 RPM，
 *  burst 尖峰先撞秒级墙。normalize 遇到它们按未知键拒收，报错里指来新参数。 */
const REMOVED_KEYS = ["phaseA", "bursts", "staggerMs"] as const;

/** 60 秒滑动窗口（RPM 定义窗，limiter.ts 同值）。 */
export const RPM_WINDOW_MS = 60_000;

/** 爬坡速率纯函数：elapsedMs 处本该用的 RPS（单测断 ramp 曲线用，不碰时钟）。 */
export function rampRps(spec: Pick<ProbeSpec, "rampStartRps" | "rampStepRps" | "rampStepMs" | "maxRps">, elapsedMs: number): number {
  const steps = Math.max(0, Math.floor(Math.max(0, elapsedMs) / spec.rampStepMs));
  return Math.min(spec.maxRps, spec.rampStartRps + steps * spec.rampStepRps);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fmt(value: unknown): string {
  const s = JSON.stringify(value);
  return s === undefined ? String(value) : s;
}

function intIn(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

const KNOWN_KEYS = [
  "provider",
  "model",
  "rampStartRps",
  "rampStepRps",
  "rampStepMs",
  "maxRps",
  "maxInflight",
  "confirmPauseMs",
  "confirmCount",
  "maxRequests",
  "durationMs",
  "maxTokens",
] as const;

/** 归一 + 校验探测参数：合法返回 {spec}，非法返回 {errors}（逐条中文，不抛）。 */
export function normalizeProbeSpec(value: unknown): { spec: ProbeSpec; errors: [] } | { spec?: undefined; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainRecord(value)) {
    return { errors: ['探测参数必须是对象，例如 { provider: "opencode" }'] };
  }
  for (const key of Object.keys(value)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      if ((REMOVED_KEYS as readonly string[]).includes(key)) {
        errors.push(`探测参数“${key}”已移除（v2 改 RPS 爬坡：rampStartRps/rampStepRps/rampStepMs/maxRps/maxInflight），请改传新参数`);
      } else {
        errors.push(
          `未知探测参数：“${key}”，仅支持 provider、model、rampStartRps、rampStepRps、rampStepMs、maxRps、maxInflight、confirmPauseMs、confirmCount、maxRequests、durationMs、maxTokens`,
        );
      }
    }
  }
  const provider: unknown = value["provider"];
  if (typeof provider !== "string" || provider.trim() === "") {
    errors.push(`probe.provider 必须是非空字符串（当前值：${fmt(provider)}）`);
  }
  const model: unknown = value["model"];
  if (model !== undefined && (typeof model !== "string" || model.trim() === "")) {
    errors.push(`probe.model 必须是非空字符串（当前值：${fmt(model)}）`);
  }
  const rampStartRps: unknown = value["rampStartRps"];
  if (rampStartRps !== undefined && intIn(rampStartRps, 1, 20) === undefined) {
    errors.push(`probe.rampStartRps 必须是 1–20 的整数 RPS（当前值：${fmt(rampStartRps)}）`);
  }
  const rampStepRps: unknown = value["rampStepRps"];
  if (rampStepRps !== undefined && intIn(rampStepRps, 1, 10) === undefined) {
    errors.push(`probe.rampStepRps 必须是 1–10 的整数 RPS（当前值：${fmt(rampStepRps)}）`);
  }
  const rampStepMs: unknown = value["rampStepMs"];
  if (rampStepMs !== undefined && intIn(rampStepMs, 500, 5000) === undefined) {
    errors.push(`probe.rampStepMs 必须是 500–5000 的整数毫秒（当前值：${fmt(rampStepMs)}）`);
  }
  const maxRps: unknown = value["maxRps"];
  if (maxRps !== undefined && intIn(maxRps, 1, 50) === undefined) {
    errors.push(`probe.maxRps 必须是 1–50 的整数 RPS（当前值：${fmt(maxRps)}）`);
  }
  const maxInflight: unknown = value["maxInflight"];
  if (maxInflight !== undefined && intIn(maxInflight, 1, 50) === undefined) {
    errors.push(`probe.maxInflight 必须是 1–50 的整数（50 并发已经不得了，当前值：${fmt(maxInflight)}）`);
  }
  const confirmPauseMs: unknown = value["confirmPauseMs"];
  if (confirmPauseMs !== undefined && intIn(confirmPauseMs, 1000, 30000) === undefined) {
    errors.push(`probe.confirmPauseMs 必须是 1000–30000 的整数毫秒（当前值：${fmt(confirmPauseMs)}）`);
  }
  const confirmCount: unknown = value["confirmCount"];
  if (confirmCount !== undefined && intIn(confirmCount, 1, 10) === undefined) {
    errors.push(`probe.confirmCount 必须是 1–10 的整数（当前值：${fmt(confirmCount)}）`);
  }
  const maxRequests: unknown = value["maxRequests"];
  if (maxRequests !== undefined && intIn(maxRequests, 1, 600) === undefined) {
    errors.push(`probe.maxRequests 必须是 1–600 的整数（当前值：${fmt(maxRequests)}）`);
  }
  const durationMs: unknown = value["durationMs"];
  if (durationMs !== undefined && intIn(durationMs, 5000, 180000) === undefined) {
    errors.push(`probe.durationMs 必须是 5000–180000 的整数毫秒（当前值：${fmt(durationMs)}）`);
  }
  const maxTokens: unknown = value["maxTokens"];
  if (maxTokens !== undefined && intIn(maxTokens, 1, 200) === undefined) {
    errors.push(`probe.maxTokens 必须是 1–200 的整数（当前值：${fmt(maxTokens)}）`);
  }
  if (errors.length > 0) return { errors };
  const spec: ProbeSpec = {
    provider: (provider as string).trim(),
    rampStartRps: (rampStartRps as number | undefined) ?? PROBE_DEFAULTS.rampStartRps,
    rampStepRps: (rampStepRps as number | undefined) ?? PROBE_DEFAULTS.rampStepRps,
    rampStepMs: (rampStepMs as number | undefined) ?? PROBE_DEFAULTS.rampStepMs,
    maxRps: (maxRps as number | undefined) ?? PROBE_DEFAULTS.maxRps,
    maxInflight: (maxInflight as number | undefined) ?? PROBE_DEFAULTS.maxInflight,
    confirmPauseMs: (confirmPauseMs as number | undefined) ?? PROBE_DEFAULTS.confirmPauseMs,
    confirmCount: (confirmCount as number | undefined) ?? PROBE_DEFAULTS.confirmCount,
    maxRequests: (maxRequests as number | undefined) ?? PROBE_DEFAULTS.maxRequests,
    durationMs: (durationMs as number | undefined) ?? PROBE_DEFAULTS.durationMs,
    maxTokens: (maxTokens as number | undefined) ?? PROBE_DEFAULTS.maxTokens,
  };
  if (spec.maxRps < spec.rampStartRps) {
    errors.push(`probe.maxRps（${spec.maxRps}）不得小于 rampStartRps（${spec.rampStartRps}），否则一步就封顶`);
    return { errors };
  }
  if (model !== undefined) spec.model = (model as string).trim();
  return { spec, errors: [] };
}

/** 单次探测调用的判定结果（成功 / 被限流 / 调用方取消 / 失败附码）。 */
export type ProbeCallOutcome =
  { outcome: "success" } | { outcome: "rateLimited" } | { outcome: "cancelled" } | { outcome: "failed"; code: string; message: string };

/** 宿主标准限流码 + 文本回退（llm-pi-ai 同款正则，不解析消息就认不出文本型 429）。 */
export function isRateLimitFailure(code: unknown, message: unknown): boolean {
  if (code === "RATE_LIMIT") return true;
  if (typeof message === "string" && /\b429\b|rate.?limit/i.test(message)) return true;
  return false;
}

/** 配额见底（≠ 速率上限）：探测必须停，且绝不能当 RPM 写入。 */
export function isQuotaFailure(code: unknown, message: unknown): boolean {
  if (code === "QUOTA") return true;
  if (typeof message !== "string") return false;
  return (
    /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(message) ||
    /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(message) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(message)
  );
}

function failureOf(value: unknown): { code: string; message: string } {
  if (typeof value === "object" && value !== null) {
    const rec = value as { code?: unknown; message?: unknown };
    const code = typeof rec.code === "string" && rec.code.length > 0 ? rec.code : "UNKNOWN";
    const message = typeof rec.message === "string" && rec.message.length > 0 ? rec.message : String(code);
    return { code, message };
  }
  return { code: "UNKNOWN", message: String(value) };
}

/** 判定终端 finish 块：宿主约定失败只以 finish/error 块落地，不抛（成功即非 error/aborted 的 finish）。 */
export function classifyFinishReason(reason: unknown): ProbeCallOutcome {
  const kind: unknown = typeof reason === "object" && reason !== null ? (reason as { kind?: unknown }).kind : undefined;
  if (kind === "error") {
    const failure: unknown = (reason as { failure?: unknown }).failure;
    const { code, message } = failureOf(failure);
    if (isRateLimitFailure(code, message)) return { outcome: "rateLimited" };
    return { outcome: "failed", code, message };
  }
  if (kind === "aborted") return { outcome: "cancelled" };
  return { outcome: "success" };
}

/** 判定抛错路径（瀑布其他监听抛错、调用前校验抛错）：先看 abort，再看码。 */
export function classifyThrown(error: unknown, aborted: boolean): ProbeCallOutcome {
  if (aborted) return { outcome: "cancelled" };
  const codeProp: unknown = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (isRateLimitFailure(codeProp, message)) return { outcome: "rateLimited" };
  const { code } = failureOf(typeof codeProp === "string" ? { code: codeProp, message } : error);
  return { outcome: "failed", code, message };
}

/** 探测汇总输入（时刻均为调用方时钟 ms；successTimes 升序，且必须是**开始时刻**，
 *  见文件头窗口语义——传完成时刻会系统性偏小）。 */
export interface ProbeSummaryInput {
  /** 每次成功请求的开始时刻（升序）。 */
  successTimes: number[];
  /** 首次见到 429 的时刻（未触顶即 null）。 */
  limitedAt: number | null;
  /** 探测起始时刻。 */
  startedAt: number;
  /** 汇总时刻（_now，便于单测注入假时钟）。 */
  now: number;
}

/** 探测汇总：触顶给估计（窗内成功数），未触顶只给下限（绝不编上限数）。 */
export function summarizeProbe(input: ProbeSummaryInput): { topped: boolean; estimate?: number; lowerBound: number } {
  const { successTimes, limitedAt, startedAt, now } = input;
  if (limitedAt !== null) {
    const floor = limitedAt - RPM_WINDOW_MS;
    let inWindow = 0;
    for (const t of successTimes) {
      if (t > floor && t <= limitedAt) inWindow += 1;
    }
    return { topped: true, estimate: inWindow, lowerBound: inWindow };
  }
  const elapsedMs = Math.max(0, now - startedAt);
  const lowerBound = elapsedMs <= 0 ? successTimes.length : Math.min(successTimes.length, Math.floor((successTimes.length * RPM_WINDOW_MS) / elapsedMs));
  return { topped: false, lowerBound };
}
