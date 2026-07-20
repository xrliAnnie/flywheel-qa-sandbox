#!/bin/bash
# FLY-1389 P1-b#3/#4/#5: writer guards on the remaining global-persistence
# installers —
#   IH1-IH5  install-hooks.sh: trusted clean-install / content update +
#            idempotent rerun / legacy checkout-path entry migration /
#            exec-mode repair / worktree-source refusal (zero global writes)
#   CM1-CM2  flywheel-cmux-install.sh: worktree refusal / trusted install
#   PV1-PV2  provision-fleet-host.sh: effective-global + worktree → die
#            BEFORE phases; explicit fake --home stays allowed
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; }

REAL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RSB="$(mktemp -d "${TESTS_DIR}/.tmp-writer-guards-XXXXXX")"
SB="$(mktemp -d /tmp/fly1389-writers-XXXXXX)"
trap 'rm -rf "$RSB" "$SB"' EXIT

make_repo() {  # <dir> <gitshape: dir|file>
  local fr="$1"
  mkdir -p "$fr/scripts/lib" "$fr/scripts/hooks"
  cp "$REAL_REPO_ROOT/scripts/lib/path-hygiene.sh" "$fr/scripts/lib/"
  cp "$REAL_REPO_ROOT/scripts/install-hooks.sh" "$fr/scripts/"
  printf '#!/bin/bash\necho session-end v1\n' > "$fr/scripts/hooks/flywheel-session-end.sh"
  if [ "$2" = "dir" ]; then mkdir -p "$fr/.git"; else echo "gitdir: /main/.git/worktrees/x" > "$fr/.git"; fi
}
TRUSTED="$RSB/trusted"; make_repo "$TRUSTED" dir
WORKTREE="$RSB/worktree"; make_repo "$WORKTREE" file

# ── IH1: trusted clean install ──
H="$SB/h1"; mkdir -p "$H"
if HOME="$H" bash "$TRUSTED/scripts/install-hooks.sh" >/dev/null 2>&1; then
  IH1_OK=1
  ST="$H/.claude/settings.json"; SH="$H/.flywheel/hooks/flywheel-session-end.sh"
  [[ -f "$SH" && -x "$SH" ]] || { IH1_OK=0; fail "IH1: stable hook copy missing/not executable"; }
  [[ "$(jq '.hooks.SessionEnd | length' "$ST")" == "1" ]] || { IH1_OK=0; fail "IH1: expected exactly one SessionEnd entry"; }
  [[ "$(jq -r '.hooks.SessionEnd[0].hooks[0].command' "$ST")" == "$SH" ]] || { IH1_OK=0; fail "IH1: command must be the STABLE path" "$(jq -c . "$ST")"; }
  [[ "$IH1_OK" == "1" ]] && pass "IH1: trusted clean install → stable copy (0755) + one stable-path entry"
else
  fail "IH1: trusted install failed"
fi

# ── IH2: content update + idempotent rerun ──
printf '#!/bin/bash\necho session-end v2\n' > "$TRUSTED/scripts/hooks/flywheel-session-end.sh"
HOME="$H" bash "$TRUSTED/scripts/install-hooks.sh" >/dev/null 2>&1
HOME="$H" bash "$TRUSTED/scripts/install-hooks.sh" >/dev/null 2>&1
IH2_OK=1
grep -q "v2" "$H/.flywheel/hooks/flywheel-session-end.sh" || { IH2_OK=0; fail "IH2: stable copy not updated"; }
[[ "$(jq '.hooks.SessionEnd | length' "$H/.claude/settings.json")" == "1" ]] || { IH2_OK=0; fail "IH2: rerun duplicated entries"; }
[[ "$IH2_OK" == "1" ]] && pass "IH2: content update deployed + double rerun keeps exactly one entry"

