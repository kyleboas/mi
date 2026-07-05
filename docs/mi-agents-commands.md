# Mi agents slash command dispatch

This table is the reviewable command classification for the `mi agents` view. New Pi extension commands should be added here and to the dispatch table before they are usable from `mi agents`.

| Command | Class | Reason |
| --- | --- | --- |
| `/new` | native-mi | Start a Mi background task in the agents view. |
| `/mi` | native-mi | Ask Mi about the selected task. |
| `/quit` | native-mi | Exit the agents view. |
| `/resume` | native-mi | Add existing Pi sessions as Mi tasks with the Mi resume picker. |
| `/open` | native-mi | The only intentional path that opens interactive Pi for a selected session. |
| `/model` | native-mi | Uses the Mi-side model picker. |
| `/scoped-models` | native-mi | Uses the Mi-side scoped-model picker. |
| `/marker` | worker-forward | Session-scoped incremental workflow command. |
| `/end` | worker-forward | Session-scoped incremental workflow command. |
| `/goal` | worker-forward | Session-scoped goal command. |
| `/todos` | worker-forward | Session-scoped checklist command. |
| `/caveman` | worker-forward | Session-scoped mode command. |
| `/cycle-models` | worker-forward | Session-scoped model cycling command. |
| `/auto` | worker-forward | Session-scoped auto/compaction command. |
| `/cd` | worker-forward | Session-scoped directory change command. |
| `/rtk` | worker-forward | Session-scoped RTK command. |
| `/detect` | background-task | Starts standalone background work. |
| `/plan` | background-task | Starts standalone planning work. |
| `/council` | background-task | Starts standalone council work. |
| `/codex` | background-task | Starts standalone Codex work. |
| `/grilling` | background-task | Starts standalone grilling work. |
| `/loop-me` | background-task | Starts standalone loop-capture work. |
| `/tasks` | headless-exec | Query/status command rendered in Mi without a task. |
| `/linear-status` | headless-exec | Query/status command rendered in Mi without a task. |
| `/pushover-test` | headless-exec | Short one-shot integration check rendered in Mi. |
| `/pushover-config` | headless-exec | Query/config status rendered in Mi. |
| `/secret` | headless-exec | One-shot broker command; output is redacted by Mi. |
| `/secret-export` | headless-exec | One-shot broker command; output is redacted by Mi. |
| `/push` | headless-exec | One-shot push command rendered in Mi. |
| `/restart` | headless-exec | One-shot restart command rendered in Mi. |
| `/browser-reset` | headless-exec | One-shot browser reset rendered in Mi. |
| `/settings` | blocked | Pi application settings UI; no Mi equivalent yet. |
| `/login` | blocked | Pi authentication UI; no Mi equivalent yet. |
| `/logout` | blocked | Pi authentication UI; no Mi equivalent yet. |
| `/reload` | blocked | Pi application reload command; no Mi equivalent needed yet. |
| `/hotkeys` | blocked | Pi application help UI; no Mi equivalent yet. |
| `/changelog` | blocked | Pi application changelog UI; no Mi equivalent yet. |

Classes:

- `native-mi`: implemented directly by the agents view.
- `worker-forward`: sent to the selected worker session over the Mi daemon `continue_worker` path.
- `background-task`: starts a new Mi background task over the daemon `run_worker` path.
- `headless-exec`: runs `pi --mode json <command>` and renders/redacts the result in the Mi status area.
- `blocked`: deliberate Pi-app-only exception with a stated reason.
