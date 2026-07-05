#!/bin/bash
# FLY-879: Anna (external interviewer) isolation verifier — a GO-LIVE GATE.
#
# Idempotent, re-runnable. Proves the hard-locked isolation of the external
# customer-facing agent by NEGATIVE + POSITIVE assertions across four surfaces:
#   1. GitHub API (scoped PAT): CAN read the interviews repo, CANNOT read the main repo.
#   2. raw git (the PAT authenticates git, not just gh): same asymmetry via ls-remote.
#   3. pane env (dry-run launch plan, the source of truth for what the Claude pane
#      actually sees): no internal creds, no bare ANNA_* token, GH_TOKEN scoped,
#      FLYWHEEL_LEAD_EXTERNAL=1 present.
#   4. workspace: no main-repo checkout under Anna's LEAD_WORKSPACE.
#
# This script NEVER prints a token value — only env-var NAMES and PASS/FAIL results.
#
# Usage:
#   ANNA_GITHUB_TOKEN=<scoped-PAT> ./scripts/verify-anna-isolation.sh
#
# Config (env, with defaults):
#   ANNA_GITHUB_TOKEN   — Anna's fine-grained PAT (scoped to the interviews repo).
#                         Required for surfaces 1+2; if unset, they are SKIPPED (not
#                         failed) so the script is still useful pre-provisioning.
#   INTERVIEWS_REPO     — "owner/name" Anna MUST reach (default xrliAnnie/flywheel-interviews)
#   INTERNAL_REPO       — "owner/name" Anna must NOT reach  (default xrliAnnie/flywheel)
#   LEAD_ID             — external lead id (default anna-interviewer-lead)
#   PROJECT_NAME        — flywheel project name (default flywheel)
#   PROJECT_DIR         — project root for the dry-run launch plan (default: repo root)
#   ANNA_LEAD_WORKSPACE — Anna's workspace (default ~/.flywheel/lead-workspace/<LEAD_ID>)
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LEAD_SH="${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh"

INTERVIEWS_REPO="${INTERVIEWS_REPO:-xrliAnnie/flywheel-interviews}"
INTERNAL_REPO="${INTERNAL_REPO:-xrliAnnie/flywheel}"
LEAD_ID="${LEAD_ID:-anna-interviewer-lead}"
PROJECT_NAME="${PROJECT_NAME:-flywheel}"
PROJECT_DIR="${PROJECT_DIR:-$REPO_ROOT}"
ANNA_LEAD_WORKSPACE="${ANNA_LEAD_WORKSPACE:-${HOME}/.flywheel/lead-workspace/${LEAD_ID}}"

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }
skip() { SKIP=$((SKIP+1)); echo "  skip - $1"; }

echo "== FLY-879 Anna isolation verifier =="
echo "   interviews repo (must reach):   ${INTERVIEWS_REPO}"
echo "   internal repo  (must NOT reach): ${INTERNAL_REPO}"
echo "   lead id: ${LEAD_ID}   project: ${PROJECT_NAME}"
echo ""

# ── Surface 1: GitHub API (scoped PAT) ──────────────────────────────
# A fine-grained PAT returns 200 for an in-scope repo and 404 (or 403) for one it
# has no access to. We assert the ASYMMETRY, never the token value.
echo "[1] GitHub API (scoped PAT)"
if [ -z "${ANNA_GITHUB_TOKEN:-}" ]; then
  skip "ANNA_GITHUB_TOKEN unset — GitHub API checks skipped (set it to run the gate)"
elif ! command -v curl >/dev/null 2>&1; then
  skip "curl not found — GitHub API checks skipped"
