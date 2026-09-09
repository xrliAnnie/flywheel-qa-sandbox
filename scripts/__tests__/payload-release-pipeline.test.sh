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
#   R4  beta single-winner sweep (reserve + scheduled dedup), with strict
#       terminal/kind guards and abandoned-id refusal
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
  FW_TEST_OPS_TOKEN="$OPS_TOKEN" FW_TEST_WEAK_ETAG=1 \
  FW_TEST_REQUIRE_CANONICAL_BASE_ETAG=1 \
  SERVE_SEED_MANIFEST="$SANDBOX/seed-empty.json" \
  node "$SERVE" > "$SERVER_OUT" 2>&1 &
SERVER_PID=$!
PORT=""
for _ in $(seq 1 40); do
  PORT="$(sed -n 's/^PORT //p' "$SERVER_OUT" 2>/dev/null | head -1)"
  [ -n "$PORT" ] && break; sleep 0.1
done
[ -n "$PORT" ] || { echo "ERROR: serve.mjs never bound"; exit 1; }
EP="http://127.0.0.1:$PORT"

ETAG_HEADER="$(curl -sS -D - -o /dev/null -H "Authorization: Bearer $OPS_TOKEN" "$EP/admin/manifest" | tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//p')"
if [[ "$ETAG_HEADER" == W/\"*\" ]]; then
  pass "E1 harness exposes the production weak-ETag shape"
else
  fail "E1 harness did not weaken the manifest ETag: $ETAG_HEADER"
fi

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
  pass "E1/R1/R2a weak-ETag rerun completes the SAME pinned ver (9.9.9-beta.1), ledger advanced exactly once"
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
SHA_P1="$(jq_manifest 'm.releaseOps["promo-1"].sha256')"
COMMIT_OUT="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-1" --expected-sha256 "$SHA_P1" 2>&1)"
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
SHA_P3="$(jq_manifest 'm.releaseOps["promo-3"].sha256')"
COMMIT3="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-3" --expected-sha256 "$SHA_P3" 2>&1)" && RC3=0 || RC3=$?
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
  node "$PROMOTE" commit --release-id "promo-4" --expected-sha256 "$(jq_manifest 'm.releaseOps["promo-4"].sha256')" >/dev/null 2>&1
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

# ── P6 · FLY-1323 · commit --expected-sha256 binds the founder's approval ────
# The founder-direct publish must bind approval to the candidate tuple, so
# `commit` must accept the approved sha256 and refuse
# fail-closed on any mismatch. An unknown flag must NEVER be silently ignored —
# a flag that looks like a control but does nothing is worse than no control.
# fresh beta at a NEW commit — 9.9.9-beta.1 was already promoted by P1 and a
# clean semver is never reused, so P6 must mint its own promotable candidate.
echo "payload input v6" > "$FIX/content.txt"
echo "v9.9.60" > "$FIX/doc/VERSION"   # fresh clean semver — 9.9.9/9.9.10 are taken by P1/W1
git -C "$FIX" add -A && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm v6
run_release "run-P6" >/dev/null 2>&1 || { echo "FATAL: beta for P6 failed"; exit 1; }
BETA_P6="$(jq_manifest 'm.releaseOps["run-P6"].ver')"
PREP6="$(env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
  node "$PROMOTE" prepare --release-id "promo-6" --beta "$BETA_P6" --repo-root "$FIX" 2>&1)" \
  || { echo "FATAL: P6 prepare failed: $PREP6"; exit 1; }
GOOD_SHA="$(jq_manifest 'm.releaseOps["promo-6"].sha256')"

# P6a · wrong expected sha → refuse, and DO NOT flip the customer pointer
PTR_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
BAD="$(printf 'b%.0s' $(seq 1 64))"
OUT_6A="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6" --expected-sha256 "$BAD" 2>&1)" && RC_6A=0 || RC_6A=$?
PTR_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
if [ "$RC_6A" -ne 0 ] && grep -qi "expected-sha256" <<<"$OUT_6A" && [ "$PTR_BEFORE" = "$PTR_AFTER" ]; then
  pass "P6a commit --expected-sha256 mismatch is refused fail-closed (pointer untouched)"
else
  fail "P6a mismatch not refused (rc=$RC_6A, ptr ${PTR_BEFORE} then ${PTR_AFTER}): $OUT_6A"
fi

# P6b · unknown flag must be REJECTED, never silently ignored (the FLY-1323 bug:
# `--sha256` was accepted-looking but dropped, faking a binding that never existed)
OUT_6B="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6" --sha256 "$GOOD_SHA" 2>&1)" && RC_6B=0 || RC_6B=$?
if [ "$RC_6B" -ne 0 ] && grep -qi "unknown" <<<"$OUT_6B"; then
  pass "P6b unknown flag (--sha256) is rejected, never silently ignored"
else
  fail "P6b unknown flag silently accepted (rc=$RC_6B): $OUT_6B"
fi

# P6c · correct expected sha → commits
OUT_6C="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6" --expected-sha256 "$GOOD_SHA" 2>&1)" && RC_6C=0 || RC_6C=$?
if [ "$RC_6C" -eq 0 ] && grep -q "COMMITTED" <<<"$OUT_6C"; then
  pass "P6c commit --expected-sha256 matching the candidate proceeds"
