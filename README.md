# Mi

Mi is a small local assistant interface built around four surfaces:

1. `mi` — the main Mi conversation.
2. `mi agents` — the live background-agent view.
3. `mi tick` — scheduled reminders, memory upkeep, capability-file cleanup, and iMessage repair checks.
4. the Mi pi extension — side-channel Mi commands inside pi.

Everything else in this repo exists to support those surfaces.

## Capability-scoped workers

Mi is moving toward capability-based execution. Scoped Pi workers now use explicit capability grant files, reduced environment variables, normal Pi extension discovery, and the Mi capability guard extension. Built-in filesystem and command access is governed by grants; raw host `bash` is denied by default and requires explicit approval or a future stronger sandbox. Flue remains for no-host/virtual agents until scoped host mounts and child-task tool attenuation exist.

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

## `pi-agents`

`pi-agents` is a standalone Pi-session board. It runs independent Pi RPC sessions in one local manager process, renders them with Pi's TUI components, and lets you reply to, stop, and resume them.

```bash
pi-agents
pi-agents start review --read-only -- "Review the current diff"
```

Only one write-capable Pi Agent may run in a checkout. Use a separate git worktree for parallel implementation tasks; use `--read-only` for parallel review or research.

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

## `mi tick`

`mi tick` is the single Mi-owned scheduled entrypoint. It:

- runs due reminder-only crons from `~/mi/state/crons.json`;
- removes expired capability grant files;
- runs memory consolidation when it is due; and
- runs the iMessage send-failure repair monitor.

A lock at `state/tick.lock` prevents overlapping runs. The systemd timer runs every minute, while the repair monitor limits itself to once every 15 minutes by default (`MI_IMESSAGE_MONITOR_INTERVAL_MS`).

When the Photon bridge is running, tick notices can use its local-only outbound endpoint. A new install writes `MI_PROACTIVE_IMESSAGE_NOTIFY=false` and does not start the timer. Keep it false until an operator chooses to send notices. Pushover is opt-in through `MI_PUSHOVER_NOTIFY=1` or `MI_PUSHOVER_FALLBACK=1`.

The repair monitor checks `mi-photon-bridge.service`, recent Photon logs, the local notify endpoint, durable deliveries, and recent Mi thread activity. A repair attempt restarts only the Photon bridge, then checks recovery. The narrow sudoers rule is required for the system service restart. Results use `state/imessage-monitor-state.json` and `state/imessage-monitor.jsonl`; stored details are redacted and bounded.

Add reminder crons explicitly:

```bash
mi cron add stand-up --every 1d --message "Stand-up time"
mi cron add appointment --at 2030-01-02T15:00:00Z --message "Appointment"
mi cron list
mi cron check
mi cron remove stand-up
```

Prompt crons also exist and name a Mi thread. Arbitrary command crons remain only as a legacy, deprecated form; use reminder or prompt crons for new entries.

The old proactive check-in, health/question checks, configured-monitor loop, daily brief, and scheduled workflow scans are removed. `mi check <assistant>` still exists only to validate one assistant Markdown file.

The timer is installed with the complete Mi stack; use the production command in **Mi stack installation** below.

## Mi pi extension

Mi's Pi extension is opt-in. It is not installed in Pi's global auto-load folder. Start a deliberate Mi TUI session with:

```bash
MI_ROOT="${MI_ROOT:-$HOME/assistant}" pi --extension "${MI_ROOT:-$HOME/assistant}/pi/extensions/mi.ts"
```

Inside that Pi session, the Mi extension exposes a single slash command: `/mi`.

```bash
/mi             # open the Mi side-channel thread
/mi <message>   # send a side-channel message to Mi
```

`/mi <message>` is intentionally minimal: it appends to `state/threads/main.jsonl` and shows a confirmation. It does not steer, interrupt, or add context to the active pi conversation. Bare `mi ...` input is not registered by the extension; use `/mi` instead.

## Photon iMessage bridge

Mi can be reached from native iMessage through Photon, the same managed iMessage relay used by Hermes Agent when no Mac/BlueBubbles server is available.

Photon is the only normal Mi service. iMessage is the only normal user interface. The bridge authenticates Photon events, derives one durable conversation identity, and calls `scripts/mi-imessage-runtime.mjs` directly.

Each conversation stores one private Pi session at `state/imessage/conversations/<conversation-id>/session.jsonl`. Pi starts only for a turn, resumes that file, and exits after the RPC turn. The runtime serializes turns per conversation, bounds concurrent conversations, records delivery state, and removes completed raw message text.

The runtime requires an upstream message ID and a stable timestamp. It rejects incomplete events with a fixed retry request before Pi starts. It replays completed but unsent replies before later turns. A successful Photon send followed by a failed durable state write can produce one duplicate after restart. The runtime never retries interrupted work automatically.

Divernote is available only to a named sender in `PHOTON_ALLOWED_USERS` after the Photon bridge has verified that sender. Its per-turn grant defaults to deny for every other sender, including the transport's unsafe `PHOTON_ALLOW_ALL_USERS` development override. An allowed sender can list supported items, search within listed results, and make only the reviewed task, note, project, and project-subtask changes. The normal capability guard and its audit log still apply to every request.

The normal stack has no Web chat dependency. Web chat remains a loopback maintenance tool and requires `MI_WEB_MAINTENANCE=1`. Do not expose it as a second user interface. No provider credential is placed in the repository or Pi configuration.

Optional env:

