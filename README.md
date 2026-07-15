# Mi

Mi is a small local assistant interface built around five surfaces only:

1. `mi` — the main Mi conversation.
2. `mi agents` — the live background-agent view.
3. `mi check` — one minimal proactive check-in.
4. `mi tick` — the single scheduled loop for reminders, configured monitor health, and the once-daily brief.
5. the Mi pi extension — side-channel Mi commands inside pi.

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

## `mi check`

`mi check` is the minimal proactive loop. It reads local Mi state, runs a small fixed set of checks, dedupes repeated observations, appends one useful message to the main Mi thread, and optionally sends a notification.

Shape: read state → run checks → dedupe → append message → maybe start safe read-only triage for allowlisted monitor failures → maybe start repair worker for crashed checks → maybe notify.

Default checks:

- `pendingApprovals`
- `failedCrons`
- `dailyBrief`

Non-error proactive messages usually end with `No action taken.` Dynamic project questions are the exception: they ask one concrete question and do not add a footer. Crashed checks report the error in the main thread and automatically request a background repair worker. The proactive loop itself still does not edit files, deploy, merge, delete, change config, or approve anything.

`mi check health-check` is separate from the default check set. It reads configured monitor inputs from `assistants/monitors.md`, including Tactics Journal health sidecars from `/home/kyle/code/research/.logs` by default and Mi reminder cron state, stores transitions in `state/monitor-health.json`, and speaks only when a monitor changes state or recovers. It now goes live by default for allowlisted stale/degraded configured monitors by starting a safe read-only triage worker with the explicit `worker-read` capability. That worker may inspect and summarize only; any edit, deploy, merge, config change, secret access, or approval still requires the normal approval path. Human-required states such as Railway auth/link problems or Cloudflare billing/forbidden problems notify without starting a worker.

Safe auto-action controls: set `MI_AUTO_ACTIONS_ENABLED=false` to disable live triage, `MI_AUTO_ACTION_INSPECT_MAX_PER_DAY` to cap read-only triage starts per day, or `MI_AUTO_ACTIONS_MAX_PER_DAY` as a fallback cap. Budget state is stored in `state/auto-actions.json`.

`mi check question` is also separate from the default check set. It asks one dynamic question tied to current projects or explicit goals, suppresses generic questions, avoids repeats, and starts no work by itself.

```bash
mi check
mi check health-check
mi check question
```

## `mi tick`

`mi tick` is the single Mi-owned scheduled entrypoint. It runs due reminder-only Mi crons, checks configured monitor health, runs the iMessage send-failure repair monitor, sends the daily brief once after the configured morning hour, may ask dynamic project questions during non-quiet hours, runs weekly Pi conversation loop discovery, and runs Loop Factory digest/build-ready checks. It uses a lock file so overlapping timer invocations do not race state.

Dynamic project questions use `MI_QUESTIONS_ENABLED`, `MI_QUESTIONS_MAX_PER_DAY`, `MI_QUESTIONS_QUIET_BEFORE`, `MI_QUESTIONS_QUIET_AFTER`, and `MI_QUESTIONS_MIN_GAP_HOURS`. The daily max is a cap, not a target: Mi skips a question when it cannot find a specific, useful project or goal question.

When the Photon bridge is running, proactive notifications can also be delivered as outbound iMessages through the bridge's local-only notify endpoint. The tick installer enables this by default with `MI_PROACTIVE_IMESSAGE_NOTIFY=true`; set it to `false` to keep notices only in Mi. Pushover is opt-in only via `MI_PUSHOVER_NOTIFY=1` or emergency fallback `MI_PUSHOVER_FALLBACK=1`.

The iMessage repair monitor runs from `mi tick` at most once every 15 minutes (`MI_IMESSAGE_MONITOR_INTERVAL_MS`). It checks `mi-photon-bridge.service`, recent Photon logs, the local notify endpoint, and recent Mi thread iMessage activity. Safe repair attempts restart the Photon bridge plus local Mi user services, then verify recovery before sending a plain-English iMessage confirmation. Unrepaired bridge failures are written to Mi main; Pushover fallback is sent only when `MI_PUSHOVER_FALLBACK=1` or `MI_PUSHOVER_NOTIFY=1`. Incident records are appended to `state/imessage-monitor.jsonl`; only redacted metadata and short previews are stored.

Pi conversation loop discovery mines approved Pi session logs from the last 90 days for recurring, painful work loops. It stores aggregate state at `~/.pi/agent/state/loop-discovery.json`, updates a managed aggregate block in `~/NOTES.md`, and sends a compact top-5 iMessage brief when candidates meet the threshold. Scheduled runs only send the brief; replying with a number or candidate name starts a scoped background grilling task in `~/workflows` and records the selected candidate in Loop Factory.

