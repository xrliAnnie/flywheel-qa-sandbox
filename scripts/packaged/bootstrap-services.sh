#!/usr/bin/env bash
# FLY-1062 P2-5: packaged first-install service bootstrap.
#
# On a PACKAGED tree (root carries .flywheel-prebuilt) the monorepo's darwin
# bring-up path does not exist: restart-services.sh is a monorepo deploy script
# (git status checks / pnpm build / tsx fallback) and flywheel-daemon.sh
# hardcodes ~/Dev/flywheel — both are DISABLED on the packaged path. This step
# is the packaged replacement: it renders + installs the Bridge, daily-standup
# and per-Lead supervisor jobs FROM PKG_ROOT, entirely through the supervisor
# seam (works on darwin via the FLY-1062 opt-in real install, and on linux via
# the existing systemd renderer). Zero restart-services.sh, zero ~/Dev/flywheel.
#
# Notes:
#   • the git auto-updater job (com.flywheel.updater) is NOT installed on the
#     packaged path — packaged updates flow through the installer's `update`
#     command (research §7; npm-ified auto-update is a registered follow-up);
#   • wrappers land in <state>/bin WITH their support-lib closure
#     (lib/host-config.sh — Codex R2#2: a copied wrapper without it silently
#     falls back to ~/Dev/flywheel);
#   • host.json gains flywheelDir=<state>/runtime/current if absent (merge,
#     never clobbering operator fields).
#
# Usage: bootstrap-services.sh [--pkg-root DIR] [--state-dir DIR]
#                              [--no-leads] [--dry-run]
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
DRY_RUN=0
INSTALL_LEADS=1

log() { echo "[packaged-bootstrap] $*"; }
warn() { echo "[packaged-bootstrap][warn] $*" >&2; }
err() { echo "[packaged-bootstrap][error] $*" >&2; }
die() { err "$*"; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pkg-root) PKG_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --no-leads) INSTALL_LEADS=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: bootstrap-services.sh [--pkg-root DIR] [--state-dir DIR] [--no-leads] [--dry-run]"
      exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[ -f "$PKG_ROOT/.flywheel-prebuilt" ] \
  || die "not a packaged tree (no .flywheel-prebuilt at $PKG_ROOT) — this bootstrap only runs on packaged installs"
command -v jq >/dev/null 2>&1 || die "jq required"

SCRIPTS="$PKG_ROOT/scripts"
# shellcheck source=../lib/script-sanity.sh
source "$SCRIPTS/lib/script-sanity.sh"
# shellcheck source=../lib/host-config.sh
source "$SCRIPTS/lib/host-config.sh"
# shellcheck source=../lib/lead-restart-lifecycle.sh
source "$SCRIPTS/lib/lead-restart-lifecycle.sh"
# shellcheck source=../lib/supervisor.sh
source "$SCRIPTS/lib/supervisor.sh"

# The stable runtime root every service points at — survives version flips.
CURRENT="${FLYWHEEL_RUNTIME_CURRENT:-$STATE_DIR/runtime/current}"

# ── host.json: ensure flywheelDir points at the stable runtime root ─────────
HOST_JSON="$HOME/.flywheel/host.json"   # bootstrap path (wrappers look here first)
ensure_host_json() {
  mkdir -p "$(dirname "$HOST_JSON")"
  if [ -f "$HOST_JSON" ]; then
    jq empty "$HOST_JSON" >/dev/null 2>&1 || die "malformed host.json at $HOST_JSON (fail-closed — fix it first)"
    local cur
    cur="$(jq -r '.flywheelDir // empty' "$HOST_JSON")"
    if [ -n "$cur" ] && [ "$cur" != "$CURRENT" ]; then
      log "host.json flywheelDir already set to '$cur' — keeping (operator override)"
      return 0
    fi
    [ "$cur" = "$CURRENT" ] && return 0
    if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would set host.json flywheelDir=$CURRENT"; return 0; fi
    local tmp="$HOST_JSON.tmp.$$"
    jq --arg d "$CURRENT" '. + {flywheelDir: $d}' "$HOST_JSON" > "$tmp" && mv "$tmp" "$HOST_JSON" \
      || die "cannot update host.json"
  else
    if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would write host.json (flywheelDir=$CURRENT)"; return 0; fi
    jq -n --arg d "$CURRENT" '{schemaVersion: 1, flywheelDir: $d}' > "$HOST_JSON" \
      || die "cannot write host.json"
  fi
  log "host.json flywheelDir=$CURRENT"
}

