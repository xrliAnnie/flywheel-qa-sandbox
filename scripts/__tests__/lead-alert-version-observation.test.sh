#!/bin/bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
TEST_ROOT=$(mktemp -d /tmp/fly2390-shell.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/repo/doc" "$TEST_ROOT/state"
cp "$REPO/scripts/lead-alert.sh" "$TEST_ROOT/bin/lead-alert.sh"
printf 'v1.56.0\n' > "$TEST_ROOT/repo/doc/VERSION"
printf '%040d\n' 1 > "$TEST_ROOT/deployed-sha"
export FLYWHEEL_STATE_DIR="$TEST_ROOT"
export FLYWHEEL_REPO="$TEST_ROOT/repo"
export FLYWHEEL_DEPLOYED_SHA_FILE="$TEST_ROOT/deployed-sha"
export FLYWHEEL_PROJECTS_FILE="$TEST_ROOT/missing-projects.json"
export FLYWHEEL_CLAIMS_DB="$TEST_ROOT/claims.db"
export FLYWHEEL_ALERT_QUEUE_DIR="$TEST_ROOT/queue"
export FLYWHEEL_ALERT_DEADLETTER_DIR="$TEST_ROOT/deadletter"
unset FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID FLYWHEEL_ALERT_SENDER_TOKEN_ENV
/bin/bash "$TEST_ROOT/bin/lead-alert.sh" --lead test --project flywheel --kind deploy_failed --severity severe --title test --body test > "$TEST_ROOT/result" 2>&1 && exit 1
shopt -s nullglob
intents=("$TEST_ROOT/state/release-readiness/gaps/"*.intent.json)
[ "${#intents[@]}" -eq 1 ] || { echo 'FAIL: preflight exit did not preserve one intent'; exit 1; }
jq -e '.reason == "shell_preflight" and .baseVersion == "1.56.0" and .sourceCommit == "0000000000000000000000000000000000000001" and .eventIdHint == null' "${intents[0]}" >/dev/null
printf 'PASS: preflight failure retains attributed capture intent\n'
# A valid unified route with no token still observes before dead-lettering.
export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=test-channel
export FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLY2390_ABSENT_TOKEN
unset FLY2390_ABSENT_TOKEN
for attempt in 1 2; do
  /bin/bash "$TEST_ROOT/bin/lead-alert.sh" --lead test --project flywheel --kind deploy_failed --severity severe --signature repeated --title test --body test > "$TEST_ROOT/result" 2>&1 || true
done
count=$(sqlite3 "$TEST_ROOT/claims.db" 'SELECT count(*) FROM alert_version_observations;' 2>/dev/null || true)
[ "$count" = 2 ] || { echo 'FAIL: no-token/repeated alert observations missing'; exit 1; }
[ "$(sqlite3 "$TEST_ROOT/claims.db" 'SELECT group_concat(occurrence) FROM alert_version_observations;')" = '1,2' ]
landed=("$TEST_ROOT/state/release-readiness/gaps/landed/"*.intent.json)
[ "${#landed[@]}" -eq 2 ] || { echo 'FAIL: successful observations not marked landed'; exit 1; }
[ "$(sqlite3 "$TEST_ROOT/claims.db" 'SELECT count(*) FROM pragma_table_info("alert_claims");')" = 4 ]
printf 'PASS: repeated no-token alerts observed; four-column claims preserved\n'
# Config and tool preflight failures retain intent without claiming delivery.
unset FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID FLYWHEEL_ALERT_SENDER_TOKEN_ENV
printf '[]\n' > "$FLYWHEEL_PROJECTS_FILE"
/bin/bash "$TEST_ROOT/bin/lead-alert.sh" --lead unknown --project flywheel --kind deploy_failed --severity severe --title test --body test > "$TEST_ROOT/result" 2>&1 && exit 1
mkdir "$TEST_ROOT/tools"
for tool in date mkdir mv; do ln -s "/bin/$tool" "$TEST_ROOT/tools/$tool"; done
PATH="$TEST_ROOT/tools" /bin/bash "$TEST_ROOT/bin/lead-alert.sh" --lead test --project flywheel --kind deploy_failed --severity severe --title test --body test > "$TEST_ROOT/result" 2>&1 && exit 1
intents=("$TEST_ROOT/state/release-readiness/gaps/"*.intent.json)
[ "${#intents[@]}" -eq 3 ] || { echo 'FAIL: config/tool gaps missing'; exit 1; }
# sqlite failure cannot retire its preflight intent.
cat > "$TEST_ROOT/bin/sqlite3" <<'SQLITE'
#!/bin/bash
exit 1
SQLITE
chmod +x "$TEST_ROOT/bin/sqlite3"
export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=test-channel
export FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLY2390_ABSENT_TOKEN
PATH="$TEST_ROOT/bin:$PATH" /bin/bash "$TEST_ROOT/bin/lead-alert.sh" --lead test --project flywheel --kind deploy_failed --severity severe --title test --body test > "$TEST_ROOT/result" 2>&1 || true
intents=("$TEST_ROOT/state/release-readiness/gaps/"*.intent.json)
[ "${#intents[@]}" -eq 4 ] || { echo 'FAIL: sqlite failure lost its gap'; exit 1; }
for intent in "${intents[@]}"; do jq -e '.reason == "shell_preflight"' "$intent" >/dev/null; done
printf 'PASS: unknown lead, missing tools and sqlite failures leave gaps\n'
node - "$REPO/scripts/lead-alert.sh" <<'NODE'
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('INSERT OR IGNORE INTO alert_claims VALUES');
const end = source.indexOf('COMMIT;', start);
const digest = createHash('sha256').update(source.slice(start, end)).digest('hex');
if (digest !== '45de0e30395f1303d5c70611f3bd7ae68d5fb9e34d04d5e7fb8f9ca38c967189') throw new Error('legacy claim transaction changed');
NODE
printf 'PASS: four original claim statements remain byte-identical\n'
printf 'v01.56.0\n' > "$TEST_ROOT/repo/doc/VERSION"
FLYWHEEL_DEPLOYED_SHA_FILE="$TEST_ROOT/absent-sha" /bin/bash "$TEST_ROOT/bin/lead-alert.sh" --lead test --project "fly'wheel" --kind deploy_failed --severity severe --signature unattributed --title test --body test > "$TEST_ROOT/result" 2>&1 || true
[ "$(sqlite3 "$TEST_ROOT/claims.db" "SELECT count(*) FROM alert_version_observations WHERE source_commit_key='null' AND base_version IS NULL AND project_name='fly''wheel';")" = 1 ] || { echo 'FAIL: missing identity or SQL quoting changed attribution'; exit 1; }
printf 'PASS: missing/invalid identity stays NULL and project quotes survive\n'
