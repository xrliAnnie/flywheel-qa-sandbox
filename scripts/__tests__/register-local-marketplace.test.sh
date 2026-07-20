#!/bin/bash
# FLY-1389 P1-e: register-local-marketplace.sh — the managed entrance for
# local directory marketplaces. Five groups per plan: traversal rejection /
# dest-symlink rejection / partial-copy cleanup / idempotent rerun-replace /
# failure injection at each transaction step asserting the terminal state is
# a COMPLETE old tree or COMPLETE new tree (never nested staging).
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RLM="${SCRIPT_DIR}/register-local-marketplace.sh"
[[ -f "$RLM" ]] || { echo "FATAL: $RLM missing" >&2; exit 1; }

SB="$(mktemp -d /tmp/fly1389-rlm-XXXXXX)"
trap 'rm -rf "$SB"' EXIT
H="$SB/home"
mkdir -p "$H"

# claude CLI stub — records invocations.
CLAUDE_STUB="$SB/claude"
cat > "$CLAUDE_STUB" <<'EOF'
#!/bin/bash
echo "$*" >> "${CLAUDE_LOG:?}"
exit "${CLAUDE_RC:-0}"
EOF
chmod +x "$CLAUDE_STUB"

SRC_V1="$SB/src-v1"; mkdir -p "$SRC_V1/plugins"
echo "v1" > "$SRC_V1/marketplace.json"
echo "p1" > "$SRC_V1/plugins/p.md"
SRC_V2="$SB/src-v2"; mkdir -p "$SRC_V2/plugins"
echo "v2" > "$SRC_V2/marketplace.json"
echo "p2" > "$SRC_V2/plugins/p.md"

run_rlm() {  # <name> <src> [env pairs...] → rc; out in $SB/out.log
  local name="$1" src="$2"; shift 2
  env HOME="$H" CLAUDE_LOG="$SB/claude.log" \
    FLYWHEEL_MARKETPLACE_CLAUDE_BIN="$CLAUDE_STUB" "$@" \
    bash "$RLM" "$name" "$src" > "$SB/out.log" 2>&1
}

DEST_ROOT="$H/.flywheel/marketplaces"

# ── 1. traversal / grammar rejection ──
R1_OK=1
for bad in "../outside" "a/b" "UPPER" "-lead" ".." "name with space"; do
  if run_rlm "$bad" "$SRC_V1"; then
    R1_OK=0; fail "1: invalid name accepted: '$bad'"
  fi
done
[[ "$R1_OK" == "1" ]] && pass "1: name grammar rejects traversal / slashes / caps / spaces"

# ── 2. destination symlink rejection ──
mkdir -p "$DEST_ROOT" "$SB/elsewhere"
ln -s "$SB/elsewhere" "$DEST_ROOT/linked"
if run_rlm "linked" "$SRC_V1"; then
  fail "2: symlink destination accepted"
else
  grep -q "symlink" "$SB/out.log" && [[ -z "$(ls -A "$SB/elsewhere")" ]] \
    && pass "2: existing symlink destination refused (no escape through it)" \
    || fail "2: refusal wrong" "$(cat "$SB/out.log")"
fi
rm "$DEST_ROOT/linked"

# ── 3. partial-copy failure → staging cleaned, destination untouched ──
: > "$SB/claude.log"
if run_rlm "skills" "$SRC_V1" FLYWHEEL_RLM_FAIL_AT=stage; then
  fail "3: injected stage failure must fail the run"
else
  R3_OK=1
  [[ ! -e "$DEST_ROOT/skills" ]] || { R3_OK=0; fail "3: destination appeared despite stage failure"; }
  [[ -z "$(ls "$DEST_ROOT" 2>/dev/null | grep staging || true)" ]] || { R3_OK=0; fail "3: staging residue left"; }
  [[ ! -s "$SB/claude.log" ]] || { R3_OK=0; fail "3: claude add ran despite failure"; }
  [[ "$R3_OK" == "1" ]] && pass "3: stage failure → staging cleaned, zero destination/registration writes"
fi

# ── 4. clean install then idempotent rerun-replace ──
: > "$SB/claude.log"
if run_rlm "skills" "$SRC_V1" \
   && diff -r "$SRC_V1" "$DEST_ROOT/skills" >/dev/null \
   && grep -q "plugin marketplace add $DEST_ROOT/skills" "$SB/claude.log"; then
  pass "4a: clean install copies to stable path + registers THAT path"
else
  fail "4a: clean install" "$(cat "$SB/out.log")"
fi
# rerun with NEW content + claude add now failing (already registered) but
# known_marketplaces.json carrying the stable path → idempotent success.
mkdir -p "$H/.claude/plugins"
jq -n --arg p "$DEST_ROOT/skills" \
  '{"skills":{"source":{"source":"local","path":$p},"installLocation":$p}}' \
  > "$H/.claude/plugins/known_marketplaces.json"
: > "$SB/claude.log"
if run_rlm "skills" "$SRC_V2" CLAUDE_RC=1 \
   && diff -r "$SRC_V2" "$DEST_ROOT/skills" >/dev/null \
   && [[ -z "$(ls -A "$DEST_ROOT" | grep -v -e '^skills$' -e '^lnk$')" ]]; then
  pass "4b: rerun REPLACES content (no nested staging), already-registered add treated idempotent"
