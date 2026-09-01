#!/usr/bin/env bash
# FLY-2204: fixture and live negative probes for the A/I/W trust boundary.
set -euo pipefail

die() {
	printf 'calendar isolation verification: %s\n' "$*" >&2
	exit 1
}

usage() {
	printf 'usage: verify-calendar-isolation.sh fixture|live [--root PATH] [--ack FLY-2204-LIVE-NEGATIVE]\n' >&2
	exit 64
}

[[ $# -ge 1 ]] || usage
MODE="$1"
shift
[[ "$MODE" == fixture || "$MODE" == live ]] || usage
ROOT="/"
ACK=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--root) [[ $# -ge 2 ]] || usage; ROOT="$2"; shift 2 ;;
		--ack) [[ $# -ge 2 ]] || usage; ACK="$2"; shift 2 ;;
		*) usage ;;
	esac
done
[[ "$ROOT" = /* && -d "$ROOT" && ! -L "$ROOT" ]] || die "root must be a real absolute directory"
ROOT="$(cd "$ROOT" && pwd -P)"
[[ "$ROOT" != / ]] || ROOT=""

dest() {
	printf '%s%s' "$ROOT" "$1"
}

regular() {
	[[ -f "$1" && ! -L "$1" ]] || die "required regular file is missing or unsafe: $1"
}

mode() {
	if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}

assert_owner_mode() {
	local path="$1" owner="$2" group="$3" expected_mode="$4" actual
	actual="$(stat -f '%Su:%Sg:%Lp' "$path")" \
		|| die "cannot inspect ownership/mode: $path"
	[[ "$actual" == "$owner:$group:$expected_mode" ]] \
		|| die "ownership/mode mismatch: $path"
}

assert_root_owned_runtime() {
	local path="$1" kind="$2" actual owner group permissions
	case "$kind" in
		executable)
			[[ -x "$path" && ! -L "$path" ]] \
				|| die "runtime executable is missing or unsafe: $path"
			;;
		regular) regular "$path" ;;
		*) die "unknown runtime path kind: $kind" ;;
	esac
	actual="$(stat -f '%Su:%Sg:%Lp' "$path")" \
		|| die "cannot inspect runtime ownership/mode: $path"
	IFS=: read -r owner group permissions <<< "$actual"
	[[ "$owner" == root && "$group" == wheel && "$permissions" =~ ^[0-7]{3,4}$ ]] \
		|| die "runtime ownership/mode is invalid: $path"
	(( (8#$permissions & 8#022) == 0 )) \
		|| die "runtime is writable outside root: $path"
}

PLAN="$(dest /etc/raya-calendar-isolation/identity-plan.tsv)"
WRITER_WRAPPER="$(dest /usr/local/libexec/raya-calendar-writer-wrapper)"
INGRESS_WRAPPER="$(dest /usr/local/libexec/raya-meeting-ingress-wrapper)"
PROXY="$(dest /usr/local/libexec/raya-calendar-peer-proxy)"
WRITER_PLIST="$(dest /Library/LaunchDaemons/com.raya.calendar-writer.plist)"
INGRESS_PLIST="$(dest /Library/LaunchDaemons/com.raya.meeting-ingress.plist)"
WRITER_ENV="$(dest /etc/raya-calendar-isolation/writer.env)"
for path in "$PLAN" "$WRITER_WRAPPER" "$INGRESS_WRAPPER" "$PROXY" \
	"$WRITER_PLIST" "$INGRESS_PLIST"; do
	regular "$path"
done

field() {
	local pattern="$1" column="$2"
	awk -F '\t' -v pattern="$pattern" -v column="$column" \
		'$4 ~ pattern { if (found++) exit 65; value=$column } END { if (found != 1) exit 65; print value }' \
		"$PLAN" || die "identity plan does not contain exactly one $pattern row"
}

plan_value() {
	local kind="$1" name="$2"
	awk -F '\t' -v kind="$kind" -v name="$name" \
		'$1==kind && $2==name { if (found++) exit 65; value=$3 }
		 END { if (found != 1) exit 65; print value }' \
		"$PLAN" || die "identity plan does not contain exactly one $kind/$name row"
}

assignment_value() {
	local name="$1" path="$2"
	awk -v name="$name" \
		'index($0, name "=")==1 { if (found++) exit 65; value=substr($0, length(name)+2) }
		 END { if (found != 1) exit 65; print value }' \
		"$path" || die "$path does not contain exactly one $name assignment"
}

wrapper_assignments() {
	local path="$1"
	awk '
		/^[A-Za-z_][A-Za-z0-9_]*="[^"]*"$/ {
			equals=index($0, "=")
			name=substr($0, 1, equals-1)
			value=substr($0, equals+2, length($0)-equals-2)
			print name "\t" value
			next
		}
		/^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.\/:@+-]+$/ {
			equals=index($0, "=")
			print substr($0, 1, equals-1) "\t" substr($0, equals+1)
		}' "$path"
}

plan_wrapper_assignments() {
	local role="$1"
	awk -F '\t' -v prefix="$role:" \
		'$1=="wrapper-assignment" && index($2, prefix)==1 {
			name=substr($2, length(prefix)+1)
			if (name !~ /^[A-Za-z_][A-Za-z0-9_]*$/ || $3 == "" || $4 != "exact") exit 65
			print name "\t" $3
		}' "$PLAN"
}

assert_wrapper_assignment_manifest() {
	local role="$1" path="$2" expected actual
	expected="$(plan_wrapper_assignments "$role" | LC_ALL=C sort)" \
		|| die "$role wrapper assignment plan is invalid"
	actual="$(wrapper_assignments "$path" | LC_ALL=C sort)" \
		|| die "$role wrapper assignments cannot be inspected"
	[[ -n "$expected" && "$actual" == "$expected" ]] \
		|| die "$role wrapper assignment manifest mismatch"
}

uid_guard_value() {
	local path="$1"
	awk '
		/^\[\[ "\$\(id -u\)" == "[0-9][0-9]*" \]\]/ {
			if (found++) exit 65
			value=$0
			sub(/^\[\[ "\$\(id -u\)" == "/, "", value)
			sub(/".*$/, "", value)
		}
		END { if (found != 1) exit 65; print value }' "$path" \
		|| die "$path does not contain exactly one numeric uid guard"
}

WRITER_USER="$(field 'calendar-credential-owner' 2)"
WRITER_UID="$(field 'calendar-credential-owner' 3)"
INGRESS_USER="$(field 'founder-only-deterministic-ingress' 2)"
INGRESS_UID="$(field 'founder-only-deterministic-ingress' 3)"
AGENT_USER="$(field 'no-calendar-credential' 2)"
AGENT_UID="$(field 'no-calendar-credential' 3)"
SERVICE_GROUP="$(awk -F '\t' -v i="$INGRESS_USER" -v w="$WRITER_USER" \
	'$1=="group" && $4=="members=" i "," w { print $2 }' "$PLAN")"
VOICE_GROUP="$(awk -F '\t' -v a="$AGENT_USER" -v i="$INGRESS_USER" \
	'$1=="group" && $4=="members=" a "," i { print $2 }' "$PLAN")"
EXPECTED_NODE="$(plan_value runtime-executable node)"
EXPECTED_WRITER="$(plan_value runtime-entrypoint calendar-writer)"
EXPECTED_INGRESS="$(plan_value runtime-entrypoint meeting-ingress)"
EXPECTED_WRITER_GUARD_UID="$(plan_value wrapper-uid-guard writer)"
EXPECTED_INGRESS_GUARD_UID="$(plan_value wrapper-uid-guard ingress)"
[[ "$WRITER_USER" =~ ^_[a-z0-9_]{2,30}$ && "$INGRESS_USER" =~ ^_[a-z0-9_]{2,30}$ \
	&& "$AGENT_USER" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "identity names are invalid"
[[ "$WRITER_UID" =~ ^[0-9]+$ && "$INGRESS_UID" =~ ^[0-9]+$ && "$AGENT_UID" =~ ^[0-9]+$ ]] \
	|| die "identity ids are invalid"
[[ "$EXPECTED_WRITER_GUARD_UID" == "$WRITER_UID" \
	&& "$EXPECTED_INGRESS_GUARD_UID" == "$INGRESS_UID" ]] \
	|| die "wrapper uid guard plan is inconsistent with identity ids"
[[ "$SERVICE_GROUP" =~ ^_[a-z0-9_]{2,30}$ && "$VOICE_GROUP" =~ ^_[a-z0-9_]{2,30}$ \
	&& "$SERVICE_GROUP" != "$VOICE_GROUP" ]] || die "A/I/W group split is invalid"
[[ "$EXPECTED_NODE" = /* && "$EXPECTED_WRITER" = /* && "$EXPECTED_INGRESS" = /* ]] \
	|| die "declared runtime path is invalid"
grep -Fq $'group\t'"$SERVICE_GROUP"$'\t' "$PLAN" || die "writer transport group missing"
grep -Fq $'group\t'"$VOICE_GROUP"$'\t' "$PLAN" || die "voice bridge group missing"
grep -Fq $'runtime-root\t/var/db/raya-calendar-isolation\troot:wheel\t0755' "$PLAN" \
	|| die "persistent runtime root ownership plan is invalid"
grep -Fq $'runtime-root\t/var/db/raya-calendar-isolation/run\troot:wheel\t0755' "$PLAN" \
	|| die "persistent runtime run-root ownership plan is invalid"
grep -Fq $'runtime-directory\t/var/db/raya-calendar-isolation/run/calendar\t'"$WRITER_USER:$SERVICE_GROUP"$'\t0750' \
	"$PLAN" || die "writer socket directory ownership plan is invalid"
if awk -F '\t' -v group="$SERVICE_GROUP" -v agent="$AGENT_USER" \
	'$1=="group" && $2==group && index($4, agent)>0 { found=1 } END { exit !found }' "$PLAN"; then
	die "agent is present in writer transport group"
fi

[[ "$(mode "$WRITER_WRAPPER")" == 755 && "$(mode "$INGRESS_WRAPPER")" == 755 \
	&& "$(mode "$PROXY")" == 755 && "$(mode "$WRITER_PLIST")" == 644 \
	&& "$(mode "$INGRESS_PLIST")" == 644 ]] || die "immutable asset mode mismatch"

grep -Fq '<key>UserName</key><string>'"$WRITER_USER"'</string>' "$WRITER_PLIST" \
	|| die "writer plist user mismatch"
grep -Fq '<key>UserName</key><string>'"$INGRESS_USER"'</string>' "$INGRESS_PLIST" \
	|| die "ingress plist user mismatch"
grep -Fq '<key>GroupName</key><string>'"$SERVICE_GROUP"'</string>' "$WRITER_PLIST" \
	|| die "writer plist group mismatch"
grep -Fq '<key>GroupName</key><string>'"$SERVICE_GROUP"'</string>' "$INGRESS_PLIST" \
	|| die "ingress plist group mismatch"
assert_wrapper_assignment_manifest writer "$WRITER_WRAPPER"
assert_wrapper_assignment_manifest ingress "$INGRESS_WRAPPER"
[[ "$(uid_guard_value "$WRITER_WRAPPER")" == "$EXPECTED_WRITER_GUARD_UID" ]] \
	|| die "writer wrapper uid guard mismatch"
[[ "$(uid_guard_value "$INGRESS_WRAPPER")" == "$EXPECTED_INGRESS_GUARD_UID" ]] \
	|| die "ingress wrapper uid guard mismatch"
[[ "$(assignment_value INGRESS_UID "$WRITER_WRAPPER")" == "\"$INGRESS_UID\"" ]] \
	|| die "writer wrapper ingress uid mismatch"
[[ "$(assignment_value PASSWORD_FILE "$WRITER_WRAPPER")" \
	== "\"/Users/$WRITER_USER/secrets/gog-keyring-password\"" ]] \
	|| die "writer wrapper password path mismatch"
[[ "$(assignment_value SOCKET_PATH "$WRITER_WRAPPER")" \
	== '"/var/db/raya-calendar-isolation/run/calendar/writer.sock"' ]] \
	|| die "writer wrapper socket path mismatch"
[[ "$(assignment_value NODE "$WRITER_WRAPPER")" == "\"$EXPECTED_NODE\"" ]] \
	|| die "writer wrapper node path mismatch"
[[ "$(assignment_value WRITER "$WRITER_WRAPPER")" == "\"$EXPECTED_WRITER\"" ]] \
	|| die "writer wrapper handler path mismatch"
[[ "$(assignment_value HOME "$INGRESS_WRAPPER")" == "\"/Users/$INGRESS_USER\"" ]] \
	|| die "ingress wrapper home mismatch"
[[ "$(assignment_value RAYA_INGRESS_ENV_FILE "$INGRESS_WRAPPER")" \
	== "\"/Users/$INGRESS_USER/ingress.env\"" ]] \
	|| die "ingress wrapper env path mismatch"
[[ "$(assignment_value NODE "$INGRESS_WRAPPER")" == "\"$EXPECTED_NODE\"" ]] \
	|| die "ingress wrapper node path mismatch"
[[ "$(assignment_value INGRESS "$INGRESS_WRAPPER")" == "\"$EXPECTED_INGRESS\"" ]] \
	|| die "ingress wrapper handler path mismatch"
grep -Fq '<key>ProgramArguments</key><array><string>/usr/local/libexec/raya-calendar-writer-wrapper</string></array>' \
	"$WRITER_PLIST" || die "writer plist program mismatch"
if grep -Eqi 'EnvironmentVariables|GOG_KEYRING_PASSWORD|BOT[_-]?TOKEN|CALENDAR.*(ACCOUNT|CLIENT)' \
	"$WRITER_PLIST" "$INGRESS_PLIST"; then
	die "plist contains credential-bearing environment"
fi
# These are deliberately literal generated-shell contracts.
# shellcheck disable=SC2016
grep -Fq 'IFS= read -r GOG_KEYRING_PASSWORD < "$PASSWORD_FILE" || true' "$WRITER_WRAPPER" \
	|| die "writer password EOF-tolerance contract is missing"
grep -Fq 'export GOG_KEYRING_PASSWORD' "$WRITER_WRAPPER" \
	|| die "writer password export contract is missing"
# shellcheck disable=SC2016
[[ "$(tail -n 1 "$WRITER_WRAPPER")" == 'exec "$PROXY" "$SOCKET_PATH" "$INGRESS_UID" "$NODE" "$WRITER" serve-stdio' ]] \
	|| die "writer wrapper has an unexpected terminal command"
# shellcheck disable=SC2016
[[ "$(tail -n 1 "$INGRESS_WRAPPER")" == 'exec "$NODE" "$INGRESS" run' ]] \
	|| die "ingress wrapper has an unexpected terminal command"
[[ "$(grep -Ec '^[[:space:]]*exec ' "$WRITER_WRAPPER")" == 1 \
	&& "$(grep -Ec '^[[:space:]]*exec ' "$INGRESS_WRAPPER")" == 1 ]] \
	|| die "wrapper contains an additional executable path"
if command -v plutil >/dev/null 2>&1; then
	plutil -lint "$WRITER_PLIST" >/dev/null || die "writer plist is invalid"
	plutil -lint "$INGRESS_PLIST" >/dev/null || die "ingress plist is invalid"
fi

if [[ "$MODE" == fixture ]]; then
	printf '{"schemaVersion":1,"ready":true,"boundary":"A/I/W","live":false}\n'
	exit 0
fi

[[ -z "$ROOT" ]] || die "live verification is restricted to the live root"
[[ "$(uname -s)" == Darwin ]] || die "live verification requires macOS"
[[ "${EUID:-$(id -u)}" == 0 ]] || die "live verification requires root"
[[ "$ACK" == FLY-2204-LIVE-NEGATIVE ]] \
	|| die "live verification requires --ack FLY-2204-LIVE-NEGATIVE"

assert_root_owned_runtime "$EXPECTED_NODE" executable
assert_root_owned_runtime "$EXPECTED_WRITER" regular
assert_root_owned_runtime "$EXPECTED_INGRESS" regular

[[ "$(id -u "$WRITER_USER")" == "$WRITER_UID" \
	&& "$(id -u "$INGRESS_USER")" == "$INGRESS_UID" \
	&& "$(id -u "$AGENT_USER")" == "$AGENT_UID" ]] || die "live uid mismatch"
has_group() {
	id -Gn "$1" | tr ' ' '\n' | grep -Fxq "$2"
}
has_group "$WRITER_USER" "$SERVICE_GROUP" || die "W is outside writer transport"
has_group "$INGRESS_USER" "$SERVICE_GROUP" || die "I is outside writer transport"
! has_group "$AGENT_USER" "$SERVICE_GROUP" || die "A can traverse writer transport"
has_group "$AGENT_USER" "$VOICE_GROUP" || die "A is outside voice bridge"
has_group "$INGRESS_USER" "$VOICE_GROUP" || die "I is outside voice bridge"
! has_group "$WRITER_USER" "$VOICE_GROUP" || die "W can traverse voice bridge"

WRITER_HOME="/Users/$WRITER_USER"
INGRESS_HOME="/Users/$INGRESS_USER"
PASSWORD_FILE="$WRITER_HOME/secrets/gog-keyring-password"
INGRESS_ENV="$INGRESS_HOME/ingress.env"
RUNTIME_ROOT="/var/db/raya-calendar-isolation"
RUNTIME_RUN_ROOT="$RUNTIME_ROOT/run"
SOCKET_DIR="$RUNTIME_RUN_ROOT/calendar"
SOCKET_PATH="$SOCKET_DIR/writer.sock"
VOICE_ROOT="$RUNTIME_RUN_ROOT/meeting-voice"
COMMAND_DIR="$VOICE_ROOT/i-to-a"
FEEDBACK_DIR="$VOICE_ROOT/a-to-i"
for path in "$PASSWORD_FILE" "$INGRESS_ENV" "$WRITER_ENV"; do regular "$path"; done
[[ -S "$SOCKET_PATH" && ! -L "$SOCKET_PATH" ]] || die "writer socket is missing or unsafe"
[[ -d "$VOICE_ROOT" && ! -L "$VOICE_ROOT" \
	&& -d "$COMMAND_DIR" && ! -L "$COMMAND_DIR" \
	&& -d "$FEEDBACK_DIR" && ! -L "$FEEDBACK_DIR" ]] \
	|| die "voice bridge directories are missing or unsafe"
[[ "$(stat -f '%Su:%Lp' "$PASSWORD_FILE")" == "$WRITER_USER:600" ]] \
	|| die "writer password ownership/mode mismatch"
[[ "$(stat -f '%Su:%Lp' "$INGRESS_ENV")" == "$INGRESS_USER:600" ]] \
	|| die "ingress env ownership/mode mismatch"
assert_owner_mode "$WRITER_WRAPPER" root wheel 755
assert_owner_mode "$INGRESS_WRAPPER" root wheel 755
assert_owner_mode "$PROXY" root wheel 755
assert_owner_mode "$WRITER_PLIST" root wheel 644
assert_owner_mode "$INGRESS_PLIST" root wheel 644
assert_owner_mode "$WRITER_ENV" root "$SERVICE_GROUP" 640
assert_owner_mode "$VOICE_ROOT" root wheel 755
for path in /var/db "$RUNTIME_ROOT" "$RUNTIME_RUN_ROOT"; do
	[[ -d "$path" && ! -L "$path" \
		&& "$(stat -f '%Su:%Sg:%Lp' "$path")" == "root:wheel:755" ]] \
		|| die "runtime ancestor ownership/mode mismatch: $path"
done
[[ "$(stat -f '%Su:%Sg:%Lp' "$SOCKET_DIR")" == "$WRITER_USER:$SERVICE_GROUP:750" ]] \
	|| die "writer socket directory ownership/mode mismatch"
[[ "$(stat -f '%Su:%Sg:%Lp' "$SOCKET_PATH")" == "$WRITER_USER:$SERVICE_GROUP:660" ]] \
	|| die "writer socket ownership/mode mismatch"
[[ "$(stat -f '%Su:%Sg:%Lp' "$COMMAND_DIR")" == "$INGRESS_USER:$VOICE_GROUP:750" ]] \
	|| die "I-to-A command directory mismatch"
[[ "$(stat -f '%Su:%Sg:%Lp' "$FEEDBACK_DIR")" == "$AGENT_USER:$VOICE_GROUP:750" ]] \
	|| die "A-to-I feedback directory mismatch"

for tuple in \
	"$AGENT_USER:$PASSWORD_FILE" "$AGENT_USER:$INGRESS_ENV" \
	"$INGRESS_USER:$PASSWORD_FILE" "$WRITER_USER:$INGRESS_ENV"; do
	user="${tuple%%:*}"
	path="${tuple#*:}"
	if /usr/bin/sudo -u "$user" /usr/bin/test -r "$path"; then
		die "credential is readable across domains"
	fi
done
/usr/bin/sudo -u "$AGENT_USER" /usr/bin/test ! -w "$COMMAND_DIR" \
	|| die "A can write I-to-A commands"
/usr/bin/sudo -u "$AGENT_USER" /usr/bin/test -r "$COMMAND_DIR" \
	|| die "A cannot read I-to-A commands"
/usr/bin/sudo -u "$INGRESS_USER" /usr/bin/test ! -w "$FEEDBACK_DIR" \
	|| die "I can write A-to-I feedback"
/usr/bin/sudo -u "$AGENT_USER" /usr/bin/test ! -w "$RUNTIME_RUN_ROOT" \
	|| die "A can replace runtime endpoints"

NODE_BIN="$(awk -F '"' '$1=="NODE=" { print $2 }' "$WRITER_WRAPPER")"
[[ "$NODE_BIN" = /* && -x "$NODE_BIN" && ! -L "$NODE_BIN" ]] || die "fixed node runtime is unsafe"
if /usr/bin/sudo -u "$AGENT_USER" "$NODE_BIN" -e '
const net = require("node:net");
const socket = net.createConnection(process.argv[1]);
const timer = setTimeout(() => process.exit(43), 3000);
socket.on("connect", () => { clearTimeout(timer); process.exit(42); });
socket.on("error", (error) => {
  clearTimeout(timer);
  process.exit(error && (error.code === "EACCES" || error.code === "EPERM") ? 0 : 44);
});
' "$SOCKET_PATH"; then
	:
else
	die "A socket probe was not denied at the transport layer"
fi
launchctl print system/com.raya.calendar-writer >/dev/null \
	|| die "writer LaunchDaemon is not loaded"
launchctl print system/com.raya.meeting-ingress >/dev/null \
	|| die "ingress LaunchDaemon is not loaded"

printf '{"schemaVersion":1,"ready":true,"boundary":"A/I/W","live":true,"credentialReads":"denied","agentSocket":"denied"}\n'
