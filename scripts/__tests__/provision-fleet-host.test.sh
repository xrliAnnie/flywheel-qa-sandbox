#!/bin/bash
# FLY-519: provision-fleet-host.sh — phased, idempotent, dry-run-default
# provisioning with a token gate and a live-fleet safety guard.
#
# Covers (plan §4 + Tadashi red lines):
#   P0) dry-run default makes NO changes (no .env, no projects.json written)
#   P1) dry-run prints a plan covering the phases
#   P2) --apply --skip-token-check materializes ~/.flywheel (projects.json + .env
#       placeholder); second run is idempotent (no error, converges)
#   P3) token GATE: placeholder .env → tokens/launchd phase aborts non-zero;
#       real values → passes
#   P4) live-fleet GUARD: --apply on a home with existing leads + no --force → refuse
#   P5) validate_tokens unit: secret-named keys enforced, non-secret ignored,
#       placeholders rejected
#
# Hermetic: fixture HOME + fixture fleet artifact + fixture repo-root with stub
# scripts. External binaries (brew/git/launchctl/curl/pnpm) stubbed on PATH.
set -uo pipefail

PASSED=0
FAILED=0
log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROVISION="${REPO_ROOT}/scripts/provision-fleet-host.sh"

SANDBOX="$(mktemp -d -t fly519-provision-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── stub PATH (record-and-succeed for external effects) ───────────────────
STUB_BIN="$SANDBOX/stubbin"
mkdir -p "$STUB_BIN"
for b in brew git launchctl curl pnpm; do
  cat > "$STUB_BIN/$b" <<EOF
#!/bin/bash
echo "[stub:$b] \$*" >> "$SANDBOX/stub-calls.log"
exit 0
EOF
  chmod +x "$STUB_BIN/$b"
done
export PATH="$STUB_BIN:$PATH"

# FLY-650: this is the DARWIN provisioning test (it predates platform-awareness and
# asserts the launchd/narrate flow with a stub fixture repo). Force darwin so it is
# deterministic on any CI host — on linux the supervisor phase would actually run
# materialize-lead-manifests.sh + supervisor_install, which the stub fixture lacks.
# The linux supervisor path (real repo-root + stubbed systemctl) is covered by
# provision-linux.test.sh.
export FLYWHEEL_PLATFORM=darwin

# ── fixture fleet artifact ────────────────────────────────────────────────
FLEET="$SANDBOX/fleet"
mkdir -p "$FLEET"
cat > "$FLEET/projects.json" <<'EOF'
[ { "projectName": "flywheel", "projectRoot": "Dev/flywheel", "projectRepo": "xrliAnnie/flywheel",
    "leads": [ { "agentId": "flywheel-cos-lead", "botTokenEnv": "CASS_BOT_TOKEN", "model": "sonnet" } ] } ]
EOF
cat > "$FLEET/env.example" <<'EOF'
# fleet tokens
CASS_BOT_TOKEN=
TEAMLEAD_PORT=
EOF
cat > "$FLEET/manifest.json" <<'EOF'
{ "schemaVersion": 1, "meta": { "capturedAt": "2026-06-23T00:00:00Z" },
  "deps": [ { "name": "jq", "channel": "brew", "formula": "jq" } ],
  "repos": [ { "name": "flywheel", "slug": "xrliAnnie/flywheel", "targetDir": "Dev/flywheel" } ],
  "launchdJobs": [ { "label": "com.flywheel.bridge", "kind": "aux" },
                   { "label": "com.flywheel.lead.flywheel-flywheel-cos-lead", "kind": "lead" } ],
  "skills": { "skillsSyncPresent": true, "skillsUpdatePlistPresent": true, "canonicalRepo": "xrliAnnie/flywheel-skills" } }
EOF

# ── fixture repo-root with stub scripts ───────────────────────────────────
RR="$SANDBOX/repo"
mkdir -p "$RR/scripts/launchd" "$RR/scripts/lib"
for f in flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh; do
  echo '#!/bin/bash' > "$RR/scripts/$f"; chmod +x "$RR/scripts/$f"
