#!/usr/bin/env bash
# Put the offline web build of PokéRogue into dist/.
# The game is built once, in the phone repo (1596941391qq/pokerogue-ios-android, app/src/main/assets/web),
# so Android, iOS and desktop always ship the identical game. game-version.json pins which commit.
#   scripts/fetch-game.sh                       # sparse-clone the pinned commit from GitHub
#   MOBILE_REPO=~/games/pokerogue-android scripts/fetch-game.sh   # copy from a local checkout instead
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"   # relative require() below works on Windows Git Bash too (its /d/... paths are not Node paths)
SRC_REPO="$(node -p "require('./game-version.json').sourceRepo")"
REF="$(node -p "require('./game-version.json').sourceRef")"
WEB=app/src/main/assets/web

if [ -n "${MOBILE_REPO:-}" ]; then
  SRC="$MOBILE_REPO/$WEB"
else
  TMP="$ROOT/.game-src"
  rm -rf "$TMP"
  git clone --quiet --filter=blob:none --no-checkout "https://github.com/$SRC_REPO.git" "$TMP"
  git -C "$TMP" sparse-checkout set --cone "$WEB"   # cone mode: no leading "/" for Git Bash to rewrite into C:/Program Files/Git/...
  git -C "$TMP" checkout --quiet "$REF"
  SRC="$TMP/$WEB"
fi

[ -f "$SRC/index.html" ] || { echo "no game build at $SRC" >&2; exit 1; }
mkdir -p "$ROOT/dist"
rsync -a --delete --exclude .gitkeep "$SRC/" "$ROOT/dist/"
rm -rf "$ROOT/.game-src"
echo "dist/ <- $SRC_REPO@$REF ($(du -sh "$ROOT/dist" | cut -f1))"