# ── IH3: legacy checkout-path entry replaced; unrelated hooks preserved —
# including a SIBLING sharing the SAME group as a legacy entry (Codex code
# R1 MED-1: a group-level filter would delete it) ──
H="$SB/h3"; mkdir -p "$H/.claude"
jq -n '{"hooks":{"SessionEnd":[
  {"hooks":[
    {"type":"command","command":"/old/worktree/checkout/scripts/hooks/flywheel-session-end.sh"},
    {"type":"command","command":"/usr/local/bin/same-group-sibling.sh"}
  ]},
  {"hooks":[{"type":"command","command":"/usr/local/bin/unrelated-hook.sh"}]}
]}}' > "$H/.claude/settings.json"
HOME="$H" bash "$TRUSTED/scripts/install-hooks.sh" >/dev/null 2>&1
IH3_OK=1
ST="$H/.claude/settings.json"
grep -q "/old/worktree/checkout" "$ST" && { IH3_OK=0; fail "IH3: legacy checkout-path entry survived"; }
jq -e '[.hooks.SessionEnd[].hooks[].command] | index("/usr/local/bin/unrelated-hook.sh")' "$ST" >/dev/null \
  || { IH3_OK=0; fail "IH3: unrelated SessionEnd hook was dropped"; }
jq -e '[.hooks.SessionEnd[].hooks[].command] | index("/usr/local/bin/same-group-sibling.sh")' "$ST" >/dev/null \
  || { IH3_OK=0; fail "IH3: same-group sibling hook was dropped (group-level filter regression)"; }
[[ "$(jq '[.hooks.SessionEnd[].hooks[].command | select(endswith("/flywheel-session-end.sh"))] | length' "$ST")" == "1" ]] \
  || { IH3_OK=0; fail "IH3: expected exactly one flywheel-session-end entry"; }
[[ "$IH3_OK" == "1" ]] && pass "IH3: legacy entry migrated; unrelated + same-group sibling hooks preserved"

# ── IH4: exec-mode — 0644 source still deploys 0755 ──
H="$SB/h4"; mkdir -p "$H"
chmod 0644 "$TRUSTED/scripts/hooks/flywheel-session-end.sh"
HOME="$H" bash "$TRUSTED/scripts/install-hooks.sh" >/dev/null 2>&1
if [[ -x "$H/.flywheel/hooks/flywheel-session-end.sh" ]]; then
  pass "IH4: non-executable source deploys as 0755"
else
  fail "IH4: exec bit missing on deployed hook"
fi

# ── IH5: worktree source refusal — ZERO global writes ──
H="$SB/h5"; mkdir -p "$H"
if HOME="$H" bash "$WORKTREE/scripts/install-hooks.sh" >/dev/null 2> "$SB/ih5.err"; then
  fail "IH5: worktree source must be refused"
else
  IH5_OK=1
  grep -q "FLY-1389" "$SB/ih5.err" || { IH5_OK=0; fail "IH5: refusal must cite FLY-1389"; }
  [[ ! -e "$H/.flywheel" && ! -e "$H/.claude" ]] || { IH5_OK=0; fail "IH5: refusal still wrote global state"; }
  [[ "$IH5_OK" == "1" ]] && pass "IH5: worktree source refused with zero global writes"
fi

# ── CM1: cmux-install worktree refusal ──
CMW="$RSB/cmux-wt"; mkdir -p "$CMW/scripts/lib"
cp "$REAL_REPO_ROOT/scripts/lib/path-hygiene.sh" "$CMW/scripts/lib/"
cp "$REAL_REPO_ROOT/scripts/flywheel-cmux-install.sh" "$CMW/scripts/"
echo "gitdir: /main/.git/worktrees/x" > "$CMW/.git"
H="$SB/hcm1"; mkdir -p "$H"
if HOME="$H" bash "$CMW/scripts/flywheel-cmux-install.sh" >/dev/null 2> "$SB/cm1.err"; then
  fail "CM1: worktree cmux-install must be refused"
