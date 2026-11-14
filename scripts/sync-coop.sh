#!/usr/bin/env bash
# Copy the co-op host scripts into coop/ (they are injected into the game page when a room is opened).
# Source: the co-op project's server/public folder (the same files the phone page is served from).
#   scripts/sync-coop.sh                 # default source below
#   COOP_PUBLIC=/path/to/public scripts/sync-coop.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${COOP_PUBLIC:-$HOME/p302-preview/outputs/pokerogue-coop/server/public}"
mkdir -p "$ROOT/coop"
# pack mods/*/ into mods-bundle.js first (the mod loader is host-mods.js)
node "$SRC/../../tools/build-mods.mjs" "$SRC"
for f in coop.js host.js host-team.js host-game.js host-overlay.js host-mods.js mods-bundle.js; do
  [ -f "$SRC/$f" ] || { echo "missing $SRC/$f" >&2; exit 1; }
  node --check "$SRC/$f"   # never bundle a half-edited script
  cp "$SRC/$f" "$ROOT/coop/$f"
done
# the 2P page itself, served by coop-lan.mjs in a LAN room (coop.js is shared by both sides)
cp "$SRC/guest2.html" "$ROOT/coop/guest2.html"
echo "coop/ <- $SRC"
