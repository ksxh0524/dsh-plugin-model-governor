# dsh-plugin-model-governor

DSH 模型治理面：每张服务商卡片一行 RPM（只排队、不拒单），RPM 探测（触顶自动填入），外加 OpenCode 会话头兼容。行为全部经 `settings.yaml` / 治理配置切片配置；设置页 UI 为每卡 RPM 行与探测行。

## 功能

- **RPM 排队（永不拒单）**：`limits.defaults` → 服务商默认 → 模型覆盖，按维度（RPM / TPM / 并发）各自合并。令牌不够时本地排队等待（FIFO），不打到远端吃 429。等待不计入 `maxRetries`；abort 即撤出排队。
- **RPM 探测（触顶自动填入）**：每卡 `探测` 按钮发极小请求（`maxTokens: 1`）分两阶段测——先单并发连打（小水管秒级定论，碰不到并发墙），再并行加倍 burst（大水管用累计成功数逼近）。只有亲眼见到 429（N 个放行、第 N+1 个被拒）才自动写入服务商级 RPM——这是远端刚演示的事实，不是推断。未触顶 / 失败 / 取消一律不写、保持不限流。单服务商单飞行，随时可取消。
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

插件行在 profile 的 `cordis.patch.yml` 里（bundle 缺省为空 = 纯自带行为）。所有键可选：

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

`probe({ provider, model?, phaseA?, bursts?, confirmPauseMs?, confirmCount?, staggerMs?, maxRequests?, durationMs? })` 后台跑、立即返回；`probeStatus({ provider })` 轮询进度，`cancelProbe({ provider })` 取消。缺省：`phaseA: 15`、`bursts: [8,16,32]`、`maxRequests: 150`、`durationMs: 120000`。探测流量 bypass 本地限流（测的是远端不是自己），成败同样进 `noteOutcome`。配额见底（`QUOTA`）即停探，且绝不当 RPM 写入。

## 界面

设置 → 模型每张卡片两行：RPM 行（`RPM 上限` + 数字框 + `应用` + `清除`）与探测行（`探测` + 进度/取消 + 一句话结论），此外什么都没有——无标题、无徽标、无页脚区。空=不限。其余经 `settings.yaml` 配置（见上文配置节）。

## 致谢

会话头机制移植自 nobu121 的 [`dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session)（MIT）。感谢。

## 许可

MIT，见 [LICENSE](./LICENSE)。