else
  fail "P6c matching expected sha refused (rc=$RC_6C): $OUT_6C"
fi

# P6d · commit WITHOUT --expected-sha256 is REFUSED (Codex design R2: an
# optional binding is not a binding; nothing needs the unbound form and keeping
# it would only preserve a footgun.)
echo "payload input v6d" > "$FIX/content.txt"
echo "v9.9.70" > "$FIX/doc/VERSION"   # fresh clean semver — 9.9.9/9.9.10 are taken by P1/W1
git -C "$FIX" add -A && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm v6d
run_release "run-P6D" >/dev/null 2>&1 || { echo "FATAL: beta for P6d failed"; exit 1; }
BETA_P6D="$(jq_manifest 'm.releaseOps["run-P6D"].ver')"
PREP6D="$(env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
  node "$PROMOTE" prepare --release-id "promo-6d" --beta "$BETA_P6D" --repo-root "$FIX" 2>&1)" \
  || { echo "FATAL: P6d prepare failed: $PREP6D"; exit 1; }
PTR_6D_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
OUT_6D="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6d" 2>&1)" && RC_6D=0 || RC_6D=$?
PTR_6D_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
if [ "$RC_6D" -ne 0 ] && grep -qi "expected-sha256 <64hex> required" <<<"$OUT_6D" \
   && [ "$PTR_6D_BEFORE" = "$PTR_6D_AFTER" ]; then
  pass "P6d commit WITHOUT --expected-sha256 is refused (an optional binding is not a binding)"
else
  fail "P6d unbound commit not refused (rc=$RC_6D, ptr ${PTR_6D_BEFORE} then ${PTR_6D_AFTER}): $OUT_6D"
fi

# P6e · the --flag=value form must NOT silently bypass the binding (Codex R2):
# argValue() matches only an exact `--expected-sha256` argv item, so the equals
# form would read back as ABSENT — the same silent-drop class as P6b.
SHA_6E="$(jq_manifest 'm.releaseOps["promo-6d"].sha256')"
PTR_6E_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
OUT_6E="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6d" --expected-sha256="$SHA_6E" 2>&1)" && RC_6E=0 || RC_6E=$?
PTR_6E_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
if [ "$RC_6E" -ne 0 ] && grep -qi "not supported" <<<"$OUT_6E" \
   && [ "$PTR_6E_BEFORE" = "$PTR_6E_AFTER" ]; then
  pass "P6e --expected-sha256=<hex> equals-form is refused, never read as absent"
else
  fail "P6e equals-form bypassed the binding (rc=$RC_6E): $OUT_6E"
fi

# P6f · a dangling `--expected-sha256` with no value must not read as absent.
# Codex code R3: this test USED TO BE VACUOUS and I had claimed it mutation-
# verified. It accepted "required" OR "64-char" — two DIFFERENT guards — so
# deleting the missing-value guard merely fell into the format guard and P6f
# stayed green. It now pins ONLY the dangling-flag diagnostic, which exactly one
# guard emits. (Absent-flag → P6d's "required"; malformed value → P6i's format
# message. One test, one guard.)
#
# NOTE: narrowing P6f REMOVED the only thing that ever touched the format guard
# — and it only touched it by accident, via the "64-char" alternative that made
# P6f vacuous. P6a is a MISMATCH test (valid hex, wrong value), not a format
# test. So P6i below is not a nice-to-have: without it, tightening P6f would
# have traded one vacuous test for one uncovered guard.
PTR_6F_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
OUT_6F="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6d" --expected-sha256 2>&1)" && RC_6F=0 || RC_6F=$?
PTR_6F_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
if [ "$RC_6F" -ne 0 ] && grep -q "requires a value but none followed it" <<<"$OUT_6F" \
   && [ "$PTR_6F_BEFORE" = "$PTR_6F_AFTER" ]; then
  pass "P6f dangling --expected-sha256 (no value) is refused, never read as absent"
else
  fail "P6f dangling flag not refused (rc=$RC_6F, ptr ${PTR_6F_BEFORE} then ${PTR_6F_AFTER}): $OUT_6F"
fi

# P6i · a malformed NON-EMPTY hash must be refused by the FORMAT guard. This is
# the coverage the vacuous P6f was accidentally standing in for: P6a proves a
# well-formed but WRONG hash is refused; nothing proved a value that is not a
# sha256 at all is refused. Pins the format diagnostic only.
PTR_6I_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
OUT_6I="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6d" --expected-sha256 "not-a-sha256" 2>&1)" \
  && RC_6I=0 || RC_6I=$?
PTR_6I_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
if [ "$RC_6I" -ne 0 ] && grep -q "must be a 64-char lowercase hex sha256" <<<"$OUT_6I" \
   && [ "$PTR_6I_BEFORE" = "$PTR_6I_AFTER" ]; then
  pass "P6i malformed --expected-sha256 value is refused by the format guard (pointer untouched)"
else
  fail "P6i malformed hash not refused (rc=$RC_6I, ptr ${PTR_6I_BEFORE} then ${PTR_6I_AFTER}): $OUT_6I"
fi

