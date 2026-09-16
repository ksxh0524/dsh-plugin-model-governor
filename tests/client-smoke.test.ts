/** client-smoke.test.ts —— 治理席位件冒烟（无头、无 DOM，全桩）：
 *  用最小 React 桩驱动 lib/client.js 真 apply() 接线，断言形态规范 §4.5 里「只能靠真渲染验」的部分：
 *  ① 只注册 provider-card keyed 席位（llm-pi-ai/llm-deepseek 各一位），绝不注册 footer；
 *  ② 席位下发的 configured/keyConfigured 必须消费：草稿卡整行不出，没配 key 的卡只说明不给写件；
 *  ③ 单行渲染 “RPM + 数字框 + 应用 + 探测”，控件走宿主 primitives（Input/Button 的 require 常路）；
 *  ④ 读数与写对象同源：取 describe.providerLimits（models[0].limits 放诱饵值，v5 会读错源）；
 *  ⑤ dirty 出「未保存」+「丢弃」，丢弃只回基线不发写；写点唯一（configure 只在 apply 路径被调）；
 *  ⑥ 三态齐：读取中 status / 校验失败 aria-invalid+alert / 读取失败 alert+重试；探测结论走 status；
 *  ⑦ 点探测 → 按钮变倒计时；结论落地 → 回「探测」+ note 直显；倒计时点按 = 取消且失败不静默吞；
 *  ⑧ 持久化时代无作用域说明（写进 settings 文档，重启仍在）+ data-gvr-ui 自报常路/降级。
 *
 *  桩说明：react / react-dom / 宿主 primitives 都不在本包 dependencies（浏览器半 require 的是宿主
 *  冻结种子表里的模块），此处手写桩并把「种子表外的 require」直接判红——降级路径不许被静默走到。
 *  useEffect 收集后手动 flush（含异步 describe 的 macrotask 排空）。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectMotionGuardViolations, collectProviderCardSeatViolations } from "dsh-check";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(HERE, "..", "lib", "client.js");
const CLIENT = fs.readFileSync(CLIENT_JS, "utf8");

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

/* ---------- 宿主 primitives 桩（真形状：Input = span 包 input；Button = button 直传 props） ---------- */
const primitivesUsed: string[] = [];
function StubInput(props: any) {
  primitivesUsed.push("Input");
  const { children, ...rest } = props;
  return { type: "span", props: { className: "ui-wrap", children: [{ type: "input", props: { ...rest, children: children ?? [] } }] } };
}
function StubButton(props: any) {
  primitivesUsed.push("Button");
  return { type: "button", props };
}
const UI_STUB = { Input: StubInput, Button: StubButton };

function render(node: any): any {
  if (Array.isArray(node)) return node.map(render);
  if (node === null || node === undefined || typeof node !== "object") return node;
  // 注意：顶层调用前由调用方 resetHooks() 一次；递归中不再重置，否则跨组件 id 碰撞
  //（曾导致同名 state cell 共用 id，读数变红字）。
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
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string") return node;
  if (node === null || node === undefined || typeof node !== "object") return "";
  return ((node.renderedChildren ?? node.props?.children ?? []) as any[]).map(textOf).join("");
}
const buttonsOf = (tree: any) => findAll(tree, (n) => n.type === "button");
const btn = (tree: any, label: string) => buttonsOf(tree).find((n) => textOf(n) === label);
const inputOf = (tree: any) => findAll(tree, (n) => n.type === "input")[0];
const texts = (tree: any) => buttonsOf(tree).map(textOf);
async function flush(times = 12) {
  for (let i = 0; i < times; i++) {
    const fns = pendingEffects.splice(0);
    for (const fn of fns) await fn();
    await new Promise((r) => setImmediate(r));
  }
}

