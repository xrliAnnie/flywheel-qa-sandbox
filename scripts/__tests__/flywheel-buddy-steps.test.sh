#!/bin/bash
# FLY-1023 M0: flywheel-buddy-steps.sh — the machine-readable step CLI shell
# over the UNCHANGED flywheel-setup.sh step implementations (source seam), plus
# journal v2 (buddy region) and the secret-injection refusal gate.
#
# Hermetic: same stub infrastructure as flywheel-setup-resume-e2e.test.sh
# (curl/systemctl/... stubs on PATH, env -i isolated HOME, answer env vars).
# Needs the built teamlead dist (real-loader gate at the config step).
#
# Covers (plan §3 M0 acceptance):
#   B1   run preflight → EXACTLY one stdout line, valid JSON, ok:true, exit 0
#   B2   all 10 existing steps driven via `run` produce a journal whose .steps
#        region + projects.json are IDENTICAL to an interactive-mode run with
#        the same stubs; `verify` answers ok:true for each done step
#   B2a  a genuinely failing step (bad Linear key) → exit 1 + error_code
#   B3   stdout-pollution sentinels: run/verify/status/state get/state set all
#        emit exactly one line and it jq-parses (step chatter goes to the log)
#   B4   v1 journal is upgraded to v2 in place, idempotently (second touch is
#        a semantic no-op); interactive-mode journals STAY version 1 (sentinel)
#   B5   buddy state: whitelisted keys settable/gettable; secret-named keys
#        refused; secret-looking values refused (scan_string_for_secrets)
#   B6   secret-class FLYWHEEL_SETUP_ANSWER_* injection refused by default,
#        allowed only under FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1
#   B7   exit-code semantics: a step returning 3 surfaces as exit 3 +
#        error_code needs_guidance (source-seam driven fake step)
#   B8   journal file stays 0600 + secret-scan clean after CLI writes
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="${REPO_ROOT}/scripts/flywheel-setup.sh"
BUDDY_STEPS="${REPO_ROOT}/scripts/flywheel-buddy-steps.sh"
VALIDATOR="${REPO_ROOT}/packages/teamlead/dist/bin/validate-projects.js"
[ -f "$VALIDATOR" ] || { echo "ERROR: built validator missing — pnpm -C packages/teamlead build"; exit 1; }
[ -f "$BUDDY_STEPS" ] || { echo "ERROR: $BUDDY_STEPS missing"; exit 1; }

SANDBOX="$(mktemp -d -t fly1023-buddy-steps-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
SD="$SANDBOX/stubstate"; mkdir -p "$SD"
for b in systemctl loginctl apt-get dnf sudo brew; do
  printf '#!/bin/bash\nexit 0\n' > "$STUB_BIN/$b"; chmod +x "$STUB_BIN/$b"
done

# curl stub — identical protocol to flywheel-setup-resume-e2e.test.sh: the
# Linear viewer check only succeeds once $SD/linear-ok exists.
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
[ -t 0 ] || cat >/dev/null
url=""; method="GET"; body=""; prev=""
for a in "$@"; do
  case "$prev" in -X) method="$a" ;; -d) body="$a" ;; esac
  case "$a" in http://*|https://*) url="$a" ;; esac
  prev="$a"
