#!/bin/bash
# FLY-1389 P1-d: check-global-path-hygiene.sh — read-only scanner over the
# global persistence surfaces. Hermetic: sandbox HOME; the built-in POSITIVE
# CONTROL is scenario 8 (a linked worktree whose path does NOT contain
# /worktrees/ — this checkout's own shape — must still be flagged, proving
# the scanner uses the .git-file judgment, not a naming heuristic).
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHECK="${SCRIPT_DIR}/check-global-path-hygiene.sh"
LIB="${SCRIPT_DIR}/lib/path-hygiene.sh"
[[ -f "$CHECK" ]] || { echo "FATAL: $CHECK missing" >&2; exit 1; }
# shellcheck source=../lib/path-hygiene.sh
source "$LIB"

# Trusted/worktree fixture roots live in-repo (mktemp roots are temp by the
# predicate under test); the sandbox HOME lives under /tmp on purpose — the
# scanner only judges what global entries POINT AT, not where HOME is.
RSB="$(mktemp -d "${TESTS_DIR}/.tmp-hygiene-XXXXXX")"
SB="$(mktemp -d /tmp/fly1389-hygiene-scan-XXXXXX)"
trap 'rm -rf "$RSB" "$SB"' EXIT

# A main-checkout shape (trusted) and a worktree shape WITHOUT /worktrees/ in
# its path (scenario 8's positive control).
MC="$RSB/main-checkout"; mkdir -p "$MC/.git" "$MC/scripts"
echo x > "$MC/scripts/tool.sh"
WT="$RSB/flywheel-FLY-9999"; mkdir -p "$WT/packages/x/dist"
echo "gitdir: /main/.git/worktrees/fly9999" > "$WT/.git"
echo x > "$WT/packages/x/dist/cli.js"

new_home() {  # <name> → fresh sandbox HOME path on stdout
  local h="$SB/$1"
  mkdir -p "$h/.flywheel/bin" "$h/.claude/plugins"
  echo "$h"
}

new_clean_source_tree() {  # <name> → minimal registered source fixture
  local root="$SB/source-$1" rel marker
  mkdir -p "$root/packages" "$root/scripts"
  printf '{}\n' > "$root/package.json"
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    mkdir -p "$(dirname "$root/$rel")"
    printf 'PATH="/opt/homebrew/bin:/usr/local/bin"\n' > "$root/$rel"
  done <<EOF
$(path_hygiene_source_path_registry)
EOF
  while IFS='|' read -r rel marker; do
    [[ -n "$rel" ]] || continue
    mkdir -p "$(dirname "$root/$rel")"
    printf '%s\n' "$marker" > "$root/$rel"
  done <<EOF
$(path_hygiene_source_priority_registry)
EOF
  echo "$root"
}

run_check() {  # <home> [--alert] → rc; output in $SB/out.log
  HOME="$1" bash "$CHECK" "${2:-}" > "$SB/out.log" 2>&1
}

# ── 1. clean → exit 0 ──
H="$(new_home clean)"
ln -s "$MC/scripts/tool.sh" "$H/.flywheel/bin/tool"
jq -n --arg p "$MC" '{"good": {"source": {"source":"local", "path": $p}, "installLocation": $p}}' \
  > "$H/.claude/plugins/known_marketplaces.json"
jq -n --arg c "$MC/scripts/tool.sh" '{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":$c}]}]}}' \
  > "$H/.claude/settings.json"
if run_check "$H"; then
  pass "1: clean global config → exit 0"
else
  fail "1: clean should pass" "$(cat "$SB/out.log")"
fi

# ── 2. broken symlink → 1 violation ──
H="$(new_home broken)"
ln -s "$SB/does-not-exist/cli.js" "$H/.flywheel/bin/agent-team-transport"
if ! run_check "$H" && grep -q "broken symlink" "$SB/out.log"; then
  pass "2: broken symlink → violation + exit 1"
else
  fail "2: broken symlink" "$(cat "$SB/out.log")"
fi

# ── 3. worktree-target symlink → 1 violation ──
H="$(new_home wt-target)"
ln -s "$WT/packages/x/dist/cli.js" "$H/.flywheel/bin/agent-team-transport"
if ! run_check "$H" && grep -q "temp/worktree checkout" "$SB/out.log"; then
  pass "3: symlink into a worktree checkout → violation"
