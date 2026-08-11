#!/usr/bin/env bash
# FLY-1678 — install-statusline.sh contract.
#
# The installed file renders on every pane on the founder's machine, so what is
# under test is not "did it copy a file" but "can it ever leave a broken
# statusline live, can it ever REPORT one as fine, and can a failed attempt
# damage the rollback point".
#
# Hermetic. Two things make that non-obvious and are worth stating:
#
#   * The installer's smoke render deliberately uses the REAL host toolchain, so
#     that it proves the script works with the date/stat/tr that will actually
#     run it in production. The statusline is BSD-only, so on the Ubuntu CI
#     runner that smoke would fail for reasons unrelated to the installer. The
#     suite therefore puts the committed deterministic shims on PATH; the
#     production-Mac run against real tools is a separate release gate.
#   * Positive cases need a checkout that is NOT temp and NOT a worktree — and
#     this repo checkout may well be a worktree — so they run against minimal
#     fixture checkouts under $HOME, mirroring install-hooks-fly1389.test.sh.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SHIM="$HERE/fixtures/fly1678/shim"
export FLY1678_FAKE_NOW=1786449600
export FLY1678_MARKER=/dev/null   # the shims' forbidden-call log; unused here

CHECKS=0; FAILURES=0
pass() { CHECKS=$((CHECKS+1)); echo "  ok   — $1"; }
fail() { CHECKS=$((CHECKS+1)); FAILURES=$((FAILURES+1)); echo "  FAIL — $1"; shift; printf '         %s\n' "$@"; return 0; }
check() { if [ "$1" -eq 0 ]; then pass "$2"; else shift; fail "$@"; fi; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fly1678-install.XXXXXX")"
# A NON-temp parent (the hygiene guard rejects temp paths), but a unique child so
# two concurrent suite runs cannot delete each other's fixtures.
mkdir -p "$HOME/.flywheel/fly1678-test-checkouts"
TRUSTED_BASE=$(mktemp -d "$HOME/.flywheel/fly1678-test-checkouts/run.XXXXXX")
trap 'rm -rf "$WORK" "$TRUSTED_BASE"' EXIT

# 0 when the directory holds no leftover temp files, at ANY depth — a rename into
# a directory-shaped target would nest one where a flat glob could not see it.
no_residue() {
  [ -z "$(find "$1" \( -name '*.staged.*' -o -name '*.restore.*' -o -name '*.bak.tmp.*' \) -print 2>/dev/null | head -1)" ]
}
# "was this file rewritten?" — read the mtime exactly. Not `ls` (unparseable),
# not `stat` (BSD and GNU disagree on the flags — the very trap this issue is
# about), and NOT bash's `-nt`: production /bin/bash is 3.2, whose `-nt` compares
# whole SECONDS only, so a rewrite inside the same second reads as unchanged and
# every idempotency assertion below would pass for free. Measured: bash 5 detects
# it, bash 3.2 does not. python3 is already required by the harness.
mtime_ns() { python3 -c 'import os,sys;print(os.stat(sys.argv[1]).st_mtime_ns)' "$1" 2>/dev/null || echo 0; }

# build_checkout <root> <git-shape: dir|file> [source-override]
build_checkout() {
  local root="$1" shape="$2" src="${3:-}"
  rm -rf "$root"; mkdir -p "$root/scripts/lib"
  if [ "$shape" = "dir" ]; then mkdir -p "$root/.git"
  else echo "gitdir: /elsewhere/.git/worktrees/x" > "$root/.git"; fi
  cp "$REPO/scripts/install-statusline.sh" "$root/scripts/"
  cp "$REPO/scripts/lib/path-hygiene.sh"   "$root/scripts/lib/"
  if [ -n "$src" ]; then cp "$src" "$root/scripts/statusline-command.sh"
  else cp "$REPO/scripts/statusline-command.sh" "$root/scripts/"; fi
  chmod 0755 "$root/scripts/install-statusline.sh" "$root/scripts/statusline-command.sh"
}
make_checkout() { build_checkout "$TRUSTED_BASE/$1" dir "${2:-}"; echo "$TRUSTED_BASE/$1"; }

make_home() { # <name> [statusline-command-override] -> echoes the HOME
  local home="$WORK/$1"; mkdir -p "$home/.claude"
  local cmd="${2-bash $home/.claude/statusline-command.sh}"
  jq -n --arg c "$cmd" '{statusLine:{type:"command",command:$c}}' > "$home/.claude/settings.json"
  echo "$home"
}

# run_install <checkout> <home> [extra-PATH-prefix]
run_install() {
  OUT="$WORK/install.log"
  local extra="${3:-}"
  if env HOME="$2" FLYWHEEL_STATUSLINE_CLAUDE_DIR="$2/.claude" \
       PATH="${extra:+$extra:}$SHIM:$PATH" \
       FLY1678_FAKE_NOW="$FLY1678_FAKE_NOW" FLY1678_MARKER="$FLY1678_MARKER" \
       /bin/bash "$1/scripts/install-statusline.sh" > "$OUT" 2>&1; then RC=0; else RC=$?; fi
}

echo "FLY-1678 install-statusline.sh contract"
echo

echo "[0] the mtime mechanism itself — an assertion that can only ever say"
echo "    'unchanged' would pass every idempotency check for free"
MT="$WORK/mtime-probe"; echo a > "$MT"; MT_BEFORE=$(mtime_ns "$MT")
check "$([ "$(mtime_ns "$MT")" = "$MT_BEFORE" ] && echo 0 || echo 1)" \
  "0: an untouched file reads as unchanged"
echo b > "$MT"    # rewritten immediately, same wall-clock second
check "$([ "$(mtime_ns "$MT")" != "$MT_BEFORE" ] && echo 0 || echo 1)" \
  "0: a same-second rewrite IS detected — the assertion is not vacuous" \
  "before=$MT_BEFORE after=$(mtime_ns "$MT")"
echo

# The rollback path verifies the restored file by RUNNING it, and the smoke gate
# demands real rendered content, so the fixture "previous version" has to be an
# actual working statusline. Take the real one and mark it, so it is
# distinguishable from the candidate while still rendering properly.
PRIOR_FILE="$WORK/prior-statusline.sh"
{ head -1 "$REPO/scripts/statusline-command.sh"
  echo "# FLY-1678 test fixture: stands in for the PREVIOUS installed version"
  tail -n +2 "$REPO/scripts/statusline-command.sh"; } > "$PRIOR_FILE"
chmod 0755 "$PRIOR_FILE"

# A candidate that renders perfectly everywhere EXCEPT at the final live path.
# Built from the real script so it clears the content-asserting smoke gate at the
# source and staged paths; only the destination directory makes it fail.
INJECT="$WORK/inject-after-rename.sh"
{ head -1 "$REPO/scripts/statusline-command.sh"
  cat <<'INJ'
# FLY-1678 test fixture: fails ONLY once live at .claude/statusline-command.sh.
# Discriminates on the DESTINATION directory, not the basename: the source lives
# at <checkout>/scripts/statusline-command.sh and the staged copy carries a
# .staged.XXXXXX suffix, so only the final live path matches here.
case "$0" in
  */.claude/statusline-command.sh) cat > /dev/null; exit 7 ;;
esac
INJ
  tail -n +2 "$REPO/scripts/statusline-command.sh"; } > "$INJECT"
