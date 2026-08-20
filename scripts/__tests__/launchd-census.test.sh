#!/usr/bin/env bash
# FLY-1814 D2: manifest convergence and read-only launchd fleet census.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/converge-nonlead-daemons.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/launchd-census.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '  ✓ %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '  ✗ %s\n' "$*" >&2; }

# shellcheck source=../lib/converge-nonlead-daemons.sh
source "$LIB"

write_plist() {
  local path="$1" label="$2"; shift 2
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict>'
    printf '<key>Label</key><string>%s</string>\n' "$label"
    printf '%s\n' '<key>ProgramArguments</key><array>'
    while (( $# > 0 )); do
      printf '<string>%s</string>\n' "$1"
      shift
    done
    printf '%s\n' '</array></dict></plist>'
  } > "$path"
}

expect_program() {
  local name="$1" expected_state="$2" expected_target="$3" plist="$4"
  LAUNCHD_PROGRAM_STATE=""
  LAUNCHD_PROGRAM_TARGET=""
  launchd_plist_program_target "$plist" >/dev/null 2>&1 || true
  if [[ "$LAUNCHD_PROGRAM_STATE" == "$expected_state" \
    && "$LAUNCHD_PROGRAM_TARGET" == "$expected_target" ]]; then
    pass "$name"
  else
    fail "$name (state=${LAUNCHD_PROGRAM_STATE:-<empty>} target=${LAUNCHD_PROGRAM_TARGET:-<empty>})"
  fi
}

echo "Test group: safe ProgramArguments resolver"

write_plist "$ROOT/liveness.plist" com.flywheel.bridge-liveness-probe \
  /bin/bash -c 'set -a; [ -f &quot;$HOME/.flywheel/.env&quot; ] &amp;&amp; . &quot;$HOME/.flywheel/.env&quot;; set +a; exec /Users/xiaorongli/Dev/flywheel/scripts/bridge-liveness-probe.sh'
expect_program "the exact liveness inline command resolves its final safe exec target" \
  resolved /Users/xiaorongli/Dev/flywheel/scripts/bridge-liveness-probe.sh "$ROOT/liveness.plist"

write_plist "$ROOT/tilde.plist" com.flywheel.skills-update \
  /bin/bash -c '~/.flywheel/bin/skills-sync.sh'
expect_program "a whole shell command beginning with literal ~/ resolves only that token" \
  resolved "$HOME/.flywheel/bin/skills-sync.sh" "$ROOT/tilde.plist"

write_plist "$ROOT/qa528.plist" com.xiaohongshu-deep-learning.qa528 \
  /bin/bash /var/folders/fixture/missing-qa528-scheduled.sh
expect_program "a direct absolute shell script resolves for zombie detection" \
  resolved /var/folders/fixture/missing-qa528-scheduled.sh "$ROOT/qa528.plist"

_cnd_plutil() { return 127; }
expect_program "the production resolver falls back safely when plutil is unavailable" \
  resolved /var/folders/fixture/missing-qa528-scheduled.sh "$ROOT/qa528.plist"
_cnd_plutil() { plutil "$@"; }

write_plist "$ROOT/dynamic.plist" com.flywheel.dynamic \
  /bin/bash -c 'prep; exec $HOME/.flywheel/bin/job.sh'
expect_program "a dynamic selected token is unknown and never expanded" \
  unknown '' "$ROOT/dynamic.plist"

write_plist "$ROOT/traversal.plist" com.flywheel.traversal \
  /bin/bash /Users/xiaorongli/Dev/flywheel/scripts/../escape.sh
expect_program "a selected token containing parent traversal is unknown" \
  unknown '' "$ROOT/traversal.plist"

write_plist "$ROOT/node-c.plist" com.flywheel.node-c node -c /safe/script.js
expect_program "Node -c is not treated as shell execution" unknown '' "$ROOT/node-c.plist"

write_plist "$ROOT/python-c.plist" com.flywheel.python-c python3 -c /safe/script.py
expect_program "Python -c is not treated as shell execution" unknown '' "$ROOT/python-c.plist"

write_plist "$ROOT/ambiguous.plist" com.flywheel.ambiguous /bin/sh -c \
  'exec /safe/first.sh; exec /safe/second.sh'
expect_program "multiple safe exec targets are ambiguous" unknown '' "$ROOT/ambiguous.plist"

write_plist "$ROOT/start-ambiguous.plist" com.flywheel.start-ambiguous /bin/sh -c \
  '~/safe/first.sh; exec /safe/second.sh'
expect_program "a command-start path plus a later exec target is ambiguous" \
  unknown '' "$ROOT/start-ambiguous.plist"

write_plist "$ROOT/dynamic-suffix.plist" com.flywheel.dynamic-suffix /bin/sh -c \
  'exec /safe/script.sh$SUFFIX'
expect_program "a dynamic suffix cannot be truncated off a selected token" \
  unknown '' "$ROOT/dynamic-suffix.plist"

write_plist "$ROOT/pipeline-adjacent.plist" com.flywheel.pipeline-adjacent /bin/sh -c \
  'exec /safe/script.sh|cat'
expect_program "an adjacent pipeline cannot be truncated off a selected token" \
  unknown '' "$ROOT/pipeline-adjacent.plist"

write_plist "$ROOT/and-ambiguous.plist" com.flywheel.and-ambiguous /bin/sh -c \
  'exec /safe/first.sh &amp;&amp; exec /safe/second.sh'
expect_program "a second exec after an and-boundary is ambiguous" \
  unknown '' "$ROOT/and-ambiguous.plist"

write_plist "$ROOT/static-args.plist" com.flywheel.static-args /bin/sh -c \
  'exec /safe/script.sh --scheduled fixture-1'
expect_program "static literal arguments preserve one unambiguous selected target" \
  resolved /safe/script.sh "$ROOT/static-args.plist"

write_plist "$ROOT/spaced-pipeline.plist" com.flywheel.spaced-pipeline /bin/sh -c \
  'exec /safe/script.sh | cat'
expect_program "a spaced pipeline after an exec target is unknown" \
  unknown '' "$ROOT/spaced-pipeline.plist"

write_plist "$ROOT/and-command.plist" com.flywheel.and-command /bin/sh -c \
  'exec /safe/script.sh &amp;&amp; echo second'
expect_program "an and-command after an exec target is unknown" \
  unknown '' "$ROOT/and-command.plist"

write_plist "$ROOT/start-semicolon.plist" com.flywheel.start-semicolon /bin/sh -c \
  '/safe/script.sh; echo second'
expect_program "an additional command after a command-start target is unknown" \
  unknown '' "$ROOT/start-semicolon.plist"

write_plist "$ROOT/start-pipeline.plist" com.flywheel.start-pipeline /bin/sh -c \
  '/safe/script.sh | cat'
expect_program "a pipeline after a command-start target is unknown" \
  unknown '' "$ROOT/start-pipeline.plist"

write_plist "$ROOT/start-dynamic-arg.plist" com.flywheel.start-dynamic-arg /bin/sh -c \
  '/safe/script.sh $DYNAMIC'
expect_program "a dynamic argument after a command-start target is unknown" \
  unknown '' "$ROOT/start-dynamic-arg.plist"

write_plist "$ROOT/and-hidden-exec.plist" com.flywheel.and-hidden-exec /bin/sh -c \
  'prep &amp;&amp; exec /safe/first.sh; exec /safe/second.sh'
expect_program "exec targets across and/semicolon boundaries are ambiguous" \
  unknown '' "$ROOT/and-hidden-exec.plist"

write_plist "$ROOT/control-hidden-exec.plist" com.flywheel.control-hidden-exec /bin/sh -c \
  'if true; then exec /safe/first.sh; fi; exec /safe/second.sh'
expect_program "exec targets nested behind control words remain ambiguous" \
  unknown '' "$ROOT/control-hidden-exec.plist"

write_plist "$ROOT/executor-substring.plist" com.flywheel.executor-substring /bin/sh -c \
  'run-executor-helper; exec /safe/script.sh'
expect_program "executor substrings do not count as exec tokens" \
  resolved /safe/script.sh "$ROOT/executor-substring.plist"

write_plist "$ROOT/quoted-exec.plist" com.flywheel.quoted-exec /bin/sh -c \
  '&quot;exec&quot; /safe/first.sh; exec /safe/second.sh'
expect_program "a quoted exec command word still makes a second target ambiguous" \
  unknown '' "$ROOT/quoted-exec.plist"

write_plist "$ROOT/escaped-exec.plist" com.flywheel.escaped-exec /bin/sh -c \
  '\exec /safe/first.sh; exec /safe/second.sh'
expect_program "an escaped exec command word still makes a second target ambiguous" \
  unknown '' "$ROOT/escaped-exec.plist"

write_plist "$ROOT/split-quoted-exec.plist" com.flywheel.split-quoted-exec /bin/sh -c \
  'e&quot;xe&quot;c /safe/first.sh; exec /safe/second.sh'
expect_program "a split-quoted exec command word fails closed as ambiguous" \
  unknown '' "$ROOT/split-quoted-exec.plist"

write_plist "$ROOT/ansi-c-exec.plist" com.flywheel.ansi-c-exec /bin/sh -c \
  "\$'exec' /safe/first.sh; exec /safe/second.sh"
expect_program "an ANSI-C quoted exec command makes target selection unknown" \
  unknown '' "$ROOT/ansi-c-exec.plist"

write_plist "$ROOT/ansi-c-split-exec.plist" com.flywheel.ansi-c-split-exec /bin/sh -c \
  "e\$'xe'c /safe/first.sh; exec /safe/second.sh"
expect_program "an ANSI-C split-quoted exec command makes target selection unknown" \
  unknown '' "$ROOT/ansi-c-split-exec.plist"

write_plist "$ROOT/locale-exec.plist" com.flywheel.locale-exec /bin/sh -c \
  '$&quot;exec&quot; /safe/first.sh; exec /safe/second.sh'
expect_program "a locale-quoted exec command makes target selection unknown" \
  unknown '' "$ROOT/locale-exec.plist"

write_plist "$ROOT/dynamic-command.plist" com.flywheel.dynamic-command /bin/sh -c \
  'x=exec; $x /safe/first.sh; exec /safe/second.sh'
expect_program "an unquoted parameter-expanded command word is unknown" \
  unknown '' "$ROOT/dynamic-command.plist"

write_plist "$ROOT/quoted-dynamic-command.plist" com.flywheel.quoted-dynamic-command /bin/sh -c \
  'x=exec; &quot;$x&quot; /safe/first.sh; exec /safe/second.sh'
expect_program "a quoted parameter-expanded command word is unknown" \
  unknown '' "$ROOT/quoted-dynamic-command.plist"

write_plist "$ROOT/braced-dynamic-command.plist" com.flywheel.braced-dynamic-command /bin/sh -c \
  'x=exec; ${x} /safe/first.sh; exec /safe/second.sh'
expect_program "a braced parameter-expanded command word is unknown" \
  unknown '' "$ROOT/braced-dynamic-command.plist"

write_plist "$ROOT/substitution-command.plist" com.flywheel.substitution-command /bin/sh -c \
  '$(printf ex%s ec) /safe/first.sh; exec /safe/second.sh'
expect_program "a command-substitution command word is unknown" \
  unknown '' "$ROOT/substitution-command.plist"

write_plist "$ROOT/backtick-command.plist" com.flywheel.backtick-command /bin/sh -c \
  '`printf ex%s ec` /safe/first.sh; exec /safe/second.sh'
expect_program "a backtick-substitution command word is unknown" \
  unknown '' "$ROOT/backtick-command.plist"

write_plist "$ROOT/dynamic-argument-control.plist" com.flywheel.dynamic-argument-control /bin/sh -c \
  'prep &quot;$HOME/safe&quot;; exec /safe/script.sh'
expect_program "parameter expansion in an ordinary argument remains applicable" \
  resolved /safe/script.sh "$ROOT/dynamic-argument-control.plist"

write_plist "$ROOT/command-forwarding.plist" com.flywheel.command-forwarding /bin/sh -c \
  'x=exec; command &quot;$x&quot; /safe/first.sh; exec /safe/second.sh'
expect_program "the command builtin cannot hide a dynamic command target" \
  unknown '' "$ROOT/command-forwarding.plist"

write_plist "$ROOT/builtin-forwarding.plist" com.flywheel.builtin-forwarding /bin/sh -c \
  'x=exec; builtin &quot;$x&quot; /safe/first.sh; exec /safe/second.sh'
expect_program "the builtin forwarder cannot hide a dynamic command target" \
  unknown '' "$ROOT/builtin-forwarding.plist"

write_plist "$ROOT/env-forwarding.plist" com.flywheel.env-forwarding /bin/sh -c \
  'x=exec; env &quot;$x&quot; /safe/first.sh; exec /safe/second.sh'
expect_program "the env forwarder cannot hide a dynamic command target" \
  unknown '' "$ROOT/env-forwarding.plist"

write_plist "$ROOT/usr-bin-env-forwarding.plist" com.flywheel.usr-bin-env-forwarding /bin/sh -c \
  'x=exec; /usr/bin/env &quot;$x&quot; /tmp/dynamic.sh; exec /tmp/static.sh'
expect_program "a path-qualified /usr/bin/env cannot hide a dynamic command target" \
  unknown '' "$ROOT/usr-bin-env-forwarding.plist"

write_plist "$ROOT/bin-env-forwarding.plist" com.flywheel.bin-env-forwarding /bin/sh -c \
  'x=exec; /bin/env &quot;$x&quot; /tmp/dynamic.sh; exec /tmp/static.sh'
expect_program "a path-qualified /bin/env cannot hide a dynamic command target" \
  unknown '' "$ROOT/bin-env-forwarding.plist"

write_plist "$ROOT/myenv-control.plist" com.flywheel.myenv-control /bin/sh -c \
  'myenv &quot;$HOME/argument&quot;; exec /tmp/static.sh'
expect_program "a myenv command substring is not a forwarder" \
  resolved /tmp/static.sh "$ROOT/myenv-control.plist"

write_plist "$ROOT/environment-control.plist" com.flywheel.environment-control /bin/sh -c \
  'prep; /path/environment &quot;$HOME/argument&quot;; exec /tmp/static.sh'
expect_program "an environment path substring is not a forwarder" \
  resolved /tmp/static.sh "$ROOT/environment-control.plist"

write_plist "$ROOT/eval-forwarding.plist" com.flywheel.eval-forwarding /bin/sh -c \
  'x=exec; eval &quot;$x /safe/first.sh&quot;; exec /safe/second.sh'
expect_program "eval cannot hide a dynamic command target" \
  unknown '' "$ROOT/eval-forwarding.plist"

write_plist "$ROOT/redirect-dynamic-command.plist" com.flywheel.redirect-dynamic-command /bin/sh -c \
  'x=exec; &gt;/dev/null $x /safe/first.sh; exec /safe/second.sh'
expect_program "a leading redirection cannot hide a dynamic command word" \
  unknown '' "$ROOT/redirect-dynamic-command.plist"

write_plist "$ROOT/fd-redirect-dynamic-command.plist" com.flywheel.fd-redirect-dynamic-command /bin/sh -c \
  'x=exec; 2&gt;/dev/null $x /safe/first.sh; exec /safe/second.sh'
expect_program "an fd-prefixed redirection cannot hide a dynamic command word" \
  unknown '' "$ROOT/fd-redirect-dynamic-command.plist"

write_plist "$ROOT/spaced-redirect-dynamic-command.plist" com.flywheel.spaced-redirect-dynamic-command /bin/sh -c \
  'x=exec; &gt; /dev/null $x /safe/first.sh; exec /safe/second.sh'
expect_program "a spaced redirection cannot hide a dynamic command word" \
  unknown '' "$ROOT/spaced-redirect-dynamic-command.plist"

write_plist "$ROOT/quoted-redirect-control.plist" com.flywheel.quoted-redirect-control /bin/sh -c \
  'prep &quot;&gt;&quot;; exec /safe/script.sh'
expect_program "a quoted greater-than argument is not redirection syntax" \
  resolved /safe/script.sh "$ROOT/quoted-redirect-control.plist"

write_plist "$ROOT/program.plist" com.flywheel.program /bin/bash /safe/script.sh
python3 - "$ROOT/program.plist" <<'PY'
import plistlib
import sys
path = sys.argv[1]
with open(path, "rb") as handle:
    data = plistlib.load(handle)
data["Program"] = "/bin/false"
with open(path, "wb") as handle:
    plistlib.dump(data, handle, sort_keys=False)
PY
expect_program "Program conflicts fail closed instead of selecting ProgramArguments" \
  unknown '' "$ROOT/program.plist"

write_plist "$ROOT/bundle-program.plist" com.flywheel.bundle /bin/bash /safe/script.sh
python3 - "$ROOT/bundle-program.plist" <<'PY'
import plistlib
import sys
path = sys.argv[1]
with open(path, "rb") as handle:
    data = plistlib.load(handle)
data["BundleProgram"] = "Contents/MacOS/job"
with open(path, "wb") as handle:
    plistlib.dump(data, handle, sort_keys=False)
PY
expect_program "BundleProgram conflicts also fail closed" unknown '' "$ROOT/bundle-program.plist"

echo "Test group: manifest-driven forward convergence"

AGENTS="$ROOT/LaunchAgents"
REPO_LAUNCHD="$ROOT/repo-launchd"
MANIFEST="$REPO_LAUNCHD/units.manifest"
DOMAIN_FILE="$ROOT/domain"
DISABLED_FILE="$ROOT/disabled"
BOOTSTRAP_LOG="$ROOT/bootstrap.log"
LIST_FILE="$ROOT/list"
LIST_RC=0
LIST_RAW_OVERRIDE=""
DISABLED_RC=0
CND_TEST_CANDIDATES=""
_cnd_launch_agents_dir() { printf '%s\n' "$AGENTS"; }
_cnd_repo_launchd_dir() { printf '%s\n' "$REPO_LAUNCHD"; }
_cnd_units_manifest() { printf '%s\n' "$MANIFEST"; }
_cnd_domain() { printf '%s\n' 'gui/501'; }

_cnd_launchctl() {
  local label=""
  case "$1" in
    print-disabled)
      cat "$DISABLED_FILE"
      return "$DISABLED_RC"
      ;;
    print)
      label="${2##*/}"
      if grep -Fxq "$label" "$DOMAIN_FILE" 2>/dev/null; then
        return 0
      fi
      printf 'Bad request.\nCould not find service "%s" in domain for user gui: 501\n' "$label" >&2
      return 113
      ;;
    bootstrap)
      label="$(nonlead_daemon_plist_label "$3" 2>/dev/null || true)"
      printf '%s\n' "$label" >> "$BOOTSTRAP_LOG"
      printf '%s\n' "$label" >> "$DOMAIN_FILE"
      ;;
    list)
      if [[ -n "$LIST_RAW_OVERRIDE" ]]; then
        printf '%s' "$LIST_RAW_OVERRIDE"
        return "$LIST_RC"
      fi
      if [[ -s "$LIST_FILE" ]]; then
        cat "$LIST_FILE"
        return "$LIST_RC"
      fi
      printf '%s\n' 'PID Status Label'
      while IFS= read -r label; do
        [[ -n "$label" ]] && printf '123\t0\t%s\n' "$label"
      done < "$DOMAIN_FILE"
      return "$LIST_RC"
      ;;
    *) return 1 ;;
  esac
}

