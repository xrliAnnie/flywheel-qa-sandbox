#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/engineering/doc/FLY-2259-raya-brain-cutover"
REGISTER="$DOC/materials/register-codex-lead.py"
EDIT_ENV="$DOC/materials/edit-raya-env.py"
PROJECT_ROW="$DOC/materials/projects.raya-row.json"
ASSIGNMENTS="$DOC/materials/assignments.json"
RUNBOOK="$DOC/activation-runbook.md"
TMP_ROOT="$(mktemp -d /tmp/fly2259-raya-materials.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }
owner_of() { stat -c %u:%g "$1" 2>/dev/null || stat -f %u:%g "$1" 2>/dev/null; }
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

projects="$TMP_ROOT/projects.json"
row="$TMP_ROOT/row.json"
printf '%s\n' '[{"projectName":"existing","projectRoot":"/tmp/existing","leads":[]}]' >"$projects"
printf '%s\n' '{"projectName":"new-project","projectRoot":"/tmp/new","leads":[]}' >"$row"
chmod 640 "$projects"
alternate_gid="$(id -G | awk -v primary="$(id -g)" '{ for (i = 1; i <= NF; i++) if ($i != primary) { print $i; exit } }')"
if [ -n "$alternate_gid" ]; then
	chgrp "$alternate_gid" "$projects"
fi
projects_owner="$(owner_of "$projects")"

if python3 "$REGISTER" "$projects" "$row" >/dev/null 2>"$TMP_ROOT/register.err" \
	&& jq -e 'length == 2 and .[1].projectName == "new-project"' "$projects" >/dev/null \
	&& [ "$(mode_of "$projects")" = 640 ] \
	&& [ "$(owner_of "$projects")" = "$projects_owner" ]; then
	pass "generic registrar atomically appends one project and preserves owner/mode"
else
	fail "generic registrar happy path ($(cat "$TMP_ROOT/register.err" 2>/dev/null))"
fi

before_sha="$(sha_of "$projects")"
before_mode="$(mode_of "$projects")"
if python3 "$REGISTER" "$projects" "$row" >/dev/null 2>"$TMP_ROOT/duplicate.err"; then
	fail "generic registrar accepted a duplicate projectName"
elif grep -Fq 'projectName already exists: new-project' "$TMP_ROOT/duplicate.err" \
	&& [ "$(sha_of "$projects")" = "$before_sha" ] && [ "$(mode_of "$projects")" = "$before_mode" ]; then
	pass "duplicate projectName fails without changing registry bytes or mode"
else
	fail "duplicate projectName failure changed the registry"
fi

memory_arg='RAYA_MEMORY_FILE=/Users/xiaorongli/Dev/raya-lead-workspace/memory/MEMORY.md'
roots_arg='RAYA_WORKSPACE_ROOTS_JSON=["/Users/xiaorongli/.flywheel/raya/code","/Users/xiaorongli/Dev/raya-lead-workspace/memory"]'
env_file="$TMP_ROOT/raya.env"
env_backup="$TMP_ROOT/raya.env.backup"
printf '%s\n' \
	'KEEP=exact' \
	'RAYA_MEMORY_FILE=/Users/xiaorongli/.flywheel/raya/memory/MEMORY.md' \
	'RAYA_WORKSPACE_ROOTS_JSON=["/Users/xiaorongli/.flywheel/raya/code","/Users/xiaorongli/.flywheel/raya/memory"]' \
	'TAIL=unchanged' >"$env_file"
chmod 600 "$env_file"
cp -p "$env_file" "$env_backup"
env_owner="$(owner_of "$env_file")"

if python3 "$EDIT_ENV" "$env_file" "$memory_arg" "$roots_arg" >/dev/null 2>"$TMP_ROOT/edit.err" \
	&& grep -Fqx "$memory_arg" "$env_file" \
	&& grep -Fqx "$roots_arg" "$env_file" \
	&& [ "$(mode_of "$env_file")" = 600 ] \
	&& [ "$(owner_of "$env_file")" = "$env_owner" ]; then
	pass "Raya env editor changes exactly the reviewed keys and preserves owner/mode"
