#!/usr/bin/env bash
# FLY-1395 — real-process Codex A/B/C assembly visibility proof.
#
# Uses production Blueprint probe + CODEX_HOME provisioning code against a
# temporary homes root. It never writes ~/.agents/skills or ~/.codex. Requires
# a logged-in Codex CLI and built edge-worker/claude-runner packages.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
QA_TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1395-codex-qa.XXXXXX")"
trap 'rm -rf -- "$QA_TMP"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[QA] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[QA] ✗ $1"; }

require_file() {
	if [[ -f "$1" ]]; then return 0; fi
	echo "[QA] missing build artifact: $1" >&2
	echo "[QA] run: pnpm --filter flywheel-edge-worker... build" >&2
	exit 1
}

require_file "$ROOT/packages/edge-worker/dist/Blueprint.js"
require_file "$ROOT/packages/claude-runner/dist/codex-home.js"
require_file "$ROOT/vendor/matt-skills/skills/tdd/SKILL.md"

SOURCE_CODEX_HOME="${QA_SOURCE_CODEX_HOME:-$HOME/.codex}"
if [[ ! -f "$SOURCE_CODEX_HOME/auth.json" ]]; then
	echo "[QA] Codex auth seed missing: $SOURCE_CODEX_HOME/auth.json" >&2
	exit 1
fi

export FLYWHEEL_CODEX_HOMES_ROOT="$QA_TMP/homes"
export FLYWHEEL_CODEX_SOURCE_HOME="$SOURCE_CODEX_HOME"
export FLYWHEEL_REPO_ROOT="$ROOT"

echo "[QA] Step 1 — provision A/B/C through production code into $FLYWHEEL_CODEX_HOMES_ROOT"
node --input-type=module <<'NODE'
import path from "node:path";
import { defaultCodexSkillAssemblyProbe } from "./packages/edge-worker/dist/Blueprint.js";
import { provisionCodexHome } from "./packages/claude-runner/dist/codex-home.js";

const root = process.env.FLYWHEEL_REPO_ROOT;
if (!root) throw new Error("FLYWHEEL_REPO_ROOT missing");
const agentsSkillsDir = path.join(process.env.HOME, ".agents", "skills");
const mattSkillsSourceDir = path.join(root, "vendor", "matt-skills", "skills");
const bare = defaultCodexSkillAssemblyProbe({
  mode: "bare",
  agentsSkillsDir,
  mattSkillsSourceDir,
});
const matt = defaultCodexSkillAssemblyProbe({
  mode: "matt",
  agentsSkillsDir,
  mattSkillsSourceDir,
});

provisionCodexHome({ executionId: "arm-a", env: process.env });
provisionCodexHome({
  executionId: "arm-b",
  env: process.env,
  skillFrameworkMode: "matt",
  codexSkillDisableNames: matt.disableNames,
  codexMattSkillsSourceDir: matt.mattSkillsSourceDir,
});
provisionCodexHome({
  executionId: "arm-c",
  env: process.env,
  skillFrameworkMode: "bare",
  codexSkillDisableNames: bare.disableNames,
});
console.log(`[QA] one-pass disable list entries: ${bare.disableNames.length}`);
NODE

A_HOME="$FLYWHEEL_CODEX_HOMES_ROOT/arm-a"
B_HOME="$FLYWHEEL_CODEX_HOMES_ROOT/arm-b"
C_HOME="$FLYWHEEL_CODEX_HOMES_ROOT/arm-c"

if ! grep -q 'flywheel-managed skills (FLY-1395)' "$A_HOME/config.toml"; then
	pass "A static: config has zero managed skill delta"
else
	fail "A static: managed skill delta leaked into config"
fi
if grep -q 'name = "superpowers:' "$B_HOME/config.toml"; then
	pass "B static: superpowers disable entries rendered"
else
	fail "B static: disable entries missing"
fi
if grep -q 'name = "superpowers:' "$C_HOME/config.toml"; then
	pass "C static: superpowers disable entries rendered"
else
	fail "C static: disable entries missing"
