# dsh-plugin-model-governor

DSH model governance plane (server-only, no browser UI): per-model thinking-intensity overrides with builtin readout, provider/model two-level RPM queueing, OpenCode session-header compat, and actionable error translation. All behavior is configured via `settings.yaml` / the governor config slice; there is no settings-page UI.

## Features

- **Thinking-intensity overrides**: each model card shows the builtin档位 (efforts/default, read from the installed catalog) and lets you override per model (`reasoningEfforts` spelling map, non-reasoning flag, route default). Empty override = follow builtin. Mismatched ids surface as repairable issues instead of silent no-ops.
- **RPM queueing (never rejects)**: `limits.defaults` → provider default → model override, merged per dimension (RPM / TPM / concurrency). When tokens run out the call waits locally (FIFO) instead of hitting the remote and eating a 429. Waiting never counts toward `maxRetries`; abort cancels the wait.
- **OpenCode session header**: ports `dsh-opencode-session` (nobu121, MIT — see Credits) natively: attaches `x-opencode-session` to OpenCode-provider requests, fixing 400 MissingSessionID and keeping prompt-cache affinity.
- **Error translation**: `UNKNOWN_MODEL` / `UNSUPPORTED_REASONING_EFFORT` / `RATE_LIMIT` become actionable messages (what id, where to fix). Auto-fallback to another model is deliberately out of scope (single-route rule).

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

`models` keys are `"provider/model"`. Effective value per dimension = model → provider → defaults (tightest wins at runtime: both the provider bucket and the provider/model bucket must grant a token).

## GUI

None — this package ships no browser half. Configure via `settings.yaml` (see Configure above).

## Credits

Session-header mechanism ported from [`dsh-opencode-session`](https://github.com/nobu121/dsh-opencode-session) by nobu121 (MIT). Thank you.

## License

MIT — see [LICENSE](./LICENSE).
