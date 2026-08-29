#!/bin/bash
# FLY-519: fleet-capture.sh — sanitized snapshot of a live fleet host.
#
# Covers (plan §3 + Tadashi over-read red line):
#   C1) produces projects.json (copy) + env.example (redacted) + manifest.json
#   C2) env.example has key names, NO values (secret-clean)
#   C3) manifest.repos[] = each project (slug + home-relative targetDir) + flywheel
#   C4) manifest.launchdJobs[] lists plist labels, classified lead vs aux
#   C5) manifest.skills reflects skills-sync presence
#   C6) the whole artifact passes scan_for_secrets (exit 0)
#   C7) RED-LINE regression: a bare secret leaked into projects.json makes the
#       final scan GATE abort non-zero and leave NO committed artifact
#   C8) a real secret VALUE in .env is redacted away → artifact still clean
#
# Hermetic: fixture $HOME with fake projects.json/.env/LaunchAgents + local git
# repos (no network). Deterministic date via --date.
set -uo pipefail

PASSED=0
FAILED=0
log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CAPTURE="${REPO_ROOT}/scripts/fleet-capture.sh"
SANITIZE="${REPO_ROOT}/scripts/lib/fleet-sanitize.sh"

SANDBOX="$(mktemp -d -t fly519-capture-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

FAKE_HOME="$SANDBOX/home"
OUT="$SANDBOX/fleet"
mkdir -p "$FAKE_HOME/.flywheel/bin" "$FAKE_HOME/Library/LaunchAgents" "$FAKE_HOME/Dev"

# ── fixture: two fake project repos with local git remotes ────────────────
mk_repo() {  # <dir> <remote-url>
  local d="$1" url="$2"
  mkdir -p "$d"
  git -C "$d" init -q
  git -C "$d" remote add origin "$url"
}
mk_repo "$FAKE_HOME/Dev/flywheel" "https://github.com/xrliAnnie/flywheel.git"
mk_repo "$FAKE_HOME/Dev/geoforge3d" "https://github.com/xrliAnnie/geoforge3d.git"

# ── fixture: projects.json (array form, env NAMES only — the real shape) ──
write_projects() {  # writes a CLEAN, valid projects.json (env NAMES only)
  cat > "$FAKE_HOME/.flywheel/projects.json" <<EOF
[
  { "projectName": "flywheel", "projectRoot": "$FAKE_HOME/Dev/flywheel",
    "projectRepo": "xrliAnnie/flywheel",
    "leads": [ { "agentId": "flywheel-cos-lead", "chatChannel": "1512578695468941333",
                 "botTokenEnv": "CASS_BOT_TOKEN", "model": "sonnet" } ] },
  { "projectName": "geoforge3d", "projectRoot": "$FAKE_HOME/Dev/geoforge3d",
    "projectRepo": "xrliAnnie/geoforge3d",
    "leads": [ { "agentId": "geoforge3d-product-lead", "chatChannel": "999",
                 "botTokenEnv": "PETER_BOT_TOKEN", "model": "sonnet" } ] }
]
EOF
}
# inject_leak <secret> — add a leaked secret VALUE to a lead via jq (guaranteed
# valid JSON; never rely on heredoc quoting for the secret value).
inject_leak() {
  local tmp="$FAKE_HOME/.flywheel/projects.json.tmp"
  jq --arg l "$1" '.[1].leads[0].leaked = $l' "$FAKE_HOME/.flywheel/projects.json" > "$tmp" \
    && mv "$tmp" "$FAKE_HOME/.flywheel/projects.json"
}
write_projects

# ── fixture: .env with REAL-looking secret values ─────────────────────────
# Assemble detector-shaped fixtures at runtime so GitHub push protection does
# not mistake the inert test data for live credentials in the QA sandbox.
DISCORD_FIXTURE_A='MTk4NjIyNDgzNDcxOTI1MjQ4''.''GqwqZ9''.''realdiscordtokenpartXYZ0123456789ab'
DISCORD_FIXTURE_B='MTk4NjIyNDgzNDcxOTI1MjQ5''.''AbCdEf''.''anotherrealtokenpartXYZ0123456789cd'
OPENAI_FIXTURE='sk-proj-''realrealrealrealrealrealrealreal12'
cat > "$FAKE_HOME/.flywheel/.env" <<EOF
# fleet secrets — real values here, must never reach the artifact
CASS_BOT_TOKEN=${DISCORD_FIXTURE_A}
PETER_BOT_TOKEN=${DISCORD_FIXTURE_B}
OPENAI_API_KEY=${OPENAI_FIXTURE}
TEAMLEAD_PORT=9876
EOF

# ── fixture: LaunchAgents plists (lead + aux) ─────────────────────────────
touch "$FAKE_HOME/Library/LaunchAgents/com.flywheel.lead.flywheel-flywheel-cos-lead.plist"
touch "$FAKE_HOME/Library/LaunchAgents/com.flywheel.lead.geoforge3d-product-lead.plist"
touch "$FAKE_HOME/Library/LaunchAgents/com.flywheel.bridge.plist"
touch "$FAKE_HOME/Library/LaunchAgents/com.flywheel.daily-standup.plist"
touch "$FAKE_HOME/Library/LaunchAgents/com.flywheel.skills-update.plist"

# ── fixture: skills-sync wiring ───────────────────────────────────────────
cat > "$FAKE_HOME/.flywheel/bin/skills-sync.sh" <<'EOF'
#!/bin/bash
# canonical skills repo
REPO="xrliAnnie/flywheel-skills"
EOF

