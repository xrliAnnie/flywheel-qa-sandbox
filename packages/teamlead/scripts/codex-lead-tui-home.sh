#!/bin/bash
# FLY-259 PR-B — codex-lead-tui-home.sh: idempotent assembly + validation of a
# Codex TUI Lead's isolated CODEX_HOME, and the remote-control daemon ensure.
#
# Usage:
#   codex-lead-tui-home.sh ensure-home   # assemble/validate $FLYWHEEL_CODEX_TUI_HOME
#   codex-lead-tui-home.sh ensure-daemon # idempotent `codex remote-control start`
#
# Contracts (plan v1.44.0 §3 D3 / §4 PR-B — review-pinned):
#   - SAFETY PIN double-insurance: config.toml carries sandbox_mode=read-only +
#     approval_policy=never (the runtime ALSO re-pins via thread params every
#     resume; the TUI command line ALSO passes explicit flags — R4 HIGH-4).
#     A pre-existing config with a DIFFERENT sandbox/approval value is a
#     fail-close exit 1 (FLY-224 HIGH-1 semantics transplanted) — we never
#     silently overwrite an operator's explicit (mis)configuration.
#   - persona does NOT live here (thread-params baseInstructions is the only
#     persona path; the demo-era AGENTS.md approach is retired — D3).
#   - standalone install REQUIRED for the daemon (npm codex has no daemon
#     backend): fail-loud with instructions, NEVER auto `curl | sh`.
#   - auth.json must exist (provisioning is the operator's/FLY-246's job).
#   - everything idempotent: re-running with a compliant home is a no-op.
#
# Env:
#   FLYWHEEL_CODEX_TUI_HOME   (required) isolated CODEX_HOME path
#   FLYWHEEL_CODEX_TUI_CWD    (required for ensure-home) Lead working dir to trust
#   FLYWHEEL_CODEX_BIN        (optional) codex binary for ensure-daemon (default: codex)

set -euo pipefail

# FLY-694: macOS /bin/bash is the GPLv2-frozen bash 3.2, whose incremental script
# reader silently mis-parses a here-document that straddles its internal read-buffer
# boundary — a byte-layout-dependent defect that `bash -n` cannot detect on ANY bash
# version. FLY-676 (#388) added ~1.8 KB to this file, shifting a heredoc onto a bad
# boundary, so bash 3.2 failed to DEFINE write_full_access_config /
# append_full_access_lead_actions_mcp at runtime → the Mufasa launcher hit
# `line 395: write_full_access_config: command not found`, exited 127, and launchd
# retried every 30s. In-file restructuring cannot fix it (the desync is intrinsic to
# 3.2's heredoc reader — even a single brace-group / main() wrapper still desyncs), so
# re-exec under a modern bash (>=4), which has no such defect and is therefore immune
# to ANY future byte-layout shift. Self-contained (no launcher / PATH dependency);
# idempotent via the sentinel; a host with no modern bash warns loudly and proceeds.
if [ "${BASH_SOURCE[0]}" = "$0" ] && [ "${BASH_VERSINFO:-0}" -lt 4 ]; then
  # Candidates are TRUSTED ABSOLUTE system paths only — never a PATH-resolved `bash`:
  # the production wrapper prepends user-writable dirs (~/.local/bin) to PATH, and even
  # the version probe below EXECUTES the candidate, so a PATH lookup could run a
  # user-writable bash impersonator in this full-access context (Codex review LOW-2).
  # These four cover macOS Homebrew (arm + intel/manual) and Linux (/usr/bin, /bin).
  if [ -z "${FLYWHEEL_TUI_HOME_REEXEC:-}" ]; then
    for _modern_bash in /opt/homebrew/bin/bash /usr/local/bin/bash /usr/bin/bash /bin/bash; do
      [ -x "$_modern_bash" ] || continue
      # only re-exec into a GENUINELY modern (>=4) bash — never loop back into a 3.x bash
      # (e.g. macOS /bin/bash). The sentinel is a second backstop against re-exec loops.
      # shellcheck disable=SC2016  # expanded by the candidate bash, not this shell
      if "$_modern_bash" -c 'exit $(( ${BASH_VERSINFO:-0} < 4 ))' 2>/dev/null; then
        export FLYWHEEL_TUI_HOME_REEXEC=1
        exec "$_modern_bash" "$0" "$@"
      fi
    done
  fi
  # Reached here only while STILL under bash <4 — either no modern bash was found, or a
  # pre-set FLYWHEEL_TUI_HOME_REEXEC suppressed the re-exec (Codex review LOW-1). Warn
  # loudly: the here-document desync may bite on this host.
  echo "[codex-lead-tui-home] WARNING (FLY-694): running under bash ${BASH_VERSION:-?} (<4) and did not re-exec into a modern bash — here-document parsing may be unreliable on this host." >&2
fi

log() { echo "[codex-lead-tui-home] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# trim leading/trailing whitespace — mirrors the TS `.trim()` calls in
# parseCodexLeadRuntimeConfig (channel ids are plain ASCII snowflakes / comma
# lists, so this simple idiom is sufficient).
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# FLY-1243 — SINGLE SOURCE OF TRUTH for the effective cross-dept channel list, mirroring
# parseCodexLeadRuntimeConfig's crossDeptChannelIds build EXACTLY (codex-lead-runtime.ts
# :545-554): split FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS on comma, trim, drop empties, drop
# any id equal to a BASE channel (FLYWHEEL_LEAD_CHAT_CHANNEL_ID / FLYWHEEL_LEAD_CORE_CHANNEL_ID
# — a chat/core channel must NOT be mention-gated), dedup (first-wins), join with ",".
# Prints the normalized comma-joined list (empty string if none).
#
# WHY the renderers MUST use THIS (Codex R3): the runtime builds its §10-gate expectedMcp
# env from config.crossDeptChannelIds — ALREADY base-filtered by the parser — so the
# config.toml the launcher writes MUST carry the SAME base-filtered value, or
# assertFullAccessLeadActionsConfigGate fail-closes the TUI Lead at boot for any
# chat/core-overlapping or messy list. For Mufasa's real config (one clean cross-dept id) normalized
# == raw, so production is byte-unchanged.
normalized_cross_dept_ids() {
  local chat core seg t oldIFS out=""
  chat="$(trim "${FLYWHEEL_LEAD_CHAT_CHANNEL_ID:-}")"
  core="$(trim "${FLYWHEEL_LEAD_CORE_CHANNEL_ID:-}")"
  oldIFS="$IFS"
  IFS=','
  for seg in ${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:-}; do
    t="$(trim "$seg")"
    [ -z "$t" ] && continue                          # drop empties
    [ "$t" = "$chat" ] && continue                   # drop base: chat channel
    [ -n "$core" ] && [ "$t" = "$core" ] && continue # drop base: core channel
    case ",$out," in *",$t,"*) continue ;; esac      # dedup (first-wins)
    if [ -z "$out" ]; then out="$t"; else out="$out,$t"; fi
  done
  IFS="$oldIFS"
  printf '%s' "$out"
}

