#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/ubuntu/Gambino-Bot"
STATE_DIR="/home/ubuntu/.local/state/gambino-bot"
STATE_FILE="$STATE_DIR/deployed-commit"
LOCK_FILE="/home/ubuntu/.cache/gambino-bot-deploy.lock"

mkdir -p "$STATE_DIR" "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

cd "$APP_DIR"
git fetch --quiet origin main
target_commit="$(git rev-parse origin/main)"
deployed_commit=""
if [[ -f "$STATE_FILE" ]]; then
  deployed_commit="$(cat "$STATE_FILE")"
fi
if [[ "$target_commit" == "$deployed_commit" ]]; then
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Deployment abgebrochen: Das Arbeitsverzeichnis auf der VM enthält lokale Änderungen." >&2
  exit 1
fi
if ! git merge-base --is-ancestor HEAD "$target_commit"; then
  echo "Deployment abgebrochen: origin/main ist kein Fast-Forward von HEAD." >&2
  exit 1
fi

git merge --ff-only "$target_commit"
npm run deploy-commands
pm2 restart gambino-bot
sleep 5
if ! pm2 describe gambino-bot | grep -Eq 'status[[:space:]]+│[[:space:]]+online'; then
  echo "Deployment fehlgeschlagen: gambino-bot ist nach dem Neustart nicht online." >&2
  exit 1
fi

printf '%s\n' "$target_commit" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
echo "Gambino Bot erfolgreich auf $target_commit aktualisiert."