# P6j / P6k · FLY-1323 (Codex code R3 MEDIUM-2) · the argv surface is closed for
# EVERY spelling, not just `--`-prefixed ones. The old scan did `continue` on any
# token not starting with `--`, so a trailing positional or a `-x` short option
# was silently ignored — the same "looks like a control, does nothing" class the
# unknown-flag guard exists to kill, just spelled differently. Both must be
# refused WITH the customer pointer untouched.
SHA_6J="$(jq_manifest 'm.releaseOps["promo-6d"].sha256')"
PTR_6J_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
OUT_6J="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6d" --expected-sha256 "$SHA_6J" stray-positional 2>&1)" \
  && RC_6J=0 || RC_6J=$?
PTR_6J_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
if [ "$RC_6J" -ne 0 ] && grep -q "unrecognized argument 'stray-positional'" <<<"$OUT_6J" \
   && [ "$PTR_6J_BEFORE" = "$PTR_6J_AFTER" ]; then
  pass "P6j trailing positional argument is refused (pointer untouched)"
else
  fail "P6j positional not refused (rc=$RC_6J, ptr ${PTR_6J_BEFORE} then ${PTR_6J_AFTER}): $OUT_6J"
fi

PTR_6K_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
OUT_6K="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6d" --expected-sha256 "$SHA_6J" -x 2>&1)" \
  && RC_6K=0 || RC_6K=$?
PTR_6K_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
if [ "$RC_6K" -ne 0 ] && grep -q "unrecognized argument '-x'" <<<"$OUT_6K" \
   && [ "$PTR_6K_BEFORE" = "$PTR_6K_AFTER" ]; then
  pass "P6k single-dash short option is refused (pointer untouched)"
else
  fail "P6k -x not refused (rc=$RC_6K, ptr ${PTR_6K_BEFORE} then ${PTR_6K_AFTER}): $OUT_6K"
fi

# ── P7 · FLY-1323 (QA ff38290f F1) · the approval binding survives the read→write
# window. `commit` checks --expected-sha256 against the manifest snapshot it read,
# but casUpdate RE-READS the manifest on every attempt, so the tuple that actually
# moves the customer pointer is a LATER snapshot. Two independent layers must hold,
# and P7a/P7b pin them separately — neither is allowed to stand in for the other.
#
# P7a: the ENDPOINT refuses to change a prepared op's tuple at all (write-once).
#      This is what makes the race unreachable in production, and QA's stub — which
#      lacked this validator — is why their repro showed a swap the real server
#      forbids. Pin it, because the CLI guard's reachability argument depends on it.
# P7 needs its OWN candidate, left in the PREPARED state: promo-6 was committed by
# P6c, and a committed op short-circuits before casUpdate (idempotent success), so
# it can prove nothing about the read→write window. Fresh commit + fresh semver.
echo "payload input v7" > "$FIX/content.txt"
echo "v9.9.90" > "$FIX/doc/VERSION"
git -C "$FIX" add -A && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm v7
run_release "run-P7" >/dev/null 2>&1 || { echo "FATAL: beta for P7 failed"; exit 1; }
BETA_P7="$(jq_manifest 'm.releaseOps["run-P7"].ver')"
PREP7="$(env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
  node "$PROMOTE" prepare --release-id "promo-7" --beta "$BETA_P7" --repo-root "$FIX" 2>&1)" \
  || { echo "FATAL: P7 prepare failed: $PREP7"; exit 1; }
GOOD_SHA_7="$(jq_manifest 'm.releaseOps["promo-7"].sha256')"
[ "$(jq_manifest 'm.releaseOps["promo-7"].state')" = "prepared" ] \
  || { echo "FATAL: promo-7 is not prepared"; exit 1; }

