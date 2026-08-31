#!/bin/bash
# FLY-1389 P1-d: machine-checkable acceptance rule — "run any installer from
# any directory; the GLOBAL config must contain zero temporary paths."
#
# READ-ONLY scanner over the global persistence surfaces:
#   1. ~/.flywheel/bin/*         — every symlink: broken target OR target
#                                  inside a temp/worktree checkout = violation
#   2. ~/.claude/plugins/known_marketplaces.json — `.source.path` AND
#                                  `.installLocation` (both shapes scanned;
#                                  parse failure is fail-closed = violation)
#   3. ~/.claude/settings.json   — hook command absolute-path tokens pointing
#                                  at temp/worktree checkouts (second net
#                                  behind the install-hooks.sh guard)
#
# Exit 0 = clean; exit 1 = violations (each printed). `--alert` additionally
# fires ONE summarizing lead-alert (claims.db dedup inside lead-alert.sh) —
# used by the converge mount; manual runs default to print-only.
#
# Judgment lives in scripts/lib/path-hygiene.sh (single truth with the
# writers' guards). Worktree detection is the .git-FILE shape of the owning
# repo root — never a naming heuristic (this repo's own worktrees don't
# carry /worktrees/ in their paths).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/path-hygiene.sh
source "${SCRIPT_DIR}/lib/path-hygiene.sh"

ALERT=0
MODE="global"
SOURCE_ROOT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    "")
      shift
      ;;
    --alert)
      ALERT=1
      shift
      ;;
    --source-tree)
      [ -n "${2:-}" ] || {
        echo "Usage: check-global-path-hygiene.sh [--alert] [--source-tree <repo-root>]" >&2
        exit 2
      }
      MODE="source"
      SOURCE_ROOT="$2"
      shift 2
      ;;
    *)
      echo "Usage: check-global-path-hygiene.sh [--alert] [--source-tree <repo-root>]" >&2
      exit 2
      ;;
  esac
done

ALERT_BIN="${FLYWHEEL_HYGIENE_ALERT_BIN:-${SCRIPT_DIR}/lead-alert.sh}"
ALERT_LEAD="${FLYWHEEL_HYGIENE_ALERT_LEAD:-flywheel-eng-lead}"
ALERT_PROJECT="${FLYWHEEL_HYGIENE_ALERT_PROJECT:-flywheel}"

VIOLATIONS=0
report() {  # <what> <detail>
  VIOLATIONS=$((VIOLATIONS + 1))
  echo "[path-hygiene] VIOLATION: $1 — $2"
}

if [ "$MODE" = "source" ]; then
  SOURCE_FINDINGS=""
  SOURCE_RC=0
  SOURCE_FINDINGS="$(path_hygiene_scan_registered_source_tree "$SOURCE_ROOT")" || SOURCE_RC=$?
  if [ "$SOURCE_RC" -ne 0 ]; then
    while IFS= read -r finding; do
      [ -n "$finding" ] || continue
      report "repository Homebrew precedence drift" "$finding"
    done <<<"$SOURCE_FINDINGS"
  fi
  if [ "$VIOLATIONS" -gt 0 ]; then
    echo "[path-hygiene] ${VIOLATIONS} violation(s) — repository PATH declarations must prefer native Homebrew"
    if [ "$ALERT" = "1" ] && [ -x "$ALERT_BIN" ]; then
      bash "$ALERT_BIN" \
        --lead "$ALERT_LEAD" --project "$ALERT_PROJECT" \
        --kind source_path_order_drift --severity severe \
        --title "repository Homebrew precedence: ${VIOLATIONS} violation(s)" \
        --body "check-global-path-hygiene.sh --source-tree found ${VIOLATIONS} declaration(s) that are missing, unreadable, or do not prefer /opt/homebrew/bin over /usr/local/bin (FLY-2190)." \
        --signature "source-path-order|${VIOLATIONS}" || true
    fi
    exit 1
  fi
  echo "[path-hygiene] clean — repository PATH declarations prefer native Homebrew"
  exit 0
fi

