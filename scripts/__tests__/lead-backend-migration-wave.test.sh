#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_TMP="$(mktemp -d)"
trap 'rm -rf "$TASK_TMP"' EXIT
export TEST_HOME="$TASK_TMP/home"
export FLYWHEEL_DIR="$TASK_TMP/repo"
export CALLS="$TASK_TMP/calls"
mkdir -p "$TEST_HOME/.flywheel/lead-backend-migrations" "$FLYWHEEL_DIR/scripts/lib"
python3 - "$ROOT/scripts/restart-services.sh" "$FLYWHEEL_DIR/scripts/wave.sh" <<'PY'
import sys
s=open(sys.argv[1]).read();s=s[s.index('do_restart_all_leads() {'):];s=s[:s.index('\n}\n')+3]
s=s.replace('${HOME}', '${TEST_HOME}').replace('$HOME', '$TEST_HOME')
open(sys.argv[2],'w').write(s)
PY
printf '#!/bin/bash\nexit 0\n' > "$FLYWHEEL_DIR/scripts/converge-flywheel-bin.sh"
cat > "$FLYWHEEL_DIR/scripts/lib/lead-backend-migration.sh" <<'SH'
lead_backend_migration_run() {
 echo migrate >> "$CALLS"
 case "$TEST_RESULT" in
 success) printf '{"status":"deployed_unverified"}\n';;
 skip) printf '{"status":"skipped"}\n';;
 fail) return 78;;
 malformed) printf '{}\n';;
 esac
}
SH
source "$FLYWHEEL_DIR/scripts/wave.sh"
log() { :; }
record_lead_restart_detail() { :; }
register_restart_transient_file() { :; }
restart_host_tmux_gate() { :; }
restart_host_tmux_census() { :; }
record_successful_lead_verify_timing() { :; }
record_successful_lead_body_observation() { :; }
restart_lead() { echo "restart:$1" >> "$CALLS"; }
lead_restart_collect_candidates() {
 printf 'flywheel-flywheel-product-lead\tflywheel\tflywheel-product-lead\t%s\trestart\tmanifest\n' "$TASK_TMP/target.json" > "$4"
 printf 'flywheel-other\tflywheel\tother\t%s\trestart\tmanifest\n' "$TASK_TMP/other.json" >> "$4"
}
touch "$TASK_TMP/target.json" "$TASK_TMP/other.json"
VERIFIED_LEAD_ELAPSED_SECONDS=0 VERIFIED_LEAD_PID=123 VERIFIED_LEAD_START=fixture
TEST_RESULT=success RESTART_REASON=updater
export TEST_RESULT
: > "$CALLS"
[ "$(do_restart_all_leads immediate)" = 'skipped:0 failed:0 total:2' ]
[ "$(wc -l < "$CALLS" | tr -d ' ')" = 2 ]
printf '{}\n' > "$TEST_HOME/.flywheel/lead-backend-migrations/FLY-2459-honey-lemon.json"
: > "$CALLS"
[ "$(do_restart_all_leads immediate)" = 'skipped:0 failed:0 total:2' ]
[ "$(cat "$CALLS")" = "$(printf 'migrate\nrestart:%s' "$TASK_TMP/other.json")" ]
TEST_RESULT=skip
: > "$CALLS"
[ "$(do_restart_all_leads immediate)" = 'skipped:0 failed:0 total:2' ]
[ "$(cat "$CALLS")" = "$(printf 'migrate\nrestart:%s\nrestart:%s' "$TASK_TMP/target.json" "$TASK_TMP/other.json")" ]
for TEST_RESULT in fail malformed; do
 : > "$CALLS"
 [ "$(do_restart_all_leads immediate)" = 'skipped:0 failed:1 total:0' ]
 [ "$(cat "$CALLS")" = migrate ]
done
RESTART_REASON=manual
: > "$CALLS"
[ "$(do_restart_all_leads immediate)" = 'skipped:0 failed:0 total:2' ]
[ "$(wc -l < "$CALLS" | tr -d ' ')" = 2 ]
echo 'PASS migration wave no-intent, current-success skip, observed-safe skip continues target and peers, failed/malformed hold, manual bypass'
