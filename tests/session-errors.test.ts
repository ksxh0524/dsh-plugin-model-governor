/** session-header 单测 + describe 入参归一。
 *
 * 设计意图：header 部分用真 AsyncLocalStorage 断“函数级真实语义”（已有头不覆盖、
 * 无 store 透传、uuid 进程内稳定、withStore 的 return/throw 透传进下游生成器）；
 * provider 过滤由 cordis 层保证，不在此测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { SESSION_HEADER, headerValueFor, patchFetch, withStore, type SessionHeaderStore } from "../src/session-header.ts";
import { buildDescribeInput } from "../src/describe-input.ts";

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

test("buildDescribeInput：归一化去空（缺省=查全部）", () => {
  assert.deepEqual(buildDescribeInput(undefined, undefined), {});
  assert.deepEqual(buildDescribeInput("  buzz  ", "  "), { provider: "buzz" });
  assert.deepEqual(buildDescribeInput(42, null), {});
  assert.deepEqual(buildDescribeInput("p", "m"), { provider: "p", model: "m" });
});
