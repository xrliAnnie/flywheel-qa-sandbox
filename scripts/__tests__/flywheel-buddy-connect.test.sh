#!/bin/bash
# FLY-1023 M4+M6: business-system connectors + JIT connection + first-output
# wiring (the dropship vertical's mechanical layer).
#
# Hermetic: curl fully stubbed (Shopify/Veeqo/Ordoro REST + IMAP), secrets
# injected via the ANSWER seam under the explicit test flag, state in a
# sandbox HOME. No network.
#
# Covers (plan §3 M4/M6 acceptance):
#   N1  connector contract ×4: connect (hidden ask → 0600 .env) → probe →
#       pull returns non-sensitive summaries; one JSON line each
#   N1b connector CLI (flywheel-connector.sh): read-only verbs work, connect
#       NOT exposed, unknown system rejected
#   N2  JIT flow: systems_needed=[shopify,email] → both connected, prefetch
#       caches 0600 + secret-scan clean, connected_systems recorded
#   N3  unsupported system → HONEST path (requested_systems recorded, no
#       fake success)
#   N4  wrong key: connect fails → retry → give-up wording, NOT recorded as
#       connected
#   N5  demo channel: unreachable without FLYWHEEL_BUDDY_DEMO=1; with it the
#       cache comes from fixtures and is marked demo:true
#   N6  ≤60s budget: the whole JIT+prefetch path completes inside the
#       first-output budget (documents the orchestration contract)
#   N7  first-output skill installs into the project workspace
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly1023-connect-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
CS="$SANDBOX/curl-state"; mkdir -p "$CS"

cat > "$STUB_BIN/curl" <<EOF
#!/bin/bash
CS="$CS"
[ -t 0 ] || cat >/dev/null
url=""; req=""; prev=""
for a in "\$@"; do
  case "\$prev" in --request|-X) req="\$a" ;; esac
  case "\$a" in http*://*|imaps://*) url="\$a" ;; esac
  prev="\$a"
