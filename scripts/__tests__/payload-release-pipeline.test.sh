#!/bin/bash
# FLY-1062 PR4 · release pipeline scripts against the REAL endpoint handler
# (hermetic: loopback serve.mjs + a FAKE packer + a fixture git repo; the real
# packer is covered by its own suites + the CI smoke).
#
#   R1  beta line full chain green (reserve→register→upload→prepared→commit)
#   R2  interruption injection at each step → rerun with the SAME releaseId is
#       idempotent: exactly one beta, no double ledger allocation
#   R3  same releaseId + different build output → fail-closed (write-once tuple)
#   P1  promote prepare (equivalence proven) + commit → customer view flips
#   P2  equivalence tamper → prepare fail-closed (no degraded pass)
#   P3  commit re-verification catches a swapped/corrupted artifact
#   P4  STRUCTURAL: zero build steps below the commit-path marker
#   W1  withdraw → quarantined + fallback re-pinned, customer view immediate
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v node >/dev/null 2>&1 || { echo "ERROR: node required"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git required"; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVE="$ROOT/packages/payload-endpoint/__tests__/serve.mjs"
RELEASE="$ROOT/scripts/release/payload-release.mjs"
PROMOTE="$ROOT/scripts/release/payload-promote.mjs"

SANDBOX="$(mktemp -d -t fly1062-pipeline-XXXXXX)"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$SANDBOX"; }
trap cleanup EXIT

BETA_TOKEN="beta-publish-test-token"
RELEASE_TOKEN="customer-release-test-token"
OPS_TOKEN="ops-admin-test-token"

# ── fixture git repo (sourceCommit discipline needs real commits) ────────────
FIX="$SANDBOX/repo"
mkdir -p "$FIX/doc"
echo "v9.9.9" > "$FIX/doc/VERSION"
echo "payload input v1" > "$FIX/content.txt"
git -C "$FIX" init -q && git -C "$FIX" add -A \
  && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm fixture

# ── FAKE packer: npm-shaped tarball whose payload = repo content.txt ─────────
# DETERMINISTIC like the real packer (npm pack pins entry mtimes): fixed
# mtimes + gzip -n, so a RERUN of the same input rebuilds the same sha256 —
# otherwise a second-boundary mtime drift would fake a tuple mismatch.
PACKER="$SANDBOX/fake-packer.sh"
cat > "$PACKER" <<'SH'
#!/bin/bash
# contract mirror of package-onboard.sh: --repo-root/--out, tarball path on
# the LAST stdout line, version = PO_RELEASE_VERSION (already validated by the
# real packer's derivation gate — mirrored here trivially).
set -euo pipefail
root=""; out=""
while [ "$#" -gt 0 ]; do case "$1" in
  --repo-root) root="$2"; shift 2 ;;
  --out) out="$2"; shift 2 ;;
  *) shift ;;
esac; done
ver="${PO_RELEASE_VERSION:?}"
stage="$(mktemp -d)/package"
mkdir -p "$stage/dist" "$out"
printf '{ "name": "fake-payload", "version": "%s" }\n' "$ver" > "$stage/package.json"
printf '%s\n' "$ver" > "$stage/.flywheel-prebuilt"
cp "$root/content.txt" "$stage/dist/content.txt"
find "$stage" -exec touch -t 202601010000 {} +
touch -t 202601010000 "$(dirname "$stage")"
tar -cf - -C "$(dirname "$stage")" package | gzip -n > "$out/fake-payload-$ver.tgz"
echo "$out/fake-payload-$ver.tgz"
SH
chmod +x "$PACKER"

# ── boot the real handler with an EMPTY (conditional-create) manifest ────────
node - "$ROOT" "$SANDBOX" <<'EOF'
const path = require("node:path");
const fs = require("node:fs");
const [root, sandbox] = process.argv.slice(2);
import(path.join(root, "packages/payload-endpoint/__tests__/harness.mjs")).then((h) => {
	fs.writeFileSync(path.join(sandbox, "seed-empty.json"), JSON.stringify(h.emptyManifest()));
});
EOF
SERVER_OUT="$SANDBOX/server.out"
FW_TEST_BETA_TOKEN="$BETA_TOKEN" FW_TEST_RELEASE_TOKEN="$RELEASE_TOKEN" \
  FW_TEST_OPS_TOKEN="$OPS_TOKEN" SERVE_SEED_MANIFEST="$SANDBOX/seed-empty.json" \
  node "$SERVE" > "$SERVER_OUT" 2>&1 &