_cnd_collect_lead_candidates() {
  local out_file="$1"
  printf '%s' "$CND_TEST_CANDIDATES" > "$out_file"
}

reset_convergence_world() {
  rm -rf "$AGENTS" "$REPO_LAUNCHD"
  mkdir -p "$AGENTS" "$REPO_LAUNCHD"
  : > "$DOMAIN_FILE"
  : > "$BOOTSTRAP_LOG"
  : > "$LIST_FILE"
  LIST_RC=0
  LIST_RAW_OVERRIDE=""
  DISABLED_RC=0
  CND_TEST_CANDIDATES=""
  cat > "$DISABLED_FILE" <<'EOF'
disabled services = {
}
EOF
  cat > "$MANIFEST" <<'EOF'
# host-prefix: /fixture/repo/
# census-scope: com.flywheel.
# census-scope: com.xiaohongshu
EOF
  NONLEAD_DAEMON_CONVERGE_STATE=""
  NONLEAD_DAEMON_CONVERGE_DETAIL=""
  LAUNCHD_CENSUS_STATE=""
  LAUNCHD_CENSUS_SUMMARY=""
  LAUNCHD_CENSUS_DETAIL=""
  LAUNCHD_CENSUS_ALERT_KEY=""
  LAUNCHD_CENSUS_ANOMALY=0
}

