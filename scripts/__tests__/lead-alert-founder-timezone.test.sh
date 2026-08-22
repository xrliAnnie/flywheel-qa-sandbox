#!/usr/bin/env bash
# FLY-1319: hermetic founder-local ticket-clock coverage for lead-alert.sh.
set -uo pipefail

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "[TEST] ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LEAD_ALERT="${SCRIPT_DIR}/../lead-alert.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lead-alert-founder-tz.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

FAKEBIN="${ROOT}/bin"
mkdir -p "$FAKEBIN"

cat > "${FAKEBIN}/curl" <<'EOF'
#!/usr/bin/env bash
out=""
prev=""
for arg in "$@"; do
  [[ "$prev" == "-o" ]] && out="$arg"
  [[ "$prev" == "-d" && -n "${FLYWHEEL_TEST_CURL_BODY:-}" ]] && printf '%s' "$arg" > "$FLYWHEEL_TEST_CURL_BODY"
  prev="$arg"
done
[[ -n "$out" ]] && : > "$out"
printf '000'
EOF

cat > "${FAKEBIN}/osascript" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "${FAKEBIN}/date" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "+%H:%M %Z")
    case "${TZ:-}" in
      America/Los_Angeles) printf '19:23 PDT\n' ;;
      Asia/Tokyo) printf '11:23 JST\n' ;;
      Europe/Berlin) printf '04:23 CEST\n' ;;
      Asia/Kolkata) printf '07:53 IST\n' ;;
      "") printf '19:23 HOST\n' ;;
      *) printf '02:23 UTC\n' ;;
    esac
    ;;
  "+%H:%M") printf '19:23\n' ;;
  "+%H:%M:%S") printf '19:23:05\n' ;;
  "+%Y%m%d") printf '20260716\n' ;;
  "-u +%Y%m%dT%H%M%SZ") printf '20260717T022305Z\n' ;;
  *) /bin/date "$@" ;;
esac
EOF

chmod +x "${FAKEBIN}/curl" "${FAKEBIN}/osascript" "${FAKEBIN}/date"

write_projects() {
  jq -n '[{projectName:"test-proj",generalChannel:"",leads:[{
    agentId:"test-lead",alertChannel:"123",alertBotTokenEnv:"FAKE_BOT_TOKEN",
    alertFallbackToCore:false,botTokenEnv:"FAKE_BOT_TOKEN"
  }]}]' > "$1"
}

run_case() {
  local name="$1" founder_tz="$2" link_kind="$3" link_tz="$4"
  local expected="$5" warning_expected="$6"
  local home="${ROOT}/${name}"
  local zone_a="${home}/mac/zoneinfo" zone_b="${home}/linux/zoneinfo"
  local localtime="${home}/localtime" stderr_file="${home}/stderr"
  mkdir -p "$home" "$zone_a/America" "$zone_a/Europe" "$zone_b/Asia"
  : > "$zone_a/America/Los_Angeles"
  : > "$zone_a/Europe/Berlin"
  : > "$zone_b/Asia/Tokyo"
  : > "$zone_b/Asia/Kolkata"
  write_projects "${home}/projects.json"

  case "$link_kind" in
    mac) ln -s "${zone_a}/${link_tz}" "$localtime" ;;
    linux) ln -s "${zone_b}/${link_tz}" "$localtime" ;;
    relative) ln -s "linux/zoneinfo/${link_tz}" "$localtime" ;;
    copy) : > "$localtime" ;;
    invalid) ln -s "${home}/not-zoneinfo/Bad/Zone" "$localtime" ;;
  esac

  env -i \
    HOME="$home" \
    PATH="${FAKEBIN}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" \
    FAKE_BOT_TOKEN="token" \
    FLYWHEEL_CLAIMS_DB="${home}/claims.db" \
    FLYWHEEL_STATE_DIR="${home}/state" \
    FLYWHEEL_PROJECTS_FILE="${home}/projects.json" \
    FLYWHEEL_ALERT_QUEUE_DIR="${home}/queue" \
    FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=123 \
    FLYWHEEL_TEST_CURL_BODY="${home}/curl-body.json" \
    FLYWHEEL_FOUNDER_TZ="$founder_tz" \
    FLYWHEEL_LOCALTIME_PATH="$localtime" \
    FLYWHEEL_ZONEINFO_ROOTS="${zone_a}:${zone_b}" \
    bash "$LEAD_ALERT" --lead test-lead --project test-proj \
      --kind rate_limit --severity warning --title T --body B \
      > /dev/null 2> "$stderr_file" || true

  local content
  content="$(jq -r '.content' "${home}/curl-body.json" 2>/dev/null || true)"
  if [[ "$content" == *"首见 ${expected}"* ]]; then
    ok "$name renders ${expected}"
  else
    bad "$name expected ${expected}; content=${content}"
  fi
  if [[ "$warning_expected" == "yes" ]]; then
    grep -q "invalid FLYWHEEL_FOUNDER_TZ" "$stderr_file" \
      && ok "$name warns for invalid override" \
      || bad "$name missing invalid override warning"
  fi
}

run_case env_override "Asia/Tokyo" mac "America/Los_Angeles" "11:23 JST" no
run_case invalid_env "Not/AZone" mac "America/Los_Angeles" "19:23 PDT" yes
run_case directory_env "America" mac "America/Los_Angeles" "19:23 PDT" yes
run_case mac_link "" mac "Europe/Berlin" "04:23 CEST" no
run_case linux_link "" linux "Asia/Tokyo" "11:23 JST" no
run_case relative_link "" relative "Asia/Kolkata" "07:53 IST" no
run_case copied_localtime "" copy "" "19:23 HOST" no
run_case invalid_link "" invalid "" "19:23 PDT" no

echo "[TEST] lead-alert founder timezone: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
