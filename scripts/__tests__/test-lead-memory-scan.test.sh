#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCAN="$REPO_ROOT/scripts/lead-memory/scan.sh"
GUARD="$REPO_ROOT/scripts/lead-memory/lib/guard.sh"
TEMPLATE="$REPO_ROOT/scripts/lead-memory/repo-template"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2145-scan.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

PASSED=0
pass() { PASSED=$((PASSED + 1)); printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

expect_failure() {
  local label="$1" expected="$2"
  shift 2
  if "$@" >"$TASK_TMP_DIR/stdout" 2>"$TASK_TMP_DIR/stderr"; then
    fail "$label (unexpected success)"
  fi
  grep -Fq "$expected" "$TASK_TMP_DIR/stderr" || {
    sed 's/^/  /' "$TASK_TMP_DIR/stderr" >&2
    fail "$label (missing error: $expected)"
  }
  pass "$label"
}

LEAD_NAMES="cos-lead flywheel-cos-lead flywheel-eng-lead flywheel-product-lead joycon-lead ops-lead product-lead rafiki-lead reflection-lead sub-lead tidal-echo-content-lead tidal-echo-cos-lead"
REPO_ID=0
make_repo() {
  REPO_ID=$((REPO_ID + 1))
  MEMORY_REPO="$TASK_TMP_DIR/memory-$REPO_ID"
  mkdir -p "$MEMORY_REPO"
  git init -q -b main "$MEMORY_REPO"
  git -C "$MEMORY_REPO" config user.name "FLY-2145 Scan Test"
  git -C "$MEMORY_REPO" config user.email "fly2145-scan@example.test"
  for lead_name in $LEAD_NAMES; do
    mkdir -p "$MEMORY_REPO/$lead_name"
    printf '%s memory\n' "$lead_name" >"$MEMORY_REPO/$lead_name/MEMORY.md"
    printf '%s second note\n' "$lead_name" >"$MEMORY_REPO/$lead_name/second.md"
    printf '%s third note\n' "$lead_name" >"$MEMORY_REPO/$lead_name/third.md"
  done
  cp "$TEMPLATE/.gitleaks.toml" "$MEMORY_REPO/.gitleaks.toml"
  cp "$TEMPLATE/.gitleaksignore" "$MEMORY_REPO/.gitleaksignore"
}

FAKE_BIN="$TASK_TMP_DIR/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/gitleaks" <<'STUB'
#!/bin/sh
set -eu
if [ "${1:-}" = version ]; then printf '8.30.1\n'; exit 0; fi
printf 'gitleaks\t%s\n' "$*" >>"${SCANNER_CALLS:?}"
report=
scan_root=
previous=
for argument in "$@"; do
  if [ "$previous" = report ]; then report=$argument; previous=; continue; fi
  if [ "$previous" = root ]; then scan_root=$argument; previous=; continue; fi
  case $argument in
    --report-path) previous=report ;;
    dir) previous=root ;;
  esac
done
[ -n "$report" ] || { printf 'fake gitleaks: report path missing\n' >&2; exit 2; }
if echo "$scan_root" | grep -q positive-controls; then
  if [ -n "${CONTROL_FINGERPRINTS:-}" ]; then
    python3 - "$scan_root" >>"$CONTROL_FINGERPRINTS" <<'PY'
import hashlib
import os
import sys
from pathlib import Path

root = sys.argv[1]
digest = hashlib.sha256()
for current_root, directories, files in os.walk(root):
    directories.sort()
    files.sort()
    for name in files:
        path = os.path.join(current_root, name)
        relative = os.path.relpath(path, root).encode("utf-8")
        data = Path(path).read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
print(digest.hexdigest())
PY
  fi
  if [ "${BREAK_CONTROL:-0}" = 1 ]; then rule=wrong-rule; else rule=github-pat; fi
  cat >"$report" <<JSON
[
 {"RuleID":"$rule","File":"github.txt","StartLine":1,"Secret":"control-github"},
 {"RuleID":"aws-access-token","File":"aws.txt","StartLine":1,"Secret":"control-aws"},
 {"RuleID":"anthropic-api-key","File":"anthropic.txt","StartLine":1,"Secret":"control-anthropic"},
 {"RuleID":"slack-bot-token","File":"slack.txt","StartLine":1,"Secret":"control-slack"},
 {"RuleID":"private-key","File":"private-key.pem","StartLine":1,"Secret":"control-private"},
 {"RuleID":"generic-api-key","File":"generic-api.txt","StartLine":1,"Secret":"control-api"},
 {"RuleID":"generic-api-key","File":"generic-secret.txt","StartLine":1,"Secret":"control-secret"},
 {"RuleID":"generic-api-key","File":"generic-token.txt","StartLine":1,"Secret":"control-token"}
]
JSON
  exit 0
