#!/usr/bin/env bash
# FLY-1439: the real-machine QA runner may load a pinned Discord plugin from
# an isolated CLAUDE_CONFIG_DIR. The production fork preflight is allowed to
# skip only when an explicit flag and a byte-identical expected path agree.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="${SCRIPT_DIR}/../claude-lead.sh"
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1439-plugin-check.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

# Execute the launcher's actual bounded preflight block, not a mirrored copy.
# The preflight delegates to validate_isolated_claude_config, which the
# launcher defines earlier (it must run before the first CLAUDE_CONFIG_DIR
# write), so the fixture concatenates that function definition ahead of the
# block. Without it every skip case would "fail closed" on a
# command-not-found instead of on the guard — a vacuous green.
BLOCK="$ROOT/plugin-preflight.sh"
awk '
  /^validate_isolated_claude_config\(\) \{$/ { in_fn = 1 }
  in_fn { print }
  in_fn && /^\}$/ { in_fn = 0 }
' "$LAUNCHER" > "$BLOCK"

VALIDATOR_LINES="$(wc -l < "$BLOCK" | tr -d ' ')"

awk '
  /^FLYWHEEL_BIN="\$\{HOME\}\/\.flywheel\/bin"$/ { in_block = 1 }
  in_block && /^# ── GEO-285: Install PostCompact hook/ { exit }
  in_block { print }
' "$LAUNCHER" >> "$BLOCK"

if [[ ! -s "$BLOCK" ]]; then
  fail "fixture" "could not extract Discord plugin preflight block"
  echo "[TEST] claude-lead-plugin-fork-check: ${PASSED} passed, ${FAILED} failed"
  exit 1
fi

# Fixture integrity: both halves must be present, and the preflight must
# actually delegate to the validator. Otherwise the fail-closed assertions
# below would pass for the wrong reason.
if [[ "$VALIDATOR_LINES" -lt 10 ]]; then
  fail "fixture" "validate_isolated_claude_config not extracted (${VALIDATOR_LINES} lines)"
  echo "[TEST] claude-lead-plugin-fork-check: ${PASSED} passed, ${FAILED} failed"
  exit 1
fi
if ! grep -q 'validate_isolated_claude_config$' "$BLOCK"; then
  fail "fixture" "preflight block no longer calls validate_isolated_claude_config"
  echo "[TEST] claude-lead-plugin-fork-check: ${PASSED} passed, ${FAILED} failed"
  exit 1
fi

# The launcher's shebang is #!/bin/bash, which on macOS is bash 3.2 — the
# shell production Leads actually start under. bash 3.2 tokenizes quoted
# heredocs inside $( ) differently from bash 5, so a stray apostrophe in the
# embedded python parses under a Homebrew bash and dies under /bin/bash. A
# `bash -n` run by whichever bash happens to be on PATH does NOT catch that,
# so pin the check to the oldest bash available.
OLD_BASH=""
if [[ -x /bin/bash ]] && /bin/bash --version 2>/dev/null | head -1 | grep -q 'version 3\.'; then
  OLD_BASH=/bin/bash
fi
if [[ -n "$OLD_BASH" ]]; then
  if "$OLD_BASH" -n "$LAUNCHER" 2>/dev/null; then
    pass "launcher parses under bash 3.2 (the production /bin/bash)"
  else
    fail "bash32" "launcher does not parse under bash 3.2 — production Leads would die at startup"
  fi
else
  echo "[TEST] — bash 3.2 parse check not applicable (no bash 3.x at /bin/bash)"
fi

make_home() {
  local home="$1"
  mkdir -p "$home/.flywheel/bin"
  cat > "$home/.flywheel/bin/check-discord-plugin.sh" <<'EOF'
#!/usr/bin/env bash
count_file="${TEST_CALL_DIR}/check.count"
count=0
[[ -f "$count_file" ]] && count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
[[ -f "${TEST_CALL_DIR}/updated" ]]
EOF
  cat > "$home/.flywheel/bin/update-discord-plugin.sh" <<'EOF'
#!/usr/bin/env bash
touch "${TEST_CALL_DIR}/updated"
EOF
  chmod +x "$home/.flywheel/bin/check-discord-plugin.sh" \
    "$home/.flywheel/bin/update-discord-plugin.sh"
}

