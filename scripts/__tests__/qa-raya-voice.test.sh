#!/usr/bin/env bash
set -uo pipefail

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2126-wrapper.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$REPO_ROOT/scripts/qa-raya-voice.sh"
FAKE_HOME="$ROOT/home"
HARNESS="$ROOT/harness"
SUBJECT="$ROOT/subject"
mkdir -p "$FAKE_HOME/.flywheel" "$HARNESS/scripts/qa" "$SUBJECT"

cat > "$FAKE_HOME/.flywheel/.env" <<'EOF'
TEST_BOT_TOKEN_1=emitter-secret-value
TEST_BOT_TOKEN_2=voice-secret-value
TEST_BOT_TOKEN_3=third-secret-value
RAYA_BOT_TOKEN=production-raya-secret
SUPABASE_SERVICE_ROLE_KEY=production-supabase-secret
EOF
chmod 600 "$FAKE_HOME/.flywheel/.env"
cat > "$FAKE_HOME/.flywheel/test-slots.json" <<'EOF'
{"slots":[
  {"id":1,"botAppId":"1511111111111111111","tokenEnvVar":"TEST_BOT_TOKEN_1"},
  {"id":2,"botAppId":"1522222222222222222","tokenEnvVar":"TEST_BOT_TOKEN_2"},
  {"id":3,"botAppId":"1533333333333333333","tokenEnvVar":"TEST_BOT_TOKEN_3"}
]}
EOF

cat > "$HARNESS/scripts/qa/raya-voice-529.mjs" <<'EOF'
import { readFileSync, statSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--contract-version") {
  console.log(process.env.HANDSHAKE_VERSION ?? "raya-voice-529/v1");
  process.exit(0);
}
const value = (name) => args[args.indexOf(name) + 1];
const emitterPath = value("--emitter-bot-env");
const voicePath = value("--voice-bot-env");
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args,
  emitterPath,
  voicePath,
  emitterToken: readFileSync(emitterPath, "utf8").trim(),
  voiceToken: readFileSync(voicePath, "utf8").trim(),
  emitterMode: statSync(emitterPath).mode & 0o777,
  voiceMode: statSync(voicePath).mode & 0o777,
  inheritedSecretNames: [
    "TEST_BOT_TOKEN_1",
    "TEST_BOT_TOKEN_2",
    "TEST_BOT_TOKEN_3",
    "RAYA_BOT_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
  ].filter((name) => process.env[name] !== undefined),
}));
if (process.env.HOLD_PATH) {
  writeFileSync(process.env.HOLD_PATH, "ready\n");
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(process.env.HARNESS_RC ?? 0));
}
EOF

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

run_wrapper() {
  HOME="$FAKE_HOME" CAPTURE_PATH="$ROOT/capture.json" \
    /bin/bash "$WRAPPER" --harness-root "$HARNESS" --subject-root "$SUBJECT" "$@"
}

rm -f "$ROOT/capture.json"
if run_wrapper >"$ROOT/success.out" 2>"$ROOT/success.err"; then
  pass "distinct default bot slots invoke the harness"
else
  fail "distinct default bot slots invoke the harness"
fi
if [[ "$(jq -r '.emitterToken' "$ROOT/capture.json")" == "DISCORD_BOT_TOKEN=emitter-secret-value" \
  && "$(jq -r '.voiceToken' "$ROOT/capture.json")" == "DISCORD_BOT_TOKEN=voice-secret-value" \
  && "$(jq -r '.emitterMode' "$ROOT/capture.json")" == 384 \
  && "$(jq -r '.voiceMode' "$ROOT/capture.json")" == 384 ]]; then
  pass "wrapper creates two distinct owner-private token files"
else
  fail "wrapper creates two distinct owner-private token files"
fi
if [[ "$(jq -c '.inheritedSecretNames' "$ROOT/capture.json")" == "[]" ]]; then
  pass "harness inherits none of the credential source secrets"
