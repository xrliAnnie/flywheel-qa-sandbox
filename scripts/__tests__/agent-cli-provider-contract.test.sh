#!/bin/bash
# FLY-1023 M0: AgentCliProvider contract test — executable form of
# scripts/lib/agent-cli-providers/CONTRACT.md.
#
# The harness (assert_contract_fn) checks the invariant surface every
# provider must honor: one JSON line on stdout, {ok, provider} fields,
# semantic exit codes. M0 proves the harness against an inline stub
# provider; M1 points the SAME assertions at the real claude.sh (stubbed
# PATH — no network, no real install) and the codex.sh placeholder.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROVIDER_DIR="$REPO_ROOT/scripts/lib/agent-cli-providers"
[ -f "$PROVIDER_DIR/CONTRACT.md" ] || { echo "ERROR: CONTRACT.md missing"; exit 1; }

SANDBOX="$(mktemp -d -t fly1023-provider-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# assert_contract_fn <label> <provider-file> <fn> <want-rc> <jq-expr> [args...]
#   Sources <provider-file> in a clean subshell, runs <fn> with [args...],
#   asserts: exit == want-rc, stdout is EXACTLY one line, it jq-parses, and
#   <jq-expr> evaluates truthy on it.
assert_contract_fn() {
  local label="$1" file="$2" fn="$3" want_rc="$4" expr="$5"; shift 5
  local out rc lines
  out="$(
    env -i HOME="$SANDBOX/home" USER=tester PATH="${CONTRACT_PATH:-$PATH}" \
      bash -c "source '$file' || exit 97; $fn \"\$@\"" _ "$@" 2>/dev/null
  )"
  rc=$?
  lines="$(printf '%s' "$out" | grep -c . || true)"
  if [ "$rc" -eq "$want_rc" ] && [ "$lines" -eq 1 ] \
     && jq -e . >/dev/null 2>&1 <<<"$out" \
     && jq -e "$expr" >/dev/null 2>&1 <<<"$out"; then
    pass "$label"
  else
    fail "$label rc=$rc(want $want_rc) lines=$lines out='$out'"
  fi
}

# assert_silent_fn <label> <provider-file> <fn> <want-rc> [args...]
# Internal provider launch seams do not emit the public one-line envelope, but
# their stubbed CLI argv is still executable behavior worth pinning.
assert_silent_fn() {
  local label="$1" file="$2" fn="$3" want_rc="$4"; shift 4
  local rc
  env -i HOME="$SANDBOX/home" USER=tester PATH="${CONTRACT_PATH:-$PATH}" \
    bash -c "source '$file' || exit 97; $fn \"\$@\"" _ "$@" \
    >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq "$want_rc" ]; then
    pass "$label"
  else
    fail "$label rc=$rc(want $want_rc)"
  fi
}

mkdir -p "$SANDBOX/home"

# ── fixture: a minimal fully-conforming stub provider ───────────────────────
STUB="$SANDBOX/stub-provider.sh"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
provider_id()          { jq -nc '{ok:true, provider:"stub"}'; }
provider_detect()      {
  if command -v stubcli >/dev/null 2>&1; then
    jq -nc '{ok:true, provider:"stub", found:true, version:"9.9.9"}'
  else
    jq -nc '{ok:false, provider:"stub", found:false, error_code:"not_found"}'; return 1
  fi
}
provider_install()     { jq -nc '{ok:true, provider:"stub", version:"9.9.9"}'; }
provider_login_guide() { jq -nc '{ok:true, provider:"stub", login:"ok"}'; }
provider_smoke()       { jq -nc '{ok:true, provider:"stub", smoke:"ok"}'; }
provider_start_buddy() { jq -nc --arg p "$1" --arg q "$2" '{ok:true, provider:"stub", reply:"hi", session_id:"s1"}'; }
provider_resume()      { jq -nc --arg s "$1" '{ok:true, provider:"stub", reply:"again", session_id:$s}'; }
provider_repair()      { jq -nc '{ok:true, provider:"stub", repaired:false}'; }
EOF

# PATH for stub runs: jq + coreutils only (no stubcli → detect misses).
CONTRACT_BIN="$SANDBOX/bin"; mkdir -p "$CONTRACT_BIN"
for t in jq bash grep sed env dirname mktemp cat chmod mv rm head tail tr sleep; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$CONTRACT_BIN/$t"
done
CONTRACT_PATH="$CONTRACT_BIN"

PERSONA="$SANDBOX/persona.md"; echo "you are buddy" > "$PERSONA"
PROMPT="$SANDBOX/prompt.md"; echo "hello" > "$PROMPT"

# ── harness proves the contract shape on the stub ───────────────────────────
assert_contract_fn "H1 stub provider_id" "$STUB" provider_id 0 '.ok==true and .provider=="stub"'
assert_contract_fn "H2 stub provider_detect (CLI absent → exit 1 + not_found)" "$STUB" provider_detect 1 '.ok==false and .found==false and .error_code=="not_found"'
printf '#!/bin/bash\nexit 0\n' > "$CONTRACT_BIN/stubcli"; chmod +x "$CONTRACT_BIN/stubcli"
assert_contract_fn "H3 stub provider_detect (CLI present → found+version)" "$STUB" provider_detect 0 '.ok==true and .found==true and (.version|length>0)'
assert_contract_fn "H4 stub provider_install" "$STUB" provider_install 0 '.ok==true and (.version|length>0)'
assert_contract_fn "H5 stub provider_login_guide" "$STUB" provider_login_guide 0 '.ok==true and .login=="ok"'
assert_contract_fn "H6 stub provider_smoke" "$STUB" provider_smoke 0 '.ok==true and .smoke=="ok"'
assert_contract_fn "H7 stub provider_start_buddy(persona,prompt)" "$STUB" provider_start_buddy 0 '.ok==true and (.reply|length>0) and (.session_id|length>0)' "$PERSONA" "$PROMPT"
assert_contract_fn "H8 stub provider_resume(session,prompt)" "$STUB" provider_resume 0 '.ok==true and .session_id=="s1"' "s1" "$PROMPT"
assert_contract_fn "H9 stub provider_repair" "$STUB" provider_repair 0 '.ok==true'

