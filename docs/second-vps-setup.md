# Set up a clean Mi instance on a second VPS

This guide creates a separate Mi installation for a separate iMessage number. It does not move the current installation.

Use placeholders such as `<mi-user>`, `<service-home>`, `<mi-root>`, `<workspace-root>`, `<repo-url>`, and `<project-name>`. Do not paste real account names, hostnames, numbers, or credentials into commands saved in the repository.

## Clean-instance rule

Do **not** copy any of these items from another host:

- private Mi state or iMessage history;
- Pi sessions;
- memory or preference files;
- pending confirmations or approvals;
- tokens, passwords, `.env`, or any `.env*` file;
- `.pi` credentials, auth files, model credentials, or session files;
- daemon sockets, locks, logs, or capability grants;
- coordinator policies or coordinator sessions; or
- any chief-of-staff SQLite database or related state.

Do not copy all of `~/.pi`, `~/mi`, `$MI_ROOT/state`, or another service user's home. The new host gets its own phone number, Photon project, allowed-sender list, Pi login, workspace, runtime directories, state directories, and service configuration.

## 1. Prerequisites

Prepare a supported Linux VPS with:

- systemd and user systemd services;
- Git;
- Node.js 24 and npm;
- Python and a working LiteLLM service layout under `/opt/litellm` if the tracked local subscription gateway will be used;
- Tailscale, joined to the new host's own tailnet identity, with HTTPS certificates enabled;
- a separate Photon project connected to the new iMessage number; and
- sudo access for installation.

The explicit maintenance Web installer calls `tailscale status` and `tailscale cert`. The normal stack check verifies files and safeguards. It does not install or require Web chat. Activation starts only services that Kyle separately approves.

The gateway installer renders account paths from explicit settings. It rejects placeholders, relative or unclean paths, symlinks, account-home mismatches, and unexpected owners before changing gateway files or restarting the service.

## 2. Create a fresh OS user

Create a dedicated unprivileged user and home with normal operating-system tools. Give the account a private home and no shared credential files. In the rest of this guide:

```bash
export MI_USER='<mi-user>'
export MI_GROUP="$(id -gn "$MI_USER")"
export MI_HOME='<service-home>'
export MI_ROOT='<mi-root>'
export MI_WORKSPACE='<workspace-root>'
export MI_GATEWAY_WORK='/var/lib/llm-gateway'
```

Use an app path under the service home for `<mi-root>`. Use a dedicated existing directory such as `<service-home>/workflows` for `<workspace-root>`. It must not equal the home directory. Mi checks the real path and refuses a workspace root that is the home or an ancestor of it.

As root, create the empty roots with the service user as owner:

```bash
install -d -m 0700 -o "$MI_USER" -g "$MI_GROUP" \
  "$MI_HOME" "$MI_WORKSPACE" "$MI_GATEWAY_WORK"
```

## 3. Clone and build

As the service user, clone a reviewed commit. Do not clone a working directory that contains state or ignored files.

```bash
git clone '<repo-url>' "$MI_ROOT"
cd "$MI_ROOT"
git checkout '<reviewed-commit>'
npm ci
npm run build
npm install -g .
```

Check that this install's commands are the ones on PATH:

```bash
command -v node npm mi
mi --help
```

## 4. Install and log in to Pi

Install the reviewed Earendil Pi fork and version used by the gateway path. Keep these two values visible so a later review can update them together:

```bash
PI_PACKAGE='@earendil-works/pi-coding-agent'
PI_VERSION='0.80.10'
npm install -g "$PI_PACKAGE@$PI_VERSION"
command -v pi
pi --help
```

Start `pi` once as the new service user and complete Pi's normal login flow. Use a new login for this host. Do not copy auth storage, provider files, model files, sessions, or any part of another host's `.pi` directory.

Configure only the models this instance needs. The iMessage coordinator uses the configured concierge route. Terra, Luna, and Sol-High worker names also need matching models available to this Pi login. A model name in source code does not prove the account can use it.

## 5. Keep Mi execution files in the reviewed source tree

