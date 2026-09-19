# dsh-plugin-model-governor

DSH 模型治理面：按服务商 RPM 排队（只延迟、不拒单）、RPS 爬坡式 RPM 探测（仅触顶才自动填入），外加 OpenCode 会话头兼容。行为全部收在 `model-governor` 设置切片里；界面是宿主模型页每张服务商卡上的一行 RPM。成败上报口（`noteOutcome`）只给将来的熔断器收信号，不改流。

## 工具与服务

| 名称              | 形态    | 说明                                                                              |
| ----------------- | ------- | --------------------------------------------------------------------------------- |
| `governor`        | Remote  | `describe` / `configure` / `probe` / `probeStatus` / `cancelProbe`（见 Contract） |
| `llm/stream` 监听 | Service | 双桶取令牌（服务商桶 + 服务商/模型桶）→ header store → `next()` 恰调一次          |
| fetch 补丁        | Service | 给目标服务商请求补会话头（OpenCode 兼容）                                         |

## Contract

| 条目        | 规则                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `describe`  | 纯读：过滤器下各模型 + 生效限流（模型 → 服务商 → 全局默认）；带 `filter.provider` 时 `providerLimits` 取服务商桶口径——与卡片写入同源 |
| `configure` | 只收 `{limits?, sessionHeader?}`（未知键报错）；某维写 `null` 即删覆盖、回落上层；域内失败回 `ok: false`，不抛                       |
| `probe`     | 后台跑、立即返回；只有亲眼见到 429（N 个放行、第 N+1 个被拒）才自动写入服务商级 RPM；未触顶 / 失败 / 取消一律不写                    |
| 持久化      | `settings.yaml` 用户层永远盖掉 `cordis.patch.yml` 的 base 行；空 bundle 配置 = 纯自带行为（不限流 + 会话头默认开）                   |
| 上报        | 每次请求向 `noteOutcome` exactly-once 上报成败——只收信号，不改流                                                                     |

## Config

| key             | 说明                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `limits`        | `{defaults, providers, models}` 三维 RPM / TPM / 并发；`models` 键形 `"provider/model"`；`null` 即删 |
| `sessionHeader` | `{providers, mode}` OpenCode 会话头兼容——只走文件，暂无 UI                                           |

## Install

```sh
# profile package.json dependencies（首个 npm 版本前用本地目录）：
"dsh-plugin-model-governor": "link:../plugin-model-governor"
```

Bundle 行：包名 `dsh-plugin-model-governor` + patch insert id `model-governor`（空 config = 纯自带行为）。宿主重启只归用户。

## 验证

```sh
node --test tests/*.test.ts   # 先跑服务端逻辑
pnpm check                     # prettier + tsc + 全量测试
pnpm check:browser             # 只在改浏览器半时跑
```

## Browser half

`lib/client.js`（`./client` 子路径）：每张服务商卡只一行——数字框 + `应用` + `探测`，此外什么都没有。卡壳归宿主自己的行：本包只出内容 div，控件用宿主 primitives，配色经 `<style data-plugin="model-governor">` 走 `--dsw-*` 令牌（索引仓 `docs/settings-pages.md` §2、`docs/runbooks/live-verify.md`）。

| 席位认领与让位 | 现状                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| 认领席位       | `settings.models.provider-card`（keyed；入参 `{provider, configured, keyConfigured}`）——写死，其他设置面一概不碰 |
| 让位方案       | 暂无——挂在索引仓欠账簿（原#20 模型治理硬编码认领两席位，让位方案未做）                                           |

草稿态看得见（改框即标未保存 + 丢弃；写点只有`应用`一处）；无凭据的卡只出一句 muted 说明，不给注定失败的写件；席位自报 `data-gvr-ui="host|fallback"`。

## 已知边界

- 只认领模型卡的服务商行（让位方案暂无——索引仓 debt 原#20）。
- 排队只延迟：不拒单、不抢占运行中的调用；等待不计入 `maxRetries`。
- 可写行暂缺真机覆盖：一次性实例没配凭据，席位走抑制态（索引仓 debt 原#16）。
- 生产页独有的竖排显示异常本地从未复现，已加固（方向/对齐/伸缩显式＋`data-gvr-ui` 自报）；再见到请报该值定位（索引仓 debt 原#21）。
- `sessionHeader` 只走文件（暂无 UI）；`noteOutcome` 只收信号，给将来的熔断器留口。
