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

3. **`mi check`**
   - One proactive check-in, not an agent platform.
   - Shape: read state → run checks → dedupe → append message → maybe notify.
   - Default checks are `pendingApprovals`, `failedCrons`, and `dailyBrief`.
   - It creates awareness only: notices, summaries, nudges, and notifications. It never acts.

## Core primitives

Mi core intentionally exposes only five primitives:

- **Assistant**: Markdown instructions plus frontmatter.
- **Trigger**: timer, webhook, manual command, or service event.
- **Tool**: a small function exposed by an integration.
- **Worker**: a short-lived AI process that does one job. The first worker backend is pi.
- **Run**: a durable record of what happened: timestamp, trigger, assistant, tool calls, worker results, approvals, status, and final report.

These primitives live in `src/primitives.ts`. Run records are written to `state/runs/<run-id>.json` and `state/runs.jsonl`. Proactive observations are logged in Mi-owned local state (`state/events.jsonl` and `state/proactive-dedupe.json`). Service-specific behavior belongs in installable tool packages, not the core.

## Routing policy

The current routing classifier returns one of three modes:

- `flue-chat`: greetings, simple conversation, planning, drafting, writing prose, messaging drafts, summarization of user-provided text, and general questions.
- `pi-read-only`: requests that combine an inspection action (`check`, `inspect`, `read`, `search`, `status`, `summarize`, `find`, `list`, `show`) with a local target (`repo`, `service`, `wiki`, `file`, `log`, `process`, `health`, `server`, `app`, `project`).
- `approval-required`: risky actions such as editing, changing, modifying, fixing, deleting, deploying, publishing, merging, committing, pushing, or secret/token/password/API-key handling.

## Safety model

Safety is enforced in `src/safety.ts`, `src/proactive.ts`, and at runner boundaries:

- Assistants are read-only by default.
- Tools or permissions that imply write/deploy/merge/delete/DNS/secret changes require approval.
- `pi.inspect` is read-only.
- `pi.repair` always requires an explicit approval gate before code-changing worker runs.
- Runtime assistants cannot silently rewrite `assistants/*.md`; they may only suggest instruction changes.
- Proactive Mi creates awareness only. It appends observations and may notify, but it does not inspect with pi, start workers, edit files, deploy, merge, delete, change config, or approve anything.
- Builder edits are reviewable file changes.

## Safety boundary

Flue decides and orchestrates. pi inspects and executes under visible constraints. There is no public webhook/control UI in Mi. Pushover is notifications-only and must not carry secrets, public control links, or dangerous action links.