chmod 0755 "$INJECT"


# ---------------------------------------------------------------------------
echo "[1] refuses to install global config from an untrusted checkout"
echo "  1a: worktree — a .git FILE at a NON-temp path"
# Deliberately not under /tmp: a fixture there trips the temp-path branch first,
# and the test would prove temp refusal while claiming to prove worktree refusal.
WT="$TRUSTED_BASE/worktree-shaped"; build_checkout "$WT" file
H=$(make_home home-worktree)
run_install "$WT" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "1a: exits non-zero" "rc=$RC log=$(cat "$OUT")"
check "$(grep -qi "worktree" "$OUT" && echo 0 || echo 1)" "1a: names the worktree guard"
check "$([ ! -e "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" "1a: target never created"
check "$([ ! -e "$H/.claude/statusline-command.sh.bak" ] && echo 0 || echo 1)" "1a: no backup created"

echo "  1b: temp path — a real .git DIRECTORY under /tmp"
# Explicitly /tmp, not $TMPDIR: path-hygiene recognises /tmp, /private/tmp and
# /var/folders, and a host whose TMPDIR points elsewhere (this repo's own runners
# do) would make the fixture non-temp and the assertion vacuous.
TMPCO=$(mktemp -d /tmp/fly1678-tempco.XXXXXX)/checkout; build_checkout "$TMPCO" dir
trap 'rm -rf "$WORK" "$TRUSTED_BASE" "$(dirname "$TMPCO")"' EXIT
H=$(make_home home-temp)
run_install "$TMPCO" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "1b: exits non-zero" "rc=$RC"
check "$([ ! -e "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" "1b: target never created"

