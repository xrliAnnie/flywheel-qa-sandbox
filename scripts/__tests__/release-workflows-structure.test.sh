#!/bin/bash
# FLY-1062 PR4 · release workflow STRUCTURE assertions — REWRITTEN by FLY-1323
# for the tokenized-CI posture (Annie's direction, 2026-07-18; design doc:
# engineering/doc/FLY-1323-npm-distribution-activation/ci-activation-design.md).
#
# OLD contract (FLY-1062): vendor credentials appear in NO workflow, npm
# publish exists in NO workflow — customer-facing publishes were broker
# actions. NEW contract ("merge gate = publish gate"): vendor credentials and
# `npm publish` are allowed ONLY inside workflows that declare
# `environment: release` (whose deployment branch policy is main-only) AND
# carry a main-only ref guard. This is a SCOPED allowlist, not a free-for-all:
# a vendor credential or a publish command in any workflow OUTSIDE that shape
# still fails HERE. The beta/promote workflows keep their original, stricter
# contract unchanged (beta-publish capability only, prepare-only promote).
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WF="$ROOT/.github/workflows"
BETA="$WF/payload-beta-release.yml"
PROMOTE="$WF/payload-promote.yml"
ACTIVATION="$WF/payload-activation.yml"

for f in "$BETA" "$PROMOTE" "$ACTIVATION"; do
  [ -f "$f" ] || { echo "ERROR: missing $f"; exit 1; }
done

