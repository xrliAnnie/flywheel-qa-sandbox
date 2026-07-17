#!/usr/bin/env bash
# FLY-1252 QA — independent mutation control for the live quota guard.
#
# The implement-phase suite proves the guard blocks an exhausted target. This QA
# harness closes the vacuous-green gap that suite leaves open: it proves the
# exit-32 verdict is what BLOCKS the incident, by running the SAME production
# launcher three ways against ONE scratch environment and diffing the outcomes:
#
#   A. POSITIVE control  — real guard, HEALTHY target  → switch SUCCEEDS (exit 0).
#      (The guard does not just fail everything; a healthy account still passes.)
#   B. FIX               — real guard, EXHAUSTED target → refused (exit 32),
#      Keychain/.active UNCHANGED, truthful exhaustion projected into the store.
#   C. MUTATION control  — BLIND guard stub (always exit 0), EXHAUSTED target →
#      switch SUCCEEDS (the 2026-07-14 incident REPRODUCES). This is the negative
#      control: with the guard's verdict removed, the launcher walks straight onto
#      the dead account — so the exit-32 path (B) is genuinely load-bearing, not a
#      coincidental failure for some unrelated reason.
#
# Everything stays under a mktemp scratch root: scratch HOME/pool/store/lock, a
# mock usage+oauth server, a stdin-only `security` stub. Production
# ~/.flywheel/claude-accounts.json is never read or written.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
TEAMLEAD_DIR="$REPO_DIR/packages/teamlead"
PROFILE_BIN="$REPO_DIR/packages/claude-runner/bin/flywheel-claude-profile"
FRESHNESS_BIN="$TEAMLEAD_DIR/bin/flywheel-claude-freshness"
GUARD_BIN="$TEAMLEAD_DIR/bin/flywheel-claude-quota-guard"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1252-qa-mutation.XXXXXX")"
SERVER_PID=""

log()  { echo "[FLY-1252 QA] $*"; }
fail() { echo "[FLY-1252 QA] FAIL: $*" >&2; exit 1; }
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill -TERM "$SERVER_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null || true
  [[ "${FLY1252_QA_KEEP:-0}" == "1" ]] && { log "kept scratch at $ROOT"; return; }
  rm -rf "$ROOT"
}
trap cleanup EXIT

for tool in bash node pnpm jq; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing prerequisite: $tool"
done
[[ -x "$PROFILE_BIN" && -x "$FRESHNESS_BIN" && -x "$GUARD_BIN" ]] \
  || fail "profile/freshness/quota-guard launchers must be executable"

log "building production teamlead artifacts (real guard dist under test)"
pnpm --dir "$TEAMLEAD_DIR" build >/dev/null

HOME_DIR="$ROOT/home"
POOL="$ROOT/pool"
STORE="$HOME_DIR/.flywheel/claude-accounts.json"
LOCK="$HOME_DIR/.flywheel/claude-accounts.lock"
KEYCHAIN_STATE="$ROOT/keychain-state.json"
SECURITY_LOG="$ROOT/security-argv.log"
mkdir -p "$HOME_DIR/.flywheel" "$POOL" "$ROOT/bin"

make_credential() { # name access refresh
  mkdir -p "$POOL/$1"
  jq -cn --arg a "$2" --arg r "$3" \
    '{claudeAiOauth:{accessToken:$a,refreshToken:$r,expiresAt:4102444800000}}' \
    > "$POOL/$1/.credentials.json"
  chmod 600 "$POOL/$1/.credentials.json"
}
make_credential shopping shopping-access shopping-refresh
make_credential business business-access business-refresh
printf 'shopping' > "$POOL/.active"
cp "$POOL/shopping/.credentials.json" "$KEYCHAIN_STATE"
chmod 600 "$KEYCHAIN_STATE"
jq -n '{generation:0,activeAccount:"shopping",accounts:[
  {name:"shopping",quotaExhaustedUntil:null,weeklyResetAt:null},
  {name:"business",quotaExhaustedUntil:null,weeklyResetAt:null}
]}' > "$STORE"
chmod 600 "$STORE"
: > "$SECURITY_LOG"