# ---------------------------------------------------------------------------
echo
echo "[2] refuses a source that does not parse — zero global writes"
BAD="$WORK/bad-source.sh"
printf '#!/usr/bin/env bash\nif [ 1 -eq 1 ]; then\n  echo unterminated\n' > "$BAD"
CO_BAD=$(make_checkout co-badsyntax "$BAD")
H=$(make_home home-badsyntax)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
printf '%s\n' "pre-existing backup" > "$H/.claude/statusline-command.sh.bak"
BAK_BEFORE=$(cksum < "$H/.claude/statusline-command.sh.bak")
BAK_MTIME_BEFORE=$(mtime_ns "$H/.claude/statusline-command.sh.bak")
run_install "$CO_BAD" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "2: exits non-zero" "rc=$RC"
check "$(grep -q "bash -n" "$OUT" && echo 0 || echo 1)" "2: names the syntax gate" "log: $(cat "$OUT")"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" "2: live target untouched"
check "$([ "$(cksum < "$H/.claude/statusline-command.sh.bak")" = "$BAK_BEFORE" ] && echo 0 || echo 1)" \
  "2: existing backup content NOT advanced by a failed attempt"
check "$([ "$(mtime_ns "$H/.claude/statusline-command.sh.bak")" = "$BAK_MTIME_BEFORE" ] && echo 0 || echo 1)" \
  "2: existing backup mtime unchanged too — it was not rewritten"

# ---------------------------------------------------------------------------
echo
echo "[3] read-only settings gate"
CO=$(make_checkout co-settings)
for label in "wrong-command" "wrong-type" "invalid-json" "substring-only"; do
  case "$label" in
    wrong-command)  H=$(make_home "home-$label" "bash /somewhere/else/statusline-command.sh") ;;
    wrong-type)     H=$(make_home "home-$label"); jq '.statusLine.type="script"' "$H/.claude/settings.json" > "$H/t" && mv "$H/t" "$H/.claude/settings.json" ;;
    invalid-json)   H=$(make_home "home-$label"); printf '{not json' > "$H/.claude/settings.json" ;;
    # merely MENTIONS the path in a comment — a substring test would wave this through
    substring-only) H=$(make_home "home-$label" "true # $WORK/home-$label/.claude/statusline-command.sh") ;;
  esac
  run_install "$CO" "$H"
  check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "3/$label: exits non-zero" "rc=$RC log=$(cat "$OUT")"
  check "$([ ! -e "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" "3/$label: target never created"
done
check "$(grep -q "read-only" "$OUT" && echo 0 || echo 1)" "3: states that settings.json is never rewritten"

# ---------------------------------------------------------------------------
echo
echo "[4] clean install"
H=$(make_home home-clean)
run_install "$CO" "$H"
check "$RC" "4: exits 0" "log: $(cat "$OUT")"
check "$(cmp -s "$CO/scripts/statusline-command.sh" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "4: installed bytes identical to source"
check "$([ -n "$(find "$H/.claude/statusline-command.sh" -perm 0755)" ] && echo 0 || echo 1)" "4: mode 0755"
check "$([ ! -e "$H/.claude/statusline-command.sh.bak" ] && echo 0 || echo 1)" \
  "4: no backup invented when there was nothing to back up"
check "$(no_residue "$H/.claude" && echo 0 || echo 1)" "4: no staged temp residue"

# ---------------------------------------------------------------------------
echo
echo "[5] backup captures the pre-install version"
H=$(make_home home-backup)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
run_install "$CO" "$H"
check "$RC" "5: exits 0"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh.bak" && echo 0 || echo 1)" \
  "5: .bak holds exactly the version that was live before"
check "$(cmp -s "$CO/scripts/statusline-command.sh" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "5: target is the new version"

# ---------------------------------------------------------------------------
echo
echo "[6] idempotency — re-run changes nothing"
BAK_BEFORE=$(cksum < "$H/.claude/statusline-command.sh.bak")
BAK_MTIME_BEFORE=$(mtime_ns "$H/.claude/statusline-command.sh.bak")
TGT_BEFORE=$(cksum < "$H/.claude/statusline-command.sh")
TGT_MTIME_BEFORE=$(mtime_ns "$H/.claude/statusline-command.sh")
run_install "$CO" "$H"
check "$RC" "6: exits 0"
check "$(grep -q "already current" "$OUT" && echo 0 || echo 1)" "6: reports already current" "log: $(cat "$OUT")"
check "$([ "$(cksum < "$H/.claude/statusline-command.sh")" = "$TGT_BEFORE" ] && echo 0 || echo 1)" "6: target content unchanged"
check "$([ "$(mtime_ns "$H/.claude/statusline-command.sh")" = "$TGT_MTIME_BEFORE" ] && echo 0 || echo 1)" "6: target mtime unchanged"
check "$([ "$(cksum < "$H/.claude/statusline-command.sh.bak")" = "$BAK_BEFORE" ] && echo 0 || echo 1)" \
  "6: backup content NOT churned by a no-op run"
