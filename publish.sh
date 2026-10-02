#!/usr/bin/env bash
# Publish this plugin into the Personal Plugins repository so the Lead/Peer/
# Supervisor modes apply on every machine you use Amp and in orbs.
#
# Override the checkout path with AMP_PERSONAL_PLUGINS if yours lives elsewhere.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${AMP_PERSONAL_PLUGINS:-$HOME/.cache/amp/repositories/ampcode.com-user-plugins}"
DEST="$REPO/amp-orchestrator"

if [ ! -d "$REPO/.git" ]; then
	echo "Personal Plugins checkout not found at $REPO" >&2
	echo "Run 'amp clone user-plugins' or set AMP_PERSONAL_PLUGINS to its path." >&2
	exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/index.ts" "$SRC/lib" "$SRC/profiles" "$DEST/"

cd "$REPO"
git add -A
if git diff --cached --quiet; then
	echo "No changes to publish."
	exit 0
fi
git commit -m "${1:-Update amp-orchestrator}"
git push
echo "Published $DEST"
echo "Reload plugins in Amp (command palette: plugins: reload), or restart the runner."
