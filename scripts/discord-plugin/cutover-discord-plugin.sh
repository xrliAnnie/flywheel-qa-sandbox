#!/bin/bash
# FLY-1676: one-shot, no-flag Discord pointer cutover / reverse transaction.
#
# This is a deployment-window artifact. It changes no persistent mode flag:
# `apply` and `rollback` are explicit one-shot operator actions. Both hold the
# existing restart.lock.d, unload Bridge + every production Lead authority,
# prove zero Lead/Discord runtime, mutate, pass a consistency gate, and only
# then bootstrap Bridge followed by the exact original Lead census.
set -uo pipefail

MODE="${1:-}"
shift || true
TARGET_SHA=""
KNOWN_GOOD_SHA=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-sha) TARGET_SHA="${2:?--target-sha requires a value}"; shift 2 ;;
    --known-good-sha) KNOWN_GOOD_SHA="${2:?--known-good-sha requires a value}"; shift 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in apply|rollback) ;; *) echo "Usage: cutover-discord-plugin.sh apply|rollback --target-sha <sha> --known-good-sha <sha>" >&2; exit 2 ;; esac
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: invalid target SHA" >&2; exit 2; }
[[ "$KNOWN_GOOD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: invalid known-good SHA" >&2; exit 2; }
[[ "${FLYWHEEL_DISCORD_CUTOVER_AUTHORIZED:-0}" == 1 ]] || {
  echo "ERROR: FLYWHEEL_DISCORD_CUTOVER_AUTHORIZED=1 is required for this exact window" >&2
  exit 1
}

REPO="${FLYWHEEL_DISCORD_CUTOVER_REPO:-${HOME}/Dev/flywheel}"
LOCK_DIR="${FLYWHEEL_DISCORD_CUTOVER_LOCK_DIR:-${HOME}/.flywheel/restart.lock.d}"
STATE_DIR="${FLYWHEEL_DISCORD_CUTOVER_STATE_DIR:-${HOME}/.flywheel/discord-plugin-cutover}"
LAUNCHD_DIR="${FLYWHEEL_LAUNCHD_DIR:-${HOME}/Library/LaunchAgents}"
SETTINGS="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/settings.json"
LAUNCHCTL="${FLYWHEEL_DISCORD_CUTOVER_LAUNCHCTL:-launchctl}"
CLAUDE_BIN="${FLYWHEEL_DISCORD_CUTOVER_CLAUDE:-claude}"
INSTALLER="${FLYWHEEL_DISCORD_CUTOVER_INSTALLER:-${REPO}/scripts/install-discord-plugin-ops.sh}"
CHECKER="${HOME}/.flywheel/bin/check-discord-plugin.sh"
ALERT_BIN="${FLYWHEEL_DISCORD_CUTOVER_ALERT:-${REPO}/scripts/lead-alert.sh}"
GUI="gui/$(id -u)"
BRIDGE_LABEL="com.flywheel.bridge"
LEAD_LABELS_FILE="${STATE_DIR}/lead-labels.txt"
CLAUDE_LABELS_FILE="${STATE_DIR}/claude-lead-labels.txt"
CLAUDE_LEAD_IDS_FILE="${STATE_DIR}/claude-lead-ids.txt"
EVENTS_FILE="${STATE_DIR}/evidence.log"
BIN_BACKUP_DIR="${STATE_DIR}/legacy-bin"
BIN_BACKUP_MANIFEST="${STATE_DIR}/legacy-bin-present.txt"
SETTINGS_BACKUP="${STATE_DIR}/settings.before.json"
LOCK_OWNED=0

if [ "${FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS:-0}" != 1 ]; then
  for seam in \
    FLYWHEEL_DISCORD_CUTOVER_LAUNCHCTL \
    FLYWHEEL_DISCORD_CUTOVER_DEPLOY_CMD \
    FLYWHEEL_DISCORD_CUTOVER_BUILD_CMD \
    FLYWHEEL_DISCORD_CUTOVER_INSTALLER \
    FLYWHEEL_DISCORD_CUTOVER_CLAUDE \
    FLYWHEEL_DISCORD_CUTOVER_CENSUS_CMD \
    FLYWHEEL_DISCORD_CUTOVER_HEALTH_CMD \
    FLYWHEEL_DISCORD_CUTOVER_PREFLIGHT_CMD \
    FLYWHEEL_DISCORD_CUTOVER_ROOT_PROOF_CMD \
    FLYWHEEL_DISCORD_CUTOVER_ALERT \
    FLYWHEEL_DISCORD_CUTOVER_FAIL_AT \
    FLYWHEEL_DISCORD_CUTOVER_LOCK_DIR \
    FLYWHEEL_DISCORD_CUTOVER_STATE_DIR \
    FLYWHEEL_LAUNCHD_DIR; do
    seam_value="$(printenv "$seam" 2>/dev/null || true)"
    [ -z "$seam_value" ] || {
      echo "ERROR: ${seam} is a hermetic-test seam; set FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS=1 only in tests" >&2
      exit 2
    }
  done
fi

log() {
  local line
  line="[$(date '+%Y-%m-%d %H:%M:%S')] [discord-cutover:${MODE}] $*"
  printf '%s\n' "$line" >&2
  [ -d "$STATE_DIR" ] && printf '%s\n' "$line" >> "$EVENTS_FILE"
}

alert_failure() {
  local phase="$1" body="$2"
  if [ -x "$ALERT_BIN" ]; then
    if ! "$ALERT_BIN" --project flywheel --lead deploy \
      --kind discord_plugin_integrity_failed --severity severe \
      --title "Discord plugin cutover failed" --body "$body" \
      --signature "cutover-${phase}-$(date -u +%Y%m%d%H%M)" 1>&2; then
      log "ERROR: Discord cutover alert delivery returned non-zero"
    fi
  else
    log "ERROR: Discord cutover alert emitter is missing: $ALERT_BIN"
  fi
}

release_lock() {
  if [ "$LOCK_OWNED" -eq 1 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || {
      log "ERROR: failed to release restart lock: $LOCK_DIR"
      return 1
    }
    LOCK_OWNED=0
  fi
}
trap 'release_lock >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

failpoint() {
  [ "${FLYWHEEL_DISCORD_CUTOVER_FAIL_AT:-}" != "$1" ] || {
    log "ERROR: injected failure after $1"
    return 1
  }
}

launch_state() {
  local label="$1" output rc=0
  output="$($LAUNCHCTL print "$GUI/$label" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'loaded\n'
  elif printf '%s' "$output" | grep -Eqi 'not found|could not find|no such'; then
    printf 'unloaded\n'
  else
    # The hermetic launchctl returns a plain rc=1 for an unloaded service.
    [ "${FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS:-0}" = 1 ] \
      && { printf 'unloaded\n'; return; }
    log "ERROR: launchctl state unreadable for $label: $output"
    return 1
  fi
}

assert_deployed_repo() {
  local bridge_plist="${LAUNCHD_DIR}/${BRIDGE_LABEL}.plist" resolved=""
  [ -f "$bridge_plist" ] || { log "ERROR: Bridge plist missing: $bridge_plist"; return 1; }
  resolved="$(python3 - "$bridge_plist" <<'PY'
import os
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    data = plistlib.load(handle)
args = data.get("ProgramArguments")
if not isinstance(args, list) or len(args) < 2:
    raise SystemExit("Bridge plist has no executable argument")
wrapper = args[1]
if not isinstance(wrapper, str) or os.path.basename(wrapper) != "flywheel-bridge-wrapper.sh":
    raise SystemExit("Bridge plist does not target flywheel-bridge-wrapper.sh")
print(os.path.realpath(os.path.join(os.path.dirname(wrapper), "..")))
PY
)" || { log "ERROR: could not resolve deployed checkout from Bridge plist"; return 1; }
  [ "$(cd "$REPO" 2>/dev/null && pwd -P)" = "$resolved" ] || {
    log "ERROR: cutover repo is not the checkout used by Bridge: repo=$REPO deployed=$resolved"
    return 1
  }
}

inventory_leads() {
  local manifest project lead backend label plist state
  local manifest_file="${STATE_DIR}/manifest-labels.txt" plist_file="${STATE_DIR}/plist-labels.txt"
  local claude_candidates="${STATE_DIR}/claude-candidates.txt" \
    claude_candidate_map="${STATE_DIR}/claude-candidate-map.txt" \
    union_file="${STATE_DIR}/candidate-labels.txt"
  : > "$manifest_file" || return 1
  : > "$plist_file" || return 1
  : > "$claude_candidates" || return 1
  : > "$claude_candidate_map" || return 1
  : > "$LEAD_LABELS_FILE" || return 1
  : > "$CLAUDE_LABELS_FILE" || return 1
  : > "$CLAUDE_LEAD_IDS_FILE" || return 1
  shopt -s nullglob
  for manifest in "${HOME}/.flywheel/manifests/"*.json; do
    project="$(jq -er '.projectName | select(type == "string" and length > 0)' "$manifest")" || return 1
    lead="$(jq -er '.leadId | select(type == "string" and length > 0)' "$manifest")" || return 1
    case "$lead" in flywheel-test-*) continue ;; esac
    label="com.flywheel.lead.${project}-${lead}"
    printf '%s\n' "$label" >> "$manifest_file" || return 1
    backend="$(jq -r '.leadBackend.backendId // empty' "$manifest")" || return 1
    if [ "$backend" = claude-code ]; then
      printf '%s\n' "$label" >> "$claude_candidates" || return 1
      printf '%s|%s\n' "$label" "$lead" >> "$claude_candidate_map" || return 1
    fi
  done
  for plist in "${LAUNCHD_DIR}/"com.flywheel.lead.*.plist; do
    label="$(basename "$plist" .plist)"
    case "$label" in *flywheel-test-*|*.test-slot-*) continue ;; esac
    printf '%s\n' "$label" >> "$plist_file" || return 1
  done
  shopt -u nullglob
  LC_ALL=C sort -u -o "$manifest_file" "$manifest_file" || return 1
  LC_ALL=C sort -u -o "$plist_file" "$plist_file" || return 1
  LC_ALL=C sort -u -o "$claude_candidates" "$claude_candidates" || return 1
  LC_ALL=C sort -u "$manifest_file" "$plist_file" > "$union_file" || return 1
  [ -s "$union_file" ] || { log "ERROR: no production Lead authorities found"; return 1; }
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    state="$(launch_state "$label")" || return 1
    [ "$state" = loaded ] || continue
    plist="${LAUNCHD_DIR}/${label}.plist"
    [ -f "$plist" ] || {
      log "ERROR: loaded Lead has no plist for deterministic restore: $label"
      return 1
    }
    printf '%s\n' "$label" >> "$LEAD_LABELS_FILE" || return 1
    if grep -Fxq "$label" "$claude_candidates"; then
      printf '%s\n' "$label" >> "$CLAUDE_LABELS_FILE" || return 1
      lead="$(awk -F '|' -v label="$label" '$1 == label { print $2; exit }' "$claude_candidate_map")"
      [ -n "$lead" ] || return 1
      printf '%s\n' "$lead" >> "$CLAUDE_LEAD_IDS_FILE" || return 1
    fi
  done < "$union_file"
  [ -s "$LEAD_LABELS_FILE" ] || { log "ERROR: no loaded production Lead authorities found"; return 1; }
  [ "$(launch_state "$BRIDGE_LABEL")" = loaded ] || {
    log "ERROR: Bridge is not loaded before the window"
    return 1
  }
}

