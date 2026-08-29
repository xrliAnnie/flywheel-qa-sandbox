#!/bin/bash
# FLY-1023 M1: flywheel-onboard.sh — one-command bootstrap + AgentCliProvider
# orchestration of the model_key step.
#
# Hermetic: isolated HOME, stubbed PATH (npm "installs" a stub claude CLI;
# curl/systemctl/… stubbed), in-repo mode (no clone), Buddy shell replaced by
# a marker script. No network, no real ~/.flywheel, no real installs.
#
# Covers (plan §3 M1 acceptance):
#   O1  fresh run: preflight + model_key land done; model_key evidence is
#       {mode:agent-cli, provider:claude, version} (no key anywhere); the
#       Buddy shell is exec'd with the identity flags
#   O2  interrupted/re-run: second run skips done steps (journal unchanged)
#       and still hands over to the Buddy shell
#   O3  FLYWHEEL_AGENT_CLI=codex: honest not-implemented → 2 attempts →
#       sanitized human-handoff summary + buddy.escalated=true + exit 1
#   O4  no secrets collected: .env has no model keys after the happy path
#   O5  default-behavior sentinel: model_key WITHOUT the orchestrate env
#       still runs the original guided body (evidence mode:claude-login)
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ONBOARD="$REPO_ROOT/scripts/flywheel-onboard.sh"
[ -f "$ONBOARD" ] || { echo "ERROR: $ONBOARD missing"; exit 1; }

SANDBOX="$(mktemp -d -t fly1023-onboard-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
for b in systemctl loginctl apt-get dnf sudo brew; do
  printf '#!/bin/bash\nexit 0\n' > "$STUB_BIN/$b"; chmod +x "$STUB_BIN/$b"
done
# curl: everything answers 200/empty (network check + Discord/Linear unused here)
printf '#!/bin/bash\n[ -t 0 ] || cat >/dev/null\nexit 0\n' > "$STUB_BIN/curl"; chmod +x "$STUB_BIN/curl"
# npm: `npm install -g @anthropic-ai/claude-code` drops a stub CLI on PATH.
# The stub is named claude-stub (and the provider pointed at it via
# FLYWHEEL_CLAUDE_BIN) so a REAL claude installed on the dev machine can
# never leak into the test: detect must miss until npm "installs".
cat > "$STUB_BIN/npm" <<EOF
#!/bin/bash
case "\$*" in
  *@anthropic-ai/claude-code*)
    cat > "$STUB_BIN/claude-stub" <<'CLI'
#!/bin/bash
[ -t 0 ] || cat >/dev/null
for a in "\$@"; do
  case "\$a" in
    --version) echo "9.9.9 (Claude Code)"; exit 0 ;;
    --print) echo "ok"; exit 0 ;;
  esac
done
exit 0
CLI
    chmod +x "$STUB_BIN/claude-stub"
    echo "installed claude stub"
    exit 0 ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/npm"
# Buddy shell marker: records argv, exits 0
BUDDY_MARK="$SANDBOX/buddy-shell.sh"
cat > "$BUDDY_MARK" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$SANDBOX/buddy-invoked.txt"
exit 0
EOF
chmod +x "$BUDDY_MARK"

run_onboard() { # <home> [extra env pairs...]
  local home="$1"; shift
  env -i HOME="$home" USER=tester PATH="$STUB_BIN:$PATH" \
    FLYWHEEL_PLATFORM=linux FLYWHEEL_ONBOARD_NONINTERACTIVE=1 \
    FLYWHEEL_BUDDY_SHELL="$BUDDY_MARK" FLYWHEEL_CLAUDE_BIN=claude-stub \
    "$@" \
    bash "$ONBOARD" --project qa-onboard --cos-persona Cass --eng-persona Tad --linear-team QAO
}

# ── O1: fresh happy path ──
H1="$SANDBOX/home1"; mkdir -p "$H1/.claude"   # login heuristic: CLI state dir present
rm -f "$STUB_BIN/claude-stub" "$SANDBOX/buddy-invoked.txt"
OUT1="$(run_onboard "$H1" 2>&1)"; RC1=$?
J1="$H1/.flywheel/setup-state.json"
EV1="$(jq -c '.steps.model_key.evidence' "$J1" 2>/dev/null)"
if [ "$RC1" -eq 0 ] \
   && [ "$(jq -r '.steps.preflight.status' "$J1" 2>/dev/null)" = "done" ] \
   && [ "$(jq -r '.mode' <<<"$EV1")" = "agent-cli" ] \
   && [ "$(jq -r '.provider' <<<"$EV1")" = "claude" ] \
   && [ -n "$(jq -r '.version // empty' <<<"$EV1")" ] \
   && grep -q -- "--project" "$SANDBOX/buddy-invoked.txt" 2>/dev/null \
   && grep -q "qa-onboard" "$SANDBOX/buddy-invoked.txt" 2>/dev/null; then
  pass "O1 fresh run: preflight+model_key done, agent-cli evidence, Buddy shell exec'd with identity"
else
  fail "O1 rc=$RC1 ev='$EV1' invoked=$(cat "$SANDBOX/buddy-invoked.txt" 2>/dev/null) out: $(tail -4 <<<"$OUT1") steplog: $(tail -8 "$H1/.flywheel/buddy-steps.log" 2>/dev/null)"
fi

