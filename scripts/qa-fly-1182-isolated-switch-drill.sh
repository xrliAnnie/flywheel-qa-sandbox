#!/usr/bin/env bash
# FLY-1182 QA — isolated verify / commit / rollback drill.
#
# Drives the REAL `flywheel-claude-profile use` binary through the three steps
# the §8 scope names, against a FAKE security(1) + scratch pool + isolated
# config. Nothing here touches the production Keychain, the real account pool,
# ~/.claude.json, or ~/.flywheel/quota-monitor.json.
#
# Isolation is FAIL-CLOSED: the guard below refuses to run unless every knob is
# pointed away from production. A drill that silently fell back to the real
# Keychain would be worse than no drill at all.
#
# Stages:
#   S1 verify+commit  — a good write reads back equal -> commit, .active flips
#   S2 rollback       — a corrupted write reads back wrong -> restore preimage,
#                       non-zero exit, .active UNCHANGED (the red line)
#   S3 argv hygiene   — no credential ever appears in any security(1) argv
#   S4 prod untouched — production files byte-identical before/after
set -uo pipefail

# Codex R1 HIGH-2 + R2 HIGH: neutralize any INHERITED env that would weaken the
# gates, skip validation, or route to production. The drill does not control its
# caller's environment, so it must defensively clear every live escape hatch
# the real binary honours before invoking it:
#   QUOTA_PREVERIFIED              — skip the fake quota guard;
#   PROFILE_IDENTITY_BYPASS        — skip the OAuth identity assertions the drill
#     is verifying (inherited =1 made the drill still report green);
#   TEST_PAUSE_AFTER_JOURNAL       — writes a `.ready` file and HANGS the switch.
unset FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED FLYWHEEL_PROFILE_IDENTITY_BYPASS \
      FLYWHEEL_TEST_PAUSE_AFTER_JOURNAL

PROFILE_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/packages/claude-runner/bin/flywheel-claude-profile"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/qa-fly-1182-drill.XXXXXX")"
PASS=0; FAIL=0
ok()   { echo "✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "❌ $1"; FAIL=$((FAIL+1)); }
note() { echo "   · $1"; }

cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

# ---------------------------------------------------------------- isolation
POOL="$ROOT/pool"; STATE="$ROOT/keychain-item"; ARGV_LOG="$ROOT/security-argv.log"
STUB="$ROOT/fake-security"; CLAUDE_JSON="$ROOT/claude.json"; FRESH="$ROOT/fake-freshness"
mkdir -p "$POOL"
: > "$ARGV_LOG"

cat > "$STUB" <<'EOS'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$FAKE_SEC_ARGV_LOG"
case "${1:-}" in
  find-generic-password)
    [[ -f "$FAKE_SEC_STATE" ]] || { echo "could not be found" >&2; exit 44; }
    cat "$FAKE_SEC_STATE" ;;
  -i)
    cmd=$(cat)
    val=$(printf '%s' "$cmd" | sed -n 's/.* -w \([^ ]*\).*/\1/p')
    [[ -z "$val" ]] && exit 1
    # CORRUPT-ONCE: corrupt only the FIRST write, then behave normally. A stub
    # that corrupts EVERY write would also corrupt the rollback write, so the
    # drill would blame the product for the harness's own sabotage.
    if [[ -f "${FAKE_SEC_CORRUPT_ONCE:-/nonexistent}" ]]; then
      rm -f "$FAKE_SEC_CORRUPT_ONCE"
      printf '%s' "CORRUPTED-BY-DRILL" > "$FAKE_SEC_STATE"
    else
      printf '%s' "$val" > "$FAKE_SEC_STATE"
    fi ;;
  delete-generic-password) rm -f "$FAKE_SEC_STATE" ;;
  *) exit 2 ;;
esac
EOS
chmod +x "$STUB"

printf '#!/usr/bin/env bash\nexit 0\n' > "$FRESH"; chmod +x "$FRESH"

