# Mi

Mi is a tiny private assistant harness for running small AI workers from plain files.

Product definition:

```text
assistant = instructions + trigger + tools + permissions
```

Mi is not a DevOps platform, workflow builder, or repair bot. It is the event-started companion to pi:

- pi starts when you ask.
- Mi starts when something happens.

## Product layers

Mi is split into two layers:

1. **Assistant Builder** — creates, edits, and explains `assistants/*.md` files from user requests.
2. **Assistant Runner** — reads those files and executes short-lived runs when a trigger fires.

Builder changes are reviewable file changes. Runtime assistants should suggest instruction changes, not silently rewrite themselves.

## Safety model

- Assistants are read-only by default.
- Risky tools or permissions require approvals.
- Runtime assistants cannot silently rewrite their own `assistants/*.md` files.
- Builder edits are reviewable file changes.
- `pi.repair` is code-changing and must stay behind an approval gate.

## Core primitives

Mi core intentionally exposes only five primitives:

1. **Assistant** — a Markdown file that defines purpose, triggers, tools, permissions, and rules.
2. **Trigger** — something that starts an assistant run: timer, webhook, manual command, or service event.
3. **Tool** — a boring function exposed to assistants, such as reading status or opening a PR.
4. **Worker** — a short-lived AI process that does one job. pi is the coding/execution worker backend: Mi decides when and why work starts; pi handles repo inspection, repair, branches, tests, and PR preparation.
5. **Run** — a durable record of what happened: timestamp, trigger, assistant, tool calls, worker results, approvals, status, and final report.

Service-specific behavior belongs in installable tool packages, not the core.

## Assistant files

Assistants live in `assistants/*.md` and use Markdown with frontmatter. See `assistant-format.md` for the full v0 format:

```md
---
name: production
triggers:
  - every: 10m
tools:
  - github
  - railway
  - cloudflare
  - pi
permissions:
  github:
    actions: read
    contents: write
    pull_requests: write
  production:
    deploy: false
    mutate_dns: false
    edit_secrets: false
    merge_code: false
---
# Production Assistant
Watch production health.
When something breaks, collect the smallest useful context, start one worker if appropriate, and report back.
Never merge, deploy, edit secrets, or change DNS.
```

## V0 commands

```bash
mi make "<assistant description>"
mi run <assistant>
mi edit <assistant> "<change>"
mi check <assistant>
mi logs <assistant>
```

From this repo before install, use `npm run mi -- ...`.

Mi chat UI slash commands are reserved for useful in-context actions. `/inbox` is intentionally hidden there because Mi already opens on the durable main inbox and temporary threads are legacy/troubleshooting state; use `/tasks` for actionable background worker status or `mi inbox`/`mi threads` from a shell when inspecting thread files.

## Background pi workers

Mi can launch and continue separate pi conversations as background workers:

```bash
mi agents
mi task <name> [--cwd <path>] -- <task prompt>
mi task reply <task-id-or-name> -- <follow-up prompt>
mi task list
```

`mi task` runs pi in RPC mode from the requested cwd and stores worker sessions in the default pi session store (`~/.pi/agent/sessions`) so they remain visible in normal pi `/resume`. Prompts and follow-ups are sent as written by default. Use an explicit `/goal ...` prompt only when you want pi standing-goal behavior.

For Mi background tasks, `mi task reply <task-id-or-name> -- <message>` uses the same steering semantics as pi's normal queued messages while a task is active: Mi queues the message into the active RPC worker with `streamingBehavior: "steer"`. This lets the current worker incorporate the queued steer instead of creating another worker on the same task. If no active worker is tracked, Mi falls back to resuming the saved task session.

## mi-agents live view

`mi agents` is the live terminal view for background workers and discovered pi sessions. It uses pi-tui's differential renderer without the alternate screen, so it avoids flicker while preserving tmux scrollback. The view dedupes rows by task/session identity, parses pi session UUIDs from session filenames, and persists visible tasks until Kyle clears them.

Key behavior:

- Normal typed text replies to the selected task. New tasks are explicit via `/new <prompt>`.
- `/goal ...` is treated as task prompt text, not as a local mi-agents slash command.
- `/resume` opens a picker for recent/default pi sessions; selected sessions are persisted into the Mi task list.
- `/model` opens a pi-style model picker for new tasks and replies; Shift+Tab cycles thinking level.
- `^L` opens full-output mode for the selected task. Arrow keys and PageUp/PageDown scroll the output; `^L` exits it.
- `m` toggles multi-select clear mode. Enter/Space toggles a row; Esc clears selected rows.
- `/mi <question>` asks Mi main about the selected task context and stays in that side-chat until Ctrl-C.
- `/upload` creates a short-lived image upload link.

Daemon behavior:

- Discovered/open pi sessions are merged with stored tasks and remain visible until cleared.
- Stale busy session state does not overwrite a terminal stored task result when no live Mi worker exists.
- Dismissed task/session keys are persisted.
- Known noisy tacticsjournal research-pipeline pi sessions are excluded from the list.

## Role of Tailscale

The Mi web UI remains private and Tailnet-only. Tailscale is the only remote control surface; there is no public webhook/control UI. Persistent Flue orchestration binds to loopback and is reached through Mi, not directly. Pushover is only for safe notifications, not a control plane.