fi
if [ -n "${MUTATE_SOURCE:-}" ]; then
  printf 'arrived after immutable snapshot\n' >>"${LIVE_MEMORY_REPO:?}/sub-lead/MEMORY.md"
fi
if [ "${FAKE_GITLEAKS_FINDINGS:-0}" = 1 ]; then
  cat >"$report" <<'JSON'
[{"RuleID":"generic-api-key","File":"sub-lead/MEMORY.md","StartLine":1,"Secret":"fixture-gitleaks-value"}]
JSON
else
  printf '[]\n' >"$report"
fi
STUB

cat >"$FAKE_BIN/trufflehog" <<'STUB'
#!/bin/sh
set -eu
if [ "${1:-}" = --version ]; then printf 'trufflehog 3.97.2\n'; exit 0; fi
printf 'trufflehog\t%s\n' "$*" >>"${SCANNER_CALLS:?}"
scan_root=${2:-}
if echo "$scan_root" | grep -q positive-controls; then
  cat <<'JSON'
{"DetectorName":"AWS","Raw":"control-aws","SourceMetadata":{"Data":{"Filesystem":{"file":"aws.txt"}}}}
{"DetectorName":"Anthropic","Raw":"control-anthropic","SourceMetadata":{"Data":{"Filesystem":{"file":"anthropic.txt"}}}}
{"DetectorName":"Github","Raw":"control-github","SourceMetadata":{"Data":{"Filesystem":{"file":"github.txt"}}}}
{"DetectorName":"Slack","Raw":"control-slack","SourceMetadata":{"Data":{"Filesystem":{"file":"slack.txt"}}}}
JSON
  exit 0
fi
case ${FAKE_TRUFFLE_FINDINGS:-0} in
  0) ;;
  1)
    printf '%s\n' '{"DetectorName":"Fixture","Raw":"fixture-truffle-value-one","SourceMetadata":{"Data":{"Filesystem":{"file":"sub-lead/MEMORY.md"}}}}'
    ;;
  2)
    printf '%s\n' '{"DetectorName":"Fixture","Raw":"fixture-truffle-value-one","SourceMetadata":{"Data":{"Filesystem":{"file":"sub-lead/MEMORY.md"}}}}'
    printf '%s\n' '{"DetectorName":"Fixture","Raw":"fixture-truffle-value-two","SourceMetadata":{"Data":{"Filesystem":{"file":"sub-lead/MEMORY.md"}}}}'
    ;;
esac
STUB
chmod +x "$FAKE_BIN/gitleaks" "$FAKE_BIN/trufflehog"

SCANNER_CALLS="$TASK_TMP_DIR/scanner.calls"
STATE_ROOT="$TASK_TMP_DIR/state"
export SCANNER_CALLS

make_repo
LIVE_MEMORY_REPO="$MEMORY_REPO"
export LIVE_MEMORY_REPO
env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" MUTATE_SOURCE=1 \
  "$SCAN" "$MEMORY_REPO"
LEDGER="$MEMORY_REPO/SCAN-LEDGER.md"
test -f "$LEDGER" || fail "clean scan atomically publishes a ledger"
pass "clean scan atomically publishes a ledger"
grep -Eq '^Scanned-Tree: `[0-9a-f]{40,64}`$' "$LEDGER" || fail "ledger records scanned tree"
pass "ledger records scanned tree"
test "$(grep -c '^| `040000 tree .*` |$' "$LEDGER")" = 12 ||
  fail "ledger records twelve name-to-child-tree mappings"
pass "ledger records twelve name-to-child-tree mappings"
grep -Fq '| Path | Blob OID | Disposition | Reviewer | Date |' "$LEDGER" ||
  fail "manual reviews are bound to immutable blob OIDs"
test "$(grep -Ec '^\| `[^`]+` \| `[0-9a-f]{40,64}` \| REVIEW_REQUIRED \|  \|  \|$' "$LEDGER")" = 36 ||
  fail "ledger lists three blob-bound manual-review samples for every Lead folder"
