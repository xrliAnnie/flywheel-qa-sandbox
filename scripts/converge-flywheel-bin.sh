#!/bin/bash
# FLY-954: converge <state>/bin runtime scripts to their repo sources.
#
# "Installed copy == repo source" is a machine-verified invariant now
# (incident 2026-07-06: 12-byte stubs sat in ~/.flywheel/bin for 8 hours;
# the nightly deploy kickstart then took all 13 Leads down). Single source
# of truth for that convergence; mounted at three points:
#   • claude-lead.sh          — every Lead start           (non-fatal)
#   • update-flywheel.sh      — daily sweep + self-ship    (non-fatal; the ONLY
#                               self-heal path that does not depend on a
#                               possibly-broken lead wrapper: its plist execs
#                               the repo script directly)
#   • restart-services.sh::do_restart_all_leads — pre-kickstart (FAIL-LOUD:
#                               kickstarting a corrupt wrapper = fleet down)
#
# Invariant per file = content checksum matches repo source AND mode is 555
# (Codex R1#1: a manually-restored 644 copy must not stay writable until the
# next provision). Per file:
#   content+mode match → silent no-op
#   content match, mode != 555 → chmod 555 (log only, no alert — not a
#                                content breach; keeps first fleet-wide
#                                rollout quiet)
#   content drift/missing → repo source sane → atomic repair (tmp+mv+555)
#                           + ONE alert; repo source INSANE → alert only,
#                           NEVER repair (fail-safe: a mid-pull/corrupted
#                           repo must not be converged in).
# Exit: 0 = all healthy/repaired; 1 = at least one file left unhealthy.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo source of truth is SELF-DERIVED from this script's own location — the
# converger is a WRITER (it repairs bin from $REPO_ROOT/scripts/*), so it must
# not let inherited env redefine its source root (Codex R2#1; same principle
# as the provisioner's env-unset). The hermetic test copies this script into
# its fake repo and invokes THAT copy, so SCRIPT_DIR/.. resolves naturally.
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
BIN_DIR="$STATE_DIR/bin"
# Notification-only test seam: redirects WHERE alerts go, never repair
# provenance (repair sources stay pinned to $REPO_ROOT above).
ALERT_BIN="${FLYWHEEL_CONVERGE_ALERT_BIN:-$SCRIPT_DIR/lead-alert.sh}"
ALERT_LEAD="${FLYWHEEL_CONVERGE_ALERT_LEAD:-flywheel-eng-lead}"
ALERT_PROJECT="${FLYWHEEL_CONVERGE_ALERT_PROJECT:-flywheel}"

# shellcheck source=lib/script-sanity.sh
source "$SCRIPT_DIR/lib/script-sanity.sh"
# FLY-1389: shared temp/worktree + global-bin predicates (write-time guard,
# symlink health, hygiene mount below).
# shellcheck source=lib/path-hygiene.sh
source "$SCRIPT_DIR/lib/path-hygiene.sh"

# FLY-954 (lead-instruction 4d224848): a NON-default state root means this run
# is a sandbox / QA-slot exercise, not this host's production bin — and a
# founder glancing at Discord cannot be expected to recognize /var/folders
# paths in the body (the smoke-test alerts read as a real incident). Prefix
# drill alert titles loudly so an exercise is never mistaken for production.
# A future fleet host running a custom host.json stateDir as PRODUCTION can
# suppress via FLYWHEEL_CONVERGE_PROD_STATE=1 (fail-safe default: mislabeling
# a drill beats scaring the founder).
ALERT_TITLE_PREFIX=""
if [ "$STATE_DIR" != "$HOME/.flywheel" ] && [ "${FLYWHEEL_CONVERGE_PROD_STATE:-0}" != "1" ]; then
  ALERT_TITLE_PREFIX="🧪[sandbox test] "
fi

FILES="flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh"
# FLY-1062: a PACKAGED tree (root carries .flywheel-prebuilt) never ships
# restart-services.sh — it is monorepo deploy machinery. There its absence is
# the EXPECTED shape, not an integrity incident; without this branch every
# Lead start on a packaged install would fire a repo-source-missing alert.
# Monorepo checkouts carry no sentinel, so the fail-loud list above stays
# verbatim (reverse-compat sentinel: packaged-seams.test.sh S7/S8).
if [ -f "$REPO_ROOT/.flywheel-prebuilt" ]; then
  FILES="flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh"
fi

log() { echo "[converge-bin] $*"; }
sha() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null; }
alert() {  # <title> <body> <signature> — best-effort (claims.db dedup inside)
  bash "$ALERT_BIN" \
    --lead "$ALERT_LEAD" --project "$ALERT_PROJECT" \
    --kind bin_integrity_drift --severity severe \
    --title "${ALERT_TITLE_PREFIX}$1" --body "$2" --signature "$3" || true
}