else
  CM1_OK=1
  grep -q "FLY-1389" "$SB/cm1.err" || { CM1_OK=0; fail "CM1: refusal must cite FLY-1389"; }
  [[ ! -e "$H/.flywheel" ]] || { CM1_OK=0; fail "CM1: refusal still wrote ~/.flywheel"; }
  [[ "$CM1_OK" == "1" ]] && pass "CM1: cmux-install refuses a worktree checkout before any write"
fi

# ── CM2: cmux-install from a trusted root installs symlinks normally ──
CMT="$RSB/cmux-trusted"; mkdir -p "$CMT/scripts/lib" "$CMT/.git"
cp "$REAL_REPO_ROOT/scripts/lib/path-hygiene.sh" "$CMT/scripts/lib/"
cp "$REAL_REPO_ROOT/scripts/flywheel-cmux-install.sh" "$CMT/scripts/"
printf '#!/bin/bash\necho sync\n' > "$CMT/scripts/flywheel-cmux-sync.sh"
printf '#!/bin/bash\necho autostart\n' > "$CMT/scripts/flywheel-cmux-autostart.sh"
H="$SB/hcm2"; mkdir -p "$H"
if HOME="$H" FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL=1 \
    bash "$CMT/scripts/flywheel-cmux-install.sh" </dev/null >/dev/null 2> "$SB/cm2.err" || true; then :; fi
if [[ "$(readlink "$H/.flywheel/bin/flywheel-cmux-sync" 2>/dev/null)" == "$CMT/scripts/flywheel-cmux-sync.sh" ]]; then
  pass "CM2: trusted cmux-install creates the bin symlinks"
else
  fail "CM2: trusted install did not create symlinks" "$(cat "$SB/cm2.err" | tail -3)"
fi

# ── PV1: provisioner — effective-global destination + worktree root → die
# BEFORE phases (zero writes) ──
PVW="$RSB/prov-wt"; mkdir -p "$PVW/scripts/lib"
for lib in host-config.sh supervisor.sh platform-deps.sh script-sanity.sh path-hygiene.sh; do
  cp "$REAL_REPO_ROOT/scripts/lib/$lib" "$PVW/scripts/lib/"
done
cp "$REAL_REPO_ROOT/scripts/provision-fleet-host.sh" "$PVW/scripts/"
echo "gitdir: /main/.git/worktrees/x" > "$PVW/.git"
# PV1's fixture HOME must be NON-temp (in-repo sandbox): a temp-canonical
# destination is recognized as a test sandbox and deliberately not guarded.
H="$RSB/hpv1"; mkdir -p "$H"
if HOME="$H" bash "$PVW/scripts/provision-fleet-host.sh" --apply >/dev/null 2> "$SB/pv1.err"; then
  fail "PV1: worktree→effective-global provision must die"
else
  PV1_OK=1
  grep -q "FLY-1389" "$SB/pv1.err" || { PV1_OK=0; fail "PV1: die message must cite FLY-1389"; }
  [[ ! -e "$H/.flywheel" ]] || { PV1_OK=0; fail "PV1: refusal still wrote ~/.flywheel"; }
  [[ "$PV1_OK" == "1" ]] && pass "PV1: provisioner dies before phases on worktree→effective-global"
fi

# ── PV2: explicit fake --home stays allowed (resolved destination is not
# the effective global) — must NOT hit the FLY-1389 refusal ──
H="$SB/hpv2"; OTHER="$SB/hpv2-target"; mkdir -p "$H" "$OTHER"
HOME="$H" bash "$PVW/scripts/provision-fleet-host.sh" --apply --home "$OTHER" \
  >/dev/null 2> "$SB/pv2.err" || true
# NOTE: grep the refusal PHRASE, not "FLY-1389" — this checkout's own path
# contains the issue id and would false-match in unrelated error output.
if grep -q "refusing to provision the effective-global" "$SB/pv2.err"; then
  fail "PV2: fake --home hermetic usage wrongly guarded" "$(grep refusing "$SB/pv2.err")"
else
  pass "PV2: explicit fake --home destination is not guarded (hermetic usage preserved)"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] || exit 1
