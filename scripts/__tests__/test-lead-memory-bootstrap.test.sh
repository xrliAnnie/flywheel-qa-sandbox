#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOOTSTRAP="$REPO_ROOT/scripts/lead-memory/bootstrap.sh"
FIRST_IMPORT="$REPO_ROOT/scripts/lead-memory/first-import.sh"
PREFLIGHT_MIRROR="$REPO_ROOT/scripts/lead-memory/preflight-mirror.sh"
REMOTE_URL=https://github.com/xrliAnnie/lead-memory.git
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2145-bootstrap.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

PASSED=0
pass() { PASSED=$((PASSED + 1)); printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

expect_failure() {
  local label="$1" expected="$2"
  shift 2
  if "$@" </dev/null >"$TASK_TMP_DIR/stdout" 2>"$TASK_TMP_DIR/stderr"; then
    fail "$label (unexpected success)"
  fi
  grep -Fq "$expected" "$TASK_TMP_DIR/stderr" || {
    sed 's/^/  /' "$TASK_TMP_DIR/stderr" >&2
    fail "$label (missing error: $expected)"
  }
  pass "$label"
}

make_bin() {
  local bin="$1" version="${2:-8.30.1}"
  mkdir -p "$bin"
  cat >"$bin/gitleaks" <<STUB
#!/bin/sh
if [ "\${1:-}" = version ]; then printf '%s\\n' '$version'; exit 0; fi
exit 0
STUB
  cat >"$bin/gh" <<'STUB'
#!/bin/sh
case "$*" in
  *'repo view xrliAnnie/lead-memory'*) printf 'true\n'; exit 0 ;;
  *) printf 'gh stub: unexpected arguments: %s\n' "$*" >&2; exit 1 ;;
esac
STUB
  chmod +x "$bin/gitleaks" "$bin/gh"
}

make_nested_home() {
  local home="$1"
  mkdir -p "$home/.claude/agent-memory/flywheel-eng-lead"
  printf 'memory\n' >"$home/.claude/agent-memory/flywheel-eng-lead/MEMORY.md"
  git init -q -b outer "$home/.claude"
  git -C "$home/.claude" config user.name "Outer Test"
  git -C "$home/.claude" config user.email "outer@example.test"
  printf 'outer\n' >"$home/.claude/outer.txt"
  git -C "$home/.claude" add outer.txt
  git -C "$home/.claude" commit -q -m outer
}

manifest() {
  local root="$1" destination="$2"
  find "$root" -type f ! -path '*/.git/*' -print0 |
    sort -z | xargs -0 shasum -a 256 >"$destination"
}

BIN="$TASK_TMP_DIR/bin"
make_bin "$BIN"

HOME_ONE="$TASK_TMP_DIR/home-one"
make_nested_home "$HOME_ONE"
TARGET_ONE="$HOME_ONE/.claude/agent-memory"
manifest "$TARGET_ONE" "$TASK_TMP_DIR/init-files-before"
OUTER_CONFIG_BEFORE="$(shasum -a 256 "$HOME_ONE/.claude/.git/config" | awk '{print $1}')"
env HOME="$HOME_ONE" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --init
manifest "$TARGET_ONE" "$TASK_TMP_DIR/init-files-after"
cmp -s "$TASK_TMP_DIR/init-files-before" "$TASK_TMP_DIR/init-files-after" ||
  fail "init preserves every pre-existing memory byte"
pass "init preserves every pre-existing memory byte"
TARGET_ONE_PHYSICAL="$(cd "$TARGET_ONE" && pwd -P)"
test "$(git -C "$TARGET_ONE" rev-parse --show-toplevel)" = "$TARGET_ONE_PHYSICAL" ||
  fail "init creates the repository at the exact memory root"
pass "init creates the repository at the exact memory root"
test "$(git -C "$TARGET_ONE" symbolic-ref --short HEAD)" = main || fail "init selects main"
pass "init selects main"
test "$(git -C "$TARGET_ONE" config --local remote.origin.url)" = "$REMOTE_URL" ||
  fail "init stores the canonical HTTPS origin"