# ── O2: re-run resumes (journal unchanged) and still hands over ──
J1_BEFORE="$(jq -S . "$J1" 2>/dev/null)"
rm -f "$SANDBOX/buddy-invoked.txt"
OUT2="$(run_onboard "$H1" 2>&1)"; RC2=$?
J1_AFTER="$(jq -S . "$J1" 2>/dev/null)"
if [ "$RC2" -eq 0 ] && [ "$J1_BEFORE" = "$J1_AFTER" ] && [ -f "$SANDBOX/buddy-invoked.txt" ]; then
  pass "O2 re-run: journal untouched (steps skipped), Buddy shell handed over again"
else
  fail "O2 rc=$RC2 journal-equal=$([ "$J1_BEFORE" = "$J1_AFTER" ] && echo y || echo n)"
fi

# ── O3: codex → honest failure → sanitized handoff + escalated flag ──
H3="$SANDBOX/home3"; mkdir -p "$H3"
OUT3="$(run_onboard "$H3" FLYWHEEL_AGENT_CLI=codex 2>&1)"; RC3=$?
J3="$H3/.flywheel/setup-state.json"
SUMMARY="$(ls "$H3/.flywheel"/support-summary-*.json 2>/dev/null | head -1)"
if [ "$RC3" -ne 0 ] && [ -n "$SUMMARY" ] \
   && [ "$(jq -r '.escalated' "$SUMMARY")" = "true" ] \
   && [ "$(jq -r '.buddy.escalated' "$J3" 2>/dev/null)" = "true" ] \
   && [ "$(jq -r '.steps.model_key.status // "pending"' "$J3" 2>/dev/null)" != "done" ] \
   && bash -c "source '$REPO_ROOT/scripts/lib/fleet-sanitize.sh'; scan_for_secrets '$SUMMARY'" >/dev/null 2>&1; then
  pass "O3 codex path: honest stop, sanitized summary + buddy.escalated=true, exit non-zero"
else
  fail "O3 rc=$RC3 summary='$SUMMARY' journal=$(jq -c '.buddy' "$J3" 2>/dev/null) out: $(tail -4 <<<"$OUT3")"
fi

# ── O4: no secrets collected on the happy path ──
if [ ! -f "$H1/.flywheel/.env" ] || ! grep -Eq 'ANTHROPIC|API_KEY|TOKEN' "$H1/.flywheel/.env"; then
  pass "O4 happy path collects zero secrets (.env has no model keys)"
else
  fail "O4 .env: $(cat "$H1/.flywheel/.env")"
fi

# ── O5: default model_key sentinel (no orchestrate env → original body) ──
H5="$SANDBOX/home5"; mkdir -p "$H5"
O5="$(env -i HOME="$H5" USER=tester PATH="$STUB_BIN:$PATH" \
  FLYWHEEL_PLATFORM=linux \
  FLYWHEEL_SETUP_ANSWER_MODEL_AUTH_MODE=login \
  FLYWHEEL_SETUP_ANSWER_CLAUDE_LOGIN_CONFIRMED=y \
  bash "$REPO_ROOT/scripts/flywheel-buddy-steps.sh" --project qa-onboard --cos-persona Cass --eng-persona Tad run model_key 2>/dev/null)"
RC5=$?
EV5="$(jq -r '.evidence.mode' <<<"$O5" 2>/dev/null)"
if [ "$RC5" -eq 0 ] && [ "$EV5" = "claude-login" ]; then
  pass "O5 sentinel: model_key without orchestrate env keeps the original guided behavior"
else
  fail "O5 rc=$RC5 out='$O5'"
fi

# ── O6: stale CLI state → failed smoke triggers ONE login-repair pass ──
cat > "$STUB_BIN/claude-broken" <<'EOF'
#!/bin/bash
[ -t 0 ] || cat >/dev/null
for a in "$@"; do
  case "$a" in
    --version) echo "9.9.9 (Claude Code)"; exit 0 ;;
    --print) exit 1 ;;
  esac
done
exit 0
EOF
chmod +x "$STUB_BIN/claude-broken"
H6O="$SANDBOX/home6o"; mkdir -p "$H6O/.claude"   # stale state dir: heuristic says logged in
O6="$(env -i HOME="$H6O" USER=tester PATH="$STUB_BIN:$PATH" \
  FLYWHEEL_PLATFORM=linux FLYWHEEL_AGENT_CLI_ORCHESTRATE=1 FLYWHEEL_AGENT_CLI=claude \
  FLYWHEEL_CLAUDE_BIN=claude-broken FLYWHEEL_AGENT_CLI_TIMEOUT_SECS=10 \
  bash "$REPO_ROOT/scripts/flywheel-buddy-steps.sh" --project qa-onboard --cos-persona Cass --eng-persona Tad run model_key 2>/dev/null)"
RC6=$?
LOG6="$(jq -r '.log // empty' <<<"$O6" 2>/dev/null)"
if [ "$RC6" -ne 0 ] \
   && [ -n "$LOG6" ] && grep -q "attempting login repair" "$LOG6" 2>/dev/null \
   && [ "$(jq -r '.steps.model_key.status // "pending"' "$H6O/.flywheel/setup-state.json" 2>/dev/null)" != "done" ]; then
  pass "O6 stale login: failed smoke gets a repair pass; still-broken auth fails closed (not done)"
else
  fail "O6 rc=$RC6 out='$O6' log=$(grep -c repair "$H6O/.flywheel/buddy-steps.log" 2>/dev/null)"
fi

echo ""
echo "flywheel-onboard.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
