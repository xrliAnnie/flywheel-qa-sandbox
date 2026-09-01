#!/usr/bin/env bash
# FLY-2204: render/install the A/I/W calendar isolation service bundle.
# Live apply/activate operations require root plus a literal acknowledgement.
set -euo pipefail

die() {
	printf 'calendar-isolation installer: %s\n' "$*" >&2
	exit 64
}

usage() {
	cat >&2 <<'EOF'
usage: install-calendar-services.sh render|apply|activate|rollback [options]

Required identity options:
  --writer-user NAME --writer-uid UID
  --ingress-user NAME --ingress-uid UID
  --service-group NAME --service-gid GID
  --agent-user NAME --agent-uid UID
  --voice-group NAME --voice-gid GID

Other options:
  --root PATH       filesystem root (required for render)
  --ack TEXT        required for live commands; literal FLY-2204-A-I-W
  --node-bin PATH   stable absolute node binary (default /opt/homebrew/bin/node)
  --gog-bin PATH    stable absolute gog binary (default /usr/local/bin/gog)
  --raya-root PATH  root-owned built Raya tree (default /usr/local/lib/raya)

render writes and validates a fixture-safe bundle. apply creates the declared
macOS identities and installs, but does not load, the daemons. activate loads
W then I and rolls both back if either bootstrap fails. rollback boots out I
then W. The script never accepts a password or token argument.
EOF
	exit 64
}

[[ $# -ge 1 ]] || usage
COMMAND="$1"
shift
case "$COMMAND" in
	render|apply|activate|rollback) ;;
	*) usage ;;
esac

