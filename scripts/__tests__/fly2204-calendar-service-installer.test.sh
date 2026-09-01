#!/usr/bin/env bash
# FLY-2204: render the system-service bundle without touching live users or launchd.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/calendar-isolation/install-calendar-services.sh"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2204-calendar-installer.XXXXXX")"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1" >&2; }

if [[ ! -x "$INSTALLER" ]]; then
	fail "I1 installer exists and is executable"
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

mkdir -p \
	"$FIXTURE_ROOT/usr/local/lib/raya/apps/brain/dist" \
	"$FIXTURE_ROOT/usr/local/bin"
: > "$FIXTURE_ROOT/usr/local/lib/raya/apps/brain/dist/calendar-writer-cli.js"
: > "$FIXTURE_ROOT/usr/local/lib/raya/apps/brain/dist/meeting-ingress-cli.js"
for binary in node gog; do
	printf '#!/bin/sh\nexit 0\n' > "$FIXTURE_ROOT/usr/local/bin/$binary"
	chmod 755 "$FIXTURE_ROOT/usr/local/bin/$binary"
done

render=(
	/bin/bash "$INSTALLER" render
	--root "$FIXTURE_ROOT"
	--writer-user _rayacalw
	--writer-uid 491
	--ingress-user _rayacali
	--ingress-uid 492
	--service-group _rayacal
	--service-gid 493
	--agent-user founder
	--agent-uid 501
	--voice-group _rayavoice
	--voice-gid 494
	--node-bin /usr/local/bin/node
	--gog-bin /usr/local/bin/gog
	--raya-root /usr/local/lib/raya
)
if "${render[@]}" >"$FIXTURE_ROOT/render.out" 2>"$FIXTURE_ROOT/render.err"; then
	pass "I1 fixture renderer completes without system mutation"
else
	fail "I1 fixture renderer completes"
	cat "$FIXTURE_ROOT/render.err" >&2
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

WRITER_WRAPPER="$FIXTURE_ROOT/usr/local/libexec/raya-calendar-writer-wrapper"
INGRESS_WRAPPER="$FIXTURE_ROOT/usr/local/libexec/raya-meeting-ingress-wrapper"
PROXY="$FIXTURE_ROOT/usr/local/libexec/raya-calendar-peer-proxy"
WRITER_PLIST="$FIXTURE_ROOT/Library/LaunchDaemons/com.raya.calendar-writer.plist"
INGRESS_PLIST="$FIXTURE_ROOT/Library/LaunchDaemons/com.raya.meeting-ingress.plist"

if [[ -x "$WRITER_WRAPPER" && -x "$INGRESS_WRAPPER" && -x "$PROXY" ]] \
	&& [[ -f "$WRITER_PLIST" && -f "$INGRESS_PLIST" ]]; then
	pass "I2 renderer emits fixed wrappers, peer proxy, and two LaunchDaemons"
else fail "I2 rendered service bundle"; fi

IDENTITIES="$FIXTURE_ROOT/etc/raya-calendar-isolation/identity-plan.tsv"
if grep -Fq $'group\t_rayacal\t493\tmembers=_rayacali,_rayacalw' "$IDENTITIES" \
	&& grep -Fq $'group\t_rayavoice\t494\tmembers=founder,_rayacali' "$IDENTITIES" \
	&& grep -Fq $'existing-agent\tfounder\t501' "$IDENTITIES"; then
	pass "I2a identity plan separates writer transport from the voice bridge"
else fail "I2a three-role identity plan"; fi

if grep -Fq $'runtime-directory\t/var/db/raya-calendar-isolation/run/calendar\t_rayacalw:_rayacal\t0750' \
	"$IDENTITIES"; then
	pass "I2b writer owns the persistent non-writable-to-ingress socket directory"
else fail "I2b socket directory ownership plan"; fi

INGRESS_TEMPLATE="$FIXTURE_ROOT/etc/raya-calendar-isolation/ingress.env.template"
if grep -Fq 'SOCKET_PATH="/var/db/raya-calendar-isolation/run/calendar/writer.sock"' "$WRITER_WRAPPER" \
	&& grep -Fq 'RAYA_WRITER_SOCKET=/var/db/raya-calendar-isolation/run/calendar/writer.sock' "$INGRESS_TEMPLATE" \
	&& grep -Fq 'RAYA_VOICE_COMMAND_DIR=/var/db/raya-calendar-isolation/run/meeting-voice/i-to-a' "$INGRESS_TEMPLATE" \
	&& ! grep -Rq '/\(private\|usr/local\)/var/run/raya-' "$FIXTURE_ROOT/etc/raya-calendar-isolation" \
		"$WRITER_WRAPPER" "$INGRESS_WRAPPER" "$WRITER_PLIST" "$INGRESS_PLIST"; then
	pass "I2c runtime paths survive a real reboot"
