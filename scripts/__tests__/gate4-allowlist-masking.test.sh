#!/bin/bash
# FLY-1062 (QA·FLY-1062 kickback — Codex Round-1 HIGH, independently reproduced):
# gate④ zero-repo-access invariant must NOT be bypassable by co-locating a
# private-repo slug on an ALREADY-allowlisted `git clone` line.
#
# THE DEFECT (scripts/package-onboard.sh po_gate ④, matching loop ~:708-723):
# a `git clone`/`xrliAnnie/` hit is cleared if its line matches ANY grep-allow
# row by (file-glob + loose SUBSTRING). The real audit-grep-allowlist registers
# a broad `provision-fleet-host.sh`＋`git clone` row (the legitimate customer-repo
# clone). A line that ALSO carries a private slug —
#   git clone https://github.com/xrliAnnie/flywheel.git
# — is therefore cleared by the `git clone` substring, and the co-located
# private `xrliAnnie/` occurrence is never independently rejected. That is a
# bypass of the exact invariant PR1 exists to guarantee (Annie's hard
# requirement: zero private-repo access in the payload).
#
# EXPECTED (post-fix): gate④ rejects the line because the private slug is not
# itself registered. RED until the gate④ matcher is tightened (a `git clone`
# allowlist row must not clear a line that also carries an unregistered
# forbidden pattern) — this test is the RED→GREEN target for the fix.
#
# Hermetic: crafts a minimal payload tree + a grep-allow with the same broad
# `git clone` row shape as production, and runs the REAL po_gate. No assembly,
# no network.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly1062-gate4mask-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── a self-contained "repo root": only doc/VERSION + the allowlist files the
#    gate reads are needed; the real package-onboard.sh is sourced for po_gate. ──
ROOT="$SANDBOX/root"
mkdir -p "$ROOT/scripts/lib" "$ROOT/scripts/packaged" "$ROOT/doc"
VER="1.0.0"
echo "v$VER" > "$ROOT/doc/VERSION"
cp -p "$REPO_ROOT/scripts/lib/fleet-sanitize.sh" "$ROOT/scripts/lib/fleet-sanitize.sh"

# files-allowlist: exactly the tree we build (so gate② passes)
cat > "$ROOT/scripts/pkg-files.allow" <<'EOF'
package.json
.flywheel-prebuilt
scripts/provision-fleet-host.sh
EOF

# grep-allowlist: the SAME broad shape production ships — a file-glob + loose
# `git clone` substring for the customer-repo clone.
printf 'scripts/provision-fleet-host.sh\tgit clone\tcustomer-repo-path (broad, as in production)\n' \
  > "$ROOT/scripts/pkg-grep.allow"

# ── the payload tree under gate: a provision script whose allowlisted
#    `git clone` line ALSO carries the PRIVATE flywheel slug ──
TREE="$SANDBOX/tree"
mkdir -p "$TREE/scripts"
printf '{"name":"flywheel-onboard-payload","version":"%s","private":true}\n' "$VER" > "$TREE/package.json"
printf '%s\n' "$VER" > "$TREE/.flywheel-prebuilt"
cat > "$TREE/scripts/provision-fleet-host.sh" <<'SH'
#!/bin/bash
# customer repo clone line (legitimately allowlisted for the `git clone` substring)
run git clone "https://github.com/xrliAnnie/flywheel.git" "$target"
SH

run_gate() {
  env PACKAGE_ONBOARD_SOURCED=1 \
    PO_FILES_ALLOWLIST="$ROOT/scripts/pkg-files.allow" \
    PO_GREP_ALLOWLIST="$ROOT/scripts/pkg-grep.allow" \
    bash -c 'source "$1"; shift; po_gate "$@"' _ "$REPO_ROOT/scripts/package-onboard.sh" \
      "$TREE" "$ROOT" > "$SANDBOX/gate.log" 2>&1
}

# ── M1 · sanity: gate④ DOES reject the private slug when it is NOT masked ─────
# (bare private slug on its own line, no allowlisted substring) → must fail.
BARE="$SANDBOX/bare"; mkdir -p "$BARE/scripts"
printf '{"name":"flywheel-onboard-payload","version":"%s","private":true}\n' "$VER" > "$BARE/package.json"
printf '%s\n' "$VER" > "$BARE/.flywheel-prebuilt"
printf '#!/bin/bash\n# ref: https://github.com/xrliAnnie/flywheel private\n' > "$BARE/scripts/provision-fleet-host.sh"
if env PACKAGE_ONBOARD_SOURCED=1 \
     PO_FILES_ALLOWLIST="$ROOT/scripts/pkg-files.allow" \
     PO_GREP_ALLOWLIST="$ROOT/scripts/pkg-grep.allow" \
     bash -c 'source "$1"; shift; po_gate "$@"' _ "$REPO_ROOT/scripts/package-onboard.sh" \
       "$BARE" "$ROOT" >"$SANDBOX/bare.log" 2>&1; then
  fail "M1 sanity: gate④ wrongly PASSED an unmasked private slug"
else
  grep -q "UNREGISTERED repo-access" "$SANDBOX/bare.log" \
    && pass "M1 sanity: gate④ rejects an unmasked private slug (gate is live)" \
    || pass "M1 sanity: gate rejects the unmasked private slug"
fi

# ── M2 · THE BUG: private slug co-located with an allowlisted `git clone` ─────
# substring must STILL be rejected. Currently po_gate PASSES it → RED.
if run_gate; then
  fail "M2 gate④ BYPASS: a private clone on an allowlisted git-clone line PASSED the gate (zero-repo-access invariant defeated)"
else
  grep -q "UNREGISTERED repo-access\|xrliAnnie" "$SANDBOX/gate.log" \
    && pass "M2 gate④ rejects a private slug even when co-located with an allowlisted git-clone substring" \
    || fail "M2 gate failed but not via gate④/repo-access: $(tail -4 "$SANDBOX/gate.log")"
fi

echo ""
echo "gate4-allowlist-masking: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