done
echo '#!/bin/bash' > "$RR/scripts/flywheel-fleet.sh"; chmod +x "$RR/scripts/flywheel-fleet.sh"
echo '# lib' > "$RR/scripts/lib/fleet-sanitize.sh"
echo '# bridge plist' > "$RR/scripts/launchd/com.flywheel.bridge.plist"
echo '# setup' > "$RR/scripts/lib/setup.ts"

run_prov() {  # args... ; sets PROV_RC + writes PROV_LOG
  HOME="$1"; shift
  HOME="$HOME" bash "$PROVISION" --repo-root "$RR" --fleet-dir "$FLEET" "$@" \
    >"$SANDBOX/prov.log" 2>&1
  PROV_RC=$?
  PROV_LOG="$SANDBOX/prov.log"
}

# ── P0/P1: dry-run default = no changes ───────────────────────────────────
H0="$SANDBOX/home0"; mkdir -p "$H0"
run_prov "$H0"
if [ "$PROV_RC" -eq 0 ]; then pass "P0a: dry-run exits 0"; else fail "P0a: dry-run exit $PROV_RC"; cat "$PROV_LOG"; fi
if [ ! -f "$H0/.flywheel/.env" ] && [ ! -f "$H0/.flywheel/projects.json" ]; then
  pass "P0b: dry-run wrote NO ~/.flywheel state"
else
  fail "P0b: dry-run made changes"; find "$H0/.flywheel" 2>/dev/null
fi
if grep -q '\[dry-run\] would:' "$PROV_LOG" && grep -q 'phase: launchd' "$PROV_LOG"; then
  pass "P1: dry-run prints a plan across phases"
else
  fail "P1: dry-run plan output"; tail -20 "$PROV_LOG"
fi

# ── P2: --apply --skip-token-check materializes + idempotent ──────────────
H2="$SANDBOX/home2"; mkdir -p "$H2"
run_prov "$H2" --apply --skip-token-check
if [ "$PROV_RC" -eq 0 ] && [ -f "$H2/.flywheel/projects.json" ] && [ -f "$H2/.flywheel/.env" ]; then
  pass "P2a: apply materializes projects.json + placeholder .env"
else
  fail "P2a: apply materialize (rc=$PROV_RC)"; tail -20 "$PROV_LOG"
fi
# second run — idempotent (keeps existing projects.json, no error)
cp "$H2/.flywheel/projects.json" "$SANDBOX/p2-before.json"
run_prov "$H2" --apply --skip-token-check --force
if [ "$PROV_RC" -eq 0 ]; then
  pass "P2b: re-apply is idempotent (exit 0)"
else
  fail "P2b: re-apply failed (rc=$PROV_RC)"; tail -20 "$PROV_LOG"
fi

# ── P3: token gate ────────────────────────────────────────────────────────
H3="$SANDBOX/home3"; mkdir -p "$H3/.flywheel"
cp "$FLEET/env.example" "$H3/.flywheel/.env"   # placeholder values (empty)
run_prov "$H3" --apply --only tokens
if [ "$PROV_RC" -ne 0 ]; then
  pass "P3a: placeholder tokens → tokens phase aborts non-zero"
else
  fail "P3a: token gate did not fire"; tail -10 "$PROV_LOG"
fi
# fill the secret-named token → passes
cat > "$H3/.flywheel/.env" <<'EOF'
CASS_BOT_TOKEN=QA_SCRATCH_NOT_A_TOKEN_DISCORD
TEAMLEAD_PORT=
EOF
run_prov "$H3" --apply --only tokens
if [ "$PROV_RC" -eq 0 ]; then
  pass "P3b: real token value → tokens phase passes"
else
  fail "P3b: tokens phase should pass with real value"; tail -10 "$PROV_LOG"
fi
# launchd phase also gated
cp "$FLEET/env.example" "$H3/.flywheel/.env"
run_prov "$H3" --apply --only launchd
if [ "$PROV_RC" -ne 0 ]; then
  pass "P3c: launchd phase token-gated (refuses on placeholder)"
else
  fail "P3c: launchd token gate did not fire"; tail -10 "$PROV_LOG"
fi

