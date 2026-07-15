#!/bin/bash
# FLY-650: linux-preflight.sh — Linux / WSL2 provisioning preflight + evidence bundle.
#
# D3=B real-machine acceptance is gated by the founder running the provisioner on
# her own Linux + Windows(WSL2) boxes and reporting back. This script pre-empts
# the traps hermetic tests cannot cover (Codex R1#6) and PRINTS a copy-pasteable
# evidence bundle so debugging is grounded in real machine state, not chat guesses.
#
# Read-only + diagnostic: it INSTALLS nothing and CHANGES nothing. It never prints
# secret VALUES (only whether token keys are present). Always exits 0 (it is a
# report); a hard blocker is shown as [BLOCK] in the summary for the operator.
#
# FLY-648 (R1#4): OPT-IN `--check` mode for orchestrators (flywheel-setup.sh)
# that need a trustable exit code: hard blockers (systemd user manager unusable,
# checkout on /mnt/c, required commands missing, host-config parse failure)
# make it exit non-zero. WITHOUT the flag, behavior is byte-identical to before
# (always exit 0, diagnostic only).
set -uo pipefail

CHECK_MODE=0
for _arg in "$@"; do
  case "$_arg" in
    --check) CHECK_MODE=1 ;;
    -h|--help) echo "Usage: linux-preflight.sh [--check]"; exit 0 ;;
    *) echo "linux-preflight: unknown arg: $_arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# FLY-1062: a PACKAGED tree (this script's own tree root carries
# .flywheel-prebuilt) builds nothing on the customer machine — pnpm is not a
# requirement there, and requiring it would hard-fail packaged linux setup in
# --check mode. Self-derived (like the converger's repo-root): inherited env
# must not flip a preflight's requirements. Monorepo checkouts carry no
# sentinel → everything below is verbatim (packaged-seams.test.sh S9/S10).
PREBUILT_TREE=0
[ -f "$SCRIPT_DIR/../.flywheel-prebuilt" ] && PREBUILT_TREE=1
# host-config gives us the resolved FLYWHEEL_DIR / FLYWHEEL_STATE_DIR / backend.
HOSTCFG_FAIL=0
# shellcheck source=lib/host-config.sh
source "$SCRIPT_DIR/lib/host-config.sh" 2>/dev/null || true
host_config_load >/dev/null 2>&1 || HOSTCFG_FAIL=1

OK="  [ok]"; WARN="  [warn]"; MISS="  [MISSING]"; BLOCK="  [BLOCK]"
blocks=0
# --check-only counters (never change the printed report):
check_mntc=0; check_missing_cmds=0

h() { echo ""; echo "── $* ──"; }
have() { command -v "$1" >/dev/null 2>&1; }

# FLY-650 (Codex R1 LOW): bound a probe so a stuck CLI (e.g. `pnpm --version`
# wedging on a fresh HOME / corepack download) can't hang the whole evidence
# bundle. Prefer timeout/gtimeout; else a portable bg+kill fallback.
_bounded() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  "$@" &
  local p=$!
  ( sleep "$secs"; kill -9 "$p" 2>/dev/null ) >/dev/null 2>&1 &
  local w=$!
  wait "$p" 2>/dev/null; local rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return "$rc"
}

echo "================================================================"
echo " Flywheel Linux/WSL2 preflight — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo " (read-only; installs/changes nothing; never prints secret values)"
echo "================================================================"

h "1. OS / kernel / WSL"
echo "  uname: $(uname -srm 2>/dev/null)"
if [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null; echo "  distro: ${PRETTY_NAME:-unknown}"; fi
IS_WSL=0
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then IS_WSL=1; echo "  WSL: yes (WSL2 expected)"; else echo "  WSL: no"; fi
if [ "$(uname -s 2>/dev/null)" != "Linux" ]; then
  echo "$WARN this preflight targets Linux; current OS is $(uname -s). Run it on the Linux/WSL2 target."
fi

h "2. Package manager"
if have apt-get; then echo "$OK apt-get present"; elif have dnf; then echo "$OK dnf present";
else echo "$MISS no apt-get/dnf — install deps manually (see runbook)"; fi

h "3. systemd user manager (supervisor backend = ${FLYWHEEL_SUPERVISOR_BACKEND:-systemd-user})"
if have systemctl; then
  if systemctl --user show-environment >/dev/null 2>&1; then
    echo "$OK systemctl --user works (user manager running)"
  else
    echo "$BLOCK systemctl --user not working. On WSL2 set /etc/wsl.conf '[boot] systemd=true' then 'wsl --shutdown' from Windows; on a server ensure a user session/dbus."
    blocks=$((blocks+1))
  fi
else
  echo "$BLOCK systemctl not found — systemd required for the linux supervisor backend."
  blocks=$((blocks+1))
fi

h "4. Linger (boot-start + survive logout)"
if have loginctl; then
  if loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    echo "$OK lingering enabled for $USER"
  else
    echo "$WARN lingering NOT enabled — run: loginctl enable-linger \"\$USER\" (needs the right; on WSL2 it is usually permitted)"
  fi
else
  echo "$WARN loginctl not found — cannot verify lingering"
fi

h "5. User runtime bus"
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "${XDG_RUNTIME_DIR:-/nonexistent}" ]; then
  echo "$OK XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
