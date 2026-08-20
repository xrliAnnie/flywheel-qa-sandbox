#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/fly-1867-playwright-orphan-census.mjs"
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
const { assertFreshBuildIdentity } = await import(process.env.SCRIPT_URL);
let failed = false;
try { assertFreshBuildIdentity({ artifactBuildSha: "old" }, "head"); }
catch (error) { failed = /teamlead_dist_stale/.test(String(error)); }
if (!failed) process.exit(1);
NODE
then
  ok "rejects a stale dist identity"
else
  bad "accepted a stale dist identity"
fi

if SCRIPT_URL="file://$SCRIPT" node --input-type=module <<'NODE'
const { assertFreshBuildIdentity, parseArgs } = await import(process.env.SCRIPT_URL);
assertFreshBuildIdentity({ artifactBuildSha: "head" }, "head");
const parsed = parseArgs(["--once", "--print"]);
if (!parsed.once || !parsed.print) process.exit(1);
NODE
then
  ok "accepts an exact fresh identity and read-only mode"
else
  bad "rejected the fresh read-only contract"
fi

TMP_REPO="$(mktemp -d)"
trap 'rm -rf "$TMP_REPO"' EXIT
mkdir -p "$TMP_REPO/packages/teamlead/dist" "$TMP_REPO/packages/teamlead/src/bridge"
printf 'export const marker = 1;\n' > "$TMP_REPO/packages/teamlead/src/bridge/source.ts"
git -C "$TMP_REPO" init -q
git -C "$TMP_REPO" add .
git -C "$TMP_REPO" -c user.name=test -c user.email=test@example.com commit -qm base
HEAD_SHA="$(git -C "$TMP_REPO" rev-parse HEAD)"
printf '{"artifactBuildSha":"%s"}\n' "$HEAD_SHA" > "$TMP_REPO/packages/teamlead/dist/build-identity.json"
if SCRIPT_URL="file://$SCRIPT" TARGET_REPO="$TMP_REPO" node --input-type=module <<'NODE'
const { assertFreshTeamleadDist } = await import(process.env.SCRIPT_URL);
assertFreshTeamleadDist(process.env.TARGET_REPO, ["packages/teamlead/src/bridge/source.ts"]);
NODE
then
  ok "accepts fresh dist only when the relevant source tree is clean"
else
  bad "rejected a fresh dist with clean relevant sources"
fi
printf 'export const marker = 2;\n' > "$TMP_REPO/packages/teamlead/src/bridge/source.ts"
if SCRIPT_URL="file://$SCRIPT" TARGET_REPO="$TMP_REPO" node --input-type=module <<'NODE'
const { assertFreshTeamleadDist } = await import(process.env.SCRIPT_URL);
let failed = false;
try { assertFreshTeamleadDist(process.env.TARGET_REPO, ["packages/teamlead/src/bridge/source.ts"]); }
catch (error) { failed = /teamlead_dist_source_dirty/.test(String(error)); }
if (!failed) process.exit(1);
NODE
then
  ok "rejects HEAD-matching dist when a relevant source is dirty"
else
  bad "accepted a HEAD-matching dist built from an unverified working tree"
fi

printf '1..%s\n' "$((PASS + FAIL))"
printf '# pass=%s fail=%s\n' "$PASS" "$FAIL"
test "$FAIL" -eq 0
