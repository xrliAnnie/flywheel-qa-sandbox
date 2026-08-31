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
STATE_DIR_FLAG=""
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
  --state-dir DIR      custom state dir (the ONLY way to redirect state writes; inherited FLYWHEEL_STATE_DIR is ignored)
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
    --state-dir) STATE_DIR_FLAG="$2"; shift 2 ;;
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
HOST_JSON="$FW/host.json"

# FLY-650: platform-abstraction libs. host-config resolves platform + supervisor
# backend (darwin defaults reproduce today's launchd behavior, byte-compat);
# supervisor renders systemd units on linux; platform-deps resolves per-platform
# install actions. Sourcing only defines functions (guarded, no side effects).
# shellcheck source=lib/host-config.sh
source "$SCRIPT_DIR/lib/host-config.sh"
# shellcheck source=lib/lead-restart-lifecycle.sh
source "$SCRIPT_DIR/lib/lead-restart-lifecycle.sh"
# shellcheck source=lib/supervisor.sh
source "$SCRIPT_DIR/lib/supervisor.sh"
# shellcheck source=lib/platform-deps.sh
source "$SCRIPT_DIR/lib/platform-deps.sh"
# shellcheck source=lib/script-sanity.sh
source "$SCRIPT_DIR/lib/script-sanity.sh"
# shellcheck source=lib/path-hygiene.sh
source "$SCRIPT_DIR/lib/path-hygiene.sh"

# ── helpers ───────────────────────────────────────────────────────────────
log()  { echo "[provision] $*"; }
plan() { echo "[dry-run] would: $*"; }
warn() { echo "[provision][warn] $*" >&2; }
die()  { echo "[provision][error] $*" >&2; exit 1; }

# ── FLY-1389 P1-b: temp/worktree source guard on the EFFECTIVE-GLOBAL
# destination. The provisioner writes global content (bin scripts, hooks,
# LaunchAgents) sourced from REPO_ROOT — provisioning the real ~/.flywheel
# from a temp/worktree checkout persists soon-to-vanish paths. Judged on the
# RESOLVED destination, not the call shape: an explicit fake --home stays
# allowed, and so does a fully-sandboxed run (hermetic suites fake HOME too
# — a destination that is itself a temp path is a test sandbox, not this
# machine's global config). Dry-run writes nothing → not guarded.
_fw_canon="$(path_hygiene_canonicalize "$FW" 2>/dev/null || echo "")"
if [ "$DRY_RUN" -eq 0 ] \
   && path_hygiene_same_path "$FW" "$HOME/.flywheel" \
   && { [ -z "$_fw_canon" ] || ! path_hygiene_is_temp_path "$_fw_canon"; } \
   && is_temp_or_worktree_root "$REPO_ROOT"; then
  die "refusing to provision the effective-global $FW from temp/worktree checkout $REPO_ROOT — global config must come from the main checkout (FLY-1389)"
fi

# FLY-954: the provisioner is a WRITER — it must not trust env vars designed
# for runtime READERS (the wrappers). Incident 2026-07-06: a runner-born
# production FLYWHEEL_STATE_DIR silently outranked the test's --home sandbox
# (host-config.sh gives env top priority) and 12-byte fixture stubs were cp'd
# into the real ~/.flywheel/bin. State-dir intent now enters ONLY via
# --state-dir (or host.json stateDir); inherited env is discarded loudly.
if [ -n "${FLYWHEEL_STATE_DIR:-}" ]; then
  warn "ignoring inherited FLYWHEEL_STATE_DIR='${FLYWHEEL_STATE_DIR}' — writers only honor --state-dir / host.json"
fi
if [ -n "${FLYWHEEL_DIR:-}" ]; then
  warn "ignoring inherited FLYWHEEL_DIR='${FLYWHEEL_DIR}' — use --repo-root / host.json"
