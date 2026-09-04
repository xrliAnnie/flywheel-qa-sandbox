#!/usr/bin/env bash
set -u
set -o pipefail

RETIRE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! declare -F fly1814_operator_audit >/dev/null 2>&1; then
	# shellcheck source=../lib/fly1814-operator-tools.sh
	. "$RETIRE_SCRIPT_DIR/../lib/fly1814-operator-tools.sh"
fi

RETIRE_SYNC_LABEL=com.flywheel.lead-memory-sync
RETIRE_ARRIVAL_LABEL=com.flywheel.lead-memory-arrival-check

_retire_source_dir() { printf '%s\n' "$RETIRE_SCRIPT_DIR/../launchd"; }
_retire_manifest_path() { printf '%s\n' "$RETIRE_SCRIPT_DIR/../launchd/units.manifest"; }

retire_usage() {
	cat >&2 <<'USAGE'
Usage: retire-units.sh [--apply|--enable] --i-am-operator LABEL

Only com.flywheel.lead-memory-sync and
com.flywheel.lead-memory-arrival-check are accepted. The default is a
read-only retirement preview; mutation requires an interactive TTY and the
explicit operator acknowledgement.
USAGE
	return 64
}

retire_label_allowed() {
	[[ "$1" == "$RETIRE_SYNC_LABEL" || "$1" == "$RETIRE_ARRIVAL_LABEL" ]]
}

retire_authority_present() {
	local label="$1" source manifest
	source="$(_retire_source_dir)/$label.plist"
	manifest="$(_retire_manifest_path)"
	[[ -f "$source" && ! -L "$source" && -f "$manifest" && ! -L "$manifest" ]] || return 1
	awk -F '\t' -v label="$label" '$1 == label && $2 == label ".plist" && $3 == "copy" { found++ } END { exit found == 1 ? 0 : 1 }' \
		"$manifest"
}

retire_plist_matches() {
	local path="$1" label="$2" source parsed
	source="$(_retire_source_dir)/$label.plist"
	[[ -f "$path" && ! -L "$path" && -f "$source" && ! -L "$source" ]] || return 1
	cmp -s "$path" "$source" || return 1
	parsed="$(fly1814_plist_label "$path" 2>/dev/null)" || return 1
	[[ "$parsed" == "$label" ]]
}

retire_probe_state() {
	local domain="$1" label="$2" disabled domain_state
	disabled="$(fly1814_disabled_state "$domain" "$label" 2>/dev/null)" || return 1
	domain_state="$(fly1814_domain_state "$domain" "$label" 2>/dev/null)" || return 1
	[[ "$disabled" == enabled || "$disabled" == disabled ]] || return 1
	[[ "$domain_state" == loaded || "$domain_state" == missing ]] || return 1
	printf '%s\t%s\n' "$disabled" "$domain_state"
}

retire_enable() {
	local label="$1" domain="$2" state disabled domain_state intent
	retire_authority_present "$label" || {
		printf 'ERROR: restore the source plist and manifest row before enable\n' >&2
		return 68
	}
	state="$(retire_probe_state "$domain" "$label")" || return 69
	IFS=$'\t' read -r disabled domain_state <<<"$state"
	if [[ "$disabled" == enabled ]]; then
		printf '%s is already enabled; run scripts/lib/converge-nonlead-daemons.sh and verify bytes\n' "$label"
		return 0
	fi
	intent="action=enable\nlabel=$label\nprior_disabled=$disabled\nprior_domain=$domain_state"
	fly1814_operator_audit enable-memory-unit "$label" \
		"FLY-2146 memory unit enable requested" \
		"Operator requested enable after restoring repository authority for $label." \
		"$intent" || { printf 'ERROR: mandatory audit was not delivered; no mutation\n' >&2; return 70; }
	[[ "$(retire_probe_state "$domain" "$label")" == "$state" ]] || {
		printf 'ERROR: unit state changed during audit; no mutation\n' >&2
		return 69
	}
	fly1814_launchctl enable "$domain/$label" || return 75
	[[ "$(fly1814_disabled_state "$domain" "$label" 2>/dev/null)" == enabled ]] || return 75
	printf '%s enabled; run scripts/lib/converge-nonlead-daemons.sh, then verify installed bytes match repository authority\n' "$label"
}

