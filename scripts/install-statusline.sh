#!/usr/bin/env bash
# Deploy scripts/statusline-command.sh to ~/.claude/statusline-command.sh.
#
# This file renders on EVERY Lead and Runner pane on the founder's machine, and
# Claude Code re-reads it on every frame. A single parse error therefore blanks
# every statusline at once, with no restart needed to spread the damage. Atomic
# rename alone does not protect against that — it prevents a HALF-written file,
# not an atomically installed BROKEN one. So the order here is validate first,
# commit second, and roll back automatically if the committed copy misbehaves:
#
#   refuse temp/worktree source  ->  bash -n source  ->  smoke-render source
#   ->  read-only settings gate  ->  stage + chmod + bash -n + smoke the STAGED
#   copy  ->  ONLY THEN write .bak  ->  rename  ->  read back + smoke
#   ->  on any post-rename failure, restore .bak and verify the restoration.
#
# Guarantee, stated precisely: every gate before the backup leaves the target AND
# the backup untouched. Once a fully validated copy enters the backup/rename
# commit phase the backup may advance even if the rename itself fails — what is
# guaranteed from that point on is the property that actually matters, that a
# broken file is never left live.
#
# Deliberately does NOT edit ~/.claude/settings.json. The statusLine command
# there already points at a stable absolute path, so this only replaces the file
# it points to; the settings check below is read-only and fail-closed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/path-hygiene.sh
source "$SCRIPT_DIR/lib/path-hygiene.sh"

SOURCE="$SCRIPT_DIR/statusline-command.sh"
CLAUDE_DIR="${FLYWHEEL_STATUSLINE_CLAUDE_DIR:-$HOME/.claude}"
TARGET="$CLAUDE_DIR/statusline-command.sh"
BACKUP="$TARGET.bak"
SETTINGS="$CLAUDE_DIR/settings.json"

STAGED=""
SMOKE_DIR=""
BACKUP_TMP=""
RESTORE_TMP=""
LOCK_DIR="$CLAUDE_DIR/.statusline-install.lock"
HELD_LOCK=0
# Transaction phase, so a signal or an unexpected exit knows whether the target
# has landed and whether it has been proved good:
#   0 = nothing committed   1 = renamed, NOT yet verified   2 = verified
PHASE=0

# Reject anything that is not a plain regular file. `-f`/`-e` FOLLOW symlinks, so
# they will happily bless a link — and a link is not a stable install target: move
# its referent and the configured path dangles. `-L` is the lstat-style question.
is_plain_file() { [ ! -L "$1" ] && [ -f "$1" ]; }
is_really_absent() { [ ! -e "$1" ] && [ ! -L "$1" ]; }

