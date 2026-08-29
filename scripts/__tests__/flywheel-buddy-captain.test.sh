#!/bin/bash
# FLY-1023 M5/M5-a: Captain preview (lead-launch contract closeout) + the
# extended placement health check (captain_health step).
#
# The REAL claude-lead.sh runs in its FLY-231 dry-run under an isolated HOME:
# a complete LAUNCH_PLAN is the executable proof that all four startup gates
# (projects.json role entry / identity.md / bin guard scripts / transport
# backend) are closed on a clean machine by the buddy chain's products.
#
# Requires the built teamlead dist (node role detection) — SKIPs when absent
# (CI builds first).
#
# Covers (plan §3 M5 acceptance):
#   P1  gates green on a buddy-shaped clean HOME → dry-run launch plan
#       completes (preview contract; the resident path runs the SAME
#       launcher through the supervisor, same gates)
#   P2  gate 1 missing (no config product) → readable failure, no launch
#   P3  gate 2 missing (no identity.md) → readable failure
#   P4  gate 3: guard stubs installed 0700 when absent; NEVER overwritten
#   P5  preview stop: no-op safe without a pid file
#   H1  captain_health: Bridge 2xx + bot identity + channel probe all green
#       → done with evidence
#   H2  captain_health: Bridge down → step fails, NOT marked done
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/buddy-captain-preview.sh"
CLI="$REPO_ROOT/scripts/flywheel-buddy-steps.sh"
DIST="$REPO_ROOT/packages/teamlead/dist"
if [ ! -f "$DIST/ProjectConfig.js" ]; then
  echo "SKIP: teamlead dist not built — run pnpm -C packages/teamlead build first"
  exit 0
fi

SANDBOX="$(mktemp -d -t fly1023-captain-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
[ -t 0 ] || cat >/dev/null
url=""; method="GET"; prev=""
for a in "$@"; do
  case "$prev" in -X) method="$a" ;; esac
  case "$a" in http*://*) url="$a" ;; esac
  prev="$a"