bootstrap_if_unloaded() {
  local label="$1" plist
  plist="${LAUNCHD_DIR}/${label}.plist"
  [ -f "$plist" ] || { log "ERROR: plist missing for $label"; return 1; }
  if [ "$(launch_state "$label")" = unloaded ]; then
    "$LAUNCHCTL" bootstrap "$GUI" "$plist" || return 1
  fi
  [ "$(launch_state "$label")" = loaded ]
}

restore_authorities() {
  local label rc=0
  bootstrap_if_unloaded "$BRIDGE_LABEL" || rc=1
  if [ -f "$LEAD_LABELS_FILE" ]; then
    while IFS= read -r label; do
      [ -n "$label" ] || continue
      bootstrap_if_unloaded "$label" || rc=1
    done < "$LEAD_LABELS_FILE"
  fi
  return "$rc"
}

stop_authorities() {
  local label
  if [ "$(launch_state "$BRIDGE_LABEL")" = loaded ]; then
    "$LAUNCHCTL" bootout "$GUI/$BRIDGE_LABEL" || return 1
  fi
  [ "$(launch_state "$BRIDGE_LABEL")" = unloaded ] || return 1
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    if [ "$(launch_state "$label")" = loaded ]; then
      "$LAUNCHCTL" bootout "$GUI/$label" || return 1
    fi
    [ "$(launch_state "$label")" = unloaded ] || return 1
  done < "$LEAD_LABELS_FILE"
}

