/** rpm-line.browser.test.ts —— RPM 单行真机门（自起实例 + 自起 headless Chrome，CDP 直驱）：
 *  无 GOV_BROWSER_URL / GOV_BROWSER_TOKEN 时 skip（本文件只在验证轮由人给出实例地址后跑，
 *  不进 pnpm check 默认链；check:browser 串起它）。有地址时不断言截图，只断言 DOM：
 *  ① 设置 → 模型页出现 ≥1 个 .gvr-rpm；② 零 data-slot-error 崩脸；③ 旧垃圾无残留
 *  （零 .gvr-card）；④ 截图落 /tmp/gov-rpm.png 供人阅读验收。
 *  零外部依赖：http + 原生 WebSocket 手写最小 CDP 客户端。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

const BASE = process.env.GOV_BROWSER_URL;
const TOKEN = process.env.GOV_BROWSER_TOKEN;
const CDP_PORT = Number(process.env.GOV_CDP_PORT ?? 9334);
const SHOT = "/tmp/gov-rpm.png";

function httpReq(method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${CDP_PORT}`);
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: { "Content-Type": "application/json" } },
      (res: any) => {
        let buf = "";
        res.on("data", (c: any) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: buf }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

class Cdp {
  private ws: any;
  private seq = 0;
  private waiting = new Map<number, { ok: (v: any) => void; err: (e: any) => void }>();
  static async open(wsUrl: string): Promise<Cdp> {
    const c = new Cdp();
    c.ws = new (globalThis as any).WebSocket(wsUrl);
    await new Promise((ok, err) => {
      c.ws.addEventListener("open", () => ok(undefined), { once: true });
      c.ws.addEventListener("error", err, { once: true });
    });
    c.ws.addEventListener("message", (ev: any) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const w = c.waiting.get(msg.id);
        if (w) {
          c.waiting.delete(msg.id);
          if (msg.error) w.err(new Error(JSON.stringify(msg.error)));
          else w.ok(msg.result);
        }
      }
    });
    return c;
  }
  call(method: string, params: any = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((ok, err) => {
      this.waiting.set(id, { ok, err });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关 */
    }
  }
}

async function evaluate(cdp: Cdp, fnSource: string, awaitPromise = false): Promise<any> {
  const r = await cdp.call("Runtime.evaluate", {
    expression: `(${fnSource})()`,
    returnByValue: true,
    awaitPromise,
  });
  if (r.exceptionDetails) throw new Error("evaluate 炸: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
}

const CLICK_MODELS = `() => {
  const btns = [...document.querySelectorAll('button')];
  const settings = btns.find(b => (b.textContent || '').includes('设置'));
  if (settings) settings.click();
  return !!settings;
}`;
const POLL_MODELS = `() => {
  const btns = [...document.querySelectorAll('button')];
  const navs = [...document.querySelectorAll('[role="tab"],li,button')];
  const model = navs.find(el => (el.textContent || '').trim() === '模型');
  if (model) model.click();
  return {
    rpm: document.querySelectorAll('.gvr-rpm').length,
    crash: document.querySelectorAll('[data-slot-error]').length,
    oldCard: document.querySelectorAll('.gvr-card').length,
    hasModels: document.body.textContent.includes('模型目录'),
  };
}`;

test("RPM 单行真机：出 UI、零崩脸、无旧垃圾", { timeout: 120000 }, async (t) => {
  if (!BASE || !TOKEN) {
    t.skip("缺 GOV_BROWSER_URL/TOKEN：真机门只在验证轮跑");
    return;
  }
  const created = await httpReq("PUT", "/json/new");
  assert.equal(created.status, 200, "Chrome 调试端口应答");
  const target = (JSON.parse(created.text) as any).webSocketDebuggerUrl as string;
  const targetId = /devtools\/page\/([^/]+)$/.exec(target)?.[1];
  const cdp = await Cdp.open(target);
  try {
    await cdp.call("Page.navigate", { url: `${BASE}/?token=${TOKEN}` });
    await new Promise((r) => setTimeout(r, 6000));
    await evaluate(cdp, CLICK_MODELS);
    let state: any = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      state = await evaluate(cdp, POLL_MODELS);
      if (state.hasModels && state.rpm > 0) break;
    }
    assert.ok(state.hasModels, "模型页应出现（模型目录字样）");
    assert.equal(state.crash, 0, "零 data-slot-error 崩脸");
    assert.equal(state.oldCard, 0, "旧垃圾 .gvr-card 无残留");
    assert.ok(state.rpm >= 1, `≥1 个 .gvr-rpm，实得 ${state.rpm}`);
    const shot = await cdp.call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  } finally {
    cdp.close();
    if (targetId) await httpReq("PUT", `/json/close/${targetId}`).catch(() => undefined);
  }
});
