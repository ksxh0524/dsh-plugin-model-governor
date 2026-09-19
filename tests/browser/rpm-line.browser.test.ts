/** rpm-line.ui.test.ts —— provider-card 席位件真机验证（索引仓 `docs/settings-pages.md` §4.5 + 索引仓 `docs/runbooks/live-verify.md` 机器化）：
 *  一次性实例走「设置 → 模型」，断言的是**席位形态**而非像素：
 *  ① 席位内容不自带卡壳（边框/底色归宿主那张 `<li class=rowCard>`）、无内联 style、CSS 走注入通道，
 *     崩脸件为 0；三态各自的形态在此收口（可写行走 primitives 规格 / 抑制态不给写件 / 失败态有 alert+重试）；
 *  ② 可写行时走真写路径：改框出「未保存」+「丢弃」（丢弃只回基线）、点应用真写一次并回读、收尾清空；
 *  ③ 可写行时点探测走真链路（无 key 的裸实例必 fast-fail：按钮回「探测」+ 结论落 role 承载）。
 *  跑法：pnpm check:browser（自起实例 + 系统 Chrome，不碰任何正在服务的 host）。 */
import { uiScenarioSuite, type UiContext } from "dsh-check";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));

type Page = UiContext["page"];
type Locator = ReturnType<Page["locator"]>;

