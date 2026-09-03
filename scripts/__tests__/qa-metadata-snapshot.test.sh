#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f2301-metadata.XXXXXX)"
trap 'chmod 600 "$TMP/home/000-secret" 2>/dev/null || true; rm -rf "$TMP"' EXIT
passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

snapshotter="$ROOT/scripts/lib/qa-metadata-snapshot.py"
mkdir -p "$TMP/home/sub"
printf '%s\n' z > "$TMP/home/z-last"
printf '%s\n' secret > "$TMP/home/000-secret"
printf '%s\n' a > "$TMP/home/a-first"
printf '%s\n' nested > "$TMP/home/sub/nested"
ln -s sub/nested "$TMP/home/link"
chmod 000 "$TMP/home/000-secret"

if snapshot_json=$(python3 "$snapshotter" "$TMP/home" 2>/dev/null) \
    && python3 - "$snapshot_json" <<'PY'
import base64
import json
import sys

value = json.loads(sys.argv[1])
assert value["schemaVersion"] == 1
assert len(value["sha256"]) == 64
entries = value["roots"][0]["entries"]
paths = [base64.b64decode(row["pathB64"]).decode() for row in entries]
assert paths == sorted(paths, key=lambda path: path.encode())
secret = next(row for row, path in zip(entries, paths) if path == "000-secret")
assert secret["type"] == "file" and secret["mode"] == "0000"
link = next(row for row, path in zip(entries, paths) if path == "link")
assert link["type"] == "symlink"
assert base64.b64decode(link["linkTargetB64"]).decode() == "sub/nested"
PY
then
  pass "metadata snapshot enumerates sorted lstat/readlink records without reading mode-000 files"
else
  fail "metadata snapshot canonical manifest"
fi

mutant="$TMP/qa-metadata-snapshot-mutant.py"
mutation_ready=1
python3 - "$snapshotter" "$mutant" <<'PY' || mutation_ready=0
from pathlib import Path
import sys

source, target = map(Path, sys.argv[1:])
body = source.read_text()
old = "        info = os.lstat(child)"
new = '        open(child, "rb").close(); info = os.lstat(child)'
if body.count(old) != 1:
    raise SystemExit(f"open mutation count was {body.count(old)}, expected 1")
target.write_text(body.replace(old, new))
PY
if [[ "$mutation_ready" == 1 ]] \
    && ! python3 "$mutant" "$TMP/home" >/dev/null 2>&1; then
  pass "regular-file open mutant fails on the unreadable sentinel"
else
  fail "metadata snapshot open mutant was non-discriminating"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
