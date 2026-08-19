#!/usr/bin/env bash
# FLY-1830: contract suite for the non-Lead launchd daemon convergence.
set -uo pipefail

ROOT="$(mktemp -d)"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/converge-nonlead-daemons.sh"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$*" >&2; }

if [[ ! -r "$LIB" ]]; then
  printf 'RED: missing %s\n' "$LIB" >&2
  exit 1
fi
# shellcheck source=../lib/converge-nonlead-daemons.sh
source "$LIB"

# This suite exercises launchd reconciliation, not machine-global Codex guard
# installation. Keep both layers hermetic: explicit roots are a fail-safe if
# the seam is accidentally removed, while the stub avoids repeating a real
# install for every launchd fixture. The guard's real same-SHA convergence is
# covered by codex-guard.test.sh against its own temporary HOME.
export HOME="$ROOT/home"
export FLYWHEEL_CODEX_GLOBAL_BIN_DIR="$ROOT/codex-global-bin"
export FLYWHEEL_CODEX_GUARD_INSTALL_ROOT="$ROOT/codex-guard-install"
mkdir -p "$HOME"
CODEX_GUARD_CONVERGE_CALLS=0
_cnd_converge_codex_guard() {
  CODEX_GUARD_CONVERGE_CALLS=$((CODEX_GUARD_CONVERGE_CALLS + 1))
}

DOMAIN_FILE="$ROOT/domain"
DISABLED_FILE="$ROOT/disabled"
BOOTSTRAP_LOG="$ROOT/bootstrap.log"
DISABLED_RC=0
BOOTSTRAP_RC=0
BOOTSTRAP_LANDS=1
PRINT_ERROR_LABEL=""
PRINT_FOREIGN_NOTFOUND=""
DISABLED_RAW_OVERRIDE=""

# Scripted launchd domain. Only this seam is faked; every predicate under test
# runs the real production code path.
_cnd_launchctl() {
  case "$1" in
    print-disabled)
      if [[ -n "$DISABLED_RAW_OVERRIDE" ]]; then
        printf '%s' "$DISABLED_RAW_OVERRIDE"
        return "$DISABLED_RC"
      fi
      cat "$DISABLED_FILE" 2>/dev/null
      printf '\t}\n'
      return "$DISABLED_RC"
      ;;
    print)
      local label="${2##*/}"
      if [[ -n "$PRINT_ERROR_LABEL" && "$label" == "$PRINT_ERROR_LABEL" ]]; then
        # A real launchctl failure that is NOT "this service is absent".
        echo "Bad request." >&2
        echo "Could not signal service: Operation not permitted" >&2
        return 1
      fi
      if [[ -n "$PRINT_FOREIGN_NOTFOUND" && "$label" == "$PRINT_FOREIGN_NOTFOUND" ]]; then
        # Another service's not-found text leaking out of an unrelated failure.
        echo "Bad request." >&2
        echo "Could not find service \"com.flywheel.someone-else\" in domain for user gui: 501" >&2
        return 1
      fi
      grep -Fxq "$label" "$DOMAIN_FILE" 2>/dev/null && return 0
      # Verbatim macOS shape: rc 113, message on stderr.
      echo "Bad request." >&2
      echo "Could not find service \"$label\" in domain for user gui: 501" >&2
      return 113
      ;;
    bootstrap)
      # Faithful to launchd: the service is registered under the plist's INTERNAL
      # Label, which is not necessarily the file name.
      local label
      label="$(sed -n 's|.*<key>Label</key><string>\([^<]*\)</string>.*|\1|p' "$3" | head -1)"
      printf '%s\n' "$label" >> "$BOOTSTRAP_LOG"
      if [[ "$BOOTSTRAP_RC" -eq 0 && "$BOOTSTRAP_LANDS" -eq 1 ]]; then
        printf '%s\n' "$label" >> "$DOMAIN_FILE"
      fi
      return "$BOOTSTRAP_RC"
      ;;
  esac
  return 1
}

