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

log() { echo "[codex-lead-tui-home] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

HOME_DIR="${FLYWHEEL_CODEX_TUI_HOME:-}"
[ -n "$HOME_DIR" ] || die "FLYWHEEL_CODEX_TUI_HOME is required"

CONFIG="$HOME_DIR/config.toml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
READ_DENY_FRAGMENT="$SCRIPT_DIR/templates/codex-read-deny-profile.toml"

# FLY-260 read-deny mode (FLYWHEEL_CODEX_LEAD_READ_DENY=1): ATOMICALLY rewrite the
# config to a known-safe [permissions]-profile shape — preserving only the existing
# trusted [projects] (TOML-safe quoted) and GUARANTEEING no top-level sandbox_mode
# (Codex R2 #1: a lingering legacy sandbox_mode disables the profile). The legacy
# (flag-off) path is unchanged below. Validates the assembled config via tomllib
# before swapping it in (key+value: sandbox_mode absent, default_permissions, every
# filesystem rule == "deny", shell_environment_policy.exclude present, approval_policy).
write_read_deny_config() {
  local cwd="$1"
  [ -f "$READ_DENY_FRAGMENT" ] || die "read-deny fragment missing: $READ_DENY_FRAGMENT (build the teamlead package / check templates/)"
  local tmp
  tmp="$(mktemp "${HOME_DIR}/.config.toml.readdeny.XXXXXX")" || die "mktemp failed"
  # 1) the canonical read-deny shape (single source of truth).
  cat "$READ_DENY_FRAGMENT" > "$tmp"
  # 2) preserve existing trusted [projects] (TOML-safe) + ensure cwd is trusted.
  python3 - "$CONFIG" "$cwd" >> "$tmp" <<'PYPROJ' || die "read-deny: failed to assemble trusted [projects] (parser missing or unparseable existing config)"
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
trusted[cwd] = True  # always trust the Lead working dir (kills the boot trust menu)
out = ["", "# Trusted project dirs (preserved + cwd) — TOML-safe quoted keys."]
for path in trusted:
    out.append(f'[projects.{json.dumps(path)}]')
    out.append('trust_level = "trusted"')
print("\n".join(out))
PYPROJ
  # 3) validate the assembled config BEFORE swapping it in (fail-closed).
  python3 - "$tmp" <<'PYVAL' || { rm -f "$tmp"; die "read-deny config validation failed (effective values must be: NO top-level sandbox_mode; default_permissions=flywheel-lead-secret-deny; every [permissions.*.filesystem] rule == \"deny\"; [shell_environment_policy].exclude present; approval_policy=never)"; }
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
NAME = "flywheel-lead-secret-deny"
# The canonical contract (must match read-deny-profile.ts + the committed fragment).
# Codex code-review R1#2: validate the EXACT shape, not just "non-empty + all deny".
EXPECT_EXTENDS = ":read-only"
# FLY-350 code-review LOW-3: keep in sync with READ_DENY_ENV_EXCLUDE (read-deny-
# profile.ts) — the FLYWHEEL_LEAD_ACTIONS_* exclusion hides the broker coordinate
# from the model shell; a template drift dropping it must fail this validator.
EXPECT_ENV = {"*TOKEN*", "*SECRET*", "*KEY*", "FLYWHEEL_LEAD_ACTIONS_*"}
EXPECT_FS = {
    "~/.codex**", "~/.ssh", "~/.aws", "~/.config/gh", "~/.config/gcloud",
    "~/.npmrc", "~/.docker", "~/**/.env**",
}
if cfg.get("sandbox_mode") is not None:
    sys.exit(10)  # legacy pin present → would disable the profile (Gotcha A)
if cfg.get("default_permissions") != NAME:
    sys.exit(11)
if cfg.get("approval_policy") != "never":
    sys.exit(12)
# token-shaped env exclude must contain ALL THREE forms (not just one).
sep = cfg.get("shell_environment_policy", {})
if not isinstance(sep, dict):
    sys.exit(13)
excl = sep.get("exclude")
if not isinstance(excl, list) or not EXPECT_ENV.issubset(set(excl)):
    sys.exit(13)
prof = cfg.get("permissions", {}).get(NAME, {})
if not isinstance(prof, dict) or prof.get("extends") != EXPECT_EXTENDS:
    sys.exit(18)
fs = prof.get("filesystem", {})
if not isinstance(fs, dict):
    sys.exit(14)
# key+value: every filesystem rule must be exactly "deny" (no read/write slipped in).
for k, v in fs.items():
    if v != "deny":
        sys.exit(15)
# EXACT canonical key set — rejects a weakened (missing key) OR widened (extra deny
# outside the verified set, e.g. a blanket ~/.flywheel) filesystem map.
if set(fs.keys()) != EXPECT_FS:
    sys.exit(16)
sys.exit(0)
PYVAL
  mv "$tmp" "$CONFIG"
  log "config.toml written (read-deny profile + env exclude; no sandbox_mode)"
}

# FLY-350 — content-coordination profile: append the narrow lead-actions MCP
# server to config.toml (the daemon spawns it; it fetches the bot token over the
# parent runtime's broker socket — NO secret in this block). Idempotent because
# the caller appends AFTER every (re)write of the base config. Fail-loud on a
# missing coordinate so a half-configured MCP never silently no-ops.
append_lead_actions_mcp() {
  [ "${FLYWHEEL_CODEX_LEAD_PROFILE:-}" = "content-coordination" ] || return 0
  local main_js="${FLYWHEEL_LEAD_ACTIONS_MAIN_JS:-}"
  local sock="${FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET:-}"
  local node_bin="${FLYWHEEL_LEAD_ACTIONS_NODE_BIN:-node}"
  local lead_id="${FLYWHEEL_LEAD_ID:-}"
  local project="${FLYWHEEL_PROJECT_NAME:-}"
  local chat="${FLYWHEEL_LEAD_CHAT_CHANNEL_ID:-}"
  local cross="${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:-}"
  local state_dir="${FLYWHEEL_LEAD_ACTIONS_STATE_DIR:-}"
  local aliases="${FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES:-}"
  for pair in "FLYWHEEL_LEAD_ACTIONS_MAIN_JS=$main_js" \
    "FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET=$sock" "FLYWHEEL_LEAD_ID=$lead_id" \
    "FLYWHEEL_PROJECT_NAME=$project" "FLYWHEEL_LEAD_CHAT_CHANNEL_ID=$chat" \
    "FLYWHEEL_LEAD_ACTIONS_STATE_DIR=$state_dir"; do
    case "$pair" in *=) die "append_lead_actions_mcp: missing required env ${pair%=}" ;; esac
  done
  # Render env as a TOML inline table via python (handles quoting; NO secret here
  # — the bot token travels over the broker socket, never config.toml).
  local env_toml
  env_toml="$(python3 - "$lead_id" "$project" "$sock" "$chat" "$cross" "$state_dir" "$aliases" <<'PYENV'
import sys, json
keys = ["FLYWHEEL_LEAD_ID","FLYWHEEL_PROJECT_NAME","FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET",
        "FLYWHEEL_LEAD_CHAT_CHANNEL_ID","FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS",
        "FLYWHEEL_LEAD_ACTIONS_STATE_DIR","FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES"]
vals = sys.argv[1:8]
pairs = []
for k, v in zip(keys, vals):
    if k == "FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES" and not v:
        continue  # optional
    # defense-in-depth: never let a secret-shaped value into config
    pairs.append(f"{k} = {json.dumps(v)}")
print(", ".join(pairs))
PYENV
)" || die "append_lead_actions_mcp: failed to render env table"
  {
    printf '\n# FLY-350 content-coordination: narrow lead-actions MCP (secretless — token via broker)\n'
    printf '[mcp_servers.lead_actions]\n'
    printf 'command = %s\n' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$node_bin")"
    printf 'args = [%s]\n' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$main_js")"
    printf 'env = { %s }\n' "$env_toml"
  } >> "$CONFIG"
  log "config.toml: appended [mcp_servers.lead_actions] (content-coordination)"
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
    die "standalone codex install missing at $standalone — the remote-control daemon requires it. Install with: CODEX_HOME=$HOME_DIR sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' (then REVERT any shell-profile PATH edit the installer makes — see FLY-259 spike notes)"
  fi

  # FLY-260: read-deny mode rewrites the config to a [permissions]-profile shape
  # (replaces legacy steps 3+4). Auth + standalone (steps 1-2 above) still applied.
  if [ "${FLYWHEEL_CODEX_LEAD_READ_DENY:-}" = "1" ]; then
    write_read_deny_config "$cwd"
    append_lead_actions_mcp
    log "home OK (read-deny): $HOME_DIR"
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

  # NOTE: no append_lead_actions_mcp here — content-coordination REQUIRES read-deny
  # (enforced at runtime parse), so the lead-actions MCP block is only ever written
  # on the read-deny path above (which atomically rewrites the base config first →
  # idempotent). The non-read-deny path must never append (it would duplicate the
  # [mcp_servers.lead_actions] table on re-run — code-review MED-4).
  log "home OK: $HOME_DIR"
}

ensure_daemon() {
  # Code review R1 MED-6: default to the STANDALONE binary inside this home —
  # the daemon requires it, and a PATH `codex` (npm install) would fail forever
  # even on a correctly provisioned home. Explicit override stays possible.
  local codex_bin="${FLYWHEEL_CODEX_BIN:-$HOME_DIR/packages/standalone/current/codex}"
  [ -x "$codex_bin" ] || die "codex binary not executable: $codex_bin (standalone install missing? see ensure-home)"
  # FLY-260 (Codex R2 #2): under read-deny, a LONG-LIVED daemon would keep the OLD
  # config it read at start (the rewritten read-deny config wouldn't take effect),
  # so STOP it first to force a clean re-read on the next start. Best-effort (a
  # not-running daemon makes stop a no-op). Flag-OFF keeps the idempotent start-only
  # behavior (no daemon interruption on a normal restart — byte-compat).
  if [ "${FLYWHEEL_CODEX_LEAD_READ_DENY:-}" = "1" ]; then
    CODEX_HOME="$HOME_DIR" "$codex_bin" remote-control stop --json >/dev/null 2>&1 || true
    log "read-deny: stopped any running daemon so it re-reads the rewritten config"
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