pass "init stores the canonical HTTPS origin"
test "$(git -C "$TARGET_ONE" config --local core.hooksPath)" = .githooks ||
  fail "init configures repository-owned hooks"
pass "init configures repository-owned hooks"
test "$(shasum -a 256 "$HOME_ONE/.claude/.git/config" | awk '{print $1}')" = "$OUTER_CONFIG_BEFORE" ||
  fail "init leaves the enclosing repository config unchanged"
pass "init leaves the enclosing repository config unchanged"
test "$(grep -c '^agent-memory/$' "$HOME_ONE/.claude/.gitignore")" = 1 ||
  fail "init adds one enclosing-repository ignore line"
pass "init adds one enclosing-repository ignore line"
env HOME="$HOME_ONE" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --init
test "$(grep -c '^agent-memory/$' "$HOME_ONE/.claude/.gitignore")" = 1 ||
  fail "repeated init does not duplicate the ignore line"
pass "repeated init is idempotent"

HOME_IGNORE_NO_NEWLINE="$TASK_TMP_DIR/home-ignore-no-newline"
make_nested_home "$HOME_IGNORE_NO_NEWLINE"
printf 'node_modules/\nsecrets.env' >"$HOME_IGNORE_NO_NEWLINE/.claude/.gitignore"
printf 'node_modules/\nsecrets.env\nagent-memory/\n' >"$TASK_TMP_DIR/expected-ignore"
env HOME="$HOME_IGNORE_NO_NEWLINE" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --init
cmp -s "$TASK_TMP_DIR/expected-ignore" "$HOME_IGNORE_NO_NEWLINE/.claude/.gitignore" ||
  fail "init preserves a newline-less final ignore rule before appending"
pass "init preserves a newline-less final ignore rule before appending"
git -C "$HOME_IGNORE_NO_NEWLINE/.claude" check-ignore -q secrets.env ||
  fail "newline-less final ignore rule remains effective"
pass "newline-less final ignore rule remains effective"
test "$(grep -c '^agent-memory/$' "$HOME_IGNORE_NO_NEWLINE/.claude/.gitignore")" = 1 ||
  fail "newline-less enclosing ignore receives one standalone memory rule"
pass "newline-less enclosing ignore receives one standalone memory rule"

HOME_BAD_VERSION="$TASK_TMP_DIR/home-bad-version"
BAD_BIN="$TASK_TMP_DIR/bin-bad-version"
make_bin "$BAD_BIN" 8.29.0
make_nested_home "$HOME_BAD_VERSION"
manifest "$HOME_BAD_VERSION/.claude" "$TASK_TMP_DIR/bad-before"
expect_failure "wrong gitleaks version fails before mutation" \
  "gitleaks 8.30.1 is required" \
  env HOME="$HOME_BAD_VERSION" PATH="$BAD_BIN:/usr/bin:/bin" "$BOOTSTRAP" --init
manifest "$HOME_BAD_VERSION/.claude" "$TASK_TMP_DIR/bad-after"
cmp -s "$TASK_TMP_DIR/bad-before" "$TASK_TMP_DIR/bad-after" ||
  fail "failed preflight leaves target and enclosing repository unchanged"
pass "failed preflight leaves target and enclosing repository unchanged"

HOME_IGNORE_LINK="$TASK_TMP_DIR/home-ignore-link"
make_nested_home "$HOME_IGNORE_LINK"
IGNORE_SENTINEL="$TASK_TMP_DIR/outside-ignore"
printf 'outside must survive\n' >"$IGNORE_SENTINEL"
ln -s "$IGNORE_SENTINEL" "$HOME_IGNORE_LINK/.claude/.gitignore"
expect_failure "symbolic-link enclosing ignore file fails before mutation" \
  "enclosing .gitignore must not be a symbolic link" \
  env HOME="$HOME_IGNORE_LINK" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --init
test "$(cat "$IGNORE_SENTINEL")" = 'outside must survive' ||
  fail "symbolic-link ignore target remains unchanged"
pass "symbolic-link ignore target remains unchanged"
test ! -e "$HOME_IGNORE_LINK/.claude/agent-memory/.git" ||
  fail "symbolic-link ignore preflight leaves the target uninitialized"
pass "symbolic-link ignore preflight leaves the target uninitialized"