EVIL_SHA="$(printf 'e%.0s' $(seq 1 64))"
SWAP_OUT="$(node -e '
const [ep, tok, id, evil] = process.argv.slice(1);
(async () => {
  const g = await fetch(ep + "/admin/manifest", {headers:{authorization:"Bearer "+tok}});
  const etag = (g.headers.get("etag") || "")
    .replace(/^W\//i, "").replace(/^"|"$/g, "");
  const m = await g.json();
  m.releaseOps[id].sha256 = evil;
  m.releaseOps[id].objectKey = "payloads/" + m.releaseOps[id].ver + "/" + evil + ".tgz";
  const p = await fetch(ep + "/admin/manifest", {
    method: "POST",
    headers: {authorization: "Bearer " + tok, "content-type": "application/json"},
    body: JSON.stringify({baseEtag: etag, manifest: m}),
  });
  console.log("HTTP " + p.status + " " + (await p.text()));
})();
' "$EP" "$OPS_TOKEN" "promo-7" "$EVIL_SHA" 2>&1)"
if grep -q "write-once\|only in reserved state" <<<"$SWAP_OUT" && ! grep -q "HTTP 200" <<<"$SWAP_OUT"; then
  pass "P7a endpoint refuses to re-point a PREPARED op's tuple (write-once) — the race is unreachable server-side"
else
  fail "P7a endpoint ACCEPTED a prepared-tuple swap — the F1 race would be live: $SWAP_OUT"
fi

# P7b: the CLI re-judges the binding inside the mutate, INDEPENDENTLY of the
#      endpoint. Defense in depth: the CLI must not silently rely on a server-side
#      invariant for its OWN approval contract — if the endpoint ever relaxed
#      write-once, an unguarded CLI would publish an unapproved artifact.
#      Because the real endpoint refuses the swap (P7a), the divergence is injected
#      the only place it can be: a PROXY that forwards everything to the real
#      endpoint but mutates the manifest on the casUpdate re-read. This is a
#      BEHAVIOURAL test of the CLI (the guard must actually fire and no write may
#      reach the endpoint) — deliberately NOT a source grep, which would pass on
#      dead code.
PROXY_OUT="$SANDBOX/f1-proxy.out"
node -e '
const http = require("node:http");
const [target, id, evilSha, evilVer] = process.argv.slice(1);
let manifestGets = 0, postSeen = false;
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.method === "POST" && req.url === "/admin/manifest") postSeen = true;
  const up = await fetch(target + req.url, {
    method: req.method,
    headers: {authorization: req.headers.authorization, ...(req.headers["content-type"] ? {"content-type": req.headers["content-type"]} : {})},
    ...(body.length ? {body} : {}),
  });
  if (req.method === "GET" && req.url === "/admin/manifest") {
    manifestGets++;
    const m = await up.json();
    // 1st GET = the snapshot commit binds against (leave it truthful).
    // 2nd GET = the casUpdate re-read → hand back a DIFFERENT tuple, exactly the
    // divergence the guard exists for.
    if (manifestGets >= 2 && m.releaseOps && m.releaseOps[id]) {
      m.releaseOps[id].sha256 = evilSha;
      m.releaseOps[id].ver = evilVer;
    }
    res.writeHead(up.status, {"content-type": "application/json", etag: up.headers.get("etag") || ""});
    res.end(JSON.stringify(m));
    return;
  }
  const buf = Buffer.from(await up.arrayBuffer());
  const h = {}; up.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") h[k] = v; });
  res.writeHead(up.status, h); res.end(buf);
});
srv.listen(0, "127.0.0.1", () => console.log("PORT " + srv.address().port));
process.on("SIGTERM", () => { console.log("POST_SEEN " + postSeen); process.exit(0); });
' "$EP" "promo-7" "$EVIL_SHA" "6.6.6" > "$PROXY_OUT" 2>&1 &
PROXY_PID=$!
PROXY_PORT=""
for _ in $(seq 1 50); do
  PROXY_PORT="$(sed -n 's/^PORT //p' "$PROXY_OUT" 2>/dev/null | head -1)"
  [ -n "$PROXY_PORT" ] && break; sleep 0.1
done
if [ -z "$PROXY_PORT" ]; then
  fail "P7b proxy never bound: $(cat "$PROXY_OUT")"
else
  PTR_7B_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
  OUT_7B="$(env FW_ENDPOINT="http://127.0.0.1:$PROXY_PORT" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
    node "$PROMOTE" commit --release-id "promo-7" --expected-sha256 "$GOOD_SHA_7" 2>&1)" && RC_7B=0 || RC_7B=$?
  PTR_7B_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
  # SIGTERM makes the proxy print POST_SEEN <bool>. Codex R4: this test used to
  # TRACK postSeen and never assert it — claiming "no write reached the endpoint"
  # while checking nothing of the sort. Assert it.
  kill -TERM "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null
  POST_SEEN="$(sed -n 's/^POST_SEEN //p' "$PROXY_OUT" 2>/dev/null | tail -1)"
  if [ "$RC_7B" -ne 0 ] && grep -q "changed under us" <<<"$OUT_7B" \
     && [ "$PTR_7B_BEFORE" = "$PTR_7B_AFTER" ] \
     && [ "$POST_SEEN" = "false" ] \
     && ! grep -q "COMMITTED: customer-release.latest = 6.6.6" <<<"$OUT_7B"; then
    pass "P7b commit re-judges the binding on the CAS re-read: swapped tuple refused, pointer untouched, NO manifest POST reached the endpoint"
  else
    fail "P7b tuple swapped in the read→write window was NOT refused (rc=$RC_7B, ptr ${PTR_7B_BEFORE} then ${PTR_7B_AFTER}): $OUT_7B"
  fi
fi

# ── P8 · FLY-2387 C-6b · retry-time veto binding and committed idempotency ──
# The initial read is not authoritative: casUpdate re-reads before writing. A
# concurrent executor may commit the SAME release in that window (idempotent),
# or the identity may drift (fail closed). These proxies alter only the second
# /admin/manifest GET and record whether the CLI attempted a manifest POST.
echo "payload input v8" > "$FIX/content.txt"
echo "v9.9.91" > "$FIX/doc/VERSION"
git -C "$FIX" add -A && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm v8
run_release "run-P8" >/dev/null 2>&1 || { echo "FATAL: beta for P8 failed"; exit 1; }
BETA_P8="$(jq_manifest 'm.releaseOps["run-P8"].ver')"
PREP8="$(env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
  node "$PROMOTE" prepare --release-id "promo-8" --beta "$BETA_P8" --repo-root "$FIX" 2>&1)" \
  || { echo "FATAL: P8 prepare failed: $PREP8"; exit 1; }
GOOD_SHA_8="$(jq_manifest 'm.releaseOps["promo-8"].sha256')"

