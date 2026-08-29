#!/bin/bash
# FLY-519: fleet-sanitize.sh — env redaction + secret scanning.
#
# Covers (plan §2 + Tadashi over-read hardening):
#   redact_env_to_keys:
#     R1) KEY=VALUE → KEY= (value stripped); R2c/R2d) source comments dropped
#     R2) `export KEY=VALUE` → `export KEY=`; value containing `=`/quotes stripped
#     R3) redacted output is secret-clean per scan_for_secrets
#   scan_for_secrets:
#     S1) bare vendor tokens flagged: Discord, Slack xox, OpenAI sk-, GitHub
#         ghp_/github_pat_, AWS AKIA, JWT eyJ  (Tadashi: bare-token net incl bare sk-)
#     S2) shell assignment of a secret-named key to a real value flagged;
#         empty / __PLACEHOLDER__ / <...> / CHANGE_ME values NOT flagged
#     S3) legit capture content (projects.json token ENV *names*, decimal channel
#         IDs, repo URLs, booleans) → ZERO false positives
#     S4) high-entropy bare blob (mixed case+digit, long) flagged
#
# Hermetic: no live execution; pure function exercise in a temp sandbox.
set -uo pipefail

PASSED=0
FAILED=0
log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="${REPO_ROOT}/scripts/lib/fleet-sanitize.sh"

SANDBOX="$(mktemp -d -t fly519-sanitize-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# shellcheck disable=SC1090
source "$LIB"

# ── redact_env_to_keys ────────────────────────────────────────────────────
ENV_IN="$SANDBOX/in.env"
ENV_OUT="$SANDBOX/out.env"
cat > "$ENV_IN" <<'EOF'
# a comment
# operator note: temporary recovery password hunter2-do-not-share-7788
FLYWHEEL_COS_BOT_TOKEN=MTIzNDU2.abcdef.realsecretvalue1234567890ZZ

export OPENAI_API_KEY=sk-proj-realrealrealrealrealrealrealreal12
QUOTED_SECRET="value=with=equals and spaces"
TEAMLEAD_PORT=9876
EOF

redact_env_to_keys "$ENV_IN" "$ENV_OUT"

if grep -q '^FLYWHEEL_COS_BOT_TOKEN=$' "$ENV_OUT" \
  && ! grep -q 'realsecretvalue' "$ENV_OUT"; then
  pass "R1: KEY=VALUE redacted to KEY= (value stripped)"
else
  fail "R1: KEY=VALUE redaction"; cat "$ENV_OUT"
fi

if grep -q '^export OPENAI_API_KEY=$' "$ENV_OUT" \
  && ! grep -q 'sk-proj-real' "$ENV_OUT"; then
  pass "R2a: export KEY=VALUE → export KEY="
else
  fail "R2a: export redaction"; cat "$ENV_OUT"
fi

if grep -q '^QUOTED_SECRET=$' "$ENV_OUT" \
  && ! grep -q 'with=equals' "$ENV_OUT"; then
  pass "R2b: value containing '=' and quotes fully stripped"
else
  fail "R2b: equals/quoted value strip"; cat "$ENV_OUT"
fi

# Codex design-review HIGH: source comments must NOT be preserved (an operator
# may hide a secret in a comment); only key names + a safe synthetic header.
if grep -q '^TEAMLEAD_PORT=$' "$ENV_OUT" \
  && ! grep -q '^# a comment$' "$ENV_OUT" \
  && grep -q 'KEY NAMES ONLY' "$ENV_OUT"; then
  pass "R2c: source comments dropped, key names kept, synthetic header present"
else
  fail "R2c: comment-drop + synthetic header"; cat "$ENV_OUT"
fi

# R2d: a secret written into a .env COMMENT must not survive into env.example
if ! grep -q 'hunter2' "$ENV_OUT"; then
  pass "R2d: secret hidden in a .env comment is dropped (not leaked)"
else
  fail "R2d: comment-secret leaked into env.example"; cat "$ENV_OUT"
fi

if scan_for_secrets "$ENV_OUT"; then
  pass "R3: redacted output passes scan_for_secrets (clean, exit 0)"
else
  fail "R3: redacted output should be scan-clean"
fi

# ── scan_for_secrets: bare vendor tokens (S1) ─────────────────────────────
check_flag() {  # <desc> <content>
  local desc="$1" content="$2" f="$SANDBOX/probe"
  printf '%s\n' "$content" > "$f"
  if scan_for_secrets "$f" >/dev/null 2>&1; then
    fail "$desc (should have been flagged, got clean exit)"
  else
    pass "$desc"
  fi
}
check_clean() {  # <desc> <content>
  local desc="$1" content="$2" f="$SANDBOX/probe"
  printf '%s\n' "$content" > "$f"
  if scan_for_secrets "$f" >/dev/null 2>&1; then
    pass "$desc"
  else
    fail "$desc (false positive — should be clean)"
  fi
}

