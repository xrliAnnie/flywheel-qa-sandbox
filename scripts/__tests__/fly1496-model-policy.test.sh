#!/usr/bin/env bash
# FLY-1496: model resolution at the fleet write/rollback boundaries. There is no
# blocklist — what is enforced is that every persisted carrier is a spelling the
# registry can resolve, and that a rollback either restores its exact recorded
# pre-image or refuses outright.
set -uo pipefail

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'not ok - %s\n' "$1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POLICY="${REPO_ROOT}/scripts/validate-model-policy.mjs"
FLEET="${REPO_ROOT}/scripts/flywheel-fleet.sh"
ROOT="$(mktemp -d -t fly1496-policy-XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT

export HOME="$ROOT"
export FLYWHEEL_STATE_DIR="$HOME/.flywheel"
export FLYWHEEL_DIR="$HOME/Dev/flywheel"
mkdir -p "$HOME/.flywheel/fleet-backups/txn-badmodel" "$HOME/.flywheel/manifests"
jq -n '{changes: [{key: "geo-lead", to: {model: null}}]}' > "$ROOT/safe-clear.json"

FUTURE_MODELS="$ROOT/future-models.json"
jq -n '{
  version: 1,
  models: [
    {id:"claude-fable-5-2",provider:"anthropic",runtimeVendor:"claude",label:"Fable 5.2",aliases:["fable-5-2"],dispatch:true,maxInputTokens:1000000},
    {id:"claude-fable-5-2[1m]",provider:"anthropic",runtimeVendor:"claude",label:"Fable 5.2 (1M)",aliases:["fable-5-2-1m"],dispatch:true,maxInputTokens:1000000,contextWindowTokens:1000000}
  ],
  bindings: {fable:"claude-fable-5-2"},
  tiers: {heavy:"fable"}
}' > "$FUTURE_MODELS"
future_binding="$(FLYWHEEL_MODELS_CONFIG="$FUTURE_MODELS" node "$POLICY" fable-binding 2>/dev/null)"
if [ "$(printf '%s' "$future_binding" | jq -r '.model')" = "claude-fable-5-2" ] \
  && [ "$(printf '%s' "$future_binding" | jq -r '.contextWindowTokens')" = "null" ] \
  && [ -n "$(printf '%s' "$future_binding" | jq -r '.revision')" ] \
  && ! rg -n 'claude-fable-5' "$FLEET" >/dev/null; then
  ok "narrow Fable authority command follows future binding and fleet has no canonical literal"
else
  bad "Fable authority command/fleet single-knob contract (binding=$future_binding)"
fi

if [ "$(node "$POLICY" model claude-fable-5 lead 2>/dev/null)" = "claude-fable-5" ] \
  && [ "$(node "$POLICY" model opus lead 2>/dev/null)" = "claude-opus-5" ] \
  && [ "$(node "$POLICY" model claude-opus-4-8 lead 2>/dev/null)" = "claude-opus-4-8" ] \
  && [ "$(node "$POLICY" model null lead 2>/dev/null)" = "null" ] \
  && ! node "$POLICY" model claude-not-a-model lead >/dev/null 2>&1 \
  && node "$POLICY" changes-file "$ROOT/safe-clear.json" lead >/dev/null 2>&1; then
  ok "writer canonicalizes aliases, passes account-default through, rejects only unresolvable spellings"
else
  bad "writer boundary resolution"
fi

PROJECTS="$HOME/.flywheel/projects.json"
jq -n '[{
  projectName: "geo",
  projectRoot: "/tmp/geo",
  leads: [{agentId: "product-lead", model: "claude-fable-5"}]
}]' > "$PROJECTS"

TXN="$HOME/.flywheel/fleet-backups/txn-badmodel/transaction.json"
jq -n '{
  transactionId: "txn-badmodel",
  leads: {
    "geo-product-lead": {
      phase: "applied",
      original: {
        projectModel: "claude-not-a-model",
        projectEffort: "null",
        projectEffortTouched: false
      },
      desired: {model: "claude-fable-5", effort: ""}
    }
  }
}' > "$TXN"

before="$(shasum -a 256 "$PROJECTS" | awk '{print $1}')"
output="$(bash "$FLEET" apply --rollback --txn txn-badmodel --yes 2>&1)"
rc=$?
after="$(shasum -a 256 "$PROJECTS" | awk '{print $1}')"
phase="$(jq -r '.leads["geo-product-lead"].phase' "$TXN")"
if [ "$rc" -ne 0 ] \
  && printf '%s' "$output" | grep -q "rollback preflight rejected with zero changes" \
  && printf '%s' "$output" | grep -q "violates current model policy" \
  && [ "$before" = "$after" ] \
  && [ "$phase" = "applied" ]; then
  ok "unresolvable rollback pre-image rejects the whole rollback before any mutation"
else
  bad "unresolvable rollback pre-image (rc=$rc phase=$phase output=$output)"
fi

mkdir -p "$HOME/.flywheel/fleet-backups/txn-legacy"
jq -n '{
  transactionId: "txn-legacy",
  leads: {
    "geo-product-lead": {
      phase: "applied",
      original: {},
      desired: {model: "claude-fable-5", effort: ""}
    }
  }
}' > "$HOME/.flywheel/fleet-backups/txn-legacy/transaction.json"

before="$(shasum -a 256 "$PROJECTS" | awk '{print $1}')"
output="$(bash "$FLEET" apply --rollback --txn txn-legacy --yes 2>&1)"
rc=$?
after="$(shasum -a 256 "$PROJECTS" | awk '{print $1}')"
if [ "$rc" -ne 0 ] \
  && printf '%s' "$output" | grep -q "lacks projects.json pre-image fields" \
  && [ "$before" = "$after" ]; then
  ok "legacy rollback journal without SSOT pre-image fails closed"
else
  bad "legacy rollback journal (rc=$rc output=$output)"
fi

printf 'fly1496-model-policy: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
