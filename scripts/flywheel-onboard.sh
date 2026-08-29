#!/usr/bin/env bash
# FLY-1023 M1: flywheel-onboard.sh — the ONE-COMMAND entry (curl|sh default
# shape; if the distribution shape changes later, only this skin changes —
# every mechanism below lives in the step CLI / providers / Buddy shell).
#
# What it does, in order (each phase resumable via the setup journal):
#   1. friendly environment checks (interactive terminal, supported OS,
#      network, git present) — plain words, no engineering vocabulary in
#      anything the user sees;
#   2. locate the Flywheel working copy (in-place when running from a
#      checkout; otherwise fetched to ~/Dev/flywheel);
#   3. base dependencies via the setup journal's preflight step;
#   4. the agent CLI via AgentCliProvider orchestration (detect → install →
#      login on the USER'S subscription → one smoke call) — the model_key
#      step under FLYWHEEL_AGENT_CLI_ORCHESTRATE=1; no keys collected;
#   5. hand the terminal to the Buddy shell (the conversation takes over).
#
# Failure discipline: each phase gets 2 attempts; the second failure writes a
# sanitized human-handoff summary (scripts/lib/buddy-escalate.sh) and stops
# with a plain-words message. Re-running resumes from the journal.
set -uo pipefail

# ── resolve the working copy ────────────────────────────────────────────────
# Running from a checkout (dev / re-run): use it. Running from a pipe
# (curl|sh): fetch to FLYWHEEL_ONBOARD_ROOT (default ~/Dev/flywheel).
FO_ROOT=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  _fo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$_fo_dir/flywheel-setup.sh" ] && FO_ROOT="$(cd "$_fo_dir/.." && pwd)"
fi
FO_ROOT="${FLYWHEEL_ONBOARD_ROOT:-$FO_ROOT}"
FO_REPO_URL="${FLYWHEEL_ONBOARD_REPO:-https://github.com/xrliAnnie/flywheel.git}"

fo_say()  { printf '%s\n' "$*" >&2; }          # user-facing (plain words)
fo_die()  { fo_say "$*"; exit 1; }

# ── identity flags: passed through to the step CLI + Buddy shell ────────────
FO_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--department|--cos-persona|--eng-persona|--linear-team|--project-slug|--skills-repo|--state-dir)
      FO_ARGS+=("$1" "${2:?$1 needs a value}"); shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: flywheel-onboard.sh [--project <name>] [--department <slug>]
         [--cos-persona <n>] [--eng-persona <n>] [--linear-team <KEY>]
         [--project-slug <owner/repo>] [--skills-repo <slug>] [--state-dir <dir>]
One command: checks your machine, installs what's needed, signs you into
your own AI subscription, then hands you to Buddy to finish setup together.
EOF
      exit 0 ;;
    *) fo_die "抱歉,我不认识这个选项:$1(用 --help 看看有哪些)" ;;
  esac
done

FO_STATE_DIR="${FLYWHEEL_SETUP_STATE_DIR:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}}"
# the phase log lands under the state dir — make sure it exists (owner-only)
# before the first phase writes to it.
mkdir -p "$FO_STATE_DIR" 2>/dev/null
chmod go-w "$FO_STATE_DIR" 2>/dev/null || true

# ── 1. friendly environment checks ──────────────────────────────────────────
if [ ! -r /dev/tty ] && [ "${FLYWHEEL_ONBOARD_NONINTERACTIVE:-0}" != "1" ]; then
  fo_die "请在一个真正的终端窗口里运行我(现在这个环境没法跟你互动)。"
fi
case "$(uname -s)" in
  Darwin|Linux) : ;;
  *) fo_die "目前支持 Mac 和 Linux(含 WSL2)。你现在的系统我还搞不定,抱歉!" ;;
esac
command -v git >/dev/null 2>&1 \
  || fo_die "需要先装 git(Mac:先装 Xcode 命令行工具,运行 xcode-select --install;Ubuntu:sudo apt-get install -y git),装好后再运行一次这条命令。"
