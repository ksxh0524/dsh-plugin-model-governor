/** model-governor 服务端入口（S4）：GovernorService（Typert SRC Remote：
 *  describe/configure/probe/probeStatus/cancelProbe 五方法）
 *  + `llm/stream` 瀑布监听装配（双桶限流 → 会话头 store → `next()` 恰一次）。
 *
 * 设计意图（2026-09-16 起本包只管三件事：RPM 限流排队 + OpenCode 会话头 + RPM 探测；
 * 思考档位覆盖已整包移除，见 git 历史）：
 * - 同一个 `llm/stream` 监听点一次拦截做两件事——先双桶取令牌（本地排队、不拒绝），再进
 *   header store 调 `next()`（顺序即定序：排队 → store → next）。
 * - 双桶口径（2026-09-16 审查修复）：provider 桶用整条线路口径
 *   `effectiveProviderLimits(config, provider)` 执法（该桶统计的是全模型流量，误用某对
 *   pair 的生效值会把其他模型连带卡死）；模型桶用 `effectiveLimits(config, provider, model)`。
 * - 探测旁路：probe 发出的请求必须测远端、不能被自己的排队污染。旁路走独立 ALS
 *   `probeBypass`（run(true) 包住整次探测，监听器见 flag 即跳过 acquire、直接委托；
 *   同一进程的其他流量不在该上下文里，照常限流）。不用 options 暗记——瀑布是否
 *   clone options 是宿主实现细节，不可依赖。
 * - 探测两阶段（S5 probe.ts 纯函数 + 本文件编排）：A 阶段单并发连打（小 RPM 秒级定论，
 *   碰不到并发墙）→ B 阶段并行加倍 burst（大水管才进，累计成功数逼近窗口值）→
 *   burst 见 429 则暂停后单并发确认（确认也 429 = 窗口真满；确认通过 = 死于并发墙）。
 *   只有亲眼见到 429（触顶）才自动填入 provider 级 rpm（远端刚演示的事实：N 个放行、
 *   第 N+1 个被拒）；未触顶只报告下限、不写配置（没证实的数写进去才是错）。
 *   单服务商单飞行（busy 直接回，不排队）；取消走 AbortController + cancelProbe。
 * - Remote 两件套手搓（零依赖铁律：禁 import `@deepseek-ai/cordis` / `dsh-typert-protocol`，
 *   写法照抄 plugin-usage-stats/src/cordis.ts）：① 实例字段 `typertRemote`；② 原型字符串键
 *   remote-methods 标记（version:1 + direct）。SRC 参数约束：单形参纯标识符，`: unknown`
 *   注解可带（Node type-strip 后变空白，网关按纯标识符解析）。
 * - 插件级 `inject = ["llm"]`（等抽象 llm 服务就绪再挂瀑布监听，dsh-opencode-session 线上先例；
 *   llm 读面用 `ctx.llm ?? ctx.get?.("llm")` 双保险）。
 * - 监听器用 async-generator 形（session-checkpoint-policy `afterCheckpoint` 同款：预检工作在首 pull
 *   时执行）：`acquire(provider 桶)` → `acquire(provider/model 桶)`（min 语义，TPM 预占取
 *   `options.maxTokens ?? 0` 估计值；第二次 acquire 抛错先还第一桶，并发槽永不泄漏）
 *   → `next()` 恰调一次 → 头条件满足则 `withStore` 包裹后委托。
 *   并发槽在 `finally` 里双桶 `release`（S2 limiter.ts 合同：调用方负责归还，超额归还忽略）；
 *   `next()` 同步抛也先归还再透传；消费方提前 return（break/取消）跳过上报时在 `finally` 补报，
 *   `noteOutcome` 依然 exactly-once。`options.sessionId` 缺失或非目标 provider 只跳过 header，限流照做。
 * - 会话头机制移植自 `dsh-opencode-session`（作者 nobu121，MIT）：
 *   store 形 `{ value }` + `patchFetch` 由本文件在装配时安装（有 `ctx.effect` 则走 fiber 作用域，
 *   卸载自动还原；无则常驻补丁并注释说明）。provider 过滤与 `next()` 调度归本文件，取值/包装/
 *   补丁归 session-header.ts。
 * - `describe` 只读装配：`buildDescribeInput` 归一 → 宿主 `listModels`/`listProviders` 取 id
 *   → 附 `effectiveLimits`（模型 → 服务商 → 全局默认逐维合并）。纯限流读出，不读档位；
 *   宿主 llm 面挂了透传错误（fail-loud，不吞成空表）。
 *   filter.provider 在场时另附 `providerLimits`（服务商桶执法口径：provider→defaults，不掺模型级覆盖）——
 *   卡片写的就是 providers[route].rpm，读数必须同源于此；取 models[0].limits 在首模型带覆盖时显示与写入不同源。
 *   provider 缺席但 model 在场时按 model 精确过滤（缺席≠不过滤）。
 * - `configure` 只认 `{limits?, sessionHeader?}`：校验后并入**运行时 live 配置**（bundle 行
 *   config 是静态起点，重启回落）；未知顶层键直接报错，禁静默吞键。某维写 `null` 即删掉
 *   已设值、回落上层（校验放行，合并后 `deleteNullLeaves` 落定）。校验→合并→删 null→live
 *   更新按序进行。返回 `{ok, applied, errors}`，域内失败一律返回值不抛（自动 fallback 切模型不做，ADR-001）。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import {
  deleteNullLeaves,
  effectiveLimits,
  effectiveProviderLimits,
  normalizeConfig,
  validateConfigPatch,
  type GovernorConfig,
  type LimitDims,
} from "./config.ts";
import { TokenBuckets } from "./limiter.ts";
import { SESSION_HEADER, headerValueFor, patchFetch, withStore, type SessionHeaderMode, type SessionHeaderStore } from "./session-header.ts";
import { buildDescribeInput, type DescribeInput } from "./describe-input.ts";
import { classifyFinishReason, classifyThrown, normalizeProbeSpec, summarizeProbe, type ProbeCallOutcome, type ProbeSpec } from "./probe.ts";

/** bundle 行 config 形（cordis.patch.yml 的 config 段与此对齐；空对象 = 自带行为）。 */
export type CordisConfig = GovernorConfig;

