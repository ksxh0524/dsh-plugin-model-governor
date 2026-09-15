/** client-smoke.test.ts —— 浏览器半渲染冒烟（无头、无 DOM、无 react 包，全桩）：
 *  用最小 React 桩（useState 真存值、useEffect 可 flush、函数/类组件真调用）驱动
 *  lib/client.js 的真 apply() 接线，断言注册形态与首屏渲染文本。回归覆盖：
 *  ① footer list 槽注册必须带 id（缺 id 宿主注册即抛，曾毒死整个 apply 致模型页零 UI）；
 *  ② ModelRow 生效档位读 `eff.efforts`（曾误写裸 `efforts`，ReferenceError 致四张卡片崩脸）。
 *
 * 桩说明：react 不在 dependencies（浏览器半只 require("react") 宿主供给），此处手写桩；
 *  document 不存在时 ensureCss 自跳过，与生产一致。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(HERE, "..", "lib", "client.js");

/* ---------- 最小 React 桩 ---------- */
type Props = Record<string, any>;
interface Rec {
  states: any[];
}
const records = new Map<string, Rec>();
let current: { states: any[]; i: number } | null = null;
let pendingEffects: Array<() => unknown> = [];

function recordKey(type: Function, props: Props): string {
  return `${type.name || "anon"}|${props?.key ?? ""}`;
}
function invokeComp(type: any, props: Props): unknown {
  const k = recordKey(type, props);
  let rec = records.get(k);
  if (!rec) {
    rec = { states: [] };
    records.set(k, rec);
  }
  const prev = current;
  current = { states: rec.states, i: 0 };
  try {
    return type(props);
  } finally {
    current = prev;
  }
}
function useState<T>(init: T): [T, (v: T | ((p: T) => T)) => void] {
  const slot = current!;
  const i = slot.i++;
  if (slot.states.length <= i) slot.states.push(init);
  const set = (v: any) => {
    slot.states[i] = typeof v === "function" ? v(slot.states[i]) : v;
  };
  return [slot.states[i] as T, set];
}
function useEffect(cb: () => unknown): void {
  pendingEffects.push(cb);
}
function useCallback<T>(fn: T): T {
  return fn;
}
function useRef<T>(init: T): { current: T } {
  const slot = current!;
  const i = slot.i++;
  if (slot.states.length <= i) slot.states.push({ current: init });
  return slot.states[i];
}
function h(type: any, props?: Props, ...kids: unknown[]): unknown {
  const p: Props = { ...(props ?? {}), children: kids.flat(Infinity) };
  if (typeof type === "function") {
    if (type.prototype && typeof type.prototype.render === "function") {
      const inst = new type(p);
      return inst.render();
    }
    return invokeComp(type, p);
  }
  return { tag: type, props: p, kids: p.children };
}
/* React 真实现的 Component 至今仍是普通 function（ES5 继承可用）；桩必须同构，
 * 否则 GvrBoundary 的 React.Component.call(this) 在桩里先炸（生产不炸）。 */
function StubComponent(this: any, props: Props) {
  this.props = props;
  this.state = {};
}
const ReactStub = {
  createElement: h,
  useState,
  useEffect,
  useCallback,
  useRef,
  Component: StubComponent as any,
};

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") {
    const n = node as { tag?: unknown; kids?: unknown; children?: unknown };
    if ("kids" in n) return textOf(n.kids);
    if ("children" in n) return textOf(n.children);
  }
  return "";
}

/* ---------- 装配浏览器半 ---------- */
type Factory = (require: (m: string) => unknown) => { apply: (ctx: any) => void };
let factory: Factory | null = null;
const g = globalThis as any;
g.window = {
  __ModuleLoader__: {
    load: ({ factory: f }: any) => {
      factory = f;
    },
  },
};
const factorySource = fs.readFileSync(CLIENT_JS, "utf8");
new Function("window", "require", "module", "exports", factorySource)(
  g.window,
  () => {
    throw new Error("unexpected top-level require");
  },
  { exports: {} },
  {},
);
assert.ok(factory, "client.js 应调用 __ModuleLoader__.load 注册工厂");
const plugin: { apply: (ctx: any) => void } = (factory as unknown as Factory)((m: string) => {
  assert.equal(m, "react");
  return ReactStub;
});