REREAD_PROXY="$SANDBOX/commit-reread-proxy.cjs"
cat > "$REREAD_PROXY" <<'JS'
const http = require("node:http");

const [target, id, mode] = process.argv.slice(2);
let manifestGets = 0;
let postSeen = false;
const server = http.createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const body = Buffer.concat(chunks);
	if (request.method === "POST" && request.url === "/admin/manifest") {
		postSeen = true;
	}
	const upstream = await fetch(target + request.url, {
		method: request.method,
		headers: {
			authorization: request.headers.authorization,
			...(request.headers["content-type"]
				? { "content-type": request.headers["content-type"] }
				: {}),
		},
		...(body.length ? { body } : {}),
	});
	if (request.method === "GET" && request.url === "/admin/manifest") {
		manifestGets++;
		const manifest = await upstream.json();
		if (manifestGets >= 2 && manifest.releaseOps?.[id]) {
			const op = manifest.releaseOps[id];
			if (mode === "same-commit") {
				manifest.versions[op.ver] = {
					sha256: op.sha256,
					key: op.objectKey,
					size: 1,
					publishedAt: "2026-09-06T00:00:00.000Z",
					channel: "release",
					status: "active",
					sourceCommit: op.sourceCommit,
					releaseId: id,
					derivedFromBeta: op.betaVersion,
					retentionSince: null,
					quarantinedAt: null,
				};
				manifest.channels["customer-release"].latest = op.ver;
				op.state = "committed";
			} else if (mode === "wrong-kind") {
				op.kind = "beta";
				op.state = "committed";
			}
		}
		response.writeHead(upstream.status, {
			"content-type": "application/json",
			etag: upstream.headers.get("etag") || "",
		});
		response.end(JSON.stringify(manifest));
		return;
	}
	const buffer = Buffer.from(await upstream.arrayBuffer());
	const headers = {};
	upstream.headers.forEach((value, key) => {
		if (key !== "content-encoding" && key !== "content-length") {
			headers[key] = value;
		}
	});
	response.writeHead(upstream.status, headers);
	response.end(buffer);
});
server.listen(0, "127.0.0.1", () =>
	console.log(`PORT ${server.address().port}`),
);
process.on("SIGTERM", () => {
	console.log(`POST_SEEN ${postSeen}`);
	process.exit(0);
});
JS

start_reread_proxy() {
  local mode="$1" output="$2"
  node "$REREAD_PROXY" "$EP" "promo-8" "$mode" > "$output" 2>&1 &
  REREAD_PID=$!
  REREAD_PORT=""
  for _ in $(seq 1 50); do
    REREAD_PORT="$(sed -n 's/^PORT //p' "$output" 2>/dev/null | head -1)"
    [ -n "$REREAD_PORT" ] && break
    sleep 0.1
  done
}

# P8a: another executor commits the exact approved artifact between reads.
# The retry sees committed, returns success, and performs no second write.
P8A_PROXY_OUT="$SANDBOX/p8a-proxy.out"
start_reread_proxy "same-commit" "$P8A_PROXY_OUT"
if [ -z "$REREAD_PORT" ]; then
  fail "P8a proxy never bound: $(cat "$P8A_PROXY_OUT")"
else
  P8A_PTR_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
  OUT_8A="$(env FW_ENDPOINT="http://127.0.0.1:$REREAD_PORT" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
    node "$PROMOTE" commit --release-id "promo-8" --expected-sha256 "$GOOD_SHA_8" 2>&1)" \
    && RC_8A=0 || RC_8A=$?
  P8A_PTR_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
  kill -TERM "$REREAD_PID" 2>/dev/null; wait "$REREAD_PID" 2>/dev/null
  P8A_POST_SEEN="$(sed -n 's/^POST_SEEN //p' "$P8A_PROXY_OUT" | tail -1)"
  if [ "$RC_8A" -eq 0 ] && grep -q "COMMITTED: customer-release.latest = 9.9.91" <<<"$OUT_8A" \
     && [ "$P8A_POST_SEEN" = "false" ] && [ "$P8A_PTR_BEFORE" = "$P8A_PTR_AFTER" ]; then
    pass "P8a CAS retry sees the same artifact committed concurrently: idempotent success, zero write"
  else
    fail "P8a concurrent identical commit was not idempotent (rc=$RC_8A, post=$P8A_POST_SEEN): $OUT_8A"
  fi
fi

# P8b: releaseId/kind/sha are all part of the retry-time committed branch.
# A same-sha record whose kind changed must not be treated as a release commit.
P8B_PROXY_OUT="$SANDBOX/p8b-proxy.out"
start_reread_proxy "wrong-kind" "$P8B_PROXY_OUT"
if [ -z "$REREAD_PORT" ]; then
  fail "P8b proxy never bound: $(cat "$P8B_PROXY_OUT")"
