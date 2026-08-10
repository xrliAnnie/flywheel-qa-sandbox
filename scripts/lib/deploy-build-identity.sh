#!/usr/bin/env bash

dbi_sha40() {
	[[ "${1:-}" =~ ^[0-9a-fA-F]{40}$ ]]
}

dbi_skip_build_allowed() {
	local mode="${1:-}" intended="${2:-}" artifact="${3:-}"
	[[ "$mode" == "source" ]] && return 0
	[[ "$mode" == "built" ]] && dbi_sha40 "$intended" \
		&& [[ "$(printf '%s' "$artifact" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$intended" | tr '[:upper:]' '[:lower:]')" ]]
}

dbi_accept_health_identity() {
	local repo="$1" intended="$2" health_json="$3" expected_mode="${4:-}"
	local mode build_sha artifact_sha
	DBI_REASON=""
	if ! mode="$(jq -er '.buildMode' <<<"$health_json" 2>/dev/null)" \
		|| ! build_sha="$(jq -er '.buildSha' <<<"$health_json" 2>/dev/null)"; then
		DBI_REASON="identity_missing"
		return 1
	fi
	if [[ "$mode" != "source" && "$mode" != "built" ]]; then
		DBI_REASON="mode_${mode:-unknown}"
		return 1
	fi
	if [[ -n "$expected_mode" && "$mode" != "$expected_mode" ]]; then
		DBI_REASON="mode_mismatch_${expected_mode}_${mode}"
		return 1
	fi
	if ! dbi_sha40 "$intended" || ! dbi_sha40 "$build_sha"; then
		DBI_REASON="sha_malformed"
		return 1
	fi
	if [[ "$mode" == "built" ]]; then
		artifact_sha="$(jq -r '.artifactBuildSha // empty' <<<"$health_json" 2>/dev/null)"
		if ! dbi_sha40 "$artifact_sha" || [[ "$(printf '%s' "$artifact_sha" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$build_sha" | tr '[:upper:]' '[:lower:]')" ]]; then
			DBI_REASON="artifact_identity_mismatch"
			return 1
		fi
	fi
	if ! git -C "$repo" merge-base --is-ancestor "$intended" "$build_sha" 2>/dev/null; then
		DBI_REASON="intended_not_ancestor"
		return 1
	fi
	DBI_REASON="accepted_${mode}"
}
