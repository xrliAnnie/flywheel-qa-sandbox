#!/bin/bash
# FLY-2030: exact-head, cross-repository prefix fence for the paired M1 PRs.
set -euo pipefail

usage() {
  echo "Usage: $0 --raya-repo <path> --raya-head <sha> --flywheel-repo <path> --flywheel-head <sha>" >&2
  exit 64
}

PAIR_RAYA_REPO=""
PAIR_RAYA_HEAD=""
PAIR_FLYWHEEL_REPO=""
PAIR_FLYWHEEL_HEAD=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --raya-repo) PAIR_RAYA_REPO="${2:-}"; shift 2 ;;
    --raya-head) PAIR_RAYA_HEAD="${2:-}"; shift 2 ;;
    --flywheel-repo) PAIR_FLYWHEEL_REPO="${2:-}"; shift 2 ;;
    --flywheel-head) PAIR_FLYWHEEL_HEAD="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$PAIR_RAYA_REPO" ] && [ -n "$PAIR_RAYA_HEAD" ] \
  && [ -n "$PAIR_FLYWHEEL_REPO" ] && [ -n "$PAIR_FLYWHEEL_HEAD" ] || usage
[[ "$PAIR_RAYA_HEAD" =~ ^[a-f0-9]{40}$ ]] || { echo "invalid Raya head SHA" >&2; exit 1; }
[[ "$PAIR_FLYWHEEL_HEAD" =~ ^[a-f0-9]{40}$ ]] || { echo "invalid Flywheel head SHA" >&2; exit 1; }
git -C "$PAIR_RAYA_REPO" cat-file -e "${PAIR_RAYA_HEAD}^{commit}"
git -C "$PAIR_FLYWHEEL_REPO" cat-file -e "${PAIR_FLYWHEEL_HEAD}^{commit}"

extract_one() {
  local label="$1" value="$2"
  local count
  count="$(printf '%s\n' "$value" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$count" != 1 ]; then
    echo "${label}: expected exactly one canonical prefix declaration, got ${count}" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

raya_prefix="$(extract_one raya-readme "$(
  git -C "$PAIR_RAYA_REPO" show "${PAIR_RAYA_HEAD}:summaries/README.md" \
    | sed -n 's/.*single fixed prefix is `\([^`]*\)`.*/\1/p'
)")"
authority_prefix="$(extract_one flywheel-authority "$(
  git -C "$PAIR_FLYWHEEL_REPO" show "${PAIR_FLYWHEEL_HEAD}:packages/teamlead/lead-rules-base/founder-only-authority.md" \
    | sed -n 's/.*single fixed prefix `\([^`]*\)`.*/\1/p'
)")"
validator_prefix="$(extract_one flywheel-validator "$(
  git -C "$PAIR_FLYWHEEL_REPO" show "${PAIR_FLYWHEEL_HEAD}:packages/flywheel-comm/src/summary-contract.ts" \
    | sed -n 's/^[[:space:]]*export const SUMMARY_PREFIX = "\([^"]*\)";$/\1/p'
)")"

for observed in "$raya_prefix" "$authority_prefix" "$validator_prefix"; do
  if [ "$observed" != "summaries/" ]; then
    echo "prefix fence rejected '$observed' (expected summaries/)" >&2
    exit 1
  fi
done

printf '{"ok":true,"prefix":"summaries/","rayaHead":"%s","flywheelHead":"%s"}\n' \
  "$PAIR_RAYA_HEAD" "$PAIR_FLYWHEEL_HEAD"
