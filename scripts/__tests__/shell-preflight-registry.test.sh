#!/bin/bash
# FLY-1323 (Codex code R1 HIGH-1) · hermetic registry-pin matrix for
# shell-publish-preflight.sh. The scoped-registry branch had ZERO coverage, and
# a scoped `npm config get` that EXITED NON-ZERO with empty stdout was silently
# read as "no override" → a green PREFLIGHT PASS against an unknown publish
# target. This shims `npm` to control every config/probe answer and asserts each
# fail-closed case actually dies BEFORE the registry-version / content-gate steps.
#
# The preflight checks the placeholder endpoint (step 1) before the registry
# (step 3), so this test temporarily points config.mjs at a real URL and restores
# it via trap. It only drives the FAIL-CLOSED cases: those die at the registry
# step, before `npm view` / `npm pack`, so the shim never needs a real registry.
# The all-npmjs PASS path needs real `npm pack` and is covered live elsewhere.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFLIGHT="$ROOT/scripts/release/shell-publish-preflight.sh"
CONFIG="$ROOT/packages/onboard-shell/lib/config.mjs"
SANDBOX="$(mktemp -d -t fly1323-regpin-XXXXXX)"

# ── restore config.mjs no matter how we exit ────────────────────────────────
cp "$CONFIG" "$SANDBOX/config.mjs.orig"
restore() { cp "$SANDBOX/config.mjs.orig" "$CONFIG"; rm -f "$CONFIG.bak"; rm -rf "$SANDBOX"; }
trap restore EXIT
# temporarily defeat the placeholder gate so execution reaches the registry step
# atomic write (temp + mv) so an interrupted run can never leave the checked-in
# config.mjs truncated (Codex R7#4); the trap above still restores the original.
sed 's#https://onboard.flywheel.invalid#https://flywheel-onboard-endpoint.example.workers.dev#' "$SANDBOX/config.mjs.orig" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"

# ── npm shim: SCOPED holds the scenario for `config get @flywheel-ai:registry` ──
# SCOPED values: "ok0" = exit0 undefined | "fail" = exit73 empty (the HIGH-1
# fail-open) | "evil" = exit0 non-npmjs.
SHIM="$SANDBOX/bin"; mkdir -p "$SHIM"
cat > "$SHIM/npm" <<'SH'
#!/bin/bash
if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  case "$3" in
    registry) echo "https://registry.npmjs.org/"; exit 0 ;;
    *:registry)
      case "$SCOPED" in
        ok0)  echo "undefined"; exit 0 ;;
        fail) exit 73 ;;                       # non-zero, empty stdout
        evil) echo "https://registry.attacker.invalid/"; exit 0 ;;
      esac ;;
  esac
fi
# any other npm call (view/pack) means we reached past the registry gate —
# these fail-closed cases must NOT get here.
echo "SHIM: unexpected npm $*" >&2; exit 99
SH
chmod +x "$SHIM/npm"

run() {  # $1=SCOPED scenario  → prints preflight output, sets RC
  SCOPED="$1" PATH="$SHIM:$PATH" bash "$PREFLIGHT" --founder-local 2>&1
}

# ── R1 · scoped probe FAILS (exit non-zero) → must DIE, not pass ─────────────
OUT="$(run fail)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q "cannot confirm the scoped publish registry" <<<"$OUT" \
   && ! grep -q "PREFLIGHT PASS" <<<"$OUT"; then
  pass "R1 scoped-registry probe failure fails CLOSED (the HIGH-1 fail-open is gone)"
else
  fail "R1 scoped probe failure did not fail closed (rc=$RC): $(tail -2 <<<"$OUT")"
fi

# ── R2 · scoped registry set to a non-npmjs host → must DIE ──────────────────
OUT="$(run evil)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q "overrides the default for publish" <<<"$OUT" \
   && ! grep -q "PREFLIGHT PASS" <<<"$OUT"; then
  pass "R2 non-npmjs scoped registry is refused"
else
  fail "R2 non-npmjs scoped registry not refused (rc=$RC): $(tail -2 <<<"$OUT")"
fi

