# Assistant File Format

Mi assistants are plain Markdown files in `assistants/*.md`.

Each assistant has YAML-like frontmatter followed by Markdown instructions:

```md
---
name: production
triggers:
  - every: 10m
tools:
  - github
  - railway
  - cloudflare
  - pi
permissions:
  github:
    actions: read
    contents: write
    pull_requests: write
  railway:
    deployments: read
    logs: read
  cloudflare:
    status: read
  production:
    deploy: false
    mutate_dns: false
    edit_secrets: false
    merge_code: false
---
# Production Assistant
Watch production health.

When everything is healthy, report:
> All clear.

When something needs attention:
1. Identify the most likely source.
2. Gather the smallest useful context.
3. If the issue appears code-related, start a pi repair worker.
4. Never merge, deploy, edit secrets, change DNS, or change production settings.
```

## Frontmatter

Required:

- `name`: stable assistant name; maps to `assistants/<name>.md`.
- `triggers`: one or more trigger declarations.
- `tools`: list of tool/integration names. Empty list is allowed.
- `permissions`: per-tool/per-domain permission map. Empty map is allowed.

Supported trigger forms for v0:

```yaml
triggers:
  - manual: true
  - every: 10m
  - webhook: github-actions-failed
  - event: railway-deploy-failed
```

Supported scalar permission values for v0:

- `read`
- `write`
- `true`
- `false`

## Instructions

The Markdown body is the assistant's instructions. It should include:

- goal
- what to watch or handle
- when to start workers
- safety rules
- reporting behavior

Runtime assistants may suggest changes to this file but must not silently rewrite their own instructions.
