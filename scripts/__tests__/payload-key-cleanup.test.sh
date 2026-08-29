#!/bin/bash
# FLY-1062 PR3 · license-key.mjs + payload-cleanup.mjs against the REAL
# endpoint handler (in-process loopback shell, hermetic — zero network beyond
# 127.0.0.1, zero real bucket).
#
#   K1 issue refused while the entitlement channel is empty (pre-activation)
#   K2 issue → fwk_ key + key id printed once; the key WORKS on /manifest
#   K3 revoke by key id → next request 401 (immediate)
#   K4 rotate → new key live, old revoked
#   K5 tokens ride env only (missing env = hard refusal; argv carries none)
#   C1 cleanup dry-run default: reports candidates, writes NOTHING
#   C2 cleanup --apply: expire→tombstone→delete lands; object physically gone;
#      view no longer lists the expired version; sweep replays the FULL set
#   C3 structural order assertions on the script source (protocol lock)
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v node >/dev/null 2>&1 || { echo "ERROR: node required"; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVE="$ROOT/packages/payload-endpoint/__tests__/serve.mjs"
LK="$ROOT/scripts/release/license-key.mjs"
CLEAN="$ROOT/scripts/release/payload-cleanup.mjs"

SANDBOX="$(mktemp -d -t fly1062-keyclean-XXXXXX)"
SERVER_PIDS=""
cleanup() { for p in $SERVER_PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$SANDBOX"; }
trap cleanup EXIT

OPS_TOKEN="ops-admin-test-token"

start_server() { # $1 = seed manifest path (optional)
  local out="$SANDBOX/server-$RANDOM.out"
  if [ -n "${1:-}" ]; then
    FW_TEST_OPS_TOKEN="$OPS_TOKEN" SERVE_SEED_MANIFEST="$1" node "$SERVE" > "$out" 2>&1 &
  else
    FW_TEST_OPS_TOKEN="$OPS_TOKEN" node "$SERVE" > "$out" 2>&1 &
  fi
  local pid=$!
  SERVER_PIDS="$SERVER_PIDS $pid"
  local port=""
  for _ in $(seq 1 40); do
    port="$(sed -n 's/^PORT //p' "$out" 2>/dev/null | head -1)"
    [ -n "$port" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  [ -n "$port" ] || { echo "ERROR: serve.mjs never bound: $(cat "$out")"; exit 1; }
  echo "$port"
}

# seed manifests generated from the endpoint test fixtures (single source)
node - "$ROOT" "$SANDBOX" <<'EOF'
const path = require("node:path");
const fs = require("node:fs");
const [root, sandbox] = process.argv.slice(2);
import(path.join(root, "packages/payload-endpoint/__tests__/harness.mjs")).then((h) => {
	// full fixture (release + beta live)
	fs.writeFileSync(path.join(sandbox, "seed-full.json"), JSON.stringify(h.fixtureManifest()));
	// no release published yet (customer channel empty)
	fs.writeFileSync(
		path.join(sandbox, "seed-norelease.json"),
		JSON.stringify(h.fixtureManifest({ withRelease: false })),
	);
	// cleanup world: fixture + a SUPERSEDED old beta far past its 14d window
	const m = h.fixtureManifest();
	const sha = "d".repeat(64);
	m.versions["1.54.0-beta.1"] = {
		sha256: sha,
		key: h.payloadKeyOf("1.54.0-beta.1", sha),
		size: 10,
		publishedAt: "2026-01-01T00:00:00.000Z",
		channel: "beta",
		status: "active",
		sourceCommit: "c".repeat(40),
		releaseId: "op-old-beta",
		derivedFromBeta: null,
		retentionSince: "2026-01-02T00:00:00.000Z",
		quarantinedAt: null,
	};
	m.releaseOps["op-old-beta"] = {
		kind: "beta",
		state: "committed",
		ver: "1.54.0-beta.1",
		betaVersion: null,
		sourceCommit: "c".repeat(40),
		sha256: sha,
		objectKey: h.payloadKeyOf("1.54.0-beta.1", sha),
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	m.releaseLedger["1.54.0"] = { nextBetaN: 2 };
	fs.writeFileSync(path.join(sandbox, "seed-cleanup.json"), JSON.stringify(m));
});
EOF
[ -f "$SANDBOX/seed-full.json" ] || { echo "ERROR: seed generation failed"; exit 1; }

# ── K5 · env-only token discipline ───────────────────────────────────────────
K5_OUT="$(FW_ENDPOINT="http://127.0.0.1:1" node "$LK" issue --customer c1 --entitlement customer 2>&1 || true)"
if grep -q "FW_OPS_ADMIN_TOKEN env required" <<<"$K5_OUT"; then
  pass "K5 missing token env = hard refusal (tokens never ride argv)"
else
  fail "K5 script ran without the token env"
fi

# ── K1 · pre-activation refusal ──────────────────────────────────────────────
PORT="$(start_server "$SANDBOX/seed-norelease.json")"
OUT="$(FW_ENDPOINT="http://127.0.0.1:$PORT" FW_OPS_ADMIN_TOKEN="$OPS_TOKEN" \
  node "$LK" issue --customer c1 --entitlement customer 2>&1)" && K1_RC=0 || K1_RC=$?
if [ "$K1_RC" -ne 0 ] && grep -q "no published release" <<<"$OUT"; then
  pass "K1 issue refused for an empty entitlement channel (plain-words reason)"
else
  fail "K1 expected pre-activation refusal, got rc=$K1_RC: $OUT"
fi
# internal channel HAS a pointer → internal issuance succeeds on the same server
OUT="$(FW_ENDPOINT="http://127.0.0.1:$PORT" FW_OPS_ADMIN_TOKEN="$OPS_TOKEN" \
  node "$LK" issue --customer c1 --entitlement internal 2>&1)"
if grep -qE "key    : fwk_[0-9a-f]{64}" <<<"$OUT"; then
  pass "K1b internal issuance works while customer channel is still empty"
else
  fail "K1b internal issuance failed: $OUT"
fi

# ── K2/K3/K4 · issue → use → revoke → rotate ────────────────────────────────
PORT="$(start_server "$SANDBOX/seed-full.json")"
EP="http://127.0.0.1:$PORT"
OUT="$(FW_ENDPOINT="$EP" FW_OPS_ADMIN_TOKEN="$OPS_TOKEN" \
  node "$LK" issue --customer acme --entitlement customer --note "first customer" 2>&1)"
KEY="$(sed -n 's/.*key    : \(fwk_[0-9a-f]*\).*/\1/p' <<<"$OUT")"
KEY_ID="$(sed -n 's/.*key id : \([0-9a-f]*\) .*/\1/p' <<<"$OUT")"
if [ -n "$KEY" ] && [ -n "$KEY_ID" ]; then
  pass "K2a issue prints the plaintext once + the non-secret key id"
else
  fail "K2a issue output missing key/key-id: $OUT"
fi
VIEW="$(curl -s -H "Authorization: Bearer $KEY" "$EP/manifest")"
if grep -q '"latest":"1.55.0"' <<<"$VIEW"; then
  pass "K2b the issued key gets the customer-release view"
else
  fail "K2b issued key rejected: $VIEW"
fi
FW_ENDPOINT="$EP" FW_OPS_ADMIN_TOKEN="$OPS_TOKEN" node "$LK" revoke --key-id "$KEY_ID" >/dev/null 2>&1
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$EP/manifest")"
if [ "$CODE" = "401" ]; then
  pass "K3 revocation is immediate (next request 401)"
else
  fail "K3 revoked key still served (HTTP $CODE)"
fi
ROT="$(FW_ENDPOINT="$EP" FW_OPS_ADMIN_TOKEN="$OPS_TOKEN" \
  node "$LK" rotate --key-id "$KEY_ID" --customer acme --entitlement customer 2>&1)"
NEWKEY="$(sed -n 's/.*key    : \(fwk_[0-9a-f]*\).*/\1/p' <<<"$ROT")"
if [ -n "$NEWKEY" ] && grep -q "rotation complete" <<<"$ROT" \
   && curl -s -H "Authorization: Bearer $NEWKEY" "$EP/manifest" | grep -q '"latest"'; then
  pass "K4 rotate: new key issued first and live"
else
  fail "K4 rotate failed: $ROT"
fi

# ── C1 · cleanup dry-run writes nothing ──────────────────────────────────────
PORT="$(start_server "$SANDBOX/seed-cleanup.json")"
EP="http://127.0.0.1:$PORT"
BEFORE="$(curl -s -H "Authorization: Bearer $OPS_TOKEN" "$EP/admin/manifest")"
DRY="$(FW_ENDPOINT="$EP" FW_OPS_ADMIN_TOKEN="$OPS_TOKEN" node "$CLEAN" 2>&1)"
AFTER="$(curl -s -H "Authorization: Bearer $OPS_TOKEN" "$EP/admin/manifest")"
if grep -q "1.54.0-beta.1" <<<"$DRY" && grep -q "dry-run only" <<<"$DRY" && [ "$BEFORE" = "$AFTER" ]; then
  pass "C1 dry-run default reports the candidate and writes nothing"
else
  fail "C1 dry-run misbehaved: $DRY"
fi

# ── C2 · apply: expire→tombstone→delete, object gone, view clean ─────────────
OBJ_KEY="payloads/1.54.0-beta.1/$(printf 'd%.0s' $(seq 1 64)).tgz"
if curl -s "$EP/__test__/objects" | grep -q "1.54.0-beta.1"; then
  pass "C2a superseded object present before apply"
else
  fail "C2a expected the seeded object before apply"
fi
APPLY="$(FW_ENDPOINT="$EP" FW_OPS_ADMIN_TOKEN="$OPS_TOKEN" node "$CLEAN" --apply 2>&1)" || true
MANIFEST_AFTER="$(curl -s -H "Authorization: Bearer $OPS_TOKEN" "$EP/admin/manifest")"
if grep -q '"1.54.0-beta.1"' <<<"$MANIFEST_AFTER" \
   && node -e "const m=JSON.parse(process.argv[1]); process.exit(m.versions['1.54.0-beta.1'].status==='expired'&&m.tombstones.includes('$OBJ_KEY')?0:1)" "$MANIFEST_AFTER"; then
  pass "C2b apply: entry expired + key tombstoned (audit record kept, never erased)"
else
  fail "C2b apply left wrong manifest state: $APPLY"
fi
if ! curl -s "$EP/__test__/objects" | grep -q "1.54.0-beta.1"; then
  pass "C2c apply: physical object deleted (step ③ after ②)"
else
  fail "C2c object survived apply"
fi
RERUN="$(FW_ENDPOINT="$EP" FW_OPS_ADMIN_TOKEN="$OPS_TOKEN" node "$CLEAN" --apply 2>&1)" || true
if grep -q "delete sweep over 1 tombstone" <<<"$RERUN"; then
  pass "C2d rerun sweeps the FULL tombstone set again (convergence, idempotent)"
else
  fail "C2d rerun did not sweep: $RERUN"
fi

# ── C3 · structural protocol lock on the script source ──────────────────────
E_LINE="$(grep -n "phase ①: EXPIRE" "$CLEAN" | cut -d: -f1)"
T_LINE="$(grep -n "phase ②: TOMBSTONE" "$CLEAN" | cut -d: -f1)"
D_LINE="$(grep -n "phase ③: DELETE" "$CLEAN" | cut -d: -f1)"
if [ -n "$E_LINE" ] && [ -n "$T_LINE" ] && [ -n "$D_LINE" ] \
   && [ "$E_LINE" -lt "$T_LINE" ] && [ "$T_LINE" -lt "$D_LINE" ]; then
  pass "C3a cleanup source keeps the expire→tombstone→delete order (never reorder)"
else
  fail "C3a phase order broken in payload-cleanup.mjs"
fi
if grep -q "FULL SWEEP" "$CLEAN" && grep -q "manifest.tombstones ?? \[\]" "$CLEAN"; then
  pass "C3b cleanup source sweeps the entire tombstone set every run"
else
  fail "C3b full-sweep marker missing from payload-cleanup.mjs"
fi
# the PUT resurrection window is closed in the HANDLER (post-check) — pin it
HANDLER="$ROOT/packages/payload-endpoint/src/handler.mjs"
if grep -q "post-check" "$HANDLER" && grep -q "claim lost during upload" "$HANDLER"; then
  pass "C3c handler PUT path keeps the post-check (resurrection window closed)"
else
  fail "C3c PUT post-check missing from handler.mjs"
fi

echo ""
echo "payload-key-cleanup: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
