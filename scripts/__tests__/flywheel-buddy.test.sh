#!/bin/bash
# FLY-1023 M2+M7: flywheel-buddy.sh — the Buddy shell's deterministic state
# machine, brain contract, resume, escalation ladder, and the two red-line
# lints (secrets + jargon).
#
# Hermetic: the step CLI is replaced by a STUB (records execution order,
# fault-injectable per step) and the brain by a STUB provider (canned JSON
# per keyword) — this isolates the SHELL's behavior; the real step CLI has
# its own test (flywheel-buddy-steps.test.sh). Real escalation lib + real
# step CLI are used only for the escalated-flag round-trip.
#
# Covers (plan §3 M2/M7 acceptance):
#   D1  full dry run b0→b8 with piped answers: exits 0, all underlying steps
#       done in order, cursor lands past b8
#   D1L jargon lint over the FULL captured transcript (blacklist minus the
#       platform-UI allowlist "Reset Token")
#   D2  EOF mid-conversation = graceful exit, progress kept (cursor=3)
#   D2R re-run resumes with the welcome-back line and completes
#   D3  parse_first_task: 4 concrete samples → valid confident proposals;
#       vague input → narrowing question → examples menu fallback
#   D4  secret-scan green over journal + shell log after the full run;
#       a pasted credential never reaches the brain (paste guard)
#   D5  escalation ladder: same step failing twice → offer → accept →
#       sanitized summary + escalated flag + exit 1; re-run shows the
#       escalated notice; clearing the flag resumes and completes
#   D6  static jargon lint over copy templates + fb_say literals
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUDDY="$REPO_ROOT/scripts/flywheel-buddy.sh"
[ -f "$BUDDY" ] || { echo "ERROR: $BUDDY missing"; exit 1; }

SANDBOX="$(mktemp -d -t fly1023-buddy-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── stub step CLI (order log + per-step fault injection) ─────────────────────
STUB_STEPS="$SANDBOX/stub-steps.sh"
cat > "$STUB_STEPS" <<'EOF'
#!/bin/bash
set -u
SD="${FLYWHEEL_SETUP_STATE_DIR:-$HOME/.flywheel}"
mkdir -p "$SD"
J="$SD/setup-state.json"
[ -f "$J" ] || printf '{"version":2,"steps":{},"buddy":{}}\n' > "$J"
while [ $# -gt 0 ]; do case "$1" in --*) shift 2 ;; *) break ;; esac; done
cmd="${1:-}"; shift || true
case "$cmd" in
  steps) echo '{"ok":true,"steps":["preflight","skeleton","model_key","bots","channels","linear","github","config","services","finish","captain_health","digest"]}' ;;
  run)
    id="$1"
    echo "$id" >> "$SD/run-order.log"
    if [ -f "$SD/fail-$id" ]; then
      n="$(cat "$SD/fail-$id")"
      if [ "$n" -gt 0 ]; then
        echo $((n-1)) > "$SD/fail-$id"
        printf '{"ok":false,"step":"%s","error_code":"step_failed","hint":"stub fail"}\n' "$id"
        exit 1
      fi
    fi
    jq --arg id "$id" '.steps[$id]={"status":"done","evidence":{}}' "$J" > "$J.t" && mv "$J.t" "$J"
    printf '{"ok":true,"step":"%s","status":"done","evidence":{}}\n' "$id" ;;
  verify) printf '{"ok":true,"step":"%s"}\n' "$1" ;;
  status) jq -c '{ok:true,version:2,steps:(.steps|map_values(.status)),buddy:(.buddy//{})}' "$J" ;;
  state)
    sub="$1"; key="$2"
    case "$sub" in
      get) jq -c --arg k "$key" '{ok:true,key:$k,value:(.buddy[$k]//null)}' "$J" ;;
      set) val="$3"
           if v="$(jq -ce . <<<"$val" 2>/dev/null)"; then :; else v="$(jq -c --arg v "$val" -n '$v')"; fi
           jq --arg k "$key" --argjson v "$v" '.buddy[$k]=$v' "$J" > "$J.t" && mv "$J.t" "$J"
           printf '{"ok":true,"key":"%s"}\n' "$key" ;;
    esac ;;
  *) echo '{"ok":false,"error_code":"bad_usage"}'; exit 1 ;;
esac
EOF
chmod +x "$STUB_STEPS"