SERVER_PID=$!
PORT=""
for _ in $(seq 1 40); do
  PORT="$(sed -n 's/^PORT //p' "$SERVER_OUT" 2>/dev/null | head -1)"
  [ -n "$PORT" ] && break; sleep 0.1
done
[ -n "$PORT" ] || { echo "ERROR: serve.mjs never bound"; exit 1; }
EP="http://127.0.0.1:$PORT"

run_release() { # $1=release-id, rest env-prefix pairs
  local id="$1"; shift
  env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" "$@" \
    node "$RELEASE" --release-id "$id" --repo-root "$FIX"
}
# run_release_auto — NO --release-id: the script derives beta-<HEAD sourceCommit>
# and dedups (scheduled-run form, plan §3 ⑤).
run_release_auto() {
  env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
    node "$RELEASE" --repo-root "$FIX"
}
manifest() { curl -s -H "Authorization: Bearer $OPS_TOKEN" "$EP/admin/manifest"; }
# jq_manifest <expr> — evaluate a TEST-AUTHORED (trusted, hardcoded in this
# file) accessor expression against the fetched manifest. new Function over a
# literal from this script only — no external input ever reaches it.
jq_manifest() { manifest | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(new Function("m","return ("+process.argv[1]+")")(m))})' "$1"; }

# ── R2a · abort after RESERVE → rerun completes, single allocation ──────────
run_release "run-A" FW_TEST_ABORT_AFTER=reserve >/dev/null 2>&1
RC=$?
if [ "$RC" -eq 42 ] && [ "$(jq_manifest 'm.releaseOps["run-A"].state')" = "reserved" ]; then
  pass "R2a reservation is durable before the crash point"
else
  fail "R2a expected durable reservation (rc=$RC)"
fi
if run_release "run-A" >/dev/null 2>&1 \
   && [ "$(jq_manifest 'm.releaseOps["run-A"].state')" = "committed" ] \
   && [ "$(jq_manifest 'm.channels["internal-beta"].latest')" = "9.9.9-beta.1" ] \
   && [ "$(jq_manifest 'm.releaseLedger["9.9.9"].nextBetaN')" = "2" ]; then
  pass "R1/R2a rerun completes the SAME pinned ver (9.9.9-beta.1), ledger advanced exactly once"
else
  fail "R1 rerun state wrong: $(manifest)"
fi

# ── R2b · abort after REGISTER (pre-upload crash) → orphan discoverable ──────
run_release "run-B" FW_TEST_ABORT_AFTER=register >/dev/null 2>&1 || true
OBJ="$(jq_manifest 'm.releaseOps["run-B"].objectKey')"
if [ "$(jq_manifest 'm.releaseOps["run-B"].state')" = "reserved" ] && [ -n "$OBJ" ] && [ "$OBJ" != "null" ] \
   && ! curl -s "$EP/__test__/objects" | grep -q "9.9.9-beta.2"; then
  pass "R2b crash between register and upload: claim visible in manifest, object absent (zero blind spots)"
else
  fail "R2b orphan not representable: $(manifest)"
fi
OUT_B="$(run_release "run-B" 2>&1)" && RC_B=0 || RC_B=$?
if [ "$RC_B" -eq 0 ] \
   && [ "$(jq_manifest 'm.releaseOps["run-B"].state')" = "committed" ]; then
  pass "R2b rerun continues from the durable claim to commit"
else
  fail "R2b rerun failed (rc=$RC_B): $OUT_B"
fi

# ── R2c · abort after UPLOAD → rerun tolerates 409 + readback + commit ───────
run_release "run-C" FW_TEST_ABORT_AFTER=upload >/dev/null 2>&1 || true
OUT_C="$(run_release "run-C" 2>&1)"
if grep -q "already present (retry)" <<<"$OUT_C" \
   && [ "$(jq_manifest 'm.releaseOps["run-C"].state')" = "committed" ]; then
  pass "R2c upload-landed-response-lost: 409 tolerated + readback + idempotent completion"
else
  fail "R2c rerun after upload-crash failed: $OUT_C"
fi

# ── R2d · full rerun of a committed id → idempotent, zero extra beta ─────────
BETAS_BEFORE="$(jq_manifest 'Object.keys(m.versions).filter(v=>v.includes("-beta.")).length')"
OUT_D="$(run_release "run-C" 2>&1)"
BETAS_AFTER="$(jq_manifest 'Object.keys(m.versions).filter(v=>v.includes("-beta.")).length')"
if grep -q "already committed" <<<"$OUT_D" && [ "$BETAS_BEFORE" = "$BETAS_AFTER" ]; then
  pass "R2d committed-response-lost rerun: idempotent success, zero second beta"
else
  fail "R2d rerun created state: $OUT_D"