command_has_loaded_claude_lead() {
  local command="$1" lead
  [ -f "$CLAUDE_LEAD_IDS_FILE" ] || return 1
  while IFS= read -r lead; do
    [ -n "$lead" ] || continue
    case " $command " in
      *" --agent $lead "*|*" --agent=$lead "*|*"claude-lead.sh $lead "*) return 0 ;;
    esac
  done < "$CLAUDE_LEAD_IDS_FILE"
  return 1
}

is_discord_adapter_command() {
  local command="$1"
  [[ "$command" == *plugins/cache*discord*server.ts* \
    || "$command" == *plugins/marketplaces*discord*server.ts* ]]
}

parent_command_from_snapshot() {
  local snapshot="$1" wanted="$2" pid ppid command
  while read -r pid ppid command; do
    if [ "$pid" = "$wanted" ]; then
      printf '%s\n' "$command"
      return 0
    fi
  done <<< "$snapshot"
  return 1
}

discord_adapter_census_from_snapshot() {
  local snapshot="$1" pid ppid command parent_command=""
  while read -r pid ppid command; do
    is_discord_adapter_command "$command" || continue
    # A ppid=1 adapter is an orphan and is always unsafe during the transition.
    # Otherwise count only adapters whose direct Claude parent is one of the
    # exact loaded production Lead ids. Runner (`--agent-id`), interactive,
    # reviewer, and QA (`--agent flywheel-test-*`) adapters remain out of scope.
    if [ "$ppid" = 1 ]; then
      printf '%s %s %s\n' "$pid" "$ppid" "$command"
      continue
    fi
    parent_command="$(parent_command_from_snapshot "$snapshot" "$ppid" || true)"
    if [ -n "$parent_command" ] && command_has_loaded_claude_lead "$parent_command"; then
      printf '%s %s %s\n' "$pid" "$ppid" "$command"
    fi
  done <<< "$snapshot"
}

