#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Refusing to update or deploy Mi from a dirty tree. Commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

origin_url="$(git remote get-url origin 2>/dev/null || true)"
case "$origin_url" in
  https://github.com/kyleboas/mi|https://github.com/kyleboas/mi.git|git@github.com:kyleboas/mi|git@github.com:kyleboas/mi.git|ssh://git@github.com/kyleboas/mi|ssh://git@github.com/kyleboas/mi.git) ;;
  *)
    echo "Refusing to update: origin must identify github.com/kyleboas/mi (got ${origin_url:-missing})." >&2
    exit 1
    ;;
esac

prior_ref="$(git symbolic-ref --quiet --short HEAD || true)"
prior_commit="$(git rev-parse --verify HEAD)"
[[ -n "$prior_ref" ]] || prior_ref="detached HEAD"
rollback_branch="mi-deploy-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
echo "Previous checkout: $prior_ref at $prior_commit"

# Keep a uniquely named local branch for the prior reviewed commit. This never
# moves or overwrites a user branch and remains available after this script.
git branch "$rollback_branch" "$prior_commit"
echo "Rollback branch: $rollback_branch"

# Fetch exactly the reviewed upstream branch. The dedicated deployment branch
# is the only local branch this command creates or advances; local main and
# the operator's prior branch are never switched or modified.
git fetch --no-tags origin main:refs/remotes/origin/main
deployment_branch="deploy/mi"
if git show-ref --verify --quiet "refs/heads/$deployment_branch"; then
  if ! git merge-base --is-ancestor "$deployment_branch" origin/main; then
    echo "Refusing to update: $deployment_branch is not a fast-forward ancestor of origin/main. Resolve it manually; deploy will not rewrite it." >&2
    exit 1
  fi
  git switch "$deployment_branch"
  git merge --ff-only origin/main
else
  git switch -c "$deployment_branch" --track origin/main
fi

deployed_commit="$(git rev-parse --verify "$deployment_branch")"
post_update=1
rollback_hint() {
  echo "Update did not complete. Recovery: git switch --detach $rollback_branch && npm ci && npm run build" >&2
  echo "If services were restarted, restart them manually after recovery; deploy does not roll them back automatically." >&2
}
on_error() {
  local status=$?
  if [[ $post_update -eq 1 ]]; then
    rollback_hint
  fi
  exit "$status"
}
trap on_error ERR

echo "Updating dependencies for $deployed_commit"
npm ci
npm run build
npm test

# Mi runs from this reviewed tree. Never copy Mi files into Pi's global
# auto-load directory.
for file in pi/extensions/mi-daemon.mjs pi/extensions/mi-capability-guard.ts pi/extensions/mi-orchestrator-adapter.ts pi/extensions/mi.ts; do
  [[ -f "$file" ]] || { echo "Missing reviewed Mi file: $file" >&2; exit 1; }
done

# Run canaries after the build and full test suite, before restarting services. A failed canary changes no deployed
# files; roll back by checking out the prior reviewed commit before activation.
MI_AUTO_ACTIONS_ENABLED=false \
MI_IMESSAGE_MONITOR_ENABLED=false \
MI_DAILY_BRIEF=false \
MI_QUESTIONS_ENABLED=false \
PUSHOVER_USER= \
PUSHOVER_TOKEN= \
node scripts/test-mi-tick.mjs

MI_AUTO_ACTIONS_ENABLED=false \
MI_IMESSAGE_MONITOR_ENABLED=false \
MI_DAILY_BRIEF=false \
MI_QUESTIONS_ENABLED=false \
PUSHOVER_USER= \
PUSHOVER_TOKEN= \
MI_ROOT="$ROOT" \
MI_DAEMON_SYSTEMD=0 \
node dist/src/cli.js tick

restarted_units=()
restart_user_unit() {
  local unit="$1"
  # A deploy refreshes only a unit that was already running. try-restart keeps
  # this true even if it stops between the check and the command.
  if systemctl --user is-active --quiet "$unit"; then
    systemctl --user try-restart "$unit"
    systemctl --user is-active --quiet "$unit"
    restarted_units+=("$unit")
  fi
}

restart_system_unit() {
  local unit="$1"
  # sudo is deliberately interactive: this manual operator path must not rely
  # on a passwordless privilege grant.
  if sudo systemctl is-active --quiet "$unit"; then
    sudo systemctl restart "$unit"
    sudo systemctl is-active --quiet "$unit"
    restarted_units+=("$unit")
  fi
}

restart_user_unit mi-daemon.service
restart_user_unit mi-web-chat.service
# A deploy does not wake scheduled or outbound work unless an operator makes a
# separate, explicit choice and supplies both safety values.
if [[ ${MI_DEPLOY_ACTIVATE_TIMER:-0} == 1 ]]; then
  [[ -n ${MI_PROACTIVE_IMESSAGE_NOTIFY+x} && -n ${MI_IMESSAGE_MONITOR_ENABLED+x} ]] || { echo 'Timer activation requires explicit notice and monitor values.' >&2; exit 1; }
  restart_user_unit mi-tick.timer
fi
restart_system_unit mi-photon-bridge.service

trap - ERR
echo "Mi deploy complete at $deployed_commit. Mi execution files remain under $ROOT/pi/extensions."
if ((${#restarted_units[@]})); then
  printf 'Restarted and verified: %s\n' "${restarted_units[*]}"
else
  echo "No active Mi services were restarted."
fi