else
  fail "harness inherited secrets outside the two owner-private files"
fi
EMITTER_PATH="$(jq -r '.emitterPath' "$ROOT/capture.json")"
VOICE_PATH="$(jq -r '.voicePath' "$ROOT/capture.json")"
if [[ ! -e "$EMITTER_PATH" && ! -e "$VOICE_PATH" ]]; then
  pass "success removes both temporary credentials"
else
  fail "success removes both temporary credentials"
fi

rm -f "$ROOT/capture.json"
set +e
run_wrapper --emitter-bot 1 --voice-bot 1 >"$ROOT/same.out" 2>"$ROOT/same.err"
RC=$?
set -e
if [[ "$RC" == 64 && ! -e "$ROOT/capture.json" ]]; then
  pass "same slot is rejected before harness login"
else
  fail "same slot rc=$RC capture=$(test -e "$ROOT/capture.json" && echo yes || echo no)"
fi

rm -f "$ROOT/capture.json"
set +e
run_wrapper --voice-bot-env "$ROOT/operator-token.env" >"$ROOT/override.out" 2>"$ROOT/override.err"
RC=$?
set -e
if [[ "$RC" == 64 && ! -e "$ROOT/capture.json" ]]; then
  pass "wrapper-owned harness credentials cannot be overridden by passthrough"
else
  fail "protected passthrough override rc=$RC"
fi

cp "$FAKE_HOME/.flywheel/.env" "$ROOT/clean.env"
printf '%s\n' \
  'CONTRACT_VERSION=poisoned/v9' \
  'EMITTER_SLOT=3' \
  'VOICE_SLOT=3' \
  'HARNESS_CLI=/tmp/not-the-harness.mjs' \
  >> "$FAKE_HOME/.flywheel/.env"
rm -f "$ROOT/capture.json"
if run_wrapper >"$ROOT/clobber.out" 2>"$ROOT/clobber.err"; then
  pass "credential source cannot clobber validated wrapper state"
else
  fail "credential source clobbered validated wrapper state"
fi
mv "$ROOT/clean.env" "$FAKE_HOME/.flywheel/.env"

jq '(.slots[] | select(.id == 1) | .tokenEnvVar) = "RAYA_QA_EMITTER_TOKEN" |
    (.slots[] | select(.id == 2) | .tokenEnvVar) = "RAYA_QA_VOICE_TOKEN"' \
  "$FAKE_HOME/.flywheel/test-slots.json" > "$ROOT/slots.tmp"
mv "$ROOT/slots.tmp" "$FAKE_HOME/.flywheel/test-slots.json"
printf '%s\n' \
  'RAYA_QA_EMITTER_TOKEN=registry-emitter-secret' \
  'RAYA_QA_VOICE_TOKEN=registry-voice-secret' \
  >> "$FAKE_HOME/.flywheel/.env"
rm -f "$ROOT/capture.json"
if run_wrapper >"$ROOT/registry.out" 2>"$ROOT/registry.err" \
  && [[ "$(jq -r '.emitterToken' "$ROOT/capture.json")" == "DISCORD_BOT_TOKEN=registry-emitter-secret" \
  && "$(jq -r '.voiceToken' "$ROOT/capture.json")" == "DISCORD_BOT_TOKEN=registry-voice-secret" ]]; then
  pass "slot registry owns the token environment variable names"
else
  fail "wrapper ignored slot tokenEnvVar mapping"
fi
jq '(.slots[] | select(.id == 1) | .tokenEnvVar) = "TEST_BOT_TOKEN_1" |
    (.slots[] | select(.id == 2) | .tokenEnvVar) = "TEST_BOT_TOKEN_2"' \
  "$FAKE_HOME/.flywheel/test-slots.json" > "$ROOT/slots.tmp"
mv "$ROOT/slots.tmp" "$FAKE_HOME/.flywheel/test-slots.json"

