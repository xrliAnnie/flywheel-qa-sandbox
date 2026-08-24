#!/usr/bin/env bash
# FLY-2015: diagram-design belongs to roles that author architecture diagrams or
# founder-facing HTML. Frontmatter is documentary; body routing is the prompt
# behavior contract, so this guard requires both surfaces and keeps QA independent.
# shellcheck disable=SC2016 # Backticks below are literal prompt-contract text.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENTS_DIR="$ROOT/.flywheel/agents/engineering"

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

frontmatter_has_skill() {
	local file="$1"
	local line
	local skills
	local skill
	local -a listed
	line="$(grep -m1 '^skills:' "$file" || true)"
	if [[ -z "$line" ]]; then
		fail "$(basename "$file") frontmatter must assign diagram-design"
		return
	fi
	skills="${line#skills: [}"
	skills="${skills%]}"
	if [[ -z "$skills" ]]; then
		fail "$(basename "$file") frontmatter must assign diagram-design"
		return
	fi
	IFS=',' read -r -a listed <<<"$skills"
	for skill in "${listed[@]}"; do
		skill="${skill#"${skill%%[![:space:]]*}"}"
		skill="${skill%"${skill##*[![:space:]]}"}"
		if [[ "$skill" == "diagram-design" ]]; then
			pass "$(basename "$file") frontmatter assigns diagram-design"
			return
		fi
	done
	fail "$(basename "$file") frontmatter must assign diagram-design"
}

body_contains() {
	local file="$1"
	local needle="$2"
	local label="$3"
	if awk '/^---$/{frontmatter++; next} frontmatter >= 2 {print}' "$file" | grep -qF -- "$needle"; then
		pass "$label"
	else
		fail "$label (missing body route: $needle)"
	fi
}

roles=(
	engineer-executor.md
	designer-executor.md
	designer-executor.bare.md
	designer-executor.matt.md
	product-designer-executor.md
	prototype-executor.md
	pm-executor.md
)

for role in "${roles[@]}"; do
	frontmatter_has_skill "$AGENTS_DIR/$role"
done

body_contains \
	"$AGENTS_DIR/engineer-executor.md" \
	'For architecture, flow, relationship, or standalone HTML/SVG explanations, explicitly invoke `diagram-design` when a visual is clearer than prose or a table.' \
	'engineer explicitly routes architecture and HTML diagrams'
body_contains \
	"$AGENTS_DIR/engineer-executor.md" \
	'Skill-missing fallback: if `diagram-design` is not installed in this runtime, follow its intended HTML/SVG workflow by hand and report the missing skill to your Lead.' \
	'engineer carries a diagram-design missing-skill fallback'

for variant in designer-executor.md designer-executor.bare.md designer-executor.matt.md; do
	body_contains \
		"$AGENTS_DIR/$variant" \
		'Use `dataviz` when quantitative encoding is the point; use `diagram-design` for polished editorial flows, relationships, or architecture; keep `mermaid` for simple source-first diagrams.' \
		"$variant prose separates dataviz, diagram-design, and mermaid"
	body_contains \
		"$AGENTS_DIR/$variant" \
		'| Polished editorial flows / relationships / architecture | `diagram-design` |' \
		"$variant skill map routes polished diagrams"
done

body_contains \
	"$AGENTS_DIR/product-designer-executor.md" \
	'| Polished editorial architecture / flow / relationship diagram for a doc or spec | `diagram-design`; keep simple source-first diagrams in Mermaid syntax |' \
	'product designer separates polished diagrams from source-first Mermaid'
body_contains \
	"$AGENTS_DIR/product-designer-executor.md" \
	'Skill-missing fallback: if `diagram-design` is not installed in this runtime, follow its intended HTML/SVG workflow by hand and report the missing skill to your Lead.' \
	'product designer carries a diagram-design missing-skill fallback'

body_contains \
	"$AGENTS_DIR/prototype-executor.md" \
	'| Standalone HTML architecture / flow explanation for the prototype | `diagram-design` |' \
	'prototype routes explanatory HTML diagrams'

body_contains \
	"$AGENTS_DIR/pm-executor.md" \
	'| `diagram-design` | Add a polished architecture / flow / relationship diagram when it explains the founder-facing page better than prose or a table |' \
	'PM routes diagrams used in founder explainers'

qa="$AGENTS_DIR/qa-executor.md"
if [[ ! -f "$qa" ]]; then
	fail 'qa-executor.md missing; cannot enforce independent QA exclusion'
elif grep -qF 'diagram-design' "$qa"; then
	fail 'QA must not receive diagram-design as a default production capability'
else
	pass 'QA remains independent and is not assigned diagram-design by default'
fi

printf '\n[FLY-2015] %s passed, %s failed\n' "$PASSED" "$FAILED"
((FAILED == 0))
