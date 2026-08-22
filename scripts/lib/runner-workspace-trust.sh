#!/usr/bin/env bash
# FLY-1961: pre-seed Claude + Codex workspace trust before a QA/legacy run POST.
# Source this file for pretrust_workspace_dual(), or invoke the CLI below.

: "${CLAUDE_LOCK_STALE_S:=60}"
: "${CLAUDE_LOCK_WAIT_S:=30}"
RUNNER_WORKSPACE_TRUST_HELD_LOCK=""
RUNNER_WORKSPACE_TRUST_CANONICAL=""

runner_workspace_trust_log() {
  printf '[workspace-trust] %s\n' "$*" >&2
}

runner_workspace_trust_validate_lock_env() {
  case "$CLAUDE_LOCK_STALE_S" in
    ''|*[!0-9]*) runner_workspace_trust_log "ERROR: CLAUDE_LOCK_STALE_S must be a non-negative integer"; return 1 ;;
  esac
  case "$CLAUDE_LOCK_WAIT_S" in
    ''|*[!0-9]*) runner_workspace_trust_log "ERROR: CLAUDE_LOCK_WAIT_S must be a non-negative integer"; return 1 ;;
  esac
}

runner_workspace_trust_canonical_future_path() {
  local target="$1" parent basename canonical_parent
  parent="$(dirname "$target")"
  basename="$(basename "$target")"
  if [[ ! -d "$parent" ]]; then
    runner_workspace_trust_log "ERROR: parent ${parent} does not exist; cannot canonicalize ${target}"
    return 1
  fi
  canonical_parent="$(cd "$parent" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$canonical_parent" "$basename"
}

# Byte-compatible with inject-linear-issue.sh/test-teardown.sh and the Node
# withMkdirLock({bare:true}) peer: empty mkdir mutex, 60s stale break, 30s wait.
runner_workspace_trust_acquire_lock() {
  local lock="$1" label="$2"
  local waited_ms=0 step_ms=100 max_ms=$((CLAUDE_LOCK_WAIT_S * 1000))
  runner_workspace_trust_validate_lock_env || return 1
  while ! mkdir "$lock" 2>/dev/null; do
    if [[ -d "$lock" ]]; then
      local mtime now age
      mtime=$(stat -f %m "$lock" 2>/dev/null) || mtime=""
      if [[ -z "$mtime" || "$mtime" == *[!0-9]* ]]; then
        mtime=$(stat -c %Y "$lock" 2>/dev/null) || mtime=""
      fi
      if [[ "$mtime" == *[!0-9]* ]]; then
        mtime=""
      fi
      now=$(date +%s)
      if [[ -n "$mtime" ]]; then
        age=$((now - mtime))
        if (( age > CLAUDE_LOCK_STALE_S )); then
          runner_workspace_trust_log "WARN: stealing stale ${label} lock ${lock} (age ${age}s)"
          rmdir "$lock" 2>/dev/null || true
          continue
        fi
      fi
    fi
    if (( waited_ms >= max_ms )); then
      runner_workspace_trust_log "ERROR: timed out waiting for ${label} lock ${lock} after ${CLAUDE_LOCK_WAIT_S}s"
      return 1
    fi
    sleep 0.1
    waited_ms=$((waited_ms + step_ms))
  done
  RUNNER_WORKSPACE_TRUST_HELD_LOCK="$lock"
}

runner_workspace_trust_release_lock() {
  local lock="$1"
  if [[ "$RUNNER_WORKSPACE_TRUST_HELD_LOCK" == "$lock" ]]; then
    rmdir "$lock" 2>/dev/null || {
      runner_workspace_trust_log "ERROR: could not release owned lock ${lock}"
      return 1
    }
    RUNNER_WORKSPACE_TRUST_HELD_LOCK=""
  fi
}

runner_workspace_trust_file_mode() {
  local path="$1" fallback="$2" mode
  if [[ -e "$path" ]]; then
    mode="$(stat -f %Lp "$path" 2>/dev/null)" \
      && [[ -n "$mode" && "$mode" != *[!0-7]* ]] \
      && printf '%s\n' "$mode" \
      && return 0
    mode="$(stat -c %a "$path" 2>/dev/null)" \
      && [[ -n "$mode" && "$mode" != *[!0-7]* ]] \
      && printf '%s\n' "$mode" \
      && return 0
    runner_workspace_trust_log "ERROR: could not read a valid file mode for ${path}"
    return 1
  else
    printf '%s\n' "$fallback"
  fi
}