# FLY-1243 — echo "1" when roundtable in-thread member-follow (autoContinue) is
# EFFECTIVELY on, else "". FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD is RETIRED (固化
# default-on) — MUST mirror parseCodexLeadRuntimeConfig's new rule exactly: a
# RESOLVABLE parent channel. The parent is
# FLYWHEEL_ROUNDTABLE_CHANNEL_ID (trimmed) if set, else crossDeptChannelIds[0] — derived
# from normalized_cross_dept_ids() so it can never drift from the value the renderers write.
roundtable_autocontinue_effective() {
  local parent
  parent="$(trim "${FLYWHEEL_ROUNDTABLE_CHANNEL_ID:-}")"
  if [ -z "$parent" ]; then
    parent="$(normalized_cross_dept_ids)"
    parent="${parent%%,*}"   # first survivor = crossDept[0] (already trimmed/base-filtered)
  fi
  if [ -n "$parent" ]; then
    printf '1'
  fi
}

HOME_DIR="${FLYWHEEL_CODEX_TUI_HOME:-}"
CONFIG="$HOME_DIR/config.toml"

# FLY-1955: absolute process primitives are wrapped only to give the hermetic
# harness deterministic fault-injection seams. Production still invokes the
# same system tools directly and adds no dependency or resident process.
fly1955_ps() { /bin/ps "$@"; }
fly1955_kill() { /bin/kill "$@"; }
fly1955_sleep() { /bin/sleep "$@"; }

AUTH_LOG_SNAPSHOT_VALID=0
AUTH_LOG_SNAPSHOT_EXISTS=0
AUTH_LOG_SNAPSHOT_INO=""
AUTH_LOG_SNAPSHOT_SIZE=""
AUTH_LOG_SNAPSHOT_DIGEST=""
AUTH_DEAD_CODE=""

snapshot_auth_log() {
  local log_file="$HOME_DIR/app-server-daemon/app-server.stderr.log" snapshot
  AUTH_LOG_SNAPSHOT_VALID=0
  AUTH_LOG_SNAPSHOT_EXISTS=0
  AUTH_LOG_SNAPSHOT_INO=""
  AUTH_LOG_SNAPSHOT_SIZE=""
  AUTH_LOG_SNAPSHOT_DIGEST=""
  if ! snapshot="$(python3 - "$log_file" <<'PY' 2>/dev/null
import hashlib
import os
import stat
import sys

try:
    before = os.lstat(sys.argv[1])
except FileNotFoundError:
    print("0\t0\t0\t-")
    sys.exit(0)
except OSError:
    sys.exit(1)
if not stat.S_ISREG(before.st_mode):
    sys.exit(1)
try:
    with open(sys.argv[1], "rb") as f:
        opened = os.fstat(f.fileno())
        data = f.read()
        after = os.fstat(f.fileno())
except OSError:
    sys.exit(1)
if ((before.st_dev, before.st_ino, before.st_size) !=
        (opened.st_dev, opened.st_ino, opened.st_size) or
    (opened.st_dev, opened.st_ino, opened.st_size) !=
        (after.st_dev, after.st_ino, after.st_size)):
    sys.exit(1)
print(f"1\t{after.st_ino}\t{after.st_size}\t{hashlib.sha256(data).hexdigest()}")
PY
)"; then
    return 0
  fi
  IFS=$'\t' read -r AUTH_LOG_SNAPSHOT_EXISTS AUTH_LOG_SNAPSHOT_INO \
    AUTH_LOG_SNAPSHOT_SIZE AUTH_LOG_SNAPSHOT_DIGEST <<< "$snapshot"
  AUTH_LOG_SNAPSHOT_VALID=1
}

classify_auth_dead() {
  local log_file="$HOME_DIR/app-server-daemon/app-server.stderr.log" matched
  AUTH_DEAD_CODE=""
  [ "$AUTH_LOG_SNAPSHOT_VALID" -eq 1 ] || return 1
  if ! matched="$(python3 - "$log_file" "$AUTH_LOG_SNAPSHOT_EXISTS" \
    "$AUTH_LOG_SNAPSHOT_INO" "$AUTH_LOG_SNAPSHOT_SIZE" \
    "$AUTH_LOG_SNAPSHOT_DIGEST" <<'PY' 2>/dev/null
import hashlib
import os
import stat
import sys

path, existed, old_ino, old_size, old_digest = sys.argv[1:]
try:
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode):
        sys.exit(1)
    with open(path, "rb") as f:
        opened = os.fstat(f.fileno())
        data = f.read()
        after = os.fstat(f.fileno())
except OSError:
    sys.exit(1)
if ((before.st_dev, before.st_ino, before.st_size) !=
        (opened.st_dev, opened.st_ino, opened.st_size) or
    (opened.st_dev, opened.st_ino, opened.st_size) !=
        (after.st_dev, after.st_ino, after.st_size)):
    sys.exit(1)

if existed == "0" or after.st_ino != int(old_ino):
    candidate = data
else:
    size = int(old_size)
    prefix_matches = len(data) >= size and hashlib.sha256(data[:size]).hexdigest() == old_digest
    if prefix_matches and len(data) == size:
        sys.exit(1)
    candidate = data[size:] if prefix_matches else data

for code in (
    b"refresh_token_invalidated",
    b"refresh_token_reused",
    b"token_revoked",
    b"token_expired",
    b"Your access token could not be refreshed",
):
    if code in candidate:
        print(code.decode("ascii"))
        sys.exit(0)