else
  echo "$WARN XDG_RUNTIME_DIR unset/missing — systemctl --user may not reach the bus"
fi

h "6. Required commands + versions"
REQUIRED_CMDS="node pnpm git jq tmux gh"
[ "$PREBUILT_TREE" -eq 1 ] && REQUIRED_CMDS="node git jq tmux gh"
for c in $REQUIRED_CMDS; do
  if have "$c"; then
    ver="$(_bounded 8 "$c" --version 2>/dev/null | head -1)"
    if [ -n "$ver" ]; then echo "$OK $c: $ver"; else echo "$WARN $c: present but --version timed out/empty"; fi
  else
    echo "$MISS $c not found"
    check_missing_cmds=$((check_missing_cmds+1))
  fi
done
if [ "$PREBUILT_TREE" -eq 0 ]; then
  have corepack && echo "$OK corepack present (pnpm path)" || echo "$WARN corepack not found (pnpm may need manual install)"
fi

h "7. Checkout / state paths"
echo "  FLYWHEEL_DIR=${FLYWHEEL_DIR:-?}"
echo "  FLYWHEEL_STATE_DIR=${FLYWHEEL_STATE_DIR:-?}"
case "${FLYWHEEL_DIR:-}" in
  /mnt/c/*|/mnt/d/*)
    echo "$WARN checkout is on a Windows drive (/mnt/...). Install under the LINUX filesystem (e.g. \$HOME/Dev) for performance + correct permissions."
    check_mntc=1 ;;
esac
if [ "$PREBUILT_TREE" -eq 1 ]; then
  # packaged install: no git checkout exists by design — the runtime is the
  # installed payload this script ships inside of.
  echo "$OK flywheel 运行程序是安装包形态(无需代码仓)"
elif [ -d "${FLYWHEEL_DIR:-/nonexistent}/.git" ]; then
  echo "$OK flywheel checkout present"
else
  echo "$MISS flywheel checkout not at FLYWHEEL_DIR"
fi

h "8. Token file (presence only — NO values)"
ENVF="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/.env"
if [ -f "$ENVF" ]; then
  KCOUNT="$(grep -cE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$ENVF" 2>/dev/null || echo 0)"
  echo "$OK $ENVF present ($KCOUNT keys; values NOT shown)"
else
  echo "$MISS $ENVF not present — provision writes a placeholder; the founder fills real values"
fi

h "9. Auth state"
if have gh; then gh auth status >/dev/null 2>&1 && echo "$OK gh authenticated" || echo "$WARN gh not authenticated — run: gh auth login"; fi
[ -d "$HOME/.codex" ] && echo "$OK ~/.codex present (codex auth)" || echo "$WARN ~/.codex not present (codex login if using Codex leads)"
[ -d "$HOME/.claude" ] && echo "$OK ~/.claude present (claude auth)" || echo "$WARN ~/.claude not present (claude login)"

h "10. Network"
if have curl; then
  curl -fsS -m 5 https://discord.com/api/v10/gateway >/dev/null 2>&1 && echo "$OK discord.com reachable" || echo "$WARN discord.com not reachable (check network/proxy)"
fi

h "11. Paste-back commands (run on failure + send to the lead)"
echo "  systemctl --user status flywheel-bridge.service --no-pager"
echo "  journalctl --user -u flywheel-bridge.service -n 100 --no-pager"
echo "  systemctl --user list-units 'flywheel-*' --no-pager"
echo "  loginctl show-user \"\$USER\" | grep Linger"

echo ""
echo "================================================================"
if [ "$blocks" -gt 0 ]; then
  echo " SUMMARY: $blocks hard blocker(s) above [BLOCK] — resolve before provisioning."
else
  echo " SUMMARY: no hard blockers. Review [warn]/[MISSING] items, then provision."
fi
echo "================================================================"

# FLY-648 --check: trustable exit code for orchestrators. Hard blockers =
# [BLOCK] items + /mnt/c checkout + missing required commands + host-config
# parse failure. Default (no flag) stays byte-identical: exit 0, no extra line.
if [ "$CHECK_MODE" -eq 1 ]; then
  check_total=$(( blocks + check_mntc + check_missing_cmds + HOSTCFG_FAIL ))
  if [ "$check_total" -gt 0 ]; then
    echo " CHECK: FAIL ($check_total hard blocker(s) in --check mode)"
    exit 1
  fi
  echo " CHECK: PASS"
fi
exit 0
