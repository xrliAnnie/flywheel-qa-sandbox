#!/bin/bash
# FLY-1389 P1-0: shared path-hygiene predicates for global-persistence writers.
#
# Incident 2026-07-20 (529 Room): ~/.flywheel/bin/agent-team-transport pointed
# into a worktree's dist; the worktree was cleaned, the symlink broke, and the
# next Lead start died FATAL at the transport preflight. Root cause class:
# installers derive their source root from their own location and write that
# root into GLOBAL config — run once from a temp/worktree checkout and the
# global config permanently remembers a temporary address.
#
# Rule (Annie red line): global bin links point at the main checkout ONLY —
# refuse AT WRITE TIME, do not detect-and-repair after the fact. Every writer
# of a global persistence surface (~/.flywheel effective state, ~/.claude
# settings/plugins, ~/Library/LaunchAgents) consults these predicates.
#
# The TypeScript mirror lives in
# packages/teamlead/src/bridge/path-hygiene.ts — keep the two hosts aligned
# (both test suites pin the same fixture matrix).
#
# Judgment basis (research §7c, macOS verified):
#   temp shape    — canonical path under /tmp, /private/tmp, /var/folders,
#                   /private/var/folders (macOS: /var → /private/var symlink,
#                   so both spellings must be in the set; judged AFTER
#                   canonicalization).
#   worktree root — <dir>/.git exists and is a FILE (linked-worktree gitdir
#                   pointer). Main checkouts have a .git DIRECTORY. Applies to
#                   the root itself only — for deep targets walk up to the
#                   owning repo root first (path_hygiene_owning_repo_root).
#                   Naming heuristics (path contains /worktrees/) are known to
#                   miss real shapes (~/Dev/flywheel-FLY-1389) — never used.
#   canonicalize  — allow-missing contract (Codex R2 #2): resolve the longest
#                   EXISTING ancestor physically, then append the missing
#                   suffix. A clean host without ~/.flywheel/bin must still be
#                   recognized as global. Any other resolution failure (empty
#                   input, dot segments in the missing suffix) → non-zero, and
#                   callers treat it FAIL-CLOSED (guard triggers).
#
# Sourcing only defines functions (no side effects). Bash 3.2 compatible.