pass "ledger lists three blob-bound manual-review samples for every Lead folder"
if ! grep -Fq 'Gitleaks: `8.30.1`' "$LEDGER" ||
  ! grep -Fq 'TruffleHog: `3.97.2`' "$LEDGER"; then
  fail "ledger records exact scanner versions"
fi
pass "ledger records exact scanner versions"
MEMORY_REPO_PHYSICAL="$(cd "$MEMORY_REPO" && pwd -P)"
grep -Fq -- "--gitleaks-ignore-path $MEMORY_REPO_PHYSICAL/.gitleaksignore" "$SCANNER_CALLS" ||
  fail "gitleaks receives the exact runtime ignore path"
pass "gitleaks receives the exact runtime ignore path"
grep -Fq -- '--no-update --fail-on-scan-errors --no-verification' "$SCANNER_CALLS" ||
  fail "trufflehog receives every fail-loud and privacy flag"
pass "trufflehog receives every fail-loud and privacy flag"
test -z "$(find "$STATE_ROOT/state/lead-memory/scan" -type d -name snapshot -print -quit)" ||
  fail "immutable scan snapshot is removed after scanning"
pass "immutable scan snapshot is removed after scanning"

SCANNED_TREE="$(sed -n 's/^Scanned-Tree: `\([^`]*\)`$/\1/p' "$LEDGER")"
git -C "$MEMORY_REPO" add sub-lead/MEMORY.md
CANDIDATE_TREE="$(git -C "$MEMORY_REPO" write-tree)"
(
  cd "$MEMORY_REPO"
  "$GUARD" lead-tree "$CANDIDATE_TREE"
) >"$TASK_TMP_DIR/mutated-tree"
MUTATED_TREE="$(awk -F '\t' 'NR == 1 { print $2 }' "$TASK_TMP_DIR/mutated-tree")"
test "$MUTATED_TREE" != "$SCANNED_TREE" ||
  fail "post-scan live mutation cannot satisfy the scanned-tree assertion"
pass "post-scan live mutation cannot satisfy the scanned-tree assertion"

awk 'BEGIN { FS=OFS="|" }
  /`sub-lead\/MEMORY.md`/ && /REVIEW_REQUIRED/ {
    $4=" reviewed: no credential material "; $5=" Test Reviewer "; $6=" 2026-09-03 "
  }
  { print }
' "$LEDGER" >"$TASK_TMP_DIR/ledger-reviewed-sample"
mv "$TASK_TMP_DIR/ledger-reviewed-sample" "$LEDGER"
env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" \
  "$SCAN" "$MEMORY_REPO"
grep -E '^\| `sub-lead/MEMORY.md` \| `[0-9a-f]{40,64}` \| REVIEW_REQUIRED \|  \|  \|$' "$LEDGER" >/dev/null ||
  fail "changed sampled content resets its prior manual review"
pass "changed sampled content resets its prior manual review"

make_repo
LIVE_MEMORY_REPO="$MEMORY_REPO"
export LIVE_MEMORY_REPO
expect_failure "open findings fail closed after publishing value-free review rows" \
  "open findings require disposition" \
  env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" \
    FAKE_GITLEAKS_FINDINGS=1 FAKE_TRUFFLE_FINDINGS=1 "$SCAN" "$MEMORY_REPO"
LEDGER="$MEMORY_REPO/SCAN-LEDGER.md"
grep -Fq 'gitleaks:generic-api-key:sub-lead/MEMORY.md:' "$LEDGER" ||
  fail "ledger contains the gitleaks value-free fingerprint"
grep -Fq 'trufflehog:Fixture:sub-lead/MEMORY.md:' "$LEDGER" ||
  fail "ledger contains the trufflehog value-free fingerprint"
if grep -Fq 'fixture-gitleaks-value' "$LEDGER" || grep -Fq 'fixture-truffle-value' "$LEDGER"; then
  fail "ledger must never contain a matched value"
fi
pass "ledger contains fingerprints but no matched values"

awk 'BEGIN { FS=OFS="|" }
  /gitleaks:generic-api-key:/ && /PENDING/ {
    $3=" rotated+redacted: fixture "; $4=" Test Reviewer "; $5=" 2026-09-03 "
  }
  /trufflehog:Fixture:/ && /PENDING/ {
    $3=" false-positive: fixture "; $4=" Test Reviewer "; $5=" 2026-09-03 "
  }
  { print }
