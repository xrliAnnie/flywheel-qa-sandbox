#!/usr/bin/env bash
# FLY-1023 M2+M7: flywheel-buddy.sh — the Buddy shell.
#
# A thin foreground REPL that OWNS the terminal: it prints all user-facing
# wording (copy templates under scripts/buddy/copy/), drives execution step
# by step through the machine-readable step CLI (flywheel-buddy-steps.sh),
# and delegates ONLY natural-language work (free-text parsing, free-form
# replies) to a headless "brain" — the user's own agent CLI via the
# AgentCliProvider seam. The step order is a DETERMINISTIC state machine in
# this file; the brain never decides what runs next (PRD FLY-910 §0.4 risk 1).
#
# Buddy steps (PRD step 0–8) → underlying journal steps:
#   b0 base       → preflight, model_key   (normally done by the bootstrap)
#   b1 welcome    → (copy only)
#   b2 tools      → skeleton (silent), bots, channels, linear, github*
#   b3 first task → brain parse → buddy state (no journal steps)
#   b4 team       → config
#   b5 early chat → Captain preview (helper lib; honest skip when absent)
#   b6 JIT        → business-system connectors (helper lib; honest skip)
#   b7 placement  → services, finish, digest
#   b8 first output → (copy handoff)
#   (*) steps not known to the step CLI yet are skipped honestly — later
#       milestones add them without touching this state machine.
#
# RED LINES (mechanical, PRD §5):
#   - jargon: every user-visible string lives in copy templates or fb_say
#     literals — the jargon lint test asserts the blacklist over both, and
#     over a captured full-run transcript;
#   - secrets: hidden input happens INSIDE step processes (fs_ask_secret on
#     /dev/tty); the brain's input is user-visible text only, and even that
#     is secret-scanned before leaving this process (paste-accident guard);
#   - escalation: 2 failures on the same step, or a clearly-confused user,
#     offers the human handoff (buddy-escalate.sh); escalated state resumes
#     after a human clears the flag.
set -uo pipefail

FB_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FB_COPY_DIR="$FB_SCRIPT_DIR/buddy/copy"
FB_PROMPTS_DIR="$FB_SCRIPT_DIR/buddy/brain-prompts"
FB_PERSONA="$FB_SCRIPT_DIR/buddy/persona.md"
FB_STEPS_CLI="${FLYWHEEL_BUDDY_STEPS_BIN:-$FB_SCRIPT_DIR/flywheel-buddy-steps.sh}"
FB_PROVIDER_DIR="${FLYWHEEL_AGENT_CLI_PROVIDER_DIR:-$FB_SCRIPT_DIR/lib/agent-cli-providers}"
# optional-capability helper libs (land in later milestones; absent = honest
# skip). Env seams keep hermetic tests pinned to a known capability set.
FB_PREVIEW_LIB="${FLYWHEEL_BUDDY_PREVIEW_LIB:-$FB_SCRIPT_DIR/lib/buddy-captain-preview.sh}"
FB_CONNECT_LIB="${FLYWHEEL_BUDDY_CONNECT_LIB:-$FB_SCRIPT_DIR/lib/buddy-connect.sh}"

# shellcheck source=lib/buddy-escalate.sh
source "$FB_SCRIPT_DIR/lib/buddy-escalate.sh"
# (buddy-escalate sources fleet-sanitize → scan_string_for_secrets available)

# ── identity args (passed through to every step CLI call) ───────────────────
FB_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--department|--cos-persona|--eng-persona|--linear-team|--project-slug|--skills-repo|--state-dir)
      [ "$1" = "--state-dir" ] && FLYWHEEL_SETUP_STATE_DIR="${2:?}"
      FB_ARGS+=("$1" "${2:?$1 needs a value}"); shift 2 ;;
    *) echo "[buddy] unknown option: $1" >&2; exit 2 ;;
  esac
done
FB_STATE_DIR="${FLYWHEEL_SETUP_STATE_DIR:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}}"

# ── talk / listen ────────────────────────────────────────────────────────────
fb_say()  { printf '%s\n' "$*"; }
fb_gap()  { printf '\n'; }

fb_bye() {
  fb_gap
  fb_say "好,先到这儿 —— 进度都存着,想继续再运行一次这条命令就行。"
  exit 0
}

