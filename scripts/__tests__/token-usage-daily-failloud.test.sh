#!/usr/bin/env bash
# FLY-929 C2: token-usage-daily.sh fail-loud + expected-date seam.
#
# Hermetic (same harness shape as token-usage-daily-channel.test.sh): shims
# flywheel-comm with a fake node dist that records argv (and can be told to
# fail specific subcommands), plus a fake scripts/lead-alert.sh in the fake
# repo recording its argv. Asserts:
#   1. P-expect=1 + token-report failure → lead-alert.sh called with
#      --kind notify_digest_failed AND the original exit code is preserved.
#   2. FLY-1243: FLYWHEEL_NOTIFY_DIGEST_EXPECT is retired (固化 default-on) —
#      P-expect UNSET + same failure still fires lead-alert.sh unconditionally,
#      same exit code preserved.
#   3. P-expect=1 + publish failure → fail-loud fires for the publish step too.
#   4. Happy path: report-day's date reaches publish-report as
#      `--kind token_report --expected-date <date>`.
#   5. report-day returning garbage → publish-report called WITHOUT the
#      receipt flags (byte-compat body) + a warning.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAILY="${SCRIPT_DIR}/../token-usage-daily.sh"
[[ -f "$DAILY" ]] || { echo "[TEST] ✗ token-usage-daily.sh not found: $DAILY"; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly929-failloud.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

# Fake flywheel-comm dist: records argv; env knobs FAIL_DAILY / FAIL_PUBLISH /
# REPORT_DAY drive behavior per subcommand.
build_fake_repo() {
	local home="$1"
	local dist="${home}/fakerepo/packages/flywheel-comm/dist"
	mkdir -p "$dist" "${home}/fakerepo/scripts"
	cat > "${dist}/index.js" <<'EOF'
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMM_LOG, args.join(" ") + "\n");
if (args[0] === "token-report" && args[1] === "daily") {
	if (process.env.FAIL_DAILY === "1") process.exit(3);
	const i = args.indexOf("--out");
	if (i >= 0 && args[i + 1]) fs.writeFileSync(args[i + 1], "<html>fake</html>");
	process.exit(0);
}
if (args[0] === "token-report" && args[1] === "report-day") {
	process.stdout.write((process.env.REPORT_DAY ?? "2026-07-06") + "\n");
	process.exit(0);
}
if (args[0] === "publish-report") {
	if (process.env.FAIL_PUBLISH === "1") process.exit(4);
	process.exit(0);
}
process.exit(0);
EOF
	cat > "${home}/fakerepo/scripts/lead-alert.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ALERT_LOG"
exit 0
EOF
	chmod +x "${home}/fakerepo/scripts/lead-alert.sh"
}

# Run the daily script hermetically. $1=home; trailing args = extra env pairs.
run_daily() {
	local home="$1"; shift
	mkdir -p "${home}/.flywheel"
	build_fake_repo "$home"
	{
		echo "FLYWHEEL_REPO=${home}/fakerepo"
		echo "TOKEN_USAGE_OUT=${home}/out.html"
		echo "FLYWHEEL_TOKEN_USAGE_CHANNEL=chan123"
	} > "${home}/.flywheel/.env"
	env -i \
		HOME="$home" \
		PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
		COMM_LOG="${home}/comm.log" \
		ALERT_LOG="${home}/alert.log" \
		"$@" \
		bash "$DAILY" > "${home}/stdout.log" 2> "${home}/stderr.log"
}

# ── Case 1: expect=1 + token-report fails → alert + original exit code ──────
H1="${ROOT}/h1"; mkdir -p "$H1"
run_daily "$H1" FAIL_DAILY=1 FLYWHEEL_NOTIFY_DIGEST_EXPECT=1; rc=$?
if [[ $rc -eq 3 ]]; then
	pass "expect=1 + daily failure: original exit code 3 preserved"
else
	fail "expect=1 + daily failure: exit code was $rc (want 3)"
fi
if grep -q -- "--kind notify_digest_failed" "${H1}/alert.log" 2>/dev/null && \
   grep -q -- "--lead codex-infra-bot-lead" "${H1}/alert.log"; then
	pass "expect=1 + daily failure: lead-alert fired with notify_digest_failed"
else
	fail "expect=1 + daily failure: alert.log: $(cat "${H1}/alert.log" 2>/dev/null)"
fi

# ── Case 2 (FLY-1243): expect unset + same failure → alert STILL fires ──────
# FLYWHEEL_NOTIFY_DIGEST_EXPECT is retired (固化 default-on); fail_loud() no
# longer gates on it, so this is no longer a "byte-compat NO alert" case.
H2="${ROOT}/h2"; mkdir -p "$H2"
run_daily "$H2" FAIL_DAILY=1; rc=$?
if [[ $rc -eq 3 ]]; then
	pass "expect unset + daily failure: exit code 3 preserved"
else
	fail "expect unset + daily failure: exit code was $rc (want 3)"
fi
if grep -q -- "--kind notify_digest_failed" "${H2}/alert.log" 2>/dev/null && \
   grep -q -- "--lead codex-infra-bot-lead" "${H2}/alert.log"; then
	pass "expect unset + daily failure: lead-alert fires unconditionally (FLY-1243 default-on)"
else
	fail "expect unset + daily failure: alert.log: $(cat "${H2}/alert.log" 2>/dev/null)"
fi

# ── Case 3: expect=1 + publish fails → fail-loud for the publish step ───────
H3="${ROOT}/h3"; mkdir -p "$H3"
run_daily "$H3" FAIL_PUBLISH=1 FLYWHEEL_NOTIFY_DIGEST_EXPECT=1; rc=$?
if [[ $rc -eq 4 ]] && grep -q "step=publish-report exit=4" "${H3}/alert.log" 2>/dev/null; then
	pass "expect=1 + publish failure: alert fired with step/exit, exit code 4 preserved"
else
	fail "expect=1 + publish failure: rc=$rc alert.log: $(cat "${H3}/alert.log" 2>/dev/null)"
fi

# ── Case 4: happy path → receipt flags reach publish-report ─────────────────
H4="${ROOT}/h4"; mkdir -p "$H4"
if run_daily "$H4" REPORT_DAY=2026-07-06; then
	if grep -q -- "publish-report .*--kind token_report --expected-date 2026-07-06" "${H4}/comm.log"; then
		pass "happy path: publish-report carries --kind token_report --expected-date"
	else
		fail "happy path: comm.log: $(tr '\n' '|' < "${H4}/comm.log")"
	fi
else
	fail "happy path: script exited non-zero: $(cat "${H4}/stderr.log")"
fi

# ── Case 5: garbage report-day → flags omitted (byte-compat body) + warning ─
H5="${ROOT}/h5"; mkdir -p "$H5"
if run_daily "$H5" REPORT_DAY="not-a-date"; then
	if grep -q "publish-report" "${H5}/comm.log" && ! grep -q -- "--expected-date" "${H5}/comm.log"; then
		pass "garbage report-day: publish-report called WITHOUT receipt flags"
	else
		fail "garbage report-day: comm.log: $(tr '\n' '|' < "${H5}/comm.log")"
	fi
	if grep -q "publishing without receipt fields" "${H5}/stderr.log"; then
		pass "garbage report-day: loud warning emitted"
	else
		fail "garbage report-day: no warning in stderr"
	fi
else
	fail "garbage report-day: script exited non-zero: $(cat "${H5}/stderr.log")"
fi

echo "[TEST] token-usage-daily-failloud: ${PASSED} passed, ${FAILED} failed"
[[ $FAILED -eq 0 ]] || exit 1