check "$([ "$(mtime_ns "$H/.claude/statusline-command.sh.bak")" = "$BAK_MTIME_BEFORE" ] && echo 0 || echo 1)" \
  "6: backup mtime unchanged too"

echo
echo "[7] same content, wrong mode — converge without churning the backup"
chmod 0644 "$H/.claude/statusline-command.sh"
run_install "$CO" "$H"
check "$RC" "7: exits 0"
check "$([ -n "$(find "$H/.claude/statusline-command.sh" -perm 0755)" ] && echo 0 || echo 1)" "7: mode repaired to 0755"
check "$([ "$(cksum < "$H/.claude/statusline-command.sh.bak")" = "$BAK_BEFORE" ] && echo 0 || echo 1)" \
  "7: backup still untouched"

# ---------------------------------------------------------------------------
echo
echo "[8] a source that parses but dies at runtime is caught by the smoke gate"
RUNTIME_BAD="$WORK/runtime-bad.sh"
printf '#!/usr/bin/env bash\ncat > /dev/null\nexit 3\n' > "$RUNTIME_BAD"
CO_RT=$(make_checkout co-runtimebad "$RUNTIME_BAD")
H=$(make_home home-runtimebad)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
printf '%s\n' "pre-existing backup" > "$H/.claude/statusline-command.sh.bak"
BAK_BEFORE=$(cksum < "$H/.claude/statusline-command.sh.bak")
run_install "$CO_RT" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "8: exits non-zero" "rc=$RC"
check "$(grep -q "smoke" "$OUT" && echo 0 || echo 1)" "8: names the smoke gate" "log: $(cat "$OUT")"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" "8: live target untouched"
check "$([ "$(cksum < "$H/.claude/statusline-command.sh.bak")" = "$BAK_BEFORE" ] && echo 0 || echo 1)" \
  "8: backup not advanced — a runtime-bad source never reaches the commit phase"

# ---------------------------------------------------------------------------
echo
echo "[9] REAL post-rename failure -> automatic, verified rollback"
# A genuine injection with no test-only seam in the installer: the source behaves
# differently depending on the path it is invoked through. The staged copy is
# ".../statusline-command.sh.staged.XXXXXX" so it passes every pre-commit gate;
# the same bytes start failing once renamed to the final name. That is exactly
# the "atomically installed a bad file" case atomic rename cannot protect against.
CO_INJ=$(make_checkout co-inject "$INJECT")

echo "  9a: with a previous version present"
H=$(make_home home-inject)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
run_install "$CO_INJ" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "9a: exits non-zero" "rc=$RC log=$(cat "$OUT")"
check "$(grep -q "Rolled back" "$OUT" && echo 0 || echo 1)" "9a: reports the rollback" "log: $(cat "$OUT")"
# Positive control: a rollback point only exists if the run got PAST staging into
# the commit phase. Without this, the test could pass on an earlier-gate failure.
check "$([ -f "$H/.claude/statusline-command.sh.bak" ] && echo 0 || echo 1)" \
  "9a: a rollback point exists — proof the run reached the commit phase"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "9a: live target restored to the pre-install version — no broken file left live"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh.bak" && echo 0 || echo 1)" \
  "9a: the rollback point itself still holds the pre-install version"
check "$(no_residue "$H/.claude" && echo 0 || echo 1)" "9a: no staged/restore temp residue"

echo "  9b: clean install (nothing to roll back to)"
H=$(make_home home-inject-clean)
run_install "$CO_INJ" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "9b: exits non-zero" "rc=$RC"
check "$([ ! -e "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" \
  "9b: the bad file is removed — machine back to having no statusline file"
check "$([ ! -e "$H/.claude/statusline-command.sh.bak" ] && echo 0 || echo 1)" "9b: no phantom backup"

echo "  9c: removal itself fails -> ROLLBACK FAILED, never a success claim"
H=$(make_home home-inject-rmfail)
RMSHIM="$WORK/rmshim"; mkdir -p "$RMSHIM"
cat > "$RMSHIM/rm" <<'RMS'
#!/usr/bin/env bash
# Fail only when asked to delete the live statusline target, so the clean-install
# rollback path genuinely cannot remove it.
for a in "$@"; do
  case "$a" in */.claude/statusline-command.sh) exit 1 ;; esac
