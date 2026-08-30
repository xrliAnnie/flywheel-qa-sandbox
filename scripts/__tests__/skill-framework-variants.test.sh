#!/usr/bin/env bash
# FLY-1356 — contract test: matt-skills vendor structure + B/C prompt variants.
#
# The arm definitions are FROZEN artifacts. This test pins:
#   - vendor/matt-skills: plugin layout, the 6 SKILL.md files, LICENSE,
#     to-spec/to-tickets frontmatter flip (no disable-model-invocation)
#   - registered general.{matt,bare}.md variants exist; retired designer variants do not
#   - matt generic variant references `grilling`, never the bare-name
#     `brainstorming` (hyphen-aware boundary — `product-brainstorming` in the
#     bare DESIGNER variant is legitimate and must not trip this)
#   - bare generic variant is whole-word grep-zero for "Superpowers"
#     (case-insensitive, NO whitelist) and free of superpowers:* skill names
#   - baseline files stay on the A arm (no FLY-1356 variant markers)
#
# Every negative assertion carries a POSITIVE CONTROL on the baseline so a
# broken grep pattern cannot silently pass (vacuous-green discipline).
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# ── vendor structure ────────────────────────────────────────────────────────
for f in \
	vendor/matt-skills/.claude-plugin/plugin.json \
	vendor/matt-skills/.claude-plugin/marketplace.json \
	vendor/matt-skills/LICENSE \
	vendor/matt-skills/VENDOR.md \
	vendor/matt-skills/skills/tdd/SKILL.md \
	vendor/matt-skills/skills/code-review/SKILL.md \
	vendor/matt-skills/skills/grilling/SKILL.md \
	vendor/matt-skills/skills/diagnosing-bugs/SKILL.md \
	vendor/matt-skills/skills/to-spec/SKILL.md \
	vendor/matt-skills/skills/to-tickets/SKILL.md; do
	if [[ -f "$f" ]]; then pass "vendor file exists: $f"; else fail "vendor file MISSING: $f"; fi
done

if grep -q '"name": "matt-skills"' vendor/matt-skills/.claude-plugin/plugin.json &&
	grep -q '"name": "matt-skills"' vendor/matt-skills/.claude-plugin/marketplace.json; then
	pass "plugin+marketplace name = matt-skills (install key matt-skills@matt-skills)"
else
	fail "plugin/marketplace name is not matt-skills"
fi

grep -q "9603c1cc8118d08bc1b3bf34cf714f62178dea3b" vendor/matt-skills/VENDOR.md &&
	pass "VENDOR.md pins the upstream commit" || fail "VENDOR.md missing the upstream commit pin"

grep -q "MIT" vendor/matt-skills/LICENSE &&
	pass "LICENSE is the MIT text" || fail "LICENSE does not look like MIT"

# to-spec / to-tickets: model-invocation ENABLED (frontmatter line removed).
# Positive control: the pattern must match a planted sample, or the grep is broken.
printf -- "---\ndisable-model-invocation: true\n---\n" > /tmp/fly1356-dmi-control.md
if grep -q "disable-model-invocation" /tmp/fly1356-dmi-control.md; then
	pass "positive control: disable-model-invocation pattern detects a planted sample"
else
	fail "positive control BROKEN: disable-model-invocation grep finds nothing"
fi
for s in to-spec to-tickets; do
	if grep -q "disable-model-invocation" "vendor/matt-skills/skills/$s/SKILL.md"; then
		fail "$s still carries disable-model-invocation"
	else
		pass "$s frontmatter flip applied (model-invocable)"
	fi
done

# ── prompt variants exist ───────────────────────────────────────────────────
for f in \
	.flywheel/agents/nodes/general.matt.md \
	.flywheel/agents/nodes/general.bare.md; do
	if [[ -f "$f" ]]; then pass "variant exists: $f"; else fail "variant MISSING: $f"; fi
done
for f in \
	.flywheel/agents/nodes/product_design.matt.md \
	.flywheel/agents/nodes/product_design.bare.md; do
	if [[ ! -e "$f" ]]; then pass "retired variant absent: $f"; else fail "retired variant still exists: $f"; fi
done

# ── matt generic variant: grilling in, bare-name brainstorming out ─────────
grep -q "matt-skills:grilling" .flywheel/agents/nodes/general.matt.md &&
	pass "matt variant drives matt-skills:grilling" || fail "matt variant missing matt-skills:grilling"
# Hyphen-aware boundary (FLY-1326 v5): match `brainstorming` NOT preceded/followed
# by [A-Za-z0-9_-] so product-brainstorming / superpowers:brainstorming don't count.
# Positive control on the BASELINE (which says superpowers:brainstorming — that is
# a namespaced use; the bare-name control is planted).
printf "use brainstorming here\n" > /tmp/fly1356-bare-name-control.md
if grep -Eq '(^|[^A-Za-z0-9_-])brainstorming($|[^A-Za-z0-9_-])' /tmp/fly1356-bare-name-control.md; then
	pass "positive control: bare-name brainstorming pattern detects a planted sample"
else
	fail "positive control BROKEN: bare-name brainstorming pattern finds nothing"
fi
for f in .flywheel/agents/nodes/general.matt.md; do
	if grep -Eq '(^|[^A-Za-z0-9_-])brainstorming($|[^A-Za-z0-9_-])' "$f"; then
		fail "matt variant still references bare-name brainstorming: $f"
	else
		pass "no bare-name brainstorming in $f"
	fi
done
# ── bare generic variant: whole-word Superpowers grep-zero (R1#5) ──────────
# Positive control: the matt variant MUST trip the same ruler.
if grep -Eiq '(^|[^A-Za-z0-9_-])superpowers($|[^A-Za-z0-9_-])' .flywheel/agents/nodes/general.matt.md; then
	pass "positive control: Superpowers pattern fires on the matt variant"
else
	fail "positive control BROKEN: Superpowers pattern finds nothing in the matt variant"
fi
if grep -Eiq '(^|[^A-Za-z0-9_-])superpowers($|[^A-Za-z0-9_-])' .flywheel/agents/nodes/general.bare.md; then
	fail "bare variant still mentions Superpowers (whole-word, case-insensitive)"
else
	pass "bare variant is Superpowers grep-zero (no whitelist needed)"
fi
if grep -Eq 'superpowers:' .flywheel/agents/nodes/general.bare.md; then
	fail "bare variant still names a superpowers:* skill"
else
	pass "bare variant carries no superpowers:* skill names"
fi

# ── baselines stay on the A arm (variant markers must NOT leak in) ─────────
for f in .flywheel/agents/nodes/general.md .flywheel/agents/nodes/product_design.md; do
	if grep -q "FLY-1356" "$f"; then
		fail "baseline gained FLY-1356 variant markers (A arm must stay untouched): $f"
	else
		pass "baseline free of variant markers: $f"
	fi
done

rm -f /tmp/fly1356-dmi-control.md /tmp/fly1356-bare-name-control.md
echo ""
echo "[TEST] $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]] || exit 1
