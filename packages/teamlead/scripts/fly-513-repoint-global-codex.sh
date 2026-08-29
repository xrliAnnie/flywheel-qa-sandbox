#!/bin/bash
# FLY-513 — repoint the GLOBAL `codex` off a per-Lead, auto-updating CODEX_HOME
# install onto a NEUTRAL, PINNED standalone install that no Lead lifecycle churns.
#
# WHY: every runner's codex review gate (openai-codex plugin stop-review-gate) and
# every codex companion resolves `codex` via PATH and spawns `codex app-server`.
# `~/.local/bin/codex` was a symlink into `~/.codex-mufasa{,-med3}/.../standalone/
# current/bin/codex`. The standalone updater + Lead flips churn that `current`
# pointer; during the churn window the global codex transiently fails with
# `failed to load configuration: No such file or directory (os error 2)`, stalling
# EVERY runner's review gate (hit ≥3 projects over ~10 days). Pinning a neutral
# install eliminates the churn window at the source.
#
# This is OPERATIONAL (mutates ~/.local/bin/codex, affecting all Leads/runners).
# It is gated on an explicit founder/Lead go (FLY-513 brainstorm: Tadashi approved).
# DEFAULT is DRY-RUN; pass `--apply` to actually install + repoint.
#
# Subcommands:
#   install   — build the neutral pinned install (atomic; idempotent)
#   repoint   — backup current symlink + atomically swap to the neutral install
#   verify    — raw `codex` + real companion `codex app-server` regression
#   rollback  — restore ~/.local/bin/codex from the recorded backup
#   all       — install → verify-source → repoint → verify (the full guarded flow)
#
# Tadashi's 5 conditions (FLY-513): ① atomic install + self-contained verify
# ② backup current symlink target ③ atomic swap (temp + mv) ④ regression: raw +
# real companion in a clean cwd ⑤ one-line rollback ready. ⚠️ Before --apply,
# confirm NO codex review is mid-flight (don't repoint into someone's churn window).

set -euo pipefail

GLOBAL_LINK="$HOME/.local/bin/codex"
NEUTRAL_ROOT="$HOME/.local/share/flywheel-codex"
# Resolve HOME to its realpath so the Lead-home containment check matches a
# realpath'd symlink target (a symlinked HOME, or /tmp→/private/tmp on macOS).
HOME_REAL="$(python3 -c 'import os; print(os.path.realpath(os.path.expanduser("~")))' 2>/dev/null || echo "$HOME")"
NOTE_DIR="${FLY513_NOTE_DIR:-$HOME/.local/share/flywheel-codex}"
BACKUP_FILE="$NOTE_DIR/.global-codex.symlink.bak"
APPLY=0

log() { echo "[fly-513] $*" >&2; }
die() { echo "[fly-513] ERROR: $*" >&2; exit 1; }
run() {
  if [ "$APPLY" = "1" ]; then "$@"; else log "DRY-RUN would: $*"; fi
}

realpath_of() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