sys.exit(1)
PY
)"; then
    return 1
  fi
  AUTH_DEAD_CODE="$matched"
}

auth_dead_hold() {
  local orig_ppid current_ppid i
  orig_ppid="$(fly1955_ps -o ppid= -p $$ 2>/dev/null)" || exit 1
  orig_ppid="$(trim "$orig_ppid")"
  [ -n "$orig_ppid" ] || exit 1
  for ((i = 0; i < 30; i++)); do
    fly1955_sleep 30
    current_ppid="$(fly1955_ps -o ppid= -p $$ 2>/dev/null)" || exit 1
    current_ppid="$(trim "$current_ppid")"
    [ "$current_ppid" = "$orig_ppid" ] || exit 1
  done
}

fly1955_read_failcount() {
  python3 - "$1" <<'PY'
import os
import stat
import sys

try:
    entry = os.lstat(sys.argv[1])
except FileNotFoundError:
    print("missing")
    sys.exit(0)
except OSError:
    print("read_state")
    sys.exit(0)
if not stat.S_ISREG(entry.st_mode):
    print("read_state")
    sys.exit(0)
try:
    with open(sys.argv[1], encoding="ascii") as f:
        raw = f.read().strip()
    value = int(raw)
except (OSError, UnicodeError):
    print("read_state")
    sys.exit(0)
except ValueError:
    print("corrupt")
    sys.exit(0)
if not raw.isdigit() or value < 0 or value >= 2147483647:
    print("corrupt")
else:
    print(f"numeric\t{value}")
PY
}

fly1955_write_failcount() {
  python3 - "$1" "$2" <<'PY'
import os
import stat
import tempfile
import sys

path, value = sys.argv[1:]
fd, tmp = tempfile.mkstemp(prefix=".flywheel-ensure-daemon-failcount.", dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w", encoding="ascii") as f:
        f.write(value + "\n")
    os.replace(tmp, path)
finally:
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
try:
    entry = os.lstat(path)
    with open(path, encoding="ascii") as f:
        stored = f.read().strip()
except (OSError, UnicodeError):
    sys.exit(1)
if not stat.S_ISREG(entry.st_mode) or stored != value:
    sys.exit(1)
PY
}

fly1955_remove_failcount() { rm -f "$1"; }

emit_failcount_io_alert() {
  local io_fault="$1" day
  day="$(LC_ALL=C date -u +%Y%m%d)"
  emit_lead_alert \
    crash_loop severe "fly1955-failcount-io|$day" \
    "Codex Lead ensure-daemon failcount persistence broken" \
    "FLY-1955: home=$HOME_DIR io_fault=$io_fault"
}

daemon_die() {
  local message="$1" reason="${2:-}" counter="$HOME_DIR/.flywheel-ensure-daemon-failcount"
  local read_state count=0 io_fault="" day
  read_state="$(fly1955_read_failcount "$counter" 2>/dev/null)" || read_state=read_state
  case "$read_state" in
    missing|corrupt) count=0 ;;
    numeric$'\t'*) count="${read_state#*$'\t'}" ;;
    *) io_fault=read_state; count=0 ;;
  esac
  count=$((count + 1))
  if [ -z "$io_fault" ] && ! fly1955_write_failcount "$counter" "$count" 2>/dev/null; then
    io_fault="write"
  fi
  if [ -n "$io_fault" ]; then
    emit_failcount_io_alert "$io_fault"
  fi
  if [ "$count" -ge 3 ]; then
    day="$(LC_ALL=C date -u +%Y%m%d)"
    emit_lead_alert \
      crash_loop severe "fly1955-ensure-daemon-failing|$day" \
      "Codex Lead ensure-daemon failing repeatedly" \
      "FLY-1955: consecutive=$count home=$HOME_DIR failure=$message${reason:+ reason=$reason}"
  fi
  die "$message"
}

clear_daemon_failcount() {
  if ! fly1955_remove_failcount "$HOME_DIR/.flywheel-ensure-daemon-failcount" 2>/dev/null; then
    log "failed to clear daemon failcount (non-fatal): $HOME_DIR"
    emit_failcount_io_alert clear
  fi
  return 0
}

resolve_lead_alert_sh() {
  if [ -n "${FLYWHEEL_LEAD_ALERT_SH:-}" ]; then
    printf '%s' "$FLYWHEEL_LEAD_ALERT_SH"
    return
  fi
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  printf '%s/scripts/lead-alert.sh' "$repo_root"
}

emit_lead_alert() {
  local kind="$1" severity="$2" signature="$3" title="$4" body="$5"
  if [ -z "${FLYWHEEL_LEAD_ID:-}" ] || [ -z "${FLYWHEEL_PROJECT_NAME:-}" ]; then
    log "alert skipped: FLYWHEEL_LEAD_ID/FLYWHEEL_PROJECT_NAME unavailable"
    return 0
  fi
  local alert_sh
  alert_sh="$(resolve_lead_alert_sh)"
  "$alert_sh" \
    --lead "$FLYWHEEL_LEAD_ID" \
    --project "$FLYWHEEL_PROJECT_NAME" \
    --kind "$kind" \
    --severity "$severity" \
    --title "$title" \
    --body "$body" \
    --signature "$signature" \
    || log "alert emit failed (non-fatal): kind=$kind signature=$signature"
}

emit_zombie_alert() {
  local outcome="$1" detail="${2:-}"
  local day
  day="$(LC_ALL=C date -u +%Y%m%d)"
  case "$outcome" in
    recovered)
      emit_lead_alert \
        crash_loop warning "fly1955-zombie-recovered|$day" \
        "Codex daemon zombie recovered" \
        "FLY-1955 recovered a stale zombie daemon for $HOME_DIR. $detail"
      ;;
    stuck)
      emit_lead_alert \
        crash_loop severe "fly1955-zombie-stuck|$day" \
        "Codex daemon zombie recovery stuck" \
        "FLY-1955 could not safely recover a stale zombie daemon for $HOME_DIR. $detail"
      ;;
    *) die "internal error: unknown zombie alert outcome '$outcome'" ;;
  esac
}

