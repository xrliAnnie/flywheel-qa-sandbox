#!/usr/bin/env bash
# FLY-1256 M6: hermetic on-machine E2E for the Claude-external quota daemon.
#
# This launches the real compiled daemon against a local OAuth/usage server, a
# scratch Keychain adapter, the real flywheel-claude-profile switch script, an
# isolated tmux server, and an isolated alert sink. No production credential,
# tmux server, alert channel, config, store, cache, or lock is reachable.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEAMLEAD_DIR="$REPO_DIR/packages/teamlead"
DAEMON_BIN="$TEAMLEAD_DIR/bin/flywheel-quota-monitor"
PROFILE_BIN="$REPO_DIR/packages/claude-runner/bin/flywheel-claude-profile"
FRESHNESS_BIN="$TEAMLEAD_DIR/bin/flywheel-claude-freshness"
PANE_FIXTURE="$TEAMLEAD_DIR/src/__tests__/fixtures/lead-panes/usage-limit-real.txt"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1256-e2e.XXXXXX")"
TMUX_SOCKET="fly1256-e2e-$$"
SERVER_PID="" DAEMON_PID=""

log() { echo "[FLY-1256 E2E] $*"; }
fail() { echo "[FLY-1256 E2E] FAIL: $*" >&2; exit 1; }
cleanup() {
  [[ -n "$DAEMON_PID" ]] && kill -TERM "$DAEMON_PID" 2>/dev/null || true
  [[ -n "$DAEMON_PID" ]] && wait "$DAEMON_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill -TERM "$SERVER_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null || true
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  if [[ "${FLYWHEEL_QUOTA_E2E_KEEP:-0}" == "1" ]]; then
    log "kept scratch evidence at $ROOT"
  else
    rm -rf "$ROOT"
  fi
}
on_error() {
  rc=$?
  echo "[FLY-1256 E2E] diagnostic tail:" >&2
  tail -40 "$ROOT/daemon.log" "$ROOT/http.log" "$ROOT/alerts.log" 2>/dev/null >&2 || true
  exit "$rc"
}
trap on_error ERR
trap cleanup EXIT

for tool in node pnpm jq tmux ps; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing prerequisite: $tool"
done
[[ -x "$DAEMON_BIN" && -x "$PROFILE_BIN" && -x "$FRESHNESS_BIN" ]] \
  || fail "quota/profile/freshness launchers must be executable"
[[ -f "$PANE_FIXTURE" ]] || fail "quota pane fixture missing: $PANE_FIXTURE"

log "building the production daemon entry"
pnpm --dir "$TEAMLEAD_DIR" build >/dev/null

mkdir -p "$ROOT/home/.flywheel" "$ROOT/home/.claude" "$ROOT/pool" "$ROOT/bin"
POOL="$ROOT/pool"
STORE="$ROOT/home/.flywheel/claude-accounts.json"
LOCK="$ROOT/home/.flywheel/claude-accounts.lock"
CONFIG="$ROOT/home/.flywheel/quota-monitor.json"
STATE="$ROOT/home/.flywheel/quota-monitor-state.json"
PIDFILE="$ROOT/home/.flywheel/quota-monitor.pid"
CACHE="$ROOT/home/.claude/usage-api-cache.json"
KEYCHAIN_STATE="$ROOT/keychain-state.json"