# stdin-only `security` stub — credential values never appear in argv.
cat > "$ROOT/bin/security" <<'SECURITY'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SECURITY_ARGV_LOG"
case "${1:-}" in
  find-generic-password) cat "$FAKE_SECURITY_STATE" ;;
  -i)
    cmd="$(cat)"
    val="$(printf '%s' "$cmd" | sed -n 's/.* -w \([^ ]*\).*/\1/p')"
    [[ -n "$val" ]] || exit 2
    printf '%s' "$val" > "$FAKE_SECURITY_STATE" ;;
  *) exit 2 ;;
esac
SECURITY

# BLIND guard stub for the mutation control: always reports healthy (exit 0),
# i.e. a guard that fails to recognize the exhausted window (pre-fix behavior).
cat > "$ROOT/bin/blind-guard" <<'BLIND'
#!/usr/bin/env bash
# Ignores --name/--pool/--store; unconditionally "healthy".
exit 0
BLIND
chmod +x "$ROOT/bin/security" "$ROOT/bin/blind-guard"

# Mock: business weekly=100% (exhausted), shopping healthy; oauth refresh echoes.
cat > "$ROOT/mock-server.mjs" <<'MOCK'
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [portFile, logFile] = process.argv.slice(2);
let refreshCounter = 0;
const record = (l) => appendFileSync(logFile, `${l}\n`);
const send = (res, s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
const usage = (n) => ({
  five_hour: { utilization: n === "business" ? 44 : 12, resets_at: "2099-01-01T00:00:00.000Z" },
  seven_day: { utilization: n === "business" ? 100 : 23, resets_at: "2099-01-07T00:00:00.000Z" },
});
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/oauth/usage") {
    const auth = String(req.headers.authorization ?? "");
    const n = auth.includes("business-") ? "business" : auth.includes("shopping-") ? "shopping" : "unknown";
    record(`usage:${n}`);
    return n === "unknown" ? send(res, 401, { error: "unauthorized" }) : send(res, 200, usage(n));
  }
  if (req.method === "POST" && req.url === "/v1/oauth/token") {
    let raw = ""; req.setEncoding("utf8");
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body; try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "bad_json" }); }
      const refresh = String(body.refresh_token ?? "");
      const n = refresh.startsWith("business-") ? "business" : refresh.startsWith("shopping-") ? "shopping" : "unknown";
      record(`refresh:${n}`);
      if (n === "unknown") return send(res, 401, { error: "bad_refresh" });
      refreshCounter += 1;
      return send(res, 200, { access_token: `${n}-rotated-${refreshCounter}`, refresh_token: `${n}-refresh-${refreshCounter}`, expires_in: 3600 });
    });
    return;
  }
  send(res, 404, { error: "not_found" });
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, `${server.address().port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
MOCK
: > "$ROOT/http.log"
node "$ROOT/mock-server.mjs" "$ROOT/http-port" "$ROOT/http.log" > "$ROOT/mock.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do [[ -s "$ROOT/http-port" ]] && break; sleep 0.1; done
[[ -s "$ROOT/http-port" ]] || fail "mock server did not bind"
PORT="$(cat "$ROOT/http-port")"

base_env() { # extra guard bin override optional via $1
  local guard="${1:-$GUARD_BIN}"
  printf '%s\n' \
    "HOME=$HOME_DIR" "PATH=$ROOT/bin:$PATH" "USER=fly1252-qa" \
    "FLYWHEEL_QUOTA_API_BASE=http://127.0.0.1:$PORT" \
    "FLYWHEEL_CLAUDE_OAUTH_ENDPOINT=http://127.0.0.1:$PORT/v1/oauth/token" \
    "FLYWHEEL_CLAUDE_PROFILES_DIR=$POOL" \
    "FLYWHEEL_CLAUDE_ACCOUNTS_PATH=$STORE" \
    "FLYWHEEL_CLAUDE_ACCOUNTS_LOCK=$LOCK" \
    "FLYWHEEL_CLAUDE_SECURITY_BIN=$ROOT/bin/security" \
    "FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE=FLY-1252 QA-credentials" \
    "FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT=fly1252-qa" \
    "FLYWHEEL_CLAUDE_FRESHNESS_BIN=$FRESHNESS_BIN" \
    "FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN=$guard" \
    "FLYWHEEL_CLAUDE_JSON=$HOME_DIR/.claude.json" \
    "FLYWHEEL_CLAUDE_JSON_LOCK=$HOME_DIR/.claude.json.lock" \
    "FAKE_SECURITY_STATE=$KEYCHAIN_STATE" \
    "FAKE_SECURITY_ARGV_LOG=$SECURITY_LOG"
}
run_use() { # guard_bin target -> sets RC/OUT
  local guard="$1" target="$2"; mapfile -t E < <(base_env "$guard")
  if OUT="$(env -i "${E[@]}" bash "$PROFILE_BIN" use "$target" 2>&1)"; then RC=0; else RC=$?; fi
}

log "seeding a fresh healthy shopping observation (for the actionable suggestion)"
mapfile -t E < <(base_env); env -i "${E[@]}" "$GUARD_BIN" check --name shopping --pool "$POOL" --store "$STORE" >/dev/null

# ---- A. POSITIVE control: real guard, HEALTHY target (already active=shopping;
#         switch to shopping is a no-op re-select, so first move business under a
#         blinded guard, then switch back to the healthy account under the real
#         guard to prove a HEALTHY account still passes exit 0). ----
log "A/C setup: mutation — BLIND guard lets the EXHAUSTED business through"
before_kc="$(cat "$KEYCHAIN_STATE")"; before_active="$(cat "$POOL/.active")"
run_use "$ROOT/bin/blind-guard" business
[[ "$RC" -eq 0 ]] || fail "C: blinded guard should let the switch proceed, got rc=$RC :: $OUT"
[[ "$(cat "$POOL/.active")" == "business" ]] \
  || fail "C: incident did NOT reproduce — .active is '$(cat "$POOL/.active")', expected business"
[[ "$(cat "$KEYCHAIN_STATE")" != "$before_kc" ]] \
  || fail "C: blinded switch left the Keychain untouched (no real switch happened)"
log "C PASS: with the guard blinded, the launcher walked onto the dead account (incident reproduced)"

log "A: POSITIVE — real guard lets a HEALTHY target (shopping) switch back"
run_use "$GUARD_BIN" shopping
[[ "$RC" -eq 0 ]] || fail "A: healthy shopping switch was blocked, got rc=$RC :: $OUT"
[[ "$(cat "$POOL/.active")" == "shopping" ]] || fail "A: healthy switch did not take effect"
log "A PASS: real guard admits a healthy account (not a block-everything stub)"

# ---- B. FIX: real guard, EXHAUSTED target → exit 32, no mutation, truthful store ----
log "B: FIX — real guard refuses the EXHAUSTED business account"
before_kc="$(cat "$KEYCHAIN_STATE")"; before_active="$(cat "$POOL/.active")"
run_use "$GUARD_BIN" business
[[ "$RC" -eq 32 ]] || fail "B: exhausted use returned $RC, expected 32 :: $OUT"
grep -q 'FLYWHEEL_TARGET_QUOTA_EXHAUSTED business' <<<"$OUT" || fail "B: refusal marker missing"
[[ "$(cat "$KEYCHAIN_STATE")" == "$before_kc" ]] || fail "B: refusal mutated the Keychain"
[[ "$(cat "$POOL/.active")" == "$before_active" ]] || fail "B: refusal mutated .active"
[[ "$(jq -r '.accounts[]|select(.name=="business")|.observedSevenDPct' "$STORE")" == "100" ]] \
  || fail "B: business weekly observation not projected into the store"
[[ "$(jq -r '.accounts[]|select(.name=="business")|.quotaExhaustedUntil' "$STORE")" == "2099-01-07T00:00:00.000Z" ]] \
  || fail "B: business exhaustion/reset not persisted (store still lies)"
log "B PASS: exit 32, Keychain/.active untouched, truthful exhaustion projected"

# ---- credential-leak red line across all evidence ----
if grep -E 'shopping-access|business-access|shopping-refresh|business-refresh' \
    "$SECURITY_LOG" "$ROOT/http.log" >/dev/null; then
  fail "credential material leaked into argv/log evidence"
fi

log "ALL PASS — guard verdict is load-bearing: healthy passes (A), exhausted blocks (B),"
log "           blinding the guard reproduces the 2026-07-14 incident (C)."