# ── wrappers + support-lib closure into <state>/bin ─────────────────────────
install_bin() {
  local f
  mkdir -p "$STATE_DIR/bin/lib" "$STATE_DIR/pids" "$STATE_DIR/state" "$STATE_DIR/logs" "$STATE_DIR/manifests"
  for f in flywheel-bridge-wrapper.sh flywheel-lead-wrapper-v2.sh flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh host-tmux-selection-gate.sh; do
    [ -f "$SCRIPTS/$f" ] || die "wrapper missing from package: scripts/$f"
    if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would install $f -> $STATE_DIR/bin/$f"; continue; fi
    install_script_atomic "$SCRIPTS/$f" "$STATE_DIR/bin/$f" \
      || die "wrapper failed sanity/atomic install: $f"
  done
  # Codex R2#2 closure: the copied wrappers source $SELF_DIR/lib/host-config.sh;
  # without it they silently fall back to ~/Dev/flywheel.
  for f in lib/host-config.sh lib/lead-address.sh; do
    [ -f "$SCRIPTS/$f" ] || die "support lib missing from package: scripts/$f"
    if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would install $f -> $STATE_DIR/bin/$f"; continue; fi
    install_script_atomic "$SCRIPTS/$f" "$STATE_DIR/bin/$f" \
      || die "support lib failed sanity/atomic install: $f"
  done
}

# ── service specs (same shape both platforms; supervisor renders per-OS) ────
emit_specs() {
  supervisor_bridge_spec "$STATE_DIR/bin/flywheel-bridge-wrapper.sh"
  jq -nc --arg cur "$CURRENT" \
    '{name:"daily-standup",kind:"timer",exec:("/bin/bash "+$cur+"/scripts/daily-standup.sh"),schedule:[{hour:3,minute:0}]}'
  if [ "$INSTALL_LEADS" -eq 1 ]; then
    local m project_name lead_id backend
    for m in "$STATE_DIR/manifests"/*.json; do
      [ -e "$m" ] || continue
      project_name=$(jq -er '.projectName' "$m") || die "invalid manifest projectName: $m"
      lead_id=$(jq -er '.leadId' "$m") || die "invalid manifest leadId: $m"
      backend=$(lead_restart_project_backend "$STATE_DIR/projects.json" "$project_name" "$lead_id") \
        || die "projects.json has no unique backend authority for ${project_name}/${lead_id}"
      if [ "$backend" != "claude-code" ]; then
        warn "lead ${project_name}/${lead_id}: skipping bespoke backend ${backend}; generic provision only installs Claude v2"
        continue
      fi
      jq -c --arg bin "$STATE_DIR/bin" --arg m "$m" \
        '{name:("lead-"+.projectName+"-"+.leadId),kind:"service",exec:("/bin/bash "+$bin+"/flywheel-lead-wrapper-v2.sh "+$m),keepAlive:true}' "$m"
    done
  fi
}

main() {
  log "pkg-root: $PKG_ROOT | state: $STATE_DIR | runtime root: $CURRENT | backend: $(supervisor_backend)"
  ensure_host_json
  install_bin
  # Materialize Lead manifests from projects.json (idempotent; same tool the
  # linux provisioner uses). Missing projects.json = first Buddy run hasn't
  # written it yet — Leads get installed on a later re-run.
  if [ "$INSTALL_LEADS" -eq 1 ] && [ -f "$STATE_DIR/projects.json" ] && [ -f "$SCRIPTS/materialize-lead-manifests.sh" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] would materialize lead manifests"
    else
      bash "$SCRIPTS/materialize-lead-manifests.sh" \
        --home "$HOME" --projects "$STATE_DIR/projects.json" --manifests-dir "$STATE_DIR/manifests" \
        || die "lead manifest materialization failed"
    fi
  fi
  local spec name rc=0
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    name="$(jq -r '.name' <<<"$spec")"
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] would supervisor-install: $name"
      continue
    fi
    log "supervisor install: $name"
    FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 supervisor_install "$spec" \
      || { err "supervisor install failed: $name"; rc=1; }
  done < <(emit_specs)
  [ "$rc" -eq 0 ] || die "one or more services failed to install"
  log "done."
}

main