/** typert 远程方法标记的原型字符串键（跨副本可读，不 import 协议包——零依赖铁律）。 */
const REMOTE_METHODS_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** configure 补丁可识别的顶层键（之外一律报错，禁静默吞键）。 */
const CONFIGURE_KNOWN_KEYS = ["limits", "sessionHeader"];

/** 单模型限流读出条目（provider/model 键 + 生效限流）。 */
export interface DescribeModelEntry {
  provider: string;
  model: string;
  /** 该 provider/model 的生效限流（三维独立合并，缺省维即不限）。 */
  limits: LimitDims;
}

/** describe 限流读出（RPM 单行的数据源）。 */
export interface DescribeResult {
  filter: DescribeInput;
  models: DescribeModelEntry[];
  /** 服务商桶的执法口径（provider→defaults 逐维合并；缺省维即不限，故可能是 `{}`）。
   *  仅当 filter.provider 在场时给出——那一维就是 `configure({limits:{providers:{[route]:…}}})` 写进去的值。
   *  卡片读数取这个，不取 `models[0].limits`（首模型带模型级覆盖时会显示成模型值）。 */
  providerLimits?: LimitDims;
}

/** configure 写回结果（域内失败一律返回值，不抛）。 */
export interface ConfigureResult {
  ok: boolean;
  applied: { governor: Record<string, unknown> };
  errors: string[];
}

/** probe 发起回执（探测在后台跑，立即返回 started；进度走 probeStatus 轮询）。 */
export interface ProbeStartResult {
  ok: boolean;
  started?: { probeId: string; provider: string; model: string };
  errors: string[];
}

/** 单次探测的结论（probeStatus state=done 时携带；note 为中文一句话，UI 直显）。 */
export interface ProbeResult {
  /** 是否亲眼见到 429（只有 true 才可信、才自动填入）。 */
  topped: boolean;
  /** 触顶时窗口内成功数（即测得 RPM；<1 时不填入）。 */
  estimate?: number;
  /** 未触顶时按耗时折算的下限（只报告、不填入）。 */
  lowerBound: number;
  /** 是否已自动填入 provider 级 rpm。 */
  applied: boolean;
  appliedRpm?: number;
  sent: number;
  succeeded: number;
  rateLimited: number;
  elapsedMs: number;
  cancelled?: boolean;
  /** 并发墙提示（如“并行 8 被限但单发正常”；只提示、不填入）。 */
  concurrencyNote?: string;
  failure?: { code: string; message: string };
  note: string;
}

/** probeStatus 回执（三态：idle / running / done，done 带 result）。
 *  running 带 durationMs（倒计时分母，UI 用 durationMs - elapsedMs 显示剩余秒）。 */
export interface ProbeStatusResult {
  state: "idle" | "running" | "done";
  probeId?: string;
  provider?: string;
  model?: string;
  sent?: number;
  succeeded?: number;
  rateLimited?: number;
  elapsedMs?: number;
  durationMs?: number;
  result?: ProbeResult;
}

/** cancelProbe 回执（idle 时 cancelled=false，照常 ok）。 */
export interface ProbeCancelResult {
  ok: boolean;
  cancelled: boolean;
  errors: string[];
}

