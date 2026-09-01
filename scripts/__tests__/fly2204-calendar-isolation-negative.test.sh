#!/usr/bin/env bash
# FLY-2204: static fixture evidence must reject every privilege-collapse mutation.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/calendar-isolation/install-calendar-services.sh"
VERIFY="$REPO_ROOT/scripts/calendar-isolation/verify-calendar-isolation.sh"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/fly2204-calendar-negative.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1" >&2; }

if [[ ! -x "$VERIFY" ]]; then
	fail "N1 verifier exists and is executable"
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

mkdir -p "$FIXTURE/usr/local/lib/raya/apps/brain/dist" "$FIXTURE/usr/local/bin"
: > "$FIXTURE/usr/local/lib/raya/apps/brain/dist/calendar-writer-cli.js"
: > "$FIXTURE/usr/local/lib/raya/apps/brain/dist/meeting-ingress-cli.js"
for binary in node gog; do
	printf '#!/bin/sh\nexit 0\n' > "$FIXTURE/usr/local/bin/$binary"
	chmod 755 "$FIXTURE/usr/local/bin/$binary"
done

render=(
	/bin/bash "$INSTALLER" render --root "$FIXTURE"
	--writer-user _rayacalw --writer-uid 491
	--ingress-user _rayacali --ingress-uid 492
	--service-group _rayacal --service-gid 493
	--agent-user founder --agent-uid 501
	--voice-group _rayavoice --voice-gid 494
	--node-bin /usr/local/bin/node --gog-bin /usr/local/bin/gog
	--raya-root /usr/local/lib/raya
)
"${render[@]}" >/dev/null || exit 1

if out="$("$VERIFY" fixture --root "$FIXTURE")" \
	&& node -e 'const v=JSON.parse(process.argv[1]); if(!v.ready||v.boundary!=="A/I/W")process.exit(1)' "$out"; then
	pass "N1 fixture proves separate transport and voice groups"
else fail "N1 fixture boundary verification"; fi

PLAN="$FIXTURE/etc/raya-calendar-isolation/identity-plan.tsv"
cp "$PLAN" "$FIXTURE/identity-plan.good"
sed 's/members=_rayacali,_rayacalw/members=founder,_rayacali,_rayacalw/' \
	"$FIXTURE/identity-plan.good" > "$PLAN"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N2 agent membership in writer transport is denied"
else
	pass "N2 agent membership in writer transport is denied"
fi
cp "$FIXTURE/identity-plan.good" "$PLAN"

sed 's#runtime-root\t/var/db/raya-calendar-isolation/run\troot:wheel#runtime-root\t/var/db/raya-calendar-isolation/run\tfounder:admin#' \
	"$FIXTURE/identity-plan.good" > "$PLAN"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N2b agent-owned runtime ancestor is denied"
else
	pass "N2b agent-owned runtime ancestor is denied"
fi
cp "$FIXTURE/identity-plan.good" "$PLAN"

PLIST="$FIXTURE/Library/LaunchDaemons/com.raya.calendar-writer.plist"
cp "$PLIST" "$FIXTURE/writer.good.plist"
sed 's#</dict>#<key>EnvironmentVariables</key><dict><key>GOG_KEYRING_PASSWORD</key><string>leak</string></dict></dict>#' \
	"$FIXTURE/writer.good.plist" > "$PLIST"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N3 secret-bearing plist is denied"
else
	pass "N3 secret-bearing plist is denied"
fi
cp "$FIXTURE/writer.good.plist" "$PLIST"

WRAPPER="$FIXTURE/usr/local/libexec/raya-calendar-writer-wrapper"
cp "$WRAPPER" "$FIXTURE/writer.good.wrapper"
INGRESS_WRAPPER="$FIXTURE/usr/local/libexec/raya-meeting-ingress-wrapper"
cp "$INGRESS_WRAPPER" "$FIXTURE/ingress.good.wrapper"
printf '\nexec /bin/sh\n' >> "$WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N4 wrapper drift is denied by fixed exec-shape verification"
else
	pass "N4 wrapper drift is denied by fixed exec-shape verification"
fi
cp "$FIXTURE/writer.good.wrapper" "$WRAPPER"

# Mutate the literal generated-shell contract.
# shellcheck disable=SC2016
sed 's#IFS= read -r GOG_KEYRING_PASSWORD < "$PASSWORD_FILE" || true#IFS= read -r GOG_KEYRING_PASSWORD < "$PASSWORD_FILE"#' \
	"$FIXTURE/writer.good.wrapper" > "$WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N4a newline-dependent password reads are denied"
else
	pass "N4a newline-dependent password reads are denied"
fi
cp "$FIXTURE/writer.good.wrapper" "$WRAPPER"

if "$VERIFY" live --root "$FIXTURE" --ack FLY-2204-LIVE-NEGATIVE \
	>"$FIXTURE/live.out" 2>"$FIXTURE/live.err"; then
	fail "N5 live probe cannot be redirected to a fixture root"
elif grep -Fq 'live verification is restricted to the live root' "$FIXTURE/live.err"; then
	pass "N5 live probe cannot be redirected to a fixture root"
