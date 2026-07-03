---
name: monitors
triggers:
  - manual: true
  - every: 1m
tools: []
permissions: {}
---
# Mi Monitor Registry

Declarative registry for `mi check health-check` / `mi tick` monitor inputs. Runtime code reads this file for configured monitors; monitor producers own their health sidecars.

| id | title | type | source | freshness | owner_repo | allowed_auto_actions | escalation |
|---|---|---|---|---|---|---|---|
| tactics:ingest | Tactics Journal ingest health | health_sidecar | /home/kyle/code/research/.logs/ingest-latest-health.json | 30h | /home/kyle/code/research | read_triage | Kyle iMessage |
| tactics:detect | Tactics Journal detect health | health_sidecar | /home/kyle/code/research/.logs/detect-latest-health.json | 30h | /home/kyle/code/research | read_triage | Kyle iMessage |
| tactics:report | Tactics Journal report health | health_sidecar | /home/kyle/code/research/.logs/report-latest-health.json | 30h | /home/kyle/code/research | read_triage | Kyle iMessage |
| tactics:report-pr-queue-worker | Tactics Journal report PR queue worker health | health_sidecar | /home/kyle/code/research/.logs/report-pr-queue-worker-latest-health.json | 30h | /home/kyle/code/research | read_triage | Kyle iMessage |
| mi-crons:configured | Mi reminder crons | mi_crons | state/crons.json | n/a | /home/kyle/assistant | read_triage | Kyle iMessage |

Removed until a producer writes their sidecar again (registry rule: a monitor with no live producer is removed, not left permanently stale): `tactics:report-worker` (job renamed to report-pr-queue-worker), `tactics:tune` (last sidecar 2026-06-16), `tactics:storage-prune` (sidecar never created).