# ── FLY-1389 P1-b: write-time guard — refuse to converge the GLOBAL bin from
# a temp/worktree checkout. The converger is a WRITER (copies its own repo's
# sources into bin): run from a worktree it would install worktree content
# into the effective global bin. ZERO writes on refusal (this sits before any
# mkdir/chmod/install), ONE alert, rc=1 (the pre-kickstart mount treats
# non-zero as "do not kickstart"). All human text on stderr (restart-services
# consumes only the exit code; its own stdout contract stays untouched).
# Sandbox/QA STATE_DIRs are non-global → not guarded (hermetic suites keep
# working). Deliberate override: FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT=1.
if [ "${FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT:-0}" != "1" ] \
   && is_global_bin_dir "$BIN_DIR" \
   && is_temp_or_worktree_root "$REPO_ROOT"; then
  echo "[converge-bin] ERROR: refusing to converge global $BIN_DIR from temp/worktree checkout $REPO_ROOT — global bin must converge from the main checkout only (FLY-1389; FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT=1 overrides deliberately)" >&2
  alert "converge refused: temp/worktree checkout targeting global bin" \
    "converge-flywheel-bin.sh ran from ${REPO_ROOT} (temp/worktree shape) against the global ${BIN_DIR} and refused all writes. Run it from the main checkout (FLY-1389)." \
    "converge|temproot"
  exit 1
fi

rc=0
for f in $FILES; do
  src="$REPO_ROOT/scripts/$f"; dst="$BIN_DIR/$f"
  # Codex code R1 HIGH: a MISSING required source is as disqualifying as an
  # insane one — exit 0 here would let the pre-kickstart mount treat an
  # unverifiable (mid-pull / broken) checkout as healthy and kickstart anyway.
  if [ ! -f "$src" ]; then
    log "ERROR: repo source missing: $src — cannot verify/repair $f (fail-safe)"
    alert "bin integrity: repo source missing for $f" \
      "$src does not exist in this checkout (mid-pull/corrupt?) — $dst cannot be verified or repaired. Investigate the repo checkout (FLY-954)." \
      "$f|srcmissing"
    rc=1; continue
  fi
  src_sha="$(sha "$src")"; dst_sha="$(sha "$dst")"
  if [ -n "$dst_sha" ] && [ "$src_sha" = "$dst_sha" ]; then
    # content converged — enforce the MODE half of the invariant (Codex R1#1)
    mode="$(mode_of "$dst")"
    if [ "$mode" != "555" ]; then
      if chmod 555 "$dst"; then
        log "mode tightened: $f (${mode:-?} -> 555)"
      else
        log "ERROR: chmod 555 failed: $dst"; rc=1
      fi
    fi
    continue
  fi
  # ([ -f ] first: a bare `wc -c < missing` prints the shell's redirect error
  # before 2>/dev/null can apply — noisy on the fail-loud mount's stderr)
  size=0
  [ -f "$dst" ] && size="$(wc -c < "$dst" | tr -d ' ')"
  if ! assert_sane_script_source "$src"; then
    log "ERROR: $f drifted (bin ${size}B) but repo source failed sanity — NOT repairing (fail-safe)"
    alert "bin integrity: $f drifted, repo source insane" \
      "$dst (${size}B, sha ${dst_sha:-missing}) != repo source, and the repo source itself failed sanity (mid-pull/corrupt?). NOT auto-repaired — investigate the repo checkout." \
      "$f|insane|${src_sha:0:12}"
    rc=1; continue
  fi
  if install_script_atomic "$src" "$dst"; then
    log "repaired: $f (bin was ${size}B sha ${dst_sha:-missing}; now repo ${src_sha:0:12})"
    alert "bin integrity drift repaired: $f" \
      "$dst had drifted from the repo source (found ${size}B, sha ${dst_sha:-missing}). Auto-repaired to repo ${src_sha:0:12} (mode 555). Drift itself is abnormal — find the writer (FLY-954)." \
      "$f|repaired|${src_sha:0:12}"
  else
    log "ERROR: repair FAILED for $f"
    alert "bin integrity: repair FAILED for $f" \
      "$dst drifted (found ${size}B) and the atomic repair failed — manual intervention required (FLY-954 runbook: cp from repo + chmod 555)." \
      "$f|failfix|${src_sha:0:12}"
    rc=1
  fi
done

# ── FLY-1389 P1-c: CLI symlink health (broken / temp-worktree targets) ──────
# The 2026-07-20 incident shape: ~/.flywheel/bin/agent-team-transport pointed
# into a cleaned worktree → broken link → new Lead FATAL at transport
# preflight, silently. This section repairs it LOUDLY at the same mounts.
# Precondition (HARD, no escape — Codex code R1 HIGH-1): repair only when
# THIS checkout is a trusted root. A temp/worktree root has no trusted source
# to repair FROM; FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT deliberately opens ONLY
# the content-converge write guard above, never symlink repair — otherwise
# the override would re-point global links INTO a worktree, recreating the
# incident. Hermetic suites stage trusted-shape (.git-directory) fixture
# repos instead. Absent links are not installed here (sync-bin / installers
# own creation); unknown extra symlinks are the hygiene scan's job.
symlink_source_for() {
  case "$1" in
    agent-team-transport) echo "$REPO_ROOT/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js" ;;
    tmux-server-rescue) echo "$REPO_ROOT/scripts/lib/tmux-server-rescue.sh" ;;
    flywheel-cmux-sync) echo "$REPO_ROOT/scripts/flywheel-cmux-sync.sh" ;;
    flywheel-cmux-autostart) echo "$REPO_ROOT/scripts/flywheel-cmux-autostart.sh" ;;
    *) echo "" ;;
  esac
}