# ── 1. ~/.flywheel/bin symlinks ─────────────────────────────────────────────
BIN_DIR="${HOME}/.flywheel/bin"
if [ -d "$BIN_DIR" ]; then
  for link in "$BIN_DIR"/*; do
    [ -L "$link" ] || continue
    target="$(readlink "$link")"
    # Relative targets resolve against the link's own directory first.
    case "$target" in
      /*) : ;;
      *) target="$(dirname "$link")/$target" ;;
    esac
    if ! canon="$(path_hygiene_canonicalize "$target")"; then
      report "unresolvable symlink target" "$link -> $target"
      continue
    fi
    if [ ! -e "$canon" ]; then
      report "broken symlink" "$link -> $target"
      continue
    fi
    if path_hygiene_target_is_temp_or_worktree "$canon"; then
      report "symlink target inside a temp/worktree checkout" "$link -> $canon"
    fi
  done
fi

# ── 2. known_marketplaces.json (.source.path + .installLocation) ───────────
MP_FILE="${HOME}/.claude/plugins/known_marketplaces.json"
if [ -f "$MP_FILE" ]; then
  if ! MP_PATHS="$(jq -r '.. | objects | ((.source? | objects | .path?) // empty), (.installLocation? // empty)' "$MP_FILE" 2>/dev/null)"; then
    report "known_marketplaces.json unparseable (fail-closed)" "$MP_FILE"
  else
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      case "$p" in /*) : ;; *) continue ;; esac
      if [ ! -e "$p" ]; then
        report "marketplace path missing (cleaned worktree?)" "$p ($MP_FILE)"
      elif path_hygiene_target_is_temp_or_worktree "$p"; then
        report "marketplace path inside a temp/worktree checkout" "$p ($MP_FILE)"
      fi
    done <<<"$MP_PATHS"
  fi
fi

# ── 3. settings.json hook commands ─────────────────────────────────────────
ST_FILE="${HOME}/.claude/settings.json"
if [ -f "$ST_FILE" ]; then
  if ! ST_CMDS="$(jq -r '(.hooks? // {}) | to_entries[]?.value[]? | .hooks[]? | .command? // empty' "$ST_FILE" 2>/dev/null)"; then
    report "settings.json unparseable (fail-closed)" "$ST_FILE"
  else
    while IFS= read -r cmd; do
      [ -n "$cmd" ] || continue
      # Judge every absolute-path-looking token of the command string.
      for tok in $cmd; do
        case "$tok" in
          /*)
            if [ -e "$tok" ]; then
              if path_hygiene_target_is_temp_or_worktree "$tok"; then
                report "hook command path inside a temp/worktree checkout" "$tok ($ST_FILE)"
              fi
            else
              # Missing path: only flag clearly-temp textual shapes — a
              # broken generic path is a different bug class and flagging
              # every env-var-ish token would drown the signal.
              if canon="$(path_hygiene_canonicalize "$tok" 2>/dev/null)" \
                 && path_hygiene_is_temp_path "$canon"; then
                report "hook command path is a temp path" "$tok ($ST_FILE)"
              fi
            fi
            ;;
        esac
      done
    done <<<"$ST_CMDS"
  fi
fi

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "[path-hygiene] ${VIOLATIONS} violation(s) — global config references temporary paths (FLY-1389 discipline: doc/engineer/implementation/global-bin-symlink-discipline.md)"
  if [ "$ALERT" = "1" ] && [ -x "$ALERT_BIN" ]; then
    bash "$ALERT_BIN" \
      --lead "$ALERT_LEAD" --project "$ALERT_PROJECT" \
      --kind bin_integrity_drift --severity severe \
      --title "global path-hygiene: ${VIOLATIONS} violation(s)" \
      --body "check-global-path-hygiene.sh found ${VIOLATIONS} global config entr(ies) pointing at temp/worktree paths. Run it manually for the list; repoint via the main checkout / register-local-marketplace.sh (FLY-1389)." \
      --signature "path-hygiene|${VIOLATIONS}" || true
  fi
  exit 1
fi
echo "[path-hygiene] clean — no temporary paths in global config"
exit 0