append_manifest() {
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >> "$MANIFEST"
}

disable_label() {
  local label="$1" temp="$ROOT/disabled.next"
  sed '$d' "$DISABLED_FILE" > "$temp"
  printf '    "%s" => disabled\n}\n' "$label" >> "$temp"
  mv "$temp" "$DISABLED_FILE"
}

make_repo_plist() {
  local label="$1" source="$2" target="$3"
  write_plist "$REPO_LAUNCHD/$source" "$label" /bin/bash "$target"
}

write_runtime_manifest_case() {
  local kind="$1" path="$2"
  case "$kind" in
    duplicate-header)
      printf '%s\n' '# host-prefix: /fixture/repo/' '# host-prefix: /fixture/repo/' \
        '# census-scope: com.flywheel.' > "$path"
      ;;
    duplicate-scope)
      printf '%s\n' '# host-prefix: /fixture/repo/' '# census-scope: com.flywheel.' \
        '# census-scope: com.flywheel.' > "$path"
      ;;
    malformed-header)
      printf '%s\n' '# host-prefix /fixture/repo/' '# census-scope: com.flywheel.' > "$path"
      ;;
    *)
      printf '%s\n' '# host-prefix: /fixture/repo/' '# census-scope: com.flywheel.' > "$path"
      ;;
  esac
  case "$kind" in
    field-underflow) printf 'com.flywheel.one\t-\tsetup\t0\n' >> "$path" ;;
    field-overflow) printf 'com.flywheel.one\t-\tsetup\t0\tnote\textra\n' >> "$path" ;;
    empty-required) printf 'com.flywheel.one\t-\tsetup\t0\t\n' >> "$path" ;;
    duplicate-label)
      printf 'com.flywheel.one\t-\tsetup\t0\tone\n' >> "$path"
      printf 'com.flywheel.one\tother.plist\tcopy\t0\ttwo\n' >> "$path"
      ;;
    duplicate-source)
      printf 'com.flywheel.one\tshared.plist\tcopy\t0\tone\n' >> "$path"
      printf 'com.flywheel.two\tshared.plist\tcopy\t0\ttwo\n' >> "$path"
      ;;
    unknown-policy) printf 'com.flywheel.one\t-\tsurprise\t0\tnote\n' >> "$path" ;;
    malformed-exits) printf 'com.flywheel.one\t-\tsetup\t0,nope\tnote\n' >> "$path" ;;
    *) printf 'com.flywheel.one\t-\tsetup\t0\tnote\n' >> "$path" ;;
  esac
}

