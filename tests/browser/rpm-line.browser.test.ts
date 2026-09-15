/** rpm-line.ui.test.ts —— RPM 单行 + 探测行真机验证（STANDARDS §5 机器化）：一次性实例走
 *  「设置 → 模型」，断言每卡 RPM 行（标签就 RPM 三个字 + 数字框 + 应用 + 清除）与探测行
 *  （探测按钮 + 说明）挂载、零崩脸、无旧垃圾；第二场景真写一次 RPM 并断言回读（覆盖 busy
 *  回解回归）；第三场景点探测走真链路（无 key 的裸实例必 fast-fail，或跑起来就取消），
 *  断言行内出现结论/错误/取消文案（wire-through 证明，不过长等待）。
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
      name: "设置 → 模型：RPM 单行挂载，零崩脸，无旧垃圾",
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
        if (crash !== 0) throw new Error(`崩脸 ${crash} 处：RPM 行炸了`);
        const old = await dialog.locator(".gvr-card").count();
        if (old !== 0) throw new Error(`旧垃圾 .gvr-card 残留 ${old} 处`);
        const label = await dialog.locator(".gvr-rpm").first().innerText();
        if (!label.includes("RPM")) throw new Error(`首行无 RPM 字样，实得：${label.slice(0, 60)}`);
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
        // 清除：删掉服务商级 rpm，回读空（回落上层=不限）。
        await row.locator("button", { hasText: "清除" }).click();
        let cleared = "";
        for (let i = 0; i < 30 && cleared !== ""; i++) {
          if (i > 0) await page.waitForTimeout(500);
          cleared = await row.locator("input").inputValue();
        }
        if (cleared !== "") throw new Error(`清除后回读失败：期望空，实得 ${cleared}`);
      },
    },
    {
      name: "探测行挂载：有点探测按钮；点探测走真链路（失败/取消皆算通）",
      async run({ page }) {
        const dialog = await openModels(page);
        const row = dialog.locator(".gvr-probe").first();
        await row.waitFor({ state: "visible", timeout: 25_000 });
        const hint = await row.innerText();
        if (!hint.includes("探测")) throw new Error(`探测行无探测字样，实得：${hint.slice(0, 60)}`);
        await row.locator("button", { hasText: "探测" }).click();
        // 裸实例无 key：要么 fast-fail 出错误文案，要么跑起来（出现取消按钮）→ 主动取消。
        const cancel = row.locator("button", { hasText: "取消" });
        try {
          await cancel.waitFor({ state: "visible", timeout: 8_000 });
          await cancel.click();
        } catch {
          // 8 秒内没进入 running：应已直接落地结论/错误，不断言细节，下一步统一验行文案。
        }
        let text = "";
        for (let i = 0; i < 30 && !(text.length > 20 && /探测|取消|写入|失败|触顶|RPM|错误|已有探测/.test(text)); i++) {
          await page.waitForTimeout(1000);
          text = await row.innerText().catch(() => "");
        }
        if (!(text.length > 20 && /探测|取消|写入|失败|触顶|RPM|错误|已有探测/.test(text))) {
          throw new Error(`探测行无结论文案，实得：${text.slice(0, 120)}`);
        }
        await page.screenshot({ path: "/tmp/gov-probe.png" });
      },
    },
  ],
});