else
	fail "N5 live probe reaches its root guard"
fi

# shellcheck disable=SC2016
if grep -Fq 'RUNTIME_ROOT="/var/db/raya-calendar-isolation"' "$VERIFY" \
	&& grep -Fq 'RUNTIME_RUN_ROOT="$RUNTIME_ROOT/run"' "$VERIFY" \
	&& grep -Fq 'SOCKET_DIR="$RUNTIME_RUN_ROOT/calendar"' "$VERIFY" \
	&& grep -Fq 'SOCKET_PATH="$SOCKET_DIR/writer.sock"' "$VERIFY"; then
	pass "N6 live socket checks derive the path from a root-owned hierarchy"
else fail "N6 live socket hierarchy definition"; fi

ASSERT_NOT_MEMBER="$(sed -n '/^assert_not_member() {$/,/^}$/p' "$INSTALLER")"
probe_membership() {
	local behavior="$1"
	(
		# Invoked by the extracted guard through eval.
		# shellcheck disable=SC2329
		die() { printf 'DIE\n'; exit 64; }
		# Invoked by the extracted guard through eval.
		# shellcheck disable=SC2329
		dseditgroup() {
			case "$behavior" in
				error) return 70 ;;
				yes|no) printf '%s\n' "$behavior" ;;
				no67) printf 'no founder is NOT a member of _rayacal\n'; return 67 ;;
			esac
		}
		eval "$ASSERT_NOT_MEMBER"
		assert_not_member founder _rayacal && printf 'PASSED\n'
	)
}
if [[ -n "$ASSERT_NOT_MEMBER" \
	&& "$(probe_membership error)" == DIE \
	&& "$(probe_membership yes)" == DIE \
	&& "$(probe_membership no)" == PASSED \
	&& "$(probe_membership no67)" == PASSED ]]; then
	pass "N7 membership guard distinguishes error, member, and non-member"
else
	fail "N7 fail-closed membership result matrix"
fi

# Exact source contracts, not local expansions.
# shellcheck disable=SC2016
OWNER_ASSERTIONS=(
	'assert_owner_mode "$WRITER_WRAPPER" root wheel 755'
	'assert_owner_mode "$INGRESS_WRAPPER" root wheel 755'
	'assert_owner_mode "$PROXY" root wheel 755'
	'assert_owner_mode "$WRITER_PLIST" root wheel 644'
	'assert_owner_mode "$INGRESS_PLIST" root wheel 644'
	'assert_owner_mode "$WRITER_ENV" root "$SERVICE_GROUP" 640'
	'assert_owner_mode "$VOICE_ROOT" root wheel 755'
	'assert_root_owned_runtime "$EXPECTED_NODE" executable'
	'assert_root_owned_runtime "$EXPECTED_WRITER" regular'
	'assert_root_owned_runtime "$EXPECTED_INGRESS" regular'
)
OWNERSHIP_COMPLETE=1
for assertion in "${OWNER_ASSERTIONS[@]}"; do
	grep -Fq "$assertion" "$VERIFY" || OWNERSHIP_COMPLETE=0
done
if [[ "$OWNERSHIP_COMPLETE" == 1 ]]; then
	pass "N8 live verification covers every root-owned boundary asset"
else
	fail "N8 complete live root-ownership verification"
fi

sed 's/INGRESS_UID="492"/INGRESS_UID="501"/' \
	"$FIXTURE/writer.good.wrapper" > "$WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9a mismatched ingress uid is denied"
else pass "N9a mismatched ingress uid is denied"; fi
cp "$FIXTURE/writer.good.wrapper" "$WRAPPER"

# Mutate literal generated-shell contracts.
# shellcheck disable=SC2016
sed 's#PASSWORD_FILE="[^\"]*"#PASSWORD_FILE="/tmp/pw"#' \
	"$FIXTURE/writer.good.wrapper" > "$WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9b unexpected password path is denied"
else pass "N9b unexpected password path is denied"; fi
cp "$FIXTURE/writer.good.wrapper" "$WRAPPER"

# shellcheck disable=SC2016
sed 's#SOCKET_PATH="/var[^\"]*"#SOCKET_PATH="/tmp/writer.sock"#' \
	"$FIXTURE/writer.good.wrapper" > "$WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9c unexpected socket path is denied"
else pass "N9c unexpected socket path is denied"; fi
cp "$FIXTURE/writer.good.wrapper" "$WRAPPER"

sed 's#<string>/usr/local/libexec/raya-calendar-writer-wrapper</string>#<string>/bin/sh</string>#' \
	"$FIXTURE/writer.good.plist" > "$PLIST"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9d unexpected plist program is denied"
else pass "N9d unexpected plist program is denied"; fi
cp "$FIXTURE/writer.good.plist" "$PLIST"

sed 's#NODE="/usr/local/bin/node"#NODE="/bin/sh"#' \
	"$FIXTURE/writer.good.wrapper" > "$WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9e unexpected writer node path is denied"