# Resolve the release root (`.../releases/<ver>-<triple>/`) of the current global
# codex, plus its version triple. Fails if the current global isn't a standalone
# release layout (nothing to copy).
resolve_source() {
  command -v codex >/dev/null 2>&1 || die "no \`codex\` on PATH to copy from"
  local bin real
  bin="$(command -v codex)"
  real="$(realpath_of "$bin")"
  # .../releases/<ver>-<triple>/bin/codex  → strip /bin/codex
  case "$real" in
    */releases/*/bin/codex) ;;
    *) die "current codex realpath is not a standalone release layout: $real (expected .../releases/<ver>-<triple>/bin/codex). Install a standalone first." ;;
  esac
  SRC_RELEASE_DIR="${real%/bin/codex}"
  SRC_VER_TRIPLE="$(basename "$SRC_RELEASE_DIR")"
  log "source release: $SRC_RELEASE_DIR (ver=$SRC_VER_TRIPLE)"
}

# Stability gate (R1 MED-5): the source `current`/global pointer must be stable
# across two reads a few seconds apart — never copy mid-update.
stability_gate() {
  local a b sleep_s="${FLY513_STABILITY_SLEEP:-4}"
  a="$(realpath_of "$GLOBAL_LINK" 2>/dev/null || true)"
  log "stability gate: read 1 = $a (waiting ${sleep_s}s)…"
  sleep "$sleep_s"
  b="$(realpath_of "$GLOBAL_LINK" 2>/dev/null || true)"
  [ -n "$a" ] && [ "$a" = "$b" ] || die "global codex realpath changed during the window ($a → $b) — an update/flip is in progress; retry later"
  log "stability gate OK (stable: $a)"
}

# Scan the copied tree for ANY symlink that points back into a Lead home or a
# `current` pointer — the copy must be fully self-contained (R1 MED-5).
# NOTE (Codex code-review R2 HIGH): the `case` must NOT live inside a `$(…)`
# command substitution — macOS /bin/bash 3.2 mis-parses a glob `case` there
# (`syntax error near unexpected token newline`) and the scan silently fails /
# aborts under `set -e`. Use process substitution + a plain accumulator so the
# `case` runs in the main shell. `bash -n`/shellcheck don't catch the 3.2 quirk;
# the apply-path test (__tests__/fly-513-repoint.test.sh) does.
scan_self_contained() {
  local dir="$1" l t leaks=""
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    t="$(realpath_of "$l" 2>/dev/null || true)"
    case "$t" in
      "$HOME_REAL"/.codex-*/*) leaks="${leaks}${l} -> ${t}"$'\n' ;;
      */standalone/current/*) leaks="${leaks}${l} -> ${t}"$'\n' ;;
    esac
  done < <(find "$dir" -type l -print 2>/dev/null)
  [ -z "$leaks" ] || die "copied tree is NOT self-contained — symlink(s) point back into a Lead home / current:
$leaks"
  log "self-contained scan OK (no symlink leaks into a Lead home / current)"
}

cmd_install() {
  resolve_source
  local target="$NEUTRAL_ROOT/$SRC_VER_TRIPLE"
  if [ -x "$target/bin/codex" ]; then
    log "neutral install already present: $target (idempotent no-op)"
    NEUTRAL_BIN="$target/bin/codex"; return 0
  fi
  stability_gate
  local tmp="$NEUTRAL_ROOT/.tmp-$SRC_VER_TRIPLE-$$"
  run mkdir -p "$NEUTRAL_ROOT"
  run cp -R "$SRC_RELEASE_DIR" "$tmp"
  if [ "$APPLY" = "1" ]; then
    scan_self_contained "$tmp"
    [ -x "$tmp/bin/codex" ] || die "copied tree has no executable bin/codex"
    log "smoke: $tmp/bin/codex --version → $("$tmp/bin/codex" --version 2>&1 | head -1)"
    # atomic publish
    mv "$tmp" "$target"
    ( cd "$NEUTRAL_ROOT" && shasum "$target/bin/codex" > "$target/bin/codex.sha" || true )
    log "installed neutral pinned codex: $target"
  fi
  NEUTRAL_BIN="$target/bin/codex"
}

cmd_repoint() {
  [ -n "${NEUTRAL_BIN:-}" ] || { cmd_install; }
  [ "$APPLY" != "1" ] || [ -x "$NEUTRAL_BIN" ] || die "neutral bin not installed: $NEUTRAL_BIN (run install first)"
  # ② backup current target
  local cur
  cur="$(readlink "$GLOBAL_LINK" 2>/dev/null || true)"
  run mkdir -p "$NOTE_DIR"
  if [ "$APPLY" = "1" ]; then
    printf '%s\n' "$cur" > "$BACKUP_FILE"
    log "backed up current symlink target → $BACKUP_FILE ($cur)"
  else
    log "DRY-RUN would back up current target ($cur) → $BACKUP_FILE"
  fi
  # ③ atomic swap: temp symlink in the SAME dir + mv -f (NOT plain ln -sfn) (R2 LOW-5)
  local link_dir tmp_link
  link_dir="$(dirname "$GLOBAL_LINK")"
  tmp_link="$link_dir/.codex.fly513.$$"
  if [ "$APPLY" = "1" ]; then
    ln -s "$NEUTRAL_BIN" "$tmp_link"
    mv -f "$tmp_link" "$GLOBAL_LINK"
    local now; now="$(realpath_of "$GLOBAL_LINK")"
    log "repointed $GLOBAL_LINK → $NEUTRAL_BIN (realpath now: $now)"
    case "$now" in "$HOME_REAL"/.codex-*/*) die "post-repoint realpath STILL in a Lead home: $now" ;; esac
  else
    log "DRY-RUN would: ln -s $NEUTRAL_BIN $tmp_link && mv -f $tmp_link $GLOBAL_LINK"
  fi
}

