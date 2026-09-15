/** model-governor 服务端入口（S4）：GovernorService（Typert SRC Remote：describe/configure 双方法）
 *  + `llm/stream` 瀑布监听装配（双桶限流 → 会话头 store → `next()` 恰一次）。
 *
 * 设计意图：
 * - 本包是 core 之外的“模型治理面”（方案 docs/designs/2026-09-16-model-thinking-rpm-overrides.md §3.4）：
 *   同一个 `llm/stream` 监听点一次拦截做两件事——先双桶取令牌（本地排队、不拒绝），再进
 *   header store 调 `next()`（顺序即 §3.5 定序：排队 → store → next）。
 * - Remote 两件套手搓（零依赖铁律：禁 import `@deepseek-ai/cordis` / `dsh-typert-protocol`，
 *   写法照抄 plugin-usage-stats/src/cordis.ts）：① 实例字段 `typertRemote`；② 原型字符串键
 *   remote-methods 标记（version:1 + direct）。SRC 参数约束：单形参纯标识符，`: unknown`
 *   注解可带（Node type-strip 后变空白，网关按纯标识符解析）。
 * - 插件级 `inject = ["llm"]`（等抽象 llm 服务就绪再挂瀑布监听，dsh-opencode-session 线上先例；
 *   `reflect`/`settings` 禁止进等待面——settings 用运行时 `ctx.inject?.(["settings"],…)` 延迟取，
 *   research 先例 plugin-research/src/cordis.ts:124；llm 读面用 `ctx.llm ?? ctx.get?.("llm")` 双保险）。
 * - 监听器用 async-generator 形（session-checkpoint-policy `afterCheckpoint` 同款：预检工作在首 pull
 *   时执行）：`acquire(provider 桶)` → `acquire(provider/model 桶)`（min 语义，TPM 预占取
 *   `options.maxTokens ?? 0` 估计值）→ `next()` 恰调一次 → 头条件满足则 `withStore` 包裹后委托。
 *   并发槽在 `finally` 里双桶 `release`（S2 limiter.ts 合同：调用方负责归还，超额归还忽略）；
 *   `next()` 同步抛也先归还再透传。`options.sessionId` 缺失或非目标 provider 只跳过 header，限流照做。
 * - 会话头机制移植自 `dsh-opencode-session`（作者 nobu121，MIT，原文
 *   `~/.dsh/profiles/web/node_modules/dsh-opencode-session/lib/index.js` 216 行）：
 *   store 形 `{ value }` + `patchFetch` 由本文件在装配时安装（有 `ctx.effect` 则走 fiber 作用域，
 *   卸载自动还原；无则常驻补丁并注释说明）。provider 过滤与 `next()` 调度归本文件，取值/包装/
 *   补丁归 S3 session-header.ts。
 * - `describe` 只读装配：`buildDescribeInput` 归一 → 宿主 `resolveModelInfo`/`listModels`/
 *   `listProviders`（只许出现在此文件）→ `mergeThinking`（自带 + 本地覆盖）→ 附 `effectiveLimits`
 *   与 issues。本地覆盖与 revision 经 `settings.describe()` 读 `llm-pi-ai` 段；未知模型按宿主
 *   `UNKNOWN_MODEL` 行为折进 issues（可修），不用抛。整路由失败（list 系抛错）则直接抛。
 * - `configure` 组合补丁语义（brief 综合：S1 `validateConfigPatch` 注明“校验 configure 补丁”，
 *   S3 `buildMutations` 注明“S4 原样传给 settings.mutate”，两者须在同一 patch 入口汇合）：
 *   `{limits?, sessionHeader?}` 走校验后并入**运行时 live 配置**（bundle 行 config 是静态起点，
 *   重启回落）；`{provider, model, routeKind?, models?, efforts?, defaultEffort?}` 走
 *   `buildMutations` 后 `settings.mutate("llm-pi-ai", ops, revision?)` 落盘（custom 路由的
 *   models[] 全量由本文件经 `listModels` 读出后传入；未知顶层键直接报错，禁静默吞键）。
 *   校验→构造→落盘→live 更新按序进行，落盘失败不污染 live 配置。返回 `{ok, applied, errors}`，
 *   域内失败一律返回值不抛（自动 fallback 切模型不做，ADR-001）。
 * - 错误文案：`translateLlmError` 只在本文件的读出/失配路径调用（展示位置归 S5），未知码直通。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import { effectiveLimits, normalizeConfig, validateConfigPatch, type GovernorConfig, type LimitDims } from "./config.ts";
import { TokenBuckets } from "./limiter.ts";
import { SESSION_HEADER, headerValueFor, patchFetch, withStore, type SessionHeaderMode, type SessionHeaderStore } from "./session-header.ts";
import { translateLlmError, type LlmErrorAdvice } from "./errors.ts";
import {
  buildDescribeInput,
  buildMutations,
  mergeThinking,
  type DescribeInput,
  type SettingsMutation,
  type ThinkingOverride,
  type ThinkingPatch,
} from "./thinking.ts";

/** bundle 行 config 形（cordis.patch.yml 的 config 段与此对齐；空对象 = 自带行为）。 */
export type CordisConfig = GovernorConfig;