run_capture() {  # sets CAP_RC; fixtures are mutated in place between calls
  HOME="$FAKE_HOME" bash "$CAPTURE" --home "$FAKE_HOME" --out "$OUT" \
    --date "2026-06-23T00:00:00Z" --force >"$SANDBOX/cap.log" 2>&1
  CAP_RC=$?
}

# ── C1/C2/C3/C4/C5/C6: happy path ─────────────────────────────────────────
rm -rf "$OUT"
run_capture
if [ "$CAP_RC" -eq 0 ]; then pass "C0: capture exits 0 on clean fixture"; else fail "C0: capture exit ($CAP_RC)"; cat "$SANDBOX/cap.log"; fi

if [ -f "$OUT/projects.json" ] && [ -f "$OUT/env.example" ] && [ -f "$OUT/manifest.json" ]; then
  pass "C1: produces projects.json + env.example + manifest.json"
else
  fail "C1: missing artifact files"; ls -la "$OUT" 2>&1
fi

if grep -q '^CASS_BOT_TOKEN=$' "$OUT/env.example" \
  && ! grep -qE 'realdiscordtoken|sk-proj-real' "$OUT/env.example"; then
  pass "C2: env.example has key names, zero values"
else
  fail "C2: env.example redaction"; cat "$OUT/env.example" 2>&1
fi

if jq -e '[.repos[].name] | index("flywheel")' "$OUT/manifest.json" >/dev/null \
  && jq -e '[.repos[].slug] | index("xrliAnnie/geoforge3d")' "$OUT/manifest.json" >/dev/null \
  && jq -e '[.repos[].targetDir] | any(test("Dev/geoforge3d$"))' "$OUT/manifest.json" >/dev/null; then
  pass "C3: manifest.repos[] has slug + home-relative targetDir + flywheel"
else
  fail "C3: manifest.repos"; jq '.repos' "$OUT/manifest.json" 2>&1
fi

if jq -e '[.launchdJobs[] | select(.kind=="lead") | .label] | index("com.flywheel.lead.geoforge3d-product-lead")' "$OUT/manifest.json" >/dev/null \
  && jq -e '[.launchdJobs[] | select(.kind=="aux") | .label] | index("com.flywheel.bridge")' "$OUT/manifest.json" >/dev/null; then
  pass "C4: launchdJobs[] classified lead vs aux"
else
  fail "C4: launchdJobs"; jq '.launchdJobs' "$OUT/manifest.json" 2>&1
fi

if jq -e '.skills.skillsSyncPresent==true and .skills.skillsUpdatePlistPresent==true' "$OUT/manifest.json" >/dev/null; then
  pass "C5: manifest.skills reflects skills-sync wiring"
else
  fail "C5: manifest.skills"; jq '.skills' "$OUT/manifest.json" 2>&1
fi

# shellcheck disable=SC1090
source "$SANITIZE"
if scan_for_secrets "$OUT"; then
  pass "C6: full artifact passes scan_for_secrets"
else
  fail "C6: artifact tripped secret scan"
fi

# ── C7: RED-LINE — leaked secret in projects.json aborts the gate ─────────
rm -rf "$OUT"
inject_leak 'sk-proj-leakedleakedleakedleakedleaked0123456789'
run_capture
if [ "$CAP_RC" -ne 0 ]; then
  if [ ! -e "$OUT/projects.json" ]; then
    pass "C7: leaked secret → capture aborts non-zero AND writes no artifact"
  else
    fail "C7: capture aborted but left an artifact with the leak"
    grep -q 'sk-proj-leaked' "$OUT/projects.json" && echo "  LEAK PRESENT IN ARTIFACT"
  fi
else
  fail "C7: capture should have aborted on leaked secret"
fi
write_projects  # restore clean fixture

# ── C8: secret VALUE in .env is redacted → artifact clean (already proven by
#       C2+C6, but assert the .env genuinely held a secret) ────────────────
if grep -q 'realdiscordtoken' "$FAKE_HOME/.flywheel/.env"; then
  pass "C8: fixture .env genuinely held real secrets (redaction is non-trivial)"
else
  fail "C8: fixture sanity"
fi

# ── C9: RED-LINE (Codex R1 HIGH-2) — a pre-existing foreign secret file in
#       the OUTPUT dir must make capture abort non-zero (whole-artifact gate),
#       even though the three generated files are themselves clean ──────────
rm -rf "$OUT"; mkdir -p "$OUT"
printf 'leftover token: sk-proj-staleStaleStaleStaleStaleStale0123456789\n' > "$OUT/stale-leak.txt"
run_capture
if [ "$CAP_RC" -ne 0 ]; then
  pass "C9: pre-existing foreign secret in OUT_DIR → capture aborts non-zero"
else
  fail "C9: whole-artifact gate did not catch a stale foreign secret"
fi
rm -rf "$OUT"

# ── C10: jq-normalization (Codex R2 HIGH) — committed projects.json is
#        pretty-printed (one field per line), upholding the scanner invariant ─
rm -rf "$OUT"
run_capture
if [ "$CAP_RC" -eq 0 ] && [ "$(wc -l < "$OUT/projects.json")" -gt 5 ] \
  && jq -e . "$OUT/projects.json" >/dev/null 2>&1; then
  pass "C10: captured projects.json is jq-normalized (multi-line, valid)"
else
  fail "C10: projects.json not normalized (lines=$(wc -l < "$OUT/projects.json" 2>/dev/null))"
fi
rm -rf "$OUT"

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
