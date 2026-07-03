# Mi testing

Use targeted tests while developing and `npm test` for full certification. Tests are hermetic by default: they should run with temporary `HOME`, fake Pi binaries, `MI_DAEMON_SYSTEMD=0`, disabled notifications, and no real secrets or live integrations.

## Agent-view tests

- `scripts/test-mi-agent-view.mjs`: core CLI/agents view behavior.
- `scripts/test-mi-agent-extension-parity.mjs`: command inventory/classification and native dispatch paths for worker-forward, background-task, headless-exec, blocked, and unknown slash commands.
- `scripts/test-mi-agent-render-snapshot.mjs`: render snapshots and scripted TUI interactions.
- `scripts/test-mi-agent-dedupe.mjs`: task de-duplication and optimistic task reconciliation.
- `scripts/test-mi-daemon-singleton.mjs`: daemon singleton/lock behavior.
- `scripts/test-mi-daemon-pi-session-e2e.mjs`: Pi session discovery/resume daemon behavior.
- `scripts/test-mi-agent-e2e.mjs`: live TUI subprocess scenarios against a fake daemon.
- `scripts/test-mi-task-notifications.mjs`: task notification state transitions.

Run the subset with:

```sh
npm run test:agents
```

## Harness contract

Prefer `scripts/mi-test-harness.mjs` for new tests. It provides temporary paths, a fake `pi`, `MI_SOCKET_PATH`, `MI_RUNTIME_DIR`, `MI_DAEMON_SYSTEMD=0`, disabled proactive/notification integrations, and helpers for fake daemons and JSONL assertions.

Useful render-test knobs:

- `MI_AGENT_RENDER_TEST=1`
- `MI_AGENT_RENDER_TEST_TASKS=<json fixture>`
- `MI_AGENT_RENDER_TEST_EVENTS=<comma separated events>`
- `MI_AGENT_RENDER_TEST_ROWS=<rows>`
- `MI_AGENT_RENDER_TEST_COLS=<cols>`
- `MI_AGENT_RENDER_TEST_DISPATCH_LOG=<jsonl path>` for slash dispatch assertions

Live smoke remains gated behind `MI_LIVE_SMOKE=1` and must not run in normal tests.
