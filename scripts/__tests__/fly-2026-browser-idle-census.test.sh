#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/fly-2026-browser-idle-census.mjs"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'ok %s - %s\n' "$PASS" "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'not ok %s - %s\n' "$((PASS + FAIL))" "$1"; }

if OUTPUT="$(node "$SCRIPT" 2>&1)"; then
  bad "accepted a missing presentation mode"
elif grep -q 'usage:' <<<"$OUTPUT"; then
  ok "rejects anything except --once --print"
else
  bad "failed without the usage contract"
fi

if SCRIPT_URL="file://$SCRIPT" node --input-type=module <<'NODE'
const { parseArgs } = await import(process.env.SCRIPT_URL);
const parsed = parseArgs(["--once", "--print"]);
if (!parsed.once || !parsed.print) process.exit(1);
let rejected = false;
try { parseArgs(["--once"]); }
catch (error) { rejected = /usage:/.test(String(error)); }
if (!rejected) process.exit(1);
NODE
then
  ok "accepts only the exact read-only mode"
else
  bad "argument parser widened the contract"
fi

if SCRIPT_URL="file://$SCRIPT" node --input-type=module <<'NODE'
const { censusExitCode } = await import(process.env.SCRIPT_URL);
if (censusExitCode({ status: "ok", singleDigit: true }) !== 0) process.exit(1);
if (censusExitCode({ status: "ok", singleDigit: false }) !== 1) process.exit(1);
if (censusExitCode({ status: "unknown", singleDigit: null }) !== 1) process.exit(1);
NODE
then
  ok "fails closed unless a healthy census is single-digit"
else
  bad "exit status accepted an unknown or double-digit census"
fi

if SCRIPT_URL="file://$SCRIPT" node --input-type=module <<'NODE'
const { relevantSourcePaths } = await import(process.env.SCRIPT_URL);
const expected = [
  "packages/teamlead/src/bridge/browser-idle-census.ts",
  "packages/teamlead/src/bridge/chrome-session-reaper.ts",
  "packages/teamlead/src/bridge/mcp-descendant-reaper.ts",
  "packages/teamlead/src/bridge/mcp-process-classifier.ts",
  "packages/teamlead/src/bridge/playwright-orphan-census.ts",
];
if (JSON.stringify(relevantSourcePaths) !== JSON.stringify(expected)) process.exit(1);
NODE
then
  ok "fresh-dist guard covers every classifier and sweep source"
else
  bad "fresh-dist source set is incomplete or unstable"
fi

TMP_REPO="$(mktemp -d)"
trap 'rm -rf "$TMP_REPO"' EXIT
SOURCE_PATH="packages/teamlead/src/bridge/browser-idle-census.ts"
mkdir -p "$TMP_REPO/$(dirname "$SOURCE_PATH")" "$TMP_REPO/packages/teamlead/dist"
printf 'export const marker = 1;\n' > "$TMP_REPO/$SOURCE_PATH"
git -C "$TMP_REPO" init -q
git -C "$TMP_REPO" add .
git -C "$TMP_REPO" -c user.name=test -c user.email=test@example.com commit -qm base
HEAD_SHA="$(git -C "$TMP_REPO" rev-parse HEAD)"
printf '{"artifactBuildSha":"%s"}\n' "$HEAD_SHA" > "$TMP_REPO/packages/teamlead/dist/build-identity.json"
if SCRIPT_URL="file://$SCRIPT" \
  HELPER_URL="file://$ROOT/scripts/fly-1867-playwright-orphan-census.mjs" \
  TARGET_REPO="$TMP_REPO" \
  SOURCE_PATH="$SOURCE_PATH" \
  node --input-type=module <<'NODE'
const { relevantSourcePaths } = await import(process.env.SCRIPT_URL);
const { assertFreshTeamleadDist } = await import(process.env.HELPER_URL);
assertFreshTeamleadDist(process.env.TARGET_REPO, relevantSourcePaths);
const { appendFileSync } = await import("node:fs");
appendFileSync(`${process.env.TARGET_REPO}/${process.env.SOURCE_PATH}`, "export const dirty = true;\n");
let rejected = false;
try { assertFreshTeamleadDist(process.env.TARGET_REPO, relevantSourcePaths); }
catch (error) { rejected = /teamlead_dist_source_dirty/.test(String(error)); }
if (!rejected) process.exit(1);
NODE
then
  ok "fresh-dist guard rejects a dirty FLY-2026 census source"
else
  bad "fresh-dist guard accepted a dirty FLY-2026 census source"
fi

if grep -q 'assertFreshTeamleadDist' "$SCRIPT" \
  && grep -q 'collectBrowserIdleCensus' "$SCRIPT" \
  && ! grep -Eq 'killProc|signalProc|process\.kill|StateStore|LeadAlert|Discord' "$SCRIPT"; then
  ok "presentation entry is read-only and fresh-dist guarded"
else
  bad "presentation entry gained mutation capability or lost freshness"
fi

printf '1..%s\n' "$((PASS + FAIL))"
printf '# pass=%s fail=%s\n' "$PASS" "$FAIL"
test "$FAIL" -eq 0
