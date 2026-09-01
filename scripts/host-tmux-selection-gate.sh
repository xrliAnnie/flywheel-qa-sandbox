#!/bin/bash
# FLY-2190 S0: fail-closed proof that the PATH which S1 will install still
# selects the known Intel tmux 3.5a client. This gate ships and becomes live
# before S1, so a later wrapper birth cannot silently enter an unverified
# 3.7c-client/3.5a-server mixed state.
set -uo pipefail

die() {
  echo "host-tmux-selection-gate: $*" >&2
  exit 1
}

usage() {
  echo "Usage: host-tmux-selection-gate.sh {gate|verify} <carrier> | census <loaded-candidates.tsv>" >&2
  exit 2
}

file_mode() {
  local path="$1"
  if /usr/bin/stat -f '%Lp' "$path" >/dev/null 2>&1; then
    /usr/bin/stat -f '%Lp' "$path"
  else
    /usr/bin/stat -c '%a' "$path"
  fi
}

plist_program_arguments() {
  local plist="$1" json=""
  if [ -x /usr/bin/plutil ] \
    && json="$(/usr/bin/plutil -convert json -o - "$plist" 2>/dev/null)"; then
    printf '%s' "$json" | /usr/bin/jq -er \
      '.ProgramArguments
       | select(type == "array" and length > 0)
       | select(all(.[];
           type == "string"
           and length > 0
           and (contains("\n") | not)
           and (contains("\r") | not)))
       | .[]' 2>/dev/null
    return $?
  fi

  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$plist" <<'PY'
import plistlib
import sys

try:
    with open(sys.argv[1], "rb") as handle:
        data = plistlib.load(handle)
    arguments = data.get("ProgramArguments")
    if not isinstance(arguments, list) or not arguments:
        raise ValueError("invalid ProgramArguments")
    for argument in arguments:
        if not isinstance(argument, str) or not argument or "\n" in argument:
            raise ValueError("invalid ProgramArguments entry")
        print(argument)
except (OSError, ValueError, plistlib.InvalidFileException):
    raise SystemExit(1)
PY
}

