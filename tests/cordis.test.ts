/** cordis.test.ts —— S4 服务端入口契约测试（不起真插件，桩 ctx + 真 limiter/config/session-header）：
 *  ① 原型 SRC 标记形态 = typert-protocol mark() 产物（version:1 + direct，
 *     describe/configure/probe/probeStatus/cancelProbe 五方法）；
 *  ② SRC 参数解析复刻（网关 methodParameterNames：括号切分 + 纯标识符过滤，`: unknown` 注解 strip 后可带）；
 *  ③ applyCordis 经 ctx.reflect.provide 注册 governor 服务 + default 三键同源 + inject 声明；
 *  ④ `llm/stream` 监听行为：双桶 acquire（provider 桶用线路口径、模型桶用 pair 生效值，
 *     min 语义）→ header 条件包裹 → `next()` 恰一次 → finally 双 release；abort 放弃且不调 next；
 *     非目标 provider / 无 sessionId 只跳过 header；探测旁路跳过 acquire 但 header 照常；
 *     成败 exactly-once 进 noteOutcome（熔断口子），口子永不抛、不断流；
 *  ⑤ describe 限流读出（按 filter 列 id + 生效限流；provider 缺席但 model 在场按 model 过滤；
 *     不读模型元数据、不抛）；
 *  ⑥ configure 写回（非法补丁中文拒收；思考键已移除、再传按未知键拒收；某维 null=删除回落；
 *     live 限流即时生效）；
 *  ⑦ probe 两阶段探测（小 RPM 单发定论、大水管 burst 逼近；触顶自动填入 provider 级 rpm，
 *     未触顶/失败/取消一律不写；单飞行 busy；cancelProbe 取消）。
 *
 * fetch 说明：applyCordis 会补丁 globalThis.fetch（header 机制本体的另一半）；模块级 after 钩子
 * 统一还原，header 断言走“桩 fetch 捕获头”而非真实网络。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import governorDefault, { applyCordis, GovernorService, inject, name } from "../src/cordis.ts";

const MARKER_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";
const SESSION_HEADER = "x-opencode-session";
/** suite 内用到的真 fetch 引用（applyCordis 补丁前保存，after 统一还原，防跨文件污染）。 */
const REAL_FETCH = globalThis.fetch;
after(() => {
  globalThis.fetch = REAL_FETCH;
});

/** 原型标记的运行时形态（跨副本可读，测试侧本地声明，避免 import 宿主协议包）。 */
interface RemoteMethodsMarker {
  version: number;
  methods: Array<{ method: string; invocation: { kind: string } }>;
}
/** 桩 ctx：真实形态由运行时决定，测试只关心被断言的子集，故宽类型为 any。 */
type StubCtx = any;

/** 网关 methodParameterNames 的解析复刻（dsh-check contract.ts 同款；`: unknown` 经 type-strip 变空白后仍得纯标识符）。 */
const srcParamNames = (fn: Function): string[] => {
  const source = Function.prototype.toString.call(fn);
  const open = source.indexOf("(");
  const close = source.indexOf(")", open + 1);
  return source
    .slice(open + 1, close)
    .split(",")
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z_$][\w$]*$/.test(token));
};

function makeLlm(overrides: Record<string, unknown> = {}): any {
  return {
    listProviders: async () => [{ id: "opencode" }],
    listModels: async (provider: string) => (provider === "opencode" ? [{ id: "qwen3-coder", name: "Qwen3 Coder" }] : []),
    ...overrides,
  };
}

function makeCtx(opts: { llm?: any } = {}): {
  ctx: StubCtx;
  provided: Record<string, unknown>;
  listeners: Array<{ event: string; fn: Function; opts: unknown }>;
  logs: string[];
} {
  const provided: Record<string, unknown> = {};
  const listeners: Array<{ event: string; fn: Function; opts: unknown }> = [];
  const logs: string[] = [];
  const ctx: StubCtx = {
    reflect: {
      provide: (key: string, svc: unknown) => {
        provided[key] = svc;
        return () => {
          delete provided[key];
        };
      },
    },
    on: (event: string, fn: Function, listenerOpts?: unknown) => {
      listeners.push({ event, fn, opts: listenerOpts });
      return () => {};
    },
    get: (serviceName: string) => {
      if (serviceName === "llm") return opts.llm;
      return undefined;
    },
    effect: (fn: () => () => void) => fn(),
    logger: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
    },
  };
  return { ctx, provided, listeners, logs };
}

