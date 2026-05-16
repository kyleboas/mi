# Mi

Mi is a tiny private assistant harness for running small AI workers from plain files.

```text
assistant = instructions + trigger + tools + permissions
```

Mi is the event-started companion to pi:

- pi starts when you ask.
- Mi starts when something happens.

The current implementation is a private iPhone-friendly scaffold for Mi:

- Web chat/approvals: local web app, intended for Tailscale-only access.
- Push: Pushover alert helper.
- Chat/orchestration: Flue is the persistent conversation and proactive/headless layer, bound to loopback and reached only through Mi's Tailnet-only web app.
- Execution: pi is the inspectable coding/execution worker backend for repo inspection, repair, branches, tests, and PR preparation.
- Safety: risky actions are routed to approvals before execution.

See `docs/mi.md` for the product concept and `docs/architecture.md` for the Flue/pi role split.

## Product layers

Mi core has five primitives only: Assistant, Trigger, Tool, Worker, and Run.

Mi is split into two layers:

1. **Assistant Builder**: creates, edits, and explains `assistants/*.md` files from user requests.
2. **Assistant Runner**: reads those files and executes short-lived runs when a trigger fires.

The Builder proposes reviewable file changes. The Runner executes existing assistant files; it must not silently rewrite its own runtime instructions.

Safety model:
- assistants are read-only by default
- risky tools/permissions require approvals
- runtime assistants cannot silently rewrite `assistants/*.md`
- builder edits are reviewable file changes

## Assistant files

The Mi interface is Markdown assistants in `assistants/*.md` with frontmatter for triggers, tools, and permissions. See `docs/assistant-format.md` for the full v0 format.

First demo assistant:
- `assistants/production.md` watches GitHub Actions, Railway deployments/logs, Cloudflare status, and app health; it reports all-clear or starts at most one pi repair worker for likely code issues, behind approval gates.

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
  production:
    deploy: false
    mutate_dns: false
    edit_secrets: false
    merge_code: false
---
# Production Assistant
Watch production health.
When something breaks, collect context, start one worker if appropriate, and report back.
```

## CLI

`mi` opens the main Mi conversation in pi. The durable Mi thread is stored locally in `state/threads/main.jsonl`, so background jobs can append messages while no terminal is open and the next `mi` run can show them through the pi extension.

Conversation commands:

```bash
npm run mi --                         # open Mi main in pi
npm run mi -- raw                     # open the minimal fallback conversation
npm run mi -- --once "message"        # send one message to main and exit
npm run mi -- inbox                   # troubleshooting: show main + legacy temporary conversations
npm run mi -- temp "React RSC review" # create/open a focused temporary conversation
npm run mi -- chat temp-react-rsc-review # reopen an existing temporary conversation
npm run mi -- compact main            # summarize/archive old read messages
```

Assistant file commands:

```bash
npm run mi -- make "Create an inbox assistant" --name inbox
npm run mi -- run inbox
npm run mi -- edit inbox "Also ignore newsletters"
npm run mi -- check inbox
npm run mi -- logs inbox
```

When installed as a package, the binary is `mi`:

```bash
mi
mi raw
mi --once "message"
mi inbox                              # troubleshooting: show main + legacy temporary conversations
mi temp "React RSC review"
mi chat temp-react-rsc-review
mi compact main
mi make "Create an inbox assistant" --name inbox
mi run inbox
mi edit inbox "Also ignore newsletters"
mi check inbox
mi logs inbox
```

## Pi integration

A global pi extension is installed at `~/.pi/agent/extensions/mi.ts`.

Inside pi:

```bash
/mi <message>   # send a side-channel message to Mi main without sending it to the current pi agent turn
/mi read        # show unread or recent Mi messages
/mi inbox       # show Mi threads
/mi bring-in    # explicitly inject recent Mi context into the current pi conversation
```

`/mi <message>` is intentionally minimal: it appends to `state/threads/main.jsonl` and shows a confirmation. It does not steer, interrupt, or add context to the active pi conversation.

Mi's own chat UI intentionally does not expose a `/inbox` slash command: the normal Mi view is already the durable main inbox, while temporary threads are legacy/troubleshooting state. Use `/tasks` in Mi for actionable background work status, or `mi inbox`/`mi threads` from a shell when inspecting thread files.

`mi task reply <task-id-or-name> -- <message>` matches pi's normal queued-message behavior for active workers: if the worker is still streaming, Mi sends the reply to that same RPC session as a `prompt` with `streamingBehavior: "steer"` instead of starting a competing resume session. If the worker is no longer active, Mi resumes the saved task session and sends the message normally.

## Run web app

```bash
cd ~/assistant
cp .env.example .env
# edit .env and set ASSISTANT_TOKEN to a strong password/token
npm run dev
```

Open on the VPS:

```bash
curl http://127.0.0.1:8787/health
```

Expose privately with Tailscale HTTPS:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Then open the Tailscale HTTPS URL on iPhone. Do not use Tailscale Funnel for this control surface.

Mi is Tailnet-only by default. The server accepts loopback and Tailscale `100.64.0.0/10` clients, plus optional `TAILNET_ALLOWED_IPS`. Public clients receive `403` even if the process is accidentally bound too broadly.

## Validate v0

```bash
npm run validate:v0
```

Checks:
- `mi check production` equivalent
- manual production run
- scheduled production run
- Tailnet web health
- read-only path
- simulated failing CI approval path

## Scheduled runs

Manual production run works with:

```bash
npm run mi -- run production
```

Scheduled execution entrypoint:

```bash
npm run scheduled -- explain production
npm run scheduled -- run production
npm run scheduled:production
```

Example systemd files:
- `mi-production.service.example`
- `mi-production.timer.example`

The production timer runs every 10 minutes. Pushover notifications are sent only when a scheduled result needs attention, and notification text is sanitized.

## Proactive jobs

Flue owns proactive/headless jobs. Run them manually or from systemd timers/cron:

```bash
npm run proactive:brief      # daily brief
npm run proactive:approvals  # approval reminders
npm run proactive:health     # Mi health check
npm run proactive            # all proactive jobs
```

These jobs gather minimal server-side state, pass it to Flue agents when enabled, log results to `state/events.jsonl`, and send safe Pushover notifications when the result says notification is needed.

Persistent Flue orchestration runs on loopback only:

```bash
npm run flue:dev      # foreground persistent Flue orchestrator on 127.0.0.1:3583
npm run flue:status   # check local Flue health
```

The web app talks to Flue through `FLUE_URL=http://127.0.0.1:3583`; Flue is not a public control surface.

## Safety

The web app requires `ASSISTANT_TOKEN` / `ASSISTANT_PASSWORD` login even over Tailscale. Normal chat routes through Flue only when it is enabled behind the Tailnet-only boundary; otherwise it uses the pi-backed safe path. Local inspection routes to read-only pi. The pi bridge enforces `--tools read,grep,find,ls`, not just prompt instructions. Mi owns the decision to start work; pi performs coding/execution worker tasks. `pi.repair` is disabled by default with `PI_REPAIR_ENABLED=false` and must sit behind approval gates before code-changing runs. Requests that look like writes/deploys/merges/deletes create an approval card instead of executing.

Pushover is notifications-only: alerts may say that attention or approval is needed, but should not contain secrets, public control links, or dangerous one-tap action links.

Kill switches:

```bash
touch state/PAUSED  # disable chat execution, keep status available
touch state/KILL    # refuse all chat execution
rm state/PAUSED state/KILL
```