done
exec /bin/rm "$@"
RMS
chmod 0755 "$RMSHIM/rm"
run_install "$CO_INJ" "$H" "$RMSHIM"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "9c: exits non-zero" "rc=$RC"
check "$(grep -q "ROLLBACK FAILED" "$OUT" && echo 0 || echo 1)" \
  "9c: reports ROLLBACK FAILED rather than 'removed'" "log: $(cat "$OUT")"
check "$(grep -q "rm -f" "$OUT" && echo 0 || echo 1)" "9c: prints an exact manual recovery command"

# ---------------------------------------------------------------------------
echo
echo "[10] interrupted install left matching bytes — must NOT be blessed"
# Recovery path after a crash between rename and verification: the target already
# holds bytes identical to the source, so a content-only idempotency check would
# short-circuit to success and permanently bless a broken live statusline.
H=$(make_home home-interrupted)
cp "$CO_INJ/scripts/statusline-command.sh" "$H/.claude/statusline-command.sh"
chmod 0755 "$H/.claude/statusline-command.sh"
run_install "$CO_INJ" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "10: exits non-zero" "rc=$RC log=$(cat "$OUT")"
check "$(grep -q "already current" "$OUT" && echo 1 || echo 0)" \
  "10: does NOT report 'already current' for a target that cannot run"
check "$(grep -qi "does not run\|Refusing" "$OUT" && echo 0 || echo 1)" \
  "10: says why" "log: $(cat "$OUT")"

# ---------------------------------------------------------------------------
echo
echo "[12] non-regular target/backup shapes are refused before the commit phase"
# `mv staged dir` SUCCEEDS by nesting the file inside the directory, and
# `cp dir target` fails midway — both end with the broken candidate live and an
# unusable recovery command, so these shapes are rejected up front.
H=$(make_home home-dirtarget); mkdir -p "$H/.claude/statusline-command.sh"
run_install "$CO" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "12a: directory-shaped target refused" "rc=$RC"
check "$(grep -q "not a plain regular file" "$OUT" && echo 0 || echo 1)" "12a: says why" "log: $(cat "$OUT")"
check "$([ -d "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" "12a: nothing was written into it"
check "$(no_residue "$H/.claude" && echo 0 || echo 1)" "12a: no residue"

H=$(make_home home-dirbackup)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
mkdir -p "$H/.claude/statusline-command.sh.bak"
run_install "$CO" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "12b: directory-shaped backup refused" "rc=$RC"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "12b: live target untouched"
check "$(no_residue "$H/.claude" && echo 0 || echo 1)" "12b: no nested backup-temp residue"

# ---------------------------------------------------------------------------
echo
echo "[13] a second installer cannot share the one mutable rollback point"
# Two concurrent runs share a single .bak: one can back up the other's
# unverified in-flight bytes, and a later rollback then 'restores' them.
H=$(make_home home-lock)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
mkdir -p "$H/.claude/.statusline-install.lock"      # simulate a run in progress
run_install "$CO" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "13: refuses while another holds the lock" "rc=$RC"
check "$(grep -q "holds" "$OUT" && echo 0 || echo 1)" "13: names the lock" "log: $(cat "$OUT")"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "13: the other run's target is untouched"
rmdir "$H/.claude/.statusline-install.lock"
run_install "$CO" "$H"
check "$RC" "13: proceeds once the lock is released" "log: $(cat "$OUT")"
check "$([ ! -e "$H/.claude/.statusline-install.lock" ] && echo 0 || echo 1)" \
  "13: the lock is released on exit, not leaked"

# ---------------------------------------------------------------------------
echo
echo "[14] interrupted-install recovery actually RECOVERS"
# Detecting the state is only half of it: the header promises a broken file is
# never left live, so this path must restore (or remove) and verify.
H=$(make_home home-recover)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh.bak"
cp "$CO_INJ/scripts/statusline-command.sh" "$H/.claude/statusline-command.sh"
chmod 0755 "$H/.claude/statusline-command.sh"
run_install "$CO_INJ" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "14a: exits non-zero" "rc=$RC"
check "$(grep -q "Rolled back" "$OUT" && echo 0 || echo 1)" "14a: rolled back, not merely reported" "log: $(cat "$OUT")"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "14a: the live target is the healthy backup, not the broken bytes"
# And the health of the final state is asserted directly, not inferred.
printf '%s' '{}' | /bin/bash "$H/.claude/statusline-command.sh" >/dev/null 2>&1
check "$?" "14a: the live target actually runs"

H=$(make_home home-recover-nobak)
cp "$CO_INJ/scripts/statusline-command.sh" "$H/.claude/statusline-command.sh"
chmod 0755 "$H/.claude/statusline-command.sh"
run_install "$CO_INJ" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "14b: exits non-zero" "rc=$RC"
check "$([ ! -e "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" \
  "14b: with no backup, the broken target is removed rather than blessed"