run_census() {
  local candidates_file="$1"
  local test_mode="${FLYWHEEL_HOST_TMUX_GATE_TEST_MODE:-0}"
  local plist_dir="${FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR:-${HOME}/Library/LaunchAgents}"
  local source_dir="${FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR:-${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}/scripts}"
  local temp_root="" plist="" args_file="" argument="" selected=""
  local selected_count=0 basename="" source="" expected_carrier=""
  local total=0 generic=0 mufasa=0 infra=0 raya=0
  local key="" project="" lead_id="" manifest="" classification="" sources=""

  if [ "$test_mode" = "1" ]; then
    case "$plist_dir:$source_dir" in
      /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) : ;;
      *) die "census test mode requires temporary isolated roots" ;;
    esac
  else
    [ -z "${FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR:-}" ] \
      || die "FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR is test-only"
    [ -z "${FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR:-}" ] \
      || die "FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR is test-only"
  fi
  [ -d "$plist_dir" ] || die "Lead plist directory is missing: $plist_dir"
  [ -d "$source_dir" ] || die "registered carrier source directory is missing: $source_dir"
  [ -f "$candidates_file" ] && [ ! -L "$candidates_file" ] \
    || die "loaded candidate inventory is not a regular file: $candidates_file"

  temp_root="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/host-tmux-census.XXXXXX")" \
    || die "cannot allocate census scratch directory"
  trap '/bin/rm -rf "$temp_root"' EXIT

  while IFS=$'\t' read -r key project lead_id manifest classification sources; do
    [ -n "$key" ] || continue
    case ",$sources," in *,plist,*) ;; *) continue ;; esac
    case "$classification" in
      restart) : ;;
      skip-test|config-drift|probe-error|manifestless) continue ;;
      *) die "invalid loaded Lead classification for $key: $classification" ;;
    esac
    case "$key" in *[!A-Za-z0-9._-]*) die "invalid loaded Lead key: $key" ;; esac
    plist="$plist_dir/com.flywheel.lead.${key}.plist"
    [ -f "$plist" ] && [ ! -L "$plist" ] \
      || die "loaded Lead plist is not a regular file: $plist"
    total=$((total + 1))
    args_file="$temp_root/args.$total"
    plist_program_arguments "$plist" > "$args_file" \
      || die "cannot parse ProgramArguments: $plist"
    selected=""
    selected_count=0
    while IFS= read -r argument; do
      basename="${argument##*/}"
      case "$basename" in
        flywheel-lead-wrapper-v2.sh|\
        flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh|\
        flywheel-codex-lead-wrapper-codex-infra-bot.sh|\
        flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh)
          selected="$argument"
          selected_count=$((selected_count + 1))
          ;;
      esac
    done < "$args_file"
    [ "$selected_count" -eq 1 ] \
      || die "Lead plist must select exactly one registered carrier: $plist"
    case "$selected" in /*) : ;; *) die "selected carrier path is not absolute: $selected" ;; esac
    [ ! -L "$selected" ] && [ -f "$selected" ] \
      || die "deployed carrier is not a non-symlink regular file: $selected"

    basename="${selected##*/}"
    source="$source_dir/$basename"
    [ ! -L "$source" ] && [ -f "$source" ] \
      || die "registered carrier source is missing: $source"
    /usr/bin/cmp -s "$source" "$selected" \
      || die "deployed carrier bytes drift from registered source: $selected"

    case "$basename" in
      flywheel-lead-wrapper-v2.sh)
        expected_carrier=lead
        generic=$((generic + 1))
        ;;
      flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh)
        expected_carrier=codex-mufasa
        mufasa=$((mufasa + 1))
        ;;
      flywheel-codex-lead-wrapper-codex-infra-bot.sh)
        expected_carrier=codex-infra-bot
        infra=$((infra + 1))
        ;;
      flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh)
        expected_carrier=codex-raya
        raya=$((raya + 1))
        ;;
      *) die "unregistered Lead carrier: $selected" ;;
    esac
    /usr/bin/grep -Fq 'host-tmux-selection-gate.sh' "$selected" \
      || die "deployed carrier is missing the S0 gate mount: $selected"
    /usr/bin/grep -Fq "\"\$HOST_TMUX_GATE_BIN\" gate $expected_carrier" "$selected" \
      || die "deployed carrier is missing the S0 gate call: $selected"
    /usr/bin/grep -Fq "\"\$HOST_TMUX_GATE_BIN\" verify $expected_carrier" "$selected" \
      || die "deployed carrier is missing the S0 receipt verification: $selected"
  done < "$candidates_file"
  [ "$total" -gt 0 ] || die "no positively-loaded production Lead plists found"

  trap - EXIT
  /bin/rm -rf "$temp_root"
  echo "host-tmux-selection-gate: census pass plists=$total generic=$generic codex-mufasa=$mufasa codex-infra-bot=$infra codex-raya=$raya"
}

ACTION="${1:-}"
if [ "$ACTION" = "census" ]; then
  [ "$#" -eq 2 ] || usage
  run_census "$2"
  exit 0
fi
case "$ACTION" in gate|verify) : ;; *) usage ;; esac
CARRIER="${2:-}"
[ -n "$CARRIER" ] && [ "$#" -eq 2 ] || usage
case "$CARRIER" in *[!A-Za-z0-9._-]*) die "invalid carrier: $CARRIER" ;; esac

STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
TEST_MODE="${FLYWHEEL_HOST_TMUX_GATE_TEST_MODE:-0}"

# Test observations are deliberately unavailable on a production state root.
# Wrappers also sanitize this variable before invoking the gate, so a sourced
# .env cannot replace the production judgment with fixture data.
if [ "$TEST_MODE" = "1" ]; then
  case "$STATE_DIR" in
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) : ;;
    *) die "test mode requires a temporary isolated FLYWHEEL_STATE_DIR" ;;
  esac