# fb_ask <prompt> — one line from the human into $FB_INPUT (NEVER call inside
# a command substitution: EOF handling exits the whole shell). TTY when we
# have one; stdin otherwise (hermetic tests pipe a conversation).
FB_INPUT=""
fb_ask() {
  local prompt="$1"
  if [ -r /dev/tty ] && [ "${FLYWHEEL_BUDDY_NONINTERACTIVE:-0}" != "1" ]; then
    printf '%s ' "$prompt" > /dev/tty
    IFS= read -r FB_INPUT < /dev/tty || fb_bye
  else
    printf '%s ' "$prompt"
    IFS= read -r FB_INPUT || fb_bye
    printf '\n'
  fi
}

# fb_copy <template> [KEY=VALUE ...] — print a copy template with {{KEY}}
# substitution. Missing template = build bug, fail loud.
fb_copy() {
  local tpl="$FB_COPY_DIR/$1.md"; shift
  [ -f "$tpl" ] || { echo "[buddy] missing copy template: $tpl" >&2; exit 1; }
  local text kv k v
  text="$(cat "$tpl")"
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    text="${text//\{\{$k\}\}/$v}"
  done
  printf '%s\n' "$text"
}

# ── step CLI plumbing ────────────────────────────────────────────────────────
fb_steps() { bash "$FB_STEPS_CLI" "${FB_ARGS[@]}" "$@"; }

FB_KNOWN_STEPS=""
fb_step_known() {
  [ -n "$FB_KNOWN_STEPS" ] || FB_KNOWN_STEPS="$(fb_steps steps 2>/dev/null | jq -r '.steps[]?' 2>/dev/null | tr '\n' ' ')"
  case " $FB_KNOWN_STEPS " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

fb_state_get() { fb_steps state get "$1" 2>/dev/null | jq -r '.value | if type=="object" or type=="array" or type=="null" then empty else tostring end' 2>/dev/null; }
fb_state_get_json() { fb_steps state get "$1" 2>/dev/null | jq -c '.value // null' 2>/dev/null; }
fb_state_set() { fb_steps state set "$1" "$2" >/dev/null 2>&1; }

# fb_run_step <step-id> — one underlying step; prints NOTHING (caller owns
# all wording). Echoes the result JSON; returns the CLI's exit code.
fb_run_step() { fb_steps run "$1" 2>>"$FB_STATE_DIR/buddy-steps.log"; }

# fb_run_guarded <step-id> <friendly-label> [extra-env...]
# The escalation ladder (spec §4) for REQUIRED steps: failure 1 → plain-words
# error + retry; failure 2 → offer the human handoff; decline → keep trying.
# This function only ever RETURNS on success — a required step can never be
# silently passed over (the cursor must not advance past missing
# infrastructure, Codex R1#1). "跳过" pauses the whole run with progress kept
# (resume re-enters the same buddy step); escalation exits via the ladder.
fb_run_guarded() {
  local id="$1" label="$2"; shift 2
  local fails=0 out rc
  while :; do
    if [ "$#" -gt 0 ]; then
      out="$(env "$@" bash "$FB_STEPS_CLI" "${FB_ARGS[@]}" run "$id" 2>>"$FB_STATE_DIR/buddy-steps.log")"
    else
      out="$(fb_run_step "$id")"
    fi
    rc=$?
    if [ "$rc" -eq 0 ]; then return 0; fi
    fails=$((fails+1))
    FB_LAST_ERROR_CODE="$(jq -r '.error_code // "step_failed"' <<<"$out" 2>/dev/null)"
    FB_LAST_HINT="$(jq -r '.hint // empty' <<<"$out" 2>/dev/null)"
    fb_gap
    if [ "$fails" -lt 2 ]; then
      fb_say "「${label}」这步没成功 —— 多半是刚才某个东西贴错了或还没弄完。咱们回头看一眼,弄好了再试一次。"
      fb_ask "(回车重试,输入「跳过」先停在这里)"
      case "$FB_INPUT" in
        跳过|skip)
          fb_say "好,先停在这儿 —— 这一步是后面要用的,弄好之后再运行这条命令,咱们从这里接着继续,前面的进度都在。"
          exit 0 ;;
      esac
    else
      fb_copy escalate-offer
      fb_ask ">"
      case "$FB_INPUT" in
        要|要的|y|yes|好)
          fb_escalate_now "$id" "${FB_LAST_ERROR_CODE:-step_failed}" "${FB_LAST_HINT:-}" ;;
        *)
          fb_say "行,那咱再试一次。" ;;
      esac
    fi
  done
}