/** 后台探测的一次运行（单服务商单飞行，key=provider）。 */
interface ProbeRun {
  id: string;
  provider: string;
  model: string;
  spec: ProbeSpec;
  startedAt: number;
  sent: number;
  succeeded: number;
  rateLimited: number;
  successTimes: number[];
  controller: AbortController;
}

function emptyApplied(): ConfigureResult["applied"] {
  return { governor: {} };
}

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 纯对象递归合并（数组/标量整体替换；返回新对象，不持有入参引用）。 */
function mergeObjects(base: unknown, patch: unknown): unknown {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainRecord(value) && isPlainRecord(out[key]) ? mergeObjects(out[key], value) : value;
  }
  return out;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && value !== undefined && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

/** Fire-and-forget 调试落盘（失败只告警，不影响主链路；原包 recordDebug 同款）。 */
function recordDebug(ctx: unknown, file: string, entry: Record<string, unknown>): void {
  const logger = (ctx as { logger?: { warn?(message: string): void } } | null | undefined)?.logger;
  appendFile(file, `${JSON.stringify(entry)}\n`, "utf8").catch((error: unknown) => {
    logger?.warn?.(`[model-governor] debugFile 写入失败：${errorOf(error)}`);
  });
}

export class GovernorService {
  ctx: any;
  /** 运行时 live 配置（bundle 行 config 为静态起点，configure 合并后即时生效，重启回落）。 */
  config: GovernorConfig;
  typertRemote: { service: GovernorService; serviceKey: string; namespace: string };
  /** 双桶（provider 桶 + provider/model 桶由监听器各 acquire 一次，取 min 语义）。 */
  readonly buckets = new TokenBuckets();
  /** 会话头 store 的 ALS（fetch 补丁与 withStore 共用同一实例）。 */
  readonly als = new AsyncLocalStorage<SessionHeaderStore>();
  /** 探测旁路 flag 的 ALS（run(true) 包住整次探测；监听器见 flag 跳过 acquire，其他流量不受影响）。 */
  readonly probeBypass = new AsyncLocalStorage<boolean>();
  /** uuid 模式的 sessionId→uuid 进程内稳定表。 */
  readonly uuidTable = new Map<string, string>();
  /** 进行中的探测（单服务商单飞行，key=provider）。 */
  private readonly probes = new Map<string, ProbeRun>();
  /** 各服务商最近一次探测结论（key=provider；新探测启动时清掉；model 随结论保留，done 态回执对称）。 */
  private readonly lastResults = new Map<string, { result: ProbeResult; model: string; at: number }>();

  constructor(ctx: any, config?: unknown) {
    this.ctx = ctx;
    this.config = normalizeConfig(config ?? {});
    this.typertRemote = Object.freeze({ service: this, serviceKey: "governor", namespace: "governor" });
  }

  /** 宿主 llm 面（插件级 inject 保证在位；缺席即 fail-loud，静默降级会治成误报）。 */
  private llmFace(): any {
    const llm = this.ctx.llm ?? this.ctx.get?.("llm");
    if (llm === undefined || llm === null) {
      throw new Error("model-governor：宿主 llm 服务缺席（插件 inject 声明了 llm，正常启动不会发生）。");
    }
    return llm;
  }

  /** 熔断口子：每次请求 exactly-once 上报成败（err=undefined 为成功，含流中途炸）。
   *  当前只收信号、零行为；熔断器（失败计数→开断→半开探活）与错误码处置 UI 将来挂在这里。
   *  合约：永不抛错（内部全吞），绝不断流；调用方在 release 之外另调，不与限流归还合并。 */
  noteOutcome(_providerKey: string, _err: unknown): void {
    // 预留：breaker.note(_providerKey, _err) 落在这里。
  }

  /** 本次请求是否进 header store（非目标 provider / 无 sessionId / 空值一律跳过 header，只限流）。 */
  headerValueForRequest(provider: string, sessionId: unknown): string | undefined {
    const header = this.config.sessionHeader;
    const providers = header?.providers ?? [];
    if (!providers.includes(provider)) return undefined;
    if (sessionId === undefined || sessionId === null) return undefined;
    const mode: SessionHeaderMode = header?.mode ?? "session-id";
    const value = headerValueFor(sessionId, mode, this.uuidTable);
    if (value !== undefined) this.logHeaderDebug(provider, sessionId, value);
    return value;
  }

  private logHeaderDebug(provider: string, sessionId: unknown, value: string): void {
    const header = this.config.sessionHeader;
    if (header?.debug !== true && header?.debugFile === undefined) return;
    if (header.debug === true) {
      this.ctx.logger?.info?.(`[model-governor] ${SESSION_HEADER} provider "${provider}" session="${String(sessionId)}" value="${value}"`);
    }
    if (typeof header.debugFile === "string" && header.debugFile.length > 0) {
      recordDebug(this.ctx, header.debugFile, {
        ts: new Date().toISOString(),
        provider,
        session: String(sessionId),
        header: SESSION_HEADER,
        value,
      });
    }
  }

