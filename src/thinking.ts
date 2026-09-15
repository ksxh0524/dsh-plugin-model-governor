/** 思考强度读写：参数归一化 + 纯合并 + 纯构造 mutate 操作（无宿主调用）。
 *
 * 设计意图：思考强度 = 内置表自带值 + 本地覆盖（逐模型 reasoningEfforts /
 * 路由级 reasoning 默认），无远端动态。宿主调用（resolveModel / listModels /
 * settings.mutate）只许出现在 cordis.ts；本文件只做三件事：
 *  ① buildDescribeInput 把 describe 入参归一化成 `{provider?, model?}`；
 *  ② mergeThinking 把“自带 + 覆盖”合并成生效值 + 中文 issues（覆盖优先，
 *     生效默认档若不在生效档位内则丢弃并记 issue——正治“配了不生效又无报错”）；
 *  ③ buildMutations 把覆盖意图翻译成 settings.mutate 的 `{op, path}` 序列，
 *     目录路由走 `modelOverrides.<id>`、自定义路由走 `models[]` 整数组 set
 *     （宿主 mutate 路径不可寻址数组元素，实证见本文件 buildMutations 注释）。
 * 路径均为 `llm-pi-ai` 命名空间内的全路径，S4 原样传给
 * `settings.mutate("llm-pi-ai", ops)` 即可。
 */

export type DescribeInput = {
  provider?: string;
  model?: string;
};