runtime_census() {
  if [ -n "${FLYWHEEL_DISCORD_CUTOVER_CENSUS_CMD:-}" ]; then
    "$FLYWHEEL_DISCORD_CUTOVER_CENSUS_CMD"
    return
  fi
  local pid ppid command snapshot=""
  snapshot="$(ps axww -o pid= -o ppid= -o command= 2>/dev/null)" || {
    log "ERROR: production runtime census sensor failed"
    return 1
  }
  while read -r pid ppid command; do
    if command_has_loaded_claude_lead "$command"; then
      printf '%s %s %s\n' "$pid" "$ppid" "$command"
    fi
  done <<< "$snapshot"
  discord_adapter_census_from_snapshot "$snapshot"
}

discord_adapter_census() {
  local snapshot=""
  snapshot="$(ps axww -o pid= -o ppid= -o command= 2>/dev/null)" || {
    log "ERROR: Discord adapter census sensor failed"
    return 1
  }
  discord_adapter_census_from_snapshot "$snapshot"
}

assert_quiet_twice() {
  local pass output
  for pass in 1 2; do
    output="$(runtime_census)" || { log "ERROR: runtime census failed"; return 1; }
    [ -z "$output" ] || {
      log "ERROR: runtime survived quiet proof $pass: $output"
      return 1
    }
  done
}

