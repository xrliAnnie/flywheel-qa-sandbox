#!/usr/bin/env bash
# FLY-1252: hermetic incident replay for trustworthy Claude quota state.
#
# Exercises production launchers and compiled modules against scratch state:
#   1. weekly=100% target is refused before Keychain/.active mutation;
#   2. retired manual bypass input cannot weaken the live quota refusal;
#   3. daemon active+sweep observations project both windows into the store;
#   4. Bridge mode stays permanently cut over to the external quota daemon.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEAMLEAD_DIR="$REPO_DIR/packages/teamlead"
PROFILE_BIN="$REPO_DIR/packages/claude-runner/bin/flywheel-claude-profile"
FRESHNESS_BIN="$TEAMLEAD_DIR/bin/flywheel-claude-freshness"
GUARD_BIN="$TEAMLEAD_DIR/bin/flywheel-claude-quota-guard"
SCRATCH_PARENT="${TMPDIR:-/tmp}"
ROOT="$(mktemp -d "${SCRATCH_PARENT%/}/fly1252-e2e.XXXXXX")"
SERVER_PID=""

log() { echo "[FLY-1252 E2E] $*"; }
fail() { echo "[FLY-1252 E2E] FAIL: $*" >&2; exit 1; }
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill -TERM "$SERVER_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null || true
  if [[ "${FLYWHEEL_QUOTA_E2E_KEEP:-0}" == "1" ]]; then
    log "kept scratch evidence at $ROOT"
  else
    rm -rf "$ROOT"
  fi
}
on_error() {
  local rc=$?
  tail -60 "$ROOT/http.log" "$ROOT/incident.log" "$ROOT/retired-bypass.log" 2>/dev/null >&2 || true
  exit "$rc"
}
trap on_error ERR
trap cleanup EXIT

for tool in bash node pnpm jq sqlite3 shasum curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing prerequisite: $tool"
done
PROFILE_CURL_BIN="$(command -v curl)"
[[ -x "$PROFILE_BIN" && -x "$FRESHNESS_BIN" && -x "$GUARD_BIN" ]] \
  || fail "profile/freshness/quota-guard launchers must be executable"

log "building production teamlead artifacts"
pnpm --dir "$TEAMLEAD_DIR" build >/dev/null

HOME_DIR="$ROOT/home"
POOL="$ROOT/pool"
STORE="$HOME_DIR/.flywheel/claude-accounts.json"
LOCK="$HOME_DIR/.flywheel/claude-accounts.lock"
KEYCHAIN_STATE="$ROOT/keychain-state.json"
SECURITY_LOG="$ROOT/security-argv.log"
mkdir -p "$HOME_DIR/.flywheel" "$POOL" "$ROOT/bin" "$ROOT/queue" "$ROOT/deadletter"

make_credential() { # name access refresh canonical-email
  local name="$1" access="$2" refresh="$3" email="$4"
  mkdir -p "$POOL/$name"
  jq -cn --arg access "$access" --arg refresh "$refresh" \
    '{claudeAiOauth:{accessToken:$access,refreshToken:$refresh,expiresAt:4102444800000}}' \
    > "$POOL/$name/.credentials.json"
  chmod 600 "$POOL/$name/.credentials.json"
  jq -cn --arg name "$name" --arg email "$email" \
    '{accountUuid:("uuid-"+$name),emailAddress:$email,organizationUuid:("org-"+$name),organizationName:("Org "+$name)}' \
    > "$POOL/$name/oauthAccount.json"
  chmod 600 "$POOL/$name/oauthAccount.json"
  jq -cn --arg name "$name" --arg email "$email" \
    '{accountUuid:("uuid-"+$name),email:$email,anchoredAt:"2026-07-16T00:00:00.000Z",anchoredBy:"fly1252-hermetic-e2e",confirmedBy:"scratch-fixture"}' \
    > "$POOL/$name/identity-anchor.json"
  chmod 600 "$POOL/$name/identity-anchor.json"
}
make_credential shopping shopping-access shopping-refresh shopping@example.test
make_credential business business-access business-refresh business@example.test
printf 'shopping' > "$POOL/.active"
cp "$POOL/shopping/.credentials.json" "$KEYCHAIN_STATE"
chmod 600 "$KEYCHAIN_STATE"
mkdir -p "$HOME_DIR"
jq -n --slurpfile identity "$POOL/shopping/oauthAccount.json" \
  '{numStartups:1,oauthAccount:$identity[0]}' > "$HOME_DIR/.claude.json"