function streamListenerOf(listeners: Array<{ event: string; fn: Function; opts: unknown }>): Function {
  const hit = listeners.find((l) => l.event === "llm/stream");
  assert.ok(hit, "applyCordis 必须注册 llm/stream 监听");
  assert.deepEqual(hit.opts, { prepend: true }, "监听须 prepend（与 RPM 中间件同一拦截点，排队优先）");
  return hit.fn;
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

test("SRC 标记与 typertRemote 绑定形态符合 gateway 读取契约", () => {
  const marker = Object.getOwnPropertyDescriptor(GovernorService.prototype, MARKER_KEY) as { value: RemoteMethodsMarker } | undefined;
  assert.ok(marker, "原型必须挂字符串键 remote-methods 标记（跨副本可读）");
  assert.equal(marker.value.version, 1);
  assert.deepEqual(
    marker.value.methods.map((m) => m.method),
    ["describe", "configure", "probe", "probeStatus", "cancelProbe"],
    "Remote 收口为 describe/configure/probe/probeStatus/cancelProbe 五方法",
  );
  assert.deepEqual(
    marker.value.methods.map((m) => m.invocation.kind),
    ["direct", "direct", "direct", "direct", "direct"],
  );
  // SRC 参数形态：单形参纯标识符；`: unknown` 注解经 type-strip 后只剩空白，解析仍得标识符。
  const proto = GovernorService.prototype as any;
  assert.deepEqual(srcParamNames(proto.describe), ["filter"], "describe wire 参数名 = filter");
  assert.deepEqual(srcParamNames(proto.configure), ["patch"], "configure wire 参数名 = patch");
  assert.deepEqual(srcParamNames(proto.probe), ["spec"], "probe wire 参数名 = spec");
  assert.deepEqual(srcParamNames(proto.probeStatus), ["filter"], "probeStatus wire 参数名 = filter");
  assert.deepEqual(srcParamNames(proto.cancelProbe), ["target"], "cancelProbe wire 参数名 = target");
});

test("default 三键同源 + applyCordis 提供注册", () => {
  assert.equal(name, "model-governor");
  assert.deepEqual(inject, ["llm"], "插件级等待面仅 llm（reflect/settings 禁止进等待面）");
  assert.equal(governorDefault.name, name);
  assert.equal(governorDefault.inject, inject);
  assert.equal(governorDefault.apply, applyCordis);
  const { ctx, provided } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  assert.ok(svc instanceof GovernorService);
  assert.equal(provided.governor, svc, '必须以 provide("governor") 注册（与 descriptor.namespace 对齐）');
  assert.equal(svc.typertRemote.service, svc, "binding.service 必须 === receiver 本体");
  assert.equal(svc.typertRemote.serviceKey, "governor");
  assert.equal(svc.typertRemote.namespace, "governor");
});

test("监听：不限流直通 + next() 恰调一次", async () => {
  const { ctx, listeners } = makeCtx({ llm: makeLlm() });
  applyCordis(ctx, {});
  const onStream = streamListenerOf(listeners);
  let nextCalls = 0;
  const next = () =>
    (async function* () {
      nextCalls += 1;
      yield "a";
      yield "b";
    })();
  // 无 sessionId：跳过 header 只限流，原样委托。
  const chunks = await drain((onStream as any)({ provider: "other", model: "m" }, next));
  assert.deepEqual(chunks, ["a", "b"]);
  assert.equal(nextCalls, 1, "next() 恰调一次");
});

test("监听：目标 provider + sessionId 走 header store（fetch 捕获会话头）", async () => {
  const seen: Array<{ url: unknown; headers: Headers }> = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    seen.push({ url: input, headers: new Headers(init?.headers) });
    return { ok: true } as any;
  }) as any;
  const { ctx, listeners } = makeCtx({ llm: makeLlm() });
  applyCordis(ctx, {});
  const onStream = streamListenerOf(listeners);
  const next = () =>
    (async function* () {
      await globalThis.fetch("http://governor-fixture.local/v1", {});
      yield "ok";
    })();
  const chunks = await drain((onStream as any)({ provider: "opencode", model: "qwen3-coder", sessionId: "s-1" }, next));
  assert.deepEqual(chunks, ["ok"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get(SESSION_HEADER), "s-1", "下游 fetch 须带上会话头（ALS store 穿越）");
});

