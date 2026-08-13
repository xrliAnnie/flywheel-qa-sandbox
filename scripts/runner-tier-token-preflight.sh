#!/bin/bash
# FLY-1715 production preflight for the master/runner credential split.
# Emits boolean verdicts only; token bytes are never printed.
set -euo pipefail

ENV_FILE="${1:-$HOME/.flywheel/.env}"
if [[ -L "$ENV_FILE" ]]; then
  echo "[runner-tier-token-preflight] REFUSE: $ENV_FILE is a symlink" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[runner-tier-token-preflight] REFUSE: $ENV_FILE is not a regular file" >&2
  exit 1
fi

# The file is the deployment source of truth. Ambient credentials from the
# invoking shell must not make an incomplete production config appear healthy.
unset TEAMLEAD_API_TOKEN TEAMLEAD_INGEST_TOKEN TEAMLEAD_GEMINI_AGENT_TOKEN
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

set +e
python3 <<'PY'
import json
import os

master_raw = os.environ.get("TEAMLEAD_API_TOKEN")
ingest_raw = os.environ.get("TEAMLEAD_INGEST_TOKEN")
gemini_raw = os.environ.get("TEAMLEAD_GEMINI_AGENT_TOKEN")

def normalized(value):
    if value is None:
        return None
    stripped = value.strip()
    return stripped if stripped else None

master = normalized(master_raw)
ingest = normalized(ingest_raw)
gemini = normalized(gemini_raw)
present_values = [value for value in (master, ingest, gemini) if value is not None]
pairwise_distinct = len(set(present_values)) == len(present_values)
master_padded = master_raw is not None and master_raw != master_raw.strip()
ok = master is not None and ingest is not None and pairwise_distinct and not master_padded

print(json.dumps({
    "master_present": master is not None,
    "ingest_present": ingest is not None,
    "gemini_present": gemini is not None,
    "pairwise_distinct": pairwise_distinct,
    "master_padded": master_padded,
    "ok": ok,
}, separators=(",", ":"), sort_keys=True))
raise SystemExit(0 if ok else 1)
PY
rc=$?
set -e
exit "$rc"
