#!/usr/bin/env bash
# FLY-1356 — real-machine arm-visibility QA (the research.md S1 spike,
# productized). Run BEFORE the 529-room derisk pass and after any change to
# the plugin keys / --settings mechanism.
#
# What it proves, with a positive control first (ruler check):
#   1. POSITIVE CONTROL — a default `claude -p` session HAS the Superpowers
#      SessionStart injection (if this says NO, the machine/ruler is broken;
#      every later "NO" would be meaningless).
#   2. BARE ARM — per-launch `--settings` disable removes the injection.
#   3. MATT ARM — superpowers disabled + matt-skills enabled: no Superpowers
#      injection AND the matt catalog (grilling/tdd) is visible to the model
#      (research.md R1: catalog residue check).
#   4. Prints the exact --settings JSON Blueprint hands the spawn for each arm
#      so an operator can eyeball a REAL tmux spawn in the isolated 529 room.
#
# Requires: claude CLI logged in; matt arm additionally requires
# scripts/setup-matt-skills.sh to have been run (step 3 tells you if not).
set -uo pipefail

MODEL="${QA_MODEL:-haiku}"
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[QA] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[QA] ✗ $1"; }

ask() { # ask <question> [settings-json]
	local q="$1" settings="${2:-}"
	if [[ -n "$settings" ]]; then
		claude -p --model "$MODEL" --settings "$settings" "$q" 2>/dev/null
	else
		claude -p --model "$MODEL" "$q" 2>/dev/null
	fi
}

Q_SUPERPOWERS='Does your context contain the text "using-superpowers" (the Superpowers skill system introduction)? Answer with exactly YES or NO.'
Q_MATT='Is a skill named "grilling" or "tdd" from a plugin called matt-skills available in your skill list? Answer with exactly YES or NO.'

BARE_SETTINGS='{"enabledPlugins":{"superpowers@superpowers-dev":false}}'
MATT_SETTINGS='{"enabledPlugins":{"superpowers@superpowers-dev":false,"matt-skills@matt-skills":true}}'

echo "[QA] Step 1 — positive control (default session must say YES)"
r1="$(ask "$Q_SUPERPOWERS")"
echo "      → $r1"
if [[ "$r1" == *YES* ]]; then
	pass "positive control: Superpowers injection present by default"
else
	fail "positive control FAILED — the ruler is broken on this machine; stop here"
	echo "[QA] $PASSED passed, $FAILED failed"; exit 1
fi

echo "[QA] Step 1b — default session must NOT see the matt catalog (global-enable leak detector)"
r1b="$(ask "$Q_MATT")"
echo "      → $r1b"
if [[ "$r1b" == *NO* && "$r1b" != *YES* ]]; then
	pass "default session: matt catalog absent (machine-level OFF holding)"
else
	fail "default session SEES the matt catalog — matt-skills is globally enabled; re-run scripts/setup-matt-skills.sh to re-pin false"
fi

echo "[QA] Step 2 — bare arm (per-launch disable must say NO)"
r2="$(ask "$Q_SUPERPOWERS" "$BARE_SETTINGS")"
echo "      → $r2"
if [[ "$r2" == *NO* && "$r2" != *YES* ]]; then
	pass "bare arm: Superpowers injection suppressed"
else
	fail "bare arm: injection still present (per-launch --settings not effective?)"
fi

echo "[QA] Step 3 — matt arm (no Superpowers + matt catalog visible)"
r3a="$(ask "$Q_SUPERPOWERS" "$MATT_SETTINGS")"
echo "      → superpowers: $r3a"
if [[ "$r3a" == *NO* && "$r3a" != *YES* ]]; then
	pass "matt arm: Superpowers injection suppressed"
else
	fail "matt arm: Superpowers injection still present"
fi
r3b="$(ask "$Q_MATT" "$MATT_SETTINGS")"
echo "      → matt catalog: $r3b"
if [[ "$r3b" == *YES* ]]; then
	pass "matt arm: matt-skills catalog visible (grilling/tdd)"
else
	fail "matt arm: matt catalog NOT visible — run scripts/setup-matt-skills.sh first (claude plugin details matt-skills@matt-skills must succeed)"
fi

echo ""
echo "[QA] Step 4 — the --settings JSON each arm's REAL spawn carries (for"
echo "      eyeballing a true tmux spawn in the isolated 529 room; Blueprint"
echo "      merges these into TmuxAdapter's single --settings flag):"
echo "      superpowers arm: (no --settings contribution — flag absent)"
echo "      bare arm:        $BARE_SETTINGS"
echo "      matt arm:        $MATT_SETTINGS"
echo ""
echo "[QA] $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]] || exit 1
