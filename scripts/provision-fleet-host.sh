#!/bin/bash
# FLY-519: provision-fleet-host.sh
#
# Turn a clean macOS (Apple Silicon) into a Flywheel fleet host from a captured,
# sanitized artifact (fleet/, produced by fleet-capture.sh). Idempotent and
# phased; DEFAULTS TO DRY-RUN — you must pass --apply to make any change.
#
# Most per-lead/Bridge launchd machinery already exists (flywheel-fleet.sh,
# flywheel-daemon.sh, the wrappers, skills-sync.sh). This script is the
# clean-machine glue: deps, repo clone, ~/.flywheel bootstrap, token placeholder
# + non-empty validation, launchd deploy (delegated), and end-to-end validation.
#
# RED LINES honoured:
#   - secrets: only placeholders are written; real values are NEVER touched.
#     Token validation refuses to proceed to launchd if required tokens are empty.
#   - host safety: refuses to --apply on a machine that already hosts a live
#     fleet (existing ~/.flywheel/projects.json with leads) unless --force.
#   - state migration (real tokens / memory DBs / codex auth / thread continuity)
#     is NOT automated here — see the runbook (Annie-handled).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── defaults / args ───────────────────────────────────────────────────────
DRY_RUN=1
HOME_DIR="${HOME:-}"
REPO_ROOT="$DEFAULT_REPO_ROOT"
FLEET_DIR=""
ONLY_PHASE=""
FROM_PHASE=""
SKIP_TOKEN_CHECK=0
FORCE=0
BRIDGE_URL="${FLYWHEEL_BRIDGE_URL:-http://127.0.0.1:9876}"

ALL_PHASES=(preflight deps repos flywheel-home tokens skills launchd validate)

usage() {
  cat <<EOF
Usage: provision-fleet-host.sh [options]
  --apply              actually make changes (default: dry-run, no changes)
  --from PHASE         start at PHASE (run it and all later phases)
  --only PHASE         run only PHASE
  --home DIR           target home (default: \$HOME)
  --repo-root DIR      flywheel checkout providing scripts/ (default: this repo)
  --fleet-dir DIR      captured artifact dir (default: <repo-root>/fleet)
  --skip-token-check   do not block on empty tokens (staged provisioning)
  --force              allow --apply even if a live fleet already exists here
  --bridge-url URL     Bridge base URL for validation (default: $BRIDGE_URL)
  -h, --help           this help
Phases: ${ALL_PHASES[*]}
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) DRY_RUN=0; shift ;;
    --from) FROM_PHASE="$2"; shift 2 ;;
    --only) ONLY_PHASE="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --fleet-dir) FLEET_DIR="$2"; shift 2 ;;
    --skip-token-check) SKIP_TOKEN_CHECK=1; shift ;;
    --force) FORCE=1; shift ;;
    --bridge-url) BRIDGE_URL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "provision: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$FLEET_DIR" ] || FLEET_DIR="$REPO_ROOT/fleet"
FW="$HOME_DIR/.flywheel"
MANIFEST="$FLEET_DIR/manifest.json"

# ── helpers ───────────────────────────────────────────────────────────────
log()  { echo "[provision] $*"; }
plan() { echo "[dry-run] would: $*"; }
warn() { echo "[provision][warn] $*" >&2; }
die()  { echo "[provision][error] $*" >&2; exit 1; }

# run CMD args...  — execute in apply mode, print intent in dry-run mode.
# Pass argv as separate words (run cp "$a" "$b"), never one quoted string.
# FAIL-CLOSED (Codex R1 HIGH-3): a real command failure aborts the whole
# provision — never continue (and never reach the final "done"/exit 0) after a
# broken step, which would mask a half-provisioned host.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "$*"
  else
    log "exec: $*"
    "$@" || die "command failed (exit $?): $*"
  fi
}

# step DESC  — a delegated / heavy-machinery action we describe but do not
# re-implement (the real work lives in flywheel-fleet.sh / skills-sync etc).
# Prints intent in both modes so the plan stays readable; the concrete
# delegation command (when there is one) is issued separately via run().
step() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "$*"
  else
    log "step: $*"
  fi
}