snapshot_legacy() {
  local script
  [ -f "$SETTINGS" ] && [ ! -L "$SETTINGS" ] || return 1
  mkdir -p "$BIN_BACKUP_DIR" || return 1
  cp "$SETTINGS" "$SETTINGS_BACKUP" || return 1
  : > "$BIN_BACKUP_MANIFEST" || return 1
  for script in check-discord-plugin.sh update-discord-plugin.sh; do
    [ -x "${HOME}/.flywheel/bin/$script" ] || return 1
  done
  "${HOME}/.flywheel/bin/check-discord-plugin.sh" >/dev/null || {
    log "ERROR: active legacy Discord overlay failed its read-only preflight"
    return 1
  }
  for script in check-discord-plugin.sh update-discord-plugin.sh \
    check-discord-plugin-legacy-overlay.sh update-discord-plugin-legacy-overlay.sh; do
    if [ -e "${HOME}/.flywheel/bin/$script" ]; then
      [ -f "${HOME}/.flywheel/bin/$script" ] && [ ! -L "${HOME}/.flywheel/bin/$script" ] || return 1
      cp "${HOME}/.flywheel/bin/$script" "$BIN_BACKUP_DIR/$script" || return 1
      printf '%s\n' "$script" >> "$BIN_BACKUP_MANIFEST" || return 1
    fi
  done
  printf '%s\n' "$TARGET_SHA" > "${STATE_DIR}/target.sha" || return 1
  printf '%s\n' "$KNOWN_GOOD_SHA" > "${STATE_DIR}/known-good.sha" || return 1
}

deploy_sha() {
  local sha="$1"
  if [ -n "${FLYWHEEL_DISCORD_CUTOVER_DEPLOY_CMD:-}" ]; then
    "$FLYWHEEL_DISCORD_CUTOVER_DEPLOY_CMD" "$sha"
    return
  fi
  [ -z "$(git -C "$REPO" status --porcelain)" ] || {
    log "ERROR: deployed checkout is dirty; refusing destructive transition"
    return 1
  }
  [ "$(git -C "$REPO" symbolic-ref --short HEAD)" = main ] || {
    log "ERROR: deployed checkout must be on main"
    return 1
  }
  git -C "$REPO" cat-file -e "${sha}^{commit}" || return 1
  if [ "$sha" = "$TARGET_SHA" ]; then
    [ "$(git -C "$REPO" rev-parse HEAD)" = "$KNOWN_GOOD_SHA" ] || return 1
    git -C "$REPO" merge-base --is-ancestor "$KNOWN_GOOD_SHA" "$TARGET_SHA" || return 1
    git -C "$REPO" merge --ff-only "$TARGET_SHA" || return 1
  else
    git -C "$REPO" reset --hard "$sha" || return 1
  fi
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$sha" ]
}

build_repo() {
  if [ -n "${FLYWHEEL_DISCORD_CUTOVER_BUILD_CMD:-}" ]; then
    "$FLYWHEEL_DISCORD_CUTOVER_BUILD_CMD"
  else
    pnpm -C "$REPO" install --frozen-lockfile && pnpm -C "$REPO" -r build
  fi
}

