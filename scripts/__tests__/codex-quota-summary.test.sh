#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SCRIPT="$ROOT/scripts/lib/codex-quota-summary.mjs"
mkdir -p "$TMP/state/codex-quota"
node "$SCRIPT" --state-root "$TMP/state" > "$TMP/result"
grep -Fxq 'CODEX_SWITCH none' "$TMP/result"
cat > "$TMP/state/codex-quota/switch-audit.jsonl" <<'ROWS'
{"schemaVersion":1,"switchId":"switch-1","incidentId":"incident-1","at":"2026-09-09T11:00:00.000Z","vendor":"codex","from":"business","to":"school","reason":"usage_limit","probeResult":"ok","committed":true,"generation":2,"recoveredCount":6,"targetCount":6}
{"schemaVersion":1,"switchId":"switch-2","incidentId":"incident-2","at":"2026-09-09T11:30:00.000Z","vendor":"codex","from":"school","to":"personal","reason":"probe_failed","probeResult":"failed","committed":false,"generation":2,"recoveredCount":0,"targetCount":1}
ROWS
cp "$TMP/state/codex-quota/switch-audit.jsonl" "$TMP/valid-audit"
node "$SCRIPT" --state-root "$TMP/state" > "$TMP/result"
grep -Fq 'from=business to=school reason=usage_limit probe=ok committed=true generation=2 recovered=6/6' "$TMP/result"
grep -Fq 'probe=failed committed=false' "$TMP/result"
printf '{"partial":' >> "$TMP/state/codex-quota/switch-audit.jsonl"
node "$SCRIPT" --state-root "$TMP/state" > "$TMP/result"
[ "$(grep -c '^CODEX_SWITCH at=' "$TMP/result")" = 2 ]
printf '\n' >> "$TMP/state/codex-quota/switch-audit.jsonl"
node "$SCRIPT" --state-root "$TMP/state" > "$TMP/result"
grep -Fxq 'CODEX_SWITCH unavailable' "$TMP/result"
echo 'PASS codex quota summary'
# STEP 2 uses the same helper in the source and packaged runtime layouts.
rm "$TMP/state/codex-quota/switch-audit.jsonl"
FLYWHEEL_STATE_DIR="$TMP/state" FLYWHEEL_STATE_DB_PATH="$TMP/missing.db" FLYWHEEL_PROJECTS_FILE="$TMP/missing.json" HOME="$TMP/home" bash "$ROOT/scripts/lead-patrol-snapshot.sh" --project test --lead test-lead > "$TMP/patrol"
grep -Fxq 'CODEX_SWITCH none' "$TMP/patrol"
# Assemble through the actual payload whitelist, then exercise both converger
# branches and a flat state/bin invocation (helper is never copied by the test).
env PACKAGE_ONBOARD_SOURCED=1 bash -c 'source "$1"; po_copy_curated_scripts "$2" "$3"' _ "$ROOT/scripts/package-onboard.sh" "$ROOT" "$TMP/payload"
cp "$ROOT/scripts/restart-services.sh" "$TMP/payload/scripts/"
printf 'gitdir: /main/.git/worktrees/quota-fixture\n' > "$TMP/payload/.git"
printf '#!/bin/bash\nprintf "alert\\n" >> "$FLY2465_ALERT_LOG"\n' > "$TMP/alert.sh"
COPY_FILES="$(sed -n 's/^FILES="\(.*\)"/\1/p' "$TMP/payload/scripts/converge-flywheel-bin.sh" | head -1)"
for mode in normal packaged; do
  state="$TMP/$mode-state"
  mkdir -p "$state/bin/lib"
  for file in $COPY_FILES; do
    [ "$file" != lib/codex-quota-summary.mjs ] || continue
    cp "$TMP/payload/scripts/$file" "$state/bin/$file"
    chmod 555 "$state/bin/$file"
  done
  if [ "$mode" = packaged ]; then echo test > "$TMP/payload/.flywheel-prebuilt"; fi
  FLY2465_ALERT_LOG="$TMP/alerts-$mode" FLYWHEEL_CONVERGE_ALERT_BIN="$TMP/alert.sh" FLYWHEEL_STATE_DIR="$state" HOME="$TMP/home" bash "$TMP/payload/scripts/converge-flywheel-bin.sh" > "$TMP/converge-$mode" 2>&1
  [ ! -s "$TMP/alerts-$mode" ]
  cmp "$ROOT/scripts/lib/codex-quota-summary.mjs" "$state/bin/lib/codex-quota-summary.mjs"
  mkdir -p "$state/codex-quota"
  cp "$TMP/valid-audit" "$state/codex-quota/switch-audit.jsonl"
  cp "$TMP/payload/scripts/lead-patrol-snapshot.sh" "$state/bin/flywheel-patrol-snapshot"
  FLYWHEEL_STATE_DIR="$state" FLYWHEEL_STATE_DB_PATH="$TMP/missing.db" FLYWHEEL_PROJECTS_FILE="$TMP/missing.json" HOME="$TMP/home" bash "$state/bin/flywheel-patrol-snapshot" --project test --lead test-lead > "$TMP/patrol-$mode"
  grep -Fq 'probe=ok committed=true generation=2 recovered=6/6' "$TMP/patrol-$mode"
  grep -Fq 'probe=failed committed=false' "$TMP/patrol-$mode"
done
echo 'PASS packaged and converged STEP 2 closure; first adoption sends zero severe alerts'
