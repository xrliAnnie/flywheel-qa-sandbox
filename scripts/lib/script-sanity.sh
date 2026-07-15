#!/bin/bash
# FLY-954: shared sanity checks + atomic install for <state>/bin runtime scripts.
#
# Incident 2026-07-06: the provisioner's bare `cp` installed 12-byte shebang-only
# test-fixture stubs into the real ~/.flywheel/bin (all three wrappers), and the
# next deploy kickstart took all 13 Leads down. Every legitimate writer of
# <state>/bin runtime scripts MUST go through these helpers:
#   assert_sane_script_source <file> [min_bytes]  — refuse degenerate sources
#   install_script_atomic <src> <dst>             — assert + same-dir tmp + atomic
#                                                   mv + chmod 555 (write-protected)
# mv is not blocked by target file perms (only directory perms), so legitimate
# re-installs need no unlock step; accidental `cp`/`>` hit EACCES and fail loudly.
#
# Sourcing only defines functions (no side effects) — same contract as
# host-config.sh / supervisor.sh. Bash 3.2 compatible.

# Floor is deliberately far below the real scripts (6.8K/9.2K/57.9K) but far
# above any stub. NOT env-tunable (Codex R1#4: a writer-side env knob would
# re-introduce exactly the inherited-env trust this issue removes — e.g. a
# sourced ~/.flywheel/.env could silently lower the floor to 1). Tests that
# need a smaller floor pass the EXPLICIT second arg when unit-testing this
# function directly; production installers never do, and install_script_atomic
# exposes no override at all.
FLYWHEEL_SCRIPT_MIN_BYTES=1024

assert_sane_script_source() {  # <file> [min_bytes(test-only)] → 0 sane, 1 + stderr reason
  local f="$1" min="${2:-$FLYWHEEL_SCRIPT_MIN_BYTES}"
  if [ ! -f "$f" ]; then
    echo "[script-sanity] source missing: $f" >&2; return 1
  fi
  local size
  size="$(wc -c < "$f" | tr -d ' ')"
  if [ "$size" -lt "$min" ]; then
    echo "[script-sanity] source too small (${size}B < ${min}B — stub?): $f" >&2; return 1
  fi
  # a sane script has at least one line that is not blank/comment/shebang
  if ! grep -qE '^[[:space:]]*[^#[:space:]]' "$f"; then
    echo "[script-sanity] no substantive lines (shebang/comment-only stub): $f" >&2; return 1
  fi
  return 0
}

install_script_atomic() {  # <src> <dst> → 0 installed, 1 + stderr reason (dst untouched on failure)
  local src="$1" dst="$2"
  assert_sane_script_source "$src" || return 1
  local dstdir tmp
  dstdir="$(dirname "$dst")"
  mkdir -p "$dstdir" || { echo "[script-sanity] mkdir failed: $dstdir" >&2; return 1; }
  tmp="${dst}.tmp.$$"
  if ! cp "$src" "$tmp" 2>/dev/null; then
    rm -f "$tmp"; echo "[script-sanity] cp to tmp failed: $src -> $tmp" >&2; return 1
  fi
  chmod 555 "$tmp" || { rm -f "$tmp"; echo "[script-sanity] chmod failed: $tmp" >&2; return 1; }
  if ! mv "$tmp" "$dst"; then
    rm -f "$tmp"; echo "[script-sanity] atomic mv failed: $tmp -> $dst" >&2; return 1
  fi
  return 0
}