chmod 600 "$HOME_DIR/.claude.json"
jq -n '{generation:0,activeAccount:"shopping",accounts:[
  {name:"shopping",quotaExhaustedUntil:null,weeklyResetAt:null},
  {name:"business",quotaExhaustedUntil:null,weeklyResetAt:null}
]}' > "$STORE"
chmod 600 "$STORE"
: > "$SECURITY_LOG"

# Scratch replacement for macOS security. Credential values flow on stdin and
# never appear in argv, matching the production red line.
cat > "$ROOT/bin/security" <<'SECURITY'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SECURITY_ARGV_LOG"
case "${1:-}" in
  find-generic-password) cat "$FAKE_SECURITY_STATE" ;;
  -i)
    command_text="$(cat)"
    value="$(printf '%s' "$command_text" | sed -n 's/.* -w \([^ ]*\).*/\1/p')"
    [[ -n "$value" ]] || exit 2
    printf '%s' "$value" > "$FAKE_SECURITY_STATE"
    ;;
  *) exit 2 ;;
esac
SECURITY

# Force lead-alert.sh down its transient queue path without network access.
cat > "$ROOT/bin/curl" <<'CURL'
#!/usr/bin/env bash
cat >/dev/null
printf '500'
CURL
chmod +x "$ROOT/bin/security" "$ROOT/bin/curl"

# Notification delivery starts without alert env. The atomic sender loads these
# values from .env while preserving the explicit scratch process environment.
cat > "$HOME_DIR/.flywheel/.env" <<ENV
FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=fly1252-e2e-channel
FLYWHEEL_NOTIFY_CHANNEL=fly1252-e2e-channel
FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLY1252_E2E_TOKEN
FLY1252_E2E_TOKEN=not-a-real-token
FLYWHEEL_ALERT_QUEUE_DIR=$ROOT/queue
FLYWHEEL_ALERT_DEADLETTER_DIR=$ROOT/deadletter
FLYWHEEL_CLAIMS_DB=$ROOT/claims.db
ENV
chmod 600 "$HOME_DIR/.flywheel/.env"

cat > "$ROOT/mock-server.mjs" <<'MOCK'
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [portFile, logFile] = process.argv.slice(2);
let refreshCounter = 0;
const record = (line) => appendFileSync(logFile, `${line}\n`);
const send = (res, status, body) => {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(raw);
};
const usage = (name) => ({
  five_hour: { utilization: name === "business" ? 44 : 12, resets_at: "2099-01-01T00:00:00.000Z" },
  seven_day: { utilization: name === "business" ? 100 : 23, resets_at: "2099-01-07T00:00:00.000Z" },
});
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/oauth/profile") {
    const auth = String(req.headers.authorization ?? "");
    const name = auth.includes("business-") ? "business" : auth.includes("shopping-") ? "shopping" : "unknown";
    record(`identity:${name}`);
    if (name === "unknown") return send(res, 401, { error: "unauthorized" });
    return send(res, 200, {
      account: { uuid: `uuid-${name}`, email: `${name}@example.test` },
    });
  }
  if (req.method === "GET" && req.url === "/api/oauth/usage") {
    const auth = String(req.headers.authorization ?? "");
    const name = auth.includes("business-") ? "business" : auth.includes("shopping-") ? "shopping" : "unknown";
    record(`usage:${name}`);
    return name === "unknown" ? send(res, 401, { error: "unauthorized" }) : send(res, 200, usage(name));
  }
  if (req.method === "POST" && req.url === "/v1/oauth/token") {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "bad_json" }); }
      const refresh = String(body.refresh_token ?? "");
      const name = refresh.startsWith("business-") ? "business" : refresh.startsWith("shopping-") ? "shopping" : "unknown";
      record(`refresh:${name}`);
      if (name === "unknown") return send(res, 401, { error: "bad_refresh" });
      refreshCounter += 1;
      return send(res, 200, {
        access_token: `${name}-rotated-${refreshCounter}`,
        refresh_token: `${name}-refresh-${refreshCounter}`,
        expires_in: 3600,
      });
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

