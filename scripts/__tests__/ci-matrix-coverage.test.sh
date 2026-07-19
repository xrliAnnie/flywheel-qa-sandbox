#!/usr/bin/env bash
# FLY-1338 QA — SEMANTIC coverage net for the sharded unit matrix.
#
# ci-structure.test.sh proves the matrix is SHAPED right (exact name/cmd literals,
# shard completeness, "every light exclusion is positively covered somewhere else").
# All of that is symbolic: it reasons about the filter STRINGS, never about which
# packages pnpm actually resolves them to. Its strongest assertion — the pinned
# name/cmd literal — is by construction CO-EDITED by whoever changes the matrix
# (change the row, update the pin, green again), so it detects an unintended drift
# but cannot judge whether the new filters still cover the workspace. Nor can a
# green CI run: a matrix that silently runs FEWER packages still passes.
#
# That is the gap this closes, and it is the issue's actual acceptance bar
# ("不牺牲覆盖"). It also catches drift the workflow file cannot see at all —
# a package added, renamed, or moved in the WORKSPACE while ci.yml stays untouched.
#
# So this asks pnpm itself, on the real workspace:
#   1. the union of all matrix rows == `./packages/*` (the pre-split test target)
#   2. the rows are pairwise disjoint (no package silently paid for twice)
# Shard rows target one package by design, so rows are compared by their filter
# set with any `--shard=k/N` removed; shard PARTITIONING is ci-structure's job.
#
# Hermetic: `pnpm list` reads the workspace manifest only — no network, no build,
# no test execution, nothing written.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"

fail() { echo "FAIL: $*" >&2; exit 1; }

command -v pnpm >/dev/null 2>&1 || fail "pnpm is required to resolve matrix filters"
[ -f "$WORKFLOW" ] || fail "missing $WORKFLOW"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. pull the matrix commands out of the REAL workflow (parsed, not grepped) ---
WORKFLOW="$WORKFLOW" python3 - "$WORK/rows.txt" <<'PY'
import os, re, sys, yaml

with open(os.environ["WORKFLOW"], encoding="utf-8") as handle:
    workflow = yaml.safe_load(handle)

include = workflow["jobs"]["unit-tests"]["strategy"]["matrix"]["include"]
seen, rows = set(), []
for entry in include:
    cmd = str(entry["cmd"])
    # Shard siblings differ ONLY by --shard=k/N and target the same package, so they
    # must be collapsed or "pairwise disjoint" would flag them against each other.
    # Collapse ONLY rows that actually carry a --shard flag: deduping on the stripped
    # command generally would also swallow a genuinely duplicated non-shard row, which
    # is exactly the overlap this check exists to catch (Codex R3).
    shard_flag = re.search(r"--shard=\d+/\d+", cmd)
    key = re.sub(r"\s*--shard=\d+/\d+", "", cmd).strip() if shard_flag else cmd.strip()
    if shard_flag:
        if key in seen:
            continue
        seen.add(key)
    rows.append(f"{entry['name']}\t{key}")

if not rows:
    sys.exit("no matrix rows found")
with open(sys.argv[1], "w", encoding="utf-8") as out:
    out.write("\n".join(rows) + "\n")
PY

# --- 2. resolve a pnpm filter expression to a sorted package-name list ---
resolve() {
  # shellcheck disable=SC2086  # filter flags must word-split into argv
  ( cd "$REPO_ROOT" && eval "pnpm $1 list --depth -1 --json" 2>/dev/null ) \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        let j; try { j = JSON.parse(s) } catch { j = [] }
        console.log(j.map(p=>p.name).filter(Boolean).sort().join("\n"))
      })'
}

# the pre-split baseline: exactly what `pnpm test:packages:run` targeted
resolve "--filter './packages/*'" | sed '/^$/d' | sort -u > "$WORK/baseline.txt"
baseline_count=$(wc -l < "$WORK/baseline.txt" | tr -d ' ')
[ "$baseline_count" -gt 0 ] || fail "baseline './packages/*' resolved to zero packages"

: > "$WORK/union.txt"
rc=0
while IFS="$(printf '\t')" read -r name cmd; do
  [ -n "${cmd:-}" ] || continue
  # keep only the --filter flags; drop the trailing script name (test:run)
  filters=$(printf '%s\n' "$cmd" \
    | sed -e 's/^pnpm //' -e 's/[[:space:]]*test:run[[:space:]]*$//')
  resolve "$filters" | sed '/^$/d' | sort -u > "$WORK/row.txt"
  row_count=$(wc -l < "$WORK/row.txt" | tr -d ' ')
  if [ "$row_count" -eq 0 ]; then
    echo "FAIL: matrix row '$name' resolves to ZERO packages (its tests never run)" >&2
    rc=1
  fi
  # pairwise disjoint: this row must not repeat work already claimed by another.
  # comm returns 0 even when the sets differ, so a non-zero exit is a REAL failure
  # (unsorted input, missing file, broken comm) and must fail closed, never `|| true`
  # — swallowing it made the whole check pass green under fault injection (Codex R3).
  if [ -s "$WORK/union.txt" ]; then
    sort -u "$WORK/union.txt" > "$WORK/union.running"
    if ! comm -12 "$WORK/row.txt" "$WORK/union.running" > "$WORK/overlap.txt"; then
      fail "comm failed while checking row '$name' for overlap"
    fi
    if [ -s "$WORK/overlap.txt" ]; then
      echo "FAIL: matrix row '$name' overlaps an earlier row: $(tr '\n' ' ' < "$WORK/overlap.txt")" >&2
      rc=1
    fi
  fi
  printf '%s\n' "$name -> $row_count package(s)"
  cat "$WORK/row.txt" >> "$WORK/union.txt"
done < "$WORK/rows.txt"

sort -u "$WORK/union.txt" > "$WORK/union.sorted"

# same fail-closed rule as the overlap check above: a non-zero comm is a broken
# comparison, not "no difference", and must never be masked into a green run.
if ! comm -23 "$WORK/baseline.txt" "$WORK/union.sorted" > "$WORK/missing.txt"; then
  fail "comm failed while diffing ./packages/* against the matrix union"
fi
if ! comm -13 "$WORK/baseline.txt" "$WORK/union.sorted" > "$WORK/extra.txt"; then
  fail "comm failed while diffing the matrix union against ./packages/*"
fi
missing=$(cat "$WORK/missing.txt")
extra=$(cat "$WORK/extra.txt")

if [ -n "$missing" ]; then
  echo "FAIL: package(s) in ./packages/* that NO matrix row runs — coverage lost:" >&2
  echo "$missing" | sed 's/^/  - /' >&2
  rc=1
fi
if [ -n "$extra" ]; then
  echo "FAIL: matrix runs package(s) outside ./packages/* — target drifted:" >&2
  echo "$extra" | sed 's/^/  - /' >&2
  rc=1
fi

[ "$rc" -eq 0 ] || exit 1

union_count=$(wc -l < "$WORK/union.sorted" | tr -d ' ')
echo "PASS: FLY-1338 matrix covers ./packages/* exactly ($union_count/$baseline_count packages, no overlap)"
