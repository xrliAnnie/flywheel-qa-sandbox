#!/usr/bin/env bash
# FLY-2274: phase-b exact-contract and fail-closed tests.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/cutover/FLY-2264/phase-b-link.sh"
RUNBOOK="$ROOT/engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md"
TMP="$(mktemp -d -t fly2264-phase-b.XXXXXX)"
TMP="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP")"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }

echo "Test: script contains the six exact runbook logical commands"
if [ -f "$SCRIPT" ] && python3 - "$SCRIPT" "$RUNBOOK" <<'PY'
import pathlib, re, sys
def normalized(path):
    text = pathlib.Path(path).read_text()
    return re.sub(r"[ \t]*\\\n[ \t]*", " ", text)
script, runbook = map(normalized, sys.argv[1:])
commands = [
    "/opt/homebrew/bin/brew link tmux",
    "/opt/homebrew/bin/brew pin tmux",
    "test \"$(python3 -c 'import os; print(os.path.realpath(\"/opt/homebrew/bin/tmux\"))')\" = '/opt/homebrew/Cellar/tmux/3.7c/bin/tmux'",
    "test \"$(/opt/homebrew/bin/tmux -V)\" = 'tmux 3.7c'",
    "file -b /opt/homebrew/Cellar/tmux/3.7c/bin/tmux | grep -F arm64",
    "/opt/homebrew/bin/brew list --pinned | grep -Fx tmux",
]
raise SystemExit(0 if all(c in script and c in runbook for c in commands) else 1)
PY
then
  pass "phase-b preserves all six reviewed commands"
else
  fail "phase-b is missing an exact runbook command"
fi

mkdir -p "$TMP/bin" "$TMP/cellar"
cat >"$TMP/bin/brew" <<'STUB'
#!/usr/bin/env bash
set -u
printf 'brew %s\n' "$*" >>"${FLY2264_PHASE_LEDGER:?}"
case "$*" in
  'link tmux') [[ "${FLY2264_PHASE_FAIL:-}" != link ]] ;;
  'pin tmux') [[ "${FLY2264_PHASE_FAIL:-}" != pin ]] ;;
  'list --pinned') [[ "${FLY2264_PHASE_FAIL:-}" == pinned ]] || printf 'tmux\n' ;;
  *) exit 64 ;;
esac
STUB
cat >"$TMP/cellar/tmux" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == -V ]]; then
  [[ "${FLY2264_PHASE_FAIL:-}" == version ]] && printf 'tmux 3.6\n' || printf 'tmux 3.7c\n'
  exit 0
fi
exit 64
STUB
cat >"$TMP/bin/file" <<'STUB'
#!/usr/bin/env bash
printf 'file %s\n' "$*" >>"${FLY2264_PHASE_LEDGER:?}"
[[ "${FLY2264_PHASE_FAIL:-}" == architecture ]] \
  && printf 'Mach-O 64-bit executable x86_64\n' \
  || printf 'Mach-O 64-bit executable arm64\n'
STUB
chmod +x "$TMP/bin/brew" "$TMP/bin/file" "$TMP/cellar/tmux"
ln -s "$TMP/cellar/tmux" "$TMP/bin/tmux"

make_runnable_copy() {
  [ -f "$SCRIPT" ] || return 1
  sed \
    -e "s#/opt/homebrew/bin/brew#$TMP/bin/brew#g" \
    -e "s#/opt/homebrew/bin/tmux#$TMP/bin/tmux#g" \
    -e "s#/opt/homebrew/Cellar/tmux/3.7c/bin/tmux#$TMP/cellar/tmux#g" \
    "$SCRIPT" >"$TMP/phase-b-test.sh"
  chmod +x "$TMP/phase-b-test.sh"
}

export FLY2264_PHASE_LEDGER="$TMP/ledger"
: >"$FLY2264_PHASE_LEDGER"
echo "Test: golden phase-b calls only link, pin, version, file, and pinned checks"
rc=0
if make_runnable_copy 2>/dev/null; then
  PATH="$TMP/bin:$PATH" "$TMP/phase-b-test.sh" >"$TMP/golden.out" 2>"$TMP/golden.err" || rc=$?
else
  rc=127
  : >"$TMP/golden.err"
fi
if [ "$rc" -eq 0 ] \
    && grep -qxF 'brew link tmux' "$FLY2264_PHASE_LEDGER" \
    && grep -qxF 'brew pin tmux' "$FLY2264_PHASE_LEDGER" \
    && grep -qxF 'brew list --pinned' "$FLY2264_PHASE_LEDGER" \
    && grep -qxF "file -b $TMP/cellar/tmux" "$FLY2264_PHASE_LEDGER" \
    && ! grep -Eq 'unlink|upgrade' "$FLY2264_PHASE_LEDGER"; then
  pass "golden phase-b is bounded to tmux link/pin/assertions"
else
  fail "golden phase-b rc=$rc ledger=$(tr '\n' ';' <"$FLY2264_PHASE_LEDGER" 2>/dev/null)"
fi

echo "Test: every phase-b item has a positive red control"
case_failures=0
for row in 'link brew-link' 'pin brew-pin' 'realpath realpath' 'version version' 'architecture architecture' 'pinned pinned'; do
  failure="${row%% *}"
  item="${row#* }"
  rm -f "$TMP/bin/tmux"
  if [ "$failure" = realpath ]; then
    ln -s "$TMP/bin/wrong-tmux" "$TMP/bin/tmux"
    cp "$TMP/cellar/tmux" "$TMP/bin/wrong-tmux"
  else
    ln -s "$TMP/cellar/tmux" "$TMP/bin/tmux"
  fi
  : >"$FLY2264_PHASE_LEDGER"
  rc=0
  FLY2264_PHASE_FAIL="$failure" PATH="$TMP/bin:$PATH" "$TMP/phase-b-test.sh" \
    >"$TMP/${failure}.out" 2>"$TMP/${failure}.err" || rc=$?
  if [ "$rc" -eq 0 ] || ! grep -qF "item=${item}" "$TMP/${failure}.err"; then
    printf '    failure=%s rc=%s stderr=%s\n' "$failure" "$rc" "$(tr '\n' ' ' <"$TMP/${failure}.err")"
    case_failures=$((case_failures + 1))
  fi
done
if [ "$case_failures" -eq 0 ]; then
  pass "six independent assertion failures are named and nonzero"
else
  fail "$case_failures phase-b failure controls did not turn red"
fi

if [ -f "$SCRIPT" ] && ! grep -Eq '\b(unlink|upgrade)\b' "$SCRIPT"; then
  pass "production script contains no unlink or upgrade"
else
  fail "production script contains a forbidden operation"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
