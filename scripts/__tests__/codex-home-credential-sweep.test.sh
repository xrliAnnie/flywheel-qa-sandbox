#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/codex-home-credential-sweep.mjs"
TMP_ROOT="$(mktemp -d /tmp/fly2404-sweep.XXXXXX)"
SERVER_PIDS=()
cleanup() {
	for pid in "${SERVER_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
	rm -rf "$TMP_ROOT"
}
trap cleanup EXIT
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

write_auth() {
	python3 - "$1" "$2" <<'PY'
import base64, json, os, pathlib, sys
path = pathlib.Path(sys.argv[1]); path.parent.mkdir(parents=True, exist_ok=True)
encode = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
id_token = ".".join((encode({"alg":"none"}), encode({"https://api.openai.com/auth":{"chatgpt_account_id":"acct-fixture"}}), "sig"))
path.write_text(json.dumps({"tokens":{"id_token":id_token,"refresh_token":sys.argv[2]}}))
os.chmod(path, 0o600)
PY
}

make_db() {
	mkdir -p "$(dirname "$1")"
	sqlite3 "$1" 'CREATE TABLE sessions (execution_id TEXT PRIMARY KEY);'
	[ -z "${2:-}" ] || sqlite3 "$1" "INSERT INTO sessions VALUES ('$2');"
}

start_bridge() {
	local t="$1"
	cat > "$t/bridge.py" <<'PY'
import json, pathlib, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

root = pathlib.Path(sys.argv[1])
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, status, value):
        body = json.dumps(value).encode(); self.send_response(status)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def authorized(self): return self.headers.get("Authorization") == "Bearer fixture-token"
    def do_GET(self):
        if not self.authorized(): return self.reply(401, {"error":"unauthorized"})
        if self.path.startswith("/api/sessions"):
            active = (root / "bridge-active").read_text().strip()
            return self.reply(200, {"sessions": ([{"execution_id":active}] if active else []), "count": (1 if active else 0)})
        if self.path == "/api/admission/quiescence":
            return self.reply(200, {"quiescent": (root / "quiescent").read_text().strip() == "true"})
        if self.path == "/health":
            value = {"ok":True,"uptime":int((root / "uptime").read_text())}
            if (root / "health-contract").read_text().strip() == "real":
                value["admissionPause"] = {"active":True,"remainingSeconds":900}
            return self.reply(200, value)
        self.reply(404, {})
    def do_POST(self):
        if not self.authorized(): return self.reply(401, {"error":"unauthorized"})
        length = int(self.headers.get("Content-Length", "0")); raw = self.rfile.read(length)
        try: body = json.loads(raw)
        except Exception: return self.reply(400, {"error":"body"})
        with (root / "calls").open("a") as log: log.write(self.path + "\t" + json.dumps(body, sort_keys=True) + "\n")
        lease = "123e4567-e89b-42d3-a456-426614174000"
        if self.path == "/api/admission/pause":
            if body.get("durationSeconds") != 900 or body.get("reason") != "fly2404-sweep": return self.reply(400,{"error":"contract"})
            if "leaseId" in body and body["leaseId"] != lease: return self.reply(409,{"error":"lease"})
            return self.reply(200,{"ok":True,"admissionPause":{"active":True,"leaseId":lease}})
        if self.path == "/api/admission/resume":
            if body.get("leaseId") != lease: return self.reply(409,{"error":"lease"})
            return self.reply(200,{"ok":True,"resumed":True})
        self.reply(404,{})

server = HTTPServer(("127.0.0.1", 0), Handler)
(root / "port").write_text(str(server.server_port))
server.serve_forever()
PY
	printf '%s\n' true > "$t/quiescent"
	printf '%s\n' 600 > "$t/uptime"
	printf '%s\n' real > "$t/health-contract"
	: > "$t/calls"
	python3 "$t/bridge.py" "$t" & SERVER_PIDS+=("$!")
	for _ in $(seq 1 100); do [ -s "$t/port" ] && break; sleep 0.02; done
}