# Canonicalize a path without requiring it to exist.
# stdout: canonical absolute path; rc=1 on unresolvable input (fail-closed at
# the call sites).
path_hygiene_canonicalize() {
  local p="${1:-}"
  [ -n "$p" ] || return 1
  case "$p" in
    /*) : ;;
    *) p="$(pwd -P)/$p" || return 1 ;;
  esac
  # strip trailing slashes (keep bare "/")
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  local suffix="" cur="$p" base
  while [ ! -d "$cur" ] && [ "$cur" != "/" ]; do
    base="$(basename "$cur")"
    case "$base" in
      .|..) return 1 ;;  # dot segment in a missing suffix is unresolvable
    esac
    suffix="${base}${suffix:+/$suffix}"
    cur="$(dirname "$cur")"
  done
  local resolved
  resolved="$(cd "$cur" 2>/dev/null && pwd -P)" || return 1
  if [ -n "$suffix" ]; then
    if [ "$resolved" = "/" ]; then
      printf '/%s\n' "$suffix"
    else
      printf '%s/%s\n' "$resolved" "$suffix"
    fi
  else
    printf '%s\n' "$resolved"
  fi
}

# Pure prefix verdict on an ALREADY-canonical path (boundary-safe: /tmpfoo is
# not /tmp).
path_hygiene_is_temp_path() {
  case "${1:-}" in
    /tmp|/tmp/*|/private/tmp|/private/tmp/*) return 0 ;;
    /var/folders|/var/folders/*|/private/var/folders|/private/var/folders/*) return 0 ;;
    *) return 1 ;;
  esac
}

# is_temp_or_worktree_root <dir> → 0 = temp/worktree shape (writers must
# REFUSE), 1 = trusted root (main checkout, packaged .flywheel-prebuilt tree,
# fleet custom root). Fail-closed: unresolvable input → 0.
is_temp_or_worktree_root() {
  local canon
  canon="$(path_hygiene_canonicalize "${1:-}")" || return 0
  path_hygiene_is_temp_path "$canon" && return 0
  [ -f "$canon/.git" ] && return 0
  return 1
}

# is_global_bin_dir <dir> → 0 = resolved identity equals the effective global
# bin ($HOME/.flywheel/bin), regardless of how the value was spelled
# (FLYWHEEL_BIN_DIR override, symlink alias, redundant slashes). Fail-closed:
# unresolvable input → 0 (treated as global so the guard triggers).
is_global_bin_dir() {
  local canon global
  canon="$(path_hygiene_canonicalize "${1:-}")" || return 0
  global="$(path_hygiene_canonicalize "${HOME}/.flywheel/bin")" || return 0
  [ "$canon" = "$global" ]
}

# path_hygiene_same_path <a> <b> → 0 = canonical identity. Fail-closed: an
# unresolvable side compares as SAME (callers use this to decide "effective
# global destination" — the guard must engage on doubt).
path_hygiene_same_path() {
  local a b
  a="$(path_hygiene_canonicalize "${1:-}")" || return 0
  b="$(path_hygiene_canonicalize "${2:-}")" || return 0
  [ "$a" = "$b" ]
}

# path_hygiene_owning_repo_root <existing-path> → prints the first ancestor
# (the path itself if a dir, else its dirname) that contains a .git entry;
# rc=1 when no ancestor is a repo root.
path_hygiene_owning_repo_root() {
  local d="${1:-}"
  [ -e "$d" ] || return 1
  [ -d "$d" ] || d="$(dirname "$d")"
  d="$(cd "$d" 2>/dev/null && pwd -P)" || return 1
  while :; do
    if [ -e "$d/.git" ]; then printf '%s\n' "$d"; return 0; fi
    [ "$d" = "/" ] && return 1
    d="$(dirname "$d")"
  done
}

# path_hygiene_target_is_temp_or_worktree <path> → 0 when the path is a
# temp-canonical location OR lives inside a linked-worktree checkout (owning
# repo root's .git is a file). For deep targets — symlink destinations,
# marketplace paths — where the root-only .git test of
# is_temp_or_worktree_root does not apply. Fail-closed on unresolvable input.
path_hygiene_target_is_temp_or_worktree() {
  local canon root
  canon="$(path_hygiene_canonicalize "${1:-}")" || return 0
  path_hygiene_is_temp_path "$canon" && return 0
  root="$(path_hygiene_owning_repo_root "$canon")" || return 1
  [ -f "$root/.git" ] && return 0
  return 1
}

# FLY-2190 S2: production PATH declarations whose Homebrew precedence is a
# repository contract. Keep the registry explicit: discovery (added below)
# prevents new declarations from bypassing the rule, while this list prevents
# a known declaration from disappearing or silently changing shape.
path_hygiene_source_path_registry() {
  cat <<'EOF'
packages/claude-runner/src/tmux-server-environment.ts
scripts/lib/kill-ledger.sh
scripts/lib/tmux-server-rescue.sh
scripts/flywheel-lead-wrapper-v2.sh
scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh
scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh
scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh
scripts/resident-codex-lead-recover.sh
scripts/flywheel-bridge-wrapper.sh
scripts/flywheel-voice-bridge-wrapper.sh
scripts/flywheel-quota-monitor-wrapper.sh
scripts/restart-services.sh
packages/teamlead/scripts/templates/flywheel-codex-lead-wrapper-mufasa-tui.sh
packages/teamlead/scripts/rollback-codex-lead-mufasa-tui.sh
scripts/launchd/com.flywheel.updater.plist
scripts/lib/qa-launchd-lead.sh
scripts/flywheel-cmux-autostart.sh
scripts/meeting-notes-tick.sh
scripts/xiaohongshu-learning-tick.sh
scripts/com.flywheel.log-janitor.plist
scripts/launchd/com.flywheel.voucher-watch.plist
scripts/launchd/com.flywheel.daily-digest.plist
scripts/launchd/com.flywheel.token-usage-daily.plist
scripts/launchd/com.flywheel.codex-log-guard.plist
scripts/launchd/com.flywheel.bridge-liveness-probe.plist
scripts/launchd/com.flywheel.lead-memory-sync.plist
scripts/launchd/com.flywheel.lead-memory-arrival-check.plist
scripts/com.flywheel.calendar-sweep.plist.template
scripts/host-tmux-selection-gate.sh
scripts/cutover/FLY-2264/verify-native-tmux-cutover.sh
packages/claude-runner/test/runner-env-isolation.real-tmux.test.ts
packages/claude-runner/test/codex-runner-tui-window.test.ts
packages/teamlead/src/lead-backends/codex/__tests__/tui-window.test.ts
packages/teamlead/src/bridge/__tests__/tmux-environment-scrub.test.ts
scripts/__tests__/tmux-server-rescue.test.sh
scripts/__tests__/host-tmux-selection-s0-scope.test.sh
scripts/test-cmux-sync.sh
scripts/__tests__/token-usage-daily-channel.test.sh
scripts/__tests__/token-usage-daily-failloud.test.sh
scripts/__tests__/launchd-units-manifest.test.sh
EOF
}

# Non-PATH first-match lists whose Homebrew ordering carries the same Rosetta
# retirement risk. Format: path|required literal substring.
path_hygiene_source_priority_registry() {
  cat <<'EOF'
packages/flywheel-comm/src/commands/qa-result.ts|QA_GITHUB_CLI_CANDIDATES=["/opt/homebrew/bin/gh","/usr/local/bin/gh","/usr/bin/gh",]asconst
EOF
}

path_hygiene_source_priority_matches() {
  local wanted_rel="${1:-}" wanted_line="${2:-}" rel marker normalized_line
  normalized_line="$(printf '%s' "$wanted_line" | tr -d '[:space:]')"
  while IFS='|' read -r rel marker; do
    [ "$rel" = "$wanted_rel" ] || continue
    case "$normalized_line" in *"$marker"*) return 0 ;; esac
  done <<EOF
$(path_hygiene_source_priority_registry)
EOF
  return 1
}

path_hygiene_source_registry_contains() {
  local wanted="${1:-}" registered
  while IFS= read -r registered; do
    [ "$registered" = "$wanted" ] && return 0
  done <<EOF
$(path_hygiene_source_path_registry)
EOF
  return 1
}

# path|required line marker|reason. Exceptions are intentionally exact; there
# is no blanket __tests__ exclusion because test mirrors can still pin a
# production PATH contract.
path_hygiene_source_exception_registry() {
  cat <<'EOF'
scripts/__tests__/lead-alert-dirs.test.sh|${FAKEBIN}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin|fake bin is the priority under test; Homebrew entries are inert fallbacks
scripts/__tests__/codex-log-guard.test.sh|${FAKEBIN}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin|fake bin is the priority under test; Homebrew entries are inert fallbacks
scripts/__tests__/lead-alert-founder-timezone.test.sh|${FAKEBIN}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin|fake bin is the priority under test; Homebrew entries are inert fallbacks
packages/flywheel-comm/src/commands/qa-result.ts|["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]|system Git is the first choice; Homebrew ordering is never consulted
packages/teamlead/scripts/codex-lead-tui-home.sh|/opt/homebrew/bin/bash /usr/local/bin/bash|explicit interpreter capability probe, not a PATH declaration
packages/teamlead/scripts/__tests__/codex-lead-tui-home-zombie-reap.test.sh|/opt/homebrew/bin/bash /usr/local/bin/bash|test-only interpreter capability probe
scripts/check-global-path-hygiene.sh|do not prefer /opt/homebrew/bin over /usr/local/bin|diagnostic prose emitted by this guard
scripts/host-terminal-cutover.sh|ls -ld /usr/local/bin/tmux /opt/homebrew/bin/tmux|two-path link inventory, not a first-match declaration
scripts/qa-fly-1986-load-probe.sh|python3 /usr/local/bin/python3 /opt/homebrew/bin/python3|explicit multi-interpreter QA probe
scripts/__tests__/fly1577-cmux-bin-closure.test.sh|for d in /opt/homebrew/bin /usr/local/bin|test cleanup visits both roots explicitly
scripts/qa-fly-153-mirror-smoke.sh|/opt/homebrew/bin/bash (Apple Silicon) or /usr/local/bin/bash|operator diagnostic names two explicit interpreters
scripts/lib/path-hygiene.sh|*|guard implementation contains the literals and registries it classifies
scripts/__tests__/check-global-path-hygiene.test.sh|*|guard test generates positive, negative, and exception fixtures deliberately
scripts/__tests__/fly2264-verify-native-cutover.test.sh|*|positive and negative native/Intel PATH fixtures
EOF
}

path_hygiene_source_exception_matches() {
  local wanted_rel="${1:-}" wanted_line="${2:-}" rel marker reason
  while IFS='|' read -r rel marker reason; do
    [ "$rel" = "$wanted_rel" ] || continue
    [ "$marker" = "*" ] && return 0
    case "$wanted_line" in *"$marker"*) return 0 ;; esac
  done <<EOF
$(path_hygiene_source_exception_registry)
EOF
  return 1
}

path_hygiene_source_file_is_scannable() {
  local file="${1:-}" base first
  case "$file" in
    *.sh|*.bash|*.py|*.js|*.cjs|*.mjs|*.ts|*.tsx|*.mts|*.cts|*.plist) return 0 ;;
  esac
  base="$(basename "$file")"
  case "$base" in *.*) return 1 ;; esac
  [ -x "$file" ] || return 1
  IFS= read -r first < "$file" || return 1
  case "$first" in '#!'*) return 0 ;; *) return 1 ;; esac
}

# Finds mixed-prefix declarations outside the explicit registry. Correctly
# ordered declarations still fail closed until they are registered: otherwise
# a new carrier could bypass the known-file half of the guard.
path_hygiene_discover_unregistered_source_declarations() {
  local root="${1:-}" source_list file rel line line_no trimmed violations
  violations=0
  source_list="$(mktemp "${TMPDIR:-/tmp}/flywheel-path-sources.XXXXXX")" || {
    echo "repo-root: unable to allocate source discovery list"
    return 1
  }
  find "$root/packages" "$root/scripts" -type f \
    ! -path '*/node_modules/*' ! -path '*/dist/*' \
    ! -path '*/.tmp-*/*' -print > "$source_list" || {
      rm -f "$source_list"
      echo "repo-root: source discovery failed under $root"
      return 1
    }
  while IFS= read -r file; do
    path_hygiene_source_file_is_scannable "$file" || continue
    rel="${file#"$root"/}"
    path_hygiene_source_registry_contains "$rel" && continue
    line_no=0
    while IFS= read -r line || [ -n "$line" ]; do
      line_no=$((line_no + 1))
      case "$line" in
        *'/opt/homebrew/bin'*'/usr/local/bin'*|*'/usr/local/bin'*'/opt/homebrew/bin'*) : ;;
        *) continue ;;
      esac
      trimmed="${line#"${line%%[![:space:]]*}"}"
      case "$trimmed" in
        \#*|//*|\**|'<!--'*) continue ;;
      esac
      path_hygiene_source_priority_matches "$rel" "$line" && continue
      path_hygiene_source_exception_matches "$rel" "$line" && continue
      echo "$rel:$line_no: unregistered mixed-prefix declaration"
      violations=$((violations + 1))
    done < "$file"
  done < "$source_list"
  rm -f "$source_list"
  [ "$violations" -eq 0 ]
}

# path_hygiene_native_homebrew_precedes_intel <text>
# rc=0 only when both prefixes exist and /opt/homebrew/bin occurs first.
path_hygiene_native_homebrew_precedes_intel() {
  local text="${1:-}" native_prefix intel_prefix
  case "$text" in
    *'/opt/homebrew/bin'*'/usr/local/bin'*) return 0 ;;
    *) return 1 ;;
  esac
}

# path_hygiene_runtime_native_homebrew_precedes_intel <platform> <path>
# On Darwin, an exact /usr/local/bin token requires an earlier exact
# /opt/homebrew/bin token. Other platforms and PATHs without Intel Homebrew are
# outside this host-specific guard.
path_hygiene_runtime_native_homebrew_precedes_intel() {
  local platform="${1:-}" runtime_path="${2-}" rest token
  local index=0 native_index=0 intel_index=0
  case "$platform" in darwin|Darwin) : ;; *) return 0 ;; esac

  rest="$runtime_path"
  while :; do
    token="${rest%%:*}"
    index=$((index + 1))
    if [ "$token" = "/opt/homebrew/bin" ] && [ "$native_index" -eq 0 ]; then
      native_index="$index"
    fi
    if [ "$token" = "/usr/local/bin" ] && [ "$intel_index" -eq 0 ]; then
      intel_index="$index"
    fi
    [ "$rest" != "$token" ] || break
    rest="${rest#*:}"
  done

  [ "$intel_index" -eq 0 ] && return 0
  [ "$native_index" -gt 0 ] && [ "$native_index" -lt "$intel_index" ]
}

# path_hygiene_scan_registered_source_tree <repo-root>
# Prints one relative-path finding per violation and returns 1 when any are
# found. The root and every registered file are fail-closed.
path_hygiene_scan_registered_source_tree() {
  local root="${1:-}" canon rel file line line_no found violations trimmed
  local marker normalized_source discovery_findings discovery_rc finding
  violations=0
  canon="$(path_hygiene_canonicalize "$root")" || {
    echo "repo-root: unresolvable source root: $root"
    return 1
  }
  if [ ! -d "$canon/packages" ] || [ ! -d "$canon/scripts" ] || [ ! -f "$canon/package.json" ]; then
    echo "repo-root: invalid Flywheel source root: $canon"
    return 1
  fi

  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    file="$canon/$rel"
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
      echo "$rel: registered source file is missing or unreadable"
      violations=$((violations + 1))
      continue
    fi
    found=0
    line_no=0
    while IFS= read -r line || [ -n "$line" ]; do
      line_no=$((line_no + 1))
      case "$line" in
        *'/opt/homebrew/bin'*'/usr/local/bin'*|*'/usr/local/bin'*'/opt/homebrew/bin'*) : ;;
        *) continue ;;
      esac
      trimmed="${line#"${line%%[![:space:]]*}"}"
      case "$trimmed" in
        \#*|//*|\**|'<!--'*) continue ;;
      esac
      found=$((found + 1))
      if ! path_hygiene_native_homebrew_precedes_intel "$line"; then
        echo "$rel:$line_no: /opt/homebrew/bin must precede /usr/local/bin"
        violations=$((violations + 1))
      fi
    done < "$file"
    if [ "$found" -eq 0 ]; then
      echo "$rel: registered PATH declaration is missing"
      violations=$((violations + 1))
    fi
  done <<EOF
$(path_hygiene_source_path_registry)
EOF

  while IFS='|' read -r rel marker; do
    [ -n "$rel" ] || continue
    file="$canon/$rel"
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
      echo "$rel: registered priority source file is missing or unreadable"
      violations=$((violations + 1))
    else
      normalized_source="$(tr -d '[:space:]' < "$file")"
      case "$normalized_source" in
        *"$marker"*) : ;;
        *)
          echo "$rel: registered native-first priority list is missing or reordered"
          violations=$((violations + 1))
          ;;
      esac
    fi
  done <<EOF
$(path_hygiene_source_priority_registry)
EOF

  discovery_findings=""
  discovery_rc=0
  discovery_findings="$(path_hygiene_discover_unregistered_source_declarations "$canon")" || discovery_rc=$?
  if [ "$discovery_rc" -ne 0 ]; then
    while IFS= read -r finding; do
      [ -n "$finding" ] || continue
      echo "$finding"
      violations=$((violations + 1))
    done <<<"$discovery_findings"
  fi

  [ "$violations" -eq 0 ]
}
