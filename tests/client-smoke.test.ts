/** client-smoke.test.ts —— 治理单行冒烟（无头、无 DOM，全桩）：
 *  用最小 React 桩驱动 lib/client.js 真 apply() 接线，断言：
 *  ① 只注册 provider-card keyed 槽（llm-pi-ai/llm-deepseek 各一位），绝不注册 footer；
 *  ② 单行渲染出 “RPM + 数字框 + 应用 + 探测”（读数取首模型生效 rpm；无清除、无探测行）；
 *  ③ 改框点应用调 configure({limits:{providers:{[route]:{rpm}}}})，空输入点应用发 {rpm:null} 删除回落不限；
 *  ④ 点探测 → probe 发起 → 按钮变倒计时秒数（running 带 durationMs 做分母）；
 *     结论落地 → 按钮变回探测 + note 直显；倒计时点按 = 取消。
 *
 *  桩说明：react 不在 dependencies（浏览器半只 require("react") 宿主供给），此处手写桩；
 *  useEffect 收集后手动 flush（含异步 describe 的 macrotask 排空）。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(HERE, "..", "lib", "client.js");

type Factory = (require: (m: string) => unknown) => {
  apply: (ctx: any) => void;
  inject: unknown;
};

/* ---------- 最小 React 桩 ---------- */
const pendingEffects: Array<() => unknown> = [];
let stateSeq = 0;
const states = new Map<number, { v: unknown }>();
function useState<T>(init: T): [T, (v: T | ((p: T) => T)) => void] {
  const id = stateSeq++;
  if (!states.has(id)) states.set(id, { v: init as unknown });
  const cell = states.get(id)!;
  const set = (v: unknown) => {
    cell.v = typeof v === "function" ? (v as (p: unknown) => unknown)(cell.v) : v;
  };
  return [cell.v as T, set as (v: T | ((p: T) => T)) => void];
}
// 每次重渲染前重置序号，使同一调用序拿到同一 cell（极简 hooks 语义，够单组件两轮断言）。
function resetHooks() {
  stateSeq = 0;
}
// useRef 与 useState 共用序号：真 React 的 ref 跨渲染稳定，桩必须同语义，
// 否则组件的 probing/poller 等跨渲染守卫在桩里永远失灵（倒计时点按取消即因此假失败过）。
const refCells = new Map<number, { current: unknown }>();
function useEffect(fn: () => unknown, _deps?: unknown) {
  pendingEffects.push(fn);
}
function useCallback<T>(fn: T, _deps?: unknown): T {
  return fn;
}
function useRef<T>(init: T): { current: T } {
  const id = stateSeq++;
  if (!refCells.has(id)) refCells.set(id, { current: init });
  return refCells.get(id) as { current: T };
}
function createElement(type: any, props: any, ...children: any[]) {
  return { type, props: { ...(props ?? {}), children: children.flat() } };
}
const ReactStub = { createElement, useState, useEffect, useCallback, useRef };

function render(node: any): any {
  if (Array.isArray(node)) return node.map(render);
  if (node === null || node === undefined || typeof node !== "object") return node;
  // 注意：顶层调用前由调用方 resetHooks() 一次；递归中不再重置，否则跨组件 id 碰撞
  //（曾导致 GvrBoundary 的 err cell 与 RpmLine 的 text cell 共用 id，读数变红字）。
  if (typeof node.type === "function") {
    return render(node.type(node.props));
  }
  const kids = (node.props?.children ?? []).map(render);
  return { ...node, renderedChildren: kids };
}
function findAll(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const k of node) findAll(k, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  for (const k of node.renderedChildren ?? node.props?.children ?? []) findAll(k, pred, out);
  return out;
}
function textOf(node: any): string {
  // 卡槽渲染多孩子时 GvrBoundary 透出数组根：数组必须展开（曾吞成 ""，探测行加入后才暴露）。
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string") return node;
  if (node === null || node === undefined || typeof node !== "object") return "";
  return ((node.renderedChildren ?? node.props?.children ?? []) as any[]).map(textOf).join("");
}
async function flush(times = 12) {
  for (let i = 0; i < times; i++) {
    const fns = pendingEffects.splice(0);
    for (const fn of fns) await fn();
    await new Promise((r) => setImmediate(r));
  }
}

