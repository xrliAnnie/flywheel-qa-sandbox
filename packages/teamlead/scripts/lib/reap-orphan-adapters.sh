#!/bin/bash
# FLY-183: Reap orphaned Discord channel adapter processes.
#
# Background: each Claude Code agent launched with `--channels plugin:discord`
# spawns a Discord channel adapter (an MCP stdio server holding the agent's
# bot-token Discord gateway connection). On Lead resume/restart the OLD adapter
# is not reaped -> it becomes an orphan (reparented to launchd, ppid==1) that
# still holds the bot-token gateway connection. Orphans accumulate and contend
# for Discord's per-bot gateway/identify limit, so the live agent's new adapter
# cannot connect and inbound DMs are silently lost.
#
# This library is meant to be `source`d by claude-lead.sh (it defines functions
# and does not change the caller's shell options). It can also be run standalone
# for dry-run judge verification:
#
#   FLY183_REAP_DRY_RUN=1 bash lib/reap-orphan-adapters.sh   # list, do not kill
#   bash lib/reap-orphan-adapters.sh                          # reap for real
#
# KILL GATE (destructive predicate): a process is reaped iff
#   (A) it is a Discord plugin adapter (3 argv shapes, see _is_discord_adapter), AND
#   (B) its ppid == 1 (reparented to launchd -> its parent claude/wrapper died).
# ppid==1 guarantees we never touch a LIVE agent's adapter (those always have a
# live direct parent, ppid!=1). Scope = ALL discord orphans (FLY-183 Q4), i.e.
# Leads AND personal agents -- they all hold a bot connection. Identity inference
# (lsof open-files) is LOG-ONLY (non-Flywheel orphans get a WARNING) and never
# affects whether a process is reaped.
#
# Compatibility: production runs under /bin/bash 3.2 with `set -euo pipefail`,
# so this file (1) uses no bash-4 features, (2) never sets shell options at
# source time, and (3) makes the public functions fail-open by saving/restoring
# errexit and guarding every command -- a reap failure must never abort the
# caller (which would block Lead launch).

# ── Fallback logger (claude-lead.sh defines `log`; standalone does not) ──
if ! declare -f log >/dev/null 2>&1; then
  log() { echo "[reap-adapter] $(date '+%H:%M:%S') $*" >&2; }
fi

# Recognized Flywheel Lead state-dir slugs (identity LABEL only, NOT a kill gate).
# Space-separated case globs; override via FLY183_FLYWHEEL_SLUGS.
: "${FLY183_FLYWHEEL_SLUGS:=discord-product-lead discord-ops-lead discord-cos-lead discord-cos discord-*test-slot* discord-flywheel-* discord-test-*}"

_fly183_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if [ -r "${_fly183_repo_root}/scripts/lib/kill-ledger.sh" ]; then
  # shellcheck source=scripts/lib/kill-ledger.sh
  source "${_fly183_repo_root}/scripts/lib/kill-ledger.sh"
else
  flywheel_audited_signal() {
    log "FLY-183: kill ledger helper unavailable; signal refused"
    return 1
  }
fi

# Process-table seam (overridable for hermetic tests so they never touch the
# real process table). Emits lines: "<pid> <ppid> <command...>".
#
# Codex R2 HIGH: FLY183_PS_OVERRIDE is a TEST-ONLY injection point. A real
# destructive run MUST read the live kernel process table, never a string that
# could be forged or leaked into a Lead launch environment. So the override is
# honored ONLY when (a) we are in dry-run (which never kills), or (b) the test
# harness has set the explicit opt-in FLY183_TEST_ALLOW_OVERRIDE=1. In every
# other case (i.e. a production destructive reap) we ignore the override and
# read real `ps`, so a leaked override can never trick the reaper into killing a
# live adapter. The per-target kill gate (_reap_target_is_live_orphan) revalidates
# against real `ps` regardless, as a second, independent line of defense.
_reap_ps_snapshot() {
  if [ -n "${FLY183_PS_OVERRIDE:-}" ] && \
     { [ "${FLY183_REAP_DRY_RUN:-0}" = "1" ] || [ "${FLY183_TEST_ALLOW_OVERRIDE:-0}" = "1" ]; }; then
    eval "${FLY183_PS_OVERRIDE}"
  else
    ps axww -o pid= -o ppid= -o command= 2>/dev/null
  fi
}