done
chan_full='[{"id":"C-cos","name":"cos-chat","type":0},{"id":"C-eng","name":"eng-chat","type":0},{"id":"C-gen","name":"general","type":0}]'
case "$method $url" in
  "GET "*discord.com*/guilds/*/channels) printf '%s\n200' "$chan_full" ;;
  "GET "*discord.com*/channels/*/messages*) printf '[{"id":"M1","author":{"id":"900000000000000001","bot":false}}]\n200' ;;
  "POST "*discord.com*/channels/*/messages) printf '{"id":"PROBE1"}\n200' ;;
  "DELETE "*discord.com*/channels/*/messages/*) printf '\n204' ;;
  "GET "*discord.com*/users/@me/guilds) printf '[{"id":"G1","name":"Test"}]\n200' ;;
  "GET "*discord.com*/users/@me) printf '{"id":"stub-bot-id","username":"stub"}\n200' ;;
  "GET "*discord.com*/users/*) printf '{"id":"stub-user"}\n200' ;;
  "POST "*api.linear.app*)
    case "$body" in
      *viewer*organization*)
        if [ -f "${FLY648_SD:?}/linear-ok" ]; then
          printf '{"data":{"viewer":{"id":"u1"},"organization":{"urlKey":"fake-workspace"}}}\n200'
        else
          printf '{"errors":[{"message":"Authentication failed - invalid token"}]}\n401'
        fi ;;
      *teamCreate*) touch "$FLY648_SD/team-exists"; printf '{"data":{"teamCreate":{"success":true,"team":{"id":"T1","key":"QAB","name":"qa-buddy"}}}}\n200' ;;
      *issueLabelCreate*) printf '{"data":{"issueLabelCreate":{"success":true,"issueLabel":{"id":"LBL1","name":"Qa-buddy"}}}}\n200' ;;
      *projectCreate*) printf '{"data":{"projectCreate":{"success":true,"project":{"id":"P1","name":"qa-buddy"}}}}\n200' ;;
      *teams*nodes*)
        if [ -f "${FLY648_SD:?}/team-exists" ]; then printf '{"data":{"teams":{"nodes":[{"id":"T1","key":"QAB","name":"qa-buddy"}]}}}\n200'
        else printf '{"data":{"teams":{"nodes":[]}}}\n200'; fi ;;
      *issueLabels*) printf '{"data":{"issueLabels":{"nodes":[]}}}\n200' ;;
      *projects*) printf '{"data":{"projects":{"nodes":[]}}}\n200' ;;
      *) printf '{"data":{}}\n200' ;;
    esac ;;
  *) printf '{}\n200' ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/curl"

COMMON_ENV=(
  FLYWHEEL_PLATFORM=linux
  FLY648_SD="$SD"
  FLYWHEEL_SETUP_HEALTH_TRIES=1 FLYWHEEL_SETUP_HEALTH_SLEEP=0
  FLYWHEEL_SETUP_ANSWER_MODEL_AUTH_MODE=login
  FLYWHEEL_SETUP_ANSWER_CLAUDE_LOGIN_CONFIRMED=y
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_COS=111111111111111111
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_COS=fake-cos-token-value
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_COS=y
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_ENG=222222222222222222
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_ENG=fake-eng-token-value
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_ENG=y
  FLYWHEEL_SETUP_ANSWER_FOUNDER_USER_ID=100000000000000009
  FLYWHEEL_SETUP_ANSWER_LINEAR_API_KEY_INPUT=lin_api_fakekey_ok
)
IDENTITY_ARGS=(--project qa-buddy --cos-persona Cass --eng-persona Tad --linear-team QAB)

# buddy_cli <home> <extra-env...> -- <cli-args...>
buddy_cli() {
  local home="$1"; shift
  local -a extra=()
  while [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  env -i HOME="$home" USER="tester" PATH="$STUB_BIN:$PATH" \
    "${COMMON_ENV[@]}" "${extra[@]}" \
    bash "$BUDDY_STEPS" "${IDENTITY_ARGS[@]}" "$@"
}

STEPS_ALL=(preflight skeleton model_key bots channels linear config services finish digest)

# ══ B1: run preflight → one JSON line on stdout, ok:true, exit 0 ══
H1="$SANDBOX/home1"; mkdir -p "$H1"
OUT1="$(buddy_cli "$H1" FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1 -- run preflight 2>"$SANDBOX/b1.err")"
RC1=$?
LINES1="$(printf '%s' "$OUT1" | grep -c . || true)"
if [ "$RC1" -eq 0 ] && [ "$LINES1" -eq 1 ] \
   && [ "$(jq -r '.ok' <<<"$OUT1" 2>/dev/null)" = "true" ] \
   && [ "$(jq -r '.step' <<<"$OUT1" 2>/dev/null)" = "preflight" ]; then
  pass "B1 run preflight: single-line JSON {ok:true, step:preflight}, exit 0"
else
  fail "B1 rc=$RC1 lines=$LINES1 out='$OUT1' err=$(tail -3 "$SANDBOX/b1.err" 2>/dev/null)"
fi

# ══ B2a: failing step (bad Linear key) → exit 1 + error_code ══
for id in skeleton model_key bots channels; do
  buddy_cli "$H1" FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1 -- run "$id" >/dev/null 2>&1 \
    || { fail "B2 pre: step $id failed unexpectedly"; break; }
done
OUT2A="$(buddy_cli "$H1" FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1 -- run linear 2>/dev/null)"
RC2A=$?
if [ "$RC2A" -eq 1 ] && [ "$(jq -r '.ok' <<<"$OUT2A" 2>/dev/null)" = "false" ] \
   && [ "$(jq -r '.error_code' <<<"$OUT2A" 2>/dev/null)" = "step_failed" ]; then
  pass "B2a failing linear step: exit 1 + {ok:false, error_code:step_failed}"
else
  fail "B2a rc=$RC2A out='$OUT2A'"
fi

# ══ B2: full 10-step run via CLI == interactive run (same stubs) ══
touch "$SD/linear-ok"
B2_OK=1
for id in linear config services finish digest; do
  O="$(buddy_cli "$H1" FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1 -- run "$id" 2>/dev/null)"
  [ "$(jq -r '.ok' <<<"$O" 2>/dev/null)" = "true" ] || { B2_OK=0; fail "B2 run $id → '$O'"; break; }
done
# interactive reference run in a SEPARATE home (same stubs/answers)
rm -f "$SD/team-exists"
H2="$SANDBOX/home2"; mkdir -p "$H2"
env -i HOME="$H2" USER="tester" PATH="$STUB_BIN:$PATH" "${COMMON_ENV[@]}" \
  bash "$SETUP" "${IDENTITY_ARGS[@]}" </dev/null >/dev/null 2>&1
RCI=$?
if [ "$B2_OK" -eq 1 ] && [ "$RCI" -eq 0 ]; then
  # evidence + projects.json carry absolute paths under each sandbox HOME —
  # normalize both sides to a placeholder before comparing.
  S_CLI="$(jq -S '.steps' "$H1/.flywheel/setup-state.json" | sed "s|$H1|__HOME__|g")"
  S_INT="$(jq -S '.steps' "$H2/.flywheel/setup-state.json" | sed "s|$H2|__HOME__|g")"
  P_CLI="$(jq -S '.' "$H1/.flywheel/projects.json" | sed "s|$H1|__HOME__|g")"
  P_INT="$(jq -S '.' "$H2/.flywheel/projects.json" | sed "s|$H2|__HOME__|g")"
  if [ "$S_CLI" = "$S_INT" ] && [ "$P_CLI" = "$P_INT" ] \
     && node "$VALIDATOR" "$H1/.flywheel/projects.json" >/dev/null 2>&1; then
    pass "B2 all 10 steps via CLI: .steps + projects.json identical to interactive mode"
  else
    fail "B2 steps-equal=$([ "$S_CLI" = "$S_INT" ] && echo y || echo n) projects-equal=$([ "$P_CLI" = "$P_INT" ] && echo y || echo n)"
  fi
else
  fail "B2 cli-chain=$B2_OK interactive-rc=$RCI"
fi

# verify each done step answers ok:true
B2V_OK=1
for id in "${STEPS_ALL[@]}"; do
  O="$(buddy_cli "$H1" FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1 -- verify "$id" 2>/dev/null)"
  [ "$(jq -r '.ok' <<<"$O" 2>/dev/null)" = "true" ] || { B2V_OK=0; fail "B2v verify $id → '$O'"; break; }
done
[ "$B2V_OK" -eq 1 ] && pass "B2v verify answers ok:true for all 10 done steps"

# ══ B3: stdout-pollution sentinels — every subcommand: exactly 1 line + jq-parses ══
B3_OK=1
check_one_json_line() {
  local label="$1" out="$2"
  local n; n="$(printf '%s' "$out" | grep -c . || true)"
  if [ "$n" -ne 1 ] || ! jq -e . >/dev/null 2>&1 <<<"$out"; then
    B3_OK=0; fail "B3 $label: lines=$n out='$out'"
  fi
}
check_one_json_line "run(skeleton re-verify path)" "$(buddy_cli "$H1" FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1 -- run skeleton 2>/dev/null)"
check_one_json_line "verify" "$(buddy_cli "$H1" FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1 -- verify skeleton 2>/dev/null)"
check_one_json_line "status" "$(buddy_cli "$H1" -- status --json 2>/dev/null)"
check_one_json_line "state set" "$(buddy_cli "$H1" -- state set cursor 3 2>/dev/null)"
check_one_json_line "state get" "$(buddy_cli "$H1" -- state get cursor 2>/dev/null)"
[ "$B3_OK" -eq 1 ] && pass "B3 stdout sentinels: run/verify/status/state emit exactly one JSON line"

# ══ B4: v1 journal → v2 upgrade, idempotent; interactive stays v1 ══
H4="$SANDBOX/home4"; mkdir -p "$H4/.flywheel"; chmod go-w "$H4/.flywheel"
printf '{"version":1,"steps":{"preflight":{"status":"done","evidence":{"platform":"linux"}}}}\n' > "$H4/.flywheel/setup-state.json"
chmod 600 "$H4/.flywheel/setup-state.json"
O4="$(buddy_cli "$H4" -- state set cursor 1 2>/dev/null)"
J4A="$(jq -S . "$H4/.flywheel/setup-state.json")"
buddy_cli "$H4" -- state set cursor 1 >/dev/null 2>&1
J4B="$(jq -S . "$H4/.flywheel/setup-state.json")"
if [ "$(jq -r '.ok' <<<"$O4" 2>/dev/null)" = "true" ] \
   && [ "$(jq -r '.version' "$H4/.flywheel/setup-state.json")" = "2" ] \
   && [ "$(jq -r '.buddy.cursor' "$H4/.flywheel/setup-state.json")" = "1" ] \
   && [ "$(jq -r '.steps.preflight.status' "$H4/.flywheel/setup-state.json")" = "done" ] \
   && [ "$J4A" = "$J4B" ]; then
  pass "B4 v1→v2 upgrade in place (steps preserved), idempotent on second touch"
else
  fail "B4 out='$O4' journal=$(cat "$H4/.flywheel/setup-state.json" 2>/dev/null)"
fi
# interactive sentinel: fresh interactive run initializes a VERSION 1 journal
if [ "$(jq -r '.version' "$H2/.flywheel/setup-state.json")" = "1" ] \
   && [ "$(jq 'has("buddy")' "$H2/.flywheel/setup-state.json")" = "false" ]; then
  pass "B4s interactive-mode journal stays version 1 with no buddy region (base engine untouched)"
else
  fail "B4s interactive journal: $(jq -c '{version, buddy}' "$H2/.flywheel/setup-state.json")"
fi

# ══ B5: buddy state whitelist + secret refusal ══
O5A="$(buddy_cli "$H4" -- state set bot_token abc 2>/dev/null)"; RC5A=$?
O5B="$(buddy_cli "$H4" -- state set first_task_summary "ghp_$(printf 'A%.0s' {1..40})" 2>/dev/null)"; RC5B=$?
O5C="$(buddy_cli "$H4" -- state set first_task_summary "check stuck orders daily" 2>/dev/null)"; RC5C=$?
O5D="$(buddy_cli "$H4" -- state get first_task_summary 2>/dev/null)"
if [ "$RC5A" -ne 0 ] && [ "$(jq -r '.error_code' <<<"$O5A")" = "key_not_allowed" ] \
   && [ "$RC5B" -ne 0 ] && [ "$(jq -r '.error_code' <<<"$O5B")" = "secret_value_refused" ] \
   && [ "$RC5C" -eq 0 ] \
   && [ "$(jq -r '.value' <<<"$O5D")" = "check stuck orders daily" ]; then
  pass "B5 buddy state: non-whitelisted key refused, secret value refused, clean value round-trips"
else
  fail "B5 a=($RC5A,$O5A) b=($RC5B,$O5B) c=($RC5C,$O5C) d='$O5D'"
fi

# ══ B6: secret-class answer injection refused by default ══
H6="$SANDBOX/home6"; mkdir -p "$H6"
O6A="$(buddy_cli "$H6" -- run preflight 2>/dev/null)"; RC6A=$?   # BOT_TOKEN answers in COMMON_ENV, no allow flag
O6B="$(buddy_cli "$H6" FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1 -- run preflight 2>/dev/null)"; RC6B=$?
if [ "$RC6A" -ne 0 ] && [ "$(jq -r '.error_code' <<<"$O6A" 2>/dev/null)" = "secret_injection_refused" ] \
   && [ "$RC6B" -eq 0 ]; then
  pass "B6 secret-class FLYWHEEL_SETUP_ANSWER_* refused by default, allowed under test flag"
else
  fail "B6 a=($RC6A,'$O6A') b=($RC6B,'$O6B')"
fi

# ══ B7: exit-3 (needs_guidance) propagation via the source seam ══
O7="$(
  env -i HOME="$H6" USER="tester" PATH="$STUB_BIN:$PATH" FLY648_SD="$SD" FLYWHEEL_PLATFORM=linux \
  bash -c '
    export FLYWHEEL_BUDDY_STEPS_SOURCED=1
    source "'"$BUDDY_STEPS"'" || exit 97
    step_run_fakeguided() { echo "needs a human hand" >&2; return 3; }
    bs_main --project qa-buddy --cos-persona Cass --eng-persona Tad --linear-team QAB run fakeguided
  ' 2>/dev/null
)"
RC7=$?
if [ "$RC7" -eq 3 ] && [ "$(jq -r '.error_code' <<<"$O7" 2>/dev/null)" = "needs_guidance" ]; then
  pass "B7 step returning 3 → exit 3 + error_code needs_guidance"
else
  fail "B7 rc=$RC7 out='$O7'"
fi

# ══ B8: journal 0600 + secret-scan clean after CLI writes ══
ST8="$H1/.flywheel/setup-state.json"
PERMS="$(stat -c '%a' "$ST8" 2>/dev/null || stat -f '%Lp' "$ST8" 2>/dev/null)"
if [ "$PERMS" = "600" ] \
   && bash -c "source '$REPO_ROOT/scripts/lib/fleet-sanitize.sh'; scan_for_secrets '$ST8'" >/dev/null 2>&1; then
  pass "B8 journal stays 0600 + passes secret scan after CLI writes"
else
  fail "B8 perms=$PERMS"
fi

echo ""
echo "flywheel-buddy-steps.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
