#!/usr/bin/env bash
# FLY-2274: atomic 0700 window installer and sha256 manifest contract.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ORIGINAL="$ROOT/scripts/cutover/FLY-2264"
TMP="$(mktemp -d -t fly2264-install.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }
mode_of() { /usr/bin/stat -c %a "$1" 2>/dev/null || /usr/bin/stat -f %Lp "$1"; }
digest_tree() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256); }

echo "Test: installer is absent before implementation (RED sentinel becomes executable)"
if [ -x "$ORIGINAL/install-window-artifacts.sh" ]; then
  pass "installer exists for the GREEN run"
else
  fail "installer is missing"
  printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

make_source() {
  local destination="$1"
  mkdir -p "$destination/lib"
  cp "$ORIGINAL/"*.sh "$ORIGINAL/supervisor-labels.txt" "$destination/"
  cp "$ORIGINAL/lib/"*.sh "$destination/lib/"
  chmod +x "$destination/"*.sh
}

SRC="$TMP/source"
make_source "$SRC"
INSTALLER="$SRC/install-window-artifacts.sh"
PARENT="$TMP/windows"
mkdir -p "$PARENT"
chmod 700 "$PARENT"
WINDOW_ROOT="$PARENT/FLY-2264"
WINDOW="$WINDOW_ROOT/artifacts"
mkdir -m 700 "$WINDOW_ROOT"

expected_files='bootout-supervisors.sh
generate-supervisor-labels.sh
lib/launchd-window.sh
lib/tmux-process-inventory.sh
phase-b-link.sh
restore-supervisors.sh
stop-old-tmux-servers.sh
supervisor-labels.txt
verify-native-tmux-cutover.sh'

echo "Test: a reviewed source set publishes once with private modes and a sorted relative manifest"
install_rc=0
"$INSTALLER" "$WINDOW" >"$TMP/install.out" 2>"$TMP/install.err" || install_rc=$?
actual_files="$(cd "$WINDOW" 2>/dev/null && find . -type f ! -name sha256-manifest.txt | sed 's#^./##' | LC_ALL=C sort)"
mode_ok=1
while IFS= read -r relative; do
  [ "$(mode_of "$WINDOW/$relative")" = 700 ] || mode_ok=0
done <<<"$expected_files"
manifest_paths="$(sed -n 's/^[0-9a-f]\{64\}  //p' "$WINDOW/sha256-manifest.txt" 2>/dev/null)"
if [ "$install_rc" -eq 0 ] && [ "$actual_files" = "$expected_files" ] \
    && [ "$manifest_paths" = "$expected_files" ] && [ "$mode_ok" -eq 1 ] \
    && [ "$(mode_of "$WINDOW")" = 700 ] \
    && [ "$(mode_of "$WINDOW/sha256-manifest.txt")" = 600 ] \
    && (cd "$WINDOW" && shasum -a 256 -c sha256-manifest.txt >/dev/null); then
  pass "install is complete, 0700, sorted, relative, and hash-valid"
else
  fail "positive install rc=$install_rc files=[$actual_files] manifest=[$manifest_paths] err=$(cat "$TMP/install.err")"
fi

echo "Test: installer owns only the fixed WINDOW_DIR/artifacts child"
DIRECT_ROOT="$PARENT/direct-root"
mkdir -m 700 "$DIRECT_ROOT"
direct_rc=0
"$INSTALLER" "$DIRECT_ROOT" >/dev/null 2>&1 || direct_rc=$?
if [ "$direct_rc" -ne 0 ] && [ -z "$(find "$DIRECT_ROOT" -mindepth 1 -print -quit)" ]; then
  pass "direct WINDOW_DIR publication is rejected; only artifacts is owned"
else
  fail "installer accepted the window root itself"
fi

echo "Test: reviewed bytes can be revalidated after known runtime artifacts exist"
RERUN_ROOT="$PARENT/rerun-window"
RERUN_WINDOW="$RERUN_ROOT/artifacts"
mkdir -m 700 "$RERUN_ROOT"
runtime_rc=0
"$INSTALLER" "$RERUN_WINDOW" >/dev/null 2>&1 || runtime_rc=$?
printf '{"schemaVersion":1,"uid":%s,"createdAt":"2026-09-02T00:00:00Z","entries":[]}\n' "$(id -u)" \
  >"$RERUN_WINDOW/supervisor-recovery.json"
printf '[]\n' >"$RERUN_WINDOW/tmux-union.json"
mkdir -m 700 "$RERUN_WINDOW/verification-artifacts"
printf '{"status":"pass"}\n' >"$RERUN_WINDOW/verification-artifacts/01-updater.json"
chmod 600 "$RERUN_WINDOW/supervisor-recovery.json" "$RERUN_WINDOW/tmux-union.json" \
  "$RERUN_WINDOW/verification-artifacts/01-updater.json"
runtime_before="$(shasum -a 256 "$RERUN_WINDOW/supervisor-recovery.json" \
  "$RERUN_WINDOW/tmux-union.json" "$RERUN_WINDOW/verification-artifacts/01-updater.json")"
"$INSTALLER" "$RERUN_WINDOW" >/dev/null 2>"$TMP/runtime-rerun.err" || runtime_rc=$?
runtime_after="$(shasum -a 256 "$RERUN_WINDOW/supervisor-recovery.json" \
  "$RERUN_WINDOW/tmux-union.json" "$RERUN_WINDOW/verification-artifacts/01-updater.json")"
if [ "$runtime_rc" -eq 0 ] && [ "$runtime_before" = "$runtime_after" ] \
    && (cd "$RERUN_WINDOW" && shasum -a 256 -c sha256-manifest.txt >/dev/null); then
  pass "idempotent install preserves and validates exact runtime outputs"