fi

# ── R3 · same id, different build output → fail-closed ───────────────────────
run_release "run-E" FW_TEST_ABORT_AFTER=register >/dev/null 2>&1 || true
echo "payload input TAMPERED" > "$FIX/content.txt"
OUT_E="$(run_release "run-E" 2>&1)" && RC_E=0 || RC_E=$?
git -C "$FIX" checkout -q content.txt
if [ "$RC_E" -ne 0 ] && grep -q "DIFFERENT tuple" <<<"$OUT_E"; then
  pass "R3 same releaseId with a different artifact is refused (write-once tuple)"
else
  fail "R3 tuple overwrite not refused: $OUT_E"
fi

# ── P1 · promote prepare + commit ────────────────────────────────────────────
PREP="$(env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
  node "$PROMOTE" prepare --release-id "promo-1" --beta "9.9.9-beta.1" --repo-root "$FIX" 2>&1)"
if grep -q "equivalence proven" <<<"$PREP" && grep -q "PREPARED: candidate promo-1" <<<"$PREP" \
   && [ "$(jq_manifest 'm.releaseOps["promo-1"].state')" = "prepared" ]; then
  pass "P1a prepare: equivalence proven + durable prepared candidate"
else
  fail "P1a prepare failed: $PREP"
fi
COMMIT_OUT="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-1" 2>&1)"
if grep -q "COMMITTED: customer-release.latest = 9.9.9" <<<"$COMMIT_OUT" \
   && [ "$(jq_manifest 'm.versions["9.9.9"].derivedFromBeta')" = "9.9.9-beta.1" ] \
   && [ "$(jq_manifest 'm.versions["9.9.9"].sourceCommit === m.versions["9.9.9-beta.1"].sourceCommit')" = "true" ]; then
  pass "P1b commit: release entry with full lineage + pointer, one CAS"
else
  fail "P1b commit failed: $COMMIT_OUT"
fi

# ── P2 · equivalence tamper → fail-closed ───────────────────────────────────
# publish a fresh beta at a NEW commit, then drift the WORKING TREE (HEAD still
# matches the beta's sourceCommit, so the commit-discipline gate passes) — the
# clean build now differs from the beta payload and equivalence must refuse.
echo "payload input v2" > "$FIX/content.txt"
git -C "$FIX" add -A && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm v2
run_release "run-F" >/dev/null 2>&1 || { echo "FATAL: beta for P2 failed"; exit 1; }
BETA_F="$(jq_manifest 'm.releaseOps["run-F"].ver')"
echo "payload input v2-DRIFTED" > "$FIX/content.txt"   # uncommitted drift
PREP2="$(env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
  node "$PROMOTE" prepare --release-id "promo-2" --beta "$BETA_F" --repo-root "$FIX" 2>&1)" && RC2=0 || RC2=$?
git -C "$FIX" checkout -q content.txt
if [ "$RC2" -ne 0 ] && grep -q "EQUIVALENCE PROOF FAILED" <<<"$PREP2" && grep -q "fail-closed" <<<"$PREP2"; then
  pass "P2 equivalence tamper → fail-closed, no degraded pass"
else
  fail "P2 tampered clean build not refused: $PREP2"
fi

# ── P3 · commit re-verification catches a swapped artifact ───────────────────
PREP3="$(env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
  node "$PROMOTE" prepare --release-id "promo-3" --beta "$BETA_F" --repo-root "$FIX" 2>&1)" \
  || { fail "P3 setup prepare failed: $PREP3"; }
OBJ3="$(jq_manifest 'm.releaseOps["promo-3"].objectKey')"
curl -s -X POST -d "{\"key\":\"$OBJ3\"}" "$EP/__test__/corrupt" >/dev/null
COMMIT3="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-3" 2>&1)" && RC3=0 || RC3=$?
if [ "$RC3" -ne 0 ] && grep -q "sha256 mismatch" <<<"$COMMIT3"; then
  pass "P3 commit refuses a swapped/corrupted artifact (readback re-verification)"
else
  fail "P3 corrupted artifact not refused: $COMMIT3"
fi

# ── P4 · structural: zero build below the commit-path marker ─────────────────
MARKER_LINE="$(grep -n "COMMIT PATH — ZERO BUILD" "$PROMOTE" | head -1 | cut -d: -f1)"
if [ -n "$MARKER_LINE" ] \
   && ! tail -n "+$MARKER_LINE" "$PROMOTE" | grep -qE "FW_PACKER|PO_RELEASE_VERSION|package-onboard|proveEquivalence|untar"; then
  pass "P4 commit path contains zero build steps (structural contract holds)"
