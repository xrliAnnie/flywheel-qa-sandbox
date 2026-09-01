#!/bin/bash
# FLY-954: converge <state>/bin runtime scripts to their repo sources.
#
# "Installed copy == repo source" is a machine-verified invariant now
# (incident 2026-07-06: 12-byte stubs sat in ~/.flywheel/bin for 8 hours;
# the nightly deploy kickstart then took all 13 Leads down). Single source
# of truth for that convergence; mounted at three points:
#   • claude-lead.sh          — every Lead start           (non-fatal)
#   • update-flywheel.sh      — scheduled + founder urgent (non-fatal; the ONLY
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

# FLY-1577: the cmux watcher's launch-path hard dependencies belong here too.
# Incident 2026-07-31: restart-storm-gate.py was absent from bin, the watcher's
# fail-closed preflight refused to launch for hours, and this converger reported
# CLEAN throughout — it simply did not manage the file. The founder lost her only
# view of what Runners were doing.
#   • restart-storm-gate.py — the brake itself. Read from <state>/bin (not the
#     repo) because the launchd plist runs flywheel-cmux-autostart through its
#     bin symlink, so its $SELF_DIR is <state>/bin.
#   • lib/bounded-run.sh    — the transport that carries the "brake is missing"
#     meta-alert out of that same launch path. Missing it does not just degrade
#     the alert, it silences it completely: command-not-found, stdout+stderr
#     redirected to /dev/null, status swallowed by `|| true`. A report chain
#     missing one link is a broken report chain.
# No installer writes either file into bin, and both are plain files — so the
# copy lane, not the symlink lane (see symlink_strict_name below for the shapes
# that must NOT be copied).
FILES="flywheel-lead-wrapper-v2.sh flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh flywheel-codex-lead-wrapper-codex-infra-bot.sh flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh resident-codex-lead-recover.sh flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh flywheel-bridge-wrapper.sh restart-services.sh restart-storm-gate.py host-tmux-selection-gate.sh lib/bounded-run.sh lib/lead-address.sh"
# FLY-1062: a PACKAGED tree (root carries .flywheel-prebuilt) never ships
# restart-services.sh — it is monorepo deploy machinery. There its absence is
# the EXPECTED shape, not an integrity incident; without this branch every
# Lead start on a packaged install would fire a repo-source-missing alert.
# Monorepo checkouts carry no sentinel, so the fail-loud list above stays
# verbatim (reverse-compat sentinel: packaged-seams.test.sh S7/S8).
# (FLY-1577: the gate and bounded-run.sh DO ship in a packaged tree — both are
# in package-onboard.sh's PO_SCRIPT_FILES whitelist and packaged-seams.test.sh
# S0 asserts the closure is executable there — so they stay in both branches.)
if [ -f "$REPO_ROOT/.flywheel-prebuilt" ]; then
  FILES="flywheel-lead-wrapper-v2.sh flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh flywheel-codex-lead-wrapper-codex-infra-bot.sh flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh resident-codex-lead-recover.sh flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh flywheel-bridge-wrapper.sh restart-storm-gate.py host-tmux-selection-gate.sh lib/bounded-run.sh lib/lead-address.sh"
fi