# every workflow file (both extensions — GitHub Actions accepts .yml and .yaml)
all_workflows() {
  for f in "$WF"/*.yml "$WF"/*.yaml; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
}

# a file qualifies as a RELEASE-ENVIRONMENT workflow iff it declares the
# environment AND carries the main-only ref guard — both, not either.
is_release_env_workflow() {
  grep -qE '^\s+environment: release$' "$1" && grep -q 'refs/heads/main' "$1"
}

# ── S1 · no shell-publish.yml (the publish path is payload-activation.yml,
#    which is environment-gated; a differently-named ungated publish workflow
#    must not reappear) ───────────────────────────────────────────────────────
if [ ! -f "$WF/shell-publish.yml" ]; then
  pass "S1 no shell-publish.yml — the only npm publish path is the environment-gated activation workflow"
else
  fail "S1 shell-publish.yml exists — npm publish may only live in the environment-gated activation workflow"
fi

# ── S2 · single-flight concurrency group ─────────────────────────────────────
ok=1
for f in "$BETA" "$PROMOTE" "$ACTIVATION"; do
  grep -q "group: payload-release" "$f" || ok=0
done
[ "$ok" -eq 1 ] && pass "S2 concurrency group payload-release present in all three release workflows" \
                || fail "S2 concurrency group missing"

# ── S3 · beta = scheduled 6h + dispatch + pre-activation guard that ACTUALLY
#    gates (Codex code R1: string presence is a false negative — the real
#    contract is that every step AFTER the preflight step carries the
#    activated condition, else the guard is decorative). ────────────────────
ok=1
STEP_STARTS=0; GATED=0
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

# ── S4 · credential scoping over ALL workflows (the FLY-1323 rewrite) ────────
# S4a: vendor control-plane (Cloudflare) references may appear ONLY in
# release-environment workflows; today that set is exactly {activation}.
# Every other workflow keeps the original ZERO-reference contract.
bad_cf=""
while IFS= read -r f; do
  if grep -qE "CLOUDFLARE|WRANGLER|CF_API" "$f"; then
    case "$f" in
      "$ACTIVATION") is_release_env_workflow "$f" || bad_cf="$bad_cf $f(not-env-gated)" ;;
      *) bad_cf="$bad_cf $f" ;;
    esac
  fi
done < <(all_workflows)
if [ -z "$bad_cf" ]; then
  pass "S4a Cloudflare/vendor credential references only in the environment-gated activation workflow"
else
  fail "S4a vendor credential reference outside the release-environment contract:$bad_cf"
fi

# S4b: the customer-release capability appears in NO workflow at all — the
# customer pointer flip is still not a CI action in this PR (a future
# promote-commit workflow must revisit THIS assertion explicitly).
if ! grep -rn "FW_CUSTOMER_RELEASE_TOKEN" "$WF" >/dev/null 2>&1; then
  pass "S4b customer-release token referenced in ZERO workflows"
else
  fail "S4b customer-release token in a workflow: $(grep -rln 'FW_CUSTOMER_RELEASE_TOKEN' "$WF")"
fi

# S4c: npm credential / OIDC id-token references may appear ONLY in
# release-environment workflows (today: exactly {activation}).
bad_npm=""
while IFS= read -r f; do
  if grep -qE "NODE_AUTH_TOKEN|NPM_TOKEN|NPM_PUBLISH_TOKEN|id-token" "$f"; then
    case "$f" in
      "$ACTIVATION") is_release_env_workflow "$f" || bad_npm="$bad_npm $f(not-env-gated)" ;;
      *) bad_npm="$bad_npm $f" ;;
    esac
  fi
done < <(all_workflows)
if [ -z "$bad_npm" ]; then
  pass "S4c npm credential / OIDC id-token only in the environment-gated activation workflow"
else
  fail "S4c npm/OIDC credential outside the release-environment contract:$bad_npm"
fi

# S4d: the beta workflow holds only the beta-publish capability (unchanged)
if grep -q "FW_BETA_PUBLISH_TOKEN" "$BETA" && ! grep -qE "FW_CUSTOMER_RELEASE|FW_OPS_ADMIN" "$BETA"; then
  pass "S4d beta workflow holds only the beta-publish capability"
else
  fail "S4d beta workflow capability set wrong"
fi

# S4e (Codex code R1): banning KNOWN names is a false negative — ALLOWLIST
# instead, per file. beta/promote: only FW_BETA_PUBLISH_TOKEN (unchanged).
# activation: exactly the two vendor secrets + the beta capability (its sha
# is derived in-run and stamped into the Worker).
bad_secret=""
for f in "$BETA" "$PROMOTE"; do
  while IFS= read -r name; do
    [ "$name" = "FW_BETA_PUBLISH_TOKEN" ] || bad_secret="$bad_secret $f:$name"
  done < <(grep -oE 'secrets\.[A-Za-z_][A-Za-z0-9_]*' "$f" | sed 's/^secrets\.//' | sort -u)
done
while IFS= read -r name; do
  case "$name" in
    CLOUDFLARE_API_TOKEN|NPM_PUBLISH_TOKEN|FW_BETA_PUBLISH_TOKEN) : ;;
    *) bad_secret="$bad_secret $ACTIVATION:$name" ;;
  esac
done < <(grep -oE 'secrets\.[A-Za-z_][A-Za-z0-9_]*' "$ACTIVATION" | sed 's/^secrets\.//' | sort -u)
if [ -z "$bad_secret" ]; then
  pass "S4e per-file secret allowlist holds (beta/promote: beta capability only; activation: two vendor secrets + beta capability)"
else
  fail "S4e non-allowlisted secret in a release workflow:$bad_secret"
fi

# S4f: a customer publish is `npm publish` — it may exist ONLY in the
# environment-gated activation workflow, and MUST exist there (the publish
# path is real, not decorative). Raw-text grep is fragile: a quoted '#',
# backslash line-continuations, options between npm and publish, and an
# echoed mention all fool it (Codex R2). Normalize each file — drop
# FULL-comment lines, join backslash continuations — then flag
# `npm [opts] publish` ONLY at a COMMAND position. NOTE: the AUTHORITATIVE
# guarantee stays the credential scoping (S4c/S4e + the release environment);
# S4f is defense in depth on top of that.
npmpub=""
for f in "$WF"/*.yml "$WF"/*.yaml; do
  [ -f "$f" ] || continue
  hit="$(
    grep -vE '^[[:space:]]*#' "$f" \
      | awk '{ line=$0; while (sub(/\\[[:space:]]*$/, "", line)) { if ((getline nl) <= 0) break; line=line nl } print line }' \
      | grep -nE "(^[[:space:]]*|[;&|][[:space:]]*|run:[[:space:]]+)npm([[:space:]]+-[^[:space:]]+)*[[:space:]]+publish" \
    || true
  )"
  [ -n "$hit" ] && npmpub="$npmpub $f"
done
if [ "$npmpub" = " $ACTIVATION" ]; then
  pass "S4f 'npm publish' COMMAND exists in exactly the environment-gated activation workflow and nowhere else"
else
  fail "S4f npm publish command set wrong (found:${npmpub:- none}; expected exactly: $ACTIVATION)"
fi

# ── S5 · promote workflow = PREPARE ONLY, no commit job (unchanged) ─────────
if grep -qE "^\s+prepare:" "$PROMOTE" && ! grep -qE "^\s+commit:" "$PROMOTE"; then
  pass "S5a promote workflow has ONLY a prepare job (no commit job)"
else
  fail "S5a promote workflow commit-job shape wrong"
fi
if ! grep -q "environment:" "$PROMOTE"; then
  pass "S5b promote workflow references no GitHub environment (prepare needs no vendor credential)"
else
  fail "S5b promote workflow references a GitHub environment"
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

# ── S7 · main-only guard on every release workflow ──────────────────────────
ok=1
for f in "$BETA" "$PROMOTE"; do
  grep -q "Dispatch-ref guard (main only)" "$f" || ok=0
  grep -q 'refs/heads/main' "$f" || ok=0
done
grep -q 'refs/heads/main' "$ACTIVATION" || ok=0
[ "$ok" -eq 1 ] && pass "S7 main-only guard present in all three release workflows" \
                || fail "S7 dispatch-ref guard missing"

# ── S8 · dispatch inputs never interpolate into run shell text ──────────────
ok=1
while IFS= read -r line; do
  case "$line" in
    *'${{ inputs.'*)
      echo "$line" | grep -qE "_INPUT: |if: |ref: " || ok=0
      ;;
  esac
done < <(cat "$BETA" "$PROMOTE" "$ACTIVATION")
[ "$ok" -eq 1 ] && pass "S8 dispatch inputs ride env/if/ref only — never raw in run: text (all three workflows)" \
                || fail "S8 raw input interpolation found in a run block"

# ── S9 · pre-existing workflows untouched: ci.yml + ship keep their names ────
ok=1
grep -q "^name: CI$" "$WF/ci.yml" || ok=0
[ -f "$WF/ship-on-comment.yml" ] || ok=0
[ "$ok" -eq 1 ] && pass "S9 pre-existing workflows still present under their original names" \
                || fail "S9 pre-existing workflow surface changed"

# ── S10/S11/S12 · parsed-YAML contract (Codex R2: substring greps were
#    fooled two ways — a QUOTED trigger key ("push":) evaded the ^[a-z] key
#    regex, and a COMMENTED-OUT gate line still matched the grep while GitHub
#    treats the gate as absent. Comments and quoting do not survive a real
#    YAML parse, so these three assertions now read the PARSED document:
#    S10 = activation shape (trigger set, single job, job-level env+gate,
#          read-only token, ACTIVATE confirm in the guard step);
#    S11 = any JOB in ANY workflow whose content references a vendor secret
#          must itself declare environment: release + the main/dispatch gate;
#    S12 = each named side-effect STEP carries its inputs.mode condition. ────
CONTRACT_OUT="$(python3 - "$WF" <<'PYEOF'
import glob
import json
import os
import sys

import yaml

wf_dir = sys.argv[1]
ACT = os.path.join(wf_dir, "payload-activation.yml")


def load(p):
    with open(p) as f:
        return yaml.safe_load(f)


def triggers(doc):
    # YAML 1.1: a bare `on` key parses as boolean True
    on = doc.get("on", doc.get(True))
    if isinstance(on, dict):
        return sorted(str(k) for k in on)
    if isinstance(on, list):
        return sorted(str(k) for k in on)
    return [str(on)]


def norm(expr):
    # whitespace-normalized EXACT comparison (Codex R3: substring matching
    # accepted `main || workflow_dispatch` and `mode == 'publish' || true` —
    # only full-expression equality proves the conjunction semantics)
    return " ".join(str(expr or "").split())


JOB_GATE = "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'"

failures = []
act = load(ACT)

# S10a: trigger allowlist on the PARSED key set — quoting cannot hide a key
t = triggers(act)
if t != ["workflow_dispatch"]:
    failures.append(f"S10:triggers={t}")

jobs = act.get("jobs") or {}
if len(jobs) != 1:
    failures.append(f"S10:jobs={sorted(jobs)}")
job = next(iter(jobs.values()), {}) or {}

# S10b: environment + job-level gate read from the JOB mapping itself —
# a commented-out line simply does not exist in the parse
if job.get("environment") != "release":
    failures.append(f"S10:environment={job.get('environment')!r}")
cond = norm(job.get("if"))
if cond != JOB_GATE:
    failures.append(f"S10:job-if={cond!r}")

# S10c: read-only default token + the ACTIVATE confirm inside the guard step
perms = act.get("permissions") or {}
if perms.get("contents") != "read":
    failures.append(f"S10:permissions={perms!r}")
steps = job.get("steps") or []
guard = next((st for st in steps if str(st.get("name", "")).startswith("Guards")), None)
if not guard or "ACTIVATE" not in str(guard.get("run") or ""):
    failures.append("S10:guard-step-missing-ACTIVATE")

# S12: per-step mode conditions from the parsed steps
MODES = {
    "workers.dev subdomain": "infra",
    "Create R2 bucket": "infra",
    "Deploy Worker": "infra",
    "Stamp beta capability": "infra",
    "Initialize manifest": "infra",
    "Report endpoint URL": "infra",
    "Refuse placeholder endpoint": "publish",
    "Publish preflight": "publish",
    "npm publish @flywheel-ai/onboard": "publish",
    "Verify the published version": "publish",
}
seen = set()
for step in steps:
    name = str(step.get("name") or "")
    for prefix, mode in MODES.items():
        if name.startswith(prefix):
            seen.add(prefix)
            sif = norm(step.get("if"))
            if sif != f"inputs.mode == '{mode}'":
                failures.append(f"S12:{prefix}:if={sif!r}")
missing = sorted(set(MODES) - seen)
if missing:
    failures.append(f"S12:missing-steps={missing}")

# S11: vendor-secret usage is checked per JOB across every workflow file —
# the gated thing is the job that can actually resolve the secret
for p in sorted(
    glob.glob(os.path.join(wf_dir, "*.yml")) + glob.glob(os.path.join(wf_dir, "*.yaml"))
):
    doc = load(p)
    for jname, j in (doc.get("jobs") or {}).items():
        blob = json.dumps(j)
        if "CLOUDFLARE_API_TOKEN" in blob or "NPM_PUBLISH_TOKEN" in blob:
            jcond = norm((j or {}).get("if"))
            if (j or {}).get("environment") != "release" or jcond != JOB_GATE:
                failures.append(f"S11:{os.path.basename(p)}:{jname}")

print("OK" if not failures else "FAIL " + " | ".join(failures))
PYEOF
)"; PY_RC=$?
# a parser error is a failed check, never a silent pass
if [ "$PY_RC" -eq 0 ] && [ "$CONTRACT_OUT" = "OK" ]; then
  pass "S10 activation shape (parsed): dispatch-only triggers + single job + environment release + job-level ref/event gate + read-only token + ACTIVATE confirm"
  pass "S11 (parsed, per-job): every job referencing a vendor secret declares environment: release + the main/dispatch job gate"
  pass "S12 (parsed, per-step): every side-effect step carries its inputs.mode condition (infra ×6, publish ×4)"
else
  fail "S10/S11/S12 parsed contract failed (rc=$PY_RC): $CONTRACT_OUT"
fi

echo ""
echo "release-workflows-structure: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