# ---------------------------------------------------------------------------
echo
echo "[11] rename itself fails -> the live target is NOT damaged"
# Real injection: a PATH `mv` that fails ONLY for staged -> target, so the
# backup/rename commit phase is entered and the rename is the thing that breaks.
# (The previous shape of this test made TARGET a directory, which made `mv`
# SUCCEED by moving the staged file inside it — it never exercised this path.)
MVSHIM="$WORK/mvshim"; mkdir -p "$MVSHIM"
cat > "$MVSHIM/mv" <<'MVS'
#!/usr/bin/env bash
case "${1:-}" in
  *.staged.*) echo "mv shim: refusing staged rename" >&2; exit 1 ;;
esac
exec /bin/mv "$@"
MVS
chmod 0755 "$MVSHIM/mv"
H=$(make_home home-mvfail)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
run_install "$CO" "$H" "$MVSHIM"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "11: exits non-zero" "rc=$RC"
check "$(grep -q "mv shim: refusing staged rename" "$OUT" && echo 0 || echo 1)" \
  "11: the injection actually fired (not an earlier gate)" "log: $(cat "$OUT")"
check "$(grep -q "rename into place failed" "$OUT" && echo 0 || echo 1)" \
  "11: emits the exact rename-failure diagnostic" "log: $(cat "$OUT")"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "11: the old live bytes are still there"
check "$(grep -q "already refreshed" "$OUT" && echo 0 || echo 1)" \
  "11: honestly reports that .bak advanced (the commit phase had begun)"
check "$(no_residue "$H/.claude" && echo 0 || echo 1)" "11: staged temp cleaned up on the failure path"

# ---------------------------------------------------------------------------
echo
echo "[15] the smoke gate demands CONTENT, not two newlines"
# `cat >/dev/null; echo; echo` exits 0 with two lines and empty stderr. A
# shape-only gate installs it and every pane goes blank.
BLANK="$WORK/blank-statusline.sh"
printf '#!/usr/bin/env bash\ncat > /dev/null\necho\necho\n' > "$BLANK"; chmod 0755 "$BLANK"
CO_BLANK=$(make_checkout co-blank "$BLANK")
H=$(make_home home-blank)
run_install "$CO_BLANK" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "15: a blank two-line renderer is refused" "rc=$RC log=$(cat "$OUT")"
check "$(grep -q "missing:" "$OUT" && echo 0 || echo 1)" "15: names the anchors it could not find" "log: $(cat "$OUT")"
check "$([ ! -e "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" "15: nothing installed"

# ---------------------------------------------------------------------------
echo
echo "[16] symlinks are not a stable install target"
# `-f` and `-e` FOLLOW symlinks, so a link to a source-identical file reads as
# 'already current' — until its referent moves and the configured path dangles.
H=$(make_home home-symlink)
cp "$CO/scripts/statusline-command.sh" "$WORK/referent.sh"; chmod 0755 "$WORK/referent.sh"
ln -s "$WORK/referent.sh" "$H/.claude/statusline-command.sh"
run_install "$CO" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "16a: a symlinked target is refused" "rc=$RC log=$(cat "$OUT")"
check "$([ -L "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" "16a: the link is left alone, not silently replaced"

H=$(make_home home-symlink-bak)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
ln -s "$WORK/referent.sh" "$H/.claude/statusline-command.sh.bak"
run_install "$CO" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "16b: a symlinked backup is refused" "rc=$RC"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" "16b: live target untouched"

H=$(make_home home-symlink-dangling)
ln -s "$WORK/does-not-exist" "$H/.claude/statusline-command.sh"
run_install "$CO" "$H"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "16c: a DANGLING symlink is refused too" "rc=$RC"
check "$([ -L "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" "16c: still a link — absence was not misread"