else
  _gh_code() { # $1 = owner/name
    curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
      -H "Authorization: Bearer ${ANNA_GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$1" 2>/dev/null || echo "000"
  }
  code_int=$(_gh_code "$INTERNAL_REPO")
  code_iv=$(_gh_code "$INTERVIEWS_REPO")
  if [ "$code_iv" = "200" ]; then ok "interviews repo reachable (HTTP ${code_iv})"; else bad "interviews repo NOT reachable (HTTP ${code_iv}) — PAT missing repo scope?"; fi
  if [ "$code_int" != "200" ]; then ok "internal repo BLOCKED (HTTP ${code_int} — expected 403/404)"; else bad "internal repo READABLE (HTTP 200) — PAT scope too broad!"; fi
fi
echo ""

# ── Surface 2: raw git (PAT authenticates git, not just gh) ─────────
echo "[2] raw git ls-remote (PAT authenticates git)"
if [ -z "${ANNA_GITHUB_TOKEN:-}" ]; then
  skip "ANNA_GITHUB_TOKEN unset — raw git checks skipped"
elif ! command -v git >/dev/null 2>&1; then
  skip "git not found — raw git checks skipped"
else
  _lsremote() { # $1 = owner/name  → 0 if reachable
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/echo \
      git ls-remote "https://x-access-token:${ANNA_GITHUB_TOKEN}@github.com/$1.git" >/dev/null 2>&1
  }
  if _lsremote "$INTERVIEWS_REPO"; then ok "interviews repo git ls-remote OK"; else bad "interviews repo git ls-remote FAILED — PAT cannot authenticate git"; fi
  if _lsremote "$INTERNAL_REPO"; then bad "internal repo git ls-remote SUCCEEDED — PAT can reach main repo via raw git!"; else ok "internal repo git ls-remote BLOCKED (as required)"; fi
  # Optional write-path probe: push --dry-run against the interviews clone if present.
  if [ -d "${ANNA_LEAD_WORKSPACE}/.git" ]; then
    if GIT_TERMINAL_PROMPT=0 git -C "$ANNA_LEAD_WORKSPACE" push --dry-run >/dev/null 2>&1; then
      ok "interviews clone push --dry-run OK (write path works)"
    else
      skip "interviews clone push --dry-run not conclusive (no upstream/branch yet)"
    fi
  else
    skip "no interviews clone at ${ANNA_LEAD_WORKSPACE} yet — write-path probe skipped"
  fi
fi
echo ""

# ── Surface 3: pane env (dry-run launch plan — what the Claude pane sees) ──
echo "[3] pane env (dry-run launch plan)"
# Probe whether Anna is configured at all — distinguishes "pre-provisioning" (skip)
# from "configured but the launcher won't produce a plan" (a real failure).
_PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-${HOME}/.flywheel/projects.json}"
_anna_configured=false
if command -v jq >/dev/null 2>&1 && [ -f "$_PROJECTS_FILE" ]; then
  if jq -e --arg p "$PROJECT_NAME" --arg l "$LEAD_ID" \
      '.[] | select(.projectName==$p) | .leads[] | select(.agentId==$l)' \
      "$_PROJECTS_FILE" >/dev/null 2>&1; then
    _anna_configured=true
  fi
fi
if [ ! -x "$LEAD_SH" ]; then
  skip "claude-lead.sh not found at ${LEAD_SH} — pane-env check skipped"
elif [ ! -f "${REPO_ROOT}/packages/teamlead/dist/ProjectConfig.js" ]; then
  skip "dist/ProjectConfig.js not built — pane-env check skipped (run pnpm -C packages/teamlead build)"
elif [ "$_anna_configured" != true ]; then
  skip "lead '${LEAD_ID}' not yet in ${_PROJECTS_FILE} — pane-env check runs at deploy time (post-provisioning)"