done
case "$url" in
  *brokenbridge*) exit 22 ;;
  *api/runs/active*) exit 0 ;;
  *discord.com*/users/@me) printf '{"id":"bot1","username":"stub"}\n200' ;;
  *discord.com*/channels/*/messages/*) printf '\n204' ;;
  *discord.com*/channels/*/messages*)
    case "$method" in
      GET) printf '[{"id":"M1"}]\n200' ;;
      POST) printf '{"id":"P1"}\n200' ;;
      *) printf '\n204' ;;
    esac ;;
  *) printf '{}\n200' ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/curl"

# make_fixture <home> — a buddy-shaped machine state: config product
# (projects.json in the real loader's shape), skeleton identity dirs, .env
# with fixture (non-real) token values, and a v2 journal carrying the
# hydration evidence captain_health needs.
make_fixture() {
  local h="$1"
  mkdir -p "$h/.flywheel" "$h/Dev/qa-captain/.lead/cos-lead" "$h/Dev/qa-captain/.lead/tad-eng-lead"
  chmod go-w "$h/.flywheel"
  printf -- '---\nname: cos-lead\n---\nCass\n' > "$h/Dev/qa-captain/.lead/cos-lead/identity.md"
  printf -- '---\nname: tad-eng-lead\n---\nTad\n' > "$h/Dev/qa-captain/.lead/tad-eng-lead/identity.md"
  jq -n --arg root "$h/Dev/qa-captain" '[
    { projectName:"qa-captain", projectRoot:$root, generalChannel:"C-gen",
      memoryAllowedUsers:["100000000000000009"],
      linear:{team:"QAC", project:"qa-captain", label:"Qa-captain"},
      leads:[
        {agentId:"cos-lead", chatChannel:"C-cos", match:{labels:["Triage"]},
         botTokenEnv:"CASS_BOT_TOKEN", canSpawnRunners:false},
        {agentId:"tad-eng-lead", chatChannel:"C-eng", match:{labels:["Qa-captain"]},
         department:"engineering", botTokenEnv:"TAD_BOT_TOKEN"}
      ] }]' > "$h/.flywheel/projects.json"
  printf 'CASS_BOT_TOKEN=fixture-cos-value\nTAD_BOT_TOKEN=fixture-eng-value\nDISCORD_GUILD_ID=G1\nDISCORD_OWNER_USER_ID=100000000000000009\n' > "$h/.flywheel/.env"
  chmod 600 "$h/.flywheel/.env"
  cat > "$h/.flywheel/setup-state.json" <<EOF
{"version":2,
 "steps":{
   "bots":{"status":"done","evidence":{"path":"c1","guildId":"G1","results":[]}},
   "channels":{"status":"done","evidence":{"channels":{"cos":"C-cos","eng":"C-eng","general":"C-gen"},"founderId":"100000000000000009"}}
 },
 "buddy":{"identity":{"project":"qa-captain","department":"engineering","cosPersona":"Cass","engPersona":"Tad","linearTeam":"QAC","projectSlug":"","skillsRepo":"xrliAnnie/flywheel-skills"}}}
EOF
  chmod 600 "$h/.flywheel/setup-state.json"
}

# run_preview <home> <fn-and-args…> — the lib under an isolated HOME.
run_preview() {
  local h="$1"; shift
  env -i HOME="$h" USER=tester PATH="$STUB_BIN:$PATH" \
    FLYWHEEL_BUDDY_PREVIEW_DRY_RUN=1 \
    bash -c 'source "'"$LIB"'" || exit 97; "$@"' _ "$@"
}

# ── P1: gates green → dry-run launch plan completes ──
H1="$SANDBOX/home1"; make_fixture "$H1"
run_preview "$H1" buddy_captain_preview_start "$H1/.flywheel" --project qa-captain 2>"$SANDBOX/p1.err"
RC1=$?
if [ "$RC1" -eq 0 ] && grep -q 'LAUNCH_PLAN_END' "$H1/.flywheel/captain-preview.log" \
   && grep -q $'ROLE\tstandard' "$H1/.flywheel/captain-preview.log" \
   && grep -q $'PANE_ENV\tDISCORD_BOT_TOKEN\tset' "$H1/.flywheel/captain-preview.log"; then
  pass "P1 clean buddy-shaped HOME: all four gates pass, launch plan completes with the Captain's token SET"
else
  fail "P1 rc=$RC1 err=$(tail -3 "$SANDBOX/p1.err" 2>/dev/null) log=$(tail -3 "$H1/.flywheel/captain-preview.log" 2>/dev/null)"
fi
# secret canary: the fixture token value must never appear in the log
if ! grep -q "fixture-eng-value" "$H1/.flywheel/captain-preview.log"; then
  pass "P1s token value never echoed into the preview log"
else
  fail "P1s token value leaked into the log"
fi

# ── P4: gate-3 guard stubs installed 0700 when absent; never overwritten ──
CHK="$H1/.flywheel/bin/check-discord-plugin.sh"
PERM4="$(stat -c '%a' "$CHK" 2>/dev/null || stat -f '%Lp' "$CHK" 2>/dev/null)"
echo "# operator-managed real script" > "$CHK"
run_preview "$H1" buddy_captain_preview_start "$H1/.flywheel" --project qa-captain >/dev/null 2>&1
if [ "$PERM4" = "700" ] && grep -q "operator-managed" "$CHK"; then
  pass "P4 guard stubs: installed 0700 when absent, existing scripts never overwritten"
else
  fail "P4 perm=$PERM4 content=$(head -1 "$CHK")"
fi

# ── P2: gate 1 missing (no projects.json) → readable failure ──
H2="$SANDBOX/home2"; make_fixture "$H2"; rm -f "$H2/.flywheel/projects.json"
OUT2="$(run_preview "$H2" buddy_captain_preview_start "$H2/.flywheel" --project qa-captain 2>&1)"
RC2=$?
if [ "$RC2" -ne 0 ] && grep -q "config" <<<"$OUT2"; then
  pass "P2 missing config product: refused with a specific reason (honest degrade path)"
else
  fail "P2 rc=$RC2 out='$OUT2'"
fi

# ── P3: gate 2 missing (identity.md) → readable failure ──
H3="$SANDBOX/home3"; make_fixture "$H3"; rm -f "$H3/Dev/qa-captain/.lead/tad-eng-lead/identity.md"
OUT3="$(run_preview "$H3" buddy_captain_preview_start "$H3/.flywheel" --project qa-captain 2>&1)"
RC3=$?
if [ "$RC3" -ne 0 ] && grep -q "skeleton" <<<"$OUT3"; then
  pass "P3 missing identity.md: refused with a specific reason"
else
  fail "P3 rc=$RC3 out='$OUT3'"
fi

# ── P4b: custom --state-dir → REFUSED before the launcher runs; the real
#        home is not mutated AT ALL (Codex R1#3 + R2#2) ──
H6="$SANDBOX/home6"; make_fixture "$H6"
mkdir -p "$H6/custom-state"; chmod go-w "$H6/custom-state"
cp "$H6/.flywheel/projects.json" "$H6/.flywheel/.env" "$H6/.flywheel/setup-state.json" "$H6/custom-state/"
rm -rf "$H6/.flywheel"
OUT4B="$(run_preview "$H6" buddy_captain_preview_start "$H6/custom-state" --project qa-captain 2>&1)"
RC4B=$?
if [ "$RC4B" -ne 0 ] && [ ! -e "$H6/.flywheel" ] && grep -q "custom state dir" <<<"$OUT4B"; then
  pass "P4b custom state dir: refused before launch, real \$HOME/.flywheel untouched entirely"
else
  fail "P4b rc=$RC4B home=$(ls -a "$H6/.flywheel" 2>/dev/null | tr '\n' ' ') out='$OUT4B'"
fi

# ── P6: LIVE preview is explicit opt-in (Codex R2#1 argv red line) ──
H8="$SANDBOX/home8"; make_fixture "$H8"
OUT6="$(env -i HOME="$H8" USER=tester PATH="$STUB_BIN:$PATH" \
  bash -c 'source "'"$LIB"'" || exit 97; buddy_captain_preview_start "$HOME/.flywheel" --project qa-captain' 2>&1)"
RC6=$?
if [ "$RC6" -ne 0 ] && grep -q "live preview deferred" <<<"$OUT6" \
   && [ ! -f "$H8/.flywheel/captain-preview.pid" ]; then
  pass "P6 live preview off by default: honest degrade, no launcher spawned"
else
  fail "P6 rc=$RC6 out='$OUT6'"
fi

# ── P5: stop without a pid file is a safe no-op ──
run_preview "$H1" buddy_captain_preview_stop "$H1/.flywheel" >/dev/null 2>&1
RC5=$?
[ "$RC5" -eq 0 ] && pass "P5 preview stop: no-op safe without a pid file" || fail "P5 rc=$RC5"

# ── H1: captain_health all green → done with evidence ──
H4="$SANDBOX/home4"; make_fixture "$H4"
O_H1="$(env -i HOME="$H4" USER=tester PATH="$STUB_BIN:$PATH" \
  bash "$CLI" --project qa-captain --cos-persona Cass --eng-persona Tad run captain_health 2>/dev/null)"
RC_H1=$?
if [ "$RC_H1" -eq 0 ] && [ "$(jq -r '.evidence.bridge' <<<"$O_H1")" = "2xx" ] \
   && [ "$(jq -r '.steps.captain_health.status' "$H4/.flywheel/setup-state.json")" = "done" ]; then
  pass "H1 captain_health: Bridge 2xx + bot identity + channel probe → done"
else
  fail "H1 rc=$RC_H1 out='$O_H1'"
fi

# ── H2: Bridge down → step fails, NOT done ──
H5="$SANDBOX/home5"; make_fixture "$H5"
O_H2="$(env -i HOME="$H5" USER=tester PATH="$STUB_BIN:$PATH" \
  FLYWHEEL_BRIDGE_URL=http://brokenbridge:1 \
  bash "$CLI" --project qa-captain --cos-persona Cass --eng-persona Tad run captain_health 2>/dev/null)"
RC_H2=$?
if [ "$RC_H2" -ne 0 ] \
   && [ "$(jq -r '.steps.captain_health.status // "pending"' "$H5/.flywheel/setup-state.json")" != "done" ]; then
  pass "H2 captain_health: Bridge down → fails closed, not marked done"
else
  fail "H2 rc=$RC_H2 out='$O_H2'"
fi

echo ""
echo "flywheel-buddy-captain.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
