# dsh-plugin-model-governor

DSH 模型治理面（纯服务端，无浏览器 UI）：逐模型思考强度覆盖（含自带值读出）、服务商/模型两级 RPM 排队、OpenCode 会话头兼容、错误翻译。行为全部经 `settings.yaml` / 治理配置切片配置，没有设置页 UI。

## 功能

- **思考强度覆盖**：每张模型卡展示自带档位（从已安装目录读出的 efforts/default），可逐模型覆盖（`reasoningEfforts` 拼写表、非推理声明、路由默认）。空覆盖 = 跟随自带。对不上的 id 进可修复列表，不再静默失效。
- **RPM 排队（永不拒单）**：`limits.defaults` → 服务商默认 → 模型覆盖，按维度（RPM / TPM / 并发）各自合并。令牌不够时本地排队等待（FIFO），不打到远端吃 429。等待不计入 `maxRetries`；abort 即撤出排队。
- **OpenCode 会话头**：原生移植 `dsh-opencode-session`（nobu121，MIT，见致谢）：给 OpenCode 系请求补 `x-opencode-session` 头，治 400 MissingSessionID 并保持 prompt-cache 亲和。
- **错误翻译**：`UNKNOWN_MODEL` / `UNSUPPORTED_REASONING_EFFORT` / `RATE_LIMIT` 翻译成可行动文案（缺哪个 id、去哪改）。自动 fallback 切模型 deliberately 不做（单路由规则）。

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

`models` 键形为 `"provider/model"`。每维度生效值 = 模型 → 服务商 → 全局默认（运行时双桶同时取令牌，最严获胜）。

## 界面

无——本包不带浏览器半，经 `settings.yaml` 配置（见上文配置节）。

## 致谢

会话头机制移植自 nobu121 的 [`dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session)（MIT）。感谢。

## 许可

MIT，见 [LICENSE](./LICENSE)。