expect_runtime_manifest_reject() {
  local kind="$1" expected="$2" path=""
  path="$ROOT/runtime-manifest-${kind}"
  write_runtime_manifest_case "$kind" "$path"
  if _cnd_load_manifest "$path" >/dev/null 2>&1; then
    fail "runtime manifest parser accepted $kind"
  elif [[ "${_CND_MANIFEST_ERROR:-}" == *"$expected"* ]]; then
    pass "runtime manifest parser rejects $kind"
  else
    fail "runtime manifest parser rejected $kind without expected detail: ${_CND_MANIFEST_ERROR:-<empty>}"
  fi
}

echo "Test group: production manifest parser fail-closed matrix"
runtime_valid="$ROOT/runtime-manifest-valid"
write_runtime_manifest_case valid "$runtime_valid"
if _cnd_load_manifest "$runtime_valid" >/dev/null 2>&1; then
  pass "runtime manifest parser accepts an exact five-field baseline"
else
  fail "runtime manifest parser rejected valid baseline: ${_CND_MANIFEST_ERROR:-<empty>}"
fi
expect_runtime_manifest_reject field-underflow 'expected exactly 5 TSV fields'
expect_runtime_manifest_reject field-overflow 'expected exactly 5 TSV fields'
expect_runtime_manifest_reject empty-required 'empty field'
expect_runtime_manifest_reject duplicate-label 'duplicate label'
expect_runtime_manifest_reject duplicate-source 'duplicate source'
expect_runtime_manifest_reject duplicate-header 'invalid host-prefix'
expect_runtime_manifest_reject duplicate-scope 'duplicate census-scope'
expect_runtime_manifest_reject malformed-header 'malformed header'
expect_runtime_manifest_reject unknown-policy 'unknown policy'
expect_runtime_manifest_reject malformed-exits 'invalid allowed exits'

reset_convergence_world
target="$ROOT/copy-job.sh"
printf '#!/bin/bash\n' > "$target"
make_repo_plist com.flywheel.copy-job com.flywheel.copy-job.plist "$target"
append_manifest com.flywheel.copy-job com.flywheel.copy-job.plist copy 0 'copy fixture'
converge_nonlead_daemons >/dev/null 2>&1
installed="$AGENTS/com.flywheel.copy-job.plist"
mode="$(stat -c '%a' "$installed" 2>/dev/null || stat -f '%Lp' "$installed" 2>/dev/null || true)"
if [[ -f "$installed" && ! -L "$installed" && "$mode" == 644 ]] \
  && grep -Fxq com.flywheel.copy-job "$BOOTSTRAP_LOG" \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == healthy ]]; then
  pass "never-installed copy is atomically installed mode 0644 and bootstrapped"
else
  fail "never-installed copy did not converge (mode=$mode state=$NONLEAD_DAEMON_CONVERGE_STATE detail=$NONLEAD_DAEMON_CONVERGE_DETAIL)"
fi

reset_convergence_world
target="$ROOT/staged-missing-target.sh"
source_plist="$REPO_LAUNCHD/com.flywheel.staged-missing.plist"
destination_plist="$AGENTS/com.flywheel.staged-missing.plist"
make_repo_plist com.flywheel.staged-missing com.flywheel.staged-missing.plist "$target"
if ! _cnd_install_plist "$source_plist" "$destination_plist" com.flywheel.staged-missing \
  && [[ ! -e "$destination_plist" ]]; then
  pass "atomic install validates the staged resolver target before publication"
else
  fail "atomic install published a staged plist with a missing target"
