/** client-smoke.test.ts —— RPM 单行冒烟（无头、无 DOM，全桩）：
 *  用最小 React 桩驱动 lib/client.js 真 apply() 接线，断言：
 *  ① 只注册 provider-card keyed 槽（key=llm-pi-ai），绝不注册 footer；
 *  ② RpmLine 渲染出 “RPM 上限 + 数字框 + 应用” 单行（读数取首模型生效 rpm）；
 *  ③ 改框点应用调 configure({limits:{providers:{[route]:{rpm}}}})，空输入无操作。
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
function useEffect(fn: () => unknown, _deps?: unknown) {
  pendingEffects.push(fn);
}
function useCallback<T>(fn: T, _deps?: unknown): T {
  return fn;
}
function useRef<T>(init: T): { current: T } {
  return { current: init };
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
const calls: { describe: any[]; configure: any[] } = { describe: [], configure: [] };
let rpmValue: number | undefined = 60;
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
        if (rpm && typeof rpm.rpm === "number") rpmValue = rpm.rpm;
        return { ok: true, applied: ["limits"], errors: [] };
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

test("注册面：只挂 provider-card keyed 槽，无 footer", () => {
  assert.deepEqual(injectedSlots, ["settings.models.provider-card"]);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].name, "settings.models.provider-card");
  assert.equal(regs[0].options.key, "llm-pi-ai");
});

test("渲染：RPM 单行（标签+数字框+应用），读数=首模型生效 rpm", async () => {
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
  const btns = findAll(tree2, (n) => n.type === "button" && textOf(n) === "应用");
  assert.equal(btns.length, 1);
  // 无卡片标题/徽标/多行：div.gvr-rpm 唯一，且无 footer 残留文本
  const roots = findAll(tree2, (n) => n.props?.className === "gvr-rpm");
  assert.equal(roots.length, 1);
  assert.ok(!textOf(tree2).includes("全局"));
  void tree;
});

test("写入：改框点应用 → configure 服务商 rpm；空输入无操作", async () => {
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
  // 空输入 = 无操作
  calls.configure.length = 0;
  input.props.onChange({ target: { value: "  " } });
  resetHooks();
  const tree3 = render(regs[0].render({ provider: { provider: "opencode" } }));
  findAll(tree3, (n) => n.type === "button")[0].props.onClick();
  await flush();
  assert.equal(calls.configure.length, 0);
});
