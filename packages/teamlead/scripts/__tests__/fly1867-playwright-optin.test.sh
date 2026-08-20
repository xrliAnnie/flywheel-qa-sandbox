#!/bin/bash
# FLY-1867: the real Lead launcher consumes the identity-bound Playwright MCP
# capability from projects.json. Machine settings remain default-off; only an
# exact Lead entry with playwrightMcp:true gets one per-launch --settings flag.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEAD_SH="$(cd "${SCRIPT_DIR}/.." && pwd)/claude-lead.sh"
DIST="$(cd "${SCRIPT_DIR}/../../dist" && pwd 2>/dev/null || true)"

if [ ! -f "${DIST}/ProjectConfig.js" ]; then
  echo "SKIP: teamlead dist not built — run 'pnpm -C packages/teamlead build' first" >&2
  exit 0
fi

PASS=0
FAIL=0
ok() { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

make_home() {
  local h
  h=$(mktemp -d "/tmp/fly1867-lead.XXXXXX")
  mkdir -p "$h/project/.lead/eng-lead"
  printf -- '---\nname: eng-lead\n---\nLead\n' > "$h/project/.lead/eng-lead/identity.md"
  echo "$h"
}

fixture_projects() {
  local h="$1" mode="$2"
  jq -cn --arg root "$h/project" --arg mode "$mode" '
    [{
      projectName:"flywheel",
      projectRoot:$root,
      leads:[{
        agentId:"eng-lead",
        chatChannel:"1",
        match:{labels:["eng"]}
      }
      | if $mode == "true" then .playwrightMcp=true
        elif $mode == "false" then .playwrightMcp=false
        else . end]
    }]'
}

run_dry() {
  local h="$1" projects="$2"
  env -i HOME="$h" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 \
    FLYWHEEL_PROJECTS="$projects" \
    DISCORD_BOT_TOKEN="CANARYBOT" \
    TEAMLEAD_API_TOKEN="CANARYTEAM" \
    bash "$LEAD_SH" eng-lead "$h/project" flywheel 2>&1
}

plan_of() { sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p'; }
settings_value() {
  awk -F'\t' '
    previous=="--settings" && $1=="ARG" { print $2; exit }
    $1=="ARG" { previous=$2 }
  '
}

for mode in absent false; do
  H=$(make_home)
  P=$(fixture_projects "$H" "$mode")
  PLAN=$(run_dry "$H" "$P" | plan_of)
  if printf '%s\n' "$PLAN" | grep -qF $'ARG\t--settings'; then
    bad "playwrightMcp:${mode} must not opt in"
  else
    ok "playwrightMcp:${mode} stays machine-default-off"
  fi
  rm -rf "$H"
done

H=$(make_home)
P=$(fixture_projects "$H" true)
PLAN=$(run_dry "$H" "$P" | plan_of)
COUNT=$(printf '%s\n' "$PLAN" | grep -cF $'ARG\t--settings' || true)
[ "$COUNT" -eq 1 ] \
  && ok "playwrightMcp:true emits exactly one --settings" \
  || bad "playwrightMcp:true emitted ${COUNT} --settings flags"
SETTINGS=$(printf '%s\n' "$PLAN" | settings_value)
printf '%s' "$SETTINGS" | jq -e '.enabledPlugins["playwright@claude-plugins-official"] == true' >/dev/null 2>&1 \
  && ok "per-launch settings positively opt in official Playwright" \
  || bad "per-launch settings missing Playwright true"
printf '%s' "$SETTINGS" | jq -e 'keys == ["enabledPlugins"] and (.enabledPlugins | keys == ["playwright@claude-plugins-official"])' >/dev/null 2>&1 \
  && ok "opt-in settings own only the Playwright plugin path" \
  || bad "opt-in settings widened the settings surface"
rm -rf "$H"

echo ""
echo "FLY-1867 Lead Playwright opt-in: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