log() { echo "[converge-bin] $*"; }
sha() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
# GNU (-c) must be tried FIRST (FLY-1577). GNU stat's -f means "file system
# status", not "format" as it does on BSD/macOS — so `stat -f '%Lp'` on Linux
# does not fail cleanly, it succeeds in filesystem mode and the `||` fallback
# never fires. With the old BSD-first order an already-555 file was re-chmod'd
# and re-logged on every Linux run (every Lead start, every kickstart). BSD stat
# has no -c at all and fails cleanly, so this order is correct on both.
# Same contract as scripts/lib/discord-bot-pool-lib.sh::_pool_file_mode and
# scripts/flywheel-setup.sh::_fs_perm.
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
# lstat identity (never dereferences on either platform) — used to prove that
# the object we archived is still the object we meant to archive. device:inode,
# not a bare inode: the same inode number on two filesystems is two different
# objects, so bare-number comparisons both miss real aliases and manufacture
# false ones.
fsid_of() { stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1" 2>/dev/null; }
# A measurement that did not happen must never read as a match or a mismatch.
# Strictly digits:digits — a lone colon, a trailing separator or a stray extra
# field is a malformed reading, not an identity.
id_ok() {
  case "$1" in ''|*[!0-9:]*) return 1 ;; esac
  case "$1" in *:*:*) return 1 ;; esac
  case "$1" in [0-9]*:[0-9]*) return 0 ;; *) return 1 ;; esac
}
# Removing a dangerous artifact is a safety transition, so it is verified rather
# than assumed: `rm -f` can fail (immutable flag, directory ACL, storage error)
# and `|| true` would turn that into a silent clean report.
# Success requires BOTH: rm reported success AND the path is really gone. Taking
# only the lstat would be another fail-open — the same directory ACL or storage
# error that blocks the unlink can block the lstat, making both predicates false
# and "unprovable" read as "removed". If rm says it failed, this says it failed,
# whatever a subsequent stat can or cannot see.
strict_discard() {  # <path> → 0 proven gone, 1 not proven gone
  [ -n "$1" ] || return 0
  rm -f "$1" 2>/dev/null || return 1
  { [ -e "$1" ] || [ -L "$1" ]; } && return 1
  return 0
}
strict_residue_alert() {  # <name> <path> <what>
  echo "[converge-bin] ERROR: could not prove removal of $2 for $1" >&2
  strict_alert "$1" "bin alert-chain cleanup unproven: $1" \
    "$2 is $3 and its removal could not be proven, so it may still be in the bin directory. Nothing was published; inspect that path manually and re-run converge (FLY-1577)." \
    "$1|strict-discard-failed"
}
alert() {  # <title> <body> <signature> — best-effort (claims.db dedup inside)
  bash "$ALERT_BIN" \
    --lead "$ALERT_LEAD" --project "$ALERT_PROJECT" \
    --kind bin_integrity_drift --severity severe \
    --title "${ALERT_TITLE_PREFIX}$1" --body "$2" --signature "$3" || true
}