# The real binary validates that a credential is a JSON object AND contains no
# whitespace (the `security -i` single-token rule), so the drill must feed the
# real shape — a synthetic non-JSON token is rejected before Keychain is ever
# touched, which would make every downstream assertion vacuously green.
SECRET_ALPHA='{"claudeAiOauth":{"accessToken":"ALPHA-b3f1a9d2c7e4","refreshToken":"ALPHA-RT-1"}}'
SECRET_BRAVO='{"claudeAiOauth":{"accessToken":"BRAVO-9d4c1e7a2f8b","refreshToken":"BRAVO-RT-1"}}'
# The distinctive substrings the argv-leak check greps for.
MARK_ALPHA="ALPHA-b3f1a9d2c7e4"
MARK_BRAVO="BRAVO-9d4c1e7a2f8b"
for acct in alpha bravo; do mkdir -p "$POOL/$acct"; done
printf '%s' "$SECRET_ALPHA" > "$POOL/alpha/.credentials.json"; chmod 600 "$POOL/alpha/.credentials.json"
printf '%s' "$SECRET_BRAVO" > "$POOL/bravo/.credentials.json"; chmod 600 "$POOL/bravo/.credentials.json"
printf 'alpha' > "$POOL/.active"

# FLY-1182 assertion B: `use` refuses any target without a valid identity anchor
# (exit 87). Seed the exact 5-key shape at mode 600 the binary demands.
seed_anchor() { # $1=name $2=uuid $3=email
  printf '{"accountUuid":"%s","email":"%s","anchoredAt":"2026-07-16T00:00:00.000Z","anchoredBy":"qa-drill","confirmedBy":"qa-drill-evidence"}' \
    "$2" "$3" > "$POOL/$1/identity-anchor.json"
  chmod 600 "$POOL/$1/identity-anchor.json"
}
seed_anchor alpha "uuid-alpha" "alpha@test.invalid"
seed_anchor bravo "uuid-bravo" "bravo@test.invalid"

# FLY-865 display identity: `use` copies this block into CLAUDE_JSON. It is
# BEST-EFFORT in the binary (missing => skip), so without seeding it the S5
# redirect proof would silently have nothing to observe.
seed_identity() { # $1=name $2=uuid $3=email $4=org
  printf '{"accountUuid":"%s","emailAddress":"%s","organizationUuid":"%s","organizationName":"QA Drill Org"}' \
    "$2" "$3" "$4" > "$POOL/$1/oauthAccount.json"
  chmod 600 "$POOL/$1/oauthAccount.json"
}
seed_identity alpha "uuid-alpha" "alpha@test.invalid" "org-alpha"
seed_identity bravo "uuid-bravo" "bravo@test.invalid" "org-bravo"

# Fake identity probe: the binary POSTs the credential's accessToken and expects
# {account:{uuid,email}}. Answer per-token so each profile asserts as ITSELF.
IDCURL="$ROOT/fake-curl"
cat > "$IDCURL" <<'EOC'
#!/usr/bin/env bash
set -u
cfg=$(cat)   # --config - carries the Authorization header
if printf '%s' "$cfg" | grep -q "ALPHA-b3f1a9d2c7e4"; then
  printf '{"account":{"uuid":"uuid-alpha","email":"alpha@test.invalid"}}'; exit 0
fi
if printf '%s' "$cfg" | grep -q "BRAVO-9d4c1e7a2f8b"; then
  printf '{"account":{"uuid":"uuid-bravo","email":"bravo@test.invalid"}}'; exit 0
fi
exit 22
EOC
chmod +x "$IDCURL"
export FLYWHEEL_PROFILE_CURL_BIN="$IDCURL"
export FLYWHEEL_PROFILE_IDENTITY_ENDPOINT="https://identity.test.invalid/oauth/profile"
export FLYWHEEL_PROFILE_AUDIT_LOG="$ROOT/audit.log"
printf '%s' "$SECRET_ALPHA" > "$STATE"          # keychain currently holds alpha
printf '{"oauthAccount":{"emailAddress":"alpha@test.invalid"}}' > "$CLAUDE_JSON"