/* ---------- 桩 ctx + 桩远端 ---------- */
interface Reg {
  opts: any;
  comp: any;
}
const regs: Reg[] = [];
const BUZZ_MODELS = [
  {
    provider: "buzz",
    model: "qwen3.8-flash-free",
    found: true,
    builtin: { efforts: ["low", "medium", "xhigh"] },
    effective: { efforts: ["low", "medium", "xhigh"], defaultEffort: "xhigh" },
    limits: { rpm: 60 },
    issues: [],
  },
  {
    provider: "buzz",
    model: "ghost-model",
    found: false,
    builtin: { efforts: [] },
    effective: { efforts: [] },
    limits: {},
    issues: ["失配覆盖：buzz/ghost-model"],
  },
];
const remoteStub = {
  async describe(args: any) {
    if (args?.provider === "buzz") return { models: BUZZ_MODELS, modelErrors: [] };
    return {
      models: [...BUZZ_MODELS.map((m) => ({ ...m }))],
      modelErrors: [],
    };
  },
};
const ctxStub: any = {
  get: (k: string) => {
    assert.equal(k, "remote.governor");
    return remoteStub;
  },
  remote: { $mount: async () => ({}) },
  slots: {
    inject: (_name: string, cb: () => unknown) => cb(),
    register: (opts: any, comp: any) => {
      regs.push({ opts, comp });
      return () => {};
    },
  },
  effect: (fn: () => unknown) => fn(),
};
plugin.apply(ctxStub);

/* 组件的 effect 一律是 fire-and-forget 形态（function () { load(); }，不返回 promise，
 * 靠 alive 哨兵防竞态——浏览器里靠 setState 自然重渲染；单测里必须排空任务轮次，
 * 光 await 回调返回值不够（它只覆盖同步前缀）。 */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const fns = pendingEffects.splice(0);
    for (const fn of fns) await fn();
    for (let k = 0; k < 10; k++) await new Promise((r) => setImmediate(r));
    if (pendingEffects.length === 0) break;
  }
}

test("注册形态：provider-card keyed + footer list 带 id", () => {
  const card = regs.find((r) => r.opts?.name === "settings.models.provider-card");
  assert.ok(card, "应注册 provider-card");
  assert.equal(card.opts.key, "llm-pi-ai");
  const footer = regs.find((r) => r.opts?.name === "settings.models.footer");
  assert.ok(footer, "应注册 footer");
  assert.equal(footer.opts.id, "model-governor-footer");
});

test("卡片渲染：读出文本 + 生效档位 + 失配徽标（ModelRow 裸变量回归）", async () => {
  records.clear();
  pendingEffects = [];
  const card = regs.find((r) => r.opts?.name === "settings.models.provider-card")!;
  const owner = { provider: { provider: "buzz", displayName: "buzz" }, configured: true, keyConfigured: false };
  let tree: unknown = invokeComp(card.comp, owner);
  await flush();
  tree = invokeComp(card.comp, owner);
  await flush();
  tree = invokeComp(card.comp, owner);
  const text = textOf(tree);
  assert.ok(text.includes("模型治理"), "应有卡片标题");
  assert.ok(text.includes("自带档位"), "应有读出区");
  assert.ok(text.includes("low、medium、xhigh"), `生效档位应渲染 effective.efforts，实得：${text.slice(0, 200)}`);
  assert.ok(text.includes("qwen3.8-flash-free"), "应列出模型行");
  assert.ok(text.includes("失配"), "found:false 模型应有失配徽标");
});

test("footer 渲染：全局区 + 模型计数", async () => {
  records.clear();
  pendingEffects = [];
  const footer = regs.find((r) => r.opts?.name === "settings.models.footer")!;
  let tree: unknown = invokeComp(footer.comp, {});
  await flush();
  tree = invokeComp(footer.comp, {});
  await flush();
  tree = invokeComp(footer.comp, {});
  const text = textOf(tree);
  assert.ok(text.includes("全局限流"), "应有全局区标题");
  assert.ok(text.includes("2 个模型"), `应渲染模型计数，实得：${text.slice(0, 200)}`);
});