# ── R3 · publishConfig.registry (package.json) non-npmjs → must DIE ──────────
# scoped is absent (ok0); the package's own publishConfig must still be pinned.
PKG="$ROOT/packages/onboard-shell/package.json"
cp "$PKG" "$SANDBOX/package.json.orig"
node -e 'const f=process.argv[1];const p=require(f);p.publishConfig=p.publishConfig||{};p.publishConfig.registry="https://registry.attacker.invalid/";require("fs").writeFileSync(f,JSON.stringify(p,null,"\t")+"\n")' "$PKG"
OUT="$(run ok0)"; RC=$?
cp "$SANDBOX/package.json.orig" "$PKG"
# QA ff38290f F3: this assertion USED TO BE VACUOUS. It matched the substring
# "publishConfig.registry", which the SUCCESS note also contains — so with the
# is_npmjs guard deleted the script printed
#   note: publishConfig.registry pinned: https://registry.attacker.invalid/
# (announcing the attacker's registry as pinned) and R3 still went green. The
# "did not reach PREFLIGHT PASS" half only held because this test's own npm shim
# refuses `npm view`; on a real machine npm view returns E404 (nothing published)
# and the run would have reached PASS. Both halves were satisfied for the wrong
# reason. It now pins the text ONLY the die emits.
if [ "$RC" -ne 0 ] && grep -q "it overrides the publish target" <<<"$OUT" \
   && ! grep -q "PREFLIGHT PASS" <<<"$OUT"; then
  pass "R3 package.json publishConfig.registry override is refused"
else
  fail "R3 publishConfig.registry override not refused (rc=$RC): $(tail -2 <<<"$OUT")"
fi

# ── R4 · the jq publishConfig probe FAILS (exit non-zero) → must DIE ────────
# Codex code R2: I fixed the two npm probes and left this one fail-open — a jq
# exiting non-zero with empty stdout read as "not configured" → PASS. Same class.
# Shim jq so ONLY the publishConfig query fails; every other jq call passes through.
JQ_REAL="$(command -v jq)"
cat > "$SHIM/jq" <<SH
#!/bin/bash
for a in "\$@"; do
  case "\$a" in *publishConfig.registry*) exit 66 ;; esac   # non-zero, empty stdout
done
exec "$JQ_REAL" "\$@"
SH
chmod +x "$SHIM/jq"
OUT="$(run ok0)"; RC=$?
rm -f "$SHIM/jq"
if [ "$RC" -ne 0 ] && grep -q "cannot confirm the publish target" <<<"$OUT" \
   && ! grep -q "PREFLIGHT PASS" <<<"$OUT"; then
  pass "R4 jq publishConfig probe failure fails CLOSED (no probe may fail open)"
else
  fail "R4 jq probe failure did not fail closed (rc=$RC): $(tail -2 <<<"$OUT")"
fi

# ── R5 · the jq .name probe FAILS → must DIE (not silently skip scope) ──────
# Codex code R2 (2nd): NAME drives SCOPE. An unguarded failing .name read left
# NAME empty → SCOPE empty → the ENTIRE scoped-registry branch was skipped, so a
# scoped override would never be examined. The most load-bearing read of all.
# Codex code R3: this test USED TO BE VACUOUS and I had claimed it mutation-
# verified. The shim exited nonzero with EMPTY stdout, and the assertion matched
# "cannot identify the package" — text that BOTH the exit-status guard and the
# empty-value guard emit. So deleting the NAME_RC guard just fell through to the
# empty-value guard and R5 stayed green: it did not pin the guard in its name.
# Fixed on both ends: the shim now prints a perfectly VALID name (so the
# empty-value guard CANNOT fire and cover for a missing exit check), and the
# assertion pins the diagnostic unique to the exit-status guard.
JQ_REAL2="$(command -v jq)"
cat > "$SHIM/jq" <<SH
#!/bin/bash
for a in "\$@"; do
  # only the .name read fails — and it fails the HARD way: plausible, non-empty
  # stdout plus a nonzero exit. Output that looks usable is not authority.
  case "\$a" in ".name") echo "@flywheel-ai/onboard"; exit 65 ;; esac
done
exec "$JQ_REAL2" "\$@"
SH
chmod +x "$SHIM/jq"
OUT="$(run ok0)"; RC=$?
rm -f "$SHIM/jq"
if [ "$RC" -ne 0 ] && grep -q "jq probe of package.json .name failed" <<<"$OUT" \
   && ! grep -q "PREFLIGHT PASS" <<<"$OUT"; then
  pass "R5 jq .name probe failure fails CLOSED (cannot silently skip scope derivation)"
else
  fail "R5 .name probe failure did not fail closed (rc=$RC): $(tail -2 <<<"$OUT")"
fi

echo ""
echo "shell-preflight-registry: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
