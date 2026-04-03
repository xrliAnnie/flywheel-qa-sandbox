#!/bin/bash
# Flywheel Runner Circuit Breaker — PostToolUse Hook (FLY-9)
#
# Detects stuck Runners and stops them to prevent resource waste.
#
# Three signal sources:
#   1. No-progress: consecutive tool calls with no file changes (soft=15, hard=20)
#   2. Repeated error: same error pattern consecutively (soft=3, hard=5)
#   3. Total cap: 50+ tool calls with recent no-progress streak >= 10
#
# Two protection layers:
#   1. Hard-stop: at hard threshold → tmux kill-pane (Runner autonomous, no Lead needed)
#   2. Soft warning: at soft threshold → additionalContext warning to Claude
#
# Anti-termination (GEO-189): skip circuit breaker when Runner is shipping
#   (git push, gh pr create, git commit, etc.)
#
# Env vars (inherited from tmux pane environment):
#   FLYWHEEL_EXEC_ID  — Runner execution ID (state file key, set by TmuxAdapter)
#   TMUX_PANE         — tmux pane ID (set by tmux automatically)
#   FLYWHEEL_COMM_DB  — CommDB path (optional, for future Lead escalation)
#
# Spike verification (2026-04-02):
#   - tmux sets TMUX_PANE for all processes in a pane (documented tmux behavior)
#   - Claude Code hooks inherit parent env (confirmed by inbox-check.sh using
#     FLYWHEEL_EXEC_ID/FLYWHEEL_COMM_DB successfully)
#   - No sandbox restrictions on hook commands (inbox-check.sh runs sqlite3)
#   - tmux kill-pane is a tmux client→server request, completes before pane dies
#
# Deployed to: ~/.flywheel/hooks/circuit-breaker.sh (via /setup-flywheel-hooks)

set -euo pipefail

# ── Thresholds ──
NO_PROGRESS_SOFT=15
NO_PROGRESS_HARD=20
ERROR_REPEAT_SOFT=3
ERROR_REPEAT_HARD=5
TOTAL_CAP=50
TOTAL_CAP_MIN_STREAK=10  # total cap fires when no_progress >= this AND total >= TOTAL_CAP

# ── Quick exit for non-Runner sessions (zero overhead) ──
EXEC_ID="${FLYWHEEL_EXEC_ID:-}"
if [ -z "$EXEC_ID" ]; then
  exit 0
fi

# ── Dependencies ──
if ! command -v jq &>/dev/null; then
  exit 0  # jq missing — degrade gracefully, don't block Runner
fi

# ── State file ──
STATE_DIR="/tmp/flywheel-cb"
mkdir -p "$STATE_DIR" 2>/dev/null || true
STATE_FILE="${STATE_DIR}/${EXEC_ID}.json"

# Initialize state on first run — guard against symlink attacks
if [ ! -f "$STATE_FILE" ]; then
  # Reject symlinks: a local attacker could pre-create a symlink to redirect writes
  if [ -L "$STATE_FILE" ]; then
    rm -f "$STATE_FILE" 2>/dev/null || true
  fi
  # Use a temp file + mv for atomic creation (safe even if path is a dangling symlink)
  INIT_TMP=$(mktemp "${STATE_DIR}/init.XXXXXX") || exit 0
  echo '{"tool_count":0,"no_progress":0,"progress_count":0,"consec_error":0,"last_error_hash":""}' > "$INIT_TMP"
  mv "$INIT_TMP" "$STATE_FILE" || exit 0
elif [ -L "$STATE_FILE" ]; then
  # Existing state file is a symlink — refuse to use it
  exit 0
fi

# ── Read hook input from stdin ──
# Limit read to 200KB to avoid blocking on huge tool_response
INPUT=$(head -c 204800)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true
if [ -z "$TOOL_NAME" ]; then
  exit 0  # Can't parse input — skip silently
fi

TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty' 2>/dev/null) || true
# Only read first 2000 chars of tool_response for error detection
TOOL_RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // empty' 2>/dev/null | head -c 2000) || true

# ── Anti-termination: Runner is shipping → skip entirely ──
if [ "$TOOL_NAME" = "Bash" ]; then
  case "$TOOL_INPUT" in
    *"git push"*|*"gh pr create"*|*"gh pr merge"*|*"gh pr comment"*|*"git commit"*|*"git tag"*)
      # Shipping activity — reset no-progress counter and exit
      # Includes "gh pr comment ... :cool:" which triggers merge via ship-on-comment.yml
      UPD_TMP=$(mktemp "${STATE_DIR}/upd.XXXXXX") || exit 0
      jq '.no_progress = 0 | .progress_count += 1 | .consec_error = 0 | .last_error_hash = ""' \
        "$STATE_FILE" > "$UPD_TMP" 2>/dev/null && mv "$UPD_TMP" "$STATE_FILE" || rm -f "$UPD_TMP"
      exit 0
      ;;
  esac
fi

# ── Determine if this tool call made progress ──
MADE_PROGRESS=false
case "$TOOL_NAME" in
  Write|Edit|MultiEdit|NotebookEdit)
    MADE_PROGRESS=true
    ;;
  Bash)
    # Only Bash commands that directly create/modify files count as progress.
    # Running tests/builds is diagnostic, NOT progress — a stuck Runner could
    # loop "pnpm test" endlessly to evade the circuit breaker.
    case "$TOOL_INPUT" in
      *" > "*|*" >> "*|*"tee "*|*"mv "*|*"cp "*|*"mkdir "*)
        MADE_PROGRESS=true
        ;;
    esac
    ;;
esac

# ── Detect error pattern ──
ERROR_HASH=""
if [ -n "$TOOL_RESPONSE" ]; then
  # Extract first error-like line from response
  ERROR_LINE=$(echo "$TOOL_RESPONSE" | grep -i -m1 'error[: ]\|fatal[: ]\|FAILED\|panic[: ]\|exception[: ]' 2>/dev/null | head -c 200) || true
  if [ -n "$ERROR_LINE" ]; then
    # Create fingerprint: hash of tool_name + first 100 chars of error
    RAW_FP="${TOOL_NAME}:$(echo "$ERROR_LINE" | head -c 100)"
    ERROR_HASH=$(printf '%s' "$RAW_FP" | md5 -q 2>/dev/null || printf '%s' "$RAW_FP" | md5sum 2>/dev/null | cut -d' ' -f1) || true
  fi
fi

# ── Update state atomically ──
PREV_HASH=$(jq -r '.last_error_hash // ""' "$STATE_FILE" 2>/dev/null) || true

JQ_UPDATE='.tool_count += 1'

# Progress tracking
if [ "$MADE_PROGRESS" = true ]; then
  JQ_UPDATE="${JQ_UPDATE} | .no_progress = 0 | .progress_count += 1"
else
  JQ_UPDATE="${JQ_UPDATE} | .no_progress += 1"
fi

# Consecutive error tracking
if [ -n "$ERROR_HASH" ]; then
  if [ "$ERROR_HASH" = "$PREV_HASH" ]; then
    JQ_UPDATE="${JQ_UPDATE} | .consec_error += 1"
  else
    JQ_UPDATE="${JQ_UPDATE} | .consec_error = 1 | .last_error_hash = \"${ERROR_HASH}\""
  fi
else
  # No error — reset consecutive error counter
  JQ_UPDATE="${JQ_UPDATE} | .consec_error = 0 | .last_error_hash = \"\""
fi

UPD_TMP=$(mktemp "${STATE_DIR}/upd.XXXXXX") || exit 0
jq "$JQ_UPDATE" "$STATE_FILE" > "$UPD_TMP" 2>/dev/null && mv "$UPD_TMP" "$STATE_FILE" || { rm -f "$UPD_TMP"; exit 0; }