phase_enabled() {  # <phase>
  local ph="$1"
  if [ -n "$ONLY_PHASE" ]; then [ "$ph" = "$ONLY_PHASE" ] && return 0 || return 1; fi
  if [ -n "$FROM_PHASE" ]; then
    local seen=0 p
    for p in "${ALL_PHASES[@]}"; do
      [ "$p" = "$FROM_PHASE" ] && seen=1
      [ "$p" = "$ph" ] && { [ "$seen" -eq 1 ] && return 0 || return 1; }
    done
    return 1
  fi
  return 0
}

# ── token validation (also unit-tested directly) ──────────────────────────
# validate_tokens <env-example> <env-file>
#   For every key in env-example whose NAME looks secret-bearing, require it to
#   exist in env-file with a non-empty, non-placeholder value. Prints the bad
#   keys. Returns 0 if all good, 1 if any missing/empty/placeholder, 2 on usage.
validate_tokens() {
  local example="$1" envf="$2"
  [ -f "$example" ] || { echo "validate_tokens: no example: $example" >&2; return 2; }
  [ -f "$envf" ] || { echo "validate_tokens: no env file: $envf" >&2; return 2; }
  local bad=0 key val line
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^([[:space:]]*)(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    key="${BASH_REMATCH[3]}"
    # only enforce secret-bearing key names
    [[ "$key" =~ (TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|PRIVKEY|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN|_KEY) ]] || continue
    # read the value from the target env file (last assignment wins)
    val="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$envf" 2>/dev/null | tail -1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?${key}=//")"
    # strip surrounding quotes + whitespace
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    val="$(printf '%s' "$val" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    case "$val" in
      ""|__PLACEHOLDER__|CHANGE_ME|CHANGEME|"<"*">"|xxx*|TODO|TBD)
        echo "  MISSING/PLACEHOLDER: $key" >&2; bad=1 ;;
    esac
  done < "$example"
  return "$bad"
}

# ── phases ────────────────────────────────────────────────────────────────
phase_preflight() {
  log "phase: preflight"
  [ -f "$MANIFEST" ] || die "no captured artifact at $MANIFEST (run fleet-capture.sh first)"
  command -v jq >/dev/null 2>&1 || die "jq required"
  [ "$(id -u)" -eq 0 ] && die "do not run as root"
  if [ "$(uname -s)" != "Darwin" ]; then warn "not macOS — provisioning targets macOS"; fi
  # host-safety: refuse to clobber a live fleet on --apply.
  if [ "$DRY_RUN" -eq 0 ] && [ -f "$FW/projects.json" ]; then
    local leads
    leads="$(jq '[.[].leads[]?] | length' "$FW/projects.json" 2>/dev/null || echo 0)"
    if [ "${leads:-0}" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
      die "live fleet detected ($leads leads in $FW/projects.json) — refusing --apply without --force"
    fi
  fi
  log "preflight ok (manifest: $(jq -r '.repos|length' "$MANIFEST") repos, $(jq -r '.launchdJobs|length' "$MANIFEST") jobs)"
}

phase_deps() {
  log "phase: deps"
  if ! command -v brew >/dev/null 2>&1; then
    step "install Homebrew (https://brew.sh install.sh)"
  fi
  local name channel formula
  while IFS=$'\t' read -r name channel formula; do
    if command -v "$name" >/dev/null 2>&1; then
      log "dep present: $name"; continue
    fi
    case "$channel" in
      brew) run brew install "${formula:-$name}" ;;
      installer) : ;;  # homebrew handled above
      *) warn "dep '$name' needs manual install (channel: $channel) — see runbook" ;;
    esac
  done < <(jq -r '.deps[] | [.name, .channel, (.formula // "")] | @tsv' "$MANIFEST")
}

