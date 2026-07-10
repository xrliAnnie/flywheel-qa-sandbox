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
# Codex R1 (QA delta) hardening: the reject branch MUST prove the rejection came
# from gate④'s UNREGISTERED-repo-access path (not some other gate silently
# rejecting the payload — that would be a false green), and clone-shape probes
# must be able to fail INDEPENDENTLY of the slug detector (a probe carrying both
# shapes would keep passing on a pure clone-detector regression because the slug
# detector still rejects it). So probes assert the exact detector, and clone-only
# / slug-only isolating probes are added.
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

# probe <label> <line(%b: \t and \\ interpreted)> <reject|pass> [must-detector: clone|slug|combo]
#   reject → the run MUST fail AND the failure MUST be a gate④ "UNREGISTERED
#            repo-access reference" line; if a must-detector is given, that exact
#            detector MUST appear in the gate④ errors (so a clone-shape probe is
#            not silently satisfied by the slug detector, and vice versa).
#   pass   → the run MUST succeed.
probe() {
  local label="$1" line="$2" expect="$3" det="${4:-}"
  local V="$SANDBOX/v"; rm -rf "$V"; mkdir -p "$V/scripts"
  printf '{"name":"flywheel-onboard-payload","version":"%s","private":true}\n' "$VER" > "$V/package.json"
  printf '%s\n' "$VER" > "$V/.flywheel-prebuilt"
  printf '#!/bin/bash\n' > "$V/scripts/provision-fleet-host.sh"
  printf '%b\n' "$line" >> "$V/scripts/provision-fleet-host.sh"
  local rc=0
  env PACKAGE_ONBOARD_SOURCED=1 \
      PO_FILES_ALLOWLIST="$ROOT/scripts/pkg-files.allow" \
      PO_GREP_ALLOWLIST="$ROOT/scripts/pkg-grep.allow" \
      bash -c 'source "$1"; shift; po_gate "$@"' _ "$REPO_ROOT/scripts/package-onboard.sh" \
        "$V" "$ROOT" >"$SANDBOX/o.log" 2>&1 || rc=$?

  if [ "$expect" = "pass" ]; then
    if [ "$rc" -eq 0 ]; then pass "$label PASSED (expected)"
    else fail "$label FALSE-POSITIVE: rejected but should PASS: $(tail -2 "$SANDBOX/o.log")"; fi
    return
  fi
  # expect = reject
  if [ "$rc" -eq 0 ]; then
    fail "$label BYPASS: PASSED the gate but must be REJECTED"
    return
  fi
  if ! grep -q "gate④: UNREGISTERED repo-access reference" "$SANDBOX/o.log"; then
    fail "$label rejected but NOT via gate④ repo-access (false-green risk — another gate rejected): $(tail -2 "$SANDBOX/o.log")"
    return
  fi
  if [ -n "$det" ] && ! grep -q "UNREGISTERED repo-access reference ($det)" "$SANDBOX/o.log"; then
    fail "$label rejected by gate④ but NOT via the expected '$det' detector (regression could be masked): $(grep -o 'UNREGISTERED repo-access reference ([a-z]*)' "$SANDBOX/o.log" | sort -u | tr '\n' ' ')"
    return
  fi
  pass "$label rejected ($(grep -o 'UNREGISTERED repo-access reference ([a-z]*)' "$SANDBOX/o.log" | sort -u | tr '\n' ' '))"
}

echo "=== gate④ round-4 independent form probes ==="
# Forms carrying the private slug (rejectable by slug and/or clone detector).
probe "F1 SSH-form private clone"        'git clone git@github.com:xrliAnnie/flywheel.git dst'          reject
probe "F2 gh repo clone private slug"    'gh repo clone xrliAnnie/flywheel dst'                          reject slug
probe "F3 tab-separated git<TAB>clone"   'git\tclone https://github.com/xrliAnnie/flywheel.git dst'      reject
probe "F4 all-caps GIT CLONE"            'GIT CLONE https://github.com/xrliAnnie/flywheel.git dst'       reject
probe "F5 git fetch private (slug-only)" 'git fetch https://github.com/xrliAnnie/flywheel.git'          reject slug
probe "F6 indented registered-substr"    '    run git clone https://github.com/xrliAnnie/flywheel.git'  reject
probe "F7 bare comment mentions slug"    '# see https://github.com/xrliAnnie/flywheel for source'       reject slug

# Detector-ISOLATING probes (Codex R1): a line that ONLY the clone detector can
# reject (no slug present) proves the clone detector is independently live — a
# clone regression can no longer hide behind the slug detector.
probe "C1 clone-only non-slug https"     'git clone https://github.com/acme/widgets.git dst'            reject clone
probe "C2 clone-only local path"         'git clone /srv/mirror/other.git dst'                          reject clone
probe "C3 clone-only tab non-slug"       'git\tclone https://example.org/x.git dst'                     reject clone

# A line that ONLY the slug detector can reject (no git-clone shape) proves the
# slug detector is independently live.
probe "S1 slug-only curl raw"            'curl https://raw.githubusercontent.com/xrliAnnie/flywheel/main/x.sh' reject slug

# Positive control: an EXACTLY registered broad row line (the literal registration
# text itself) must still clear — proves the gate is not simply rejecting all.
probe "P1 exact-registered clone row"    'git clone'                                                     pass

echo ""
echo "gate4-forms-probe: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