make_credential() { # profile access refresh
  local profile="$1" access="$2" refresh="$3"
  mkdir -p "$POOL/$profile"
  jq -cn --arg access "$access" --arg refresh "$refresh" \
    '{claudeAiOauth:{accessToken:$access,refreshToken:$refresh,expiresAt:4102444800000}}' \
    > "$POOL/$profile/.credentials.json"
  chmod 600 "$POOL/$profile/.credentials.json"
  jq -cn --arg suffix "$profile" \
    '{accountUuid:("uuid-"+$suffix),emailAddress:($suffix+"@example.test"),organizationUuid:("org-"+$suffix),organizationName:("Org "+$suffix)}' \
    > "$POOL/$profile/oauthAccount.json"
  chmod 600 "$POOL/$profile/oauthAccount.json"
}
make_credential shopping shopping-active shopping-refresh
make_credential school school-old school-refresh
make_credential backup backup-old backup-refresh
printf 'shopping\n' > "$POOL/.active"
cp "$POOL/shopping/.credentials.json" "$KEYCHAIN_STATE"
chmod 600 "$KEYCHAIN_STATE"
jq -n '{generation:0,activeAccount:"shopping",accounts:["shopping","school","backup"]|map({name:.,quotaExhaustedUntil:null,weeklyResetAt:null})}' > "$STORE"
chmod 600 "$STORE"
jq -n '{
  trigger5hPct:90,
  basePollMinutes:1,
  acceleratePct:70,
  acceleratedPollMinutes:1,
  candidateSweepMinutes:60,
  minSwitchIntervalMinutes:1,
  order:["shopping","school","backup"],
  writeStatuslineCache:true
}' > "$CONFIG"
chmod 600 "$CONFIG"
cp "$POOL/shopping/oauthAccount.json" "$ROOT/active-identity.json"
jq -n --slurpfile identity "$ROOT/active-identity.json" '{numStartups:1,oauthAccount:$identity[0]}' \
  > "$ROOT/home/.claude.json"
chmod 600 "$ROOT/home/.claude.json"

# Scratch replacement for macOS `security`: secrets flow on stdin for writes,
# never argv, matching the real flywheel-claude-profile contract.
cat > "$ROOT/bin/security" <<'SECURITY'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SECURITY_ARGV_LOG"
case "${1:-}" in
  find-generic-password)
    cat "$FAKE_SECURITY_STATE"
    ;;
  -i)
    command_text="$(cat)"
    value="$(printf '%s' "$command_text" | sed -n 's/.* -w \([^ ]*\).*/\1/p')"
    [[ -n "$value" ]] || exit 2
    printf '%s' "$value" > "$FAKE_SECURITY_STATE"
    ;;
  *) exit 2 ;;
esac
SECURITY

# A sentinel proves no Claude executable participates in detection/switching.
cat > "$ROOT/bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf 'unexpected claude invocation: %s\n' "$*" >> "$CLAUDE_PARTICIPATION_LOG"
exit 99
CLAUDE

cat > "$ROOT/bin/lead-alert" <<'ALERT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_ALERT_LOG"
printf 'sent\n'
ALERT
chmod +x "$ROOT/bin/security" "$ROOT/bin/claude" "$ROOT/bin/lead-alert"
: > "$ROOT/security-argv.log"
: > "$ROOT/alerts.log"
: > "$ROOT/claude-participation.log"

