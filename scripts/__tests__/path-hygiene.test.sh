#!/bin/bash
# FLY-1389 P1-0: scripts/lib/path-hygiene.sh — shared predicates every global-
# persistence writer consults before writing temp/worktree paths into global
# config (~/.flywheel/bin symlinks, ~/.claude settings/plugins, …).
#
# Fixture placement note: trusted-root fixtures live under the REPO checkout
# (scripts/__tests__/.tmp-*), NOT under mktemp — mktemp roots are temp by the
# very predicate under test. The predicate only inspects the given dir's OWN
# .git entry (no ancestor walk), so a fixture inside this checkout is judged
# by its own .git shape regardless of the checkout being a worktree (FLY-1285:
# this checkout itself is a linked worktree whose path has no /worktrees/).
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; }

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${TESTS_DIR}/../lib/path-hygiene.sh"
if [[ ! -f "$LIB" ]]; then
  echo "FATAL: ${LIB} missing — implement scripts/lib/path-hygiene.sh first" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$LIB"
for fn in path_hygiene_canonicalize path_hygiene_is_temp_path \
  is_temp_or_worktree_root is_global_bin_dir path_hygiene_same_path \
  path_hygiene_owning_repo_root path_hygiene_target_is_temp_or_worktree; do
  if ! type "$fn" >/dev/null 2>&1; then
    echo "FATAL: ${fn} not defined in ${LIB}" >&2
    exit 1
  fi
done

# In-repo sandbox for trusted-root fixtures (see header note) + mktemp sandbox
# for temp-shape fixtures.
# Temp-shape fixtures are pinned under literal /tmp (NOT $TMPDIR — runner
# sessions redirect TMPDIR to ~/.flywheel/runner-state, which is deliberately
# not a temp shape and would false-fail the temp-prefix scenarios).
RSB="$(mktemp -d "${TESTS_DIR}/.tmp-path-hygiene-XXXXXX")"
TSB="$(mktemp -d /tmp/fly1389-hygiene-XXXXXX)"
trap 'rm -rf "$RSB" "$TSB"' EXIT

# ── 1. pure temp-prefix matrix (no fs — canonical strings in, verdict out) ──
T_OK=1
for p in /tmp /tmp/x /private/tmp /private/tmp/deep/x /var/folders \
  /var/folders/zz/abc /private/var/folders /private/var/folders/zz/abc; do
  path_hygiene_is_temp_path "$p" || { T_OK=0; fail "temp-prefix should match: $p"; }
done
for p in /tmpfoo /private/tmpfoo /var/foldersfoo /private/var/foldersfoo \
  /home/user/tmp /Users/x/Dev/flywheel /var/log; do
  if path_hygiene_is_temp_path "$p"; then T_OK=0; fail "temp-prefix must NOT match: $p"; fi
done
[[ "$T_OK" == "1" ]] && pass "1: temp-prefix matrix (4 prefixes, boundary-safe)"

# ── 2. linked worktree root (.git is a FILE) → temp/worktree ──
WT="$RSB/worktree-shaped"
mkdir -p "$WT"
echo "gitdir: /some/main/.git/worktrees/x" > "$WT/.git"
if is_temp_or_worktree_root "$WT"; then
  pass "2: .git-file root → temp/worktree (refuse)"
else
  fail "2: worktree root not detected" "$WT"
fi

# ── 3. main checkout root (.git is a DIRECTORY) → trusted ──
MC="$RSB/main-checkout"
mkdir -p "$MC/.git"
if is_temp_or_worktree_root "$MC"; then
  fail "3: .git-dir root wrongly refused" "$MC"
else
  pass "3: .git-dir root → trusted"
fi

# ── 4. plain non-git dir outside temp (packaged tree shape) → trusted ──
PK="$RSB/packaged-tree"
mkdir -p "$PK"
touch "$PK/.flywheel-prebuilt"
if is_temp_or_worktree_root "$PK"; then
  fail "4: packaged tree wrongly refused" "$PK"
