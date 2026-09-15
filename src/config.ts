/** model-governor 配置层（S1）：GovernorConfig 形态 + 缺省 / 归一 / 校验 / 三维生效合并。
 *
 * 设计意图：
 * - 本文件是纯数据层：零依赖（不 import 任何包，零依赖铁律），不碰宿主 settings / llm
 *   服务；只定义“限流三维 + 会话头”配置的形态与纯函数，供 cordis.ts（S4：configure /
 *   describe 读写面）与 limiter 中间件消费。
 * - 不限流用“字段缺省”表示（`{}` 即全不限），`0` 一律非法——`rpm: 0` 语义含混（是关闭
 *   还是全禁？），写路径由 validateConfigPatch 拦下；读路径 normalizeConfig 丢弃非有限
 *   数字，保证流到 limiter 的都是干净数字。
 * - 优先级 `model > provider > defaults`，且三维（rpm / tpm / maxConcurrent）各自独立
 *   合并：模型级只需覆盖它关心的那一维，其余维继续向上继承。provider 桶另有
 *   `effectiveProviderLimits`（整条线路口径，不掺模型级）。
 * - 删除语义：补丁里某维写 `null` 即删掉已设值、回落上层（校验放行，合并后由
 *   `deleteNullLeaves` 落定；归一层同样丢弃 null，live 配置里永不出现 null）。
 * - models 表键形固定为 `"provider/model"`（与 effectiveLimits 的查表键一致）；键形错误
 *   只在 validateConfigPatch 里逐条中文报错，normalize / effective 层不抛（查不到即不限）。
 */

export type LimitDims = {
  /** 每分钟请求数上限（>0；缺省 = 不限）。 */
  rpm?: number;
  /** 每分钟 token 数上限（>0；缺省 = 不限；limiter 层按 options.maxTokens 估计值预占）。 */
  tpm?: number;
  /** 最大并发数（>0；缺省 = 不限）。 */
  maxConcurrent?: number;
};

export type GovernorLimits = {
  /** 全局缺省（三维各自独立作为最后回落）。 */
  defaults?: LimitDims;
  /** 按 provider 覆盖，键为 provider 名（如 "opencode"；不可含 "/"）。 */
  providers?: Record<string, LimitDims>;
  /** 按模型覆盖，键形固定为 "provider/model"（如 "opencode/qwen3-coder"）。 */
  models?: Record<string, LimitDims>;
};

export type GovernorSessionHeader = {
  /** 需要透传会话头的 provider 名单（缺省 ["opencode", "opencode-go"]；`[]` = 全关）。 */
  providers?: string[];
  /** 会话标识形态（缺省 "session-id"）。 */
  mode?: "session-id" | "uuid";
  /** 调试开关（缺省关）。 */
  debug?: boolean;
  /** 调试日志落盘路径（仅 debug 开启时有意义）。 */
  debugFile?: string;
};

export type GovernorConfig = {
  limits?: GovernorLimits;
  sessionHeader?: GovernorSessionHeader;
};

/** 三维键表（合并 / 归一 / 校验共用，防三处各写一份字符串 drift）。 */
const DIM_KEYS = ["rpm", "tpm", "maxConcurrent"] as const;
type DimKey = (typeof DIM_KEYS)[number];

