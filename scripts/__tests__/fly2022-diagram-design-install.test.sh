#!/usr/bin/env bash
# FLY-2022: diagram-design must be an exact project-scoped copy with a
# first-run-safe default marker. This suite is hermetic and never uses network.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL="$ROOT/.claude/skills/diagram-design"
CONFIG="$ROOT/.diagram-design"
EXPECTED_SKILL_SHA="0d4f3cce282b128887a4ce1c4ad140b7c3fd1dafe4b5be606a68593284592971"
EXPECTED_TREE="8fe791a61ab857ae7994f90681cbd5db1ac5ee4b"
EXPECTED_UPSTREAM="648c2a597839301e06df1e7434a08bde9f42eed3"

PASSED=0
FAILED=0

pass() {
	PASSED=$((PASSED + 1))
	printf '[PASS] %s\n' "$1"
}

fail() {
	FAILED=$((FAILED + 1))
	printf '[FAIL] %s\n' "$1" >&2
}

if [[ -f "$CONFIG" ]] && cmp -s "$CONFIG" <(printf 'profile: default\n'); then
	pass '.diagram-design is exactly profile: default plus newline'
else
	fail '.diagram-design must be exactly profile: default plus newline'
fi

tracked_paths="$(git -C "$ROOT" ls-files -- .claude/skills)"
tracked_count="$(printf '%s\n' "$tracked_paths" | sed '/^$/d' | wc -l | tr -d ' ')"
unexpected_paths="$(printf '%s\n' "$tracked_paths" | sed '/^$/d' | grep -v '^\.claude/skills/diagram-design/' || true)"
if [[ "$tracked_count" == "208" && -z "$unexpected_paths" ]]; then
	pass 'tracked .claude/skills set is exactly the 208 diagram-design files'
else
	fail "tracked .claude/skills set must be exactly 208 diagram-design files (count=$tracked_count unexpected=${unexpected_paths:-none})"
fi

if [[ -f "$SKILL/SKILL.md" ]]; then
	actual_skill_sha="$(shasum -a 256 "$SKILL/SKILL.md" | awk '{print $1}')"
	if [[ "$actual_skill_sha" == "$EXPECTED_SKILL_SHA" ]]; then
		pass 'installed SKILL.md sha256 matches flywheel-skills PR #18 exact head'
	else
		fail "installed SKILL.md sha256 mismatch (actual=$actual_skill_sha)"
	fi
else
	fail 'installed SKILL.md exists'
fi

index_tree="$(git -C "$ROOT" write-tree)"
installed_tree="$(git -C "$ROOT" rev-parse --verify "$index_tree:.claude/skills/diagram-design" 2>/dev/null || true)"
if [[ "$installed_tree" == "$EXPECTED_TREE" ]]; then
	pass 'installed tracked subtree matches exact companion tree object'
else
	fail "installed tracked subtree mismatch (actual=${installed_tree:-missing})"
fi

file_count="$(find "$SKILL" -type f 2>/dev/null | wc -l | tr -d ' ')"
asset_count="$(find "$SKILL/assets" -type f 2>/dev/null | wc -l | tr -d ' ')"
reference_count="$(find "$SKILL/references" -type f 2>/dev/null | wc -l | tr -d ' ')"
script_count="$(find "$SKILL/scripts" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$file_count:$asset_count:$reference_count:$script_count" == "208:149:53:3" ]]; then
	pass 'installed file census is 208 total / 149 assets / 53 references / 3 scripts'
else
	fail "installed file census mismatch (total=$file_count assets=$asset_count references=$reference_count scripts=$script_count)"
fi

if [[ -f "$SKILL/LICENSE" && -f "$SKILL/THIRD_PARTY_LICENSES.md" ]]; then
	pass 'installed copy carries both required license files'
else
	fail 'installed copy must carry LICENSE and THIRD_PARTY_LICENSES.md'
fi

anchors=(
	"commit=$EXPECTED_UPSTREAM"
	'FLY-2015-LIMIT-1-AUTO-GENERATION-UNVERIFIED'
	'FLY-2015-QA-AUTO-GENERATION-E2E'
	'FLY-2015-LIMIT-2-CJK-FONT-FALLBACK'
	'FLY-2015-LIMIT-3-PUBLISH-REPORT-FONT-CSP'
	'FLY-2015-LIMIT-4-MOVING-UPSTREAM'
)
missing_anchors=""
for anchor in "${anchors[@]}"; do
	grep -qF -- "$anchor" "$SKILL/SKILL.md" 2>/dev/null \
		|| missing_anchors="$missing_anchors $anchor"
done
if [[ -z "$missing_anchors" ]]; then
	pass 'installed provenance, four limits, and required E2E anchor are intact'
else
	fail "installed SKILL.md is missing contract anchors:$missing_anchors"
fi

forbidden_tracked="$(git -C "$ROOT" ls-files -- \
	.agents/skills/diagram-design \
	.codex/skills/diagram-design \
	skills-lock.json)"
if [[ -z "$forbidden_tracked" ]]; then
	pass 'install has no duplicate agent copy or temp-path lockfile'
else
	fail "install must not track duplicate/global-adjacent outputs: $forbidden_tracked"
fi

printf '\n[FLY-2022] %s passed, %s failed\n' "$PASSED" "$FAILED"
((FAILED == 0))
