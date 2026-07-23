#!/usr/bin/env bash
# FLY-1439 QA: reproduce the LOW advisory — a non-traversable CLAUDE_CONFIG_DIR
# makes claude-lead.sh emit a bare `cd` error instead of its own guard message.
SC="$(cd "$(dirname "$0")" && pwd)"
T="${SC}/lowtest"
rm -rf "$T"
mkdir -p "$T/cfg"
chmod 000 "$T/cfg"

echo "--- claude-lead.sh:729-733 logic, config root exists but is not traversable ---"
(
  CLAUDE_CONFIG_DIR="$T/cfg"
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ -d "${CLAUDE_CONFIG_DIR}" ]; then
    QA_CLAUDE_CONFIG_REAL="$(cd "${CLAUDE_CONFIG_DIR}" && pwd -P)"
  fi
  echo "QA_CLAUDE_CONFIG_REAL=[${QA_CLAUDE_CONFIG_REAL:-}]"
) 2>&1

chmod 755 "$T/cfg"
rm -rf "$T"
