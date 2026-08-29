#!/usr/bin/env bash
# FLY-615: one-time, idempotent setup of the ponytail code-minimalism plugin
# for Claude Code, enforcing the "installed but GLOBALLY DISABLED" final state.
#
# Why globally disabled: Flywheel turns ponytail on per-RUN (via the resolution
# ladder run>label>project>off), passing `--settings enabledPlugins` only for
# runs that resolved "on". If ponytail were globally enabled, EVERY Claude
# Runner would inherit it and the per-project / per-issue rollout + A/B would be
# meaningless (and not byte-compatible). So this script installs the plugin and
# then explicitly disables it at the user scope, verifying the final state.
#
# Operator runs this ONCE per machine (a PR cannot install a global plugin).
# Codex Runners do NOT use the plugin (headless, no interactive hook-trust) —
# Flywheel injects the portable ponytail ruleset into the Codex prompt instead,
# so Codex needs no setup here.
#
# Usage:  scripts/setup-ponytail.sh
# Env:    CLAUDE_CONFIG_DIR (optional) — operate on a specific Claude config dir.
set -euo pipefail

MARKETPLACE_SRC="DietrichGebert/ponytail"
PLUGIN="ponytail@ponytail"

log()  { printf '[setup-ponytail] %s\n' "$*"; }
fail() { printf '[setup-ponytail] ERROR: %s\n' "$*" >&2; exit 1; }

# 1. Preflight — claude + node must be on PATH (ponytail's hooks require node).
command -v claude >/dev/null 2>&1 || fail "\`claude\` not on PATH — install Claude Code first."
command -v node   >/dev/null 2>&1 || fail "\`node\` not on PATH — ponytail's lifecycle hooks require node."
log "claude: $(command -v claude); node: $(node --version)"
[ -n "${CLAUDE_CONFIG_DIR:-}" ] && log "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}"

# 2. Install if absent (idempotent).
if claude plugin details "$PLUGIN" >/dev/null 2>&1; then
  log "$PLUGIN already installed — skipping marketplace add + install."
else
  log "Installing $PLUGIN ..."
  claude plugin marketplace add "$MARKETPLACE_SRC" || fail "marketplace add failed"
  claude plugin install "$PLUGIN" || fail "plugin install failed"
fi

# 3. ENFORCE the final state: installed but globally DISABLED. `install` may
#    leave the plugin enabled in ~/.claude/settings.json::enabledPlugins, so we
#    disable it explicitly. Idempotent (disabling an already-disabled plugin is
#    a no-op / harmless).
log "Disabling $PLUGIN globally (per-run enablement is Flywheel's job) ..."
claude plugin disable "$PLUGIN" >/dev/null 2>&1 || true

# 4. Verify the final state = installed AND not globally enabled.
claude plugin details "$PLUGIN" >/dev/null 2>&1 \
  || fail "post-setup verify: $PLUGIN is NOT installed (install/disable failed)."

if claude plugin list 2>/dev/null | grep -Eiq "ponytail.*enabled|enabled.*ponytail"; then
  fail "post-setup verify: $PLUGIN appears GLOBALLY ENABLED. Run: claude plugin disable $PLUGIN"
fi

log "OK — $PLUGIN is installed and globally disabled."
log "Per-project / per-issue rollout:"
log "  • per-project : flywheel-comm feature-flags set --name ponytail --to on --project <project> --reason \"enable ponytail rollout\""
log "  • per-issue   : add the Linear label 'ponytail' (force on) or 'ponytail-off' (force off)"
log "  • default     : off everywhere (byte-compatible)."
