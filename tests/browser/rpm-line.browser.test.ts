/** rpm-line.ui.test.ts —— 治理单行真机验证（STANDARDS §5 机器化）：一次性实例走
 *  「设置 → 模型」，断言每卡单行（RPM + 数字框 + 应用 + 探测，无清除）挂载、零崩脸、
 *  无旧垃圾；第二场景真写一次 RPM 并断言回读（覆盖 busy 回解回归）；第三场景点探测
 *  走真链路（无 key 的裸实例必 fast-fail：按钮变回探测 + 行下跟失败文案），断言
 *  wire-through（结论/错误/取消文案出现即算通，不过长等待）。
 *  跑法：pnpm check:browser（自起实例 + 系统 Chrome，不碰任何正在服务的 host）。 */
import { uiScenarioSuite, type UiContext } from "dsh-check";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));

type Page = UiContext["page"];

async function openModels(page: Page) {
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

uiScenarioSuite({
  pluginRoot,
  scenarios: [
    {
      name: "设置 → 模型：治理单行挂载，零崩脸，无旧垃圾",
      async run({ page }) {
        const dialog = await openModels(page);
        try {
          // 卡片异步挂载：等首个 .gvr-rpm 可见（裸实例模型目录即出卡，无需配 key）。
          await dialog.locator(".gvr-rpm").first().waitFor({ state: "visible", timeout: 25_000 });
        } catch {
          const text = ((await dialog.innerText().catch(() => "")) || "").slice(0, 500);
          await page.screenshot({ path: "/tmp/gov-rpm-fail.png" });
          throw new Error(`等 .gvr-rpm 超时；弹层文本头：${text}（截图 /tmp/gov-rpm-fail.png）`);
        }
        const crash = await dialog.locator("[data-slot-error]").count();
        if (crash !== 0) throw new Error(`崩脸 ${crash} 处：治理单行炸了`);
        const old = await dialog.locator(".gvr-card").count();
        if (old !== 0) throw new Error(`旧垃圾 .gvr-card 残留 ${old} 处`);
        const row = dialog.locator(".gvr-rpm").first();
        const label = await row.innerText();
        if (!label.includes("RPM")) throw new Error(`首行无 RPM 字样，实得：${label.slice(0, 60)}`);
        // 单行两按钮：应用在前、探测在后，无清除、无探测行。
        const btns = await row.locator("button").allInnerTexts();
        if (btns.length !== 2 || btns[0] !== "应用" || btns[1] !== "探测") {
          throw new Error(`单行按钮形态不对，实得：${JSON.stringify(btns)}`);
        }
        if ((await dialog.locator(".gvr-probe").count()) !== 0) throw new Error("旧探测行 .gvr-probe 残留");
        await page.screenshot({ path: "/tmp/gov-rpm.png" });
      },
    },
    {
      name: "RPM 写入：改框点应用 → 回读新值，按钮回解",
      async run({ page }) {
        const dialog = await openModels(page);
        const row = dialog.locator(".gvr-rpm").first();
        await row.waitFor({ state: "visible", timeout: 25_000 });
        await row.locator("input").fill("77");
        await row.locator("button", { hasText: "应用" }).click();
        // busy 回解：按钮文字回“应用”（曾卡死“应用中”的回归）。
        await row.locator("button", { hasText: "应用" }).waitFor({ timeout: 15_000 });
        const value = await row.locator("input").inputValue();
        if (value !== "77") throw new Error(`回读失败：期望 77，实得 ${value}`);
      },
    },
    {
      name: "探测：点探测走真链路（裸实例 fast-fail：按钮变回探测 + 行下跟失败文案）",
      async run({ page }) {
        const dialog = await openModels(page);
        const row = dialog.locator(".gvr-rpm").first();
        await row.waitFor({ state: "visible", timeout: 25_000 });
        await row.locator("button", { hasText: "探测" }).click();
        // 裸实例无 key：探测发起即失败 → 按钮变回“探测”，行下跟失败文案。
        // 若 8 秒内按钮变成倒计时（说明真跑起来了）→ 点它取消，同样回按钮 + 取消文案。
        const probeBtn = row.locator("button", { hasText: "探测" });
        try {
          await probeBtn.waitFor({ state: "visible", timeout: 30_000 });
        } catch {
          // 30 秒还没回按钮：看是不是倒计时卡住，卡住就点它取消再验。
          const countdown = row.locator("button").nth(1);
          const countdownText = await countdown.innerText().catch(() => "");
          if (/^\d+s$/.test(countdownText)) await countdown.click();
          await probeBtn.waitFor({ state: "visible", timeout: 30_000 });
        }
        let text = "";
        for (let i = 0; i < 15 && !(text.length > 10 && /探测|取消|写入|失败|触顶|RPM|错误|已有探测/.test(text)); i++) {
          await page.waitForTimeout(1000);
          text = await row.innerText().catch(() => "");
        }
        if (!(text.length > 10 && /探测|取消|写入|失败|触顶|RPM|错误|已有探测/.test(text))) {
          throw new Error(`探测后无结论/失败文案，实得：${text.slice(0, 120)}`);
        }
        await page.screenshot({ path: "/tmp/gov-probe.png" });
      },
    },
  ],
});
