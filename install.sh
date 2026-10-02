#!/usr/bin/env bash
# Install amp-orchestrator as a system plugin.
#
# Amp does not follow a symlinked plugin *directory* in the plugins directory, so
# this copies the plugin files instead. Re-run after editing the repo to update
# the installed copy (use --force to overwrite).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/amp/plugins"
DEST="$DEST_DIR/amp-orchestrator"

mkdir -p "$DEST_DIR"

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
	if [ "${1:-}" = "--force" ]; then
		rm -rf "$DEST"
	else
		echo "Refusing to overwrite existing $DEST" >&2
		echo "Re-run with --force to replace it." >&2
		exit 1
	fi
fi

mkdir -p "$DEST"
cp -R "$SRC/index.ts" "$SRC/lib" "$SRC/profiles" "$DEST/"

echo "Installed $DEST"
echo "Reload plugins in Amp (command palette: plugins: reload), or restart Amp."