run_case() {
  local name="$1" home="$2" call_dir="$3"
  shift 3
  mkdir -p "$call_dir"
  (
    env -i \
      HOME="$home" \
      PATH="/usr/bin:/bin" \
      TEST_CALL_DIR="$call_dir" \
      "$@" \
      bash -c 'set -euo pipefail; log() { printf "%s\n" "$*" >> "${TEST_CALL_DIR}/launcher.log"; }; source "$1"' \
      _ "$BLOCK"
  ) >"$call_dir/stdout" 2>"$call_dir/stderr"
}

# Unset is the production byte-compat path: check fails, update runs, recheck
# passes. This pins the original behavior rather than merely source-grepping it.
H1="$ROOT/home-default"; C1="$ROOT/calls-default"; make_home "$H1"
if run_case default "$H1" "$C1"; then
  if [[ "$(cat "$C1/check.count" 2>/dev/null)" == "2" \
      && -f "$C1/updated" \
      && "$(grep -c 'Discord plugin fork check: OK' "$C1/launcher.log")" == "1" ]]; then
    pass "unset flag preserves check → update → recheck production behavior"
  else
    fail "unset flag" "preflight call sequence changed"
  fi
else
  fail "unset flag" "production preflight exited non-zero"
fi

# Flag-only, mismatched, and canonical/aliased production-root paths must fail
# before either production cache script can run.
for variant in missing mismatch production production-alias; do
  H="$ROOT/home-$variant"; C="$ROOT/calls-$variant"; make_home "$H"
  args=(TEST_SKIP_PLUGIN_FORK_CHECK=1)
  if [[ "$variant" == "mismatch" ]]; then
    args+=(CLAUDE_CONFIG_DIR="$ROOT/config-a")
    args+=(TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$ROOT/config-b")
  elif [[ "$variant" == "production" || "$variant" == "production-alias" ]]; then
    mkdir -p "$H/.claude"
    production_config="$H/.claude"
    [[ "$variant" == "production-alias" ]] && production_config="$H/./.claude//"
    args+=(CLAUDE_CONFIG_DIR="$production_config")
    args+=(TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$production_config")
  fi
  if run_case "$variant" "$H" "$C" "${args[@]}"; then
    fail "$variant" "unsafe skip configuration was accepted"
  elif [[ ! -f "$C/check.count" && ! -f "$C/updated" ]]; then
    pass "$variant skip config fails closed before production scripts run"
  else
    fail "$variant" "production scripts ran before fail-closed exit"
  fi
done

# Exact match is the only accepted skip shape and must not touch production.
H4="$ROOT/home-match"; C4="$ROOT/calls-match"; make_home "$H4"
CFG="$ROOT/isolated-config"; mkdir -p "$CFG"
if run_case match "$H4" "$C4" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$CFG" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG"; then
  if [[ ! -f "$C4/check.count" && ! -f "$C4/updated" ]] \
      && grep -q "isolated CLAUDE_CONFIG_DIR" "$C4/launcher.log"; then
    pass "exact isolated config match skips without touching production scripts"
  else
    fail "matching skip" "production scripts ran or skip was not auditable"
  fi
else
  fail "matching skip" "valid isolated skip exited non-zero"
fi

# Codex R1 HIGH: a root-only comparison is not isolation. An isolated root
# whose plugin surface symlinks back to the production plugin cache must be
# rejected — otherwise the skip is granted while Claude still reads and writes
# production plugin bytes, defeating the whole seam.
for surface in plugins plugins/cache plugins/marketplaces; do
  variant="symlink-$(printf '%s' "$surface" | tr '/' '-')"
  H="$ROOT/home-$variant"; C="$ROOT/calls-$variant"; make_home "$H"
  mkdir -p "$H/.claude/plugins/cache" "$H/.claude/plugins/marketplaces"
  CFG_S="$ROOT/config-$variant"
  mkdir -p "$CFG_S/$(dirname "$surface")"
  ln -s "$H/.claude/$surface" "$CFG_S/$surface"
  if run_case "$variant" "$H" "$C" \
      TEST_SKIP_PLUGIN_FORK_CHECK=1 \
      CLAUDE_CONFIG_DIR="$CFG_S" \
      TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_S"; then
    fail "$variant" "isolated root with $surface symlinked to production was accepted"
  elif grep -q "escapes the isolated root" "$C/launcher.log" \
      && [[ ! -f "$C/check.count" && ! -f "$C/updated" ]]; then
    pass "$surface symlinked into production plugin cache is rejected"
  else
    fail "$variant" "rejected for the wrong reason (expected plugin-tree containment guard)"
  fi
done

# Codex R2: the escape can be arbitrarily deep — plugins/cache is a real
# isolated directory, but the plugin VERSION directory inside it points back at
# production. A top-level surface check accepts this while Claude still loads
# production plugin bytes, so the whole subtree has to be walked.
H_D="$ROOT/home-deep"; C_D="$ROOT/calls-deep"; make_home "$H_D"
DEEP_PROD="$H_D/.claude/plugins/cache/claude-plugins-official/discord/0.0.4"
mkdir -p "$DEEP_PROD"
printf 'PRODUCTION PLUGIN BYTES\n' > "$DEEP_PROD/server.ts"
CFG_D="$ROOT/config-deep"
mkdir -p "$CFG_D/plugins/cache/claude-plugins-official/discord"
ln -s "$DEEP_PROD" "$CFG_D/plugins/cache/claude-plugins-official/discord/0.0.4"
if run_case deep "$H_D" "$C_D" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$CFG_D" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_D"; then
  fail "deep" "deep plugin symlink into production was accepted"
elif grep -q "escapes the isolated root" "$C_D/launcher.log" \
    && [[ ! -f "$C_D/check.count" && ! -f "$C_D/updated" ]]; then
  pass "deep plugin symlink into production is rejected"
else
  fail "deep" "rejected for the wrong reason (expected plugin-tree containment guard)"
fi

# Codex R2: a relative CLAUDE_CONFIG_DIR is validated against the launcher's
# cwd but consumed by a Lead tmux starts with `-c "$LEAD_WORKSPACE"`, so the
# same string can mean the isolated root here and the production root there.
# Only an absolute path is verifiable — reject relative outright.
H_R="$ROOT/home-relative"; C_R="$ROOT/calls-relative"; make_home "$H_R"
mkdir -p "$H_R/.claude/plugins"
if run_case relative "$H_R" "$C_R" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR=".claude" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR=".claude"; then
  fail "relative" "relative CLAUDE_CONFIG_DIR was accepted"
elif grep -q "requires an ABSOLUTE CLAUDE_CONFIG_DIR" "$C_R/launcher.log" \
    && [[ ! -f "$C_R/check.count" && ! -f "$C_R/updated" ]]; then
  pass "relative CLAUDE_CONFIG_DIR is rejected (cwd-dependent, unverifiable)"
else
  fail "relative" "rejected for the wrong reason (expected absolute-path guard)"
fi

# An isolated root nested INSIDE the production config root is not isolated.
H_N="$ROOT/home-nested"; C_N="$ROOT/calls-nested"; make_home "$H_N"
mkdir -p "$H_N/.claude/nested-config"
if run_case nested "$H_N" "$C_N" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$H_N/.claude/nested-config" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$H_N/.claude/nested-config"; then
  fail "nested" "config root inside the production Claude root was accepted"
elif grep -q "nested inside the production Claude config root" "$C_N/launcher.log"; then
  pass "config root nested inside the production Claude root is rejected"
else
  fail "nested" "rejected for the wrong reason (expected nested-root guard)"
fi

# Codex R3: on a case-insensitive volume ~/.CLAUDE and ~/.claude are the SAME
# directory, but pwd -P and realpath both preserve the caller's casing, so a
# path-string comparison says they differ. Identity must come from
# (device, inode). On a case-sensitive filesystem the alias is genuinely a
# different directory, so the case is reported as not applicable rather than
# silently passing.
H_CI="$ROOT/home-caseless"; C_CI="$ROOT/calls-caseless"; make_home "$H_CI"
mkdir -p "$H_CI/.claude/plugins"
if [[ -d "$H_CI/.CLAUDE" ]]; then
  if run_case caseless "$H_CI" "$C_CI" \
      TEST_SKIP_PLUGIN_FORK_CHECK=1 \
      CLAUDE_CONFIG_DIR="$H_CI/.CLAUDE" \
      TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$H_CI/.CLAUDE"; then
    fail "caseless" "case-aliased production root was accepted"
  elif grep -q "IS the production Claude config root" "$C_CI/launcher.log"; then
    pass "case-aliased production root is rejected by inode identity"
  else
    fail "caseless" "rejected for the wrong reason (expected identity guard)"
  fi
else
  echo "[TEST] — case-alias case not applicable (case-sensitive filesystem)"
fi

# Codex R3: a dangling plugins root. The link target does not exist yet, so an
# existence-gated check never runs at all and the skip is granted; Claude then
# creates the target on first write.
H_DL="$ROOT/home-dangling"; C_DL="$ROOT/calls-dangling"; make_home "$H_DL"
mkdir -p "$H_DL/.claude"
CFG_DL="$ROOT/config-dangling"; mkdir -p "$CFG_DL"
ln -s "$H_DL/.claude/plugins" "$CFG_DL/plugins"   # target intentionally absent
if run_case dangling "$H_DL" "$C_DL" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$CFG_DL" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_DL"; then
  fail "dangling" "dangling plugins root link was accepted"
elif grep -q "dangling link" "$C_DL/launcher.log"; then
  pass "dangling plugins root link is rejected"
else
  fail "dangling" "rejected for the wrong reason (expected dangling-link guard)"
fi

# A dangling link NESTED inside an otherwise valid plugin tree. Mutation
# testing showed the root-level dangling case did not exercise this branch, so
# it gets its own fixture rather than riding on the root case.
H_DI="$ROOT/home-dangling-inner"; C_DI="$ROOT/calls-dangling-inner"; make_home "$H_DI"
mkdir -p "$H_DI/.claude/plugins"
CFG_DI="$ROOT/config-dangling-inner"
mkdir -p "$CFG_DI/plugins/cache/claude-plugins-official/discord"
ln -s "$H_DI/.claude/plugins/cache/claude-plugins-official/discord/0.0.4" \
  "$CFG_DI/plugins/cache/claude-plugins-official/discord/0.0.4"   # target absent
if run_case dangling-inner "$H_DI" "$C_DI" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$CFG_DI" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_DI"; then
  fail "dangling-inner" "dangling link inside the plugin tree was accepted"
elif grep -q "dangling link in plugin tree" "$C_DI/launcher.log"; then
  pass "dangling link nested inside the plugin tree is rejected"
else
  fail "dangling-inner" "rejected for the wrong reason (expected inner dangling-link guard)"
fi

# Codex R3: laundering through an innocent third directory. The plugin link
# points somewhere harmless; that directory then links on to production. A
# guard that only asks "does this land in production" misses the first hop, so
# the invariant is containment within the isolated root, not production-avoidance.
H_LA="$ROOT/home-laundered"; C_LA="$ROOT/calls-laundered"; make_home "$H_LA"
mkdir -p "$H_LA/.claude/plugins/cache"
OUTSIDE="$ROOT/outside-dir"; mkdir -p "$OUTSIDE"
ln -s "$H_LA/.claude/plugins/cache" "$OUTSIDE/cache"
CFG_LA="$ROOT/config-laundered"; mkdir -p "$CFG_LA/plugins"
ln -s "$OUTSIDE" "$CFG_LA/plugins/cache"
if run_case laundered "$H_LA" "$C_LA" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$CFG_LA" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_LA"; then
  fail "laundered" "plugin link laundered through an outside directory was accepted"
elif grep -q "escapes the isolated root" "$C_LA/launcher.log"; then
  pass "plugin link escaping the isolated root is rejected (even via a third directory)"
else
  fail "laundered" "rejected for the wrong reason (expected containment guard)"
fi

# Codex R3: a hardlink is not a link as far as islink() is concerned, but it is
# the same bytes on the same inode as the production file.
H_HL="$ROOT/home-hardlink"; C_HL="$ROOT/calls-hardlink"; make_home "$H_HL"
PROD_HL="$H_HL/.claude/plugins/cache/claude-plugins-official/discord/0.0.4"
mkdir -p "$PROD_HL"
printf 'PRODUCTION PLUGIN BYTES\n' > "$PROD_HL/server.ts"
CFG_HL="$ROOT/config-hardlink"
mkdir -p "$CFG_HL/plugins/cache/claude-plugins-official/discord/0.0.4"
if ln "$PROD_HL/server.ts" "$CFG_HL/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts" 2>/dev/null; then
  if run_case hardlink "$H_HL" "$C_HL" \
      TEST_SKIP_PLUGIN_FORK_CHECK=1 \
      CLAUDE_CONFIG_DIR="$CFG_HL" \
      TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_HL"; then
    fail "hardlink" "file hardlinked to the production plugin tree was accepted"
  elif grep -q "hardlink to the production plugin tree" "$C_HL/launcher.log"; then
    pass "file hardlinked to the production plugin tree is rejected"
  else
    fail "hardlink" "rejected for the wrong reason (expected hardlink identity guard)"
  fi
else
  fail "hardlink" "could not create a hardlink fixture (cross-device?)"
fi

# Codex R4: the registries are ordinary files with st_nlink == 1 and no links
# anywhere, so filesystem containment never looks at them — yet a single missed
# rewrite during QA setup leaves installPath / installLocation / source.path
# aimed at production and the skip is still granted. This is the ordinary
# operator-misconfiguration case, which is exactly what this seam is for.
H_IP="$ROOT/home-registry-installed"; C_IP="$ROOT/calls-registry-installed"; make_home "$H_IP"
mkdir -p "$H_IP/.claude/plugins/cache/claude-plugins-official/discord/0.0.4"
CFG_IP="$ROOT/config-registry-installed"; mkdir -p "$CFG_IP/plugins"
cat > "$CFG_IP/plugins/installed_plugins.json" <<JSON
{"plugins":{"discord@claude-plugins-official":[{"installPath":"$H_IP/.claude/plugins/cache/claude-plugins-official/discord/0.0.4"}]}}
JSON
if run_case registry-installed "$H_IP" "$C_IP" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$CFG_IP" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_IP"; then
  fail "registry-installed" "installed_plugins.json pointing at production was accepted"
elif grep -q "installed_plugins.json .* points outside the isolated root" "$C_IP/launcher.log"; then
  pass "installed_plugins.json installPath aimed at production is rejected"
else
  fail "registry-installed" "rejected for the wrong reason (expected registry path guard)"
fi

H_KM="$ROOT/home-registry-market"; C_KM="$ROOT/calls-registry-market"; make_home "$H_KM"
mkdir -p "$H_KM/.claude/plugins/marketplaces/claude-plugins-official"
CFG_KM="$ROOT/config-registry-market"; mkdir -p "$CFG_KM/plugins"
cat > "$CFG_KM/plugins/known_marketplaces.json" <<JSON
{"claude-plugins-official":{"source":{"source":"directory","path":"$H_KM/.claude/plugins/marketplaces/claude-plugins-official"},"installLocation":"$H_KM/.claude/plugins/marketplaces/claude-plugins-official"}}
JSON
if run_case registry-market "$H_KM" "$C_KM" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$CFG_KM" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_KM"; then
  fail "registry-market" "known_marketplaces.json pointing at production was accepted"
elif grep -q "known_marketplaces.json .* points outside the isolated root" "$C_KM/launcher.log"; then
  pass "known_marketplaces.json installLocation/source.path aimed at production is rejected"
else
  fail "registry-market" "rejected for the wrong reason (expected registry path guard)"
fi

# A registry we cannot parse is a registry we cannot verify — fail closed.
H_MJ="$ROOT/home-registry-malformed"; C_MJ="$ROOT/calls-registry-malformed"; make_home "$H_MJ"
mkdir -p "$H_MJ/.claude/plugins"
CFG_MJ="$ROOT/config-registry-malformed"; mkdir -p "$CFG_MJ/plugins"
printf '{ this is not json' > "$CFG_MJ/plugins/installed_plugins.json"
if run_case registry-malformed "$H_MJ" "$C_MJ" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$CFG_MJ" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_MJ"; then
  fail "registry-malformed" "unparseable registry was accepted"
elif grep -q "could not verify installed_plugins.json" "$C_MJ/launcher.log"; then
  pass "unparseable registry fails closed"
else
  fail "registry-malformed" "rejected for the wrong reason (expected fail-closed parse guard)"
fi

# A correctly rewritten registry pointing INSIDE the isolated root must still
# be accepted — otherwise the guard would block the very setup it exists for.
H_OK="$ROOT/home-registry-ok"; C_OK="$ROOT/calls-registry-ok"; make_home "$H_OK"
mkdir -p "$H_OK/.claude/plugins"
CFG_OK="$ROOT/config-registry-ok"
mkdir -p "$CFG_OK/plugins/cache/claude-plugins-official/discord/0.0.4"
cat > "$CFG_OK/plugins/installed_plugins.json" <<JSON
{"plugins":{"discord@claude-plugins-official":[{"installPath":"$CFG_OK/plugins/cache/claude-plugins-official/discord/0.0.4"}]}}
JSON
if run_case registry-ok "$H_OK" "$C_OK" \
    TEST_SKIP_PLUGIN_FORK_CHECK=1 \
    CLAUDE_CONFIG_DIR="$CFG_OK" \
    TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$CFG_OK"; then
  if grep -q "isolated CLAUDE_CONFIG_DIR" "$C_OK/launcher.log"; then
    pass "correctly rewritten registry inside the isolated root is accepted"
  else
    fail "registry-ok" "accepted but the skip was not auditable"
  fi
else
  fail "registry-ok" "a correctly rewritten registry was rejected"
fi

# Codex R1 MEDIUM: ordering. The guard must run BEFORE the launcher makes its
# first CLAUDE_CONFIG_DIR-derived write, so a rejected skip request leaves the
# production agent file byte-identical. Extracting only the preflight block
# cannot observe this, so this case runs the launcher's real prologue up to
# and including the agent-file copy.
PROLOGUE="$ROOT/prologue.sh"
awk '
  /^# ── FLY-1439: validate an isolated-CLAUDE_CONFIG_DIR skip request ──$/ { in_block = 1 }
  in_block && /^# ── GEO-285: Install PostCompact hook/ { exit }
  in_block { print }
' "$LAUNCHER" > "$PROLOGUE"

if ! grep -q 'validate_isolated_claude_config$' "$PROLOGUE" \
  || ! grep -q 'cp "\$AGENT_SOURCE" "\$AGENT_TARGET"' "$PROLOGUE"; then
  fail "ordering fixture" "prologue must contain both the guard call and the agent copy"
else
  H_O="$ROOT/home-order"; C_O="$ROOT/calls-order"; make_home "$H_O"
  mkdir -p "$H_O/.claude/agents" "$H_O/.claude/plugins"
  SENTINEL="$H_O/.claude/agents/qa-lead.md"
  printf 'PRODUCTION SENTINEL — must not be overwritten\n' > "$SENTINEL"
  SENTINEL_BEFORE="$(shasum -a 256 "$SENTINEL" | awk '{print $1}')"
  mkdir -p "$ROOT/proj-order/.lead/qa-lead"
  printf 'QA AGENT CONTENT\n' > "$ROOT/proj-order/.lead/qa-lead/identity.md"
  mkdir -p "$C_O"
  (
    env -i HOME="$H_O" PATH="/usr/bin:/bin" TEST_CALL_DIR="$C_O" \
      LEAD_ID=qa-lead PROJECT_DIR="$ROOT/proj-order" \
      TEST_SKIP_PLUGIN_FORK_CHECK=1 \
      CLAUDE_CONFIG_DIR="$H_O/.claude" \
      TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$H_O/.claude" \
      bash -c 'set -euo pipefail; log() { printf "%s\n" "$*" >> "${TEST_CALL_DIR}/launcher.log"; }; source "$1"' \
      _ "$PROLOGUE"
  ) >"$C_O/stdout" 2>"$C_O/stderr"
  ORDER_RC=$?
  SENTINEL_AFTER="$(shasum -a 256 "$SENTINEL" | awk '{print $1}')"
  if [[ "$ORDER_RC" -eq 0 ]]; then
    fail "ordering" "production config root was accepted by the prologue"
  elif [[ "$SENTINEL_BEFORE" == "$SENTINEL_AFTER" ]]; then
    pass "guard rejects before any production agent write (sentinel byte-identical)"
  else
    fail "ordering" "production agent file was overwritten before the guard aborted"
  fi
fi

echo
echo "[TEST] claude-lead-plugin-fork-check: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