# ---------------------------------------------------------------------------
echo
echo "[17] the backup temp is reserved, not composed from a predictable name"
# The former "$BACKUP.tmp.$$" could be pre-created as a DIRECTORY by a stale
# artifact or PID reuse, after which `cp file dir` and `mv dir backup` both
# succeed and .bak becomes a directory rollback cannot read. A decoy at a GUESSED
# pid proves nothing — the old code used the installer's real $$ — so this asserts
# the mechanism directly: the temp must come from mktemp with an XXXXXX template.
MKSHIM="$WORK/mkshim"; mkdir -p "$MKSHIM"
cat > "$MKSHIM/mktemp" <<MKS
#!/usr/bin/env bash
echo "mktemp \$*" >> "$WORK/mktemp-calls.log"
exec /usr/bin/mktemp "\$@"
MKS
chmod 0755 "$MKSHIM/mktemp"
: > "$WORK/mktemp-calls.log"
H=$(make_home home-baktmp)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
run_install "$CO" "$H" "$MKSHIM"
check "$RC" "17: install succeeds" "log: $(cat "$OUT")"
check "$(grep -q 'statusline-command.sh.bak.tmp.XXXXXX' "$WORK/mktemp-calls.log" && echo 0 || echo 1)" \
  "17: the backup temp was RESERVED via mktemp, not composed from \$\$" \
  "mktemp calls: $(cat "$WORK/mktemp-calls.log")"
check "$([ -f "$H/.claude/statusline-command.sh.bak" ] && [ ! -L "$H/.claude/statusline-command.sh.bak" ] && echo 0 || echo 1)" \
  "17: .bak is a plain regular file"
# And a decoy sitting at the OLD predictable shape must not be adopted either.
H=$(make_home home-baktmp-decoy)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
mkdir -p "$H/.claude/statusline-command.sh.bak.tmp.99999"
run_install "$CO_INJ" "$H"
check "$([ -f "$H/.claude/statusline-command.sh.bak" ] && echo 0 || echo 1)" \
  "17b: a stale decoy temp never becomes the rollback point"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "17b: rollback still restored the healthy version"

# ---------------------------------------------------------------------------
echo
echo "[18] a signal after the rename must still roll back"
# The window between the staged->target rename and its verification. Without a
# phase-aware trap the unverified candidate stays live while a healthy backup
# sits unused. Injected by a `mv` shim that completes the real rename and then
# signals the installer.
SIGSHIM="$WORK/sigshim"; mkdir -p "$SIGSHIM"
cat > "$SIGSHIM/mv" <<'SIGS'
#!/usr/bin/env bash
case "${1:-}" in
  *.staged.*)
    /bin/mv "$@" || exit $?
    echo "mv shim: rename committed, now signalling the installer" >&2
    kill -TERM "$PPID" 2>/dev/null
    sleep 5
    exit 0
    ;;
esac
exec /bin/mv "$@"
SIGS
chmod 0755 "$SIGSHIM/mv"
H=$(make_home home-signal)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
run_install "$CO_INJ" "$H" "$SIGSHIM"
check "$([ "$RC" -eq 143 ] && echo 0 || echo 1)" "18: exits exactly 143 (the TERM status is preserved)" "rc=$RC"
check "$(grep -q "rename committed" "$OUT" && echo 0 || echo 1)" \
  "18: the injection really committed the rename first" "log: $(cat "$OUT")"
check "$(grep -qi "interrupted after the target landed" "$OUT" && echo 0 || echo 1)" \
  "18: the interrupt is recognised as landed-but-unverified" "log: $(cat "$OUT")"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "18: the healthy previous version is live again, not the unverified candidate"
check "$([ ! -e "$H/.claude/.statusline-install.lock" ] && echo 0 || echo 1)" "18: the lock is released"

# ---------------------------------------------------------------------------
echo
echo "[19] a cleanup failure must not mask the error or leak the lock"
# The failure has to happen AFTER the lock is taken and the staged temp exists,
# otherwise there is no cleanup to fail and no lock to leak — an earlier version
# of this test used a syntax-invalid source, which dies at the very first gate.
# So: a candidate that renders fine at the source path but fails at the STAGED
# path (the mirror image of the post-rename injection), plus an rm that refuses
# to remove the staged temp.
STAGEFAIL="$WORK/stage-fail.sh"
{ head -1 "$REPO/scripts/statusline-command.sh"
  cat <<'SF'
# FLY-1678 test fixture: fails only when invoked through a .staged. path.
case "$0" in
  *.staged.*) cat > /dev/null; echo "stage-fail marker" >&2; exit 71 ;;
esac
SF
  tail -n +2 "$REPO/scripts/statusline-command.sh"; } > "$STAGEFAIL"
chmod 0755 "$STAGEFAIL"
CO_SF=$(make_checkout co-stagefail "$STAGEFAIL")

RMFAIL="$WORK/rmfail"; mkdir -p "$RMFAIL"
cat > "$RMFAIL/rm" <<RMF
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *.staged.*) echo "rm shim: refusing to remove the staged temp" >&2; exit 72 ;;
  esac
done
exec /bin/rm "\$@"
RMF
chmod 0755 "$RMFAIL/rm"