# FLY-2190/2216: these carrier artifacts either predated converger ownership or
# enter it as part of an intentional rollout. Their first successful convergence
# is an expected adoption, not evidence that an established managed file drifted.
# Record that transition durably and silently exactly once; every later drift
# takes the ordinary severe-alert path below.
ADOPTION_DIR="$STATE_DIR/state/converge-adoptions"
is_first_adoption_name() {
  case "$1" in
    flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh|flywheel-codex-lead-wrapper-codex-infra-bot.sh|flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh|resident-codex-lead-recover.sh) return 0 ;;
    *) return 1 ;;
  esac
}
adoption_is_complete() { # <name>
  local marker="$ADOPTION_DIR/$1"
  [ -f "$marker" ] && [ ! -L "$marker" ] && [ -s "$marker" ] \
    && grep -Fqx "managed=$1" "$marker"
}
record_adoption() { # <name> <source-sha>
  local name="$1" source_sha="$2" marker="$ADOPTION_DIR/$1" tmp="${ADOPTION_DIR}/.$1.tmp.$$"
  if [ -L "$ADOPTION_DIR" ] || { [ -e "$ADOPTION_DIR" ] && [ ! -d "$ADOPTION_DIR" ]; }; then
    return 1
  fi
  if ( umask 077
    mkdir -p "$ADOPTION_DIR" \
      && chmod 700 "$ADOPTION_DIR" \
      && printf 'managed=%s\nsourceSha=%s\n' "$name" "$source_sha" > "$tmp" \
      && chmod 600 "$tmp" \
      && mv -f "$tmp" "$marker"
  ); then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true
  return 1
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
    if is_first_adoption_name "$f" && ! adoption_is_complete "$f"; then
      if record_adoption "$f" "$src_sha"; then
        log "adoption baseline recorded: $f was already converged"
      else
        log "ERROR: could not persist adoption baseline for $f"
        alert "bin integrity: adoption baseline FAILED for $f" \
          "$dst already matches the repo source, but the one-shot adoption marker could not be written under $ADOPTION_DIR. Runtime bytes are healthy and remain eligible; repair state-directory permissions so later drift can use normal alert wording (FLY-2190)." \
          "$f|adoption-marker-failed"
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
    if is_first_adoption_name "$f" && ! adoption_is_complete "$f"; then
      if record_adoption "$f" "$src_sha"; then
        log "first managed adoption recorded: $f (expected rollout; alert suppressed once)"
      else
        log "ERROR: repaired $f but could not persist its adoption baseline"
        alert "bin integrity: adoption baseline FAILED for $f" \
          "$dst was installed from the sane repo source, but the one-shot adoption marker could not be written under $ADOPTION_DIR. Runtime bytes are healthy and remain eligible; repair state-directory permissions so later drift can use normal alert wording (FLY-2190)." \
          "$f|adoption-marker-failed|${src_sha:0:12}"
      fi
    else
      alert "bin integrity drift repaired: $f" \
        "$dst had drifted from the repo source (found ${size}B, sha ${dst_sha:-missing}). Auto-repaired to repo ${src_sha:0:12} (mode 555). Drift itself is abnormal — find the writer (FLY-954)." \
        "$f|repaired|${src_sha:0:12}"
    fi
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
    meta-alert.sh) echo "$REPO_ROOT/scripts/meta-alert.sh" ;;
    flywheel-patrol-snapshot) echo "$REPO_ROOT/scripts/lead-patrol-snapshot.sh" ;;
    flywheel-node-dwell-control) echo "$REPO_ROOT/scripts/flywheel-node-dwell-control.mjs" ;;
    *) echo "" ;;
  esac
}

# FLY-1577: names under the STRICT regime. flywheel-cmux-install.sh installs
# meta-alert.sh as a SYMLINK, so it cannot join the copy lane above — a symlink
# there would report the link's own mode (lstat) and never converge, while
# `chmod 555` would follow the link and rewrite the repo source itself.
# But "best-effort link repair" is not enough either: the cmux watcher's
# fail-closed branch reaches this file to report that the brake is gone, and the
# only way anyone learns the watcher never started is if that report lands. So
# for these names the healthy terminal state is exact — a symlink to the
# canonical source whose source passes sanity + shebang + exec — and anything
# unrepairable exits non-zero rather than being reported healthy (converge's rc
# is the pre-kickstart gate; kickstarting with a dead alert chain is how an
# outage stays invisible).
# Whitelisted deliberately: the four legacy names keep their previous semantics
# verbatim (absence is the installer's business, and their rc contract is
# unchanged) — widening the regime to them is a far larger blast radius than
# this incident justifies.
symlink_strict_name() { case "$1" in meta-alert.sh|flywheel-patrol-snapshot|flywheel-node-dwell-control) return 0 ;; *) return 1 ;; esac; }

# Keep every existing meta-alert.sh title/body byte-for-byte. The patrol
# snapshot shares the strict mechanics but is a generic managed executable,
# not part of the cmux alert chain (FLY-1855).
strict_alert() { # <name> <title> <body> <signature>
  local strict_name="$1" title="$2" body="$3" signature="$4" generic_title generic_body
  if [ "$strict_name" = "meta-alert.sh" ]; then
    alert "$title" "$body" "$signature"
  else
    generic_title="${title//alert-chain/managed executable}"
    # Preserve the caller's path, source, state transition, and remediation
    # detail. Only translate the legacy cmux-specific class labels; reading
    # caller locals such as link/src here previously discarded that evidence.
    generic_body="${body//alert-chain/managed executable}"
    generic_body="${generic_body//cmux watcher's fail-closed launch path/managed executable path}"
    generic_body="${generic_body//the 'restart brake unavailable' report/its failure report}"
    generic_body="${generic_body//cmux watcher's failure-reporting chain/managed executable delivery path}"
    generic_body="${generic_body//cmux watcher/managed executable}"
    alert "$generic_title" "$generic_body" "$signature"
  fi
}