function cleanSegment(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 归一化 describe 入参：非字符串/空串一律按“未指定”处理（缺省=查全部）。 */
export function buildDescribeInput(provider: unknown, model: unknown): DescribeInput {
  const input: DescribeInput = {};
  const p = cleanSegment(provider);
  const m = cleanSegment(model);
  if (p !== undefined) input.provider = p;
  if (m !== undefined) input.model = m;
  return input;
}

/** 自带能力（adapter modelInfo 口径：内置表 + 目录合并后）。 */
export type ThinkingModelInfo = {
  /** 自带可用档（空数组 = 该模型不推理）。 */
  efforts: string[];
  /** 自带默认档（路由级 reasoning 或空）。 */
  defaultEffort?: string;
};

/** 本地覆盖（models[] / modelOverrides 条目 + 路由级 reasoning 默认的子集）。 */
export type ThinkingOverride = {
  /** 覆盖档位：提供即整体替换自带（含空数组 = 显式收成无档）；省略=跟随自带。 */
  efforts?: string[];
  /** 覆盖默认档；省略=跟随自带。 */
  defaultEffort?: string;
};

/** 合并结果：生效值 + 中文问题清单（空数组=无异常）。 */
export type ThinkingMerged = {
  efforts: string[];
  defaultEffort?: string;
  issues: string[];
};

/** 纯合并：覆盖优先；生效默认档不在生效档位内则丢弃并记 issue（不抛错）。
 *
 * 优先级：`override.efforts ?? 自带 efforts`；`override.defaultEffort ?? 自带 default`。
 * 输入数组一律拷贝，永不别名调用方数据。
 */
export function mergeThinking(modelInfo: ThinkingModelInfo, override: ThinkingOverride): ThinkingMerged {
  const efforts = [...(override.efforts ?? modelInfo.efforts)];
  const wanted = override.defaultEffort ?? modelInfo.defaultEffort;
  const issues: string[] = [];
  let defaultEffort: string | undefined;
  if (wanted !== undefined) {
    if (efforts.includes(wanted)) {
      defaultEffort = wanted;
    } else {
      issues.push(
        `默认思考档“${wanted}”不在该模型生效档位` +
          (efforts.length > 0 ? `（${efforts.join("、")}）` : `（无可用档）`) +
          `中，已置空：检查路由级 reasoning 默认与该模型的 reasoningEfforts 覆盖是否匹配，` +
          `显式请求该档仍会报 UNSUPPORTED_REASONING_EFFORT。`,
      );
    }
  }
  return { efforts, defaultEffort, issues };
}

/** 路由形态：目录路由（装机目录 + modelOverrides 补丁）vs 自定义路由（models[] 全量列表）。 */
export type ThinkingRouteKind = "catalog" | "custom";

/** 单模型覆盖意图（S4 先做服务端校验，再调 buildMutations 落盘）。 */
export type ThinkingPatch = {
  /** 路由键（settings 路径 `providers.<route>` 下）。 */
  provider: string;
  /** 目标模型 id（modelOverrides 的字典键；custom 路由按 `entry.id` 定位数组元素）。 */
  model: string;
  routeKind: ThinkingRouteKind;
  /** custom 路由必填：models[] 当前全量（S4 经 listModels 读出后传入）。
   * 宿主 mutate 的 applyPathOp 只穿越 plain object，数组元素不可路径寻址，
   * 故 custom 路由只能整数组 set（见 buildMutations 注释）。 */
  models?: readonly Record<string, unknown>[];
  /** 档位覆盖：undefined=不动；null=清除（unset，跟随自带）；false=声明非推理模型；
   * string[] 按档名写 identity 字典（wire 拼写 = 档名）；dict=精确 wire 拼写直写。 */
  efforts?: string[] | Record<string, string | null> | false | null;
  /** 路由级 reasoning 默认：undefined=不动；null=清除（unset）；字符串=set。 */
  defaultEffort?: string | null;
};

/** settings.mutate 单步编辑（与宿主 `{op: "set" | "unset", path}` 协议同形）。 */
export type SettingsMutation = {
  op: "set" | "unset";
  path: string[];
  value?: unknown;
};

function requireRouteTarget(patch: ThinkingPatch): void {
  if (patch.provider.trim().length === 0) throw new Error("buildMutations：provider 路由键不能为空。");
  if (patch.model.trim().length === 0) throw new Error("buildMutations：model id 不能为空。");
}

/** 纯构造 settings.mutate 操作序列（目录路由 ↔ modelOverrides，自定义路由 ↔ models[]）。
 *
 * 路由形态分支：
 * - catalog：`modelOverrides.<id>.reasoningEfforts` 路径 set/unset，
 *   中间对象不存在由宿主自动创建，无需预读。
 * - custom：宿主 mutate 路径只穿越 plain object，`models[<i>]` 不可寻址，
 *   故按 `entry.id` 在传入的 models[] 全量中定位并生成**整数组 set**。
 *   并发编辑同路由 models[] 的写者可能互盖，S4 应透传 expectedRevision 排队。
 *
 * 不做任何 IO；非法输入直接抛中文错 fail-loud（空路由/model、custom 缺 models
 * 全量或 id 不在其中、空档位数组），与宿主 assertServiceable 的“写时即报错”一致。
 */
export function buildMutations(patch: ThinkingPatch): SettingsMutation[] {
  requireRouteTarget(patch);
  const base = ["providers", patch.provider];
  const ops: SettingsMutation[] = [];

  if (patch.defaultEffort !== undefined) {
    const path = [...base, "reasoning"];
    if (patch.defaultEffort === null) ops.push({ op: "unset", path });
    else ops.push({ op: "set", path, value: patch.defaultEffort });
  }

  if (patch.efforts === undefined) return ops;

  if (patch.routeKind === "catalog") {
    ops.push(effortsOp([...base, "modelOverrides", patch.model, "reasoningEfforts"], patch));
    return ops;
  }

  if (patch.models === undefined) {
    throw new Error(
      `buildMutations：自定义路由“${patch.provider}”须先经 listModels 读出 models[] 全量并传入 models，` +
        `纯函数凭它定位模型“${patch.model}”后生成整数组 set（宿主 mutate 路径不可寻址数组元素）。`,
    );
  }
  const index = patch.models.findIndex((entry) => entry["id"] === patch.model);
  if (index < 0) {
    throw new Error(
      `buildMutations：模型“${patch.model}”不在自定义路由“${patch.provider}”的 models[] 中；` + `新增模型条目须补协议等全量字段，请走设置页手工添加后重试。`,
    );
  }
  const next = patch.models.map((entry, i) => {
    if (i !== index) return entry;
    const updated = { ...entry };
    applyEffortsValue(updated, patch);
    return updated;
  });
  ops.push({ op: "set", path: [...base, "models"], value: next });
  return ops;
}

/** 把档位覆盖翻译成 modelOverrides 叶路径上的单步 op。 */
function effortsOp(path: string[], patch: ThinkingPatch): SettingsMutation {
  const efforts = patch.efforts;
  if (efforts === null) return { op: "unset", path };
  if (efforts === false) return { op: "set", path, value: false };
  if (Array.isArray(efforts)) return { op: "set", path, value: levelsToDict(patch.model, efforts) };
  return { op: "set", path, value: { ...(efforts as Record<string, string | null>) } };
}

/** 把档位覆盖施加到 models[] 目标条目副本上（null=删键=跟随自带）。 */
function applyEffortsValue(entry: Record<string, unknown>, patch: ThinkingPatch): void {
  const efforts = patch.efforts;
  if (efforts === null) {
    delete entry["reasoningEfforts"];
  } else if (efforts === false) {
    entry["reasoningEfforts"] = false;
  } else if (Array.isArray(efforts)) {
    entry["reasoningEfforts"] = levelsToDict(patch.model, efforts);
  } else {
    entry["reasoningEfforts"] = { ...(efforts as Record<string, string | null>) };
  }
}

/** string[] → identity 字典（wire 拼写 = 档名）；空数组是宿主非法值，直接抛。 */
function levelsToDict(model: string, levels: string[]): Record<string, string> {
  if (levels.length === 0) {
    throw new Error(`buildMutations：模型“${model}”的 reasoningEfforts 为空数组是宿主非法值；` + `声明非推理模型请用 false，清除覆盖请用 null。`);
  }
  const dict: Record<string, string> = {};
  for (const level of levels) dict[level] = level;
  return dict;
}