test("监听：非目标 provider 不加头", async () => {
  const seen: Array<{ headers: Headers }> = [];
  globalThis.fetch = (async (_input: any, init?: any) => {
    seen.push({ headers: new Headers(init?.headers) });
    return { ok: true } as any;
  }) as any;
  const { ctx, listeners } = makeCtx({ llm: makeLlm() });
  applyCordis(ctx, {});
  const onStream = streamListenerOf(listeners);
  const next = () =>
    (async function* () {
      await globalThis.fetch("http://governor-fixture.local/v1", {});
      yield "ok";
    })();
  await drain((onStream as any)({ provider: "other", model: "m", sessionId: "s-1" }, next));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get(SESSION_HEADER), null, "非目标 provider 须跳过 header（只限流）");
});

test("监听：并发槽在 finally 归还（同 key 串行两次不卡死）", async () => {
  const { ctx, listeners } = makeCtx({ llm: makeLlm() });
  applyCordis(ctx, { limits: { providers: { p: { maxConcurrent: 1 } } } });
  const onStream = streamListenerOf(listeners);
  const runOnce = () =>
    drain(
      (onStream as any)({ provider: "p", model: "m" }, () =>
        (async function* () {
          yield "x";
        })(),
      ),
    );
  assert.deepEqual(await withTimeout(runOnce(), 2000, "第一次 acquire 超时"), ["x"]);
  assert.deepEqual(await withTimeout(runOnce(), 2000, "限流槽未释放：第二次 acquire 超时（finally release 缺失）"), ["x"]);
});

test("监听：abort 放弃排队且不调 next", async () => {
  const { ctx, listeners } = makeCtx({ llm: makeLlm() });
  applyCordis(ctx, {});
  const onStream = streamListenerOf(listeners);
  const controller = new AbortController();
  controller.abort(new Error("test-abort"));
  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
    return (async function* () {
      yield "never";
    })();
  };
  await assert.rejects(drain((onStream as any)({ provider: "p", model: "m", signal: controller.signal }, next)));
  assert.equal(nextCalls, 0, "abort 即放弃排队：next() 不得调用");
});

test("describe：单模型限流读出（provider/model 键 + 生效限流）", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const result = await svc.describe({ provider: "opencode", model: "qwen3-coder" });
  assert.deepEqual(result.filter, { provider: "opencode", model: "qwen3-coder" });
  assert.equal(result.models.length, 1);
  assert.deepEqual(result.models[0], { provider: "opencode", model: "qwen3-coder", limits: {} });
});

test("describe：读出不碰模型元数据（无 resolve 系调用也照常出数）", async () => {
  let metaCalls = 0;
  const llm = makeLlm({
    resolveModelInfo: async () => {
      metaCalls += 1;
      throw new Error("must not be called");
    },
    resolveModel: async () => {
      metaCalls += 1;
      throw new Error("must not be called");
    },
  });
  const { ctx } = makeCtx({ llm });
  const svc = applyCordis(ctx, {});
  const result = await svc.describe({ provider: "opencode" });
  assert.equal(result.models.length, 1);
  assert.deepEqual(result.models[0].limits, {});
  assert.equal(metaCalls, 0, "RPM 读出只列 id + 合并限流，不读模型元数据");
});

test("describe：空 filter 枚举全部路由模型", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const result = await svc.describe(undefined);
  assert.deepEqual(result.filter, {});
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].model, "qwen3-coder");
});