# Every action guarded independently: under `set -e` the first failure would
# otherwise skip the rest — including releasing the lock, which would then block
# the very run that could repair things.
cleanup() {
  local incoming=$?
  if [ "$PHASE" -eq 1 ]; then
    echo "ERROR: interrupted after the target landed but before it was verified." >&2
    recover_target || true
    incoming=${incoming:-1}
    [ "$incoming" -eq 0 ] && incoming=1
  fi
  [ -n "$STAGED" ]      && [ -e "$STAGED" ]      && { rm -f "$STAGED"      || echo "  cleanup: could not remove $STAGED" >&2; }
  [ -n "$BACKUP_TMP" ]  && [ -e "$BACKUP_TMP" ]  && { rm -f "$BACKUP_TMP"  || echo "  cleanup: could not remove $BACKUP_TMP" >&2; }
  [ -n "$RESTORE_TMP" ] && [ -e "$RESTORE_TMP" ] && { rm -f "$RESTORE_TMP" || echo "  cleanup: could not remove $RESTORE_TMP" >&2; }
  [ -n "$SMOKE_DIR" ]   && [ -d "$SMOKE_DIR" ]   && { rm -rf "$SMOKE_DIR"  || echo "  cleanup: could not remove $SMOKE_DIR" >&2; }
  if [ "$HELD_LOCK" -eq 1 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || echo "  cleanup: could not release $LOCK_DIR — remove it by hand" >&2
  fi
  exit "$incoming"
}
trap cleanup EXIT
# A catchable signal between the rename and its verification would otherwise
# leave the unverified candidate live with the healthy backup sitting unused.
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

# Two windows must not be torn in half by a catchable signal: acquiring the lock
# (mkdir succeeds, then ownership is recorded — a signal between them leaks a
# lock that blocks every later run) and rolling back (a signal mid-restore would
# otherwise exit with the broken candidate live). Both are short and bounded, so
# ignoring signals across them is simpler and more robust than resumable state.
# SIGKILL still cannot be caught; that limit is stated, not papered over.
signals_off() { trap '' INT TERM HUP; }
signals_on()  { trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP; }

die() { echo "ERROR: $*" >&2; exit 1; }

# --- (1) refuse installing global config from a temp/worktree checkout --------
# FLY-1389: running an installer from a worktree once left the global config
# permanently pointing into a directory that later got cleaned.
if is_temp_or_worktree_root "$REPO_ROOT"; then
  echo "ERROR: refusing to install global config from a temp/worktree checkout: $REPO_ROOT" >&2
  echo "  Re-run from the MAIN checkout after this branch merges (FLY-1389)." >&2
  exit 1
fi

# --- (2) source must exist ---------------------------------------------------
[ -f "$SOURCE" ] || die "statusline source missing: $SOURCE"

# --- (3) syntax gate, before any global write --------------------------------
/bin/bash -n "$SOURCE" 2>/dev/null || die "source fails 'bash -n': $SOURCE (nothing was changed)"

# --- smoke render ------------------------------------------------------------
# Runs the candidate against the REAL host toolchain — which is the point: this
# must prove the script works with the date/stat/tr that will actually run it in
# production, not under test shims. Only curl and security are stubbed, so the
# smoke can never reach the network or the Keychain.
#
# Content, not just shape: a candidate of `cat >/dev/null; echo; echo` exits 0
# with two lines and no stderr, and a shape-only gate installs it — a blank
# statusline on every pane. The fixture below is fixed, so every value it should
# surface is a known anchor and can be demanded.
smoke_render() { # <script-path> -> 0 ok
  local script="$1" home rc lines
  SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly1678-smoke.XXXXXX")"
  home="$SMOKE_DIR/home"
  mkdir -p "$home/.claude" "$SMOKE_DIR/bin"
  for stub in curl security; do
    printf '#!/bin/sh\nexit 1\n' > "$SMOKE_DIR/bin/$stub"
    chmod 0755 "$SMOKE_DIR/bin/$stub"
  done
  printf '%s' '{"oauthAccount":{"emailAddress":"smoke@example.test"}}' > "$home/.claude.json"
  printf '%s' '{"effortLevel":"high"}' > "$home/.claude/settings.json"
  printf '%s' '{"five_hour":{"utilization":50,"resets_at":"2030-01-01T00:00:00Z"},
"seven_day":{"utilization":60,"resets_at":"2030-01-02T00:00:00Z"},
"limits":[{"kind":"weekly_scoped","percent":70,"resets_at":"2030-01-02T00:00:00Z",
"scope":{"model":{"id":null,"display_name":"SmokeModel"},"surface":null}}]}' \
    > "$home/.claude/usage-api-cache.json"

  rc=0
  printf '%s' '{"model":{"display_name":"Smoke"},"workspace":{"current_dir":"/tmp"},"context_window":{"used_percentage":10}}' \
    | env HOME="$home" PATH="$SMOKE_DIR/bin:$PATH" \
        /bin/bash "$script" > "$SMOKE_DIR/out" 2> "$SMOKE_DIR/err" || rc=$?
  lines=$(wc -l < "$SMOKE_DIR/out" | tr -d ' ')

  local result=0 missing=""
  if [ "$rc" -ne 0 ]; then
    echo "  smoke: exited $rc; stderr: $(head -c 300 "$SMOKE_DIR/err")" >&2; result=1
  elif [ "$lines" -ne 2 ]; then
    echo "  smoke: expected 2 rendered lines, got $lines" >&2; result=1
  elif [ -s "$SMOKE_DIR/err" ]; then
    echo "  smoke: wrote to stderr: $(head -c 300 "$SMOKE_DIR/err")" >&2; result=1
  else
    for anchor in "Smoke" "ctx 10%" "5h " "50%" "7d " "60%" "SmokeModel" "70%"; do
      grep -qF "$anchor" "$SMOKE_DIR/out" || missing="$missing '$anchor'"
    done
    if [ -n "$missing" ]; then
      echo "  smoke: rendered two lines but they are missing:$missing" >&2; result=1
    fi
  fi
  rm -rf "$SMOKE_DIR"; SMOKE_DIR=""
  return $result
}

smoke_render "$SOURCE" || die "source fails its smoke render (nothing was changed)"

# Put the machine back into a state that is known-good, verified. Used by the
# post-rename check, by the interrupted-install branch, and by the signal path.
# Returns 0 when the end state is proven safe.
recover_target() {
  signals_off
  local outcome
  _recover_target_inner; outcome=$?
  signals_on
  return $outcome
}