else pass "N9e unexpected writer node path is denied"; fi
cp "$FIXTURE/writer.good.wrapper" "$WRAPPER"

sed 's#WRITER="/usr/local/lib/raya/apps/brain/dist/calendar-writer-cli.js"#WRITER="/usr/local/lib/raya/apps/brain/dist/meeting-ingress-cli.js"#' \
	"$FIXTURE/writer.good.wrapper" > "$WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9f unexpected writer handler path is denied"
else pass "N9f unexpected writer handler path is denied"; fi
cp "$FIXTURE/writer.good.wrapper" "$WRAPPER"

sed 's#HOME="/Users/_rayacali"#HOME="/Users/founder"#' \
	"$FIXTURE/ingress.good.wrapper" > "$INGRESS_WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9g unexpected ingress home is denied"
else pass "N9g unexpected ingress home is denied"; fi
cp "$FIXTURE/ingress.good.wrapper" "$INGRESS_WRAPPER"

sed 's#RAYA_INGRESS_ENV_FILE="/Users/_rayacali/ingress.env"#RAYA_INGRESS_ENV_FILE="/tmp/ingress.env"#' \
	"$FIXTURE/ingress.good.wrapper" > "$INGRESS_WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9h unexpected ingress env path is denied"
else pass "N9h unexpected ingress env path is denied"; fi
cp "$FIXTURE/ingress.good.wrapper" "$INGRESS_WRAPPER"

sed 's#NODE="/usr/local/bin/node"#NODE="/bin/sh"#' \
	"$FIXTURE/ingress.good.wrapper" > "$INGRESS_WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9i unexpected ingress node path is denied"
else pass "N9i unexpected ingress node path is denied"; fi
cp "$FIXTURE/ingress.good.wrapper" "$INGRESS_WRAPPER"

sed 's#INGRESS="/usr/local/lib/raya/apps/brain/dist/meeting-ingress-cli.js"#INGRESS="/usr/local/lib/raya/apps/brain/dist/calendar-writer-cli.js"#' \
	"$FIXTURE/ingress.good.wrapper" > "$INGRESS_WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	fail "N9j unexpected ingress handler path is denied"
else pass "N9j unexpected ingress handler path is denied"; fi
cp "$FIXTURE/ingress.good.wrapper" "$INGRESS_WRAPPER"

WRITER_ASSIGNMENT_MANIFEST_COMPLETE=1
while IFS='|' read -r assignment replacement; do
	[[ -n "$assignment" ]] || continue
	sed "s#^${assignment}=.*#${assignment}=${replacement}#" \
		"$FIXTURE/writer.good.wrapper" > "$WRAPPER"
	if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
		printf 'accepted writer assignment drift: %s\n' "$assignment" >&2
		WRITER_ASSIGNMENT_MANIFEST_COMPLETE=0
	fi
done <<'EOF'
HOME|"/tmp/fly2204-writer-home"
CONFIG_FILE|"/tmp/fly2204-writer.env"
PASSWORD_FILE|"/tmp/fly2204-password"
PROXY|"/bin/cat"
SOCKET_PATH|"/tmp/fly2204-writer.sock"
INGRESS_UID|"605"
NODE|"/bin/sh"
WRITER|"/bin/sh"
GOG_KEYRING_BACKEND|memory
RAYA_WRITER_STATE_DIR|"/tmp/fly2204-state"
EOF
awk '/^exec / { print "fly2204_unknown_assignment=\"/tmp/fly2204-undeclared\"" } { print }' \
	"$FIXTURE/writer.good.wrapper" > "$WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	printf 'accepted undeclared lowercase writer assignment\n' >&2
	WRITER_ASSIGNMENT_MANIFEST_COMPLETE=0
fi
if [[ "$WRITER_ASSIGNMENT_MANIFEST_COMPLETE" == 1 ]]; then
	pass "N10a every writer literal assignment is manifest-bound"
else
	fail "N10a complete writer assignment manifest"
fi
cp "$FIXTURE/writer.good.wrapper" "$WRAPPER"

WRAPPER_UID_GUARDS_BOUND=1
sed 's/== "491"/== "605"/' "$FIXTURE/writer.good.wrapper" > "$WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	printf 'accepted writer uid guard drift\n' >&2
	WRAPPER_UID_GUARDS_BOUND=0
fi
cp "$FIXTURE/writer.good.wrapper" "$WRAPPER"
sed 's/== "492"/== "605"/' "$FIXTURE/ingress.good.wrapper" > "$INGRESS_WRAPPER"
if "$VERIFY" fixture --root "$FIXTURE" >/dev/null 2>&1; then
	printf 'accepted ingress uid guard drift\n' >&2
	WRAPPER_UID_GUARDS_BOUND=0
fi
if [[ "$WRAPPER_UID_GUARDS_BOUND" == 1 ]]; then
	pass "N10b both wrapper uid guards are manifest-bound"
else
	fail "N10b wrapper uid guard manifest"
fi
cp "$FIXTURE/ingress.good.wrapper" "$INGRESS_WRAPPER"

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
exit "$FAIL"
