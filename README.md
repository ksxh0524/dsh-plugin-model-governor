# dsh-plugin-model-governor

DSH model governance plane: one RPM line per provider card (never rejects, only delays), RPM probing with auto-apply, plus OpenCode session-header compat. All behavior is configured via `settings.yaml` / the governor config slice; the settings-page UI is a single per-provider RPM row inside the host's Models card.

## Features

- **RPM queueing (never rejects)**: `limits.defaults` → provider default → model override, merged per dimension (RPM / TPM / concurrency). When tokens run out the call waits locally (FIFO) instead of hitting the remote and eating a 429. Waiting never counts toward `maxRetries`; abort cancels the wait.
- **RPM probing (auto-apply when topped)**: per-card `Probe` button fires tiny requests (`maxTokens: 16` by default, tunable 1–200 — some gateways reject `max_completion_tokens: 1` with 400) in two phases — sequential single-flight first (small limits conclude in seconds without ever touching concurrency walls), then doubling parallel bursts (large quotas approached via cumulative successes). Only a topped run (watched a 429: N accepted, N+1 rejected) is auto-written to the provider-level RPM — demonstrated fact, not inference. Untopped / failed / cancelled runs write nothing and keep unlimited. One flight per provider; cancellable anytime.
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

The plugin row lives in the profile's `cordis.patch.yml` (or the bundle default, which is empty = builtins only). All keys optional:

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

`probe({ provider, model?, phaseA?, bursts?, confirmPauseMs?, confirmCount?, staggerMs?, maxRequests?, durationMs?, maxTokens? })` starts a background run and returns immediately; poll `probeStatus({ provider })`, cancel with `cancelProbe({ provider })`. Defaults: `phaseA: 15`, `bursts: [8, 16, 32]`, `maxRequests: 150`, `durationMs: 120000`, `maxTokens: 16`. Probe traffic bypasses the local limiter (it measures the remote, not itself) and is reported to `noteOutcome` like any other call. Quota exhaustion (`QUOTA`) stops the run and is never written as an RPM.

## GUI

One line per provider card on Settings → Models: `RPM` + number box + `应用` + `探测` — nothing else. The card shell (border, background, radius, padding) belongs to the host's own `<li class="rowCard">`: this half emits a plain content div, uses host primitives (`Input`, `Button` sm = 28px/r14) and `--dsw-*` tokens injected through `<style data-plugin="model-governor">` (STANDARDS §4.5).

- **Seat facts are consumed**: the slot hands down `{provider, configured, keyConfigured}`. Draft cards (an unsaved "add provider" row) render nothing; a card without a configured credential renders one muted line instead of controls that could only fail.
- **Readout and write share one source**: the box shows `describe({provider}).providerLimits` — the provider bucket's own enforcement value (`providers[route]` → `defaults`), i.e. exactly what `configure({limits:{providers:{[route]:{rpm}}}})` writes. Model-level overrides stay in `models[].limits` and never leak into the row.
- **Draft state is visible**: editing marks the row 未保存 and adds 丢弃 (revert to the server value — never a write); `应用` stays the only write path.
- **Runtime scope, stated in the row itself in plain words**: RPM edits apply to this run's live config only ("只在本次运行有效，重启 host 后恢复原值"); a restart reverts to the configured value. The row says so permanently, since otherwise it looks like a persisted setting. The seat also self-reports `data-gvr-ui="host|fallback"` so a screenshot or DOM dump shows whether host primitives or the local fallback rendered.
- Clicking `探测` turns that button into a remaining-seconds countdown (click again to cancel — a failed cancel is reported, not swallowed). When a run ends or fails, the button flips back to `探测` and a verdict line follows, carried by `role="status"` / `role="alert"` (a failed read gets 重试). Empty input = unlimited. Other configuration goes through `settings.yaml` (see Configure above).

## Browser E2E (UI verification)

`pnpm check:browser` boots a disposable instance and drives headless Chrome into Settings → Models, asserting the
seat's form rather than pixels: no duplicated card shell, no inline `style` attributes, CSS arrives through the
injected `<style data-plugin>` channel, and each of the three seat states has its own shape (writable row on host
primitives specs / suppressed card with no controls / failed read with `role="alert"` + 重试). Browser-half changes
must pass it (STANDARDS §4.5 + §5, dsh-check gate 12).

## Credits

Session-header mechanism ported from [`dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session) by nobu121 (MIT). Thank you.

## License

MIT — see [LICENSE](./LICENSE).