/* ---------- 装载（require 白名单 = 宿主冻结模块种子表内的三个词） ---------- */
const g = globalThis as any;
let factory: Factory | null = null;
g.window = { __ModuleLoader__: { load: ({ factory: f }: any) => (factory = f) } };
const SEED_MODULES = ["react", "react-dom", "@deepseek-ai/dsh-client-ui-primitives"];
function pluginRequire(m: string): unknown {
  assert.ok(SEED_MODULES.includes(m), `浏览器半 require 了种子表外的模块：${m}`);
  if (m === "react") return ReactStub;
  if (m === "@deepseek-ai/dsh-client-ui-primitives") return UI_STUB;
  return { createPortal: (n: any) => n };
}
new Function("window", "require", "module", "exports", CLIENT)(g.window, pluginRequire, { exports: {} }, {});
assert.ok(factory, "client.js 应调用 __ModuleLoader__.load 注册工厂");
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
/** describe 回执：providerLimits 是真源，models[0].limits.rpm 是诱饵（v5 读的是诱饵）。 */
function describeBody(provider: string) {
  return {
    filter: { provider },
    models: [{ provider, model: "m", limits: { rpm: 999 } }],
    providerLimits: rpmValue === undefined ? {} : { rpm: rpmValue },
  };
}
const ctxStub: any = {
  remote: { $mount: () => Promise.resolve({}) },
  get: (name: string) => {
    assert.equal(name, "remote.governor");
    return {
      describe: async (f: any) => {
        calls.describe.push(f);
        return describeBody(f.provider);
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
    register: (def: any, render2: any) => {
      regs.push({ name: def.name, options: def, render: render2 });
      return () => {};
    },
  },
  effect: (fn: () => unknown) => fn(),
};
plugin.apply(ctxStub);

/** 席位下发的 owner props（slot-contract.ts:43-50）：默认「已落盘 + 已配 key」。 */
const SEAT = (provider: string, over: Record<string, unknown> = {}) => ({
  provider: { provider, settingsNs: provider },
  configured: true,
  keyConfigured: true,
  ...over,
});
/** 渲染两轮（第一轮起 effect 读服务端，第二轮拿到 ready 态）。 */
async function renderReady(props: any) {
  resetHooks();
  render(regs[0].render(props));
  await flush();
  resetHooks();
  return render(regs[0].render(props));
}

test("注册面：只挂 provider-card keyed 席位（两命名空间各一位），无 footer", () => {
  assert.deepEqual(injectedSlots, ["settings.models.provider-card"]);
  assert.equal(regs.length, 2);
  for (const reg of regs) assert.equal(reg.name, "settings.models.provider-card");
  assert.deepEqual(regs.map((r) => r.options.key).sort(), ["llm-deepseek", "llm-pi-ai"]);
});

// 读取失败一支必须排在首个成功渲染之前：mini-React 的状态格按 hook 调用序复用，
// 成功渲染过一次 ready=true 就再也回不到「失败不给可写件」那支（真 React 每实例独立，无此问题）。
test("读取失败：role=alert 报错 + 重试再走一次读取，成功后旧错作废", async () => {
  const origGet = ctxStub.get;
  ctxStub.get = (name: string) => ({
    ...origGet(name),
    describe: async () => {
      throw new Error("gateway 未连接");
    },
  });
  const before = calls.describe.length;
  const failed = await renderReady(SEAT("opencode-fail"));
  ctxStub.get = origGet;
  const alert = findAll(failed, (n) => n.props?.role === "alert");
  assert.ok(alert.length >= 1 && textOf(alert[0]).includes("RPM 读取失败"), "读取失败要报出来，不静默空白");
  assert.equal(findAll(failed, (n) => n.type === "input").length, 0, "失败态不给可写控件");
  btn(failed, "重试")!.props.onClick();
  await flush();
  assert.ok(calls.describe.length > before, "重试真的再走一次读取");
  const recovered = await renderReady(SEAT("opencode-fail"));
  assert.equal(findAll(recovered, (n) => n.props?.role === "alert").length, 0, "回读成功后上一条读取错误必须作废");
  assert.equal(inputOf(recovered).props.value, "60");
});

test("席位消费：草稿卡（configured:false）整行不出；没配 key 只说明不给写件", async () => {
  const draft = render(regs[0].render(SEAT("opencode", { configured: false })));
  assert.equal(draft, null, "未落盘的草稿卡不该出现可写控件（写进去无处挂）");
  const noKey = await renderReady(SEAT("opencode", { keyConfigured: false }));
  assert.equal(buttonsOf(noKey).length, 0, "没配 key 的卡不给按钮");
  assert.equal(findAll(noKey, (n) => n.type === "input").length, 0, "没配 key 的卡不给输入框");
  assert.ok(textOf(noKey).includes("还没配 API key"), "该说一句为什么这里没有 RPM 行");
  assert.equal(calls.probe.length, 0);
});

test("渲染：治理单行（RPM+数字框+应用+探测）走 primitives 常路，读数=服务商桶口径", async () => {
  const tree = await renderReady(SEAT("opencode"));
  assert.equal(findAll(tree, (n) => n.props?.className === "gvr-seat").length, 1, "卡壳归宿主 <li>，本半只出一层内容壳");
  assert.equal(findAll(tree, (n) => n.type === "li").length, 0, "绝不自造 <li> 卡壳");
  assert.equal(textOf(findAll(tree, (n) => n.type === "span" && n.props?.className === "gvr-label")[0]), "RPM");
  assert.ok(primitivesUsed.includes("Input") && primitivesUsed.includes("Button"), "共享控件必须走宿主 primitives，不是手搓替身");
  assert.equal(inputOf(tree).props.value, "60", "读数取 providerLimits（models[0].limits.rpm=999 是诱饵，读了就红）");
  assert.equal(inputOf(tree).props["aria-label"], "RPM", "席位范本是 span 字段名 + 控件 aria-label（不套 §4.2 htmlFor）");
  assert.deepEqual(texts(tree), ["应用", "探测"], "同行两按钮：应用在前、探测在后，无清除");
  assert.ok(btn(tree, "探测")!.props.title.includes("自动测 RPM"), "探测按钮 title 说明用途");
  assert.ok(!textOf(tree).includes("重启"), "写进 settings 文档即持久，不再挂“重启恢复”说明（那句是内存时代的遗物）");
  assert.equal(findAll(tree, (n) => n.props?.className === "gvr-seat")[0].props["data-gvr-ui"], "host", "常路必须自报家门（截图/DOM 一眼可辨走的哪条）");
});

test("降级：primitives 缺席走本地同规格件（描边药丸 .gvr-btn 不是裸文字），席位自报 fallback", async () => {
  const fallbackRequire = (m: string): unknown => {
    if (m === "react") return ReactStub;
    if (m === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("UI 缺席");
    return { createPortal: (n: any) => n };
  };
  const base = regs.length;
  (factory as unknown as Factory)(fallbackRequire).apply(ctxStub);
  assert.equal(regs.length, base + 2, "降级实例照常注册两席位");
  resetHooks();
  render(regs[base].render(SEAT("opencode")));
  await flush();
  resetHooks();
  const tree = render(regs[base].render(SEAT("opencode")));
  const seat = findAll(tree, (n) => n.props?.className === "gvr-seat")[0];
  assert.equal(seat.props["data-gvr-ui"], "fallback", "降级必须自报，不许静默扮常路");
  assert.equal(findAll(tree, (n) => n.type === "input").length, 1, "降级也给输入框");
  assert.deepEqual(texts(tree), ["应用", "探测"], "降级按钮形态不变（同行两按钮）");
  assert.ok(
    buttonsOf(tree).every((b: any) => b.props?.className === "gvr-btn"),
    "降级按钮是描边药丸同规格件，不是裸文字（竖排事故里那两条无框文字就是裸降级）",
  );
  assert.equal(inputOf(tree).props.value, "60", "降级读数不断（同源 providerLimits）");
});

test("写入：改框出「未保存」+「丢弃」，点应用才 configure；丢弃只回基线不写", async () => {
  calls.configure.length = 0;
  const tree = await renderReady(SEAT("opencode"));
  assert.equal(btn(tree, "丢弃"), undefined, "未改框不出丢弃入口");
  inputOf(tree).props.onChange({ target: { value: "120" } });
  resetHooks();
  const dirty = render(regs[0].render(SEAT("opencode")));
  assert.ok(textOf(dirty).includes("未保存"), "改框要有 dirty 标记（同页宿主写流程有暂存态）");
  const discard = btn(dirty, "丢弃");
  assert.ok(discard, "dirty 时必须有丢弃入口");
  btn(dirty, "应用")!.props.onClick();
  await flush();
  assert.equal(calls.configure.length, 1, "写点唯一：只有 apply 路径调 configure");
  assert.deepEqual(calls.configure[0], { limits: { providers: { opencode: { rpm: 120 } } } });
  // 回归：写入完成后 busy 必解（按钮回“应用”，框内是新值）；曾因代际计数 bug 卡死“应用中”。
  const after = await renderReady(SEAT("opencode"));
  assert.equal(textOf(btn(after, "应用")), "应用");
  assert.equal(inputOf(after).props.value, "120");
  assert.equal(btn(after, "丢弃"), undefined, "回读后不 dirty，丢弃入口收起");
  // 丢弃路径：改框后点丢弃 → 回基线，一次 configure 都不发
  calls.configure.length = 0;
  inputOf(after).props.onChange({ target: { value: "999" } });
  resetHooks();
  const dirty2 = render(regs[0].render(SEAT("opencode")));
  btn(dirty2, "丢弃")!.props.onClick();
  resetHooks();
  const reverted = render(regs[0].render(SEAT("opencode")));
  assert.equal(inputOf(reverted).props.value, "120", "丢弃回服务端基线，不是回空");
  assert.equal(btn(reverted, "丢弃"), undefined);
  assert.equal(calls.configure.length, 0, "丢弃不写");
  // 空输入 = 删除该卡 RPM（{rpm:null} 回落不限，与占位符“空=不限”对齐）
  calls.configure.length = 0;
  inputOf(reverted).props.onChange({ target: { value: "  " } });
  resetHooks();
  const blank = render(regs[0].render(SEAT("opencode")));
  btn(blank, "应用")!.props.onClick();
  await flush();
  assert.deepEqual(calls.configure[0], { limits: { providers: { opencode: { rpm: null } } } });
  rpmValue = 60;
});

test("校验失败：aria-invalid + role=alert 播报", async () => {
  const tree = await renderReady(SEAT("opencode"));
  inputOf(tree).props.onChange({ target: { value: "0" } });
  resetHooks();
  const bad = render(regs[0].render(SEAT("opencode")));
  btn(bad, "应用")!.props.onClick();
  resetHooks();
  const shown = render(regs[0].render(SEAT("opencode")));
  const alert = findAll(shown, (n) => n.props?.role === "alert");
  assert.ok(alert.length >= 1 && textOf(alert[0]).includes("RPM 须为正整数"), "校验失败要 role=alert（读屏播得到）");
  assert.equal(inputOf(shown).props["aria-invalid"], "true", "输入框要挂 aria-invalid");
});

test("包络分支：网关 {ok:true,value} 包裹的 describe 同样读出服务商桶口径", async () => {
  // 真网关把方法回执包成 {ok:true,value}（见 usage-stats 同款）；桩默认直返裸值，
  // 本用例锁定 unwrap 的包络分支（裸值分支由其余用例覆盖）。
  const origGet = ctxStub.get;
  ctxStub.get = (name: string) => ({
    ...origGet(name),
    describe: async (f: any) => ({ ok: true, value: { filter: { provider: f.provider }, models: [], providerLimits: { rpm: 33 } } }),
  });
  try {
    const tree = await renderReady(SEAT("opencode"));
    assert.equal(inputOf(tree).props.value, "33", "包络须解出内层读数");
  } finally {
    ctxStub.get = origGet;
  }
});

// 静态形态判定一律交给 dsh-check 的门（门自己会剥注释；本地再拿正则扫源码会把头注释里的
// 「v5 曾挂 window error 监听」这类历史说明当成现稿——判据必须来自被检代码本体）。
test("源码形态纪律：过 provider-card 席位门（§4.5）与动效守卫门（§4.3）", () => {
  assert.deepEqual(collectProviderCardSeatViolations(CLIENT), [], "provider-card 席位门必须零判");
  assert.deepEqual(collectMotionGuardViolations(CLIENT), [], "动效守卫必须零判");
  assert.ok(CLIENT.includes("--dsw-alias-") && CLIENT.includes("data-plugin"), "配色走设计令牌 + CSS 经注入通道（内联 style 承载不了态样式）");
});
