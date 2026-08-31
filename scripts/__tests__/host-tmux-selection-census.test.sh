#!/bin/bash
# FLY-2190 A0: every live Lead plist must resolve to registered, converged S0
# carrier bytes. Unknown or drifted carrier shapes fail closed.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; shift; [ "$#" -eq 0 ] || echo "        $*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/host-tmux-selection-gate.sh"
SANDBOX="$(mktemp -d -t fly2190-host-tmux-census-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

HOME_ROOT="$SANDBOX/home"
PLIST_DIR="$HOME_ROOT/Library/LaunchAgents"
SOURCE_DIR="$SANDBOX/repo/scripts"
INSTALLED_DIR="$HOME_ROOT/.flywheel/bin"
mkdir -p "$PLIST_DIR" "$SOURCE_DIR" "$INSTALLED_DIR"

REGISTERED_WRAPPERS="
flywheel-lead-wrapper-v2.sh
flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh
flywheel-codex-lead-wrapper-codex-infra-bot.sh
"
for wrapper in $REGISTERED_WRAPPERS; do
  cp "$REPO_ROOT/scripts/$wrapper" "$SOURCE_DIR/$wrapper"
  cp "$SOURCE_DIR/$wrapper" "$INSTALLED_DIR/$wrapper"
  chmod 555 "$SOURCE_DIR/$wrapper" "$INSTALLED_DIR/$wrapper"
done

write_plist() {
  local label="$1" wrapper="$2"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '<key>Label</key><string>%s</string>\n' "$label"
    printf '%s\n' '<key>ProgramArguments</key><array>'
    printf '%s\n' '<string>/bin/bash</string>'
    printf '<string>%s</string>\n' "$INSTALLED_DIR/$wrapper"
    printf '%s\n' '</array><key>KeepAlive</key><true/></dict></plist>'
  } > "$PLIST_DIR/$label.plist"
}

for index in $(seq 1 14); do
  write_plist "com.flywheel.lead.fixture-${index}" flywheel-lead-wrapper-v2.sh
done
write_plist com.flywheel.lead.growth-mufasa-lead \
  flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh
write_plist com.flywheel.lead.flywheel-codex-infra-bot-lead \
  flywheel-codex-lead-wrapper-codex-infra-bot.sh

CANDIDATES="$SANDBOX/loaded-candidates.tsv"
for index in $(seq 1 14); do
  printf 'fixture-%s\tfixture\tlead-%s\t-\trestart\tplist\n' "$index" "$index"
done > "$CANDIDATES"
printf '%s\n' \
  $'growth-mufasa-lead\tfixture\tmufasa\t-\trestart\tplist' \
  $'flywheel-codex-infra-bot-lead\tfixture\tinfra\t-\trestart\tplist' \
  >> "$CANDIDATES"
cp "$CANDIDATES" "$SANDBOX/loaded-candidates.base.tsv"

# A staged on-disk plist is not live authority and must not participate in the
# census. Production obtains the same positively-loaded set from
# lead_restart_collect_candidates.
write_plist com.flywheel.lead.staged-retired flywheel-lead-wrapper-v2.sh

run_census() {
  local name="$1"
  CENSUS_RC=0
  env -i \
    HOME="$HOME_ROOT" \
    PATH="/usr/bin:/bin" \
    FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
    FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR="$PLIST_DIR" \
    FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR="$SOURCE_DIR" \
    bash "$GATE" census "$CANDIDATES" >"$SANDBOX/$name.out" \
      2>"$SANDBOX/$name.err" || CENSUS_RC=$?
}

run_census healthy

if [ "$CENSUS_RC" -eq 0 ] \
  && grep -Fq 'census pass plists=16 generic=14 codex-mufasa=1 codex-infra-bot=1' \
    "$SANDBOX/healthy.out"; then
  pass "all 16 positively-loaded Lead plists map to the three registered carriers"
else
  fail "healthy 16-Lead census (rc=$CENSUS_RC)" \
    "$(cat "$SANDBOX/healthy.err" 2>/dev/null)"
fi

# Non-restart classifications are already isolated by the restart authority.
# A loaded but malformed/QA plist must not promote itself into a whole-fleet
# census veto.
write_plist com.flywheel.lead.skipped-unknown flywheel-unknown-lead-wrapper.sh
printf '%s\n' $'skipped-unknown\t-\t-\t-\tconfig-drift\tplist' >> "$CANDIDATES"
run_census classified-skip
if [ "$CENSUS_RC" -eq 0 ] \
  && grep -Fq 'census pass plists=16 generic=14 codex-mufasa=1 codex-infra-bot=1' \
    "$SANDBOX/classified-skip.out"; then
  pass "non-restart loaded classifications do not veto healthy production Leads"
