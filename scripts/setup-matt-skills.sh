#!/usr/bin/env bash
# FLY-1356 — install the frozen matt-skills B-arm plugin (deployment surface).
#
# Idempotent: re-running produces no changes. Installs the vendored plugin at
# vendor/matt-skills as `matt-skills@matt-skills` in USER scope and pins it
# machine-level DISABLED in ~/.claude/settings.json — Runners only ever see it
# through Blueprint's per-launch `--settings` enable (skill_framework_mode=
# matt). Run this BEFORE opening `split` (runbook precondition); Blueprint's
# readiness probe never caches a negative, so this takes effect on the next
# matt-resolved run without a Bridge restart.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/matt-skills"
PLUGIN_KEY="matt-skills@matt-skills"
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

[[ -f "$VENDOR_DIR/.claude-plugin/plugin.json" ]] || {
	echo "ERROR: $VENDOR_DIR/.claude-plugin/plugin.json not found" >&2
	exit 1
}
command -v claude >/dev/null || {
	echo "ERROR: claude CLI not on PATH" >&2
	exit 1
}
# Bar-Raiser LOW-2: node runs the false-pin (step 3). Without it the install
# step would leave the plugin AUTO-ENABLED machine-wide — refuse up front.
command -v node >/dev/null || {
	echo "ERROR: node not on PATH (required for the settings.json false-pin)" >&2
	exit 1
}

# 1. Local marketplace (idempotent — add only when absent).
if ! claude plugin marketplace list 2>/dev/null | grep -q "matt-skills"; then
	echo "[setup-matt-skills] adding local marketplace: $VENDOR_DIR"
	claude plugin marketplace add "$VENDOR_DIR"
else
	echo "[setup-matt-skills] marketplace matt-skills already configured"
fi

# 2. User-scope install (idempotent — install only when absent).
if ! claude plugin list 2>/dev/null | grep -q "matt-skills"; then
	echo "[setup-matt-skills] installing $PLUGIN_KEY (user scope)"
	claude plugin install "$PLUGIN_KEY"
else
	echo "[setup-matt-skills] $PLUGIN_KEY already installed"
fi

# 3. Machine-level default DISABLED (settings.json enabledPlugins) —
# UNCONDITIONALLY pinned to false. `claude plugin install` auto-enables the
# plugin it just installed (writes `true` — real-machine finding, 2026-07-20),
# which would put the B-arm skills in EVERY session including Leads. This
# script's contract is machine-level OFF: only Blueprint's per-launch
# --settings enable (highest non-managed precedence, FLY-1185 measured) turns
# it on for a matt-arm Runner. Idempotent: re-running keeps false.
node -e '
const fs = require("fs");
const path = process.argv[1];
const key = process.argv[2];
let settings = {};
// Bar-Raiser LOW-3: an EXISTING but unparseable settings.json must fail loud
// — silently rewriting it wholesale would destroy the operator's config.
if (fs.existsSync(path)) {
	settings = JSON.parse(fs.readFileSync(path, "utf-8"));
}
settings.enabledPlugins = settings.enabledPlugins || {};
if (settings.enabledPlugins[key] === false) {
	console.log(`[setup-matt-skills] ${key} already pinned false in ${path}`);
} else {
	const prev = settings.enabledPlugins[key];
	settings.enabledPlugins[key] = false;
	fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
	console.log(`[setup-matt-skills] ${key}: pinned false in ${path} (was: ${prev === undefined ? "absent" : prev} — plugin install auto-enables, this script always re-pins OFF)`);
}
' "$SETTINGS" "$PLUGIN_KEY"

# 4. Verify — the same probe Blueprint runs at resolution time.
echo "[setup-matt-skills] verification (claude plugin details):"
claude plugin details "$PLUGIN_KEY"