_recover_target_inner() {
  if [ "$had_backup" -eq 1 ]; then
    RESTORE_TMP=$(mktemp "$TARGET.restore.XXXXXX") || { echo "  ROLLBACK FAILED: could not create a restore temp." >&2; return 1; }
    if is_plain_file "$RESTORE_TMP" \
       && cp "$BACKUP" "$RESTORE_TMP" && chmod 0755 "$RESTORE_TMP" \
       && mv "$RESTORE_TMP" "$TARGET" && cmp -s "$BACKUP" "$TARGET" \
       && /bin/bash -n "$TARGET" 2>/dev/null && smoke_render "$TARGET"; then
      RESTORE_TMP=""
      echo "  Rolled back: $TARGET restored from $BACKUP (verified: bytes, syntax, smoke)." >&2
      return 0
    fi
    rm -f "$RESTORE_TMP" 2>/dev/null; RESTORE_TMP=""
    echo "  ROLLBACK FAILED. Restore by hand: mv $BACKUP $TARGET" >&2
    return 1
  fi
  # No rollback point, so the only safe end state is "no file at all". A
  # successful `rm -f` is not the same as the file being gone — and `-e` is false
  # for a dangling symlink, so absence is checked with lstat semantics too.
  rm -f "$TARGET" || true
  if is_really_absent "$TARGET"; then
    echo "  Removed the freshly installed target; the machine is back to having no $TARGET." >&2
    return 0
  fi
  echo "  ROLLBACK FAILED: could not remove the broken target." >&2
  echo "  Remove it by hand: rm -f $TARGET" >&2
  return 1
}

recover_and_die() { # <reason>
  echo "ERROR: post-install verification failed: $1" >&2
  # PHASE stays at 1 until recovery has RUN. Marking it verified up front is what
  # let a signal arriving mid-restore exit through an EXIT trap that then skipped
  # recovery entirely, leaving the broken candidate live.
  #
  # Honest note: with signals now masked across recovery, this ordering has no
  # observable effect on its own — a mutant that reverses it survives the whole
  # suite, because signals_off already closes the hole (removing THAT is caught,
  # by test 20). The ordering is kept as belt-and-braces for any future failure
  # mode inside recovery that is not a signal; it is not claimed to be tested.
  recover_target || true
  PHASE=2
  exit 1
}


# --- (4) read-only settings gate --------------------------------------------
# Without this, a successful install could deploy a file Claude Code never reads
# and still report success. Exact-match, never substring: a substring test would
# accept a command that merely MENTIONS the path without executing it.
[ -f "$SETTINGS" ] || die "settings not found: $SETTINGS"
jq empty "$SETTINGS" 2>/dev/null || die "settings is not valid JSON: $SETTINGS"

sl_type=$(jq -r '.statusLine.type // ""' "$SETTINGS")
sl_cmd=$(jq -r '.statusLine.command // ""' "$SETTINGS")
[ "$sl_type" = "command" ] || die "settings .statusLine.type is '$sl_type', expected 'command'"

case "$sl_cmd" in
  "bash $TARGET"|"/bin/bash $TARGET"|"$TARGET") ;;
  *)
    echo "ERROR: settings .statusLine.command does not invoke the install target." >&2
    printf '  expected one of:\n    bash %s\n    /bin/bash %s\n    %s\n' "$TARGET" "$TARGET" "$TARGET" >&2
    printf '  actual: %q\n' "$sl_cmd" >&2
    echo "  Refusing to install a file Claude Code would not read. Nothing was changed." >&2
    echo "  (This gate is read-only — settings.json is never rewritten here.)" >&2
    exit 1
    ;;
esac

# --- (5) serialize: one installer at a time ---------------------------------
# There is exactly one rollback point per machine, and it is mutable. Two
# concurrent installers share it: one can back up the other's unverified
# in-flight bytes, and a later rollback then "restores" them. `mkdir` is the
# portable atomic test-and-set — `flock` is Linux-only and `set -o noclobber`
# is subtler. Fail fast rather than queue: a second installer is a mistake, not
# a workload.
mkdir -p "$CLAUDE_DIR"
signals_off
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  signals_on
  echo "ERROR: another install-statusline.sh holds $LOCK_DIR" >&2
  echo "  Wait for it to finish. If no installer is running, remove the stale" >&2
  echo "  lock by hand: rmdir $LOCK_DIR" >&2
  exit 1
fi
HELD_LOCK=1
signals_on