fi

MATT_COUNT="$(find "$B_HOME/skills" -mindepth 2 -maxdepth 2 -path '*/matt-skills:*/*' -name SKILL.md | wc -l | tr -d ' ')"
if [[ "$MATT_COUNT" == "6" ]]; then
	pass "B static: all six matt skills copied into the per-runner home"
else
	fail "B static: expected 6 matt skills, found $MATT_COUNT"
fi
if [[ ! -d "$C_HOME/skills" ]] ||
	[[ -z "$(find "$C_HOME/skills" -mindepth 1 -maxdepth 1 -name 'matt-skills:*' -print -quit)" ]]; then
	pass "C static: no matt skill directory"
else
	fail "C static: matt skill directory leaked"
fi

echo "[QA] Step 2 — strict-config oracle for the pinned skills.config surface"
mkdir -p "$QA_TMP/work"
ORACLE_OUT="$QA_TMP/oracle.txt"
if CODEX_HOME="$A_HOME" codex exec --strict-config \
	-c 'skills.config=[]' --skip-git-repo-check --ephemeral \
	--sandbox read-only -C "$QA_TMP/work" --output-last-message "$ORACLE_OUT" \
	'Reply with exactly OK.' < /dev/null >/dev/null 2>&1; then
	pass "strict-config accepts the pinned skills.config surface"
else
	fail "strict-config rejected skills.config (Codex version drift?)"
fi

QUESTION='Inspect only the Available skills catalog already supplied in your system context; do not use terminal tools. Answer on one line with exactly SUPERPOWERS=YES|NO MATT=YES|NO. SUPERPOWERS is YES iff any displayed skill identifier starts with superpowers:. MATT is YES iff any displayed skill identifier starts with matt-skills:.'

ask_arm() {
	local arm="$1"
	local home="$2"
	local output="$QA_TMP/${arm}.txt"
	local -a model_args=()
	if [[ -n "${QA_MODEL:-}" ]]; then model_args=(-m "$QA_MODEL"); fi
	CODEX_HOME="$home" codex exec --strict-config --skip-git-repo-check \
		--ephemeral --sandbox read-only -C "$QA_TMP/work" \
		"${model_args[@]}" --output-last-message "$output" "$QUESTION" \
		< /dev/null >/dev/null 2>&1
	tr '[:lower:]' '[:upper:]' < "$output" | tr -d '`'
}

assert_visibility() {
	local arm="$1" response="$2" expected_super="$3" expected_matt="$4"
	echo "      $arm → $response"
	if [[ "$response" == *"SUPERPOWERS=$expected_super"* ]]; then
		pass "$arm behavior: superpowers=$expected_super"
	else
		fail "$arm behavior: expected superpowers=$expected_super"
	fi
	if [[ "$response" == *"MATT=$expected_matt"* ]]; then
		pass "$arm behavior: matt=$expected_matt"
	else
		fail "$arm behavior: expected matt=$expected_matt"
	fi
}

echo "[QA] Step 3 — real Codex process visibility (positive control first)"
A_RESPONSE="$(ask_arm A "$A_HOME")"
assert_visibility A "$A_RESPONSE" YES NO
B_RESPONSE="$(ask_arm B "$B_HOME")"
assert_visibility B "$B_RESPONSE" NO YES
C_RESPONSE="$(ask_arm C "$C_HOME")"
assert_visibility C "$C_RESPONSE" NO NO

echo "[QA] Step 4 — process-level static evidence"
echo "      B config managed blocks:"
sed -n '/flywheel-managed skills (FLY-1395)/,/flywheel-managed skills (FLY-1395)/p' "$B_HOME/config.toml"
echo "      B skills listing:"
find "$B_HOME/skills" -mindepth 2 -maxdepth 3 -name SKILL.md -print | sort
echo "      C config managed blocks:"
sed -n '/flywheel-managed skills (FLY-1395)/,/flywheel-managed skills (FLY-1395)/p' "$C_HOME/config.toml"

echo "[QA] $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]]