phase_repos() {
  log "phase: repos"
  local name slug targetRel target
  while IFS=$'\t' read -r name slug targetRel; do
    target="$targetRel"
    case "$target" in /*) ;; *) target="$HOME_DIR/$targetRel" ;; esac
    if [ -d "$target/.git" ]; then
      log "repo present: $name ($target)"; continue
    fi
    if [ -z "$slug" ] || [ "$slug" = "null" ]; then
      warn "repo '$name' has no slug — clone manually into $target (see runbook)"; continue
    fi
    run git clone "https://github.com/${slug}.git" "$target"
  done < <(jq -r '.repos[] | [.name, (.slug // ""), .targetDir] | @tsv' "$MANIFEST")
  # build flywheel
  local fwdir
  fwdir="$(jq -r '.repos[] | select(.name=="flywheel") | .targetDir' "$MANIFEST" | head -1)"
  case "$fwdir" in /*) ;; *) fwdir="$HOME_DIR/$fwdir" ;; esac
  if [ -n "$fwdir" ]; then
    run pnpm -C "$fwdir" install
    run pnpm -C "$fwdir" -r build
  fi
}

phase_flywheel_home() {
  log "phase: flywheel-home"
  local d
  for d in "" logs manifests bin pids comm staging state; do
    run mkdir -p "$FW/$d"
  done
  if [ -f "$FW/projects.json" ] && [ "$FORCE" -ne 1 ]; then
    log "projects.json exists — keeping (use --force to overwrite)"
  else
    run cp "$FLEET_DIR/projects.json" "$FW/projects.json"
  fi
  # install runtime bin scripts from the checkout.
  local f
  for f in flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh; do
    if [ -f "$REPO_ROOT/scripts/$f" ]; then
      run cp "$REPO_ROOT/scripts/$f" "$FW/bin/$f"
    fi
  done
}

phase_tokens() {
  log "phase: tokens"
  if [ ! -f "$FW/.env" ]; then
    if [ -f "$FLEET_DIR/env.example" ]; then
      run cp "$FLEET_DIR/env.example" "$FW/.env"
      warn "wrote placeholder $FW/.env — Annie must fill real token values"
    else
      warn "no env.example in artifact; create $FW/.env manually"
    fi
  else
    log ".env exists — not overwriting (secrets are Annie-handled)"
  fi
  # validate (dry-run still validates against whatever .env exists, if any).
  if [ -f "$FW/.env" ] && [ -f "$FLEET_DIR/env.example" ]; then
    if validate_tokens "$FLEET_DIR/env.example" "$FW/.env"; then
      log "token check: all required tokens present and non-empty"
    else
      if [ "$SKIP_TOKEN_CHECK" -eq 1 ]; then
        warn "token check failed but --skip-token-check set — continuing"
      else
        die "required tokens are empty/placeholder — fill $FW/.env then re-run --from tokens (or --skip-token-check)"
      fi
    fi
  elif [ "$DRY_RUN" -eq 0 ]; then
    warn "cannot validate tokens (missing .env or env.example)"
  fi
}

phase_skills() {
  log "phase: skills"
  # skills-sync.sh is a home-dir runtime script (synced from the flywheel-skills
  # repo); wiring is delegated, not re-implemented here. The runbook covers the
  # one-time install + first sync (global skills incl notion).
  step "wire skills-sync (skills-sync.sh + com.flywheel.skills-update.plist)"
  step "run first skills-sync (global skills incl notion)"
  local canon
  canon="$(jq -r '.skills.canonicalRepo // ""' "$MANIFEST" 2>/dev/null)"
  [ -n "$canon" ] && log "skills canonical repo: $canon"
}

phase_launchd() {
  log "phase: launchd"
  # token gate before any launchd activation.
  if [ "$SKIP_TOKEN_CHECK" -ne 1 ] && [ -f "$FW/.env" ] && [ -f "$FLEET_DIR/env.example" ]; then
    if ! validate_tokens "$FLEET_DIR/env.example" "$FW/.env" >/dev/null 2>&1; then
      die "token gate: refusing to start launchd jobs with empty/placeholder tokens"
    fi
  fi
  # Bridge + auxiliary jobs: delegated to restart-services.sh on the real host
  # (it already (re)loads bridge + cmux-watcher + standup + skills-update +
  # updater idempotently). We enumerate them here for plan visibility.
  step "deploy Bridge + auxiliary launchd jobs via restart-services.sh"
  local label kind
  while IFS=$'\t' read -r label kind; do
    [ "$kind" = "aux" ] || continue
    step "  aux job: $label"
  done < <(jq -r '.launchdJobs[] | [.label, .kind] | @tsv' "$MANIFEST")
  # leads: delegated to the real host, NOT auto-run here (Codex R1 MEDIUM).
  # `flywheel-fleet.sh apply` is a carrier-DIFF engine (model/backend cutover)
  # and reports not-installed/no-carrier on a clean host — it does NOT do a
  # from-scratch bring-up. `flywheel-daemon.sh install --all` installs from
  # EXISTING manifests, which on a clean host don't exist yet: each Lead's
  # manifest is generated by claude-lead.sh on its FIRST launch (daemon.sh:21).
  # So the correct clean-host sequence is operator-run + verified on the real
  # machine per the runbook; we narrate it rather than fire a command that
  # would silently no-op (or that this PR is forbidden to run here anyway).
  step "deploy lead launchd jobs from projects.json — per Lead:"
  step "  1) run claude-lead.sh ONCE to generate the Lead's manifest, then stop it"
  step "     (the launchd wrapper EXITS if no manifest exists — it does not self-generate)"
  step "  2) flywheel-daemon.sh install <lead> — generate plist + bootstrap from the manifest"
  step "  NOTE: run + verify on the REAL host per the runbook (flywheel-daemon.sh status)"
}

phase_validate() {
  log "phase: validate"
  local ok=1
  # Bridge HTTP up.
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "curl -fsS $BRIDGE_URL/api/runs/active (expect 2xx)"
  else
    if curl -fsS -m 10 "$BRIDGE_URL/api/runs/active" >/dev/null 2>&1; then
      log "validate: Bridge up at $BRIDGE_URL"
    else
      warn "validate: Bridge not responding at $BRIDGE_URL/api/runs/active"; ok=0
    fi
  fi
  # lead plists loaded + processes (dry-run: plan).
  local uid label
  uid="$(id -u)"
  while IFS=$'\t' read -r label _; do
    if [ "$DRY_RUN" -eq 1 ]; then
      plan "launchctl print gui/$uid/$label (expect loaded)"
    else
      if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
        log "validate: loaded $label"
      else
        warn "validate: NOT loaded $label"; ok=0
      fi
    fi
  done < <(jq -r '.launchdJobs[] | [.label, .kind] | @tsv' "$MANIFEST")
  # dispatcher smoke: Bridge read-only endpoint reachable (429 = limiting, warn).
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "dispatcher smoke: GET $BRIDGE_URL/api/runs/active (429 → warn, not fail)"
  fi
  log "validate: Discord bot online status is EXTERNAL — verify per runbook checklist"
  # Fail-closed (Codex R2 MEDIUM): a failed Bridge/launchd check must make the
  # phase (and the run) non-zero, not silently print done/exit 0.
  if [ "$ok" -eq 1 ]; then
    log "validate: PASS"
    return 0
  fi
  warn "validate: FAIL — one or more health checks failed (see above)"
  return 1
}

main() {
  log "mode: $([ "$DRY_RUN" -eq 1 ] && echo DRY-RUN || echo APPLY)  fleet-dir: $FLEET_DIR  home: $HOME_DIR"
  local ph fn
  for ph in "${ALL_PHASES[@]}"; do
    phase_enabled "$ph" || continue
    fn="phase_${ph//-/_}"
    # FAIL-CLOSED (Codex R1 HIGH-3): a phase that returns non-zero aborts the
    # run. Belt-and-suspenders with run()'s own die-on-failure.
    if ! "$fn"; then
      die "phase '$ph' failed — aborting (host left partially provisioned; re-run with --from $ph after fixing)"
    fi
  done
  log "done."
}

if [ -z "${PROVISION_FLEET_SOURCED:-}" ]; then
  main "$@"
fi