# ④ regression — raw + REAL companion in a clean cwd. Records broker vs direct.
# ④ regression — FAIL-CLOSED (Codex code-review R1 HIGH): raw + REAL companion in a
# clean cwd. Exit status is checked, NOT swallowed in a `log "$(…)"`, so a broken
# install / broken config-load makes verify return non-zero → `all` auto-rolls-back
# BEFORE leaving the global codex pointing at a bad target. Returns 0 only if every
# enabled check passed.
cmd_verify() {
  local rc=0
  # raw must succeed (exit-checked).
  if codex --version >/dev/null 2>&1; then
    log "raw OK: $(codex --version 2>&1 | head -1)"
  else
    log "FAIL: raw \`codex --version\` exited non-zero"
    rc=1
  fi
  # real companion app-server path (the exact one that failed in FLY-513).
  local tmpdir
  tmpdir="$(mktemp -d)"
  local companion
  companion="$(find "$HOME/.claude/plugins/cache" -path "*/openai-codex/codex/*/scripts/codex-companion.mjs" 2>/dev/null | sort -V | tail -1)"
  if [ -z "$companion" ]; then
    log "FAIL: codex-companion.mjs not found — cannot verify the companion path"
    rc=1
  elif [ "$APPLY" = "1" ]; then
    if ( cd "$tmpdir" && node "$companion" task --json --prompt-file <(printf 'Reply with exactly: FLY-513 OK') >/dev/null 2>&1 ); then
      log "real companion OK (codex app-server initialize + task in clean cwd $tmpdir)"
    else
      log "FAIL: real companion verify exited non-zero (codex app-server config-load may be broken)"
      rc=1
    fi
  else
    log "DRY-RUN would run companion task --json in $tmpdir (fail-closed under --apply)"
  fi
  rm -rf "$tmpdir"
  return "$rc"
}

# ⑤ one-line rollback
cmd_rollback() {
  [ -f "$BACKUP_FILE" ] || die "no backup at $BACKUP_FILE — cannot auto-rollback (was repoint --apply run?)"
  local prev; prev="$(cat "$BACKUP_FILE")"
  [ -n "$prev" ] || die "backup is empty"
  run ln -sfn "$prev" "$GLOBAL_LINK"
  log "rolled back $GLOBAL_LINK → $prev"
}

main() {
  local sub="${1:-}"; shift || true
  for a in "$@"; do [ "$a" = "--apply" ] && APPLY=1; done
  if [ "$APPLY" = "1" ]; then
    log "MODE: APPLY (will mutate)"
  else
    log "MODE: DRY-RUN (no mutation; pass --apply to execute)"
  fi
  case "$sub" in
    install)  cmd_install ;;
    repoint)  cmd_repoint ;;
    verify)   cmd_verify || die "verification FAILED — do not trust the current global codex" ;;
    rollback) cmd_rollback ;;
    all)
      cmd_install
      cmd_repoint
      # Codex code-review R1 HIGH: under --apply the symlink is already swapped, so a
      # failed post-repoint verify MUST auto-rollback — a broken global codex must
      # never persist. DRY-RUN just reports.
      if [ "$APPLY" = "1" ]; then
        if ! cmd_verify; then
          log "verify FAILED after repoint — AUTO-ROLLBACK (a broken global codex must never persist)"
          cmd_rollback
          die "post-repoint verification failed; rolled back $GLOBAL_LINK to its previous target"
        fi
      else
        cmd_verify
      fi
      ;;
    *) die "usage: $0 {install|repoint|verify|rollback|all} [--apply]" ;;
  esac
  log "done: $sub"
}

# Only auto-run when executed directly — sourcing (tests) loads the functions only.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
