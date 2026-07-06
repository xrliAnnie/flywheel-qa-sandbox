#!/usr/bin/env bash
# FLY-886 / FLY-876 handoff — precise project-ref sweep of the merged-tree cron
# tick + growth scripts + growth config (sub -> tidal-echo), operating on the
# ~/Dev/tidal-echo checkout so FLY-876 can review + commit the result as a
# tidal-echo PR.
#
# OWNERSHIP: FLY-876 owns the cron content changes + final grep-zero verification
# (plan §5, §9). This is prepped in the FLY-886 activation bundle so the sweep is
# turnkey; it is INTENTIONALLY not baked into the FLY-886 tidal-echo PR (keeps that
# PR scoped to runner/lead config + avoids conflicting with FLY-876's own PR).
#
# COVERAGE (Codex R1 HIGH-2): NOT just the 3 shell tick scripts — the active
# growth call sites also carry sub project/channel refs and would break the fold:
# growth_dr.py (invoked by growth-improve-tick.sh -> `--project sub` /
# `"projectName":"sub"` = project_unknown after fold), growth_policy.py
# (REPO_DEFAULT_CHANNEL fallback), and growth/config.json (report channel+project
# -> posts to a non-general channel). All are swept here + gated by grep-zero.
#
# PREP-ONLY: dry-run (unified diff) by default. Pass --activate to edit in place
# (with .bak-fly886 backups). Run inside the ~/Dev/tidal-echo checkout AFTER the
# FLY-886 tidal-echo PR is merged + pulled, in the founder window.
#
# PRECISION (plan §5.3): change ONLY project references. NEVER touch `sub-lead`
# (leadId, preserved), `sub-create` / `/sub-create` / `sub_create` (skill names).
# Anchored patterns + a before/after protected-token count assertion enforce this.
# Excluded on purpose: test_*.py (assertions/comments), ACTIVATION.md + other docs.
set -euo pipefail

REPO="${TIDAL_ECHO_REPO:-$HOME/Dev/tidal-echo}"
SCRIPTS="$REPO/sub/content/scripts"
GROWTH="$REPO/sub/growth"
ACTIVATE="${1:-}"
OLD_CH="1511267947551653918"
NEW_CH="1517041708855197908"

[ -d "$SCRIPTS" ] || { echo "refusing: $SCRIPTS not found — merge tidal-echo PR + git pull first" >&2; exit 1; }

# Active call-site files (per FLY-886 audit + Codex R1 HIGH-2). The 3 zero-ref
# shell scripts + growth-tick-common.sh are included so grep-zero covers them too.
CANDIDATES=(
  "$SCRIPTS/sub-create-nightly-tick.sh"
  "$SCRIPTS/sub-daily-loop-tick.sh"
  "$SCRIPTS/growth-improve-tick.sh"
  "$SCRIPTS/growth-learn-tick.sh"
  "$SCRIPTS/growth-report-tick.sh"
  "$SCRIPTS/growth-retro-tick.sh"
  "$SCRIPTS/growth-tick-common.sh"
  "$SCRIPTS/growth_dr.py"
  "$SCRIPTS/growth_policy.py"
  "$SCRIPTS/dryrun_growth_wired.py"
  "$GROWTH/config.json"
)
PRESENT=()
for f in "${CANDIDATES[@]}"; do [ -f "$f" ] && PRESENT+=("$f"); done
[ ${#PRESENT[@]} -gt 0 ] || { echo "refusing: none of the expected cron/growth files present under $REPO" >&2; exit 1; }

# Precise perl substitutions (shared by dry-run + activate). Anchored so they only
# hit project/channel references, never sub-lead / sub-create / sub_create.
PERL_SUBS=(
  -e 's/\bPROJECT="sub"/PROJECT="tidal-echo"/g;'                                   # shell PROJECT
  -e "s/REPORT_CHANNEL=\"$OLD_CH\"/REPORT_CHANNEL=\"$NEW_CH\"/g;"                   # shell report channel
  -e "s/REPO_DEFAULT_CHANNEL = \"$OLD_CH\"/REPO_DEFAULT_CHANNEL = \"$NEW_CH\"/g;"   # growth_policy.py fallback
  -e 's/--project sub(?![-\w])/--project tidal-echo/g;'                            # shell `--project sub`
  -e 's/"--project",(\s*)"sub"/"--project",${1}"tidal-echo"/g;'                    # python list `"--project", "sub"`
  -e 's/"projectName":(\s*)"sub"/"projectName":${1}"tidal-echo"/g;'                # json/py projectName
  -e 's/"project":(\s*)"sub"/"project":${1}"tidal-echo"/g;'                        # json/py project
  -e "s/\"channel_id\":(\\s*)\"$OLD_CH\"/\"channel_id\":\${1}\"$NEW_CH\"/g;"        # json/py report channel_id
)

# Safety: these token counts MUST be identical before and after (must NOT sweep).
protected_counts() { grep -hoE 'sub-lead|/sub-create|sub-create|sub_create' "${PRESENT[@]}" 2>/dev/null | sort | uniq -c; }

echo "== FLY-886/876 cron+growth content sweep (${ACTIVATE:-dry-run}) =="
echo "-- files present (${#PRESENT[@]}) --"; printf '   %s\n' "${PRESENT[@]}"
echo "-- protected tokens BEFORE (must be unchanged after) --"
BEFORE=$(protected_counts); echo "$BEFORE"

if [ "$ACTIVATE" != "--activate" ]; then
  echo "-- DRY-RUN unified diff (no write) --"
  for f in "${PRESENT[@]}"; do
    perl -p "${PERL_SUBS[@]}" "$f" | diff -u "$f" - && echo "   (no change) $(basename "$f")" || true
  done
  echo "== pass --activate inside the checkout (after merge+pull) to edit in place =="
  exit 0
fi

for f in "${PRESENT[@]}"; do
  perl -i.bak-fly886 -p "${PERL_SUBS[@]}" "$f"
  echo "swept $(basename "$f") (backup .bak-fly886)"
done

echo "-- protected tokens AFTER --"
AFTER=$(protected_counts); echo "$AFTER"
[ "$BEFORE" = "$AFTER" ] || { echo "ABORT: protected token counts changed — restore from .bak-fly886 and investigate" >&2; exit 1; }

echo "-- grep-zero (plan §5.4): project/channel refs must be gone across the full active set --"
if grep -REn 'PROJECT="sub"|--project sub([^-_[:alnum:]]|$)|"--project", *"sub"|"projectName": *"sub"|"project": *"sub"|REPORT_CHANNEL="'"$OLD_CH"'"|REPO_DEFAULT_CHANNEL = "'"$OLD_CH"'"|"channel_id": *"'"$OLD_CH"'"' "${PRESENT[@]}"; then
  echo "FAIL: residual project/channel refs above" >&2; exit 1
fi
echo "OK: protected tokens unchanged + project/channel refs grep-zero. FLY-876 to review + commit as a tidal-echo PR."