else
  pass "4: non-git non-temp root (packaged tree) → trusted"
fi

# ── 5. real /tmp dir → temp (canonical prefix; macOS resolves /private/tmp) ──
if is_temp_or_worktree_root "$TSB"; then
  pass "5: /tmp dir → temp (canonical prefix)"
else
  fail "5: /tmp dir not judged temp" "$TSB → $(path_hygiene_canonicalize "$TSB" || echo '<err>')"
fi

# ── 5b. macOS real-machine predicate check (FLY-1285: verify the platform
# fact itself, not only hermetic fixtures) ──
if [[ "$(uname)" == "Darwin" ]]; then
  VF_CANON="$(path_hygiene_canonicalize /var/folders)"
  if [[ "$VF_CANON" == "/private/var/folders" ]]; then
    pass "5b: macOS /var/folders canonicalizes to /private/var/folders"
  else
    fail "5b: macOS canonical fact drifted" "got: $VF_CANON"
  fi
else
  pass "5b: (skipped — not macOS)"
fi

# ── 6. is_global_bin_dir: resolved identity vs \$HOME/.flywheel/bin ──
FH="$TSB/home"
mkdir -p "$FH/.flywheel/bin" "$FH/elsewhere"
ln -s "$FH/.flywheel/bin" "$FH/alias-bin"
G_OK=1
HOME="$FH" is_global_bin_dir "$FH/.flywheel/bin" || { G_OK=0; fail "6: exact global path not recognized"; }
HOME="$FH" is_global_bin_dir "$FH/.flywheel//bin" || { G_OK=0; fail "6: double-slash form not recognized"; }
HOME="$FH" is_global_bin_dir "$FH/alias-bin" || { G_OK=0; fail "6: symlink alias not recognized (resolved identity)"; }
if HOME="$FH" is_global_bin_dir "$FH/elsewhere"; then G_OK=0; fail "6: non-global dir wrongly global"; fi
[[ "$G_OK" == "1" ]] && pass "6: is_global_bin_dir resolved-identity matrix (exact / // / symlink alias / other)"

# ── 7. clean-host: \$HOME exists but .flywheel/bin does not — allow-missing
# canonicalization must still recognize global AND must not create anything ──
CH="$TSB/cleanhost"
mkdir -p "$CH"
C_OK=1
HOME="$CH" is_global_bin_dir "$CH/.flywheel/bin" || { C_OK=0; fail "7: clean-host global bin not recognized"; }
[[ ! -e "$CH/.flywheel" ]] || { C_OK=0; fail "7: predicate CREATED .flywheel on clean host"; }
[[ "$C_OK" == "1" ]] && pass "7: clean-host allow-missing canonicalization (recognized, zero side effects)"

# ── 8. fail-closed: unresolvable inputs trip the guard on BOTH predicates ──
FC_OK=1
is_temp_or_worktree_root "/nonexistent-fly1389/../weird" || { FC_OK=0; fail "8: dot-segment miss should be fail-closed temp"; }
HOME="$CH" is_global_bin_dir "/nonexistent-fly1389/../weird" || { FC_OK=0; fail "8: dot-segment miss should be fail-closed global"; }
is_temp_or_worktree_root "" || { FC_OK=0; fail "8: empty input should be fail-closed temp"; }
[[ "$FC_OK" == "1" ]] && pass "8: unresolvable input → fail-closed (guard triggers)"

# ── 9. path_hygiene_same_path (provisioner effective-global comparison) ──
S_OK=1
path_hygiene_same_path "$FH/.flywheel" "$FH/.flywheel/" || { S_OK=0; fail "9: trailing slash identity"; }
if path_hygiene_same_path "$FH/.flywheel" "$CH/.flywheel"; then S_OK=0; fail "9: distinct paths wrongly same"; fi
[[ "$S_OK" == "1" ]] && pass "9: same_path canonical identity"