else
	fail "Raya env editor happy path ($(cat "$TMP_ROOT/edit.err" 2>/dev/null))"
fi

if python3 "$EDIT_ENV" --verify "$env_backup" "$env_file" >/dev/null 2>"$TMP_ROOT/verify.err"; then
	pass "Raya env verifier accepts the exact two-key transition"
else
	fail "Raya env verifier rejected the reviewed transition ($(cat "$TMP_ROOT/verify.err" 2>/dev/null))"
fi

duplicate_env="$TMP_ROOT/raya.duplicate.env"
cp -p "$env_backup" "$duplicate_env"
printf '%s\n' 'RAYA_MEMORY_FILE=/second/value' >>"$duplicate_env"
duplicate_sha="$(sha_of "$duplicate_env")"
if python3 "$EDIT_ENV" "$duplicate_env" "$memory_arg" "$roots_arg" >/dev/null 2>"$TMP_ROOT/edit-duplicate.err"; then
	fail "Raya env editor accepted a duplicate target key"
elif grep -Fq 'must appear exactly once' "$TMP_ROOT/edit-duplicate.err" \
	&& [ "$(sha_of "$duplicate_env")" = "$duplicate_sha" ]; then
	pass "duplicate target key fails without changing env bytes"
else
	fail "duplicate target key failure was ambiguous or mutated bytes"
fi

unrelated_env="$TMP_ROOT/raya.unrelated.env"
sed 's/^KEEP=exact$/KEEP=changed/' "$env_file" >"$unrelated_env"
chmod 600 "$unrelated_env"
if python3 "$EDIT_ENV" --verify "$env_backup" "$unrelated_env" >/dev/null 2>"$TMP_ROOT/unrelated.err"; then
	fail "Raya env verifier accepted an unrelated line change"
elif grep -Fq 'non-target content changed' "$TMP_ROOT/unrelated.err"; then
	pass "Raya env verifier rejects unrelated content changes"
else
	fail "unrelated-line diagnostic is ambiguous"
fi

wrong_target_env="$TMP_ROOT/raya.wrong-target.env"
sed 's#^RAYA_MEMORY_FILE=.*#RAYA_MEMORY_FILE=/wrong/MEMORY.md#' "$env_file" >"$wrong_target_env"
chmod 600 "$wrong_target_env"
if python3 "$EDIT_ENV" --verify "$env_backup" "$wrong_target_env" >/dev/null 2>"$TMP_ROOT/wrong-target.err"; then
	fail "Raya env verifier accepted a wrong target value"
elif grep -Fq 'target value mismatch' "$TMP_ROOT/wrong-target.err"; then
	pass "Raya env verifier rejects wrong target values"
else
	fail "wrong-target diagnostic is ambiguous"
fi

wrong_mode_env="$TMP_ROOT/raya.wrong-mode.env"
cp -p "$env_file" "$wrong_mode_env"
chmod 644 "$wrong_mode_env"
if python3 "$EDIT_ENV" --verify "$env_backup" "$wrong_mode_env" >/dev/null 2>"$TMP_ROOT/wrong-mode.err"; then
	fail "Raya env verifier accepted mode other than 0600"
elif grep -Fq 'mode must be 0600' "$TMP_ROOT/wrong-mode.err"; then
	pass "Raya env verifier rejects a non-0600 current file"
else
	fail "wrong-mode diagnostic is ambiguous"
fi