HOME_FOREIGN="$TASK_TMP_DIR/home-foreign"
make_nested_home "$HOME_FOREIGN"
git init -q -b main "$HOME_FOREIGN/.claude/agent-memory"
git -C "$HOME_FOREIGN/.claude/agent-memory" remote add origin https://example.invalid/foreign.git
expect_failure "existing target repository with another origin is rejected" \
  "origin does not match" \
  env HOME="$HOME_FOREIGN" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --init

HOME_PUSHURL="$TASK_TMP_DIR/home-pushurl"
make_nested_home "$HOME_PUSHURL"
git init -q -b main "$HOME_PUSHURL/.claude/agent-memory"
git -C "$HOME_PUSHURL/.claude/agent-memory" remote add origin "$REMOTE_URL"
git config --file "$HOME_PUSHURL/.gitconfig" remote.origin.pushurl https://example.invalid/leak.git
expect_failure "existing target repository with a separate push URL is rejected" \
  "origin push URL must not be configured" \
  env HOME="$HOME_PUSHURL" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --init

HOME_GITFILE="$TASK_TMP_DIR/home-gitfile"
make_nested_home "$HOME_GITFILE"
printf 'gitdir: ../foreign.git\n' >"$HOME_GITFILE/.claude/agent-memory/.git"
expect_failure "target-owned gitfile is rejected" \
  "target .git must be a directory" \
  env HOME="$HOME_GITFILE" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --init

HOME_LINK="$TASK_TMP_DIR/home-link"
mkdir -p "$HOME_LINK/.claude/actual-memory"
ln -s actual-memory "$HOME_LINK/.claude/agent-memory"
expect_failure "symbolic-link target is rejected" \
  "target must not be a symbolic link" \
  env HOME="$HOME_LINK" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --init

expect_failure "unsupported bootstrap switch is rejected" \
  "unknown argument" \
  env HOME="$HOME_ONE" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --skip

# Build a local stand-in for the canonical private remote. Git's insteadOf
# rewrites transport only; bootstrap still stores and validates the HTTPS URL.
ORIGIN="$TASK_TMP_DIR/lead-memory.git"
SEED="$TASK_TMP_DIR/seed"
git init -q --bare --initial-branch=main "$ORIGIN"
test "$(git --git-dir="$ORIGIN" symbolic-ref HEAD)" = refs/heads/main ||
  fail "clone fixture origin must advertise main independently of host defaults"
pass "clone fixture origin advertises main"
git clone -q "$ORIGIN" "$SEED"
git -C "$SEED" checkout -q -b main
git -C "$SEED" config user.name "Seed Test"
git -C "$SEED" config user.email "seed@example.test"
printf 'remote memory\n' >"$SEED/remote.txt"
mkdir -p "$SEED/.githooks/lib"
cp "$REPO_ROOT/scripts/lead-memory/hooks/"* "$SEED/.githooks/"
cp "$REPO_ROOT/scripts/lead-memory/lib/guard.sh" "$SEED/.githooks/lib/guard.sh"
cp "$BOOTSTRAP" "$SEED/bootstrap.sh"
git -C "$SEED" add -A
git -C "$SEED" commit -q -m seed
git -C "$SEED" push -q origin main
git --git-dir="$ORIGIN" symbolic-ref HEAD refs/heads/main

configure_transport() {
  local home="$1" remote="$2"
  git config --file "$home/.gitconfig" protocol.file.allow always
  git config --file "$home/.gitconfig" url."file://$remote".insteadOf "$REMOTE_URL"
}

HOME_CLONE_UNCONFIRMED="$TASK_TMP_DIR/home-clone-unconfirmed"
make_nested_home "$HOME_CLONE_UNCONFIRMED"
configure_transport "$HOME_CLONE_UNCONFIRMED" "$ORIGIN"
printf 'newer live memory\n' >"$HOME_CLONE_UNCONFIRMED/.claude/agent-memory/newer-live.txt"
expect_failure "divergent existing memory requires explicit replacement confirmation" \
  "replacement cancelled; original directory was not changed" \
  env HOME="$HOME_CLONE_UNCONFIRMED" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --clone
