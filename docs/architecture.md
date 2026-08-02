# Mi architecture

Mi is a private assistant harness made from Markdown assistants, local state, Pi workers, and small transport services.

## Product parts

### Assistant Builder

The builder creates, edits, and explains `assistants/*.md`. Its output is a normal file change that can be reviewed.

### Assistant Runner

The runner reads an assistant file and starts a short run from an explicit trigger. Run records go to `state/runs/` and `state/runs.jsonl`.

## Runtime parts

### Mi command and Pi extension

`mi` opens the main interface. `mi agents` shows daemon tasks and known Pi sessions. `mi.ts` adds `/mi` only when a user starts Pi with `--extension <reviewed Mi path>`; it is never globally auto-loaded.

### Mi daemon

`$MI_ROOT/pi/extensions/mi-daemon.mjs` owns the local worker socket and background task records. The user unit and on-demand launches use that explicit reviewed path. Its default runtime directory is `~/.pi/agent/mi`. Scoped workers get short-lived capability files and a reduced environment. Read workers get read tools. Write workers are allowed only inside the configured workflows directory.

### iMessage runtime

The Photon bridge calls `scripts/mi-imessage-runtime.mjs` directly. The runtime stores one private JSONL Pi session per normalized conversation and starts Pi only for a turn. It resumes the exact session path with `--mode rpc --session` and exits after settlement. It does not copy thread history into the prompt.

The runtime loads only the reviewed capability guard, adapter, and Diver Notes extension. A policy binds the request to one real workspace root and working directory. High-impact work needs exact confirmation. Delegated work uses the reviewed Mi daemon path, and the runtime waits for terminal evidence before it reports completion.

### Advisor workers

A direct Seth or Alex request uses one separate Sol-High worker for each selected advisor. Each worker gets the `advisor-read` profile and explicitly loads only the trusted advisor skill. If the model, worker, skill, socket, or complete task list is unavailable, the adapter fails closed and Mi must not claim an advisor result.

### Photon bridge

`scripts/mi-photon-bridge.mjs` is the only normal service and iMessage transport adapter. It accepts only configured Photon users unless an unsafe development override is set. It calls the focused runtime directly and offers a separate loopback-only endpoint for outbound notices.

### Mi tick

`src/tick.ts` is deliberately small. One locked run:

1. runs due reminder crons;
2. removes expired capability grants;
3. runs memory consolidation when due; and
4. runs the iMessage repair monitor.

It does not run the removed proactive check-in, configured monitor registry, daily brief, or automatic project-question and project-summary loops.

## State boundaries

State has three main roots:

- `$MI_ROOT/state` for threads, events, approvals, memory, web state, and iMessage repair records;
- `~/mi/state` for crons and daemon task-list state; and
- `~/.pi/agent/mi` for daemon sockets, logs, grants, and coordinator files.

Normal iMessage sessions live under `$MI_ROOT/state/imessage/conversations/`. Delivery records use owner-only directories and files. File modes for private state, policy, grant, key, and socket directories are set to owner-only where the code creates them. Completed delivery records retain sanitized replies but erase raw message text.

## Safety boundary

Mi does not treat model text, files, web content, or worker output as authority. The current request and its stored policy set the allowed goal and workspace. High-impact work needs confirmation, and some work is never delegated from iMessage. Mi does not expose a public control UI by default. Notification links must not become control links.