H=$(make_home home-cleanupfail)
run_install "$CO_SF" "$H" "$RMFAIL"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "19: exits non-zero" "rc=$RC"
check "$(grep -q "stage-fail marker" "$OUT" && echo 0 || echo 1)" \
  "19: the staged-smoke injection actually fired (the lock and staged temp exist by now)" \
  "log: $(cat "$OUT")"
check "$(grep -q "rm shim: refusing" "$OUT" && echo 0 || echo 1)" \
  "19: the cleanup injection actually fired" "log: $(cat "$OUT")"
check "$(grep -q "cleanup: could not remove" "$OUT" && echo 0 || echo 1)" \
  "19: the cleanup failure is reported, not swallowed" "log: $(cat "$OUT")"
check "$([ ! -e "$H/.claude/.statusline-install.lock" ] && echo 0 || echo 1)" \
  "19: the lock is STILL released even though an earlier cleanup action failed"
check "$([ ! -e "$H/.claude/statusline-command.sh" ] && echo 0 || echo 1)" \
  "19: nothing was installed"

# ---------------------------------------------------------------------------
echo
echo "[20] a signal DURING rollback must not abandon the broken target"
# recover_target used to run with signals live while PHASE already said
# "verified", so a TERM mid-restore exited through an EXIT handler that skipped
# recovery — broken candidate left live, healthy backup unused.
CPSHIM="$WORK/cpshim"; mkdir -p "$CPSHIM"
cat > "$CPSHIM/cp" <<CPS
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *.restore.*)
      echo "cp shim: signalling during recovery" >&2
      kill -TERM "\$PPID" 2>/dev/null
      sleep 1
      ;;
  esac
done
exec /bin/cp "\$@"
CPS
chmod 0755 "$CPSHIM/cp"
H=$(make_home home-signal-recovery)
cp "$PRIOR_FILE" "$H/.claude/statusline-command.sh"; chmod 0755 "$H/.claude/statusline-command.sh"
run_install "$CO_INJ" "$H" "$CPSHIM"
check "$([ "$RC" -ne 0 ] && echo 0 || echo 1)" "20: exits non-zero" "rc=$RC"
check "$(grep -q "cp shim: signalling during recovery" "$OUT" && echo 0 || echo 1)" \
  "20: the injection actually fired mid-recovery" "log: $(cat "$OUT")"
check "$(cmp -s "$PRIOR_FILE" "$H/.claude/statusline-command.sh" && echo 0 || echo 1)" \
  "20: recovery completed anyway — the healthy version is live"
printf '%s' '{"model":{"display_name":"X"},"context_window":{"used_percentage":1}}' \
  | env HOME="$H" PATH="$SHIM:$PATH" /bin/bash "$H/.claude/statusline-command.sh" >/dev/null 2>&1
check "$?" "20: and the live target actually runs"
check "$([ ! -e "$H/.claude/.statusline-install.lock" ] && echo 0 || echo 1)" "20: the lock is released"

# ---------------------------------------------------------------------------
echo
echo "[21] a signal between mkdir and ownership must not leak the lock"
MKLOCK="$WORK/mklock"; mkdir -p "$MKLOCK"
cat > "$MKLOCK/mkdir" <<MKL
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *.statusline-install.lock)
      /bin/mkdir "\$@" || exit \$?
      # A file marker, not stderr: the installer sends this call's stderr
      # to /dev/null, which would swallow the evidence.
      echo fired > "$WORK/mkdir-lock-marker"
      kill -TERM "\$PPID" 2>/dev/null
      sleep 1
      exit 0
      ;;
  esac
done
exec /bin/mkdir "\$@"
MKL
chmod 0755 "$MKLOCK/mkdir"
H=$(make_home home-locksignal)
rm -f "$WORK/mkdir-lock-marker"
run_install "$CO" "$H" "$MKLOCK"
check "$([ -f "$WORK/mkdir-lock-marker" ] && echo 0 || echo 1)" \
  "21: the injection created the lock and then signalled" "log: $(cat "$OUT")"
check "$([ ! -e "$H/.claude/.statusline-install.lock" ] && echo 0 || echo 1)" \
  "21: no lock is left behind to block every later run"
# The window is mkdir plus one assignment, so the deferred TERM is discarded and
# the run finishes normally. That is the intended trade: a leaked lock blocks
# every future run, whereas losing a signal across a microsecond window does not.
check "$RC" "21: the run completes rather than dying mid-acquisition" "rc=$RC"

echo
if [ "$FAILURES" -eq 0 ]; then echo "PASS — $CHECKS checks, 0 failures"; exit 0; fi
echo "FAIL — $FAILURES of $CHECKS checks failed"; exit 1
