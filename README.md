# dsh-plugin-model-governor

DSH model-governance plane: per-provider RPM queueing (delays, never rejects), RPS-ramp RPM probing that auto-applies only on topped runs, plus OpenCode session-header compat. All behavior lives in the `model-governor` settings slice; the UI is one RPM row per provider card on the host Models page. An outcome hook (`noteOutcome`) collects signals for a future breaker and never alters the stream.

## Tools & Services

| Name              | Kind    | Shape                                                                                  |
| ----------------- | ------- | -------------------------------------------------------------------------------------- |
| `governor`        | Remote  | `describe` / `configure` / `probe` / `probeStatus` / `cancelProbe` (see Contract)      |
| `llm/stream` hook | Service | Dual-bucket acquire (provider + provider/model) → header store → `next()` exactly once |
| fetch patch       | Service | Attaches the session header on target providers (OpenCode compat)                      |

## Contract

| Item        | Rule                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe`  | Read-only: models under the filter with effective limits (model → provider → defaults); with `filter.provider`, `providerLimits` uses the provider-bucket reading — the same source the card writes |
| `configure` | Accepts `{limits?, sessionHeader?}` only (unknown keys error); a dimension written `null` deletes the override and falls back upward; domain failures return `ok: false`, never throw               |
| `probe`     | Background run, returns immediately; only a topped run (watched a 429: N accepted, N+1 rejected) auto-writes the provider-level RPM; untopped / failed / cancelled runs write nothing               |
| Persistence | The `settings.yaml` user layer always wins over the `cordis.patch.yml` base row; empty bundle config = builtins only (unlimited + session header on)                                                |
| Outcome     | Every request reports success/failure exactly once to `noteOutcome` — signals only, never alters the stream                                                                                         |

## Config

| key             | Description                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `limits`        | `{defaults, providers, models}` per-dimension RPM / TPM / concurrency; `models` keys are `"provider/model"`; `null` deletes |
| `sessionHeader` | `{providers, mode}` OpenCode header compat — file-managed, no UI yet                                                        |

## Install

```sh
# profile package.json dependencies (local checkout until the first npm release):
"dsh-plugin-model-governor": "link:../plugin-model-governor"
```

Bundle row: package `dsh-plugin-model-governor` + patch insert id `model-governor` (empty config = builtins only). Host restart is user-owned.

## Verify

```sh
node --test tests/*.test.ts   # server logic first
pnpm check                     # prettier + tsc + full tests
pnpm check:browser             # browser-half changes only
```

## Browser half

`lib/client.js` (`./client` subpath): one RPM row per provider card — number box + `应用` + `探测`, nothing else. The card shell belongs to the host's own row: this half emits a plain content div, uses host primitives and `--dsw-*` tokens through `<style data-plugin="model-governor">` (index `docs/settings-pages.md` §2, `docs/runbooks/live-verify.md`).

| Seat claim & yield | Status                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Claimed seat       | `settings.models.provider-card` (keyed; props `{provider, configured, keyConfigured}`) — hard-wired, no other settings surface touched |
| Yield plan         | None yet — parked in the index debt book (原#20 模型治理硬编码认领两席位，让位方案未做)                                                |

Draft state is visible (editing marks 未保存 + 丢弃; `应用` is the only write path); a card without credentials renders one muted line instead of failing controls; the seat self-reports `data-gvr-ui="host|fallback"`.

## Known limits

- Only the Models-card provider row is claimed (yield plan: none yet — index debt 原#20).
- Queueing only delays: never rejects, never preempts a running call, and waiting never counts toward `maxRetries`.
- Writable rows have no real-device coverage yet: disposable instances carry no credentials, so the seat runs suppressed (index debt 原#16).
- A production-only vertical-layout anomaly never reproduced locally; hardened with explicit direction/alignment/flex plus `data-gvr-ui` self-report — quote that value if seen again (index debt 原#21).
- `sessionHeader` stays file-managed (no UI yet); `noteOutcome` only collects signals for a future breaker.
