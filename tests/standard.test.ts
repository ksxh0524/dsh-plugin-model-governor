/** standard.test.ts —— 插件标准门（dsh-check）：cordis 形态/零依赖铁律/双语 README/工具链 + 两端契约配对。
 *  浏览器半 v3 只有 RPM 单行（provider-card 槽，无 footer）；配对门照常覆盖
 *  describe/configure 描述符。断言逻辑全在 dsh-check；本文件只做注册，门规则漂移在共享包统一升级。 */
import { contractPairSuite, pluginStandardSuite } from "dsh-check";
import { GovernorService } from "../src/cordis.ts";

pluginStandardSuite({ metaUrl: import.meta.url });
contractPairSuite({
  service: GovernorService,
  namespace: "governor",
  idPrefix: "model-governor",
  metaUrl: import.meta.url,
  optionalParams: true,
});