# True if the string (argv or cwd) points at the discord plugin in the legacy
# official cache/marketplace layouts or the FLY-1676 pointer marketplace cache.
#
# Codex R2 MEDIUM: match the `discord` segment at an exact directory boundary
# (the dir itself or something inside it). The old `external_plugins/discord*`
# glob also matched siblings like `external_plugins/discord-backup`, widening the
# destructive-kill surface to unrelated dirs. Both install layouts get the same
# exact-dir + inside-dir boundary treatment.
_is_discord_path() {
  case "$1" in
    */claude-plugins-official/discord) return 0 ;;
    */claude-plugins-official/discord/*) return 0 ;;
    */claude-plugins-official/external_plugins/discord) return 0 ;;
    */claude-plugins-official/external_plugins/discord/*) return 0 ;;
    */flywheel-plugins/discord) return 0 ;;
    */flywheel-plugins/discord/*) return 0 ;;
  esac
  return 1
}

# ── Token-aware argv parsing (Codex R4): never glob the WHOLE command string ──
# R2→R4 hit a whack-a-mole: every time we narrowed `_is_discord_path "$wholeCmd"`
# we leaked an edge (discord-backup matched; then the marketplace `--cwd <dir>`
# wrapper stopped matching because the dir is followed by a SPACE not `/`). Root
# cause: matching argv shape with whole-string globs is wrong. Instead, isolate
# the RELEVANT argv token (the `--cwd` value, the `server.ts`/`start-adapter.sh`
# path) and check THAT token's path with _is_discord_path. Globbing is disabled
# while word-splitting so a `*` in argv can't expand.

# Echo the value of `--cwd <path>` or `--cwd=<path>` in command string $1 (empty
# if absent).
_extract_cwd_arg() {
  local cmd="$1" tok prev="" out="" had_f=0
  case $- in *f*) had_f=1 ;; esac
  set -f
  for tok in $cmd; do
    case "$tok" in
      --cwd=*) out="${tok#--cwd=}"; break ;;
    esac
    [ "$prev" = "--cwd" ] && { out="$tok"; break; }
    prev="$tok"
  done
  [ "$had_f" = 0 ] && set +f
  printf '%s' "$out"
}

# True iff some argv token in $1 is an ABSOLUTE path ending in `/<basename>` ($2)
# whose PARENT directory is a discord plugin dir. Checks each token's directory
# with _is_discord_path -- so `/abs/.../discord/server.ts` matches but a sibling
# `.../discord-backup/server.ts` or an out-of-plugin `/tmp/x/server.ts` does not.
#
# Codex R5 MEDIUM: the token MUST be absolute (leading `/`). The real adapter is
# always launched with an absolute path (start-adapter.sh: `exec bun "$DIR/server.ts"`
# with `$DIR="$(cd .. && pwd)"`), so the `/*/<base>` glob both matches every real
# shape AND rejects a relative `rel/.../discord/server.ts` or an option-value
# token like `--entry=/.../discord/server.ts` (whose leading `-`/`r` is not `/`).
_has_discord_entry_token() {
  local cmd="$1" base="$2" tok rc=1 had_f=0
  case $- in *f*) had_f=1 ;; esac
  set -f
  for tok in $cmd; do
    case "$tok" in
      /*/"$base") _is_discord_path "${tok%/*}" && { rc=0; break; } ;;
    esac
  done
  [ "$had_f" = 0 ] && set +f
  return $rc
}

# Echo a process's cwd via lsof (empty if lsof unavailable or unreadable).
_adapter_cwd() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

# Whitelist of the EXACT Discord-adapter launch shapes. A process is reaped only
# if its argv matches ONE of these (each verified by parsing the RELEVANT argv
# token with _is_discord_path -- never a whole-command-string glob). Enumerated,
# not hole-plugged:
#   A. Direct inner (current start-adapter.sh runtime):
#        bun  <abs-discord>/server.ts
#   B. Legacy wrapper (cache `.../discord/<ver>` OR marketplace `.../external_plugins/discord`):
#        bun run --cwd <abs-discord-dir> [flags] start
#   C. Legacy relative inner (path only knowable from the live cwd):
#        bun server.ts          (BARE token; cwd must be a discord dir, via lsof)
#   D. Transient launcher:
#        bash <abs-discord>/start-adapter.sh   |   <abs-discord>/start-adapter.sh
# argv[0] must be the LAUNCHED program (bun/*/bun, a shell, or the script path),
# never merely a word later in argv -- so `--bun`, `/Users/bun/...`, `node --bun`,
# editors/pagers, and `bun test .../discord/server.test.ts` are all rejected. The
# kill is destructive and runs near live production processes; the matcher must
# match only the real adapter, no more and no less.
_is_discord_adapter() {
  local cmd="$2" first cwd

  first="${cmd%% *}"

  # D. Launcher. argv[0] is an ABSOLUTE `/abs/.../start-adapter.sh` (Codex R5:
  # leading `/` required -- a relative `rel/.../start-adapter.sh` is never how the
  # MCP host launches it), or a shell with an absolute start-adapter.sh argument.
  case "$first" in
    /*/start-adapter.sh)                          # direct exec: argv[0] is the script
      _is_discord_path "${first%/*}" && return 0 ;;
    bash|sh|*/bash|*/sh)                          # interpreter + a start-adapter.sh arg
      _has_discord_entry_token "$cmd" "start-adapter.sh" && return 0 ;;
  esac

  # A / B / C all require argv[0] to BE bun (`bun` or a path ending `/bun`).
  case "$first" in
    bun|*/bun) ;;
    *) return 1 ;;
  esac

  # B. Legacy wrapper: `bun run --cwd <discord-dir> ... start`. Parse --cwd token.
  # The --cwd value MUST be an absolute path (Codex R5: the real wrapper always
  # passed an absolute --cwd; a relative `--cwd rel/.../discord` is not a real shape).
  case " $cmd " in
    *" run "*)
      case "$cmd" in
        *" start")
          cwd="$(_extract_cwd_arg "$cmd")"
          case "$cwd" in /*) _is_discord_path "$cwd" && return 0 ;; esac
          ;;
      esac
      ;;
  esac

  # A. Direct inner: an absolute `<abs-discord>/server.ts` token.
  _has_discord_entry_token "$cmd" "server.ts" && return 0

  # C. Legacy relative inner: a BARE `server.ts` token (no path) -> the path is
  # only knowable from the live cwd, which must be a discord dir. An ABSOLUTE
  # `/server.ts` is handled by shape A above and must NOT reach here, else a
  # non-plugin abs server.ts launched from the discord cwd would false-match.
  case " $cmd " in
    *" server.ts "*)
      cwd="$(_adapter_cwd "$1")"                  # lsof cwd is absolute; assert it
      case "$cwd" in /*) _is_discord_path "$cwd" && return 0 ;; esac
      ;;
  esac

  return 1
}

# Print the pid of every ppid==1 discord adapter (one per line).
_list_orphan_adapters() {
  local pid ppid rest
  _reap_ps_snapshot | while read -r pid ppid rest; do
    [ "$ppid" = "1" ] || continue
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if _is_discord_adapter "$pid" "$rest"; then
      printf '%s\n' "$pid"
    fi
  done
}

# Echo all descendants of pid ($1), deepest-first (so callers can TERM leaves
# before their parents).
_collect_descendants() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do
    _collect_descendants "$c"
    echo "$c"
  done
}

# Best-effort identity LABEL for a still-live orphan (call BEFORE kill -- once
# the process exits lsof can no longer read its open files). The adapter opens
# its DISCORD_STATE_DIR (~/.claude/channels/discord-<slug>/...); we grep that
# slug from its open files. Returns: "flywheel:<slug>" | "NONFLYWHEEL:<slug>" |
# "UNIDENTIFIED". Inference failure -> UNIDENTIFIED is a NORMAL path (the adapter
# may not hold state files open continuously); it never affects the kill.
_identity_label() {
  command -v lsof >/dev/null 2>&1 || { echo "UNIDENTIFIED"; return 0; }
  local slug g
  slug="$(lsof -p "$1" 2>/dev/null | grep -oE 'channels/discord-[A-Za-z0-9._-]+' | sed 's#channels/##' | head -1)"
  if [ -z "$slug" ]; then echo "UNIDENTIFIED"; return 0; fi
  for g in $FLY183_FLYWHEEL_SLUGS; do
    case "$slug" in $g) echo "flywheel:$slug"; return 0 ;; esac
  done
  echo "NONFLYWHEEL:$slug"
}

# Live revalidation gate (Codex R2 HIGH). Called immediately before EVERY
# destructive signal. Reads the REAL kernel process table for THIS pid (always
# direct `ps -p`, never the FLY183_PS_OVERRIDE test seam) and confirms the
# process is STILL a ppid==1 discord adapter. This defeats two hazards that the
# one-shot discovery snapshot cannot:
#   (1) the matched orphan exited and the PID was reused by an unrelated LIVE
#       process between discovery and the kill;
#   (2) a leaked/forged FLY183_PS_OVERRIDE that lies about ppid/argv -- this gate
#       trusts only the live kernel view, so a forged snapshot can never make us
#       signal a process that is not actually a ppid==1 adapter right now.
# Returns 0 (signal permitted) iff live ppid==1 AND live argv is a discord adapter.
_reap_target_is_live_orphan() {
  local pid="$1" ppid cmd
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  [ "$ppid" = "1" ] || return 1
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
  [ -n "$cmd" ] || return 1
  _is_discord_adapter "$pid" "$cmd"
}

# Reap all orphaned discord adapters. Fail-open: never aborts the caller.
# Honors FLY183_REAP_DRY_RUN=1 (list only, no kill).
reap_orphan_adapters() {
  # Save + disable errexit so a single failing command can't abort the caller
  # (claude-lead.sh runs under `set -e`). Restore on exit.
  local _had_e=0; case $- in *e*) _had_e=1 ;; esac
  set +e

  local dry="${FLY183_REAP_DRY_RUN:-0}" pid label cmd d n=0
  local targets=""
  # Collect targets first (single snapshot) so labeling/kill act on a stable set.
  while read -r pid; do
    [ -n "$pid" ] && targets="$targets $pid" && n=$((n + 1))
  done < <(_list_orphan_adapters)

  if [ "$n" -eq 0 ]; then
    [ "$dry" = "1" ] && log "FLY-183[dry-run]: 0 orphan adapter(s) matched"
    [ "$_had_e" = "1" ] && set -e
    return 0
  fi

  for pid in $targets; do
    label="$(_identity_label "$pid")"                                   # BEFORE kill (lsof needs live proc)
    cmd="$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-90)"
    if [ "$dry" = "1" ]; then
      log "FLY-183[dry-run]: WOULD reap pid=$pid label=$label :: $cmd"
      continue
    fi
    # Codex R2 HIGH: re-confirm against the LIVE process table immediately before
    # any destructive signal. Skip if the pid is no longer a ppid==1 adapter
    # (exited + PID reuse, or a forged/leaked override snapshot).
    if ! _reap_target_is_live_orphan "$pid"; then
      log "FLY-183: skip pid=$pid -- not a live ppid==1 adapter at signal time (stale/forged target)"
      continue
    fi
    for d in $(_collect_descendants "$pid"); do
      flywheel_audited_signal "orphan_adapter_reaper" "SIGTERM" "pid" "$d" "" "discord_adapter_descendant" || true
    done
    flywheel_audited_signal "orphan_adapter_reaper" "SIGTERM" "pid" "$pid" "" "discord_adapter_orphan" || true
    case "$label" in
      NONFLYWHEEL:*|UNIDENTIFIED)
        log "WARNING FLY-183: reaped non-Flywheel/unidentified orphan adapter ($label) pid=$pid :: $cmd" ;;
      *)
        log "FLY-183: reaped orphan adapter ($label) pid=$pid" ;;
    esac
  done

  if [ "$dry" = "1" ]; then
    log "FLY-183[dry-run]: $n orphan adapter(s) matched, none killed"
    [ "$_had_e" = "1" ] && set -e
    return 0
  fi

  # Grace for server.ts SIGTERM handler (client.destroy), then SIGKILL survivors.
  # Codex R2 HIGH: revalidate each survivor against the LIVE table before KILL too
  # (closes the same exit/PID-reuse window for the harder SIGKILL signal).
  sleep 1
  while read -r pid; do
    [ -n "$pid" ] || continue
    _reap_target_is_live_orphan "$pid" || continue
    if kill -0 "$pid" 2>/dev/null; then
      flywheel_audited_signal "orphan_adapter_reaper" "SIGKILL" "pid" "$pid" "" "discord_adapter_orphan_escalation" || true
      log "FLY-183: KILL survivor orphan adapter pid=$pid"
    fi
  done < <(_list_orphan_adapters)

  [ "$_had_e" = "1" ] && set -e
  return 0
}

# Standalone execution: run a reap (respects FLY183_REAP_DRY_RUN).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  reap_orphan_adapters
fi
