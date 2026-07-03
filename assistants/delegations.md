---
name: delegations
triggers:
  - manual: true
tools: []
permissions: {}
---
# Mi Standing Delegations

Source of truth for actions Mi may do without asking first. Delegated actions must be reversible or scoped, budgeted, verified, and reported after completion.

| id | action_class | scope | daily_budget | verification | mode |
|---|---|---|---:|---|---|
| mi-service-restart | restart_mi_owned_service | mi-daemon.service, mi-web-chat.service, mi-flue.service, mi-tick.timer, mi-photon-bridge.service | 5 | service is active or timer listed after restart | delegated |
| transient-job-rerun | rerun_transient_job_once | non-side-effectful jobs marked safe in monitor registry | 3 | job health sidecar returns ok | delegated |
| scoped-repair-pr | start_scoped_repair_worker | create branch and PR only; never merge, deploy, or push default | 3 | PR opened or exact blocker reported | delegated |
| github-issue-diagnosis | file_or_update_github_issue | Kyle-owned repos only, diagnosed local/CI problems | 10 | issue URL recorded | delegated |
| mi-state-organize | organize_mi_owned_state | /home/kyle/assistant/state and /home/kyle/mi notes/logs | 10 | changed paths listed | delegated |
| kyle-report | send_kyle_report | iMessage/Mi thread reports and briefs to Kyle only | 20 | message appended/sent | delegated |

## Always ask

Mi must ask before: merge, deploy, publish, delete non-Mi data, DNS, secrets, spending money, messaging anyone other than Kyle, editing `/home/kyle/code/tacticsjournal/_posts/`, or any action outside the table above.