else
  OUT_8B="$(env FW_ENDPOINT="http://127.0.0.1:$REREAD_PORT" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
    node "$PROMOTE" commit --release-id "promo-8" --expected-sha256 "$GOOD_SHA_8" 2>&1)" \
    && RC_8B=0 || RC_8B=$?
  kill -TERM "$REREAD_PID" 2>/dev/null; wait "$REREAD_PID" 2>/dev/null
  P8B_POST_SEEN="$(sed -n 's/^POST_SEEN //p' "$P8B_PROXY_OUT" | tail -1)"
  if [ "$RC_8B" -ne 0 ] && grep -q "kind release" <<<"$OUT_8B" \
     && [ "$P8B_POST_SEEN" = "false" ]; then
    pass "P8b CAS retry refuses a same-sha committed record whose kind is not release"
  else
    fail "P8b retry accepted non-release identity (rc=$RC_8B, post=$P8B_POST_SEEN): $OUT_8B"
  fi
fi

# P8c: once P8 makes P7's beta non-latest, quarantine it in a prior CAS. The
# prepared commit must re-derive its veto binding on the current CAS snapshot.
P8C_QUARANTINE="$(node -e '
const [endpoint, token, beta] = process.argv.slice(1);
(async () => {
  const get = await fetch(endpoint + "/admin/manifest", {headers:{authorization:"Bearer "+token}});
  const etag = (get.headers.get("etag") || "")
    .replace(/^W\//i, "").replace(/^"|"$/g, "");
  const manifest = await get.json();
  manifest.versions[beta].status = "quarantined";
  const post = await fetch(endpoint + "/admin/manifest", {
    method: "POST",
    headers: {authorization:"Bearer "+token, "content-type":"application/json"},
    body: JSON.stringify({baseEtag: etag, manifest}),
  });
  console.log("HTTP " + post.status + " " + (await post.text()));
})();
' "$EP" "$RELEASE_TOKEN" "$BETA_P7" 2>&1)"
P8C_PTR_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
P8C_OP_BEFORE="$(jq_manifest 'JSON.stringify(m.releaseOps["promo-7"])')"
OUT_8C="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-7" --expected-sha256 "$GOOD_SHA_7" 2>&1)" \
  && RC_8C=0 || RC_8C=$?
P8C_PTR_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
P8C_OP_AFTER="$(jq_manifest 'JSON.stringify(m.releaseOps["promo-7"])')"
if grep -q "HTTP 200" <<<"$P8C_QUARANTINE" && [ "$RC_8C" -ne 0 ] \
   && grep -q "must be active" <<<"$OUT_8C" \
   && [ "$P8C_PTR_BEFORE" = "$P8C_PTR_AFTER" ] \
   && [ "$P8C_OP_BEFORE" = "$P8C_OP_AFTER" ] \
   && [ "$(jq_manifest 'm.versions["9.9.90"] === undefined')" = "true" ]; then
  pass "P8c prepared commit re-derives veto binding: quarantined beta refused, pointer/op byte-unchanged"
else
  fail "P8c quarantined-beta veto failed (rc=$RC_8C): quarantine=$P8C_QUARANTINE commit=$OUT_8C"
fi

# P8d/e: cold-start against an already-committed op whose source beta has
# legally expired. The committed branch checks only releaseId/kind/sha: matching
# is a zero-write success; mismatched sha is fail-closed and also zero-write.
COLD_MANIFEST="$SANDBOX/cold-committed-manifest.json"
manifest > "$COLD_MANIFEST"
COLD_SERVER_OUT="$SANDBOX/cold-committed-server.out"
node - "$COLD_MANIFEST" "promo-1" > "$COLD_SERVER_OUT" 2>&1 <<'JS' &
const fs = require("node:fs");
const http = require("node:http");

const [manifestPath, id] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const betaVersion = manifest.releaseOps[id].betaVersion;
manifest.versions[betaVersion].status = "expired";
manifest.versions[betaVersion].retentionSince ||= "2026-09-01T00:00:00.000Z";
let postSeen = false;
let otherSeen = false;
const server = http.createServer((request, response) => {
	if (request.method === "GET" && request.url === "/admin/manifest") {
		response.writeHead(200, {
			"content-type": "application/json",
			etag: '"cccccccccccccccccccccccccccccccc"',
		});
		response.end(JSON.stringify(manifest));
		return;
	}
	if (request.method === "POST" && request.url === "/admin/manifest") {
		postSeen = true;
	} else {
		otherSeen = true;
	}
	response.writeHead(500);
	response.end();
});
server.listen(0, "127.0.0.1", () => {
	console.log(`PORT ${server.address().port}`);
	console.log(`BETA_STATUS ${manifest.versions[betaVersion].status}`);
});
process.on("SIGTERM", () => {
	console.log(`POST_SEEN ${postSeen}`);
	console.log(`OTHER_SEEN ${otherSeen}`);
	process.exit(0);
});
JS
COLD_PID=$!
COLD_PORT=""
for _ in $(seq 1 50); do
  COLD_PORT="$(sed -n 's/^PORT //p' "$COLD_SERVER_OUT" 2>/dev/null | head -1)"
  [ -n "$COLD_PORT" ] && break
  sleep 0.1
done
if [ -z "$COLD_PORT" ]; then
  fail "P8d cold server never bound: $(cat "$COLD_SERVER_OUT")"