  /** 限流读出：按 filter 列模型 id 并附生效限流（不读档位、不抛错）；filter.provider 在场时另附服务商桶执法口径。 */
  async describe(filter: unknown): Promise<DescribeResult> {
    const narrowed = (typeof filter === "object" && filter !== null ? filter : {}) as {
      provider?: unknown;
      model?: unknown;
    };
    const input = buildDescribeInput(narrowed.provider, narrowed.model);
    const llm = this.llmFace();
    const models: DescribeModelEntry[] = [];
    if (input.provider !== undefined && input.model !== undefined) {
      models.push(this.describeOne(input.provider, input.model));
    } else if (input.provider !== undefined) {
      const ids = idsOf(await llm.listModels(input.provider));
      for (const id of ids) models.push(this.describeOne(input.provider, id));
    } else {
      const providers = idsOf(await llm.listProviders());
      for (const provider of providers) {
        const ids = idsOf(await llm.listModels(provider));
        // provider 缺席但 model 在场：按 model 精确过滤（缺席≠不过滤）。
        for (const id of ids) {
          if (input.model === undefined || id === input.model) models.push(this.describeOne(provider, id));
        }
      }
    }
    const out: DescribeResult = { filter: input, models };
    // 服务商桶口径与模型列表同源给出：卡片写 providers[route]，读就必须是这里（审查中⑦）。
    if (input.provider !== undefined) out.providerLimits = effectiveProviderLimits(this.config, input.provider);
    return out;
  }

  private describeOne(provider: string, model: string): DescribeModelEntry {
    return { provider, model, limits: effectiveLimits(this.config, provider, model) };
  }

