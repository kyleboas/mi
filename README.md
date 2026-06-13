# Mi

Mi is a small local assistant interface built around four surfaces only:

1. `mi` — the main Mi conversation.
2. `mi agents` — the live background-agent view.
3. `mi check` — one minimal proactive check-in.
4. the Mi pi extension — side-channel Mi commands inside pi.

Everything else in this repo exists to support those surfaces.

## Install from Git

Requires Node.js and npm. Install Mi directly from the GitHub repo:

```bash
npm install -g git+https://github.com/kyleboas/mi.git
```

Then run:

```bash
mi
```

To update, reinstall from the same Git URL:

```bash
npm install -g git+https://github.com/kyleboas/mi.git
```

## `mi`

`mi` opens the main Mi conversation in pi. The durable Mi thread is stored locally in `state/threads/main.jsonl`, so background jobs can append messages while no terminal is open and the next `mi` run can show them through the pi extension.

```bash
mi
```

From this repo before install:

```bash
npm run mi --
```

## `mi agents`

![](/assets/mi_agents.jpeg)

`mi agents` opens the live background-agent view.

```bash
mi agents
```

From this repo before install:

```bash
npm run mi -- agents
```

Useful in-view commands:

- `/new <prompt>` starts a new background task from the view.
- Enter on normal text replies to the selected task; `/goal ...` is forwarded as task prompt text.
- `/resume` opens a picker for recent/default pi sessions so they can be added to the task list.
- `/open` opens the selected background agent in pi.
- `/model` opens a pi-style model picker; Shift+Tab cycles thinking level.
- `^F` toggles full-output mode; arrows/PageUp/PageDown scroll that output.
- `^M` toggles multi-select clear mode; Esc clears selected rows or exits input modes.
- `/mi <question>` asks Mi main about the selected task context without steering the worker.

Mi discovers pi sessions from the default pi session store (`~/.pi/agent/sessions`), reconciles stale running rows after daemon restarts, and persists the merged `mi agents` view so tasks do not disappear unless cleared.

## `mi check`

`mi check` is the minimal proactive loop. It reads local Mi state, runs a small fixed set of checks, dedupes repeated observations, appends one useful message to the main Mi thread, and optionally sends a notification.

Shape: read state → run checks → dedupe → append message → maybe start repair worker for errors → maybe notify.

Default checks:

- `pendingApprovals`
- `failedCrons`
- `dailyBrief`

Non-error proactive messages do not take action and end with `No action taken.` Error notices, such as failed crons or crashed checks, report the error in the main thread and automatically request a background repair worker. The proactive loop itself still does not edit files, deploy, merge, delete, change config, or approve anything.

```bash
mi check
```

## Mi pi extension

A global pi extension is installed at `~/.pi/agent/extensions/mi.ts`.

Inside pi, the Mi extension exposes a single slash command: `/mi`.

```bash
/mi             # open the Mi side-channel thread
/mi <message>   # send a side-channel message to Mi
```

`/mi <message>` is intentionally minimal: it appends to `state/threads/main.jsonl` and shows a confirmation. It does not steer, interrupt, or add context to the active pi conversation. Bare `mi ...` input is not registered by the extension; use `/mi` instead.

## Development

```bash
npm install
npm run build
npm test
```

Security check:

```bash
npm audit --omit=dev
```