else
  OUT_8D="$(env FW_ENDPOINT="http://127.0.0.1:$COLD_PORT" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
    node "$PROMOTE" commit --release-id "promo-1" --expected-sha256 "$SHA_P1" 2>&1)" \
    && RC_8D=0 || RC_8D=$?
  OUT_8E="$(env FW_ENDPOINT="http://127.0.0.1:$COLD_PORT" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
    node "$PROMOTE" commit --release-id "promo-1" --expected-sha256 "$BAD" 2>&1)" \
    && RC_8E=0 || RC_8E=$?
  kill -TERM "$COLD_PID" 2>/dev/null; wait "$COLD_PID" 2>/dev/null
  COLD_POST_SEEN="$(sed -n 's/^POST_SEEN //p' "$COLD_SERVER_OUT" | tail -1)"
  COLD_OTHER_SEEN="$(sed -n 's/^OTHER_SEEN //p' "$COLD_SERVER_OUT" | tail -1)"
  if grep -q "BETA_STATUS expired" "$COLD_SERVER_OUT" \
     && [ "$RC_8D" -eq 0 ] && grep -q "already committed" <<<"$OUT_8D" \
     && [ "$COLD_POST_SEEN" = "false" ] && [ "$COLD_OTHER_SEEN" = "false" ]; then
    pass "P8d cold committed rerun ignores expired beta: id/kind/sha match, idempotent zero-write success"
  else
    fail "P8d cold committed rerun was not idempotent (rc=$RC_8D, post=$COLD_POST_SEEN, other=$COLD_OTHER_SEEN): $OUT_8D"
  fi
  if [ "$RC_8E" -ne 0 ] && grep -q "does not match candidate" <<<"$OUT_8E" \
     && [ "$COLD_POST_SEEN" = "false" ] && [ "$COLD_OTHER_SEEN" = "false" ]; then
    pass "P8e committed record with sha != expectedSha256 fails closed with zero write"
  else
    fail "P8e committed sha mismatch was accepted (rc=$RC_8E, post=$COLD_POST_SEEN): $OUT_8E"
  fi
fi

# ── P9c · one clean semver has one winning release candidate ────────────────
echo "payload input p9c" > "$FIX/content.txt"
echo "v9.9.92" > "$FIX/doc/VERSION"
git -C "$FIX" add -A && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm p9c
run_release "run-P9C" >/dev/null 2>&1 || { echo "FATAL: beta for P9c failed"; exit 1; }
BETA_P9C="$(jq_manifest 'm.releaseOps["run-P9C"].ver')"
for id in promo-p9c-old promo-p9c-winner; do
  env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
    node "$PROMOTE" prepare --release-id "$id" --beta "$BETA_P9C" --repo-root "$FIX" >/dev/null 2>&1 \
    || { echo "FATAL: P9c prepare failed for $id"; exit 1; }
done
P9C_SHA="$(jq_manifest 'm.releaseOps["promo-p9c-winner"].sha256')"
P9C_OUT="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id promo-p9c-winner --expected-sha256 "$P9C_SHA" 2>&1)" \
  && P9C_RC=0 || P9C_RC=$?
if [ "$P9C_RC" -eq 0 ] \
   && grep -q '"action":"commit"' <<<"$P9C_OUT" \
   && grep -q '"outcome":"committed"' <<<"$P9C_OUT" \
   && [ "$(jq_manifest 'm.releaseOps["promo-p9c-winner"].state')" = "committed" ] \
   && [ "$(jq_manifest 'm.releaseOps["promo-p9c-old"].state')" = "abandoned" ] \
   && [ "$(jq_manifest 'm.channels["customer-release"].latest')" = "9.9.92" ]; then
  pass "P9c commit CAS picks one same-version winner and abandons every other live release candidate"
else
  fail "P9c same-version candidates did not converge: $P9C_OUT $(manifest)"
fi
P9C_BEFORE="$(manifest)"
P9C_REPLAY="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id promo-p9c-winner --expected-sha256 "$P9C_SHA" 2>&1)" \
  && P9C_REPLAY_RC=0 || P9C_REPLAY_RC=$?
P9C_AFTER="$(manifest)"
if [ "$P9C_REPLAY_RC" -eq 0 ] && grep -q '"outcome":"idempotent"' <<<"$P9C_REPLAY" \
   && [ "$P9C_BEFORE" = "$P9C_AFTER" ]; then
  pass "P9c committed winner replay is idempotent and byte-zero-write"
else
  fail "P9c replay was not idempotent: $P9C_REPLAY"
fi

# ── R4 · beta staging has one live winner across explicit ids ───────────────
# All three ids use the same HEAD. The reserved op must abandon the prior
# prepared op in ITS reserve CAS; the final winner must abandon that reserved
# op in ITS reserve CAS. Committed beta and release-kind ops are never swept.
RELEASE_KIND_BEFORE="$(jq_manifest 'm.releaseOps["promo-6d"].state')"
run_release "r4-prepared" FW_TEST_ABORT_AFTER=prepared >/dev/null 2>&1
R4_PREP_RC=$?
run_release "r4-reserved" FW_TEST_ABORT_AFTER=reserve >/dev/null 2>&1
R4_RES_RC=$?
run_release "r4-winner" >/dev/null 2>&1
R4_WIN_RC=$?
if [ "$R4_PREP_RC" -eq 42 ] && [ "$R4_RES_RC" -eq 42 ] && [ "$R4_WIN_RC" -eq 0 ] \
   && [ "$(jq_manifest 'm.releaseOps["r4-prepared"].state')" = "abandoned" ] \
   && [ "$(jq_manifest 'm.releaseOps["r4-reserved"].state')" = "abandoned" ] \
   && [ "$(jq_manifest 'm.releaseOps["r4-winner"].state')" = "committed" ]; then
  pass "R4 reserve CAS abandons every older live beta op and commits one winner"
