/** cordis.test.ts —— S4 服务端入口契约测试（不起真宿主，桩 ctx + 真 limiter/config/session-header）：
 *  ① 原型 SRC 标记形态 = typert-protocol mark() 产物（version:1 + direct，describe/configure 双方法）；
 *  ② SRC 参数解析复刻（网关 methodParameterNames：括号切分 + 纯标识符过滤，`: unknown` 注解 strip 后可带）；
 *  ③ applyCordis 经 ctx.reflect.provide 注册 governor 服务 + default 三键同源 + inject 声明；
 *  ④ `llm/stream` 监听行为：双桶 acquire（min 语义）→ header 条件包裹 → `next()` 恰一次 →
 *     finally 双 release；abort 放弃且不调 next；非目标 provider / 无 sessionId 只跳过 header；
 *  ⑤ describe 合并读出（自带档位/默认档/上下文/输出/生效限流/issues；失配折 UNKNOWN_MODEL 可修文案）；
 *  ⑥ configure 写回（非法补丁中文拒收且不落盘；catalog/custom 落 settings.mutate；live 限流即时生效）。
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
/** 桩宿主 ctx：真实形态由宿主决定，测试只关心被断言的子集，故宽类型为 any。 */
type StubCtx = any;

const MODEL_INFO = {
  provider: "opencode",
  id: "qwen3-coder",
  name: "Qwen3 Coder",
  reasoning: {
    efforts: [
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
    ],
    defaultEffort: "high",
  },
  context: { contextWindow: 262144 },
  defaultMaxTokens: 32000,
};

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

function unknownModelError(): Error {
  const err = new Error('unknown model opencode/ghost "x"') as Error & { code: string };
  err.code = "UNKNOWN_MODEL";
  return err;
}

function makeLlm(overrides: Record<string, unknown> = {}): any {
  return {
    listProviders: async () => [{ id: "opencode" }],
    listModels: async (provider: string) => (provider === "opencode" ? [{ id: "qwen3-coder", name: "Qwen3 Coder" }] : []),
    resolveModelInfo: async (provider: string, model: string) => {
      if (provider === "opencode" && model === "qwen3-coder") return MODEL_INFO;
      throw unknownModelError();
    },
    ...overrides,
  };
}

function makeSettings(captured: Record<string, unknown>, value: unknown = { providers: {} }, revision = 7): any {
  return {
    describe: () => [{ ns: "llm-pi-ai", value, revision }],
    mutate: async (ns: unknown, ops: unknown, rev?: unknown) => {
      captured.ns = ns;
      captured.ops = ops;
      captured.rev = rev;
    },
  };
}

function makeCtx(opts: { llm?: any; settings?: any; injectSettings?: boolean } = {}): {
  ctx: StubCtx;
  provided: Record<string, unknown>;
  listeners: Array<{ event: string; fn: Function; opts: unknown }>;
  logs: string[];
} {
  const provided: Record<string, unknown> = {};
  const listeners: Array<{ event: string; fn: Function; opts: unknown }> = [];
  const logs: string[] = [];
  const settings = opts.settings ?? makeSettings({});
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
    inject: (deps: string[], cb: (face: unknown) => void) => {
      if (opts.injectSettings !== false && deps.includes("settings")) cb({ settings });
      return () => {};
    },
    get: (serviceName: string) => {
      if (serviceName === "llm") return opts.llm;
      if (serviceName === "settings") return settings;
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
    ["describe", "configure"],
    "Remote 收口为 describe/configure 双方法",
  );
  assert.deepEqual(
    marker.value.methods.map((m) => m.invocation.kind),
    ["direct", "direct"],
  );
  // SRC 参数形态：单形参纯标识符；`: unknown` 注解经 type-strip 后只剩空白，解析仍得标识符。
  const proto = GovernorService.prototype as any;
  assert.deepEqual(srcParamNames(proto.describe), ["filter"], "describe wire 参数名 = filter");
  assert.deepEqual(srcParamNames(proto.configure), ["patch"], "configure wire 参数名 = patch");
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

test("describe：单模型合并读出（自带档位/默认档/上下文/输出/生效限流）", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const result = await svc.describe({ provider: "opencode", model: "qwen3-coder" });
  assert.deepEqual(result.filter, { provider: "opencode", model: "qwen3-coder" });
  assert.equal(result.revision, 7, "须带回 llm-pi-ai revision（configure 作 expectedRevision）");
  assert.equal(result.models.length, 1);
  const entry = result.models[0];
  assert.equal(entry.found, true);
  assert.deepEqual(entry.builtin.efforts, ["low", "high"]);
  assert.equal(entry.builtin.defaultEffort, "high");
  assert.deepEqual(entry.effective.efforts, ["low", "high"], "无覆盖 = 跟随自带");
  assert.equal(entry.effective.defaultEffort, "high");
  assert.equal(entry.contextWindow, 262144);
  assert.equal(entry.maxTokens, 32000);
  assert.deepEqual(entry.limits, {}, "空配置 = 不限流");
  assert.deepEqual(entry.issues, []);
  assert.deepEqual(result.modelErrors, []);
});

test("describe：未知模型折 UNKNOWN_MODEL 可修文案（不抛）", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const result = await svc.describe({ provider: "opencode", model: "ghost" });
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].found, false);
  assert.equal(result.modelErrors.length, 1);
  assert.match(result.modelErrors[0].advice.title, /未知模型/, "issues 首条须为 UNKNOWN_MODEL 可行动文案");
  assert.ok(result.modelErrors[0].advice.actions.length > 0, "可行动文案须带 actions");
});

