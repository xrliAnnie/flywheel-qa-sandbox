#!/usr/bin/env bash
set -euo pipefail

run_id="${1:?usage: nested-manual-closeout.sh <workflow-run-id>}"
bridge_url="${FLYWHEEL_BRIDGE_URL:-http://127.0.0.1:9876}"
master_token="${TEAMLEAD_API_TOKEN:?TEAMLEAD_API_TOKEN is required}"
base="$bridge_url/api/runs/$run_id"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/flywheel-nested-closeout.XXXXXX")"
chmod 700 "$tmp_dir"
trap 'rm -rf -- "$tmp_dir"' EXIT

curl_auth() {
	printf 'header = "Authorization: Bearer %s"\n' "$master_token"
}

get_diagnostic() {
	local output_file="$1"
	local status
	status="$(
		curl_auth |
			curl --silent --show-error --config - \
				--output "$output_file" \
				--write-out '%{http_code}' \
				"$base/diagnostic"
	)"
	if [[ "$status" != "200" ]]; then
		echo "diagnostic HTTP $status" >&2
		[[ -f "$output_file" ]] && sed -n '1,80p' "$output_file" >&2
		return 1
	fi
}

validate_snapshot() {
	local diagnostic_file="$1"
	local expected_status="$2"
	jq --exit-status --arg status "$expected_status" '
		.schema_version == 1
		and .run.status == $status
		and .latest_hold.reason == "nested_land_unsupported"
		and .quiescence.quiescent == true
		and .receipts.attributed_out_of_set == 0
		and .finalization.state == null
		and .land_operation.present == false
		and ([.truncated[]] | any) == false
		and (
			if .pr_manifest == null then
				.single_closeout_target != null
				and .single_closeout_target.target_repo_identity != "__main__"
			else
				.pr_manifest.sealed == true
				and (.declared_prs | length) > 0
				and (.declared_prs | length) == .pr_manifest.expected_count
				and ([.declared_prs[].state == "merged"] | all)
			end
		)
	' "$diagnostic_file" >/dev/null
}

diagnostic_before="$tmp_dir/diagnostic-before.json"
get_diagnostic "$diagnostic_before"

recovered=0
if jq --exit-status '.run.status == "terminated"' "$diagnostic_before" >/dev/null; then
	validate_snapshot "$diagnostic_before" "terminated"
	invariant_digest="$(jq --exit-status --raw-output '
		.latest_termination.closeout_invariant_digest
		| select(type == "string" and test("^[0-9a-f]{64}$"))
	' "$diagnostic_before")"
	client_request_id="nested-closeout-${run_id}-${invariant_digest}"
	jq --exit-status \
		--arg digest "$invariant_digest" \
		--arg request_id "$client_request_id" '
		.latest_termination.closeout_kind == "nested_manual"
		and .latest_termination.closeout_invariant_digest == $digest
		and .latest_termination.client_request_id == $request_id
	' "$diagnostic_before" >/dev/null
	recovered=1
else
	validate_snapshot "$diagnostic_before" "held"
	invariant_digest="$(jq --exit-status --raw-output '
		.closeout_invariant_digest
		| select(type == "string" and test("^[0-9a-f]{64}$"))
	' "$diagnostic_before")"
	client_request_id="nested-closeout-${run_id}-${invariant_digest}"
fi

if jq --exit-status '.pr_manifest == null' "$diagnostic_before" >/dev/null; then
	jq --compact-output '.single_closeout_target' "$diagnostic_before" \
		>"$tmp_dir/targets.jsonl"
else
	jq --compact-output '.declared_prs[]' "$diagnostic_before" \
		>"$tmp_dir/targets.jsonl"
fi

while IFS= read -r row; do
	repo_slug="$(jq --exit-status --raw-output \
		'.probe_repo_slug | select(type == "string" and length > 0)' <<<"$row")"
	pr_number="$(jq --exit-status --raw-output \
		'.pr_number | select(type == "number" and . > 0)' <<<"$row")"
	frozen_head="$(jq --exit-status --raw-output \
		'.frozen_head_sha | select(test("^[0-9a-f]{40}$"))' <<<"$row")"
	pr_json="$(gh pr view "$pr_number" --repo "$repo_slug" --json state,headRefOid)"
	jq --exit-status \
		--arg expected_head "$frozen_head" \
		'.state == "MERGED" and .headRefOid == $expected_head' \
		<<<"$pr_json" >/dev/null
	echo "PROOF $repo_slug#$pr_number @ $frozen_head MERGED"
done <"$tmp_dir/targets.jsonl"

if [[ "$recovered" == "0" ]]; then
	jq --null-input \
		--arg reason "nested_manual_closeout: all declared PRs merged" \
		--arg request_id "$client_request_id" \
		--arg digest "$invariant_digest" '
		{
			reason: $reason,
			clientRequestId: $request_id,
			closeoutInvariantDigest: $digest
		}
	' >"$tmp_dir/request.json"
	status="$(
		curl_auth |
			curl --silent --show-error --config - \
				--request POST \
				--header 'Content-Type: application/json' \
				--data-binary "@$tmp_dir/request.json" \
				--output "$tmp_dir/termination.json" \
				--write-out '%{http_code}' \
				"$base/terminate"
	)"
	if [[ "$status" != "200" ]]; then
		echo "terminate HTTP $status; rerun the complete script after resolving the refusal" >&2
		[[ -f "$tmp_dir/termination.json" ]] &&
			sed -n '1,80p' "$tmp_dir/termination.json" >&2
		exit 1
	fi
	jq --exit-status \
		--arg run_id "$run_id" '
		.success == true and .runId == $run_id and .status == "terminated"
	' "$tmp_dir/termination.json" >/dev/null
fi

diagnostic_after="$tmp_dir/diagnostic-after.json"
get_diagnostic "$diagnostic_after"
validate_snapshot "$diagnostic_after" "terminated"
jq --exit-status \
	--arg digest "$invariant_digest" \
	--arg request_id "$client_request_id" '
	.latest_termination.closeout_kind == "nested_manual"
	and .latest_termination.closeout_invariant_digest == $digest
	and .latest_termination.client_request_id == $request_id
' "$diagnostic_after" >/dev/null

echo "CLOSEOUT OK — run $run_id terminated with invariant $invariant_digest."
echo "Automatic Linear Done/archive is intentionally disabled; complete those manual steps only after re-reading the diagnostic endpoint."