fi

reset_convergence_world
target="$ROOT/concurrent-install.sh"; printf '#!/bin/bash\n' > "$target"
source_plist="$REPO_LAUNCHD/com.flywheel.concurrent-install.plist"
destination_plist="$AGENTS/com.flywheel.concurrent-install.plist"
make_repo_plist com.flywheel.concurrent-install com.flywheel.concurrent-install.plist "$target"
ln() {
  printf 'operator concurrent file\n' > "$2"
  command ln "$@"
}
install_rc=0
_cnd_install_plist "$source_plist" "$destination_plist" com.flywheel.concurrent-install \
  || install_rc=$?
unset -f ln
if [[ "$install_rc" -ne 0 ]] \
  && [[ "$(cat "$destination_plist" 2>/dev/null || true)" == 'operator concurrent file' ]]; then
  pass "atomic install never overwrites a concurrently-created destination"
else
  fail "atomic install clobbered concurrent destination (rc=$install_rc)"
fi

reset_convergence_world
target="$ROOT/installed-valid-copy.sh"; printf '#!/bin/bash\n' > "$target"
make_repo_plist com.flywheel.installed-valid-copy com.flywheel.installed-valid-copy.plist "$target"
cp "$REPO_LAUNCHD/com.flywheel.installed-valid-copy.plist" \
  "$AGENTS/com.flywheel.installed-valid-copy.plist"
append_manifest com.flywheel.installed-valid-copy \
  com.flywheel.installed-valid-copy.plist copy 0 'installed valid copy fixture'
converge_nonlead_daemons >/dev/null 2>&1
if grep -Fxq com.flywheel.installed-valid-copy "$BOOTSTRAP_LOG" \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == healthy ]]; then
  pass "an identical installed copy with a valid target bootstraps when unloaded"
else
  fail "valid installed copy did not bootstrap: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
write_plist "$REPO_LAUNCHD/com.flywheel.installed-unknown-copy.plist" \
  com.flywheel.installed-unknown-copy /bin/bash -c 'exec $HOME/dynamic-copy.sh'
cp "$REPO_LAUNCHD/com.flywheel.installed-unknown-copy.plist" \
  "$AGENTS/com.flywheel.installed-unknown-copy.plist"
append_manifest com.flywheel.installed-unknown-copy \
  com.flywheel.installed-unknown-copy.plist copy 0 'installed unknown copy fixture'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" && "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'installed-unknown-copy'* ]]; then
  pass "an installed copy with unknown ProgramArguments never bootstraps"
else
  fail "installed unknown copy bootstrapped or stayed healthy: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
target="$ROOT/installed-missing-target.sh"
make_repo_plist com.flywheel.installed-missing-target \
  com.flywheel.installed-missing-target.plist "$target"
cp "$REPO_LAUNCHD/com.flywheel.installed-missing-target.plist" \
  "$AGENTS/com.flywheel.installed-missing-target.plist"
append_manifest com.flywheel.installed-missing-target \
  com.flywheel.installed-missing-target.plist copy 0 'installed missing target fixture'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" && "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'installed-missing-target'* ]]; then
  pass "an installed copy with a missing resolved target never bootstraps"
else
  fail "installed missing-target copy bootstrapped or stayed healthy: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
target="$ROOT/disabled-job.sh"
printf '#!/bin/bash\n' > "$target"
make_repo_plist com.flywheel.disabled-job com.flywheel.disabled-job.plist "$target"
append_manifest com.flywheel.disabled-job com.flywheel.disabled-job.plist copy 0 'disabled fixture'
disable_label com.flywheel.disabled-job
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -e "$AGENTS/com.flywheel.disabled-job.plist" && ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == healthy ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'skipped_disabled=1'* ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'com.flywheel.disabled-job'* ]]; then
  pass "a missing disabled copy stays absent and is named without degrading"
else
  fail "disabled copy was hidden or mutated: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
target="$ROOT/hold-job.sh"
printf '#!/bin/bash\n' > "$target"
make_repo_plist com.flywheel.hold-job com.flywheel.hold-job.plist "$target"
append_manifest com.flywheel.hold-job com.flywheel.hold-job.plist hold 0 'hold fixture'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -e "$AGENTS/com.flywheel.hold-job.plist" && ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == healthy ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'hold=1'* ]]; then
  pass "hold is counted but never installed or bootstrapped"
else
  fail "hold policy mutated or degraded: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
append_manifest com.flywheel.setup-job - setup 0 'setup fixture'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" && "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'needs_setup=1'* ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'com.flywheel.setup-job'* ]]; then
  pass "missing setup unit is named as needs-setup and never copied"
else
  fail "missing setup policy result wrong: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
write_plist "$AGENTS/com.flywheel.managed-job.plist" com.flywheel.managed-job /bin/bash "$ROOT/managed.sh"
printf '%s\n' com.flywheel.managed-job > "$DOMAIN_FILE"
append_manifest com.flywheel.managed-job - managed 0 'managed fixture'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" && "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'managed_loaded=1'* ]]; then
  pass "managed loaded is an anomaly and convergence never mutates it"
else
  fail "managed policy result wrong: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
target="$ROOT/managed-disabled.sh"; printf '#!/bin/bash\n' > "$target"
write_plist "$AGENTS/com.flywheel.voice-bridge.plist" \
  com.flywheel.voice-bridge /bin/bash "$target"
printf '%s\n' com.flywheel.voice-bridge > "$DOMAIN_FILE"
append_manifest com.flywheel.voice-bridge - managed 0 'disabled managed fixture'
disable_label com.flywheel.voice-bridge
converge_nonlead_daemons >/dev/null 2>&1
converge_state="$NONLEAD_DAEMON_CONVERGE_STATE"
converge_detail="$NONLEAD_DAEMON_CONVERGE_DETAIL"
census_launchd_fleet >/dev/null 2>&1
if [[ "$converge_state" == degraded && "$converge_detail" == *'managed_loaded=1'* ]] \
  && [[ "$LAUNCHD_CENSUS_STATE" == degraded ]] \
  && [[ " $LAUNCHD_CENSUS_SUMMARY " == *' managed_loaded=1 '* ]] \
  && [[ " $LAUNCHD_CENSUS_SUMMARY " == *' skipped_disabled=1 '* ]] \
  && [[ ! -s "$BOOTSTRAP_LOG" ]]; then
  pass "disabled managed jobs remain visible as managed_loaded without mutation"
else
  fail "disabled managed job was hidden: $converge_state / $converge_detail / $LAUNCHD_CENSUS_SUMMARY"
fi

