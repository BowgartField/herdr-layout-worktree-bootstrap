#!/bin/sh
# Install this repository's mods and layout as personal copies in a Herdr app
# home. Needs only sh: no Python, Node or build step.
#
#   sh tools/install.sh [--activate] [--app-home DIR] [--no-check]
#
# Never touches shipped mods or layouts. Refuses to overwrite a file it did not
# install, or one edited since it installed it. Re-running updates its own files.
set -eu
umask 022

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
HOME_DIR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
ACTIVATE=0
CHECK=1
while [ $# -gt 0 ]; do
  case $1 in
    --activate) ACTIVATE=1 ;;
    --no-check) CHECK=0 ;;
    --app-home) [ $# -ge 2 ] || { echo "--app-home needs a folder" >&2; exit 2; }; HOME_DIR=$2; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$HOME_DIR"
HOME_DIR=$(cd "$HOME_DIR" && pwd -P)
STATE=$HOME_DIR/data/worktree-bootstrap
MANIFEST=$STATE/install.manifest
LEGACY=$STATE/install.json

sum() { cksum < "$1" | awk '{ print $1 "-" $2 }'; }
sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'
  fi
}
# Whether this installer owns REL and it is unchanged since.
owned() {
  [ -f "$MANIFEST" ] && grep -qxF "$(sum "$HOME_DIR/$1") $1" "$MANIFEST" && return 0
  # Files recorded by the former Python installer (sha256).
  [ -f "$LEGACY" ] || return 1
  _want=$(sed -n "s|^ *\"$(printf '%s' "$1" | sed 's/[.[\*^$|]/\\&/g')\": \"\\([0-9a-f]\\{64\\}\\)\",\\{0,1\\}\$|\\1|p" "$LEGACY")
  [ -n "$_want" ] && [ "$(sha256 "$HOME_DIR/$1")" = "$_want" ]
}

# mod.json first: Herdr docks a new mod folder by its mod.json the moment it
# sees it, so a folder seen without one would be docked at the default place.
FILES=$(cd "$ROOT" && {
  find mods -mindepth 2 -maxdepth 2 -type f -name mod.json | sort
  find mods -mindepth 2 -maxdepth 2 -type f \( -name '*.js' -o -name '*.svg' \) | sort
  echo layouts/worktree-bootstrap.json
})

for rel in $FILES; do
  if [ -e "$HOME_DIR/$rel" ] && ! owned "$rel"; then
    echo "Refusing to overwrite an existing or independently edited file: $HOME_DIR/$rel" >&2
    exit 1
  fi
done

NEW=$(mktemp "${TMPDIR:-/tmp}/worktree-bootstrap.XXXXXX")
trap 'rm -f "$NEW"' EXIT
for rel in $FILES; do
  mkdir -p "$(dirname "$HOME_DIR/$rel")"
  cp "$ROOT/$rel" "$HOME_DIR/$rel.installing"
  mv -f "$HOME_DIR/$rel.installing" "$HOME_DIR/$rel"
  printf '%s %s\n' "$(sum "$HOME_DIR/$rel")" "$rel" >> "$NEW"
done

# Files a former version installed and nobody edited: the Python runtime and
# shared modules that moved. Edited ones are left in place.
for old in $( { [ -f "$MANIFEST" ] && awk '{ print $2 }' "$MANIFEST"; [ -f "$LEGACY" ] && sed -n 's/^ *"\([^"]*\)": "[0-9a-f]\{64\}",\{0,1\}$/\1/p' "$LEGACY"; } | sort -u); do
  case " $(echo $FILES) " in *" $old "*) continue ;; esac
  if [ -f "$HOME_DIR/$old" ] && owned "$old"; then
    rm -f "$HOME_DIR/$old"
    rmdir "$(dirname "$HOME_DIR/$old")" 2>/dev/null || true
  fi
done
rm -rf "$STATE/runtime/vendor/__pycache__" "$STATE/runtime/__pycache__" 2>/dev/null || true
rmdir "$STATE/runtime/vendor" 2>/dev/null || true

mkdir -p "$STATE"
mv -f "$NEW" "$MANIFEST"
chmod 644 "$MANIFEST"
rm -f "$LEGACY"

if [ "$CHECK" = 1 ]; then
  for dir in "$ROOT"/mods/*/; do
    herdr-app check "$HOME_DIR/mods/$(basename "$dir")"
  done
fi
if [ "$ACTIVATE" = 1 ]; then
  herdr-app do layout.switch '{"name":"worktree-bootstrap"}'
fi
echo "Installed worktree-bootstrap. Switch with: herdr-app do layout.switch '{\"name\":\"worktree-bootstrap\"}'"
