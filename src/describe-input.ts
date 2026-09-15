/** describe 入参归一化（无宿主调用的纯函数）。
 *
 * 设计意图：describe(filter) 的 `{provider?, model?}` 归一（非字符串/空串按未指定处理，
 * 缺省=查全部）。思考档位覆盖已整包移除（2026-09-16 起本包只管 RPM 限流 + OpenCode
 * 会话头），本文件只剩这一件事。
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
