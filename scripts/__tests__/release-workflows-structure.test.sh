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
COMMIT="$WF/payload-promote-commit.yml"
ACTIVATION="$WF/payload-activation.yml"

for f in "$BETA" "$PROMOTE" "$COMMIT" "$ACTIVATION"; do
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
for f in "$BETA" "$PROMOTE" "$COMMIT" "$ACTIVATION"; do
  grep -q "group: payload-release" "$f" || ok=0
done
[ "$ok" -eq 1 ] && pass "S2 concurrency group payload-release present in all four release workflows" \
                || fail "S2 concurrency group missing"

# S3: parsed job boundaries plus mutation guards replace the former step-count heuristic.
if node --test "$ROOT/scripts/__tests__/beta-workflow-structure.test.mjs" "$ROOT/scripts/__tests__/beta-schedule-receipt.test.mjs"; then
  pass "S3 beta preflight/publication/receipt jobs enforce admission and activation"
else
  fail "S3 parsed beta workflow contract or mutation guard failed"
fi

# ── S4 · credential scoping over ALL workflows (the FLY-1323 rewrite) ────────
# S4a: vendor credentials/control-plane references may appear ONLY in the
# release-environment workflow. CI has one explicit credentialless Worker
# bundle proof, but it must remain `wrangler deploy --dry-run`; every other
# workflow keeps the original zero-reference contract.
bad_cf=""
while IFS= read -r f; do
  if grep -qE "CLOUDFLARE|WRANGLER|CF_API" "$f"; then
    case "$f" in
      "$ACTIVATION") is_release_env_workflow "$f" || bad_cf="$bad_cf $f(not-env-gated)" ;;
      "$WF/ci.yml")
        normalized_ci="$(
          grep -vE '^[[:space:]]*#' "$f" \
            | awk '{ line=$0; while (sub(/\\[[:space:]]*$/, "", line)) { if ((getline nl) <= 0) break; line=line nl } print line }'
        )"
        ci_wrangler_count="$(grep -cE 'pnpm exec wrangler deploy' <<<"$normalized_ci" || true)"
        ci_dry_run_count="$(grep -cE 'pnpm exec wrangler deploy --dry-run' <<<"$normalized_ci" || true)"
        if grep -qE "CLOUDFLARE|CF_API" "$f" \
           || [ "$ci_wrangler_count" -ne 1 ] || [ "$ci_dry_run_count" -ne 1 ]; then
          bad_cf="$bad_cf $f(not-credentialless-dry-run)"
        fi
        ;;
      *) bad_cf="$bad_cf $f" ;;
    esac
  fi
done < <(all_workflows)
if [ -z "$bad_cf" ]; then
  pass "S4a vendor credentials remain release-environment-only; CI has one credentialless wrangler dry-run"
else
  fail "S4a vendor credential reference outside the release-environment contract:$bad_cf"
fi

# S4b (FLY-2388 Amendment A1): the customer-release capability is allowlisted
# only in the zero-build commit workflow and activation's sha-stamping step.
bad_customer=""
while IFS= read -r f; do
  if grep -q "FW_CUSTOMER_RELEASE_TOKEN" "$f"; then
    case "$f" in
      "$COMMIT"|"$ACTIVATION") is_release_env_workflow "$f" || bad_customer="$bad_customer $f(not-env-gated)" ;;
      *) bad_customer="$bad_customer $f" ;;
    esac
  fi
done < <(all_workflows)
if [ -z "$bad_customer" ] && grep -q "FW_CUSTOMER_RELEASE_TOKEN" "$COMMIT"; then
  pass "S4b customer-release token is scoped to the release-env commit/activation allowlist"
else
  fail "S4b customer-release token outside its allowlist:$bad_customer"
fi

# S4c: trusted publishing has no long-lived npm credential in any workflow.
# id-token is present only in the release-environment activation workflow.
bad_npm=""
while IFS= read -r f; do
  if grep -qE "NODE_AUTH_TOKEN|NPM_TOKEN|NPM_PUBLISH_TOKEN" "$f"; then
    bad_npm="$bad_npm $f(long-lived-token)"
  fi
  if grep -q "id-token" "$f"; then
    case "$f" in
      "$ACTIVATION") is_release_env_workflow "$f" || bad_npm="$bad_npm $f(not-env-gated)" ;;
      *) bad_npm="$bad_npm $f(id-token-outside-activation)" ;;
    esac
  fi
