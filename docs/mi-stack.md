# Mi stack operator guide

## Production install or repair

Run one command as Kyle:

```bash
/home/kyle/install-mi-stack.sh
```

The entrypoint performs one sudo transition and coordinates the tracked modular installers. It fails at the first named stage, restores generated configuration files from the transaction snapshot, and leaves credentials and operator-owned overrides untouched. Re-running it is idempotent.

Preview or inspect without mutation or sudo:

```bash
/home/kyle/install-mi-stack.sh --dry-run
/home/kyle/install-mi-stack.sh --check
```

The check reports service health and fixed expected values only: the two production aliases, Photon loopback URL, TLS path shape, helper path, and PATH shape. It does not dump process environments, registry contents, host DNS names, prompts, or credentials. Gateway readiness uses the existing authenticated local health helper.

Production install restores `coding-main` (implicit high) and `mi-concierge` (medium), removes installed `mi-eval-*` aliases and overlay state, and preserves unrelated Pi registry providers/models/settings. Evaluation remains an explicit separate cycle:

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

## Rollback

A failed install restores the pre-run generated files. After correcting the named stage, rerun the canonical command and then `--check`. V1 source and all tracked modular installers are retained; eval harness files are not removed.
