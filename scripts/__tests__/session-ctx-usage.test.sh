#!/bin/bash
# FLY-1716: prove the offline Lead transcript context reader's three-state contract.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
READER="$ROOT/packages/teamlead/scripts/lib/session-ctx-usage.mjs"
TMP="$(mktemp -d /tmp/fly1716-session-ctx.XXXXXX)"
PASS=0
FAIL=0
trap 'rm -rf "$TMP"' EXIT

ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

if [ ! -f "$READER" ]; then
  bad "session context reader exists"
  printf '%d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

FIXTURE_ROOT="$TMP" node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const root = process.env.FIXTURE_ROOT;
const usage = (input, cacheRead = 0, cacheCreate = 0, output = 0) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate,
  output_tokens: output,
});
const assistant = (tokens, extra = {}) => JSON.stringify({
  type: "assistant",
  message: {
    model: extra.model ?? "claude-haiku-4-5-20251001",
    role: "assistant",
    usage: tokens,
    content: [],
  },
  ...extra.root,
});
const write = (name, body) => fs.writeFileSync(path.join(root, name), body);

write("normal.jsonl", `${assistant(usage(10_000))}\n`);
write("synthetic-tail.jsonl", `${assistant(usage(10_000))}\n${JSON.stringify({
  type: "assistant",
  message: { model: "<synthetic>", usage: usage(0), content: "x".repeat(130_000) },
})}\n`);
write("all-synthetic.jsonl", `${assistant(usage(0), { model: "<synthetic>" })}\n`);
write("damaged-tail.jsonl", `${assistant(usage(10_000))}\n{not-json}\n`);
write("cross-chunk.jsonl", `${JSON.stringify({
  padding: "x".repeat((4 * 1024 * 1024) + 128),
  type: "assistant",
  message: { model: "claude-haiku-4-5-20251001", role: "assistant", usage: usage(10_000) },
})}\n`);
write("high-output.jsonl", assistant(usage(10_000, 0, 0, 130_000)));
write("one-byte-bound.jsonl", `${assistant(usage(10_000))}\n${"x".repeat(130_000)}`);
write("threshold-safe.jsonl", assistant(usage(139_999)));
write("threshold-unsafe.jsonl", assistant(usage(140_000)));
write("one-million.jsonl", assistant(usage(700_000)));

const unicodeDir = path.join(root, "space 和 unicode");
fs.mkdirSync(unicodeDir);
fs.writeFileSync(path.join(unicodeDir, "session file.jsonl"), `${assistant(usage(10_000))}\n`);
fs.symlinkSync(path.join(unicodeDir, "session file.jsonl"), path.join(root, "session-link.jsonl"));

const budget = fs.openSync(path.join(root, "budget.jsonl"), "w");
fs.writeSync(budget, assistant(usage(10_000)) + "\n");
fs.ftruncateSync(budget, (128 * 1024 * 1024) + 4096);
fs.closeSync(budget);
NODE

assert_case() {
  local label="$1" transcript="$2" window="$3" verdict="$4" reason="$5"
  local output rc=0 line_count
  output="$(node "$READER" --transcript "$transcript" --window "$window" 2>"$TMP/stderr")" || rc=$?
  line_count="$(printf '%s\n' "$output" | wc -l | tr -d ' ')"
  if [ "$rc" -eq 0 ] \
    && [ "$line_count" -eq 1 ] \
    && printf '%s' "$output" | jq -e \
      --arg verdict "$verdict" --arg reason "$reason" \
      '.verdict == $verdict and .reason == $reason' >/dev/null \
    && [ ! -s "$TMP/stderr" ]; then
    ok "$label"
  else
    bad "$label (rc=$rc output=$output stderr=$(cat "$TMP/stderr"))"
  fi
}

assert_case "normal usage below threshold is safe" \
  "$TMP/normal.jsonl" 200000 safe_resume below_threshold
assert_case "synthetic tail contributes a conservative byte upper bound" \
  "$TMP/synthetic-tail.jsonl" 200000 unsafe threshold_reached
assert_case "an all-synthetic transcript is unknown" \
  "$TMP/all-synthetic.jsonl" 200000 unknown no_real_usage
assert_case "a missing transcript is unknown without throwing" \
  "$TMP/missing.jsonl" 200000 unknown transcript_missing
assert_case "damaged trailing lines are skipped" \
  "$TMP/damaged-tail.jsonl" 200000 safe_resume below_threshold
assert_case "a real assistant line crossing the 4 MiB scan boundary is found" \
  "$TMP/cross-chunk.jsonl" 200000 safe_resume below_threshold
assert_case "a 128 MiB backward-scan budget exhaustion is unknown" \
  "$TMP/budget.jsonl" 200000 unknown scan_budget_exceeded
assert_case "spaces, Unicode, and symlinks are accepted" \
  "$TMP/session-link.jsonl" 200000 safe_resume below_threshold
assert_case "output tokens participate in the base upper bound" \
  "$TMP/high-output.jsonl" 200000 unsafe threshold_reached
assert_case "the one-token-per-byte adversarial tail is conservative" \
  "$TMP/one-byte-bound.jsonl" 200000 unsafe threshold_reached
assert_case "one token below the integer threshold stays safe" \
  "$TMP/threshold-safe.jsonl" 200000 safe_resume below_threshold
assert_case "the exact integer threshold is unsafe" \
  "$TMP/threshold-unsafe.jsonl" 200000 unsafe threshold_reached
assert_case "a 1M window uses the supplied canonical window" \
  "$TMP/one-million.jsonl" 1000000 unsafe threshold_reached
assert_case "an invalid window fails closed as unknown" \
  "$TMP/normal.jsonl" nope unknown invalid_window

output="$(FLYWHEEL_LEAD_CTX_RESUME_MAX=71 node "$READER" \
  --transcript "$TMP/threshold-unsafe.jsonl" --window 200000)"
if printf '%s' "$output" | jq -e \
  '.verdict == "safe_resume" and .threshold == 71 and .estTokens == 140000' >/dev/null; then
  ok "the validated integer threshold override uses cross multiplication"
else
  bad "threshold override was not applied exactly (output=$output)"
fi

output="$(FLYWHEEL_LEAD_CTX_RESUME_MAX=70.5 node "$READER" \
  --transcript "$TMP/normal.jsonl" --window 200000)"
if printf '%s' "$output" | jq -e \
  '.verdict == "unknown" and .reason == "invalid_threshold"' >/dev/null; then
  ok "a non-integer threshold fails closed"
else
  bad "invalid threshold did not fail closed (output=$output)"
fi

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