done < <(all_workflows)
if [ -z "$bad_npm" ] && grep -q 'id-token:[[:space:]]*write' "$ACTIVATION"; then
  pass "S4c zero long-lived npm token globally; OIDC id-token only in release activation"
else
  fail "S4c npm/OIDC credential contract failed:$bad_npm"
fi

# S4d: the beta workflow holds only the beta-publish capability (unchanged)
if grep -q "FW_BETA_PUBLISH_TOKEN" "$BETA" && ! grep -qE "FW_CUSTOMER_RELEASE|FW_OPS_ADMIN" "$BETA"; then
  pass "S4d beta workflow holds only the beta-publish capability"
else
  fail "S4d beta workflow capability set wrong"
fi

# S4e (Codex code R1): banning KNOWN names is a false negative — ALLOWLIST
# instead, per file. beta/promote: only FW_BETA_PUBLISH_TOKEN (unchanged).
# activation: explicitly scoped infra and publication credentials. B2 signer
# and cleanup inputs are also restricted to infra at the parsed step boundary.
bad_secret=""
for f in "$BETA" "$PROMOTE"; do
  while IFS= read -r name; do
    [ "$name" = "FW_BETA_PUBLISH_TOKEN" ] || bad_secret="$bad_secret $f:$name"
  done < <(grep -oE 'secrets\.[A-Za-z_][A-Za-z0-9_]*' "$f" | sed 's/^secrets\.//' | sort -u)
done
commit_secrets="$(grep -oE 'secrets\.[A-Za-z_][A-Za-z0-9_]*' "$COMMIT" | sed 's/^secrets\.//' | sort -u | tr '\n' ' ')"
[ "$commit_secrets" = "FW_CUSTOMER_RELEASE_TOKEN " ] \
  || bad_secret="$bad_secret $COMMIT:{${commit_secrets}}"
while IFS= read -r name; do
  case "$name" in
    CLOUDFLARE_API_TOKEN|FW_BETA_PUBLISH_TOKEN|FW_CUSTOMER_RELEASE_TOKEN|FW_CLEANUP_TOKEN|FW_R2_ACCESS_KEY_ID|FW_R2_SECRET_ACCESS_KEY) : ;;
    *) bad_secret="$bad_secret $ACTIVATION:$name" ;;
  esac
done < <(grep -oE 'secrets\.[A-Za-z_][A-Za-z0-9_]*' "$ACTIVATION" | sed 's/^secrets\.//' | sort -u)
if [ -z "$bad_secret" ]; then
  pass "S4e per-file secret allowlist holds (commit: customer capability only; activation: scoped release secrets)"
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
for f in "$PROMOTE"; do
  grep -q "Dispatch-ref guard (main only)" "$f" || ok=0
  grep -q 'refs/heads/main' "$f" || ok=0
done
grep -q "refs/heads/main" "$BETA" || ok=0
grep -q "Guards (main-only" "$COMMIT" || ok=0
grep -q 'refs/heads/main' "$COMMIT" || ok=0
grep -q 'refs/heads/main' "$ACTIVATION" || ok=0
[ "$ok" -eq 1 ] && pass "S7 main-only guard present in all four release workflows" \
                || fail "S7 dispatch-ref guard missing"

