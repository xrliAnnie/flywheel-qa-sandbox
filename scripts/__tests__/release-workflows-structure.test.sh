#!/bin/bash
# FLY-1062 PR4 · release workflow STRUCTURE assertions (automation form, plan
# §3). These are the machine-checkable halves of the founder-gate contract.
# The two CUSTOMER-FACING publishes (promote-commit, shell npm publish) are
# Bridge/broker actions gated by the Flywheel approve gate — NEVER CI. GitHub
# CI holds ONLY the beta-publish capability (internal-beta blast radius). A
# later edit that quietly puts the customer-release / npm credential into a
# workflow, or re-adds a shell-publish workflow, or a promote commit job,
# fails HERE.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WF="$ROOT/.github/workflows"
BETA="$WF/payload-beta-release.yml"
PROMOTE="$WF/payload-promote.yml"

for f in "$BETA" "$PROMOTE"; do
  [ -f "$f" ] || { echo "ERROR: missing $f"; exit 1; }
done

# ── S1 · NO shell-publish.yml (npm publish is a broker action, not CI) ───────
if [ ! -f "$WF/shell-publish.yml" ]; then
  pass "S1 no shell-publish.yml — npm publish is a Bridge/broker action, never CI"
else
  fail "S1 shell-publish.yml exists — npm publish must not be a CI workflow (plan §3 B)"
fi

# ── S2 · single-flight concurrency group ─────────────────────────────────────
ok=1
for f in "$BETA" "$PROMOTE"; do
  grep -q "group: payload-release" "$f" || ok=0
done
[ "$ok" -eq 1 ] && pass "S2 concurrency group payload-release present in both CI workflows" \
                || fail "S2 concurrency group missing"

# ── S3 · beta = scheduled 6h + dispatch + pre-activation guard that ACTUALLY
#    gates (Codex code R1: string presence is a false negative — the real
#    contract is that every step AFTER the preflight step carries the
#    activated condition, else the guard is decorative). ────────────────────
ok=1
grep -qE '^\s*schedule:' "$BETA" || ok=0
grep -q '0 \*/6 \* \* \*' "$BETA" || ok=0
grep -qE '^\s+workflow_dispatch:' "$BETA" || ok=0
grep -qE '^\s+id: preflight' "$BETA" || ok=0
# structural: after the preflight step, EVERY step start must carry the
# activated condition (a mutation that strips the `if:` lines fails here).
PRE_LINE="$(grep -n 'id: preflight' "$BETA" | head -1 | cut -d: -f1)"
if [ -n "$PRE_LINE" ]; then
  POST="$(tail -n "+$((PRE_LINE + 1))" "$BETA")"
  STEP_STARTS="$(printf '%s\n' "$POST" | grep -cE '^      - (uses|name):')"
  GATED="$(printf '%s\n' "$POST" | grep -cF "if: steps.preflight.outputs.activated == 'true'")"
  [ "$STEP_STARTS" -ge 5 ] || ok=0                 # sanity: real steps exist
  [ "$GATED" -eq "$STEP_STARTS" ] || ok=0          # every post-preflight step gated
else
  ok=0
fi
[ "$ok" -eq 1 ] && pass "S3 beta workflow: schedule 6h + dispatch + EVERY post-preflight step gated by activated (guard actually no-ops before P5)" \
                || fail "S3 beta schedule/guard not structurally gating (steps=$STEP_STARTS gated=$GATED)"

# ── S4 · credential lint over ALL workflows ──────────────────────────────────
# vendor control-plane credentials NEVER enter any workflow (plan §3 底线一)
if ! grep -rInE "CLOUDFLARE|WRANGLER|CF_API" "$WF" >/dev/null 2>&1; then
  pass "S4a zero Cloudflare/vendor control-plane credential references in ANY workflow"
else
  fail "S4a vendor credential reference: $(grep -rlnE 'CLOUDFLARE|WRANGLER|CF_API' "$WF")"
fi
# the two customer-facing publish credentials appear in NO workflow at all
if ! grep -rn "FW_CUSTOMER_RELEASE_TOKEN" "$WF" >/dev/null 2>&1; then
  pass "S4b customer-release token referenced in ZERO workflows (it lives only in the broker)"
else
  fail "S4b customer-release token in a workflow: $(grep -rln 'FW_CUSTOMER_RELEASE_TOKEN' "$WF")"
fi
# zero npm publish credential AND zero OIDC id-token (shell publish is broker-side)
if ! grep -rInE "NODE_AUTH_TOKEN|NPM_TOKEN|id-token" "$WF" >/dev/null 2>&1; then
  pass "S4c zero npm token / OIDC id-token in ANY workflow (shell publish is broker-side)"
else
  fail "S4c npm/OIDC credential in a workflow: $(grep -rlnE 'NODE_AUTH_TOKEN|NPM_TOKEN|id-token' "$WF")"
fi
# the beta workflow holds only the beta-publish capability
if grep -q "FW_BETA_PUBLISH_TOKEN" "$BETA" && ! grep -qE "FW_CUSTOMER_RELEASE|FW_OPS_ADMIN" "$BETA"; then
  pass "S4d beta workflow holds only the beta-publish capability"
else
  fail "S4d beta workflow capability set wrong"
fi
# S4e (Codex code R1): banning KNOWN names is a false negative — a mutation
# can name a NEW secret (FW_RELEASE_TOKEN, NPM_AUTH, …) and publish with it.
# ALLOWLIST instead: every secrets.<X> reference in the RELEASE workflows must
# be FW_BETA_PUBLISH_TOKEN — any other secret name (regardless of what it is
# called) fails here.
bad_secret=""
for f in "$BETA" "$PROMOTE"; do
  while IFS= read -r name; do
    [ "$name" = "FW_BETA_PUBLISH_TOKEN" ] || bad_secret="$bad_secret $f:$name"
  done < <(grep -oE 'secrets\.[A-Za-z_][A-Za-z0-9_]*' "$f" | sed 's/^secrets\.//' | sort -u)