# FLY-1715: the packaged Buddy cannot import the TypeScript constant at
# runtime, so pin its unavoidable per-launch copy to the canonical key set.
if python3 - "$REPO_ROOT" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
canonical_text = (root / "packages/config/src/non-lead-forbidden-plugins.ts").read_text()
canonical_block = re.search(
    r"NON_LEAD_FORBIDDEN_PLUGINS\s*=\s*\[(.*?)\]\s*as const",
    canonical_text,
    re.S,
)
assert canonical_block is not None
canonical = set(re.findall(r'"([^"]+)"', canonical_block.group(1)))
assert canonical

buddy_text = (root / "scripts/lib/agent-cli-providers/claude.sh").read_text()
buddy_match = re.search(r"readonly ACP_NON_LEAD_SETTINGS='([^']+)'", buddy_text)
assert buddy_match is not None
buddy_payload = json.loads(buddy_match.group(1))
buddy_plugins = buddy_payload.get("enabledPlugins")
assert isinstance(buddy_plugins, dict)
assert all(value is False for value in buddy_plugins.values())

assert set(buddy_plugins) == canonical
PY
then
  pass "C0 Buddy per-launch Discord deny matches the canonical TypeScript key set"
else
  fail "C0 Buddy per-launch Discord deny drifted from the canonical TypeScript key set"
fi

# ── M1: the real claude.sh against a stubbed PATH ───────────────────────────
CLAUDE_SH="$PROVIDER_DIR/claude.sh"
if [ -f "$CLAUDE_SH" ]; then
  # claude CLI stub: --version, --print (echo a reply), plain run = login flow.
  # FLY-1715: every model-bearing --print call must carry exactly one inline
  # settings payload with both Discord marketplace identities disabled.
  cat > "$CONTRACT_BIN/claude" <<'EOF'
#!/bin/bash
[ -t 0 ] || cat >/dev/null
is_print=false
is_login=false
settings_count=0
settings_value=""
take_settings=false
for a in "$@"; do
  if [ "$take_settings" = true ]; then
    settings_count=$((settings_count + 1))
    settings_value="$a"
    take_settings=false
    continue
  fi
  case "$a" in
    --version) echo "9.9.9 (Claude Code)"; exit 0 ;;
    --print) is_print=true ;;
    /login) is_login=true ;;
    --settings) take_settings=true ;;
    --settings=*) settings_count=$((settings_count + 1)); settings_value="${a#--settings=}" ;;
  esac
done
if [ "$is_print" = true ] || [ "$is_login" = true ]; then
  [ "$take_settings" = false ] || exit 42
  [ "$settings_count" -eq 1 ] || exit 43
  jq -e '.enabledPlugins["discord@flywheel-plugins"] == false and .enabledPlugins["discord@claude-plugins-official"] == false' \
    >/dev/null 2>&1 <<<"$settings_value" || exit 44
  if [ "$is_print" = true ]; then
    printf '{"result":"stub reply","session_id":"sess-1234"}\n'
  fi
  exit 0
fi
exit 0
EOF
  chmod +x "$CONTRACT_BIN/claude"
  mkdir -p "$SANDBOX/home/.claude"
  assert_contract_fn "C1 claude provider_id" "$CLAUDE_SH" provider_id 0 '.ok==true and .provider=="claude"'
  assert_contract_fn "C2 claude provider_detect (stub claude on PATH)" "$CLAUDE_SH" provider_detect 0 '.ok==true and .found==true and (.version|length>0)'
  assert_contract_fn "C3 claude provider_smoke disables both Discord plugins" "$CLAUDE_SH" provider_smoke 0 '.ok==true and .smoke=="ok"'
  assert_contract_fn "C4 claude provider_start_buddy disables both Discord plugins" "$CLAUDE_SH" provider_start_buddy 0 '.ok==true and (.reply|length>0) and (.session_id|length>0)' "$PERSONA" "$PROMPT"
  assert_contract_fn "C5 claude provider_resume disables both Discord plugins" "$CLAUDE_SH" provider_resume 0 '.ok==true and (.reply|length>0)' "sess-1234" "$PROMPT"
  assert_silent_fn "C6 claude login boot disables both Discord plugins" "$CLAUDE_SH" _acp_login_cli 0
  rm -f "$CONTRACT_BIN/claude"
  assert_contract_fn "C7 claude provider_detect (no CLI → exit 1 + not_found)" "$CLAUDE_SH" provider_detect 1 '.ok==false and .error_code=="not_found"'
else
  echo "[TEST] (claude.sh not present yet — M1 section skipped)"
fi

# ── M1: codex.sh must be an HONEST not-implemented placeholder ──────────────
CODEX_SH="$PROVIDER_DIR/codex.sh"
if [ -f "$CODEX_SH" ]; then
  assert_contract_fn "X1 codex provider_detect → not_implemented" "$CODEX_SH" provider_detect 1 '.ok==false and .error_code=="not_implemented"'
  assert_contract_fn "X2 codex provider_start_buddy → not_implemented" "$CODEX_SH" provider_start_buddy 1 '.ok==false and .error_code=="not_implemented"' "$PERSONA" "$PROMPT"
else
  echo "[TEST] (codex.sh not present yet — placeholder section skipped)"
fi

echo ""
echo "agent-cli-provider-contract.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
