#!/bin/sh
# Sync the source to the runtime folder (outside ~/Documents, which launchd services can't read)
# and restart the service. Also snapshots the live library into the repo as a backup.
set -eu

LABEL=com.mila.homelibrary
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$HOME/Library/Application Support/HomeLibrary"
LIVE_DATA="$RUNTIME/books.json"

mkdir -p "$RUNTIME/app"
rsync -a --delete \
  --exclude '.git' --exclude 'data' --exclude 'test' --exclude 'scripts' --exclude 'graphify-out' \
  "$APP_DIR/" "$RUNTIME/app/"

# First deploy: seed the live data from the repo copy.
[ -f "$LIVE_DATA" ] || cp "$APP_DIR/data/books.json" "$LIVE_DATA"
# Backup snapshot, tracked in git.
cp "$LIVE_DATA" "$APP_DIR/data/library-backup.json"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  echo "Deployed and restarted."
else
  echo "Deployed. Service not installed yet: run scripts/install-service.sh"
fi
