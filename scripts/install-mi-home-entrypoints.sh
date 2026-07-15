#!/usr/bin/env bash
# Install tracked home wrappers and safely retire only known generated predecessors.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${MI_STACK_HOME:-/home/kyle}"
SOURCE_DIR="$ROOT/scripts/home-entrypoints"
MANIFEST="$ROOT/scripts/mi-obsolete-home-entrypoints.tsv"
ARCHIVE="$HOME_DIR/.local/state/mi/obsolete-entrypoints"
mkdir -p "$ARCHIVE"
chmod 700 "$ARCHIVE"

known_hash() { awk -F '\t' -v name="$1" '$1 == name { print $2 }' "$MANIFEST"; }
owned_or_absent() {
  local target="$1" name expected actual
  [[ -e "$target" ]] || return 0
  grep -q '^# MI-GENERATED:' "$target" 2>/dev/null && return 0
  name=$(basename "$target"); expected=$(known_hash "$name")
  actual=$(sha256sum "$target" | cut -d' ' -f1)
  [[ -n "$expected" && "$actual" == "$expected" ]]
}
install_wrapper() {
  local name="$1" target="$HOME_DIR/$1"
  if ! owned_or_absent "$target"; then
    echo "Preserved unknown or modified home entrypoint: ~/$name" >&2
    return 1
  fi
  install -m 700 "$SOURCE_DIR/$name" "$target.tmp"
  mv -f "$target.tmp" "$target"
}

install_wrapper install-mi-stack.sh
install_wrapper install-mi-model-eval-gateway.sh
install_wrapper uninstall-mi-model-eval-gateway.sh

while IFS=$'\t' read -r name expected action; do
  [[ "$name" == \#* || "$action" != archive-* ]] && continue
  target="$HOME_DIR/$name"
  [[ -e "$target" ]] || continue
  actual=$(sha256sum "$target" | cut -d' ' -f1)
  if [[ "$actual" == "$expected" ]] || grep -q '^# MI-GENERATED:' "$target" 2>/dev/null; then
    install -m 700 "$target" "$ARCHIVE/$name"
    rm -f "$target"
    echo "Archived known obsolete home entrypoint: ~/$name"
  else
    echo "Preserved unknown or modified obsolete entrypoint: ~/$name" >&2
  fi
done < "$MANIFEST"
echo 'Installed tracked Mi home entrypoints (mode 0700)'