else
  fail "4b: idempotent rerun" "$(cat "$SB/out.log"; ls -la "$DEST_ROOT")"
fi

# ── 4c (Codex R1 MED-3): content symlink escaping the tree → refused;
# internal symlinks are allowed ──
SRC_LNK="$SB/src-lnk"; mkdir -p "$SRC_LNK/plugins"
echo "x" > "$SRC_LNK/marketplace.json"
ln -s "$SB/src-v1/marketplace.json" "$SRC_LNK/plugins/escape.md"   # escapes the tree
if run_rlm "lnk" "$SRC_LNK"; then
  fail "4c: escaping content symlink accepted"
else
  grep -q "escapes the marketplace tree" "$SB/out.log" \
    && [[ ! -e "$DEST_ROOT/lnk" ]] \
    && pass "4c: escaping content symlink refused (stable copy would still break)" \
    || fail "4c: wrong refusal" "$(cat "$SB/out.log")"
fi
rm "$SRC_LNK/plugins/escape.md"
ln -s "../marketplace.json" "$SRC_LNK/plugins/internal.md"          # stays inside
if run_rlm "lnk" "$SRC_LNK" && [[ -L "$DEST_ROOT/lnk/plugins/internal.md" ]]; then
  pass "4d: internal relative symlink allowed and preserved"
else
  fail "4d: internal symlink wrongly refused" "$(cat "$SB/out.log")"
fi

# ── 4e (Codex R1 MED-4): half-stale registration (one field worktree) must
# NOT be treated as idempotent success when claude add fails ──
jq -n --arg p "$DEST_ROOT/skills" --arg w "/somewhere/worktrees/x/vendor/skills" \
  '{"skills":{"source":{"source":"local","path":$w},"installLocation":$p}}' \
  > "$H/.claude/plugins/known_marketplaces.json"
if run_rlm "skills" "$SRC_V1" CLAUDE_RC=1; then
  fail "4e: half-stale registration wrongly treated as idempotent success"
else
  grep -q "no fully-stable registration" "$SB/out.log" \
    && pass "4e: half-stale registration (or→and) correctly fails loud" \
    || fail "4e: wrong failure" "$(cat "$SB/out.log")"
fi
# restore fully-stable registration for the remaining scenarios
jq -n --arg p "$DEST_ROOT/skills" \
  '{"skills":{"source":{"source":"local","path":$p},"installLocation":$p}}' \
  > "$H/.claude/plugins/known_marketplaces.json"
run_rlm "skills" "$SRC_V2" CLAUDE_RC=1 >/dev/null 2>&1 || true

# ── 4f (Codex R1 MED-2): per-name lock — concurrent registration refused ──
mkdir -p "$DEST_ROOT/.lock-skills"
if run_rlm "skills" "$SRC_V1"; then
  fail "4f: concurrent registration not blocked by the lock"
else
  grep -q "another registration" "$SB/out.log" \
    && pass "4f: per-name lock refuses a concurrent registration" \
    || fail "4f: wrong lock failure" "$(cat "$SB/out.log")"
fi
rmdir "$DEST_ROOT/.lock-skills"

# ── 5. failure injection at each transaction step ──
# 5a: after-backup → COMPLETE old tree restored, no residue.
if run_rlm "skills" "$SRC_V1" FLYWHEEL_RLM_FAIL_AT=after-backup; then
  fail "5a: injected after-backup failure must fail"
else
  diff -r "$SRC_V2" "$DEST_ROOT/skills" >/dev/null \
    && [[ -z "$(ls -A "$DEST_ROOT" | grep -v -e '^skills$' -e '^lnk$')" ]] \
    && pass "5a: after-backup failure → complete OLD tree restored, zero residue" \
    || fail "5a: old tree not restored intact" "$(ls -la "$DEST_ROOT")"
fi
# 5b: promote failure → complete old tree restored.
if run_rlm "skills" "$SRC_V1" FLYWHEEL_RLM_FAIL_AT=promote; then
  fail "5b: injected promote failure must fail"
else
  diff -r "$SRC_V2" "$DEST_ROOT/skills" >/dev/null \
    && [[ -z "$(ls -A "$DEST_ROOT" | grep -v -e '^skills$' -e '^lnk$')" ]] \
    && pass "5b: promote failure → complete OLD tree restored, staging discarded" \
    || fail "5b: old tree not restored intact" "$(ls -la "$DEST_ROOT")"
fi
# 5c: cleanup failure → COMPLETE new tree live (stale backup tolerated, warned).
if run_rlm "skills" "$SRC_V1" FLYWHEEL_RLM_FAIL_AT=cleanup; then
  diff -r "$SRC_V1" "$DEST_ROOT/skills" >/dev/null \
    && grep -q "backup cleanup failed" "$SB/out.log" \
    && pass "5c: cleanup failure → complete NEW tree live + loud warning" \
    || fail "5c: new tree incomplete or warning missing" "$(cat "$SB/out.log")"
else
  fail "5c: cleanup failure must not fail the transaction (new tree is live)"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] || exit 1