grep -Fq "WARNING: existing memory differs from the repository snapshot" "$TASK_TMP_DIR/stderr" ||
  fail "unconfirmed clone prints a visible rollback warning"
pass "unconfirmed clone prints a visible rollback warning"
test -f "$HOME_CLONE_UNCONFIRMED/.claude/agent-memory/newer-live.txt" ||
  fail "unconfirmed clone preserves newer live memory"
pass "unconfirmed clone preserves newer live memory"
test -z "$(find "$HOME_CLONE_UNCONFIRMED/.claude" -maxdepth 1 \( -name 'agent-memory.clone-*' -o -name 'agent-memory.pre-clone-*' \) -print -quit)" ||
  fail "unconfirmed clone cleans temporary paths without creating a backup"
pass "unconfirmed clone cleans temporary paths without creating a backup"

COMPARE_FAIL_BIN="$TASK_TMP_DIR/bin-compare-fail"
make_bin "$COMPARE_FAIL_BIN"
cat >"$COMPARE_FAIL_BIN/python3" <<'STUB'
#!/bin/sh
exit 75
STUB
chmod +x "$COMPARE_FAIL_BIN/python3"
HOME_CLONE_COMPARE_FAIL="$TASK_TMP_DIR/home-clone-compare-fail"
make_nested_home "$HOME_CLONE_COMPARE_FAIL"
configure_transport "$HOME_CLONE_COMPARE_FAIL" "$ORIGIN"
printf 'newer live memory\n' >"$HOME_CLONE_COMPARE_FAIL/.claude/agent-memory/newer-live.txt"
expect_failure "snapshot comparison failure fails closed before replacement" \
  "could not compare existing memory with the repository snapshot" \
  env HOME="$HOME_CLONE_COMPARE_FAIL" PATH="$COMPARE_FAIL_BIN:/usr/bin:/bin" "$BOOTSTRAP" --clone
test -f "$HOME_CLONE_COMPARE_FAIL/.claude/agent-memory/newer-live.txt" ||
  fail "comparison failure preserves newer live memory"
pass "comparison failure preserves newer live memory"
test -z "$(find "$HOME_CLONE_COMPARE_FAIL/.claude" -maxdepth 1 \( -name 'agent-memory.clone-*' -o -name 'agent-memory.pre-clone-*' \) -print -quit)" ||
  fail "comparison failure cleans temporary paths without creating a backup"
pass "comparison failure cleans temporary paths without creating a backup"

MUTANT_BOOTSTRAP="$TASK_TMP_DIR/bootstrap-with-confirmation-neutralized.sh"
# These names are matched literally in the product source.
# shellcheck disable=SC2016
sed 's/^[[:space:]]*require_replacement_confirmation_if_divergent "$target" "$clone_dir" "$backup_dir"$/: # mutation: replacement confirmation neutralized/' \
  "$BOOTSTRAP" >"$MUTANT_BOOTSTRAP"
chmod +x "$MUTANT_BOOTSTRAP"
grep -Fxq ': # mutation: replacement confirmation neutralized' "$MUTANT_BOOTSTRAP" ||
  fail "mutation control neutralizes exactly the replacement-confirmation call"
HOME_CLONE_MUTANT="$TASK_TMP_DIR/home-clone-mutant"
make_nested_home "$HOME_CLONE_MUTANT"
configure_transport "$HOME_CLONE_MUTANT" "$ORIGIN"
printf 'newer live memory\n' >"$HOME_CLONE_MUTANT/.claude/agent-memory/newer-live.txt"
env HOME="$HOME_CLONE_MUTANT" PATH="$BIN:/usr/bin:/bin" "$MUTANT_BOOTSTRAP" --clone \
  </dev/null >"$TASK_TMP_DIR/clone-mutant-stdout" 2>"$TASK_TMP_DIR/clone-mutant-stderr"
test -f "$HOME_CLONE_MUTANT/.claude/agent-memory/remote.txt" &&
  test ! -e "$HOME_CLONE_MUTANT/.claude/agent-memory/newer-live.txt" ||
  fail "neutralized confirmation reproduces replacement by the repository snapshot"