emit_global_codex_alert() {
  local global_real="$1" day
  day="$(LC_ALL=C date -u +%Y%m%d)"
  emit_lead_alert \
    bin_integrity_drift warning "fly513-global-codex|$day" \
    "Global Codex points into a Lead home" \
    "FLY-513: global codex resolves into $HOME_DIR ($global_real); use the neutral pinned Flywheel Codex install."
}

# FLY-398 — FULL-ACCESS (= Claude-equal) config: workspace-write + network ON + the
# project root as the single writable root. The daemon
# reads this at start; pin ⑤ (ensure_daemon stop/start) forces a re-read on flip.
# Atomically rewritten via tmp + validated.
write_full_access_config() {
  local cwd="$1"
  local tmp
  tmp="$(mktemp "${HOME_DIR}/.config.toml.fullaccess.XXXXXX")" || die "mktemp failed"
  {
    printf '# Generated by codex-lead-tui-home.sh (FLY-398) — FULL-ACCESS (= Claude-equal)\n'
    printf '# windowed TUI Lead: workspace-write + network ON + project writable root.\n'
    printf '# The runtime re-pins via thread params on every resume and the TUI command\n'
    printf '# line carries -s workspace-write (double insurance).\n'
    printf 'sandbox_mode = "workspace-write"\n'
    printf 'approval_policy = "never"\n'
    printf '\n[sandbox_workspace_write]\n'
    printf 'network_access = true\n'
    printf 'writable_roots = [%s]\n' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$cwd")"
  } > "$tmp"
  # preserve existing trusted [projects] (TOML-safe) + ensure cwd is trusted.
  python3 - "$CONFIG" "$cwd" >> "$tmp" <<'PYPROJ' || die "full-access: failed to assemble trusted [projects] (parser missing or unparseable existing config)"
import json, sys
try:
    import tomllib
except ImportError:
    sys.exit(2)
cfg = {}
try:
    with open(sys.argv[1], "rb") as f:
        cfg = tomllib.load(f)
except FileNotFoundError:
    cfg = {}
except Exception:
    sys.exit(3)
cwd = sys.argv[2]
projects = cfg.get("projects", {})
if not isinstance(projects, dict):
    sys.exit(4)
trusted = {}
for path, entry in projects.items():
    if isinstance(entry, dict) and entry.get("trust_level") == "trusted":
        trusted[path] = True
trusted[cwd] = True
out = ["", "# Trusted project dirs (preserved + cwd) — TOML-safe quoted keys."]
for path in trusted:
    out.append(f'[projects.{json.dumps(path)}]')
    out.append('trust_level = "trusted"')
print("\n".join(out))
PYPROJ
  # validate the assembled config BEFORE swapping it in (fail-closed): workspace-write
  # + network ON + exactly [cwd] writable + approval_policy=never + no default profile.
  python3 - "$tmp" "$cwd" <<'PYVAL' || { rm -f "$tmp"; die "full-access config validation failed (must be sandbox_mode=workspace-write; approval_policy=never; [sandbox_workspace_write] network_access=true + writable_roots=[cwd]; NO default_permissions profile)"; }
import sys
try:
    import tomllib
except ImportError:
    sys.exit(2)
try:
    with open(sys.argv[1], "rb") as f:
        cfg = tomllib.load(f)
except Exception:
    sys.exit(3)
cwd = sys.argv[2]
if cfg.get("sandbox_mode") != "workspace-write":
    sys.exit(10)
if cfg.get("approval_policy") != "never":
    sys.exit(11)
# A full-access Lead must not carry a default permission profile.
if cfg.get("default_permissions") is not None:
    sys.exit(12)
sww = cfg.get("sandbox_workspace_write", {})
if not isinstance(sww, dict):
    sys.exit(13)
if sww.get("network_access") is not True:
    sys.exit(14)
if sww.get("writable_roots") != [cwd]:
    sys.exit(15)
sys.exit(0)
PYVAL
  mv "$tmp" "$CONFIG"
  log "config.toml written (full-access: workspace-write + network ON, writable_roots=[$cwd])"
}

# FLY-398 — full-access lead-actions MCP block: approve mode + token forwarded BY
# NAME (env_vars) — NO broker socket (a full-access Lead has the token in its daemon
# env, Claude-equal). The runtime's full-access §10 config gate validates the exact
# shape (assertFullAccessLeadActionsConfigGate). Idempotent: appended AFTER every
# (re)write of the base full-access config (write_full_access_config).
append_full_access_lead_actions_mcp() {
  [ "${FLYWHEEL_CODEX_LEAD_PROFILE:-}" = "full-access" ] || return 0
  local main_js="${FLYWHEEL_LEAD_ACTIONS_MAIN_JS:-}"
  local node_bin="${FLYWHEEL_LEAD_ACTIONS_NODE_BIN:-node}"
  local lead_id="${FLYWHEEL_LEAD_ID:-}"
  local project="${FLYWHEEL_PROJECT_NAME:-}"
  local chat="${FLYWHEEL_LEAD_CHAT_CHANNEL_ID:-}"
  # FLY-1243 (Codex R3): write the NORMALIZED (split/trim/drop-empties/drop-base/dedup)
  # cross-dept list — the SAME value config.crossDeptChannelIds carries in the runtime's
  # full-access §10-gate expectedMcp. The old inline python normalize (Codex R1 LOW-4) only
  # split/trim/filter-empty and did NOT drop base channels, so a chat/core-overlapping list
  # still diverged from the gate; the shared helper is now the single source of truth.
  local cross
  cross="$(normalized_cross_dept_ids)"
  local state_dir="${FLYWHEEL_LEAD_ACTIONS_STATE_DIR:-}"
  local comm_db="${FLYWHEEL_COMM_DB:-}"
  local aliases="${FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES:-}"
  for pair in "FLYWHEEL_LEAD_ACTIONS_MAIN_JS=$main_js" "FLYWHEEL_LEAD_ID=$lead_id" \
    "FLYWHEEL_PROJECT_NAME=$project" "FLYWHEEL_LEAD_CHAT_CHANNEL_ID=$chat" \
    "FLYWHEEL_LEAD_ACTIONS_STATE_DIR=$state_dir" "FLYWHEEL_COMM_DB=$comm_db"; do
    case "$pair" in *=) die "append_full_access_lead_actions_mcp: missing required env ${pair%=}" ;; esac
  done
  # env table: non-secret coords ONLY, NO broker socket (token is by NAME via env_vars).
  local rt_eff
  rt_eff="$(roundtable_autocontinue_effective)"  # FLY-676 — see helper; gate-matched
  local env_toml
  env_toml="$(python3 - "$lead_id" "$project" "$chat" "$cross" "$state_dir" "$comm_db" "$aliases" "$rt_eff" <<'PYENV'