# ── 10. owning repo root walk + target compound predicate ──
DEEP_WT="$WT/packages/x/dist"
mkdir -p "$DEEP_WT"
touch "$DEEP_WT/cli.js"
DEEP_MC="$MC/scripts/lib"
mkdir -p "$DEEP_MC"
touch "$DEEP_MC/tool.sh"
O_OK=1
[[ "$(path_hygiene_owning_repo_root "$DEEP_WT/cli.js")" == "$(path_hygiene_canonicalize "$WT")" ]] \
  || { O_OK=0; fail "10: owning root of deep worktree file"; }
path_hygiene_target_is_temp_or_worktree "$DEEP_WT/cli.js" || { O_OK=0; fail "10: deep worktree target not flagged"; }
if path_hygiene_target_is_temp_or_worktree "$DEEP_MC/tool.sh"; then
  O_OK=0; fail "10: main-checkout target wrongly flagged"
fi
path_hygiene_target_is_temp_or_worktree "$TSB/some/tool.sh" || { O_OK=0; fail "10: temp-canonical target not flagged"; }
[[ "$O_OK" == "1" ]] && pass "10: owning-root walk + target compound predicate (worktree deep file / trusted deep file / temp)"

# ── 11. sourcing is side-effect free (function definitions only) ──
SE="$TSB/sideffect-probe"
mkdir -p "$SE"
( cd "$SE" && source "$LIB" )
if [[ -z "$(ls -A "$SE")" ]]; then
  pass "11: sourcing the lib performs no writes"
else
  fail "11: sourcing wrote files" "$(ls -A "$SE")"
fi

# ── 12. runtime PATH tokens: native Homebrew must lead when Intel exists ──
NATIVE_HOMEBREW_BIN="/opt/homebrew/bin"
INTEL_HOMEBREW_BIN="/usr/local/bin"
RUNTIME_PATH_OK=1
if ! type path_hygiene_runtime_native_homebrew_precedes_intel >/dev/null 2>&1; then
  RUNTIME_PATH_OK=0
  fail "12: runtime native-before-Intel helper is missing"
else
  path_hygiene_runtime_native_homebrew_precedes_intel darwin \
    "$NATIVE_HOMEBREW_BIN:/usr/bin" \
    || { RUNTIME_PATH_OK=0; fail "12: native-only Darwin PATH should pass"; }
  path_hygiene_runtime_native_homebrew_precedes_intel darwin \
    "/usr/bin:/bin" \
    || { RUNTIME_PATH_OK=0; fail "12: clean Darwin PATH should pass"; }
  path_hygiene_runtime_native_homebrew_precedes_intel linux \
    "$INTEL_HOMEBREW_BIN:/usr/bin" \
    || { RUNTIME_PATH_OK=0; fail "12: non-Darwin PATH should pass"; }
  path_hygiene_runtime_native_homebrew_precedes_intel darwin \
    "$NATIVE_HOMEBREW_BIN:$INTEL_HOMEBREW_BIN:/usr/bin" \
    || { RUNTIME_PATH_OK=0; fail "12: native-first Darwin PATH should pass"; }
  if path_hygiene_runtime_native_homebrew_precedes_intel darwin \
    "$INTEL_HOMEBREW_BIN:/usr/bin"; then
    RUNTIME_PATH_OK=0; fail "12: Intel-only Darwin PATH should fail"
  fi
  if path_hygiene_runtime_native_homebrew_precedes_intel darwin \
    "$INTEL_HOMEBREW_BIN:$NATIVE_HOMEBREW_BIN:/usr/bin"; then
    RUNTIME_PATH_OK=0; fail "12: Intel-first Darwin PATH should fail"
  fi
  path_hygiene_runtime_native_homebrew_precedes_intel darwin \
    "/usr/local/bin-tools:/usr/bin" \
    || { RUNTIME_PATH_OK=0; fail "12: substring lookalikes must not count as Intel Homebrew"; }
fi
[[ "$RUNTIME_PATH_OK" == "1" ]] \
  && pass "12: runtime PATH uses exact colon tokens and enforces native-before-Intel on Darwin"

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] || exit 1