# ── stub brain provider ──────────────────────────────────────────────────────
PROV_DIR="$SANDBOX/providers"; mkdir -p "$PROV_DIR"
cat > "$PROV_DIR/stub.sh" <<'EOF'
#!/usr/bin/env bash
_sp_reply() {
  local pf="$1" body json
  body="$(cat "$pf")"
  case "$body" in
    *订单*) json='{"intent":"盯 dropship 订单","team_name":"订单盯梢","roles":["Captain 把关","Crew 查单"],"scope":"找出卡住的订单","systems_needed":["shopify","email"],"confident":true}' ;;
    *广告*) json='{"intent":"对广告花费和成交","team_name":"投放对账","roles":["Captain 把关","Crew 对账"],"scope":"每天对一次","systems_needed":[],"confident":true}' ;;
    *询价*) json='{"intent":"回客户询价","team_name":"询价小助","roles":["Captain 把关","Crew 整理"],"scope":"整理询价","systems_needed":["email"],"confident":true}' ;;
    *文案*) json='{"intent":"上新品写文案","team_name":"文案小组","roles":["Captain 把关","Crew 起稿"],"scope":"三版标题","systems_needed":[],"confident":true}' ;;
    *) json='{"intent":"unclear","team_name":"小组","roles":[],"scope":"","systems_needed":[],"confident":false}' ;;
  esac
  jq -nc --arg r "$json" '{ok:true, provider:"stub", reply:$r, session_id:"bs1"}'
}
provider_id()          { jq -nc '{ok:true, provider:"stub"}'; }
provider_start_buddy() { _sp_reply "$2"; }
provider_resume()      { _sp_reply "$2"; }
EOF

run_buddy() { # <home> <answers-string> [extra env pairs...]
  local home="$1" answers="$2"; shift 2
  printf '%s' "$answers" | env -i HOME="$home" USER=tester PATH="$PATH" \
    FLYWHEEL_BUDDY_STEPS_BIN="$STUB_STEPS" \
    FLYWHEEL_AGENT_CLI=stub FLYWHEEL_AGENT_CLI_PROVIDER_DIR="$PROV_DIR" \
    FLYWHEEL_BUDDY_PREVIEW_LIB=/nonexistent FLYWHEEL_BUDDY_CONNECT_LIB=/nonexistent \
    FLYWHEEL_BUDDY_NONINTERACTIVE=1 \
    "$@" \
    bash "$BUDDY" --project qa-buddy --cos-persona Cass --eng-persona Tad
}

# ── D1: full dry run b0→b8 ──
H1="$SANDBOX/home1"; mkdir -p "$H1"
T1="$(run_buddy "$H1" $'\n帮我盯下 dropship 订单,哪单卡了、为什么卡\n成\n' 2>&1)"
RC1=$?
J1="$H1/.flywheel/setup-state.json"
ORDER="$(tr '\n' ' ' < "$H1/.flywheel/run-order.log" 2>/dev/null)"
CURSOR1="$(jq -r '.buddy.cursor' "$J1" 2>/dev/null)"
DONE1="$(jq -r '[.steps|to_entries[]|select(.value.status=="done")|.key]|length' "$J1" 2>/dev/null)"
if [ "$RC1" -eq 0 ] && [ "$CURSOR1" = "9" ] && [ "$DONE1" -eq 12 ] \
   && [ "$ORDER" = "preflight model_key skeleton bots channels linear github config services finish captain_health digest " ] \
   && grep -q "欢迎入伙" <<<"$T1" && grep -q "地基齐了" <<<"$T1" && grep -q "搞定 🎉" <<<"$T1"; then
  pass "D1 full dry run: exits 0, 11 steps done in canonical order, cursor past b8"
else
  fail "D1 rc=$RC1 cursor=$CURSOR1 done=$DONE1 order='$ORDER'"
fi

# ── D1L: jargon lint over the FULL transcript ──
CLEANED="$(sed 's/Reset Token//g' <<<"$T1")"
if ! grep -qiE '(^|[^a-zA-Z])(lead|runner|manifest|launchd|systemd|bridge|repo|token)([^a-zA-Z]|$)' <<<"$CLEANED"; then
  pass "D1L transcript jargon lint: blacklist absent (Reset Token UI label allowlisted)"
else
  fail "D1L jargon found: $(grep -oiE '(^|[^a-zA-Z])(lead|runner|manifest|launchd|systemd|bridge|repo|token)([^a-zA-Z]|$)' <<<"$CLEANED" | sort -u | tr '\n' ' ')"
fi

# ── D2: EOF mid-conversation → graceful exit, cursor kept at 3 ──
H2="$SANDBOX/home2"; mkdir -p "$H2"
T2="$(run_buddy "$H2" $'\n' 2>&1)"   # only the b1 answer; EOF at b3's question
RC2=$?
CURSOR2="$(jq -r '.buddy.cursor' "$H2/.flywheel/setup-state.json" 2>/dev/null)"
if [ "$RC2" -eq 0 ] && [ "$CURSOR2" = "3" ] && grep -q "进度都存着" <<<"$T2"; then
  pass "D2 EOF mid-flow: graceful goodbye, cursor kept at 3"