else
  for name in \
    FLYWHEEL_HOST_TMUX_POST_S1_PATH \
    FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH \
    FLYWHEEL_HOST_TMUX_FILE_BIN \
    FLYWHEEL_HOST_TMUX_HOST_ID \
    FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH \
    FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS \
    FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY; do
    [ -z "${!name:-}" ] || die "$name is test-only"
  done
fi

if [ "$TEST_MODE" = "1" ]; then
  NOW_EPOCH="${FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH:-}"
else
  NOW_EPOCH="$(/bin/date +%s)" || die "cannot determine current epoch"
fi
case "$NOW_EPOCH" in *[!0-9]*) die "invalid gate clock" ;; esac

POST_S1_PATH="${FLYWHEEL_HOST_TMUX_POST_S1_PATH:-${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
EXPECTED_CANONICAL="${FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH:-/usr/local/Cellar/tmux/3.5a/bin/tmux}"
FILE_BIN="${FLYWHEEL_HOST_TMUX_FILE_BIN:-/usr/bin/file}"

# This repository also ships portable and already-native installations. S0 is
# required only on a host that has (or has previously recorded) the legacy
# Intel Homebrew tmux layout. The durable marker makes removal/drift fail
# closed after first activation, while clean Linux/native hosts remain outside
# this host-specific migration gate.
RECEIPT_DIR="$STATE_DIR/state/host-tmux"
REQUIRED_MARKER="$RECEIPT_DIR/required"
BREAK_GLASS_FILE="$RECEIPT_DIR/break-glass"
if [ -e "$BREAK_GLASS_FILE" ] || [ -L "$BREAK_GLASS_FILE" ]; then
  [ -n "$NOW_EPOCH" ] || die "test epoch required for break-glass authorization"
  [ -d "$RECEIPT_DIR" ] && [ ! -L "$RECEIPT_DIR" ] \
    || die "break-glass parent must be a non-symlink directory: $RECEIPT_DIR"
  [ -f "$REQUIRED_MARKER" ] && [ ! -L "$REQUIRED_MARKER" ] \
    || die "break-glass requires the durable host-gate marker: $REQUIRED_MARKER"
  [ -f "$BREAK_GLASS_FILE" ] && [ ! -L "$BREAK_GLASS_FILE" ] \
    || die "break-glass authorization must be a regular file: $BREAK_GLASS_FILE"
  [ -O "$BREAK_GLASS_FILE" ] \
    || die "break-glass authorization must be owned by the current user: $BREAK_GLASS_FILE"
  BREAK_GLASS_MODE="$(file_mode "$BREAK_GLASS_FILE" 2>/dev/null)" \
    || die "cannot inspect break-glass authorization mode: $BREAK_GLASS_FILE"
  [ "$BREAK_GLASS_MODE" = "600" ] \
    || die "break-glass authorization mode must be 600: $BREAK_GLASS_MODE"

  exec 9< "$BREAK_GLASS_FILE" \
    || die "cannot read break-glass authorization: $BREAK_GLASS_FILE"
  IFS= read -r BREAK_GLASS_DEADLINE_LINE <&9 \
    || die "break-glass authorization is missing disabledUntil"
  IFS= read -r BREAK_GLASS_REASON_LINE <&9 \
    || die "break-glass authorization is missing reason"
  if IFS= read -r BREAK_GLASS_EXTRA_LINE <&9; then
    exec 9<&-
    die "break-glass authorization must contain exactly two lines"
  fi
  exec 9<&-
  case "$BREAK_GLASS_DEADLINE_LINE" in
    disabledUntil=*) BREAK_GLASS_UNTIL="${BREAK_GLASS_DEADLINE_LINE#disabledUntil=}" ;;
    *) die "break-glass authorization has invalid disabledUntil" ;;
  esac
  case "$BREAK_GLASS_REASON_LINE" in
    reason=*) BREAK_GLASS_REASON="${BREAK_GLASS_REASON_LINE#reason=}" ;;
    *) die "break-glass authorization has invalid reason" ;;
  esac
  case "$BREAK_GLASS_UNTIL" in ''|*[!0-9]*) die "break-glass disabledUntil must be an epoch" ;; esac
  case "$BREAK_GLASS_REASON" in ''|*$'\r'*) die "break-glass reason must be one non-empty line" ;; esac
  [ "${#BREAK_GLASS_REASON}" -le 200 ] \
    || die "break-glass reason must be at most 200 characters"
  [ "$BREAK_GLASS_UNTIL" -gt "$NOW_EPOCH" ] \
    || die "break-glass authorization has expired: $BREAK_GLASS_UNTIL <= $NOW_EPOCH"
  [ "$BREAK_GLASS_UNTIL" -le "$((NOW_EPOCH + 900))" ] \
    || die "break-glass authorization exceeds the 900-second maximum"
  echo "host-tmux-selection-gate: BREAK-GLASS active carrier=$CARRIER until=$BREAK_GLASS_UNTIL authorization=$BREAK_GLASS_FILE" >&2
  exit 0