Loop Factory captures explicit user phrases such as “this is a loop”, “make this a workflow”, “automate this recurring thing”, “I keep doing this”, and “next time do this automatically”. It stores aggregate state at `~/.pi/agent/state/loop-factory.json`, maintains a separate managed `~/NOTES.md` block, creates draft specs under `~/workflows`, runs one active scoped grilling session at a time, treats `r`/`R` as accepting the recommended answer, detects build-ready specs via a `<!-- loop-factory:build_ready -->` marker, and asks for `queue now`, `later`, or `never` before implementation.

Manual run:

```bash
mi loop-discovery --force
mi loop-discovery --notify
mi loop-discovery --select 2
```

Arbitrary command crons are legacy/deprecated; prefer reminder-only crons plus configured monitors and scoped repair workers.

Install the user timer with:

```bash
sudo scripts/install-mi-tick-systemd.sh
```

## Mi pi extension

A global pi extension is installed at `~/.pi/agent/extensions/mi.ts`.

Inside pi, the Mi extension exposes a single slash command: `/mi`.

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

Setup:

1. Create/login to Photon at https://photon.codes/ / https://app.photon.codes/.
2. Create a Spectrum/iMessage project and get the project id/secret.
3. Start Mi web chat locally or over Tailscale. For the user service, run `./scripts/install-mi-web-chat-systemd.sh`; it derives the machine's current Tailscale DNS name when issuing its certificate, then run `systemctl --user restart mi-web-chat.service`.
4. Run the bridge with only your phone number allowlisted:

```bash
PHOTON_PROJECT_ID=... \
PHOTON_PROJECT_SECRET=... \
PHOTON_ALLOWED_USERS=+15551234567 \
MI_WEB_URL=http://127.0.0.1:8787 \
npm run photon
```

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

The bridge also exposes a local-only notification endpoint at `http://127.0.0.1:8788/notify` by default. `mi tick` uses that endpoint for opt-in proactive iMessage notifications; it does not expose Photon credentials to the tick process. For V2 work, generic daemon reports are retained only in daemon task state; the bridge polls solely for the single correlation-bound formatted completion.

### Local Codex subscription gateway

`vps-gateway/mi-concierge` is Mi V2's production-only foreground route. The existing authenticated LiteLLM listener maps it immutably to `openai-codex/gpt-5.6-sol` with `--thinking medium`. Shared `vps-gateway/coding-main` remains unchanged on its historical high-effort route for every other gateway client. Neither route has an OpenRouter, Cloudflare, or OpenAI API-key path; `coding-fast` is intentionally not exposed. Pi runs offline, without sessions, tools, extensions, skills, prompt templates, or themes, and receives a scrubbed environment rather than gateway variables.

The tracked root installer is `scripts/install-mi-subscription-gateway-root.sh`. Its prepared root entrypoint is `/home/kyle/install-mi-subscription-gateway.sh`; it installs only the tracked LiteLLM config/handler/wrapper/drop-in, reloads and restarts `llm-gateway`, then performs the authenticated local health check. It does not configure provider secrets:

```bash
sudo /home/kyle/install-mi-subscription-gateway.sh
```

Install the non-secret, user-level Pi registry entries before using the production concierge or evaluation aliases:

```bash
npm run setup:mi-gateway-models
```

#### Decision-only model evaluation

The immutable authenticated aliases `mi-eval-luna-low`, `mi-eval-sol-low`, `mi-eval-terra-low`, `mi-eval-sol-medium`, and `mi-eval-sol-high` exist only for the synthetic Mi V2 decision evaluation. They are separate from `mi-concierge` and keep `coding-main` unchanged. The root gateway installer above installs their authenticated local mappings.

Then run the two-pass, sequential (maximum concurrency two) comparison with:

```bash
npm run eval:mi-models
```

It uses `/home/kyle/bin/run-heavy`, invokes only `/home/kyle/bin/pi-gateway`, writes sanitized synthetic summaries and blinded outputs under ignored `.tmp/mi-model-eval/`, and never dispatches a task.

For always-on use, store the Photon values once, then install/restart:

```bash
sudo secret assistant photon
# paste PHOTON_PROJECT_ID=..., PHOTON_PROJECT_SECRET=..., PHOTON_ALLOWED_USERS=...

sudo ./scripts/install-mi-imessage-stack-root.sh
sudo journalctl -u mi-photon-bridge -f
```

The installer creates/enables:

- `/etc/systemd/system/mi-photon-bridge.service` — Photon/iMessage transport bridge.

The service loads `/etc/agent-secrets/projects/assistant/photon.secret` with `EnvironmentFile=` and runs the bridge as `kyle`. It does not print or read secret values into the agent shell.

For automatic repair from unprivileged `mi tick`, install the narrow sudoers rule that permits only restarting `mi-photon-bridge.service`:

```bash
sudo ./scripts/install-mi-imessage-repair-sudoers-root.sh
```

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