runner_workspace_trust_write_claude() {
  local canonical="$1"
  local claude_json="${FLYWHEEL_CLAUDE_JSON:-${HOME}/.claude.json}"
  local lock="${FLYWHEEL_CLAUDE_JSON_LOCK:-${claude_json}.lock}"
  local mode tmp py_status verify_status release_status=0
  mkdir -p "$(dirname "$claude_json")" || return 1
  runner_workspace_trust_acquire_lock "$lock" "Claude JSON" || return 1
  mode="$(runner_workspace_trust_file_mode "$claude_json" 600)" || {
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }
  tmp="$(mktemp "${claude_json}.tmp.XXXXXX")" || {
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }

  if python3 - "$claude_json" "$canonical" "$tmp" <<'PY'
import json, os, sys

source, target, output = sys.argv[1:]
try:
    if os.path.exists(source):
        with open(source, encoding="utf-8") as handle:
            state = json.load(handle)
    else:
        state = {}
    if not isinstance(state, dict):
        raise ValueError("root must be an object")
    projects = state.get("projects", {})
    if not isinstance(projects, dict):
        raise ValueError("projects must be an object")
    entry = projects.get(target)
    if entry is not None and not isinstance(entry, dict):
        raise ValueError("project entry must be an object")
    if isinstance(entry, dict) and entry.get("hasTrustDialogAccepted") is True:
        raise SystemExit(3)
    projects[target] = {**(entry or {}), "hasTrustDialogAccepted": True}
    state["projects"] = projects
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
except SystemExit:
    raise
except Exception as error:
    print(f"[workspace-trust] ERROR: Claude state is invalid or unsupported: {type(error).__name__}", file=sys.stderr)
    raise SystemExit(2)
PY
  then
    py_status=0
  else
    py_status=$?
  fi

  if [[ "$py_status" -eq 3 ]]; then
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock"
    return $?
  fi
  if [[ "$py_status" -ne 0 ]]; then
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock" || true
    return "$py_status"
  fi
  chmod "$mode" "$tmp" || {
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }
  mv -f "$tmp" "$claude_json" || {
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }
  if python3 - "$claude_json" "$canonical" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    state = json.load(handle)
assert state.get("projects", {}).get(sys.argv[2], {}).get("hasTrustDialogAccepted") is True
PY
  then
    verify_status=0
  else
    verify_status=$?
    runner_workspace_trust_log "ERROR: Claude post-write trust verification failed"
  fi
  runner_workspace_trust_release_lock "$lock" || release_status=$?
  [[ "$verify_status" -eq 0 && "$release_status" -eq 0 ]]
}

runner_workspace_trust_write_codex() {
  local canonical="$1"
  local codex_home="${FLYWHEEL_CODEX_SOURCE_HOME:-${HOME}/.codex}"
  local config="${codex_home}/config.toml" lock="${codex_home}/config.toml.lock"
  local mode tmp py_status verify_status release_status=0
  mkdir -p "$codex_home" || return 1
  runner_workspace_trust_acquire_lock "$lock" "Codex TOML" || return 1
  mode="$(runner_workspace_trust_file_mode "$config" 600)" || {
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }
  tmp="$(mktemp "${config}.tmp.XXXXXX")" || {
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }

  if python3 - "$config" "$canonical" "$tmp" <<'PY'
import base64, copy, json, os, sys, tomllib

source, target, output = sys.argv[1:]
try:
    raw = ""
    if os.path.exists(source):
        with open(source, encoding="utf-8") as handle:
            raw = handle.read()
    base = tomllib.loads(raw)
    projects = base.get("projects", {})
    if not isinstance(projects, dict):
        raise ValueError("projects must be a table")
    entry = projects.get(target)
    if entry is not None:
        if not isinstance(entry, dict) or entry.get("trust_level") != "trusted":
            raise ValueError("existing target is not trusted")
        raise SystemExit(3)
    token = base64.urlsafe_b64encode(target.encode()).decode().rstrip("=")
    key = json.dumps(target, ensure_ascii=True)
    separator = "" if not raw or raw.endswith("\n") else "\n"
    block = (
        f"{separator}\n# >>> flywheel-managed QA workspace trust (FLY-1961) {token} >>>\n"
        f"[projects.{key}]\ntrust_level = \"trusted\"\n"
        "# <<< flywheel-managed QA workspace trust (FLY-1961) <<<\n"
    )
    candidate = raw + block
    rendered = tomllib.loads(candidate)
    assert rendered["projects"][target]["trust_level"] == "trusted"
    comparison = copy.deepcopy(rendered)
    if "projects" in base:
        comparison["projects"] = copy.deepcopy(base["projects"])
    else:
        comparison.pop("projects", None)
    if comparison != base:
        raise ValueError("unrelated config changed")
    with open(output, "w", encoding="utf-8") as handle:
        handle.write(candidate)
except SystemExit:
    raise
except Exception as error:
    print(f"[workspace-trust] ERROR: Codex config is invalid or unsupported: {type(error).__name__}", file=sys.stderr)
    raise SystemExit(2)
PY
  then
    py_status=0
  else
    py_status=$?
  fi

  if [[ "$py_status" -eq 3 ]]; then
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock"
    return $?
  fi
  if [[ "$py_status" -ne 0 ]]; then
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock" || true
    return "$py_status"
  fi
  chmod "$mode" "$tmp" || {
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }
  mv -f "$tmp" "$config" || {
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }
  if python3 - "$config" "$canonical" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as handle:
    config = tomllib.load(handle)
assert config.get("projects", {}).get(sys.argv[2], {}).get("trust_level") == "trusted"
PY
  then
    verify_status=0
  else
    verify_status=$?
    runner_workspace_trust_log "ERROR: Codex post-write trust verification failed"
  fi
  runner_workspace_trust_release_lock "$lock" || release_status=$?
  [[ "$verify_status" -eq 0 && "$release_status" -eq 0 ]]
}