fi
if [ "$TEST_MODE" = "1" ]; then
  APPLICABILITY="${FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY:-required}"
else
  if [ -f "$REQUIRED_MARKER" ] && [ ! -L "$REQUIRED_MARKER" ]; then
    APPLICABILITY=required
  elif [ -f "$EXPECTED_CANONICAL" ] && [ -x "$EXPECTED_CANONICAL" ]; then
    [ ! -L "$RECEIPT_DIR" ] || die "receipt directory must not be a symlink: $RECEIPT_DIR"
    /bin/mkdir -p "$RECEIPT_DIR" || die "cannot create receipt directory: $RECEIPT_DIR"
    [ -d "$RECEIPT_DIR" ] && [ ! -L "$RECEIPT_DIR" ] \
      || die "receipt directory must be a non-symlink directory: $RECEIPT_DIR"
    /bin/chmod 700 "$RECEIPT_DIR" || die "cannot protect receipt directory: $RECEIPT_DIR"
    MARKER_TMP="$(/usr/bin/mktemp "${REQUIRED_MARKER}.tmp.XXXXXX")" \
      || die "cannot allocate applicability marker"
    trap '/bin/rm -f "$MARKER_TMP"' EXIT
    printf '%s\n' "$EXPECTED_CANONICAL" > "$MARKER_TMP" \
      || die "cannot write applicability marker"
    /bin/chmod 600 "$MARKER_TMP" || die "cannot protect applicability marker"
    /bin/mv -f "$MARKER_TMP" "$REQUIRED_MARKER" \
      || die "cannot publish applicability marker"
    trap - EXIT
    APPLICABILITY=required
  else
    APPLICABILITY=not-applicable
  fi
fi
case "$APPLICABILITY" in
  required) : ;;
  not-applicable)
    echo "host-tmux-selection-gate: not applicable carrier=$CARRIER legacy_tmux=$EXPECTED_CANONICAL"
    exit 0
    ;;
  *) die "invalid gate applicability: $APPLICABILITY" ;;
esac
[ -n "$NOW_EPOCH" ] || die "test epoch required for host-gate receipt"

SELECTED_PATH="$(PATH="$POST_S1_PATH" command -v tmux 2>/dev/null)" \
  || die "post-S1 PATH does not resolve tmux"
[ -n "$SELECTED_PATH" ] || die "post-S1 PATH resolved an empty tmux path"
CANONICAL_PATH="$(/usr/bin/readlink -f "$SELECTED_PATH" 2>/dev/null)" \
  || die "cannot canonicalize selected tmux: $SELECTED_PATH"
[ "$CANONICAL_PATH" = "$EXPECTED_CANONICAL" ] \
  || die "post-S1 PATH selected unexpected tmux: $SELECTED_PATH -> $CANONICAL_PATH"
[ -f "$CANONICAL_PATH" ] && [ -x "$CANONICAL_PATH" ] \
  || die "selected tmux is not an executable regular file: $CANONICAL_PATH"

TMUX_VERSION="$("$CANONICAL_PATH" -V 2>/dev/null)" \
  || die "selected tmux version probe failed: $CANONICAL_PATH"
[ "$TMUX_VERSION" = "tmux 3.5a" ] \
  || die "selected tmux version is not tmux 3.5a: $TMUX_VERSION"