else
  fail "config-drift candidate escalated into a fleet veto (rc=$CENSUS_RC)" \
    "$(cat "$SANDBOX/classified-skip.err" 2>/dev/null)"
fi
cp "$SANDBOX/loaded-candidates.base.tsv" "$CANDIDATES"
rm -f "$PLIST_DIR/com.flywheel.lead.skipped-unknown.plist"

UNKNOWN="$INSTALLED_DIR/flywheel-unknown-lead-wrapper.sh"
printf '%s\n' '#!/bin/bash' 'exit 0' > "$UNKNOWN"
chmod 555 "$UNKNOWN"
write_plist com.flywheel.lead.fixture-14 flywheel-unknown-lead-wrapper.sh
run_census unknown
if [ "$CENSUS_RC" -ne 0 ] \
  && grep -Fq 'Lead plist must select exactly one registered carrier' \
    "$SANDBOX/unknown.err"; then
  pass "an unknown live wrapper fails the census closed"
else
  fail "unknown live wrapper was accepted (rc=$CENSUS_RC)" \
    "$(cat "$SANDBOX/unknown.err" 2>/dev/null)"
fi
write_plist com.flywheel.lead.fixture-14 flywheel-lead-wrapper-v2.sh

# Both plist parsers must reject one logical ProgramArguments string that
# embeds a newline. The primary plutil+jq path must not split it into a fake
# second registered carrier argument.
{
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<plist version="1.0"><dict><key>ProgramArguments</key><array>'
  printf '<string>/opt/unregistered&#10;%s</string>\n' "$INSTALLED_DIR/flywheel-lead-wrapper-v2.sh"
  printf '%s\n' '</array></dict></plist>'
} > "$PLIST_DIR/com.flywheel.lead.fixture-14.plist"
run_census newline-argument
if [ "$CENSUS_RC" -ne 0 ] \
  && grep -Fq 'cannot parse ProgramArguments' "$SANDBOX/newline-argument.err"; then
  pass "plist parsers consistently reject embedded-newline arguments"
else
  fail "newline-bearing plist argument was split and accepted (rc=$CENSUS_RC)" \
    "$(cat "$SANDBOX/newline-argument.err" 2>/dev/null)"
fi
write_plist com.flywheel.lead.fixture-14 flywheel-lead-wrapper-v2.sh

chmod u+w "$INSTALLED_DIR/flywheel-lead-wrapper-v2.sh"
printf '%s\n' '# deployed drift' >> "$INSTALLED_DIR/flywheel-lead-wrapper-v2.sh"
run_census drift
if [ "$CENSUS_RC" -ne 0 ] \
  && grep -Fq 'deployed carrier bytes drift from registered source' \
    "$SANDBOX/drift.err"; then
  pass "deployed wrapper drift fails the census closed"
else
  fail "drifted deployed wrapper was accepted (rc=$CENSUS_RC)" \
    "$(cat "$SANDBOX/drift.err" 2>/dev/null)"
fi
cp "$SOURCE_DIR/flywheel-lead-wrapper-v2.sh" \
  "$INSTALLED_DIR/flywheel-lead-wrapper-v2.sh"
chmod 555 "$INSTALLED_DIR/flywheel-lead-wrapper-v2.sh"

MOUNTLESS_TMP="$SANDBOX/mountless-wrapper"
sed '/host-tmux-selection-gate\.sh/d' "$SOURCE_DIR/flywheel-lead-wrapper-v2.sh" \
  > "$MOUNTLESS_TMP"
mv "$MOUNTLESS_TMP" "$SOURCE_DIR/flywheel-lead-wrapper-v2.sh"
chmod u+w "$INSTALLED_DIR/flywheel-lead-wrapper-v2.sh"
cp "$SOURCE_DIR/flywheel-lead-wrapper-v2.sh" \
  "$INSTALLED_DIR/flywheel-lead-wrapper-v2.sh"
chmod 555 "$SOURCE_DIR/flywheel-lead-wrapper-v2.sh" \
  "$INSTALLED_DIR/flywheel-lead-wrapper-v2.sh"
run_census mountless
if [ "$CENSUS_RC" -ne 0 ] \
  && grep -Fq 'deployed carrier is missing the S0 gate mount' \
    "$SANDBOX/mountless.err"; then
  pass "source-identical bytes without the S0 mount still fail closed"
else
  fail "mountless deployed wrapper was accepted (rc=$CENSUS_RC)" \
    "$(cat "$SANDBOX/mountless.err" 2>/dev/null)"
fi

echo ""
echo "host-tmux-selection-census: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