MUTANT_BACKUP="$(find "$HOME_CLONE_MUTANT/.claude" -maxdepth 1 -type d -name 'agent-memory.pre-clone-*' -print -quit)"
test -n "$MUTANT_BACKUP" && test -f "$MUTANT_BACKUP/newer-live.txt" ||
  fail "mutation control still preserves the replaced live directory"
if grep -Fq 'WARNING: existing memory differs' "$TASK_TMP_DIR/clone-mutant-stderr"; then
  fail "neutralized confirmation must reproduce the silent replacement"
fi
pass "neutralized confirmation reproduces silent replacement while preserving the old directory"

HOME_CLONE="$TASK_TMP_DIR/home-clone"
make_nested_home "$HOME_CLONE"
configure_transport "$HOME_CLONE" "$ORIGIN"
printf 'original marker\n' >"$HOME_CLONE/.claude/agent-memory/original.txt"
printf 'REPLACE\n' |
  env HOME="$HOME_CLONE" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --clone \
    >"$TASK_TMP_DIR/clone-confirmed-stdout" 2>"$TASK_TMP_DIR/clone-confirmed-stderr"
grep -Fq "WARNING: existing memory differs from the repository snapshot" "$TASK_TMP_DIR/clone-confirmed-stderr" ||
  fail "confirmed clone warns before replacing live memory"
pass "confirmed clone warns before replacing live memory"
test -f "$HOME_CLONE/.claude/agent-memory/remote.txt" || fail "clone installs remote content"
pass "clone installs remote content"
BACKUP_ONE="$(find "$HOME_CLONE/.claude" -maxdepth 1 -type d -name 'agent-memory.pre-clone-*' -print -quit)"
test -n "$BACKUP_ONE" && test -f "$BACKUP_ONE/original.txt" ||
  fail "clone preserves the replaced directory as a timestamped backup"
pass "clone preserves the replaced directory as a timestamped backup"
grep -Fxq "lead-memory-bootstrap: cloned $HOME_CLONE/.claude/agent-memory" "$TASK_TMP_DIR/clone-confirmed-stdout" ||
  fail "confirmed clone reports the installed target"
pass "confirmed clone reports the installed target"
grep -Fxq "lead-memory-bootstrap: previous directory preserved at $BACKUP_ONE" "$TASK_TMP_DIR/clone-confirmed-stdout" ||
  fail "confirmed clone reports the exact preserved-directory path"
pass "confirmed clone reports the exact preserved-directory path"
test "$(git -C "$HOME_CLONE/.claude/agent-memory" config core.hooksPath)" = .githooks ||
  fail "clone configures repository-owned hooks"
pass "clone configures repository-owned hooks"

HOME_ABSENT="$TASK_TMP_DIR/home-absent"
mkdir -p "$HOME_ABSENT/.claude"
configure_transport "$HOME_ABSENT" "$ORIGIN"
env HOME="$HOME_ABSENT" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --clone
test -f "$HOME_ABSENT/.claude/agent-memory/remote.txt" || fail "clone fills an absent target"
pass "clone fills an absent target"

HOME_CLONE_FAIL="$TASK_TMP_DIR/home-clone-fail"
make_nested_home "$HOME_CLONE_FAIL"
configure_transport "$HOME_CLONE_FAIL" "$TASK_TMP_DIR/missing-origin.git"
printf 'must survive\n' >"$HOME_CLONE_FAIL/.claude/agent-memory/survive.txt"
expect_failure "clone transport failure leaves the original in place" \
  "clone failed" \
  env HOME="$HOME_CLONE_FAIL" PATH="$BIN:/usr/bin:/bin" "$BOOTSTRAP" --clone
test -f "$HOME_CLONE_FAIL/.claude/agent-memory/survive.txt" ||
  fail "clone failure preserves original content"
pass "clone failure preserves original content"
test -z "$(find "$HOME_CLONE_FAIL/.claude" -maxdepth 1 -name 'agent-memory.clone-*' -print -quit)" ||
  fail "clone failure cleans its temporary directory"
pass "clone failure cleans its temporary directory"