make_fixture() {
	local t="$1"
	local homes="$t/home/.flywheel/codex-homes"
	mkdir -p "$homes" "$t/home/.codex/profiles/business" \
		"$t/home/.flywheel/codex-credential-backups" "$t/home/.codex-lead" \
		"$t/home/.flywheel/raya/codex-home" "$t/reports" "$t/bin"
	INACTIVE="11111111-1111-4111-8111-111111111111"
	ACTIVE_DB="22222222-2222-4222-8222-222222222222"
	ACTIVE_BRIDGE="33333333-3333-4333-8333-333333333333"
	ACTIVE_PS="44444444-4444-4444-8444-444444444444"
	ACTIVE_LEASE="55555555-5555-4555-8555-555555555555"
	MALFORMED="66666666-6666-4666-8666-666666666666"
	LINKED="77777777-7777-4777-8777-777777777777"
	for id in "$INACTIVE" "$ACTIVE_DB" "$ACTIVE_BRIDGE" "$ACTIVE_PS" "$ACTIVE_LEASE"; do
		write_auth "$homes/$id/auth.json" "refresh-$id"
	done
	mkdir -p "$homes/$ACTIVE_LEASE/.flywheel-leases"
	printf lease > "$homes/$ACTIVE_LEASE/.flywheel-leases/live"
	write_auth "$homes/agents/flywheel/implement/auth.json" keyed
	mkdir -p "$homes/$MALFORMED" "$homes/$LINKED" "$t/link-target"
	printf '%s\n' not-json > "$homes/$MALFORMED/auth.json"
	chmod 600 "$homes/$MALFORMED/auth.json"
	write_auth "$t/link-target/auth.json" linked
	ln -s "$t/link-target/auth.json" "$homes/$LINKED/auth.json"
	write_auth "$t/home/.codex-lead/auth.json" lead
	write_auth "$t/home/.flywheel/raya/codex-home/auth.json" raya
	write_auth "$t/home/.codex/profiles/business/auth.json" profile
	write_auth "$t/home/.flywheel/codex-credential-backups/old.json" old
	write_auth "$t/home/.flywheel/codex-credential-backups/new.json" new
	touch -t 202608010000 "$t/home/.flywheel/codex-credential-backups/old.json"
	make_db "$t/home/.flywheel/comm/a/comm.db"
	make_db "$t/home/.flywheel/comm/b/comm.db" "$ACTIVE_DB"
	make_db "$t/home/.flywheel/comm.db"
	printf '%s\n' "$ACTIVE_BRIDGE" > "$t/bridge-active"
	cat > "$t/bin/ps" <<EOF
#!/usr/bin/env bash
printf '%s\n' '900 codex CODEX_HOME=$homes/$ACTIVE_PS'
EOF
	chmod +x "$t/bin/ps"
	start_bridge "$t"
}

run_sweep() {
	local t="$1"; shift
	HOME="$t/home" TEAMLEAD_API_TOKEN="${SWEEP_TOKEN:-fixture-token}" \
	FLYWHEEL_CODEX_HOMES_ROOT="$t/home/.flywheel/codex-homes" \
	FLYWHEEL_CODEX_SWEEP_COMM_ROOT="$t/home/.flywheel/comm" \
	FLYWHEEL_CODEX_SWEEP_ROOT_COMM_DB="$t/home/.flywheel/comm.db" \
	FLYWHEEL_CODEX_SWEEP_BRIDGE_URL="http://127.0.0.1:$(cat "$t/port")" \
	FLYWHEEL_CODEX_SWEEP_PS_BIN="$t/bin/ps" \
	FLYWHEEL_CODEX_SWEEP_REPORT_ROOT="$t/reports" \
	FLYWHEEL_CODEX_SWEEP_BACKUP_ROOT="$t/home/.flywheel/codex-credential-backups" \
	FLYWHEEL_CODEX_SWEEP_LEAD_HOMES="$t/home/.codex-lead" \
	FLYWHEEL_CODEX_SWEEP_RAYA_HOME="$t/home/.flywheel/raya/codex-home" \
	FLYWHEEL_CODEX_SWEEP_QUIESCENCE_TIMEOUT_MS=0 \
		node "$SUT" "$@"
}

T1="$TMP_ROOT/success"; make_fixture "$T1"
before="$(find "$T1/home" -name auth.json -o -name '*.json' | sort | xargs shasum)"
dry_json="$(run_sweep "$T1" --json 2>"$T1/dry.err")"; dry_rc=$?
after="$(find "$T1/home" -name auth.json -o -name '*.json' | sort | xargs shasum)"
if [ "$dry_rc" -eq 0 ] && [ "$before" = "$after" ] \
	&& [ "$(printf '%s' "$dry_json" | jq '.activeLegacy | length')" -eq 4 ] \
	&& ! printf '%s' "$dry_json" | grep -q 'refresh-'; then
	pass "dry-run inventories hashed chains and active legacy homes without mutation or token output"
else
	fail "dry-run inventory contract"
fi