AGENTS="$ROOT/LaunchAgents"
_cnd_launch_agents_dir() { printf '%s\n' "$AGENTS"; }
_cnd_domain() { printf '%s\n' "gui/501"; }

reset_world() {
  rm -rf "$AGENTS"
  mkdir -p "$AGENTS"
  : > "$DOMAIN_FILE"
  : > "$BOOTSTRAP_LOG"
  DISABLED_RC=0
  BOOTSTRAP_RC=0
  BOOTSTRAP_LANDS=1
  PRINT_ERROR_LABEL=""
  PRINT_FOREIGN_NOTFOUND=""
  DISABLED_RAW_OVERRIDE=""
  printf '\n\tdisabled services = {\n' > "$DISABLED_FILE"
  NONLEAD_DAEMON_CONVERGE_STATE=""
  NONLEAD_DAEMON_CONVERGE_DETAIL=""
}

# A plist whose internal Label matches its filename — the normal case.
plist() { plist_labeled "$1" "$1"; }

# A plist whose internal Label is whatever the caller says. launchd registers the
# service under THIS label, not under the file name.
plist_labeled() {
  cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key><string>$2</string>
    <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
}
in_domain() { printf '%s\n' "$1" >> "$DOMAIN_FILE"; }
disabled() { printf '\t\t"%s" => disabled\n' "$1" >> "$DISABLED_FILE"; }
enabled() { printf '\t\t"%s" => enabled\n' "$1" >> "$DISABLED_FILE"; }
bootstrapped() { grep -Fxq "$1" "$BOOTSTRAP_LOG" 2>/dev/null; }

echo "Test: the FLY-1830 shape — enabled, on disk, out of the domain → converged back"
reset_world
plist com.flywheel.quota-monitor
enabled com.flywheel.quota-monitor
converge_nonlead_daemons >/dev/null 2>&1
if bootstrapped com.flywheel.quota-monitor \
  && [[ "$CODEX_GUARD_CONVERGE_CALLS" == "1" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "healthy" ]] \
  && grep -Fxq com.flywheel.quota-monitor "$DOMAIN_FILE"; then
  pass "an enabled non-Lead daemon is bootstrapped and the isolated guard seam runs once"
else
  fail "quota-monitor shape not converged (state=$NONLEAD_DAEMON_CONVERGE_STATE guard_calls=$CODEX_GUARD_CONVERGE_CALLS)"
fi

echo "Test: a label with no override entry at all counts as enabled (launchd's default)"
reset_world
plist com.flywheel.daily-standup
converge_nonlead_daemons >/dev/null 2>&1
if bootstrapped com.flywheel.daily-standup; then
  pass "absence from the override database is read as enabled, not as unknown"
else
  fail "a plist with no override entry was not converged"
fi

echo "Test: idempotent — a daemon already in the domain is never re-bootstrapped"
reset_world
plist com.flywheel.cmux-watcher
enabled com.flywheel.cmux-watcher
in_domain com.flywheel.cmux-watcher
converge_nonlead_daemons >/dev/null 2>&1
if ! bootstrapped com.flywheel.cmux-watcher \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "healthy" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *"already_loaded=1"* ]]; then
  pass "a loaded daemon is left alone (running this on every deploy is a no-op)"
else
  fail "a loaded daemon was disturbed: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

echo "Test: a deliberately disabled daemon stays disabled"
reset_world
plist com.flywheel.growth-learn
disabled com.flywheel.growth-learn
converge_nonlead_daemons >/dev/null 2>&1
if ! bootstrapped com.flywheel.growth-learn \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *"enabled=0"* ]]; then
  pass "operator intent (disabled) is authority; convergence does not override it"
else
  fail "a disabled daemon was started: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