else
  fail "P4 build reference found below the commit-path marker"
fi

# ── W1 · withdraw → quarantine + fallback re-pin, view immediate ─────────────
# ship a second release (9.9.10) so 9.9.9 becomes the explicit fallback
echo "v9.9.10" > "$FIX/doc/VERSION"
git -C "$FIX" add -A && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm bump
run_release "run-G" >/dev/null 2>&1 || { echo "FATAL: beta for W1 failed"; exit 1; }
env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
  node "$PROMOTE" prepare --release-id "promo-4" --beta "9.9.10-beta.1" --repo-root "$FIX" >/dev/null 2>&1
env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-4" >/dev/null 2>&1
[ "$(jq_manifest 'm.channels["customer-release"].latest')" = "9.9.10" ] || { fail "W1 setup: 9.9.10 not live"; }
[ "$(jq_manifest 'm.versions["9.9.9"].retentionSince !== null')" = "true" ] || { fail "W1 setup: superseded 9.9.9 missing clock"; }
WD="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" withdraw --withdraw "9.9.10" --fallback "9.9.9" 2>&1)"
if grep -q "WITHDRAWN" <<<"$WD" \
   && [ "$(jq_manifest 'm.versions["9.9.10"].status')" = "quarantined" ] \
   && [ "$(jq_manifest 'm.channels["customer-release"].latest')" = "9.9.9" ] \
   && [ "$(jq_manifest 'm.versions["9.9.9"].retentionSince')" = "null" ]; then
  pass "W1 withdraw: quarantined + fallback re-pinned (retention clock reset server-side)"
else
  fail "W1 withdraw wrong: $WD $(manifest)"
fi
# customer view flips immediately (issue a key to look through the customer lens)
KEYSHA="$(node -e 'const c=require("node:crypto");console.log(c.createHash("sha256").update("fwk_"+"a".repeat(64)).digest("hex"))')"
curl -s -X PUT -H "Authorization: Bearer $OPS_TOKEN" -H "content-type: application/json" \
  -d '{"customerId":"t","entitlement":"customer","revoked":false}' "$EP/admin/key/$KEYSHA" >/dev/null
VIEW="$(curl -s -H "Authorization: Bearer fwk_$(printf 'a%.0s' $(seq 1 64))" "$EP/manifest")"
if grep -q '"latest":"9.9.9"' <<<"$VIEW" && ! grep -q '9.9.10' <<<"$VIEW"; then
  pass "W1b customer view: withdrawn version gone, latest = fallback (immediate)"
else
  fail "W1b customer view wrong: $VIEW"
fi

# ── R-auto · scheduled beta: deterministic releaseId + sourceCommit dedup ────
# runs LAST — it commits to the fixture repo (moves HEAD), so it must not
# precede the promote/withdraw scenarios that pin the earlier HEAD.
echo "auto-beta content" > "$FIX/content.txt"
git -C "$FIX" add -A && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm auto-beta
HEAD_SHA="$(git -C "$FIX" rev-parse HEAD)"
OUT_AUTO="$(run_release_auto 2>&1)" && RC_AUTO=0 || RC_AUTO=$?
if [ "$RC_AUTO" -eq 0 ] \
   && [ "$(jq_manifest "m.releaseOps['beta-$HEAD_SHA']?.state")" = "committed" ] \
   && [ "$(jq_manifest "m.releaseOps['beta-$HEAD_SHA']?.sourceCommit")" = "$HEAD_SHA" ]; then
  pass "R-auto scheduled beta derives deterministic releaseId=beta-<sourceCommit> and commits"
else
  fail "R-auto deterministic releaseId wrong (rc=$RC_AUTO): $OUT_AUTO"
fi
BETAS_BEFORE_AUTO="$(jq_manifest 'Object.keys(m.versions).filter(v=>v.includes("-beta.")).length')"
OUT_DEDUP="$(run_release_auto 2>&1)" && RC_DEDUP=0 || RC_DEDUP=$?
BETAS_AFTER_AUTO="$(jq_manifest 'Object.keys(m.versions).filter(v=>v.includes("-beta.")).length')"
if [ "$RC_DEDUP" -eq 0 ] && grep -q "already published" <<<"$OUT_DEDUP" \
   && [ "$BETAS_BEFORE_AUTO" = "$BETAS_AFTER_AUTO" ]; then
  pass "R-auto dedup: a second scheduled run on the same idle sourceCommit is a no-op (zero new beta.N)"
else
  fail "R-auto dedup failed (rc=$RC_DEDUP): $OUT_DEDUP"
fi

echo ""
echo "payload-release-pipeline: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