else
  fail "3: worktree target" "$(cat "$SB/out.log")"
fi

# ── 4. only .source.path polluted → 1 violation ──
H="$(new_home mp-source)"
jq -n --arg bad "$WT/vendor/matt-skills" --arg good "$MC" \
  '{"matt-skills": {"source": {"source":"local","path": $bad}, "installLocation": $good}}' \
  > "$H/.claude/plugins/known_marketplaces.json"
mkdir -p "$WT/vendor/matt-skills"
if ! run_check "$H" && grep -q "marketplace path inside" "$SB/out.log"; then
  pass "4: .source.path pointing into a worktree → violation"
else
  fail "4: .source.path" "$(cat "$SB/out.log")"
fi

# ── 5. only .installLocation polluted → 1 violation ──
H="$(new_home mp-install)"
jq -n --arg bad "$WT/vendor/matt-skills" --arg good "$MC" \
  '{"matt-skills": {"source": {"source":"local","path": $good}, "installLocation": $bad}}' \
  > "$H/.claude/plugins/known_marketplaces.json"
if ! run_check "$H" && grep -q "marketplace path inside" "$SB/out.log"; then
  pass "5: .installLocation pointing into a worktree → violation"
else
  fail "5: .installLocation" "$(cat "$SB/out.log")"
fi

# ── 5b. unparseable marketplaces file → fail-closed violation ──
H="$(new_home mp-bad)"
echo "{ not json" > "$H/.claude/plugins/known_marketplaces.json"
if ! run_check "$H" && grep -q "unparseable" "$SB/out.log"; then
  pass "5b: unparseable known_marketplaces.json → fail-closed violation"
else
  fail "5b: fail-closed parse" "$(cat "$SB/out.log")"
fi

# ── 6. RELATIVE symlink target resolves against the link dir ──
# This HOME lives INSIDE the main-checkout fixture: the healthy relative
# target must be non-temp AND shielded by a .git DIRECTORY ancestor (the
# owning-root walk stops at $MC) — a /tmp sandbox HOME would make even a
# healthy target read as temp.
H="$MC/home6"
mkdir -p "$H/.flywheel/bin" "$H/.flywheel/src" "$H/.claude/plugins"
cp "$MC/scripts/tool.sh" "$H/.flywheel/src/tool.sh"
( cd "$H/.flywheel/bin" && ln -s "../src/tool.sh" tool )
R6_CLEAN_RC=0; run_check "$H" || R6_CLEAN_RC=$?
( cd "$H/.flywheel/bin" && rm tool && ln -s "../src/missing.sh" tool )
if [[ "$R6_CLEAN_RC" -eq 0 ]] && ! run_check "$H" && grep -q "broken symlink" "$SB/out.log"; then
  pass "6: relative symlink target expanded against link dir (healthy passes, broken flagged)"
else
  fail "6: relative expansion (clean rc=$R6_CLEAN_RC)" "$(cat "$SB/out.log")"
fi

# ── 7. settings.json hook command pointing into a worktree → violation ──
H="$(new_home hookcmd)"
jq -n --arg c "bash $WT/packages/x/dist/cli.js --flag" \
  '{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":$c}]}]}}' \
  > "$H/.claude/settings.json"
if ! run_check "$H" && grep -q "hook command path inside" "$SB/out.log"; then
  pass "7: settings.json hook command into a worktree → violation"
else
  fail "7: hook command" "$(cat "$SB/out.log")"
fi

