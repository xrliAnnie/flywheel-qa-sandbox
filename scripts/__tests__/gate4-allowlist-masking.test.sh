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

# ── M3-M6 · Round-2 variants (Codex xhigh): normalization bypasses ───────────
# Each REACHABLE variant of a private-repo clone must be rejected even though
# it avoids the literal case-sensitive `git clone` / `xrliAnnie/` byte forms.
variant_case() { # <label> <line>
  local label="$1" line="$2"
  local V="$SANDBOX/variant"; rm -rf "$V"; mkdir -p "$V/scripts"
  printf '{"name":"flywheel-onboard-payload","version":"%s","private":true}\n' "$VER" > "$V/package.json"
  printf '%s\n' "$VER" > "$V/.flywheel-prebuilt"
  printf '#!/bin/bash\n%s\n' "$line" > "$V/scripts/provision-fleet-host.sh"
  if env PACKAGE_ONBOARD_SOURCED=1 \
       PO_FILES_ALLOWLIST="$ROOT/scripts/pkg-files.allow" \
       PO_GREP_ALLOWLIST="$ROOT/scripts/pkg-grep.allow" \
       bash -c 'source "$1"; shift; po_gate "$@"' _ "$REPO_ROOT/scripts/package-onboard.sh" \
         "$V" "$ROOT" >"$SANDBOX/variant.log" 2>&1; then
    fail "$label: variant PASSED the gate (bypass)"
  else
    grep -q "UNREGISTERED repo-access" "$SANDBOX/variant.log" \
      && pass "$label rejected" \
      || fail "$label failed but not via gate④: $(tail -3 "$SANDBOX/variant.log")"
  fi
}
variant_case "M3 lowercase slug" \
  'run git clone "https://github.com/xrliannie/flywheel.git" "$target"'
variant_case "M4 quote-split slug" \
  'run git clone "https://github.com/xrliAnnie"/"flywheel.git" "$target"'
variant_case "M5 double-space clone" \
  'run git  clone https://github.com/xrliannie/flywheel.git "$target"'
variant_case "M6 flagged clone (git -C)" \
  'run git -C "$PWD" clone https://github.com/xrliannie/flywheel.git "$target"'

# ── M7 · the legitimate EXACT-registered shape still clears ──────────────────
# provision's real customer-repo clone line (no private slug), registered as
# an exact line per the R4-hardened allowlist semantics, must PASS.
printf 'scripts/provision-fleet-host.sh\trun git clone "https://github.com/${slug}.git" "$target"\tcustomer-repo-path exact row\n' \
  > "$ROOT/scripts/pkg-grep-exact.allow"
LEGIT="$SANDBOX/legit"; mkdir -p "$LEGIT/scripts"
printf '{"name":"flywheel-onboard-payload","version":"%s","private":true}\n' "$VER" > "$LEGIT/package.json"
printf '%s\n' "$VER" > "$LEGIT/.flywheel-prebuilt"
printf '#!/bin/bash\nrun git clone "https://github.com/${slug}.git" "$target"\n' > "$LEGIT/scripts/provision-fleet-host.sh"
if env PACKAGE_ONBOARD_SOURCED=1 \
     PO_FILES_ALLOWLIST="$ROOT/scripts/pkg-files.allow" \
     PO_GREP_ALLOWLIST="$ROOT/scripts/pkg-grep-exact.allow" \
     bash -c 'source "$1"; shift; po_gate "$@"' _ "$REPO_ROOT/scripts/package-onboard.sh" \
       "$LEGIT" "$ROOT" >"$SANDBOX/legit.log" 2>&1; then
  pass "M7 exact-registered customer-repo clone still clears (no false positive)"
else
  fail "M7 legitimate registered clone rejected: $(tail -3 "$SANDBOX/legit.log")"
fi

# ── M8 · Round-3 (Codex): BOTH broad rows registered for one file must not ───
# jointly clear a combined private-clone line. Production shape: flywheel-setup
# registers a slug row (template) AND a clone row (doc comment) for DIFFERENT
# lines; an accidental executable `git clone <private>` line in that file was
# cleared twice — slug occurrence by the slug row, clone occurrence by the
# clone row. The combo detector demands a single row carrying both shapes.
printf 'scripts/provision-fleet-host.sh\tgit clone\tbroad clone row\nscripts/provision-fleet-host.sh\txrliAnnie/flywheel\tbroad slug row\n' \
  > "$ROOT/scripts/pkg-grep-both.allow"
COMBO="$SANDBOX/combo"; mkdir -p "$COMBO/scripts"
printf '{"name":"flywheel-onboard-payload","version":"%s","private":true}\n' "$VER" > "$COMBO/package.json"
printf '%s\n' "$VER" > "$COMBO/.flywheel-prebuilt"
printf '#!/bin/bash\ngit clone https://github.com/xrliAnnie/flywheel.git "$PWD/private-flywheel"\n' \
  > "$COMBO/scripts/provision-fleet-host.sh"
if env PACKAGE_ONBOARD_SOURCED=1 \
     PO_FILES_ALLOWLIST="$ROOT/scripts/pkg-files.allow" \
     PO_GREP_ALLOWLIST="$ROOT/scripts/pkg-grep-both.allow" \
     bash -c 'source "$1"; shift; po_gate "$@"' _ "$REPO_ROOT/scripts/package-onboard.sh" \
       "$COMBO" "$ROOT" >"$SANDBOX/combo.log" 2>&1; then
  fail "M8 combined private clone cleared jointly by separate slug+clone rows (bypass)"
else
  grep -q "UNREGISTERED repo-access reference (combo)" "$SANDBOX/combo.log" \
    && pass "M8 combined private-clone line demands a combo-registered row (both broad rows insufficient)" \
    || fail "M8 failed but not via the combo detector: $(tail -3 "$SANDBOX/combo.log")"
fi

# ── M9 · Round-4 (Codex): backslash-continuation split ────────────────────────
# `git clone \` on one physical line + the private URL on the next: the two
# halves must not be cleared by broad rows (each half equals no registered
# exact line — the clone half alone triggers the clone detector unregistered).
CONT="$SANDBOX/cont"; mkdir -p "$CONT/scripts"
printf '{"name":"flywheel-onboard-payload","version":"%s","private":true}\n' "$VER" > "$CONT/package.json"
printf '%s\n' "$VER" > "$CONT/.flywheel-prebuilt"
cat > "$CONT/scripts/provision-fleet-host.sh" <<'SH'
#!/bin/bash
git clone \
  https://github.com/xrliAnnie/flywheel.git "$PWD/private-flywheel"
SH
if env PACKAGE_ONBOARD_SOURCED=1 \
     PO_FILES_ALLOWLIST="$ROOT/scripts/pkg-files.allow" \
     PO_GREP_ALLOWLIST="$ROOT/scripts/pkg-grep-both.allow" \
     bash -c 'source "$1"; shift; po_gate "$@"' _ "$REPO_ROOT/scripts/package-onboard.sh" \
       "$CONT" "$ROOT" >"$SANDBOX/cont.log" 2>&1; then
  fail "M9 continuation-split private clone PASSED the gate (bypass)"
else
  grep -q "UNREGISTERED repo-access" "$SANDBOX/cont.log" \
    && pass "M9 continuation-split private clone rejected (each half unregistered)" \
    || fail "M9 failed but not via gate④: $(tail -3 "$SANDBOX/cont.log")"
fi

echo ""
echo "gate4-allowlist-masking: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