else
  fail "D2 rc=$RC2 cursor=$CURSOR2"
fi

# ── D2R: re-run resumes (welcome back) and completes ──
T2R="$(run_buddy "$H2" $'\n帮我盯下 dropship 订单\n成\n' 2>&1)"
RC2R=$?
CURSOR2R="$(jq -r '.buddy.cursor' "$H2/.flywheel/setup-state.json" 2>/dev/null)"
if [ "$RC2R" -eq 0 ] && [ "$CURSOR2R" = "9" ] && grep -q "欢迎回来" <<<"$T2R"; then
  pass "D2R resume: welcome-back line + run completes from the kept cursor"
else
  fail "D2R rc=$RC2R cursor=$CURSOR2R out: $(head -3 <<<"$T2R")"
fi

# ── D3: parse_first_task — 4 samples + vague fallback (sourced harness) ──
H3="$SANDBOX/home3"; mkdir -p "$H3"
d3_parse() { # <piped-input> <first-arg-text> → prints FB_PROPOSAL
  printf '%s' "$1" | env -i HOME="$H3" USER=tester PATH="$PATH" \
    FLYWHEEL_BUDDY_STEPS_BIN="$STUB_STEPS" \
    FLYWHEEL_AGENT_CLI=stub FLYWHEEL_AGENT_CLI_PROVIDER_DIR="$PROV_DIR" \
    FLYWHEEL_BUDDY_NONINTERACTIVE=1 FLYWHEEL_BUDDY_SOURCED=1 \
    bash -c '
      arg="$1"
      set --   # sourced scripts inherit caller args; the buddy arg parser must see none
      source "'"$BUDDY"'" || exit 97
      fb_parse_first_task "$arg" >/dev/null 2>&1
      printf "%s\n" "$FB_PROPOSAL"
    ' _ "$2" 2>/dev/null | tail -1
}
D3_OK=1
for sample in "帮我盯订单" "对一下广告花费" "回客户询价" "上新品写文案"; do
  P="$(d3_parse "" "$sample")"
  jq -e '.confident == true and (.team_name|length>0) and (.intent|length>0)' >/dev/null 2>&1 <<<"$P" \
    || { D3_OK=0; fail "D3 sample '$sample' → '$P'"; }
done
# vague input → narrowing question (fed vague again) → examples menu → pick 1
PV="$(d3_parse $'还是不知道要干啥\n1\n' "帮我赚钱")"
if [ "$D3_OK" -eq 1 ] && [ "$(jq -r '.team_name' <<<"$PV" 2>/dev/null)" = "订单盯梢" ]; then
  pass "D3 parse_first_task: 4 samples confident; vague → narrow → examples menu → proposal"
else
  [ "$D3_OK" -eq 1 ] && fail "D3 vague path → '$PV'"
fi

# ── D4: secret hygiene ──
D4_OK=1
bash -c "source '$REPO_ROOT/scripts/lib/fleet-sanitize.sh'; scan_for_secrets '$J1'" >/dev/null 2>&1 || { D4_OK=0; fail "D4 journal scan"; }
[ -f "$H1/.flywheel/buddy-steps.log" ] && { bash -c "source '$REPO_ROOT/scripts/lib/fleet-sanitize.sh'; scan_for_secrets '$H1/.flywheel/buddy-steps.log'" >/dev/null 2>&1 || { D4_OK=0; fail "D4 log scan"; }; }
# paste-accident guard: a token-looking answer to b3 must NOT reach the brain
H4="$SANDBOX/home4"; mkdir -p "$H4"
T4="$(run_buddy "$H4" $'\nghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcd1234\n1\n' 2>&1)"
if grep -q "像是个密钥" <<<"$T4" \
   && [ "$(jq -r '.buddy.team_proposal.team_name' "$H4/.flywheel/setup-state.json" 2>/dev/null)" = "订单盯梢" ]; then
  [ "$D4_OK" -eq 1 ] && pass "D4 secret hygiene: journal+log scan clean; pasted credential blocked before the brain"
else
  fail "D4 paste guard: $(grep -c '像是个密钥' <<<"$T4") proposal=$(jq -c '.buddy.team_proposal' "$H4/.flywheel/setup-state.json" 2>/dev/null)"
fi