else fail "I2c persistent runtime paths"; fi

if grep -Fq $'runtime-root\t/var/db/raya-calendar-isolation\troot:wheel\t0755' "$IDENTITIES" \
	&& grep -Fq $'runtime-root\t/var/db/raya-calendar-isolation/run\troot:wheel\t0755' "$IDENTITIES"; then
	pass "I2d agent cannot replace the persistent runtime hierarchy"
else fail "I2d root-owned persistent runtime hierarchy"; fi

if grep -q '<string>_rayacalw</string>' "$WRITER_PLIST" \
	&& grep -q '<string>_rayacali</string>' "$INGRESS_PLIST" \
	&& grep -q '/usr/local/libexec/raya-calendar-writer-wrapper' "$WRITER_PLIST" \
	&& grep -q '/usr/local/libexec/raya-meeting-ingress-wrapper' "$INGRESS_PLIST" \
	&& ! grep -Eqi 'password|token|calendar.*account|calendar.*client' "$WRITER_PLIST" "$INGRESS_PLIST"; then
	pass "I3 plists switch uid and contain only non-secret fixed paths"
else fail "I3 plist identity and secret boundary"; fi

# These are deliberately literal generated-shell expressions.
# shellcheck disable=SC2016
if grep -Fq 'IFS= read -r GOG_KEYRING_PASSWORD < "$PASSWORD_FILE"' "$WRITER_WRAPPER" \
	&& grep -Fq 'export GOG_KEYRING_PASSWORD' "$WRITER_WRAPPER" \
	&& grep -Fq 'GOG_KEYRING_BACKEND=file' "$WRITER_WRAPPER" \
	&& grep -Fq '"$PROXY" "$SOCKET_PATH" "$INGRESS_UID"' "$WRITER_WRAPPER" \
	&& ! grep -Fq 'fixture-password' "$WRITER_WRAPPER"; then
	pass "I4 writer reads its password only inside the W process"
else fail "I4 W-only password flow"; fi

HARNESS_HOME="$FIXTURE_ROOT/writer-home"
HARNESS_CONFIG="$FIXTURE_ROOT/writer.env"
HARNESS_PASSWORD="$HARNESS_HOME/secrets/gog-keyring-password"
HARNESS_PROXY="$FIXTURE_ROOT/fake-peer-proxy"
HARNESS_RESULT="$FIXTURE_ROOT/writer-password.result"
HARNESS_WRAPPER="$FIXTURE_ROOT/writer-wrapper-harness"
mkdir -p "$HARNESS_HOME/secrets"
printf 'RAYA_GOG_BIN=/usr/local/bin/gog\n' > "$HARNESS_CONFIG"
printf 'fixture-password-without-newline' > "$HARNESS_PASSWORD"
# The emitted script must expand these in the W process.
# shellcheck disable=SC2016
printf '%s\n' '#!/bin/sh' 'printf '\''%s\n'\'' "$GOG_KEYRING_PASSWORD" > "$RESULT_FILE"' \
	> "$HARNESS_PROXY"
chmod 755 "$HARNESS_PROXY"
sed \
	-e "s#== \"491\"#== \"$(id -u)\"#" \
	-e "s#^HOME=.*#HOME=\"$HARNESS_HOME\"#" \
	-e "s#^CONFIG_FILE=.*#CONFIG_FILE=\"$HARNESS_CONFIG\"#" \
	-e "s#^PASSWORD_FILE=.*#PASSWORD_FILE=\"$HARNESS_PASSWORD\"#" \
	-e "s#^PROXY=.*#PROXY=\"$HARNESS_PROXY\"#" \
	"$WRITER_WRAPPER" > "$HARNESS_WRAPPER"
chmod 755 "$HARNESS_WRAPPER"
if RESULT_FILE="$HARNESS_RESULT" "$HARNESS_WRAPPER" >/dev/null 2>&1 \
	&& [[ "$(cat "$HARNESS_RESULT" 2>/dev/null)" == 'fixture-password-without-newline' ]]; then
	pass "I4a writer accepts a password file without a trailing newline"
else fail "I4a password file without trailing newline"; fi