HOME_SWAP_FAIL="$TASK_TMP_DIR/home-swap-fail"
make_nested_home "$HOME_SWAP_FAIL"
configure_transport "$HOME_SWAP_FAIL" "$ORIGIN"
printf 'restore me\n' >"$HOME_SWAP_FAIL/.claude/agent-memory/restore.txt"
MV_BIN="$TASK_TMP_DIR/bin-mv"
make_bin "$MV_BIN"
cat >"$MV_BIN/mv" <<'STUB'
#!/bin/sh
count=0
if [ -f "${MV_COUNTER:?}" ]; then count=$(cat "$MV_COUNTER"); fi
count=$((count + 1))
printf '%s\n' "$count" >"$MV_COUNTER"
if [ "$count" -eq 2 ]; then exit 73; fi
exec /bin/mv "$@"
STUB
chmod +x "$MV_BIN/mv"
# The positional parameters are intentionally expanded by the child shell.
# shellcheck disable=SC2016
expect_failure "post-clone swap failure restores the original directory" \
  "swap failed; original directory restored" \
  sh -c 'printf "REPLACE\n" | env HOME="$1" PATH="$2:/usr/bin:/bin" MV_COUNTER="$3" "$4" --clone' \
    sh "$HOME_SWAP_FAIL" "$MV_BIN" "$TASK_TMP_DIR/mv-counter" "$BOOTSTRAP"
test -f "$HOME_SWAP_FAIL/.claude/agent-memory/restore.txt" ||
  fail "swap rollback restores original bytes"
pass "swap rollback restores original bytes"
test -z "$(find "$HOME_SWAP_FAIL/.claude" -maxdepth 1 \( -name 'agent-memory.clone-*' -o -name 'agent-memory.pre-clone-*' \) -print -quit)" ||
  fail "swap rollback cleans temporary and backup paths"
pass "swap rollback cleans temporary and backup paths"

# The operator-facing first import is deliberately two-phase: prepare may
# initialize and scan, but only publish may create the remote main branch.
IMPORT_ORIGIN="$TASK_TMP_DIR/import-origin.git"
git init -q --bare --initial-branch=main "$IMPORT_ORIGIN"
test "$(git --git-dir="$IMPORT_ORIGIN" symbolic-ref HEAD)" = refs/heads/main ||
  fail "first-import fixture origin must advertise main independently of host defaults"
pass "first-import fixture origin advertises main"
HOME_IMPORT="$TASK_TMP_DIR/home-import"
make_nested_home "$HOME_IMPORT"
for lead_name in cos-lead flywheel-cos-lead flywheel-eng-lead flywheel-product-lead joycon-lead ops-lead product-lead rafiki-lead reflection-lead sub-lead tidal-echo-content-lead tidal-echo-cos-lead; do
  mkdir -p "$HOME_IMPORT/.claude/agent-memory/$lead_name"
  printf '%s first\n' "$lead_name" >"$HOME_IMPORT/.claude/agent-memory/$lead_name/MEMORY.md"
  printf '%s second\n' "$lead_name" >"$HOME_IMPORT/.claude/agent-memory/$lead_name/second.md"
  printf '%s third\n' "$lead_name" >"$HOME_IMPORT/.claude/agent-memory/$lead_name/third.md"
done
configure_transport "$HOME_IMPORT" "$IMPORT_ORIGIN"
IMPORT_BIN="$TASK_TMP_DIR/import-bin"
make_bin "$IMPORT_BIN"
cat >"$IMPORT_BIN/gh" <<'STUB'
#!/bin/sh
case "$*" in
  *'repo view xrliAnnie/lead-memory --json isPrivate'*) printf 'true\n' ;;
  *'repo view xrliAnnie/lead-memory --json defaultBranchRef'*) printf 'main\n' ;;
  *'repo edit xrliAnnie/lead-memory --default-branch main'*) ;;
  *) printf 'gh stub: unexpected arguments: %s\n' "$*" >&2; exit 1 ;;
esac
STUB
cat >"$IMPORT_BIN/gitleaks" <<'STUB'
#!/bin/sh
set -eu
if [ "${1:-}" = version ]; then printf '8.30.1\n'; exit 0; fi
report=
scan_root=
previous=
for argument in "$@"; do
  if [ "$previous" = report ]; then report=$argument; previous=; continue; fi
  if [ "$previous" = root ]; then scan_root=$argument; previous=; continue; fi
  case $argument in
    --report-path) previous=report ;;
    dir) previous=root ;;
  esac