# --- (5b) refuse shapes the transaction cannot handle ------------------------
# `mv` and `cp` silently do the WRONG thing against a directory: `mv staged dir`
# succeeds by nesting the file inside it, and `cp dir target` fails midway. Both
# end with the broken candidate live and an unusable recovery command. Anything
# that is not a regular file (or absent) is rejected before the commit phase.
for path in "$TARGET" "$BACKUP"; do
  if ! is_really_absent "$path" && ! is_plain_file "$path"; then
    echo "ERROR: $path exists but is not a plain regular file (directory, symlink, or special)." >&2
    echo "  A symlink is not a stable install target — move its referent and the" >&2
    echo "  configured path dangles — and a directory silently absorbs the rename." >&2
    echo "  Refusing to run a rename/backup transaction against it. Nothing was changed." >&2
    exit 1
  fi
done

# --- (6) idempotent short-circuit -------------------------------------------
# Re-running with identical content must be a no-op, including leaving .bak
# alone. Content alone is not convergence though, on two counts:
#
#   * A same-content 0644 target is repaired in place (still without touching
#     the rollback point).
#   * Matching bytes are not proof that the LIVE file works. If a previous run
#     was interrupted between the rename and its verification, the next run
#     would see identical bytes and permanently bless a target that is broken at
#     its final path. So the live file is syntax- and smoke-checked here too,
#     before anything is called "already current".
if is_plain_file "$TARGET" && cmp -s "$SOURCE" "$TARGET"; then
  if ! /bin/bash -n "$TARGET" 2>/dev/null || ! smoke_render "$TARGET"; then
    # Detecting this is not enough: leaving it live would contradict this
    # script's one hard guarantee. Recover through the same verified path the
    # post-rename failure uses.
    had_backup=0
    is_plain_file "$BACKUP" && had_backup=1
    recover_and_die "the live target matches the source byte-for-byte but does not run"
  fi
  # `find -perm 0755` is an exact-mode match on both BSD and GNU find. Reading the
  # mode via `stat` would need different flags per platform — the very portability
  # trap this issue is about — and parsing `ls` is worse.
  if [ -n "$(find "$TARGET" -perm 0755 2>/dev/null)" ]; then
    echo "already current: $TARGET (verified; no change)"
    exit 0
  fi
  chmod 0755 "$TARGET"
  echo "already current: $TARGET (verified; repaired mode to 0755; backup untouched)"
  exit 0
fi

# --- (7) stage and validate the exact bytes that will go live ----------------
STAGED=$(mktemp "$TARGET.staged.XXXXXX")
cp "$SOURCE" "$STAGED"
chmod 0755 "$STAGED"
/bin/bash -n "$STAGED" 2>/dev/null || die "staged copy fails 'bash -n' (nothing was changed)"
smoke_render "$STAGED" || die "staged copy fails its smoke render (nothing was changed)"

# --- (8) commit phase: rollback point, then rename --------------------------
had_backup=0
if is_plain_file "$TARGET"; then
  had_backup=1
  # mktemp, not "$BACKUP.tmp.$$": a predictable name can be pre-created as a
  # DIRECTORY or a symlink, after which `cp file dir` and `mv dir backup` both
  # succeed and the rollback point becomes a directory that rollback cannot read.
  BACKUP_TMP=$(mktemp "$BACKUP.tmp.XXXXXX") || die "could not create a backup temp"
  is_plain_file "$BACKUP_TMP" || die "backup temp $BACKUP_TMP is not a regular file"
  cp "$TARGET" "$BACKUP_TMP"
  mv "$BACKUP_TMP" "$BACKUP"
  BACKUP_TMP=""
fi

PHASE=1     # from here until verification, an interrupt must roll back
if ! mv "$STAGED" "$TARGET"; then
  PHASE=0
  echo "ERROR: rename into place failed; the live target was NOT modified." >&2
  [ "$had_backup" -eq 1 ] && echo "  Note: $BACKUP was already refreshed to the pre-install version." >&2
  exit 1
fi
STAGED=""

# --- (9) verify what actually landed, and roll back if it is wrong -----------
cmp -s "$SOURCE" "$TARGET" || recover_and_die "installed bytes differ from the source"
smoke_render "$TARGET" || recover_and_die "installed file fails its smoke render"

PHASE=2
echo "Installed $TARGET from $SOURCE"
[ "$had_backup" -eq 1 ] && echo "  Rollback point: $BACKUP  (restore with: mv $BACKUP $TARGET)"
echo "  Takes effect on the next statusline frame — no service restart required."