done
[ -f "\$CS/deny-all" ] && exit 22
case "\$url" in
  *myshopify*/admin/api/*/orders.json*|*qa-shop*/admin/api/*/orders.json*)
    printf '{"orders":[{"name":"#1234","financial_status":"pending","fulfillment_status":null,"created_at":"2026-07-08T09:00:00Z"},{"name":"#1235","financial_status":"paid","fulfillment_status":"fulfilled","created_at":"2026-07-08T10:12:00Z"}]}' ;;
  *api.veeqo.com/orders*)
    printf '[{"id":9,"number":"V-9","status":"awaiting_fulfillment","created_at":"2026-07-08"}]' ;;
  *api.ordoro.com/order*)
    printf '{"order":[{"order_number":"O-7","status":"in_process","order_placed_date":"2026-07-08"}]}' ;;
  imaps://*)
    case "\$req" in
      SEARCH*) printf '* SEARCH 1 2 3 4 5' ;;
      *) printf '' ;;
    esac ;;
  *) printf '{}' ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/curl"

ANSWERS=(
  FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION=1
  FLYWHEEL_SETUP_ANSWER_SHOPIFY_STORE_DOMAIN=qa-shop.myshopify.com
  FLYWHEEL_SETUP_ANSWER_SHOPIFY_TOKEN=fixture-shop-token-value
  FLYWHEEL_SETUP_ANSWER_VEEQO_KEY=fixture-veeqo-key-value
  FLYWHEEL_SETUP_ANSWER_ORDORO_KEY=user:fixture-ordoro-value
  FLYWHEEL_SETUP_ANSWER_IMAP_HOST=imap.test
  FLYWHEEL_SETUP_ANSWER_IMAP_USER=qa@test.example
  FLYWHEEL_SETUP_ANSWER_IMAP_APP_PASSWORD=fixture-app-pass-value
)

# run_connector <home> <module> <fn> — one connector function under the seam
run_connector() {
  local h="$1" module="$2" fn="$3"
  mkdir -p "$h/.flywheel"; chmod go-w "$h/.flywheel"
  env -i HOME="$h" USER=tester PATH="$STUB_BIN:$PATH" \
    FLYWHEEL_SETUP_STATE_DIR="$h/.flywheel" "${ANSWERS[@]}" \
    bash -c '
      export FLYWHEEL_SETUP_SOURCED=1
      source "'"$REPO_ROOT"'/scripts/flywheel-setup.sh" || exit 97
      source "'"$REPO_ROOT"'/scripts/lib/buddy-connectors/'"$2"'.sh" || exit 97
      '"$fn"'
    ' 2>/dev/null
}

# ── N1: contract ×4 ──
N1_OK=1
for m in shopify veeqo ordoro imap; do
  H="$SANDBOX/h-$m"
  OC="$(run_connector "$H" "$m" connector_connect)"; RCC=$?
  OP="$(run_connector "$H" "$m" connector_probe)"; RCP=$?
  OL="$(run_connector "$H" "$m" connector_pull)"; RCL=$?
  if [ "$RCC" -eq 0 ] && [ "$RCP" -eq 0 ] && [ "$RCL" -eq 0 ] \
     && [ "$(jq -r '.ok' <<<"$OC")" = "true" ] \
     && jq -e '.ok == true' >/dev/null 2>&1 <<<"$OL" \
     && [ "$(stat -c '%a' "$H/.flywheel/.env" 2>/dev/null || stat -f '%Lp' "$H/.flywheel/.env")" = "600" ]; then
    :
  else
    N1_OK=0; fail "N1 $m connect=$RCC/$OC probe=$RCP pull=$RCL/$OL"
  fi
done
[ "$N1_OK" -eq 1 ] && pass "N1 connector contract ×4: connect→0600 .env, probe ok, pull JSON summaries"

# ── N1b: read-only CLI ──
HCLI="$SANDBOX/h-shopify"   # already connected in N1
O_CLI="$(env -i HOME="$HCLI" USER=tester PATH="$STUB_BIN:$PATH" FLYWHEEL_SETUP_STATE_DIR="$HCLI/.flywheel" \
  bash "$REPO_ROOT/scripts/flywheel-connector.sh" shopify pull 2>/dev/null)"
O_BAD="$(env -i HOME="$HCLI" USER=tester PATH="$STUB_BIN:$PATH" \
  bash "$REPO_ROOT/scripts/flywheel-connector.sh" shopify connect 2>/dev/null)"; RC_BAD=$?
O_UNK="$(env -i HOME="$HCLI" USER=tester PATH="$STUB_BIN:$PATH" \
  bash "$REPO_ROOT/scripts/flywheel-connector.sh" tiktok pull 2>/dev/null)"; RC_UNK=$?
if jq -e '.ok == true and (.orders|length) >= 1' >/dev/null 2>&1 <<<"$O_CLI" \
   && [ "$RC_BAD" -ne 0 ] && [ "$RC_UNK" -ne 0 ]; then
  pass "N1b connector CLI: pull works; connect verb + unknown system rejected"
else
  fail "N1b cli='$O_CLI' bad=$RC_BAD unk=$RC_UNK"
fi

# ── JIT harness: sourced buddy shell + connect lib + stub steps CLI ──
STUB_STEPS="$SANDBOX/stub-steps.sh"
cat > "$STUB_STEPS" <<'EOF'
#!/bin/bash
set -u
SD="${FLYWHEEL_SETUP_STATE_DIR:-$HOME/.flywheel}"
mkdir -p "$SD"; J="$SD/setup-state.json"
[ -f "$J" ] || printf '{"version":2,"steps":{},"buddy":{}}\n' > "$J"
while [ $# -gt 0 ]; do case "$1" in --*) shift 2 ;; *) break ;; esac; done
cmd="${1:-}"; shift || true
case "$cmd" in
  state)
    sub="$1"; key="$2"
    case "$sub" in
      get) jq -c --arg k "$key" '{ok:true,key:$k,value:(.buddy[$k]//null)}' "$J" ;;
      set) val="$3"
           if v="$(jq -ce . <<<"$val" 2>/dev/null)"; then :; else v="$(jq -c --arg v "$val" -n '$v')"; fi
           jq --arg k "$key" --argjson v "$v" '.buddy[$k]=$v' "$J" > "$J.t" && mv "$J.t" "$J"
           printf '{"ok":true,"key":"%s"}\n' "$key" ;;
    esac ;;
  *) echo '{"ok":true}' ;;
esac
EOF
chmod +x "$STUB_STEPS"

run_jit() { # <home> <proposal-json> <answers-string> [extra env pairs...]
  local h="$1" proposal="$2" answers="$3"; shift 3
  mkdir -p "$h/.flywheel"; chmod go-w "$h/.flywheel"
  printf '%s' "$answers" | env -i HOME="$h" USER=tester PATH="$STUB_BIN:$PATH" \
    FLYWHEEL_SETUP_STATE_DIR="$h/.flywheel" \
    FLYWHEEL_BUDDY_STEPS_BIN="$STUB_STEPS" FLYWHEEL_BUDDY_NONINTERACTIVE=1 \
    FLYWHEEL_BUDDY_SOURCED=1 "${ANSWERS[@]}" "$@" \
    bash -c '
      prop="$1"; set --
      source "'"$REPO_ROOT"'/scripts/flywheel-buddy.sh" || exit 97
      source "'"$REPO_ROOT"'/scripts/lib/buddy-connect.sh" || exit 97
      buddy_connect_jit "$FB_STATE_DIR" "$prop"
    ' _ "$proposal" 2>&1
}

# ── N2 + N6: happy JIT (shopify + email) under the ≤60s budget ──
H2="$SANDBOX/h-jit"
T_START="$(date +%s)"
T2="$(run_jit "$H2" '{"systems_needed":["shopify","email"]}' "")"
RC2=$?
T_ELAPSED=$(( $(date +%s) - T_START ))
J2="$H2/.flywheel/setup-state.json"
CONN2="$(jq -c '.buddy.connected_systems' "$J2" 2>/dev/null)"
CACHE_S="$H2/.flywheel/buddy-cache/shopify.json"
CACHE_E="$H2/.flywheel/buddy-cache/email.json"
PERM_C="$(stat -c '%a' "$CACHE_S" 2>/dev/null || stat -f '%Lp' "$CACHE_S" 2>/dev/null)"
if [ "$RC2" -eq 0 ] && [ "$CONN2" = '["shopify","email"]' ] \
   && [ -f "$CACHE_S" ] && [ -f "$CACHE_E" ] && [ "$PERM_C" = "600" ] \
   && jq -e '(.orders|length) >= 1' "$CACHE_S" >/dev/null 2>&1 \
   && bash -c "source '$REPO_ROOT/scripts/lib/fleet-sanitize.sh'; scan_for_secrets '$H2/.flywheel/buddy-cache'" >/dev/null 2>&1; then
  pass "N2 JIT: shopify+email connected, prefetch caches 0600 + secret-scan clean"
else
  fail "N2 rc=$RC2 conn='$CONN2' perm=$PERM_C out: $(tail -3 <<<"$T2")"
fi
if [ "$T_ELAPSED" -lt 60 ]; then
  pass "N6 JIT+prefetch inside the 60s first-output budget (${T_ELAPSED}s)"
else
  fail "N6 elapsed=${T_ELAPSED}s"
fi

# ── N3: unsupported system → honest path ──
H3="$SANDBOX/h-honest"
T3="$(run_jit "$H3" '{"systems_needed":["tiktok"]}' "")"
RC3=$?
REQ3="$(jq -c '.buddy.requested_systems' "$H3/.flywheel/setup-state.json" 2>/dev/null)"
if [ "$RC3" -eq 0 ] && [ "$REQ3" = '["tiktok"]' ] && grep -q "先记下" <<<"$T3" \
   && [ "$(jq -c '.buddy.connected_systems // []' "$H3/.flywheel/setup-state.json")" = "[]" ]; then
  pass "N3 unsupported system: honest wording + requested_systems recorded, nothing faked"
else
  fail "N3 rc=$RC3 req='$REQ3' out: $(tail -2 <<<"$T3")"
fi

# ── N4: wrong key → retry → give-up, not connected ──
H4="$SANDBOX/h-deny"
touch "$CS/deny-all"
T4="$(run_jit "$H4" '{"systems_needed":["shopify"]}' $'\n')"
rm -f "$CS/deny-all"
# nothing connected → no state write at all: missing journal counts as empty
CONN4="$(jq -c '.buddy.connected_systems // []' "$H4/.flywheel/setup-state.json" 2>/dev/null || true)"
if { [ "$CONN4" = "[]" ] || [ -z "$CONN4" ]; } && grep -q "先放一放" <<<"$T4"; then
  pass "N4 wrong key: retried, gave up honestly, NOT recorded as connected"
else
  fail "N4 conn='$CONN4' out: $(tail -3 <<<"$T4")"
fi

# ── N5: demo channel gated behind the explicit env ──
H5A="$SANDBOX/h-demo-off"
touch "$CS/deny-all"
run_jit "$H5A" '{"systems_needed":["shopify"]}' $'\n' >/dev/null
rm -f "$CS/deny-all"
H5B="$SANDBOX/h-demo-on"
T5B="$(run_jit "$H5B" '{"systems_needed":["shopify"]}' "" FLYWHEEL_BUDDY_DEMO=1)"
if [ ! -f "$H5A/.flywheel/buddy-cache/shopify.json" ] \
   && [ "$(jq -r '.demo' "$H5B/.flywheel/buddy-cache/shopify.json" 2>/dev/null)" = "true" ] \
   && grep -q "演示模式" <<<"$T5B"; then
  pass "N5 demo channel: unreachable without the env; fixture cache marked demo:true with it"
else
  fail "N5 offCache=$([ -f "$H5A/.flywheel/buddy-cache/shopify.json" ] && echo present || echo absent) on=$(jq -c . "$H5B/.flywheel/buddy-cache/shopify.json" 2>/dev/null)"
fi

# ── N7: first-output skill install ──
H7="$SANDBOX/h-skill"; mkdir -p "$H7/.flywheel" "$H7/Dev/qa-conn"; chmod go-w "$H7/.flywheel"
jq -n --arg root "$H7/Dev/qa-conn" '[{projectName:"qa-conn", projectRoot:$root, leads:[]}]' > "$H7/.flywheel/projects.json"
env -i HOME="$H7" USER=tester PATH="$PATH" bash -c '
  source "'"$REPO_ROOT"'/scripts/lib/buddy-connect.sh" || exit 97
  fb_say() { :; }; fb_ask() { :; }; fb_gap() { :; }; fb_copy() { :; }; fb_state_set() { :; }
  buddy_install_first_output_skill "$HOME/.flywheel" qa-conn
' 2>/dev/null
if [ -f "$H7/Dev/qa-conn/.claude/skills/first-output/SKILL.md" ] \
   && grep -q "first-output" "$H7/Dev/qa-conn/.claude/skills/first-output/SKILL.md"; then
  pass "N7 first-output skill lands in the project workspace"
else
  fail "N7 skill missing"
fi

echo ""
echo "flywheel-buddy-connect.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