fb_escalate_now() { # <where> <error_code> <hint>
  local summary
  summary="$(buddy_escalate "$FB_STATE_DIR" "$1" "$2" "${3:-}" 2>>"$FB_STATE_DIR/buddy-steps.log")" || summary="(没写出来,把屏幕上这段话发给支持同学也行)"
  fb_gap
  fb_copy escalate-done "SUMMARY_PATH=$summary"
  exit 1
}

# confusion patterns → offer the human handoff right away (spec §0.4-3)
fb_confused() {
  printf '%s' "$1" | grep -Eq '不懂|看不懂|不明白|不太明白|啥意思|什么意思|听不懂|不会弄|不会搞|搞不懂|太难了'
}

fb_maybe_escalate_confusion() { # <where> <user-text>
  fb_confused "$2" || return 1
  fb_gap
  fb_copy escalate-offer
  fb_ask ">"
  case "$FB_INPUT" in
    要|要的|y|yes|好) fb_escalate_now "$1" "user_confused" "" ;;
    *) fb_say "好,那我再讲细一点,咱慢慢来。"; return 1 ;;
  esac
}

# ── brain (headless model via the provider seam) ─────────────────────────────
fb_brain() { # <prompt-name> <user-text> → prints the reply text; rc!=0 on failure
  local name="$1" input="$2"
  # paste-accident guard: user text that looks like a credential never
  # leaves this process toward the model.
  if ! scan_string_for_secrets "$input" >/dev/null 2>&1; then
    fb_say "等等 —— 你刚才发的那串像是个密钥。密钥别贴在聊天里,待会儿有专门的安全输入。我就当没看见它,咱继续。" >&2
    return 1
  fi
  local pid="${FLYWHEEL_AGENT_CLI:-claude}"
  local mod="$FB_PROVIDER_DIR/${pid}.sh"
  [ -f "$mod" ] || return 1
  local pf out reply sid rc
  pf="$(mktemp "${TMPDIR:-/tmp}/buddy-brain.XXXXXX")" || return 1
  chmod 600 "$pf"
  { cat "$FB_PROMPTS_DIR/$name.md"; printf '\nUSER_INPUT:\n%s\n' "$input"; } > "$pf"
  sid="$(fb_state_get brain_session_id)"
  out="$(
    {
      # shellcheck disable=SC1090
      source "$mod" || exit 1
      if [ -n "$sid" ]; then provider_resume "$sid" "$pf"; else provider_start_buddy "$FB_PERSONA" "$pf"; fi
    } 2>>"$FB_STATE_DIR/buddy-steps.log"
  )"
  rc=$?
  rm -f "$pf"
  [ "$rc" -eq 0 ] || return 1
  reply="$(jq -r '.reply // empty' <<<"$out" 2>/dev/null)"
  local new_sid; new_sid="$(jq -r '.session_id // empty' <<<"$out" 2>/dev/null)"
  [ -n "$new_sid" ] && [ "$new_sid" != "$sid" ] && fb_state_set brain_session_id "$new_sid"
  [ -n "$reply" ] || return 1
  printf '%s\n' "$reply"
}

# fb_parse_first_task <user-text> — brain → validated proposal JSON in
# FB_PROPOSAL. Schema failures retry ≤2; vague input gets ONE narrowing
# question; then the 3-example menu (spec step 3 branch).
FB_PROPOSAL=""
fb_parse_first_task() {
  local input="$1" attempt reply json=""
  for attempt in 1 2; do
    reply="$(fb_brain parse_first_task "$input")" || { json=""; break; }
    json="$(jq -ce . <<<"$reply" 2>/dev/null)" || json=""
    if [ -z "$json" ]; then
      json="$(printf '%s' "$reply" | sed -n 's/.*\({.*}\).*/\1/p' | jq -ce . 2>/dev/null)" || json=""
    fi
    if [ -n "$json" ] && jq -e \
        '(.intent|type=="string") and (.team_name|type=="string") and (.roles|type=="array") and (.systems_needed|type=="array") and has("confident")' \
        >/dev/null 2>&1 <<<"$json"; then
      break
    fi
    json=""
  done
  if [ -n "$json" ] && [ "$(jq -r '.confident' <<<"$json")" = "true" ]; then
    FB_PROPOSAL="$json"
    return 0
  fi
  if [ -n "$json" ]; then
    # brain understood the words but they were too vague — narrow once.
    fb_gap
    fb_ask "能再具体点吗?比如你今天正手动盯着、最烦的那一件事:"
    local more="$FB_INPUT"
    fb_maybe_escalate_confusion b3 "$more" || true
    reply="$(fb_brain parse_first_task "$more")" || reply=""
    json="$(jq -ce . <<<"$reply" 2>/dev/null)" || json=""
    if [ -n "$json" ] && [ "$(jq -r '.confident // false' <<<"$json" 2>/dev/null)" = "true" ]; then
      FB_PROPOSAL="$json"
      return 0
    fi
  fi
  # examples menu
  fb_gap
  fb_copy examples-menu
  fb_ask ">"
  case "$FB_INPUT" in
    1) FB_PROPOSAL='{"intent":"盯 dropship 订单:哪单卡了、为什么卡","team_name":"订单盯梢","roles":["Captain 帮你把关","Crew 去各系统查这单为什么卡"],"scope":"每天把卡住的订单找出来并说清原因","systems_needed":["shopify","email"],"confident":true}' ;;
    2) FB_PROPOSAL='{"intent":"对广告花费和成交","team_name":"投放对账","roles":["Captain 帮你把关","Crew 去拉花费和成交对一遍"],"scope":"每天给一句花了多少、成了几单、划不划算","systems_needed":[],"confident":true}' ;;
    3) FB_PROPOSAL='{"intent":"先回客户询价","team_name":"询价小助","roles":["Captain 帮你把关","Crew 把等报价的客户和草稿整理好"],"scope":"把在等报价的客户找出来并拟好草稿","systems_needed":["email"],"confident":true}' ;;
    *) fb_parse_first_task "$FB_INPUT"; return $? ;;
  esac
  return 0
}