# FLY-1182 #618 hardening: `use` now runs a live quota guard before switching and
# reads a claude-accounts.json store. Both default to PRODUCTION paths
# (~/.flywheel/claude-accounts.json + the real dist quota-guard bin), so the
# drill MUST inject scratch versions or the new gate would touch production.
ACCOUNTS_STORE_FILE="$ROOT/claude-accounts.json"
printf '{"generation":1,"activeAccount":"alpha","accounts":[{"name":"alpha"},{"name":"bravo"}]}' > "$ACCOUNTS_STORE_FILE"

# A controllable fake quota guard. FAKE_QUOTA_RC decides the verdict per scenario:
#   0 healthy · 32 exhausted · 33 evidence unavailable. Contract from the binary:
#   `<bin> check --name <name> --pool <dir> --store <store>`.
QGUARD="$ROOT/fake-quota-guard"
cat > "$QGUARD" <<'EOQ'
#!/usr/bin/env bash
set -u
exit "${FAKE_QUOTA_RC:-0}"
EOQ
chmod +x "$QGUARD"

export FLYWHEEL_CLAUDE_PROFILES_DIR="$POOL"
export FLYWHEEL_CLAUDE_ACCOUNTS_LOCK="$ROOT/lock"
export FLYWHEEL_CLAUDE_ACCOUNTS_PATH="$ACCOUNTS_STORE_FILE"       # NOT prod claude-accounts.json
export FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN="$QGUARD"                  # NOT the real dist guard
export FLYWHEEL_CLAUDE_SECURITY_BIN="$STUB"
export FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE="QA-FLY1182-Drill-credentials"   # NOT the prod service
export FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT="qa-drill-acct"
export FLYWHEEL_CLAUDE_JSON="$CLAUDE_JSON"
export FLYWHEEL_CLAUDE_JSON_LOCK="$ROOT/claude-json.lock"
export FLYWHEEL_CLAUDE_FRESHNESS_BIN="$FRESH"
# Codex R1 HIGH-1: a successful `use` writes then clears a transition journal
# (write_transition_journal -> clear_transition_journal). Its default is the
# PRODUCTION path ~/.flywheel/claude-account-transition.json, so a manual switch
# transiently writes production — and a mid-switch failure would leave residue
# there. A write-then-delete leaves no before/after hash diff, so S4 could never
# catch it; inject it to scratch so the binary physically cannot touch production.
export FLYWHEEL_CLAUDE_TRANSITION_JOURNAL="$ROOT/transition-journal.json"
export FAKE_SEC_STATE="$STATE"
export FAKE_SEC_ARGV_LOG="$ARGV_LOG"
export FAKE_QUOTA_RC=0   # default healthy; individual scenarios override

# FLY-2240: public `use` now intentionally enters the Node selector/executor.
# This drill is narrower: it mutates the fake Keychain to prove the Bash
# primitive's verify/rollback red lines. Invoke that primitive exactly as the
# atomic executor does — from an authenticated parent-owned lock with the
# internal apply marker — while retaining the real freshness/quota/identity
# guards configured above. Public routing + notification have separate E2Es.
invoke_profile_use() { # <target>
  local target="$1" holder_pid="${BASHPID:-$$}" token marker rc
  token="qa1182-${holder_pid}-${RANDOM}"
  marker="$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK/holder.${holder_pid}.${token}"
  mkdir "$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK" || return 1
  printf '{"pid":%d,"at":%d,"token":"%s"}' \
    "$holder_pid" "$(( $(date +%s) * 1000 ))" "$token" > "$marker"
  chmod 600 "$marker"
  FLYWHEEL_CLAUDE_LOCK_DELEGATED="$holder_pid" \
    FLYWHEEL_ATOMIC_SWITCH_APPLY=1 \
    "$PROFILE_BIN" use "$target"
  rc=$?
  rm -f "$marker"
  rmdir "$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK" 2>/dev/null || true
  return "$rc"
}

