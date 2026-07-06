#!/bin/bash
#
# GEO-151 L3 — find-window: resolve a macOS app/window query to a window ID
# suitable for `screencapture -l <windowID>`.
#
# Usage:
#   find-window.sh <query>
#
# `<query>` can be:
#   - An exact app process name (case-insensitive): `cmux`, `Terminal`
#   - A substring match against the window TITLE (lowercase contains)
#   - A bundle ID prefix (`com.googlecode.iterm2`)
#
# Output (stdout, single line):
#   - On match: the numeric windowID, exit 0
#   - On no match / all matches minimized: empty stdout, exit 1
#   - On AppleScript / system error: empty stdout + stderr message, exit 2
#
# Why AppleScript and not `lsappinfo` or a tool? `lsappinfo` does not give
# us per-window IDs; the AppKit window list is the only stable surface.
# This script wraps the AppleScript so the prompt (screencapture-l3-skill.md)
# doesn't have to embed AppleScript — Annie's Lead model just calls
# `find-window.sh cmux` and parses the integer.
#
# This script is intentionally side-effect-free: it does NOT bring the
# target app to the front, does NOT screenshot, does NOT touch any GUI
# state. It just queries.

set -u

QUERY="${1:-}"
if [ -z "$QUERY" ]; then
  echo "usage: find-window.sh <app-name-or-window-title-substring>" >&2
  exit 2
fi

# Allow tests to inject a fake osascript by setting FIND_WINDOW_OSASCRIPT.
OSASCRIPT="${FIND_WINDOW_OSASCRIPT:-osascript}"

# AppleScript:
#   1. Get every process that has at least one visible window.
#   2. For each process, match its name (case-insensitive contains) OR
#      its bundle identifier (prefix match) against the query.
#   3. If matched, return the id of the first window that is NOT
#      minimized (collapsed) AND has positive width+height.
#   4. If no match → return empty string.
#
# Note: the AppleScript `id of window` returns the AX windowID which is
# what `screencapture -l` consumes (verified macOS 14+).
read -r -d '' SCRIPT <<'APPLESCRIPT' || true
on run argv
  set queryStr to item 1 of argv
  set queryLower to my toLower(queryStr)
  tell application "System Events"
    set procList to every application process whose visible is true
    -- Two-pass matching:
    --   Pass 1: process name / bundle ID match — return first visible
    --           non-minimized window of the matching process.
    --   Pass 2 (Codex R1 MED#3): if no process matched, fall back to
    --           per-window TITLE substring match across all visible
    --           processes. The skill prompt advertises window-title
    --           matching, so the helper must actually do it.
    repeat with proc in procList
      try
        set procName to name of proc
        set procBundle to bundle identifier of proc
      on error
        set procName to ""
        set procBundle to ""
      end try
      set procNameLower to my toLower(procName)
      set procBundleLower to my toLower(procBundle)
      if procNameLower contains queryLower or procBundleLower starts with queryLower then
        set wid to my firstVisibleWindowId(proc)
        if wid is not "" then return wid
      end if
    end repeat
    -- Pass 2: title substring match.
    repeat with proc in procList
      try
        set winList to every window of proc
        repeat with w in winList
          try
            set winTitle to name of w
          on error
            set winTitle to ""
          end try
          set winTitleLower to my toLower(winTitle)
          if winTitleLower contains queryLower then
            try
              set wMinimized to value of attribute "AXMinimized" of w
            on error
              set wMinimized to false
            end try
            if wMinimized is false then
              try
                set wSize to size of w
                if (item 1 of wSize) > 0 and (item 2 of wSize) > 0 then
                  return (id of w) as integer
                end if
              end try
            end if
          end if
        end repeat
      end try
    end repeat
  end tell
  return ""
end run

on firstVisibleWindowId(proc)
  tell application "System Events"
    try
      set winList to every window of proc
      repeat with w in winList
        try
          set wMinimized to value of attribute "AXMinimized" of w
        on error
          set wMinimized to false
        end try
        if wMinimized is false then
          try
            set wSize to size of w
            if (item 1 of wSize) > 0 and (item 2 of wSize) > 0 then
              return (id of w) as integer
            end if
          end try
        end if
      end repeat
    end try
  end tell
  return ""
end firstVisibleWindowId

on toLower(s)
  set lowChars to "abcdefghijklmnopqrstuvwxyz"
  set upChars to "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  set out to ""
  repeat with i from 1 to length of s
    set c to character i of s
    set ix to offset of c in upChars
    if ix > 0 then
      set out to out & character ix of lowChars
    else
      set out to out & c
    end if
  end repeat
  return out
end toLower
APPLESCRIPT

RESULT="$("$OSASCRIPT" -e "$SCRIPT" -- "$QUERY" 2>/dev/null)"
RC=$?

if [ "$RC" -ne 0 ]; then
  echo "find-window: osascript exited $RC" >&2
  exit 2
fi

# Trim whitespace
RESULT="$(echo "$RESULT" | tr -d '[:space:]')"

if [ -z "$RESULT" ]; then
  exit 1
fi

# Validate it's a positive integer (defense-in-depth — AppleScript should
# only return ints or empty, but never trust shell-bridge output).
if ! [[ "$RESULT" =~ ^[0-9]+$ ]]; then
  echo "find-window: unexpected osascript output: $RESULT" >&2
  exit 2
fi

echo "$RESULT"
exit 0