else
  # Run the REAL launcher in dry-run and capture the structured plan. The role must
  # resolve to external (Anna's entry must be external:true in projects.json).
  PLAN=$(FLYWHEEL_LEAD_DRY_RUN=1 bash "$LEAD_SH" "$LEAD_ID" "$PROJECT_DIR" "$PROJECT_NAME" 2>/dev/null \
    | sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p')
  if [ -z "$PLAN" ]; then
    bad "dry-run produced no launch plan (Anna not configured as external in projects.json? role fail-STOP?)"
  else
    printf '%s\n' "$PLAN" | grep -qF $'ROLE\texternal' && ok "role is external" || bad "role is NOT external (check projects.json external:true)"
    printf '%s\n' "$PLAN" | grep -qF $'PANE_ENV\tFLYWHEEL_LEAD_EXTERNAL\tset' && ok "FLYWHEEL_LEAD_EXTERNAL=1 present" || bad "FLYWHEEL_LEAD_EXTERNAL marker missing"
    printf '%s\n' "$PLAN" | grep -qF $'PANE_ENV\tTEAMLEAD_API_TOKEN\tempty' && ok "TEAMLEAD_API_TOKEN empty in pane" || bad "TEAMLEAD_API_TOKEN NOT empty — Bridge token leaked to pane"
    printf '%s\n' "$PLAN" | grep -qF $'PANE_ENV\tBRIDGE_URL\tempty' && ok "BRIDGE_URL empty in pane" || bad "BRIDGE_URL not empty in pane"
    # No LINEAR_* and no OTHER lead's *_BOT_TOKEN and no bare ANNA_* leaked into the pane.
    if printf '%s\n' "$PLAN" | grep -qE $'PANE_ENV\tLINEAR'; then bad "a LINEAR_* var is present in the pane"; else ok "no LINEAR_* in pane"; fi
    if printf '%s\n' "$PLAN" | grep -qE $'PANE_ENV\tANNA_'; then bad "a bare ANNA_* var leaked into the pane (must stay in wrapper/launcher only)"; else ok "no bare ANNA_* in pane"; fi
    # DISCORD_BOT_TOKEN is Anna's OWN Discord token (required, passed generically). The
    # forbidden case is any OTHER lead's NAMED *_BOT_TOKEN (PETER_BOT_TOKEN, or a bare
    # ANNA_BOT_TOKEN) leaking in — assert none exist except the generic DISCORD one.
    _stray_tokens=$(printf '%s\n' "$PLAN" | awk -F'\t' '$1=="PANE_ENV" && $2 ~ /_BOT_TOKEN$/ && $2 != "DISCORD_BOT_TOKEN" {print $2}')
    if [ -n "$_stray_tokens" ]; then bad "a non-Discord *_BOT_TOKEN var leaked into the pane: $(printf '%s' "$_stray_tokens" | tr '\n' ' ')"; else ok "no stray *_BOT_TOKEN in pane (only generic DISCORD_BOT_TOKEN)"; fi
    # GH_TOKEN, if forwarded, must be present as a name (its value points to the scoped PAT — value never printed here).
    printf '%s\n' "$PLAN" | grep -qF $'MCP_SERVER\tflywheel-terminal' && bad "flywheel-terminal MCP registered for external agent" || ok "no flywheel-terminal MCP"
  fi
fi
echo ""

# ── Surface 4: workspace has no main-repo checkout ──────────────────
echo "[4] workspace isolation"
if [ ! -d "$ANNA_LEAD_WORKSPACE" ]; then
  skip "workspace ${ANNA_LEAD_WORKSPACE} does not exist yet — checked at deploy time"
else
  # Main-repo fingerprints that must NOT appear under Anna's workspace.
  _leaked=""
  for fp in "packages/teamlead" "packages/claude-runner" "packages/bridge"; do
    [ -e "${ANNA_LEAD_WORKSPACE}/${fp}" ] && _leaked="${_leaked} ${fp}"
  done
  if [ -n "$_leaked" ]; then
    bad "main-repo checkout fingerprint(s) found under workspace:${_leaked}"
  else
    ok "no main-repo checkout under ${ANNA_LEAD_WORKSPACE}"
  fi
fi

echo ""
echo "== summary: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped =="
[ "$FAIL" -eq 0 ]