# ── 8. POSITIVE CONTROL: linked worktree WITHOUT /worktrees/ in its path
# (this checkout's own shape) is already what scenarios 3/4/5/7 used — pin it
# explicitly: the path must not contain /worktrees/ and must still be flagged.
case "$WT" in
  */worktrees/*) fail "8: fixture invalid — path contains /worktrees/" "$WT" ;;
  *)
    H="$(new_home noname)"
    ln -s "$WT/packages/x/dist/cli.js" "$H/.flywheel/bin/x"
    if ! run_check "$H" && grep -q "temp/worktree checkout" "$SB/out.log"; then
      pass "8: worktree with NO /worktrees/ path shape still flagged (.git-file judgment, not naming)"
    else
      fail "8: naming-heuristic trap" "$(cat "$SB/out.log")"
    fi
    ;;
esac

# ── 9. --alert fires exactly one summarizing alert through the seam ──
H="$(new_home alerting)"
ln -s "$SB/gone/cli.js" "$H/.flywheel/bin/broken"
ALERT_STUB="$SB/alert.sh"
cat > "$ALERT_STUB" <<'EOF'
#!/bin/bash
echo "ALERT $*" >> "${ALERT_LOG:?}"
exit 0
EOF
chmod +x "$ALERT_STUB"
: > "$SB/alerts.log"
HOME="$H" ALERT_LOG="$SB/alerts.log" FLYWHEEL_HYGIENE_ALERT_BIN="$ALERT_STUB" \
  bash "$CHECK" --alert > "$SB/out.log" 2>&1
RC=$?
if [[ "$RC" -ne 0 && "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ]] \
   && grep -q 'bin_integrity_drift' "$SB/alerts.log"; then
  pass "9: --alert → exactly one lead-alert; default run is print-only"
else
  fail "9: alert wiring (rc=$RC)" "$(cat "$SB/alerts.log" 2>/dev/null)"
fi

# ── 10. read-only: a full scan mutates nothing in HOME ──
# Portable snapshot (macOS + Linux CI): entry list + content hashes. A
# platform-specific stat here would silently produce empty snapshots on the
# other platform and pass vacuously (FLY-1285 discipline).
snapshot_home() { find "$1" | sort; find "$1" -type f -exec shasum {} + 2>/dev/null | sort; }
H="$(new_home readonly)"
ln -s "$WT/packages/x/dist/cli.js" "$H/.flywheel/bin/x"
BEFORE="$(snapshot_home "$H")"
[[ -n "$BEFORE" ]] || fail "10: snapshot tooling produced empty output (vacuous)"
run_check "$H" || true
AFTER="$(snapshot_home "$H")"
if [[ -n "$BEFORE" && "$BEFORE" == "$AFTER" ]]; then
  pass "10: scanner is read-only (no entry/content changes under HOME)"
else
  fail "10: scanner wrote something" "$(diff <(echo "$BEFORE") <(echo "$AFTER") | head -5)"
fi

# ── 11. FLY-2190 real tree: the original 10-point RED is now GREEN ──
# TDD evidence before S1 named all ten §1.1 declarations as violations. Keep
# that exact baseline list here and prove the same registered real tree is now
# clean, rather than replacing the test with a smaller synthetic surface.
H="$(new_home source-real)"
SOURCE_RC=0
HOME="$H" bash "$CHECK" --source-tree "$REPO_ROOT" > "$SB/out.log" 2>&1 || SOURCE_RC=$?
SOURCE_EXPECTED=(
  "packages/claude-runner/src/tmux-server-environment.ts"
  "scripts/lib/tmux-server-rescue.sh"
  "scripts/flywheel-lead-wrapper-v2.sh"
  "scripts/flywheel-bridge-wrapper.sh"
  "scripts/flywheel-voice-bridge-wrapper.sh"
  "scripts/flywheel-quota-monitor-wrapper.sh"
  "scripts/restart-services.sh"
  "packages/teamlead/scripts/templates/flywheel-codex-lead-wrapper-mufasa-tui.sh"
  "packages/teamlead/scripts/rollback-codex-lead-mufasa-tui.sh"
  "scripts/launchd/com.flywheel.updater.plist"
)
SOURCE_MISSING=""
SOURCE_REGISTRY="$(path_hygiene_source_path_registry)"
for rel in "${SOURCE_EXPECTED[@]}"; do
  grep -Fxq "$rel" <<<"$SOURCE_REGISTRY" || SOURCE_MISSING="${SOURCE_MISSING}${SOURCE_MISSING:+, }${rel}"
done
if [[ "$SOURCE_RC" -eq 0 && -z "$SOURCE_MISSING" ]]; then
  pass "11: the same 10-point production registry that proved RED is now GREEN"
else
  fail "11: source-tree GREEN coverage (rc=$SOURCE_RC; unregistered=${SOURCE_MISSING:-none})" "$(cat "$SB/out.log")"
fi

# ── 12. Discovery closure: a new Python PATH declaration cannot bypass S2 ──
SRC="$(new_clean_source_tree python-discovery)"
cat > "$SRC/scripts/new-carrier.py" <<'EOF'
#!/usr/bin/env python3
PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin"
EOF
SOURCE_RC=0
HOME="$(new_home source-python)" bash "$CHECK" --source-tree "$SRC" > "$SB/out.log" 2>&1 || SOURCE_RC=$?
if [[ "$SOURCE_RC" -eq 1 ]] && grep -Fq "scripts/new-carrier.py" "$SB/out.log"; then
  pass "12: unregistered Python PATH declaration → fail-closed violation"
else
  fail "12: Python discovery closure (rc=$SOURCE_RC)" "$(cat "$SB/out.log")"
fi

# ── 13. Discovery uses the shared JS + extensionless-shebang enumerator ──
SRC="$(new_clean_source_tree cross-type-discovery)"
cat > "$SRC/packages/new-carrier.js" <<'EOF'
export const env = { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin" };
EOF
cat > "$SRC/scripts/new-carrier" <<'EOF'
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin"
EOF
chmod +x "$SRC/scripts/new-carrier"
SOURCE_RC=0
HOME="$(new_home source-cross-type)" bash "$CHECK" --source-tree "$SRC" > "$SB/out.log" 2>&1 || SOURCE_RC=$?
if [[ "$SOURCE_RC" -eq 1 ]] \
   && grep -Fq "packages/new-carrier.js" "$SB/out.log" \
   && grep -Fq "scripts/new-carrier" "$SB/out.log"; then
  pass "13: JS and extensionless shebang declarations → fail-closed violations"
else
  fail "13: cross-file-type discovery (rc=$SOURCE_RC)" "$(cat "$SB/out.log")"
fi

# ── 14. Comments and engineering history are outside the candidate set ──
SRC="$(new_clean_source_tree ignored-text)"
cat > "$SRC/scripts/comment-only.py" <<'EOF'
# PATH = "/usr/local/bin:/opt/homebrew/bin" is historical prose, not a declaration.
EOF
mkdir -p "$SRC/engineering/doc"
cat > "$SRC/engineering/doc/history.md" <<'EOF'
PATH=/usr/local/bin:/opt/homebrew/bin
EOF
SOURCE_RC=0
HOME="$(new_home source-ignored)" bash "$CHECK" --source-tree "$SRC" > "$SB/out.log" 2>&1 || SOURCE_RC=$?
if [[ "$SOURCE_RC" -eq 0 ]]; then
  pass "14: comments and engineering history do not produce false positives"
else
  fail "14: ignored text (rc=$SOURCE_RC)" "$(cat "$SB/out.log")"
fi

# ── 15. Locked fake-bin fixtures are explicit exceptions, not silent skips ──
SRC="$(new_clean_source_tree fake-bin-exceptions)"
for rel in \
  scripts/__tests__/lead-alert-dirs.test.sh \
  scripts/__tests__/codex-log-guard.test.sh \
  scripts/__tests__/lead-alert-founder-timezone.test.sh; do
  mkdir -p "$(dirname "$SRC/$rel")"
  printf 'PATH="${FAKEBIN}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"\n' > "$SRC/$rel"
done
SOURCE_RC=0
HOME="$(new_home source-exceptions)" bash "$CHECK" --source-tree "$SRC" > "$SB/out.log" 2>&1 || SOURCE_RC=$?
if [[ "$SOURCE_RC" -eq 0 ]]; then
  pass "15: the three registered fake-bin fixtures are accepted"
else
  fail "15: fake-bin exception registry (rc=$SOURCE_RC)" "$(cat "$SB/out.log")"
fi

# ── 16. qa-result's non-PATH gh list is a first-class guarded priority ──
SRC="$(new_clean_source_tree qa-result-priority)"
mkdir -p "$SRC/packages/flywheel-comm/src/commands"
cat > "$SRC/packages/flywheel-comm/src/commands/qa-result.ts" <<'EOF'
export const QA_GITHUB_CLI_CANDIDATES = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh",] as const;
EOF
SOURCE_RC=0
HOME="$(new_home source-qa-result)" bash "$CHECK" --source-tree "$SRC" > "$SB/out.log" 2>&1 || SOURCE_RC=$?
if [[ "$SOURCE_RC" -eq 0 ]]; then
  pass "16: registered qa-result native-first gh list is accepted"
else
  fail "16: qa-result priority registration (rc=$SOURCE_RC)" "$(cat "$SB/out.log")"
fi

# ── 17. qa-result cannot silently return to Intel-first resolution ──
SRC="$(new_clean_source_tree qa-result-reversed)"
cat > "$SRC/packages/flywheel-comm/src/commands/qa-result.ts" <<'EOF'
export const QA_GITHUB_CLI_CANDIDATES = ["/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/usr/bin/gh",] as const;
EOF
SOURCE_RC=0
HOME="$(new_home source-qa-result-red)" bash "$CHECK" --source-tree "$SRC" > "$SB/out.log" 2>&1 || SOURCE_RC=$?
if [[ "$SOURCE_RC" -eq 1 ]] && grep -Fq "packages/flywheel-comm/src/commands/qa-result.ts" "$SB/out.log"; then
  pass "17: reversed qa-result gh list → fail-closed violation"
else
  fail "17: qa-result reversed priority (rc=$SOURCE_RC)" "$(cat "$SB/out.log")"
fi

# ── 18. The QA launchd parity declaration is mandatory in the registry ──
SRC="$(new_clean_source_tree qa-parity-missing)"
rm -f "$SRC/scripts/lib/qa-launchd-lead.sh"
SOURCE_RC=0
HOME="$(new_home source-qa-parity)" bash "$CHECK" --source-tree "$SRC" > "$SB/out.log" 2>&1 || SOURCE_RC=$?
if [[ "$SOURCE_RC" -eq 1 ]] && grep -Fq "scripts/lib/qa-launchd-lead.sh" "$SB/out.log"; then
  pass "18: missing registered QA parity declaration → fail-closed violation"
else
  fail "18: QA parity registration (rc=$SOURCE_RC)" "$(cat "$SB/out.log")"
fi

# ── 19. Both source-managed live Codex Lead carriers are guarded ──
SRC="$(new_clean_source_tree live-codex-missing)"
rm -f "$SRC/scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh"
SOURCE_RC=0
HOME="$(new_home source-live-codex)" bash "$CHECK" --source-tree "$SRC" > "$SB/out.log" 2>&1 || SOURCE_RC=$?
if [[ "$SOURCE_RC" -eq 1 ]] && grep -Fq "scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" "$SB/out.log"; then
  pass "19: missing live Codex Lead wrapper declaration → fail-closed violation"
else
  fail "19: live Codex Lead registry (rc=$SOURCE_RC)" "$(cat "$SB/out.log")"
fi

# ── 20. Existing native-first production declarations remain registered ──
SOURCE_NATIVE_EXPECTED=(
  "scripts/flywheel-cmux-autostart.sh"
  "scripts/meeting-notes-tick.sh"
  "scripts/xiaohongshu-learning-tick.sh"
  "scripts/com.flywheel.log-janitor.plist"
  "scripts/launchd/com.flywheel.voucher-watch.plist"
  "scripts/launchd/com.flywheel.daily-digest.plist"
  "scripts/launchd/com.flywheel.token-usage-daily.plist"
  "scripts/launchd/com.flywheel.codex-log-guard.plist"
  "scripts/launchd/com.flywheel.bridge-liveness-probe.plist"
  "scripts/com.flywheel.calendar-sweep.plist.template"
  "scripts/host-tmux-selection-gate.sh"
)
SOURCE_REGISTRY="$(path_hygiene_source_path_registry)"
SOURCE_MISSING=""
for rel in "${SOURCE_NATIVE_EXPECTED[@]}"; do
  grep -Fxq "$rel" <<<"$SOURCE_REGISTRY" || SOURCE_MISSING="${SOURCE_MISSING}${SOURCE_MISSING:+, }${rel}"
done
if [[ -z "$SOURCE_MISSING" ]]; then
  pass "20: all existing native-first production declarations are registered"
else
  fail "20: native-first registry completeness" "missing=$SOURCE_MISSING"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] || exit 1
