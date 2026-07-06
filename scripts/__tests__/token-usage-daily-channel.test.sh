#!/usr/bin/env bash
# FLY-744: hermetic test for scripts/token-usage-daily.sh channel delivery.
#
# Codex R1 HIGH-1: the script used to resolve FLYWHEEL_TOKEN_USAGE_CHANNEL (and
# FLYWHEEL_REPO) BEFORE sourcing ~/.flywheel/.env, so the documented deployment path
# (channel id in .env) silently never published. This test proves the fix: with the
# channel present ONLY in a temp .env, the script must reach `publish-report --channel`;
# with no channel it must render-only (no publish) and warn.
#
# It shims `flywheel-comm` (COMM) with a fake node script that records its argv, and
# points FLYWHEEL_REPO (via .env) at a temp fake repo so real `node` runs the stub.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAILY="${SCRIPT_DIR}/../token-usage-daily.sh"
[[ -f "$DAILY" ]] || { echo "[TEST] ✗ token-usage-daily.sh not found: $DAILY"; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/token-usage-daily.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

# ── Fake flywheel-comm dist (records argv; materializes --out for token-report) ──
build_fake_repo() {
	local home="$1"
	local dist="${home}/fakerepo/packages/flywheel-comm/dist"
	mkdir -p "$dist"
	cat > "${dist}/index.js" <<'EOF'
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMM_LOG, args.join(" ") + "\n");
const i = args.indexOf("--out");
if (i >= 0 && args[i + 1]) fs.writeFileSync(args[i + 1], "<html>fake</html>");
process.exit(0);
EOF
}

# Run the daily script in a hermetic env. $1=home, $2=channel-in-env("" => omit).
# Extra trailing args are passed as KEY=VAL process-env entries (to test precedence).
run_daily() {
	local home="$1" channel="$2"; shift 2
	mkdir -p "${home}/.flywheel"
	build_fake_repo "$home"
	{
		echo "FLYWHEEL_REPO=${home}/fakerepo"
		echo "TOKEN_USAGE_OUT=${home}/out.html"
		[[ -n "$channel" ]] && echo "FLYWHEEL_TOKEN_USAGE_CHANNEL=${channel}"
	} > "${home}/.flywheel/.env"
	env -i \
		HOME="$home" \
		PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
		COMM_LOG="${home}/comm.log" \
		"$@" \
		bash "$DAILY" > "${home}/stdout.log" 2> "${home}/stderr.log"
}

# ── Case 1: channel present only in .env → must publish to that channel ──────
H1="${ROOT}/h1"; mkdir -p "$H1"
if run_daily "$H1" "12345test"; then
	if grep -q "publish-report" "${H1}/comm.log" && grep -q -- "--channel 12345test" "${H1}/comm.log"; then
		pass "channel from .env reaches publish-report --channel (HIGH-1 fix)"
	else
		fail "channel from .env: comm.log did not show publish-report --channel; got: $(tr '\n' '|' < "${H1}/comm.log")"
	fi
else
	fail "channel from .env: script exited non-zero: $(cat "${H1}/stderr.log")"
fi

# ── Case 2: no channel → render-only (no publish) + warn ─────────────────────
H2="${ROOT}/h2"; mkdir -p "$H2"
if run_daily "$H2" ""; then
	if grep -q "token-report daily" "${H2}/comm.log" && ! grep -q "publish-report" "${H2}/comm.log"; then
		pass "no channel: renders (token-report daily) but does NOT publish"
	else
		fail "no channel: expected token-report daily and no publish-report; got: $(tr '\n' '|' < "${H2}/comm.log")"
	fi
	if grep -q "WARNING: FLYWHEEL_TOKEN_USAGE_CHANNEL is unset" "${H2}/stderr.log"; then
		pass "no channel: emits a loud unset-channel warning"
	else
		fail "no channel: missing unset-channel warning"
	fi
else
	fail "no channel: script exited non-zero: $(cat "${H2}/stderr.log")"
fi

# ── Case 3: process env WINS over .env (Codex R1 HIGH — no stale-.env clobber) ──
# .env says channel "envfile-ch"; process env says "proc-ch" → publish must use proc-ch.
H3="${ROOT}/h3"; mkdir -p "$H3"
if run_daily "$H3" "envfile-ch" FLYWHEEL_TOKEN_USAGE_CHANNEL="proc-ch"; then
	if grep -q -- "--channel proc-ch" "${H3}/comm.log" && ! grep -q -- "--channel envfile-ch" "${H3}/comm.log"; then
		pass "process env channel wins over .env (no stale-.env clobber)"
	else
		fail "process env precedence: expected --channel proc-ch; got: $(tr '\n' '|' < "${H3}/comm.log")"
	fi
else
	fail "process env precedence: script exited non-zero: $(cat "${H3}/stderr.log")"
fi

# ── Case 4: process env FLYWHEEL_REPO wins over .env (wrong-checkout guard) ──
# .env points REPO at h4/fakerepo; process env points at h4/procrepo (also a fake repo)
# → the script must run COMM from procrepo, proving the plist repo path wins.
H4="${ROOT}/h4"; mkdir -p "$H4"
build_fake_repo "$H4"                              # writes ${H4}/fakerepo/.../index.js (from .env)
PROCREPO_DIST="${H4}/procrepo/packages/flywheel-comm/dist"
mkdir -p "$PROCREPO_DIST"
# distinct stub: tag its log line so we can tell which repo ran
cat > "${PROCREPO_DIST}/index.js" <<'EOF'
const fs = require("node:fs");
fs.appendFileSync(process.env.COMM_LOG, "FROM_PROCREPO " + process.argv.slice(2).join(" ") + "\n");
const a = process.argv.slice(2);
const i = a.indexOf("--out");
if (i >= 0 && a[i + 1]) fs.writeFileSync(a[i + 1], "x");
process.exit(0);
EOF
if run_daily "$H4" "" FLYWHEEL_REPO="${H4}/procrepo"; then
	if grep -q "FROM_PROCREPO" "${H4}/comm.log"; then
		pass "process env FLYWHEEL_REPO wins over .env (runs COMM from plist checkout)"
	else
		fail "process env repo precedence: expected FROM_PROCREPO; got: $(tr '\n' '|' < "${H4}/comm.log")"
	fi
else
	fail "process env repo precedence: script exited non-zero: $(cat "${H4}/stderr.log")"
fi

echo
echo "[TEST] token-usage-daily-channel: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