if ! is_temp_or_worktree_root "$REPO_ROOT"; then
  for name in agent-team-transport tmux-server-rescue flywheel-cmux-sync flywheel-cmux-autostart; do
    link="$BIN_DIR/$name"
    [ -L "$link" ] || continue
    target="$(readlink "$link")"
    case "$target" in
      /*) : ;;
      *) target="$(dirname "$link")/$target" ;;
    esac
    unhealthy=""
    if ! canon_target="$(path_hygiene_canonicalize "$target")" || [ ! -e "$canon_target" ]; then
      unhealthy="broken (target missing: ${target})"
    elif path_hygiene_target_is_temp_or_worktree "$canon_target"; then
      unhealthy="temp/worktree target (${canon_target})"
    fi
    [ -n "$unhealthy" ] || continue
    src="$(symlink_source_for "$name")"
    # Codex code R1 HIGH-2 + R2 HIGH: a symlink TARGET is invoked directly,
    # so beyond the FLY-954 content sanity it must be executable-shaped:
    #   • first line must be a shebang (every legitimate source here ships
    #     one: the node CLI dist and the three bash scripts — a shebang-less
    #     file would die with Exec format error at invocation);
    #   • missing owner-exec bit is AUTO-REPAIRED with chmod 0755, mirroring
    #     syncFlywheelCliBin (FLY-142 R5: tsc emits dist at 0644 — refusing
    #     would make every fresh-build repair fail).
    src_ok=0
    if [ -n "$src" ] && assert_sane_script_source "$src" 2>/dev/null \
       && head -c 2 "$src" 2>/dev/null | grep -q '^#!'; then
      if [ ! -x "$src" ]; then
        if chmod 0755 "$src" 2>/dev/null; then
          echo "[converge-bin] chmod 0755 on repair source $src (exec bit was missing; tsc default 0644)" >&2
          src_ok=1
        fi
      else
        src_ok=1
      fi
    fi
    if [ "$src_ok" = "1" ]; then
      tmp="${link}.tmp.$$"
      if ln -s "$src" "$tmp" 2>/dev/null && mv -f "$tmp" "$link"; then
        echo "[converge-bin] symlink repaired: $name was ${unhealthy} -> now $src" >&2
        alert "bin symlink repaired: $name" \
          "$link was ${unhealthy}; atomically re-pointed to this checkout's $src. A global bin link pointing at a temp/worktree path means a writer bypassed the FLY-1389 guard — find it." \
          "$name|symlink-repaired"
      else
        rm -f "$tmp" 2>/dev/null || true
        echo "[converge-bin] ERROR: symlink repair FAILED for $name (${unhealthy})" >&2
        alert "bin symlink repair FAILED: $name" \
          "$link is ${unhealthy} and the atomic re-point failed — manual repair required (ln -sfn <main-checkout-source> $link)." \
          "$name|symlink-failfix"
        rc=1
      fi
    else
      echo "[converge-bin] WARNING: $name is ${unhealthy} but this checkout has no SANE executable source at ${src:-<none>} — NOT repairing (build the dist first)" >&2
      alert "bin symlink unhealthy: $name (no sane local source)" \
        "$link is ${unhealthy}; this checkout has no sane executable ${src:-<none>} to repair from (missing, failed FLY-954 source sanity, no shebang, or un-chmod-able). Build the dist (pnpm -r build) and re-run converge, or repair manually." \
        "$name|symlink-nosource"
    fi
  done
else
  echo "[converge-bin] symlink health: skipped — REPO_ROOT ${REPO_ROOT} is a temp/worktree shape (no trusted repair source here; the ALLOW_TEMP_ROOT override never enables repair)" >&2
fi

# ── FLY-1389 P1-d mount: global path-hygiene scan (read-only; rc OR) ────────
# Violations here are the machine form of the acceptance rule "no temporary
# paths in global config". Alerts only fire for the production state root
# (sandbox converge runs print-only — their HOME globals are not their
# business to page about). Output on stderr.
HYGIENE_CHECK="$SCRIPT_DIR/check-global-path-hygiene.sh"
if [ -f "$HYGIENE_CHECK" ]; then
  hygiene_args=""
  if [ "$STATE_DIR" = "$HOME/.flywheel" ]; then hygiene_args="--alert"; fi
  # shellcheck disable=SC2086
  if ! bash "$HYGIENE_CHECK" $hygiene_args >&2; then
    echo "[converge-bin] ERROR: global path-hygiene scan found violations (see above, FLY-1389)" >&2
    rc=1
  fi
fi

exit "$rc"
