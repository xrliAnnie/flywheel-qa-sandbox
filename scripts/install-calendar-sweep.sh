#!/usr/bin/env bash
# FLY-2137 — explicit operator install/uninstall for the report-only daily sweep.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_RAW="${FLYWHEEL_REPO:-$HOME/Dev/flywheel}"
TEMPLATE="$SCRIPT_DIR/com.flywheel.calendar-sweep.plist.template"
LABEL="com.flywheel.calendar-sweep"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
DEST="$LAUNCH_AGENTS/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/flywheel"
ACTION="${1:-install}"
RENDERED=""
DEST_TMP=""

log() { printf '[install-calendar-sweep] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }
cleanup() {
	[[ -z "$RENDERED" ]] || rm -f "$RENDERED" 2>/dev/null || true
	[[ -z "$DEST_TMP" ]] || rm -f "$DEST_TMP" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

[[ $# -le 1 ]] || die "usage: install-calendar-sweep.sh [install|uninstall]"
[[ "$ACTION" == install || "$ACTION" == uninstall ]] \
	|| die "usage: install-calendar-sweep.sh [install|uninstall]"
[[ "$HOME" == /* ]] || die "HOME must be absolute"

if [[ -n "${FLYWHEEL_CALENDAR_SWEEP_LAUNCHCTL:-}" ]]; then
	LAUNCHCTL="$FLYWHEEL_CALENDAR_SWEEP_LAUNCHCTL"
else
	LAUNCHCTL="$(command -v launchctl 2>/dev/null || true)"
fi
[[ -n "$LAUNCHCTL" && -x "$LAUNCHCTL" ]] || die "launchctl is unavailable"
DOMAIN="gui/$(id -u)"

if [[ "$ACTION" == uninstall ]]; then
	"$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
	if [[ -L "$DEST" ]]; then
		die "refusing to remove symlink plist: $DEST"
	fi
	if [[ -e "$DEST" && ! -f "$DEST" ]]; then
		die "plist destination is not a regular file: $DEST"
	fi
	rm -f "$DEST"
	log "uninstalled $LABEL"
	exit 0
fi

[[ "$REPO_RAW" == /* && -d "$REPO_RAW" && ! -L "$REPO_RAW" ]] \
	|| die "FLYWHEEL_REPO must be an absolute, non-symlink directory: $REPO_RAW"
REPO_ROOT="$(cd -P "$REPO_RAW" && pwd -P)"
[[ -f "$TEMPLATE" && ! -L "$TEMPLATE" ]] || die "missing or unsafe template: $TEMPLATE"
[[ -f "$REPO_ROOT/scripts/calendar-write-sweep.mjs" \
	&& ! -L "$REPO_ROOT/scripts/calendar-write-sweep.mjs" ]] \
	|| die "calendar sweep is missing or unsafe in $REPO_ROOT"
NODE_BIN="${FLYWHEEL_CALENDAR_SWEEP_NODE:-$(command -v node 2>/dev/null || true)}"
[[ "$NODE_BIN" == /* && -x "$NODE_BIN" ]] || die "node executable is unavailable: $NODE_BIN"

mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR"
[[ ! -L "$DEST" ]] || die "refusing to replace symlink plist: $DEST"
[[ ! -e "$DEST" || -f "$DEST" ]] || die "plist destination is not a regular file: $DEST"

escape_sed() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
escaped_repo="$(escape_sed "$REPO_ROOT")"
escaped_home="$(escape_sed "$HOME")"
escaped_node="$(escape_sed "$NODE_BIN")"
RENDERED="$(mktemp "${TMPDIR:-/tmp}/flywheel-calendar-sweep-plist.XXXXXX")" \
	|| die "cannot allocate plist staging file"
sed \
	-e "s|__REPO_ROOT__|$escaped_repo|g" \
	-e "s|__HOME__|$escaped_home|g" \
	-e "s|__NODE_BIN__|$escaped_node|g" \
	"$TEMPLATE" > "$RENDERED" || die "cannot render plist"
if grep -Eq '__[A-Z0-9_]+__' "$RENDERED"; then
	die "rendered plist contains unresolved placeholders"
fi
if command -v plutil >/dev/null 2>&1; then
	plutil -lint "$RENDERED" >/dev/null || die "rendered plist is invalid"
fi

DEST_TMP="$(mktemp "$DEST.tmp.XXXXXX")" || die "cannot stage destination plist"
cp "$RENDERED" "$DEST_TMP"
chmod 644 "$DEST_TMP"
mv -f "$DEST_TMP" "$DEST"
DEST_TMP=""
[[ -f "$DEST" && ! -L "$DEST" ]] || die "installed plist failed verification"

"$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
if ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$DEST" >/dev/null 2>&1; then
	"$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
	die "launchctl bootstrap failed for $LABEL"
fi
if ! "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
	"$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
	die "launchctl accepted bootstrap but $LABEL is not loaded"
fi
log "installed and verified $LABEL at $DEST"
