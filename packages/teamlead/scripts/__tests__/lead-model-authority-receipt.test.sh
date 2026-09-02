#!/usr/bin/env bash
# FLY-2238: the Lead resume gate and launcher share one restart-safe model receipt.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HELPER="$ROOT/packages/teamlead/scripts/lib/lead-model-authority-receipt.mjs"
LEAD_SH="$ROOT/packages/teamlead/scripts/claude-lead.sh"
DIST="$ROOT/packages/teamlead/dist"
TMP="$(mktemp -d /tmp/fly2238-model-authority.XXXXXX)"
PASS=0
FAIL=0
trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

RECEIPT="$TMP/state/lead-model-authority.json"
if node "$HELPER" write --file "$RECEIPT" \
    --model claude-fable-5-10 --context-window 800000 \
    --revision fixture-revision > "$TMP/written.json" 2>/dev/null \
  && [ "$(file_mode "$RECEIPT")" = 600 ] \
  && node "$HELPER" read --file "$RECEIPT" > "$TMP/read.json" 2>/dev/null \
  && jq -e '.schemaVersion == 1 and .model == "claude-fable-5-10" and
    .contextWindowTokens == 800000 and .configRevision == "fixture-revision" and
    (.resolvedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$"))' "$TMP/read.json" >/dev/null; then
  ok "authority receipt is atomically readable with owner-only mode"
else
  bad "authority receipt write/read contract failed"
fi

REGISTRY_SPELLING_RECEIPT="$TMP/state/registry-spelling.json"
if node "$HELPER" write --file "$REGISTRY_SPELLING_RECEIPT" \
    --model claude-fable-5.2 --context-window 800000 \
    --revision registry-spelling > /dev/null 2>&1 \
  && [ "$(node "$HELPER" read --file "$REGISTRY_SPELLING_RECEIPT" 2>/dev/null \
    | jq -r '.model')" = claude-fable-5.2 ]; then
  ok "receipt accepts the canonical spelling already accepted by the model registry"
else
  bad "receipt imposed a stricter canonical model grammar than the registry"
fi

printf -v LONG_MODEL 'x%.0s' {1..257}
UNSAFE_MODELS=("--effort" "claude fable" $'claude\tfable' $'claude\nfable' "$LONG_MODEL")
UNSAFE_REJECTED=1
INDEX=0
for UNSAFE_MODEL in "${UNSAFE_MODELS[@]}"; do
  INDEX=$((INDEX + 1))
  if node "$HELPER" write --file "$TMP/state/unsafe-$INDEX.json" \
      --model "$UNSAFE_MODEL" --context-window 800000 \
      --revision unsafe-model >/dev/null 2>&1; then
    UNSAFE_REJECTED=0
  fi
done
UNSAFE_READ_RECEIPT="$TMP/state/unsafe-read.json"
printf '%s\n' '{"schemaVersion":1,"model":"--effort","contextWindowTokens":800000,"configRevision":"unsafe-model","resolvedAt":"2026-09-01T00:00:00.000Z"}' \
  > "$UNSAFE_READ_RECEIPT"
chmod 600 "$UNSAFE_READ_RECEIPT"
if [ "$UNSAFE_REJECTED" -eq 1 ] \
  && ! node "$HELPER" read --file "$UNSAFE_READ_RECEIPT" >/dev/null 2>&1; then
  ok "argv-unsafe receipt model values fail loud on write and read"
else
  bad "argv-unsafe receipt model value was accepted"
fi

chmod 644 "$RECEIPT" 2>/dev/null || true
if ! node "$HELPER" read --file "$RECEIPT" >/dev/null 2>&1; then
  ok "group/world-readable authority receipt is rejected"
else
  bad "unsafe receipt mode was accepted"
fi

printf '%s\n' '{"schemaVersion":1,"model":"claude-fable-5-10-preview","contextWindowTokens":"800000","configRevision":"fixture-revision","resolvedAt":"2026-09-01T00:00:00.000Z"}' > "$RECEIPT"
chmod 600 "$RECEIPT"
if ! node "$HELPER" read --file "$RECEIPT" >/dev/null 2>&1; then
  ok "malformed receipt metadata is rejected"
else
  bad "malformed receipt metadata was accepted"
fi

make_home() {
  local home="$1"
  mkdir -p "$home/project/.lead/eng-lead" "$home/.flywheel/manifests"
  printf '%s\n' '{"granularity":"per-lead","setBy":"test","setAt":"2026-09-01T00:00:00.000Z"}' \
    > "$home/.flywheel/summary-config.json"
  printf -- '---\nname: eng-lead\n---\nLead\n' > "$home/project/.lead/eng-lead/identity.md"
}

fixture_projects() {
  local home="$1"
  jq -cn --arg root "$home/project" '[{
    projectName:"flywheel",projectRoot:$root,leads:[{
      agentId:"eng-lead",summaryRole:"producer",chatChannel:"1",
      match:{labels:["eng"]},model:"fable"
    }]
  }]'
}