ARCHITECTURE="$(PATH="$POST_S1_PATH" "$FILE_BIN" "$CANONICAL_PATH" 2>/dev/null)" \
  || die "selected tmux architecture probe failed: $CANONICAL_PATH"
case "$ARCHITECTURE" in
  *x86_64*|*x86-64*) : ;;
  *) die "selected tmux is not x86_64: $ARCHITECTURE" ;;
esac
case "$ARCHITECTURE" in
  *arm64*) die "selected tmux unexpectedly contains arm64: $ARCHITECTURE" ;;
esac

if [ "$TEST_MODE" = "1" ]; then
  HOST_ID="${FLYWHEEL_HOST_TMUX_HOST_ID:?test host id required}"
  TTL_SECONDS="${FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS:-300}"
else
  HOST_ID="$(/usr/sbin/scutil --get LocalHostName 2>/dev/null || /bin/hostname -s 2>/dev/null)"
  TTL_SECONDS=300
fi
case "$NOW_EPOCH:$TTL_SECONDS" in *[!0-9:]*) die "invalid receipt clock" ;; esac
[ -n "$HOST_ID" ] || die "cannot determine host id"
[ "$TTL_SECONDS" -gt 0 ] && [ "$TTL_SECONDS" -le 900 ] \
  || die "receipt TTL must be between 1 and 900 seconds"
EXPIRES_AT=$((NOW_EPOCH + TTL_SECONDS))

TARGET_SHA="${FLYWHEEL_HOST_TMUX_TARGET_SHA:-}"
[ "${#TARGET_SHA}" -eq 40 ] \
  || die "FLYWHEEL_HOST_TMUX_TARGET_SHA must contain 40 hex characters"
case "$TARGET_SHA" in
  *[!0-9a-fA-F]*) die "FLYWHEEL_HOST_TMUX_TARGET_SHA must contain 40 hex characters" ;;
esac
BOUND_TRANSACTION="${FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION:-keepalive:${CARRIER}}"
MOUNT_POINT="${FLYWHEEL_HOST_TMUX_MOUNT_POINT:-unknown}"
[ -n "$BOUND_TRANSACTION" ] || die "bound transaction is required"
[ "$MOUNT_POINT" != "unknown" ] && [ -n "$MOUNT_POINT" ] || die "mount point is required"

RECEIPT="$RECEIPT_DIR/$CARRIER.json"
if [ -L "$RECEIPT" ] || { [ -e "$RECEIPT" ] && [ ! -f "$RECEIPT" ]; }; then
  die "receipt path must be a regular file: $RECEIPT"
fi