async function openModels(page: Page): Promise<Locator> {
  // 自起实例落地页可能已开着设置弹层（触发器 aria-expanded=true）：开着就直接用，不硬点。
  let dialog = page.locator('[role="dialog"]').last();
  if (
    (await dialog.count()) === 0 ||
    !(await dialog
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await page.locator('[aria-label="设置"]').first().click({ timeout: 10_000 });
    dialog = page.locator('[role="dialog"]').last();
  }
  await dialog.getByText("模型", { exact: true }).first().click({ timeout: 10_000 });
  return dialog;
}

/** 席位三态（判据是 DOM 里的件，不是文案子串——抑制说明本身就带“自动探测”字样）：
 *  row = 给了可写行；suppressed = keyConfigured:false 的抑制说明；error = 读取失败态。 */
type SeatState = "row" | "suppressed" | "error";

async function awaitSeat(page: Page): Promise<{ dialog: Locator; seat: Locator; state: SeatState; text: string }> {
  const dialog = await openModels(page);
  const seat = dialog.locator(".gvr-seat").first();
  try {
    await seat.waitFor({ state: "visible", timeout: 25_000 });
  } catch {
    const text = ((await dialog.innerText().catch(() => "")) || "").slice(0, 400);
    await page.screenshot({ path: "/tmp/gov-seat-fail.png" });
    throw new Error(`等 .gvr-seat 超时（席位没渲染：PROVIDER_KEYS 与下发的 settingsNs 对不上，或只剩草稿位）弹层文本头：${text}`);
  }
  const text = await seat.innerText();
  const state: SeatState = (await dialog.locator(".gvr-row input").count()) > 0 ? "row" : text.includes("还没配 API key") ? "suppressed" : "error";
  return { dialog, seat, state, text };
}

const styleOf = (page: Page, sel: string, prop: string) =>
  page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).${prop}`) as Promise<string>;

uiScenarioSuite({
  pluginRoot,
  scenarios: [
    {
      name: "席位形态：内容壳不重复宿主卡壳、无内联 style、CSS 走注入通道、三态各有其形",
      async run({ page }) {
        const { dialog, seat, state, text } = await awaitSeat(page);
        if (await dialog.locator("[data-slot-error]").count()) throw new Error("冒出宿主崩脸件：席位件抛错了");
        // 卡壳归宿主：本半的内容壳不得自带边框/底色（重复容器 = 双框错位）
        if ((await seat.evaluate((el: any) => el.tagName)) !== "DIV") throw new Error("席位内容壳不是 div（卡壳归宿主 <li>，别自造）");
        if ((await dialog.locator(".gvr-seat li").count()) !== 0) throw new Error("席位内部又长出 <li>");
        const border = await styleOf(page, ".gvr-seat", "borderTopWidth");
        const bg = await styleOf(page, ".gvr-seat", "backgroundColor");
        if (border !== "0px") throw new Error(`内容壳自带边框 ${border}——卡壳样式该归宿主 rowCard`);
        if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") throw new Error(`内容壳自带底色 ${bg}——同上`);
        // 配色走令牌 + 注入通道：内联 style 承载不了 hover/focus/placeholder/disabled
        if ((await dialog.locator(".gvr-seat [style]").count()) !== 0) throw new Error("席位里还有内联 style（v5 遗风：字面色贴深色主题必坏）");
        if (!(await page.evaluate(`!!document.querySelector('style[data-plugin="model-governor"]')`)))
          throw new Error("CSS 没走注入通道（<style data-plugin>）");
        if (state === "suppressed") {
          // 抑制态（一次性实例没配 key 即此支）：不给任何写件，但要说清为什么。
          if ((await seat.locator("button").count()) !== 0) throw new Error("抑制态还留着按钮——没配 key 的写件与探测必失败");
          await page.screenshot({ path: "/tmp/gov-seat-suppressed.png" });
          return;
        }
        if (state === "error") {
          if ((await seat.locator('[role="alert"]').count()) === 0) throw new Error(`失败态没有 role=alert 承载：${text.slice(0, 80)}`);
          if ((await seat.locator("button", { hasText: "重试" }).count()) === 0) throw new Error("失败态没有重试入口");
          return;
        }
        const btns = await seat.locator("button").allInnerTexts();
        if (btns.length !== 2 || btns[0] !== "应用" || btns[1] !== "探测") throw new Error(`单行按钮形态不对，实得：${JSON.stringify(btns)}`);
        const radius = await styleOf(page, ".gvr-row button", "borderRadius");
        const height = await styleOf(page, ".gvr-row button", "height");
        if (radius !== "14px" || height !== "28px") throw new Error(`按钮不是宿主 primitives 的 sm 规格（实得 r=${radius} h=${height}）——手搓替身或 CSS 打架`);
        if ((await page.evaluate(`document.querySelector(".gvr-row input")?.getAttribute("aria-label") || ""`)) !== "RPM")
          throw new Error("输入框缺 aria-label（席位范本：span 字段名 + aria-label）");
        // 单行横排是机器断言，不是靠眼睛：方向、子项同行、诊断位三件齐（模型卡竖排事故复盘）。
        if ((await styleOf(page, ".gvr-row", "flexDirection")) !== "row") throw new Error("可写行不是横排（方向必须显式 row，不靠默认值）");
        const ys = await page.evaluate(
          `[...document.querySelector(".gvr-seat .gvr-row").children].map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })`,
        );
        if (Math.max(...(ys as number[])) - Math.min(...(ys as number[])) > 12)
          throw new Error(`同行四件不在一条水平线上（中线 y=${JSON.stringify(ys)}）——竖排/换行即红`);
        if (!["host", "fallback"].includes(await page.evaluate(`document.querySelector(".gvr-seat")?.getAttribute("data-gvr-ui") || ""`)))
          throw new Error("席位缺 data-gvr-ui 诊断位（必须自报走宿主件还是本地降级）");
        if (text.includes("重启")) throw new Error("写进 settings 文档即持久，不该再挂“重启恢复”说明");
        await page.screenshot({ path: "/tmp/gov-seat.png" });
      },
    },
    {
      name: "写路径：dirty 出「未保存」+「丢弃」（丢弃只回基线），应用真写一次并回读",
      async run({ page }) {
        const { seat, state } = await awaitSeat(page);
        if (state !== "row") return; // 非可写两态的形态归第一景统一判
        const input = seat.locator("input").first();
        const baseline = await input.inputValue();
        await input.fill("77");
        if (!(await seat.innerText()).includes("未保存")) throw new Error("改框后没有未保存标记");
        const discard = seat.locator("button", { hasText: "丢弃" });
        if ((await discard.count()) === 0) throw new Error("dirty 却没有丢弃入口");
        await discard.click();
        if ((await input.inputValue()) !== baseline) throw new Error("丢弃没回服务端基线");
        if ((await seat.locator("button", { hasText: "丢弃" }).count()) !== 0) throw new Error("回基线后丢弃入口未收起");
        // 真写一次：应用 → busy 回解（曾卡死“应用中”）→ 回读新值
        await input.fill("77");
        await seat.locator("button", { hasText: "应用" }).click();
        await seat.locator("button", { hasText: "应用" }).waitFor({ timeout: 15_000 });
        if ((await input.inputValue()) !== "77") throw new Error(`回读失败：期望 77，实得 ${await input.inputValue()}`);
        // 收尾回干净：空 = 删除该服务商 RPM 桶（回落不限），不把 77 留给后面的场景
        await input.fill("");
        await seat.locator("button", { hasText: "应用" }).click();
        await seat.locator("button", { hasText: "应用" }).waitFor({ timeout: 15_000 });
      },
    },
    {
      name: "探测：点探测走真链路；结论落 role 承载且按钮回「探测」",
      async run({ page }) {
        const { seat, state } = await awaitSeat(page);
        if (state !== "row") {
          if ((await seat.locator("button", { hasText: "探测" }).count()) !== 0) throw new Error("非可写态不该出现探测入口");
          return;
        }
        await seat.locator("button", { hasText: "探测" }).click();
        // 裸实例无 key：探测发起即失败 → 按钮变回“探测”，行下跟结论；
        // 若真跑起来（按钮变倒计时）→ 点它取消，同样回按钮。
        const probeBtn = seat.locator("button", { hasText: "探测" });
        try {
          await probeBtn.waitFor({ state: "visible", timeout: 30_000 });
        } catch {
          const countdown = seat.locator("button").nth(1);
          const countdownText = await countdown.innerText().catch(() => "");
          if (/^\d+s$/.test(countdownText)) {
            if ((await countdown.getAttribute("aria-label")) !== "取消探测") throw new Error("倒计时按钮缺 aria-label（视觉上只剩秒数）");
            await countdown.click();
          }
          await probeBtn.waitFor({ state: "visible", timeout: 30_000 });
        }
        let text = "";
        for (let i = 0; i < 15 && !(text.length > 10 && /探测|取消|写入|失败|触顶|RPM|错误|已有探测/.test(text)); i++) {
          await page.waitForTimeout(1000);
          text = await seat.innerText().catch(() => "");
        }
        if (!(text.length > 10 && /探测|取消|写入|失败|触顶|RPM|错误|已有探测/.test(text)))
          throw new Error(`探测后无结论/失败文案，实得：${text.slice(0, 120)}`);
        // 结论必须坐在能播报的位置上（role=status/alert），不是一条裸 div
        if ((await seat.locator('[role="status"], [role="alert"]').count()) === 0) throw new Error(`探测结论无 role 承载（读屏播不到）：${text.slice(0, 80)}`);
        await page.screenshot({ path: "/tmp/gov-probe.png" });
      },
    },
  ],
});
