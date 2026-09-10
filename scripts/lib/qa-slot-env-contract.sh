#!/usr/bin/env bash
# Sourceable projection of the declarative 529-room environment contract.

qa_slot_env_contract_path() {
	local contract_dir
	contract_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return 1
	printf '%s/qa-slot-env-contract.json\n' "$contract_dir"
}

qa_slot_env_contract_names() {
	local disposition="${1:?disposition required}"
	case "$disposition" in redirect|clear|passthrough) ;; *) return 2 ;; esac
	jq -er --arg disposition "$disposition" \
		'.[] | select(.disposition == $disposition) | .name' \
		"$(qa_slot_env_contract_path)"
}

qa_slot_env_contract_render() {
	local slot_dir="${1:?slot directory required}"
	local project_name="${2:?project name required}"
	local repo_root slot_tmpdir
	repo_root="$(cd "$(dirname "$(qa_slot_env_contract_path)")/../.." && pwd)" \
		|| return 1
	slot_tmpdir="${slot_dir}/tmp"
	jq -r --arg slotDir "$slot_dir" --arg repoRoot "$repo_root" \
		--arg slotTmpdir "$slot_tmpdir" --arg projectName "$project_name" '
		.[] | select(.disposition == "redirect") |
		.name + "=" + (
			.value
			| gsub("\\$\\{SLOT_DIR\\}"; $slotDir)
			| gsub("\\$\\{REPO_ROOT\\}"; $repoRoot)
			| gsub("\\$\\{SLOT_TMPDIR\\}"; $slotTmpdir)
			| gsub("\\$\\{TEST_PROJECT_NAME\\}"; $projectName)
		)
	' "$(qa_slot_env_contract_path)"
}