done
if [ -z "$bad_secret" ]; then
  pass "S4e release workflows reference ONLY secrets.FW_BETA_PUBLISH_TOKEN (allowlist — a differently-named publish secret fails)"
else
  fail "S4e non-allowlisted secret in a release workflow:$bad_secret"
fi
# S4f (Codex code R1/R2): a customer publish is `npm publish` — it must not
# run in ANY workflow (shell publish is a broker action). Raw-text grep is
# fragile: a quoted '#', backslash line-continuations, options between npm and
# publish, and an echoed mention all fool it (Codex R2). Normalize each file —
# drop FULL-comment lines (first non-ws char is '#', so an inline quoted '#'
# survives), join backslash continuations — then flag `npm [opts] publish`
# ONLY at a COMMAND position: line start, after a shell separator (; & |), or
# after a `run:` key. So echo "... npm publish ..." is not a false positive,
# and options / split lines cannot hide a real command. NOTE: the AUTHORITATIVE
# guarantee that CI cannot publish to npm is the credential ban (S4c no
# npm/OIDC token, S4e secret allowlist) — an npm publish with no token is
# inert. S4f is defense in depth on top of that.
npmpub=""
for f in "$WF"/*.yml "$WF"/*.yaml; do
  [ -f "$f" ] || continue   # GitHub Actions accepts BOTH extensions (Codex R3)
  hit="$(
    grep -vE '^[[:space:]]*#' "$f" \
      | awk '{ line=$0; while (sub(/\\[[:space:]]*$/, "", line)) { if ((getline nl) <= 0) break; line=line nl } print line }' \
      | grep -nE "(^[[:space:]]*|[;&|][[:space:]]*|run:[[:space:]]+)npm([[:space:]]+-[^[:space:]]+)*[[:space:]]+publish" \
    || true
  )"
  [ -n "$hit" ] && npmpub="$npmpub $f"
done
if [ -z "$npmpub" ]; then
  pass "S4f zero 'npm publish' COMMAND in any workflow (normalized: comments/continuations/options/quoted mentions handled)"
else
  fail "S4f real 'npm publish' command in a workflow:$npmpub"
fi

# ── S5 · promote workflow = PREPARE ONLY, no commit job ─────────────────────
# the commit (customer pointer flip) is a broker action — it must not exist as
# a job here, and this workflow must carry zero build-after-gate / customer token.
if grep -qE "^\s+prepare:" "$PROMOTE" && ! grep -qE "^\s+commit:" "$PROMOTE"; then
  pass "S5a promote workflow has ONLY a prepare job (no commit job — commit is a broker action)"
else
  fail "S5a promote workflow commit-job shape wrong"
fi
if ! grep -q "environment:" "$PROMOTE"; then
  pass "S5b promote workflow references no GitHub environment (gate is the broker approve gate)"
else
  fail "S5b promote workflow still references a GitHub environment"
fi

# ── S6 · promote sourceCommit is DERIVED, never an operator input ───────────
ok=1
grep -q "source-commit:" "$PROMOTE" && ok=0                      # the input must not exist
grep -q "id: derive" "$PROMOTE" || ok=0                          # manifest-derivation step
grep -q "GITHUB_OUTPUT" "$PROMOTE" || ok=0
grep -q "Check out the DERIVED commit" "$PROMOTE" || ok=0        # checkout AFTER derivation
DERIVE_LINE="$(grep -n 'id: derive' "$PROMOTE" | head -1 | cut -d: -f1)"
CHECKOUT_LINE="$(grep -n 'Check out the DERIVED commit' "$PROMOTE" | head -1 | cut -d: -f1)"
{ [ -n "$DERIVE_LINE" ] && [ -n "$CHECKOUT_LINE" ] && [ "$DERIVE_LINE" -lt "$CHECKOUT_LINE" ]; } || ok=0
[ "$ok" -eq 1 ] && pass "S6 promote derives sourceCommit from the manifest before any foreign checkout (no operator commit input)" \
                || fail "S6 promote sourceCommit derivation contract broken"

# ── S7 · main-only dispatch guard on every workflow ─────────────────────────
ok=1
for f in "$BETA" "$PROMOTE"; do
  grep -q "Dispatch-ref guard (main only)" "$f" || ok=0
  grep -q 'refs/heads/main' "$f" || ok=0
done
[ "$ok" -eq 1 ] && pass "S7 main-only dispatch guard present in both CI workflows" \
                || fail "S7 dispatch-ref guard missing"

# ── S8 · dispatch inputs never interpolate into run shell text ──────────────
ok=1
while IFS= read -r line; do
  case "$line" in
    *'${{ inputs.'*)
      echo "$line" | grep -qE "_INPUT: |if: |ref: " || ok=0
      ;;
  esac
done < <(cat "$BETA" "$PROMOTE")
[ "$ok" -eq 1 ] && pass "S8 dispatch inputs ride env/if/ref only — never raw in run: text" \
                || fail "S8 raw input interpolation found in a run block"

# ── S9 · pre-existing workflows untouched: ci.yml + ship keep their names ────
ok=1
grep -q "^name: CI$" "$WF/ci.yml" || ok=0
[ -f "$WF/ship-on-comment.yml" ] || ok=0
[ "$ok" -eq 1 ] && pass "S9 pre-existing workflows still present under their original names" \
                || fail "S9 pre-existing workflow surface changed"

echo ""
echo "release-workflows-structure: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