pretrust_workspace_dual() {
  local target="$1" canonical
  canonical="$(runner_workspace_trust_canonical_future_path "$target")" || return 1
  runner_workspace_trust_write_claude "$canonical" || return 1
  runner_workspace_trust_write_codex "$canonical" || return 1
  RUNNER_WORKSPACE_TRUST_CANONICAL="$canonical"
}

prune_codex_workspace_trust_prefix() {
  local raw_prefix="$1" canonical_prefix codex_home config lock mode tmp py_status release_status=0
  canonical_prefix="$(runner_workspace_trust_canonical_future_path "$raw_prefix")" || return 1
  case "$canonical_prefix" in */) ;; *) canonical_prefix="${canonical_prefix}/" ;; esac
  codex_home="${FLYWHEEL_CODEX_SOURCE_HOME:-${HOME}/.codex}"
  config="${codex_home}/config.toml"
  lock="${codex_home}/config.toml.lock"
  [[ -f "$config" ]] || return 0
  runner_workspace_trust_acquire_lock "$lock" "Codex TOML" || return 1
  mode="$(runner_workspace_trust_file_mode "$config" 600)" || {
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }
  tmp="$(mktemp "${config}.tmp.XXXXXX")" || {
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  }

  if python3 - "$config" "$canonical_prefix" "$tmp" <<'PY'
import base64, copy, re, sys, tomllib

source, prefix, output = sys.argv[1:]
begin = r"# >>> flywheel-managed QA workspace trust \(FLY-1961\) ([A-Za-z0-9_-]+) >>>"
end = r"# <<< flywheel-managed QA workspace trust \(FLY-1961\) <<<"
pattern = re.compile(rf"\n*{begin}\n.*?\n{end}\n?", re.DOTALL)
try:
    with open(source, encoding="utf-8") as handle:
        raw = handle.read()
    before = tomllib.loads(raw)
    selected = []
    def replace(match):
        token = match.group(1)
        token += "=" * (-len(token) % 4)
        path = base64.urlsafe_b64decode(token).decode()
        if path.startswith(prefix):
            selected.append(path)
            return "\n"
        return match.group(0)
    candidate = pattern.sub(replace, raw)
    if not selected:
        raise SystemExit(3)
    after = tomllib.loads(candidate)
    for path in selected:
        if before.get("projects", {}).get(path, {}).get("trust_level") != "trusted":
            raise ValueError("managed marker target is not trusted")
        if path in after.get("projects", {}):
            raise ValueError("selected target survived prune")
    normalized_before = copy.deepcopy(before)
    normalized_after = copy.deepcopy(after)
    for state in (normalized_before, normalized_after):
        projects = state.get("projects")
        if isinstance(projects, dict):
            for path in selected:
                projects.pop(path, None)
            if not projects:
                state.pop("projects", None)
    if normalized_before != normalized_after:
        raise ValueError("prune altered unrelated config")
    with open(output, "w", encoding="utf-8") as handle:
        handle.write(candidate)
except SystemExit:
    raise
except Exception as error:
    print(f"[workspace-trust] ERROR: managed Codex prune failed: {type(error).__name__}", file=sys.stderr)
    raise SystemExit(2)
PY
  then
    py_status=0
  else
    py_status=$?
  fi

  if [[ "$py_status" -eq 3 ]]; then
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock"
    return $?
  fi
  if [[ "$py_status" -ne 0 ]]; then
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock" || true
    return "$py_status"
  fi
  if ! chmod "$mode" "$tmp" || ! mv -f "$tmp" "$config"; then
    rm -f "$tmp"
    runner_workspace_trust_release_lock "$lock" || true
    return 1
  fi
  runner_workspace_trust_release_lock "$lock" || release_status=$?
  return "$release_status"
}

runner_workspace_trust_main() {
  local command="${1:-}" target="${2:-}"
  if [[ -z "$target" || "$#" -ne 2 ]]; then
    runner_workspace_trust_log "Usage: runner-workspace-trust.sh pretrust-dual|prune-codex-prefix <path>"
    return 64
  fi
  case "$command" in
    pretrust-dual)
      pretrust_workspace_dual "$target" || return $?
      printf '%s\n' "$RUNNER_WORKSPACE_TRUST_CANONICAL"
      ;;
    prune-codex-prefix)
      prune_codex_workspace_trust_prefix "$target"
      ;;
    *)
      runner_workspace_trust_log "ERROR: unknown command ${command}"
      return 64
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  runner_workspace_trust_main "$@"
fi
