#!/usr/bin/env bash
# Install amp-orchestrator as a system plugin by symlinking this directory into
# the user's plugin directory.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/amp/plugins"
DEST="$DEST_DIR/amp-orchestrator"

mkdir -p "$DEST_DIR"

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
	echo "Refusing to overwrite existing $DEST" >&2
	echo "Remove it first if you want to reinstall." >&2
	exit 1
fi

ln -s "$SRC" "$DEST"
echo "Linked $DEST -> $SRC"
echo "Reload plugins in Amp (command palette: plugins: reload), or restart Amp."