else
  fail "runtime-artifact rerun rc=$runtime_rc err=$(tr '\n' ' ' <"$TMP/runtime-rerun.err")"
fi

echo "Test: manifest positive control detects one-byte tampering"
cp "$WINDOW/phase-b-link.sh" "$TMP/phase.good"
printf '\n# tamper\n' >>"$WINDOW/phase-b-link.sh"
if (cd "$WINDOW" && shasum -a 256 -c sha256-manifest.txt >/dev/null 2>&1); then
  fail "tampered script passed the manifest"
else
  pass "one-byte-equivalent content drift turns shasum red"
fi
cp "$TMP/phase.good" "$WINDOW/phase-b-link.sh"
chmod 700 "$WINDOW/phase-b-link.sh"

echo "Test: an exact repeat is idempotent and a drifted repeat is zero-mutation"
before="$(digest_tree "$WINDOW")"
repeat_rc=0
"$INSTALLER" "$WINDOW" >"$TMP/repeat.out" 2>"$TMP/repeat.err" || repeat_rc=$?
after="$(digest_tree "$WINDOW")"
printf '\n# drift\n' >>"$WINDOW/restore-supervisors.sh"
drift_before="$(digest_tree "$WINDOW")"
drift_rc=0
"$INSTALLER" "$WINDOW" >"$TMP/drift.out" 2>"$TMP/drift.err" || drift_rc=$?
drift_after="$(digest_tree "$WINDOW")"
if [ "$repeat_rc" -eq 0 ] && [ "$before" = "$after" ] \
    && [ "$drift_rc" -ne 0 ] && [ "$drift_before" = "$drift_after" ]; then
  pass "repeat is exact-idempotent; populated drift fails before mutation"
else
  fail "repeat/drift contract repeat=$repeat_rc drift=$drift_rc"
fi

echo "Test: relative, symlink, wrong-mode, and wrong-owner destinations fail before publish"
destination_negative=1
(cd "$TMP" && "$INSTALLER" relative-window/artifacts >/dev/null 2>&1) && destination_negative=0
mkdir -m 700 "$PARENT/symlink-root"
ln -s "$WINDOW" "$PARENT/symlink-root/artifacts"
"$INSTALLER" "$PARENT/symlink-root/artifacts" >/dev/null 2>&1 && destination_negative=0
mkdir -m 700 "$PARENT/wrong-mode-root"
mkdir "$PARENT/wrong-mode-root/artifacts"
chmod 755 "$PARENT/wrong-mode-root/artifacts"
"$INSTALLER" "$PARENT/wrong-mode-root/artifacts" >/dev/null 2>&1 && destination_negative=0
[ -z "$(find "$PARENT/wrong-mode-root/artifacts" -mindepth 1 -print -quit)" ] || destination_negative=0
mkdir -m 700 "$PARENT/wrong-owner-root"
mkdir "$PARENT/wrong-owner-root/artifacts"
chmod 700 "$PARENT/wrong-owner-root/artifacts"
mkdir "$TMP/fake-bin"
cat >"$TMP/fake-bin/stat" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *'%u'*wrong-owner-root/artifacts*) printf '999999\n'; exit 0 ;;
esac
exec /usr/bin/stat "$@"
STUB
chmod +x "$TMP/fake-bin/stat"
PATH="$TMP/fake-bin:/usr/bin:/bin" "$INSTALLER" "$PARENT/wrong-owner-root/artifacts" >/dev/null 2>&1 \
  && destination_negative=0
[ -z "$(find "$PARENT/wrong-owner-root/artifacts" -mindepth 1 -print -quit)" ] || destination_negative=0
if [ "$destination_negative" -eq 1 ]; then
  pass "destination path/mode/owner guards all fail without publication"
else
  fail "destination guard matrix"
fi

echo "Test: source symlink, missing source, and stale staging collision are zero-publication failures"
source_negative=1
SRC_LINK="$TMP/source-link"
make_source "$SRC_LINK"
rm "$SRC_LINK/phase-b-link.sh"
ln -s "$ORIGINAL/phase-b-link.sh" "$SRC_LINK/phase-b-link.sh"
mkdir -m 700 "$PARENT/from-link"
"$SRC_LINK/install-window-artifacts.sh" "$PARENT/from-link/artifacts" >/dev/null 2>&1 && source_negative=0
[ ! -e "$PARENT/from-link/artifacts" ] || source_negative=0
SRC_MISSING="$TMP/source-missing"
make_source "$SRC_MISSING"
rm "$SRC_MISSING/restore-supervisors.sh"
mkdir -m 700 "$PARENT/from-missing"
"$SRC_MISSING/install-window-artifacts.sh" "$PARENT/from-missing/artifacts" >/dev/null 2>&1 && source_negative=0
[ ! -e "$PARENT/from-missing/artifacts" ] || source_negative=0
mkdir -m 700 "$PARENT/from-collision"
mkdir "$PARENT/from-collision/.fly2264-window.stale"
"$INSTALLER" "$PARENT/from-collision/artifacts" >/dev/null 2>&1 && source_negative=0
[ ! -e "$PARENT/from-collision/artifacts" ] || source_negative=0
if [ "$source_negative" -eq 1 ]; then
  pass "source integrity and staging collision guards publish nothing"
else
  fail "source/staging guard matrix"
fi

echo "Test: installer source contains no absolute source paths in the generated manifest"
if ! grep -Eq 'install-bridge-launchd|launchctl[[:space:]]+(bootout|bootstrap|kickstart)|brew[[:space:]]+(link|unlink|upgrade)' "$INSTALLER"; then
  pass "installer is byte publication only"
else
  fail "installer contains service or package mutation"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