COMMON_ENV=(
  "HOME=$HOME_DIR"
  "PATH=$ROOT/bin:$PATH"
  "USER=fly1252-e2e"
  "FLYWHEEL_QUOTA_API_BASE=http://127.0.0.1:$PORT"
  "FLYWHEEL_CLAUDE_OAUTH_ENDPOINT=http://127.0.0.1:$PORT/v1/oauth/token"
  "FLYWHEEL_PROFILE_IDENTITY_ENDPOINT=http://127.0.0.1:$PORT/v1/oauth/profile"
  "FLYWHEEL_CLAUDE_PROFILES_DIR=$POOL"
  "FLYWHEEL_CLAUDE_PROFILE_BIN=$PROFILE_BIN"
  "FLYWHEEL_CLAUDE_ACCOUNTS_PATH=$STORE"
  "FLYWHEEL_CLAUDE_ACCOUNTS_LOCK=$LOCK"
  "FLYWHEEL_CLAUDE_SECURITY_BIN=$ROOT/bin/security"
  "FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE=FLY-1252 Scratch-credentials"
  "FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT=fly1252-e2e"
  "FLYWHEEL_CLAUDE_FRESHNESS_BIN=$FRESHNESS_BIN"
  "FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN=$GUARD_BIN"
  "FLYWHEEL_PROFILE_CURL_BIN=$PROFILE_CURL_BIN"
  "FLYWHEEL_CLAUDE_JSON=$HOME_DIR/.claude.json"
  "FLYWHEEL_CLAUDE_JSON_LOCK=$HOME_DIR/.claude.json.lock"
  "FAKE_SECURITY_STATE=$KEYCHAIN_STATE"
  "FAKE_SECURITY_ARGV_LOG=$SECURITY_LOG"
)

log "seeding a fresh healthy observation for the actionable suggestion"
env "${COMMON_ENV[@]}" "$GUARD_BIN" check --name shopping --pool "$POOL" --store "$STORE"

log "replaying the incident: manual use of a weekly-exhausted business account"
before_keychain="$(cat "$KEYCHAIN_STATE")"
before_active="$(cat "$POOL/.active")"
if incident_output="$(env "${COMMON_ENV[@]}" bash "$PROFILE_BIN" use business 2>&1)"; then
  incident_rc=0
else
  incident_rc=$?
fi
printf '%s\n' "$incident_output" > "$ROOT/incident.log"
[[ "$incident_rc" -eq 32 ]] || fail "weekly-exhausted use returned $incident_rc, expected 32"
grep -q 'FLYWHEEL_MANUAL_NO_TARGET business:quota_exhausted' "$ROOT/incident.log" \
  || fail "atomic selector refusal marker/panorama missing"
[[ "$(cat "$KEYCHAIN_STATE")" == "$before_keychain" ]] || fail "refusal mutated Keychain"
[[ "$(cat "$POOL/.active")" == "$before_active" ]] || fail "refusal mutated .active"
[[ "$(jq -r '.accounts[] | select(.name=="business") | .observedSevenDPct' "$STORE")" == "100" ]] \
  || fail "business weekly observation was not projected"
