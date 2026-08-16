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
if [ "${BASH_VERSINFO:-0}" -lt 4 ]; then
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
[ -n "$HOME_DIR" ] || die "FLYWHEEL_CODEX_TUI_HOME is required"

CONFIG="$HOME_DIR/config.toml"

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
    die "standalone codex install missing at $standalone — the remote-control daemon requires it. Install with: CODEX_HOME=$HOME_DIR sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' (then REVERT any shell-profile PATH edit the installer makes AND restore the neutral global ~/.local/bin/codex symlink — see FLY-259 spike notes + FLY-513)"
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

ensure_daemon() {
  # Code review R1 MED-6: default to the STANDALONE binary inside this home —
  # the daemon requires it, and a PATH `codex` (npm install) would fail forever
  # even on a correctly provisioned home. Explicit override stays possible.
  local codex_bin="${FLYWHEEL_CODEX_BIN:-$HOME_DIR/packages/standalone/current/codex}"
  [ -x "$codex_bin" ] || die "codex binary not executable: $codex_bin (standalone install missing? see ensure-home)"
  # FLY-398 (pin ⑤): full-access needs stop-before-start — a stale read-only
  # daemon would keep its old read-only sandbox/config/MCP and never re-read the
  # rewritten workspace-write config (a flip would silently keep Mufasa read-only).
  if [ "${FLYWHEEL_CODEX_LEAD_PROFILE:-}" = "full-access" ]; then
    CODEX_HOME="$HOME_DIR" "$codex_bin" remote-control stop --json >/dev/null 2>&1 || true
    log "stopped any running daemon so it re-reads the full-access config"
  fi
  # `remote-control start` is idempotent (spike-verified: already-running →
  # status connected). Fail-loud otherwise — the supervisor retries with backoff.
  CODEX_HOME="$HOME_DIR" "$codex_bin" remote-control start --json \
    || die "remote-control start failed (home: $HOME_DIR)"
  local sock="$HOME_DIR/app-server-control/app-server-control.sock"
  [ -S "$sock" ] || die "daemon reported started but control socket missing: $sock"
  log "daemon OK: $sock"
}

case "${1:-}" in
  ensure-home)   ensure_home ;;
  ensure-daemon) ensure_daemon ;;
  *) die "usage: $0 ensure-home|ensure-daemon" ;;
esac