/** 缺省配置：limits 全空 = 不限流；session 头默认对 opencode 系开启。 */
export function defaultConfig(): GovernorConfig {
  return {
    limits: { defaults: {}, providers: {}, models: {} },
    sessionHeader: { providers: ["opencode", "opencode-go"], mode: "session-id" },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 归一单个维度表：只收有限数字，其余（字符串 / NaN / Infinity / 对象）丢弃即不限。
 *  `null` 视为删除标记同样丢弃（configure 删除语义在本层即收敛，live 配置里永不出现 null）。 */
function normalizeDims(value: unknown): LimitDims {
  const out: LimitDims = {};
  if (!isPlainObject(value)) return out;
  for (const key of DIM_KEYS) {
    const n: unknown = value[key];
    if (typeof n === "number" && Number.isFinite(n)) out[key] = n;
  }
  return out;
}

/** 归一 provider/models 映射表：键原样保留（键形由 validate 把关），值逐表归一。 */
function normalizeDimsMap(value: unknown): Record<string, LimitDims> {
  const out: Record<string, LimitDims> = {};
  if (!isPlainObject(value)) return out;
  for (const [key, dims] of Object.entries(value)) out[key] = normalizeDims(dims);
  return out;
}

/** 把外部存量 / 传入的未知形态收敛为规范 GovernorConfig：缺键补缺省，未知字段丢弃。
 * 永远返回全新对象（不持有入参引用），非对象输入直接回缺省。 */
export function normalizeConfig(value: unknown): GovernorConfig {
  const base = defaultConfig();
  if (!isPlainObject(value)) return base;

  const rawLimits: unknown = value["limits"];
  const limits: GovernorLimits = { defaults: {}, providers: {}, models: {} };
  if (isPlainObject(rawLimits)) {
    limits.defaults = normalizeDims(rawLimits["defaults"]);
    limits.providers = normalizeDimsMap(rawLimits["providers"]);
    limits.models = normalizeDimsMap(rawLimits["models"]);
  }

  const rawHeader: unknown = value["sessionHeader"];
  const sessionHeader: GovernorSessionHeader = {
    providers: base.sessionHeader?.providers ? [...base.sessionHeader.providers] : [],
    mode: "session-id",
  };
  if (isPlainObject(rawHeader)) {
    const providers: unknown = rawHeader["providers"];
    if (Array.isArray(providers)) {
      sessionHeader.providers = providers.filter((p): p is string => typeof p === "string" && p.trim() !== "");
    }
    const mode: unknown = rawHeader["mode"];
    sessionHeader.mode = mode === "uuid" || mode === "session-id" ? mode : "session-id";
    const debug: unknown = rawHeader["debug"];
    if (typeof debug === "boolean") sessionHeader.debug = debug;
    const debugFile: unknown = rawHeader["debugFile"];
    if (typeof debugFile === "string" && debugFile.trim() !== "") sessionHeader.debugFile = debugFile;
  }

  return { limits, sessionHeader };
}

/** 供报错打印当前值（JSON 不可串化时回退 String）。 */
function fmt(value: unknown): string {
  const s = JSON.stringify(value);
  return s === undefined ? String(value) : s;
}

/** models 键形：恰一个 "/"，两边均不能为空且不含空白。 */
function isModelKey(key: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(key);
}

/** provider 键形：非空，不含 "/"（模型级请走 limits.models），不含空白。 */
function isProviderKey(key: string): boolean {
  return key.trim() !== "" && !key.includes("/") && !/\s/.test(key);
}

function validateDims(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} 必须是对象，例如 { rpm: 60, tpm: 60000, maxConcurrent: 2 }（当前值：${fmt(value)}）`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "rpm" && key !== "tpm" && key !== "maxConcurrent") {
      errors.push(`${path} 存在未知配置项：“${key}”，仅支持 rpm、tpm、maxConcurrent`);
    }
  }
  for (const dim of DIM_KEYS) {
    const v: unknown = value[dim as string];
    // null = 删除该维（configure 删除语义：删掉已设值、回落上层；归一层同样丢弃）。
    if (v === undefined || v === null) continue;
    const label = `${path}.${dim}`;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${label} 必须是有限数字，删除该维请传 null（当前值：${fmt(v)}）`);
      continue;
    }
    if (v <= 0) {
      errors.push(`${label} 必须大于 0，不限流请直接省略该字段，删除已设值请传 null（当前值：${fmt(v)}）`);
    }
  }
}

function validateLimits(value: unknown, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`limits 必须是对象，例如 { defaults: { rpm: 60 } }（当前值：${fmt(value)}）`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "defaults" && key !== "providers" && key !== "models") {
      errors.push(`limits 存在未知配置项：“${key}”，仅支持 defaults、providers、models`);
    }
  }
  if (value["defaults"] !== undefined) validateDims(value["defaults"], "limits.defaults", errors);

  if (value["providers"] !== undefined) {
    const providers: unknown = value["providers"];
    if (!isPlainObject(providers)) {
      errors.push(`limits.providers 必须是对象，键为 provider 名（如 "opencode"），值为限流维度（当前值：${fmt(providers)}）`);
    } else {
      for (const [key, dims] of Object.entries(providers)) {
        if (!isProviderKey(key)) {
          errors.push(`limits.providers 的键“${key}”非法：provider 名不能为空且不能含“/”（模型级请写到 limits.models，键形如 "provider/model"）`);
        }
        validateDims(dims, `limits.providers["${key}"]`, errors);
      }
    }
  }

  if (value["models"] !== undefined) {
    const models: unknown = value["models"];
    if (!isPlainObject(models)) {
      errors.push(`limits.models 必须是对象，键形为 "provider/model"（如 "opencode/qwen3-coder"），值为限流维度（当前值：${fmt(models)}）`);
    } else {
      for (const [key, dims] of Object.entries(models)) {
        if (!isModelKey(key)) {
          errors.push(`limits.models 的键“${key}”非法：应为 "provider/model" 形（如 "opencode/qwen3-coder"），provider 与 model 均不能为空`);
        }
        validateDims(dims, `limits.models["${key}"]`, errors);
      }
    }
  }
}

