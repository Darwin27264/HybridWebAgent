#!/usr/bin/env bash
# Ofln-Scout One-Click Launcher for Linux / macOS
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not found in your PATH."
  echo "Please install Node.js v20+ to run Ofln-Scout."
  exit 1
fi

# Detect headless Linux environment (no DISPLAY or WAYLAND_DISPLAY)
if [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ] && [ "$#" -eq 0 ]; then
  echo "[Ofln-Scout] Headless server environment detected (no GUI display)."
  echo "[Ofln-Scout] Defaulting to headless daemon mode on port 4040..."
  exec node scripts/launch.mjs --daemon-only --host 0.0.0.0
else
  exec node scripts/launch.mjs "$@"
fi

