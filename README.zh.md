# dsh-plugin-model-governor

DSH 模型治理面：每张服务商卡片一行 RPM（只排队、不拒单），RPM 探测（触顶自动填入），外加 OpenCode 会话头兼容。行为全部经 `settings.yaml` / 治理配置切片配置；设置页 UI 为宿主模型卡内的一行 RPM。

## 功能

- **RPM 排队（永不拒单）**：`limits.defaults` → 服务商默认 → 模型覆盖，按维度（RPM / TPM / 并发）各自合并。令牌不够时本地排队等待（FIFO），不打到远端吃 429。等待不计入 `maxRetries`；abort 即撤出排队。RPM 槽自放行起占满 60 秒（滑窗），并发槽占到 `release` 为止——跑得再快，该分钟的 RPM 照样计数。
- **RPM 探测（触顶自动填入）**：每卡 `探测` 按钮发极小请求（`maxTokens` 缺省 16，可调 1–200——部分网关对 `max_completion_tokens: 1` 直接 400），按 RPS 爬坡测——起始 2 RPS、每秒 +1、封顶 20 RPS，同时在飞最多 32（硬顶 50）。发送速率与 RTT 无关，RPM 60 约 9 秒定论、RPM 300 约 23 秒，全程不出缺省 60 秒窗口。只有亲眼见到 429（N 个放行、第 N+1 个被拒）才自动写入服务商级 RPM——这是远端刚演示的事实，不是推断。未触顶 / 失败 / 取消一律不写、保持不限流。单服务商单飞行，随时可取消。
- **OpenCode 会话头**：原生移植 `dsh-opencode-session`（nobu121，MIT，见致谢）：给 OpenCode 系请求补 `x-opencode-session` 头，治 400 MissingSessionID 并保持 prompt-cache 亲和。
- **成败上报口（预留）**：每次请求 exactly-once 向 `noteOutcome` 上报成败——将来熔断器（与按错误码处置 UI）挂在这里。目前只收信号，不改流。

## 安装

```bash
dsh plugin --profile <your-profile> add dsh-plugin-model-governor
```

然后完整重启 profile（bundle 层只在启动时读）。首个 npm 版本发布前，用本地目录安装：

```bash
dsh plugin --profile <your-profile> add ./path/to/dsh-plugin-model-governor
```

## 配置

插件行在 profile 的 `cordis.patch.yml` 里（bundle 缺省为空 = 纯自带行为）。它是 base 缺省层：页面上点的 `应用` / 探测自动填入写进 `settings.yaml` 的 `model-governor` 段并盖在它上面，重启仍在。所有键可选：

```yaml
- insert:
    - id: model-governor
      name: dsh-plugin-model-governor
      config:
        limits:
          defaults: { rpm: 60 }
          providers: { buzz: { rpm: 30 } }
          models: { "buzz/qwen3.8-flash-free": { rpm: 10 } }
        sessionHeader:
          providers: [opencode, opencode-go]
          mode: session-id
```

`models` 键形为 `"provider/model"`。每维度生效值 = 模型 → 服务商 → 全局默认（运行时双桶同时取令牌，最严获胜）。某维写 `null` 即删掉已设值、回落上层（如 `{ limits: { providers: { buzz: { rpm: null } } } }`）。

## 探测

`probe({ provider, model?, rampStartRps?, rampStepRps?, rampStepMs?, maxRps?, maxInflight?, confirmPauseMs?, confirmCount?, maxRequests?, durationMs?, maxTokens? })` 后台跑、立即返回；`probeStatus({ provider })` 轮询进度，`cancelProbe({ provider })` 取消。缺省：`rampStartRps: 2`、`rampStepRps: 1/秒`、`maxRps: 20`、`maxInflight: 32`（硬顶 50）、`maxRequests: 300`、`durationMs: 60000`、`maxTokens: 16`。探测流量 bypass 本地限流（测的是远端不是自己），成败同样进 `noteOutcome`。配额见底（`QUOTA`）即停探，且绝不当 RPM 写入。

## 界面

设置 → 模型每张卡片只一行：`RPM` + 数字框 + `应用` + `探测`，此外什么都没有。卡壳（边框/底色/圆角/padding）归宿主自己的 `<li class="rowCard">`：本包只出一个内容 div，控件用宿主 primitives（`Input`、`Button` sm = 28px/r14），配色全走 `--dsw-*` 令牌并经 `<style data-plugin="model-governor">` 注入（索引仓 `docs/settings-pages.md` §4.5）。

- **消费席位下发的事实**：槽给的是 `{provider, configured, keyConfigured}`。草稿卡（「添加提供方」还没落盘）整行不出；没配凭据的卡只出一句 muted 说明，不给注定失败的写件。
- **读数与写入同源**：框里显示 `describe({provider}).providerLimits`，即服务商桶自己的执法口径（`providers[route]` → `defaults`），也正是 `configure({limits:{providers:{[route]:{rpm}}}})` 写进去的那一维。模型级覆盖留在 `models[].limits`，不串进本行。
- **草稿态看得见**：改框即标「未保存」并出现「丢弃」（回服务端值，绝不发写）；写点仍然只有「应用」一处。
- **写下去就是永久的**：`应用` 与探测触顶自动填入都经 `configure` 同一路落进宿主 settings 文档（`model-governor` 段，`settings.yaml`），热推送即时生效，重启仍在。`cordis.patch.yml` 的 config 行是 base 缺省（空 = 纯自带行为），文档用户层盖在它上面；`sessionHeader` 暂无 UI，只走文件。席位另带 `data-gvr-ui="host|fallback"` 自报走的是宿主件还是本地降级，截图/DOM 一眼可辨。
- 点 `探测` 后该按钮本身变成剩余秒倒计时（再点=取消；取消失败会写明原因，不静默吞）；结束或失败都变回 `探测`，结论行由 `role="status"` / `role="alert"` 承载（读取失败带「重试」）。空=删除该卡 RPM（回落上层）。其余经 `settings.yaml` 配置（见上文配置节）。

## 已知边界

- 只认领模型卡的服务商行（席位写死）；其他设置面一概不碰。
- 排队只延迟——不拒单、不抢占运行中的调用；等待不计入 `maxRetries`。
- `settings.yaml` 用户层永远盖掉 `cordis.patch.yml` 的 base 行；空 bundle 配置 = 纯自带行为（不限流 + OpenCode 会话头默认开）。
- `sessionHeader` 只走文件（暂无 UI）；`noteOutcome` 只收信号，给将来的熔断器留口，不改流。
- 可写行暂缺真机覆盖：一次性实例没配凭据，席位走抑制态，写路径与探测只由离线 harness 覆盖。
- 生产页独有的竖排显示异常本地从未复现，已加固（方向/对齐/伸缩显式＋降级药丸＋`data-gvr-ui` 自报）；再见到请报该值定位。

## 浏览器 E2E（UI 验证）

`pnpm check:browser` 自起一次性实例，真驱动无头 Chrome 进「设置 → 模型」，断言席位形态而非像素：不重复宿主卡壳、
不留内联 `style`、CSS 确经 `<style data-plugin>` 注入通道到达，且三态各有其形（可写行命中宿主 primitives 规格 /
抑制卡不给写件 / 读取失败有 `role="alert"` + 重试）。浏览器半改动必须过它（索引仓 `docs/settings-pages.md` §4.5 + 索引仓 `docs/runbooks/live-verify.md`，dsh-check 第 12 门）。

## 致谢

会话头机制移植自 nobu121 的 [`dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session)（MIT）。感谢。

## 许可

MIT，见 [LICENSE](./LICENSE)。
