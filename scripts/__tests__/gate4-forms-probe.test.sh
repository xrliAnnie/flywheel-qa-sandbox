#!/bin/bash
# FLY-1062 (QA re-test, gate④ round-4 verification): independent adversarial
# forms NOT in gate4-allowlist-masking.test.sh (M1-M9).
#
# The R4 fix reframed gate④ as EXACT-LINE + detector judgment: an allowlist row
# clears a forbidden-shape occurrence only if its file glob matches AND its
# normalized registration EXACTLY EQUALS the normalized line AND it triggers the
# same detector. This test pins that the closed form rejects additional
# real-world repo-access spellings the review rounds never enumerated — SSH URL,
# `gh repo clone`, tab-separated `git\tclone`, an all-caps command, a slug-only
# `git fetch`, an indented clone, and even a bare comment mentioning the private
# slug. Worst case is granted to the attacker: BOTH broad substring rows
# (`git clone` and `xrliAnnie/flywheel`) are registered, so nothing but exact
# registration can clear a line.
#
# Hermetic: crafts a minimal payload tree + a broad grep-allow, runs the REAL
# po_gate. No assembly, no network. Companion to the M-series regression.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly1062-gate4forms-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

ROOT="$SANDBOX/root"
mkdir -p "$ROOT/scripts/lib" "$ROOT/scripts/packaged" "$ROOT/doc"
VER="1.0.0"
echo "v$VER" > "$ROOT/doc/VERSION"
cp -p "$REPO_ROOT/scripts/lib/fleet-sanitize.sh" "$ROOT/scripts/lib/fleet-sanitize.sh"

cat > "$ROOT/scripts/pkg-files.allow" <<'EOF'
package.json
.flywheel-prebuilt
scripts/provision-fleet-host.sh
EOF

# WORST CASE: both broad substring rows registered. If exact-line semantics hold,
# neither row can clear a line it does not normalize-equal.
printf 'scripts/provision-fleet-host.sh\tgit clone\tbroad clone row\nscripts/provision-fleet-host.sh\txrliAnnie/flywheel\tbroad slug row\n' \
  > "$ROOT/scripts/pkg-grep.allow"

# probe <label> <line(%b: \t and \\ interpreted)> <reject|pass>
probe() {
  local label="$1" line="$2" expect="$3"
  local V="$SANDBOX/v"; rm -rf "$V"; mkdir -p "$V/scripts"
  printf '{"name":"flywheel-onboard-payload","version":"%s","private":true}\n' "$VER" > "$V/package.json"
  printf '%s\n' "$VER" > "$V/.flywheel-prebuilt"
  printf '#!/bin/bash\n' > "$V/scripts/provision-fleet-host.sh"
  printf '%b\n' "$line" >> "$V/scripts/provision-fleet-host.sh"
  if env PACKAGE_ONBOARD_SOURCED=1 \
       PO_FILES_ALLOWLIST="$ROOT/scripts/pkg-files.allow" \
       PO_GREP_ALLOWLIST="$ROOT/scripts/pkg-grep.allow" \
       bash -c 'source "$1"; shift; po_gate "$@"' _ "$REPO_ROOT/scripts/package-onboard.sh" \
         "$V" "$ROOT" >"$SANDBOX/o.log" 2>&1; then
    if [ "$expect" = "pass" ]; then pass "$label PASSED (expected)"
    else fail "$label BYPASS: PASSED the gate but must be REJECTED"; fi
  else
    if [ "$expect" = "reject" ]; then
      pass "$label rejected ($(grep -o 'UNREGISTERED repo-access reference ([a-z]*)' "$SANDBOX/o.log" | head -1))"
    else fail "$label FALSE-POSITIVE: rejected but should PASS: $(tail -2 "$SANDBOX/o.log")"; fi
  fi
}

echo "=== gate④ round-4 independent form probes ==="
probe "F1 SSH-form private clone"        'git clone git@github.com:xrliAnnie/flywheel.git dst'          reject
probe "F2 gh repo clone private slug"    'gh repo clone xrliAnnie/flywheel dst'                          reject
probe "F3 tab-separated git<TAB>clone"   'git\tclone https://github.com/xrliAnnie/flywheel.git dst'      reject
probe "F4 all-caps GIT CLONE"            'GIT CLONE https://github.com/xrliAnnie/flywheel.git dst'       reject
probe "F5 git fetch private (slug-only)" 'git fetch https://github.com/xrliAnnie/flywheel.git'          reject
probe "F6 indented registered-substr"    '    run git clone https://github.com/xrliAnnie/flywheel.git'  reject
probe "F7 bare comment mentions slug"    '# see https://github.com/xrliAnnie/flywheel for source'       reject

# Positive control: an EXACTLY registered broad row line (the literal registration
# text itself) must still clear — proves the gate is not simply rejecting all.
probe "F8 exact-registered clone row"    'git clone'                                                     pass

echo ""
echo "gate4-forms-probe: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