echo "Test: the Lead family is never touched — including the FLY-398 TUI carrier"
reset_world
plist com.flywheel.lead.growth-mufasa-lead   # enabled, on disk, NOT in the domain
plist com.flywheel.lead.flywheel-eng-lead
enabled com.flywheel.lead.growth-mufasa-lead
enabled com.flywheel.lead.flywheel-eng-lead
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *"enabled=0"* ]]; then
  pass "com.flywheel.lead.* is excluded, so the double-listen hazard is unreachable"
else
  fail "a Lead carrier was bootstrapped: $(cat "$BOOTSTRAP_LOG")"
fi

echo "Test: unreadable override database → converge nothing, report unverifiable"
reset_world
plist com.flywheel.quota-monitor
DISABLED_RC=1
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "unverifiable" ]]; then
  pass "without the enabled/disabled truth nothing is started (fail-closed)"
else
  fail "converged without the override database (state=$NONLEAD_DAEMON_CONVERGE_STATE)"
fi

echo "Test: bootstrap exiting 0 without landing the label is a FAILURE, not success"
reset_world
plist com.flywheel.updater
enabled com.flywheel.updater
BOOTSTRAP_RC=0
BOOTSTRAP_LANDS=0
converge_nonlead_daemons >/dev/null 2>&1
if [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "degraded" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *"failed: com.flywheel.updater"* ]]; then
  pass "the post-bootstrap domain re-read is the verdict, not launchctl's exit code"
else
  fail "a no-op bootstrap was reported as success: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

echo "Test: a failing bootstrap is reported as degraded and does not abort the sweep"
reset_world
plist com.flywheel.updater
plist com.flywheel.quota-monitor
enabled com.flywheel.updater
enabled com.flywheel.quota-monitor
BOOTSTRAP_RC=1
converge_nonlead_daemons >/dev/null 2>&1
if [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "degraded" ]] \
  && bootstrapped com.flywheel.updater && bootstrapped com.flywheel.quota-monitor \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *"failed=2"* ]]; then
  pass "one failure does not hide the rest of the set"
else
  fail "sweep aborted early or misreported: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

echo "Test: the Lead exclusion follows the plist's INTERNAL Label, not the file name"
# launchd registers a service under the Label inside the plist. A file that is not
# named com.flywheel.lead.* but declares a Lead label would otherwise sail past a
# filename-only exclusion and start a second Mufasa listener.
reset_world
plist_labeled com.flywheel.rogue com.flywheel.lead.growth-mufasa-lead
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]]; then
  pass "a Lead label hiding behind a non-Lead file name is still excluded"
else
  fail "double-listen hazard reachable: bootstrapped $(cat "$BOOTSTRAP_LOG")"
fi

echo "Test: a plist declaring a label outside the com.flywheel namespace is refused"
reset_world
plist_labeled com.flywheel.borrowed com.someoneelse.daemon
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "degraded" ]]; then
  pass "a flywheel-named file cannot smuggle in a foreign service"
else
  fail "foreign label accepted: $(cat "$BOOTSTRAP_LOG") state=$NONLEAD_DAEMON_CONVERGE_STATE"
fi

echo "Test: a plist whose Label cannot be read is skipped and reported, never guessed"
reset_world
printf 'bplist00\x01\x02not-xml\n' > "$AGENTS/com.flywheel.opaque.plist"
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "degraded" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *"com.flywheel.opaque"* ]]; then
  pass "an unreadable Label is not silently replaced by the file name"
else
  fail "unreadable Label mishandled: $NONLEAD_DAEMON_CONVERGE_DETAIL"
fi

echo "Test: domain membership is judged by the internal Label too"
reset_world
plist_labeled com.flywheel.oddname com.flywheel.quota-monitor
in_domain com.flywheel.quota-monitor
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_DETAIL" == *"already_loaded=1"* ]]; then
  pass "a service already loaded under its real label is not duplicated"
else
  fail "duplicate bootstrap of a loaded service: $(cat "$BOOTSTRAP_LOG")"
fi

