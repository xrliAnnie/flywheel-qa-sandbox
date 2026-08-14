#!/usr/bin/env bash
# FLY-1759: reap arbitrary processes rooted in a worktree before filesystem
# teardown. This file is sourced by host projects that may not have Node dist.

_reap_worktree_guard() {
  local project_root="$1" target="$2" expected_parent target_parent
  local project_base target_base target_core target_real
  [[ "$project_root" == /* && "$target" == /* ]] || return 1
  [[ "$target" != "/" && -d "$target" && ! -L "$target" ]] || return 1
  expected_parent="$(cd "$(dirname "$project_root")" 2>/dev/null && pwd -P)" || return 1
  target_parent="$(cd "$(dirname "$target")" 2>/dev/null && pwd -P)" || return 1
  [[ "$target_parent" == "$expected_parent" ]] || return 1
  project_base="$(basename "$project_root")"
  target_base="$(basename "$target")"
  target_core="${target_base%%.removing-*}"
  target_core="${target_core%%.removing.*}"
  [[ "$target_core" == "$project_base"-* ]] || return 1
  target_real="$(cd "$target" 2>/dev/null && pwd -P)" || return 1
  [[ "$(dirname "$target_real")" == "$expected_parent" ]] || return 1
}

_reap_worktree_identity_matches() {
  local ps_bin="$1" identity_dir="$2" pid="$3" actual_start actual_command
  actual_start="$(TZ=UTC LC_ALL=C "$ps_bin" -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" || return 1
  actual_command="$(TZ=UTC LC_ALL=C "$ps_bin" -p "$pid" -o command= 2>/dev/null)" || return 1
  [[ -n "$actual_start" && -n "$actual_command" ]] || return 1
  [[ "$actual_start" == "$(cat "$identity_dir/$pid.start")" ]] || return 1
  [[ "$actual_command" == "$(cat "$identity_dir/$pid.command")" ]] || return 1
}

_reap_worktree_capture_identity() {
  local ps_bin="$1" identity_dir="$2" pid="$3" started command
  started="$(TZ=UTC LC_ALL=C "$ps_bin" -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" || return 1
  command="$(TZ=UTC LC_ALL=C "$ps_bin" -p "$pid" -o command= 2>/dev/null)" || return 1
  [[ -n "$started" && -n "$command" ]] || return 1
  printf '%s\n' "$started" > "$identity_dir/$pid.start"
  printf '%s\n' "$command" > "$identity_dir/$pid.command"
}

_reap_worktree_scan_matches() {
  local lsof_bin="$1" target_real="$2" output="$3"
  "$lsof_bin" -a -d cwd -F pfn > "$output" 2>/dev/null || return 1
  awk -v root="$target_real" '
    /^p[0-9]+$/ { pid=substr($0, 2); next }
    /^n/ {
      cwd=substr($0, 2)
      if (pid != "" && (cwd == root || index(cwd, root "/") == 1)) print pid
    }
  ' "$output" | sort -nu > "$output.matches"
}

reap_worktree_processes() {
  local project_root="$1" target="$2"
  local lsof_bin="${REAP_WORKTREE_LSOF_BIN:-lsof}"
  local ps_bin="${REAP_WORKTREE_PS_BIN:-ps}"
  local kill_bin="${REAP_WORKTREE_KILL_BIN:-/bin/kill}"
  local sleep_bin="${REAP_WORKTREE_SLEEP_BIN:-sleep}"
  local tmp target_real pid started command ambiguity survivors

  _reap_worktree_guard "$project_root" "$target" || {
    echo "[reap-worktree] refused unsafe target: $target" >&2
    return 1
  }
  target_real="$(cd "$target" 2>/dev/null && pwd -P)" || return 1
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/flywheel-reap.XXXXXX")" || return 1
  mkdir -p "$tmp/identity"

  if ! _reap_worktree_scan_matches "$lsof_bin" "$target_real" "$tmp/lsof"; then
    echo "[reap-worktree] cwd census failed for $target" >&2
    rm -rf "$tmp"
    return 1
  fi
  if [[ ! -s "$tmp/lsof.matches" ]]; then
    rm -rf "$tmp"
    return 0
  fi
  if ! TZ=UTC LC_ALL=C "$ps_bin" -axo pid=,ppid= > "$tmp/ps" 2>/dev/null; then
    echo "[reap-worktree] process census failed for $target" >&2
    rm -rf "$tmp"
    return 1
  fi

  # Descendant closure: a child may chdir elsewhere after being spawned from
  # the worktree, so cwd matches are roots rather than the full target set.
  awk '
    NR==FNR { if ($1 ~ /^[0-9]+$/) target[$1]=1; next }
    { pid[++n]=$1; ppid[$1]=$2 }
    END {
      changed=1
      while (changed) {
        changed=0
        for (i=1; i<=n; i++) if (!target[pid[i]] && target[ppid[pid[i]]]) {
          target[pid[i]]=1; changed=1
        }
      }
      for (i=1; i<=n; i++) if (target[pid[i]]) print pid[i]
    }
  ' "$tmp/lsof.matches" "$tmp/ps" | sort -nu > "$tmp/targets.all"

  # Protect this reaper, every ancestor, and pid 1. The caller may itself live
  # in the target worktree; that physical tier cannot safely self-reap.
  awk -v self="$$" '
    { parent[$1]=$2 }
    END {
      print 1; print self; cur=self
      while (parent[cur] > 1) { cur=parent[cur]; print cur }
    }
  ' "$tmp/ps" | sort -nu > "$tmp/protected"
  grep -Fvx -f "$tmp/protected" "$tmp/targets.all" > "$tmp/targets" || true

  # Capture every identity before the first signal. Any unreadable identity
  # makes the entire pre-signal census ambiguous, so no signal is sent.
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if ! _reap_worktree_capture_identity "$ps_bin" "$tmp/identity" "$pid"; then
      echo "[reap-worktree] identity capture failed for pid $pid" >&2
      rm -rf "$tmp"
      return 1
    fi
  done < "$tmp/targets"

  ambiguity=0
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    "$kill_bin" -0 "$pid" 2>/dev/null || continue
    _reap_worktree_guard "$project_root" "$target" || { ambiguity=1; break; }
    if ! _reap_worktree_identity_matches "$ps_bin" "$tmp/identity" "$pid"; then
      ambiguity=1
      continue
    fi
    "$kill_bin" -TERM "$pid" 2>/dev/null || true
  done < "$tmp/targets"
  if [[ "$ambiguity" -ne 0 ]]; then
    echo "[reap-worktree] identity/path changed before TERM; refusing further signals" >&2
    rm -rf "$tmp"
    return 1
  fi

  for _ in $(seq 1 50); do
    : > "$tmp/survivors"
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && "$kill_bin" -0 "$pid" 2>/dev/null && printf '%s\n' "$pid" >> "$tmp/survivors"
    done < "$tmp/targets"
    [[ ! -s "$tmp/survivors" ]] && break
    "$sleep_bin" 0.1
  done

  if [[ -s "$tmp/survivors" ]]; then
    _reap_worktree_guard "$project_root" "$target" || {
      rm -rf "$tmp"
      return 1
    }
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      "$kill_bin" -0 "$pid" 2>/dev/null || continue
      if ! _reap_worktree_identity_matches "$ps_bin" "$tmp/identity" "$pid"; then
        ambiguity=1
        continue
      fi
      "$kill_bin" -KILL "$pid" 2>/dev/null || true
    done < "$tmp/survivors"
  fi
  if [[ "$ambiguity" -ne 0 ]]; then
    echo "[reap-worktree] identity changed before KILL; refusing further signals" >&2
    rm -rf "$tmp"
    return 1
  fi

  for _ in $(seq 1 20); do
    survivors=0
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && "$kill_bin" -0 "$pid" 2>/dev/null && survivors=1
    done < "$tmp/targets"
    [[ "$survivors" -eq 0 ]] && break
    "$sleep_bin" 0.1
  done
  if [[ "$survivors" -ne 0 ]]; then
    echo "[reap-worktree] survivors remain for $target" >&2
    rm -rf "$tmp"
    return 1
  fi

  # Fresh cwd census prevents "sent signals" from masquerading as verified
  # cleanup. A new/forked cwd match is incomplete and stays auditable.
  if ! _reap_worktree_scan_matches "$lsof_bin" "$target_real" "$tmp/final-lsof" \
      || [[ -s "$tmp/final-lsof.matches" ]]; then
    echo "[reap-worktree] final cwd census is not clean for $target" >&2
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
  return 0
}
