#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/test-auto-approve.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1726-auto-approve.XXXXXX")"
SLOT_ID=""
SLOT_DIR=""
for candidate in 91 92 93 94 95 96 97 98 99; do
  candidate_dir="/tmp/flywheel-test-slot-${candidate}"
  if mkdir "$candidate_dir" 2>/dev/null; then
    SLOT_ID="$candidate"
    SLOT_DIR="$candidate_dir"
    break
  fi
done
[[ -n "$SLOT_ID" ]] || { printf 'FAIL: no isolated QA slot fixture directory\n' >&2; exit 1; }
cleanup() {
  rm -f "$SLOT_DIR/flywheel-projects.json"
  rmdir "$SLOT_DIR" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/home/.flywheel" "$TMP/bin"
mkdir -p "$TMP/home/.flywheel/comm/test-slot-${SLOT_ID}"
: > "$TMP/home/.flywheel/comm/test-slot-${SLOT_ID}/comm.db"
cat > "$TMP/home/.flywheel/test-slots.json" <<JSON
{"slots":[$(printf '{},%.0s' $(seq 1 $((SLOT_ID - 1)))) {"bridgePort":9876,"botName":"test-lead"}]}
JSON
cat > "$SLOT_DIR/flywheel-projects.json" <<JSON
[{"projectName":"test-slot-${SLOT_ID}","leads":[{"agentId":"test-lead"}]}]
JSON
cat > "$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$TMP/bin/sqlite3" <<'SH'
#!/usr/bin/env bash
printf 'question-1\n'
SH
cat > "$TMP/bin/node" <<SH
#!/usr/bin/env bash
if [[ " \$* " == *" lead-identity resolve "* ]]; then
  printf '%s\n' '{"schemaVersion":1,"leadId":"test-lead","projectName":"test-slot-${SLOT_ID}","leadKey":"test-slot-${SLOT_ID}-test-lead","agentTeamName":"test-lead","botUserId":"12345678901234567","botTokenEnv":"TEST_TOKEN","discordStateDir":"$TMP/state","backend":"claude-code","role":"dept","projectsDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
  exit 0
fi
env | sort > "$TMP/respond.env"
printf '%s\n' "\$*" > "$TMP/respond.args"
SH
chmod +x "$TMP/bin/"*

set +e
HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  LEAD_ID=foreign-ambient PROJECT_NAME=foreign-project \
  bash "$SCRIPT" "$SLOT_ID" execution-1 --timeout 1 --poll-interval 1 \
  >"$TMP/stdout" 2>"$TMP/stderr"
rc=$?
set -e

if [[ "$rc" -eq 0 ]] \
  && grep -qx "FLYWHEEL_PROJECTS_FILE=$SLOT_DIR/flywheel-projects.json" "$TMP/respond.env" \
  && grep -qx "FLYWHEEL_PROJECT_NAME=test-slot-${SLOT_ID}" "$TMP/respond.env" \
  && grep -qx "PROJECT_NAME=test-slot-${SLOT_ID}" "$TMP/respond.env" \
  && grep -qx 'FLYWHEEL_LEAD_ID=test-lead' "$TMP/respond.env" \
  && grep -qx 'LEAD_ID=test-lead' "$TMP/respond.env" \
  && grep -qx "FLYWHEEL_LEAD_KEY=test-slot-${SLOT_ID}-test-lead" "$TMP/respond.env" \
  && grep -qx 'FLYWHEEL_LEAD_IDENTITY_DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$TMP/respond.env" \
  && grep -qx 'FLYWHEEL_LEAD_LEASE_MODE=off' "$TMP/respond.env" \
  && grep -q ' respond --lead test-lead --db ' "$TMP/respond.args"; then
  printf 'PASS: test-auto-approve projects canonical identity into the explicit QA writer\n'
else
  printf 'FAIL: test-auto-approve canonical identity projection (rc=%s)\n' "$rc" >&2
  cat "$TMP/stderr" >&2 || true
  grep -E '^(FLYWHEEL_(PROJECTS_FILE|PROJECT_NAME|LEAD_ID|LEAD_KEY|LEAD_IDENTITY_DIGEST|LEAD_LEASE_MODE)|PROJECT_NAME|LEAD_ID)=' \
    "$TMP/respond.env" >&2 2>/dev/null || true
  exit 1
fi