test("describe：本地覆盖合并（modelOverrides + 路由级默认）", async () => {
  const captured: Record<string, unknown> = {};
  const settings = makeSettings(captured, {
    providers: { opencode: { reasoning: "low", modelOverrides: { "qwen3-coder": { reasoningEfforts: { low: "low" } } } } },
  });
  const { ctx } = makeCtx({ llm: makeLlm(), settings });
  const svc = applyCordis(ctx, {});
  const result = await svc.describe({ provider: "opencode", model: "qwen3-coder" });
  assert.deepEqual(result.models[0].effective.efforts, ["low"], "覆盖档位整体替换自带");
  assert.equal(result.models[0].effective.defaultEffort, "low");
});

test("describe：modelOverrides 指错 id 记入 modelErrors", async () => {
  const captured: Record<string, unknown> = {};
  const settings = makeSettings(captured, {
    providers: { opencode: { modelOverrides: { ghost: { reasoningEfforts: { low: "low" } } } } },
  });
  const { ctx } = makeCtx({ llm: makeLlm(), settings });
  const svc = applyCordis(ctx, {});
  const result = await svc.describe({ provider: "opencode" });
  assert.equal(result.models.length, 1);
  assert.deepEqual(
    result.modelErrors.map((e) => e.model),
    ["ghost"],
    "覆盖了不存在的模型 id 须进可修清单",
  );
});

test("describe：空 filter 枚举全部路由模型", async () => {
  const { ctx } = makeCtx({ llm: makeLlm() });
  const svc = applyCordis(ctx, {});
  const result = await svc.describe(undefined);
  assert.deepEqual(result.filter, {});
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].model, "qwen3-coder");
});

test("configure：非法补丁中文拒收且不落盘", async () => {
  const captured: Record<string, unknown> = {};
  const { ctx } = makeCtx({ llm: makeLlm(), settings: makeSettings(captured) });
  const svc = applyCordis(ctx, {});
  const result = await svc.configure({
    limits: { defaults: { rpm: 0 } },
    provider: "opencode",
    model: "qwen3-coder",
    routeKind: "catalog",
    efforts: ["low"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  for (const message of result.errors) assert.match(message, /[\u4e00-\u9fa5]/, "逐条中文报错");
  assert.equal(captured.ns, undefined, "校验失败不得落盘（settings.mutate 不得调用）");
});

test("configure：目录路由落 modelOverrides（revision 透传）", async () => {
  const captured: Record<string, unknown> = {};
  const { ctx } = makeCtx({ llm: makeLlm(), settings: makeSettings(captured) });
  const svc = applyCordis(ctx, {});
  const result = await svc.configure({
    provider: "opencode",
    model: "qwen3-coder",
    routeKind: "catalog",
    efforts: ["low"],
    defaultEffort: "low",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(captured.ns, "llm-pi-ai");
  assert.equal(captured.rev, 7, "须透传 expectedRevision（custom 并发写防互盖同链路）");
  assert.deepEqual(captured.ops, [
    { op: "set", path: ["providers", "opencode", "reasoning"], value: "low" },
    { op: "set", path: ["providers", "opencode", "modelOverrides", "qwen3-coder", "reasoningEfforts"], value: { low: "low" } },
  ]);
  assert.deepEqual(result.applied.mutations, captured.ops);
});

test("configure：custom 路由经 listModels 补全量后整数组 set", async () => {
  const captured: Record<string, unknown> = {};
  const llm = makeLlm({ listModels: async () => [{ id: "m1", reasoningEfforts: { low: "low" } }] });
  const settings = makeSettings(captured, { providers: { custom: { models: [{ id: "m1" }] } } });
  const { ctx } = makeCtx({ llm, settings });
  const svc = applyCordis(ctx, {});
  const result = await svc.configure({ provider: "custom", model: "m1", routeKind: "custom", efforts: ["low"] });
  assert.equal(result.ok, true);
  assert.deepEqual(captured.ops, [{ op: "set", path: ["providers", "custom", "models"], value: [{ id: "m1", reasoningEfforts: { low: "low" } }] }]);
});

test("configure：governor 切片并入 live（后续限流/读出即时生效）", async () => {
  const { ctx } = makeCtx({ llm: makeLlm(), settings: makeSettings({}) });
  const svc = applyCordis(ctx, {});
  const result = await svc.configure({ limits: { defaults: { rpm: 60 } } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied.governor, { limits: { defaults: { rpm: 60 } } });
  assert.deepEqual(result.applied.mutations, []);
  const readout = await svc.describe({ provider: "opencode", model: "qwen3-coder" });
  assert.deepEqual(readout.models[0].limits, { rpm: 60 }, "live 配置须即时影响 effectiveLimits");
});

test("configure：未知顶层键拒收；settings 缺席时 thinking 写失败不抛", async () => {
  const { ctx } = makeCtx({ llm: makeLlm(), settings: makeSettings({}) });
  const svc = applyCordis(ctx, {});
  const unknown = await svc.configure({ bogus: 1 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join("；"), /未知配置项/);
  const bare = makeCtx({ llm: makeLlm(), injectSettings: false });
  bare.ctx.get = () => undefined;
  const svc2 = applyCordis(bare.ctx, {});
  const result = await svc2.configure({ provider: "p", model: "m", routeKind: "catalog", efforts: ["x"] });
  assert.equal(result.ok, false, "settings 缺席不得静默吞写");
  assert.match(result.errors.join("；"), /settings/);
});