[[ "$(jq -r '.accounts[] | select(.name=="business") | .quotaExhaustedUntil' "$STORE")" == "2099-01-07T00:00:00.000Z" ]] \
  || fail "business exhaustion/reset was not persisted"

log "verifying a retired manual bypass name cannot weaken quota refusal"
: > "$ROOT/retired-bypass.log"
retired_quota_bypass="FLY""WHEEL_CLAUDE_QUOTA_BYPASS"
for _ in 1 2; do
	if env -i "${COMMON_ENV[@]}" "${retired_quota_bypass}=1" \
		bash "$PROFILE_BIN" use business >> "$ROOT/retired-bypass.log" 2>&1; then
		fail "retired bypass input unexpectedly admitted an exhausted account"
	else
		[[ "$?" -eq 32 ]] || fail "retired bypass refusal returned an unexpected status"
	fi
done
grep -q 'FLYWHEEL_MANUAL_NO_TARGET business:quota_exhausted' "$ROOT/retired-bypass.log" \
	|| fail "retired bypass input did not preserve the fail-closed panorama"
[[ "$(cat "$KEYCHAIN_STATE")" == "$before_keychain" ]] || fail "retired bypass input mutated Keychain"
[[ "$(cat "$POOL/.active")" == "$before_active" ]] || fail "retired bypass input mutated .active"
if grep -R -q 'quota_guard_bypassed' "$ROOT/queue" 2>/dev/null; then
	fail "retired bypass input emitted a legacy bypass audit"
fi