# strict_publish_link <name> <src> <link> <what> — atomic create/replace.
# On failure the canonical path is left exactly as it was and the process's own
# tmp is removed. The tmp name is process-specific and is NEVER globbed away:
# two Leads starting at once both run this, and deleting `*.tmp.*` would destroy
# the other converger's in-flight publish.
strict_publish_link() {
  local name="$1" src="$2" link="$3" what="$4" tmp="${3}.tmp.$$" sha_src
  if ln -s "$src" "$tmp" 2>/dev/null && mv -f "$tmp" "$link"; then
    sha_src="$(sha "$src")"
    echo "[converge-bin] strict link ${what}: $name -> $src" >&2
    strict_alert "$name" "bin alert-chain link ${what}: $name" \
      "$link ${what} to this checkout's $src (sha ${sha_src:0:12}). $name is on the cmux watcher's fail-closed launch path — without it the 'restart brake unavailable' report is silently dropped (FLY-1577)." \
      "$name|strict-${what}"
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true
  echo "[converge-bin] ERROR: strict link publish FAILED for $name" >&2
  strict_alert "$name" "bin alert-chain publish FAILED: $name" \
    "Could not publish $link -> $src. The path was left unchanged; the cmux watcher's failure-reporting chain stays broken until this is repaired (FLY-1577)." \
    "$name|strict-publish-failed"
  return 1
}

symlink_source_ready() { # <name> <source> — sane, shebang-bearing, executable
  local name="$1" src="$2"
  [ -n "$src" ] || return 1
  assert_sane_script_source "$src" 2>/dev/null || return 1
  head -c 2 "$src" 2>/dev/null | grep -q '^#!' || return 1
  if [ ! -x "$src" ]; then
    # FLY-2210's wrapper is committed mode 100755. Converge must not mutate a
    # trusted checkout to disguise an index-mode regression.
    [ "$name" != "flywheel-node-dwell-control" ] || return 1
    if chmod 0755 "$src" 2>/dev/null; then
      echo "[converge-bin] chmod 0755 on repair source $src (exec bit was missing; tsc default 0644)" >&2
    else
      return 1
    fi
  fi
  return 0
}

