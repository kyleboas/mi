# Mi Architecture

Mi is a tiny private assistant harness where assistants are Markdown files plus triggers, tools, permissions, and workers.

## Product layers

Mi has two product layers:

1. **Assistant Builder**
   - Creates, edits, and explains `assistants/*.md` files.
   - Turns a user description into reviewable Markdown assistant instructions.
   - May propose edits when asked.
   - Does not run incidents or silently rewrite a runtime assistant's own rules.

2. **Assistant Runner**
   - Reads `assistants/*.md` files.
   - Executes short-lived runs from manual, timer, webhook, or event triggers.
   - Uses tools and workers according to the assistant file and permission policy.
   - Records what happened for each run.

## Runtime components

The current private implementation uses these runtime components under the two product layers:

1. **Flue**
   - Persistent chat and orchestration layer.
   - Runs as a long-lived local orchestrator on loopback (`127.0.0.1:3583` by default).
   - Runs locally and is not exposed as a public webhook/control UI.
   - Owns scheduled or event-driven assistant behavior such as daily briefs, reminders, and health-watch prompts.
   - Can spawn temporary Flue agents for short background jobs, checks, summaries, and worker tasks.
   - Should not directly perform risky local mutations from chat.

2. **pi**
   - Inspectable local execution cockpit and coding/execution worker backend.
   - Mi decides when and why work starts; pi handles repo inspection, code repair, branch/test work, and PR preparation.
   - Used when a request needs local context or tools: files, repos, wiki, service status, logs, or machine inspection.
   - `pi.inspect` is read-only and constrained to safe read/search tools.
   - `pi.repair` is defined as the code-changing worker but disabled by default; it requires approval before enabling.

3. **`mi check` / `mi tick`**
   - One proactive check-in and one scheduled entrypoint, not a generic agent platform.
   - Shape: read state → run checks → dedupe → append message → optionally start a bounded delegated/read-only worker → maybe notify.
   - Default checks are `pendingApprovals`, `failedCrons`, and `dailyBrief`.
   - Registry-only checks include configured monitor health and dynamic project questions.
   - It may act without asking only when a standing delegation in `assistants/delegations.md` permits the action; otherwise it observes, asks, or reports.

## Core primitives

Mi core intentionally exposes these primitives:

- **Assistant**: Markdown instructions plus frontmatter.
- **Trigger**: timer, webhook, manual command, or service event.
- **Tool**: a small function exposed by an integration.
- **Worker**: a short-lived AI process that does one job. The first worker backend is pi.
- **Principal**: the human or trigger source whose authority backs a run.
- **Capability**: a bounded grant to a resource such as `file://...`, `https://...`, or `secret://...` with rights like `read`, `write`, `execute`, `fetch`, or `exchange`.
- **Run**: a durable record of what happened: timestamp, trigger, assistant, principal, capability grants/audit, tool calls, worker results, approvals, status, and final report.

These primitives live in `src/primitives.ts`. Run records are written to `state/runs/<run-id>.json` and `state/runs.jsonl`. Proactive observations are logged in Mi-owned local state (`state/events.jsonl` and `state/proactive-dedupe.json`). Service-specific behavior belongs in installable tool packages, not the core.

## Routing policy

The current routing classifier returns one of four modes:

- `flue-chat`: greetings, simple conversation, planning, drafting, writing prose, messaging drafts, summarization of user-provided text, and general questions.
- `pi-read-only`: requests that combine an inspection action (`check`, `inspect`, `read`, `search`, `status`, `summarize`, `find`, `list`, `show`) with a local target (`repo`, `service`, `wiki`, `file`, `log`, `process`, `health`, `server`, `app`, `project`).
- `delegated`: reversible/scoped actions that match `assistants/delegations.md`, such as Mi-owned service restarts, scoped repair workers that only prepare branches/PRs, or Kyle-only reports.
- `approval-required`: always-ask or risky actions such as merging, deploying, publishing, deleting non-Mi data, DNS, secrets, spending money, messaging anyone other than Kyle, or editing Tactics Journal posts.

## Safety model

Safety is enforced in `src/safety.ts`, `src/capabilities.ts`, `src/proactive.ts`, the Pi capability guard, and runner boundaries:

- Assistants are read-only by default.
- Tools or permissions that imply write/deploy/merge/delete/DNS/secret changes require approval.
- Scoped Pi workers run with explicit tool lists and a reduced environment; they do not inherit the daemon's full `process.env`.
- Raw host `bash` is denied by default for scoped workers. Bash requires an explicit execute capability or a stronger sandbox in a later phase.
- `pi.inspect` is read-only.
- `pi.repair` always requires an explicit approval gate before code-changing worker runs; approvals mint bounded capability grants rather than broad permission.
- Runtime assistants cannot silently rewrite `assistants/*.md`; they may only suggest instruction changes.
- Proactive Mi uses a three-tier model: read-only inspection, delegated act-then-report, and approval-required.
- Delegated actions must match `assistants/delegations.md`, consume a bounded budget, verify their result, and write/report what happened.
- Always-ask actions include merge, deploy, publish, delete non-Mi data, DNS, secrets, spending money, messaging anyone other than Kyle, and edits under Tactics Journal `_posts/`.
- Builder edits are reviewable file changes.

## Safety boundary

Flue decides and orchestrates for no-host or virtual-sandbox work. Until Flue has scoped host mounts and child-task tool attenuation, Mi does not use Flue `local()` as a host security boundary. pi inspects and executes under visible constraints projected by Mi: explicit tools, reduced env, and `pi/extensions/mi-capability-guard.ts` loaded with `--no-extensions --extension <guard>`. There is no public webhook/control UI in Mi. Pushover is notifications-only and must not carry secrets, public control links, or dangerous action links.
