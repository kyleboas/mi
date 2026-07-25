# iMessage repair monitoring

Mi's active monitor is the iMessage send-failure repair monitor in `src/imessage-monitor.ts`. `mi tick` calls it after reminder, capability-file, and memory upkeep.

The old configured health-monitor registry is retired. `mi tick` does not read `assistants/monitors.md`, health sidecars, or `state/monitor-health.json`, and it does not start repair workers from monitor rows.

## What the repair monitor checks

By default it runs no more than once every 15 minutes. It checks:

- `mi-photon-bridge.service` status;
- recent Photon service logs;
- the Photon bridge's loopback notification endpoint; and
- recent Mi-thread iMessage activity.

Set `MI_IMESSAGE_MONITOR_ENABLED=false` to turn it off. Change the interval with `MI_IMESSAGE_MONITOR_INTERVAL_MS`.

## Repair limits

A repair attempt restarts `mi-photon-bridge.service` and the user services in `MI_IMESSAGE_REPAIR_USER_SERVICES`. The default user services are `mi-web-chat.service,mi-daemon.service`. It then checks whether the bridge recovered.

The system service restart works only when the narrow rule from this script is installed:

```bash
sudo MI_USER="$(id -un)" ./scripts/install-mi-imessage-repair-sudoers-root.sh
```

That rule permits only `systemctl restart mi-photon-bridge.service`.

## Reports and state

Recovered failures can send a short iMessage through the local notify endpoint. Unrepaired failures are written to Mi main. Pushover fallback is off unless `MI_PUSHOVER_FALLBACK=1` or `MI_PUSHOVER_NOTIFY=1`.

The monitor stores:

- `state/imessage-monitor-state.json` for its last-run and open-incident state; and
- `state/imessage-monitor.jsonl` for incident records.

It removes URLs, redacts secret-like text, and limits stored details and previews.

## Service checks

Use normal service commands without printing service environments:

```bash
systemctl --user status mi-tick.timer mi-web-chat.service mi-daemon.service
sudo systemctl status mi-photon-bridge.service
sudo journalctl -u mi-photon-bridge.service -n 100
```

The complete stack has a non-secret check mode:

```bash
~/install-mi-stack.sh --check
```
