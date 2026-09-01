# Mi

Mi is a small local assistant harness. Assistants are Markdown instructions plus triggers, tools, permissions, and workers.

## Main parts

1. **Assistant Builder** creates or edits reviewable files under `assistants/`.
2. **Assistant Runner** reads an assistant file and runs it when asked.
3. **Mi chat** keeps the main local conversation.
4. **Mi agents** shows background Pi work and known Pi sessions.
5. **Mi tick** runs explicit reminders, memory upkeep, capability-file cleanup, and iMessage repair checks.

Runtime assistants do not silently rewrite their own rules.

## Safety

- Read access is the default for scoped workers.
- A write worker is limited to its approved workspace.
- Deploying, publishing, merging, deleting data, changing secrets, spending money, and sending outside messages need a clear approval path.
- The iMessage runtime loads only the reviewed Mi capability guard, adapter, and Divernote extension. It disables normal extension, skill, theme, prompt-template, and context-file discovery.
- Divernote access needs both Photon verification and a named `PHOTON_ALLOWED_USERS` sender. It is denied for every other sender, and remains constrained by the per-turn capability grant and audit log.
- Direct advisor work loads only the reviewed advisor skill and gives it read access.
- Mi has no public control webhook by default.

## Commands

The main commands are:

```bash
mi                 # open Mi
mi agents          # open the background-agent view
mi tick            # run scheduled Mi upkeep once
mi approvals       # list pending approvals
mi task list        # list background tasks
```

`mi check <assistant>` validates one assistant Markdown file. It is not a proactive check-in command.

Explicit reminder examples:

```bash
mi cron add daily-note --every 1d --message "Review today's note"
mi cron add one-time --at 2030-01-02T15:00:00Z --message "Appointment"
mi cron list
mi cron check
mi cron remove daily-note
```

Prompt crons can use `--prompt` and `--thread`. Command crons are still parsed for old data but are deprecated.

The removed proactive check-in, monitor registry runner, daily brief, and automatic project-question and project-summary loops are not part of `mi tick`.

## Mi agents

`mi agents` shows `needs input`, `working`, and `completed` sections. Important commands are:

- `/new <prompt>` starts a task.
- Normal text replies to the selected task.
- `/resume` adds a known Pi session to the view.
- `/open` opens the selected session in Pi.
- `/model` chooses a model for new work.
- `^F` shows full output. Arrow keys switch tasks, while PageUp/PageDown scroll a cached terminal-sized output view so replies stay responsive for large sessions.
- `^M` selects tasks to clear.
- `/mi <question>` asks Mi about the selected task without steering it.

Mi reads Pi sessions from `~/.pi/agent/sessions`. It stores its daemon runtime under `~/.pi/agent/mi` and its task view under `~/mi/state` by default.

## Tick and notifications

`mi tick` runs due reminder crons, removes expired capability grants, runs memory consolidation when due, and calls the iMessage repair monitor. Its lock is `state/tick.lock` under `MI_ROOT`.

The stack timer runs every minute. The iMessage monitor has its own interval and defaults to 15 minutes. The monitor may restart only the Photon bridge. The system bridge restart needs the narrow sudoers rule from `scripts/install-mi-imessage-repair-sudoers-root.sh`.

The Photon bridge offers a loopback-only notification endpoint. Tick can use it when `MI_PROACTIVE_IMESSAGE_NOTIFY=true`. Pushover remains opt-in.

A Divernote work notification names its exact Pi session. A reply to that notification may use the scoped `pi.message` Divernote operation to continue only that session. The canonical Divernote CLI verifies the session against the private vault before it sends the user's text.

## Local state

Default locations are split by purpose:

- `~/assistant/state` or `$MI_ROOT/state`: threads, events, approvals, memory, tick lock, web data, and iMessage monitor records.
- `~/mi/state`: reminder crons, cron logs, task rows, and dismissed task rows.
- `~/.pi/agent/mi`: daemon socket, daemon log, short-lived capability grants, and coordinator policy files.
- `$MI_ROOT/state/imessage/conversations`: private per-conversation Pi sessions and delivery records.
- `~/.pi/agent/sessions`: general Pi sessions.
- `~/mi/memory.md` and `~/mi/preferences.md`: the small user-facing memory and preference files used by chat.

These paths contain private data. Do not copy them when making a clean second instance.

## Installation

The complete stack installer adds the production gateway registry, brokered gateway helper, Mi daemon, tick timer, Photon bridge, and generated home entrypoints. It does not install Web chat in the normal stack. Install Web chat separately with `MI_WEB_MAINTENANCE=1` for explicit maintenance. See [the stack guide](mi-stack.md). For a clean second VPS and a different phone number, use [the second VPS guide](second-vps-setup.md).