if [ "$ACTION" = "verify" ]; then
  [ -f "$RECEIPT" ] || die "selection receipt is missing: $RECEIPT"
  RECEIPT_HOST="$(/usr/bin/jq -er \
    '.hostId | select(type == "string" and length > 0)' "$RECEIPT" 2>/dev/null)" \
    || die "selection receipt is invalid: $RECEIPT"
  [ "$RECEIPT_HOST" = "$HOST_ID" ] \
    || die "receipt host does not match current host: $RECEIPT_HOST != $HOST_ID"
  RECEIPT_EXPIRES_AT="$(/usr/bin/jq -er \
    '.expiresAt | select(type == "number" and floor == .)' "$RECEIPT" 2>/dev/null)" \
    || die "selection receipt expiry is invalid: $RECEIPT"
  [ "$NOW_EPOCH" -lt "$RECEIPT_EXPIRES_AT" ] \
    || die "selection receipt has expired: $RECEIPT_EXPIRES_AT <= $NOW_EPOCH"
  RECEIPT_TARGET_SHA="$(/usr/bin/jq -er \
    '.targetSha | select(type == "string" and length == 40)' "$RECEIPT" 2>/dev/null)" \
    || die "selection receipt target SHA is invalid: $RECEIPT"
  [ "$RECEIPT_TARGET_SHA" = "$TARGET_SHA" ] \
    || die "receipt target SHA does not match deployed SHA: $RECEIPT_TARGET_SHA != $TARGET_SHA"
  /usr/bin/jq -e \
    --arg hostId "$HOST_ID" \
    --arg targetSha "$TARGET_SHA" \
    --arg selectedPath "$SELECTED_PATH" \
    --arg canonicalPath "$CANONICAL_PATH" \
    --arg tmuxVersion "$TMUX_VERSION" \
    --arg architecture "$ARCHITECTURE" \
    --arg boundTransaction "$BOUND_TRANSACTION" \
    --arg carrier "$CARRIER" \
    --arg mountPoint "$MOUNT_POINT" \
    --argjson now "$NOW_EPOCH" \
    'type == "object"
      and .schemaVersion == 1
      and .hostId == $hostId
      and .targetSha == $targetSha
      and (.generatedAt | type == "number" and floor == .)
      and (.expiresAt | type == "number" and floor == .)
      and .generatedAt <= $now
      and .expiresAt > $now
      and .expiresAt > .generatedAt
      and (.expiresAt - .generatedAt) <= 900
      and .selectedPath == $selectedPath
      and .canonicalPath == $canonicalPath
      and .tmuxVersion == $tmuxVersion
      and .architecture == $architecture
      and .verdict == "pass"
      and .boundTransaction == $boundTransaction
      and .carrier == $carrier
      and .mountPoint == $mountPoint' \
    "$RECEIPT" >/dev/null 2>&1 \
    || die "selection receipt payload does not match the current probe: $RECEIPT"
  echo "host-tmux-selection-gate: verified carrier=$CARRIER host=$HOST_ID"
  exit 0
fi

umask 077
/bin/mkdir -p "${STATE_DIR}/state" || die "cannot create state directory: ${STATE_DIR}/state"
[ ! -L "$RECEIPT_DIR" ] || die "receipt directory must not be a symlink: $RECEIPT_DIR"
/bin/mkdir -p "$RECEIPT_DIR" || die "cannot create receipt directory: $RECEIPT_DIR"
[ -d "$RECEIPT_DIR" ] && [ ! -L "$RECEIPT_DIR" ] \
  || die "receipt directory must be a non-symlink directory: $RECEIPT_DIR"
/bin/chmod 700 "$RECEIPT_DIR" || die "cannot protect receipt directory: $RECEIPT_DIR"
TMP_RECEIPT="$(/usr/bin/mktemp "${RECEIPT}.tmp.XXXXXX")" \
  || die "cannot allocate receipt temp file"
trap '/bin/rm -f "$TMP_RECEIPT"' EXIT

/usr/bin/jq -n \
  --arg hostId "$HOST_ID" \
  --arg targetSha "$TARGET_SHA" \
  --arg boundTransaction "$BOUND_TRANSACTION" \
  --arg selectedPath "$SELECTED_PATH" \
  --arg canonicalPath "$CANONICAL_PATH" \
  --arg tmuxVersion "$TMUX_VERSION" \
  --arg architecture "$ARCHITECTURE" \
  --arg carrier "$CARRIER" \
  --arg mountPoint "$MOUNT_POINT" \
  --argjson generatedAt "$NOW_EPOCH" \
  --argjson expiresAt "$EXPIRES_AT" \
  '{schemaVersion: 1, hostId: $hostId, targetSha: $targetSha,
    generatedAt: $generatedAt, expiresAt: $expiresAt,
    boundTransaction: $boundTransaction, selectedPath: $selectedPath,
    canonicalPath: $canonicalPath, tmuxVersion: $tmuxVersion,
    architecture: $architecture, verdict: "pass", carrier: $carrier,
    mountPoint: $mountPoint}' > "$TMP_RECEIPT" \
  || die "cannot serialize selection receipt"
/bin/chmod 600 "$TMP_RECEIPT" || die "cannot protect selection receipt"
/bin/mv -f "$TMP_RECEIPT" "$RECEIPT" || die "cannot publish selection receipt"
trap - EXIT

echo "host-tmux-selection-gate: pass carrier=$CARRIER selected=$SELECTED_PATH canonical=$CANONICAL_PATH version=$TMUX_VERSION"
exit 0