Pi auto-loads `~/.pi/agent/extensions`. Do not copy Mi's TUI, daemon, capability guard, or orchestrator adapter into that folder or into any project `.pi/extensions` folder. They stay in the reviewed checkout at `$MI_ROOT/pi/extensions` and Mi starts them only by explicit absolute path.

The Mi TUI is optional. A normal `pi` session must not load it. To use it for one deliberate session, run:

```bash
MI_ROOT="$MI_ROOT" pi --extension "$MI_ROOT/pi/extensions/mi.ts"
```

The iMessage coordinator explicitly loads `$MI_ROOT/pi/extensions/mi-capability-guard.ts` and `$MI_ROOT/pi/extensions/mi-orchestrator-adapter.ts` after `--no-extensions`. The daemon user unit explicitly runs `$MI_ROOT/pi/extensions/mi-daemon.mjs`. Do not add any of these files as globally discovered extensions.

The advisor skill is passive until it is explicitly requested. If it is installed, keep its reviewed source at `$MI_HOME/.pi/agent/skills/advisor`, with `SKILL.md` and its required source registry. Do not copy the whole skills directory from another machine. Point `MI_ADVISOR_SKILL_PATH` at that reviewed directory if it is installed elsewhere.

Direct advisor requests fail closed unless all required parts exist. Each selected advisor needs one independent Sol-High worker, a configured `openai-codex/gpt-5.6-sol:high` model, the reviewed advisor skill, and the Mi daemon. “Ask the advisors” needs two separate Sol-High workers, one per advisor. Mi must not claim advisor output when any worker cannot start.

## 6. Create the new Photon configuration

Create a separate Photon project for the new iMessage number. Set its allowed users to only the phone numbers or user IDs that may control this Mi. Never set `PHOTON_ALLOW_ALL_USERS=true` in production.

Use the local secret broker. Do not use Infisical, raw tokens, or `.env` files. Ask an operator to add the Photon service with:

```bash
sudo secret <project-name> photon
```

Use `sudo secret global <service>` only when the service is intentionally shared for the whole host. The broker-managed Photon service must provide `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, and `PHOTON_ALLOWED_USERS`. Do not open or print the broker file to verify it. Use normal brokered commands and service status instead.

Any Pushover or other optional notification service follows the same rule:

```bash
sudo secret <project-name> <service>
```

Pushover is optional. Leave it disabled for the first smoke test.

## 7. Install the services

Run the tracked stack installer with every account-specific gateway value set. Resolve executable symlinks before sudo; the gateway rejects symlink executables so a package update cannot silently change what it runs:

```bash
NODE_BIN="$(readlink -f "$(command -v node)")"
MI_BIN="$(readlink -f "$(command -v mi)")"
PI_COMMAND_DIR="$(dirname "$(command -v pi)")"
PI_BIN="$(readlink -f "$(command -v pi)")"
GATEWAY_HEALTH="$(readlink -f '<brokered-local-health-command>')"

sudo env \
  MI_STACK_NO_SUDO=1 \
  MI_APP_DIR="$MI_ROOT" \
  MI_STACK_HOME="$MI_HOME" \
  MI_SERVICE_USER="$MI_USER" \
  MI_NODE_BIN="$NODE_BIN" \
  MI_BIN="$MI_BIN" \
  MI_GATEWAY_SERVICE_USER="$MI_USER" \
  MI_GATEWAY_SERVICE_HOME="$MI_HOME" \
  MI_GATEWAY_PI_BINARY="$PI_BIN" \
  MI_GATEWAY_PI_COMMAND_DIR="$PI_COMMAND_DIR" \
  MI_GATEWAY_PI_AGENT_DIR="$MI_HOME/.pi/agent" \
  MI_GATEWAY_WORK_DIR="$MI_GATEWAY_WORK" \
  MI_GATEWAY_HEALTH_COMMAND="$GATEWAY_HEALTH" \
  MI_GATEWAY_HEALTH_USER="$MI_USER" \
  MI_PHOTON_SECRET_ENV="/etc/agent-secrets/projects/<project-name>/photon.secret" \
  "$MI_ROOT/scripts/install-mi-stack.sh"
