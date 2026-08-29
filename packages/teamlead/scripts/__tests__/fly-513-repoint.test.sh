#!/bin/bash
# FLY-513 — fly-513-repoint-global-codex.sh apply-path tests.
#
# Codex code-review R2 HIGH: the original `scan_self_contained()` put a glob
# `case` inside a `$(…)` command substitution, which macOS /bin/bash 3.2
# mis-parses at RUNTIME (`syntax error near unexpected token newline`), aborting
# `cmd_install` on the --apply path — `bash -n`/shellcheck never catch it. These
# tests exercise the real --apply path in a sandbox (fake HOME + fake source
# release + mock codex on PATH) so the regression is guarded behaviourally on any
# bash. (The 3.2-specific parse was additionally reproduced by hand on the dev mac.)
#
# Run with /bin/bash.

set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/fly-513-repoint-global-codex.sh"
[ -f "$SUT" ] || { echo "SUT missing: $SUT"; exit 1; }

T=$(mktemp -d /tmp/fly513.XXXXX); trap 'rm -rf "$T"' EXIT
FAKE_HOME="$T/home"; mkdir -p "$FAKE_HOME"

# A fake standalone release tree (the source the script copies from).
SRC_REL="$T/src/packages/standalone/releases/0.1.0-test"
mkdir -p "$SRC_REL/bin"
cat > "$SRC_REL/bin/codex" <<'EOF'
#!/bin/bash
[ "$1" = "--version" ] && { echo "codex-cli 0.1.0-test"; exit 0; }
exit 0
EOF
chmod +x "$SRC_REL/bin/codex"

# Put the mock codex on PATH as a symlink → release bin (so realpath resolves into
# a `.../releases/<ver>/bin/codex` layout, the shape resolve_source expects).
mkdir -p "$T/bin"
ln -sfn "$SRC_REL/bin/codex" "$T/bin/codex"

# Pre-create a STABLE global link so stability_gate has something to read.
mkdir -p "$FAKE_HOME/.local/bin"
ln -sfn "$T/bin/codex" "$FAKE_HOME/.local/bin/codex"

run_sut() { # args… ; runs the SUT with sandboxed HOME + fast stability gate
  HOME="$FAKE_HOME" PATH="$T/bin:$PATH" FLY513_STABILITY_SLEEP=0 \
    /bin/bash "$SUT" "$@" 2>&1
}

# ── 1. install --apply on a CLEAN source publishes the neutral install ────────
out="$(run_sut install --apply)"; rc=$?
NEUTRAL_BIN="$FAKE_HOME/.local/share/flywheel-codex/0.1.0-test/bin/codex"
if [ "$rc" -eq 0 ] && [ -x "$NEUTRAL_BIN" ]; then
  pass "install --apply publishes neutral pinned install"
else
  fail "install --apply (rc=$rc, neutral bin exists=$( [ -x "$NEUTRAL_BIN" ] && echo y || echo n ))"
  echo "$out" | sed 's/^/      /'
fi

# ── 2. No bash-3.2 command-substitution syntax error on the --apply path ──────
if echo "$out" | grep -q "syntax error"; then
  fail "scan emitted a 'syntax error' (bash 3.2 case-in-\$() regression)"
else
  pass "no 'syntax error' on the --apply scan path"
fi

# ── 3. A LEAKY source (symlink back into a Lead home) is DETECTED → die ───────
SRC_REL2="$T/src2/packages/standalone/releases/0.2.0-test"
mkdir -p "$SRC_REL2/bin" "$FAKE_HOME/.codex-leak"
cat > "$SRC_REL2/bin/codex" <<'EOF'
#!/bin/bash
[ "$1" = "--version" ] && { echo "codex-cli 0.2.0-test"; exit 0; }
exit 0
EOF
chmod +x "$SRC_REL2/bin/codex"
ln -sfn "$FAKE_HOME/.codex-leak/x" "$SRC_REL2/leak.link"   # planted leak
ln -sfn "$SRC_REL2/bin/codex" "$T/bin/codex"               # repoint mock → leaky release
out2="$(run_sut install --apply)"; rc2=$?
if [ "$rc2" -ne 0 ] && echo "$out2" | grep -q "NOT self-contained"; then
  pass "leaky source (symlink into ~/.codex-*) is detected → dies"
else
  fail "leaky source NOT caught (rc=$rc2)"
  echo "$out2" | sed 's/^/      /'
fi

# ── 4. verify is FAIL-CLOSED when raw codex is broken (R1 HIGH) ───────────────
cat > "$T/bin/codex" <<'EOF'
#!/bin/bash
exit 7   # raw codex always fails
EOF
chmod +x "$T/bin/codex"   # replace the symlink with a failing real file
out3="$(HOME="$FAKE_HOME" PATH="$T/bin:$PATH" /bin/bash "$SUT" verify --apply 2>&1)"; rc3=$?
if [ "$rc3" -ne 0 ]; then
  pass "verify is fail-closed (raw codex nonzero → verify dies)"
else
  fail "verify did NOT fail-close on a broken raw codex (rc=$rc3)"
  echo "$out3" | sed 's/^/      /'
fi

echo "── fly-513-repoint: $PASS passed, $FAIL failed ──"
[ "$FAIL" -eq 0 ]