run_dry() {
  local home="$1" launcher="$2" projects="$3"
  env -i HOME="$home" PATH="$PATH" \
    FLYWHEEL_STATE_DIR="$home/authority-root" \
    FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$projects" \
    DISCORD_BOT_TOKEN=CANARYBOT TEAMLEAD_API_TOKEN=CANARYTEAM \
    bash "$launcher" eng-lead "$home/project" flywheel 2>&1
}

plan_model() {
  sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p' \
    | awk -F'\t' 'previous=="--model" && $1=="ARG" { print $2; exit } $1=="ARG" { previous=$2 }'
}

if [ -f "$DIST/lead-model-launch.js" ]; then
  HOME_OK="$TMP/home-ok"
  make_home "$HOME_OK"
  PROJECTS="$(fixture_projects "$HOME_OK")"
  OUT="$(run_dry "$HOME_OK" "$LEAD_SH" "$PROJECTS")"
  AUTHORITY="$HOME_OK/authority-root/state/lead-model-authority.json"
  if [ "$(printf '%s\n' "$OUT" | plan_model)" = claude-fable-5-1 ] \
    && node "$HELPER" read --file "$AUTHORITY" > "$TMP/normal.json" 2>/dev/null \
    && jq -e '.model == "claude-fable-5-1" and .contextWindowTokens == 1000000' \
      "$TMP/normal.json" >/dev/null; then
    ok "normal resolve persists the canonical model and registry window under FLYWHEEL_STATE_DIR"
  else
    bad "normal resolve did not persist the authority receipt"
  fi

  HOME_WRITE_FAIL="$TMP/home-write-fail"
  make_home "$HOME_WRITE_FAIL"
  mkdir -p "$HOME_WRITE_FAIL/authority-root"
  printf 'blocks the receipt directory\n' > "$HOME_WRITE_FAIL/authority-root/state"
  WRITE_FAIL_PROJECTS="$(fixture_projects "$HOME_WRITE_FAIL")"
  OUT="$(run_dry "$HOME_WRITE_FAIL" "$LEAD_SH" "$WRITE_FAIL_PROJECTS")"
  if [ "$(printf '%s\n' "$OUT" | plan_model)" = claude-fable-5-1 ] \
    && grep -q 'WARNING:.*receipt write failed.*live model resolution' <<< "$OUT"; then
    ok "receipt persistence failure keeps the verified live model launchable"
  else
    bad "receipt persistence failure discarded the verified live model decision"
  fi

  MIRROR="$TMP/mirror"
  mkdir -p "$MIRROR/packages/teamlead/dist" "$MIRROR/packages/config/dist"
  for entry in "$ROOT"/*; do
    base="$(basename "$entry")"
    [ "$base" = packages ] || ln -s "$entry" "$MIRROR/$base"
  done
  for entry in "$ROOT/packages"/*; do
    base="$(basename "$entry")"
    case "$base" in teamlead|config) ;; *) ln -s "$entry" "$MIRROR/packages/$base" ;; esac
  done
  for entry in "$ROOT/packages/teamlead"/*; do
    base="$(basename "$entry")"
    [ "$base" = dist ] || ln -s "$entry" "$MIRROR/packages/teamlead/$base"
  done
  for entry in "$ROOT/packages/config"/*; do
    base="$(basename "$entry")"
    [ "$base" = dist ] || ln -s "$entry" "$MIRROR/packages/config/$base"
  done
  for entry in "$ROOT/packages/teamlead/dist"/*; do
    base="$(basename "$entry")"
    [ "$base" = lead-model-launch.js ] \
      || ln -s "$entry" "$MIRROR/packages/teamlead/dist/$base"
  done
  for entry in "$ROOT/packages/config/dist"/*; do
    base="$(basename "$entry")"
    [ "$base" = index.js ] || ln -s "$entry" "$MIRROR/packages/config/dist/$base"
  done
  # Both build/deploy seams are deliberately absent in the mirrored checkout.
  rm -f "$MIRROR/packages/teamlead/dist/lead-model-launch.js" \
    "$MIRROR/packages/config/dist/index.js"

  OUT="$(run_dry "$HOME_OK" "$MIRROR/packages/teamlead/scripts/claude-lead.sh" "$PROJECTS")"
  if [ "$(printf '%s\n' "$OUT" | plan_model)" = claude-fable-5-1 ] \
    && grep -q 'last-good model authority receipt' <<< "$OUT"; then
    ok "dist-unavailable launch uses the same last-good canonical receipt"
  else
    bad "dist-unavailable launch did not use the last-good receipt"
  fi

  HOME_MISSING="$TMP/home-missing"
  make_home "$HOME_MISSING"
  MISSING_PROJECTS="$(fixture_projects "$HOME_MISSING")"
  OUT="$(run_dry "$HOME_MISSING" "$MIRROR/packages/teamlead/scripts/claude-lead.sh" "$MISSING_PROJECTS")"
  if [ -z "$(printf '%s\n' "$OUT" | plan_model)" ] \
    && grep -q 'FATAL:.*model authority' <<< "$OUT"; then
    ok "dist-unavailable launch without a receipt fails loud before spawn"
  else
    bad "missing receipt silently selected a launch model"
  fi
else
  ok "launcher integration skipped until teamlead dist is built"
fi

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