ROOT="/"
ROOT_EXPLICIT=0
ACK=""
WRITER_USER=""
WRITER_UID=""
INGRESS_USER=""
INGRESS_UID=""
SERVICE_GROUP=""
SERVICE_GID=""
AGENT_USER=""
AGENT_UID=""
VOICE_GROUP=""
VOICE_GID=""
NODE_BIN="/opt/homebrew/bin/node"
GOG_BIN="/usr/local/bin/gog"
RAYA_ROOT="/usr/local/lib/raya"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--root) [[ $# -ge 2 ]] || usage; ROOT="$2"; ROOT_EXPLICIT=1; shift 2 ;;
		--ack) [[ $# -ge 2 ]] || usage; ACK="$2"; shift 2 ;;
		--writer-user) [[ $# -ge 2 ]] || usage; WRITER_USER="$2"; shift 2 ;;
		--writer-uid) [[ $# -ge 2 ]] || usage; WRITER_UID="$2"; shift 2 ;;
		--ingress-user) [[ $# -ge 2 ]] || usage; INGRESS_USER="$2"; shift 2 ;;
		--ingress-uid) [[ $# -ge 2 ]] || usage; INGRESS_UID="$2"; shift 2 ;;
		--service-group) [[ $# -ge 2 ]] || usage; SERVICE_GROUP="$2"; shift 2 ;;
		--service-gid) [[ $# -ge 2 ]] || usage; SERVICE_GID="$2"; shift 2 ;;
		--agent-user) [[ $# -ge 2 ]] || usage; AGENT_USER="$2"; shift 2 ;;
		--agent-uid) [[ $# -ge 2 ]] || usage; AGENT_UID="$2"; shift 2 ;;
		--voice-group) [[ $# -ge 2 ]] || usage; VOICE_GROUP="$2"; shift 2 ;;
		--voice-gid) [[ $# -ge 2 ]] || usage; VOICE_GID="$2"; shift 2 ;;
		--node-bin) [[ $# -ge 2 ]] || usage; NODE_BIN="$2"; shift 2 ;;
		--gog-bin) [[ $# -ge 2 ]] || usage; GOG_BIN="$2"; shift 2 ;;
		--raya-root) [[ $# -ge 2 ]] || usage; RAYA_ROOT="$2"; shift 2 ;;
		*) usage ;;
	esac
done

[[ "$COMMAND" != render || "$ROOT_EXPLICIT" == 1 ]] \
	|| die "render live root requires explicit --root PATH"

system_name() {
	[[ "$1" =~ ^_[a-z0-9_]{2,30}$ ]] || die "$2 must be a macOS system identity name"
}

user_name() {
	[[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "$2 must be a local user name"
}

numeric_id() {
	[[ "$1" =~ ^[0-9]{2,9}$ ]] || die "$2 must be numeric"
}

logical_path() {
	[[ "$1" = /* && "$1" != *$'\n'* && "$1" != *$'\r'* \
		&& "$1" != *'/../'* && "$1" != */.. && "$1" != *'/./'* ]] \
		|| die "$2 must be a normalized absolute path"
}

system_name "$WRITER_USER" "--writer-user"
system_name "$INGRESS_USER" "--ingress-user"
system_name "$SERVICE_GROUP" "--service-group"
system_name "$VOICE_GROUP" "--voice-group"
user_name "$AGENT_USER" "--agent-user"
numeric_id "$WRITER_UID" "--writer-uid"
numeric_id "$INGRESS_UID" "--ingress-uid"
numeric_id "$SERVICE_GID" "--service-gid"
numeric_id "$AGENT_UID" "--agent-uid"
numeric_id "$VOICE_GID" "--voice-gid"
logical_path "$NODE_BIN" "--node-bin"
logical_path "$GOG_BIN" "--gog-bin"
logical_path "$RAYA_ROOT" "--raya-root"
[[ "$WRITER_USER" != "$INGRESS_USER" && "$WRITER_USER" != "$AGENT_USER" \
	&& "$INGRESS_USER" != "$AGENT_USER" ]] || die "A, I, and W users must differ"
[[ "$SERVICE_GROUP" != "$VOICE_GROUP" ]] || die "writer transport and voice groups must differ"
UNIQUE_ID_COUNT="$(
	printf '%s\n' "$WRITER_UID" "$INGRESS_UID" "$SERVICE_GID" "$AGENT_UID" "$VOICE_GID" \
		| sort -u | wc -l | tr -d '[:space:]'
)"
[[ "$UNIQUE_ID_COUNT" == 5 ]] || die "all declared uid/gid values must differ"

[[ "$ROOT" = /* ]] || die "--root must be absolute"
[[ -d "$ROOT" && ! -L "$ROOT" ]] || die "--root must be a real directory"

path_identity() {
	local path="$1" identity
	if identity="$(stat -f '%d:%i' -L "$path" 2>/dev/null)"; then
		:
	elif identity="$(stat -Lc '%d:%i' "$path" 2>/dev/null)"; then
		:
	else
		die "cannot inspect root identity: $path"
	fi
	printf '%s' "$identity"
}

ROOT="$(cd "$ROOT" && pwd -P)"
root_maps_live_target() {
	local live_target candidate link_target
	for live_target in /etc /usr/local /Library/LaunchDaemons; do
		candidate="$ROOT$live_target"
		if [[ -L "$candidate" ]]; then
			link_target="$(readlink "$candidate" 2>/dev/null)" \
				|| die "cannot inspect root link: $candidate"
			[[ "$link_target" == "$live_target" ]] && return 0
		fi
		[[ -e "$candidate" && -e "$live_target" ]] || continue
		if [[ "$(path_identity "$candidate")" == "$(path_identity "$live_target")" ]]; then
			return 0
		fi
	done
	return 1
}

if [[ "$(path_identity "$ROOT")" == "$(path_identity /)" ]] \
	|| root_maps_live_target; then
	ROOT=""
fi

dest() {
	printf '%s%s' "$ROOT" "$1"
}

safe_directory() {
	local path="$1"
	[[ ! -L "$path" ]] || die "refusing symlink directory: $path"
	mkdir -p "$path"
	[[ -d "$path" && ! -L "$path" ]] || die "directory is unsafe: $path"
}

safe_target() {
	local path="$1"
	[[ ! -L "$path" ]] || die "refusing symlink target: $path"
	[[ ! -e "$path" || -f "$path" ]] || die "refusing non-file target: $path"
}

atomic_install() {
	local source="$1" target="$2" mode="$3"
	safe_target "$target"
	local temporary="${target}.tmp.$$"
	rm -f "$temporary"
	install -m "$mode" "$source" "$temporary"
	mv -f "$temporary" "$target"
}

atomic_text() {
	local target="$1" mode="$2"
	safe_target "$target"
	local temporary="${target}.tmp.$$"
	rm -f "$temporary"
	cat > "$temporary"
	chmod "$mode" "$temporary"
	mv -f "$temporary" "$target"
}

LIBEXEC="/usr/local/libexec"
CONFIG_ROOT="/etc/raya-calendar-isolation"
WRITER_HOME="/Users/$WRITER_USER"
INGRESS_HOME="/Users/$INGRESS_USER"
RUNTIME_ROOT="/var/db/raya-calendar-isolation"
RUNTIME_RUN_ROOT="$RUNTIME_ROOT/run"
SOCKET_DIR="$RUNTIME_RUN_ROOT/calendar"
SOCKET_PATH="$SOCKET_DIR/writer.sock"
VOICE_ROOT="$RUNTIME_RUN_ROOT/meeting-voice"
VOICE_COMMAND_DIR="$VOICE_ROOT/i-to-a"
VOICE_FEEDBACK_DIR="$VOICE_ROOT/a-to-i"
WRITER_LABEL="com.raya.calendar-writer"
INGRESS_LABEL="com.raya.meeting-ingress"
WRITER_PLIST="/Library/LaunchDaemons/$WRITER_LABEL.plist"
INGRESS_PLIST="/Library/LaunchDaemons/$INGRESS_LABEL.plist"

render_bundle() {
	local runtime_writer runtime_ingress node gog cc
	runtime_writer="$(dest "$RAYA_ROOT/apps/brain/dist/calendar-writer-cli.js")"
	runtime_ingress="$(dest "$RAYA_ROOT/apps/brain/dist/meeting-ingress-cli.js")"
	node="$(dest "$NODE_BIN")"
	gog="$(dest "$GOG_BIN")"
	[[ -f "$runtime_writer" && ! -L "$runtime_writer" ]] \
		|| die "calendar writer runtime is missing from $RAYA_ROOT"
	[[ -f "$runtime_ingress" && ! -L "$runtime_ingress" ]] \
		|| die "meeting ingress runtime is missing from $RAYA_ROOT"
	[[ -x "$node" && ! -L "$node" ]] || die "node runtime is missing from $NODE_BIN"
	[[ -x "$gog" && ! -L "$gog" ]] || die "gog is missing from $GOG_BIN"
	cc="$(command -v cc 2>/dev/null || true)"
	[[ -n "$cc" ]] || die "a C compiler is required for the peer proxy"

	local libexec config launchdaemons build
	libexec="$(dest "$LIBEXEC")"
	config="$(dest "$CONFIG_ROOT")"
	launchdaemons="$(dest "/Library/LaunchDaemons")"
	build="$(mktemp -d "${TMPDIR:-/tmp}/fly2204-calendar-render.XXXXXX")"
	for path in "$libexec" "$config" "$launchdaemons"; do safe_directory "$path"; done

	"$cc" -std=c11 -Wall -Wextra -Werror -O2 \
		"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/raya-calendar-peer-proxy.c" \
		-o "$build/raya-calendar-peer-proxy"
	atomic_install "$build/raya-calendar-peer-proxy" \
		"$libexec/raya-calendar-peer-proxy" 0755
	rm -f "$build/raya-calendar-peer-proxy"
	rmdir "$build"

	atomic_text "$libexec/raya-calendar-writer-wrapper" 0755 <<EOF
#!/usr/bin/env bash
set -euo pipefail
[[ "\$(id -u)" == "$WRITER_UID" ]] || { printf 'writer wrapper: wrong uid\n' >&2; exit 77; }
HOME="$WRITER_HOME"
CONFIG_FILE="$CONFIG_ROOT/writer.env"
PASSWORD_FILE="$WRITER_HOME/secrets/gog-keyring-password"
PROXY="$LIBEXEC/raya-calendar-peer-proxy"
SOCKET_PATH="$SOCKET_PATH"
INGRESS_UID="$INGRESS_UID"
NODE="$NODE_BIN"
WRITER="$RAYA_ROOT/apps/brain/dist/calendar-writer-cli.js"
for path in "\$CONFIG_FILE" "\$PASSWORD_FILE"; do
	[[ -f "\$path" && ! -L "\$path" ]] || { printf 'writer wrapper: unsafe configuration\n' >&2; exit 78; }
done
set -a
# root-owned and non-writable by W; contains selectors and paths, never a password.
. "\$CONFIG_FILE"
set +a
[[ "\${RAYA_GOG_BIN:-}" == "$GOG_BIN" ]] || { printf 'writer wrapper: gog path mismatch\n' >&2; exit 78; }
IFS= read -r GOG_KEYRING_PASSWORD < "\$PASSWORD_FILE" || true
[[ -n "\$GOG_KEYRING_PASSWORD" ]] || { printf 'writer wrapper: empty keyring password\n' >&2; exit 78; }
GOG_KEYRING_BACKEND=file
RAYA_WRITER_STATE_DIR="$WRITER_HOME/state"
export GOG_KEYRING_PASSWORD
export HOME GOG_KEYRING_BACKEND RAYA_WRITER_STATE_DIR
exec "\$PROXY" "\$SOCKET_PATH" "\$INGRESS_UID" "\$NODE" "\$WRITER" serve-stdio
EOF

	atomic_text "$libexec/raya-meeting-ingress-wrapper" 0755 <<EOF
#!/usr/bin/env bash
set -euo pipefail
[[ "\$(id -u)" == "$INGRESS_UID" ]] || { printf 'meeting ingress wrapper: wrong uid\n' >&2; exit 77; }
HOME="$INGRESS_HOME"
RAYA_INGRESS_ENV_FILE="$INGRESS_HOME/ingress.env"
NODE="$NODE_BIN"
INGRESS="$RAYA_ROOT/apps/brain/dist/meeting-ingress-cli.js"
[[ -f "\$RAYA_INGRESS_ENV_FILE" && ! -L "\$RAYA_INGRESS_ENV_FILE" ]] \
	|| { printf 'meeting ingress wrapper: unsafe env file\n' >&2; exit 78; }
export HOME RAYA_INGRESS_ENV_FILE
exec "\$NODE" "\$INGRESS" run
EOF

	{
		printf 'kind\tname\tid\tpolicy\n'
		printf 'group\t%s\t%s\tmembers=%s,%s\n' \
			"$SERVICE_GROUP" "$SERVICE_GID" "$INGRESS_USER" "$WRITER_USER"
		printf 'group\t%s\t%s\tmembers=%s,%s\n' \
			"$VOICE_GROUP" "$VOICE_GID" "$AGENT_USER" "$INGRESS_USER"
		printf 'user\t%s\t%s\tno-login;calendar-credential-owner\n' \
			"$WRITER_USER" "$WRITER_UID"
		printf 'user\t%s\t%s\tno-login;founder-only-deterministic-ingress\n' \
			"$INGRESS_USER" "$INGRESS_UID"
		printf 'existing-agent\t%s\t%s\tno-calendar-credential;not-in-%s\n' \
			"$AGENT_USER" "$AGENT_UID" "$SERVICE_GROUP"
		printf 'runtime-executable\tnode\t%s\troot-owned;executable\n' "$NODE_BIN"
		printf 'runtime-entrypoint\tcalendar-writer\t%s\troot-owned;regular\n' \
			"$RAYA_ROOT/apps/brain/dist/calendar-writer-cli.js"
		printf 'runtime-entrypoint\tmeeting-ingress\t%s\troot-owned;regular\n' \
			"$RAYA_ROOT/apps/brain/dist/meeting-ingress-cli.js"
		printf 'wrapper-assignment\twriter:HOME\t%s\texact\n' "$WRITER_HOME"
		printf 'wrapper-assignment\twriter:CONFIG_FILE\t%s/writer.env\texact\n' "$CONFIG_ROOT"
		printf 'wrapper-assignment\twriter:PASSWORD_FILE\t%s/secrets/gog-keyring-password\texact\n' \
			"$WRITER_HOME"
		printf 'wrapper-assignment\twriter:PROXY\t%s/raya-calendar-peer-proxy\texact\n' "$LIBEXEC"
		printf 'wrapper-assignment\twriter:SOCKET_PATH\t%s\texact\n' "$SOCKET_PATH"
		printf 'wrapper-assignment\twriter:INGRESS_UID\t%s\texact\n' "$INGRESS_UID"
		printf 'wrapper-assignment\twriter:NODE\t%s\texact\n' "$NODE_BIN"
		printf 'wrapper-assignment\twriter:WRITER\t%s/apps/brain/dist/calendar-writer-cli.js\texact\n' \
			"$RAYA_ROOT"
		printf 'wrapper-assignment\twriter:GOG_KEYRING_BACKEND\tfile\texact\n'
		printf 'wrapper-assignment\twriter:RAYA_WRITER_STATE_DIR\t%s/state\texact\n' "$WRITER_HOME"
		printf 'wrapper-assignment\tingress:HOME\t%s\texact\n' "$INGRESS_HOME"
		printf 'wrapper-assignment\tingress:RAYA_INGRESS_ENV_FILE\t%s/ingress.env\texact\n' \
			"$INGRESS_HOME"
		printf 'wrapper-assignment\tingress:NODE\t%s\texact\n' "$NODE_BIN"
		printf 'wrapper-assignment\tingress:INGRESS\t%s/apps/brain/dist/meeting-ingress-cli.js\texact\n' \
			"$RAYA_ROOT"
		printf 'wrapper-uid-guard\twriter\t%s\texact\n' "$WRITER_UID"
		printf 'wrapper-uid-guard\tingress\t%s\texact\n' "$INGRESS_UID"
		printf 'runtime-root\t%s\troot:wheel\t0755\n' "$RUNTIME_ROOT"
		printf 'runtime-root\t%s\troot:wheel\t0755\n' "$RUNTIME_RUN_ROOT"
		printf 'runtime-directory\t%s\t%s:%s\t0750\n' \
			"$SOCKET_DIR" "$WRITER_USER" "$SERVICE_GROUP"
	} | atomic_text "$config/identity-plan.tsv" 0644

	atomic_text "$config/writer.env.template" 0640 <<EOF
# Root-owned, non-secret selectors. Do not put GOG_KEYRING_PASSWORD here.
RAYA_GOG_BIN=$GOG_BIN
RAYA_MEETING_CALENDAR_ACCOUNT=REPLACE_WITH_WRITER_ACCOUNT
RAYA_MEETING_CALENDAR_CLIENT=REPLACE_WITH_INDEPENDENT_CLIENT
RAYA_MEETING_CALENDAR_ID=REPLACE_WITH_EXPLICIT_FOUNDER_CALENDAR_ID
EOF
	atomic_text "$config/ingress.env.template" 0600 <<EOF
# Copy to $INGRESS_HOME/ingress.env as $INGRESS_USER mode 0600.
RAYA_INGRESS_HOME=$INGRESS_HOME
RAYA_INGRESS_ENV_FILE=$INGRESS_HOME/ingress.env
RAYA_INGRESS_STATE_DIR=$INGRESS_HOME/state
RAYA_INGRESS_BOT_TOKEN=REPLACE_IN_I_DOMAIN_ONLY
RAYA_INGRESS_BOT_USER_ID=REPLACE_WITH_INGRESS_BOT_ID
RAYA_FOUNDER_DISCORD_USER_ID=REPLACE_WITH_FOUNDER_ID
RAYA_DISCORD_GUILD_ID=REPLACE_WITH_GUILD_ID
RAYA_DISCORD_TEXT_CHANNEL_ID=REPLACE_WITH_TEXT_CHANNEL_ID
RAYA_MEETING_SHARED_CHANNEL_ID=REPLACE_WITH_SHARED_CHANNEL_ID
RAYA_DISCORD_VOICE_CHANNEL_ID=REPLACE_WITH_VOICE_CHANNEL_ID
RAYA_WRITER_SOCKET=$SOCKET_PATH
RAYA_VOICE_COMMAND_DIR=$VOICE_COMMAND_DIR
RAYA_VOICE_FEEDBACK_DIR=$VOICE_FEEDBACK_DIR
EOF

	atomic_text "$(dest "$WRITER_PLIST")" 0644 <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$WRITER_LABEL</string>
  <key>UserName</key><string>$WRITER_USER</string>
  <key>GroupName</key><string>$SERVICE_GROUP</string>
  <key>ProgramArguments</key><array><string>$LIBEXEC/raya-calendar-writer-wrapper</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$WRITER_HOME/log/writer.log</string>
  <key>StandardErrorPath</key><string>$WRITER_HOME/log/writer.err.log</string>
</dict></plist>
EOF
	atomic_text "$(dest "$INGRESS_PLIST")" 0644 <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$INGRESS_LABEL</string>
  <key>UserName</key><string>$INGRESS_USER</string>
  <key>GroupName</key><string>$SERVICE_GROUP</string>
  <key>ProgramArguments</key><array><string>$LIBEXEC/raya-meeting-ingress-wrapper</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$INGRESS_HOME/log/ingress.log</string>
  <key>StandardErrorPath</key><string>$INGRESS_HOME/log/ingress.err.log</string>
</dict></plist>
EOF

	if command -v plutil >/dev/null 2>&1; then
		plutil -lint "$(dest "$WRITER_PLIST")" >/dev/null
		plutil -lint "$(dest "$INGRESS_PLIST")" >/dev/null
	fi
	printf 'rendered FLY-2204 A/I/W bundle under %s\n' "${ROOT:-/}"
}

require_live_authority() {
	[[ -z "$ROOT" ]] || die "$COMMAND is restricted to the live root"
	[[ "$(uname -s)" == "Darwin" ]] || die "$COMMAND requires macOS"
	[[ "${EUID:-$(id -u)}" == 0 ]] || die "$COMMAND requires root"
	[[ "$ACK" == "FLY-2204-A-I-W" ]] || die "$COMMAND requires --ack FLY-2204-A-I-W"
}

dscl_id() {
	local kind="$1" name="$2" key="$3"
	dscl . -read "/$kind/$name" "$key" 2>/dev/null | awk '{print $2}'
}

ensure_group() {
	local name="$1" gid="$2" current
	current="$(dscl_id Groups "$name" PrimaryGroupID || true)"
	if [[ -n "$current" ]]; then
		[[ "$current" == "$gid" ]] || die "group $name has gid $current, expected $gid"
		return
	fi
	[[ -z "$(dscl . -search /Groups PrimaryGroupID "$gid" 2>/dev/null || true)" ]] \
		|| die "gid $gid is already assigned"
	dscl . -create "/Groups/$name"
	dscl . -create "/Groups/$name" PrimaryGroupID "$gid"
	dscl . -create "/Groups/$name" Password '*'
}

ensure_user() {
	local name="$1" uid="$2" gid="$3" home="$4" current
	current="$(dscl_id Users "$name" UniqueID || true)"
	if [[ -n "$current" ]]; then
		[[ "$current" == "$uid" ]] || die "user $name has uid $current, expected $uid"
		return
	fi
	[[ -z "$(dscl . -search /Users UniqueID "$uid" 2>/dev/null || true)" ]] \
		|| die "uid $uid is already assigned"
	dscl . -create "/Users/$name"
	dscl . -create "/Users/$name" UniqueID "$uid"
	dscl . -create "/Users/$name" PrimaryGroupID "$gid"
	dscl . -create "/Users/$name" NFSHomeDirectory "$home"
	dscl . -create "/Users/$name" UserShell /usr/bin/false
	dscl . -create "/Users/$name" IsHidden 1
	dscl . -create "/Users/$name" Password '*'
}

assert_agent_identity() {
	local actual
	actual="$(dscl_id Users "$AGENT_USER" UniqueID || true)"
	[[ "$actual" == "$AGENT_UID" ]] || die "agent user $AGENT_USER uid mismatch"
}

assert_not_member() {
	local user="$1" group="$2" result verdict status=0
	result="$(dseditgroup -o checkmember -m "$user" "$group" 2>&1)" || status=$?
	read -r verdict _ <<< "$result"
	case "$verdict" in
		yes) die "$user must not be a member of $group" ;;
		no)
			[[ "$status" == 0 || "$status" == 67 ]] \
				|| die "unexpected group membership status for $user"
			return 0
			;;
		*) die "unexpected group membership result for $user" ;;
	esac
}

assert_root_runtime_directory() {
	local path="$1"
	[[ -d "$path" && ! -L "$path" ]] || die "runtime ancestor is missing or unsafe: $path"
	[[ "$(stat -f '%Su:%Sg:%Lp' "$path")" == "root:wheel:755" ]] \
		|| die "runtime ancestor ownership/mode mismatch: $path"
}

ensure_root_runtime_directory() {
	local path="$1"
	[[ ! -L "$path" ]] || die "refusing symlink runtime ancestor: $path"
	install -d -o root -g wheel -m 0755 "$path"
	assert_root_runtime_directory "$path"
}

apply_bundle() {
	require_live_authority
	ensure_group "$SERVICE_GROUP" "$SERVICE_GID"
	ensure_group "$VOICE_GROUP" "$VOICE_GID"
	ensure_user "$WRITER_USER" "$WRITER_UID" "$SERVICE_GID" "$WRITER_HOME"
	ensure_user "$INGRESS_USER" "$INGRESS_UID" "$SERVICE_GID" "$INGRESS_HOME"
	assert_agent_identity
	for member in "$WRITER_USER" "$INGRESS_USER"; do
		dseditgroup -o edit -a "$member" -t user "$SERVICE_GROUP"
	done
	for member in "$AGENT_USER" "$INGRESS_USER"; do
		dseditgroup -o edit -a "$member" -t user "$VOICE_GROUP"
	done
	assert_not_member "$AGENT_USER" "$SERVICE_GROUP"
	assert_not_member "$WRITER_USER" "$VOICE_GROUP"
	render_bundle

	install -d -o "$WRITER_USER" -g "$SERVICE_GROUP" -m 0700 \
		"$WRITER_HOME" "$WRITER_HOME/state" "$WRITER_HOME/secrets" "$WRITER_HOME/log"
	install -d -o "$INGRESS_USER" -g "$SERVICE_GROUP" -m 0700 \
		"$INGRESS_HOME" "$INGRESS_HOME/state" "$INGRESS_HOME/log"
	assert_root_runtime_directory /var/db
	ensure_root_runtime_directory "$RUNTIME_ROOT"
	ensure_root_runtime_directory "$RUNTIME_RUN_ROOT"
	install -d -o "$WRITER_USER" -g "$SERVICE_GROUP" -m 0750 "$SOCKET_DIR"
	install -d -o root -g wheel -m 0755 "$VOICE_ROOT"
	install -d -o "$INGRESS_USER" -g "$VOICE_GROUP" -m 0750 "$VOICE_COMMAND_DIR"
	install -d -o "$AGENT_USER" -g "$VOICE_GROUP" -m 0750 "$VOICE_FEEDBACK_DIR"
	if [[ ! -e "$CONFIG_ROOT/writer.env" ]]; then
		install -o root -g "$SERVICE_GROUP" -m 0640 \
			"$CONFIG_ROOT/writer.env.template" "$CONFIG_ROOT/writer.env"
	fi
	if [[ ! -e "$WRITER_HOME/secrets/gog-keyring-password" ]]; then
		install -o "$WRITER_USER" -g "$SERVICE_GROUP" -m 0600 /dev/null \
			"$WRITER_HOME/secrets/gog-keyring-password"
	fi
	if [[ ! -e "$INGRESS_HOME/ingress.env" ]]; then
		install -o "$INGRESS_USER" -g "$SERVICE_GROUP" -m 0600 \
			"$CONFIG_ROOT/ingress.env.template" "$INGRESS_HOME/ingress.env"
	fi
	chown root:wheel "$LIBEXEC/raya-calendar-peer-proxy" \
		"$LIBEXEC/raya-calendar-writer-wrapper" "$LIBEXEC/raya-meeting-ingress-wrapper" \
		"$WRITER_PLIST" "$INGRESS_PLIST"
	chmod 0755 "$LIBEXEC/raya-calendar-peer-proxy" \
		"$LIBEXEC/raya-calendar-writer-wrapper" "$LIBEXEC/raya-meeting-ingress-wrapper"
	chmod 0644 "$WRITER_PLIST" "$INGRESS_PLIST"
	printf 'installed but not activated; provision W/I private files, then run activate\n'
}

activate_bundle() {
	require_live_authority
	for path in "$CONFIG_ROOT/writer.env" "$WRITER_HOME/secrets/gog-keyring-password" \
		"$INGRESS_HOME/ingress.env" "$WRITER_PLIST" "$INGRESS_PLIST"; do
		[[ -s "$path" && ! -L "$path" ]] || die "activation input is missing or unsafe: $path"
	done
	plutil -lint "$WRITER_PLIST" >/dev/null
	plutil -lint "$INGRESS_PLIST" >/dev/null
	launchctl bootout "system/$INGRESS_LABEL" 2>/dev/null || true
	launchctl bootout "system/$WRITER_LABEL" 2>/dev/null || true
	if ! launchctl bootstrap system "$WRITER_PLIST"; then
		die "writer bootstrap failed"
	fi
	if ! launchctl bootstrap system "$INGRESS_PLIST"; then
		launchctl bootout "system/$WRITER_LABEL" 2>/dev/null || true
		die "ingress bootstrap failed; writer rolled back"
	fi
	if ! launchctl print "system/$WRITER_LABEL" >/dev/null \
		|| ! launchctl print "system/$INGRESS_LABEL" >/dev/null; then
			launchctl bootout "system/$INGRESS_LABEL" 2>/dev/null || true
			launchctl bootout "system/$WRITER_LABEL" 2>/dev/null || true
			die "post-bootstrap verification failed; both services rolled back"
	fi
}

rollback_bundle() {
	require_live_authority
	launchctl bootout "system/$INGRESS_LABEL" 2>/dev/null || true
	launchctl bootout "system/$WRITER_LABEL" 2>/dev/null || true
	printf 'booted out %s then %s; credentials and identities were retained\n' \
		"$INGRESS_LABEL" "$WRITER_LABEL"
}

case "$COMMAND" in
	render)
		if [[ -z "$ROOT" ]]; then
			[[ "$ACK" == "FLY-2204-A-I-W" ]] \
				|| die "render live root requires --ack FLY-2204-A-I-W"
			require_live_authority
		fi
		render_bundle
		;;
	apply) apply_bundle ;;
	activate) activate_bundle ;;
	rollback) rollback_bundle ;;
esac