/* ---------- 装载 ---------- */
const g = globalThis as any;
let factory: Factory | null = null;
g.window = { __ModuleLoader__: { load: ({ factory: f }: any) => (factory = f) } };
const factorySource = fs.readFileSync(CLIENT_JS, "utf8");
new Function("window", "require", "module", "exports", factorySource)(
  g.window,
  (m: string) => {
    assert.equal(m, "react");
    return ReactStub;
  },
  { exports: {} },
  {},
);
assert.ok(factory, "client.js 应调用 __ModuleLoader__.load 注册工厂");
const pluginRequire = (m: string) => {
  assert.equal(m, "react");
  return ReactStub;
};
const plugin = (factory as unknown as Factory)(pluginRequire);

/* ---------- 桩 ctx ---------- */
const regs: Array<{ name: string; options: any; render: any }> = [];
const injectedSlots: string[] = [];
const calls: { describe: any[]; configure: any[]; probe: any[]; probeStatus: any[]; cancelProbe: any[] } = {
  describe: [],
  configure: [],
  probe: [],
  probeStatus: [],
  cancelProbe: [],
};
let rpmValue: number | undefined = 60;
/** 桩 probeStatus 的剧本（用例按需改写：running 态或 done 结论；running 带 durationMs 做倒计时分母）。 */
let probeStatusScript: any = { state: "running", sent: 3, succeeded: 3, rateLimited: 0, elapsedMs: 3000, durationMs: 120000 };
const ctxStub: any = {
  remote: { $mount: () => Promise.resolve({}) },
  get: (name: string) => {
    assert.equal(name, "remote.governor");
    return {
      describe: async (f: any) => {
        calls.describe.push(f);
        return { models: [{ provider: f.provider, model: "m", limits: rpmValue === undefined ? {} : { rpm: rpmValue } }] };
      },
      configure: async (p: any) => {
        calls.configure.push(p);
        const rpm = p?.limits?.providers ? (Object.values(p.limits.providers)[0] as any) : undefined;
        if (rpm && "rpm" in rpm) rpmValue = typeof rpm.rpm === "number" ? rpm.rpm : undefined;
        return { ok: true, applied: ["limits"], errors: [] };
      },
      probe: async (s: any) => {
        calls.probe.push(s);
        return { ok: true, started: { probeId: "pb-1", provider: s.provider, model: "m" }, errors: [] };
      },
      probeStatus: async (f: any) => {
        calls.probeStatus.push(f);
        return probeStatusScript;
      },
      cancelProbe: async (t: any) => {
        calls.cancelProbe.push(t);
        return { ok: true, cancelled: true, errors: [] };
      },
    };
  },
  slots: {
    inject: (name: string, fn: () => unknown) => {
      injectedSlots.push(name);
      return fn();
    },
    register: (def: any, render: any) => {
      regs.push({ name: def.name, options: def, render });
      return () => {};
    },
  },
  effect: (fn: () => unknown) => fn(),
};
plugin.apply(ctxStub);

test("注册面：只挂 provider-card keyed 槽（两命名空间各一位），无 footer", () => {
  assert.deepEqual(injectedSlots, ["settings.models.provider-card"]);
  assert.equal(regs.length, 2);
  for (const reg of regs) assert.equal(reg.name, "settings.models.provider-card");
  assert.deepEqual(regs.map((r) => r.options.key).sort(), ["llm-deepseek", "llm-pi-ai"]);
});

test("渲染：治理单行（RPM+数字框+应用+探测），读数=首模型生效 rpm", async () => {
  resetHooks();
  const tree = render(regs[0].render({ provider: { provider: "opencode" } }));
  await flush();
  resetHooks();
  const tree2 = render(regs[0].render({ provider: { provider: "opencode" } }));
  const label = findAll(tree2, (n) => n.type === "span" && textOf(n) === "RPM");
  assert.equal(label.length, 1);
  const inputs = findAll(tree2, (n) => n.type === "input");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].props.value, "60");
  const btns = findAll(tree2, (n) => n.type === "button");
  assert.deepEqual(btns.map(textOf), ["应用", "探测"], "同行两按钮：应用在前、探测在后，无清除");
  assert.ok(btns[1].props.title.includes("自动测 RPM"), "探测按钮 title 说明用途");
  // 无卡片标题/徽标/多行：div.gvr-rpm 唯一，无探测行残留，且无 footer 残留文本
  const roots = findAll(tree2, (n) => n.props?.className === "gvr-rpm");
  assert.equal(roots.length, 1);
  assert.equal(findAll(tree2, (n) => n.props?.className === "gvr-probe").length, 0);
  assert.ok(!textOf(tree2).includes("全局"));
  void tree;
});

