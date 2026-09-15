/** 错误翻译：把裸模型错误码翻成中文可行动文案（纯函数，无宿主调用）。
 *
 * 设计意图：`UNKNOWN_MODEL` / `UNSUPPORTED_REASONING_EFFORT` / `RATE_LIMIT` 这类
 * 错误裸抛时用户不知道“缺哪个 id、去哪改、配什么能好”。本模块只做“码 → 文案”
 * 的纯映射，展示位置（Models 页 footer / 失配可修列表）与触发时机归 cordis.ts；
 * 未知 code 必须原文直通，禁止改写或吞掉细节。
 */

export type LlmErrorDetail = {
  provider: string;
  model: string;
  /** 该模型自带可用档（仅 UNSUPPORTED_REASONING_EFFORT 用到，用于列出合法档）。 */
  efforts?: string[];
};

/** 翻译结果：标题 + 说明正文 + 可执行动作清单（UI 逐条渲染）。 */
export type LlmErrorAdvice = {
  title: string;
  body: string;
  actions: string[];
};

function modelRef(detail: LlmErrorDetail): string {
  return `${detail.provider}/${detail.model}`;
}

function unknownModelAdvice(detail: LlmErrorDetail): LlmErrorAdvice {
  return {
    title: `未知模型：${modelRef(detail)}`,
    body:
      `模型 id“${detail.model}”在路由“${detail.provider}”的可用列表里不存在，` +
      `请求尚未发出。请检查路由配置：目录路由核对 modelOverrides 下的 id 拼写，` +
      `自定义路由检查 models[] 是否收录该 id；写错的覆盖会被记入 modelErrors，可在原处改名修复。`,
    actions: [
      `检查 llm-pi-ai.providers.${detail.provider} 路由配置`,
      `核对模型 id“${detail.model}”拼写，或删除错误的 modelOverrides/models 条目`,
      `在设置页 Models 的失配列表中改名修复`,
    ],
  };
}

function unsupportedEffortAdvice(detail: LlmErrorDetail): LlmErrorAdvice {
  const efforts = detail.efforts ?? [];
  const supported = efforts.length > 0 ? `该模型支持的思考档为：${efforts.join("、")}。` : `该模型未声明可用思考档（可能是非推理模型）。`;
  return {
    title: `该模型不支持请求的思考档：${modelRef(detail)}`,
    body:
      `${supported}显式请求的档位若不在此列会直接报错；` +
      `路由级 reasoning 默认值若对该模型非法会被静默丢弃（配了不生效又无报错即此原因）。` +
      `请改用支持档显式覆盖，或清除覆盖跟随自带。`,
    actions:
      efforts.length > 0
        ? [`改用该模型支持的档：${efforts.join(" / ")}`, `或清除该模型的思考强度覆盖，跟随自带默认`]
        : [`清除该模型的思考强度覆盖（非推理模型不要配思考档）`],
  };
}

function rateLimitAdvice(detail: LlmErrorDetail): LlmErrorAdvice {
  return {
    title: `触发远端限流：${modelRef(detail)}`,
    body:
      `远端返回 429，服务端配额按 key / provider 共享，burst 打过去只会吃掉重试次数。` +
      `建议在本插件为该 provider 配 RPM 上限（model 桶可再收紧贵慢模型），` +
      `把 burst 拦在本地排队等待；同时检查服务商控制台的配额与 retry-after。`,
    actions: [
      `为 ${detail.provider} 配置 RPM 上限，必要时再给 ${modelRef(detail)} 加模型级覆盖`,
      `降低该模型的并发上限，把 burst 摊平`,
      `检查服务商控制台配额与账单状态`,
    ],
  };
}

/** 已知错误码 → 中文可行动文案；未知 code 原文直通（title/body 均为原码，actions 为空）。 */
export function translateLlmError(code: string, detail: LlmErrorDetail): LlmErrorAdvice {
  switch (code) {
    case "UNKNOWN_MODEL":
      return unknownModelAdvice(detail);
    case "UNSUPPORTED_REASONING_EFFORT":
      return unsupportedEffortAdvice(detail);
    case "RATE_LIMIT":
      return rateLimitAdvice(detail);
    default:
      return { title: code, body: code, actions: [] };
  }
}
