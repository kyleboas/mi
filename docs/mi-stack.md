# Mi stack operator guide

## Production install or repair

Run one command as Kyle:

```bash
/home/kyle/install-mi-stack.sh
```

The entrypoint performs one sudo transition and coordinates the tracked modular installers. It fails at the first named stage, restores generated configuration files from the transaction snapshot, and leaves credentials and operator-owned overrides untouched. Unit files and their drop-in folders are copied to an owner-only backup before replacement. Re-running it is safe. The reviewed current-host defaults remain Kyle's service account and installed Pi path.

For another account, pass `MI_SERVICE_USER`, `MI_STACK_HOME`, `MI_GATEWAY_SERVICE_USER`, `MI_GATEWAY_SERVICE_HOME`, `MI_GATEWAY_PI_BINARY`, `MI_GATEWAY_PI_COMMAND_DIR`, `MI_GATEWAY_PI_AGENT_DIR`, `MI_GATEWAY_WORK_DIR`, `MI_GATEWAY_HEALTH_COMMAND`, and `MI_GATEWAY_HEALTH_USER` explicitly. The service home must match the account database. Home, Pi command, agent, and work directories must be real account-owned directories. Pi and health commands must be absolute, executable, non-symlink files owned by the selected user or root. See `docs/second-vps-setup.md` for the complete command.

Preview or inspect without mutation or sudo:

```bash
/home/kyle/install-mi-stack.sh --dry-run
/home/kyle/install-mi-stack.sh --check
```

The check reports fixed expected values only: the two production aliases, Photon loopback URL, TLS path shape, helper path, and PATH shape. It also checks that the daemon uses its reviewed private extension path and sandbox settings. It does not dump process environments, registry contents, host DNS names, prompts, or credentials. Gateway readiness uses the existing authenticated local health helper.

Production install first writes the tracked non-secret `coding-main` baseline through the gateway-client stage, then adds `mi-concierge` (medium). It removes installed `mi-eval-*` aliases and overlay state, and preserves unrelated Pi registry providers/models/settings. The production alias stage fails instead of guessing a missing baseline. Evaluation remains an explicit separate cycle:

```bash
sudo /home/kyle/install-mi-model-eval-gateway.sh
npm run eval:mi-models
sudo /home/kyle/uninstall-mi-model-eval-gateway.sh
```

The legacy V1 router remains available through `MI_IMESSAGE_V2=0`; the production registry installed by the stack continues to support shared/V1 callers.

## Safe cleanup manifest

Tracked manifest: `scripts/mi-obsolete-home-entrypoints.tsv`.

The canonical installer archives only a wrapper whose SHA-256 matches its known generated version or which carries a Mi generated marker. Modified and unknown files are reported and preserved. Current cleanup entries are:

- `~/fix-mi-gateway.sh` — obsolete; archive when ownership matches.
- `~/install-mi-subscription-gateway.sh` — superseded by the stack entrypoint; archive when ownership matches.
- `~/install-mi-model-eval-gateway.sh` — replace from tracked source only when ownership matches.
- `~/uninstall-mi-model-eval-gateway.sh` — replace from tracked source only when ownership matches.

The web installer similarly removes only exact known Mi-owned predecessor drop-ins and preserves unrelated content. Photon removes only the exact obsolete `localhost` loopback drop-in; arbitrary administrator files are never removed.

## First safe activation

The stack install writes files only. It does not reload, enable, start, stop, or restart the gateway, web service, Photon bridge, daemon, or timer. It writes `MI_PROACTIVE_IMESSAGE_NOTIFY=false` and `MI_IMESSAGE_MONITOR_ENABLED=false` into the tick unit.

First check the installed paths and sandbox settings: the daemon path must stay under the reviewed Mi root, `PrivateTmp=true`, `ProtectSystem=full`, the service-user PATH must be fixed, writable paths must be limited to the reviewed state, runtime, Mi home, and workflow folders, and both tick settings must be false.

Only after separate approval, reload the unit files. Reloading reads files; it does not start a service:

```bash
/home/kyle/install-mi-stack.sh --check
sudo systemctl daemon-reload
systemctl --user daemon-reload
```

Start each approved service in a separate command. Gateway and Photon approval is separate from Mi daemon approval:

```bash
sudo systemctl start llm-gateway.service
systemctl --user start mi-daemon.service
sudo systemctl start mi-photon-bridge.service
```

Leave `mi-tick.timer`, the web service, proactive notices, and the repair monitor off until each has later, separate approval. Enabling a unit for startup is also a separate approval.

## Rollback

A failed install restores the pre-run generated files and preserves the pre-install active and enabled state of every service. It never reloads, enables, starts, stops, or restarts a service during rollback. The production gateway stage restores its five files as one set if any file write fails. After correcting the named stage, rerun the canonical command and then `--check`.

The gateway-only installer keeps the prior five-file set under `/var/backups/mi-gateway`. Operators who need to restore that set can rerun `scripts/install-mi-subscription-gateway-root.sh --rollback` through the same root boundary and with the same explicit account settings used for install. The command checks that every prior file or absent-file marker exists before changing anything, restores files only, and is safe to repeat.

V1 source and all tracked modular installers are retained; eval harness files are not removed.