# ── P4: live-fleet guard ──────────────────────────────────────────────────
H4="$SANDBOX/home4"; mkdir -p "$H4/.flywheel"
cat > "$H4/.flywheel/projects.json" <<'EOF'
[ { "projectName": "x", "leads": [ { "agentId": "a" }, { "agentId": "b" } ] } ]
EOF
run_prov "$H4" --apply --only preflight
if [ "$PROV_RC" -ne 0 ] && grep -q 'live fleet detected' "$PROV_LOG"; then
  pass "P4a: --apply on live fleet refused without --force"
else
  fail "P4a: live-fleet guard"; tail -10 "$PROV_LOG"
fi
run_prov "$H4" --apply --only preflight --force
if [ "$PROV_RC" -eq 0 ]; then
  pass "P4b: --force overrides live-fleet guard"
else
  fail "P4b: --force should allow"; tail -10 "$PROV_LOG"
fi

# ── P6: RED-LINE (Codex R1 HIGH-3) — a failing phase command must abort the
#       run non-zero and NOT print the final "done." ────────────────────────
STUBFAIL="$SANDBOX/stubfail"
mkdir -p "$STUBFAIL"
cat > "$STUBFAIL/git" <<EOF
#!/bin/bash
echo "[stubfail:git] \$* (forced failure)" >&2
exit 7
EOF
chmod +x "$STUBFAIL/git"
H6="$SANDBOX/home6"; mkdir -p "$H6"
PATH="$STUBFAIL:$PATH" HOME="$H6" bash "$PROVISION" --repo-root "$RR" --fleet-dir "$FLEET" \
  --home "$H6" --apply --skip-token-check --only repos >"$SANDBOX/prov6.log" 2>&1
P6RC=$?
if [ "$P6RC" -ne 0 ] && ! grep -q '\[provision\] done\.' "$SANDBOX/prov6.log"; then
  pass "P6: failing git clone aborts provision non-zero, no 'done.' printed"
else
  fail "P6: phase failure was swallowed (rc=$P6RC)"; tail -10 "$SANDBOX/prov6.log"
fi

# ── P7: RED-LINE (Codex R2 MEDIUM) — validate must FAIL non-zero when a
#       Bridge/launchd health check fails (not silently print done/exit 0) ────
STUBVFAIL="$SANDBOX/stubvfail"
mkdir -p "$STUBVFAIL"
for b in curl launchctl; do
  cat > "$STUBVFAIL/$b" <<EOF
#!/bin/bash
exit 1
EOF
  chmod +x "$STUBVFAIL/$b"
done
H7="$SANDBOX/home7"; mkdir -p "$H7"
PATH="$STUBVFAIL:$PATH" HOME="$H7" bash "$PROVISION" --repo-root "$RR" --fleet-dir "$FLEET" \
  --home "$H7" --apply --only validate >"$SANDBOX/prov7.log" 2>&1
P7RC=$?
if [ "$P7RC" -ne 0 ]; then
  pass "P7: failed Bridge/launchd checks → validate phase aborts non-zero"
else
  fail "P7: validate swallowed health-check failures (rc=$P7RC)"; tail -8 "$SANDBOX/prov7.log"
fi

# ── P5: validate_tokens unit ──────────────────────────────────────────────
export PROVISION_FLEET_SOURCED=1
# shellcheck disable=SC1090
source "$PROVISION"
EX="$SANDBOX/p5.example"; EV="$SANDBOX/p5.env"
printf 'CASS_BOT_TOKEN=\nOPENAI_API_KEY=\nTEAMLEAD_PORT=\n' > "$EX"
printf 'CASS_BOT_TOKEN=realvalue123\nOPENAI_API_KEY=sk-real\nTEAMLEAD_PORT=\n' > "$EV"
if validate_tokens "$EX" "$EV"; then
  pass "P5a: all secret keys filled + non-secret empty → OK"
else
  fail "P5a: validate_tokens false-negative"
fi
printf 'CASS_BOT_TOKEN=realvalue123\nOPENAI_API_KEY=__PLACEHOLDER__\nTEAMLEAD_PORT=\n' > "$EV"
if validate_tokens "$EX" "$EV" 2>/dev/null; then
  fail "P5b: placeholder secret value should fail"
else
  pass "P5b: placeholder secret value rejected"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
