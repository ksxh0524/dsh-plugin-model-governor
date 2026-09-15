/** model-governor RPM 探测纯函数层（S5）：参数归一/校验 + 终端块分类 + 估计值汇总。
 *
 * 设计意图：
 * - 本文件是纯数据/纯判定层：零依赖（不 import 任何包），不碰宿主 llm 服务、不碰
 *   时间源（调用方传入 `now`），编排（发请求、并发池、旁路 ALS、自动填入）归
 *   cordis.ts，方便单测把“判定”与“发包”分开断。
 * - 探测语义（与 cordis 侧两阶段算法配套）：A 阶段单并发连打（小 RPM 几秒定论，
 *   永远碰不到并发墙）；B 阶段并行加倍 burst（大水管才进，用累计成功数逼近窗口
 *   值）。本文件只回答三件事：参数合不合法、这次调用算成功/限流/取消/失败、
 *   给定成功时刻表与是否触顶、估计值是多少。
 * - 分类口径照抄宿主实证：`failure.code === "RATE_LIMIT"`（宿主标准码，
 *   llm/pi-ai 按 `/\b429\b|rate.?limit/i` 归一）优先，文本回退只认同一正则；
 *   `QUOTA` 另算失败（配额见底 ≠ 速率上限，探测必须停、不得当 RPM 写）。
 * - 估计值绝不编数：触顶（亲眼见到 429）→ 估计 = 触顶时刻前 60 秒窗内成功数
 *   （探测通常 <60 秒，即累计成功数）；未触顶 → 只给下限（按实际耗时折算，
 *   向上取整封顶为累计成功数——发送速率本就是远端接受速率的真下限）。
 */

export interface ProbeSpec {
  /** 服务商路由 id（必填，非空）。 */
  provider: string;
  /** 模型 id（缺省 = 该服务商 listModels 首个）。 */
  model?: string;
  /** A 阶段单并发连打数（1–30，缺省 15；RPM≤14 在此定论）。 */
  phaseA: number;
  /** B 阶段并行 burst 序列（每项 1–64，最多 6 项，缺省 [8,16,32]；空数组=跳过 B 阶段）。 */
  bursts: number[];
  /** burst 见 429 后暂停毫秒数（1000–30000，缺省 5000，等窗口稍滑再确认）。 */
  confirmPauseMs: number;
  /** 确认阶段单并发补发数（1–10，缺省 5）。 */
  confirmCount: number;
  /** burst 内逐发间隔毫秒（0–1000，缺省 50，避开“秒级”毛刺限流）。 */
  staggerMs: number;
  /** 全程请求数硬上限（1–300，缺省 150，花费封顶）。 */
  maxRequests: number;
  /** 全程时长硬上限毫秒（5000–180000，缺省 120000）。 */
  durationMs: number;
}

export const PROBE_DEFAULTS = {
  phaseA: 15,
  bursts: [8, 16, 32],
  confirmPauseMs: 5000,
  confirmCount: 5,
  staggerMs: 50,
  maxRequests: 150,
  durationMs: 120_000,
} as const;

/** 60 秒滑动窗口（RPM 定义窗，limiter.ts 同值）。 */
export const RPM_WINDOW_MS = 60_000;

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

/** 归一 + 校验探测参数：合法返回 {spec}，非法返回 {errors}（逐条中文，不抛）。 */
export function normalizeProbeSpec(value: unknown): { spec: ProbeSpec; errors: [] } | { spec?: undefined; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainRecord(value)) {
    return { errors: ['探测参数必须是对象，例如 { provider: "opencode" }'] };
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "provider" &&
      key !== "model" &&
      key !== "phaseA" &&
      key !== "bursts" &&
      key !== "confirmPauseMs" &&
      key !== "confirmCount" &&
      key !== "staggerMs" &&
      key !== "maxRequests" &&
      key !== "durationMs"
    ) {
      errors.push(`未知探测参数：“${key}”，仅支持 provider、model、phaseA、bursts、confirmPauseMs、confirmCount、staggerMs、maxRequests、durationMs`);
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
  const phaseA: unknown = value["phaseA"];
  if (phaseA !== undefined && intIn(phaseA, 1, 30) === undefined) {
    errors.push(`probe.phaseA 必须是 1–30 的整数（当前值：${fmt(phaseA)}）`);
  }
  const bursts: unknown = value["bursts"];
  if (bursts !== undefined) {
    if (!Array.isArray(bursts) || bursts.length > 6) {
      errors.push(`probe.bursts 必须是最多 6 项的数组（空数组=跳过 B 阶段，当前值：${fmt(bursts)}）`);
    } else {
      bursts.forEach((item: unknown, i: number) => {
        if (intIn(item, 1, 64) === undefined) errors.push(`probe.bursts[${i}] 必须是 1–64 的整数（当前值：${fmt(item)}）`);
      });
    }
  }
  const confirmPauseMs: unknown = value["confirmPauseMs"];
  if (confirmPauseMs !== undefined && intIn(confirmPauseMs, 1000, 30000) === undefined) {
    errors.push(`probe.confirmPauseMs 必须是 1000–30000 的整数毫秒（当前值：${fmt(confirmPauseMs)}）`);
  }
  const confirmCount: unknown = value["confirmCount"];
  if (confirmCount !== undefined && intIn(confirmCount, 1, 10) === undefined) {
    errors.push(`probe.confirmCount 必须是 1–10 的整数（当前值：${fmt(confirmCount)}）`);
  }
  const staggerMs: unknown = value["staggerMs"];
  if (staggerMs !== undefined && intIn(staggerMs, 0, 1000) === undefined) {
    errors.push(`probe.staggerMs 必须是 0–1000 的整数毫秒（当前值：${fmt(staggerMs)}）`);
  }
  const maxRequests: unknown = value["maxRequests"];
  if (maxRequests !== undefined && intIn(maxRequests, 1, 300) === undefined) {
    errors.push(`probe.maxRequests 必须是 1–300 的整数（当前值：${fmt(maxRequests)}）`);
  }
  const durationMs: unknown = value["durationMs"];
  if (durationMs !== undefined && intIn(durationMs, 5000, 180000) === undefined) {
    errors.push(`probe.durationMs 必须是 5000–180000 的整数毫秒（当前值：${fmt(durationMs)}）`);
  }
  if (errors.length > 0) return { errors };
  const spec: ProbeSpec = {
    provider: (provider as string).trim(),
    phaseA: (phaseA as number | undefined) ?? PROBE_DEFAULTS.phaseA,
    bursts: bursts === undefined ? [...PROBE_DEFAULTS.bursts] : ([...(bursts as number[])] as number[]),
    confirmPauseMs: (confirmPauseMs as number | undefined) ?? PROBE_DEFAULTS.confirmPauseMs,
    confirmCount: (confirmCount as number | undefined) ?? PROBE_DEFAULTS.confirmCount,
    staggerMs: (staggerMs as number | undefined) ?? PROBE_DEFAULTS.staggerMs,
    maxRequests: (maxRequests as number | undefined) ?? PROBE_DEFAULTS.maxRequests,
    durationMs: (durationMs as number | undefined) ?? PROBE_DEFAULTS.durationMs,
  };
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

/** 探测汇总输入（时刻均为调用方时钟 ms；successTimes 升序）。 */
export interface ProbeSummaryInput {
  /** 每次成功的完成时刻（升序）。 */
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