test("configure：非法补丁中文拒收", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const result = await svc.configure({ limits: { defaults: { rpm: 0 } } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  for (const message of result.errors) assert.match(message, /[一-鿿]/, "逐条中文报错");
});

test("configure：思考键已移除（再传按未知键拒收）", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const result = await svc.configure({ provider: "opencode", model: "qwen3-coder", efforts: ["low"] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("；"), /未知配置项/, "思考覆盖整包移除，只认 limits/sessionHeader");
});

test("configure：governor 切片并入 live（后续限流/读出即时生效）", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const result = await svc.configure({ limits: { defaults: { rpm: 60 } } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied, { governor: { limits: { defaults: { rpm: 60 } } } });
  const readout = await svc.describe({ provider: "opencode", model: "qwen3-coder" });
  assert.deepEqual(readout.models[0].limits, { rpm: 60 }, "live 配置须即时影响 effectiveLimits");
});

test("configure：未知顶层键拒收", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const unknown = await svc.configure({ bogus: 1 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join("；"), /未知配置项/);
});

test("noteOutcome：熔断口子永不抛；下游炸流照常透传且不占名额", async () => {
  const { ctx, listeners } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {}) as GovernorService;
  assert.doesNotThrow(() => svc.noteOutcome("opencode", undefined));
  assert.doesNotThrow(() => svc.noteOutcome("opencode", new Error("boom")));
  const listen = streamListenerOf(listeners);
  const boom = new Error("downstream boom");
  await assert.rejects(
    drain(
      listen({ provider: "opencode", model: "qwen3-coder", sessionId: "s1" }, async function* () {
        throw boom;
      }),
    ),
    (err: unknown) => err === boom,
    "下游错误须原样透传（口子只收信号不改流）",
  );
  // 名额已归还：同一 key 再走一次成功流不卡死。
  const chunks = await drain(
    listen({ provider: "opencode", model: "qwen3-coder", sessionId: "s1" }, async function* () {
      yield "ok";
    }),
  );
  assert.deepEqual(chunks, ["ok"]);
});

/* ---------- 审查修复回归 ---------- */

test("监听：provider 桶用线路口径（模型级 rpm 不连带卡死其他模型）", async () => {
  const { ctx, listeners } = makeCtx({ llm: makeLlm() });
  applyCordis(ctx, { limits: { providers: { p: { rpm: 100 } }, models: { "p/m": { rpm: 1 } } } });
  const onStream = streamListenerOf(listeners);
  const run = (model: string, signal?: AbortSignal) =>
    drain(
      (onStream as any)({ provider: "p", model, signal }, () =>
        (async function* () {
          yield "x";
        })(),
      ),
    );
  await withTimeout(run("m"), 2000, "首个 p/m 超时");
  const stopper = new AbortController();
  const second = run("m", stopper.signal); // 占模型桶 rpm:1，应排队
  try {
    // 线路桶余量充足（1/100）：p/other 必须立即过（旧口径会跟在 p/m 后面排 60s）。
    assert.deepEqual(await withTimeout(run("other"), 2000, "p/other 被模型级 rpm 连带卡死：provider 桶误用 pair 口径"), ["x"]);
  } finally {
    stopper.abort();
    await assert.rejects(second, "排队的第二个 p/m 应随 abort 撤出");
  }
});

test("监听：探测旁路跳过 acquire（本地 rpm=1 也不排队），header 照常", async () => {
  const seen: Array<{ headers: Headers }> = [];
  globalThis.fetch = (async (_input: any, init?: any) => {
    seen.push({ headers: new Headers(init?.headers) });
    return { ok: true } as any;
  }) as any;
  const { ctx, listeners } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, { limits: { defaults: { rpm: 1 } } });
  const onStream = streamListenerOf(listeners);
  const run = (signal?: AbortSignal) =>
    drain(
      (onStream as any)({ provider: "opencode", model: "m", sessionId: "s-bypass", signal }, () =>
        (async function* () {
          await globalThis.fetch("http://governor-fixture.local/v1", {});
          yield "x";
        })(),
      ),
    );
  await withTimeout(run(), 2000, "首个请求超时");
  const stopper = new AbortController();
  const blocked = run(stopper.signal); // 占掉 rpm:1，排队中
  try {
    const bypassed = await withTimeout(
      svc.probeBypass.run(true, () => run()),
      2000,
      "旁路流量应跳过本地排队直通",
    );
    assert.deepEqual(bypassed, ["x"]);
    assert.equal(seen[seen.length - 1].headers.get(SESSION_HEADER), "s-bypass", "旁路只跳限流，header 照常进 store");
    // 正常流量仍在排队：短超时内不得完成（排队语义未被旁路破坏）。
    await assert.rejects(
      withTimeout(
        blocked.then(() => "leaked"),
        300,
        "排队流量被旁路提前放行",
      ),
      /排队流量被旁路提前放行/,
    );
  } finally {
    stopper.abort();
    await assert.rejects(blocked, "排队的请求应随 abort 撤出");
  }
});

