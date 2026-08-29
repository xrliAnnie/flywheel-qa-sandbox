#!/usr/bin/env bash
# FLY-350 M-2: full-access MERGE RED-LINE acceptance gate.
#
# A full-access Codex Lead has full LOCAL gh/git (the (Z) structural no-merge is
# gone), so the merge red line is now ENFORCED by the team-wide model: main branch
# protection + the founder-only-authority contract. This script CERTIFIES that line
# against the EXACT gh actor the full-access Lead's env authenticates as (env token
# vs on-disk ~/.config/gh keyring — verify what gh ACTUALLY resolves, not what we
# assume). Run it from the SAME env the full-access launcher uses, BEFORE cutover.
#
#   verify-merge-actor-denied.sh [owner/repo ...]
#     repos default to $FLY350_MERGE_GATE_REPOS (space-separated) or the Mufasa set.
#
# Exit 0 = every target repo's protected branch is unmergeable by this actor (PASS).
# Exit 1 = at least one repo is mergeable / unprotected / actor is admin → do NOT
#          cut over to full-access (fail-closed: an unresolved actor is also FAIL).
set -euo pipefail

GH="${GH_BIN:-gh}"
PROTECTED_BRANCH="${FLY350_PROTECTED_BRANCH:-main}"

# Target repos: CLI args > $FLY350_MERGE_GATE_REPOS > the default Mufasa set.
declare -a REPOS=()
if [ "$#" -gt 0 ]; then
	REPOS=("$@")
else
	# shellcheck disable=SC2206  # deliberate word-split of a space-separated list
	REPOS=(${FLY350_MERGE_GATE_REPOS:-xrliAnnie/growth xrliAnnie/flywheel})
fi

# jq is required to parse the branch-protection JSON locally (one API fetch, many
# fields). Fail-closed if absent — never certify the red line without it.
if ! command -v jq >/dev/null 2>&1; then
	echo "FAIL: jq is required to parse branch protection — refusing to certify blind (fail-closed)" >&2
	exit 1
fi

# 1. Resolve the actor gh authenticates as under THIS env. Fail-closed if unknown —
#    never certify the red line blind.
ACTOR="$("$GH" api user -q .login 2>/dev/null || true)"
if [ -z "$ACTOR" ]; then
	echo "FAIL: could not resolve the gh actor (gh api user) — refusing to certify the merge red line blind" >&2
	exit 1
fi
echo "actor: ${ACTOR} (resolved from the full-access env's gh auth)"

rc=0
for repo in "${REPOS[@]}"; do
	[ -z "$repo" ] && continue
	# (a) resolve the actor's permission, fail-closed on empty / unknown / any
	# UNRECOGNIZED value (Codex review MED: whitelist the permission set so an
	# unexpected gh output can never slip through as non-admin). The `|| true` keeps
	# a gh failure from tripping `set -e` so the explicit check below fail-closes.
	perm="$("$GH" api "repos/${repo}/collaborators/${ACTOR}/permission" -q .permission 2>/dev/null || true)"
	case "$perm" in
	admin | maintain | write | triage | read | none) ;;
	*)
		echo "FAIL[${repo}]: ${ACTOR}'s permission did not resolve to a recognized level (got '${perm:-<empty>}') — refusing to certify blind (fail-closed)" >&2
		rc=1
		continue
		;;
	esac
	# (b) admin bypasses branch protection outright → can merge.
	if [ "$perm" = "admin" ]; then
		echo "FAIL[${repo}]: actor ${ACTOR} has ADMIN — can bypass protection / merge to ${PROTECTED_BRANCH}" >&2
		rc=1
		continue
	fi
	# (c) Fetch the branch-protection JSON ONCE and PROVE merge-denial structurally.
	# (The operational enforcement is the runtime :cool: founder gate; this is the
	# pre-cutover structural certification that no non-admin actor can self-merge.)
	prot="$("$GH" api "repos/${repo}/branches/${PROTECTED_BRANCH}/protection" 2>/dev/null || true)"
	if [ -z "$prot" ]; then
		echo "FAIL[${repo}]: ${PROTECTED_BRANCH} has NO branch protection (or it is unreadable) — a '${perm}' actor could push/merge directly" >&2
		rc=1
		continue
	fi
	# (c1) protection must REQUIRE >= 1 approving review (the founder gate). A 0 /
	# absent / unreadable count collapses to 0 → FAIL.
	reviews="$(printf '%s' "$prot" | jq -r '.required_pull_request_reviews.required_approving_review_count // 0' 2>/dev/null || echo 0)"
	case "$reviews" in
	'' | *[!0-9]*) reviews=0 ;;
	esac
	if [ "$reviews" -lt 1 ]; then
		echo "FAIL[${repo}]: ${PROTECTED_BRANCH} protection does NOT require an approving review (count=${reviews}) — a '${perm}' actor could merge after CI without founder approval" >&2
		rc=1
		continue
	fi
	# (c2) Codex review HIGH: required reviews alone is NOT proof — a non-admin actor
	# on the PR-BYPASS allowances list can merge WITHOUT an approving review. Fail if
	# the actor is directly listed, OR if ANY team/app bypass exists (we cannot cheaply
	# prove the actor is not transitively covered → fail-closed; the operator verifies).
	actor_bypass=0
	for u in $(printf '%s' "$prot" | jq -r '[.required_pull_request_reviews.bypass_pull_request_allowances.users[]?.login] | join(" ")' 2>/dev/null || true); do
		[ "$u" = "$ACTOR" ] && actor_bypass=1
	done
	if [ "$actor_bypass" = "1" ]; then
		echo "FAIL[${repo}]: actor ${ACTOR} is on the PR-bypass allowances list — can merge WITHOUT an approving review" >&2
		rc=1
		continue
	fi
	bypass_other="$(printf '%s' "$prot" | jq -r '((.required_pull_request_reviews.bypass_pull_request_allowances.teams | length) + (.required_pull_request_reviews.bypass_pull_request_allowances.apps | length))' 2>/dev/null || echo 0)"
	case "$bypass_other" in
	'' | *[!0-9]*) bypass_other=0 ;;
	esac
	if [ "$bypass_other" -ge 1 ]; then
		echo "FAIL[${repo}]: ${PROTECTED_BRANCH} has team/app PR-bypass allowances configured — cannot prove ${ACTOR} is not covered (fail-closed; operator must verify)" >&2
		rc=1
		continue
	fi
	echo "PASS[${repo}]: ${PROTECTED_BRANCH} requires ${reviews} approving review(s); actor ${ACTOR} perm='${perm}' (non-admin, not bypass-listed) → cannot self-merge (founder review gates it)"
done

if [ "$rc" -ne 0 ]; then
	echo "MERGE RED LINE: FAIL — do NOT cut over Mufasa to full-access until resolved" >&2
	exit 1
fi
echo "MERGE RED LINE: PASS — the full-access actor cannot merge any target repo's ${PROTECTED_BRANCH}"