# S8: inspect executable strings, allowing inputs only in structured env/if/ref/run-name fields.
if node --input-type=module - "$ROOT" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const root=process.argv[2];const require=createRequire(path.join(root,'packages/teamlead/package.json'));const {parse}=require('yaml');
for(const name of ['payload-beta-release','payload-promote','payload-promote-commit','payload-activation']){
 const workflow=parse(fs.readFileSync(path.join(root,'.github/workflows',name+'.yml'),'utf8'));
 for(const job of Object.values(workflow.jobs))for(const step of job.steps??[]){
  for(const text of [step.run,step.with?.script])if(typeof text==='string'&&/\$\{\{\s*(?:github\.event\.)?inputs[.\[]/.test(text))throw new Error('input interpolation in executable text');
 }
}
NODE
then pass "S8 parsed run/script bodies contain no raw inputs interpolation"; else fail "S8 executable inputs interpolation"; fi

# ── S9 · pre-existing workflows untouched: ci.yml + ship keep their names ────
ok=1
grep -q "^name: CI$" "$WF/ci.yml" || ok=0
[ -f "$WF/ship-on-comment.yml" ] || ok=0
[ "$ok" -eq 1 ] && pass "S9 pre-existing workflows still present under their original names" \
                || fail "S9 pre-existing workflow surface changed"

# ── S10/S11/S12/S13 · parsed-YAML contract (Codex R2: substring greps were
#    fooled two ways — a QUOTED trigger key ("push":) evaded the ^[a-z] key
#    regex, and a COMMENTED-OUT gate line still matched the grep while GitHub
#    treats the gate as absent. Comments and quoting do not survive a real
#    YAML parse, so these three assertions now read the PARSED document:
#    S10 = activation shape (trigger set, single job, job-level env+gate,
#          read-only token, ACTIVATE confirm in the guard step);
#    S11 = any JOB in ANY workflow whose content references a vendor secret
#          must itself declare environment: release + the main/dispatch gate;
#    S12 = each named side-effect STEP carries its inputs.mode condition;
#    S13 = release triggers are their exact allowlisted sets (never merge
#          side effects), and activation retains its confirm input. ──────────
CONTRACT_OUT="$(python3 - "$WF" <<'PYEOF'
import glob
import json
import os
import sys

import yaml

wf_dir = sys.argv[1]
ACT = os.path.join(wf_dir, "payload-activation.yml")
BETA = os.path.join(wf_dir, "payload-beta-release.yml")
PROMOTE = os.path.join(wf_dir, "payload-promote.yml")
COMMIT = os.path.join(wf_dir, "payload-promote-commit.yml")
CI = os.path.join(wf_dir, "ci.yml")


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
ci = load(CI)

# S13: trigger sets are exact. A future push/pull_request addition would make
# release a merge side effect and violate REQ-0 even if every job guard stayed.
expected_triggers = {
    BETA: ["schedule", "workflow_dispatch"],
    PROMOTE: ["workflow_dispatch"],
    COMMIT: ["workflow_dispatch"],
    ACT: ["workflow_dispatch"],
}
for workflow_path, expected in expected_triggers.items():
    actual = triggers(load(workflow_path))
    if actual != expected:
        failures.append(
            f"S13:{os.path.basename(workflow_path)}:triggers={actual},expected={expected}"
        )
activation_inputs = ((act.get("on", act.get(True)) or {}).get("workflow_dispatch") or {}).get("inputs") or {}
if "confirm" not in activation_inputs:
    failures.append("S13:activation-confirm-input-missing")
commit = load(COMMIT)
commit_inputs = ((commit.get("on", commit.get(True)) or {}).get("workflow_dispatch") or {}).get("inputs") or {}
if "confirm" not in commit_inputs:
    failures.append("S13:commit-confirm-input-missing")
expected_commit_inputs = {
    "confirm", "action", "release-id", "expected-sha256",
    "withdraw-version", "fallback-version",
}
if set(commit_inputs) != expected_commit_inputs:
    failures.append(f"S13:commit-inputs={sorted(commit_inputs)}")
action_input = commit_inputs.get("action") or {}
if action_input.get("type") != "choice" or action_input.get("options") != ["commit", "abandon", "withdraw"]:
    failures.append(f"S13:commit-actions={action_input!r}")

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

# S12: prefix -> exact parsed condition. The publish command alone is also
# gated by registry preflight's free outcome; idempotent reruns skip it.
STEP_CONDITIONS = {
    "workers.dev subdomain": "inputs.mode == 'infra'",
    "Create R2 bucket": "inputs.mode == 'infra'",
    "Validate B2 deployment inputs": "inputs.mode == 'infra'",
    "Verify private R2": "inputs.mode == 'infra'",
    "Stage B2 Worker secrets": "inputs.mode == 'infra'",
    "Deploy Worker": "inputs.mode == 'infra'",
    "Stamp beta capability": "inputs.mode == 'infra'",
    "Stamp customer-release capability": "inputs.mode == 'infra'",
    "Initialize manifest": "inputs.mode == 'infra'",
    "Report endpoint URL": "inputs.mode == 'infra'",
    "Refuse placeholder endpoint": "inputs.mode == 'publish'",
    "Install pinned npm": "inputs.mode == 'publish'",
    "Publish preflight (workflow mode)": "inputs.mode == 'publish'",
    "Pack exact tarball": "inputs.mode == 'publish'",
    "Content gate on the exact tarball": "inputs.mode == 'publish'",
    "Registry preflight": "inputs.mode == 'publish'",
    "npm publish @flywheel-ai/onboard": "inputs.mode == 'publish' && steps.reg.outputs.outcome == 'free'",
    "Verify the published version": "inputs.mode == 'publish'",
}
seen = set()
for step in steps:
    name = str(step.get("name") or "")
    for prefix, expected_condition in STEP_CONDITIONS.items():
        if name.startswith(prefix):
            seen.add(prefix)
            sif = norm(step.get("if"))
            if sif != expected_condition:
                failures.append(f"S12:{prefix}:if={sif!r}")
# B2 signing/cleanup credentials must never enter publish or job-wide env.
secret_names = ['FW_R2_ACCESS_KEY_ID', 'FW_R2_SECRET_ACCESS_KEY', 'FW_CLEANUP_TOKEN']
if any(name in json.dumps(job.get('env') or {}) for name in secret_names):
    failures.append('B2:secret-in-job-env')
for step in steps:
    if any(name in json.dumps(step.get('env') or {}) for name in secret_names) and norm(step.get('if')) != "inputs.mode == 'infra'":
        failures.append('B2:secret-outside-infra')
ordered_names = ['Validate B2 deployment inputs', 'Create R2 bucket (tolerates already-exists = resume)',
                 'Verify private R2 and apply reviewed lifecycle', 'Stage B2 Worker secrets', 'Deploy Worker + capture endpoint URL']
positions = [next((i for i, step in enumerate(steps) if step.get('name') == name), -1) for name in ordered_names]
if -1 in positions or positions != sorted(positions):
    failures.append('B2:predeploy-order')

missing = sorted(set(STEP_CONDITIONS) - seen)
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
        if any(name in blob for name in ["CLOUDFLARE_API_TOKEN", "FW_CUSTOMER_RELEASE_TOKEN"]):
            jcond = norm((j or {}).get("if"))
            if (j or {}).get("environment") != "release" or jcond != JOB_GATE:
                failures.append(f"S11:{os.path.basename(p)}:{jname}")

# S14: the customer pointer execution surface is dispatch-only, one job,
# environment-gated, read-only, zero-build, and permits only a fully pinned
# actions/checkout reference with credentials disabled.
commit_jobs = commit.get("jobs") or {}
if len(commit_jobs) != 1:
    failures.append(f"S14:jobs={sorted(commit_jobs)}")
commit_job = next(iter(commit_jobs.values()), {}) or {}
if commit_job.get("environment") != "release":
    failures.append(f"S14:environment={commit_job.get('environment')!r}")
if norm(commit_job.get("if")) != JOB_GATE:
    failures.append(f"S14:job-if={norm(commit_job.get('if'))!r}")
if (commit.get("permissions") or {}) != {"contents": "read"}:
    failures.append(f"S14:permissions={commit.get('permissions')!r}")
if (commit.get("concurrency") or {}).get("group") != "payload-release":
    failures.append(f"S14:concurrency={commit.get('concurrency')!r}")
commit_steps = commit_job.get("steps") or []
for step in commit_steps:
    uses = str(step.get("uses") or "")
    run = str(step.get("run") or "")
    blob = f"{uses}\n{run}"
    if any(forbidden in blob for forbidden in [
        "pnpm install", "pnpm build", "package-onboard", "npm ci",
        "npm run build", "setup-pnpm", "actions/setup-node",
    ]):
        failures.append(f"S14:build-step={step.get('name') or uses}")
    if uses:
        if not uses.startswith("actions/checkout@"):
            failures.append(f"S14:uses-not-allowlisted={uses}")
        else:
            ref = uses.split("@", 1)[1]
            if not __import__("re").fullmatch(r"[0-9a-f]{40}", ref):
                failures.append(f"S14:checkout-not-pinned={uses}")
            with_map = step.get("with") or {}
            if with_map.get("persist-credentials") is not False:
                failures.append(f"S14:persist-credentials={with_map.get('persist-credentials')!r}")
            if with_map.get("fetch-depth") != 1:
                failures.append(f"S14:fetch-depth={with_map.get('fetch-depth')!r}")
guard = next((st for st in commit_steps if str(st.get("name", "")).startswith("Guards")), None)
release_id_module = os.path.join(os.path.dirname(os.path.dirname(wf_dir)), "scripts", "release", "lib", "release-id.mjs")
release_id_text = open(release_id_module).read()
release_id_match = __import__("re").search(r'RELEASE_ID_SOURCE\s*=\s*"([^"]+)"', release_id_text)
release_id_source = release_id_match.group(1) if release_id_match else "<missing>"
if not guard or release_id_source not in str(guard.get("run") or "") or "COMMIT" not in str(guard.get("run") or ""):
    failures.append("S14:guard-contract-missing")
commit_secret_names = sorted(set(__import__("re").findall(
    r"secrets\.([A-Za-z_][A-Za-z0-9_]*)", json.dumps(commit_job)
)))
if commit_secret_names != ["FW_CUSTOMER_RELEASE_TOKEN"]:
    failures.append(f"S14:secrets={commit_secret_names}")
action_steps = {
    "Run commit": ("commit_result", "inputs.action == 'commit'"),
    "Run abandon": ("abandon_result", "inputs.action == 'abandon'"),
    "Run withdraw": ("withdraw_result", "inputs.action == 'withdraw'"),
}
for name, (expected_id, expected_if) in action_steps.items():
    step = next((st for st in commit_steps if st.get("name") == name), None)
    if not step or step.get("id") != expected_id or norm(step.get("if")) != expected_if:
        failures.append(f"S14:action-step={name}:{step!r}")
render_index = next((i for i, st in enumerate(commit_steps) if st.get("name") == "Render result (always)"), -1)
validate_index = next((i for i, st in enumerate(commit_steps) if st.get("name") == "Validate production manifest snapshot"), -1)
action_indexes = [next((i for i, st in enumerate(commit_steps) if st.get("name") == name), -1) for name in action_steps]
render = commit_steps[render_index] if render_index >= 0 else {}
if (
    validate_index < 0
    or any(index <= validate_index for index in action_indexes)
    or render_index <= max(action_indexes)
    or norm(render.get("if")) != "always()"
    or render.get("continue-on-error") is not True
    or "PROMOTE_RESULT" not in str(render.get("run") or "")
):
    failures.append("S14:validate-action-render-order")

# S15: exact-tarball OIDC dataflow. Every consumer is bound through parsed
# step outputs; source directories, ambient tags, and long-lived npm tokens
# cannot substitute for the reviewed tarball tuple.
if perms != {"contents": "read", "id-token": "write"}:
    failures.append(f"S15:permissions={perms!r}")

def step_with_prefix(prefix):
    return next((st for st in steps if str(st.get("name") or "").startswith(prefix)), None)

publish_names = [
    "Install pinned npm",
    "Publish preflight (workflow mode)",
    "Pack exact tarball",
    "Content gate on the exact tarball",
    "Registry preflight",
    "npm publish @flywheel-ai/onboard",
    "Verify the published version",
]
publish_steps = {name: step_with_prefix(name) for name in publish_names}

# S16 is independent of S15's complete publish-step inventory: a missing S15
# step must not suppress an unrelated CI/activation npm-pin mismatch.
activation_install = publish_steps["Install pinned npm"]
activation_install_run = None if activation_install is None else norm(activation_install.get("run"))
ci_payload = ((ci.get("jobs") or {}).get("payload-distribution") or {})
ci_steps = ci_payload.get("steps") or []
ci_install = next((
    st for st in ci_steps
    if st.get("name") == "Install pinned npm for publish integration"
), None)
ci_idempotency = next((
    st for st in ci_steps
    if st.get("name") == "Exact shell publish idempotency (local registry stub)"
), None)
if (
    activation_install_run is None
    or ci_install is None
    or ci_idempotency is None
    or norm(ci_install.get("run")) != activation_install_run
    or ci_steps.index(ci_install) >= ci_steps.index(ci_idempotency)
):
    failures.append(
        "S16:ci-pinned-npm-before-idempotency="
        f"install:{None if ci_install is None else norm(ci_install.get('run'))!r},"
        f"activation:{activation_install_run!r}"
    )

if any(step is None for step in publish_steps.values()):
    failures.append(f"S15:missing={sorted(name for name, step in publish_steps.items() if step is None)}")
else:
    install = publish_steps["Install pinned npm"]
    workflow_preflight = publish_steps["Publish preflight (workflow mode)"]
    pack = publish_steps["Pack exact tarball"]
    content = publish_steps["Content gate on the exact tarball"]
    registry = publish_steps["Registry preflight"]
    publish = publish_steps["npm publish @flywheel-ai/onboard"]
    verify = publish_steps["Verify the published version"]
    if pack.get("id") != "pack" or registry.get("id") != "reg":
        failures.append(f"S15:ids=pack:{pack.get('id')!r},reg:{registry.get('id')!r}")
    indexes = [steps.index(publish_steps[name]) for name in publish_names]
    if indexes != sorted(indexes):
        failures.append(f"S15:order={indexes}")
    npm_pin = __import__("re").fullmatch(r"npm i -g npm@(\d+)\.(\d+)\.(\d+)", norm(install.get("run")))
    if not npm_pin or tuple(map(int, npm_pin.groups())) < (11, 5, 1):
        failures.append(f"S15:npm-pin={norm(install.get('run'))!r}")
    if norm(workflow_preflight.get("run")) != "bash scripts/release/shell-publish-preflight.sh --workflow":
        failures.append(f"S15:workflow-preflight={norm(workflow_preflight.get('run'))!r}")
    if norm(pack.get("run")) != 'node scripts/release/shell-publish-helper.mjs pack --out "$RUNNER_TEMP/shell"':
        failures.append(f"S15:pack-run={norm(pack.get('run'))!r}")
    expected_env = {
        "Content gate on the exact tarball": {
            "TARBALL": "${{ steps.pack.outputs.tarball }}",
        },
        "Registry preflight": {
            "TARBALL": "${{ steps.pack.outputs.tarball }}",
            "SHA": "${{ steps.pack.outputs.sha }}",
            "TAG": "${{ steps.pack.outputs.tag }}",
        },
        "npm publish @flywheel-ai/onboard": {
            "TARBALL": "${{ steps.pack.outputs.tarball }}",
            "TAG": "${{ steps.pack.outputs.tag }}",
            "NPM_CONFIG_PROVENANCE": "false",
        },
        "Verify the published version": {
            "TARBALL": "${{ steps.pack.outputs.tarball }}",
            "SHA": "${{ steps.pack.outputs.sha }}",
            "TAG": "${{ steps.pack.outputs.tag }}",
        },
    }
    for name, wanted in expected_env.items():
        actual = publish_steps[name].get("env") or {}
        for key, value in wanted.items():
            if actual.get(key) != value:
                failures.append(f"S15:{name}:env.{key}={actual.get(key)!r}")
    helper_binding = '--expect-sha "$SHA" --expect-tag "$TAG" --registry https://registry.npmjs.org/'
    if norm(content.get("run")) != 'node scripts/release/shell-publish-helper.mjs gate "$TARBALL"':
        failures.append(f"S15:content-run={norm(content.get('run'))!r}")
    if helper_binding not in norm(registry.get("run")) or 'preflight "$TARBALL"' not in norm(registry.get("run")):
        failures.append(f"S15:registry-run={norm(registry.get('run'))!r}")
    if norm(publish.get("run")) != 'npm publish "$TARBALL" --access public --tag "$TAG"':
        failures.append(f"S15:publish-run={norm(publish.get('run'))!r}")
    if helper_binding not in norm(verify.get("run")) or 'verify "$TARBALL"' not in norm(verify.get("run")):
        failures.append(f"S15:verify-run={norm(verify.get('run'))!r}")

print("OK" if not failures else "FAIL " + " | ".join(failures))
PYEOF
)"; PY_RC=$?
# a parser error is a failed check, never a silent pass
if [ "$PY_RC" -eq 0 ] && [ "$CONTRACT_OUT" = "OK" ]; then
  pass "S10 activation shape (parsed): dispatch-only triggers + single job + release env + job gate + contents-read/OIDC permissions + ACTIVATE confirm"
  pass "S11 (parsed, per-job): every job referencing a vendor secret declares environment: release + the main/dispatch job gate"
  pass "S12 (parsed, per-step): every side-effect step carries its exact condition (infra ×10, publish ×8)"
  pass "S13 (parsed): release trigger sets are exact and activation retains confirm (release is never a merge side effect)"
  pass "S14 (parsed): commit workflow is one release-env, dispatch-only, read-only, pinned-checkout, zero-build job"
  pass "S15 (parsed): OIDC publish binds exact tarball + sha + dist-tag through pack/reg outputs"
  pass "S16 (parsed): payload CI installs the activation workflow's exact npm pin before the idempotency integration"
else
  fail "S10-S16 parsed contract failed (rc=$PY_RC): $CONTRACT_OUT"
fi

# B2: parsed cleanup workflow + native lifecycle, including adverse mutations.
if python3 - "$ROOT" <<'PYB2'
import copy, json, pathlib, sys, yaml
root = pathlib.Path(sys.argv[1])
workflow = yaml.safe_load((root / '.github/workflows/payload-cleanup.yml').read_text())
lifecycle = json.loads((root / 'packages/payload-endpoint/r2-lifecycle.json').read_text())
def check(w, native):
    triggers = w.get('on', w.get(True))
    assert set(triggers) == {'schedule', 'workflow_dispatch'}
    assert triggers['schedule'] == [{'cron': '17 * * * *'}]
    assert w['permissions'] == {'contents': 'read'}
    assert w['concurrency'] == {'group': 'payload-cleanup', 'cancel-in-progress': False}
    assert set(w['jobs']) == {'cleanup'}
    job = w['jobs']['cleanup']
    assert job['environment'] == 'release' and job['timeout-minutes'] == 10
    assert job['if'] == "github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')"
    steps = job['steps']
    assert steps[0]['id'] == 'preflight'
    assert 'not activated' in steps[0]['run'] and 'activated=false' in steps[0]['run']
    assert len(steps) == 4
    assert all(s['if'] == "steps.preflight.outputs.activated == 'true'" for s in steps[1:])
    assert steps[1]['uses'] == 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5'
    assert steps[1]['with']['persist-credentials'] is False
    assert steps[2]['uses'] == 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
    assert steps[3]['run'] == 'node scripts/release/payload-cleanup.mjs --apply'
    assert steps[3]['env'] == {'FW_ENDPOINT': '${{ vars.FW_ENDPOINT }}', 'FW_CLEANUP_TOKEN': '${{ secrets.FW_CLEANUP_TOKEN }}'}
    blob = json.dumps(w)
    assert all(k not in blob for k in ['FW_OPS_ADMIN', 'FW_R2_SECRET', 'CLOUDFLARE_API', 'FW_BETA_PUBLISH', 'FW_CUSTOMER_RELEASE'])
    assert native == {'rules': [{'id': 'abort-incomplete-multipart-7d', 'enabled': True, 'conditions': {'prefix': ''}, 'abortMultipartUploadsTransition': {'condition': {'type': 'Age', 'maxAge': 604800}}}]}
check(workflow, lifecycle)
mutations = [lambda w: w['jobs']['cleanup'].pop('if'), lambda w: w['jobs']['cleanup'].pop('environment'),
             lambda w: w['jobs']['cleanup']['steps'][1].pop('if'),
             lambda w: w['concurrency'].update({'cancel-in-progress': True}),
             lambda w: w['concurrency'].update({'group': 'payload-release'}),
             lambda w: w['jobs']['cleanup']['steps'][3]['env'].update({'FW_OPS_ADMIN_TOKEN': 'unsafe'})]
for mutate in mutations:
    bad = copy.deepcopy(workflow); mutate(bad)
    try: check(bad, lifecycle)
    except (AssertionError, KeyError): pass
    else: raise AssertionError('unsafe workflow mutation survived')
bad = copy.deepcopy(lifecycle); bad['rules'][0]['deleteObjectsTransition'] = {'condition': {'type': 'Age', 'maxAge': 86400}}
try: check(workflow, bad)
except AssertionError: pass
else: raise AssertionError('native object-age deletion survived')
PYB2
then pass "S17 parsed B2 cleanup/main/env/skip/least privilege and native lifecycle mutation guards"
else fail "S17 B2 cleanup or lifecycle contract"
fi

echo ""
echo "release-workflows-structure: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
