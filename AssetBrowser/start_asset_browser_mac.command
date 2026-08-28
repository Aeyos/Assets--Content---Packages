#!/usr/bin/env bash
# Launches the Asset Browser server on macOS.
#
# Double-click this file in Finder (or run it from a terminal). It installs
# dependencies on first run, warns (without blocking) if the F3D CLI isn't
# available for server-side thumbnail generation, starts the server, and
# opens it in your default browser once it's up.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-4747}"
URL="http://localhost:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found on PATH. Install it from https://nodejs.org (or 'brew install node') and try again." >&2
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

if [ -z "${F3D_BIN:-}" ] && ! command -v f3d >/dev/null 2>&1; then
  echo "Warning: no 'f3d' executable found on PATH and F3D_BIN is not set." >&2
  echo "         3D model thumbnails will fail to generate until F3D is installed (https://f3d.app, or 'brew install f3d')." >&2
  echo "         Everything else - indexing, tagging, search, the in-browser 3D/image/audio previews - is unaffected." >&2
fi

open_browser() {
  # Give the server a moment to start listening before opening the tab.
  sleep 1.5
  open "$URL" >/dev/null 2>&1 &
}
open_browser &

echo "Starting Asset Browser at $URL (Ctrl+C to stop, or just close this window)"
exec node server.js