if grep -Fq 'RAYA_INGRESS_ENV_FILE=' "$INGRESS_WRAPPER" \
	&& grep -Fq 'meeting-ingress-cli.js' "$INGRESS_WRAPPER" \
	&& ! grep -Eqi 'bot[_-]?token=.*[^}]$' "$INGRESS_WRAPPER"; then
	pass "I5 ingress wrapper carries only the I-private env-file path"
else fail "I5 I-only listener credential flow"; fi

mode() {
	if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}
if [[ "$(mode "$WRITER_WRAPPER")" == 755 ]] \
	&& [[ "$(mode "$INGRESS_WRAPPER")" == 755 ]] \
	&& [[ "$(mode "$WRITER_PLIST")" == 644 ]] \
	&& [[ "$(mode "$INGRESS_PLIST")" == 644 ]]; then
	pass "I6 rendered immutable assets have explicit modes"
else fail "I6 rendered asset modes"; fi

rm -f "$WRITER_WRAPPER"
ln -s "$FIXTURE_ROOT/render.out" "$WRITER_WRAPPER"
if "${render[@]}" >"$FIXTURE_ROOT/symlink.out" 2>"$FIXTURE_ROOT/symlink.err"; then
	fail "I7 renderer refuses a symlink target"
else
	pass "I7 renderer refuses a symlink target"
fi

if /bin/bash "$INSTALLER" apply --root "$FIXTURE_ROOT" \
	--writer-user _rayacalw --writer-uid 491 \
	--ingress-user _rayacali --ingress-uid 492 \
	--service-group _rayacal --service-gid 493 \
	--agent-user founder --agent-uid 501 \
	--voice-group _rayavoice --voice-gid 494 \
	--node-bin /usr/local/bin/node --gog-bin /usr/local/bin/gog \
	--raya-root /usr/local/lib/raya \
	>"$FIXTURE_ROOT/apply.out" 2>"$FIXTURE_ROOT/apply.err"; then
	fail "I8 apply requires the live root and explicit acknowledgement"
else
	pass "I8 apply requires the live root and explicit acknowledgement"
fi

if /bin/bash "$INSTALLER" render \
	--writer-user _rayacalw --writer-uid 491 \
	--ingress-user _rayacali --ingress-uid 492 \
	--service-group _rayacal --service-gid 493 \
	--agent-user founder --agent-uid 501 \
	--voice-group _rayavoice --voice-gid 494 \
	--node-bin /usr/local/bin/node --gog-bin /usr/local/bin/gog \
	--raya-root /usr/local/lib/raya \
	>"$FIXTURE_ROOT/render-live.out" 2>"$FIXTURE_ROOT/render-live.err"; then
	fail "I9 render requires an explicit filesystem root"
elif grep -Fq 'render live root requires explicit --root PATH' "$FIXTURE_ROOT/render-live.err"; then
	pass "I9 render requires an explicit filesystem root"
else
	fail "I9 render reaches its explicit-root guard"
fi

if /bin/bash "$INSTALLER" render --root / \
	--writer-user _rayacalw --writer-uid 491 \
	--ingress-user _rayacali --ingress-uid 492 \
	--service-group _rayacal --service-gid 493 \
	--agent-user founder --agent-uid 501 \
	--voice-group _rayavoice --voice-gid 494 \
	--node-bin /usr/local/bin/node --gog-bin /usr/local/bin/gog \
	--raya-root /usr/local/lib/raya \
	>"$FIXTURE_ROOT/render-root.out" 2>"$FIXTURE_ROOT/render-root.err"; then
	fail "I10 live-root render requires explicit acknowledgement"
elif grep -Fq 'render live root requires --ack FLY-2204-A-I-W' \
	"$FIXTURE_ROOT/render-root.err"; then
	pass "I10 live-root render requires explicit acknowledgement"
else
	fail "I10 live-root render reaches its acknowledgement guard"
fi

if /bin/bash "$INSTALLER" render --root // \
	--writer-user _rayacalw --writer-uid 491 \
	--ingress-user _rayacali --ingress-uid 492 \
	--service-group _rayacal --service-gid 493 \
	--agent-user founder --agent-uid 501 \
	--voice-group _rayavoice --voice-gid 494 \
	--node-bin /usr/local/bin/node --gog-bin /usr/local/bin/gog \
	--raya-root /__fly2204_missing_raya__ \
	>"$FIXTURE_ROOT/render-double-slash.out" \
	2>"$FIXTURE_ROOT/render-double-slash.err"; then
	fail "I11 double-slash live-root alias requires explicit acknowledgement"