```

The script installs the production gateway, then the brokered gateway client and its non-secret `coding-main` Pi registry baseline, then the production Pi aliases, Mi daemon, tick timer, Photon bridge, and generated home entrypoint. It does not install Web chat in the normal stack. It writes files only and does not reload, enable, start, stop, or restart services. It makes owner-only backups of replaced Mi unit files and drop-in folders. Preview its stages first if needed:

```bash
MI_APP_DIR="$MI_ROOT" "$MI_ROOT/scripts/install-mi-stack.sh" --dry-run
```

Add private service settings through systemd drop-ins, not `.env` files. Set these values in the matching units:

- the explicit maintenance `mi-web-chat.service`: set `MI_WEB_MAINTENANCE=1`, `MI_ROOT`, and approved workspace paths.
- `mi-daemon.service`: `MI_ROOT`, `MI_WORKFLOWS_DIR`, and `MI_ADVISOR_SKILL_PATH`.
- `mi-tick.service`: `MI_ROOT`, notification choices, and monitor choice.
- `mi-photon-bridge.service`: `MI_ROOT`.

Use `systemctl edit --user <unit>` for user units and `sudo systemctl edit mi-photon-bridge.service` for the system unit. Use literal final paths in unit files because systemd does not expand shell variables there.

For the first start, set:

```ini
Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=false
Environment=MI_IMESSAGE_MONITOR_ENABLED=false
Environment=MI_PUSHOVER_NOTIFY=0
Environment=MI_PUSHOVER_FALLBACK=0
```

Then verify the daemon sandbox (`PrivateTmp=true`, `ProtectSystem=full`), fixed service-user PATH, reviewed private extension paths, writable paths, and disabled notice/monitor settings. After separate approval, reload the files. Reloading does not start a service:

```bash
sudo systemctl daemon-reload
systemctl --user daemon-reload
```

Start gateway and Photon only in separate approved commands. Photon is the only normal user-facing service. The runtime starts the daemon on demand:

```bash
sudo systemctl start llm-gateway.service
sudo systemctl start mi-photon-bridge.service
```

Leave the timer, maintenance Web service, proactive notices, and repair monitor off until each has separate approval. Enabling a unit for boot is a separate approval too.

## 8. Ownership and modes

Check names and modes without reading private content:

```bash
install -d -m 0700 -o "$MI_USER" -g "$MI_GROUP" \
  "$MI_ROOT/state" "$MI_HOME/mi" "$MI_HOME/.pi/agent/mi"
chown -R "$MI_USER:$MI_GROUP" "$MI_ROOT" "$MI_WORKSPACE" "$MI_HOME/mi" "$MI_HOME/.pi/agent/mi"
chmod 0700 "$MI_WORKSPACE" "$MI_ROOT/state" "$MI_HOME/mi" "$MI_HOME/.pi/agent/mi"
find "$MI_ROOT/state" "$MI_HOME/mi" "$MI_HOME/.pi/agent/mi" -type f -exec chmod 0600 {} +
```

Keep the reviewed `$MI_ROOT/pi/extensions` directory and the passive advisor skill directory at `0700`; use `0600` for TypeScript and Markdown files and `0700` for the executable daemon script. Systemd unit files are normally `0644`. The repair sudoers file must be `0440`. Leave broker secret ownership and modes to `sudo secret`; do not change or inspect them.

## 9. Repair monitor and notifications

When the bridge has passed non-send checks, install the narrow repair rule:

```bash
sudo MI_USER="$MI_USER" "$MI_ROOT/scripts/install-mi-imessage-repair-sudoers-root.sh"
```

It permits only a restart of `mi-photon-bridge.service`. The monitor restarts only `mi-photon-bridge.service`. It does not restart Web chat or the daemon.

Keep `MI_PROACTIVE_IMESSAGE_NOTIFY=false` if this instance should not send automatic iMessages. Turn on the repair monitor only after the new number and allowed-user list are confirmed. Pushover stays opt-in.

## 10. Explicit cron choices

A new instance starts with no copied cron state. Add only wanted reminders as the service user:

```bash
mi cron add daily-note --every 1d --message "Review the daily note"
mi cron add one-time --at 2030-01-02T15:00:00Z --message "Appointment"
mi cron list
```

Prompt crons may use `--prompt` and `--thread`. Do not add legacy command crons for a new instance. The timer runs reminder crons, memory upkeep, capability-file cleanup, and the iMessage repair monitor. It does not run configured health monitors or removed automatic project loops.

## 11. Isolated smoke tests

Run local checks before enabling any live send:

```bash
cd "$MI_ROOT"
npm run build
node scripts/test-mi-tick.mjs
node scripts/test-mi-imessage-monitor.mjs
node scripts/test-mi-photon-bridge-relay.mjs
npx tsx scripts/test-mi-orchestrator-adapter.ts
mi --help
```

The repository tests use temporary homes, fake workers, and local HTTP servers. Do not set `MI_LIVE_SMOKE=1` or `MI_LIVE_IMESSAGE_SMOKE=1` during this step.

Check units without dumping their environments or secret files:

```bash
systemctl --user status mi-web-chat.service mi-daemon.service mi-tick.timer
sudo systemctl status mi-photon-bridge.service
MI_APP_DIR="$MI_ROOT" MI_STACK_HOME="$MI_HOME" MI_SERVICE_USER="$MI_USER" \
  MI_NODE_BIN="$(readlink -f "$(command -v node)")" \
  MI_GATEWAY_HEALTH_COMMAND="$(readlink -f '<brokered-local-health-command>')" \
  MI_GATEWAY_HEALTH_USER="$MI_USER" \
  "$MI_ROOT/scripts/install-mi-stack.sh" --check