reset_convergence_world
write_plist "$AGENTS/com.flywheel.legacy.plist" com.flywheel.legacy /bin/bash "$ROOT/legacy.sh"
MANIFEST="$ROOT/missing-units.manifest"
converge_nonlead_daemons >/dev/null 2>&1
if grep -Fxq com.flywheel.legacy "$BOOTSTRAP_LOG" \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'units manifest unreadable'* ]]; then
  pass "unreadable manifest degrades explicitly while v1 installed-disk convergence survives"
else
  fail "manifest failure erased v1 behavior: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

for malformed_kind in policy exits; do
  reset_convergence_world
  if [[ "$malformed_kind" == policy ]]; then
    append_manifest com.flywheel.bad - surprise 0 'bad policy'
  else
    append_manifest com.flywheel.bad - setup '0,nope' 'bad exits'
  fi
  converge_nonlead_daemons >/dev/null 2>&1
  if [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
    && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'units manifest malformed'* ]]; then
    pass "unknown manifest $malformed_kind fails closed"
  else
    fail "unknown manifest $malformed_kind was accepted: $NONLEAD_DAEMON_CONVERGE_DETAIL"
  fi
done

reset_convergence_world
write_plist "$REPO_LAUNCHD/com.flywheel.dynamic-copy.plist" \
  com.flywheel.dynamic-copy /bin/bash -c 'exec $HOME/dynamic-copy.sh'
append_manifest com.flywheel.dynamic-copy com.flywheel.dynamic-copy.plist copy 0 'dynamic copy fixture'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -e "$AGENTS/com.flywheel.dynamic-copy.plist" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'com.flywheel.dynamic-copy(program target unknown)'* ]]; then
  pass "copy install fails closed when the selected ProgramArguments target is unknown"
else
  fail "dynamic copy target was installed or hidden: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
target="$ROOT/suffix-copy.sh"; printf '#!/bin/bash\n' > "$target"
write_plist "$REPO_LAUNCHD/com.flywheel.suffix-copy.plist" \
  com.flywheel.suffix-copy /bin/bash -c "exec ${target} \$DYNAMIC"
append_manifest com.flywheel.suffix-copy com.flywheel.suffix-copy.plist copy 0 'suffix copy fixture'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -e "$AGENTS/com.flywheel.suffix-copy.plist" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'com.flywheel.suffix-copy(program target unknown)'* ]]; then
  pass "copy install refuses a safe target followed by a dynamic argument"
else
  fail "dynamic-suffix copy was installed or hidden: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
write_plist "$AGENTS/com.flywheel.staged-job-staged.plist" \
  com.flywheel.staged-job /bin/bash "$ROOT/staged-job.sh"
append_manifest com.flywheel.staged-job - setup 0 'staged setup fixture'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" && "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'needs_setup: com.flywheel.staged-job'* ]]; then
  pass "a staged plist declaring the manifest Label is ignored and never bootstrapped"
else
  fail "staged plist counted as installed: $NONLEAD_DAEMON_CONVERGE_DETAIL / $(cat "$BOOTSTRAP_LOG")"
fi

reset_convergence_world
target="$ROOT/drift-converge.sh"; printf '#!/bin/bash\n' > "$target"
make_repo_plist com.flywheel.drift-converge com.flywheel.drift-converge.plist "$target"
cp "$REPO_LAUNCHD/com.flywheel.drift-converge.plist" "$AGENTS/com.flywheel.drift-converge.plist"
printf '\n<!-- operator byte -->\n' >> "$AGENTS/com.flywheel.drift-converge.plist"
append_manifest com.flywheel.drift-converge com.flywheel.drift-converge.plist copy 0 'drift convergence fixture'
before_drift="$(shasum -a 256 "$AGENTS/com.flywheel.drift-converge.plist" | awk '{print $1}')"
converge_nonlead_daemons >/dev/null 2>&1
after_drift="$(shasum -a 256 "$AGENTS/com.flywheel.drift-converge.plist" | awk '{print $1}')"
if [[ "$before_drift" == "$after_drift" && "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'drift=1'* ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'drift: com.flywheel.drift-converge'* ]] \
  && grep -Fxq com.flywheel.drift-converge "$BOOTSTRAP_LOG"; then
  pass "safe installed byte drift is named, preserved, and bootstrapped when unloaded"
else
  fail "safe drift convergence overwrote, failed to bootstrap, or hid installed bytes: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
target="$ROOT/drift-unsafe-source.sh"; printf '#!/bin/bash\n' > "$target"
make_repo_plist com.flywheel.drift-unsafe com.flywheel.drift-unsafe.plist "$target"
write_plist "$AGENTS/com.flywheel.drift-unsafe.plist" \
  com.flywheel.drift-unsafe /bin/bash -c 'exec $HOME/dynamic-target.sh'
append_manifest com.flywheel.drift-unsafe com.flywheel.drift-unsafe.plist copy 0 'unsafe installed drift fixture'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" && "$NONLEAD_DAEMON_CONVERGE_STATE" == degraded ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *'com.flywheel.drift-unsafe(installed program target unknown)'* ]]; then
  pass "unsafe installed drift remains fail-closed and is never bootstrapped"
else
  fail "unsafe installed drift bootstrapped or hid resolver failure: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

reset_convergence_world
target="$ROOT/external-converge.sh"; printf '#!/bin/bash\n' > "$target"
write_plist "$AGENTS/com.flywheel.external-converge.plist" \
  com.flywheel.external-converge /bin/bash "$target"
append_manifest com.flywheel.external-converge - external '*' 'informational-only external convergence fixture'
converge_nonlead_daemons >/dev/null 2>&1
if grep -Fxq com.flywheel.external-converge "$BOOTSTRAP_LOG" \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == healthy ]]; then
  pass "installed enabled external unit is bootstrapped when missing from the domain"
else
  fail "external installed convergence failed: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

census_summary_has() {
  local needle="$1"
  [[ " ${LAUNCHD_CENSUS_SUMMARY:-} " == *" ${needle} "* \
    || "${LAUNCHD_CENSUS_SUMMARY:-}" == *"${needle}"* ]]
}

copy_repo_to_installed() {
  local label="$1" source="$2" target="$3"
  make_repo_plist "$label" "$source" "$target"
  cp "$REPO_LAUNCHD/$source" "$AGENTS/$label.plist"
  chmod 0644 "$AGENTS/$label.plist"
}

list_row() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$LIST_FILE"
}

echo "Test group: read-only bidirectional census"

reset_convergence_world
target="$ROOT/expected-job.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.expected-one com.flywheel.expected-one.plist "$target"
make_repo_plist com.flywheel.expected-two com.flywheel.expected-two.plist "$target"
append_manifest com.flywheel.expected-one com.flywheel.expected-one.plist copy 0 'loaded fixture'
append_manifest com.flywheel.expected-two com.flywheel.expected-two.plist copy 0 'unloaded fixture'
list_row 101 0 com.flywheel.expected-one
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == degraded ]] \
  && census_summary_has expected=2 && census_summary_has loaded=1 \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'expected_unloaded: com.flywheel.expected-two'* ]] \
  && [[ "$LAUNCHD_CENSUS_ALERT_KEY" == 'expected_unloaded:com.flywheel.expected-two' ]]; then
  pass "enabled manifest denominator detects an expected unloaded unit"