elif grep -Fq 'render live root requires --ack FLY-2204-A-I-W' \
	"$FIXTURE_ROOT/render-double-slash.err"; then
	pass "I11 double-slash live-root alias requires explicit acknowledgement"
else
	fail "I11 double-slash alias reaches the live-root guard"
fi

LIVE_SUBTREE_ROOT="$FIXTURE_ROOT/live-subtree-alias"
if [[ -d /private && ! -L /private && -e /private/etc ]]; then
	LIVE_SUBTREE_ROOT=/private
else
	mkdir -p "$LIVE_SUBTREE_ROOT"
	ln -s /etc "$LIVE_SUBTREE_ROOT/etc"
fi
if /bin/bash "$INSTALLER" render --root "$LIVE_SUBTREE_ROOT" \
	--writer-user _rayacalw --writer-uid 491 \
	--ingress-user _rayacali --ingress-uid 492 \
	--service-group _rayacal --service-gid 493 \
	--agent-user founder --agent-uid 501 \
	--voice-group _rayavoice --voice-gid 494 \
	--node-bin /usr/local/bin/node --gog-bin /usr/local/bin/gog \
	--raya-root /__fly2204_missing_raya__ \
	>"$FIXTURE_ROOT/render-live-subtree.out" \
	2>"$FIXTURE_ROOT/render-live-subtree.err"; then
	fail "I12 live /etc subtree alias requires explicit acknowledgement"
elif grep -Fq 'render live root requires --ack FLY-2204-A-I-W' \
	"$FIXTURE_ROOT/render-live-subtree.err"; then
	pass "I12 live /etc subtree alias requires explicit acknowledgement"
else
	fail "I12 live /etc subtree alias reaches the live-root guard"
fi

LIVE_DATA_ROOT="$FIXTURE_ROOT/live-data-alias"
if [[ -d /System/Volumes/Data && ! -L /System/Volumes/Data \
	&& -e /System/Volumes/Data/usr/local ]]; then
	LIVE_DATA_ROOT=/System/Volumes/Data
else
	mkdir -p "$LIVE_DATA_ROOT/usr"
	ln -s /usr/local "$LIVE_DATA_ROOT/usr/local"
fi
if /bin/bash "$INSTALLER" render --root "$LIVE_DATA_ROOT" \
	--writer-user _rayacalw --writer-uid 491 \
	--ingress-user _rayacali --ingress-uid 492 \
	--service-group _rayacal --service-gid 493 \
	--agent-user founder --agent-uid 501 \
	--voice-group _rayavoice --voice-gid 494 \
	--node-bin /usr/local/bin/node --gog-bin /usr/local/bin/gog \
	--raya-root /__fly2204_missing_raya__ \
	>"$FIXTURE_ROOT/render-live-data.out" \
	2>"$FIXTURE_ROOT/render-live-data.err"; then
	fail "I13 live /usr/local target alias requires explicit acknowledgement"
elif grep -Fq 'render live root requires --ack FLY-2204-A-I-W' \
	"$FIXTURE_ROOT/render-live-data.err"; then
	pass "I13 live /usr/local target alias requires explicit acknowledgement"
else
	fail "I13 live /usr/local target alias reaches the live-root guard"
fi

LIVE_LAUNCHD_ROOT="$FIXTURE_ROOT/live-launchd-alias"
mkdir -p "$LIVE_LAUNCHD_ROOT/Library"
ln -s /Library/LaunchDaemons "$LIVE_LAUNCHD_ROOT/Library/LaunchDaemons"
if /bin/bash "$INSTALLER" render --root "$LIVE_LAUNCHD_ROOT" \
	--writer-user _rayacalw --writer-uid 491 \
	--ingress-user _rayacali --ingress-uid 492 \
	--service-group _rayacal --service-gid 493 \
	--agent-user founder --agent-uid 501 \
	--voice-group _rayavoice --voice-gid 494 \
	--node-bin /usr/local/bin/node --gog-bin /usr/local/bin/gog \
	--raya-root /__fly2204_missing_raya__ \
	>"$FIXTURE_ROOT/render-live-launchd.out" \
	2>"$FIXTURE_ROOT/render-live-launchd.err"; then
	fail "I14 live LaunchDaemons target alias requires explicit acknowledgement"
elif grep -Fq 'render live root requires --ack FLY-2204-A-I-W' \
	"$FIXTURE_ROOT/render-live-launchd.err"; then
	pass "I14 live LaunchDaemons target alias requires explicit acknowledgement"
else
	fail "I14 live LaunchDaemons target alias reaches the live-root guard"
fi

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
exit "$FAIL"
