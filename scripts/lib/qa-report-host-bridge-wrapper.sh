#!/usr/bin/env bash
# FLY-2270: start the slot-local report host, then exec the Bridge in this pid.
set -euo pipefail

root="${1:?root}"
node_bin="${2:?node}"
[[ "${3:-}" == "--" ]] || exit 64
shift 3
[[ $# -gt 0 ]] || exit 64
[[ "$node_bin" == /* && -x "$node_bin" ]] || exit 64
[[ -d "$root" && ! -L "$root" ]] || {
	echo '[qa-report-host-wrapper] report host root must be a real directory' >&2
	exit 64
}
canonical="$(cd "$root" && pwd -P)"
[[ "$canonical" =~ ^/(private/)?tmp/flywheel-test-slot-[1-9][0-9]*/state/report-host$ ]] || {
	echo '[qa-report-host-wrapper] report host root is outside the slot tree' >&2
	exit 64
}
[[ -f "${canonical}/token" && ! -L "${canonical}/token" ]] || {
	echo '[qa-report-host-wrapper] token missing or symlinked' >&2
	exit 64
}

slot_dir="$(cd "${canonical}/../.." && pwd -P)"
lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -f "${canonical}/port"
env -i HOME="$HOME" PATH="$PATH" "$node_bin" \
	"${lib}/qa-report-host.mjs" --root "$canonical" --expected-parent "$$" \
	>> "${slot_dir}/report-host.log" 2>&1 &
stub=$!
for _ in $(seq 1 100); do
	[[ -s "${canonical}/port" ]] && break
	kill -0 "$stub" 2>/dev/null || break
	sleep 0.1
done
if [[ ! -s "${canonical}/port" ]]; then
	echo '[qa-report-host-wrapper] report host did not become ready within 10s; refusing to start the Bridge' >&2
	kill "$stub" 2>/dev/null || true
	wait "$stub" 2>/dev/null || true
	exit 70
fi
export FLYWHEEL_REPORT_HOST_OVERRIDE_URL="http://127.0.0.1:$(<"${canonical}/port")"
exec "$@"
