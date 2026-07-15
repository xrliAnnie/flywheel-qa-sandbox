#!/usr/bin/env bash
# FLY-1023 M4/M6: flywheel-connector.sh — thin CLI over the buddy connectors.
#
#   flywheel-connector.sh <system> <probe|pull>   (read-only verbs only)
#
# One JSON line on stdout; used by the Captain's first-output skill (and
# tests) to read business systems that onboarding already connected. The
# connect verb is deliberately NOT exposed here — connecting collects a
# secret and belongs to the Buddy conversation's hidden-input flow.
set -uo pipefail

FC_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FC_CONNECTOR_DIR="${FLYWHEEL_BUDDY_CONNECTOR_DIR:-$FC_SCRIPT_DIR/lib/buddy-connectors}"

sys="${1:-}"; verb="${2:-}"
case "$verb" in
  probe|pull) : ;;
  *) echo '{"ok":false,"error_code":"bad_usage","hint":"usage: flywheel-connector.sh <system> <probe|pull>"}'; exit 1 ;;
esac
case "$sys" in
  shopify|veeqo|ordoro|imap) : ;;
  email|gmail) sys=imap ;;
  *) echo '{"ok":false,"error_code":"unknown_system"}'; exit 1 ;;
esac

export FLYWHEEL_SETUP_SOURCED=1
FLYWHEEL_SETUP_STATE_DIR="${FLYWHEEL_SETUP_STATE_DIR:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}}"
export FLYWHEEL_SETUP_STATE_DIR
# shellcheck source=flywheel-setup.sh
source "$FC_SCRIPT_DIR/flywheel-setup.sh"
# shellcheck disable=SC1090
source "$FC_CONNECTOR_DIR/$sys.sh" || { echo '{"ok":false,"error_code":"connector_missing"}'; exit 1; }
"connector_$verb"