/** typert 远程方法标记的原型字符串键（跨副本可读，不 import 协议包——零依赖铁律）。 */
const REMOTE_METHODS_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** configure 落盘的目标 settings 命名空间（thinking.ts 合同：mutate 路径均为该空间内全路径）。 */
const SETTINGS_NS = "llm-pi-ai";

/** configure 补丁可识别的顶层键（之外一律报错，禁静默吞键）。 */
const CONFIGURE_KNOWN_KEYS = ["limits", "sessionHeader", "provider", "model", "routeKind", "models", "efforts", "defaultEffort"];

/** 单模型读出条目（自带值 / 生效值 / 生效限流 / 问题清单）。 */
export interface DescribeModelEntry {
  provider: string;
  model: string;
  /** 是否解析到宿主模型元数据（false = 失配行，issues 首条为 UNKNOWN_MODEL 可行动文案）。 */
  found: boolean;
  /** 自带档位（adapter resolveModelInfo 口径）。 */
  builtin: { efforts: string[]; defaultEffort?: string };
  /** 生效档位（自带 + 本地覆盖经 mergeThinking 合并）。 */
  effective: { efforts: string[]; defaultEffort?: string };
  contextWindow?: number;
  maxTokens?: number;
  /** 该 provider/model 的生效限流（三维独立合并，缺省维即不限）。 */
  limits: LimitDims;
  /** 中文问题清单：mergeThinking issues（字符串）+ 失配可行动文案（LlmErrorAdvice，可直接渲染）。 */
  issues: Array<string | LlmErrorAdvice>;
}

/** describe 合并读出（S5 footer/卡扩展的数据源）。 */
export interface DescribeResult {
  filter: DescribeInput;
  /** llm-pi-ai 段 revision（读出时刻；configure 透传作 expectedRevision 防互盖）。 */
  revision?: number;
  models: DescribeModelEntry[];
  /** 失配覆盖 id 清单（modelOverrides 指错 id / 已删模型的可修列表）。 */
  modelErrors: Array<{ provider: string; model: string; advice: LlmErrorAdvice }>;
}

/** configure 写回结果（域内失败一律返回值，不抛）。 */
export interface ConfigureResult {
  ok: boolean;
  applied: { governor: Record<string, unknown>; mutations: SettingsMutation[] };
  errors: string[];
}