echo "Test: an override database entry we cannot classify is fail-closed"
reset_world
plist com.flywheel.quota-monitor
printf '\t\t"com.flywheel.something" => wat\n' >> "$DISABLED_FILE"
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "unverifiable" ]]; then
  pass "an unrecognised enabled/disabled value stops the sweep instead of assuming enabled"
else
  fail "malformed override output was treated as usable: state=$NONLEAD_DAEMON_CONVERGE_STATE"
fi

echo "Test: a domain probe ERROR is not read as 'the service is absent'"
reset_world
plist com.flywheel.quota-monitor
enabled com.flywheel.quota-monitor
PRINT_ERROR_LABEL=com.flywheel.quota-monitor
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "degraded" ]]; then
  pass "only a verbatim 'Could not find service' counts as absent; errors do not bootstrap"
else
  fail "a probe error triggered a bootstrap: $(cat "$BOOTSTRAP_LOG")"
fi

echo "Test: the XML fallback takes the Label's own <string>, not an earlier one on the line"
reset_world
cat > "$AGENTS/com.flywheel.crowded.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Program</key><string>com.flywheel.decoy</string><key>Label</key><string>com.flywheel.lead.growth-mufasa-lead</string>
</dict>
</plist>
EOF
( _cnd_plutil() { return 1; }; converge_nonlead_daemons ) >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]]; then
  pass "the fallback parser cannot be fooled by a <string> that precedes <key>Label</key>"
else
  fail "fallback took the wrong <string>: bootstrapped $(cat "$BOOTSTRAP_LOG")"
fi

echo "Test: the XML fallback survives <key>Label</key> sitting at the end of a line"
reset_world
cat > "$AGENTS/com.flywheel.trailingkey.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Program</key><string>com.flywheel.decoy</string><key>Label</key>
    <string>com.flywheel.lead.growth-mufasa-lead</string>
</dict>
</plist>
EOF
( _cnd_plutil() { return 1; }; converge_nonlead_daemons ) >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]]; then
  pass "an empty remainder continues onto the next line, it does not re-scan this one"
else
  fail "end-of-line Label key re-opened the decoy: bootstrapped $(cat "$BOOTSTRAP_LOG")"
fi

echo "Test: an override listing with no closing brace is fail-closed"
reset_world
plist com.flywheel.quota-monitor
enabled com.flywheel.quota-monitor
DISABLED_RAW_OVERRIDE=$'\n\tdisabled services = {\n\t\t"com.flywheel.other" => disabled\n'
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "unverifiable" ]]; then
  pass "a truncated override listing is not accepted as complete"
else
  fail "truncated listing accepted: state=$NONLEAD_DAEMON_CONVERGE_STATE"
fi

echo "Test: an override entry with trailing junk is fail-closed, never silently dropped"
reset_world
plist com.flywheel.quota-monitor
printf '\t\t"com.flywheel.quota-monitor" => disabled } trailing\n' >> "$DISABLED_FILE"
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "unverifiable" ]]; then
  pass "an entry that does not parse exactly stops the sweep instead of vanishing"
else
  fail "trailing junk dropped a disabled label: state=$NONLEAD_DAEMON_CONVERGE_STATE bootstrap=$(cat "$BOOTSTRAP_LOG")"
fi

echo "Test: 'not found' must name the label we asked about"
reset_world
plist com.flywheel.quota-monitor
enabled com.flywheel.quota-monitor
PRINT_FOREIGN_NOTFOUND=com.flywheel.quota-monitor
converge_nonlead_daemons >/dev/null 2>&1
PRINT_FOREIGN_NOTFOUND=""
if [[ ! -s "$BOOTSTRAP_LOG" ]] \
  && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "degraded" ]]; then
  pass "another service's not-found text is an error, not evidence about ours"
else
  fail "absence inferred from an unrelated message: $(cat "$BOOTSTRAP_LOG")"
fi

