#!/bin/bash
# FLY-310 E2E — minimal explicit launch env for the headless Codex Lead in QA slot 2.
# Sourced by the dry-run and the real launch. Pulls ONLY TEST_BOT_TOKEN_2 from .env
# (no other production secret enters this process's env).
WT=/Users/xiaorongli/Dev/flywheel-FLY-260
export FLYWHEEL_LEAD_ID="codex-qa-fly310"
export FLYWHEEL_PROJECT_NAME="growth"
export FLYWHEEL_LEAD_BOT_USER_ID="1493072948683341976"   # flywheel-test-2 (product-lead-test)
export DISCORD_BOT_TOKEN="$(grep '^TEST_BOT_TOKEN_2=' "$HOME/.flywheel/.env" | head -1 | cut -d= -f2- | tr -d '"'\''')"
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID="1493080993173737583"   # #product-lead-test (slot 2)
export FLYWHEEL_CODEX_LEAD_STATE_DIR="$HOME/.flywheel/state/codex-lead/fly310-e2e"
export CODEX_HOME="$HOME/.codex-fly310-e2e"                  # isolated canary home
export FLYWHEEL_CODEX_BIN="$(command -v codex)"
export FLYWHEEL_CODEX_LEAD_OUTBOUND="direct"                 # post with own bot token, no Bridge
export FLYWHEEL_CODEX_LEAD_SANDBOX="read-only"
export FLYWHEEL_CODEX_LEAD_READ_DENY="1"                     # FLY-260 deny ON (subject under test)
export RUNTIME="$WT/packages/teamlead/dist/lead-backends/codex/codex-lead-runtime.js"
mkdir -p "$FLYWHEEL_CODEX_LEAD_STATE_DIR"