# ── Read updated counters ──
TOOL_COUNT=$(jq -r '.tool_count' "$STATE_FILE" 2>/dev/null) || exit 0
NO_PROGRESS=$(jq -r '.no_progress' "$STATE_FILE" 2>/dev/null) || exit 0
CONSEC_ERROR=$(jq -r '.consec_error' "$STATE_FILE" 2>/dev/null) || exit 0

# ── Evaluate thresholds ──
HARD_STOP=false
SOFT_WARN=false
REASON=""

# Signal 1: No-progress streak
if [ "$NO_PROGRESS" -ge "$NO_PROGRESS_HARD" ]; then
  HARD_STOP=true
  REASON="no-progress: ${NO_PROGRESS} consecutive tool calls without file changes (hard limit: ${NO_PROGRESS_HARD})"
elif [ "$NO_PROGRESS" -ge "$NO_PROGRESS_SOFT" ]; then
  SOFT_WARN=true
  REASON="no-progress: ${NO_PROGRESS} consecutive tool calls without file changes (soft limit: ${NO_PROGRESS_SOFT})"
fi

# Signal 2: Repeated error (takes priority if it triggers hard stop)
if [ "$CONSEC_ERROR" -ge "$ERROR_REPEAT_HARD" ]; then
  HARD_STOP=true
  REASON="repeated-error: same error ${CONSEC_ERROR} consecutive times (hard limit: ${ERROR_REPEAT_HARD})"
elif [ "$CONSEC_ERROR" -ge "$ERROR_REPEAT_SOFT" ] && [ "$SOFT_WARN" = false ]; then
  SOFT_WARN=true
  REASON="repeated-error: same error ${CONSEC_ERROR} consecutive times (soft limit: ${ERROR_REPEAT_SOFT})"
fi

# Signal 3: Total cap with recent no-progress
if [ "$TOOL_COUNT" -ge "$TOTAL_CAP" ] && [ "$NO_PROGRESS" -ge "$TOTAL_CAP_MIN_STREAK" ]; then
  HARD_STOP=true
  REASON="total-cap: ${TOOL_COUNT} tool calls total, ${NO_PROGRESS} recent with no progress (cap: ${TOTAL_CAP})"
fi

# ── Act ──

if [ "$HARD_STOP" = true ]; then
  PANE="${TMUX_PANE:-}"

  # Log to stderr (visible in tmux pane if remain-on-exit is on)
  echo "[circuit-breaker] HARD STOP: $REASON" >&2
  echo "[circuit-breaker] Stats: tool_count=$TOOL_COUNT no_progress=$NO_PROGRESS consec_error=$CONSEC_ERROR" >&2

  # Kill the tmux pane — TMUX_PANE is set by tmux for all processes in a pane
  if [ -n "$PANE" ]; then
    tmux kill-pane -t "$PANE" 2>/dev/null &
    # Background the kill so hook can exit cleanly; tmux server processes it async
  fi

  # Cleanup state file
  rm -f "$STATE_FILE" 2>/dev/null || true
  exit 0
fi

if [ "$SOFT_WARN" = true ]; then
  jq -n \
    --arg reason "$REASON" \
    --argjson tc "$TOOL_COUNT" \
    --argjson np "$NO_PROGRESS" \
    --argjson ce "$CONSEC_ERROR" \
    '{
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: (
          "CIRCUIT BREAKER WARNING — Approaching hard stop\n\n" +
          "Reason: " + $reason + "\n" +
          "Stats: tool_count=" + ($tc|tostring) + " no_progress=" + ($np|tostring) + " consec_error=" + ($ce|tostring) + "\n\n" +
          "To avoid termination:\n" +
          "1. Make meaningful file changes (Write/Edit) to reset the no-progress counter\n" +
          "2. If stuck on a repeated error, try a different approach\n" +
          "3. If the task is impossible, stop gracefully and report failure"
        )
      }
    }'
  exit 0
fi

# No threshold hit — silent exit (zero overhead to Claude conversation)
exit 0