  /** 写配置：governor 切片（limits/sessionHeader）校验后并入 live。域内失败返回 ok:false。 */
  async configure(patch: unknown): Promise<ConfigureResult> {
    if (!isPlainRecord(patch)) {
      return { ok: false, applied: emptyApplied(), errors: ["配置补丁必须是对象，例如 { limits: { defaults: { rpm: 60 } } }"] };
    }
    const unknownKeys = Object.keys(patch).filter((key) => !CONFIGURE_KNOWN_KEYS.includes(key));
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        applied: emptyApplied(),
        errors: unknownKeys.map((key) => `未知配置项：“${key}”，仅支持 limits、sessionHeader`),
      };
    }
    const governor: Record<string, unknown> = {};
    if (patch.limits !== undefined) governor.limits = patch.limits;
    if (patch.sessionHeader !== undefined) governor.sessionHeader = patch.sessionHeader;
    const govErrors = validateConfigPatch(governor);
    if (govErrors.length > 0) return { ok: false, applied: emptyApplied(), errors: govErrors };
    if (Object.keys(governor).length > 0) this.applyGovernorPatch(governor);
    return { ok: true, applied: { governor }, errors: [] };
  }

  /** governor 切片并入 live（configure 与 probe 自动填入共用：合并→删 null→归一）。 */
  private applyGovernorPatch(governor: Record<string, unknown>): void {
    const merged = mergeObjects(this.config, governor);
    deleteNullLeaves(merged);
    this.config = normalizeConfig(merged);
  }

  /** 发起 RPM 探测：校验参数后后台跑，立即返回 started（进度走 probeStatus 轮询）。
   *  单服务商单飞行：已有在跑即 busy 回（不排队，免得 UI 点两次叠加烧 token）。 */
  async probe(spec: unknown): Promise<ProbeStartResult> {
    const checked = normalizeProbeSpec(spec);
    if (checked.errors.length > 0 || checked.spec === undefined) {
      return { ok: false, errors: checked.errors };
    }
    const input = checked.spec;
    const running = this.probes.get(input.provider);
    if (running !== undefined) {
      return {
        ok: false,
        errors: [`服务商“${input.provider}”已有探测在跑（${running.id}，已发 ${running.sent} 个），先等它结束或调 cancelProbe 取消`],
      };
    }
    let model = input.model;
    if (model === undefined) {
      let first: string | undefined;
      try {
        first = idsOf(await this.llmFace().listModels(input.provider))[0];
      } catch (err) {
        return { ok: false, errors: [`读服务商“${input.provider}”模型列表失败：${errorOf(err)}`] };
      }
      if (first === undefined) {
        return { ok: false, errors: [`服务商“${input.provider}”无可用模型，无法探测（先确认该服务商已配置）`] };
      }
      model = first;
    }
    const run: ProbeRun = {
      id: `probe-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`,
      provider: input.provider,
      model,
      spec: input,
      startedAt: Date.now(),
      sent: 0,
      succeeded: 0,
      rateLimited: 0,
      successTimes: [],
      controller: new AbortController(),
    };
    this.probes.set(input.provider, run);
    this.lastResults.delete(input.provider);
    // 后台跑：旁路 ALS 包住全程（监听器跳过 acquire，测的是远端不是自己）；
    //  settled 即记结论 + 清运行态，永不抛（失败即 failed 结论）。
    void this.probeBypass
      .run(true, () => this.executeProbe(run))
      .then(
        (result) => {
          this.lastResults.set(run.provider, { result, model: run.model, at: Date.now() });
          if (this.probes.get(run.provider) === run) this.probes.delete(run.provider);
        },
        (err: unknown) => {
          const result: ProbeResult = {
            topped: false,
            lowerBound: 0,
            applied: false,
            sent: run.sent,
            succeeded: run.succeeded,
            rateLimited: run.rateLimited,
            elapsedMs: Date.now() - run.startedAt,
            failure: { code: "UNKNOWN", message: errorOf(err) },
            note: `探测内部失败：${errorOf(err)}，未写入`,
          };
          this.lastResults.set(run.provider, { result, model: run.model, at: Date.now() });
          if (this.probes.get(run.provider) === run) this.probes.delete(run.provider);
        },
      );
    return { ok: true, started: { probeId: run.id, provider: run.provider, model: run.model }, errors: [] };
  }

  /** 查探测进度/结论：idle（没跑过）/ running（计数快照）/ done（结论，含自动填入情况）。 */
  async probeStatus(filter: unknown): Promise<ProbeStatusResult> {
    const narrowed = (typeof filter === "object" && filter !== null ? filter : {}) as { provider?: unknown };
    const provider = typeof narrowed.provider === "string" ? narrowed.provider.trim() : "";
    if (provider === "") return { state: "idle" };
    const running = this.probes.get(provider);
    if (running !== undefined) {
      return {
        state: "running",
        probeId: running.id,
        provider: running.provider,
        model: running.model,
        sent: running.sent,
        succeeded: running.succeeded,
        rateLimited: running.rateLimited,
        elapsedMs: Date.now() - running.startedAt,
        durationMs: running.spec.durationMs,
      };
    }
    const last = this.lastResults.get(provider);
    if (last === undefined) return { state: "idle" };
    return {
      state: "done",
      provider,
      model: last.model,
      sent: last.result.sent,
      succeeded: last.result.succeeded,
      rateLimited: last.result.rateLimited,
      elapsedMs: last.result.elapsedMs,
      result: last.result,
    };
  }

  /** 取消探测：abort 即停（in-flight 的请求按取消结算，不计失败）。idle 时照常 ok。 */
  async cancelProbe(target: unknown): Promise<ProbeCancelResult> {
    const narrowed = (typeof target === "object" && target !== null ? target : {}) as { provider?: unknown };
    const provider = typeof narrowed.provider === "string" ? narrowed.provider.trim() : "";
    if (provider === "") return { ok: false, cancelled: false, errors: ["cancelProbe.provider 必须是非空字符串"] };
    const running = this.probes.get(provider);
    if (running === undefined) return { ok: true, cancelled: false, errors: [] };
    running.controller.abort();
    return { ok: true, cancelled: true, errors: [] };
  }

  /** 一次探测请求的完整构造（极小：1 条文本消息 + maxTokens 取 spec，缺省 16；
   *  远端网关常对 max_completion_tokens 设下限（如 >2），1 会吃 400）。 */
  private probeOptions(run: ProbeRun): any {
    return {
      provider: run.provider,
      model: run.model,
      messages: [
        {
          id: `governor-probe-${run.id}`,
          role: "user",
          content: [{ type: "text", text: "ok" }],
          source: { kind: "user" },
        },
      ],
      maxTokens: run.spec.maxTokens,
      signal: run.controller.signal,
      // 探测 sessionId 按 provider 稳定（不用 run.id）：uuid 模式按 sessionId 落表，
      // 每次新 id 即一条永不删的表项，长期运行会被探测撑大（审查修复）。
      sessionId: `governor-probe-${run.provider}`,
    };
  }

  /** 单次探测调用：发一个极小请求并排干流，按终端块判定（宿主约定失败只以 finish/error 落地）。 */
  private async singleProbeCall(run: ProbeRun): Promise<ProbeCallOutcome> {
    const llm = this.llmFace();
    run.sent += 1;
    let judged: ProbeCallOutcome;
    try {
      judged = await this.drainProbeCall(llm.stream(this.probeOptions(run)));
    } catch (err) {
      judged = classifyThrown(err, run.controller.signal.aborted);
    }
    // 计数与判定收口一处：bare-done 成功与抛错路径的限流同样落数，
    // 否则 probeStatus 快照与结论自相矛盾（审查修复）。
    if (judged.outcome === "success") {
      run.succeeded += 1;
      run.successTimes.push(Date.now());
    } else if (judged.outcome === "rateLimited") {
      run.rateLimited += 1;
    }
    return judged;
  }

  /** 排干一次探测流并判定（只判定不计数，计数由 singleProbeCall 按 outcome 统一落）。 */
  private async drainProbeCall(stream: unknown): Promise<ProbeCallOutcome> {
    const iterable = stream as AsyncIterable<unknown> | AsyncIterator<unknown>;
    const iterator: AsyncIterator<unknown> =
      typeof (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
        ? (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]()
        : (iterable as AsyncIterator<unknown>);
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return { outcome: "success" };
      const chunk = next.value as { type?: unknown; reason?: unknown } | null | undefined;
      if (typeof chunk === "object" && chunk !== null && chunk.type === "finish") {
        return classifyFinishReason(chunk.reason);
      }
    }
  }

  /** 可中断睡眠（确认暂停/错峰用）：abort 即早醒返回 false。 */
  private abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(!signal.aborted);
    if (signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 预算检查：请求数/时长/取消三者任一到顶即停（省 token、省时间）。 */
  private probeBudgetLeft(run: ProbeRun): boolean {
    if (run.controller.signal.aborted) return false;
    if (run.sent >= run.spec.maxRequests) return false;
    if (Date.now() - run.startedAt >= run.spec.durationMs) return false;
    return true;
  }

  /** 探测编排（后台跑，全程在 probeBypass ALS 里）：A 单发 → B burst → 确认 → 汇总 → 触顶自动填入。 */
  private async executeProbe(run: ProbeRun): Promise<ProbeResult> {
    const { spec, controller } = run;
    const signal = controller.signal;
    let limitedAt: number | null = null;
    let failure: { code: string; message: string } | undefined;
    let concurrencyNote: string | undefined;

    // A 阶段：单并发连打（小 RPM 在此定论；单发永远碰不到并发墙，429 只可能是窗口满）。
    for (let i = 0; i < spec.phaseA && this.probeBudgetLeft(run); i += 1) {
      const judged = await this.singleProbeCall(run);
      if (judged.outcome === "rateLimited") {
        limitedAt = Date.now();
        break;
      }
      if (judged.outcome === "failed") {
        failure = { code: judged.code, message: judged.message };
        break;
      }
      if (judged.outcome === "cancelled") break;
    }

    // B 阶段：并行加倍 burst（A 全过才进；累计成功数逼近窗口值）。
    if (limitedAt === null && failure === undefined && !signal.aborted) {
      for (const size of spec.bursts) {
        if (!this.probeBudgetLeft(run)) break;
        let burstLimited = 0;
        let burstFailed: { code: string; message: string } | undefined;
        let launched = 0;
        const room = Math.min(size, spec.maxRequests - run.sent);
        const calls: Array<Promise<ProbeCallOutcome>> = [];
        for (let k = 0; k < room; k += 1) {
          if (!this.probeBudgetLeft(run)) break;
          if (k > 0 && spec.staggerMs > 0) {
            const slept = await this.abortableSleep(spec.staggerMs, signal);
            if (!slept) break;
          }
          launched += 1;
          calls.push(this.singleProbeCall(run));
        }
        const settled = await Promise.all(calls);
        for (const judged of settled) {
          if (judged.outcome === "rateLimited") burstLimited += 1;
          else if (judged.outcome === "failed" && burstFailed === undefined) {
            burstFailed = { code: judged.code, message: judged.message };
          }
        }
        if (signal.aborted) break;
        if (burstFailed !== undefined) {
          failure = burstFailed;
          break;
        }
        if (burstLimited === 0) continue; // 整 burst 全过：下限抬高，下一档
        // burst 见 429：暂停让窗口稍滑，再单并发确认（分清 RPM 满 vs 并发墙）。
        await this.abortableSleep(spec.confirmPauseMs, signal);
        if (signal.aborted) break;
        let confirmed = false;
        for (let c = 0; c < spec.confirmCount && this.probeBudgetLeft(run); c += 1) {
          const judged = await this.singleProbeCall(run);
          if (judged.outcome === "rateLimited") {
            limitedAt = Date.now();
            confirmed = true;
            break;
          }
          if (judged.outcome === "failed") {
            failure = { code: judged.code, message: judged.message };
            break;
          }
          if (judged.outcome === "cancelled") break;
        }
        if (limitedAt !== null || failure !== undefined || signal.aborted) break;
        // 确认全过：burst 死于并发墙（RPM 未触顶）；更大 burst 只会再撞墙，停 B。
        concurrencyNote = `并行 ${launched} 个被限但单发正常，疑似该服务商并发墙（<${launched}），RPM 未触顶`;
        break;
      }
    }

    const elapsedMs = Date.now() - run.startedAt;
    if (signal.aborted) {
      return {
        topped: false,
        lowerBound: summarizeProbe({ successTimes: run.successTimes, limitedAt: null, startedAt: run.startedAt, now: Date.now() }).lowerBound,
        applied: false,
        sent: run.sent,
        succeeded: run.succeeded,
        rateLimited: run.rateLimited,
        elapsedMs,
        cancelled: true,
        ...(concurrencyNote !== undefined ? { concurrencyNote } : {}),
        note: `探测已取消（${run.sent} 发，${run.succeeded} 成功），未写入`,
      };
    }
    if (failure !== undefined) {
      return {
        topped: false,
        lowerBound: 0,
        applied: false,
        sent: run.sent,
        succeeded: run.succeeded,
        rateLimited: run.rateLimited,
        elapsedMs,
        ...(concurrencyNote !== undefined ? { concurrencyNote } : {}),
        failure,
        note: `探测失败：${failure.code} ${failure.message.slice(0, 120)}，未写入`,
      };
    }
    const summary = summarizeProbe({ successTimes: run.successTimes, limitedAt, startedAt: run.startedAt, now: Date.now() });
    if (summary.topped) {
      const estimate = summary.estimate ?? 0;
      if (estimate < 1) {
        return {
          topped: true,
          estimate: 0,
          lowerBound: 0,
          applied: false,
          sent: run.sent,
          succeeded: run.succeeded,
          rateLimited: run.rateLimited,
          elapsedMs,
          note: `首个请求即被限流（窗口已满或该 key 正被别处占用），未写入；请稍后重测`,
        };
      }
      // 触顶 = 远端刚演示的事实（N 个放行、第 N+1 个被拒）：自动填入 provider 级 rpm。
      this.applyGovernorPatch({ limits: { providers: { [run.provider]: { rpm: estimate } } } });
      return {
        topped: true,
        estimate,
        lowerBound: estimate,
        applied: true,
        appliedRpm: estimate,
        sent: run.sent,
        succeeded: run.succeeded,
        rateLimited: run.rateLimited,
        elapsedMs,
        ...(concurrencyNote !== undefined ? { concurrencyNote } : {}),
        note: `测得约 ${estimate} RPM（${run.succeeded} 成功 / ${(elapsedMs / 1000).toFixed(1)}s，${run.rateLimited} 次被限），已自动填入`,
      };
    }
    const secs = (elapsedMs / 1000).toFixed(1);
    return {
      topped: false,
      lowerBound: summary.lowerBound,
      applied: false,
      sent: run.sent,
      succeeded: run.succeeded,
      rateLimited: run.rateLimited,
      elapsedMs,
      ...(concurrencyNote !== undefined ? { concurrencyNote } : {}),
      note: `未触顶：${run.sent} 发全过（约${secs}s），远端上限 ≥${summary.lowerBound}，保持不限流、未写入${concurrencyNote !== undefined ? `；${concurrencyNote}` : ""}`,
    };
  }
}

