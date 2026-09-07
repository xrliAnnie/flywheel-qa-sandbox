#!/usr/bin/env bash
# FLY-2401: hermetic contracts for Raya read-side activation materials.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOC="$ROOT/engineering/doc/FLY-2401-raya-read-activation"
MATERIALS="$DOC/materials"
RENDER="$MATERIALS/render-production-diff.py"
TRANSITION="$MATERIALS/transition-raya-env.py"
VERIFY_STATE="$MATERIALS/verify-activation-state.py"
VERIFY_ROUND="$MATERIALS/verify-first-round.py"
TARGET="$MATERIALS/raya-env-target.json"
ROW="$ROOT/engineering/doc/FLY-2259-raya-brain-cutover/materials/projects.raya-row.json"
PLIST="$ROOT/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist"
CHECKLIST="$DOC/activation-checklist.md"
tmp_parent="${TMPDIR:-/tmp}"
TMP_ROOT="$(mktemp -d "${tmp_parent%/}/fly2401-raya-read-activation.XXXXXX")"
DISCORD_SERVER_PID=""
cleanup() {
	if [ -n "$DISCORD_SERVER_PID" ]; then
		kill "$DISCORD_SERVER_PID" 2>/dev/null || true
		wait "$DISCORD_SERVER_PID" 2>/dev/null || true
	fi
	rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

PASS=0
FAIL=0

pass() {
	PASS=$((PASS + 1))
	printf '[TEST] ok - %s\n' "$1"
}

fail() {
	FAIL=$((FAIL + 1))
	printf '[TEST] FAIL - %s\n' "$1" >&2
}

sha_of() {
	shasum -a 256 "$1" | awk '{print $1}'
}

mode_of() {
	stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null
}

fingerprint() {
	local path="$1"
	if [ -L "$path" ]; then
		printf 'link:%s:%s\n' "$(readlink "$path")" "$(mode_of "$path")"
	elif [ -f "$path" ]; then
		printf 'file:%s:%s\n' "$(sha_of "$path")" "$(mode_of "$path")"
	else
		printf 'absent\n'
	fi
}

tree_fingerprint() {
	local root="$1" path relative
	find "$root" -mindepth 1 -print | LC_ALL=C sort | while IFS= read -r path; do
		relative="${path#"$root"/}"
		if [ -L "$path" ]; then
			printf 'L\t%s\t%s\t%s\n' "$relative" "$(mode_of "$path")" "$(readlink "$path")"
		elif [ -d "$path" ]; then
			printf 'D\t%s\t%s\n' "$relative" "$(mode_of "$path")"
		elif [ -f "$path" ]; then
			printf 'F\t%s\t%s\t%s\n' "$relative" "$(mode_of "$path")" "$(sha_of "$path")"
		fi
	done
}

if grep -Fq '.phase == "pre"' "$CHECKLIST" \
	&& grep -Fq '.phase=="active"' "$CHECKLIST" \
	&& ! grep -Eq '\.mode ?== ?"(pre|active)"' "$CHECKLIST" \
	&& ! grep -Fq 'scripts/codex-home-link-truth.sh' "$CHECKLIST" \
	&& grep -Fq 'FLY2404_HELPER:?' "$CHECKLIST"; then
	pass "operator checklist gates use the verifier phase contract"
else
	fail "operator checklist gates drifted from the verifier phase contract"
fi

fixture_home="$TMP_ROOT/home"
projects="$TMP_ROOT/projects.json"
raya_env="$TMP_ROOT/raya.env"
identity_source="$TMP_ROOT/code/IDENTITY.md"
identity_projection="$TMP_ROOT/identity/IDENTITY.md"
mkdir -p "$fixture_home" "$(dirname "$identity_source")" "$(dirname "$identity_projection")"
printf '%s\n' \
	'[{"projectName":"existing","projectRoot":"/tmp/existing","leads":[{"agentId":"old-lead"}]}]' \
	>"$projects"
printf '%s\n' \
	'KEEP_SECRET=must-never-appear' \
	"RAYA_MEMORY_FILE=$fixture_home/.flywheel/raya/memory/MEMORY.md" \
	"RAYA_WORKSPACE_ROOTS_JSON=[\"$fixture_home/.flywheel/raya/code\",\"$fixture_home/.flywheel/raya/memory\"]" \
	>"$raya_env"
printf '%s\n' \
	'# Raya identity' \
	'Use summary merge receipts and report every summary absorption round.' \
	>"$identity_source"
printf '%s\n' '# Old Raya identity' >"$identity_projection"

projects_sha_before="$(sha_of "$projects")"
env_sha_before="$(sha_of "$raya_env")"
source_sha_before="$(sha_of "$identity_source")"
projection_sha_before="$(sha_of "$identity_projection")"
expected_memory="$fixture_home/Dev/raya-lead-workspace/memory/MEMORY.md"
expected_code="$fixture_home/.flywheel/raya/code"
expected_voice="$fixture_home/.flywheel/raya/code/apps/voice/assets/start-instructions.zh.md"
expected_plist="$fixture_home/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist"

renderer_stdout="$TMP_ROOT/renderer.json"
renderer_stderr="$TMP_ROOT/renderer.err"
if python3 "$RENDER" \
	--home "$fixture_home" \
	--projects "$projects" \
	--raya-env "$raya_env" \
	--identity-source "$identity_source" \
	--identity-projection "$identity_projection" \
	--project-row "$ROW" \
	--plist-template "$PLIST" \
	--env-target "$TARGET" \
	>"$renderer_stdout" 2>"$renderer_stderr" \
	&& jq -e \
		--slurpfile row "$ROW" \
		--arg memory "$expected_memory" \
		--arg code "$expected_code" \
		--arg voice "$expected_voice" \
		--arg plist "$expected_plist" \
		--arg source_sha "$source_sha_before" \
		--arg projection_sha "$projection_sha_before" \
		--arg plist_sha "$(sha_of "$PLIST")" '
		.schemaVersion == 1 and
		.productionWritesPerformed == false and
		.projectsPatch == [{"op":"add","path":"/1","value":$row[0]}] and
		.fleetIdentityImpact == {
			"currentLeadCount":1,
			"targetLeadCount":2,
			"allExistingLeadsRequireRestart":true,
			"reason":"summaryAssignmentDigest covers the full Lead registry"
		} and
		.envPatch == [
			{"key":"RAYA_MEMORY_FILE","before":.envPatch[0].before,"after":$memory},
			{"key":"RAYA_WORKSPACE_ROOTS_JSON","before":.envPatch[1].before,"after":[$code,($memory|sub("/MEMORY.md$";""))]},
			{"key":"RAYA_VOICE_OPTIONS_JSON","before":null,"after":{"startInstructionsFile":$voice}}
		] and
		.identityProjection.operation == "audit_only" and
		.identityProjection.mutationPlanned == false and
		.identityProjection.authoritativeForLead == false and
		.identityProjection.sourceSha256 == $source_sha and
		.identityProjection.projectionSha256 == $projection_sha and
		(.identityProjection.diff | contains("--- identity-projection") and contains("+++ identity-source")) and
		.launchdPlist == {"operation":"create","targetPath":$plist,"templateSha256":$plist_sha}
	' "$renderer_stdout" >/dev/null \
	&& ! grep -Fq 'must-never-appear' "$renderer_stdout" \
	&& [ "$(sha_of "$projects")" = "$projects_sha_before" ] \
	&& [ "$(sha_of "$raya_env")" = "$env_sha_before" ] \
	&& [ "$(sha_of "$identity_source")" = "$source_sha_before" ] \
	&& [ "$(sha_of "$identity_projection")" = "$projection_sha_before" ] \
	&& [ ! -e "$fixture_home/Dev/raya-lead-workspace" ] \
	&& [ ! -e "$expected_plist" ] \
	&& [ ! -e "$fixture_home/.flywheel/manifests/raya-raya.json" ]; then
	pass "renderer emits the scoped Raya activation proposal"
else
	fail "renderer emits the scoped Raya activation proposal ($(tr '\n' ' ' <"$renderer_stderr"))"
fi

R_PROJECTS="$projects"
R_ENV="$raya_env"
R_SOURCE="$identity_source"
R_PROJECTION="$identity_projection"
R_ROW="$ROW"
R_PLIST="$PLIST"
R_TARGET="$TARGET"

expect_renderer_reject() {
	local name="$1" needle="$2" watched="$3"
	local out="$TMP_ROOT/reject-${name}.out" err="$TMP_ROOT/reject-${name}.err"
	local before after
	before="$(fingerprint "$watched")"
	if python3 "$RENDER" \
		--home "$fixture_home" \
		--projects "$R_PROJECTS" \
		--raya-env "$R_ENV" \
		--identity-source "$R_SOURCE" \
		--identity-projection "$R_PROJECTION" \
		--project-row "$R_ROW" \
		--plist-template "$R_PLIST" \
		--env-target "$R_TARGET" \
		>"$out" 2>"$err"; then
		fail "$name renderer input was accepted"
		return
	fi
	after="$(fingerprint "$watched")"
	if grep -Fq "$needle" "$err" \
		&& [ "$before" = "$after" ] \
		&& [ ! -s "$out" ] \
		&& ! grep -Fq 'must-never-appear' "$err" \
		&& [ ! -e "$expected_plist" ] \
		&& [ ! -e "$fixture_home/.flywheel/manifests/raya-raya.json" ]; then
		pass "$name is rejected without writes"
	else
		fail "$name rejection was ambiguous or mutated input ($(tr '\n' ' ' <"$err"))"
	fi
}

duplicate_projects="$TMP_ROOT/projects.duplicate.json"
jq --slurpfile row "$ROW" '. + [$row[0]]' "$projects" >"$duplicate_projects"
R_PROJECTS="$duplicate_projects"
expect_renderer_reject "duplicate-raya-project" "already exists" "$duplicate_projects"
R_PROJECTS="$projects"

duplicate_lead_projects="$TMP_ROOT/projects.duplicate-lead.json"
printf '%s\n' \
	'[{"projectName":"other","leads":[{"agentId":"raya"}]}]' \
	>"$duplicate_lead_projects"
R_PROJECTS="$duplicate_lead_projects"
expect_renderer_reject "duplicate-raya-lead" "already exists" "$duplicate_lead_projects"
R_PROJECTS="$projects"

duplicate_env="$TMP_ROOT/raya.duplicate.env"
cp "$raya_env" "$duplicate_env"
printf '%s\n' 'RAYA_MEMORY_FILE=/duplicate' >>"$duplicate_env"
R_ENV="$duplicate_env"
expect_renderer_reject "duplicate-env-key" "must appear exactly once" "$duplicate_env"
R_ENV="$raya_env"

invalid_voice_env="$TMP_ROOT/raya.invalid-voice.env"
cp "$raya_env" "$invalid_voice_env"
printf '%s\n' 'RAYA_VOICE_OPTIONS_JSON={broken' >>"$invalid_voice_env"
R_ENV="$invalid_voice_env"
expect_renderer_reject "invalid-voice-json" "must be valid JSON" "$invalid_voice_env"
R_ENV="$raya_env"

array_voice_env="$TMP_ROOT/raya.array-voice.env"
cp "$raya_env" "$array_voice_env"
printf '%s\n' 'RAYA_VOICE_OPTIONS_JSON=[]' >>"$array_voice_env"
R_ENV="$array_voice_env"
expect_renderer_reject "voice-json-array" "must be a JSON object" "$array_voice_env"
R_ENV="$raya_env"

projects_link="$TMP_ROOT/projects.link.json"
ln -s "$projects" "$projects_link"
R_PROJECTS="$projects_link"
expect_renderer_reject "symlink-projects" "regular non-symlink" "$projects_link"
R_PROJECTS="$projects"

env_link="$TMP_ROOT/raya.link.env"
ln -s "$raya_env" "$env_link"
R_ENV="$env_link"
expect_renderer_reject "symlink-env" "regular non-symlink" "$env_link"
R_ENV="$raya_env"

source_link="$TMP_ROOT/identity-source.link.md"
ln -s "$identity_source" "$source_link"
R_SOURCE="$source_link"
expect_renderer_reject "symlink-identity-source" "regular non-symlink" "$source_link"
R_SOURCE="$identity_source"

projection_link="$TMP_ROOT/identity-projection.link.md"
ln -s "$identity_projection" "$projection_link"
R_PROJECTION="$projection_link"
expect_renderer_reject "symlink-identity-projection" "regular non-symlink" "$projection_link"
R_PROJECTION="$identity_projection"

plist_link="$TMP_ROOT/raya.link.plist"
ln -s "$PLIST" "$plist_link"
R_PLIST="$plist_link"
expect_renderer_reject "symlink-plist" "regular non-symlink" "$plist_link"
R_PLIST="$PLIST"

target_link="$TMP_ROOT/target.link.json"
ln -s "$TARGET" "$target_link"
R_TARGET="$target_link"
expect_renderer_reject "symlink-env-target" "regular non-symlink" "$target_link"
R_TARGET="$TARGET"

identity_oversize="$TMP_ROOT/identity.oversize.md"
dd if=/dev/zero of="$identity_oversize" bs=1048577 count=1 2>/dev/null
R_SOURCE="$identity_oversize"
expect_renderer_reject "oversize-identity" "input is too large" "$identity_oversize"
R_SOURCE="$identity_source"

transition_env="$TMP_ROOT/transition.env"
transition_original="$TMP_ROOT/transition.original.env"
transition_backup="$TMP_ROOT/transition.before.env"
printf '%s\n' \
	'KEEP_SECRET=must-never-appear' \
	"RAYA_MEMORY_FILE=$fixture_home/.flywheel/raya/memory/MEMORY.md" \
	"RAYA_WORKSPACE_ROOTS_JSON=[\"$fixture_home/.flywheel/raya/code\",\"$fixture_home/.flywheel/raya/memory\"]" \
	'TAIL=unchanged' \
	>"$transition_env"
chmod 600 "$transition_env"
cp -p "$transition_env" "$transition_original"
transition_err="$TMP_ROOT/transition.err"
if python3 "$TRANSITION" apply \
	--home "$fixture_home" --target "$TARGET" \
	--env "$transition_env" --backup "$transition_backup" \
	>/dev/null 2>"$transition_err" \
	&& python3 "$TRANSITION" verify \
		--home "$fixture_home" --target "$TARGET" \
		--before "$transition_backup" --current "$transition_env" \
		>/dev/null 2>>"$transition_err" \
	&& [ "$(mode_of "$transition_env")" = 600 ] \
	&& [ "$(mode_of "$transition_backup")" = 600 ] \
	&& cmp -s "$transition_original" "$transition_backup" \
	&& grep -Fxq "RAYA_MEMORY_FILE=$expected_memory" "$transition_env" \
	&& grep -Fxq "RAYA_WORKSPACE_ROOTS_JSON=[\"$expected_code\",\"${expected_memory%/MEMORY.md}\"]" "$transition_env" \
	&& grep -Fxq "RAYA_VOICE_OPTIONS_JSON={\"startInstructionsFile\":\"$expected_voice\"}" "$transition_env" \
	&& grep -Fxq 'KEEP_SECRET=must-never-appear' "$transition_env" \
	&& grep -Fxq 'TAIL=unchanged' "$transition_env" \
	&& python3 "$TRANSITION" rollback \
		--home "$fixture_home" --target "$TARGET" \
		--backup "$transition_backup" --env "$transition_env" \
		>/dev/null 2>>"$transition_err" \
	&& cmp -s "$transition_original" "$transition_env" \
	&& cmp -s "$transition_original" "$transition_backup" \
	&& ! grep -Fq 'must-never-appear' "$transition_err"; then
	pass "three-key env transition applies, verifies, and rolls back atomically"
else
	fail "three-key env transition applies, verifies, and rolls back atomically ($(tr '\n' ' ' <"$transition_err"))"
fi

expect_transition_apply_reject() {
	local name="$1" needle="$2" env_path="$3" backup_path="$4"
	local out="$TMP_ROOT/transition-${name}.out" err="$TMP_ROOT/transition-${name}.err"
	local env_before backup_before env_after backup_after
	env_before="$(fingerprint "$env_path")"
	backup_before="$(fingerprint "$backup_path")"
	if python3 "$TRANSITION" apply \
		--home "$fixture_home" --target "$TARGET" \
		--env "$env_path" --backup "$backup_path" \
		>"$out" 2>"$err"; then
		fail "$name transition input was accepted"
		return
	fi
	env_after="$(fingerprint "$env_path")"
	backup_after="$(fingerprint "$backup_path")"
	if grep -Fq "$needle" "$err" \
		&& [ "$env_before" = "$env_after" ] \
		&& [ "$backup_before" = "$backup_after" ] \
		&& [ ! -s "$out" ] \
		&& ! grep -Fq 'must-never-appear' "$err"; then
		pass "$name transition is rejected without partial writes"
	else
		fail "$name transition rejection was ambiguous or mutated state ($(tr '\n' ' ' <"$err"))"
	fi
}

transition_extra="$TMP_ROOT/transition.extra.env"
transition_extra_backup="$TMP_ROOT/transition.extra.before"
printf '%s\n' \
	"RAYA_MEMORY_FILE=$fixture_home/.flywheel/raya/memory/MEMORY.md" \
	"RAYA_WORKSPACE_ROOTS_JSON=[\"$fixture_home/.flywheel/raya/code\",\"$fixture_home/.flywheel/raya/memory\"]" \
	'RAYA_VOICE_OPTIONS_JSON={"other":"keep","startInstructionsFile":"/old"}' \
	>"$transition_extra"
chmod 600 "$transition_extra"
if python3 "$TRANSITION" apply --home "$fixture_home" --target "$TARGET" \
	--env "$transition_extra" --backup "$transition_extra_backup" >/dev/null \
	&& python3 "$TRANSITION" verify --home "$fixture_home" --target "$TARGET" \
		--before "$transition_extra_backup" --current "$transition_extra" >/dev/null \
	&& grep -Fxq "RAYA_VOICE_OPTIONS_JSON={\"other\":\"keep\",\"startInstructionsFile\":\"$expected_voice\"}" "$transition_extra"; then
	pass "transition preserves unrelated voice option keys"
else
	fail "transition did not preserve unrelated voice option keys"
fi

transition_duplicate="$TMP_ROOT/transition.duplicate.env"
cp -p "$transition_original" "$transition_duplicate"
printf '%s\n' 'RAYA_MEMORY_FILE=/duplicate' >>"$transition_duplicate"
expect_transition_apply_reject "duplicate-key" "must appear exactly once" \
	"$transition_duplicate" "$TMP_ROOT/transition.duplicate.before"

transition_invalid_voice="$TMP_ROOT/transition.invalid-voice.env"
cp -p "$transition_original" "$transition_invalid_voice"
printf '%s\n' 'RAYA_VOICE_OPTIONS_JSON={broken' >>"$transition_invalid_voice"
expect_transition_apply_reject "invalid-voice" "must be valid JSON" \
	"$transition_invalid_voice" "$TMP_ROOT/transition.invalid-voice.before"

transition_array_voice="$TMP_ROOT/transition.array-voice.env"
cp -p "$transition_original" "$transition_array_voice"
printf '%s\n' 'RAYA_VOICE_OPTIONS_JSON=[]' >>"$transition_array_voice"
expect_transition_apply_reject "array-voice" "must be a JSON object" \
	"$transition_array_voice" "$TMP_ROOT/transition.array-voice.before"

transition_wrong_mode="$TMP_ROOT/transition.wrong-mode.env"
cp "$transition_original" "$transition_wrong_mode"
chmod 644 "$transition_wrong_mode"
expect_transition_apply_reject "wrong-mode" "mode must be 0600" \
	"$transition_wrong_mode" "$TMP_ROOT/transition.wrong-mode.before"

transition_link="$TMP_ROOT/transition.link.env"
ln -s "$transition_original" "$transition_link"
expect_transition_apply_reject "symlink-env" "regular non-symlink" \
	"$transition_link" "$TMP_ROOT/transition.link.before"

transition_oversize="$TMP_ROOT/transition.oversize.env"
dd if=/dev/zero of="$transition_oversize" bs=1048577 count=1 2>/dev/null
chmod 600 "$transition_oversize"
expect_transition_apply_reject "oversize-env" "input is too large" \
	"$transition_oversize" "$TMP_ROOT/transition.oversize.before"

transition_existing_backup_env="$TMP_ROOT/transition.existing-backup.env"
transition_existing_backup="$TMP_ROOT/transition.existing.backup"
cp -p "$transition_original" "$transition_existing_backup_env"
printf '%s\n' 'existing backup sentinel' >"$transition_existing_backup"
chmod 600 "$transition_existing_backup"
expect_transition_apply_reject "existing-backup" "backup already exists" \
	"$transition_existing_backup_env" "$transition_existing_backup"

transition_drift_env="$TMP_ROOT/transition.drift.env"
transition_drift_backup="$TMP_ROOT/transition.drift.before"
cp -p "$transition_original" "$transition_drift_env"
if python3 "$TRANSITION" apply --home "$fixture_home" --target "$TARGET" \
	--env "$transition_drift_env" --backup "$transition_drift_backup" >/dev/null; then
	printf '%s\n' 'UNRELATED_DRIFT=1' >>"$transition_drift_env"
	drift_before="$(fingerprint "$transition_drift_env")"
	if python3 "$TRANSITION" rollback --home "$fixture_home" --target "$TARGET" \
		--backup "$transition_drift_backup" --env "$transition_drift_env" \
		>"$TMP_ROOT/transition-drift.out" 2>"$TMP_ROOT/transition-drift.err"; then
		fail "rollback accepted unrelated current drift"
	elif grep -Fq 'non-target content changed' "$TMP_ROOT/transition-drift.err" \
		&& [ "$drift_before" = "$(fingerprint "$transition_drift_env")" ]; then
		pass "rollback rejects unrelated drift without overwriting current env"
	else
		fail "rollback drift rejection was ambiguous or mutated current env"
	fi
else
	fail "rollback drift fixture could not be prepared"
fi

state_home="$TMP_ROOT/state-home"
state_projects="$TMP_ROOT/state-projects.json"
state_raya_env="$TMP_ROOT/state-raya.env"
state_global_env="$TMP_ROOT/state-global.env"
state_identity_source="$state_home/.flywheel/raya/code/IDENTITY.md"
state_identity_projection="$state_home/.flywheel/raya/identity/IDENTITY.md"
state_old_memory="$state_home/.flywheel/raya/memory"
state_codex_home="$state_home/.codex-raya"
state_codex_truth="$state_home/.codex/auth.json"
state_installed_wrapper="$state_home/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"
state_installed_plist="$state_home/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist"
state_manifest="$state_home/.flywheel/manifests/raya-raya.json"
state_voice_asset="$state_home/.flywheel/raya/code/apps/voice/assets/start-instructions.zh.md"
mkdir -p \
	"$state_old_memory" \
	"$(dirname "$state_identity_source")" \
	"$(dirname "$state_identity_projection")" \
	"$(dirname "$state_codex_truth")" \
	"$state_codex_home/packages/standalone/current" \
	"$(dirname "$state_installed_wrapper")" \
	"$(dirname "$state_installed_plist")" \
	"$(dirname "$state_manifest")" \
	"$(dirname "$state_voice_asset")"
printf '%s\n' '[]' >"$state_projects"
printf '%s\n' \
	"RAYA_MEMORY_FILE=$state_home/.flywheel/raya/memory/MEMORY.md" \
	"RAYA_WORKSPACE_ROOTS_JSON=[\"$state_home/.flywheel/raya/code\",\"$state_home/.flywheel/raya/memory\"]" \
	>"$state_raya_env"
chmod 600 "$state_raya_env"
printf '%s\n' \
	'UNRELATED_SECRET=do-not-print' \
	'RAYA_BOT_TOKEN=state-token-must-never-appear' \
	>"$state_global_env"
chmod 600 "$state_global_env"
printf '%s\n' \
	'# Raya' \
	'Use summary merge for each summary-absorption round and publish a visible report.' \
	>"$state_identity_source"
printf '%s\n' '# Old product identity' >"$state_identity_projection"
chmod 444 "$state_identity_projection"
printf '%s\n' '# Voice instructions for Raya' >"$state_voice_asset"
printf '%s\n' '# Memory' >"$state_old_memory/MEMORY.md"
git -C "$state_old_memory" init -q
git -C "$state_old_memory" add MEMORY.md
git -C "$state_old_memory" \
	-c user.name=test -c user.email=test@example.com -c commit.gpgsign=false \
	commit -qm base
chmod 700 "$state_codex_home"
printf '%s\n' '{"tokens":{"access_token":"fixture"}}' >"$state_codex_truth"
chmod 600 "$state_codex_truth"
ln -s "$state_codex_truth" "$state_codex_home/auth.json"
printf '%s\n' '#!/bin/sh' 'printf "codex-cli fixture\n"' \
	>"$state_codex_home/packages/standalone/current/codex"
chmod 755 "$state_codex_home/packages/standalone/current/codex"
cp "$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" "$state_installed_wrapper"
chmod 555 "$state_installed_wrapper"

state_before="$(tree_fingerprint "$state_home")"
state_pre_out="$TMP_ROOT/state-pre.json"
state_pre_err="$TMP_ROOT/state-pre.err"
if python3 "$VERIFY_STATE" pre \
	--home "$state_home" \
	--projects "$state_projects" \
	--raya-env "$state_raya_env" \
	--global-env "$state_global_env" \
	--project-row "$ROW" \
	--env-target "$TARGET" \
	--identity-source "$state_identity_source" \
	--identity-projection "$state_identity_projection" \
	--wrapper-source "$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
	--wrapper-installed "$state_installed_wrapper" \
	--plist-template "$PLIST" \
	--installed-plist "$state_installed_plist" \
	--manifest "$state_manifest" \
	>"$state_pre_out" 2>"$state_pre_err" \
	&& jq -e '
		.schemaVersion == 1 and .phase == "pre" and .ready == true and
		.productionWritesPerformed == false and
		([.checks[] | select(.status != "pass")] | length) == 0 and
		([.checks[].id] | contains([
			"registry","source_memory","destination_workspace","codex_home",
			"codex_auth","codex_binary","wrapper","row","plist_template",
			"voice_asset","token_selector","env","identity_source",
			"identity_projection","installed_plist","manifest"
		])) and
		([.checks[] | select(
			.id == "codex_auth" and .status == "pass" and
			.detail == "absolute symlink to canonical truth mode=0600"
		)] | length) == 1 and
		([.advisories[] | select(.id == "identity_projection_drift")] | length) == 1
	' "$state_pre_out" >/dev/null \
	&& [ "$state_before" = "$(tree_fingerprint "$state_home")" ] \
	&& ! grep -Fq 'state-token-must-never-appear' "$state_pre_out" \
	&& ! grep -Fq 'state-token-must-never-appear' "$state_pre_err"; then
	pass "pre activation state is verified read-only"
else
	fail "pre activation state verifier contract ($(tr '\n' ' ' <"$state_pre_err"))"
fi

expect_pre_report_fail() {
	local name="$1" check_id="$2" watched="$3" wrapper_path="$4"
	local out="$TMP_ROOT/pre-${name}.json" err="$TMP_ROOT/pre-${name}.err"
	local before after tree_before tree_after rc=0
	before="$(fingerprint "$watched")"
	tree_before="$(tree_fingerprint "$state_home")"
	python3 "$VERIFY_STATE" pre \
		--home "$state_home" --projects "$state_projects" --raya-env "$state_raya_env" \
		--global-env "$state_global_env" --project-row "$ROW" --env-target "$TARGET" \
		--identity-source "$state_identity_source" --identity-projection "$state_identity_projection" \
		--wrapper-source "$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
		--wrapper-installed "$wrapper_path" --plist-template "$PLIST" \
		--installed-plist "$state_installed_plist" --manifest "$state_manifest" \
		>"$out" 2>"$err" || rc=$?
	after="$(fingerprint "$watched")"
	tree_after="$(tree_fingerprint "$state_home")"
	if [ "$rc" -eq 1 ] \
		&& jq -e --arg id "$check_id" '
			.ready == false and .productionWritesPerformed == false and
			([.checks[] | select(.id == $id and .status == "fail")] | length) == 1
		' "$out" >/dev/null \
		&& [ "$before" = "$after" ] \
		&& [ "$tree_before" = "$tree_after" ] \
		&& ! grep -Fq 'state-token-must-never-appear' "$out" \
		&& ! grep -Fq 'state-token-must-never-appear' "$err"; then
		pass "$name pre-state rejection retains the complete JSON report"
	else
		fail "$name pre-state rejection lost its JSON report or mutated input (rc=$rc $(tr '\n' ' ' <"$err"))"
	fi
}

state_wrapper_link="$TMP_ROOT/state-wrapper.link"
ln -s "$state_installed_wrapper" "$state_wrapper_link"
expect_pre_report_fail "symlink-wrapper" "wrapper" "$state_wrapper_link" "$state_wrapper_link"

state_voice_real="$TMP_ROOT/state-voice.real.md"
mv "$state_voice_asset" "$state_voice_real"
ln -s "$state_voice_real" "$state_voice_asset"
expect_pre_report_fail "symlink-voice-asset" "voice_asset" "$state_voice_asset" "$state_installed_wrapper"
rm "$state_voice_asset"
mv "$state_voice_real" "$state_voice_asset"

active_home="$TMP_ROOT/active-home"
active_projects="$TMP_ROOT/active-projects.json"
active_raya_env="$TMP_ROOT/active-raya.env"
active_global_env="$TMP_ROOT/active-global.env"
active_identity_source="$active_home/.flywheel/raya/code/IDENTITY.md"
active_identity_projection="$active_home/.flywheel/raya/identity/IDENTITY.md"
active_wrapper="$active_home/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"
active_plist="$active_home/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist"
active_manifest="$active_home/.flywheel/manifests/raya-raya.json"
active_workspace="$active_home/Dev/raya-lead-workspace"
active_memory="$active_workspace/memory"
active_voice="$active_home/.flywheel/raya/code/apps/voice/assets/start-instructions.zh.md"
active_codex_truth="$active_home/.codex/auth.json"
mkdir -p \
	"$(dirname "$active_identity_source")" \
	"$(dirname "$active_identity_projection")" \
	"$(dirname "$active_wrapper")" \
	"$(dirname "$active_plist")" \
	"$(dirname "$active_manifest")" \
	"$(dirname "$active_voice")" \
	"$(dirname "$active_codex_truth")" \
	"$active_workspace/state" \
	"$active_home/.codex-raya/packages/standalone/current"
cp -R "$state_old_memory" "$active_memory"
cp "$state_identity_source" "$active_identity_source"
cp "$state_identity_projection" "$active_identity_projection"
chmod 444 "$active_identity_projection"
cp "$state_voice_asset" "$active_voice"
cp "$state_installed_wrapper" "$active_wrapper"
chmod 555 "$active_wrapper"
cp "$state_codex_truth" "$active_codex_truth"
chmod 700 "$active_home/.codex-raya"
chmod 600 "$active_codex_truth"
ln -s "$active_codex_truth" "$active_home/.codex-raya/auth.json"
cp "$state_codex_home/packages/standalone/current/codex" \
	"$active_home/.codex-raya/packages/standalone/current/codex"
chmod 755 "$active_home/.codex-raya/packages/standalone/current/codex"
cp "$PLIST" "$active_plist"
jq -s . "$ROW" >"$active_projects"
printf '%s\n' \
	"RAYA_MEMORY_FILE=$active_memory/MEMORY.md" \
	"RAYA_WORKSPACE_ROOTS_JSON=[\"$active_home/.flywheel/raya/code\",\"$active_memory\"]" \
	"RAYA_VOICE_OPTIONS_JSON={\"startInstructionsFile\":\"$active_voice\"}" \
	>"$active_raya_env"
chmod 600 "$active_raya_env"
cp -p "$state_global_env" "$active_global_env"
jq -n \
	--arg project_dir "$active_workspace" \
	--arg projects_file "$active_projects" '
	{
		projectName:"raya", leadId:"raya",
		projectDir:$project_dir, workspace:$project_dir,
		projectsFile:$projects_file,
		leadBackend:{backendId:"codex-app-server"}
	}' >"$active_manifest"

active_before="$(tree_fingerprint "$active_home")"
active_out="$TMP_ROOT/state-active.json"
active_err="$TMP_ROOT/state-active.err"
if python3 "$VERIFY_STATE" active \
	--home "$active_home" \
	--projects "$active_projects" \
	--raya-env "$active_raya_env" \
	--global-env "$active_global_env" \
	--project-row "$ROW" \
	--env-target "$TARGET" \
	--identity-source "$active_identity_source" \
	--identity-projection "$active_identity_projection" \
	--wrapper-source "$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
	--wrapper-installed "$active_wrapper" \
	--plist-template "$PLIST" \
	--installed-plist "$active_plist" \
	--manifest "$active_manifest" \
	>"$active_out" 2>"$active_err" \
	&& jq -e '
		.schemaVersion == 1 and .phase == "active" and .ready == true and
		.productionWritesPerformed == false and
		([.checks[] | select(.status != "pass")] | length) == 0 and
		.runtimeChecksRequired == [
			"launchd","tmux","heartbeat","discord_roundtrip","bridge_reload",
			"full_fleet_identity_refresh","raya_runtime_registration"
		] and
		([.checks[] | select(
			.id == "codex_auth" and .status == "pass" and
			.detail == "absolute symlink to canonical truth mode=0600"
		)] | length) == 1 and
		([.advisories[] | select(.id == "identity_projection_drift")] | length) == 1
	' "$active_out" >/dev/null \
	&& [ "$active_before" = "$(tree_fingerprint "$active_home")" ] \
	&& ! grep -Fq 'state-token-must-never-appear' "$active_out" \
	&& ! grep -Fq 'state-token-must-never-appear' "$active_err"; then
	pass "active activation state is verified read-only"
else
	fail "active activation state verifier contract ($(tr '\n' ' ' <"$active_err"))"
fi

A_PROJECTS="$active_projects"
A_ENV="$active_raya_env"
A_GLOBAL_ENV="$active_global_env"
A_IDENTITY_SOURCE="$active_identity_source"
A_IDENTITY_PROJECTION="$active_identity_projection"
A_WRAPPER="$active_wrapper"
A_PLIST="$active_plist"
A_MANIFEST="$active_manifest"

expect_active_fail() {
	local name="$1" check_id="$2" watched="$3"
	local out="$TMP_ROOT/active-${name}.json" err="$TMP_ROOT/active-${name}.err"
	local before after tree_before tree_after rc=0
	before="$(fingerprint "$watched")"
	tree_before="$(tree_fingerprint "$active_home")"
	python3 "$VERIFY_STATE" active \
		--home "$active_home" \
		--projects "$A_PROJECTS" \
		--raya-env "$A_ENV" \
		--global-env "$A_GLOBAL_ENV" \
		--project-row "$ROW" \
		--env-target "$TARGET" \
		--identity-source "$A_IDENTITY_SOURCE" \
		--identity-projection "$A_IDENTITY_PROJECTION" \
		--wrapper-source "$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
		--wrapper-installed "$A_WRAPPER" \
		--plist-template "$PLIST" \
		--installed-plist "$A_PLIST" \
		--manifest "$A_MANIFEST" \
		>"$out" 2>"$err" || rc=$?
	after="$(fingerprint "$watched")"
	tree_after="$(tree_fingerprint "$active_home")"
	if [ "$rc" -eq 1 ] \
		&& jq -e --arg id "$check_id" '
			.ready == false and
			([.checks[] | select(.id == $id and .status == "fail")] | length) == 1
		' "$out" >/dev/null \
		&& [ "$before" = "$after" ] \
		&& [ "$tree_before" = "$tree_after" ] \
		&& ! grep -Fq 'state-token-must-never-appear' "$out" \
		&& ! grep -Fq 'state-token-must-never-appear' "$err"; then
		pass "$name active state is rejected by $check_id without writes"
	else
		fail "$name active-state rejection was ambiguous or mutated input (rc=$rc $(tr '\n' ' ' <"$err"))"
	fi
}

active_duplicate_projects="$TMP_ROOT/active-projects.duplicate.json"
jq '. + [.[0]]' "$active_projects" >"$active_duplicate_projects"
A_PROJECTS="$active_duplicate_projects"
expect_active_fail "duplicate-raya" "registry" "$active_duplicate_projects"
A_PROJECTS="$active_projects"

active_old_env="$TMP_ROOT/active-old-root.env"
cp -p "$active_raya_env" "$active_old_env"
sed "s#$active_memory#$active_home/.flywheel/raya/memory#g" "$active_raya_env" >"$active_old_env"
chmod 600 "$active_old_env"
A_ENV="$active_old_env"
expect_active_fail "old-env-root" "env" "$active_old_env"
A_ENV="$active_raya_env"

active_bad_identity="$TMP_ROOT/active-bad-identity.md"
printf '%s\n' '# Raya without the required contract' >"$active_bad_identity"
A_IDENTITY_SOURCE="$active_bad_identity"
expect_active_fail "identity-contract-missing" "identity_source" "$active_bad_identity"
A_IDENTITY_SOURCE="$active_identity_source"

active_bad_manifest="$TMP_ROOT/active-bad-manifest.json"
jq '.workspace = "/wrong/workspace"' "$active_manifest" >"$active_bad_manifest"
A_MANIFEST="$active_bad_manifest"
expect_active_fail "manifest-workspace-drift" "manifest" "$active_bad_manifest"
A_MANIFEST="$active_manifest"

tui_case="$TMP_ROOT/tui-case"
mkdir -p "$tui_case"
cp "$PLIST" "$tui_case/com.flywheel.lead.raya-raya.plist"
cp "$PLIST" "$tui_case/com.flywheel.lead.raya-raya.tui.plist"
A_PLIST="$tui_case/com.flywheel.lead.raya-raya.plist"
expect_active_fail "tui-plist-residue" "installed_plist" "$tui_case/com.flywheel.lead.raya-raya.tui.plist"
A_PLIST="$active_plist"

active_projection_0644="$TMP_ROOT/active-projection-0644.md"
cp "$active_identity_projection" "$active_projection_0644"
chmod 644 "$active_projection_0644"
A_IDENTITY_PROJECTION="$active_projection_0644"
projection_mode_out="$TMP_ROOT/active-projection-mode.json"
if python3 "$VERIFY_STATE" active \
	--home "$active_home" --projects "$A_PROJECTS" --raya-env "$A_ENV" \
	--global-env "$A_GLOBAL_ENV" --project-row "$ROW" --env-target "$TARGET" \
	--identity-source "$A_IDENTITY_SOURCE" --identity-projection "$A_IDENTITY_PROJECTION" \
	--wrapper-source "$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
	--wrapper-installed "$A_WRAPPER" --plist-template "$PLIST" \
	--installed-plist "$A_PLIST" --manifest "$A_MANIFEST" \
	>"$projection_mode_out" 2>/dev/null \
	&& jq -e '
		.ready == true and
		([.checks[] | select(.id == "identity_projection" and .status == "pass")] | length) == 1 and
		([.advisories[] | select(.id == "identity_projection_mode")] | length) == 1
	' "$projection_mode_out" >/dev/null; then
	pass "product projection mode drift is audit-only for Lead readiness"
else
	fail "product projection mode drift incorrectly blocked Lead readiness"
fi
A_IDENTITY_PROJECTION="$active_identity_projection"

active_duplicate_global="$TMP_ROOT/active-global.duplicate.env"
cp -p "$active_global_env" "$active_duplicate_global"
printf '%s\n' 'RAYA_BOT_TOKEN=second-token-must-never-appear' >>"$active_duplicate_global"
A_GLOBAL_ENV="$active_duplicate_global"
expect_active_fail "duplicate-token-selector" "token_selector" "$active_duplicate_global"
A_GLOBAL_ENV="$active_global_env"

active_bad_wrapper="$TMP_ROOT/active-bad-wrapper.sh"
printf '%s\n' '#!/bin/sh' 'exit 1' >"$active_bad_wrapper"
chmod 555 "$active_bad_wrapper"
A_WRAPPER="$active_bad_wrapper"
expect_active_fail "installed-wrapper-drift" "wrapper" "$active_bad_wrapper"
A_WRAPPER="$active_wrapper"

rm "$active_home/.codex-raya/auth.json"
cp "$active_codex_truth" "$active_home/.codex-raya/auth.json"
expect_active_fail "copied-codex-auth" "codex_auth" "$active_home/.codex-raya/auth.json"
rm "$active_home/.codex-raya/auth.json"
ln -s ../.codex/auth.json "$active_home/.codex-raya/auth.json"
expect_active_fail "relative-codex-auth-link" "codex_auth" "$active_home/.codex-raya/auth.json"
rm "$active_home/.codex-raya/auth.json"
wrong_codex_truth="$active_home/.codex/wrong-auth.json"
cp "$active_codex_truth" "$wrong_codex_truth"
chmod 600 "$wrong_codex_truth"
ln -s "$wrong_codex_truth" "$active_home/.codex-raya/auth.json"
expect_active_fail "wrong-codex-auth-target" "codex_auth" "$active_home/.codex-raya/auth.json"
rm "$active_home/.codex-raya/auth.json" "$wrong_codex_truth"
ln -s "$active_codex_truth" "$active_home/.codex-raya/auth.json"
chmod 644 "$active_codex_truth"
expect_active_fail "wrong-codex-truth-mode" "codex_auth" "$active_codex_truth"
chmod 600 "$active_codex_truth"

state_codex_away="$TMP_ROOT/state-codex-away"
mv "$state_codex_home" "$state_codex_away"
pending_before="$(tree_fingerprint "$state_home")"
pending_out="$TMP_ROOT/state-pending.json"
pending_err="$TMP_ROOT/state-pending.err"
pending_rc=0
python3 "$VERIFY_STATE" pre \
	--home "$state_home" --projects "$state_projects" --raya-env "$state_raya_env" \
	--global-env "$state_global_env" --project-row "$ROW" --env-target "$TARGET" \
	--identity-source "$state_identity_source" --identity-projection "$state_identity_projection" \
	--wrapper-source "$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
	--wrapper-installed "$state_installed_wrapper" --plist-template "$PLIST" \
	--installed-plist "$state_installed_plist" --manifest "$state_manifest" \
	>"$pending_out" 2>"$pending_err" || pending_rc=$?
if [ "$pending_rc" -eq 2 ] \
	&& jq -e '
		.ready == false and
		([.checks[] | select(.status == "fail")] | length) == 0 and
		([.checks[] | select(
			(.id == "codex_home" or .id == "codex_auth" or .id == "codex_binary") and
			.status == "pending"
		)] | length) == 3
	' "$pending_out" >/dev/null \
	&& [ "$pending_before" = "$(tree_fingerprint "$state_home")" ]; then
	pass "missing Raya Codex home is a read-only pre-window pending state"
else
	fail "missing Raya Codex home did not return exact pending semantics (rc=$pending_rc $(tr '\n' ' ' <"$pending_err"))"
fi
mv "$state_codex_away" "$state_codex_home"

active_projects_link="$TMP_ROOT/active-projects.link.json"
ln -s "$active_projects" "$active_projects_link"
hard_fail_before="$(tree_fingerprint "$active_home")"
hard_fail_rc=0
python3 "$VERIFY_STATE" active \
	--home "$active_home" --projects "$active_projects_link" --raya-env "$active_raya_env" \
	--global-env "$active_global_env" --project-row "$ROW" --env-target "$TARGET" \
	--identity-source "$active_identity_source" --identity-projection "$active_identity_projection" \
	--wrapper-source "$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
	--wrapper-installed "$active_wrapper" --plist-template "$PLIST" \
	--installed-plist "$active_plist" --manifest "$active_manifest" \
	>"$TMP_ROOT/state-hard-fail.out" 2>"$TMP_ROOT/state-hard-fail.err" || hard_fail_rc=$?
if [ "$hard_fail_rc" -eq 1 ] \
	&& grep -Fq 'regular non-symlink' "$TMP_ROOT/state-hard-fail.err" \
	&& [ ! -s "$TMP_ROOT/state-hard-fail.out" ] \
	&& [ "$hard_fail_before" = "$(tree_fingerprint "$active_home")" ]; then
	pass "state verifier rejects symlink input without writes"
else
	fail "state verifier symlink rejection was ambiguous or mutated fixture"
fi

round_id="summary-absorption:2026-09-07T06:00:00.000Z"
round_repo="xrliAnnie/raya"
round_pr=15
round_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
round_db="$TMP_ROOT/first-round.db"
round_receipts="$TMP_ROOT/summary-merge-receipts.jsonl"
round_memory="$TMP_ROOT/first-round-MEMORY.md"
round_pr_json="$TMP_ROOT/first-round-pr.json"
round_response="$TMP_ROOT/discord-response.json"
round_port_file="$TMP_ROOT/discord-port"
round_request_log="$TMP_ROOT/discord-request.log"

python3 - "$round_db" "$round_id" <<'PY'
import sqlite3
import sys

db_path, event_id = sys.argv[1:]
connection = sqlite3.connect(db_path)
connection.execute(
    """CREATE TABLE lead_events (
        lead_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        session_key TEXT,
        delivered_at TEXT,
        delivery_attempts INTEGER NOT NULL,
        last_delivery_error TEXT
    )"""
)
connection.execute(
    "INSERT INTO lead_events VALUES (?, ?, ?, ?, ?, ?, ?)",
    (
        "raya",
        event_id,
        "summary_absorption_round",
        "summary-absorption",
        "2026-09-07 06:00:05",
        0,
        None,
    ),
)
connection.commit()
connection.close()
PY
printf '%s\n' "{\"type\":\"merge\",\"ts\":\"2026-09-07T06:05:00.000Z\",\"roundId\":\"$round_id\",\"repo\":\"$round_repo\",\"pr\":$round_pr,\"projects\":[\"flywheel\"],\"files\":[\"summaries/flywheel/2026-09-06--flywheel-eng-lead--01.md\"],\"verifiedHeadSha\":\"$round_sha\",\"method\":\"merge\"}" >"$round_receipts"
printf '%s\n' "{\"number\":$round_pr,\"state\":\"MERGED\",\"headRefOid\":\"$round_sha\"}" >"$round_pr_json"
printf '# Raya memory\n\nRound: %s\nReceipt: %s\n' "$round_id" 'summaries/flywheel/2026-09-06--flywheel-eng-lead--01.md' >"$round_memory"
printf '%s\n' "{\"id\":\"345678901234567890\",\"channel_id\":\"234567890123456789\",\"author\":{\"id\":\"456789012345678901\"},\"content\":\"round=$round_id reviewed=1 absorbed=1\"}" >"$round_response"

python3 - "$round_port_file" "$round_request_log" "$round_response" <<'PY' &
import http.server
import json
import pathlib
import sys

port_path, request_log_path, response_path = map(pathlib.Path, sys.argv[1:])

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        request_log_path.write_text(
            json.dumps({"path": self.path, "authorization": self.headers.get("Authorization")}),
            encoding="utf-8",
        )
        payload = json.loads(response_path.read_text(encoding="utf-8"))
        redirect_to = payload.pop("_redirect_to", None)
        if redirect_to is not None and self.path != redirect_to:
            self.send_response(302)
            self.send_header("Location", redirect_to)
            self.end_headers()
            return
        status = int(payload.pop("_http_status", 200))
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_path.write_text(str(server.server_port), encoding="utf-8")
server.serve_forever()
PY
DISCORD_SERVER_PID=$!
for _attempt in $(seq 1 100); do
	[ -s "$round_port_file" ] && break
	sleep 0.02
done
round_port="$(cat "$round_port_file" 2>/dev/null || true)"

round_out="$TMP_ROOT/first-round.json"
round_err="$TMP_ROOT/first-round.err"
if FLY2401_TEST_DISCORD_TOKEN='test-token-must-never-appear' python3 "$VERIFY_ROUND" \
	--db "$round_db" --round-id "$round_id" --repo "$round_repo" --pr "$round_pr" \
	--receipts "$round_receipts" --memory "$round_memory" --pr-json "$round_pr_json" \
	--discord-message-url 'https://discord.com/channels/123456789012345678/234567890123456789/345678901234567890' \
	--discord-bot-user-id '456789012345678901' \
	--discord-token-env FLY2401_TEST_DISCORD_TOKEN \
	--discord-api-base "http://127.0.0.1:$round_port" --allow-loopback-test-endpoint \
	>"$round_out" 2>"$round_err" \
	&& jq -e \
		--arg round "$round_id" --arg repo "$round_repo" --arg sha "$round_sha" '
		.schemaVersion == 1 and .ok == true and .productionWritesPerformed == false and
		.roundId == $round and .repo == $repo and .pr == 15 and
		.verifiedHeadSha == $sha and .evidenceSource == "loopback_test" and
		.advisories == []
	' "$round_out" >/dev/null \
	&& jq -e '
		.path == "/channels/234567890123456789/messages/345678901234567890" and
		.authorization == "Bot test-token-must-never-appear"
	' "$round_request_log" >/dev/null \
	&& ! grep -Fq 'test-token-must-never-appear' "$round_out" \
	&& ! grep -Fq 'test-token-must-never-appear' "$round_err"; then
	pass "first-round verifier cross-checks DB, merge, memory, PR, and live Discord evidence"
else
	fail "first-round verifier rejected matching evidence ($(tr '\n' ' ' <"$round_err"))"
fi

FR_DB="$round_db"
FR_ROUND_ID="$round_id"
FR_REPO="$round_repo"
FR_PR="$round_pr"
FR_RECEIPTS="$round_receipts"
FR_MEMORY="$round_memory"
FR_PR_JSON="$round_pr_json"
FR_URL='https://discord.com/channels/123456789012345678/234567890123456789/345678901234567890'
FR_BOT_ID='456789012345678901'
FR_TOKEN_ENV='FLY2401_TEST_DISCORD_TOKEN'
FR_TOKEN_PRESENT=1
FR_API_BASE="http://127.0.0.1:$round_port"
FR_ALLOW_OVERRIDE=1

expect_round_reject() {
	local name="$1" needle="$2" watched="$3"
	local out="$TMP_ROOT/round-reject-${name}.out" err="$TMP_ROOT/round-reject-${name}.err"
	local before after rc=0
	local -a override_args=()
	before="$(fingerprint "$watched")"
	if [ "$FR_ALLOW_OVERRIDE" -eq 1 ]; then
		override_args=(--discord-api-base "$FR_API_BASE" --allow-loopback-test-endpoint)
	elif [ -n "$FR_API_BASE" ]; then
		override_args=(--discord-api-base "$FR_API_BASE")
	fi
	if [ "$FR_TOKEN_PRESENT" -eq 1 ]; then
		env "$FR_TOKEN_ENV=test-token-must-never-appear" python3 "$VERIFY_ROUND" \
			--db "$FR_DB" --round-id "$FR_ROUND_ID" --repo "$FR_REPO" --pr "$FR_PR" \
			--receipts "$FR_RECEIPTS" --memory "$FR_MEMORY" --pr-json "$FR_PR_JSON" \
			--discord-message-url "$FR_URL" --discord-bot-user-id "$FR_BOT_ID" \
			--discord-token-env "$FR_TOKEN_ENV" "${override_args[@]}" \
			>"$out" 2>"$err" || rc=$?
	else
		env -u "$FR_TOKEN_ENV" python3 "$VERIFY_ROUND" \
			--db "$FR_DB" --round-id "$FR_ROUND_ID" --repo "$FR_REPO" --pr "$FR_PR" \
			--receipts "$FR_RECEIPTS" --memory "$FR_MEMORY" --pr-json "$FR_PR_JSON" \
			--discord-message-url "$FR_URL" --discord-bot-user-id "$FR_BOT_ID" \
			--discord-token-env "$FR_TOKEN_ENV" "${override_args[@]}" \
			>"$out" 2>"$err" || rc=$?
	fi
	after="$(fingerprint "$watched")"
	if [ "$rc" -eq 1 ] \
		&& grep -Fq "$needle" "$err" \
		&& [ ! -s "$out" ] \
		&& [ "$before" = "$after" ] \
		&& ! grep -Fq 'test-token-must-never-appear' "$err"; then
		pass "$name first-round evidence is rejected without writes or token leakage"
	else
		fail "$name first-round rejection was ambiguous (rc=$rc $(tr '\n' ' ' <"$err"))"
	fi
}

round_response_machine="$TMP_ROOT/discord-response-machine.json"
cp "$round_response" "$round_response_machine"
jq --arg round "$round_id" \
	'.content = ("今天下午 6 点，我 review 了 11 个 PR，吸收了 8 条；roundId：" + $round)' \
	"$round_response_machine" >"$round_response"
natural_out="$TMP_ROOT/first-round-natural-report.json"
natural_err="$TMP_ROOT/first-round-natural-report.err"
if FLY2401_TEST_DISCORD_TOKEN='test-token-must-never-appear' python3 "$VERIFY_ROUND" \
	--db "$round_db" --round-id "$round_id" --repo "$round_repo" --pr "$round_pr" \
	--receipts "$round_receipts" --memory "$round_memory" --pr-json "$round_pr_json" \
	--discord-message-url "$FR_URL" --discord-bot-user-id "$FR_BOT_ID" \
	--discord-token-env FLY2401_TEST_DISCORD_TOKEN \
	--discord-api-base "$FR_API_BASE" --allow-loopback-test-endpoint \
	>"$natural_out" 2>"$natural_err" \
	&& jq -e '.ok == true and .reviewed == 11 and .absorbed == 8' "$natural_out" >/dev/null \
	&& ! grep -Fq 'test-token-must-never-appear' "$natural_out" \
	&& ! grep -Fq 'test-token-must-never-appear' "$natural_err"; then
	pass "first-round verifier accepts Raya's canonical natural Chinese report shape"
else
	fail "first-round verifier rejected canonical natural report ($(tr '\n' ' ' <"$natural_err"))"
fi
cp "$round_response_machine" "$round_response"

FR_DB="$TMP_ROOT/nonexistent-first-round.db"
expect_round_reject "missing-db" "db:unavailable" "$FR_DB"
FR_DB="$round_db"

round_zero_db="$TMP_ROOT/first-round-zero.db"
cp "$round_db" "$round_zero_db"
python3 - "$round_zero_db" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("DELETE FROM lead_events")
connection.commit()
connection.close()
PY
FR_DB="$round_zero_db"
expect_round_reject "zero-db-rows" "db:expected_exactly_one_round" "$round_zero_db"

round_two_db="$TMP_ROOT/first-round-two.db"
cp "$round_db" "$round_two_db"
python3 - "$round_two_db" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("INSERT INTO lead_events SELECT * FROM lead_events")
connection.commit()
connection.close()
PY
FR_DB="$round_two_db"
expect_round_reject "duplicate-db-rows" "db:expected_exactly_one_round" "$round_two_db"

round_undelivered_db="$TMP_ROOT/first-round-undelivered.db"
cp "$round_db" "$round_undelivered_db"
python3 - "$round_undelivered_db" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("UPDATE lead_events SET delivered_at = NULL")
connection.commit()
connection.close()
PY
FR_DB="$round_undelivered_db"
expect_round_reject "undelivered-db-row" "db:undelivered" "$round_undelivered_db"
FR_DB="$round_db"

round_missing_receipt="$TMP_ROOT/first-round-missing-receipt.jsonl"
: >"$round_missing_receipt"
FR_RECEIPTS="$round_missing_receipt"
expect_round_reject "missing-receipt" "receipts:matching_merge_missing" "$round_missing_receipt"

round_wrong_receipt="$TMP_ROOT/first-round-wrong-receipt.jsonl"
jq -c '.roundId = "summary-absorption:wrong"' "$round_receipts" >"$round_wrong_receipt"
FR_RECEIPTS="$round_wrong_receipt"
expect_round_reject "wrong-round-receipt" "receipts:matching_merge_missing" "$round_wrong_receipt"

round_conflicting_receipts="$TMP_ROOT/first-round-conflicting-receipts.jsonl"
cp "$round_receipts" "$round_conflicting_receipts"
jq -c '.verifiedHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$round_receipts" >>"$round_conflicting_receipts"
FR_RECEIPTS="$round_conflicting_receipts"
expect_round_reject "conflicting-receipt-heads" "receipts:conflicting_verified_heads" "$round_conflicting_receipts"

round_empty_files_receipt="$TMP_ROOT/first-round-empty-files-receipt.jsonl"
jq -c '.files = []' "$round_receipts" >"$round_empty_files_receipt"
FR_RECEIPTS="$round_empty_files_receipt"
expect_round_reject "empty-receipt-files" "receipts:files_invalid" "$round_empty_files_receipt"
FR_RECEIPTS="$round_receipts"

round_open_pr="$TMP_ROOT/first-round-open-pr.json"
jq '.state = "OPEN"' "$round_pr_json" >"$round_open_pr"
FR_PR_JSON="$round_open_pr"
expect_round_reject "open-pr" "pr_json:not_merged" "$round_open_pr"

round_wrong_head_pr="$TMP_ROOT/first-round-wrong-head-pr.json"
jq '.headRefOid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$round_pr_json" >"$round_wrong_head_pr"
FR_PR_JSON="$round_wrong_head_pr"
expect_round_reject "wrong-pr-head" "pr_json:head_mismatch" "$round_wrong_head_pr"
FR_PR_JSON="$round_pr_json"

round_missing_memory_round="$TMP_ROOT/first-round-memory-no-round.md"
printf '%s\n' 'summaries/flywheel/2026-09-06--flywheel-eng-lead--01.md' >"$round_missing_memory_round"
FR_MEMORY="$round_missing_memory_round"
expect_round_reject "memory-missing-round" "memory:round_missing" "$round_missing_memory_round"

round_missing_memory_file="$TMP_ROOT/first-round-memory-no-file.md"
printf '%s\n' "$round_id" >"$round_missing_memory_file"
FR_MEMORY="$round_missing_memory_file"
expect_round_reject "memory-missing-file" "memory:receipt_file_missing" "$round_missing_memory_file"
FR_MEMORY="$round_memory"

FR_TOKEN_PRESENT=0
expect_round_reject "missing-discord-token" "discord:token_missing" "$round_response"
FR_TOKEN_PRESENT=1

round_response_happy="$TMP_ROOT/discord-response-happy.json"
cp "$round_response" "$round_response_happy"
printf '%s\n' '{"_http_status":500,"error":"test failure"}' >"$round_response"
expect_round_reject "discord-http-failure" "discord:http_failed" "$round_response"

jq '. + {"_redirect_to":"/redirected-success"}' "$round_response_happy" >"$round_response"
expect_round_reject "discord-http-redirect" "discord:http_failed" "$round_response"

jq '.channel_id = "999999999999999999"' "$round_response_happy" >"$round_response"
expect_round_reject "wrong-discord-channel" "discord:channel_mismatch" "$round_response"

jq '.author.id = "999999999999999999"' "$round_response_happy" >"$round_response"
expect_round_reject "wrong-discord-author" "discord:author_mismatch" "$round_response"

jq '.id = "999999999999999999"' "$round_response_happy" >"$round_response"
expect_round_reject "wrong-discord-message" "discord:message_mismatch" "$round_response"

jq '.content = "round=summary-absorption:wrong reviewed=1 absorbed=1"' "$round_response_happy" >"$round_response"
expect_round_reject "wrong-discord-round" "discord:round_missing" "$round_response"

jq --arg round "$round_id" '.content = ("round=" + $round + " reviewed=1 absorbed=0")' "$round_response_happy" >"$round_response"
expect_round_reject "zero-discord-absorbed" "discord:absorbed_zero" "$round_response"
cp "$round_response_happy" "$round_response"

FR_API_BASE='https://example.com/api/v10'
expect_round_reject "non-loopback-api-override" "discord:api_override_not_loopback" "$round_response"
FR_API_BASE="http://127.0.0.1:$round_port"

round_stale_error_db="$TMP_ROOT/first-round-stale-error.db"
cp "$round_db" "$round_stale_error_db"
python3 - "$round_stale_error_db" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("UPDATE lead_events SET last_delivery_error = 'old test error'")
connection.commit()
connection.close()
PY
stale_out="$TMP_ROOT/first-round-stale-error.json"
stale_err="$TMP_ROOT/first-round-stale-error.err"
if FLY2401_TEST_DISCORD_TOKEN='test-token-must-never-appear' python3 "$VERIFY_ROUND" \
	--db "$round_stale_error_db" --round-id "$round_id" --repo "$round_repo" --pr "$round_pr" \
	--receipts "$round_receipts" --memory "$round_memory" --pr-json "$round_pr_json" \
	--discord-message-url "$FR_URL" --discord-bot-user-id "$FR_BOT_ID" \
	--discord-token-env FLY2401_TEST_DISCORD_TOKEN \
	--discord-api-base "http://127.0.0.1:$round_port" --allow-loopback-test-endpoint \
	>"$stale_out" 2>"$stale_err" \
	&& jq -e '
		.ok == true and .advisories == [{
			"id":"db_stale_last_delivery_error",
			"message":"delivered event retains a historical last_delivery_error"
		}]
	' "$stale_out" >/dev/null \
	&& ! grep -Fq 'old test error' "$stale_out" \
	&& ! grep -Fq 'test-token-must-never-appear' "$stale_out" \
	&& ! grep -Fq 'test-token-must-never-appear' "$stale_err"; then
	pass "stale delivery error is advisory after a successful delivery"
else
	fail "stale delivery error did not preserve successful evidence semantics ($(tr '\n' ' ' <"$stale_err"))"
fi

printf '[TEST] %s passed, %s failed\n' "$PASS" "$FAIL"
((FAIL == 0))