# ── D5: escalation ladder ──
H5="$SANDBOX/home5"; mkdir -p "$H5/.flywheel"; chmod go-w "$H5/.flywheel"
echo 3 > "$H5/.flywheel/fail-bots"
T5="$(run_buddy "$H5" $'\n\n要\n' 2>&1)"   # b1 enter; retry-enter; accept handoff
RC5=$?
SUM5="$(ls "$H5/.flywheel"/support-summary-*.json 2>/dev/null | head -1)"
ESC5="$(jq -r '.buddy.escalated' "$H5/.flywheel/setup-state.json" 2>/dev/null)"
if [ "$RC5" -eq 1 ] && [ -n "$SUM5" ] && [ "$ESC5" = "true" ] \
   && grep -q "转好了" <<<"$T5" \
   && bash -c "source '$REPO_ROOT/scripts/lib/fleet-sanitize.sh'; scan_for_secrets '$SUM5'" >/dev/null 2>&1; then
  pass "D5 ladder: 2 failures → offer → accept → sanitized summary + escalated flag + exit 1"
else
  fail "D5 rc=$RC5 sum='$SUM5' escalated=$ESC5 out: $(tail -3 <<<"$T5")"
fi
# re-run while escalated → notice only
T5B="$(run_buddy "$H5" "" 2>&1)"; RC5B=$?
if [ "$RC5B" -eq 0 ] && grep -q "人工支持" <<<"$T5B" && ! grep -q "欢迎入伙" <<<"$T5B"; then
  pass "D5B escalated state: notice shown, no re-run of the flow"
else
  fail "D5B rc=$RC5B out: $(head -2 <<<"$T5B")"
fi
# human clears the flag → resume completes
env -i HOME="$H5" USER=tester PATH="$PATH" FLYWHEEL_SETUP_STATE_DIR="$H5/.flywheel" \
  bash "$STUB_STEPS" state set escalated false >/dev/null 2>&1
T5C="$(run_buddy "$H5" $'\n\n帮我盯订单\n成\n' 2>&1)"   # welcome-back, b1... (cursor was 2)
RC5C=$?
CURSOR5="$(jq -r '.buddy.cursor' "$H5/.flywheel/setup-state.json" 2>/dev/null)"
if [ "$RC5C" -eq 0 ] && [ "$CURSOR5" = "9" ]; then
  pass "D5C cleared flag: resume from kept cursor to completion"
else
  fail "D5C rc=$RC5C cursor=$CURSOR5 out: $(tail -3 <<<"$T5C")"
fi

# ── D7: REQUIRED step skip → run PAUSES, cursor does NOT advance (Codex R1#1) ──
H7="$SANDBOX/home7"; mkdir -p "$H7/.flywheel"; chmod go-w "$H7/.flywheel"
echo 99 > "$H7/.flywheel/fail-bots"
T7="$(run_buddy "$H7" $'\n跳过\n' 2>&1)"   # b1 enter; bots fail 1 → skip
RC7=$?
CURSOR7="$(jq -r '.buddy.cursor' "$H7/.flywheel/setup-state.json" 2>/dev/null)"
BOTS7="$(jq -r '.steps.bots.status // "pending"' "$H7/.flywheel/setup-state.json" 2>/dev/null)"
if [ "$RC7" -eq 0 ] && [ "$CURSOR7" = "2" ] && [ "$BOTS7" != "done" ] \
   && grep -q "先停在这儿" <<<"$T7" && ! grep -q "搞定 🎉" <<<"$T7" && ! grep -q "地基齐了" <<<"$T7"; then
  pass "D7 required-step skip: run pauses honestly, cursor stays at b2, no completion copy"
else
  fail "D7 rc=$RC7 cursor=$CURSOR7 bots=$BOTS7 out: $(tail -3 <<<"$T7")"
fi

# ── D6: static jargon lint (copy templates + fb_say literals). persona.md is
# NOT user-visible copy — it is the brain's instruction sheet and must NAME
# the forbidden words to ban them, so it stays out of this lint. ──
COPY_HITS="$(sed 's/Reset Token//g' "$REPO_ROOT"/scripts/buddy/copy/*.md \
  | grep -icE '(^|[^a-zA-Z])(lead|runner|manifest|launchd|systemd|bridge)([^a-zA-Z]|$)' || true)"
SAY_HITS="$(grep -E 'fb_say "' "$BUDDY" | grep -icE '(lead|runner|manifest|launchd|systemd|bridge|token)' || true)"
if [ "${COPY_HITS:-0}" -eq 0 ] && [ "${SAY_HITS:-0}" -eq 0 ]; then
  pass "D6 static jargon lint: copy templates + fb_say literals clean"
else
  fail "D6 copy=$COPY_HITS say=$SAY_HITS"
fi

echo ""
echo "flywheel-buddy.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