test("写入：改框点应用 → configure 服务商 rpm；空输入点应用 → {rpm:null} 删除回落不限", async () => {
  calls.configure.length = 0;
  render(regs[0].render({ provider: { provider: "opencode" } }));
  await flush();
  resetHooks();
  const tree = render(regs[0].render({ provider: { provider: "opencode" } }));
  const input = findAll(tree, (n) => n.type === "input")[0];
  input.props.onChange({ target: { value: "120" } });
  resetHooks();
  const tree2 = render(regs[0].render({ provider: { provider: "opencode" } }));
  const btn = findAll(tree2, (n) => n.type === "button")[0];
  btn.props.onClick();
  await flush();
  assert.equal(calls.configure.length, 1);
  assert.deepEqual(calls.configure[0], { limits: { providers: { opencode: { rpm: 120 } } } });
  // 回归：写入完成后 busy 必解（按钮回“应用”，框内是新值）；曾因代际计数 bug 卡死“应用中”。
  resetHooks();
  const treeDone = render(regs[0].render({ provider: { provider: "opencode" } }));
  assert.equal(textOf(findAll(treeDone, (n) => n.type === "button")[0]), "应用");
  assert.equal(findAll(treeDone, (n) => n.type === "input")[0].props.value, "120");
  // 空输入 = 删除该卡 RPM（{rpm:null} 回落不限，与占位符“空=不限”对齐）
  calls.configure.length = 0;
  input.props.onChange({ target: { value: "  " } });
  resetHooks();
  const tree3 = render(regs[0].render({ provider: { provider: "opencode" } }));
  findAll(tree3, (n) => n.type === "button")[0].props.onClick();
  await flush();
  assert.equal(calls.configure.length, 1);
  assert.deepEqual(calls.configure[0], { limits: { providers: { opencode: { rpm: null } } } });
});

test("探测：点探测 → 按钮变倒计时；结论落地 → 按钮变回探测 + note 直显", async () => {
  // 回收组件起的轮询 timer（poller 1s + 本地走格 ticker 0.5s），防测试进程悬挂。
  const timers: unknown[] = [];
  const g = globalThis as any;
  const realSetInterval = g.setInterval;
  g.setInterval = (fn: (...args: unknown[]) => void, ms: number) => {
    const handle = realSetInterval(fn, ms);
    timers.push(handle);
    return handle;
  };
  try {
    probeStatusScript = { state: "running", sent: 3, succeeded: 3, rateLimited: 0, elapsedMs: 3000, durationMs: 120000 };
    calls.probe.length = 0;
    calls.probeStatus.length = 0;
    const describeBefore = calls.describe.length;
    resetHooks();
    render(regs[0].render({ provider: { provider: "opencode" } }));
    await flush();
    resetHooks();
    const tree = render(regs[0].render({ provider: { provider: "opencode" } }));
    findAll(tree, (n) => n.type === "button" && textOf(n) === "探测")[0].props.onClick();
    await flush();
    assert.equal(calls.probe.length, 1);
    assert.deepEqual(calls.probe[0], { provider: "opencode" });
    assert.ok(calls.probeStatus.length >= 1);
    // 倒计时 = ceil((120000-3000)/1000) = 117s（“探测”二字消失，只剩秒数）。
    resetHooks();
    const counting = render(regs[0].render({ provider: { provider: "opencode" } }));
    assert.deepEqual(findAll(counting, (n) => n.type === "button").map(textOf), ["应用", "117s"]);
    // 结论落地（触顶自动填入）：等一次轮询 → 按钮变回探测 + note 直显 + RPM 就地回读。
    probeStatusScript = {
      state: "done",
      result: { topped: true, estimate: 60, lowerBound: 60, applied: true, appliedRpm: 60, note: "测得约 60 RPM，已自动填入" },
    };
    await new Promise((r) => setTimeout(r, 1200));
    await flush();
    resetHooks();
    const done = render(regs[0].render({ provider: { provider: "opencode" } }));
    assert.deepEqual(findAll(done, (n) => n.type === "button").map(textOf), ["应用", "探测"]);
    assert.ok(textOf(done).includes("测得约 60 RPM，已自动填入"), "结论 note 应直显");
    assert.ok(calls.describe.length > describeBefore, "自动填入后应就地回读 RPM");
  } finally {
    for (const handle of timers.splice(0)) g.clearInterval(handle);
    g.setInterval = realSetInterval;
    probeStatusScript = { state: "running", sent: 3, succeeded: 3, rateLimited: 0, elapsedMs: 3000, durationMs: 120000 };
  }
});

