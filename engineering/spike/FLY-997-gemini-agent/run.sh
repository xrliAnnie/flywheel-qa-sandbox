#!/bin/bash
# FLY-997 spike launcher — scrubs production Bridge env (sandbox guard runs
# inside node and fail-closes if these survive), resolves GEMINI_API_KEY.
# Usage: ./run.sh <script.mjs> [args...]
set -euo pipefail
cd "$(dirname "$0")"

# Resolve GEMINI_API_KEY without echoing it. On this machine the Gemini
# AI-Studio key lives in ~/.zshrc as NANOBANANA_GEMINI_API_KEY (same Google
# project as voice/image use). Never printed.
if [ -z "${GEMINI_API_KEY:-}" ]; then
  key_line=$(grep -m1 '^export NANOBANANA_GEMINI_API_KEY=' ~/.zshrc || true)
  if [ -n "$key_line" ]; then
    export GEMINI_API_KEY="${key_line#export NANOBANANA_GEMINI_API_KEY=}"
    # strip optional surrounding quotes
    GEMINI_API_KEY="${GEMINI_API_KEY%\"}"; GEMINI_API_KEY="${GEMINI_API_KEY#\"}"
    export GEMINI_API_KEY
  fi
fi
if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "[run.sh] GEMINI_API_KEY not resolvable — aborting" >&2
  exit 78
fi

exec env -u BRIDGE_URL -u FLYWHEEL_BRIDGE_URL -u TEAMLEAD_API_TOKEN -u LINEAR_API_KEY \
  node "$@"