# ── buddy step handlers ──────────────────────────────────────────────────────
fb_cursor_label() {
  case "$1" in
    0) printf '准备底座' ;; 1) printf '刚见面' ;; 2) printf '接地基工具' ;;
    3) printf '聊你想先搞定的事' ;; 4) printf '定你的小组' ;;
    5) printf '跟 Captain 打招呼' ;; 6) printf '接业务系统' ;;
    7) printf '安顿团队' ;; *) printf '收尾' ;;
  esac
}

fb_b0() {
  fb_say "正在做最后的底座检查…"
  fb_run_guarded preflight "把需要的基础软件装齐"
  fb_run_guarded model_key "装好 AI 助手并登录你自己的账号" \
    FLYWHEEL_AGENT_CLI_ORCHESTRATE=1 FLYWHEEL_AGENT_CLI="${FLYWHEEL_AGENT_CLI:-claude}" || true
}

fb_b1() {
  fb_gap; fb_copy step1-welcome; fb_gap
  fb_ask "(回车继续)"
  fb_maybe_escalate_confusion b1 "$FB_INPUT" || true
}

fb_b2() {
  fb_copy step2-tools-open; fb_gap
  # project scaffold is invisible plumbing — quietly, before anything needs it.
  fb_run_guarded skeleton "把工作区搭好"
  fb_copy step2a-discord; fb_gap
  fb_run_guarded bots "把团队成员的工牌办好"
  fb_run_guarded channels "把办公室的房间布置好"
  fb_gap; fb_copy step2b-linear; fb_gap
  fb_run_guarded linear "接上后台小本子"
  if fb_step_known github; then
    fb_gap; fb_copy step2c-github; fb_gap
    fb_run_guarded github "接上 GitHub"
  fi
  fb_gap; fb_copy step2-close
}

fb_b3() {
  fb_gap; fb_copy step3-ask-first-task
  fb_ask ">"
  local input="$FB_INPUT"
  fb_maybe_escalate_confusion b3 "$input" || true
  fb_parse_first_task "$input"
  fb_state_set first_task_summary "$(jq -r '.intent' <<<"$FB_PROPOSAL")"
  fb_state_set team_proposal "$FB_PROPOSAL"
}

fb_b4() {
  local proposal team roles
  proposal="$(fb_state_get_json team_proposal)"
  team="$(jq -r '.team_name // "你的小组"' <<<"$proposal")"
  roles="$(jq -r '[.roles[]?] | join(",")' <<<"$proposal")"
  [ -n "$roles" ] || roles="一个 Crew 去把事查清楚"
  fb_gap
  fb_copy step4-team-proposal "TEAM_NAME=$team" "ROLES=$roles"
  fb_ask ">"
  if printf '%s' "$FB_INPUT" | grep -Eq '改|换'; then
    fb_ask "行,想叫什么名字?"
    local newname="$FB_INPUT"
    if [ -n "$newname" ] && scan_string_for_secrets "$newname" >/dev/null 2>&1; then
      proposal="$(jq -c --arg n "$newname" '.team_name = $n' <<<"$proposal")"
      fb_state_set team_proposal "$proposal"
      fb_say "好,就叫「${newname}」。"
    fi
  fi
  fb_say "我这就把小组安排下去,稍等…"
  fb_run_guarded config "把小组落到册子上"
}