jq '.slots[2].botAppId = .slots[0].botAppId' "$FAKE_HOME/.flywheel/test-slots.json" > "$ROOT/slots.tmp"
mv "$ROOT/slots.tmp" "$FAKE_HOME/.flywheel/test-slots.json"
set +e
run_wrapper --emitter-bot 1 --voice-bot 3 >"$ROOT/same-id.out" 2>"$ROOT/same-id.err"
RC=$?
set -e
if [[ "$RC" == 64 ]]; then pass "different slots with one bot id are rejected"; else fail "same id rc=$RC"; fi

set +e
HOME="$FAKE_HOME" HANDSHAKE_VERSION="wrong/v9" CAPTURE_PATH="$ROOT/capture.json" \
  /bin/bash "$WRAPPER" --harness-root "$HARNESS" --subject-root "$SUBJECT" \
  >"$ROOT/handshake.out" 2>"$ROOT/handshake.err"
RC=$?
set -e
if [[ "$RC" == 78 ]]; then pass "contract mismatch fails at 78"; else fail "contract mismatch rc=$RC"; fi

jq '.slots[2].botAppId = "1533333333333333333"' "$FAKE_HOME/.flywheel/test-slots.json" > "$ROOT/slots.tmp"
mv "$ROOT/slots.tmp" "$FAKE_HOME/.flywheel/test-slots.json"
rm -f "$ROOT/capture.json"
set +e
HOME="$FAKE_HOME" CAPTURE_PATH="$ROOT/capture.json" HARNESS_RC=20 \
  /bin/bash "$WRAPPER" --harness-root "$HARNESS" --subject-root "$SUBJECT" \
  >"$ROOT/fail.out" 2>"$ROOT/fail.err"
RC=$?
set -e
EMITTER_PATH="$(jq -r '.emitterPath' "$ROOT/capture.json")"
VOICE_PATH="$(jq -r '.voicePath' "$ROOT/capture.json")"
if [[ "$RC" == 20 && ! -e "$EMITTER_PATH" && ! -e "$VOICE_PATH" ]]; then
  pass "harness failure code is preserved after credential cleanup"
else
  fail "harness failure cleanup rc=$RC"
fi

rm -f "$ROOT/capture.json" "$ROOT/hold.ready"
HOME="$FAKE_HOME" CAPTURE_PATH="$ROOT/capture.json" HOLD_PATH="$ROOT/hold.ready" \
  /bin/bash "$WRAPPER" --harness-root "$HARNESS" --subject-root "$SUBJECT" \
  >"$ROOT/signal.out" 2>"$ROOT/signal.err" &
WRAPPER_PID=$!
for _ in $(seq 1 300); do
  [[ -f "$ROOT/hold.ready" ]] && break
  sleep 0.1
done
if [[ -f "$ROOT/hold.ready" ]]; then
  kill -TERM "$WRAPPER_PID"
else
  kill -TERM "$WRAPPER_PID" 2>/dev/null || true
fi
set +e
wait "$WRAPPER_PID"
RC=$?
set -e
if [[ ! -f "$ROOT/hold.ready" ]]; then
  fail "harness did not become ready before the signal-test deadline"
elif [[ ! -f "$ROOT/capture.json" ]]; then
  fail "signal test became ready without writing its capture receipt"
else
  EMITTER_PATH="$(jq -r '.emitterPath' "$ROOT/capture.json")"
  VOICE_PATH="$(jq -r '.voicePath' "$ROOT/capture.json")"
  if [[ "$RC" == 143 && ! -e "$EMITTER_PATH" && ! -e "$VOICE_PATH" ]]; then
    pass "SIGTERM forwards to the harness and removes both credentials"
  else
    fail "signal cleanup rc=$RC"
  fi
fi

if rg -q 'emitter-secret-value|voice-secret-value' "$ROOT"/*.out "$ROOT"/*.err; then
  fail "wrapper output leaked a configured token"
else
  pass "success and failure output remain token-free"
fi

printf '[TEST] %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