else
  fail "expected-unloaded census mismatch: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL / key=$LAUNCHD_CENSUS_ALERT_KEY"
fi

(
  set -e
  census_launchd_fleet >/dev/null 2>&1
)
set_e_census_rc=$?
if [[ "$set_e_census_rc" -eq 0 ]]; then
  pass "census remains auxiliary and returns zero under a set -e caller"
else
  fail "census aborted a set -e caller while building its anomaly key (rc=$set_e_census_rc)"
fi

reset_convergence_world
target="$ROOT/control-job.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.control com.flywheel.control.plist "$target"
append_manifest com.flywheel.control com.flywheel.control.plist copy 0 'control fixture'
LIST_RC=1
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == unverifiable ]] \
  && census_summary_has instrument_suspect=1 \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'expected_unloaded:'* ]]; then
  pass "launchctl list failure is instrument_suspect and suppresses absence conclusions"
else
  fail "list positive control mismatch: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
target="$ROOT/zero-control.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.zero-control com.flywheel.zero-control.plist "$target"
append_manifest com.flywheel.zero-control com.flywheel.zero-control.plist copy 0 'zero positive control'
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == unverifiable ]] \
  && census_summary_has instrument_suspect=1 \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'launchctl-list-zero-positive-control'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'expected_unloaded:'* ]]; then
  pass "enabled manifest with zero list sightings trips the positive control and suppresses absence"
else
  fail "zero-sighting positive control mismatch: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
LIST_RAW_OVERRIDE=$'PID Status Label\nthis is not a launchctl row\n'
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == unverifiable ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'launchctl-list'* ]]; then
  pass "unparseable launchctl list output is instrument_suspect"
else
  fail "unparseable list output was accepted: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
target="$ROOT/unrelated-list-label.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.unrelated-list-label \
  com.flywheel.unrelated-list-label.plist "$target"
append_manifest com.flywheel.unrelated-list-label \
  com.flywheel.unrelated-list-label.plist copy 0 'unrelated list-label fixture'
LIST_RAW_OVERRIDE=$'PID Status Label\n123 0 com.flywheel.unrelated-list-label\n- 1 homebrew.mxcl.postgresql@14\n'
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == healthy ]] \
  && census_summary_has instrument_suspect=0 \
  && census_summary_has expected=1 && census_summary_has loaded=1; then
  pass "non-owned launchctl labels outside the strict owned grammar are ignored"
else
  fail "unrelated launchctl label poisoned census: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
LIST_RAW_OVERRIDE=$'PID Status Label\n- 1 com.flywheel.bad@owned\n'
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == unverifiable ]] \
  && census_summary_has instrument_suspect=1 \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'launchctl-list'* ]]; then
  pass "malformed owned launchctl labels remain fail-closed"
else
  fail "malformed owned launchctl label was ignored: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
DISABLED_RC=1
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == unverifiable ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'print-disabled'* ]]; then
  pass "disabled parser failure is instrument_suspect"
else
  fail "disabled parser failure was accepted: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
target="$ROOT/empty-disabled-job.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.empty-disabled com.flywheel.empty-disabled.plist "$target"
append_manifest com.flywheel.empty-disabled com.flywheel.empty-disabled.plist copy 0 'empty disabled fixture'
list_row 202 0 com.flywheel.empty-disabled
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == healthy ]] \
  && census_summary_has instrument_suspect=0 && census_summary_has expected=1 \
  && census_summary_has loaded=1; then
  pass "an empty but valid disabled listing is a healthy negative control"
else
  fail "empty disabled listing treated as suspect: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
target="$ROOT/nonactionable-control.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.nonactionable-control \
  com.flywheel.nonactionable-control.plist "$target"
append_manifest com.flywheel.nonactionable-control \
  com.flywheel.nonactionable-control.plist copy 0 'nonactionable positive control'
write_plist "$AGENTS/com.flywheel.disabled-installed.plist" \
  com.flywheel.disabled-installed /bin/bash "$ROOT/missing-disabled-target.sh"
write_plist "$AGENTS/com.flywheel.hold-installed.plist" \
  com.flywheel.hold-installed /bin/bash "$ROOT/missing-hold-target.sh"
append_manifest com.flywheel.disabled-installed - setup 0 'disabled installed fixture'
append_manifest com.flywheel.hold-installed - hold 0 'hold installed fixture'
disable_label com.flywheel.disabled-installed
list_row 250 0 com.flywheel.nonactionable-control
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == healthy ]] \
  && census_summary_has skipped_disabled=1 && census_summary_has hold=1 \
  && census_summary_has zombie=0 && census_summary_has unverifiable=0; then
  pass "disabled and hold installations stay informational even with absent targets"
else
  fail "disabled/hold target state degraded census: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
target="$ROOT/positive.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.positive com.flywheel.positive.plist "$target"
append_manifest com.flywheel.positive com.flywheel.positive.plist copy 0 'positive fixture'
write_plist "$AGENTS/com.xiaohongshu-deep-learning.qa528.plist" \
  com.xiaohongshu-deep-learning.qa528 /bin/bash "$ROOT/missing-zombie.sh"
write_plist "$AGENTS/com.flywheel.unknown.plist" com.flywheel.unknown /bin/bash -c 'exec $HOME/dynamic.sh'
write_plist "$AGENTS/com.flywheel.suffix-unknown.plist" \
  com.flywheel.suffix-unknown /bin/bash -c 'exec /missing/suffix.sh $DYNAMIC'
append_manifest com.flywheel.unknown - external '*' 'informational-only unknown fixture'
append_manifest com.flywheel.suffix-unknown - external '*' 'informational-only suffix fixture'
list_row 303 0 com.flywheel.positive
list_row 304 0 com.xiaohongshu-deep-learning.qa528
list_row 305 0 com.flywheel.unknown
list_row 306 0 com.flywheel.suffix-unknown
census_launchd_fleet >/dev/null 2>&1
if census_summary_has zombie=1 && census_summary_has unverifiable=2 \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'zombie: com.xiaohongshu-deep-learning.qa528'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'com.flywheel.unknown'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'com.flywheel.suffix-unknown'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'zombie: com.flywheel.unknown'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'zombie: com.flywheel.suffix-unknown'* ]]; then
  pass "resolved missing targets are zombies while dynamic/suffixed targets are unverifiable"
else
  fail "zombie/unknown split mismatch: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
