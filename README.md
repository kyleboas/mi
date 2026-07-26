# Mi

Mi is a small local assistant interface built around four surfaces:

1. `mi` — the main Mi conversation.
2. `mi agents` — the live background-agent view.
3. `mi tick` — scheduled reminders, memory upkeep, capability-file cleanup, and iMessage repair checks.
4. the Mi pi extension — side-channel Mi commands inside pi.

Everything else in this repo exists to support those surfaces.

## Capability-scoped workers

Mi is moving toward capability-based execution. Scoped Pi workers now use explicit capability grant files, reduced environment variables, and the Mi capability guard extension. Read-only scoped workers default to `read,grep,find,ls`; raw host `bash` is denied by default and requires explicit approval or a future stronger sandbox. Flue remains for no-host/virtual agents until scoped host mounts and child-task tool attenuation exist.

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

## `mi tick`

`mi tick` is the single Mi-owned scheduled entrypoint. It:

- runs due reminder-only crons from `~/mi/state/crons.json`;
- removes expired capability grant files;
- runs memory consolidation when it is due; and
- runs the iMessage send-failure repair monitor.

A lock at `state/tick.lock` prevents overlapping runs. The systemd timer runs every minute, while the repair monitor limits itself to once every 15 minutes by default (`MI_IMESSAGE_MONITOR_INTERVAL_MS`).

When the Photon bridge is running, tick notices can use its local-only outbound endpoint. A new install writes `MI_PROACTIVE_IMESSAGE_NOTIFY=false` and does not start the timer. Keep it false until an operator chooses to send notices. Pushover is opt-in through `MI_PUSHOVER_NOTIFY=1` or `MI_PUSHOVER_FALLBACK=1`.

The repair monitor checks `mi-photon-bridge.service`, recent Photon logs, the local notify endpoint, and recent Mi thread activity. A repair attempt restarts the Photon bridge and the user services named by `MI_IMESSAGE_REPAIR_USER_SERVICES`, then checks recovery. The narrow sudoers rule is required for the system service restart. Results use `state/imessage-monitor-state.json` and `state/imessage-monitor.jsonl`; stored details are redacted and bounded.

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

The bridge is only a transport adapter. By default `/api/imessage` uses the minimal V2 concierge: each inbound turn gets one fresh, read-only assistant call with a capped context bundle (recent thread history including results, preferences, durable memory, active/recent work, and a compact safe-state/project snapshot). Cached context is orientation, not live proof. Mi replies naturally, starts existing background work for substantive tasks, and asks one short question before consequential or genuinely ambiguous action. Worker mechanics stay out of the thread; task acknowledgements and completions are correlated by task id.

Set `MI_IMESSAGE_V2=0` for an immediate rollback to the complete legacy V1 regex route. V1 remains intact in this release; its `MI_IMESSAGE_ASK_FIRST=1` behavior still applies only when V1 is enabled. V2 does not automatically write preferences or add new proactive messages.

Minimal memory is backed by the existing `/home/kyle/mi/memory.md` file. V2 consults a bounded slice as context. The legacy V1 path also supports explicit leading `remember ...`, `save ...`, or `note ...` writes under `## Captured via iMessage`; secret-like content is refused, and writes are allowed only through local or token-authorized `/api/imessage` calls.

Setup uses the complete Mi stack installer below. It derives the current Tailscale DNS name for TLS and configures Photon to reach Mi only through `http://127.0.0.1:8787`; no provider credential is placed in the repository or Pi configuration.

Optional env:

- `MI_PHOTON_THREAD=main` — Mi thread to use.
- `MI_PHOTON_MAX_REPLY_CHARS=1200` — soft cap for text-message-sized replies.
- `PHOTON_ALLOW_ALL_USERS=true` — dev only; do not use for a terminal-capable assistant.
- `MI_PHOTON_MAX_WAIT_MS=1800000` — how long the bridge waits for a background-worker result after sending its acknowledgement; defaults to 30 minutes.
- `MI_IMESSAGE_V2=0` — immediately use the retained legacy V1 iMessage router instead of the default minimal V2 concierge.
- `MI_IMESSAGE_MODEL` — override V2's default `vps-gateway/mi-concierge` local gateway model. The default is an authenticated request to the sole local LiteLLM listener (`127.0.0.1:4000`); it is not a direct provider bypass.
- `MI_IMESSAGE_COMPLETION_TIMEOUT_MS=15000` — timeout for the separate, no-tools completion formatter. V2 worker findings are never sent directly: Mi invokes the authenticated `vps-gateway/mi-concierge` route through `/home/kyle/bin/pi-gateway`, then applies a deterministic 480-character safety gate. Formatter failures send a safe fallback, never raw findings.
- `MI_IMESSAGE_ASK_FIRST=1` — legacy V1 opt-in to always asking before iMessage starts tool-backed work.
- `MI_PHOTON_NOTIFY_PORT=8788` — local-only outbound iMessage notification endpoint for Mi proactive notices.
- `MI_PROACTIVE_IMESSAGE_NOTIFY=true` — send Mi proactive notifications to iMessage through the local Photon notify endpoint.
- `MI_IMESSAGE_MONITOR_ENABLED=false` — disable the tick-owned iMessage repair monitor.
- `MI_IMESSAGE_MONITOR_INTERVAL_MS=900000` — monitor cadence; default is 15 minutes.
- `MI_IMESSAGE_REPAIR_USER_SERVICES=mi-web-chat.service,mi-daemon.service` — user services restarted during safe iMessage repair attempts.

The bridge also exposes a local-only notification endpoint at `http://127.0.0.1:8788/notify` by default. `mi tick` uses that endpoint for opt-in proactive iMessage notifications; it does not expose Photon credentials to the tick process. For V2 work, generic daemon reports are retained only in daemon task state; the bridge polls solely for one correlation-bound user-visible completion per acknowledgement/generation. Workers may optionally end with the versioned structured completion envelope (`version`, `status`, `userSummary`, optional internal details). Only a validated summary can skip the formatter; internal details never enter threads, context, or Photon. Sanitized lifecycle metadata is bounded in `state/mi-turn-events.jsonl` and contains no message text or identifiers.

### Local Codex subscription gateway

`vps-gateway/mi-concierge` is Mi V2's production-only foreground route. The authenticated LiteLLM listener maps it immutably to `openai-codex/gpt-5.6-sol` with `--thinking medium`. Shared `vps-gateway/coding-main` remains unchanged on its historical implicit-high route for every other gateway client. These are the only durable production aliases; tracked production callers do not require `coding-fast`. Neither route has an OpenRouter, Cloudflare, or OpenAI API-key path. Pi runs offline, without sessions, tools, extensions, skills, prompt templates, or themes, and receives a scrubbed environment rather than gateway variables.

The gateway and non-secret production Pi registry are installed as stages of the canonical stack operation. The tracked modular scripts remain internal implementation and test units.

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

Use `/home/kyle/install-mi-stack.sh --check` for a non-secret configuration summary or `--dry-run` to list stages without mutation. The operation installs reviewed unit files but does not enable or start web, Photon, daemon, or timer work. It writes disabled notice and repair-monitor settings. After checking the safeguards, start only `mi-daemon.service`; leave the timer, notices, and repair monitor disabled. See [`docs/mi-stack.md`](docs/mi-stack.md) for rollback and safe-cleanup behavior.

The installer creates the system Photon bridge unit and the user web, daemon, and tick units. The Photon unit loads its broker-managed secret file with `EnvironmentFile=`. It does not print credential values into the agent shell.

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

`test:quality` covers assistant behavior shape: routing choices, worker handoff/follow-up decisions, iMessage status replies, result relay behavior, and acknowledgement wording invariants. It does not prove live LLM prose quality because all workers and Mi replies are faked.

Live smoke tests are opt-in only. Keep any real LLM/iMessage/notification/service checks behind `MI_LIVE_SMOKE=1`. The live script prints only present/missing flag names, never secret values. By default it only preflights; select checks explicitly:

```bash
MI_LIVE_SMOKE=1 npm run test:live
MI_LIVE_SMOKE=1 MI_WEB_URL=http://127.0.0.1:8787 MI_LIVE_WEB_HEALTH=1 npm run test:live
```

Real iMessage API smoke is additionally gated by `MI_LIVE_IMESSAGE_SMOKE=1`.

Security check:

```bash
npm audit --omit=dev
```