# FAIL-CLOSED isolation guard — refuse to run if anything points at production.
echo "── isolation guard ──"
guard_fail=0
[[ "$FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE" == "Claude Code-credentials" ]] && { echo "REFUSE: prod keychain service"; guard_fail=1; }
[[ "$FLYWHEEL_CLAUDE_PROFILES_DIR" == "$HOME/.flywheel/claude-profiles" ]] && { echo "REFUSE: prod pool"; guard_fail=1; }
[[ "$FLYWHEEL_CLAUDE_JSON" == "$HOME/.claude.json" ]] && { echo "REFUSE: prod claude.json"; guard_fail=1; }
[[ "$FLYWHEEL_CLAUDE_SECURITY_BIN" == "/usr/bin/security" ]] && { echo "REFUSE: real security(1)"; guard_fail=1; }
[[ "$FLYWHEEL_CLAUDE_PROFILES_DIR" == "$ROOT"/* ]] || { echo "REFUSE: pool outside scratch root"; guard_fail=1; }
# FLY-1182 #618: the new quota gate reads a store + a guard bin that default to
# production — assert BOTH are scratch, or the gate would touch production data.
[[ "$FLYWHEEL_CLAUDE_ACCOUNTS_PATH" == "$HOME/.flywheel/claude-accounts.json" ]] && { echo "REFUSE: prod accounts store"; guard_fail=1; }
[[ "$FLYWHEEL_CLAUDE_ACCOUNTS_PATH" == "$ROOT"/* ]] || { echo "REFUSE: accounts store outside scratch root"; guard_fail=1; }
[[ "$FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN" == "$ROOT"/* ]] || { echo "REFUSE: quota guard bin outside scratch root"; guard_fail=1; }
# Codex R1 HIGH-1: the transition journal defaults to production; assert scratch.
[[ "$FLYWHEEL_CLAUDE_TRANSITION_JOURNAL" == "$HOME/.flywheel/claude-account-transition.json" ]] && { echo "REFUSE: prod transition journal"; guard_fail=1; }
[[ "$FLYWHEEL_CLAUDE_TRANSITION_JOURNAL" == "$ROOT"/* ]] || { echo "REFUSE: transition journal outside scratch root"; guard_fail=1; }
if [[ "$guard_fail" == "1" ]]; then echo "isolation guard tripped — refusing to run"; exit 90; fi
ok "isolation guard: every knob points at scratch, not production (incl. #618 quota store + guard bin + transition journal)"

# Codex R1 HIGH-1: a transient write-then-delete leaves no hash diff, so S4's
# byte-identity check cannot catch it. Record whether the production journal
# EXISTS before the run; S4 asserts the run did not create it (existence, not hash).
PROD_JOURNAL="$HOME/.flywheel/claude-account-transition.json"
PROD_JOURNAL_EXISTED_BEFORE=0; [[ -e "$PROD_JOURNAL" ]] && PROD_JOURNAL_EXISTED_BEFORE=1

# Production preimage (red line: must be byte-identical afterwards).
#
# ~/.claude.json is deliberately NOT a sentinel: it is rewritten continuously by
# the live claude fleet (measured — it drifted on its own inside a 25s window
# with no drill running), so asserting byte-identity on it yields a FALSE red-
# line breach. Isolation from it is proven positively instead, by S5 below.
PROD_SENTINELS=(
  "$HOME/.flywheel/quota-monitor.json"
  "$HOME/.flywheel/claude-accounts.json"
  "$HOME/.flywheel/claude-profiles/.active"
)
PROD_HASHES_BEFORE="$ROOT/prod-before.txt"
: > "$PROD_HASHES_BEFORE"
for f in "${PROD_SENTINELS[@]}"; do [[ -f "$f" ]] && shasum -a 256 "$f" >> "$PROD_HASHES_BEFORE"; done
PROD_CLAUDE_JSON_BEFORE=$(shasum -a 256 "$HOME/.claude.json" 2>/dev/null | cut -d' ' -f1)
SCRATCH_CJ_BEFORE=$(shasum -a 256 "$CLAUDE_JSON" | cut -d' ' -f1)

echo
echo "── S1: verify + commit (happy path) ──"
S1_OUT=$(invoke_profile_use bravo 2>&1); S1_RC=$?
KC_NOW=$(cat "$STATE"); ACTIVE_NOW=$(cat "$POOL/.active")
if [[ "$S1_RC" == "0" && "$KC_NOW" == "$SECRET_BRAVO" && "$ACTIVE_NOW" == "bravo" ]]; then
  ok "S1 commit: rc=0, keychain=bravo credential, .active=bravo"
else
  bad "S1 commit: rc=$S1_RC keychain-matches-bravo=$([[ "$KC_NOW" == "$SECRET_BRAVO" ]] && echo yes || echo no) .active=$ACTIVE_NOW"
  note "output: $(printf '%s' "$S1_OUT" | tail -2)"
fi

echo
echo "── S2: rollback (verify-before-commit fails) ──"
# Reset to a known-good alpha state, then force every write to corrupt.
printf '%s' "$SECRET_ALPHA" > "$STATE"; printf 'alpha' > "$POOL/.active"
PRE_KC=$(cat "$STATE"); PRE_ACTIVE=$(cat "$POOL/.active")
S2_ARGV_BEFORE=$(wc -l < "$ARGV_LOG" | tr -d ' ')
export FAKE_SEC_CORRUPT_ONCE="$ROOT/corrupt-once"
: > "$FAKE_SEC_CORRUPT_ONCE"      # armed: the NEXT write corrupts, later ones don't
S2_OUT=$(invoke_profile_use bravo 2>&1); S2_RC=$?
unset FAKE_SEC_CORRUPT_ONCE
POST_KC=$(cat "$STATE"); POST_ACTIVE=$(cat "$POOL/.active")
S2_ARGV_AFTER=$(wc -l < "$ARGV_LOG" | tr -d ' ')

# GUARD (Codex R1 MEDIUM-1): the rollback assertions are only meaningful if the
# run reached the Keychain WRITE. Counting any new security argv line is too weak
# — the forced pre-write `kc_read` (find-generic-password) alone satisfies it, so
# a bail between the read and the write would make "keychain unchanged" trivially
# green. Require that a `-i` WRITE actually happened in the S2 window AND that the
# corrupt-once marker was consumed (proving the corrupted first write occurred).
S2_WRITES=$(tail -n +"$((S2_ARGV_BEFORE + 1))" "$ARGV_LOG" | grep -c '^-i')
S2_CORRUPT_CONSUMED=0; [[ ! -e "$ROOT/corrupt-once" ]] && S2_CORRUPT_CONSUMED=1
if [[ "$S2_WRITES" -ge 1 && "$S2_CORRUPT_CONSUMED" == "1" ]]; then
  ok "S2 precondition: a real Keychain write happened ($S2_WRITES '-i' write(s)) and the corrupt-once marker was consumed"
else
  bad "S2 PRECONDITION: no Keychain WRITE in the S2 window (writes=$S2_WRITES, corrupt-consumed=$S2_CORRUPT_CONSUMED) — rollback assertions would be VACUOUS"
  note "output: $(printf '%s' "$S2_OUT" | tail -2)"
fi

[[ "$S2_RC" != "0" ]] && ok "S2 rollback: refused with non-zero exit (rc=$S2_RC)" \
                      || bad "S2 rollback: exited 0 — a corrupted write was accepted!"
if [[ "$POST_KC" == "$PRE_KC" ]]; then
  ok "S2 rollback: keychain restored byte-identical to the preimage (login NOT broken)"
else
  bad "S2 rollback: keychain left as '$POST_KC' (expected the alpha preimage) — RED LINE BREACH"
fi
[[ "$POST_ACTIVE" == "$PRE_ACTIVE" ]] && ok "S2 rollback: .active unchanged ($POST_ACTIVE)" \
                                      || bad "S2 rollback: .active drifted to $POST_ACTIVE"
note "refusal message: $(printf '%s' "$S2_OUT" | grep -io 'rolled back[^\"]*' | head -1)"

echo
echo "── S3: argv hygiene (no credential in any security(1) argv) ──"
ARGV_LINES=$(wc -l < "$ARGV_LOG" | tr -d ' ')
LEAK=0
for s in "$MARK_ALPHA" "$MARK_BRAVO"; do
  grep -q -- "$s" "$ARGV_LOG" && { LEAK=1; bad "S3: credential marker '$s' LEAKED into security argv"; }
done
[[ "$LEAK" == "0" ]] && ok "S3: zero credential markers in $ARGV_LINES logged security argv lines"
# Positive control: an empty/unreadable log would make the leak check vacuous —
# it must contain a string we KNOW is there, proving security(1) really ran.
if [[ "$ARGV_LINES" -gt 0 ]] && grep -q -- "find-generic-password" "$ARGV_LOG"; then
  ok "S3 positive control: security(1) really ran ($ARGV_LINES argv lines, 'find-generic-password' present)"
else
  bad "S3 positive control FAILED — $ARGV_LINES argv lines; security(1) never ran, so the leak check proves NOTHING"
fi

echo
echo "── S4: production untouched ──"
PROD_HASHES_AFTER="$ROOT/prod-after.txt"
: > "$PROD_HASHES_AFTER"
for f in "${PROD_SENTINELS[@]}"; do [[ -f "$f" ]] && shasum -a 256 "$f" >> "$PROD_HASHES_AFTER"; done
if diff -q "$PROD_HASHES_BEFORE" "$PROD_HASHES_AFTER" >/dev/null 2>&1; then
  ok "S4: $(wc -l < "$PROD_HASHES_BEFORE" | tr -d ' ') production sentinels byte-identical (quota-monitor.json / claude-accounts.json / pool .active)"
else
  bad "S4: a production sentinel CHANGED — red line breach"; diff "$PROD_HASHES_BEFORE" "$PROD_HASHES_AFTER"
fi
# Codex R2 MEDIUM (honest scope): the REAL protection against the journal write is
# the scratch INJECTION above (the binary physically cannot reach the production
# path). This existence check is only a belt: it catches RESIDUE — a journal LEFT
# on the production path (e.g. a mid-switch failure that never reached the clear).
# It does NOT catch a clean write-then-delete (absent before AND after), so it is
# not claimed to. Injection is what makes the clean case impossible.
if [[ "$PROD_JOURNAL_EXISTED_BEFORE" == "0" && -e "$PROD_JOURNAL" ]]; then
  bad "S4: production transition journal RESIDUE left by the run — isolation breach (journal not injected to scratch)"
else
  ok "S4: no production transition-journal residue (belt; the clean case is prevented by the scratch injection asserted in the guard)"
fi

echo
echo "── S5: ~/.claude.json isolation (proved positively, not by byte-identity) ──"
SCRATCH_CJ_AFTER=$(shasum -a 256 "$CLAUDE_JSON" | cut -d' ' -f1)
PROD_CLAUDE_JSON_AFTER=$(shasum -a 256 "$HOME/.claude.json" 2>/dev/null | cut -d' ' -f1)
if [[ "$SCRATCH_CJ_AFTER" != "$SCRATCH_CJ_BEFORE" ]]; then
  ok "S5: the identity write landed in the SCRATCH claude.json — FLYWHEEL_CLAUDE_JSON redirect is real"
  note "scratch ${SCRATCH_CJ_BEFORE:0:12}… → ${SCRATCH_CJ_AFTER:0:12}…"
  note "prod    ${PROD_CLAUDE_JSON_BEFORE:0:12}… → ${PROD_CLAUDE_JSON_AFTER:0:12}… (drifts on its own; live fleet writes it — NOT a drill signal)"
else
  bad "S5: scratch claude.json never written — cannot prove the redirect carried the identity write"
fi

echo
echo "── S6: NEW quota gate (#618) — an EXHAUSTED target is refused, keychain untouched ──"
# Reset to a clean alpha baseline, arm the guard to report the target exhausted.
printf '%s' "$SECRET_ALPHA" > "$STATE"; printf 'alpha' > "$POOL/.active"
S6_PRE_KC=$(cat "$STATE"); S6_PRE_ACTIVE=$(cat "$POOL/.active")
S6_OUT=$(FAKE_QUOTA_RC=32 invoke_profile_use bravo 2>&1); S6_RC=$?
S6_KC=$(cat "$STATE"); S6_ACTIVE=$(cat "$POOL/.active")
[[ "$S6_RC" != "0" ]] && ok "S6: exhausted target refused with non-zero exit (rc=$S6_RC)" \
                      || bad "S6: exited 0 — switched to an EXHAUSTED account!"
{ [[ "$S6_KC" == "$S6_PRE_KC" ]] && [[ "$S6_ACTIVE" == "$S6_PRE_ACTIVE" ]]; } \
  && ok "S6: keychain + .active unchanged (the exhausted target never landed)" \
  || bad "S6: state moved despite exhausted target — kc-match=$([[ "$S6_KC" == "$S6_PRE_KC" ]] && echo y || echo n) active=$S6_ACTIVE"
printf '%s' "$S6_OUT" | grep -qi "exhausted" \
  && ok "S6: refusal names the reason (exhausted)" \
  || bad "S6: refusal did not mention 'exhausted' — silent/misleading"

echo
echo "── S7: NEW quota gate (#618) — evidence UNAVAILABLE is fail-closed, keychain untouched ──"
printf '%s' "$SECRET_ALPHA" > "$STATE"; printf 'alpha' > "$POOL/.active"
S7_PRE_KC=$(cat "$STATE")
S7_OUT=$(FAKE_QUOTA_RC=33 invoke_profile_use bravo 2>&1); S7_RC=$?
S7_KC=$(cat "$STATE"); S7_ACTIVE=$(cat "$POOL/.active")
[[ "$S7_RC" != "0" ]] && ok "S7: evidence-unavailable refused with non-zero exit (rc=$S7_RC) — fail-closed" \
                      || bad "S7: exited 0 — switched WITHOUT live quota evidence (fail-OPEN)!"
{ [[ "$S7_KC" == "$S7_PRE_KC" ]] && [[ "$S7_ACTIVE" == "alpha" ]]; } \
  && ok "S7: keychain + .active unchanged" \
  || bad "S7: state moved despite unavailable evidence"
# Positive control for the whole gate: with a HEALTHY guard the SAME switch is
# allowed — proves S6/S7 refusals come from the verdict, not a blanket block.
printf '%s' "$SECRET_ALPHA" > "$STATE"; printf 'alpha' > "$POOL/.active"
FAKE_QUOTA_RC=0 invoke_profile_use bravo >/dev/null 2>&1
[[ "$(cat "$STATE")" == "$SECRET_BRAVO" ]] \
  && ok "S7 positive control: a HEALTHY guard (rc=0) DOES allow the switch — the gate is not a blanket block" \
  || bad "S7 positive control: healthy guard still blocked — gate is over-blocking or harness broken"

echo
echo "════════ RESULT: $PASS passed, $FAIL failed ════════"
exit $(( FAIL > 0 ? 1 : 0 ))