retire_apply() {
	local label="$1" domain="$2" agents="$3" source active archive_dir archive
	local state disabled domain_state active_identity archive_identity intent post_state
	source="$(_retire_source_dir)/$label.plist"
	active="$agents/$label.plist"
	archive_dir="$agents/retired-$(fly1814_today)"
	archive="$archive_dir/$label.plist"
	retire_authority_present "$label" || { printf 'ERROR: repository authority is missing\n' >&2; return 68; }
	state="$(retire_probe_state "$domain" "$label")" || { printf 'ERROR: cannot prove launchd state\n' >&2; return 69; }
	IFS=$'\t' read -r disabled domain_state <<<"$state"

	if [[ ! -e "$active" && ! -L "$active" ]]; then
		if retire_plist_matches "$archive" "$label" && [[ "$disabled" == disabled && "$domain_state" == missing ]]; then
			printf '%s already retired\n' "$label"
			return 0
		fi
		printf 'ERROR: active plist is absent but retirement state is incomplete or foreign\n' >&2
		return 68
	fi
	retire_plist_matches "$active" "$label" || {
		printf 'ERROR: active plist identity differs from repository authority\n' >&2
		return 68
	}
	active_identity="$(fly1814_file_identity "$active" 2>/dev/null)" || return 68
	archive_identity=
	if [[ -e "$archive" || -L "$archive" ]]; then
		retire_plist_matches "$archive" "$label" || {
			printf 'ERROR: archive destination is foreign\n' >&2
			return 73
		}
		archive_identity="$(fly1814_file_identity "$archive" 2>/dev/null)" || return 73
		if [[ "$archive_identity" != "$active_identity" ]] || ! fly1814_files_are_same "$active" "$archive"; then
			printf 'ERROR: archive collision is not the resumable same-inode state\n' >&2
			return 73
		fi
	fi
	[[ ! -L "$archive_dir" && ( ! -e "$archive_dir" || -d "$archive_dir" ) ]] || return 73

	intent="action=retire\nlabel=$label\nprior_disabled=$disabled\nprior_domain=$domain_state\nactive_identity=$active_identity\narchive=$archive"
	fly1814_operator_audit retire-memory-unit "$label" \
		"FLY-2146 memory unit retirement requested" \
		"Operator requested disable, unload, and identity-safe archive for $label." \
		"$intent" || { printf 'ERROR: mandatory audit was not delivered; no mutation\n' >&2; return 70; }
	retire_plist_matches "$active" "$label" || { printf 'ERROR: active plist changed during audit\n' >&2; return 68; }
	[[ "$(fly1814_file_identity "$active" 2>/dev/null || true)" == "$active_identity" ]] || return 68
	post_state="$(retire_probe_state "$domain" "$label")" || return 69
	[[ "$post_state" == "$state" ]] || { printf 'ERROR: unit state changed during audit\n' >&2; return 69; }
	if [[ -n "$archive_identity" ]]; then
		[[ "$(fly1814_file_identity "$archive" 2>/dev/null || true)" == "$archive_identity" ]] || return 73
	fi

	if [[ "$disabled" != disabled ]]; then
		fly1814_launchctl disable "$domain/$label" || return 74
		[[ "$(fly1814_disabled_state "$domain" "$label" 2>/dev/null)" == disabled ]] || return 74
		disabled=disabled
	fi
	if [[ "$domain_state" == loaded ]]; then
		if ! fly1814_launchctl bootout "$domain/$label"; then
			[[ "$(fly1814_domain_state "$domain" "$label" 2>/dev/null)" == missing ]] || return 75
		fi
		[[ "$(fly1814_domain_state "$domain" "$label" 2>/dev/null)" == missing ]] || return 75
		domain_state=missing
	fi
	if [[ ! -e "$archive" && ! -L "$archive" ]]; then
		if [[ ! -d "$archive_dir" ]]; then
			fly1814_mkdir "$archive_dir" || return 76
		fi
		fly1814_archive_publish "$active" "$archive" || return 76
		archive_identity="$(fly1814_file_identity "$archive" 2>/dev/null)" || return 76
		[[ "$archive_identity" == "$active_identity" ]] && fly1814_files_are_same "$active" "$archive" || return 76
	fi
	fly1814_source_remove "$active" "$archive" "$active_identity" || return 76
	[[ ! -e "$active" && ! -L "$active" && -f "$archive" && ! -L "$archive" ]] || return 76
	printf '%s retired; revert the source plist and manifest row only when retirement is intended to remain permanent\n' "$label"
}

retire_main() {
	local action=preview operator=0 label="" arg domain agents
	while [[ "$#" -gt 0 ]]; do
		arg="$1"
		case "$arg" in
			--apply) [[ "$action" == preview ]] || { retire_usage; return $?; }; action=apply ;;
			--enable) [[ "$action" == preview ]] || { retire_usage; return $?; }; action=enable ;;
			--i-am-operator) operator=1 ;;
			-h | --help) retire_usage; return 0 ;;
			-*) retire_usage; return $? ;;
			*) [[ -z "$label" ]] || { retire_usage; return $?; }; label="$arg" ;;
		esac
		shift
	done
	if [[ -z "$label" ]] || ! retire_label_allowed "$label"; then
		printf 'ERROR: exact FLY-2146 label required\n' >&2
		return 64
	fi
	domain="$(fly1814_domain)" || return 69
	agents="$(fly1814_launch_agents_dir)" || return 69
	if [[ "$action" == preview ]]; then
		printf 'DRY-RUN: would audit, disable, bootout, and archive %s/%s.plist\n' "$agents" "$label"
		return 0
	fi
	fly1814_operator_has_tty || { printf 'ERROR: mutation requires an interactive TTY\n' >&2; return 66; }
	[[ "$operator" == 1 ]] || { printf 'ERROR: --i-am-operator is required\n' >&2; return 66; }
	case "$action" in
		apply) retire_apply "$label" "$domain" "$agents" ;;
		enable) retire_enable "$label" "$domain" ;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	retire_main "$@"
	exit $?
fi
