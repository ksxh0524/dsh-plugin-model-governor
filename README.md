# dsh-plugin-model-governor

DSH model governance plane: one RPM line per provider card (never rejects, only delays), RPM probing with auto-apply, plus OpenCode session-header compat. All behavior is configured via `settings.yaml` / the governor config slice; the settings-page UI is a single per-provider RPM row inside the host's Models card.

## Features

- **RPM queueing (never rejects)**: `limits.defaults` → provider default → model override, merged per dimension (RPM / TPM / concurrency). When tokens run out the call waits locally (FIFO) instead of hitting the remote and eating a 429. Waiting never counts toward `maxRetries`; abort cancels the wait. RPM slots live a full 60s from admission (sliding window) while concurrency slots are held until `release` — a finished-fast request still counts toward RPM for its minute.
- **RPM probing (auto-apply when topped)**: per-card `Probe` button fires tiny requests (`maxTokens: 16` by default, tunable 1–200 — some gateways reject `max_completion_tokens: 1` with 400) on an RPS ramp — starting at 2 RPS, +1 every second, capped at 20 RPS with at most 32 in flight (hard cap 50). Send rate is decoupled from RTT, so RPM 60 concludes in ~9s and RPM 300 in ~23s, all inside the default 60s window. Only a topped run (watched a 429: N accepted, N+1 rejected) is auto-written to the provider-level RPM — demonstrated fact, not inference. Untopped / failed / cancelled runs write nothing and keep unlimited. One flight per provider; cancellable anytime.
- **OpenCode session header**: ports `dsh-opencode-session` (nobu121, MIT — see Credits) natively: attaches `x-opencode-session` to OpenCode-provider requests, fixing 400 MissingSessionID and keeping prompt-cache affinity.
- **Outcome hook (reserved)**: every request reports success/failure exactly once to `noteOutcome` — the seam where a future circuit breaker (and per-code handling UI) will plug in. Currently collects signals only, never alters the stream.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-plugin-model-governor
```

Then fully restart the profile (bundle layers are read at startup). Until the first npm release, install from a local checkout instead:

```bash
dsh plugin --profile <your-profile> add ./path/to/dsh-plugin-model-governor
```

## Configure

The plugin row lives in the profile's `cordis.patch.yml` (or the bundle default, which is empty = builtins only). It is the base-default layer: UI `应用` clicks and probe auto-applies land in the `model-governor` section of `settings.yaml`, win over it, and survive restarts. All keys optional:

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

`models` keys are `"provider/model"`. Effective value per dimension = model → provider → defaults (tightest wins at runtime: both the provider bucket and the provider/model bucket must grant a token). Write `null` for a dimension to delete the override and fall back upward (e.g. `{ limits: { providers: { buzz: { rpm: null } } } }`).

## Probe

`probe({ provider, model?, rampStartRps?, rampStepRps?, rampStepMs?, maxRps?, maxInflight?, confirmPauseMs?, confirmCount?, maxRequests?, durationMs?, maxTokens? })` starts a background run and returns immediately; poll `probeStatus({ provider })`, cancel with `cancelProbe({ provider })`. Defaults: `rampStartRps: 2`, `rampStepRps: 1/s`, `maxRps: 20`, `maxInflight: 32` (hard cap 50), `maxRequests: 300`, `durationMs: 60000`, `maxTokens: 16`. Probe traffic bypasses the local limiter (it measures the remote, not itself) and is reported to `noteOutcome` like any other call. Quota exhaustion (`QUOTA`) stops the run and is never written as an RPM.

## GUI

One line per provider card on Settings → Models: `RPM` + number box + `应用` + `探测` — nothing else. The card shell (border, background, radius, padding) belongs to the host's own `<li class="rowCard">`: this half emits a plain content div, uses host primitives (`Input`, `Button` sm = 28px/r14) and `--dsw-*` tokens injected through `<style data-plugin="model-governor">` (index `docs/settings-pages.md` §4.5).

- **Seat facts are consumed**: the slot hands down `{provider, configured, keyConfigured}`. Draft cards (an unsaved "add provider" row) render nothing; a card without a configured credential renders one muted line instead of controls that could only fail.
- **Readout and write share one source**: the box shows `describe({provider}).providerLimits` — the provider bucket's own enforcement value (`providers[route]` → `defaults`), i.e. exactly what `configure({limits:{providers:{[route]:{rpm}}}})` writes. Model-level overrides stay in `models[].limits` and never leak into the row.
- **Draft state is visible**: editing marks the row 未保存 and adds 丢弃 (revert to the server value — never a write); `应用` stays the only write path.
- **Writes are durable**: `应用` and topped-probe auto-apply share one path into the host settings document (`model-governor` section in `settings.yaml`), hot-pushed live and restart-safe. The `cordis.patch.yml` `config` row is the base default (empty = builtins only); the document user layer wins over it. `sessionHeader` has no UI yet and stays file-managed. The seat also self-reports `data-gvr-ui="host|fallback"` so a screenshot or DOM dump shows whether host primitives or the local fallback rendered.
- Clicking `探测` turns that button into a remaining-seconds countdown (click again to cancel — a failed cancel is reported, not swallowed). When a run ends or fails, the button flips back to `探测` and a verdict line follows, carried by `role="status"` / `role="alert"` (a failed read gets 重试). Empty input deletes that card's RPM (falls back up). Other configuration goes through `settings.yaml` (see Configure above).

## Known limits

- Only the Models-card provider row is claimed (hard-wired seat); no other settings surface is touched.
- Queueing only delays — it never rejects, never preempts a running call, and waiting never counts toward `maxRetries`.
- The `settings.yaml` user layer always wins over the `cordis.patch.yml` base row; an empty bundle config = builtins only (unlimited + OpenCode session header on).
- `sessionHeader` stays file-managed (no UI yet); `noteOutcome` only collects signals for a future breaker, never alters the stream.
- Writable rows have no real-device coverage yet: disposable instances carry no credentials, so the seat runs suppressed and the write path plus probing are covered only by the offline harness.
- A production-only layout anomaly (writable row rendered vertically) never reproduced locally; already hardened with explicit direction/alignment/flex plus a fallback pill and `data-gvr-ui` self-report — quote that value if seen again.

## Browser E2E (UI verification)

`pnpm check:browser` boots a disposable instance and drives headless Chrome into Settings → Models, asserting the
seat's form rather than pixels: no duplicated card shell, no inline `style` attributes, CSS arrives through the
injected `<style data-plugin>` channel, and each of the three seat states has its own shape (writable row on host
primitives specs / suppressed card with no controls / failed read with `role="alert"` + 重试). Browser-half changes
must pass it (index `docs/settings-pages.md` §4.5 + index `docs/runbooks/live-verify.md`, dsh-check gate 12).

## Credits

Session-header mechanism ported from [`dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session) by nobu121 (MIT). Thank you.

## License

MIT — see [LICENSE](./LICENSE).
