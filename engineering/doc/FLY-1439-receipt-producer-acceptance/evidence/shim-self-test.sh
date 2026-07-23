#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1439-shim-test.XXXXXX")"
DIST="$ROOT/dist"
SLOT="$ROOT/slot"
mkdir -p "$DIST" "$SLOT/discord-state"

ORIGINAL_HASH=""
restore() {
  if [[ -f "$DIST/index.real.js" ]]; then
    rm -f "$DIST/index.js"
    mv "$DIST/index.real.js" "$DIST/index.js"
  fi
  if [[ -n "$ORIGINAL_HASH" && -f "$DIST/index.js" ]]; then
    [[ "$(shasum -a 256 "$DIST/index.js" | awk '{print $1}')" == "$ORIGINAL_HASH" ]]
  fi
  rm -rf "$ROOT"
}
trap restore EXIT INT TERM

cp "$HERE/shim.mjs" "$DIST/shim-source.mjs"
cat > "$DIST/index.js" <<'EOF'
import { appendFileSync } from "node:fs";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(process.env.FLY1439_REAL_CAPTURE, `${JSON.stringify({ argv: process.argv.slice(2), stdin })}\n`);
process.stdout.write(`real-out:${process.argv.slice(2).join(",")}`);
process.stderr.write("real-err");
process.exit(Number(process.env.FLY1439_REAL_EXIT || 0));
EOF
ORIGINAL_HASH="$(shasum -a 256 "$DIST/index.js" | awk '{print $1}')"

# Registering the trap precedes the first destructive rename, matching the live
# install contract.
mv "$DIST/index.js" "$DIST/index.real.js"
cp "$DIST/shim-source.mjs" "$DIST/index.js"
chmod +x "$DIST/index.js"

export DISCORD_STATE_DIR="$SLOT/discord-state"
export FLY1439_REAL_CAPTURE="$SLOT/real-capture.jsonl"

printf 'stdin-bytes' | node "$DIST/index.js" harmless --alpha beta \
  >"$SLOT/passthrough.stdout" 2>"$SLOT/passthrough.stderr"
grep -q '^real-out:harmless,--alpha,beta$' "$SLOT/passthrough.stdout"
grep -q '^real-err$' "$SLOT/passthrough.stderr"
node -e '
  const row = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (row.stdin !== "stdin-bytes") process.exit(1);
  if (JSON.stringify(row.argv) !== JSON.stringify(["harmless", "--alpha", "beta"])) process.exit(1);
' "$SLOT/real-capture.jsonl"

printf 'fail-begin\n' > "$SLOT/shim-mode"
if node "$DIST/index.js" chat-receipt begin --message-id 1001 \
    >"$SLOT/fail.stdout" 2>"$SLOT/fail.stderr"; then
  echo "fail-begin unexpectedly succeeded" >&2
  exit 1
fi
grep -q 'injected fail-begin' "$SLOT/fail.stderr"

wait_for_barrier() {
  local barrier="$1"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -f "$barrier" ]] && return 0
    sleep 0.1
  done
  return 1
}

for spec in "hang-complete complete 1002" "hang-settle settle 1003"; do
  read -r mode sub msg_id <<<"$spec"
  printf '%s\n' "$mode" > "$SLOT/shim-mode"
  node "$DIST/index.js" chat-receipt "$sub" --message-id "$msg_id" \
    >"$SLOT/$sub.stdout" 2>"$SLOT/$sub.stderr" &
  shim_pid=$!
  barrier="$SLOT/shim-barrier-$sub-$msg_id.json"
  wait_for_barrier "$barrier"
  call_id="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).callId)' "$barrier")"
  node -e '
    const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
    const selected = rows.filter((row) => row.callId === process.argv[2]);
    if (selected.length !== 1 || selected[0].phase !== "start") process.exit(1);
  ' "$SLOT/shim-ledger.jsonl" "$call_id"
  kill -TERM "$shim_pid"
  wait "$shim_pid" 2>/dev/null || true
done

node -e '
  const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
  const byId = new Map();
  for (const row of rows) {
    const phases = byId.get(row.callId) || [];
    phases.push(row.phase);
    byId.set(row.callId, phases);
  }
  const paired = [...byId.values()].filter((phases) => phases.join(",") === "start,end").length;
  const hanging = [...byId.values()].filter((phases) => phases.join(",") === "start").length;
  if (paired !== 2 || hanging !== 2) process.exit(1);
' "$SLOT/shim-ledger.jsonl"

rm -f "$SLOT/shim-mode"
rm -f "$SLOT"/shim-barrier-*.json

# Exercise the real restore path before EXIT so the hash assertion is visible.
rm -f "$DIST/index.js"
mv "$DIST/index.real.js" "$DIST/index.js"
[[ "$(shasum -a 256 "$DIST/index.js" | awk '{print $1}')" == "$ORIGINAL_HASH" ]]

echo "shim self-test PASS: passthrough bytes, 3 fault modes, atomic barriers, ledger states, restore hash"
