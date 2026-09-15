#!/usr/bin/env bash
# Exercise the exact wrapper block without launching Bridge or altering host limits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/bridge-fd.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT
awk '/^# BEGIN bridge fd soft limit$/{copy=1;next} /^# END bridge fd soft limit$/{copy=0} copy' \
  "$ROOT/scripts/flywheel-bridge-wrapper.sh" > "$FIXTURE/block.sh"
[ -s "$FIXTURE/block.sh" ] || { echo 'missing wrapper fd block' >&2; exit 1; }
run_case() (
  local initial="$1" hard="$2" expected="$3" warning="$4"
  local current="$initial" writes=0
  ulimit() {
    case "$*" in
      '-Sn') echo "$current";;
      '-Hn') echo "$hard";;
      '-Sn 8192')
        writes=$((writes+1))
        if [[ "$hard" != unlimited && "$hard" -lt 8192 ]]; then return 1; fi
        current=8192;;
      *) return 99;;
    esac
  }
  source "$FIXTURE/block.sh" 2> "$FIXTURE/warn"
  [[ "$current" == "$expected" ]]
  if [[ "$warning" == yes ]]; then
    [[ "$(cat "$FIXTURE/warn")" == *WARN* ]]
  else
    [[ ! -s "$FIXTURE/warn" ]]
  fi
  if [[ "$initial" == unlimited || "$initial" == 16384 ]]; then [[ "$writes" == 0 ]]; fi
  # A failed raise still reaches the same exec boundary.
  exec bash -c 'exit 0'
)
run_case 256 16384 8192 no
run_case 16384 16384 16384 no
run_case unlimited unlimited unlimited no
run_case 256 1024 256 yes
# Real subprocess: shell soft limit is not the Node process's authoritative limit.
(
  ulimit -Sn 256
  node -e 'const soft=process.report.getReport().userLimits.open_files.soft; if (!(soft === "unlimited" || Number(soft) >= 256)) process.exit(1); console.log("Node actual soft limit:", soft)'
)
echo 'bridge-wrapper-fd-limit: PASS (four startup branches and real Node report)'