fi
unset FLYWHEEL_STATE_DIR FLYWHEEL_DIR
[ -n "$STATE_DIR_FLAG" ] && export FLYWHEEL_STATE_DIR="$STATE_DIR_FLAG"

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
  case "$FLYWHEEL_PLATFORM" in
    darwin|linux) ;;
    *) warn "unsupported platform '${FLYWHEEL_PLATFORM:-?}' — provisioning supports darwin|linux" ;;
  esac
  # host-safety: the live-fleet guard runs in main() BEFORE the phase loop so it
  # protects EVERY entrypoint (incl --only/--from flywheel-home), not just a full
  # run through preflight (Codex R4 HIGH). Nothing to do here.
  log "preflight ok (manifest: $(jq -r '.repos|length' "$MANIFEST") repos, $(jq -r '.launchdJobs|length' "$MANIFEST") jobs)"
}

# _host_safety_guard — refuse to clobber a live fleet on --apply (FLY-519 red line).
# FLY-650: checks BOTH the resolved state dir AND the DEFAULT ~/.flywheel (a custom
# host.json.stateDir must not let an existing default-location fleet slip past).
# FLY-650 (Codex R4 HIGH): called from main() before ANY phase, so destructive
# --only/--from entrypoints (e.g. flywheel-home) cannot bypass it.
_host_safety_guard() {
  [ "$DRY_RUN" -eq 0 ] || return 0
  [ "$FORCE" -ne 1 ] || return 0
  # Idempotency (Codex R4): once THIS provision has written its bootstrap host.json
  # marker, staged re-entry (--only tokens after --only flywheel-home, re-runs) is
  # our own managed state — skip. A pre-FLY-650 live fleet has NO host.json, so the
  # accidental-clobber case (provisioning over a foreign/older live fleet) still
  # fires. Re-clobbering an already-provisioned host is an explicit --force action.
  [ -f "$HOST_JSON" ] && return 0
  local -a cands=("$FW/projects.json")
  [ "$FW" != "$HOME_DIR/.flywheel" ] && cands+=("$HOME_DIR/.flywheel/projects.json")
  local pj n total=0
  for pj in "${cands[@]}"; do
    [ -f "$pj" ] || continue
    n="$(jq '[.[].leads[]?] | length' "$pj" 2>/dev/null || echo 0)"
    total=$((total + ${n:-0}))
  done
  if [ "$total" -gt 0 ]; then
    die "live fleet detected ($total leads in ${cands[*]}) — refusing --apply without --force"
  fi
}

# detect_pkgmgr <platform> — which package manager to drive on this host.
detect_pkgmgr() {
  case "$1" in
    darwin) echo brew ;;
    linux)
      if command -v apt-get >/dev/null 2>&1; then echo apt
      elif command -v dnf >/dev/null 2>&1; then echo dnf
      else echo ""; fi ;;
    *) echo "" ;;
  esac
}

phase_deps() {
  local platform="${FLYWHEEL_PLATFORM:-}"
  if [ -z "$platform" ]; then
    case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) platform=unknown ;; esac
  fi
  local pkgmgr; pkgmgr="$(detect_pkgmgr "$platform")"
  log "phase: deps (platform: $platform, pkgmgr: ${pkgmgr:-none})"
  if [ "$platform" = "darwin" ] && [ "$pkgmgr" = "brew" ] && ! command -v brew >/dev/null 2>&1; then
    step "install Homebrew (https://brew.sh install.sh)"
  fi
  # FLY-650: per-platform install actions via platform-deps.sh (brew/apt/dnf/
  # present-check/manual/skip). REQUIRED deps with no linux mapping fail-loud.
  local manifest_json; manifest_json="$(cat "$MANIFEST")"
  local name action arg
  while IFS=$'\t' read -r name action arg; do
    [ -z "$name" ] && continue
    if command -v "$name" >/dev/null 2>&1; then
      log "dep present: $name"; continue
    fi
    case "$action" in
      install-brew) run brew install "$arg" ;;
      install-apt)  run sudo apt-get install -y "$arg" ;;
      install-dnf)  run sudo dnf install -y "$arg" ;;
      present-check) warn "dep '$name' must already be present on $platform (e.g. nvm/corepack) — not auto-installed; see runbook" ;;
      manual) warn "dep '$name' needs manual install ($platform) — see runbook" ;;
      skip) log "dep '$name' not required on $platform — skipping" ;;
      error-no-linux-mapping) die "dep '$name': $arg" ;;
      *) warn "dep '$name': unknown action '$action'" ;;
    esac
  done < <(platform_deps_select "$manifest_json" "$platform" "$pkgmgr")
}