import sys, json
keys = ["FLYWHEEL_LEAD_ID","FLYWHEEL_PROJECT_NAME","FLYWHEEL_LEAD_CHAT_CHANNEL_ID",
        "FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS","FLYWHEEL_LEAD_ACTIONS_STATE_DIR",
        "FLYWHEEL_COMM_DB","FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES"]
vals = sys.argv[1:8]
pairs = []
for k, v in zip(keys, vals):
    if k == "FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES" and not v:
        continue  # optional
    # FLY-1243: FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS is already normalized+base-filtered by
    # the shell (normalized_cross_dept_ids) — written verbatim to match the gate exactly.
    pairs.append(f"{k} = {json.dumps(v)}")
# FLY-676: effective roundtable autoContinue flag — ONLY when on (matches the runtime
# full-access builder's conditional include; preserves the prior OFF env shape).
if len(sys.argv) > 8 and sys.argv[8] == "1":
    pairs.append(f'FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE = {json.dumps("1")}')
print(", ".join(pairs))
PYENV
)" || die "append_full_access_lead_actions_mcp: failed to render env table"
  {
    printf '\n# FLY-398 full-access (= Claude-equal): lead-actions MCP — approve mode + token by NAME (no broker)\n'
    printf '[mcp_servers.lead_actions]\n'
    printf 'command = %s\n' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$node_bin")"
    printf 'args = [%s]\n' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$main_js")"
    printf 'default_tools_approval_mode = "approve"\n'
    printf 'env_vars = ["DISCORD_BOT_TOKEN"]\n'
    printf 'env = { %s }\n' "$env_toml"
  } >> "$CONFIG"
  log "config.toml: appended [mcp_servers.lead_actions] (full-access: approve + token by name)"
}

