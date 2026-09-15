/** session 兼容头：`llm/stream` 瀑布监听 + AsyncLocalStorage + globalThis.fetch 补丁。
 *
 * 设计意图：OpenCode 系中继把携带同一 `x-opencode-session` 值的请求钉到同一上游，
 * 跨 turn 保住 prompt cache 亲和并治 400 MissingSessionID。本文件只放可单测的纯机制
 * （取值/透传包装/fetch 补丁），provider 过滤与 `next()` 调度归 cordis.ts 监听器。
 *
 * 出处与许可：移植自 `dsh-opencode-session`（作者 nobu121，MIT License），原文
 * `~/.dsh/profiles/web/node_modules/dsh-opencode-session/lib/index.js`（216 行）。
 * 语义与原文逐行一致：header 已存在不覆盖、空 sessionId 不产值、uuid 模式进程内
 * 按 sessionId 稳定、withStore 逐次 `next()` 进 store 而 `return` 直透。
 */

import { randomUUID } from "node:crypto";

/** OpenCode 中继识别会话亲和的请求头名（与原包同名，改名即失效）。 */
export const SESSION_HEADER = "x-opencode-session";

/** 头取值模式：复用 DSH 会话 id，或按会话 id 派生进程内稳定的随机 uuid。 */
export type SessionHeaderMode = "session-id" | "uuid";

/** 跟随一次模型调用穿越 adapter 的最小状态：不透明头值。 */
export type SessionHeaderStore = { value: string };

/** 对 AsyncLocalStorage 的最小结构依赖（真 ALS 与测试替身皆可满足）。 */
export type AsyncStore<T> = {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
};

/** 为一个 DSH 会话 id 派生不透明头值（语义与原包 `headerValueFor` 一致）。
 *
 * - 空串 sessionId 无意义，返回 undefined（调用方应跳过 header 只限流）。
 * - `session-id` 模式直接复用 id：跨 turn 且跨重启稳定、同会话共享上游。
 * - `uuid` 模式按 sessionId 查表，缺失即 `randomUUID()` 落表：进程内稳定、
 *   进程重启即换（不透明，但丢掉跨重启亲和）。
 */
export function headerValueFor(sessionId: unknown, mode: SessionHeaderMode, table: Map<string, string>): string | undefined {
  const raw = String(sessionId);
  if (raw.length === 0) return undefined;
  if (mode !== "uuid") return raw;
  let value = table.get(raw);
  if (value === undefined) {
    value = randomUUID();
    table.set(raw, value);
  }
  return value;
}

/** withStore 产出的流形态：next/return/throw 三件齐（相对 AsyncIterableIterator
 * 把可选的 return/throw 收紧为必备——cordis 层 abort/收尾依赖它们直达下游）。 */
export type StoredStream<T> = AsyncIterableIterator<T> & {
  return(value?: T): Promise<IteratorResult<T>>;
  throw(error?: unknown): Promise<IteratorResult<T>>;
};

/** 把下游异步流包进 ALS store：每次拉取都发生在 `als.run` 内（语义与原文一致）。
 *
 * Async 生成器及其派生 promise 只要从 `als.run` 内的 pull 驱动就继承 store，
 * 因此包装器对每次 `next()` 单独 `als.run`。`return` 故意不进 store（下游 teardown
 * 语义，失败吞掉按 done 处理）；`throw` 进 store 后透传给下游迭代器。
 */
export function withStore<T>(iterable: AsyncIterable<T> | AsyncIterator<T>, store: SessionHeaderStore, als: AsyncStore<SessionHeaderStore>): StoredStream<T> {
  const iterator: AsyncIterator<T> =
    typeof (iterable as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
      ? (iterable as AsyncIterable<T>)[Symbol.asyncIterator]()
      : (iterable as AsyncIterator<T>);
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<T>> {
      return als.run(store, () => iterator.next());
    },
    async return(value?: T): Promise<IteratorResult<T>> {
      if (typeof iterator.return === "function") {
        try {
          return await iterator.return(value);
        } catch {
          // 下游流可能已拆除，按结束处理（与原包一致）。
        }
      }
      return { done: true, value: value as T };
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      if (typeof iterator.throw === "function") {
        return als.run(store, () => (iterator.throw as (e?: unknown) => Promise<IteratorResult<T>>)(error));
      }
      throw error;
    },
  };
}

/** 请求已带会话头则为真（私有：init.headers 优先，否则取 Request 自身头）。 */
function hasSessionHeader(input: unknown, init?: { headers?: ConstructorParameters<typeof Headers>[0] }): boolean {
  const source = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  if (source === undefined) return false;
  try {
    return new Headers(source).has(SESSION_HEADER);
  } catch {
    return false;
  }
}

/** 构造补丁 fetch：store 活跃且请求尚未带头时并入头（语义与原文一致）。
 *
 * 头合并优先级沿用原生 fetch：`init.headers` 存在即以它为基，否则用 Request 自身头；
 * 已带头的请求一律不覆盖（调用方显式值优先）。无 store 时原样透传。
 */
export function patchFetch(original: typeof globalThis.fetch, als: AsyncStore<SessionHeaderStore>): typeof globalThis.fetch {
  return function patchedFetch(this: unknown, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
    const state = als.getStore();
    if (state && !hasSessionHeader(input, init)) {
      const base = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
      const headers = new Headers(base);
      headers.set(SESSION_HEADER, state.value);
      return original.call(this, input, { ...init, headers });
    }
    return original.call(this, input, init);
  };
}
