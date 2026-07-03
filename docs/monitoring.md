# Monitoring

Mi monitor health is registry-driven. The reviewable registry is `assistants/monitors.md`; `mi check health-check` and `mi tick` read that file and persist transition state in `state/monitor-health.json`.

## Registry fields

Each table row in `assistants/monitors.md` describes one watched thing:

- `id` — stable monitor id, for example `tactics:detect`.
- `title` — human-readable name used in notices.
- `type` — currently `health_sidecar` or `mi_crons`.
- `source` — sidecar path or state source.
- `freshness` — max age such as `30h`; `n/a` for non-sidecar monitors.
- `owner_repo` — repo that owns the producer.
- `allowed_auto_actions` — `read_triage` permits a read-only worker; leave blank for notify-only.
- `escalation` — where human-required notices go.

## Health sidecar contract

Jobs can opt into Mi monitoring by writing a JSON file named `<job>-latest-health.json` at the path listed in the registry. The Tactics Journal defaults live under `/home/kyle/code/research/.logs/`.

Required fields:

```json
{
  "version": 1,
  "checked_at": "2026-07-02T00:00:00.000Z",
  "step": "detect",
  "status": "ok",
  "reason": "ok",
  "counts": {}
}
```

Supported `status` values:

- `ok` — healthy.
- `degraded` — completed with a repairable problem.
- `error` — failed; repairability depends on `reason`.
- `human-required` — cannot be safely fixed by Mi.

Optional fields:

- `counts` — small numeric counters, such as `{"items": 12}`.
- `error` — short redacted error summary, not secrets or personal content.
- `log_file` — local path to a log file a read-only triage worker may inspect.
- `exit_code` — process exit code.
- `human_action_required` — `true` forces notify-only behavior.

Known human-required reasons include `railway_auth_failed`, `railway_project_unlinked`, `cloudflare_ai_gateway_billing`, and `cloudflare_ai_gateway_forbidden`.

## Writer helper

Use `writeHealthSidecar()` from `src/monitoring.ts` in Mi-owned jobs:

```ts
import { writeHealthSidecar } from './monitoring.js';

await writeHealthSidecar('/home/kyle/code/research/.logs/detect-latest-health.json', {
  step: 'detect',
  status: 'ok',
  counts: { candidates: 8 },
});
```

The helper creates parent directories, writes `0600`, adds `checked_at`, and normalizes `reason`.

## Escalation ladder

For a non-healthy sidecar, Mi records the transition and then follows this ladder:

1. observe and persist state;
2. start one budgeted `worker-read` triage when `allowed_auto_actions` is `read_triage` and the reason is allowlisted;
3. notify Kyle with the diagnosis;
4. after repeated failed repair attempts, escalate once and store `muted_pending_human` so the monitor stays quiet until it recovers.

Mi never edits files, deploys, merges, changes config, approves anything, or touches secrets from automatic monitor triage.