test("configure：某维 null=删除回落（删掉已设值，不限流请省略、删除请 null）", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  assert.equal((await svc.configure({ limits: { providers: { p: { rpm: 60 } } } })).ok, true);
  assert.deepEqual((await svc.describe({ provider: "p", model: "m" })).models[0].limits, { rpm: 60 });
  const cleared = await svc.configure({ limits: { providers: { p: { rpm: null } } } });
  assert.equal(cleared.ok, true);
  assert.deepEqual((await svc.describe({ provider: "p", model: "m" })).models[0].limits, {}, "删掉后回落上层（空=不限）");
});

test("describe：provider 缺席但 model 在场按 model 精确过滤", async () => {
  const llm = makeLlm({
    listProviders: async () => [{ id: "opencode" }, { id: "buzz" }],
    listModels: async (provider: string) => (provider === "opencode" ? [{ id: "a" }, { id: "b" }] : [{ id: "b" }]),
  });
  const { ctx } = makeCtx({ llm });
  const svc = applyCordis(ctx, {});
  const result = await svc.describe({ model: "b" });
  assert.equal(result.models.length, 2);
  for (const entry of result.models) assert.equal(entry.model, "b");
});

/* ---------- probe ---------- */

type ProbeBehavior = "ok" | "limited" | "quota" | "auth";

/** 脚本化桩 llm（按调用序号落地终端块；小延迟让出事件循环，感知 abort）。 */
function makeProbeLlm(behavior: (callIndex: number) => ProbeBehavior, delayMs = 5): any {
  let calls = 0;
  const seen: any[] = [];
  return {
    listProviders: async () => [{ id: "p" }],
    listModels: async () => [{ id: "m" }],
    seen,
    stream: (options: any) =>
      (async function* () {
        const n = calls++;
        seen.push(options);
        await new Promise((r) => setTimeout(r, delayMs));
        if (options.signal?.aborted) {
          yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "cancelled" } } };
          return;
        }
        const kind = behavior(n);
        if (kind === "ok") yield { type: "finish", reason: { kind: "stop" } };
        else if (kind === "limited") {
          yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "429 slow down" } } };
        } else if (kind === "quota") {
          yield { type: "finish", reason: { kind: "error", failure: { code: "QUOTA", message: "out of credits" } } };
        } else {
          yield { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "invalid key" } } };
        }
      })(),
  };
}

