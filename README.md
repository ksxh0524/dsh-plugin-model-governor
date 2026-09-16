# dsh-plugin-model-governor

DSH model governance plane: one RPM line per provider card (never rejects, only delays), RPM probing with auto-apply, plus OpenCode session-header compat. All behavior is configured via `settings.yaml` / the governor config slice; the settings-page UI is the per-card RPM row and probe row.

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

Two lines per provider card on Settings → Models: the RPM row (`RPM 上限` + number box + `应用` + `清除`) and the probe row (`探测` + progress/cancel + one-line verdict); nothing else — no titles, badges, or footer panels. Empty input = unlimited. Configure via `settings.yaml` (see Configure above).

## Credits

Session-header mechanism ported from [`dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session) by nobu121 (MIT). Thank you.

## License

MIT — see [LICENSE](./LICENSE).