if jq -e '
  .projectName == "raya" and
  .projectRoot == "/Users/xiaorongli/Dev/raya-lead-workspace" and
  .projectRepo == "xrliAnnie/raya" and
  .memoryAllowedUsers == ["annie", "raya"] and
  .generalChannel == "1542079099928059987" and
  (.leads | length) == 1 and
  .leads[0].agentId == "raya" and
  .leads[0].backend == "codex-app-server" and
  .leads[0].codexProfile == "full-access" and
  .leads[0].canSpawnRunners == false and
  (.leads[0].companion // false) == false and
  .leads[0].summaryRole == "recipient" and
  .leads[0].codexResidencyPatrol == true and
  .leads[0].match.labels == ["raya-lead"]
' "$PROJECT_ROW" >/dev/null 2>&1; then
	pass "reviewed Raya project row pins the canonical non-companion resident identity"
else
	fail "Raya project row is missing or drifted"
fi

identity_projects="$TMP_ROOT/identity-projects.json"
if jq -s . "$PROJECT_ROW" >"$identity_projects" 2>/dev/null; then
	identity="$(node "$ROOT/packages/flywheel-comm/dist/index.js" lead-identity resolve \
		--projects-file "$identity_projects" --project raya --lead raya --format json 2>/dev/null || true)"
else
	identity=""
fi
if jq -e '
  .role == "cos" and .botUserId == "1542068543645024257" and
  .model == "gpt-5.6-sol" and .effort == "xhigh" and
  .modelContextWindow == 1000000 and .summaryRole == "recipient" and
  .hasSummaryDuty == false and
  (.summaryGranularity == "per-lead" or .summaryGranularity == "per-project")
' <<<"$identity" >/dev/null 2>&1; then
	pass "installed identity resolver accepts the reviewed Raya row"
else
	fail "reviewed Raya row does not resolve canonically ($identity)"
fi

if jq -e '
  (.assignments | length) == 17 and
  ([.assignments[] | (.projectName + "\u0000" + .leadId)] as $keys |
    ($keys | unique | length) == ($keys | length)) and
  ([.assignments[] | select(.projectName == "raya" and .leadId == "raya" and .summaryRole == "recipient")] | length) == 1 and
  ([.projectAggregators[] | select(.projectName == "raya")] | length) == 0 and
  (.projectAggregators | length) == 6
' "$ASSIGNMENTS" >/dev/null 2>&1; then
	pass "summary assignments add Raya once without inventing an aggregator"
else
	fail "summary assignment material is missing or malformed"
fi

rehearsal_home="$TMP_ROOT/rehearsal-home"
rehearsal_projects="$rehearsal_home/.flywheel/projects.json"
rehearsal_manifests="$rehearsal_home/.flywheel/manifests"
mkdir -p "$rehearsal_manifests" "$rehearsal_home/Library/LaunchAgents"
printf '%s\n' '[]' >"$rehearsal_projects"
chmod 600 "$rehearsal_projects"
rehearsal_log="$TMP_ROOT/rehearsal-materialize.log"
if python3 "$REGISTER" "$rehearsal_projects" "$PROJECT_ROW" >/dev/null 2>"$TMP_ROOT/rehearsal-register.err" \
	&& bash "$ROOT/scripts/materialize-lead-manifests.sh" \
		--home "$rehearsal_home" --projects "$rehearsal_projects" --manifests-dir "$rehearsal_manifests" \
		>"$rehearsal_log" 2>"$TMP_ROOT/rehearsal-materialize.err" \
	&& [ "$(find "$rehearsal_manifests" -type f -name '*.json' | wc -l | tr -d ' ')" -eq 1 ] \
	&& [ "$(grep -c '^materialize: wrote ' "$rehearsal_log")" -eq 1 ] \
	&& jq -e --arg projects "$rehearsal_projects" '
		.projectName == "raya" and .leadId == "raya" and
		.projectDir == "/Users/xiaorongli/Dev/raya-lead-workspace" and .workspace == .projectDir and
		.projectsFile == $projects and .leadBackend.backendId == "codex-app-server"
	' "$rehearsal_manifests/raya-raya.json" >/dev/null 2>&1; then
	pass "temporary HOME registration and materialization produce exactly the Raya manifest"
else
	fail "temporary HOME registration/materialization rehearsal drifted"
fi

rehearsal_plist="$rehearsal_home/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist"
cp "$ROOT/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist" "$rehearsal_plist"
fake_bin="$TMP_ROOT/fake-bin"
fake_launchctl_log="$TMP_ROOT/fake-launchctl.log"
mkdir -p "$fake_bin"
printf '%s\n' \
	'#!/bin/bash' \
	'set -eu' \
	'printf "%s" "$1" >>"$FAKE_LAUNCHCTL_LOG"' \
	'shift' \
	'for arg in "$@"; do printf "|%s" "$arg" >>"$FAKE_LAUNCHCTL_LOG"; done' \
	'printf "\\n" >>"$FAKE_LAUNCHCTL_LOG"' \
	'if [ "${1:-}" = "gui/501/com.flywheel.lead.raya-raya" ]; then' \
	'  printf "state = running\\npid = 4242\\n"' \
	'fi' >"$fake_bin/launchctl"
chmod +x "$fake_bin/launchctl"
: >"$fake_launchctl_log"
if plutil -lint "$rehearsal_plist" >/dev/null \
	&& FAKE_LAUNCHCTL_LOG="$fake_launchctl_log" PATH="$fake_bin:$PATH" \
		launchctl bootstrap gui/501 "$rehearsal_plist" \
	&& FAKE_LAUNCHCTL_LOG="$fake_launchctl_log" PATH="$fake_bin:$PATH" \
		launchctl print gui/501/com.flywheel.lead.raya-raya >"$TMP_ROOT/fake-launchctl.print" \
	&& grep -Fxq "bootstrap|gui/501|$rehearsal_plist" "$fake_launchctl_log" \
	&& grep -Fxq 'print|gui/501/com.flywheel.lead.raya-raya' "$fake_launchctl_log" \
	&& grep -Fxq 'state = running' "$TMP_ROOT/fake-launchctl.print" \
	&& grep -Fxq 'pid = 4242' "$TMP_ROOT/fake-launchctl.print" \
	&& [ ! -e "$rehearsal_home/Library/LaunchAgents/com.flywheel.lead.raya-raya.tui.plist" ]; then
	pass "fake launchctl rehearsal births only the exact non-tui Raya label"
else
	fail "fake launchctl birth rehearsal failed"
fi

partial_dir="$TMP_ROOT/partial-manifests"
partial_attempt="$TMP_ROOT/partial-attempt"
partial_before="$TMP_ROOT/partial.before"
partial_after="$TMP_ROOT/partial.after"
mkdir -p "$partial_dir" "$partial_attempt"
printf '%s\n' '{}' >"$partial_dir/existing.json"
ls "$partial_dir"/*.json | sort >"$partial_before"
printf '%s\n' \
	'#!/bin/bash' \
	'set -eu' \
	'printf "{}\\n" >"$1"' \
	'printf "materialize: wrote %s\\n" "$1"' \
	'exit 7' >"$TMP_ROOT/fake-materialize.sh"
chmod +x "$TMP_ROOT/fake-materialize.sh"
bash "$TMP_ROOT/fake-materialize.sh" "$partial_dir/raya-raya.json" | tee "$TMP_ROOT/partial-materialize.log" >/dev/null
partial_pipe_rc=("${PIPESTATUS[@]}")
ls "$partial_dir"/*.json | sort >"$partial_after"
comm -13 "$partial_before" "$partial_after" >"$partial_attempt/new-manifests.txt"
while IFS= read -r added; do
	case "$added" in "$partial_dir/"*.json) mv "$added" "$partial_attempt/" ;; *) false ;; esac
done <"$partial_attempt/new-manifests.txt"
ls "$partial_dir"/*.json | sort >"$partial_attempt/current"
if [ "${partial_pipe_rc[0]}" -eq 7 ] && [ "${partial_pipe_rc[1]}" -eq 0 ] \
	&& grep -Fxq "$partial_dir/raya-raya.json" "$partial_attempt/new-manifests.txt" \
	&& cmp -s "$partial_before" "$partial_attempt/current" \
	&& [ -f "$partial_attempt/raya-raya.json" ]; then
	pass "partial materializer failure preserves PIPESTATUS evidence and R3 restores the baseline"
else
	fail "partial materializer failure rehearsal did not roll back exactly"
fi

required_runbook_literals='set -euo pipefail
register-codex-lead.py
edit-raya-env.py --verify
pipe_rc=("${PIPESTATUS[@]}")
FLY2259_MERGE_SHA
http://127.0.0.1:9876/health
com.flywheel.lead.raya-raya
resident-codex-lead-recover.sh --project raya --lead raya --probe
kill -STOP "$T0_pid"
kill -CONT "$T0_pid"
[ ! -e "$HOME/Dev/raya-lead-workspace/memory" ]
R1 — registry + receipt
R5 — emergency watcher'
runbook_ok=1
if [ ! -f "$RUNBOOK" ]; then
	runbook_ok=0
else
	while IFS= read -r literal; do
		grep -Fq "$literal" "$RUNBOOK" || runbook_ok=0
	done <<<"$required_runbook_literals"
fi
if [ "$runbook_ok" -eq 1 ] \
	&& [ "$(sed -n '1p' "$RUNBOOK")" = '# FLY-2259 Raya 脑迁入受管常驻体制 — 激活操作手册' ] \
	&& grep -Fq 'Issue: FLY-2259 (' "$RUNBOOK" \
	&& grep -Fq '日期: 2026-09-03' "$RUNBOOK" \
	&& grep -Fq '基于: plan.md' "$RUNBOOK"; then
	pass "activation runbook carries the pinned birth, recovery, and rollback predicates"
else
	fail "activation runbook is missing reviewed predicates or required metadata"
fi

unsafe_and_guards="$TMP_ROOT/unsafe-and-guards.txt"
awk '
	/^[[:space:]]*\[[^]]+\][[:space:]]*&&[[:space:]]*\[/ && $0 !~ /\|\|/ {
		print NR ":" $0
	}
' "$RUNBOOK" >"$unsafe_and_guards"
if [ ! -s "$unsafe_and_guards" ]; then
	pass "activation runbook has no standalone AND-list guards that set -e can ignore"
else
	fail "activation runbook has standalone AND-list guards ($(tr '\n' ';' <"$unsafe_and_guards"))"
fi

memory_guard_home="$TMP_ROOT/memory-guard-home"
source_memory="$memory_guard_home/.flywheel/raya/memory"
destination_memory="$memory_guard_home/Dev/raya-lead-workspace/memory"
mkdir -p "$source_memory" "$destination_memory"
printf '%s\n' '# source memory' >"$source_memory/MEMORY.md"
printf '%s\n' 'destination residue' >"$destination_memory/residue.txt"
memory_move_snippet="$(awk '
	/^install -d -m 700 "\$HOME\/Dev\/raya-lead-workspace"/ { capture = 1 }
	capture { print }
	capture && /^\[ ! -e "\$HOME\/\.flywheel\/raya\/memory" \]/ { exit }
' "$RUNBOOK")"
if HOME="$memory_guard_home" bash -c "set -euo pipefail
$memory_move_snippet" >/dev/null 2>"$TMP_ROOT/memory-guard.err"; then
	fail "memory destination residue was accepted"
elif [ -r "$source_memory/MEMORY.md" ] \
	&& [ ! -e "$destination_memory/memory" ] \
	&& grep -Fxq 'destination residue' "$destination_memory/residue.txt"; then
	pass "memory destination residue fails before mv and preserves both trees"
else
	fail "memory destination guard failed only after mutating the source tree"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