ensure_home() {
  local cwd="${FLYWHEEL_CODEX_TUI_CWD:-}"
  [ -n "$cwd" ] || die "FLYWHEEL_CODEX_TUI_CWD is required for ensure-home"
  mkdir -p "$HOME_DIR"

  # 1. auth must be provisioned already (operator / FLY-246) — fail-loud.
  [ -f "$HOME_DIR/auth.json" ] || die "auth.json missing in $HOME_DIR — provision the Lead's Codex auth first (see FLY-246); this script never copies credentials"

  # 2. standalone install required for the daemon backend — fail-loud, no auto-install.
  local standalone="$HOME_DIR/packages/standalone/current/codex"
  if [ ! -x "$standalone" ]; then
    die "standalone codex install missing at $standalone — the remote-control daemon requires it. Install with: CODEX_HOME='$HOME_DIR' CODEX_INSTALL_DIR='$HOME_DIR/.local/bin' sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' (then REVERT any shell-profile PATH edit the installer makes; the home-scoped install target must not touch global ~/.local/bin/codex — see FLY-259 spike notes + FLY-513)"
  fi

  # FLY-513: warn (non-fatal) if the GLOBAL `codex` on PATH was hijacked INTO this
  # Lead home by the curl installer's `~/.local/bin/codex` side effect. The global
  # codex (every runner's codex review gate + every codex companion resolves it via
  # PATH) must be a NEUTRAL, PINNED install — a Lead-home binary gets churned by the
  # standalone updater + Lead flips and transiently fails config-load, stalling every
  # runner's review gate. Warn only: an operator may have a deliberate setup, and
  # ensure-home must stay idempotent for a compliant home.
  local global_codex="$HOME/.local/bin/codex"
  if [ -L "$global_codex" ] || [ -e "$global_codex" ]; then
    local global_real
    global_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$global_codex" 2>/dev/null || true)"
    case "$global_real" in
      "$HOME_DIR"/*)
        log "WARNING (FLY-513): global codex $global_codex resolves INTO this Lead home: $global_real"
        log "  → the standalone updater / Lead flips will churn it and transiently break EVERY runner's codex review gate."
        log "  → restore a neutral pinned global, e.g.: ln -sfn ~/.local/share/flywheel-codex/<ver>/bin/codex $global_codex"
        emit_global_codex_alert "$global_real"
        ;;
    esac
  fi

  # FLY-398: full-access (= Claude-equal) rewrites the config to a workspace-write +
  # network-ON shape (replaces legacy steps 3+4). Auth + standalone still apply.
  if [ "${FLYWHEEL_CODEX_LEAD_PROFILE:-}" = "full-access" ]; then
    write_full_access_config "$cwd"
    append_full_access_lead_actions_mcp
    log "home OK (full-access): $HOME_DIR"
    return 0
  fi

  # 3. config.toml: write pins if absent; FAIL-CLOSE if present with drift.
  #    Code review R1 HIGH-3: grep can be bypassed by TOML comments
  #    (`sandbox_mode = "danger-full-access" # sandbox_mode = "read-only"`) —
  #    validate EFFECTIVE values with a real TOML parser (python3.11+ tomllib;
  #    its absence is itself a fail-close).
  if [ -f "$CONFIG" ]; then
    python3 - "$CONFIG" <<'PYCHECK' || die "config.toml pin validation failed (effective values must be sandbox_mode=read-only + approval_policy=never; parse errors and tomllib absence also fail closed). Fix $CONFIG manually."
import sys
try:
    import tomllib
except ImportError:
    sys.exit(2)  # no parser → fail closed, never guess
try:
    with open(sys.argv[1], "rb") as f:
        cfg = tomllib.load(f)
except Exception:
    sys.exit(3)  # unparseable config → fail closed
ok = cfg.get("sandbox_mode") == "read-only" and cfg.get("approval_policy") == "never"
sys.exit(0 if ok else 4)
PYCHECK
  else
    cat > "$CONFIG" <<EOF
# Generated by codex-lead-tui-home.sh (FLY-259) — safety pins for a read-only
# chat-only companion TUI Lead. The runtime re-pins via thread params on every
# resume and the TUI command line carries explicit flags (double insurance).
sandbox_mode = "read-only"
approval_policy = "never"
EOF
    log "config.toml written with read-only/never pins"
  fi

  # 4. trust the Lead's working dir (kills the boot trust-menu; cwd menu is
  #    killed by -C on the TUI command — spike-verified, zero menus).
  #    Code review R2 MED-4: judge the EFFECTIVE trust state via TOML parse —
  #    grep presence would accept an explicit untrusted entry (menu stays) and
  #    can false-match on comments/metacharacters.
  local trust_state
  trust_state=$(python3 - "$CONFIG" "$cwd" <<'PYTRUST'
import sys
try:
    import tomllib
except ImportError:
    print("error"); sys.exit(0)
try:
    with open(sys.argv[1], "rb") as f:
        cfg = tomllib.load(f)
except Exception:
    print("error"); sys.exit(0)
projects = cfg.get("projects", {})
# R4 MED-1: a non-table `projects` (scalar/list) must fail closed — appending
# a [projects."<cwd>"] table next to it would produce invalid TOML.
if not isinstance(projects, dict):
    print("error"); sys.exit(0)
if sys.argv[2] not in projects:
    print("absent")  # no entry at all -> safe to append
else:
    entry = projects[sys.argv[2]]
    if not isinstance(entry, dict):
        print("error"); sys.exit(0)  # entry itself malformed -> fail closed
    level = entry.get("trust_level")
    # R3 MED-2: an EXISTING table without trust_level must NOT be appended to
    # (duplicate [projects."<cwd>"] tables are invalid TOML) -> fail loud.
    print("trusted" if level == "trusted" else ("empty" if level is None else "drift"))
PYTRUST
)
  case "$trust_state" in
    trusted) : ;;
    empty) die "config.toml has a [projects.\"$cwd\"] table without trust_level — appending would create an invalid duplicate table (R3 MED-2). Add trust_level = \"trusted\" to the existing table manually." ;;
    absent)
      cat >> "$CONFIG" <<EOF

[projects."$cwd"]
trust_level = "trusted"
EOF
      log "trusted project dir added: $cwd"
      ;;
    drift) die "config.toml has an explicit non-trusted entry for $cwd — the boot trust menu would block an unattended TUI. Fix $CONFIG manually." ;;
    *) die "trust-state TOML inspection failed for $CONFIG (parser missing or unparseable config) — fail closed" ;;
  esac

  log "home OK: $HOME_DIR"
}

# FLY-1955 — `codex remote-control start` treats a zombie recorded in
# app-server.pid as alive, then waits for a control socket that can never exist.
# These helpers prove that exact shape and authorize one bounded updater reap.
PID_RECORD_PID=""
PID_RECORD_START=""
PROBE_VALUE=""
IDENTITY_STATE=""
REAP_OUTCOME="not_proven"
REAP_OLD_UPDATER_PID=""
REAP_OLD_UPDATER_LSTART=""
REAP_OLD_UPDATER_COMMAND=""

read_daemon_pid_record() {
  local pid_file="$HOME_DIR/app-server-daemon/app-server.pid" parsed
  [ -f "$pid_file" ] || return 1
  if ! parsed="$(python3 - "$pid_file" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        value = json.load(f)
except Exception:
    sys.exit(1)
pid = value.get("pid") if isinstance(value, dict) else None
started = value.get("processStartTime") if isinstance(value, dict) else None
if (not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1
        or not isinstance(started, str) or not started
        or any(c in started for c in "\r\n\t")):
    sys.exit(1)
print(f"{pid}\t{started}")
PY
)"; then
    return 1
  fi
  IFS=$'\t' read -r PID_RECORD_PID PID_RECORD_START <<< "$parsed"
  [ -n "$PID_RECORD_PID" ] && [ -n "$PID_RECORD_START" ]
}

# Return 0=present, 1=absent, 2=probe error; value is in PROBE_VALUE.
probe_ps_field() {
  local pid="$1" field="$2" rc
  PROBE_VALUE=""
  if PROBE_VALUE="$(LC_ALL=C fly1955_ps -o "${field}=" -p "$pid" 2>/dev/null)"; then
    [ -n "$PROBE_VALUE" ] && return 0
    return 2
  else
    rc=$?
  fi
  [ "$rc" -eq 1 ] && [ -z "$PROBE_VALUE" ] && return 1
  return 2
}

probe_ps_command() {
  local pid="$1" rc
  PROBE_VALUE=""
  if PROBE_VALUE="$(LC_ALL=C fly1955_ps -ww -o command= -p "$pid" 2>/dev/null)"; then
    [ -n "$PROBE_VALUE" ] && return 0
    return 2
  else
    rc=$?
  fi
  [ "$rc" -eq 1 ] && [ -z "$PROBE_VALUE" ] && return 1
  return 2
}

home_updater_command_matches() {
  local command="$1"
  local suffix=" app-server daemon pid-update-loop" executable
  case "$command" in
    *"$suffix") executable="${command%"$suffix"}" ;;
    *) return 1 ;;
  esac
  case "$executable" in *[[:space:]]*) return 1 ;; esac
  case "$executable" in "$HOME_DIR/packages/standalone/"*) return 0 ;; esac
  return 1
}

# State for the snapshotted updater: same|absent|changed|error.
updater_identity_state() {
  local pid="$1" expected_lstart="$2" expected_command="$3" rc lstart command
  if probe_ps_field "$pid" lstart; then
    lstart="$(trim "$PROBE_VALUE")"
  else
    rc=$?
    [ "$rc" -eq 1 ] && IDENTITY_STATE=absent || IDENTITY_STATE=error
    return 0
  fi
  if probe_ps_command "$pid"; then
    command="$PROBE_VALUE"
  else
    rc=$?
    [ "$rc" -eq 1 ] && IDENTITY_STATE=absent || IDENTITY_STATE=error
    return 0
  fi
  if [ "$lstart" = "$expected_lstart" ] && [ "$command" = "$expected_command" ]; then
    IDENTITY_STATE=same
  else
    IDENTITY_STATE=changed
  fi
}

updater_and_child_state() {
  local updater_pid="$1" updater_lstart="$2" updater_command="$3" daemon_pid="$4" rc ppid
  updater_identity_state "$updater_pid" "$updater_lstart" "$updater_command"
  [ "$IDENTITY_STATE" = same ] || return 0
  if probe_ps_field "$daemon_pid" ppid; then
    ppid="$(trim "$PROBE_VALUE")"
    [ "$ppid" = "$updater_pid" ] || IDENTITY_STATE=changed
  else
    rc=$?
    [ "$rc" -eq 1 ] && IDENTITY_STATE=changed || IDENTITY_STATE=error
  fi
}

current_zombie_proof_matches() {
  local daemon_pid="$1" daemon_start="$2" updater_pid="$3" updater_lstart="$4" updater_command="$5"
  local state lstart ppid
  [ ! -S "$HOME_DIR/app-server-control/app-server-control.sock" ] || return 1
  read_daemon_pid_record || return 1
  [ "$PID_RECORD_PID" = "$daemon_pid" ] && [ "$PID_RECORD_START" = "$daemon_start" ] || return 1
  if probe_ps_field "$daemon_pid" state; then state="$(trim "$PROBE_VALUE")"; else return 1; fi
  case "$state" in Z*) ;; *) return 1 ;; esac
  if probe_ps_field "$daemon_pid" lstart; then lstart="$(trim "$PROBE_VALUE")"; else return 1; fi
  [ "$lstart" = "$daemon_start" ] || return 1
  if probe_ps_field "$daemon_pid" ppid; then ppid="$(trim "$PROBE_VALUE")"; else return 1; fi
  [ "$ppid" = "$updater_pid" ] || return 1
  updater_identity_state "$updater_pid" "$updater_lstart" "$updater_command"
  [ "$IDENTITY_STATE" = same ]
}

reap_zombie_daemon_if_proven() {
  local sock="$HOME_DIR/app-server-control/app-server-control.sock"
  local daemon_pid daemon_start state lstart updater_pid updater_lstart updater_command rc i
  local term_sent=0 updater_gone=0
  REAP_OUTCOME=not_proven
  REAP_OLD_UPDATER_PID=""
  REAP_OLD_UPDATER_LSTART=""
  REAP_OLD_UPDATER_COMMAND=""

  [ ! -S "$sock" ] || { REAP_OUTCOME=race_self_healed; return 0; }
  read_daemon_pid_record || return 0
  daemon_pid="$PID_RECORD_PID"
  daemon_start="$PID_RECORD_START"

  if probe_ps_field "$daemon_pid" state; then state="$(trim "$PROBE_VALUE")"; else return 0; fi
  case "$state" in Z*) ;; *) return 0 ;; esac
  if probe_ps_field "$daemon_pid" lstart; then lstart="$(trim "$PROBE_VALUE")"; else return 0; fi
  [ "$lstart" = "$daemon_start" ] || return 0
  if probe_ps_field "$daemon_pid" ppid; then updater_pid="$(trim "$PROBE_VALUE")"; else return 0; fi
  [[ "$updater_pid" =~ ^[0-9]+$ ]] && [ "$updater_pid" -gt 1 ] || return 0
  if probe_ps_field "$updater_pid" lstart; then updater_lstart="$(trim "$PROBE_VALUE")"; else return 0; fi
  if probe_ps_command "$updater_pid"; then updater_command="$PROBE_VALUE"; else return 0; fi
  home_updater_command_matches "$updater_command" || return 0

  REAP_OLD_UPDATER_PID="$updater_pid"
  REAP_OLD_UPDATER_LSTART="$updater_lstart"
  REAP_OLD_UPDATER_COMMAND="$updater_command"

  # Final fresh proof immediately before the first signal. Any drift before
  # action is a quiet not_proven; after action, uncertainty is action_stuck.
  current_zombie_proof_matches \
    "$daemon_pid" "$daemon_start" "$updater_pid" "$updater_lstart" "$updater_command" \
    || return 0

  if fly1955_kill -TERM "$updater_pid" 2>/dev/null; then
    term_sent=1
  else
    updater_and_child_state "$updater_pid" "$updater_lstart" "$updater_command" "$daemon_pid"
    if [ "$IDENTITY_STATE" = absent ]; then
      updater_gone=1
    else
      REAP_OUTCOME=action_stuck
      return 0
    fi
  fi

  if [ "$term_sent" -eq 1 ]; then
    for ((i = 0; i < 10; i++)); do
      updater_and_child_state "$updater_pid" "$updater_lstart" "$updater_command" "$daemon_pid"
      case "$IDENTITY_STATE" in
        absent) updater_gone=1; break ;;
        same) fly1955_sleep 0.2 ;;
        changed|error) REAP_OUTCOME=action_stuck; return 0 ;;
      esac
    done
  fi

  if [ "$updater_gone" -eq 0 ]; then
    updater_and_child_state "$updater_pid" "$updater_lstart" "$updater_command" "$daemon_pid"
    [ "$IDENTITY_STATE" = same ] || { REAP_OUTCOME=action_stuck; return 0; }
    if ! fly1955_kill -KILL "$updater_pid" 2>/dev/null; then
      updater_identity_state "$updater_pid" "$updater_lstart" "$updater_command"
      [ "$IDENTITY_STATE" = absent ] || { REAP_OUTCOME=action_stuck; return 0; }
    fi
  fi

  for ((i = 0; i < 50; i++)); do
    if probe_ps_field "$daemon_pid" state; then
      fly1955_sleep 0.2
    else
      rc=$?
      if [ "$rc" -eq 1 ]; then
        REAP_OUTCOME=reaped
        return 0
      fi
      REAP_OUTCOME=action_stuck
      return 0
    fi
  done
  REAP_OUTCOME=action_stuck
}

HOME_UPDATER_COUNT=0
count_home_updaters() {
  local output line command
  HOME_UPDATER_COUNT=0
  if ! output="$(LC_ALL=C fly1955_ps -ww -axo pid=,command= 2>/dev/null)"; then
    return 1
  fi
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*([0-9]+)[[:space:]]+(.*)$ ]]; then
      command="${BASH_REMATCH[2]}"
      if home_updater_command_matches "$command"; then
        HOME_UPDATER_COUNT=$((HOME_UPDATER_COUNT + 1))
      fi
    fi
  done <<< "$output"
}

assert_recovery_shape() {
  local state lstart
  [ -S "$HOME_DIR/app-server-control/app-server-control.sock" ] || return 1
  updater_identity_state \
    "$REAP_OLD_UPDATER_PID" "$REAP_OLD_UPDATER_LSTART" "$REAP_OLD_UPDATER_COMMAND"
  [ "$IDENTITY_STATE" != same ] && [ "$IDENTITY_STATE" != error ] || return 1
  read_daemon_pid_record || return 1
  if probe_ps_field "$PID_RECORD_PID" state; then state="$(trim "$PROBE_VALUE")"; else return 1; fi
  case "$state" in Z*) return 1 ;; esac
  if probe_ps_field "$PID_RECORD_PID" lstart; then lstart="$(trim "$PROBE_VALUE")"; else return 1; fi
  [ "$lstart" = "$PID_RECORD_START" ] || return 1
  count_home_updaters || return 1
  [ "$HOME_UPDATER_COUNT" -eq 1 ]
}

ensure_daemon() {
  # Code review R1 MED-6: default to the STANDALONE binary inside this home —
  # the daemon requires it, and a PATH `codex` (npm install) would fail forever
  # even on a correctly provisioned home. Explicit override stays possible.
  local codex_bin="${FLYWHEEL_CODEX_BIN:-$HOME_DIR/packages/standalone/current/codex}"
  [ -x "$codex_bin" ] || daemon_die "codex binary not executable: $codex_bin (standalone install missing? see ensure-home)"
  # FLY-398 (pin ⑤): full-access needs stop-before-start — a stale read-only
  # daemon would keep its old read-only sandbox/config/MCP and never re-read the
  # rewritten workspace-write config (a flip would silently keep Mufasa read-only).
  if [ "${FLYWHEEL_CODEX_LEAD_PROFILE:-}" = "full-access" ]; then
    CODEX_HOME="$HOME_DIR" "$codex_bin" remote-control stop --json >/dev/null 2>&1 || true
    log "stopped any running daemon so it re-reads the full-access config"
  fi
  # `remote-control start` is idempotent (spike-verified: already-running →
  # status connected). Fail-loud otherwise — the supervisor retries with backoff.
  local sock="$HOME_DIR/app-server-control/app-server-control.sock"
  snapshot_auth_log
  # Codex's updater runs install.sh, whose default BIN_DIR is the real
  # $HOME/.local/bin. Keep its visible command inside this Lead home so a Lead
  # update (or an isolated experiment) can never rewrite the global Codex axis.
  if CODEX_INSTALL_DIR="$HOME_DIR/.local/bin" CODEX_HOME="$HOME_DIR" \
    "$codex_bin" remote-control start --json; then
    [ -S "$sock" ] || daemon_die "daemon reported started but control socket missing: $sock"
    clear_daemon_failcount
    log "daemon OK: $sock"
    return 0
  fi

  if [ "$AUTH_LOG_SNAPSHOT_VALID" -ne 1 ]; then
    auth_dead_hold
    daemon_die \
      "remote-control start failed (home: $HOME_DIR) (auth evidence snapshot unavailable; failure unclassified)" \
      snapshot_unavailable
  fi

  if classify_auth_dead; then
    local day
    day="$(LC_ALL=C date -u +%Y%m%d)"
    emit_lead_alert \
      login_expired severe "fly1955-codex-auth-dead|$day" \
      "Codex Lead auth revoked — re-login required" \
      "FLY-1955: $HOME_DIR matched $AUTH_DEAD_CODE; follow the account runbook in engineering/doc/FLY-1955-codex-lead-crash-loop/plan.md section 6."
    auth_dead_hold
    daemon_die "remote-control start failed (home: $HOME_DIR) (codex auth revoked — re-login required)"
  fi

  reap_zombie_daemon_if_proven
  case "$REAP_OUTCOME" in
    not_proven)
      daemon_die "remote-control start failed (home: $HOME_DIR) (stale-daemon evidence incomplete)"
      ;;
    action_stuck)
      emit_zombie_alert stuck "Updater identity changed, a signal failed, or the zombie was not reaped within 10s."
      daemon_die "remote-control start failed (home: $HOME_DIR) (stale-daemon recovery stuck)"
      ;;
    race_self_healed|reaped)
      # The bounded state machine authorizes exactly one retry. Exit 0 from the
      # CLI is insufficient: the socket must still exist after the command.
      if ! CODEX_INSTALL_DIR="$HOME_DIR/.local/bin" CODEX_HOME="$HOME_DIR" \
        "$codex_bin" remote-control start --json; then
        [ "$REAP_OUTCOME" = reaped ] \
          && emit_zombie_alert stuck "The one authorized remote-control retry failed."
        daemon_die "remote-control start failed after stale-daemon recovery (home: $HOME_DIR)"
      fi
      if [ ! -S "$sock" ]; then
        [ "$REAP_OUTCOME" = reaped ] \
          && emit_zombie_alert stuck "The retry exited 0 but the control socket is absent."
        daemon_die "daemon reported started after stale-daemon recovery but control socket missing: $sock"
      fi
      if [ "$REAP_OUTCOME" = reaped ]; then
        if assert_recovery_shape; then
          emit_zombie_alert recovered "Control socket, live daemon, and exactly one home-scoped updater verified."
        else
          # The Lead can run because the socket is present; preserve service and
          # page the incomplete postcondition rather than converting recovery
          # into another crash loop.
          emit_zombie_alert stuck "The control socket recovered, but updater/daemon postconditions are incomplete."
        fi
      fi
      clear_daemon_failcount
      log "daemon OK: $sock"
      return 0
      ;;
    *) daemon_die "internal error: unknown stale-daemon recovery outcome '$REAP_OUTCOME'" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [ -n "$HOME_DIR" ] || die "FLYWHEEL_CODEX_TUI_HOME is required"
  case "${1:-}" in
    ensure-home)   ensure_home ;;
    ensure-daemon) ensure_daemon ;;
    *) die "usage: $0 ensure-home|ensure-daemon" ;;
  esac
fi
