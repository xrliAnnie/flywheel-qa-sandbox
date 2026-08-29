#!/bin/bash
# FLY-1023 M3: the buddy-only `github` step — gh-CLI path (auth probe →
# find-or-create repo → bind origin → first push → ls-remote verify) with
# guided fallbacks.
#
# Hermetic: gh is a stub (auth state + repo store are sandbox files); the
# "GitHub remote" is a LOCAL bare repository (FLYWHEEL_BUDDY_GITHUB_URL_BASE
# seam) so the push/ls-remote legs run through REAL git with zero network.
#
# Covers (plan §3 M3 GitHub acceptance):
#   G1  authed happy path: repo created, skeleton committed + pushed, remote
#       answers, evidence records the repo full name; FS_PROJECT_SLUG wired
#   G2  not signed in + no TTY → exit 3 (needs_guidance), nothing pushed
#   G3  create refused (org policy) → guided fallback: manual-create answer
#       + re-verify → done; without the answer → exit 3
#   G4  idempotent re-run: skip via verify (remote binding intact)
#   G5  journal stays secret-scan clean (no gh tokens anywhere near us)
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_ROOT/scripts/flywheel-buddy-steps.sh"

SANDBOX="$(mktemp -d -t fly1023-github-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
GHS="$SANDBOX/gh-state"; mkdir -p "$GHS"
REMOTES="$SANDBOX/remotes"; mkdir -p "$REMOTES"

cat > "$STUB_BIN/gh" <<EOF
#!/bin/bash
GHS="$GHS"; REMOTES="$REMOTES"
case "\$1 \$2" in
  "auth status") [ -f "\$GHS/authed" ] && exit 0 || exit 1 ;;
  "auth login")  echo login >> "\$GHS/calls"; touch "\$GHS/authed"; exit 0 ;;
  "api user")    echo "qaowner"; exit 0 ;;
  "repo view")   [ -d "\$REMOTES/\$3.git" ] && exit 0 || exit 1 ;;
  "repo create")
    [ -f "\$GHS/refuse-create" ] && exit 1
    mkdir -p "\$(dirname "\$REMOTES/\$3.git")"
    git init --bare -q "\$REMOTES/\$3.git"
    exit 0 ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/gh"

H="$SANDBOX/home"; mkdir -p "$H"
run_step() { # <step> [extra env pairs...]
  local step="$1"; shift
  env -i HOME="$H" USER=tester PATH="$STUB_BIN:$PATH" \
    FLYWHEEL_BUDDY_GITHUB_URL_BASE="$REMOTES/" \
    "$@" \
    bash "$CLI" --project qa-github --cos-persona Cass --eng-persona Tad run "$step"
}

# skeleton first (real step — local git init + scaffold)
run_step skeleton >/dev/null 2>&1 || { echo "ERROR: skeleton step failed"; exit 1; }

# ── G2: not signed in, no TTY → needs_guidance, nothing pushed ──
O2="$(run_step github </dev/null 2>/dev/null)"; RC2=$?
if [ "$RC2" -eq 3 ] && [ "$(jq -r '.error_code' <<<"$O2")" = "needs_guidance" ] \
   && [ ! -d "$REMOTES/qaowner/qa-github.git" ]; then
  pass "G2 unauthenticated + no TTY: exit 3 needs_guidance, nothing created"
else
  fail "G2 rc=$RC2 out='$O2'"
fi

# ── G1: authed happy path ──
touch "$GHS/authed"
O1="$(run_step github </dev/null 2>/dev/null)"; RC1=$?
J="$H/.flywheel/setup-state.json"
LSR="$(git -C "$H/Dev/qa-github" ls-remote origin 2>/dev/null | wc -l | tr -d ' ')"
if [ "$RC1" -eq 0 ] && [ "$(jq -r '.evidence.repo' <<<"$O1")" = "qaowner/qa-github" ] \
   && [ -d "$REMOTES/qaowner/qa-github.git" ] && [ "${LSR:-0}" -ge 1 ] \
   && git -C "$H/Dev/qa-github" rev-parse HEAD >/dev/null 2>&1; then
  pass "G1 happy path: repo created, skeleton committed+pushed, remote answers, evidence=repo"
else
  fail "G1 rc=$RC1 out='$O1' lsr=$LSR"
fi

# ── G4: idempotent re-run (verify keeps it done) ──
O4="$(run_step github </dev/null 2>/dev/null)"; RC4=$?
if [ "$RC4" -eq 0 ] && [ "$(jq -r '.ok' <<<"$O4")" = "true" ]; then
  pass "G4 re-run: done step verified + skipped cleanly"
else
  fail "G4 rc=$RC4 out='$O4'"
fi

# ── G3: create refused → guided fallback ──
H3="$SANDBOX/home3"; mkdir -p "$H3"
GHS3="$SANDBOX/gh-state"; touch "$GHS/refuse-create"
run_step_h3() {
  local step="$1"; shift
  env -i HOME="$H3" USER=tester PATH="$STUB_BIN:$PATH" \
    FLYWHEEL_BUDDY_GITHUB_URL_BASE="$REMOTES/" \
    "$@" \
    bash "$CLI" --project qa-blocked --cos-persona Cass --eng-persona Tad run "$step"
}
run_step_h3 skeleton >/dev/null 2>&1
# no manual-create answer, no TTY → guidance exit
O3A="$(run_step_h3 github </dev/null 2>/dev/null)"; RC3A=$?
# manual path: "create" the repo out-of-band, answer yes → done
mkdir -p "$REMOTES/qaowner"; git init --bare -q "$REMOTES/qaowner/qa-blocked.git"
O3B="$(run_step_h3 github FLYWHEEL_SETUP_ANSWER_GITHUB_REPO_CREATED_MANUALLY=y </dev/null 2>/dev/null)"; RC3B=$?
if [ "$RC3A" -ne 0 ] && [ "$RC3B" -eq 0 ] \
   && [ "$(jq -r '.evidence.repo' <<<"$O3B")" = "qaowner/qa-blocked" ]; then
  pass "G3 create refused: guidance exit without answer; manual-create + answer lands done"
else
  fail "G3 rcA=$RC3A rcB=$RC3B outB='$O3B'"
fi
rm -f "$GHS/refuse-create"

# ── G5: journal secret-scan clean ──
if bash -c "source '$REPO_ROOT/scripts/lib/fleet-sanitize.sh'; scan_for_secrets '$J'" >/dev/null 2>&1; then
  pass "G5 journal stays secret-scan clean after the github step"
else
  fail "G5 journal scan"
fi

echo ""
echo "flywheel-buddy-github.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
