#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TASK_TMP="$(mktemp -d -t fly2392-wrapper-XXXXXX)"
trap 'rm -rf "$TASK_TMP"' EXIT
WRAPPER="$ROOT/scripts/packaged/flywheel-auto-update.sh"
mkdir -p "$TASK_TMP/home/.local/bin" "$TASK_TMP/state/shell/current/bin"
cat > "$TASK_TMP/home/.local/bin/node" <<'NODE'
#!/bin/bash
[ -z "${FLYWHEEL_LICENSE_KEY:-}" ] || exit 91
[ -z "${FLYWHEEL_ALLOW_LICENSE_KEY_ENV:-}" ] || exit 92
printf 'NODE %s %s %s\n' "$1" "$2" "$3"
NODE
chmod +x "$TASK_TMP/home/.local/bin/node"
touch "$TASK_TMP/state/auto-update.off"
HOME="$TASK_TMP/home" bash "$WRAPPER" "$TASK_TMP/state"
! grep -q NODE "$TASK_TMP/state/logs/auto-update.log"
grep -q disabled "$TASK_TMP/state/logs/auto-update.log"
rm "$TASK_TMP/state/auto-update.off"
HOME="$TASK_TMP/home" bash "$WRAPPER" "$TASK_TMP/state"
grep -q shell_missing "$TASK_TMP/state/logs/auto-update.log"
touch "$TASK_TMP/state/shell/current/bin/flywheel-onboard.js"
HOME="$TASK_TMP/home" FLYWHEEL_LICENSE_KEY=fixture-secret FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1 bash "$WRAPPER" "$TASK_TMP/state"
grep -q 'update --unattended' "$TASK_TMP/state/logs/auto-update.log"
! grep -q fixture-secret "$TASK_TMP/state/logs/auto-update.log"
# Force the command lookup failure without touching host binaries.
command() { if [ "$*" = '-v node' ]; then return 1; fi; builtin command "$@"; }
export -f command
HOME="$TASK_TMP/home" bash "$WRAPPER" "$TASK_TMP/state"
grep -q node_missing "$TASK_TMP/state/logs/auto-update.log"
unset -f command
printf 'packaged-auto-update-wrapper: 4 scenarios passed\n'

# Real bootstrap script, inert supervisor fixture: no host service mutation.
PKG="$TASK_TMP/pkg"
mkdir -p "$PKG/scripts/packaged" "$PKG/scripts/lib"
touch "$PKG/.flywheel-prebuilt"
cp "$ROOT/scripts/packaged/bootstrap-services.sh" "$PKG/scripts/packaged/"
cp "$WRAPPER" "$PKG/scripts/packaged/"
for file in host-config.sh lead-restart-lifecycle.sh; do printf '# fixture\n' > "$PKG/scripts/lib/$file"; done
cat > "$PKG/scripts/lib/script-sanity.sh" <<'LIB'
install_script_atomic() { cp "$1" "$2"; chmod +x "$2"; }
LIB
cat > "$PKG/scripts/lib/supervisor.sh" <<'LIB'
supervisor_backend() { echo fixture; }
supervisor_install() { printf '%s\n' "$1" >> "$SPEC_LOG"; }
supervisor_bridge_spec() { echo 'bridge-must-not-be-emitted'; return 1; }
LIB
SPEC_LOG="$TASK_TMP/specs" HOME="$TASK_TMP/home" bash "$PKG/scripts/packaged/bootstrap-services.sh" --only auto-update --state-dir "$TASK_TMP/timer-state" > "$TASK_TMP/bootstrap.log"
[ "$(wc -l < "$TASK_TMP/specs" | tr -d ' ')" = 1 ]
jq -e '.name=="auto-update" and .kind=="timer" and [.schedule[].hour]==[3,9,15,21]' "$TASK_TMP/specs" >/dev/null
[ ! -e "$TASK_TMP/home/.flywheel/host.json" ]
[ -x "$TASK_TMP/timer-state/bin/flywheel-auto-update.sh" ]
printf '{"schemaVersion":1,"checkEveryHours":8,"applyHour":23,"applyGraceHours":2}' > "$TASK_TMP/timer-state/auto-update.json"
: > "$TASK_TMP/specs"
SPEC_LOG="$TASK_TMP/specs" HOME="$TASK_TMP/home" bash "$PKG/scripts/packaged/bootstrap-services.sh" --only auto-update --state-dir "$TASK_TMP/timer-state" > "$TASK_TMP/bootstrap.log"
jq -e '[.schedule[].hour]==[7,15,23]' "$TASK_TMP/specs" >/dev/null
printf 'packaged-auto-update-bootstrap: isolated install and configurable schedule passed\n'
for config in '{}' 'null' '[]' '{"schemaVersion":1,"checkEveryHours":5}' '{"schemaVersion":1,"checkEveryHours":6,"applyHour":"x","applyGraceHours":2}'; do
  printf '%s' "$config" > "$TASK_TMP/timer-state/auto-update.json"
  : > "$TASK_TMP/specs"
  SPEC_LOG="$TASK_TMP/specs" HOME="$TASK_TMP/home" bash "$PKG/scripts/packaged/bootstrap-services.sh" --only auto-update --state-dir "$TASK_TMP/timer-state" > "$TASK_TMP/bootstrap.log"
  [ -s "$TASK_TMP/specs" ]
  jq -e '[.schedule[].hour]==[3,9,15,21]' "$TASK_TMP/specs" >/dev/null
done
printf 'packaged-auto-update-bootstrap: invalid configuration defaults passed\n'