target="$ROOT/exit-job.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.daily-standup com.flywheel.daily-standup.plist "$target"
copy_repo_to_installed com.flywheel.bad-exit com.flywheel.bad-exit.plist "$target"
copy_repo_to_installed com.flywheel.active-history com.flywheel.active-history.plist "$target"
append_manifest com.flywheel.daily-standup com.flywheel.daily-standup.plist copy 0,1 'exit one allowed'
append_manifest com.flywheel.bad-exit com.flywheel.bad-exit.plist copy 0 'exit one forbidden'
append_manifest com.flywheel.active-history com.flywheel.active-history.plist copy 0 'active history ignored'
list_row - 1 com.flywheel.daily-standup
list_row - 1 com.flywheel.bad-exit
list_row 999 77 com.flywheel.active-history
census_launchd_fleet >/dev/null 2>&1
if census_summary_has live_failure=1 \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'live_failure: com.flywheel.bad-exit(exit=1)'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'daily-standup(exit=1)'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'active-history'* ]]; then
  pass "allowlisted exits and active-PID history stay healthy while a current disallowed exit alerts"
else
  fail "allowed-exit classification mismatch: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
target="$ROOT/external.sh"; printf '#!/bin/bash\n' > "$target"
write_plist "$AGENTS/com.flywheel.external.plist" com.flywheel.external /bin/bash "$target"
append_manifest com.flywheel.external - external '*' 'informational-only external fixture'
list_row - 97 com.flywheel.external
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == healthy ]] && census_summary_has live_failure=0 \
  && census_summary_has informational_exit=1 \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'informational_exit: com.flywheel.external(exit=97)'* ]]; then
  pass "external '*' exit history is named informational evidence only"
else
  fail "external '*' exit evidence mismatch: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
target="$ROOT/unmanaged.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.anchor com.flywheel.anchor.plist "$target"
append_manifest com.flywheel.anchor com.flywheel.anchor.plist copy 0 'anchor fixture'
write_plist "$AGENTS/com.flywheel.satellite-unmanaged.plist" \
  com.flywheel.satellite-unmanaged /bin/bash "$target"
list_row 401 0 com.flywheel.anchor
list_row - 88 com.flywheel.satellite-unmanaged
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == healthy ]] && census_summary_has unmanaged=1 \
  && census_summary_has live_failure=0 && census_summary_has informational_exit=1 \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'com.flywheel.satellite-unmanaged(exit=88)'* ]]; then
  pass "unmanaged satellite nonzero exits are named informational evidence"
else
  fail "unmanaged unit degraded census: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

reset_convergence_world
target="$ROOT/drift.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.drift com.flywheel.drift.plist "$target"
printf '\n<!-- operator drift -->\n' >> "$AGENTS/com.flywheel.drift.plist"
write_plist "$AGENTS/com.flywheel.managed.plist" com.flywheel.managed /bin/bash "$target"
append_manifest com.flywheel.drift com.flywheel.drift.plist copy 0 'drift fixture'
append_manifest com.flywheel.managed - managed 0 'managed fixture'
list_row 501 0 com.flywheel.drift
list_row 502 0 com.flywheel.managed
census_launchd_fleet >/dev/null 2>&1
if [[ "$LAUNCHD_CENSUS_STATE" == degraded ]] && census_summary_has drift=1 \
  && census_summary_has managed_loaded=1 \
  && [[ "$LAUNCHD_CENSUS_ALERT_KEY" == 'drift:com.flywheel.drift;managed_loaded:com.flywheel.managed' ]]; then
  pass "byte drift and a loaded managed unit produce one canonical anomaly set"
else
  fail "drift/managed anomaly mismatch: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL / key=$LAUNCHD_CENSUS_ALERT_KEY"
fi

reset_convergence_world
target="$ROOT/lead-anchor.sh"; printf '#!/bin/bash\n' > "$target"
copy_repo_to_installed com.flywheel.anchor com.flywheel.anchor.plist "$target"
append_manifest com.flywheel.anchor com.flywheel.anchor.plist copy 0 'lead positive control'
write_plist "$AGENTS/com.flywheel.lead.project-plist-only.plist" \
  com.flywheel.lead.project-plist-only /bin/bash "$target"
write_plist "$AGENTS/com.flywheel.lead.project-flywheel-test-1.plist" \
  com.flywheel.lead.project-flywheel-test-1 /bin/bash "$target"
write_plist "$AGENTS/com.flywheel.lead.project.qa529.plist" \
  com.flywheel.lead.project.qa529 /bin/bash "$target"
write_plist "$AGENTS/com.flywheel.lead.project-test-slot-3.plist" \
  com.flywheel.lead.project-test-slot-3 /bin/bash "$target"
write_plist "$AGENTS/com.flywheel.lead.project-skip-test-4.plist" \
  com.flywheel.lead.project-skip-test-4 /bin/bash "$target"
CND_TEST_CANDIDATES=$'project-primary\tproject\tprimary\t/manifest\trestart\tmanifest\nproject-manifestless\tproject\tmanifestless\t-\tmanifestless\tplist\nproject-flywheel-test-2\tproject\tflywheel-test-2\t/test\tskip-test\tmanifest\nproject-skip-class\tproject\tproduction-name\t/test\tskip-test\tmanifest\nproject.qa528\tproject\tqa528\t/manifest\trestart\tmanifest\nproject-test-slot-2\tproject\ttest-slot-2\t/manifest\trestart\tmanifest\nbad/key\tproject\tinvalid\t/manifest\trestart\tmanifest\nproject-disabled\tproject\tdisabled\t/manifest\trestart\tmanifest\n'
disable_label com.flywheel.lead.project-disabled
printf '%s\n' com.flywheel.anchor com.flywheel.lead.project-primary \
  com.flywheel.lead.project-manifestless > "$DOMAIN_FILE"
list_row 601 0 com.flywheel.anchor
list_row 602 0 com.flywheel.lead.project-primary
list_row 603 0 com.flywheel.lead.project-manifestless
census_launchd_fleet >/dev/null 2>&1
if census_summary_has lead=2/3 && census_summary_has manifestless=1 \
  && census_summary_has lead_disabled=1 \
  && census_summary_has unverifiable=1 \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'lead_unloaded: com.flywheel.lead.project-plist-only'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" == *'lead-candidate-invalid'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'flywheel-test'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'qa529'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'test-slot-3'* ]] \
  && [[ "$LAUNCHD_CENSUS_DETAIL" != *'skip-test-4'* ]]; then
  pass "Lead union fails closed on invalid primary rows and excludes QA symmetrically"
else
  fail "Lead denominator mismatch: $LAUNCHD_CENSUS_SUMMARY / $LAUNCHD_CENSUS_DETAIL"
fi

printf '\nlaunchd-census: PASSED=%d FAILED=%d\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