set_selection() {
  local selection="$1"
  python3 - "$SETTINGS" "$selection" <<'PY'
import json
import os
import sys
import tempfile

path, selection = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
enabled = data.setdefault("enabledPlugins", {})
enabled["discord@claude-plugins-official"] = selection == "legacy"
enabled["discord@flywheel-plugins"] = selection == "pointer"
fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".settings.")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

pointer_launcher_contract() {
  local launcher_text="$1"
  grep -Fq 'CLAUDE_ARGS+=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins")' \
    <<< "$launcher_text" || return 1
  # FLY-1679 is a hard cutover dependency: without its v2 call site, a cold
  # Lead parks on the development-channel confirmation dialog and looks healthy
  # to launchd while Discord inbound remains unavailable.
  grep -Fq '_poll_dev_channels_dialog_v2 "$FLYWHEEL_DIALOG_TIMEOUT_SEC" &' \
    <<< "$launcher_text" || return 1
  # Every Lead now loads Discord as a development channel. The FLY-1679 poller
  # must therefore be unconditional; its pre-FLY-1676 inbox-only guard leaves
  # companion and external Leads parked at Claude's confirmation prompt.
  if awk '
    function opens_if(line) {
      return line ~ /^[[:space:]]*if[[:space:]].*[[:space:]]then[[:space:]]*$/
    }
    guard_depth > 0 {
      if (index($0, "_poll_dev_channels_dialog_v2")) found = 1
      if (opens_if($0)) guard_depth++
      if ($0 ~ /^[[:space:]]*fi[[:space:]]*$/) guard_depth--
      next
    }
    opens_if($0) && index($0, "INBOX_MCP_ENABLED") { guard_depth = 1 }
    END { exit found ? 0 : 1 }
  ' <<< "$launcher_text"; then
    return 1
  fi
}

preflight_target() {
  local launcher_text=""
  if [ -n "${FLYWHEEL_DISCORD_CUTOVER_PREFLIGHT_CMD:-}" ]; then
    "$FLYWHEEL_DISCORD_CUTOVER_PREFLIGHT_CMD" --target-sha "$TARGET_SHA" >/dev/null
    return
  fi
  launcher_text="$(git -C "$REPO" show \
    "${TARGET_SHA}:packages/teamlead/scripts/claude-lead.sh" 2>/dev/null)" || {
    log "ERROR: target launcher is unreadable at $TARGET_SHA"
    return 1
  }
  pointer_launcher_contract "$launcher_text" || {
    log "ERROR: target launcher lacks the safe Discord development-channel contract"
    return 1
  }
}

preflight_pointer() {
  if [ -n "${FLYWHEEL_DISCORD_CUTOVER_PREFLIGHT_CMD:-}" ]; then
    "$FLYWHEEL_DISCORD_CUTOVER_PREFLIGHT_CMD"
    return
  fi
  local script live source install_path launcher launcher_text
  for script in check-discord-plugin.sh update-discord-plugin.sh \
    check-discord-plugin-legacy-overlay.sh update-discord-plugin-legacy-overlay.sh; do
    live="${HOME}/.flywheel/bin/$script"
    source="${REPO}/scripts/discord-plugin/$script"
    [ -x "$live" ] && cmp -s "$source" "$live" || return 1
  done
  launcher="${REPO}/packages/teamlead/scripts/claude-lead.sh"
  launcher_text="$(< "$launcher")" || return 1
  pointer_launcher_contract "$launcher_text" || return 1
  jq -e '.enabledPlugins["discord@claude-plugins-official"] == false and .enabledPlugins["discord@flywheel-plugins"] == true' \
    "$SETTINGS" >/dev/null || return 1
  install_path="$($CHECKER --print-install-path)" || return 1
  printf '%s\n' "$install_path"
}