echo "Test: identity is the declared Label even when the file NAME looks like a Lead"
reset_world
plist_labeled com.flywheel.lead.misnamed com.flywheel.quota-monitor
enabled com.flywheel.quota-monitor
converge_nonlead_daemons >/dev/null 2>&1
if bootstrapped com.flywheel.quota-monitor; then
  pass "no file-name shortcut survives; the declared Label decides in both directions"
else
  fail "a non-Lead daemon was skipped because of its file name"
fi

echo "Test: backup / staged / symlinked plist siblings are not daemons"
reset_world
plist com.flywheel.quota-monitor
enabled com.flywheel.quota-monitor
printf '<plist/>\n' > "$AGENTS/com.flywheel.bridge.plist.bak-batchA"
printf '<plist/>\n' > "$AGENTS/com.flywheel.growth-mufasa.plist.fly398-tui-staged"
printf '<plist/>\n' > "$ROOT/elsewhere.plist"
ln -s "$ROOT/elsewhere.plist" "$AGENTS/com.flywheel.symlinked.plist"
converge_nonlead_daemons >/dev/null 2>&1
if [[ "$(cat "$BOOTSTRAP_LOG")" == "com.flywheel.quota-monitor" ]]; then
  pass "only exact com.flywheel.<label>.plist regular files are considered"
else
  fail "a non-daemon file was bootstrapped: $(cat "$BOOTSTRAP_LOG")"
fi

echo "Test: an empty LaunchAgents directory is a clean no-op, not a failure"
reset_world
converge_nonlead_daemons >/dev/null 2>&1
if [[ ! -s "$BOOTSTRAP_LOG" ]] && [[ "$NONLEAD_DAEMON_CONVERGE_STATE" == "healthy" ]]; then
  pass "no plists → healthy with nothing done"
else
  fail "empty directory misreported: $NONLEAD_DAEMON_CONVERGE_STATE"
fi

echo "Test: convergence runs after deployed-sha advances, and reports a degraded result"
# Ordering is load-bearing, not cosmetic: a converged job can start the instant it
# enters the domain (RunAtLoad, or QueueDirectories over a non-empty queue as
# com.flywheel.updater has). Converging before the deploy finishes could hand the
# updater a git pull on the checkout this deploy is still building from.
RS="$REPO_ROOT/scripts/restart-services.sh"
watcher_line=$(grep -n '^[[:space:]]*restart_cmux_watcher$' "$RS" | head -1 | cut -d: -f1)
converge_line=$(grep -n '^[[:space:]]*converge_nonlead_daemons$' "$RS" | head -1 | cut -d: -f1)
sha_line=$(grep -n '^[[:space:]]*echo "\$CURRENT_HEAD" > "\$DEPLOYED_SHA_FILE"$' "$RS" | head -1 | cut -d: -f1)
warn_line=$(grep -n 'nonlead-daemons-\${nonlead_state}' "$RS" | head -1 | cut -d: -f1)
if grep -q 'lib/converge-nonlead-daemons.sh' "$RS" \
  && [[ "$watcher_line" =~ ^[0-9]+$ && "$converge_line" =~ ^[0-9]+$ \
     && "$sha_line" =~ ^[0-9]+$ && "$warn_line" =~ ^[0-9]+$ ]] \
  && (( watcher_line < converge_line )) \
  && (( sha_line < converge_line )) \
  && (( converge_line < warn_line )) \
  && [[ "$(cat "$RS")" == *'非-Lead daemon 收敛=${nonlead_state}: ${nonlead_detail}'* ]]; then
  pass "convergence runs after the deploy is committed and still feeds the warning"
else
  fail "wiring/order incomplete (watcher=$watcher_line sha=$sha_line converge=$converge_line warn=$warn_line)"
fi

echo "Test: the restart wave must not be aborted by a degraded convergence"
if [[ "$(grep -A 3 '^[[:space:]]*converge_nonlead_daemons$' "$RS")" != *"return 1"* ]]; then
  pass "an auxiliary daemon that cannot be put back never blocks the deploy"
else
  fail "convergence failure aborts the deploy"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