function idsOf(listed: unknown): string[] {
  if (!Array.isArray(listed)) return [];
  return [
    ...new Set(
      listed
        .map((entry) => {
          if (typeof entry === "string") return entry.trim();
          if (isPlainRecord(entry) && typeof entry.id === "string") return entry.id.trim();
          return "";
        })
        .filter((id) => id.length > 0),
    ),
  ];
}

/** 手写 SRC Remote 标记（形态 = typert-protocol mark() 产物：{version:1, methods:[...]}）。 */
Object.defineProperty(GovernorService.prototype, REMOTE_METHODS_KEY, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: "describe", invocation: Object.freeze({ kind: "direct" }) }),
      Object.freeze({ method: "configure", invocation: Object.freeze({ kind: "direct" }) }),
      Object.freeze({ method: "probe", invocation: Object.freeze({ kind: "direct" }) }),
      Object.freeze({ method: "probeStatus", invocation: Object.freeze({ kind: "direct" }) }),
      Object.freeze({ method: "cancelProbe", invocation: Object.freeze({ kind: "direct" }) }),
    ]),
  }),
});

export const name = "model-governor";
export const inject: string[] = ["llm"];

/** 装配：provide 服务 + fetch 补丁 + `llm/stream` 监听（顺序：双桶 acquire → header store 包裹 → next）。 */
export function applyCordis(ctx: any, config?: unknown): GovernorService {
  const service = new GovernorService(ctx, config);
  ctx.reflect.provide("governor", service);
  installFetchPatch(ctx, service);
  installLlmStreamListener(ctx, service);
  ctx.logger?.info?.("[model-governor] governor remote online（双桶限流 + 会话头监听已挂载）");
  return service;
}

