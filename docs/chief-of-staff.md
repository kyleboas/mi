# Mi chief-of-staff state

Mi provides a local chief-of-staff layer without calendar or email integration.

## State and schema

The canonical database is `state/chief-of-staff.sqlite` under `MI_ROOT`. Override it with `MI_CHIEF_OF_STAFF_DB` for isolated tests or recovery. Runtime state is ignored by Git and created with local-only permissions.

The SQLite store uses WAL, foreign keys, a five-second busy timeout, transactional writes, and `PRAGMA user_version` migrations. It records:

- people and explicit relationship context;
- project references;
- commitments with clarification/proposed/active/blocked/completed/cancelled status, owner, due/review time, confidence, source key, exact bounded excerpt, and completion evidence;
- typed actions with approval policy, idempotency key, attempts, result/error, external reference, and proposed/approved/executing/verification-required/completed/failed/cancelled lifecycle;
- provenance-backed durable facts with supersession history;
- relationship follow-ups, durable delivery dedupe, ingestion cursors, and append-only database audit history.

Every inferred record has a stable source key. Thread ingestion advances a durable timestamp/message-ID cursor, while artifact and daemon-task ingestion skip unchanged content digests; source-key idempotency remains defense in depth after restart or compaction. Lifecycle changes are written to database history and mirrored to `state/events.jsonl` through Mi's redacting event logger.

## Ingestion

`mi chief ingest` and `mi tick` inspect only Mi-owned trusted local inputs:

- user-role records in durable Mi threads;
- unchecked entries in selected local Mi plan/task Markdown files;
- Mi daemon and web-worker task state for reconciliation.

Set `MI_CHIEF_OF_STAFF_ARTIFACTS` to a colon-separated artifact allowlist. Calendar and email are not read. Assistant-role messages are never converted to Kyle commitments. Explicit first-person commitments become active; clear requests become proposed Mi commitments; `maybe`, `should`, and ambiguous `we` language becomes `needs_clarification`. Extraction intentionally favors false negatives. Sensitive relationship attributes are not inferred, and relationship records require explicit user-provided wording.

Compaction cannot duplicate records because message IDs are provenance keys. Dream consolidation resets an impossible legacy numeric cursor if thread compaction shrinks a thread, preventing future messages from being skipped.

## Execution policy

Dispatch policy is enforced in `ChiefOfStaffStore.dispatchAction`, not in a prompt. That is the exact enforcement boundary: only actions actually routed through this typed dispatcher receive this store's hard gate. Existing Mi main-agent, daemon, worker, cron, and other legacy execution call sites continue to rely on their existing policy and capability checks until each is deliberately routed through the store. Reconciliation records legacy daemon state but does not intercept, approve, or retroactively mediate the daemon's execution. Mi must not claim system-wide enforcement from the presence of a linked record.

- Internal organization, reminders, and private updates may auto-approve and run through named handlers.
- External communication, destructive changes, financial actions, publication, and infrastructure require approval.
- Approval is consumed when the actual handler enters `executing`.
- Unknown action kinds cannot execute. Approval alone does not make them executable, and Mi has no generic shell handler.
- Messages to Kyle are notifications and may be automatic. Messages to any other person are external actions.
- Completion requires evidence; daemon-reported completion enters `verification_required` until reconciled.

`mi actions approve <id> --confirm` records explicit approval. `mi actions run <id>` still rechecks policy at dispatch. A reported result can be closed with `mi actions verify <id> --evidence "..." --confirm`, which also completes its linked commitment. Cancellation and commitment completion require `--confirm`; completion also requires `--evidence`.

## Reviews and correction

The morning brief prioritizes open commitments, decisions, and delegated work. Tick also detects overdue, blocked, stalled, clarification, failed, approval, verification, and relationship follow-up states. Dedupe is stored in SQLite, with resurfacing intervals based on state. An evening reconciliation and period-filtered weekly review are delivered to the main thread and normal Kyle notification path. `MI_TICK_DRY_RUN=true` renders without recording delivery or sending notifications.

Dedicated follow-ups are written as plain conversational iMessages. One item has no heading or bullet and ends with a concrete question. Multiple independent items use a natural opener and separate short paragraphs without exposing IDs, risk classes, daemon/worker terms, or lifecycle labels. The formatter uses commitment detail or the fuller provenance excerpt when an older title already ends in an ellipsis. New long inferred commitments keep a concise title plus bounded full detail/source context. Messages over the transport bound are divided into explicit “part X of Y” messages; a harder context bound points back to the original conversation instead of silently truncating.

Correct inferred state with:

```text
mi commitments update <id> --title "..." --status active --due <ISO>
mi commitments cancel <id> --confirm
mi clarifications resolve <id> --title "..."
mi people update <id-or-name> --relationship "..." --notes "..."
```

The original provenance, audit transitions, and source key remain available after correction.

## Memory compatibility

`state/memory/MEMORY.md` is the canonical human-readable memory. Dream history remains in `state/memory/history.jsonl`, with the existing private Git history under `state/memory/.git`. A one-time migration imports legacy `~/mi/memory.md` and writes `.legacy-imported`; it never deletes or rewrites the legacy file. Explicit iMessage memory writes now target the canonical surface. Structured active commitments, facts, and people are included in bounded, redacted Flue/worker context; the pi extension and iMessage use bounded canonical Markdown context.

## Export, backup, and recovery

```text
mi chief export [directory]
mi chief backup [destination.sqlite]
```

Export writes redacted, mode-0600 JSON and Markdown. Backup uses Node's SQLite online backup API and atomic rename, so WAL state is included safely. The default backup directory is `state/backups/`; default exports are under `state/exports/`. Keep those runtime directories out of Git.

Recovery steps:

1. Stop only the Mi tick/service that writes this database; do not stop unrelated protected jobs.
2. Preserve the damaged database and its `-wal`/`-shm` companions.
3. Copy a verified backup into the configured database path while Mi is stopped.
4. Run `mi chief status`, `mi chief export`, then `mi chief ingest`.
5. Restart Mi through its normal managed service procedure.

A stale tick lock is recovered only when its recorded owner is not alive and its age exceeds `MI_TICK_LOCK_STALE_MS` (30 minutes by default). A live lock owner is never displaced.

## Limitations

Mi does not integrate with calendar or email, infer sensitive personal attributes, execute arbitrary shell commands, verify every external result automatically, or send unapproved messages to other people. Artifact extraction supports conservative unchecked Markdown tasks rather than arbitrary natural-language plans. Existing daemon work is reconciled from available task state; incomplete or ambiguous outcomes remain blocked or verification-required.