# Local server logs only account classes and request ordering, never tokens.
cat > "$ROOT/mock-server.mjs" <<'MOCK'
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [portFile, logFile] = process.argv.slice(2);
let refreshCounter = 0;
const record = (line) => appendFileSync(logFile, `${line}\n`);
const json = (res, status, body) => {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
};
const usage = (account) => ({
  five_hour: { utilization: account === "shopping" ? 92 : account === "school" ? 3 : 4, resets_at: "2099-01-01T00:00:00.000Z" },
  seven_day: { utilization: account === "shopping" ? 20 : 10, resets_at: "2099-01-07T00:00:00.000Z" },
});
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/oauth/usage") {
    const auth = String(req.headers.authorization ?? "");
    const account = auth.includes("shopping-") ? "shopping" : auth.includes("school-") ? "school" : auth.includes("backup-") ? "backup" : "unknown";
    record(`usage:${account}`);
    if (account === "unknown") return json(res, 401, { error: "unauthorized" });
    return json(res, 200, usage(account));
  }
  if (req.method === "POST" && req.url === "/v1/oauth/token") {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "bad_json" }); }
      const refresh = String(body.refresh_token ?? "");
      const account = refresh.startsWith("school-") ? "school" : refresh.startsWith("backup-") ? "backup" : "unknown";
      record(`refresh:${account}`);
      if (account === "unknown") return json(res, 401, { error: "bad_refresh" });
      refreshCounter += 1;
      return json(res, 200, {
        access_token: `${account}-rotated-${refreshCounter}`,
        refresh_token: `${account}-refresh-${refreshCounter}`,
        expires_in: 3600,
      });
    });
    return;
  }
  json(res, 404, { error: "not_found" });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  writeFileSync(portFile, `${address.port}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
MOCK
: > "$ROOT/http.log"
node "$ROOT/mock-server.mjs" "$ROOT/http-port" "$ROOT/http.log" > "$ROOT/mock.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do [[ -s "$ROOT/http-port" ]] && break; sleep 0.1; done
[[ -s "$ROOT/http-port" ]] || fail "mock server did not bind"
PORT="$(cat "$ROOT/http-port")"

# The pane is deliberately only a shell reading stdin: it renders the captured
# quota fixture but no Claude process exists to help the daemon recover it.
cat > "$ROOT/quota-pane.sh" <<PANE
#!/usr/bin/env bash
cat "$PANE_FIXTURE"
IFS= read -r response
printf '%s\n' "\$response" > "$ROOT/pane-response"
while :; do sleep 60; done
PANE
chmod +x "$ROOT/quota-pane.sh"
# Match a real Lead pane width so the audited cap sentence remains one line;
# the classifier deliberately rejects a sentence wrapped before its period.
tmux -L "$TMUX_SOCKET" new-session -d -x 220 -y 20 -s quota-dead "$ROOT/quota-pane.sh"
for _ in $(seq 1 50); do
  tmux -L "$TMUX_SOCKET" capture-pane -p -t quota-dead 2>/dev/null | grep -q 'Claude usage limit reached' && break
  sleep 0.1
done
tmux -L "$TMUX_SOCKET" capture-pane -p -t quota-dead | grep -q 'Claude usage limit reached' \
  || fail "isolated tmux pane never rendered the quota fixture"

export HOME="$ROOT/home"
export PATH="$ROOT/bin:$PATH"
export FLYWHEEL_QUOTA_MONITOR_CONFIG="$CONFIG"
export FLYWHEEL_QUOTA_API_BASE="http://127.0.0.1:$PORT"
export FLYWHEEL_QUOTA_STATUSLINE_CACHE="$CACHE"
export FLYWHEEL_QUOTA_TMUX_SOCKET="$TMUX_SOCKET"
export FLYWHEEL_QUOTA_STATE_PATH="$STATE"
export FLYWHEEL_QUOTA_PIDFILE="$PIDFILE"
export FLYWHEEL_CLAUDE_PROFILES_DIR="$POOL"
export FLYWHEEL_CLAUDE_ACCOUNTS_PATH="$STORE"
export FLYWHEEL_CLAUDE_ACCOUNTS_LOCK="$LOCK"
export FLYWHEEL_CLAUDE_SECURITY_BIN="$ROOT/bin/security"
export FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE="FLY-1256 Scratch-credentials"
export FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT="fly1256-e2e"
export FLYWHEEL_CLAUDE_PROFILE_BIN="$PROFILE_BIN"
export FLYWHEEL_CLAUDE_FRESHNESS_BIN="$FRESHNESS_BIN"
export FLYWHEEL_CLAUDE_OAUTH_ENDPOINT="http://127.0.0.1:$PORT/v1/oauth/token"
export FLYWHEEL_CLAUDE_JSON="$ROOT/home/.claude.json"
export FLYWHEEL_CLAUDE_JSON_LOCK="$ROOT/home/.claude.json.lock"
export FLYWHEEL_LEAD_ALERT_BIN="$ROOT/bin/lead-alert"
export FAKE_SECURITY_STATE="$KEYCHAIN_STATE"
export FAKE_SECURITY_ARGV_LOG="$ROOT/security-argv.log"
export FAKE_ALERT_LOG="$ROOT/alerts.log"
export CLAUDE_PARTICIPATION_LOG="$ROOT/claude-participation.log"

log "starting real daemon with Claude absent"
"$DAEMON_BIN" > "$ROOT/daemon.log" 2>&1 &
DAEMON_PID=$!
sleep 0.2
kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon exited during startup"
for _ in $(seq 1 50); do [[ -s "$PIDFILE" ]] && break; sleep 0.1; done
[[ "$(jq -r '.pid // empty' "$PIDFILE" 2>/dev/null)" == "$DAEMON_PID" ]] \
  || fail "singleton pidfile is not owned by the daemon"
if daemon_comm="$(ps -p "$DAEMON_PID" -o comm= 2>/dev/null | sed 's|.*/||' | tr -d ' ')" \
  && [[ -n "$daemon_comm" ]]; then
  [[ "$daemon_comm" == "node" ]] || fail "daemon owner is not Node (comm=$daemon_comm)"
  ps_proof="ps"
else
  # Some CI/sandbox hosts deny /bin/ps. The pidfile owner plus the claude
  # executable sentinel still proves the tested process path; unsandboxed
  # on-machine QA records the stronger ps branch above.
  daemon_comm="node(pidfile)"
  ps_proof="pidfile+exec-sentinel (ps unavailable)"
fi

for _ in $(seq 1 300); do
  [[ "$(cat "$POOL/.active" 2>/dev/null || true)" == "school" ]] \
    && [[ "$(cat "$ROOT/pane-response" 2>/dev/null || true)" == "continue" ]] \
    && grep -q -- '--kind account_switched' "$ROOT/alerts.log" 2>/dev/null \
    && break
  sleep 0.1
done

[[ "$(cat "$POOL/.active")" == "school" ]] || fail "profile did not switch shopping -> school"
[[ "$(jq -r '.activeAccount' "$STORE")" == "school" ]] || fail "CAS store did not commit school"
[[ "$(jq -r '.generation' "$STORE")" == "1" ]] || fail "CAS generation did not increment exactly once"
[[ "$(cat "$ROOT/pane-response")" == "continue" ]] || fail "quota-stuck pane was not revived with literal continue+Enter"
grep -q -- '--kind account_switched' "$ROOT/alerts.log" || fail "isolated alert sink missed account_switched"
grep -q -- '--strict-delivery' "$ROOT/alerts.log" || fail "alert did not use strict delivery"
[[ "$(jq -r '.five_hour.utilization' "$CACHE")" == "3" ]] || fail "statusline cache was not refreshed from new account"
[[ "$(jq -r '[.reviveEpoch.panes[].attempts] | max' "$STATE")" == "1" ]] || fail "revive attempt was not durably recorded"
[[ "$(jq -r '.claudeAiOauth.accessToken | startswith("school-rotated-")' "$KEYCHAIN_STATE")" == "true" ]] \
  || fail "scratch Keychain was not switched to refreshed school credential"

school_line="$(grep -n -m1 '^refresh:school$' "$ROOT/http.log" | cut -d: -f1)"
backup_line="$(grep -n -m1 '^refresh:backup$' "$ROOT/http.log" | cut -d: -f1)"
[[ -n "$school_line" && -n "$backup_line" && "$school_line" -lt "$backup_line" ]] \
  || fail "candidate validation did not follow school before backup"

[[ ! -s "$ROOT/claude-participation.log" ]] || fail "a Claude executable participated"
pane_pid="$(tmux -L "$TMUX_SOCKET" list-panes -t quota-dead -F '#{pane_pid}')"
if pane_comm="$(ps -p "$pane_pid" -o comm= 2>/dev/null | sed 's|.*/||' | tr -d ' ')" \
  && [[ -n "$pane_comm" ]]; then
  [[ "$pane_comm" != "claude" ]] || fail "quota fixture pane unexpectedly runs Claude"
else
  pane_comm="shell(pidfile)"
fi

# Secrets may exist only in the scratch pool/Keychain. They must not cross argv,
# state, cache, daemon logs, HTTP classification logs, or alert payloads.
if grep -E 'shopping-active|school-old|backup-old|shopping-refresh|school-refresh|backup-refresh' \
    "$ROOT/security-argv.log" "$STATE" "$CACHE" "$ROOT/daemon.log" "$ROOT/http.log" "$ROOT/alerts.log" >/dev/null; then
  fail "credential material leaked outside scratch pool/Keychain"
fi

kill -TERM "$DAEMON_PID"
wait "$DAEMON_PID"
DAEMON_PID=""
[[ ! -e "$PIDFILE" ]] || fail "graceful shutdown left the singleton pidfile behind"

log "PASS: cache updated, school validated before backup, Keychain/store switched, quota pane revived, alert isolated"
log "PASS: daemon=$daemon_comm pane=$pane_comm proof=$ps_proof; fake claude invocation count=0"