if [ "${FLYWHEEL_ONBOARD_SKIP_NET:-0}" != "1" ]; then
  command -v curl >/dev/null 2>&1 \
    || fo_die "需要先装 curl,装好后再运行一次这条命令。"
  curl -fsS -m 10 -o /dev/null https://api.github.com 2>/dev/null \
    || fo_die "现在连不上网(或 github.com 不可达)。检查一下网络,再运行一次这条命令就好。"
fi

# ── 2. fetch the working copy when not already in one ───────────────────────
if [ -z "$FO_ROOT" ]; then
  FO_ROOT="$HOME/Dev/flywheel"
  if [ ! -f "$FO_ROOT/scripts/flywheel-setup.sh" ]; then
    fo_say "正在下载安装文件(只需要这一次)…"
    mkdir -p "$(dirname "$FO_ROOT")"
    git clone --depth 1 "$FO_REPO_URL" "$FO_ROOT" >&2 2>&1 \
      || fo_die "下载没成功。检查一下网络,再运行一次这条命令(会从头接着来,不会丢进度)。"
  fi
fi
[ -f "$FO_ROOT/scripts/flywheel-buddy-steps.sh" ] \
  || fo_die "安装文件不完整($FO_ROOT)。删掉这个文件夹再运行一次这条命令。"

# shellcheck source=lib/buddy-escalate.sh
source "$FO_ROOT/scripts/lib/buddy-escalate.sh"

# ── phase runner: 2 attempts → sanitized human handoff ──────────────────────
# fo_phase <phase-id> <friendly-label> <cmd...>
fo_phase() {
  local id="$1" label="$2"; shift 2
  local attempt out rc
  for attempt in 1 2; do
    out="$("$@" 2>>"$FO_STATE_DIR/buddy-steps.log")"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      fo_say "✓ $label"
      return 0
    fi
    [ "$attempt" -eq 1 ] && fo_say "「${label}」第一次没成功,我再试一次…"
  done
  local ec hint
  ec="$(jq -r '.error_code // "phase_failed"' <<<"$out" 2>/dev/null)"
  hint="$(jq -r '.hint // empty' <<<"$out" 2>/dev/null)"
  local summary
  summary="$(buddy_escalate "$FO_STATE_DIR" "$id" "${ec:-phase_failed}" "${hint:-}")" || summary=""
  fo_say ""
  fo_say "「${label}」这一步我试了两次都没成功,先停在这里。"
  fo_say "已经把情况整理好了$([ -n "$summary" ] && printf '(%s)' "$summary"),把这个文件发给我们的支持同学,他们会帮你接着弄。"
  fo_say "问题解决后,再运行一次这条命令,会从这里接着继续,前面的进度都在。"
  exit 1
}

STEPS_CLI="$FO_ROOT/scripts/flywheel-buddy-steps.sh"

fo_say ""
fo_say "你好!我是 Buddy,接下来我陪你把你的 AI 团队搭起来。先做两件准备工作:"
fo_say ""

# ── 3. base dependencies (journal step: preflight) ──────────────────────────
fo_phase preflight "把需要的基础软件装齐" \
  bash "$STEPS_CLI" "${FO_ARGS[@]}" run preflight

# ── 4. the agent CLI (journal step: model_key, orchestrated) ────────────────
fo_phase model_key "装好 AI 助手并登录你自己的账号" \
  env FLYWHEEL_AGENT_CLI_ORCHESTRATE=1 FLYWHEEL_AGENT_CLI="${FLYWHEEL_AGENT_CLI:-claude}" \
  bash "$STEPS_CLI" "${FO_ARGS[@]}" run model_key

# ── 5. hand over to the Buddy shell ─────────────────────────────────────────
FO_BUDDY_SHELL="${FLYWHEEL_BUDDY_SHELL:-$FO_ROOT/scripts/flywheel-buddy.sh}"
[ -f "$FO_BUDDY_SHELL" ] \
  || fo_die "对话程序还没就位($FO_BUDDY_SHELL)。这不该发生——把这句话发给支持同学。"
fo_say ""
fo_say "准备工作完成,接下来我们边聊边搭。"
exec bash "$FO_BUDDY_SHELL" "${FO_ARGS[@]}"