done
if [ -n "$report" ]; then
  if echo "$scan_root" | grep -q positive-controls; then
    cat >"$report" <<'JSON'
[
 {"RuleID":"github-pat","File":"github.txt","Secret":"control-github"},
 {"RuleID":"aws-access-token","File":"aws.txt","Secret":"control-aws"},
 {"RuleID":"anthropic-api-key","File":"anthropic.txt","Secret":"control-anthropic"},
 {"RuleID":"slack-bot-token","File":"slack.txt","Secret":"control-slack"},
 {"RuleID":"private-key","File":"private-key.pem","Secret":"control-private"},
 {"RuleID":"generic-api-key","File":"generic-api.txt","Secret":"control-api"},
 {"RuleID":"generic-api-key","File":"generic-secret.txt","Secret":"control-secret"},
 {"RuleID":"generic-api-key","File":"generic-token.txt","Secret":"control-token"}
]
JSON
  else
    printf '[]\n' >"$report"
  fi
fi
exit 0
STUB
cat >"$IMPORT_BIN/trufflehog" <<'STUB'
#!/bin/sh
set -eu
if [ "${1:-}" = --version ]; then printf 'trufflehog 3.97.2\n'; exit 0; fi
case ${2:-} in
  *positive-controls*)
    cat <<'JSON'
{"DetectorName":"AWS","Raw":"control-aws","SourceMetadata":{"Data":{"Filesystem":{"file":"aws.txt"}}}}
{"DetectorName":"Anthropic","Raw":"control-anthropic","SourceMetadata":{"Data":{"Filesystem":{"file":"anthropic.txt"}}}}
{"DetectorName":"Github","Raw":"control-github","SourceMetadata":{"Data":{"Filesystem":{"file":"github.txt"}}}}
{"DetectorName":"Slack","Raw":"control-slack","SourceMetadata":{"Data":{"Filesystem":{"file":"slack.txt"}}}}
JSON
    ;;
esac
STUB
chmod +x "$IMPORT_BIN/gh" "$IMPORT_BIN/gitleaks" "$IMPORT_BIN/trufflehog"

IMPORT_ENV=(
  HOME="$HOME_IMPORT"
  PATH="$IMPORT_BIN:/usr/bin:/bin"
  FLYWHEEL_STATE_DIR="$TASK_TMP_DIR/import-state"
  GIT_AUTHOR_NAME="Import Test"
  GIT_AUTHOR_EMAIL="import@example.test"
  GIT_COMMITTER_NAME="Import Test"
  GIT_COMMITTER_EMAIL="import@example.test"
)
MIRROR_TMP="$TASK_TMP_DIR/mirror-tmp"
mkdir -p "$MIRROR_TMP"
env "${IMPORT_ENV[@]}" TMPDIR="$MIRROR_TMP" FLYWHEEL_STATE_DIR="$TASK_TMP_DIR/mirror-state" \
  "$PREFLIGHT_MIRROR"
test ! -e "$HOME_IMPORT/.claude/agent-memory/.git" &&
  test ! -e "$HOME_IMPORT/.claude/agent-memory/SCAN-LEDGER.md" ||
  fail "mirror preflight leaves the live source byte shape untouched"
pass "mirror preflight never initializes or writes its live source"
test -f "$TASK_TMP_DIR/mirror-state/state/lead-memory/preflight/SCAN-LEDGER.md" ||
  fail "mirror preflight preserves its value-free ledger in private state"
pass "mirror preflight preserves a value-free private ledger"
test -z "$(find "$MIRROR_TMP" -mindepth 1 -print -quit)" ||
  fail "mirror preflight removes its sensitive temporary copy"
pass "mirror preflight removes its sensitive temporary copy"

env "${IMPORT_ENV[@]}" "$FIRST_IMPORT" --prepare
test -z "$(git --git-dir="$IMPORT_ORIGIN" for-each-ref --format='%(refname)' refs/heads/main)" ||
  fail "prepare must not create remote main"