else
  fail "R4 beta candidates did not converge to one winner: $(manifest)"
fi

# Scheduled dedup still has cleanup work: a committed op for this sourceCommit
# is not permission to leave a later explicit stray live forever.
run_release "r4-dedup-stray" FW_TEST_ABORT_AFTER=reserve >/dev/null 2>&1
R4_STRAY_RC=$?
R4_DEDUP_BEFORE="$(manifest)"
R4_DEDUP_OUT="$(run_release_auto 2>&1)"; R4_DEDUP_RC=$?
R4_DEDUP_AFTER="$(manifest)"
if [ "$R4_STRAY_RC" -eq 42 ] && [ "$R4_DEDUP_RC" -eq 0 ] \
   && grep -q "already published" <<<"$R4_DEDUP_OUT" \
   && [ "$(jq_manifest 'm.releaseOps["r4-dedup-stray"].state')" = "abandoned" ] \
   && [ "$R4_DEDUP_BEFORE" != "$R4_DEDUP_AFTER" ]; then
  pass "R4b scheduled dedup hit performs one CAS sweep when a live beta stray exists"
else
  fail "R4b dedup did not sweep the stray (rc=$R4_DEDUP_RC): $R4_DEDUP_OUT"
fi
R4_ZERO_BEFORE="$(manifest)"
R4_ZERO_OUT="$(run_release_auto 2>&1)"; R4_ZERO_RC=$?
R4_ZERO_AFTER="$(manifest)"
if [ "$R4_ZERO_RC" -eq 0 ] && grep -q "already published" <<<"$R4_ZERO_OUT" \
   && [ "$R4_ZERO_BEFORE" = "$R4_ZERO_AFTER" ]; then
  pass "R4b scheduled dedup with no live beta stray is byte-zero-write"
else
  fail "R4b empty dedup sweep wrote state (rc=$R4_ZERO_RC): $R4_ZERO_OUT"
fi

if [ "$(jq_manifest 'm.releaseOps["r4-winner"].state')" = "committed" ] \
   && [ "$(jq_manifest 'm.releaseOps["promo-6d"].state')" = "$RELEASE_KIND_BEFORE" ]; then
  pass "R4c beta sweep leaves committed and kind=release operations untouched"
else
  fail "R4c beta sweep damaged terminal or release-kind operations"
fi
R4_RETRY_OUT="$(run_release "r4-dedup-stray" 2>&1)"; R4_RETRY_RC=$?
if [ "$R4_RETRY_RC" -ne 0 ] && grep -q "was abandoned" <<<"$R4_RETRY_OUT"; then
  pass "R4d explicit rerun of an abandoned beta releaseId fails closed"
else
  fail "R4d abandoned releaseId rerun was not refused (rc=$R4_RETRY_RC): $R4_RETRY_OUT"
fi

# P6g · FLY-1323 (Codex code R1 MEDIUM-2) · DUPLICATE flags are refused.
# argValue() resolves via indexOf → the FIRST occurrence wins and later ones are
# silently dropped, so `--expected-sha256 <good> --expected-sha256 <evil>` was
# ambiguous about which artifact was actually approved. The docs CLAIMED P6
# covered duplicates; it did not — deleting the `seen` check survived every
# other P6 case. This is that missing coverage.
PTR_6G_BEFORE="$(jq_manifest 'm.channels["customer-release"].latest')"
SHA_6G="$(jq_manifest 'm.releaseOps["promo-6d"].sha256')"
OUT_6G="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6d" \
    --expected-sha256 "$SHA_6G" --expected-sha256 "$BAD" 2>&1)" && RC_6G=0 || RC_6G=$?
PTR_6G_AFTER="$(jq_manifest 'm.channels["customer-release"].latest')"
if [ "$RC_6G" -ne 0 ] && grep -qi "more than once" <<<"$OUT_6G" \
   && [ "$PTR_6G_BEFORE" = "$PTR_6G_AFTER" ]; then
  pass "P6g duplicate --expected-sha256 is refused as ambiguous (pointer untouched)"
else
  fail "P6g duplicate flag not refused (rc=$RC_6G, ptr ${PTR_6G_BEFORE} then ${PTR_6G_AFTER}): $OUT_6G"
fi

# P6h · duplicate --release-id is equally ambiguous → refused
OUT_6H="$(env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
  node "$PROMOTE" commit --release-id "promo-6d" --release-id "promo-1" \
    --expected-sha256 "$SHA_6G" 2>&1)" && RC_6H=0 || RC_6H=$?
if [ "$RC_6H" -ne 0 ] && grep -qi "more than once" <<<"$OUT_6H"; then
  pass "P6h duplicate --release-id is refused as ambiguous"
else
  fail "P6h duplicate --release-id not refused (rc=$RC_6H): $OUT_6H"
fi

echo ""
echo "payload-release-pipeline: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
