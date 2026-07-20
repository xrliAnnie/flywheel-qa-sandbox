#!/bin/bash
# FLY-1389 P1-0: shared path-hygiene predicates for global-persistence writers.
#
# Incident 2026-07-20 (529 Room): ~/.flywheel/bin/agent-team-transport pointed
# into a worktree's dist; the worktree was cleaned, the symlink broke, and the
# next Lead start died FATAL at the transport preflight. Root cause class:
# installers derive their source root from their own location and write that
# root into GLOBAL config — run once from a temp/worktree checkout and the
# global config permanently remembers a temporary address.
#
# Rule (Annie red line): global bin links point at the main checkout ONLY —
# refuse AT WRITE TIME, do not detect-and-repair after the fact. Every writer
# of a global persistence surface (~/.flywheel effective state, ~/.claude
# settings/plugins, ~/Library/LaunchAgents) consults these predicates.
#
# The TypeScript mirror lives in
# packages/teamlead/src/bridge/path-hygiene.ts — keep the two hosts aligned
# (both test suites pin the same fixture matrix).
#
# Judgment basis (research §7c, macOS verified):
#   temp shape    — canonical path under /tmp, /private/tmp, /var/folders,
#                   /private/var/folders (macOS: /var → /private/var symlink,
#                   so both spellings must be in the set; judged AFTER
#                   canonicalization).
#   worktree root — <dir>/.git exists and is a FILE (linked-worktree gitdir
#                   pointer). Main checkouts have a .git DIRECTORY. Applies to
#                   the root itself only — for deep targets walk up to the
#                   owning repo root first (path_hygiene_owning_repo_root).
#                   Naming heuristics (path contains /worktrees/) are known to
#                   miss real shapes (~/Dev/flywheel-FLY-1389) — never used.
#   canonicalize  — allow-missing contract (Codex R2 #2): resolve the longest
#                   EXISTING ancestor physically, then append the missing
#                   suffix. A clean host without ~/.flywheel/bin must still be
#                   recognized as global. Any other resolution failure (empty
#                   input, dot segments in the missing suffix) → non-zero, and
#                   callers treat it FAIL-CLOSED (guard triggers).
#
# Sourcing only defines functions (no side effects). Bash 3.2 compatible.

# Canonicalize a path without requiring it to exist.
# stdout: canonical absolute path; rc=1 on unresolvable input (fail-closed at
# the call sites).
path_hygiene_canonicalize() {
  local p="${1:-}"
  [ -n "$p" ] || return 1
  case "$p" in
    /*) : ;;
    *) p="$(pwd -P)/$p" || return 1 ;;
  esac
  # strip trailing slashes (keep bare "/")
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  local suffix="" cur="$p" base
  while [ ! -d "$cur" ] && [ "$cur" != "/" ]; do
    base="$(basename "$cur")"
    case "$base" in
      .|..) return 1 ;;  # dot segment in a missing suffix is unresolvable
    esac
    suffix="${base}${suffix:+/$suffix}"
    cur="$(dirname "$cur")"
  done
  local resolved
  resolved="$(cd "$cur" 2>/dev/null && pwd -P)" || return 1
  if [ -n "$suffix" ]; then
    if [ "$resolved" = "/" ]; then
      printf '/%s\n' "$suffix"
    else
      printf '%s/%s\n' "$resolved" "$suffix"
    fi
  else
    printf '%s\n' "$resolved"
  fi
}

# Pure prefix verdict on an ALREADY-canonical path (boundary-safe: /tmpfoo is
# not /tmp).
path_hygiene_is_temp_path() {
  case "${1:-}" in
    /tmp|/tmp/*|/private/tmp|/private/tmp/*) return 0 ;;
    /var/folders|/var/folders/*|/private/var/folders|/private/var/folders/*) return 0 ;;
    *) return 1 ;;
  esac
}

# is_temp_or_worktree_root <dir> → 0 = temp/worktree shape (writers must
# REFUSE), 1 = trusted root (main checkout, packaged .flywheel-prebuilt tree,
# fleet custom root). Fail-closed: unresolvable input → 0.
is_temp_or_worktree_root() {
  local canon
  canon="$(path_hygiene_canonicalize "${1:-}")" || return 0
  path_hygiene_is_temp_path "$canon" && return 0
  [ -f "$canon/.git" ] && return 0
  return 1
}

# is_global_bin_dir <dir> → 0 = resolved identity equals the effective global
# bin ($HOME/.flywheel/bin), regardless of how the value was spelled
# (FLYWHEEL_BIN_DIR override, symlink alias, redundant slashes). Fail-closed:
# unresolvable input → 0 (treated as global so the guard triggers).
is_global_bin_dir() {
  local canon global
  canon="$(path_hygiene_canonicalize "${1:-}")" || return 0
  global="$(path_hygiene_canonicalize "${HOME}/.flywheel/bin")" || return 0
  [ "$canon" = "$global" ]
}

# path_hygiene_same_path <a> <b> → 0 = canonical identity. Fail-closed: an
# unresolvable side compares as SAME (callers use this to decide "effective
# global destination" — the guard must engage on doubt).
path_hygiene_same_path() {
  local a b
  a="$(path_hygiene_canonicalize "${1:-}")" || return 0
  b="$(path_hygiene_canonicalize "${2:-}")" || return 0
  [ "$a" = "$b" ]
}

# path_hygiene_owning_repo_root <existing-path> → prints the first ancestor
# (the path itself if a dir, else its dirname) that contains a .git entry;
# rc=1 when no ancestor is a repo root.
path_hygiene_owning_repo_root() {
  local d="${1:-}"
  [ -e "$d" ] || return 1
  [ -d "$d" ] || d="$(dirname "$d")"
  d="$(cd "$d" 2>/dev/null && pwd -P)" || return 1
  while :; do
    if [ -e "$d/.git" ]; then printf '%s\n' "$d"; return 0; fi
    [ "$d" = "/" ] && return 1
    d="$(dirname "$d")"
  done
}

# path_hygiene_target_is_temp_or_worktree <path> → 0 when the path is a
# temp-canonical location OR lives inside a linked-worktree checkout (owning
# repo root's .git is a file). For deep targets — symlink destinations,
# marketplace paths — where the root-only .git test of
# is_temp_or_worktree_root does not apply. Fail-closed on unresolvable input.
path_hygiene_target_is_temp_or_worktree() {
  local canon root
  canon="$(path_hygiene_canonicalize "${1:-}")" || return 0
  path_hygiene_is_temp_path "$canon" && return 0
  root="$(path_hygiene_owning_repo_root "$canon")" || return 1
  [ -f "$root/.git" ] && return 0
  return 1
}