function validateSessionHeader(value: unknown, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`sessionHeader 必须是对象，例如 { providers: ["opencode"], mode: "session-id" }（当前值：${fmt(value)}）`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "providers" && key !== "mode" && key !== "debug" && key !== "debugFile") {
      errors.push(`sessionHeader 存在未知配置项：“${key}”，仅支持 providers、mode、debug、debugFile`);
    }
  }
  if (value["providers"] !== undefined) {
    const providers: unknown = value["providers"];
    if (!Array.isArray(providers)) {
      errors.push(`sessionHeader.providers 必须是字符串数组，例如 ["opencode", "opencode-go"]（当前值：${fmt(providers)}）`);
    } else {
      providers.forEach((item: unknown, i: number) => {
        if (typeof item !== "string" || item.trim() === "") {
          errors.push(`sessionHeader.providers[${i}] 必须是非空字符串（当前值：${fmt(item)}）`);
        }
      });
    }
  }
  if (value["mode"] !== undefined) {
    const mode: unknown = value["mode"];
    if (mode !== "session-id" && mode !== "uuid") {
      errors.push(`sessionHeader.mode 非法（当前值：${fmt(mode)}），仅支持 "session-id"、"uuid"`);
    }
  }
  if (value["debug"] !== undefined && typeof value["debug"] !== "boolean") {
    errors.push(`sessionHeader.debug 必须是布尔值（当前值：${fmt(value["debug"])}）`);
  }
  if (value["debugFile"] !== undefined && (typeof value["debugFile"] !== "string" || (value["debugFile"] as string).trim() === "")) {
    errors.push(`sessionHeader.debugFile 必须是非空字符串（当前值：${fmt(value["debugFile"])}）`);
  }
}

/** 校验 configure 补丁（config 形态子集）：合法返回 []，非法逐条中文错误（不抛）。 */
export function validateConfigPatch(patch: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(patch)) {
    return ["配置补丁必须是对象，例如 { limits: { defaults: { rpm: 60 } } }"];
  }
  for (const key of Object.keys(patch)) {
    if (key !== "limits" && key !== "sessionHeader") {
      errors.push(`未知配置项：“${key}”，仅支持 limits、sessionHeader`);
    }
  }
  if (patch["limits"] !== undefined) validateLimits(patch["limits"], errors);
  if (patch["sessionHeader"] !== undefined) validateSessionHeader(patch["sessionHeader"], errors);
  return errors;
}

/** 查某 provider/model 的生效限流：model → provider → defaults，三维各自独立合并。
 * 缺省的维即不限流（返回对象里不出现该键）。从不抛：形态外输入按空配置处理。 */
export function effectiveLimits(cfg: GovernorConfig, provider: string, model: string): LimitDims {
  const limits: GovernorLimits | undefined = isPlainObject(cfg) ? (cfg as GovernorConfig).limits : undefined;
  const defaults: LimitDims = limits?.defaults ?? {};
  const byProvider: LimitDims = limits?.providers?.[provider] ?? {};
  const byModel: LimitDims = limits?.models?.[`${provider}/${model}`] ?? {};
  const out: LimitDims = {};
  for (const key of DIM_KEYS) {
    const v: number | undefined = byModel[key] ?? byProvider[key] ?? defaults[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** 查某 provider 整条线路的生效限流：provider → defaults（provider 桶的执法口径）。
 *
 * 设计意图：provider 桶统计的是该服务商**所有模型**的流量，执法必须用整条线路的
 * 口径；若误用某对 pair 的生效值（如模型 A 的 rpm:10），其他模型的流量会被连带
 * 卡死（2026-09-16 审查发现，见 cordis 监听器）。模型桶仍用 effectiveLimits。 */
export function effectiveProviderLimits(cfg: GovernorConfig, provider: string): LimitDims {
  const limits: GovernorLimits | undefined = isPlainObject(cfg) ? (cfg as GovernorConfig).limits : undefined;
  const defaults: LimitDims = limits?.defaults ?? {};
  const byProvider: LimitDims = limits?.providers?.[provider] ?? {};
  const out: LimitDims = {};
  for (const key of DIM_KEYS) {
    const v: number | undefined = byProvider[key] ?? defaults[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** 删除合并后配置里的 null 叶（configure 删除语义的第二步：merge 把 null 落盘后，
 *  本函数就地删掉 null 叶；空对象保留（即不限流），调用方传入的须是合并产出的全新对象）。 */
export function deleteNullLeaves(value: unknown): void {
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (child === null) {
      delete value[key];
    } else if (isPlainObject(child)) {
      deleteNullLeaves(child);
    }
  }
}