wait_bridge_health() {
  local _try
  for _try in $(seq 1 60); do
    if [ -n "${FLYWHEEL_DISCORD_CUTOVER_HEALTH_CMD:-}" ]; then
      "$FLYWHEEL_DISCORD_CUTOVER_HEALTH_CMD" && return 0
    elif curl -fsS --max-time 2 http://127.0.0.1:9876/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_pointer_fleet() {
  local install_path="$1" label expected=0 attempt=1 rows matching total
  bootstrap_if_unloaded "$BRIDGE_LABEL" || return 1
  wait_bridge_health || return 1
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    bootstrap_if_unloaded "$label" || return 1
  done < "$LEAD_LABELS_FILE"
  expected="$(awk 'NF { n++ } END { print n+0 }' "$CLAUDE_LABELS_FILE")"
  if [ -n "${FLYWHEEL_DISCORD_CUTOVER_ROOT_PROOF_CMD:-}" ]; then
    "$FLYWHEEL_DISCORD_CUTOVER_ROOT_PROOF_CMD" "$install_path" "$expected"
    return
  fi
  while [ "$attempt" -le 120 ]; do
    rows="$(discord_adapter_census)" || return 1
    total="$(printf '%s\n' "$rows" | awk 'NF { n++ } END { print n+0 }')"
    matching="$(printf '%s\n' "$rows" | grep -F "${install_path}/server.ts" | awk 'NF { n++ } END { print n+0 }')"
    if [ "$total" -eq "$expected" ] && [ "$matching" -eq "$expected" ]; then
      log "pointer root proof passed: ${matching}/${expected} Claude adapters"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  log "ERROR: pointer root proof timed out: matching=${matching:-0} total=${total:-0} expected=${expected}"
  return 1
}

restore_legacy_bytes() {
  local script
  for script in check-discord-plugin.sh update-discord-plugin.sh \
    check-discord-plugin-legacy-overlay.sh update-discord-plugin-legacy-overlay.sh; do
    if grep -Fxq "$script" "$BIN_BACKUP_MANIFEST"; then
      [ -f "$BIN_BACKUP_DIR/$script" ] || return 1
      cp "$BIN_BACKUP_DIR/$script" "${HOME}/.flywheel/bin/$script" || return 1
      chmod 0755 "${HOME}/.flywheel/bin/$script" || return 1
    else
      rm -f "${HOME}/.flywheel/bin/$script" || return 1
    fi
  done
}

pointer_install_state() {
  python3 - "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/plugins/installed_plugins.json" <<'PY'
import json
import os
import sys

path = sys.argv[1]
if not os.path.exists(path):
    print("absent")
    raise SystemExit(0)
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"invalid plugin registry during rollback: {error}")
entries = data.get("plugins", {}).get("discord@flywheel-plugins", [])
print("present" if entries else "absent")
PY
}

rollback_mutated() {
  local rc=0 pointer_state=""
  stop_authorities || rc=1
  assert_quiet_twice || rc=1
  [ "$rc" -eq 0 ] || return 1
  deploy_sha "$KNOWN_GOOD_SHA" || return 1
  build_repo || return 1
  restore_legacy_bytes || return 1
  set_selection legacy || return 1
  pointer_state="$(pointer_install_state)" || return 1
  if [ "$pointer_state" = present ]; then
    if ! "$CLAUDE_BIN" plugin uninstall discord@flywheel-plugins --scope user; then
      log "WARNING: pointer uninstall failed; settings keep it disabled while legacy recovery continues"
    fi
  fi
  "${HOME}/.flywheel/bin/check-discord-plugin.sh" || return 1
  restore_authorities || return 1
}

