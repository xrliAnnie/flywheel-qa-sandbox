#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCAN="$REPO_ROOT/scripts/lead-memory/scan.sh"
TEMPLATE="$REPO_ROOT/scripts/lead-memory/repo-template"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2145-scan-real.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

MEMORY_REPO="$TASK_TMP_DIR/memory"
STATE_ROOT="$TASK_TMP_DIR/state"
LEAD_NAMES="cos-lead flywheel-cos-lead flywheel-eng-lead flywheel-product-lead joycon-lead ops-lead product-lead rafiki-lead reflection-lead sub-lead tidal-echo-content-lead tidal-echo-cos-lead"

git init -q -b main "$MEMORY_REPO"
for lead_name in $LEAD_NAMES; do
  mkdir -p "$MEMORY_REPO/$lead_name"
  printf '%s has an ordinary memory note\n' "$lead_name" >"$MEMORY_REPO/$lead_name/MEMORY.md"
  printf '%s has a second ordinary note\n' "$lead_name" >"$MEMORY_REPO/$lead_name/second.md"
  printf '%s has a third ordinary note\n' "$lead_name" >"$MEMORY_REPO/$lead_name/third.md"
done
cp "$TEMPLATE/.gitleaks.toml" "$MEMORY_REPO/.gitleaks.toml"
cp "$TEMPLATE/.gitleaksignore" "$MEMORY_REPO/.gitleaksignore"

env FLYWHEEL_STATE_DIR="$STATE_ROOT" "$SCAN" "$MEMORY_REPO"
grep -Fq -- '- status: PASS' "$MEMORY_REPO/SCAN-LEDGER.md"
grep -Fq 'Positive-Controls: `8/8 gitleaks mappings; 4/4 trufflehog mappings`' \
  "$MEMORY_REPO/SCAN-LEDGER.md"
printf 'ok - real gitleaks and trufflehog positive controls plus clean scan passed\n'
