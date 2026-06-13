# Mi

Mi is a tiny local assistant harness for running small AI workers from plain files.

Product definition:

```text
assistant = instructions + trigger + tools + permissions
```

Mi is not a DevOps platform, workflow builder, or repair bot. Its minimal proactive mode only notices, summarizes, and nudges:

- pi starts when you ask.
- Mi can check local signals and tell you what it noticed.
- Proactive Mi does not act on its own.

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

## User-facing commands

Keep the public Mi surface small:

```bash
mi          # open Mi chat
mi agents   # open the live background-agent view
mi check    # check local Mi state and report observations
```

From this repo before install, use `npm run mi --`, `npm run mi -- agents`, and `npm run mi -- check`.

Other lower-level/debug commands may exist in the CLI, but docs and user flows should point to `mi` for chat and `mi agents` for background work.

## mi agents live view

`mi agents` is the live terminal view for background workers and discovered pi sessions. It uses pi-tui's differential renderer in the alternate screen so stale scrollback rows cannot look like duplicate tasks, resets stale mouse tracking so tmux wheel behavior recovers after exit, dedupes rows by task/session identity, parses pi session UUIDs from session filenames, and persists visible tasks until the user clears them.

Key behavior:

- Normal typed text replies to the selected task. New tasks are explicit via `/new <prompt>`.
- `/goal ...` is treated as task prompt text, not as a local mi agents slash command.
- `/resume` opens a picker for recent/default pi sessions; selected sessions are persisted into the Mi task list.
- `/model` opens a pi-style model picker for new tasks and replies; Shift+Tab cycles thinking level.
- `^F` opens full-output mode for the selected task. Arrow keys and PageUp/PageDown scroll the output; `^F` exits it.
- `^M` toggles multi-select clear mode. Enter/Space toggles a row; Esc clears selected rows.
- `/mi <question>` asks Mi main about the selected task context and stays in that side-chat until Ctrl-C.

Daemon behavior:

- Discovered/open pi sessions are merged with stored tasks and remain visible until cleared.
- Stale busy session state does not overwrite a terminal stored task result when no live Mi worker exists.
- Dismissed task/session keys are persisted.
- Known noisy project-specific pi sessions can be excluded through code/configuration when needed.

## Public-control safety

Mi does not expose a public webhook/control UI by default. Persistent Flue orchestration binds to loopback. Notification integrations are outbound-only and must not carry secrets, public control links, or dangerous action links.