# Compiled-module E2E for daemon projection and the permanent Bridge cutover.
# All writes stay under the scratch root.
cat > "$ROOT/runtime-replay.mjs" <<'RUNTIME'
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const dist = process.env.TEAMLEAD_DIST;
const load = (rel) => import(pathToFileURL(join(dist, rel)).href);
const { makeQuotaMonitorRuntime } = await load("account-heal/quota-monitor-runtime.js");
const { readStore, writeStore } = await load("account-heal/account-store.js");
const { resolveQuotaDaemonBridgeMode } = await load("bridge/quota-daemon-cutover.js");

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const RESET_5H = "2026-07-16T17:00:00.000Z";
const RESET_7D = "2026-07-20T19:00:00.000Z";
const daemonRoot = join(root, "daemon");
const poolDir = join(daemonRoot, "pool");
const storePath = join(daemonRoot, "accounts.json");
const configPath = join(daemonRoot, "config.json");
const statePath = join(daemonRoot, "state.json");
const cachePath = join(daemonRoot, "cache.json");
const lockPath = join(daemonRoot, "accounts.lock");
const claudeJsonPath = join(daemonRoot, ".claude.json");
mkdirSync(poolDir, { recursive: true });
for (const name of ["shopping", "business", "school"]) {
  mkdirSync(join(poolDir, name), { recursive: true });
  writeFileSync(join(poolDir, name, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: `${name}-token`, refreshToken: `${name}-refresh`, expiresAt: 4102444800000 },
  }), { mode: 0o600 });
  writeFileSync(join(poolDir, name, "oauthAccount.json"), JSON.stringify({
    accountUuid: `uuid-${name}`,
    emailAddress: `${name}@example.test`,
    organizationUuid: `org-${name}`,
    organizationName: `Org ${name}`,
  }), { mode: 0o600 });
  writeFileSync(join(poolDir, name, "identity-anchor.json"), JSON.stringify({
    accountUuid: `uuid-${name}`,
    anchoredAt: "2026-07-16T11:00:00.000Z",
    anchoredBy: "qa-fly-1252",
    confirmedBy: "oauth-profile",
    email: `${name}@example.test`,
  }), { mode: 0o600 });
}
writeFileSync(join(poolDir, ".active"), "shopping");
writeFileSync(claudeJsonPath, JSON.stringify({
  oauthAccount: {
    accountUuid: "uuid-shopping",
    emailAddress: "shopping@example.test",
    organizationUuid: "org-shopping",
    organizationName: "Org shopping",
  },
}), { mode: 0o600 });
writeStore({
  generation: 4,
  activeAccount: "shopping",
  accounts: ["shopping", "business", "school"].map((name) => ({ name, quotaExhaustedUntil: null, weeklyResetAt: null })),
}, storePath);
writeFileSync(configPath, JSON.stringify({
  trigger5hPct: 90,
  basePollMinutes: 20,
  acceleratePct: 70,
  acceleratedPollMinutes: 10,
  candidateSweepMinutes: 60,
  minSwitchIntervalMinutes: 15,
  order: ["shopping", "business", "school"],
  writeStatuslineCache: true,
}));
// Active usage is accelerated (>70) but below the switch trigger (<90), so
// this tick performs both the active projection and the due candidate sweep.
const pct = { shopping: [75, 21], business: [31, 41], school: [51, 61] };
const usageFor = (token) => {
  const name = token.split("-")[0];
  const [five, seven] = pct[name];
  const raw = {
    five_hour: { utilization: five, resets_at: RESET_5H },
    seven_day: { utilization: seven, resets_at: RESET_7D },
  };
  return { ok: { raw, fiveH: { pct: five, resetsAt: RESET_5H }, sevenD: { pct: seven, resetsAt: RESET_7D } } };
};
const runtime = makeQuotaMonitorRuntime({
  now: () => NOW,
  paths: { poolDir, storePath, configPath, statePath, cachePath, lockPath, claudeJsonPath },
  readKeychainCredential: async () => ({ accessToken: "shopping-token", expiresAt: 4102444800000 }),
  fetchUsage: async (token) => usageFor(token),
  fetchIdentity: async () => ({ email: "shopping@example.test", uuid: "uuid-shopping" }),
  verifyCandidate: async () => ({ fresh: "refreshed", expiresAt: 4102444800000 }),
  tmux: { listPanes: async () => [], capturePane: async () => "", sendContinue: async () => undefined },
  alert: async () => undefined,
});
await runtime.tick();
const projected = readStore(storePath);
for (const [name, expected] of Object.entries(pct)) {
  const entry = projected.accounts.find((account) => account.name === name);
  assert.equal(entry.observedFiveHPct, expected[0], `${name} 5h projection`);
  assert.equal(entry.observedSevenDPct, expected[1], `${name} 7d projection`);
  assert.equal(entry.lastObservedAt, new Date(NOW).toISOString(), `${name} observedAt`);
  assert.equal(entry.weeklyResetAt, RESET_7D, `${name} weekly reset`);
}

const bridgeMode = resolveQuotaDaemonBridgeMode();
assert.deepEqual(bridgeMode, {
  cutover: true,
  attachAccountSwitch: false,
  retireAccountSwitchRoute: true,
  quarantinePending: true,
  runRunnerQuotaScan: true,
});

writeFileSync(join(root, "runtime-pass"), "daemon projection + permanent cutover passed\n");
RUNTIME

log "verifying daemon observation projection and permanent Bridge cutover"
TEAMLEAD_DIST="$TEAMLEAD_DIR/dist" node "$ROOT/runtime-replay.mjs" "$ROOT"
[[ -s "$ROOT/runtime-pass" ]] || fail "compiled runtime replay did not complete"

if grep -E 'shopping-access|business-access|shopping-refresh|business-refresh' \
    "$SECURITY_LOG" "$ROOT/incident.log" "$ROOT/retired-bypass.log" "$ROOT/http.log" "$ROOT/queue"/*.json >/dev/null; then
  fail "credential material leaked into argv/log/alert evidence"
fi

log "PASS: weekly exhaustion refused with actionable suggestion and no Keychain mutation"
log "PASS: retired bypass input stayed fail-closed without Keychain or marker mutation"
log "PASS: daemon store projection is authoritative and Bridge account-switch execution stays retired"
