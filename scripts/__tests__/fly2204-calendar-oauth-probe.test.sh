#!/usr/bin/env bash
# FLY-2204: OAuth probes must use the reviewed write grammar and classify denial.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE="$REPO_ROOT/scripts/calendar-isolation/calendar-oauth-probe.mjs"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/fly2204-oauth-probe.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1" >&2; }

if [[ ! -x "$PROBE" ]]; then
	fail "O1 OAuth probe exists and is executable"
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

STUB="$FIXTURE/oauth-cli"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
printf '%s\037' "$@" >> "$PROBE_ARG_LOG"
printf '\n' >> "$PROBE_ARG_LOG"
if [[ " $* " == *" --dry-run "* ]]; then
	printf '{"dryRun":true}\n'
	exit 0
fi
	case "${PROBE_STUB_RESULT:-scope}" in
	scope) printf '403 ACCESS_TOKEN_SCOPE_INSUFFICIENT insufficient authentication scopes\n' >&2; exit 22 ;;
	revoked) printf '401 invalid_grant credentials are no longer valid\n' >&2; exit 22 ;;
	missing) printf 'unauthenticated: no credentials configured\n' >&2; exit 22 ;;
	success) printf '{"id":"unexpected-canary-event"}\n'; exit 0 ;;
esac
EOF
chmod 700 "$STUB"
LOG="$FIXTURE/args.log"
CANARY="fly2204-canary@group.calendar.google.com"
FROM="2026-09-01T20:00:00.000Z"
TO="2026-09-01T20:05:00.000Z"

common=(
	--executable "$STUB"
	--account personal
	--client fly2204-isolated
	--calendar-id "$CANARY"
	--from "$FROM"
	--to "$TO"
)

if out="$(PROBE_ARG_LOG="$LOG" node "$PROBE" gog-scope "${common[@]}" \
	--ack FLY-2204-LIVE-CANARY)" \
	&& node -e 'const v=JSON.parse(process.argv[1]); if(v.result!=="insufficient_scope"||v.grammar!=="passed")process.exit(1)' "$out"; then
	pass "O1 gog scope probe classifies a valid-token 403"
else fail "O1 gog insufficient-scope classification"; fi

if grep -Fq -- $'--dry-run\037calendar\037create\037' "$LOG" \
	&& grep -Fq $'calendar\037create\037fly2204-canary@group.calendar.google.com\037' "$LOG" \
	&& grep -Fq -- $'--summary\037FLY-2204 OAuth scope canary\037--from\037' "$LOG"; then
	pass "O2 gog uses calendar create grammar and dry-runs first"
else fail "O2 gog reviewed grammar"; fi

: > "$LOG"
if out="$(PROBE_ARG_LOG="$LOG" node "$PROBE" gws-scope "${common[@]}" \
	--ack FLY-2204-LIVE-CANARY)" \
	&& node -e 'const v=JSON.parse(process.argv[1]); if(v.result!=="insufficient_scope"||v.grammar!=="passed")process.exit(1)' "$out"; then
	pass "O3 gws scope probe classifies a valid-token 403"
else fail "O3 gws insufficient-scope classification"; fi

if grep -Fq -- $'--dry-run\037calendar\037events\037insert\037--params\037{"calendarId":"fly2204-canary@group.calendar.google.com"}\037--json\037' "$LOG" \
	&& grep -Fq '"summary":"FLY-2204 OAuth scope canary"' "$LOG"; then
	pass "O4 gws uses events insert params/json grammar and dry-runs first"
else fail "O4 gws reviewed grammar"; fi

: > "$LOG"
if out="$(PROBE_ARG_LOG="$LOG" PROBE_STUB_RESULT=revoked node "$PROBE" gog-revoked \
	"${common[@]}" --ack FLY-2204-REVOKED-GRANT)" \
	&& node -e 'const v=JSON.parse(process.argv[1]); if(v.result!=="old_grant_revoked")process.exit(1)' "$out"; then
	pass "O5 old grant probe distinguishes invalid_grant from insufficient scope"
else fail "O5 revoked-grant classification"; fi

: > "$LOG"
if PROBE_ARG_LOG="$LOG" node "$PROBE" gog-scope "${common[@]}" \
	--ack WRONG >/dev/null 2>&1 || [[ -s "$LOG" ]]; then
	fail "O6 literal acknowledgement gates every canary call"
else
	pass "O6 literal acknowledgement gates every canary call"
fi

: > "$LOG"
if PROBE_ARG_LOG="$LOG" PROBE_STUB_RESULT=success node "$PROBE" gog-scope \
	"${common[@]}" --ack FLY-2204-LIVE-CANARY >"$FIXTURE/success.out" 2>/dev/null; then
	fail "O7 an unexpected write success fails closed"
elif node -e 'const v=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); if(v.result!=="unexpected_write_success")process.exit(1)' "$FIXTURE/success.out"; then
	pass "O7 an unexpected write success fails closed"
else fail "O7 unexpected success evidence"; fi

: > "$LOG"
if PROBE_ARG_LOG="$LOG" PROBE_STUB_RESULT=missing node "$PROBE" gog-revoked \
	"${common[@]}" --ack FLY-2204-REVOKED-GRANT >/dev/null 2>&1; then
	fail "O8 missing local credentials cannot prove server-side revocation"
else
	pass "O8 missing local credentials cannot prove server-side revocation"
fi

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
exit "$FAIL"