if ! is_temp_or_worktree_root "$REPO_ROOT"; then
  for name in agent-team-transport tmux-server-rescue flywheel-cmux-sync flywheel-cmux-autostart meta-alert.sh flywheel-patrol-snapshot flywheel-node-dwell-control; do
    link="$BIN_DIR/$name"
    src="$(symlink_source_for "$name")"

    # FLY-1446 P1-c': the cmux installer contract is a link to the trusted
    # main checkout. A regular-file copy is not "healthy because its bytes
    # happen to match today"; it is the deployment-copy disease that let the
    # production watcher stay stale for seven days. Archive deployed bytes
    # first, then atomically restore the link shape. Other CLI names retain
    # the pre-FLY-1446 absent/copy behavior.
    case "$name" in
      flywheel-cmux-sync|flywheel-cmux-autostart)
        if [ -e "$link" ] && [ ! -L "$link" ]; then
          if [ ! -f "$link" ]; then
            echo "[converge-bin] ERROR: $name has unsupported non-file deployment shape at $link — NOT replacing" >&2
            alert "bin shape unhealthy: $name is not a regular file or symlink" \
              "$link exists but is neither the required symlink nor an archivable regular file. NOT auto-repaired; inspect the path manually (FLY-1446)." \
              "$name|copy-shape-unsupported"
            rc=1
            continue
          fi
          if ! symlink_source_ready "$name" "$src"; then
            echo "[converge-bin] WARNING: $name is a regular-file copy but this checkout has no SANE executable source at ${src:-<none>} — NOT replacing" >&2
            alert "bin copy shape unhealthy: $name (no sane executable source)" \
              "$link is a regular-file deployment copy, but this checkout has no sane executable ${src:-<none>} to link (missing, failed source sanity, no shebang, or un-chmod-able). The deployed copy was preserved; repair the checkout first." \
              "$name|copy-shape-nosource"
            rc=1
            continue
          fi

          archive="${link}.bak-shape-$(date +%s)-$$"
          archive_ok=0
          if ln "$link" "$archive" 2>/dev/null; then
            archive_ok=1
          else
            # Reserve a process-unique path before copying so fallback never
            # clobbers an older forensic archive.
            archive="$(mktemp "${archive}.XXXXXX" 2>/dev/null || true)"
            if [ -n "$archive" ] && cp -p "$link" "$archive" 2>/dev/null; then
              archive_ok=1
            elif [ -n "$archive" ]; then
              rm -f "$archive" 2>/dev/null || true
            fi
          fi
          if [ "$archive_ok" != "1" ]; then
            echo "[converge-bin] ERROR: shape archive FAILED for $name — canonical copy preserved" >&2
            alert "bin shape archive FAILED: $name" \
              "Could not preserve $link before replacing its regular-file deployment shape. Canonical path was left untouched; fix bin-directory permissions/storage and re-run converge (FLY-1446)." \
              "$name|copy-shape-archive-failed"
            rc=1
            continue
          fi

          # A concurrent converger may have replaced the canonical path after
          # our initial lstat. If the archived object is a symlink, it is not
          # historical copy evidence: discard it and let the healthy-link
          # path below verify the winner.
          if [ -L "$archive" ]; then
            rm -f "$archive" 2>/dev/null || true
          else
            tmp="${link}.tmp.$$"
            if ln -s "$src" "$tmp" 2>/dev/null && mv -f "$tmp" "$link"; then
              src_sha="$(sha "$src")"
              echo "[converge-bin] copy shape converged: $name archived at $archive -> now symlink $src" >&2
              alert "bin deployment copy converged to symlink: $name" \
                "$link was a regular-file deployment copy. Preserved the old bytes at $archive, then atomically restored the installer contract -> $src (sha ${src_sha:0:12}). Find the writer that broke the link shape (FLY-1446)." \
                "$name|copy-shape-converged|${src_sha:0:12}"
              continue
            fi
            rm -f "$tmp" 2>/dev/null || true
            echo "[converge-bin] ERROR: copy-shape symlink publish FAILED for $name (archive retained at $archive)" >&2
            alert "bin copy-shape repair FAILED: $name" \
              "$link was archived at $archive, but atomic symlink publication to $src failed. The canonical copy remains available; manual intervention required." \
              "$name|copy-shape-failfix"
            rc=1
            continue
          fi
        fi
        ;;
    esac

    # ── FLY-1577 Block A: strict names, NON-symlink shapes ──────────────────
    # Strict-name alert closure also covers non-symlink deployment shapes.
    # Without this block, `[ -L "$link" ] || continue` below skips a regular
    # file or a directory sitting at this path and converge reports healthy —
    # e.g. a mode-000 regular meta-alert.sh, which leaves the notifier just as
    # silent as an absent one.
    if symlink_strict_name "$name" && [ ! -L "$link" ]; then
      if [ ! -e "$link" ]; then
        if symlink_source_ready "$name" "$src"; then
          strict_publish_link "$name" "$src" "$link" created || rc=1
        else
          echo "[converge-bin] ERROR: $name is absent and this checkout has no sane executable source at ${src:-<none>}" >&2
          strict_alert "$name" "bin alert-chain unhealthy: $name absent, no sane source" \
            "$link is missing and this checkout has no sane executable ${src:-<none>} to link (missing, failed FLY-954 source sanity, no shebang, or un-chmod-able). The cmux watcher cannot report a failed launch until this is repaired (FLY-1577)." \
            "$name|strict-nosource"
          rc=1
        fi
      elif [ -f "$link" ]; then
        # A regular-file deployment copy. Preserve the deployed bytes for
        # forensics BEFORE replacing the shape (FLY-1446's contract) — but this
        # is a separate path from the cmux block above, so it carries its own
        # failure handling and its own test (M13); the existing C2 case does not
        # reach here.
        if ! symlink_source_ready "$name" "$src"; then
          echo "[converge-bin] WARNING: $name is a regular-file copy but this checkout has no sane executable source at ${src:-<none>}" >&2
          strict_alert "$name" "bin alert-chain copy unhealthy: $name (no sane source)" \
            "$link is a regular-file deployment copy and this checkout has no sane executable ${src:-<none>} to link. The deployed copy was preserved; repair the checkout first (FLY-1577)." \
            "$name|strict-copy-nosource"
          rc=1
        else
          archive="${link}.bak-shape-$(date +%s)-$$"
          archive_ok=0
          # Preserving the displaced bytes is the whole point of this branch, and
          # every step of it is racing another Lead's converge.
          #
          # 1. -P on BOTH legs, and it is required rather than stylistic.
          #    `[ -f "$link" ]` above follows symlinks, so a rival that published
          #    the canonical link between that test and here leaves us archiving
          #    a SYMLINK. BSD `ln`/`cp` dereference by default (GNU does not, so
          #    Linux CI cannot see this), and the "archive" then becomes a hard
          #    link to the repo's own meta-alert.sh: it lies about which bytes
          #    were displaced, and a later chmod or write on it would reach the
          #    trusted repo source through the shared inode. With -P the archive
          #    is the symlink object, which the `[ -L "$archive" ]` test catches.
          #    No amount of checking beforehand substitutes for this: the rival
          #    can publish between ANY check and the syscall that follows it, so
          #    the syscall itself has to refuse to follow.
          #
          # 2. -P is still not a proof. `cp -P` is a command, not one atomic
          #    syscall: it can lstat a regular file and only afterwards open the
          #    pathname, and that window yields a REGULAR archive holding
          #    repo-source bytes — which no shape or inode test on the ARCHIVE
          #    can tell from a legitimate one. So instead of assuming the copy
          #    was atomic, record the identity of the object we set out to
          #    preserve and re-check it afterwards: if the pathname is no longer
          #    that same object, something moved under us and the artifact
          #    cannot be vouched for, whatever produced it.
          pre_id="$(fsid_of "$link")"
          race_lost=0; publish_blocked=0
          if ln -P "$link" "$archive" 2>/dev/null; then
            archive_ok=1
          else
            archive="$(mktemp "${archive}.XXXXXX" 2>/dev/null || true)"
            if [ -n "$archive" ] && cp -pP "$link" "$archive" 2>/dev/null; then
              archive_ok=1
            else
              if [ -n "$archive" ] && ! strict_discard "$archive"; then
                strict_residue_alert "$name" "$archive" "a failed archive attempt"
                rc=1; publish_blocked=1
              fi
              archive=""
            fi
          fi
          post_id="$(fsid_of "$link")"
          if [ "$publish_blocked" = "1" ]; then
            : # residue we could not remove — decided below, nothing else to try
          elif [ "$archive_ok" = "1" ] && { [ -L "$archive" ] || [ -L "$link" ] \
               || ! id_ok "$pre_id" || [ "$post_id" != "$pre_id" ]; }; then
            # Either we archived a symlink outright, or the pathname is no longer
            # the object we started from. Both mean a rival published while we
            # were copying, so the artifact may hold repo-source bytes rather than
            # the displaced deployment copy. It must go — and "must go" has to be
            # verified, not assumed: an unlink can fail on an immutable flag, a
            # changed directory ACL or a storage error, and reporting clean while
            # a dangerous artifact is still on disk is the failure mode this whole
            # change exists to remove.
            if strict_discard "$archive"; then
              archive_ok=0; race_lost=1
            else
              strict_residue_alert "$name" "$archive" "an artifact of unproven provenance"
              rc=1; publish_blocked=1
            fi
          elif [ "$archive_ok" != "1" ] && [ -L "$link" ]; then
            # The archive syscall failed AND the path is now a symlink: the same
            # race, observed one step later. Distinguishing it from a real
            # archive failure matters — reporting rc=1 here would fail a converge
            # whose only "problem" is that a sibling already did the work.
            race_lost=1
          fi
          if [ "$publish_blocked" = "0" ] && [ "$race_lost" = "0" ] && [ "$archive_ok" = "1" ]; then
            # The identity re-check proves the pathname did not move; it does NOT
            # prove the object was ever distinct from the repo source. A "copy"
            # installed as a HARD LINK to scripts/meta-alert.sh keeps one identity
            # start to finish, so pre==post holds while the archive is simply a
            # third alias of the trusted file — precisely the hazard -P exists to
            # avoid: a writable alias of production source inside <state>/bin.
            # Identity is device:inode, not a bare inode number: the same inode
            # number on two filesystems is two different objects, and comparing
            # bare numbers could just as easily delete a legitimate archive.
            src_id="$(fsid_of "$src")"; arch_id="$(fsid_of "$archive")"
            if ! id_ok "$src_id" || ! id_ok "$arch_id"; then
              # We cannot prove the retained archive is distinct from the source,
              # and we cannot prove the source is even still there — publishing
              # now could replace a working regular file with a broken link.
              # Same fail-closed stance the pre-image check above takes.
              echo "[converge-bin] ERROR: cannot establish file identity for $name (src=${src_id:-?} archive=${arch_id:-?})" >&2
              if ! strict_discard "$archive"; then
                strict_residue_alert "$name" "$archive" "an artifact whose identity could not be established"
              fi
              strict_alert "$name" "bin alert-chain identity unmeasurable: $name" \
                "Could not read the identity of ${src} and/or its archive, so it is not provable that the retained artifact differs from the trusted source — or that the source still exists. Nothing was published; $link was left as it was (FLY-1577)." \
                "$name|strict-identity-unmeasurable"
              rc=1; publish_blocked=1
            elif [ "$arch_id" = "$src_id" ]; then
              log "strict shape: $name was a hard link to the repo source — no separate bytes to archive"
              if strict_discard "$archive"; then
                archive=""
              else
                strict_residue_alert "$name" "$archive" "a writable alias of the trusted repo source"
                rc=1; publish_blocked=1
              fi
            fi
          fi
          if [ "$publish_blocked" = "1" ]; then
            : # already alerted with rc=1; the canonical path is left untouched
          elif [ "$race_lost" = "1" ]; then
            # Only healthy if the winner published the target we would have.
            # Anything else means the path is in a state we cannot vouch for.
            if [ "$(readlink "$link" 2>/dev/null)" = "$src" ]; then
              log "strict shape: $name already converged by a concurrent run"
            else
              echo "[converge-bin] ERROR: $name changed shape mid-repair and is not the canonical link" >&2
              strict_alert "$name" "bin alert-chain shape race unresolved: $name" \
                "$link stopped being a regular-file copy while it was being repaired, but it is not the canonical link to $src either. Nothing was published; re-run converge and investigate the writer (FLY-1577)." \
                "$name|strict-shape-race"
              rc=1
            fi
          elif [ "$archive_ok" != "1" ]; then
            echo "[converge-bin] ERROR: strict archive FAILED for $name — canonical copy preserved" >&2
            strict_alert "$name" "bin alert-chain archive FAILED: $name" \
              "Could not preserve $link before replacing its regular-file deployment shape. The canonical path was left untouched; fix bin-directory permissions/storage and re-run converge (FLY-1577)." \
              "$name|strict-archive-failed"
            rc=1
          else
            strict_publish_link "$name" "$src" "$link" copy-converged || rc=1
          fi
        fi
      else
        echo "[converge-bin] ERROR: $name has an unsupported shape at $link — NOT replacing" >&2
        strict_alert "$name" "bin alert-chain shape unsupported: $name" \
          "$link exists but is neither the required symlink nor an archivable regular file. NOT auto-repaired; inspect the path manually (FLY-1577)." \
          "$name|strict-shape-unsupported"
        rc=1
      fi
      continue
    fi

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
    elif symlink_strict_name "$name"; then
      # ── FLY-1577 Block B: strict names must point at the CANONICAL source ──
      if ! canon_expected="$(path_hygiene_canonicalize "$src")"; then
        # Identity cannot be proven, so nothing gets published — "unprovable"
        # must never fall through into the repair path below, because that
        # would mean publishing a target we could not verify.
        echo "[converge-bin] ERROR: cannot canonicalize the expected source for $name (${src:-<none>})" >&2
        strict_alert "$name" "bin alert-chain identity unprovable: $name" \
          "The expected source ${src:-<none>} for $link could not be canonicalized, so the link's identity cannot be verified and nothing was published (FLY-1577)." \
          "$name|strict-identity-unprovable"
        rc=1; continue
      elif [ "$canon_target" != "$canon_expected" ]; then
        unhealthy="wrong target (${canon_target} != ${canon_expected})"
      fi
    fi
    if [ -z "$unhealthy" ]; then
      # ── FLY-1577 Block C: a canonical link is only healthy if its SOURCE is ──
      # The pre-FLY-1577 code `continue`d here, so a link that still pointed at
      # the right path passed even after that path rotted (truncated, lost its
      # shebang, lost its exec bit). For the alert chain a rotted source is a
      # broken chain, so it is loud instead of silent. 0644 is the normal fresh
      # -checkout shape and is auto-chmod'd inside symlink_source_ready without
      # rebuilding the link.
      if symlink_strict_name "$name" && ! symlink_source_ready "$name" "$src"; then
        echo "[converge-bin] ERROR: $name links to ${src} but that source is not usable" >&2
        strict_alert "$name" "bin alert-chain source unusable: $name" \
          "$link points at the canonical ${src}, but that source failed FLY-954 sanity / has no shebang / could not be made executable. The link was left untouched. The cmux watcher's failure report cannot be delivered until the source is repaired (FLY-1577)." \
          "$name|strict-source-unready"
        rc=1
      fi
      continue
    fi
    # Codex code R1 HIGH-2 + R2 HIGH: a symlink TARGET is invoked directly,
    # so beyond the FLY-954 content sanity it must be executable-shaped:
    #   • first line must be a shebang (every legitimate source here ships
    #     one: the node CLI dist and the three bash scripts — a shebang-less
    #     file would die with Exec format error at invocation);
    #   • missing owner-exec bit is AUTO-REPAIRED with chmod 0755, mirroring
    #     syncFlywheelCliBin (FLY-142 R5: tsc emits dist at 0644 — refusing
    #     would make every fresh-build repair fail).
    if symlink_source_ready "$name" "$src"; then
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
      # FLY-1577 Block D: for strict names an unrepairable link is a dead alert
      # chain, so it must fail the converge rather than warn and exit 0. The
      # legacy four keep their alert-only rc semantics verbatim.
      symlink_strict_name "$name" && rc=1
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