/** 安装 globalThis.fetch 补丁（store 活跃时并入会话头；fiber effect 在位则随卸载还原）。 */
function installFetchPatch(ctx: any, service: GovernorService): void {
  const original = globalThis.fetch;
  if (typeof original !== "function") {
    ctx.logger?.warn?.("[model-governor] globalThis.fetch 不可用：会话头注入停用（限流不受影响）。");
    return;
  }
  const patched = patchFetch(original, service.als);
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      globalThis.fetch = patched;
      return () => {
        if (globalThis.fetch === patched) globalThis.fetch = original;
      };
    }, "model-governor.fetch-patch");
    return;
  }
  // 无 fiber effect 面：常驻补丁（卸载不自动还原，随进程结束；宿主插件 ctx 正常带有 effect）。
  globalThis.fetch = patched;
}

/** 挂载 `llm/stream` 瀑布监听（prepend：与 RPM 中间件同一拦截点，排队优先于下游中间件）。 */
function installLlmStreamListener(ctx: any, service: GovernorService): void {
  ctx.on(
    "llm/stream",
    async function* (options: any, next: () => AsyncIterable<any>): AsyncGenerator<any, void, unknown> {
      if (options === null || options === undefined || typeof options !== "object") {
        yield* next();
        return;
      }
      const provider = String(options.provider ?? "");
      const model = String(options.model ?? "");
      // 探测旁路：probe 自己的流量跳过双桶 acquire（测远端不测自己）；header 包裹与
      // next()/release/noteOutcome 语义与正常流量完全一致（opencode 系缺头会 400，不能省）。
      const bypassed = service.probeBypass.getStore() === true;
      // 双桶口径：provider 桶用整条线路值，模型桶用 pair 生效值（min 语义）。
      const providerDims = effectiveProviderLimits(service.config, provider);
      const pairDims = effectiveLimits(service.config, provider, model);
      // TPM 预占是估计值（实际用量流结束后才知道，事前按 maxTokens 上限占位，偏保守）。
      const reserve = typeof options.maxTokens === "number" && Number.isFinite(options.maxTokens) ? options.maxTokens : 0;
      const signal: AbortSignal | undefined = options.signal ?? undefined;
      const providerKey = provider;
      const modelKey = `${provider}/${model}`;
      if (!bypassed) {
        await service.buckets.acquire(providerKey, providerDims, signal, reserve);
        try {
          await service.buckets.acquire(modelKey, pairDims, signal, reserve);
        } catch (err) {
          // 第二次 acquire 失败（abort 落在两次取令牌之间）：第一次已占的并发槽必须归还，
          // 否则 maxConcurrent 的 inflight 永久 +1，反复命中把该 key 彻底卡死（审查修复）。
          // RPM/TPM 滑窗占位不在此撤销（limiter 无 revoke 语义），60 秒自然滑出、可接受。
          service.buckets.release(providerKey);
          throw err;
        }
      }
      let downstream: unknown;
      try {
        downstream = next();
      } catch (err) {
        if (!bypassed) {
          service.buckets.release(providerKey);
          service.buckets.release(modelKey);
        }
        service.noteOutcome(providerKey, err);
        throw err;
      }
      let settled = false; // noteOutcome 是否已上报（finally 补报消费方提前 return 的路径）
      try {
        const value = service.headerValueForRequest(provider, options.sessionId);
        if (value === undefined || !isAsyncIterable(downstream)) {
          // 无头可加或下游非异步流：原样委托（同步可迭代 yield* 同样透传）。
          if (downstream !== null && downstream !== undefined) yield* downstream as AsyncIterable<any>;
          settled = true;
          service.noteOutcome(providerKey, undefined);
          return;
        }
        yield* withStore(downstream, { value }, service.als);
        settled = true;
        service.noteOutcome(providerKey, undefined);
      } catch (err) {
        settled = true;
        service.noteOutcome(providerKey, err);
        throw err;
      } finally {
        if (!bypassed) {
          service.buckets.release(providerKey);
          service.buckets.release(modelKey);
        }
        if (!settled) {
          // 消费方提前 return（break/取消）会跳过 yield* 之后的上报直进 finally：
          // 在此补报一次，exactly-once 依然成立（审查修复）。
          settled = true;
          service.noteOutcome(providerKey, new Error("model-governor：消费方提前结束流（取消），下游未读完"));
        }
      }
    },
    { prepend: true },
  );
}

export default { name, inject, apply: applyCordis };