test("包络分支：网关 {ok:true,value} 包裹的 describe 同样读数", async () => {
  // 真网关把方法回执包成 {ok:true,value}（见 usage-stats 同款）；桩默认直返裸值，
  // 本用例锁定 unwrap 的包络分支（裸值分支由其余用例覆盖）。
  const origGet = ctxStub.get;
  ctxStub.get = (name: string) => {
    const remote = origGet(name);
    return {
      ...remote,
      describe: async (f: any) => ({ ok: true, value: { models: [{ provider: f.provider, model: "m", limits: { rpm: 33 } }] } }),
    };
  };
  try {
    resetHooks();
    render(regs[0].render({ provider: { provider: "opencode" } }));
    await flush();
    resetHooks();
    const tree = render(regs[0].render({ provider: { provider: "opencode" } }));
    assert.equal(findAll(tree, (n) => n.type === "input")[0].props.value, "33", "包络须解出内层读数");
  } finally {
    ctxStub.get = origGet;
  }
});

test("探测：倒计时点按 = 取消（已取消落地即回按钮）", async () => {
  const timers: unknown[] = [];
  const g = globalThis as any;
  const realSetInterval = g.setInterval;
  g.setInterval = (fn: (...args: unknown[]) => void, ms: number) => {
    const handle = realSetInterval(fn, ms);
    timers.push(handle);
    return handle;
  };
  try {
    probeStatusScript = { state: "running", sent: 1, succeeded: 1, rateLimited: 0, elapsedMs: 1000, durationMs: 120000 };
    calls.cancelProbe.length = 0;
    resetHooks();
    render(regs[0].render({ provider: { provider: "opencode" } }));
    await flush();
    resetHooks();
    const tree = render(regs[0].render({ provider: { provider: "opencode" } }));
    findAll(tree, (n) => n.type === "button" && textOf(n) === "探测")[0].props.onClick();
    await flush();
    resetHooks();
    const counting = render(regs[0].render({ provider: { provider: "opencode" } }));
    const countdown = findAll(counting, (n) => n.type === "button" && /^\d+s$/.test(textOf(n)))[0];
    assert.ok(countdown, "运行中按钮应为倒计时秒数");
    // 点倒计时 → 取消；结论（已取消）落地 → 按钮变回探测。
    probeStatusScript = { state: "done", result: { topped: false, lowerBound: 1, applied: false, cancelled: true, note: "探测已取消" } };
    countdown.props.onClick();
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    assert.equal(calls.cancelProbe.length, 1);
    assert.deepEqual(calls.cancelProbe[0], { provider: "opencode" });
    resetHooks();
    const back = render(regs[0].render({ provider: { provider: "opencode" } }));
    assert.deepEqual(findAll(back, (n) => n.type === "button").map(textOf), ["应用", "探测"]);
    assert.ok(textOf(back).includes("探测已取消"));
  } finally {
    for (const handle of timers.splice(0)) g.clearInterval(handle);
    g.setInterval = realSetInterval;
    probeStatusScript = { state: "running", sent: 3, succeeded: 3, rateLimited: 0, elapsedMs: 3000, durationMs: 120000 };
  }
});