- `MI_PHOTON_MAX_REPLY_CHARS=1200` — bound user-facing reply text.
- `MI_PHOTON_TYPING_DELAY_MS=100` — delay cosmetic typing feedback.
- `MI_IMESSAGE_WORKSPACE_ROOT` and `MI_IMESSAGE_WORKSPACE_CWD` — approved workspace paths.
- `MI_IMESSAGE_CONCURRENCY=4` — maximum concurrent conversations.
- `MI_IMESSAGE_COORDINATOR_TIMEOUT_MS=90000` — maximum Pi and delegated-task time.
- `MI_PHOTON_NOTIFY_PORT=8788` — local-only outbound iMessage notification endpoint.
- `MI_PROACTIVE_IMESSAGE_NOTIFY=true` — opt in to proactive iMessage notices.
- `MI_IMESSAGE_MONITOR_ENABLED=false` — disable the tick-owned repair monitor.
- `MI_IMESSAGE_MONITOR_INTERVAL_MS=900000` — monitor cadence. The default is 15 minutes.

The bridge exposes a local-only notification endpoint at `http://127.0.0.1:8788/notify`. The monitor checks durable deliveries, Photon logs and service state, the notify endpoint, and stale thread activity. It restarts only `mi-photon-bridge.service` by default. It does not restart Web chat or the daemon.

### Local Codex subscription gateway

`vps-gateway/mi-concierge` is the production route for focused Pi turns. The authenticated LiteLLM listener maps it immutably to `openai-codex/gpt-5.6-sol` with `--thinking medium`. Shared `vps-gateway/coding-main` remains unchanged on its historical implicit-high route for every other gateway client. These are the only durable production aliases. Neither route has an OpenRouter, Cloudflare, or OpenAI API-key path. The runtime loads only reviewed extensions and passes a scrubbed environment.

The canonical stack first installs the gateway client and its non-secret `coding-main` Pi registry baseline, then installs the production `mi-concierge` alias. The alias stage fails closed if that baseline cannot be established. The tracked modular scripts remain internal implementation and test units.

#### Decision-only model evaluation

The immutable aliases `mi-eval-luna-low`, `mi-eval-sol-low`, `mi-eval-sol-medium`, `mi-eval-terra-low`, and `mi-eval-sol-high` live only in a temporary overlay. The normal production installer and registry setup never install them. An evaluation is always install → evaluate → uninstall:

```bash
sudo /home/kyle/install-mi-model-eval-gateway.sh
npm run eval:mi-models
sudo /home/kyle/uninstall-mi-model-eval-gateway.sh
```

The uninstall is idempotent: it restores the canonical production config/handler, removes only eval-only registry entries, preserves unrelated settings/models and production defaults, restarts the gateway, and waits for the existing authenticated readiness check. The harness uses `/home/kyle/bin/run-heavy`, invokes only `/home/kyle/bin/pi-gateway`, writes sanitized synthetic summaries and blinded outputs under ignored `.tmp/mi-model-eval/`, and never dispatches a task.

### Mi stack installation

Normal installation and repair has one user-facing command (run normally; it requests sudo at most once):

```bash
/home/kyle/install-mi-stack.sh
```

Use `/home/kyle/install-mi-stack.sh --check` for a non-secret configuration summary or `--dry-run` to list stages without mutation. The operation installs files only. It does not reload, enable, start, stop, or restart the gateway, Photon, daemon, or timer. Normal readiness checks only the gateway and Photon. Start services only after Kyle approves the commands. The runtime starts the daemon on demand when delegated work needs it. See [`docs/mi-stack.md`](docs/mi-stack.md) for rollback and recovery limits.

The installer creates the system Photon bridge unit and user daemon and tick units. It does not install the maintenance Web unit. Install that unit separately with `MI_WEB_MAINTENANCE=1` when maintenance access is required. The Photon unit loads its broker-managed secret file with `EnvironmentFile=`. It does not print credential values into the agent shell.

For automatic repair from unprivileged `mi tick`, install the narrow sudoers rule that permits only restarting `mi-photon-bridge.service`:

```bash
sudo MI_USER="$(id -un)" ./scripts/install-mi-imessage-repair-sudoers-root.sh
```

For a separate host and phone number, follow [`docs/second-vps-setup.md`](docs/second-vps-setup.md). Do not copy an existing Mi home or state directory.

## Development

Default Mi regression tests are hermetic: they use temporary `HOME`, `MI_ROOT`, daemon sockets, fake pi workers, and local HTTP servers. They must not send real iMessages, push notifications, Pushover messages, LLM requests, deploys, or service mutations.

```bash
npm install
npm run build
npm test
npm run test:mi-surfaces
npm run test:quality
```

`test:quality` covers assistant behavior shape: guarded routing choices, worker handoff and follow-up decisions, delivery recovery, and acknowledgement wording invariants. It does not prove live LLM prose quality because all workers and Mi replies are faked.

Live smoke tests are opt-in only. Keep any real LLM/iMessage/notification/service checks behind `MI_LIVE_SMOKE=1`. The live script prints only present/missing flag names, never secret values. By default it only preflights; select checks explicitly:

```bash
MI_LIVE_SMOKE=1 npm run test:live
MI_LIVE_SMOKE=1 MI_WEB_MAINTENANCE=1 MI_WEB_URL=http://127.0.0.1:8787 MI_LIVE_WEB_HEALTH=1 npm run test:live
```

Real iMessage smoke requires a direct Photon test harness and Kyle's separate approval. The Web smoke script does not call an iMessage HTTP route.

Security check:

```bash
npm audit --omit=dev
```
