# Mi

Mi is a small local assistant interface built around three surfaces only:

1. `mi` — the main Mi conversation.
2. `mi agents` — the live background-agent view.
3. the Mi pi extension — side-channel Mi commands inside pi.

Everything else in this repo exists to support those surfaces.

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
- `^L` toggles full-output mode; arrows/PageUp/PageDown scroll that output.
- `^M` toggles multi-select clear mode; Esc clears selected rows or exits input modes.
- `/mi <question>` asks Mi main about the selected task context without steering the worker.

Mi discovers pi sessions from the default pi session store (`~/.pi/agent/sessions`), reconciles stale running rows after daemon restarts, and persists the merged `mi agents` view so tasks do not disappear unless cleared.

## Mi pi extension

A global pi extension is installed at `~/.pi/agent/extensions/mi.ts`.

Inside pi, the Mi extension exposes a single slash command: `/mi`.

```bash
/mi             # open the Mi side-channel thread
/mi <message>   # send a side-channel message to Mi main without sending it to the current pi agent turn
/mi read        # show unread or recent Mi messages
/mi inbox       # show Mi threads
/mi bring-in    # explicitly inject recent Mi context into the current pi conversation
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