function emptyApplied(): ConfigureResult["applied"] {
  return { governor: {}, mutations: [] };
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

function isAdvice(value: unknown): value is LlmErrorAdvice {
  if (!isPlainRecord(value)) return false;
  return typeof value.title === "string" && typeof value.body === "string" && Array.isArray(value.actions);
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

/** 从 adapter reasoning 口径提自带档位（宿主 LlmModelReasoningInfo：efforts 为 {id,name} 数组）。 */
function builtinFromReasoning(reasoning: unknown): { efforts: string[]; defaultEffort?: string } {
  const rec = (typeof reasoning === "object" && reasoning !== null ? reasoning : {}) as {
    efforts?: unknown;
    defaultEffort?: unknown;
  };
  const raw = Array.isArray(rec.efforts) ? rec.efforts : [];
  const efforts = [
    ...new Set(
      raw
        .map((entry) => {
          if (typeof entry === "string") return entry;
          const obj = (typeof entry === "object" && entry !== null ? entry : {}) as { id?: unknown; name?: unknown };
          if (typeof obj.id === "string" && obj.id.length > 0) return obj.id;
          return typeof obj.name === "string" ? obj.name : "";
        })
        .filter((s) => s.length > 0),
    ),
  ];
  const d = rec.defaultEffort;
  return { efforts, ...(typeof d === "string" && d.length > 0 ? { defaultEffort: d } : {}) };
}

/** 从 llm-pi-ai 路由值提本地覆盖（modelOverrides 条目 reasoningEfforts + 路由级 reasoning 默认）。 */
function overrideFromRoute(routeValue: unknown, model: string): ThinkingOverride {
  const out: ThinkingOverride = {};
  const route = (typeof routeValue === "object" && routeValue !== null ? routeValue : {}) as {
    modelOverrides?: unknown;
    reasoning?: unknown;
  };
  const table = (typeof route.modelOverrides === "object" && route.modelOverrides !== null ? route.modelOverrides : {}) as Record<string, unknown>;
  const hit = table[model];
  if (hit !== undefined && hit !== null && typeof hit === "object") {
    const re = (hit as { reasoningEfforts?: unknown }).reasoningEfforts;
    if (re === false) out.efforts = [];
    else if (Array.isArray(re)) out.efforts = re.filter((s): s is string => typeof s === "string");
    else if (re !== null && typeof re === "object") out.efforts = Object.keys(re);
  }
  if (typeof route.reasoning === "string" && route.reasoning.length > 0) out.defaultEffort = route.reasoning;
  return out;
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
  /** uuid 模式的 sessionId→uuid 进程内稳定表。 */
  readonly uuidTable = new Map<string, string>();
  /** 延迟取到的宿主 settings 面（research-124 写法回填；缺席则按需经 ctx.get 兜底）。 */
  private settingsService: unknown;

  constructor(ctx: any, config?: unknown) {
    this.ctx = ctx;
    this.config = normalizeConfig(config ?? {});
    this.typertRemote = Object.freeze({ service: this, serviceKey: "governor", namespace: "governor" });
    // settings 是运行时延迟服务：禁止进插件级等待面，用 ctx.inject 延迟回填（research 先例）。
    ctx.inject?.(["settings"], (settingsCtx: unknown) => {
      const face = (settingsCtx ?? {}) as { settings?: unknown };
      if (face.settings !== undefined && face.settings !== null) this.settingsService = face.settings;
    });
  }

  /** 宿主 llm 面（插件级 inject 保证在位；缺席即 fail-loud，静默降级会治成误报）。 */
  private llmFace(): any {
    const llm = this.ctx.llm ?? this.ctx.get?.("llm");
    if (llm === undefined || llm === null) {
      throw new Error("model-governor：宿主 llm 服务缺席（插件 inject 声明了 llm，正常启动不会发生）。");
    }
    return llm;
  }

  /** 宿主 settings 面（延迟面：可能缺席，调用方按需 fail-loud 或优雅降级）。 */
  private settingsFace(): any {
    return this.settingsService ?? this.ctx.get?.("settings") ?? undefined;
  }

  /** 读 llm-pi-ai 段 resolved 值 + revision（读不到即 undefined：覆盖未知、跟随自带）。 */
  private llmPiAiView(): { value: unknown; revision?: number } | undefined {
    try {
      const settings = this.settingsFace();
      const descriptors: unknown = settings?.describe?.();
      if (!Array.isArray(descriptors)) return undefined;
      const hit = descriptors.find((d) => isPlainRecord(d) && d.ns === SETTINGS_NS) as { value?: unknown; revision?: unknown } | undefined;
      if (!hit) return undefined;
      return { value: hit.value, revision: typeof hit.revision === "number" ? hit.revision : undefined };
    } catch {
      return undefined;
    }
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

  /** 合并读出：自带档位 + 生效值 + 上下文/输出 + 生效限流 + issues（失配可修，不抛）。 */
  async describe(filter: unknown): Promise<DescribeResult> {
    const narrowed = (typeof filter === "object" && filter !== null ? filter : {}) as {
      provider?: unknown;
      model?: unknown;
    };
    const input = buildDescribeInput(narrowed.provider, narrowed.model);
    const llm = this.llmFace();
    const view = this.llmPiAiView();
    const routes = (typeof view?.value === "object" && view.value !== null ? view.value : {}) as {
      providers?: Record<string, unknown>;
    };
    const models: DescribeModelEntry[] = [];
    const modelErrors: DescribeResult["modelErrors"] = [];
    if (input.provider !== undefined && input.model !== undefined) {
      models.push(await this.describeOne(input.provider, input.model, llm, routes.providers?.[input.provider]));
    } else if (input.provider !== undefined) {
      const ids = idsOf(await llm.listModels(input.provider));
      for (const id of ids) models.push(await this.describeOne(input.provider, id, llm, routes.providers?.[input.provider]));
      modelErrors.push(...this.routeModelErrors(input.provider, routes.providers?.[input.provider], new Set(ids)));
    } else {
      const providers = providerIdsOf(await llm.listProviders());
      for (const provider of providers) {
        const ids = idsOf(await llm.listModels(provider));
        for (const id of ids) models.push(await this.describeOne(provider, id, llm, routes.providers?.[provider]));
        modelErrors.push(...this.routeModelErrors(provider, routes.providers?.[provider], new Set(ids)));
      }
    }
    // 单模型失配行同步进可修清单（describeOne 已把 UNKNOWN_MODEL 文案记进 issues）。
    for (const entry of models) {
      if (entry.found) continue;
      const advice = entry.issues.find(isAdvice);
      if (advice) modelErrors.push({ provider: entry.provider, model: entry.model, advice });
    }
    return {
      filter: input,
      ...(view?.revision === undefined ? {} : { revision: view.revision }),
      models,
      modelErrors,
    };
  }

  private async describeOne(provider: string, model: string, llm: any, routeValue: unknown): Promise<DescribeModelEntry> {
    const limits = effectiveLimits(this.config, provider, model);
    let info: unknown;
    try {
      info = typeof llm.resolveModelInfo === "function" ? await llm.resolveModelInfo(provider, model) : await llm.resolveModel(provider, model);
    } catch (err) {
      const code = (err as { code?: unknown } | null | undefined)?.code;
      if (typeof code !== "string" || code.length === 0) throw err;
      return {
        provider,
        model,
        found: false,
        builtin: { efforts: [] },
        effective: { efforts: [] },
        limits,
        issues: [translateLlmError(code, { provider, model })],
      };
    }
    const rec = (typeof info === "object" && info !== null ? info : {}) as {
      reasoning?: unknown;
      context?: unknown;
      defaultMaxTokens?: unknown;
    };
    const builtin = builtinFromReasoning(rec.reasoning);
    const merged = mergeThinking(
      { efforts: builtin.efforts, ...(builtin.defaultEffort === undefined ? {} : { defaultEffort: builtin.defaultEffort }) },
      overrideFromRoute(routeValue, model),
    );
    const entry: DescribeModelEntry = {
      provider,
      model,
      found: true,
      builtin,
      effective: { efforts: merged.efforts, ...(merged.defaultEffort === undefined ? {} : { defaultEffort: merged.defaultEffort }) },
      limits,
      issues: [...merged.issues],
    };
    const contextWindow = (rec.context as { contextWindow?: unknown } | null | undefined)?.contextWindow;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow)) entry.contextWindow = contextWindow;
    if (typeof rec.defaultMaxTokens === "number" && Number.isFinite(rec.defaultMaxTokens)) entry.maxTokens = rec.defaultMaxTokens;
    return entry;
  }

  /** 路由 modelOverrides 中不在已知 id 里的条目 = 失配可修项（读时记 modelErrors）。 */
  private routeModelErrors(provider: string, routeValue: unknown, known: Set<string>): DescribeResult["modelErrors"] {
    const out: DescribeResult["modelErrors"] = [];
    const route = (typeof routeValue === "object" && routeValue !== null ? routeValue : {}) as { modelOverrides?: unknown };
    const table = (typeof route.modelOverrides === "object" && route.modelOverrides !== null ? route.modelOverrides : {}) as Record<string, unknown>;
    for (const id of Object.keys(table)) {
      if (known.has(id)) continue;
      out.push({ provider, model: id, advice: translateLlmError("UNKNOWN_MODEL", { provider, model: id }) });
    }
    return out;
  }

  /** 写配置：governor 切片并入 live，thinking 切片经 settings.mutate 落盘。域内失败返回 ok:false。 */
  async configure(patch: unknown): Promise<ConfigureResult> {
    if (!isPlainRecord(patch)) {
      return { ok: false, applied: emptyApplied(), errors: ["配置补丁必须是对象，例如 { limits: { defaults: { rpm: 60 } } }"] };
    }
    const unknownKeys = Object.keys(patch).filter((key) => !CONFIGURE_KNOWN_KEYS.includes(key));
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        applied: emptyApplied(),
        errors: unknownKeys.map((key) => `未知配置项：“${key}”，仅支持 limits、sessionHeader、provider、model、routeKind、models、efforts、defaultEffort`),
      };
    }
    const governor: Record<string, unknown> = {};
    if (patch.limits !== undefined) governor.limits = patch.limits;
    if (patch.sessionHeader !== undefined) governor.sessionHeader = patch.sessionHeader;
    const govErrors = validateConfigPatch(governor);
    if (govErrors.length > 0) return { ok: false, applied: emptyApplied(), errors: govErrors };
    let ops: SettingsMutation[] = [];
    if (CONFIGURE_KNOWN_KEYS.slice(2).some((key) => patch[key] !== undefined)) {
      const built = await this.buildThinkingOps(patch);
      if ("errors" in built) return { ok: false, applied: emptyApplied(), errors: built.errors };
      ops = built.ops;
      const settings = this.settingsFace();
      if (settings?.mutate === undefined || settings?.mutate === null || typeof settings.mutate !== "function") {
        return {
          ok: false,
          applied: emptyApplied(),
          errors: ["宿主 settings 服务缺席：思考强度覆盖须写入 llm-pi-ai，当前无法持久化（稍后重试；限流配置不受影响）。"],
        };
      }
      try {
        await settings.mutate(SETTINGS_NS, ops, this.llmPiAiView()?.revision);
      } catch (err) {
        return { ok: false, applied: emptyApplied(), errors: [errorOf(err)] };
      }
    }
    if (Object.keys(governor).length > 0) this.config = normalizeConfig(mergeObjects(this.config, governor));
    return { ok: true, applied: { governor, mutations: ops }, errors: [] };
  }

  /** 把 thinking 切片组装成 ThinkingPatch 并纯构造 mutate ops（custom 路由的 models[] 全量经 listModels 补齐）。 */
  private async buildThinkingOps(raw: Record<string, unknown>): Promise<{ ops: SettingsMutation[] } | { errors: string[] }> {
    const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    if (provider.length === 0 || model.length === 0) {
      return { errors: ["思考强度覆盖须同时指定 provider 与 model（非空字符串）。"] };
    }
    const errors: string[] = [];
    let efforts: ThinkingPatch["efforts"];
    if (raw.efforts !== undefined) {
      const v = raw.efforts;
      if (v === null || v === false) efforts = v;
      else if (Array.isArray(v)) {
        if (v.some((s) => typeof s !== "string")) errors.push("efforts 数组元素须为字符串（档名）；声明非推理模型请用 false，清除覆盖请用 null。");
        else efforts = [...v];
      } else if (isPlainRecord(v)) {
        const bad = Object.entries(v).find(([, w]) => typeof w !== "string" && w !== null);
        if (bad) errors.push("efforts 字典的值须为字符串（wire 拼写）或 null。");
        else efforts = { ...v } as Record<string, string | null>;
      } else {
        errors.push("efforts 非法：string[] 按档名写 identity 字典，dict 精确直写，false 声明非推理模型，null 清除。");
      }
    }
    let defaultEffort: ThinkingPatch["defaultEffort"];
    if (raw.defaultEffort !== undefined) {
      const v = raw.defaultEffort;
      if (v === null) defaultEffort = null;
      else if (typeof v === "string" && v.trim().length > 0) defaultEffort = v;
      else errors.push("defaultEffort 非法：字符串 set，null 清除（unset），不动请省略。");
    }
    let routeKind = raw.routeKind;
    if (routeKind === undefined) {
      const inferred = this.inferRouteKind(provider);
      if (inferred === undefined) {
        errors.push(`无法判定路由“${provider}”的形态（llm-pi-ai 段不可读）：请显式传入 routeKind（"catalog" 目录路由 / "custom" 自定义路由）。`);
      } else routeKind = inferred;
    } else if (routeKind !== "catalog" && routeKind !== "custom") {
      errors.push(`routeKind 非法（当前值：${JSON.stringify(routeKind)}），仅支持 "catalog"、"custom"。`);
    }
    let models = raw.models;
    if (errors.length === 0 && routeKind === "custom" && models === undefined) {
      try {
        models = await this.llmFace().listModels(provider);
      } catch (err) {
        errors.push(`读取路由“${provider}”的 models[] 全量失败：${errorOf(err)}（custom 路由须先读全量再整数组 set）。`);
      }
    }
    if (models !== undefined && !Array.isArray(models)) errors.push("models 非法：须为 listModels 读出的 models[] 全量数组（custom 路由整数组 set 用）。");
    if (errors.length > 0) return { errors };
    try {
      const thinkingPatch: ThinkingPatch = {
        provider,
        model,
        routeKind: routeKind as ThinkingPatch["routeKind"],
        ...(models === undefined ? {} : { models: models as ThinkingPatch["models"] }),
        ...(efforts === undefined ? {} : { efforts }),
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
      };
      return { ops: buildMutations(thinkingPatch) };
    } catch (err) {
      return { errors: [errorOf(err)] };
    }
  }

  /** 由 llm-pi-ai 路由值推断路由形态（有 models[] 数组 = custom，否则目录路由；段不可读则 undefined）。 */
  private inferRouteKind(provider: string): ThinkingPatch["routeKind"] | undefined {
    const providers = (this.llmPiAiView()?.value as { providers?: unknown } | null | undefined)?.providers;
    if (!isPlainRecord(providers)) return undefined;
    const route = providers[provider];
    if (!isPlainRecord(route)) return undefined;
    return Array.isArray(route.models) ? "custom" : "catalog";
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

function providerIdsOf(listed: unknown): string[] {
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
      const dims = effectiveLimits(service.config, provider, model);
      // TPM 预占是估计值（实际用量流结束后才知道，事前按 maxTokens 上限占位，偏保守）。
      const reserve = typeof options.maxTokens === "number" && Number.isFinite(options.maxTokens) ? options.maxTokens : 0;
      const signal: AbortSignal | undefined = options.signal ?? undefined;
      const providerKey = provider;
      const modelKey = `${provider}/${model}`;
      await service.buckets.acquire(providerKey, dims, signal, reserve);
      await service.buckets.acquire(modelKey, dims, signal, reserve);
      let downstream: unknown;
      try {
        downstream = next();
      } catch (err) {
        service.buckets.release(providerKey);
        service.buckets.release(modelKey);
        throw err;
      }
      try {
        const value = service.headerValueForRequest(provider, options.sessionId);
        if (value === undefined || !isAsyncIterable(downstream)) {
          // 无头可加或下游非异步流：原样委托（同步可迭代 yield* 同样透传）。
          if (downstream !== null && downstream !== undefined) yield* downstream as AsyncIterable<any>;
          return;
        }
        yield* withStore(downstream, { value }, service.als);
      } finally {
        service.buckets.release(providerKey);
        service.buckets.release(modelKey);
      }
    },
    { prepend: true },
  );
}

export default { name, inject, apply: applyCordis };