async function waitProbeDone(svc: GovernorService, provider: string, timeoutMs = 15000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const status = await svc.probeStatus({ provider });
    if (status.state === "done" && status.result !== undefined) return status.result;
    if (Date.now() - start > timeoutMs) throw new Error(`等探测结论超时：${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("probe：小 RPM 单发定论（3 成功后 429 → 估计 3 并自动填入）", async () => {
  const { ctx } = makeCtx({ llm: undefined });
  const svc = applyCordis(ctx, {});
  const stub = makeProbeLlm((n) => (n < 3 ? "ok" : "limited"));
  ctx.get = (
    (_inner: unknown) => (_name: string) =>
      _inner
  )(stub);
  const started = await svc.probe({ provider: "p", phaseA: 10, bursts: [], maxRequests: 20 });
  assert.equal(started.ok, true);
  const result = await waitProbeDone(svc, "p");
  assert.equal(result.topped, true);
  assert.equal(result.estimate, 3);
  assert.equal(result.applied, true);
  assert.equal(result.appliedRpm, 3);
  assert.match(result.note, /已自动填入/);
  assert.deepEqual((await svc.describe({ provider: "p", model: "m" })).models[0].limits, { rpm: 3 }, "触顶必须自动填入 provider 级 rpm");
  // 400 回归：探测请求 maxTokens 缺省 16（不再是 1），且透传到远端。
  assert.ok(stub.seen.length > 0);
  for (const options of stub.seen) assert.equal(options.maxTokens, 16);
});

test("probe：maxTokens 可调（网关下限各异时透传自定义值）", async () => {
  const { ctx } = makeCtx({ llm: undefined });
  const svc = applyCordis(ctx, {});
  const stub = makeProbeLlm(() => "ok");
  ctx.get = (
    (_inner: unknown) => (_name: string) =>
      _inner
  )(stub);
  assert.equal((await svc.probe({ provider: "p", phaseA: 2, bursts: [], maxRequests: 2, maxTokens: 32 })).ok, true);
  await waitProbeDone(svc, "p");
  assert.equal(stub.seen.length, 2);
  for (const options of stub.seen) assert.equal(options.maxTokens, 32);
});

test("probe：端到端走真监听器（本地 rpm=1 不污染探测）", async () => {
  const { ctx, listeners } = makeCtx({ llm: undefined });
  const svc = applyCordis(ctx, { limits: { defaults: { rpm: 1 } } });
  const onStream = streamListenerOf(listeners);
  let n = 0;
  const scripted = makeProbeLlm(() => {
    n += 1;
    return "ok";
  });
  // 宿主 llm 面 = 瀑布直通：stream 进监听器，下游按脚本落地（5 个全过）。
  ctx.get = () => ({
    listProviders: async () => [{ id: "p" }],
    listModels: async () => [{ id: "m" }],
    stream: (options: any) => (onStream as any)(options, () => scripted.stream(options)),
  });
  const started = await svc.probe({ provider: "p", phaseA: 5, bursts: [], maxRequests: 5 });
  assert.equal(started.ok, true);
  const result = await waitProbeDone(svc, "p", 10000);
  assert.equal(n, 5);
  assert.equal(result.topped, false, "全过=未触顶");
  assert.equal(result.applied, false, "未触顶绝不写配置");
  assert.deepEqual((await svc.describe({ provider: "p", model: "m" })).models[0].limits, { rpm: 1 }, "本地配置保持原样");
});

test("probe：配额见底停探不写（QUOTA≠RPM）", async () => {
  const { ctx } = makeCtx({ llm: undefined });
  const svc = applyCordis(ctx, {});
  ctx.get = (
    (_inner: unknown) => (_name: string) =>
      _inner
  )(makeProbeLlm(() => "quota"));
  assert.equal((await svc.probe({ provider: "p", phaseA: 5, bursts: [] })).ok, true);
  const result = await waitProbeDone(svc, "p");
  assert.equal(result.topped, false);
  assert.equal(result.applied, false);
  assert.equal(result.failure?.code, "QUOTA");
  assert.match(result.note, /未写入/);
  assert.deepEqual((await svc.describe({ provider: "p", model: "m" })).models[0].limits, {});
});

test("probe：单飞行 busy + cancelProbe 取消", async () => {
  const { ctx } = makeCtx({ llm: undefined });
  const svc = applyCordis(ctx, {});
  ctx.get = (
    (_inner: unknown) => (_name: string) =>
      _inner
  )(makeProbeLlm(() => "ok", 30));
  assert.equal((await svc.probe({ provider: "p", phaseA: 30, bursts: [], maxRequests: 30 })).ok, true);
  const busy = await svc.probe({ provider: "p", phaseA: 1 });
  assert.equal(busy.ok, false);
  assert.match(busy.errors.join("；"), /已有探测在跑/);
  const running = await svc.probeStatus({ provider: "p" });
  assert.equal(running.state, "running");
  assert.ok((running.sent ?? 0) >= 0);
  assert.deepEqual(await svc.cancelProbe({ provider: "p" }), { ok: true, cancelled: true, errors: [] });
  const result = await waitProbeDone(svc, "p");
  assert.equal(result.cancelled, true);
  assert.equal(result.applied, false);
  assert.deepEqual(await svc.cancelProbe({ provider: "p" }), { ok: true, cancelled: false, errors: [] }, "idle 再取消照常 ok");
});

test("probe：非法参数中文拒收；status/cancel 无 provider 行为", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const bad = await svc.probe({ phaseA: 999 });
  assert.equal(bad.ok, false);
  for (const message of bad.errors) assert.match(message, /[一-鿿]/);
  assert.deepEqual(await svc.probeStatus({ provider: "never-ran" }), { state: "idle" });
  assert.deepEqual(await svc.probeStatus({}), { state: "idle" });
  const noTarget = await svc.cancelProbe({});
  assert.equal(noTarget.ok, false);
});