DISCORD_FIXTURE='MTk4NjIyNDgzNDcxOTI1MjQ4''.''GqwqZ9''.''someactualtokenpartXYZ0123456789ab'
SLACK_FIXTURE='xoxb-''1234567890-abcdefghijklmnop'
OPENAI_FIXTURE='sk-proj-''abcdefghijklmnopqrstuvwxyz0123456789ABCD'
GITHUB_CLASSIC_FIXTURE='ghp_''abcdefghijklmnopqrstuvwxyz0123456789AB'
GITHUB_PAT_FIXTURE='github_pat_''11ABCDEFG0abcdefghij_klmnopqrstuvwxyz0123456789ABCDE'
AWS_FIXTURE='AKIA''IOSFODNN7EXAMPLE'
check_flag  "S1-discord: bare Discord bot token" "$DISCORD_FIXTURE"
check_flag  "S1-slack: bare xoxb- token" "$SLACK_FIXTURE"
check_flag  "S1-openai: bare sk- token (Tadashi)" "$OPENAI_FIXTURE"
check_flag  "S1-github-classic: ghp_ token" "$GITHUB_CLASSIC_FIXTURE"
check_flag  "S1-github-pat: github_pat_ token" "$GITHUB_PAT_FIXTURE"
check_flag  "S1-aws: AKIA access key id" "$AWS_FIXTURE"
check_flag  "S1-jwt: bare JWT" \
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'
check_flag  "S1-fwk: Flywheel license key (FLY-1062)" \
  'fwk_0123456789abcdef0123456789abcdef'
check_clean "S1-fwk-short: fwk_ prefix with too little entropy is not a key" \
  'fwk_0123abcd'

# ── scan_for_secrets: shell assignment of real value (S2) ─────────────────
check_flag  "S2-realvalue: secret-named key = arbitrary non-placeholder value" \
  'MY_CUSTOM_SECRET=ZxQ7-not-a-vendor-format-but-real-9aBc'
check_clean "S2-empty: secret-named key with empty value" \
  'FLYWHEEL_COS_BOT_TOKEN='
check_clean "S2-placeholder: __PLACEHOLDER__ value" \
  'DISCORD_BOT_TOKEN=__PLACEHOLDER__'
check_clean "S2-angle: <fill-me> value" \
  'SOME_API_KEY=<fill-me>'
check_clean "S2-changeme: CHANGE_ME value" \
  'ADMIN_PASSWORD=CHANGE_ME'
check_clean "S2-nonsecret-name: port number, key name not secret-ish" \
  'TEAMLEAD_PORT=9876'

# ── scan_for_secrets: legit capture content must NOT false-positive (S3) ──
PROJ="$SANDBOX/projects.json"
cat > "$PROJ" <<'EOF'
{
  "projects": [
    { "projectName": "flywheel",
      "leads": [
        { "agentId": "flywheel-cos-lead",
          "chatChannel": "1512578695468941333",
          "botTokenEnv": "FLYWHEEL_COS_BOT_TOKEN",
          "model": "sonnet",
          "match": { "labels": ["Flywheel"] } }
      ],
      "projectDir": "/Users/x/Dev/flywheel" }
  ]
}
EOF
check_clean "S3-projects.json: token ENV names + channel IDs + paths are clean" \
  "$(cat "$PROJ")"

check_clean "S3-repo-url: a github clone url is not a secret" \
  'https://github.com/ceedaragents/flywheel.git'
check_clean "S3-screaming-snake: an all-caps env NAME value is not a secret" \
  'BOT_TOKEN_ENV=FLYWHEEL_GEOFORGE3D_PRODUCT_BOT_TOKEN'

# ── scan_for_secrets: high-entropy bare blob (S4) ─────────────────────────
check_flag  "S4-highentropy: long mixed-case+digit random blob" \
  'aZ9kQ2mB7xT4wR1nP6vL3jH8sD5fG0cYbN2eM4uK7iO1pA3'

# ── Codex R1 HIGH-1 regression: secret-named values beyond shell KEY=val ──
check_flag  "S5-json-hex: camelCase JSON apiKey with hex value" \
  '{"apiKey":"abcdef0123456789abcdef0123456789"}'
check_flag  "S5b-json-bare-sk: JSON key with bare sk- value" \
  '{"openaiKey": "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"}'