fb_b5() {
  if [ -f "$FB_PREVIEW_LIB" ]; then
    # shellcheck disable=SC1090
    source "$FB_PREVIEW_LIB"
    if buddy_captain_preview_start "$FB_STATE_DIR" "${FB_ARGS[@]}" 2>>"$FB_STATE_DIR/buddy-steps.log"; then
      fb_gap; fb_copy step5-early-chat
      fb_ask "(回车继续)"
      return 0
    fi
  fi
  fb_say "Captain 一会儿安顿好就上线,到时候你们在 Discord 见面。"
}

fb_b6() {
  local proposal intent
  proposal="$(fb_state_get_json team_proposal)"
  intent="$(jq -r '.intent // "你说的那件事"' <<<"$proposal")"
  if [ -f "$FB_CONNECT_LIB" ]; then
    fb_gap; fb_copy step6-jit-intro "INTENT=$intent"
    # shellcheck disable=SC1090
    source "$FB_CONNECT_LIB"
    buddy_connect_jit "$FB_STATE_DIR" "$proposal"
  else
    fb_say "你要用到的那几样东西,等下让 Captain 带你接 —— 不耽误先把团队安顿好。"
  fi
}

fb_project_name() {
  local i=0 n="${#FB_ARGS[@]}"
  while [ "$i" -lt "$n" ]; do
    if [ "${FB_ARGS[$i]}" = "--project" ]; then printf '%s' "${FB_ARGS[$((i+1))]}"; return 0; fi
    i=$((i+1))
  done
  jq -r '.buddy.identity.project // empty' "$FB_STATE_DIR/setup-state.json" 2>/dev/null
}

fb_b7() {
  fb_gap; fb_copy step7-placement; fb_gap
  if [ -f "$FB_PREVIEW_LIB" ]; then
    # shellcheck disable=SC1090
    source "$FB_PREVIEW_LIB"
    buddy_captain_preview_stop "$FB_STATE_DIR" 2>>"$FB_STATE_DIR/buddy-steps.log" || true
  fi
  if [ -f "$FB_CONNECT_LIB" ]; then
    # shellcheck disable=SC1090
    source "$FB_CONNECT_LIB"
    buddy_install_first_output_skill "$FB_STATE_DIR" "$(fb_project_name)" \
      2>>"$FB_STATE_DIR/buddy-steps.log" || true
  fi
  fb_run_guarded services "让团队常驻上岗"
  fb_run_guarded finish "确认家里的大本营开张"
  if fb_step_known captain_health; then
    fb_run_guarded captain_health "上线自检(团队能收发消息)"
  fi
  fb_run_step digest >/dev/null || true
}

fb_b8() {
  local ask
  ask="$(fb_state_get first_task_summary)"
  [ -n "$ask" ] || ask="看看我今天有没有卡住的事"
  fb_gap
  fb_copy step8-first-output "FIRST_ASK=$ask"
}

# ── main ─────────────────────────────────────────────────────────────────────
fb_main() {
  command -v jq >/dev/null 2>&1 || { echo "[buddy] jq required" >&2; exit 1; }
  mkdir -p "$FB_STATE_DIR" 2>/dev/null; chmod go-w "$FB_STATE_DIR" 2>/dev/null || true

  # escalated = a human is on it; resume only after they clear the flag.
  if [ "$(fb_state_get escalated)" = "true" ]; then
    fb_copy escalated-notice
    exit 0
  fi

  local cursor
  cursor="$(fb_state_get cursor)"
  case "$cursor" in (''|*[!0-9]*) cursor=0 ;; esac
  if [ "$cursor" -gt 0 ] && [ "$cursor" -lt 8 ]; then
    fb_copy welcome-back "LAST_STEP=$(fb_cursor_label "$cursor")"
    fb_ask ">"
  fi

  local b
  for b in 0 1 2 3 4 5 6 7 8; do
    [ "$b" -lt "$cursor" ] && continue
    "fb_b$b"
    cursor=$((b+1))
    fb_state_set cursor "$cursor"
  done
  exit 0
}

if [ -z "${FLYWHEEL_BUDDY_SOURCED:-}" ]; then
  fb_main
fi
