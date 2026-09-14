#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"
export ENV_FILE="$TMP/absent.env" FLYWHEEL_STATE_DIR="$TMP" TEST_ROOT="$TMP"
export FLYWHEEL_COMM_CLI="$TMP/comm.cjs" FLYWHEEL_READINESS_REPORT_CHANNEL=123
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1";;
    -D) shift; headers="$1";;
    --config) shift; cat >/dev/null;;
  esac
  shift
done
printf '<html>readiness</html>' > "$out"
printf 'HTTP/1.1 200 OK\r\nX-Readiness-Commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\nX-Readiness-Version: 1.56.0\r\n\r\n' > "$headers"
CURL
chmod +x "$TMP/bin/curl"
cat > "$TMP/comm.cjs" <<'NODE'
const fs = require('node:fs');
const dir = process.env.FLYWHEEL_STATE_DIR + '/state/release-readiness/publications';
const file = fs.readdirSync(dir).find(f => f.endsWith('.json'));
if (!file || JSON.parse(fs.readFileSync(dir+'/'+file)).status !== 'intent') process.exit(9);
if (process.env.LAND_DURING_SEND) {fs.mkdirSync(dir+'/landed', {recursive:true}); fs.renameSync(dir+'/'+file, dir+'/landed/'+file);}
fs.appendFileSync(process.env.TEST_ROOT+'/sends', 'sent\n');
console.log(JSON.stringify({ok: !process.env.FAIL_SEND, messageId: process.env.FAIL_SEND ? null : '456'}));
if (process.env.FAIL_SEND) process.exit(1);
NODE
/bin/bash "$REPO/scripts/release-readiness-report.sh"
DAY="$(/bin/date -u +%Y-%m-%d)"
FILE="$TMP/state/release-readiness/publications/$DAY.json"
jq -e '.status == "published" and .messageId == "456" and .subjectCommit == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$FILE" >/dev/null
/bin/bash "$REPO/scripts/release-readiness-report.sh"
[ "$(wc -l < "$TMP/sends" | tr -d ' ')" = 1 ]
mkdir -p "$(dirname "$FILE")/landed"
mv "$FILE" "$(dirname "$FILE")/landed/"
/bin/bash "$REPO/scripts/release-readiness-report.sh"
[ "$(wc -l < "$TMP/sends" | tr -d ' ')" = 1 ]
export FLYWHEEL_STATE_DIR="$TMP/failed" FAIL_SEND=1
if /bin/bash "$REPO/scripts/release-readiness-report.sh"; then echo 'failed publish returned success' >&2; exit 1; fi
jq -e '.status == "failed" and .messageId == null' "$TMP/failed/state/release-readiness/publications/$DAY.json" >/dev/null
FLYWHEEL_READINESS_REPORT_CHANNEL='' /bin/bash "$REPO/scripts/release-readiness-report.sh"
unset FAIL_SEND
export FLYWHEEL_STATE_DIR="$TMP/interleaved" LAND_DURING_SEND=1
/bin/bash "$REPO/scripts/release-readiness-report.sh"
jq -e '.status == "published"' "$TMP/interleaved/state/release-readiness/publications/$DAY.json" >/dev/null
jq -e '.status == "intent"' "$TMP/interleaved/state/release-readiness/publications/landed/$DAY.json" >/dev/null
echo 'readiness report: intent-before-send, success, failure, pending/landed idempotence and disabled channel PASS'