pass "prepare initializes and scans without publishing"
git -C "$HOME_IMPORT/.claude/agent-memory" symbolic-ref HEAD refs/heads/alternate
expect_failure "publish rejects a non-main repository state before committing" \
  "repository branch must be main" \
  env "${IMPORT_ENV[@]}" "$FIRST_IMPORT" --publish
git -C "$HOME_IMPORT/.claude/agent-memory" symbolic-ref HEAD refs/heads/main
git -C "$HOME_IMPORT/.claude/agent-memory" remote set-url --push origin https://example.invalid/leak.git
expect_failure "publish rechecks and rejects an injected push URL" \
  "origin push URL must not be configured" \
  env "${IMPORT_ENV[@]}" "$FIRST_IMPORT" --publish
git -C "$HOME_IMPORT/.claude/agent-memory" config --unset-all remote.origin.pushurl
expect_failure "publish refuses incomplete manual review" \
  "manual sample review is incomplete" \
  env "${IMPORT_ENV[@]}" "$FIRST_IMPORT" --publish

IMPORT_LEDGER="$HOME_IMPORT/.claude/agent-memory/SCAN-LEDGER.md"
mkdir -p "$TASK_TMP_DIR/import-state/state/lead-memory/preflight"
awk 'BEGIN { FS="|" }
  /REVIEW_REQUIRED/ {
    path=$2; oid=$3
    gsub(/^ +| +$/, "", path); gsub(/^`|`$/, "", path)
    gsub(/^ +| +$/, "", oid); gsub(/^`|`$/, "", oid)
    printf "%s\t%s\treviewed: no credential material\tImport Reviewer\t2026-09-03\n", path, oid
  }
' "$IMPORT_LEDGER" >"$TASK_TMP_DIR/import-state/state/lead-memory/preflight/manual-review.tsv"
env "${IMPORT_ENV[@]}" "$FIRST_IMPORT" --publish >"$TASK_TMP_DIR/import-receipt-output"
IMPORT_SHA="$(git -C "$HOME_IMPORT/.claude/agent-memory" rev-parse HEAD)"
REMOTE_IMPORT_SHA="$(git --git-dir="$IMPORT_ORIGIN" rev-parse refs/heads/main)"
test "$IMPORT_SHA" = "$REMOTE_IMPORT_SHA" || fail "publish pushes the first-import commit to main"
pass "publish pushes the first-import commit to main"
test "$(git -C "$HOME_IMPORT/.claude/agent-memory" show -s --format='%(trailers:key=Memory-Owner,valueonly)' HEAD)" = admin ||
  fail "first-import commit carries the admin ownership trailer"
pass "first-import commit carries the admin ownership trailer"
test "$(git -C "$HOME_IMPORT/.claude/agent-memory" show HEAD:SCAN-LEDGER.md | grep -c 'reviewed: no credential material')" = 36 ||
  fail "publish applies all matching private review-receipt rows"
pass "publish applies blob-matched private review evidence"
test "$(git -C "$HOME_IMPORT/.claude/agent-memory" ls-tree HEAD -- .github/workflows/remote-observe.yml | awk '{print $1}')" = 100644 ||
  fail "first-import root commit does not contain remote-observe.yml"
test "$(git -C "$HOME_IMPORT/.claude/agent-memory" ls-tree HEAD -- write-memory.sh | awk '{print $1}')" = 100755 ||
  fail "first-import root commit does not contain executable write-memory.sh"
pass "first-import root commit contains the complete A2 automation surface"
grep -Fq "IMPORT_SHA=$IMPORT_SHA" "$TASK_TMP_DIR/import-receipt-output" ||
  fail "publish emits copyable before/after evidence"
pass "publish emits copyable before/after evidence"
env "${IMPORT_ENV[@]}" "$FIRST_IMPORT" --publish >"$TASK_TMP_DIR/import-idempotent-output"
test "$(git --git-dir="$IMPORT_ORIGIN" rev-list --count refs/heads/main)" = 1 ||
  fail "repeated publish must not create another first-import commit"
pass "repeated publish is idempotent at the imported root commit"

printf 'RESULTS: %d passed\n' "$PASSED"
