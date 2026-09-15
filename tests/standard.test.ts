/** standard.test.ts —— 插件标准门（dsh-check）：cordis 形态/零依赖铁律/双语 README/工具链。
 *  本包是纯服务端插件（无浏览器半：2026-09-16 用户要求去掉模型页扩展 UI 后整摘，
 *  见 INC-005）：不传 clientFile，装载面/UI 件/配对门按无客户端跳过；服务端 SRC
 *  形态仍由本门 + cordis.test.ts 覆盖。断言逻辑全在 dsh-check；本文件只做注册。 */
import { pluginStandardSuite } from "dsh-check";

pluginStandardSuite({ metaUrl: import.meta.url });