```

Keep outbound sending disabled until an operator deliberately confirms the new Photon project, new number, allowed-sender list, and target thread. Then enable one notification path at a time and perform one deliberate live test.

## 12. Backup and rollback

Back up only this new instance after it has created its own state. Keep code and private state separate:

- record the Git commit and service drop-ins;
- back up the new instance's own `$MI_ROOT/state`, `~/mi`, and needed memory files with encryption and owner-only access;
- use the Pi product's own account recovery instead of copying `.pi` credentials; and
- do not back up sockets, locks, coordinator policy/session files, or pending confirmations as portable data.

For a code rollback, use a separately approved service stop only when needed, then check out the previous reviewed commit, run `npm ci && npm run build`, reinstall the package, and rerun the stack installer. Its failed-install transaction restores generated configuration while preserving the pre-install active and enabled state; it never reloads, enables, starts, stops, or restarts services. Keep broker-managed credentials in place; do not move them into the repository or backup bundle. Before activation, remove or quarantine any old Mi files in Pi global or project auto-load folders; do not restore them during rollback.

The gateway-only installer saves all five replaced files under `/var/backups/mi-gateway` before it writes them. To restore that saved set together, use the same reviewed checkout and account settings used for installation:

```bash
sudo env \
  MI_GATEWAY_SERVICE_USER="$MI_USER" \
  MI_GATEWAY_SERVICE_HOME="$MI_HOME" \
  MI_GATEWAY_PI_BINARY="$PI_BIN" \
  MI_GATEWAY_PI_COMMAND_DIR="$PI_COMMAND_DIR" \
  MI_GATEWAY_PI_AGENT_DIR="$MI_HOME/.pi/agent" \
  MI_GATEWAY_WORK_DIR="$MI_GATEWAY_WORK" \
  MI_GATEWAY_HEALTH_COMMAND="$GATEWAY_HEALTH" \
  MI_GATEWAY_HEALTH_USER="$MI_USER" \
  "$MI_ROOT/scripts/install-mi-subscription-gateway-root.sh" --rollback
```

Rollback validates the full saved set before changing a gateway file. It restores files only, preserves gateway active and enabled state, is safe to repeat, and does not read or move broker-managed secrets.

To stop the clean instance without deleting it:

```bash
systemctl --user disable --now mi-tick.timer mi-daemon.service mi-web-chat.service
sudo systemctl disable --now mi-photon-bridge.service
```

Do not delete state as part of a rollback. Review and approve any later cleanup separately.