check_flag  "S6-comment: secret-named assignment inside a comment" \
  '# OLD_API_KEY=9f8e7d6c5b4a39281706fedcba0918273645'
check_flag  "S7-base64slash: yaml secret with base64 (+/=) value" \
  'secret: "aGVsbG8vd29ybGQrZm9vL2Jhcg==paddedlongvalue"'
check_clean "S8-camel-envname: camelCase key whose value is a SCREAMING_SNAKE env name" \
  '"botTokenEnv": "FLYWHEEL_COS_BOT_TOKEN",'
check_clean "S8b-channelid: camelCase id key with a decimal snowflake value" \
  '"chatChannel": "1512578695468941333",'

# ── Codex R2 HIGH regression: minified multi-field line, secret hides behind
#    a leading env-name / decimal id (all token runs on the line are checked) ─
check_flag  "S9-minified-behind-envname: secret after a SCREAMING_SNAKE value" \
  '{"botTokenEnv":"FLYWHEEL_COS_BOT_TOKEN","apiKey":"abcdef0123456789abcdef0123456789"}'
check_flag  "S10-minified-behind-id: secret after a decimal channel id" \
  '{"chatChannel":"1512578695468941333","apiKey":"abcdef0123456789abcdef0123456789"}'
check_clean "S11-minified-clean: minified line of only env names + ids" \
  '{"botTokenEnv":"FLYWHEEL_COS_BOT_TOKEN","chatChannel":"1512578695468941333"}'

# ── FLY-1023 M0: scan_string_for_secrets (single-value form; same patterns) ─
if scan_string_for_secrets "check stuck orders daily" >/dev/null 2>&1; then
  pass "STR1-clean: ordinary sentence passes the string scan"
else
  fail "STR1-clean: ordinary sentence flagged"
fi
if ! scan_string_for_secrets "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcd1234" >/dev/null 2>&1; then
  pass "STR2-vendor: GitHub token flagged by the string scan"
else
  fail "STR2-vendor: GitHub token NOT flagged"
fi
if ! scan_string_for_secrets "LINEAR_API_KEY=lin_api_realLooking0123456789" >/dev/null 2>&1; then
  pass "STR3-assignment: secret-named assignment flagged by the string scan"
else
  fail "STR3-assignment: secret assignment NOT flagged"
fi
scan_string_for_secrets >/dev/null 2>&1; STR_RC=$?
if [ "$STR_RC" -eq 2 ]; then
  pass "STR4-usage: no-arg call returns 2 (usage error)"
else
  fail "STR4-usage: rc=$STR_RC (want 2)"
fi

# ── TREE-ERR: scanner TOOL errors must return 2, never read as "clean" ───────
# (FLY-1062 broker gate Codex R4: grep exit >1 / find failure = incompletely
#  scanned tree — the previous `|| true` turned those into empty findings.)
TREE_OK="$SANDBOX/tree-ok"; mkdir -p "$TREE_OK"; echo "hello" > "$TREE_OK/a.mjs"
if scan_code_tree_for_secrets "$TREE_OK" >/dev/null 2>&1; then
  pass "TREE-ERR0: clean readable tree still returns 0"
else
  fail "TREE-ERR0: clean tree no longer passes"
fi
TREE_ERR="$SANDBOX/tree-err"; mkdir -p "$TREE_ERR/locked"
echo "hello" > "$TREE_ERR/locked/a.mjs"
chmod 000 "$TREE_ERR/locked"
scan_code_tree_for_secrets "$TREE_ERR" >/dev/null 2>&1; TREE_RC=$?
chmod 755 "$TREE_ERR/locked"
if [ "$TREE_RC" -eq 2 ]; then
  pass "TREE-ERR1: unreadable subtree → return 2 (tool error, fail-closed)"
else
  fail "TREE-ERR1: rc=$TREE_RC (want 2 — an unscannable tree must not read as clean)"
fi

# ── SFS-ERR: scan_for_secrets itself must return 2 on an unreadable input ────
# (FLY-1062 Codex R5: the config-class leg's inner greps previously swallowed
#  tool errors into empty candidate sets → clean.)
SFS_ERR="$SANDBOX/sfs-err.json"
echo '{ "ok": true }' > "$SFS_ERR"
chmod 000 "$SFS_ERR"
scan_for_secrets "$SFS_ERR" >/dev/null 2>&1; SFS_RC=$?
chmod 644 "$SFS_ERR"
if [ "$SFS_RC" -eq 2 ]; then
  pass "SFS-ERR1: unreadable input file → return 2 (tool error, fail-closed)"
else
  fail "SFS-ERR1: rc=$SFS_RC (want 2 — an unscannable input must not read as clean)"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
