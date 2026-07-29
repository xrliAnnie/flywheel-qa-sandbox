#!/usr/bin/env bash
set -euo pipefail

usage() {
	echo "usage: $0 /absolute/path/to/rehearsal-target.json" >&2
	exit 64
}

[[ $# -eq 1 ]] || usage
manifest=$1
[[ "$manifest" = /* && -f "$manifest" ]] || usage

mode=$(jq -er '.mode' "$manifest")
[[ "$mode" == "rehearsal" ]] || {
	echo "rehearsal target must declare mode=rehearsal" >&2
	exit 65
}

production_root=$(jq -er '.productionHomeRoot' "$manifest")
evidence_path=$(jq -er '.rehearsalEvidencePath' "$manifest")
window_id=$(jq -er '.windowId' "$manifest")
epoch=$(jq -er '.epoch' "$manifest")
[[ "$production_root" = /* && "$evidence_path" = /* ]] || {
	echo "manifest production/evidence paths must be absolute" >&2
	exit 65
}

scratch=$(mktemp -d "${TMPDIR:-/tmp}/flywheel-v2-rehearsal.XXXXXX")
cleanup() {
	rm -rf "$scratch"
}
trap cleanup EXIT

snapshot_control_plane() {
	local destination=$1
	local launchd_labels
	if ! launchd_labels=$(launchctl list 2>/dev/null); then
		echo "unable to snapshot production launchd labels; rehearsal is NO-GO" >&2
		return 1
	fi
	{
		echo "launchd-labels"
		printf '%s\n' "$launchd_labels" |
			awk 'NR > 1 {print $3}' |
			LC_ALL=C sort
		echo "launchd-disabled"
		launchctl print-disabled "gui/$(id -u)" 2>/dev/null || true
		echo "tmux-sessions"
		tmux list-sessions -F '#S' 2>/dev/null | LC_ALL=C sort || true
		echo "production-tree"
		if [[ -e "$production_root" ]]; then
			find -s "$production_root" -xdev \
				-exec stat -f '%N|%HT|%Mp%Lp|%z|%m' {} \; 2>/dev/null
		else
			echo "missing:$production_root"
		fi
	} >"$destination"
}

before=$scratch/before.txt
after=$scratch/after.txt
snapshot_control_plane "$before"

cutover_cli=${FLYWHEEL_V2_CUTOVER_CLI:-}
if [[ -n "$cutover_cli" ]]; then
	"$cutover_cli" run --target "$manifest" --yes
else
	repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
	node "$repo_root/packages/v2-cutover/dist/cli.js" \
		run --target "$manifest" --yes
fi

snapshot_control_plane "$after"
if ! diff -u "$before" "$after" >"$scratch/production.diff"; then
	echo "rehearsal changed production control-plane state; evidence remains NO-GO" >&2
	cat "$scratch/production.diff" >&2
	exit 1
fi

before_digest=$(shasum -a 256 "$before" | awk '{print $1}')
after_digest=$(shasum -a 256 "$after" | awk '{print $1}')
[[ "$before_digest" == "$after_digest" ]]
mkdir -p "$(dirname "$evidence_path")"
temporary=$(mktemp "$(dirname "$evidence_path")/.rehearsal-evidence.XXXXXX")
jq \
	--arg window "$window_id" \
	--argjson epoch "$epoch" \
	--arg before "$before_digest" \
	--arg after "$after_digest" \
	'. + {
		status: "pass",
		window_id: $window,
		epoch: $epoch,
		production_unchanged: true,
		production_snapshot_before: $before,
		production_snapshot_after: $after
	}' "$evidence_path" >"$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$evidence_path"

jq -c '{
	status,
	window_id,
	epoch,
	production_unchanged,
	production_snapshot_before,
	production_snapshot_after
}' "$evidence_path"