' "$LEDGER" >"$TASK_TMP_DIR/ledger-disposed"
mv "$TASK_TMP_DIR/ledger-disposed" "$LEDGER"
env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" \
  FAKE_GITLEAKS_FINDINGS=0 FAKE_TRUFFLE_FINDINGS=1 "$SCAN" "$MEMORY_REPO"
if grep -Fq 'PENDING' "$LEDGER"; then fail "disposed retained finding reaches terminal success"; fi
pass "disposed retained finding reaches terminal success"

expect_failure "a neighboring new finding invalidates the prior disposition" \
  "open findings require disposition" \
  env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" \
    FAKE_GITLEAKS_FINDINGS=0 FAKE_TRUFFLE_FINDINGS=2 "$SCAN" "$MEMORY_REPO"
test "$(grep -c 'trufflehog:Fixture:sub-lead/MEMORY.md:' "$LEDGER")" -ge 2 ||
  fail "new neighboring finding receives a distinct fingerprint"
pass "new neighboring finding receives a distinct fingerprint"

make_repo
LIVE_MEMORY_REPO="$MEMORY_REPO"
export LIVE_MEMORY_REPO
CONTROL_FINGERPRINTS="$TASK_TMP_DIR/control-fingerprints"
export CONTROL_FINGERPRINTS
env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" \
  "$SCAN" "$MEMORY_REPO"
env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" \
  "$SCAN" "$MEMORY_REPO"
unset CONTROL_FINGERPRINTS
test "$(wc -l <"$TASK_TMP_DIR/control-fingerprints" | tr -d ' ')" = 2 ||
  fail "two independent scans record two positive-control fingerprints"
test "$(sed -n '1p' "$TASK_TMP_DIR/control-fingerprints")" = \
  "$(sed -n '2p' "$TASK_TMP_DIR/control-fingerprints")" ||
  fail "positive-control samples are stable across independent runs"
pass "positive-control samples are stable across independent runs"

make_repo
LIVE_MEMORY_REPO="$MEMORY_REPO"
export LIVE_MEMORY_REPO
expect_failure "wrong positive-control mapping aborts before ledger publication" \
  "positive-control mapping failed" \
  env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" \
    BREAK_CONTROL=1 "$SCAN" "$MEMORY_REPO"
test ! -e "$MEMORY_REPO/SCAN-LEDGER.md" || fail "failed positive controls publish no ledger"
pass "failed positive controls publish no ledger"

expect_failure "scan has no skip command-line switch" \
  "unknown argument" \
  env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" \
    "$SCAN" --skip "$MEMORY_REPO"
expect_failure "scan has no no-scan command-line switch" \
  "unknown argument" \
  env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" \
    "$SCAN" --no-scan "$MEMORY_REPO"

CALLS_BEFORE="$(wc -l <"$SCANNER_CALLS" | tr -d ' ')"
env PATH="$FAKE_BIN:/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE_ROOT" SKIP_SCAN=1 \
  "$SCAN" "$MEMORY_REPO"
CALLS_AFTER="$(wc -l <"$SCANNER_CALLS" | tr -d ' ')"
test "$CALLS_AFTER" -ge $((CALLS_BEFORE + 4)) ||
  fail "skip-like environment variables do not suppress either scanner or controls"
pass "skip-like environment variables do not suppress either scanner or controls"

if [ -n "${FLY2145_REAL_GITLEAKS_BIN:-}" ]; then
  test "$($FLY2145_REAL_GITLEAKS_BIN version)" = 8.30.1 ||
    fail "CI-provided real gitleaks must be exactly 8.30.1"
  MIXED_BIN="$TASK_TMP_DIR/mixed-bin"
  mkdir -p "$MIXED_BIN"
  cp "$FAKE_BIN/trufflehog" "$MIXED_BIN/trufflehog"
  make_repo
  LIVE_MEMORY_REPO="$MEMORY_REPO"
  export LIVE_MEMORY_REPO
  env PATH="$(dirname "$FLY2145_REAL_GITLEAKS_BIN"):$MIXED_BIN:/usr/bin:/bin" \
    FLYWHEEL_STATE_DIR="$STATE_ROOT" "$SCAN" "$MEMORY_REPO"
  grep -Fq -- '- status: PASS' "$MEMORY_REPO/SCAN-LEDGER.md" ||
    fail "real gitleaks positive controls and clean snapshot pass"
  pass "real gitleaks 8.30.1 runs the positive controls in the CI-capable suite"
fi

printf 'RESULTS: %d passed\n' "$PASSED"
