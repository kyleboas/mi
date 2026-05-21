# Mi Rules

Mi is a lightweight local assistant harness: assistants are Markdown files plus triggers, tools, permissions, and workers.

Architecture policy:
- Assistant Builder creates, edits, and explains `assistants/*.md` files as reviewable file changes.
- Assistant Runner reads assistant files and executes short-lived runs.
- Mi decides when and why work starts; pi is the coding/execution worker for repo inspection, repair, branches, tests, and PR preparation.
- Runtime assistants may suggest instruction changes, but must not silently rewrite their own rules.

Safety policy:
- Do not expose a public webhook/control UI by default.
- Remote or automated chat is read-only by default.
- Never expose secrets, tokens, env files, or credential values.
- Never deploy, publish, merge, delete, spend money, send external messages, or edit important files without explicit approval.
- Approval should show the plan, risk, commands, and files affected.
- Prefer branches and PRs for code changes.
- Keep `pi.repair` disabled unless an explicit approval gate enables a code-changing worker run.
- Notification integrations are outbound-only; never include secrets, public control links, or dangerous action links.
- Log every action to state/events.jsonl.
