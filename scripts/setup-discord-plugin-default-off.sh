#!/bin/bash
# FLY-1715 — machine-level Discord plugin default-off safety net.
#
# Every known non-Lead Claude spawn also receives a per-launch deny setting.
# This script covers unknown/ad-hoc Claude launches without removing either
# plugin registration from the machine.
#
# Contract: idempotent, atomic same-directory replacement, mode preserving,
# refuses symlinks and malformed JSON, backup only when apply changes bytes,
# and exposes a validated restore operation.
set -euo pipefail

FORK_PLUGIN_KEY="discord@flywheel-plugins"
OFFICIAL_PLUGIN_KEY="discord@claude-plugins-official"

usage() {
  cat >&2 <<'EOF'
Usage:
  setup-discord-plugin-default-off.sh [settings-path]
  setup-discord-plugin-default-off.sh --restore <backup-path> [settings-path]

The settings path defaults to $HOME/.claude/settings.json.
EOF
  exit 2
}

refuse_symlink() {
  local path="$1"
  local label="$2"
  if [ -L "$path" ]; then
    echo "[setup-discord-plugin-default-off] REFUSE: $label $path is a symlink" >&2
    exit 1
  fi
}

require_file() {
  local path="$1"
  local label="$2"
  refuse_symlink "$path" "$label"
  if [ ! -f "$path" ]; then
    echo "[setup-discord-plugin-default-off] REFUSE: $label $path does not exist or is not a regular file" >&2
    exit 1
  fi
}

validate_settings_json() {
  local path="$1"
  local label="$2"
  if ! python3 - "$path" <<'PY' 2>/dev/null
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    settings = json.load(handle)

if not isinstance(settings, dict):
    raise TypeError("settings root must be an object")
plugins = settings.get("enabledPlugins")
if plugins is not None and not isinstance(plugins, dict):
    raise TypeError("enabledPlugins must be an object")
PY
  then
    echo "[setup-discord-plugin-default-off] REFUSE: $label $path is not valid Claude settings JSON" >&2
    exit 1
  fi
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

atomic_copy_preserving_target_mode() {
  local source="$1"
  local target="$2"
  local mode
  local temporary
  mode="$(file_mode "$target")"
  temporary="$(mktemp "${target}.tmp.XXXXXX")"
  if ! cp "$source" "$temporary" || ! chmod "$mode" "$temporary" || ! mv "$temporary" "$target"; then
    rm -f "$temporary"
    return 1
  fi
}

restore_backup() {
  local backup="$1"
  local settings="$2"
  require_file "$settings" "target"
  require_file "$backup" "backup"
  validate_settings_json "$backup" "backup"
  atomic_copy_preserving_target_mode "$backup" "$settings"
  echo "[setup-discord-plugin-default-off] restored: $settings from $backup"
}

apply_default_off() {
  local settings="$1"
  require_file "$settings" "target"
  validate_settings_json "$settings" "target"

  if python3 - "$settings" "$FORK_PLUGIN_KEY" "$OFFICIAL_PLUGIN_KEY" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    settings = json.load(handle)
plugins = settings.get("enabledPlugins", {})
raise SystemExit(0 if all(plugins.get(key) is False for key in sys.argv[2:]) else 1)
PY
  then
    echo "[setup-discord-plugin-default-off] no-op: both Discord plugin keys already false in $settings"
    return 0
  fi

  local mode
  local temporary
  mode="$(file_mode "$settings")"
  temporary="$(mktemp "${settings}.tmp.XXXXXX")"
  if ! python3 - "$settings" "$FORK_PLUGIN_KEY" "$OFFICIAL_PLUGIN_KEY" > "$temporary" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    settings = json.load(handle)
plugins = settings.setdefault("enabledPlugins", {})
for key in sys.argv[2:]:
    plugins[key] = False
json.dump(settings, sys.stdout, indent=2, ensure_ascii=False)
sys.stdout.write("\n")
PY
  then
    rm -f "$temporary"
    return 1
  fi
  if ! chmod "$mode" "$temporary"; then
    rm -f "$temporary"
    return 1
  fi

  local backup
  backup="$(mktemp "${settings}.bak-discord-plugin-default-off.XXXXXX")"
  if ! cp -p "$settings" "$backup"; then
    rm -f "$backup" "$temporary"
    return 1
  fi
  if ! mv "$temporary" "$settings"; then
    rm -f "$backup" "$temporary"
    return 1
  fi

  echo "[setup-discord-plugin-default-off] set both Discord plugin keys false in $settings (backup: $backup)"
}

case "${1:-}" in
  --help|-h)
    usage
    ;;
  --restore)
    [ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
    restore_backup "$2" "${3:-$HOME/.claude/settings.json}"
    ;;
  --*)
    usage
    ;;
  *)
    [ "$#" -le 1 ] || usage
    apply_default_off "${1:-$HOME/.claude/settings.json}"
    ;;
esac
