#!/bin/bash
# FLY-2459: source-only adapter inside the existing updater-owned restart window.
# No watcher, scheduler, approval, service action, or admission-resume entry lives here.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo 'lead-backend-migration.sh must be sourced by restart-services' >&2
  exit 78
fi

lead_backend_migration_run() {
  local migration_home="$1" intent="" entry="" context=""
  intent="$migration_home/.flywheel/lead-backend-migrations/FLY-2459-honey-lemon.json"
  [[ -e "$intent" || -L "$intent" ]] || return 0
  if [[ "${RESTART_REASON:-}" != updater || -z "${ADMISSION_PAUSE_LEASE_ID:-}" \
    || "${LOCK_DIR:-}" != "$migration_home/.flywheel/restart.lock.d" \
    || ! -d "$LOCK_DIR" || -L "$LOCK_DIR" ]]; then
    echo 'migration requires the owned updater restart/admission window' >&2
    return 78
  fi
  entry="${FLYWHEEL_DIR:?}/packages/teamlead/dist/bin/execute-backend-migration.js"
  if [[ ! -f "$entry" || -L "$entry" ]]; then
    echo 'migration compiled entry unavailable' >&2
    return 78
  fi
  # These observations are inputs, not authority. The internal entry must verify
  # the actual ancestry/lock tuple and owner-qualified admission lease again.
  context="$(node - "$migration_home" "$FLYWHEEL_DIR" "$$" "$ADMISSION_PAUSE_LEASE_ID" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [home, root, restartPidText, leaseId] = process.argv.slice(2);
const restartPid = Number(restartPidText);
const lock = fs.lstatSync(path.join(home, '.flywheel/restart.lock.d'));
const restartStart = execFileSync('/bin/ps', ['-p', restartPidText, '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, env: {...process.env, LC_ALL:'C'} }).trim();
process.stdout.write(JSON.stringify({home, root, restartPid, restartStart, lockDev:lock.dev, lockIno:lock.ino, leaseId, restartScript:path.join(root,'scripts/restart-services.sh'), updaterScript:path.join(root,'scripts/update-flywheel.sh')}));
NODE
)" || return 78
  node "$entry" --window-context "$context"
}

# Prepared-stage checks only. Full generic preflight follows the config/manifest
# CAS and precedes activation, per Lead ruling 2a724d78. No candidate registry API.
lead_backend_migration_static_preflight() (
  [[ "$#" -eq 5 ]] || return 64
  local migration_home="$1" root="$2" project_root="$3" target_sha="$4" bot_env="$5"
  local codex_home="" state_dir="" inspection="" profile="" tool=""
  [[ "$migration_home" = /* && "$root" = /* && "$project_root" = /* \
    && "$target_sha" =~ ^[a-f0-9]{40}$ && "$bot_env" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 64
  if [[ -z "${FLYWHEEL_API_TOKEN:-${TEAMLEAD_API_TOKEN:-}}" || -z "${!bot_env:-}" ]]; then
    echo 'migration static preflight: required Bridge or bot token unavailable' >&2
    return 78
  fi
  for tool in "$root/scripts/lib/lead-address.sh" \
    "$root/packages/flywheel-comm/dist/index.js" \
    "$root/packages/teamlead/dist/bin/preflight-codex-project-root.js" \
    "$root/packages/teamlead/dist/lead-backends/codex/lead-actions/lead-actions-main.js" \
    "$root/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js" \
    "$project_root/.lead/flywheel-product-lead/identity.md"; do
    [[ -f "$tool" && ! -L "$tool" && -r "$tool" ]] || {
      echo 'migration static preflight: required code or identity file unavailable' >&2
      return 78
    }
  done
  for tool in "$root/scripts/codex-home-link-truth.sh" \
    "$root/scripts/host-tmux-selection-gate.sh" \
    "$root/packages/teamlead/scripts/codex-lead.sh"; do
    [[ -f "$tool" && ! -L "$tool" && -x "$tool" ]] || return 78
  done
  # shellcheck source=lead-address.sh
  source "$root/scripts/lib/lead-address.sh"
  codex_home="$(derive_codex_lead_home flywheel-product-lead "$migration_home")" || return 78
  [[ -d "$codex_home" && ! -L "$codex_home" && -f "$codex_home/auth.json" \
    && -x "$codex_home/packages/standalone/current/codex" ]] || return 78
  profile="$(node "$root/packages/flywheel-comm/dist/index.js" lead-registry generic-codex-profile)" || return 78
  [[ "$profile" = full-access ]] || return 78
  inspection="$("$root/scripts/codex-home-link-truth.sh" --inspect --lead flywheel/flywheel-product-lead "$codex_home")" || return 78
  jq -e '.state == "already"' <<<"$inspection" >/dev/null || return 78
  state_dir="$(FLYWHEEL_STATE_DIR="$migration_home/.flywheel" \
    /bin/bash "$root/packages/teamlead/scripts/codex-lead.sh" --print-state-dir flywheel-product-lead flywheel)" || return 78
  [[ "$state_dir" = /* ]] || return 78
  node "$root/packages/teamlead/dist/bin/preflight-codex-project-root.js" \
    --project-root "$project_root" --state-dir "$state_dir" --codex-home "$codex_home" >/dev/null || return 78
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$target_sha" \
    FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="migration:FLY-2459:prepared" \
    FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/lib/lead-backend-migration.sh" \
    "$root/scripts/host-tmux-selection-gate.sh" probe codex-generic >/dev/null || return 78
  jq -nc --arg codexHome "$codex_home" --arg stateDir "$state_dir" \
    '{codexHome:$codexHome,stateDir:$stateDir}'
)

# Bootstrap the already-CASed plist byte-for-byte. Generic install regenerates
# it, so it cannot preserve either the target postimage or a restored source.
# The internal caller proves the updater window and unloaded state before this.
lead_backend_migration_load_staged() (
  [[ "$#" -eq 2 ]] || return 64
  local migration_home="$1" root="$2"
  [[ "$migration_home" = /* && "$root" = /* ]] || return 64
  [[ -f "$root/scripts/flywheel-lead.sh" && ! -L "$root/scripts/flywheel-lead.sh" ]] || return 78
  export HOME="$migration_home" FLYWHEEL_DIR="$root" FLYWHEEL_STATE_DIR="$migration_home/.flywheel"
  export FLYWHEEL_LAUNCHD_DIR="$migration_home/Library/LaunchAgents"
  source "$root/scripts/flywheel-lead.sh" || return $?
  load_common paths-only || return $?
  resolve_lifecycle_target --project flywheel --lead flywheel-product-lead || return $?
  (preflight_manifest "$LIFECYCLE_MANIFEST") || return $?
  assert_lifecycle_carrier || return $?
  plist_matches_lifecycle_target "$LIFECYCLE_PLIST" || return 78
  launchctl bootstrap "gui/$(id -u)" "$LIFECYCLE_PLIST" || return $?
  plist_matches_lifecycle_target "$LIFECYCLE_PLIST" || return 78
)