phase_repos() {
  log "phase: repos"
  # FLY-1062: PREBUILT mode — REPO_ROOT is an installed npm payload (tree root
  # carries .flywheel-prebuilt): the flywheel runtime arrives prebuilt, so the
  # flywheel clone AND the pnpm install/build are skipped entirely. Customer
  # project repo entries below behave verbatim. A monorepo checkout has no
  # sentinel → this whole phase is byte-identical (reverse-compat sentinel:
  # provision-prebuilt.test.sh).
  local prebuilt=0
  [ -f "$REPO_ROOT/.flywheel-prebuilt" ] && prebuilt=1
  local name slug targetRel target
  while IFS=$'\t' read -r name slug targetRel; do
    if [ "$prebuilt" -eq 1 ] && [ "$name" = "flywheel" ]; then
      log "repo 'flywheel': prebuilt payload — skipping clone"; continue
    fi
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
  if [ "$prebuilt" -eq 1 ]; then
    log "prebuilt payload — skipping pnpm install/build"
    return 0
  fi
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
  # FLY-650: materialize host.json (core/host config) from the artifact. Like
  # projects.json: keep an existing one (operator may have added platform/path
  # overrides) unless --force. Absent in old captures → fine (defaults apply).
  # host.json lives at the BOOTSTRAP path (dirname $HOST_JSON = $HOME/.flywheel),
  # which may DIFFER from $FW when a custom stateDir is set — ensure it exists.
  if [ -f "$FLEET_DIR/host.json" ]; then
    run mkdir -p "$(dirname "$HOST_JSON")"
    if [ -f "$HOST_JSON" ] && [ "$FORCE" -ne 1 ]; then
      log "host.json exists — keeping (use --force to overwrite)"
    else
      run cp "$FLEET_DIR/host.json" "$HOST_JSON"
    fi
  fi
  # install runtime bin scripts from the checkout (FLY-954: sanity + atomic +
  # write-protected 555 — a degenerate source must fail the provision loudly,
  # never install silently; bare cp is banned for <state>/bin).
  local f
  for f in flywheel-lead-wrapper-v2.sh \
      flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh \
      flywheel-bridge-wrapper.sh restart-services.sh host-tmux-selection-gate.sh; do
    if [ -f "$REPO_ROOT/scripts/$f" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        plan "install (sanity+atomic+555) $REPO_ROOT/scripts/$f -> $FW/bin/$f"
      else
        log "exec: install_script_atomic $REPO_ROOT/scripts/$f $FW/bin/$f"
        install_script_atomic "$REPO_ROOT/scripts/$f" "$FW/bin/$f" \
          || die "bin script failed sanity/atomic install: $f"
      fi
    fi
  done
  # The installed wrapper sources support libs beside itself. Publish that
  # closure in both monorepo and prebuilt installs.
  run mkdir -p "$FW/bin/lib"
  for f in lib/host-config.sh lib/lead-address.sh; do
      [ -f "$REPO_ROOT/scripts/$f" ] || die "tree missing support lib: scripts/$f"
      if [ "$DRY_RUN" -eq 1 ]; then
        plan "install (sanity+atomic+555) $REPO_ROOT/scripts/$f -> $FW/bin/$f"
      else
        log "exec: install_script_atomic $REPO_ROOT/scripts/$f $FW/bin/$f"
        install_script_atomic "$REPO_ROOT/scripts/$f" "$FW/bin/$f" \
          || die "support lib failed sanity/atomic install: $f"
      fi
  done
  # FLY-1185 §2.7 (prevention leg): machine-level playwright default-off. A host
  # without a Claude settings file yet is narrated, not failed — the runbook's
  # first Claude login creates it and the operator re-runs this script then.
  if [ -f "$HOME_DIR/.claude/settings.json" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      plan "setup-mcp-on-demand.sh apply $HOME_DIR/.claude/settings.json (playwright default-off + opt-in headless)"
    else
      run bash "$REPO_ROOT/scripts/setup-mcp-on-demand.sh" apply "$HOME_DIR/.claude/settings.json" \
        || die "setup-mcp-on-demand failed (settings untouched — fix and re-run)"
    fi
  else
    log "no $HOME_DIR/.claude/settings.json yet — run scripts/setup-mcp-on-demand.sh apply after first Claude login"
  fi
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
  # Codex R2 MED-B: this phase only narrates/delegates — an empty/null canonicalRepo
  # must NOT make the phase (and thus the whole provision) fail. Keep return 0.
  if [ -n "$canon" ]; then log "skills canonical repo: $canon"; else log "skills canonicalRepo: (none captured) — wire skills-sync per runbook"; fi
  return 0
}

# FLY-650 (Codex R1 HIGH-1): the canonical Linux systemd unit specs the
# provisioner installs — bridge (service) + deterministic aux (updater path+timer,
# daily-standup timer) + per-lead services from the MATERIALIZED manifests. Both
# phase_supervisor (install) and phase_validate (check) iterate THIS list, so unit
# names are consistent by construction. cmux-watcher is darwinOnly (omitted on
# linux); skills-update needs the synced skills-sync.sh script (narrated, R2#1).
# Echoes one spec JSON per line.
_fleet_linux_specs() {
  local fw="$FLYWHEEL_DIR" st="$FLYWHEEL_STATE_DIR"
  jq -nc --arg fw "$fw" '{name:"flywheel-bridge",kind:"service",exec:("/bin/bash "+$fw+"/scripts/flywheel-bridge-wrapper.sh"),keepAlive:true,stdout:"/tmp/flywheel-bridge.log"}'
  jq -nc --arg fw "$fw" --arg st "$st" '{name:"flywheel-updater",kind:"path",exec:("/bin/bash "+$fw+"/scripts/update-flywheel.sh"),watch:[($st+"/self-ship-urgent.d")],schedule:[{hour:0,minute:0},{hour:12,minute:0}]}'
  jq -nc --arg fw "$fw" '{name:"flywheel-daily-standup",kind:"timer",exec:("/bin/bash "+$fw+"/scripts/daily-standup.sh"),schedule:[{hour:3,minute:0}]}'
  local m project_name lead_id backend
  for m in "$FW/manifests"/*.json; do
    [ -e "$m" ] || continue
    project_name=$(jq -er '.projectName' "$m") || return 1
    lead_id=$(jq -er '.leadId' "$m") || return 1
    backend=$(lead_restart_project_backend "$FW/projects.json" "$project_name" "$lead_id") || return 1
    if [ "$backend" != "claude-code" ]; then
      warn "lead ${project_name}/${lead_id}: skipping bespoke backend ${backend}; generic provision only installs Claude v2"
      continue
    fi
    jq -c --arg st "$st" --arg m "$m" \
      '{name:("flywheel-lead-"+.projectName+"-"+.leadId),kind:"service",exec:("/bin/bash "+$st+"/bin/flywheel-lead-wrapper-v2.sh "+$m),keepAlive:true}' "$m"
  done
}

phase_launchd() {
  log "phase: launchd"
  # token gate before any launchd activation.
  if [ "$SKIP_TOKEN_CHECK" -ne 1 ] && [ -f "$FW/.env" ] && [ -f "$FLEET_DIR/env.example" ]; then
    if ! validate_tokens "$FLEET_DIR/env.example" "$FW/.env" >/dev/null 2>&1; then
      die "token gate: refusing to start launchd jobs with empty/placeholder tokens"
    fi
  fi
  # FLY-1062: PREBUILT mode routes first-install bring-up through the packaged
  # bootstrap (supervisor seam on BOTH platforms) — restart-services.sh and
  # flywheel-daemon.sh are monorepo deploy machinery and are DISABLED on the
  # packaged path. Monorepo checkouts (no sentinel) fall through to the
  # verbatim FLY-650 flow below (reverse-compat sentinel).
  if [ -f "$REPO_ROOT/.flywheel-prebuilt" ]; then
    [ -f "$REPO_ROOT/scripts/packaged/bootstrap-services.sh" ] \
      || die "prebuilt tree missing scripts/packaged/bootstrap-services.sh"
    run bash "$REPO_ROOT/scripts/packaged/bootstrap-services.sh" --state-dir "$FW"
    return $?
  fi
  # FLY-650: platform-aware supervisor bring-up. The phase id stays "launchd"
  # (CLI/test surface compat) but routes through the supervisor backend resolved
  # by host-config. Lead bring-up is NARRATED (not fired) on BOTH platforms — the
  # manifest-first-run chicken-egg + irreversible side effects make it operator-
  # run per the runbook (Codex R1 MEDIUM/#2).
  local label kind
  if [ "${FLYWHEEL_SUPERVISOR_BACKEND:-launchd}" = "systemd-user" ]; then
    log "supervisor backend: systemd --user (linux)"
    if [ "$DRY_RUN" -eq 1 ]; then
      plan "loginctl enable-linger \"\$USER\" (boot-start + survive logout)"
      plan "materialize lead manifests: materialize-lead-manifests.sh --home $HOME_DIR"
      plan "supervisor install flywheel-bridge.service, flywheel-updater.{path,timer}, flywheel-daily-standup.timer"
      plan "supervisor install per-lead flywheel-lead-<project>-<leadId>.service (from materialized manifests)"
      step "cmux-watcher darwinOnly→skipped; skills-update needs ~/.flywheel/bin/skills-sync.sh (see runbook)"
    else
      # FLY-650 (Codex R1 HIGH-1): ACTUALLY install on linux. Unlike darwin (where
      # restart-services.sh is the operator's bring-up tool), linux has no such
      # delegate — the provisioner IS the bring-up tool, so D3=B can really run.
      # FLY-957②: $USER is unset in non-login shells (containers, systemd/CI
      # invocations) and this script runs under `set -u` — fall back to id -un.
      # Found by the FLY-648 container real-machine QA.
      run loginctl enable-linger "${USER:-$(id -un)}"
      log "materializing lead manifests"
      run bash "$REPO_ROOT/scripts/materialize-lead-manifests.sh" \
        --home "$HOME_DIR" --projects "$FW/projects.json" --manifests-dir "$FW/manifests"
      local spec uname_
      while IFS= read -r spec; do
        [ -z "$spec" ] && continue
        uname_="$(jq -r '.name' <<<"$spec")"
        log "supervisor install: $uname_"
        supervisor_install "$spec" || die "supervisor install failed: $uname_"
      done < <(_fleet_linux_specs)
      step "cmux-watcher darwinOnly→skipped; skills-update needs ~/.flywheel/bin/skills-sync.sh (see runbook)"
    fi
  else
    # darwin: delegated to restart-services.sh (it (re)loads bridge + cmux-watcher
    # + standup + skills-update + updater idempotently). Unchanged from FLY-519.
    step "deploy Bridge + auxiliary launchd jobs via restart-services.sh"
    while IFS=$'\t' read -r label kind; do
      [ "$kind" = "aux" ] || continue
      step "  aux job: $label"
    done < <(jq -r '.launchdJobs[] | [.label, .kind] | @tsv' "$MANIFEST")
    # Leads: delegated to the real host, NOT auto-run here (Codex R1 MEDIUM).
    # The correct clean-host sequence is materialize → install → verify; we
    # narrate it rather than mutate the operator's real launchd domain here.
    step "deploy lead launchd jobs from projects.json — per Lead:"
    step "  1) materialize-lead-manifests.sh --home $HOME_DIR"
    step "  2) flywheel-daemon.sh install <lead> — generate plist + bootstrap from the manifest"
    step "  NOTE: run + verify on the REAL host per the runbook (flywheel-daemon.sh status)"
  fi
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
  # units/plists loaded (dry-run: plan). FLY-650: platform-aware — launchd
  # (darwin, byte-identical to FLY-519) vs systemctl --user (linux).
  local uid label
  uid="$(id -u)"
  if [ "${FLYWHEEL_SUPERVISOR_BACKEND:-launchd}" = "systemd-user" ]; then
    # Codex R1 MED-2: check the SAME units the supervisor phase installed (from
    # _fleet_linux_specs) — consistent flywheel-* names, not launchd-label-derived.
    local spec unit
    while IFS= read -r spec; do
      [ -z "$spec" ] && continue
      case "$(jq -r '.kind' <<<"$spec")" in timer) unit="$(jq -r '.name' <<<"$spec").timer" ;; path) unit="$(jq -r '.name' <<<"$spec").path" ;; *) unit="$(jq -r '.name' <<<"$spec").service" ;; esac
      if [ "$DRY_RUN" -eq 1 ]; then
        plan "systemctl --user is-active $unit (expect active)"
      elif systemctl --user is-active "$unit" >/dev/null 2>&1; then
        log "validate: active $unit"
      else
        warn "validate: NOT active $unit"; ok=0
      fi
    done < <(_fleet_linux_specs)
  else
    while IFS=$'\t' read -r label _; do
      if [ "$DRY_RUN" -eq 1 ]; then
        plan "launchctl print gui/$uid/$label (expect loaded)"
      elif launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
        log "validate: loaded $label"
      else
        warn "validate: NOT loaded $label"; ok=0
      fi
    done < <(jq -r '.launchdJobs[] | [.label, .kind] | @tsv' "$MANIFEST")
  fi
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
  # FLY-650: resolve platform + supervisor backend FIRST (before any phase, so
  # --only/--from also see it). host.json from $FW or the artifact; platform
  # derives from THIS target's uname — a darwin capture never pins platform onto
  # a linux target. Malformed host.json fails closed.
  local host_json_src="$HOST_JSON"
  [ -f "$host_json_src" ] || host_json_src="$FLEET_DIR/host.json"
  if ! host_config_load "$host_json_src"; then
    die "host.json invalid — fix it then re-run (fail-closed)"
  fi
  # FLY-650 (Codex R2 MED-A): write ALL runtime state (.env/projects.json/manifests/
  # dirs) under the RESOLVED state root so provision-write matches what the wrappers
  # read at runtime. host.json itself stays at the BOOTSTRAP path ($HOME/.flywheel/
  # host.json) — the wrappers must find it BEFORE they know a custom stateDir.
  # Default stateDir == $HOME/.flywheel ⇒ FW unchanged (byte-compat).
  FW="${FLYWHEEL_STATE_DIR:-$HOME_DIR/.flywheel}"
  log "platform: ${FLYWHEEL_PLATFORM} | supervisor: ${FLYWHEEL_SUPERVISOR_BACKEND} | viewer: ${FLYWHEEL_VIEWER_BACKEND} | state: ${FW} | host.json: ${HOST_JSON}"
  # FLY-650 (Codex R4 HIGH): host-safety guard runs HERE — before any phase — so
  # destructive --only/--from entrypoints can't bypass it (it was preflight-only).
  _host_safety_guard
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