apply_out="$(run_sweep "$T1" --apply 2>"$T1/apply.err")"; apply_rc=$?
homes="$T1/home/.flywheel/codex-homes"
if [ "$apply_rc" -eq 0 ] && [ ! -e "$homes/$INACTIVE/auth.json" ] \
	&& [ -f "$homes/$ACTIVE_DB/auth.json" ] && [ -f "$homes/$ACTIVE_BRIDGE/auth.json" ] \
	&& [ -f "$homes/$ACTIVE_PS/auth.json" ] && [ -f "$homes/$ACTIVE_LEASE/auth.json" ] \
	&& [ -f "$homes/$MALFORMED/auth.json" ] && [ -L "$homes/$LINKED/auth.json" ] \
	&& [ -f "$homes/agents/flywheel/implement/auth.json" ] \
	&& [ -f "$T1/home/.codex-lead/auth.json" ] \
	&& [ -f "$T1/home/.flywheel/raya/codex-home/auth.json" ] \
	&& [ -f "$T1/home/.codex/profiles/business/auth.json" ] \
	&& [ ! -e "$T1/home/.flywheel/codex-credential-backups/old.json" ] \
	&& [ -f "$T1/home/.flywheel/codex-credential-backups/new.json" ] \
	&& grep -q 'phase":"intent' "$T1/reports"/*.jsonl \
	&& grep -q 'phase":"applied' "$T1/reports"/*.jsonl \
	&& grep -q '/api/admission/resume' "$T1/calls" \
	&& [[ "$apply_out" == *'applied=2'* ]]; then
	pass "apply deletes only inactive legacy auth and expired backup under an owned pause"
else
	fail "owned-pause deletion allowlist contract (rc=$apply_rc out=$apply_out)"
fi

T2="$TMP_ROOT/bad-db"; make_fixture "$T2"; printf not-sqlite > "$T2/home/.flywheel/comm/b/comm.db"
run_sweep "$T2" --apply >"$T2/out" 2>"$T2/err"; rc=$?
if [ "$rc" -ne 0 ] && [ -f "$T2/home/.flywheel/codex-homes/$INACTIVE/auth.json" ] \
	&& ! grep -q '/api/admission/pause' "$T2/calls"; then
	pass "an unreadable or schema-drifted comm shard fails before pause and mutation"
else
	fail "comm authority failure was not fail-closed"
fi

T3="$TMP_ROOT/bad-ps"; make_fixture "$T3"; printf '#!/bin/sh\nexit 1\n' > "$T3/bin/ps"; chmod +x "$T3/bin/ps"
run_sweep "$T3" --apply >"$T3/out" 2>"$T3/err"; rc=$?
if [ "$rc" -ne 0 ] && [ -f "$T3/home/.flywheel/codex-homes/$INACTIVE/auth.json" ]; then
	pass "process authority failure produces zero writes"
else
	fail "process authority failure was not fail-closed"
fi

T4="$TMP_ROOT/auth"; make_fixture "$T4"; SWEEP_TOKEN=wrong run_sweep "$T4" --apply >"$T4/out" 2>"$T4/err"; rc=$?
if [ "$rc" -eq 2 ] && [ -f "$T4/home/.flywheel/codex-homes/$INACTIVE/auth.json" ] \
	&& ! grep -q 'wrong' "$T4/out" "$T4/err"; then
	pass "bad Bridge bearer exits 2 with zero mutation and no credential leak"
else
	fail "bad Bridge bearer contract (rc=$rc)"
fi

T5="$TMP_ROOT/not-quiet"; make_fixture "$T5"; printf false > "$T5/quiescent"
run_sweep "$T5" --apply >"$T5/out" 2>"$T5/err"; rc=$?
if [ "$rc" -ne 0 ] && [ -f "$T5/home/.flywheel/codex-homes/$INACTIVE/auth.json" ] \
	&& grep -q '/api/admission/resume' "$T5/calls"; then
	pass "quiescence timeout writes nothing and resumes the same owned lease"
else
	fail "quiescence timeout contract"
fi

T6="$TMP_ROOT/health-contract"; make_fixture "$T6"; printf missing-pause > "$T6/health-contract"
run_sweep "$T6" --apply >"$T6/out" 2>"$T6/err"; rc=$?
if [ "$rc" -ne 0 ] && [ -f "$T6/home/.flywheel/codex-homes/$INACTIVE/auth.json" ] \
	&& grep -q 'Bridge uptime or owned-pause health fence failed' "$T6/err" \
	&& grep -q '/api/admission/resume' "$T6/calls"; then
	pass "a mismatched health contract fails loudly with zero mutation and resumes the owned lease"
else
	fail "health contract mismatch was not fail-closed"
fi

if grep -Fxq 'codex-home-credential-sweep.mjs' "$ROOT/scripts/package-onboard.sh" \
	&& grep -Fxq 'scripts/codex-home-credential-sweep.mjs' "$ROOT/scripts/package-onboard-files.allow"; then
	pass "the sweep utility ships in the onboarding payload"
else
	fail "the sweep utility is absent from onboarding packaging"
fi

printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