apply_transaction() {
  local install_path
  deploy_sha "$TARGET_SHA" || return 1
  failpoint deploy || return 1
  build_repo || return 1
  "$INSTALLER" || return 1
  failpoint install-ops || return 1
  "$CLAUDE_BIN" plugin install discord@flywheel-plugins --scope user || return 1
  failpoint install-plugin || return 1
  set_selection pointer || return 1
  failpoint settings || return 1
  install_path="$(preflight_pointer)" || return 1
  failpoint preflight || return 1
  start_pointer_fleet "$install_path" || return 1
  printf 'complete\n' > "${STATE_DIR}/status"
}

mkdir -p "$(dirname "$LOCK_DIR")" || exit 1
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "ERROR: restart/deploy lock is already held: $LOCK_DIR" >&2
  exit 1
fi
LOCK_OWNED=1

if ! assert_deployed_repo; then
  release_lock || true
  exit 1
fi

if [ "$MODE" = apply ]; then
  [ ! -e "$STATE_DIR" ] || { log "ERROR: cutover state already exists: $STATE_DIR"; release_lock; exit 1; }
  if ! preflight_target; then
    log "ERROR: target dependency preflight failed before fleet mutation"
    release_lock || true
    exit 1
  fi
  mkdir -p "$STATE_DIR" || { release_lock; exit 1; }
  if ! inventory_leads || ! snapshot_legacy || ! stop_authorities || ! assert_quiet_twice; then
    log "ERROR: pre-mutation quiet gate failed; restoring the untouched legacy fleet"
    if ! restore_authorities; then
      alert_failure pre-mutation "Discord cutover quiet gate failed and the untouched legacy fleet could not be fully restored. Fleet state requires operator attention."
    fi
    printf 'pre-mutation-aborted\n' > "${STATE_DIR}/status"
    release_lock || true
    exit 1
  fi
  if apply_transaction; then
    log "SUCCESS: pointer cutover completed with the full fleet on discord@flywheel-plugins"
    release_lock || exit 1
    exit 0
  fi
  log "ERROR: apply failed after mutation; running the canonical reverse transaction"
  if rollback_mutated; then
    printf 'rolled-back\n' > "${STATE_DIR}/status"
    alert_failure apply-rolled-back "Discord pointer cutover failed after mutation; the canonical reverse transaction restored the legacy code, plugin, settings, and fleet."
  else
    printf 'rollback-failed-fleet-stopped\n' > "${STATE_DIR}/status"
    alert_failure rollback-failed "Discord pointer cutover and its reverse transaction failed. The fleet remains stopped under operator control; do not start Leads until consistency is restored."
  fi
  release_lock || true
  exit 1
fi

# Explicit post-cutover rollback: acquire the same gate and replay the durable
# pre-image. This mode is intentionally not a persistent runtime selector.
[ -f "$LEAD_LABELS_FILE" ] && [ -d "$BIN_BACKUP_DIR" ] || {
  log "ERROR: durable cutover pre-image is missing; refusing partial rollback"
  release_lock || true
  exit 1
}
recorded_target="$(cat "${STATE_DIR}/target.sha" 2>/dev/null || true)"
recorded_known="$(cat "${STATE_DIR}/known-good.sha" 2>/dev/null || true)"
if [ "$TARGET_SHA" != "$recorded_target" ] || [ "$KNOWN_GOOD_SHA" != "$recorded_known" ]; then
  log "ERROR: rollback SHAs do not match the durable cutover pre-image"
  release_lock || true
  exit 1
fi
if ! stop_authorities || ! assert_quiet_twice; then
  alert_failure rollback-quiesce "Post-cutover rollback could not establish a quiet fleet. No reverse mutation was attempted."
  release_lock || true
  exit 1
fi
if rollback_mutated; then
  printf 'rolled-back\n' > "${STATE_DIR}/status"
  log "SUCCESS: explicit reverse transaction restored the legacy fleet"
  release_lock || exit 1
  exit 0
fi
printf 'rollback-failed-fleet-stopped\n' > "${STATE_DIR}/status"
alert_failure rollback-failed "Explicit Discord rollback failed. The fleet remains stopped; operator recovery is required."
release_lock || true
exit 1
