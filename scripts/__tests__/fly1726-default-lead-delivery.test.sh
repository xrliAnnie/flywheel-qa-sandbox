#!/usr/bin/env bash
# FLY-1726: the Bridge's explicit default Lead reaches both upgrade and fresh-install paths.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$ROOT/scripts/lib/default-lead-agent-env.sh"
RESTART="$ROOT/scripts/restart-services.sh"
TMP="$(mktemp -d /tmp/fly1726-default-lead.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

if [ ! -f "$LIB" ]; then
  bad "default Lead delivery helper exists"
  printf '%d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi
# shellcheck source=../lib/default-lead-agent-env.sh
source "$LIB"

PROJECTS="$TMP/projects.json"
cat > "$PROJECTS" <<'JSON'
[
  {"projectName":"legacy","projectRoot":"/tmp/legacy","leads":[{"agentId":"product-lead"}]},
  {"projectName":"fresh","projectRoot":"/tmp/fresh","leads":[{"agentId":"cos-lead"}]}
]
JSON

# Upgrade path: materialize the exact former implicit default, then stay idempotent.
ENV1="$TMP/legacy.env"
printf 'UNRELATED=kept\n' > "$ENV1"
chmod 640 "$ENV1"
unset TEAMLEAD_DEFAULT_LEAD_AGENT
if default_lead_agent_env_converge "$ENV1" "$PROJECTS" "" false >/dev/null 2>&1 \
  && [ "${TEAMLEAD_DEFAULT_LEAD_AGENT:-}" = "product-lead" ] \
  && [ "$(grep -c '^TEAMLEAD_DEFAULT_LEAD_AGENT=product-lead$' "$ENV1")" -eq 1 ] \
  && grep -q '^UNRELATED=kept$' "$ENV1" \
  && [ "$(stat -c '%a' "$ENV1" 2>/dev/null || stat -f '%Lp' "$ENV1")" = 600 ]; then
  ok "legacy upgrade atomically materializes the former default as explicit config"
else
  bad "legacy upgrade did not materialize product-lead"
fi
if default_lead_agent_env_converge "$ENV1" "$PROJECTS" "" false >/dev/null 2>&1 \
  && [ "$(grep -c '^TEAMLEAD_DEFAULT_LEAD_AGENT=product-lead$' "$ENV1")" -eq 1 ]; then
  ok "legacy migration is idempotent"
else
  bad "legacy migration duplicated or rejected its explicit value"
fi

# Explicit fresh/custom config is authoritative and never rewritten.
ENV2="$TMP/explicit.env"
printf 'TEAMLEAD_DEFAULT_LEAD_AGENT=cos-lead\nUNRELATED=kept\n' > "$ENV2"
before="$(shasum -a 256 "$ENV2")"
TEAMLEAD_DEFAULT_LEAD_AGENT=cos-lead
if default_lead_agent_env_converge "$ENV2" "$PROJECTS" "" false >/dev/null 2>&1 \
  && [ "$before" = "$(shasum -a 256 "$ENV2")" ]; then
  ok "explicit canonical default validates without rewrite"
else
  bad "explicit canonical default was rejected or rewritten"
fi

# An ambiguous/absent historical default fails before changing host config.
NO_LEGACY="$TMP/no-legacy.json"
printf '[{"projectName":"only","projectRoot":"/tmp/only","leads":[{"agentId":"cos-lead"}]}]\n' > "$NO_LEGACY"
ENV3="$TMP/refuse.env"
printf 'UNRELATED=kept\n' > "$ENV3"
before="$(shasum -a 256 "$ENV3")"
unset TEAMLEAD_DEFAULT_LEAD_AGENT
out="$(default_lead_agent_env_converge "$ENV3" "$NO_LEGACY" "" false 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && [ "$before" = "$(shasum -a 256 "$ENV3")" ] \
  && grep -q 'TEAMLEAD_DEFAULT_LEAD_AGENT' <<<"$out"; then
  ok "custom legacy host fails closed with remediation and zero mutation"
else
  bad "custom legacy host did not fail closed (rc=$rc out=$out)"
fi

# The inline registry has the same precedence as Bridge loadProjects().
ENV4="$TMP/inline.env"
inline='[{"projectName":"inline","projectRoot":"/tmp/inline","leads":[{"agentId":"cos-lead"}]}]'
printf "TEAMLEAD_DEFAULT_LEAD_AGENT=cos-lead\nFLYWHEEL_PROJECTS='%s'\n" "$inline" > "$ENV4"
TEAMLEAD_DEFAULT_LEAD_AGENT=cos-lead
if default_lead_agent_env_converge "$ENV4" "$NO_LEGACY" "$inline" false >/dev/null 2>&1; then
  ok "delivery validation honors FLYWHEEL_PROJECTS precedence"
else
  bad "delivery validation ignored the active inline registry"
fi

ENV4B="$TMP/ambient-inline.env"
printf 'TEAMLEAD_DEFAULT_LEAD_AGENT=cos-lead\n' > "$ENV4B"
before="$(shasum -a 256 "$ENV4B")"
out="$(default_lead_agent_env_converge "$ENV4B" "$NO_LEGACY" "$inline" false 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && [ "$before" = "$(shasum -a 256 "$ENV4B")" ] \
  && grep -q 'ambient registry override' <<<"$out"; then
  ok "ambient inline registry cannot masquerade as persisted Bridge config"
else
  bad "ambient FLYWHEEL_PROJECTS was accepted (rc=$rc out=$out)"
fi

# Dry-run reports the migration but never writes it.
ENV5="$TMP/dry.env"
printf 'UNRELATED=kept\n' > "$ENV5"
before="$(shasum -a 256 "$ENV5")"
unset TEAMLEAD_DEFAULT_LEAD_AGENT
if default_lead_agent_env_converge "$ENV5" "$PROJECTS" "" true >/dev/null 2>&1 \
  && [ "$before" = "$(shasum -a 256 "$ENV5")" ]; then
  ok "dry-run leaves env untouched"
else
  bad "dry-run mutated or rejected a valid migration"
fi

source_line="$(grep -n 'source .*default-lead-agent-env.sh' "$RESTART" | head -1 | cut -d: -f1)"
call_line="$(grep -n 'default_lead_agent_env_converge' "$RESTART" | tail -1 | cut -d: -f1)"
lock_line="$(grep -n '^acquire_lock$' "$RESTART" | tail -1 | cut -d: -f1)"
plugin_line="$(grep -n '^# Discord plugin detection' "$RESTART" | head -1 | cut -d: -f1)"
if [ -n "$source_line" ] && [ -n "$call_line" ] && [ -n "$lock_line" ] && [ -n "$plugin_line" ] \
  && [ "$call_line" -gt "$lock_line" ] && [ "$call_line" -lt "$plugin_line" ]; then
  ok "restart converges config under its lock before deploy/service work"
else
  bad "restart wiring/order missing (source=$source_line lock=$lock_line call=$call_line plugin=$plugin_line)"
fi

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
