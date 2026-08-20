#!/usr/bin/env bash
# FLY-1814 D3: hermetic contracts for the two explicit launchd operator tools.
# The production files are sourced and every TTY, audit, launchctl, and host
# path boundary is replaced before main is called. No real launchd domain or
# alert channel is touched.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AUX_TOOL="$REPO_ROOT/scripts/fly1814-enable-aux-job.sh"
CLEANUP_TOOL="$REPO_ROOT/scripts/fly1814-cleanup-zombie.sh"
DECISIONS="$REPO_ROOT/scripts/launchd/fly1814-aux-decisions.tsv"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1814-operator.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '  ✓ %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '  ✗ %s\n' "$*" >&2; }

write_plist() {
  local path="$1" label="$2" target="$3"
  mkdir -p "$(dirname "$path")"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict>'
    printf '<key>Label</key><string>%s</string>\n' "$label"
    printf '<key>ProgramArguments</key><array><string>/bin/bash</string><string>%s</string></array>\n' "$target"
    printf '%s\n' '</dict></plist>'
  } > "$path"
}

write_decisions() {
  local path="$1" selected="$2" selected_status="$3" selected_target="$4"
  local label="" status="" target=""
  mkdir -p "$(dirname "$path")"
  printf 'label\tstatus\tapproved_target\tpurpose\tprovenance\trecommendation\tevidence\n' > "$path"
  for label in \
    com.flywheel.growth-improve \
    com.flywheel.growth-learn \
    com.flywheel.growth-report \
    com.flywheel.growth-retro \
    com.flywheel.sub-create-nightly \
    com.flywheel.sub-daily-loop \
    com.flywheel.skills-update \
    com.flywheel.token-usage-daily; do
    status=pending
    [[ "$label" == "$selected" ]] && status="$selected_status"
    target="/fixture/${label}.sh"
    [[ "$label" == "$selected" ]] && target="$selected_target"
    case "$label" in
      com.flywheel.growth-*|com.flywheel.sub-*) provenance=bak-fly886 ;;
      *) provenance=unknown ;;
    esac
    printf '%s\t%s\t%s\tfixture-purpose\t%s\treview-before-enable\tfixture-evidence\n' \
      "$label" "$status" "$target" "$provenance" >> "$path"
  done
}

run_aux() {
  local case_root="$1" status="$2" loaded="$3" disabled="$4" tty="$5" audit_result="$6" behavior="$7"
  shift 7
  local label="com.flywheel.growth-learn" harness="" target=""
  target="$case_root/targets/growth-learn.sh"
  mkdir -p "$case_root/home/Library/LaunchAgents" "$case_root/state" "$case_root/targets"
  printf '#!/bin/sh\n' > "$target"
  write_plist "$case_root/home/Library/LaunchAgents/${label}.plist" "$label" "$target"
  write_decisions "$case_root/decisions.tsv" "$label" "$status" "$target"
  case "$behavior" in
    decision-content)
      awk -F '\t' 'BEGIN { OFS="\t" } $1 == "com.flywheel.growth-learn" { $7="changed-evidence" } { print }' \
        "$case_root/decisions.tsv" > "$case_root/decisions.changed"
      mv "$case_root/decisions.changed" "$case_root/decisions.tsv"
      ;;
    target-missing) rm "$target" ;;
    target-unknown)
      {
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict>'
        printf '<key>Label</key><string>%s</string>\n' "$label"
        # Literal dollar-sign content is the unsafe resolver fixture.
        # shellcheck disable=SC2016
        printf '%s\n' '<key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>$DYNAMIC</string></array>' '</dict></plist>'
      } > "$case_root/home/Library/LaunchAgents/${label}.plist"
      ;;
  esac
  printf '%s\n' "$loaded" > "$case_root/state/loaded"
  printf '%s\n' "$disabled" > "$case_root/state/disabled"
  : > "$case_root/audit.calls"
  : > "$case_root/launchctl.calls"
  : > "$case_root/mutations"
  : > "$case_root/filesystem.calls"
  # Apple Bash 3.2 can expand pieces of a large quoted heredoc in the
  # enclosing shell when that heredoc is itself embedded inside $(...). Write
  # the fixture first so only the child command is inside command substitution.
  harness="$case_root/aux-harness.sh"
  cat > "$harness" <<'HARNESS'
source "$AUX_TOOL"
fly1814_operator_has_tty() { [[ "$CASE_TTY" == 1 ]]; }
fly1814_domain() { printf 'gui/501\n'; }
fly1814_launch_agents_dir() { printf '%s\n' "$CASE_ROOT/home/Library/LaunchAgents"; }
fly1814_aux_decisions_file() { printf '%s\n' "$CASE_ROOT/decisions.tsv"; }
fly1814_alert_send() {
  printf '%s\n' "$*" >> "$CASE_ROOT/audit.calls"
  if [[ "$CASE_BEHAVIOR" == target-changed-after-audit ]]; then
    printf '#!/bin/sh\n' > "$CASE_ROOT/targets/replaced.sh"
    write_plist_for_mutant "$CASE_ROOT/home/Library/LaunchAgents/com.flywheel.growth-learn.plist" \
      com.flywheel.growth-learn "$CASE_ROOT/targets/replaced.sh"
  fi
  if [[ "$CASE_BEHAVIOR" == decision-revoked-after-audit \
    || "$CASE_BEHAVIOR" == decision-row-changed-after-audit ]]; then
    awk -F '\t' -v behavior="$CASE_BEHAVIOR" '
      BEGIN { OFS="\t" }
      $1 == "com.flywheel.growth-learn" && behavior == "decision-revoked-after-audit" { $2="hold" }
      $1 == "com.flywheel.growth-learn" && behavior == "decision-row-changed-after-audit" { $7="changed-after-audit" }
      { print }
    ' "$CASE_ROOT/decisions.tsv" > "$CASE_ROOT/decisions.changed"
    mv "$CASE_ROOT/decisions.changed" "$CASE_ROOT/decisions.tsv"
  fi
  if [[ "$CASE_BEHAVIOR" == disabled-changed-during-audit ]]; then
    printf '0\n' > "$CASE_ROOT/state/disabled"
  fi
  if [[ "$CASE_BEHAVIOR" == domain-changed-during-audit ]]; then
    printf '1\n' > "$CASE_ROOT/state/loaded"
  fi
  if [[ "$CASE_AUDIT_RESULT" == sent ]]; then
    printf 'sent\n'
    return 0
  fi
  printf '%s\n' "$CASE_AUDIT_RESULT"
  return 2
}
fly1814_launchctl() {
  local verb="$1" target="${2:-}" label=""
  label="${target##*/}"
  printf '%s\n' "$*" >> "$CASE_ROOT/launchctl.calls"
  case "$verb" in
    print-disabled)
      disabled_count="$(cat "$CASE_ROOT/state/disabled-print-count" 2>/dev/null || printf '0\n')"
      disabled_count=$((disabled_count + 1))
      printf '%s\n' "$disabled_count" > "$CASE_ROOT/state/disabled-print-count"
      if [[ "$CASE_BEHAVIOR" == rollback-bootout-fail && "$disabled_count" == 3 ]]; then
        printf 'unparseable override state\n'
        return 0
      fi
      printf 'disabled services = {\n'
      if [[ "$(cat "$CASE_ROOT/state/disabled")" == 1 ]]; then
        printf '  "com.flywheel.growth-learn" => disabled\n'
      else
        printf '  "com.flywheel.growth-learn" => enabled\n'
      fi
      printf '}\n'
      ;;
    print)
      count="$(cat "$CASE_ROOT/state/print-count" 2>/dev/null || printf '0\n')"
      count=$((count + 1))
      printf '%s\n' "$count" > "$CASE_ROOT/state/print-count"
      if [[ "$CASE_BEHAVIOR" == reprobe-error && "$count" == 3 ]]; then
        printf 'launchd IPC error\n' >&2
        return 1
      fi
      if [[ "$(cat "$CASE_ROOT/state/loaded")" == 1 ]]; then
        printf 'service = %s\n' "$label"
      else
        printf 'Could not find service "%s" in domain for user\n' "$label" >&2
        return 113
      fi
      ;;
    enable)
      printf 'enable %s\n' "$target" >> "$CASE_ROOT/mutations"
      [[ "$CASE_BEHAVIOR" == enable-fail ]] && return 1
      printf '0\n' > "$CASE_ROOT/state/disabled"
      ;;
    bootstrap)
      printf 'bootstrap %s %s\n' "$target" "${3:-}" >> "$CASE_ROOT/mutations"
      [[ "$CASE_BEHAVIOR" == bootstrap-fail || "$CASE_BEHAVIOR" == rollback-fail \
        || "$CASE_BEHAVIOR" == rollback-disable-fail ]] && return 1
      if [[ "$CASE_BEHAVIOR" == reprobe-missing ]]; then
        printf '0\n' > "$CASE_ROOT/state/loaded"
      else
        printf '1\n' > "$CASE_ROOT/state/loaded"
      fi
      ;;
    bootout)
      printf 'bootout %s\n' "$target" >> "$CASE_ROOT/mutations"
      [[ "$CASE_BEHAVIOR" == rollback-fail || "$CASE_BEHAVIOR" == rollback-bootout-fail ]] && return 1
      printf '0\n' > "$CASE_ROOT/state/loaded"
      ;;
    disable)
      printf 'disable %s\n' "$target" >> "$CASE_ROOT/mutations"
      [[ "$CASE_BEHAVIOR" == rollback-fail || "$CASE_BEHAVIOR" == rollback-disable-fail ]] && return 1
      printf '1\n' > "$CASE_ROOT/state/disabled"
      ;;
    *) return 99 ;;
  esac
}
write_plist_for_mutant() {
  local path="$1" label="$2" target="$3"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict>'
    printf '<key>Label</key><string>%s</string>\n' "$label"
    printf '<key>ProgramArguments</key><array><string>/bin/bash</string><string>%s</string></array>\n' "$target"
    printf '%s\n' '</dict></plist>'
  } > "$path"
}
fly1814_aux_main "$@"
HARNESS
  set +e
  LAST_OUT="$(
    AUX_TOOL="$AUX_TOOL" CASE_ROOT="$case_root" CASE_TTY="$tty" \
      CASE_AUDIT_RESULT="$audit_result" CASE_BEHAVIOR="$behavior" HOME="$case_root/home" \
      /bin/bash "$harness" "$@" 2>&1
  )"
  LAST_RC=$?
  set -u
}

run_cleanup() {
  local case_root="$1" label="$2" loaded="$3" tty="$4" audit_result="$5" behavior="$6"
  shift 6
  local plist="$case_root/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist"
  local target="/var/folders/zz/fixture/T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh"
  local harness=""
  mkdir -p "$case_root/home/Library/LaunchAgents" "$case_root/state"
  if [[ "$label" != absent ]]; then
    write_plist "$plist" "$label" "$target"
  fi
  printf '%s\n' "$loaded" > "$case_root/state/loaded"
  : > "$case_root/audit.calls"
  : > "$case_root/launchctl.calls"
  : > "$case_root/mutations"
  harness="$case_root/cleanup-harness.sh"
  cat > "$harness" <<'HARNESS'
source "$CLEANUP_TOOL"
fly1814_operator_has_tty() { [[ "$CASE_TTY" == 1 ]]; }
fly1814_domain() { printf 'gui/501\n'; }
fly1814_launch_agents_dir() { printf '%s\n' "$CASE_ROOT/home/Library/LaunchAgents"; }
fly1814_today() { printf '20260819\n'; }
fixture_file_identity() {
  local value=""
  value="$(stat -c '%d:%i' "$1" 2>/dev/null || true)"
  case "$value" in *:*) printf '%s\n' "$value"; return 0 ;; esac
  stat -f '%d:%i' "$1" 2>/dev/null
}
fixture_replace_archive() {
  local archive="$CASE_ROOT/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
  command rm -f -- "$archive"
  printf 'operator replacement bytes\n' > "$archive"
}
fly1814_file_identity() {
  local path="$1" count=""
  if [[ "$path" == */retired-20260819/com.xiaohongshu-deep-learning.qa528.plist ]]; then
    count="$(cat "$CASE_ROOT/state/archive-identity-count" 2>/dev/null || printf '0\n')"
    count=$((count + 1))
    printf '%s\n' "$count" > "$CASE_ROOT/state/archive-identity-count"
    if [[ "$CASE_BEHAVIOR" == archive-replaced-before-unlink && "$count" == 2 ]]; then
      fixture_replace_archive
    fi
  fi
  fixture_file_identity "$path"
}
write_cleanup_mutant() {
  local path="$1" target="$2"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict>'
    printf '%s\n' '<key>Label</key><string>com.xiaohongshu-deep-learning.qa528</string>'
    printf '<key>ProgramArguments</key><array><string>/bin/bash</string><string>%s</string></array>\n' "$target"
    printf '%s\n' '</dict></plist>'
  } > "$path"
}
fly1814_alert_send() {
  printf '%s\n' "$*" >> "$CASE_ROOT/audit.calls"
  if [[ "$CASE_BEHAVIOR" == collision-after-audit ]]; then
    mkdir -p "$CASE_ROOT/home/Library/LaunchAgents/retired-20260819"
    printf 'operator raced file\n' > "$CASE_ROOT/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
  fi
  if [[ "$CASE_BEHAVIOR" == target-changed-after-audit ]]; then
    write_cleanup_mutant \
      "$CASE_ROOT/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
      /var/folders/zz/replaced/T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh
  fi
  if [[ "$CASE_BEHAVIOR" == symlink-after-audit ]]; then
    mv "$CASE_ROOT/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
      "$CASE_ROOT/state/original.plist"
    ln -s "$CASE_ROOT/state/original.plist" \
      "$CASE_ROOT/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist"
  fi
  if [[ "$CASE_BEHAVIOR" == domain-changed-during-audit ]]; then
    printf '0\n' > "$CASE_ROOT/state/loaded"
  fi
  if [[ "$CASE_AUDIT_RESULT" == sent ]]; then
    printf 'sent\n'
    return 0
  fi
  printf '%s\n' "$CASE_AUDIT_RESULT"
  return 2
}
fly1814_reference_scan() {
  [[ "$CASE_BEHAVIOR" == reference-error ]] && return 2
  command grep -R -l -F -- "$1" "$2" 2>/dev/null
}
fly1814_mkdir() {
  printf 'mkdir %s\n' "$*" >> "$CASE_ROOT/filesystem.calls"
  [[ "$CASE_BEHAVIOR" == mkdir-fail ]] && return 1
  command mkdir "$@"
}
fly1814_archive_publish() {
  local replacement="" source_identity="" replacement_identity=""
  printf 'archive-publish %s %s\n' "$1" "$2" >> "$CASE_ROOT/filesystem.calls"
  if [[ "$CASE_BEHAVIOR" == active-source-replaced-before-publication-failure ]]; then
    replacement="$CASE_ROOT/state/operator-active-replacement.plist"
    write_cleanup_mutant "$replacement" \
      /var/folders/zz/fixture/T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh
    printf '%s\n' '<!-- operator active replacement before failed publication -->' >> "$replacement"
    # Create the foreign inode while the signed source inode is still linked.
    # Otherwise ext4 may immediately reuse the just-unlinked inode and the
    # fixture stops modeling the replacement that this assertion names.
    source_identity="$(fly1814_file_identity "$1")" || return 1
    replacement_identity="$(fly1814_file_identity "$replacement")" || return 1
    [[ "$source_identity" != "$replacement_identity" ]] || return 1
    command rm -f -- "$1"
    command mv -- "$replacement" "$1"
    return 1
  fi
  [[ "$CASE_BEHAVIOR" == archive-fail || "$CASE_BEHAVIOR" == archive-rollback-bootstrap-fail ]] && return 1
  command ln "$1" "$2" || return 1
  if [[ "$CASE_BEHAVIOR" == active-source-replaced-after-publication ]]; then
    command rm -f -- "$1"
    write_cleanup_mutant "$1" \
      /var/folders/zz/fixture/T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh
    printf '%s\n' '<!-- operator active replacement bytes -->' >> "$1"
  fi
}
fly1814_unlink() {
  printf 'unlink %s\n' "$1" >> "$CASE_ROOT/filesystem.calls"
  if [[ "$1" == */Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist \
    && "$CASE_BEHAVIOR" == source-remove-fail ]]; then
    return 1
  fi
  if [[ "$1" == */Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist \
    && "$CASE_BEHAVIOR" == source-remove-after-effect ]]; then
    command rm -f -- "$1"
    return 1
  fi
  command rm -f -- "$1"
}
fly1814_archive_remove_owned() {
  printf 'archive-remove %s\n' "$1" >> "$CASE_ROOT/filesystem.calls"
  [[ "$CASE_BEHAVIOR" == rollback-fail || "$CASE_BEHAVIOR" == reprobe-rollback-fail \
    || "$CASE_BEHAVIOR" == rollback-remove-fail ]] && return 1
  command rm -f -- "$1"
}
fly1814_active_restore() {
  printf 'active-restore %s %s\n' "$1" "$2" >> "$CASE_ROOT/filesystem.calls"
  [[ "$CASE_BEHAVIOR" == rollback-fail || "$CASE_BEHAVIOR" == reprobe-rollback-fail ]] && return 1
  command ln "$1" "$2"
}
fly1814_launchctl() {
  local verb="$1" target="${2:-}" label=""
  label="${target##*/}"
  printf '%s\n' "$*" >> "$CASE_ROOT/launchctl.calls"
  case "$verb" in
    print)
      count="$(cat "$CASE_ROOT/state/print-count" 2>/dev/null || printf '0\n')"
      count=$((count + 1))
      printf '%s\n' "$count" > "$CASE_ROOT/state/print-count"
      if [[ "$CASE_BEHAVIOR" == reprobe-error && "$count" -ge 3 ]] \
        || [[ "$CASE_BEHAVIOR" == reprobe-once-error && "$count" == 3 ]] \
        || [[ "$CASE_BEHAVIOR" == reprobe-rollback-fail && "$count" == 3 ]] \
        || [[ "$CASE_BEHAVIOR" == rollback-remove-fail && "$count" == 3 ]] \
        || [[ "$CASE_BEHAVIOR" == archive-replaced-before-rollback && "$count" == 3 ]]; then
        if [[ "$CASE_BEHAVIOR" == archive-replaced-before-rollback && "$count" == 3 ]]; then
          fixture_replace_archive
        fi
        printf 'launchd IPC error\n' >&2
        return 1
      fi
      if [[ "$(cat "$CASE_ROOT/state/loaded")" == 1 ]]; then
        printf 'service = %s\n' "$label"
      else
        printf 'Could not find service "%s" in domain for user\n' "$label" >&2
        return 113
      fi
      ;;
    bootout)
      printf 'bootout %s\n' "$target" >> "$CASE_ROOT/mutations"
      [[ "$CASE_BEHAVIOR" == bootout-fail ]] && return 1
      printf '0\n' > "$CASE_ROOT/state/loaded"
      if [[ "$CASE_BEHAVIOR" == collision-race ]]; then
        mkdir -p "$CASE_ROOT/home/Library/LaunchAgents/retired-20260819"
        printf 'operator raced file\n' > "$CASE_ROOT/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
      fi
      ;;
    bootstrap)
      printf 'bootstrap %s %s\n' "$target" "${3:-}" >> "$CASE_ROOT/mutations"
      [[ "$CASE_BEHAVIOR" == rollback-fail || "$CASE_BEHAVIOR" == reprobe-rollback-fail \
        || "$CASE_BEHAVIOR" == archive-rollback-bootstrap-fail ]] && return 1
      printf '1\n' > "$CASE_ROOT/state/loaded"
      ;;
    *) return 99 ;;
  esac
}
fly1814_cleanup_main "$@"
HARNESS
  set +e
  LAST_OUT="$(
    CLEANUP_TOOL="$CLEANUP_TOOL" CASE_ROOT="$case_root" CASE_TTY="$tty" \
      CASE_AUDIT_RESULT="$audit_result" CASE_BEHAVIOR="$behavior" HOME="$case_root/home" \
      /bin/bash "$harness" "$@" 2>&1
  )"
  LAST_RC=$?
  set -u
}

echo "Test: files source without auto-run and expose safe direct help"
set +e
lib_direct_out="$(/bin/bash "$REPO_ROOT/scripts/lib/fly1814-operator-tools.sh" 2>&1)"
lib_direct_rc=$?
set -u
if [[ -f "$AUX_TOOL" && -f "$CLEANUP_TOOL" ]] \
  && AUX_TOOL="$AUX_TOOL" CLEANUP_TOOL="$CLEANUP_TOOL" /bin/bash -c \
    'source "$AUX_TOOL"; source "$CLEANUP_TOOL"; declare -F fly1814_aux_main >/dev/null; declare -F fly1814_cleanup_main >/dev/null' \
  && /bin/bash "$AUX_TOOL" --help >/dev/null 2>&1 \
  && /bin/bash "$CLEANUP_TOOL" --help >/dev/null 2>&1 \
  && [[ "$lib_direct_rc" == 64 && "$lib_direct_out" == *source-only* ]]; then
  pass "tools are source-safe/directly executable and the library rejects direct execution"
else
  fail "operator tool source/direct-execution contract missing"
fi

echo "Test: production SHA-256 and device/inode identity seams are portable and exact"
identity_root="$ROOT/identity-primitives"
mkdir -p "$identity_root"
printf 'identity fixture\n' > "$identity_root/source"
ln "$identity_root/source" "$identity_root/same"
printf 'other fixture\n' > "$identity_root/other"
if REPO_ROOT="$REPO_ROOT" IDENTITY_ROOT="$identity_root" /bin/bash -c '
  source "$REPO_ROOT/scripts/lib/fly1814-operator-tools.sh"
  digest="$(printf abc | fly1814_sha256)" || exit 1
  source_id="$(fly1814_file_identity "$IDENTITY_ROOT/source")" || exit 2
  same_id="$(fly1814_file_identity "$IDENTITY_ROOT/same")" || exit 3
  other_id="$(fly1814_file_identity "$IDENTITY_ROOT/other")" || exit 4
  [[ "$digest" == ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad ]] || exit 5
  [[ "$source_id" == "$same_id" && "$source_id" != "$other_id" ]] || exit 6
  fly1814_files_are_same "$IDENTITY_ROOT/source" "$IDENTITY_ROOT/same" || exit 7
  ! fly1814_files_are_same "$IDENTITY_ROOT/source" "$IDENTITY_ROOT/other"
'; then
  pass "production primitives return SHA-256 and distinguish stable file identity"
else
  fail "SHA-256 or device/inode identity primitive is not portable/exact"
fi

echo "Test: decision artifact is exact, machine-readable, and entirely pending"
if [[ -f "$DECISIONS" ]] \
  && awk -F '\t' '
    NR == 1 { ok = ($0 == "label\tstatus\tapproved_target\tpurpose\tprovenance\trecommendation\tevidence"); next }
    NF != 7 || $2 != "pending" || $3 !~ /^\// || $4 == "" || $6 == "" || $7 == "" { ok = 0 }
    $5 == "bak-fly886" { bak++ }
    $5 == "unknown" { unknown++ }
    $1 == "com.flywheel.growth-improve" && $3 != "/Users/xiaorongli/Dev/tidal-echo/sub/content/scripts/growth-improve-tick.sh" { ok = 0 }
    $1 == "com.flywheel.growth-learn" && $3 != "/Users/xiaorongli/Dev/tidal-echo/sub/content/scripts/growth-learn-tick.sh" { ok = 0 }
    $1 == "com.flywheel.growth-report" && $3 != "/Users/xiaorongli/Dev/tidal-echo/sub/content/scripts/growth-report-tick.sh" { ok = 0 }
    $1 == "com.flywheel.growth-retro" && $3 != "/Users/xiaorongli/Dev/tidal-echo/sub/content/scripts/growth-retro-tick.sh" { ok = 0 }
    $1 == "com.flywheel.sub-create-nightly" && $3 != "/Users/xiaorongli/Dev/tidal-echo/sub/content/scripts/sub-create-nightly-tick.sh" { ok = 0 }
    $1 == "com.flywheel.sub-daily-loop" && $3 != "/Users/xiaorongli/Dev/tidal-echo/sub/content/scripts/sub-daily-loop-tick.sh" { ok = 0 }
    $1 == "com.flywheel.skills-update" && $3 != "/Users/xiaorongli/.flywheel/bin/skills-sync.sh" { ok = 0 }
    $1 == "com.flywheel.token-usage-daily" && $3 != "/Users/xiaorongli/Dev/flywheel/scripts/token-usage-daily.sh" { ok = 0 }
    { labels[$1]++; rows++ }
    END {
      expected["com.flywheel.growth-improve"]=1
      expected["com.flywheel.growth-learn"]=1
      expected["com.flywheel.growth-report"]=1
      expected["com.flywheel.growth-retro"]=1
      expected["com.flywheel.sub-create-nightly"]=1
      expected["com.flywheel.sub-daily-loop"]=1
      expected["com.flywheel.skills-update"]=1
      expected["com.flywheel.token-usage-daily"]=1
      if (rows != 8 || bak != 6 || unknown != 2) ok=0
      for (label in expected) if (labels[label] != 1) ok=0
      for (label in labels) if (!expected[label]) ok=0
      exit(ok ? 0 : 1)
    }
  ' "$DECISIONS"; then
  pass "eight decision rows bind pending authority to exact targets with 6 known and 2 unknown provenance rows"
else
  fail "decision artifact schema, labels, initial status, or provenance is wrong"
fi

echo "Test: aux approval is bound to a real, resolved, existing payload before and after audit"
run_aux "$ROOT/aux-target-missing" approved 0 1 1 sent target-missing \
  com.flywheel.growth-learn --apply --i-am-operator
target_missing_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *target* && ! -s "$ROOT/aux-target-missing/mutations" \
  && ! -s "$ROOT/aux-target-missing/audit.calls" ]] && target_missing_ok=1
run_aux "$ROOT/aux-target-unknown" approved 0 1 1 sent target-unknown \
  com.flywheel.growth-learn --apply --i-am-operator
target_unknown_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *target* && ! -s "$ROOT/aux-target-unknown/mutations" \
  && ! -s "$ROOT/aux-target-unknown/audit.calls" ]] && target_unknown_ok=1
run_aux "$ROOT/aux-target-changed" approved 0 1 1 sent target-changed-after-audit \
  com.flywheel.growth-learn --apply --i-am-operator
if [[ "$target_missing_ok" == 1 && "$target_unknown_ok" == 1 && "$LAST_RC" != 0 \
  && "$LAST_OUT" == *changed* && ! -s "$ROOT/aux-target-changed/mutations" \
  && -s "$ROOT/aux-target-changed/audit.calls" ]]; then
  pass "missing, unknown, and same-label changed payloads fail before launchctl mutation"
else
  fail "aux payload identity was not bound and revalidated"
fi

echo "Test: aux apply re-reads the exact approved decision after audit"
run_aux "$ROOT/aux-decision-revoked" approved 0 1 1 sent decision-revoked-after-audit \
  com.flywheel.growth-learn --apply --i-am-operator
decision_revoked_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *decision* \
  && ! -s "$ROOT/aux-decision-revoked/mutations" \
  && -s "$ROOT/aux-decision-revoked/audit.calls" ]] && decision_revoked_ok=1
run_aux "$ROOT/aux-decision-row-changed" approved 0 1 1 sent decision-row-changed-after-audit \
  com.flywheel.growth-learn --apply --i-am-operator
if [[ "$decision_revoked_ok" == 1 && "$LAST_RC" != 0 && "$LAST_OUT" == *decision* \
  && ! -s "$ROOT/aux-decision-row-changed/mutations" \
  && -s "$ROOT/aux-decision-row-changed/audit.calls" ]]; then
  pass "revoked or byte-changed approval cannot cross the post-audit authority boundary"
else
  fail "aux apply retained stale pre-audit decision authority"
fi

echo "Test: aux apply re-probes every signed launchctl state after audit"
run_aux "$ROOT/aux-disabled-changed-during-audit" approved 0 1 1 sent disabled-changed-during-audit \
  com.flywheel.growth-learn --apply --i-am-operator
aux_disabled_race_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *state* \
  && ! -s "$ROOT/aux-disabled-changed-during-audit/mutations" \
  && -s "$ROOT/aux-disabled-changed-during-audit/audit.calls" ]] && aux_disabled_race_ok=1
run_aux "$ROOT/aux-domain-changed-during-audit" approved 0 1 1 sent domain-changed-during-audit \
  com.flywheel.growth-learn --apply --i-am-operator
if [[ "$aux_disabled_race_ok" == 1 && "$LAST_RC" != 0 && "$LAST_OUT" == *state* \
  && ! -s "$ROOT/aux-domain-changed-during-audit/mutations" \
  && -s "$ROOT/aux-domain-changed-during-audit/audit.calls" ]]; then
  pass "disabled and domain drift cannot cross the audited pre-state boundary"
else
  fail "aux apply retained stale launchctl pre-state after audit"
fi

echo "Test: default dry runs perform zero mutation and zero audit"
run_aux "$ROOT/aux-dry" approved 0 1 0 sent normal com.flywheel.growth-learn
aux_dry_ok=0
[[ "$LAST_RC" == 0 && "$LAST_OUT" == *DRY-RUN* \
  && "$LAST_OUT" == *'purpose: fixture-purpose'* \
  && "$LAST_OUT" == *'recommendation: review-before-enable'* \
  && "$LAST_OUT" == *'evidence: fixture-evidence'* \
  && ! -s "$ROOT/aux-dry/mutations" && ! -s "$ROOT/aux-dry/audit.calls" ]] && aux_dry_ok=1
run_cleanup "$ROOT/cleanup-dry" com.xiaohongshu-deep-learning.qa528 1 0 sent normal
if [[ "$aux_dry_ok" == 1 && "$LAST_RC" == 0 && "$LAST_OUT" == *DRY-RUN* \
  && "$LAST_OUT" == *'bootout gui/501/com.xiaohongshu-deep-learning.qa528'* \
  && "$LAST_OUT" == *'retired-20260819'* \
  && ! -s "$ROOT/cleanup-dry/mutations" && ! -s "$ROOT/cleanup-dry/audit.calls" ]]; then
  pass "dry-run reports exact intent without launchctl/filesystem mutation or audit send"
else
  fail "dry-run mutated state, sent audit, or omitted exact cleanup intent"
fi

echo "Test: apply requires both an interactive TTY and the operator flag"
run_aux "$ROOT/aux-nontty" approved 0 1 0 sent normal \
  com.flywheel.growth-learn --apply --i-am-operator
nontty_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *TTY* \
  && ! -s "$ROOT/aux-nontty/mutations" && ! -s "$ROOT/aux-nontty/audit.calls" ]] && nontty_ok=1
run_aux "$ROOT/aux-no-flag" approved 0 1 1 sent normal com.flywheel.growth-learn --apply
if [[ "$nontty_ok" == 1 && "$LAST_RC" != 0 && "$LAST_OUT" == *i-am-operator* \
  && ! -s "$ROOT/aux-no-flag/mutations" && ! -s "$ROOT/aux-no-flag/audit.calls" ]]; then
  pass "non-TTY and missing-flag apply attempts fail before audit or mutation"
else
  fail "operator identity gates did not fail closed"
fi

echo "Test: exact aux allowlist and pending/hold authority fail closed"
run_aux "$ROOT/aux-unknown" approved 0 1 1 sent normal com.flywheel.not-approved --apply --i-am-operator
unknown_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *allowlist* \
  && ! -s "$ROOT/aux-unknown/mutations" && ! -s "$ROOT/aux-unknown/audit.calls" ]] && unknown_ok=1
run_aux "$ROOT/aux-pending" pending 0 1 1 sent normal com.flywheel.growth-learn --apply --i-am-operator
pending_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *pending* \
  && ! -s "$ROOT/aux-pending/mutations" && ! -s "$ROOT/aux-pending/audit.calls" ]] && pending_ok=1
run_aux "$ROOT/aux-hold" hold 0 1 1 sent normal com.flywheel.growth-learn --apply --i-am-operator
if [[ "$unknown_ok" == 1 && "$pending_ok" == 1 && "$LAST_RC" != 0 && "$LAST_OUT" == *hold* \
  && ! -s "$ROOT/aux-hold/mutations" && ! -s "$ROOT/aux-hold/audit.calls" ]]; then
  pass "unknown labels and non-approved decisions can never reach mutation"
else
  fail "aux allowlist or decision authority was bypassed"
fi

echo "Test: aux audit delivery must be confirmed before mutation"
run_aux "$ROOT/aux-audit-fail" approved 0 1 1 queued_transient normal \
  com.flywheel.growth-learn --apply --i-am-operator
if [[ "$LAST_RC" != 0 && "$LAST_OUT" == *audit* \
  && ! -s "$ROOT/aux-audit-fail/mutations" ]] \
  && grep -q -- '--kind deploy_degraded' "$ROOT/aux-audit-fail/audit.calls" \
  && ! grep -q -- '--mention-user' "$ROOT/aux-audit-fail/audit.calls"; then
  pass "unconfirmed aux audit blocks mutation and never mentions the founder"
else
  fail "aux mutation escaped an unconfirmed audit"
fi

echo "Test: one approved aux label enables, bootstraps only if unloaded, and re-probes"
run_aux "$ROOT/aux-approved" approved 0 1 1 sent normal \
  com.flywheel.growth-learn --apply --i-am-operator
expected_aux_mutations="$(printf 'enable gui/501/com.flywheel.growth-learn\nbootstrap gui/501 %s\n' \
  "$ROOT/aux-approved/home/Library/LaunchAgents/com.flywheel.growth-learn.plist")"
if [[ "$LAST_RC" == 0 && "$(cat "$ROOT/aux-approved/mutations")" == "$expected_aux_mutations" \
  && "$(cat "$ROOT/aux-approved/state/loaded")" == 1 \
  && "$(cat "$ROOT/aux-approved/state/disabled")" == 0 \
  && "$LAST_OUT" == *'before: disabled loaded=no'* \
  && "$LAST_OUT" == *'after: enabled loaded=yes'* ]]; then
  pass "approved apply mutates exactly one label and reports before/after evidence"
else
  fail "approved aux apply command order or evidence mismatch: rc=$LAST_RC out=$LAST_OUT"
fi

echo "Test: already enabled and loaded aux apply is idempotent"
run_aux "$ROOT/aux-loaded" approved 1 0 1 sent normal \
  com.flywheel.growth-learn --apply --i-am-operator
if [[ "$LAST_RC" == 0 && ! -s "$ROOT/aux-loaded/mutations" \
  && "$LAST_OUT" == *'already enabled and loaded'* \
  && "$(wc -l < "$ROOT/aux-loaded/audit.calls" | tr -d ' ')" == 1 ]]; then
  pass "already-converged aux apply audits once and performs no launchctl mutation"
else
  fail "already-loaded aux apply was not idempotent"
fi

echo "Test: SHA-256 audit signature binds exact decision and mutation-driving pre-state"
signature_root="$ROOT/aux-signature"
run_aux "$signature_root" approved 1 0 1 sent normal \
  com.flywheel.growth-learn --apply --i-am-operator
signature_one="$(sed -n 's/.*--signature \([^ ]*\).*/\1/p' "$signature_root/audit.calls")"
run_aux "$signature_root" approved 1 0 1 sent normal \
  com.flywheel.growth-learn --apply --i-am-operator
signature_two="$(sed -n 's/.*--signature \([^ ]*\).*/\1/p' "$signature_root/audit.calls")"
run_aux "$signature_root" approved 1 0 1 sent decision-content \
  com.flywheel.growth-learn --apply --i-am-operator
signature_decision_changed="$(sed -n 's/.*--signature \([^ ]*\).*/\1/p' "$signature_root/audit.calls")"
run_aux "$signature_root" approved 0 1 1 queued_transient normal \
  com.flywheel.growth-learn --apply --i-am-operator
signature_state_changed="$(sed -n 's/.*--signature \([^ ]*\).*/\1/p' "$signature_root/audit.calls")"
signature_format_ok=0
printf '%s\n' "$signature_one" \
  | grep -Eq '^fly1814-enable-aux-com\.flywheel\.growth-learn-[0-9]{8}-[0-9a-f]{64}$' \
  && signature_format_ok=1
cleanup_signature_root="$ROOT/cleanup-signature"
run_cleanup "$cleanup_signature_root" com.xiaohongshu-deep-learning.qa528 1 1 queued_transient normal \
  --apply --i-am-operator
cleanup_signature_loaded="$(sed -n 's/.*--signature \([^ ]*\).*/\1/p' "$cleanup_signature_root/audit.calls")"
run_cleanup "$cleanup_signature_root" com.xiaohongshu-deep-learning.qa528 1 1 queued_transient normal \
  --apply --i-am-operator
cleanup_signature_same="$(sed -n 's/.*--signature \([^ ]*\).*/\1/p' "$cleanup_signature_root/audit.calls")"
run_cleanup "$cleanup_signature_root" com.xiaohongshu-deep-learning.qa528 0 1 queued_transient normal \
  --apply --i-am-operator
cleanup_signature_unloaded="$(sed -n 's/.*--signature \([^ ]*\).*/\1/p' "$cleanup_signature_root/audit.calls")"
if [[ "$signature_format_ok" == 1 && -n "$signature_one" && "$signature_one" == "$signature_two" \
  && "$signature_one" != "$signature_decision_changed" \
  && "$signature_one" != "$signature_state_changed" \
  && -n "$cleanup_signature_loaded" && "$cleanup_signature_loaded" == "$cleanup_signature_same" \
  && "$cleanup_signature_loaded" != "$cleanup_signature_unloaded" ]]; then
  pass "identical intents dedupe while decision and prior-state changes get distinct SHA-256 identities"
else
  fail "audit signature omits authority/pre-state or is not deterministic SHA-256"
fi

echo "Test: aux failures restore the prior disabled and unloaded state"
run_aux "$ROOT/aux-enable-fail" approved 0 1 1 sent enable-fail \
  com.flywheel.growth-learn --apply --i-am-operator
enable_fail_ok=0
[[ "$LAST_RC" != 0 && "$(cat "$ROOT/aux-enable-fail/state/disabled")" == 1 \
  && "$(cat "$ROOT/aux-enable-fail/state/loaded")" == 0 ]] && enable_fail_ok=1
run_aux "$ROOT/aux-bootstrap-fail" approved 0 1 1 sent bootstrap-fail \
  com.flywheel.growth-learn --apply --i-am-operator
bootstrap_fail_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *restored* \
  && "$(cat "$ROOT/aux-bootstrap-fail/state/disabled")" == 1 \
  && "$(cat "$ROOT/aux-bootstrap-fail/state/loaded")" == 0 \
  && "$(cat "$ROOT/aux-bootstrap-fail/mutations")" == *disable* ]] && bootstrap_fail_ok=1
run_aux "$ROOT/aux-reprobe-missing" approved 0 1 1 sent reprobe-missing \
  com.flywheel.growth-learn --apply --i-am-operator
reprobe_missing_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *restored* \
  && "$(cat "$ROOT/aux-reprobe-missing/state/disabled")" == 1 \
  && "$(cat "$ROOT/aux-reprobe-missing/state/loaded")" == 0 ]] && reprobe_missing_ok=1
run_aux "$ROOT/aux-reprobe-error" approved 0 1 1 sent reprobe-error \
  com.flywheel.growth-learn --apply --i-am-operator
reprobe_error_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *restored* \
  && "$(cat "$ROOT/aux-reprobe-error/state/disabled")" == 1 \
  && "$(cat "$ROOT/aux-reprobe-error/state/loaded")" == 0 ]] && reprobe_error_ok=1
run_aux "$ROOT/aux-rollback-bootout" approved 0 1 1 sent rollback-bootout-fail \
  com.flywheel.growth-learn --apply --i-am-operator
rollback_bootout_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *rollback-failed* \
  && "$(cat "$ROOT/aux-rollback-bootout/state/disabled")" == 1 \
  && "$(cat "$ROOT/aux-rollback-bootout/state/loaded")" == 1 ]] && rollback_bootout_ok=1
run_aux "$ROOT/aux-rollback-disable" approved 0 1 1 sent rollback-disable-fail \
  com.flywheel.growth-learn --apply --i-am-operator
if [[ "$enable_fail_ok" == 1 && "$bootstrap_fail_ok" == 1 \
  && "$reprobe_missing_ok" == 1 && "$reprobe_error_ok" == 1 \
  && "$rollback_bootout_ok" == 1 && "$LAST_RC" != 0 && "$LAST_OUT" == *rollback-failed* \
  && "$(cat "$ROOT/aux-rollback-disable/state/disabled")" == 0 \
  && "$(cat "$ROOT/aux-rollback-disable/state/loaded")" == 0 ]]; then
  pass "enable/bootstrap/reprobe failures compensate or report distinct rollback failure"
else
  fail "aux compensation matrix did not restore or distinguish rollback failure"
fi

echo "Test: aux rollback never disables a label that was already enabled"
run_aux "$ROOT/aux-prior-enabled" approved 0 0 1 sent bootstrap-fail \
  com.flywheel.growth-learn --apply --i-am-operator
if [[ "$LAST_RC" != 0 && "$(cat "$ROOT/aux-prior-enabled/state/disabled")" == 0 ]] \
  && ! grep -q '^disable ' "$ROOT/aux-prior-enabled/mutations"; then
  pass "already-enabled prior state is not replaced with a disable rollback"
else
  fail "aux rollback invented a disabled state"
fi

echo "Test: cleanup rejects identity drift, archive collisions, and audit failure"
run_cleanup "$ROOT/cleanup-mismatch" com.example.changed 1 1 sent normal --apply --i-am-operator
mismatch_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *Label* \
  && ! -s "$ROOT/cleanup-mismatch/mutations" && ! -s "$ROOT/cleanup-mismatch/audit.calls" ]] && mismatch_ok=1
collision_root="$ROOT/cleanup-collision"
mkdir -p "$collision_root/home/Library/LaunchAgents/retired-20260819"
printf 'collision\n' > "$collision_root/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
run_cleanup "$collision_root" com.xiaohongshu-deep-learning.qa528 1 1 sent normal --apply --i-am-operator
collision_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *collision* \
  && ! -s "$collision_root/mutations" && ! -s "$collision_root/audit.calls" ]] && collision_ok=1
symlink_root="$ROOT/cleanup-symlink"
mkdir -p "$symlink_root/home/Library/LaunchAgents" "$symlink_root/archive-elsewhere"
ln -s "$symlink_root/archive-elsewhere" \
  "$symlink_root/home/Library/LaunchAgents/retired-20260819"
run_cleanup "$symlink_root" com.xiaohongshu-deep-learning.qa528 1 1 sent normal --apply --i-am-operator
symlink_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *'archive directory'* \
  && ! -s "$symlink_root/mutations" && ! -s "$symlink_root/audit.calls" ]] && symlink_ok=1
run_cleanup "$ROOT/cleanup-audit-fail" com.xiaohongshu-deep-learning.qa528 1 1 dead_lettered normal \
  --apply --i-am-operator
if [[ "$mismatch_ok" == 1 && "$collision_ok" == 1 && "$symlink_ok" == 1 && "$LAST_RC" != 0 \
  && "$LAST_OUT" == *audit* && ! -s "$ROOT/cleanup-audit-fail/mutations" \
  && -f "$ROOT/cleanup-audit-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" ]]; then
  pass "cleanup preflight and audit failures preserve the active plist and launchd state"
else
  fail "cleanup identity/collision/audit gate did not fail closed"
fi

echo "Test: qa528 target shape rejects traversal, empty segments, and arbitrary depth"
if CLEANUP_TOOL="$CLEANUP_TOOL" /bin/bash -c '
  source "$CLEANUP_TOOL"
  good=/var/folders/zz/fixture/T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh
  fly1814_cleanup_target_is_stale "$good" || exit 1
  for bad in \
    /private/var/folders/zz/fixture/T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh \
    /var/folders/z/fixture/T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh \
    /var/folders/zz/../T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh \
    /var/folders/zz/fixture/T/../com.xiaohongshu-deep-learning.qa528-scheduled.sh \
    /var/folders/zz//T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh \
    /var/folders/zz/fixture/extra/T/fly1814/com.xiaohongshu-deep-learning.qa528-scheduled.sh \
    /var/folders/zz/fixture/T/fly1814/extra/com.xiaohongshu-deep-learning.qa528-scheduled.sh \
    /var/folders/zz/fixture/T/fly1814/not-qa528.sh; do
    if fly1814_cleanup_target_is_stale "$bad"; then exit 2; fi
  done
'; then
  pass "qa528 accepts only the exact normalized /var/folders segment structure"
else
  fail "qa528 temporary target validator crosses slash/traversal boundaries"
fi

echo "Test: cleanup reference scan errors fail closed before audit or mutation"
run_cleanup "$ROOT/cleanup-reference-error" com.xiaohongshu-deep-learning.qa528 1 1 sent reference-error \
  --apply --i-am-operator
if [[ "$LAST_RC" != 0 && "$LAST_OUT" == *reference* && "$LAST_OUT" != *'(none)'* \
  && ! -s "$ROOT/cleanup-reference-error/audit.calls" \
  && ! -s "$ROOT/cleanup-reference-error/mutations" ]]; then
  pass "an incomplete reference scan is never reported as no references"
else
  fail "reference scan error was hidden or allowed mutation"
fi

echo "Test: cleanup revalidates collision and identity after the exact audit receipt"
run_cleanup "$ROOT/cleanup-post-audit-collision" com.xiaohongshu-deep-learning.qa528 1 1 sent collision-after-audit \
  --apply --i-am-operator
post_audit_archive="$ROOT/cleanup-post-audit-collision/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
post_audit_collision_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *collision* \
  && "$(cat "$post_audit_archive")" == 'operator raced file' \
  && ! -s "$ROOT/cleanup-post-audit-collision/mutations" ]] && post_audit_collision_ok=1
run_cleanup "$ROOT/cleanup-post-audit-target" com.xiaohongshu-deep-learning.qa528 1 1 sent target-changed-after-audit \
  --apply --i-am-operator
post_audit_target_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *changed* \
  && ! -s "$ROOT/cleanup-post-audit-target/mutations" ]] && post_audit_target_ok=1
run_cleanup "$ROOT/cleanup-post-audit-symlink" com.xiaohongshu-deep-learning.qa528 1 1 sent symlink-after-audit \
  --apply --i-am-operator
if [[ "$post_audit_collision_ok" == 1 && "$post_audit_target_ok" == 1 \
  && "$LAST_RC" != 0 && "$LAST_OUT" == *changed* \
  && ! -s "$ROOT/cleanup-post-audit-symlink/mutations" ]]; then
  pass "post-audit collision/target/type drift is caught before bootout"
else
  fail "cleanup did not revalidate every identity/filesystem boundary after audit"
fi

echo "Test: cleanup re-probes its signed domain state after audit"
run_cleanup "$ROOT/cleanup-domain-changed-during-audit" com.xiaohongshu-deep-learning.qa528 1 1 sent \
  domain-changed-during-audit --apply --i-am-operator
if [[ "$LAST_RC" != 0 && "$LAST_OUT" == *state* \
  && ! -s "$ROOT/cleanup-domain-changed-during-audit/mutations" \
  && ! -s "$ROOT/cleanup-domain-changed-during-audit/filesystem.calls" \
  && -f "$ROOT/cleanup-domain-changed-during-audit/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && ! -e "$ROOT/cleanup-domain-changed-during-audit/home/Library/LaunchAgents/retired-20260819" ]]; then
  pass "cleanup domain drift aborts before bootout, archive, or compensation"
else
  fail "cleanup retained stale launchctl pre-state after audit"
fi

echo "Test: cleanup mkdir and bootout failures cannot reach archive publication"
run_cleanup "$ROOT/cleanup-mkdir-fail" com.xiaohongshu-deep-learning.qa528 1 1 sent mkdir-fail \
  --apply --i-am-operator
mkdir_fail_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *archive* \
  && ! -s "$ROOT/cleanup-mkdir-fail/mutations" \
  && -f "$ROOT/cleanup-mkdir-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" ]] && mkdir_fail_ok=1
run_cleanup "$ROOT/cleanup-bootout-fail" com.xiaohongshu-deep-learning.qa528 1 1 sent bootout-fail \
  --apply --i-am-operator
if [[ "$mkdir_fail_ok" == 1 && "$LAST_RC" != 0 && "$LAST_OUT" == *bootout* \
  && -f "$ROOT/cleanup-bootout-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && ! -e "$ROOT/cleanup-bootout-fail/home/Library/LaunchAgents/retired-20260819" \
  && "$(cat "$ROOT/cleanup-bootout-fail/state/loaded")" == 1 ]]; then
  pass "directory and bootout failures preserve the active plist and prior domain"
else
  fail "cleanup crossed an unsuccessful directory/bootout boundary"
fi

echo "Test: cleanup compensates every failure after bootout"
run_cleanup "$ROOT/cleanup-archive-fail" com.xiaohongshu-deep-learning.qa528 1 1 sent archive-fail \
  --apply --i-am-operator
archive_fail_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *restored* \
  && -f "$ROOT/cleanup-archive-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && ! -e "$ROOT/cleanup-archive-fail/home/Library/LaunchAgents/retired-20260819" \
  && "$(cat "$ROOT/cleanup-archive-fail/state/loaded")" == 1 ]] && archive_fail_ok=1
run_cleanup "$ROOT/cleanup-source-remove-fail" com.xiaohongshu-deep-learning.qa528 1 1 sent source-remove-fail \
  --apply --i-am-operator
source_remove_fail_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *restored* \
  && -f "$ROOT/cleanup-source-remove-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && ! -e "$ROOT/cleanup-source-remove-fail/home/Library/LaunchAgents/retired-20260819" \
  && "$(cat "$ROOT/cleanup-source-remove-fail/state/loaded")" == 1 ]] && source_remove_fail_ok=1
run_cleanup "$ROOT/cleanup-source-remove-after" com.xiaohongshu-deep-learning.qa528 1 1 sent source-remove-after-effect \
  --apply --i-am-operator
source_remove_after_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *restored* \
  && -f "$ROOT/cleanup-source-remove-after/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && ! -e "$ROOT/cleanup-source-remove-after/home/Library/LaunchAgents/retired-20260819" \
  && "$(cat "$ROOT/cleanup-source-remove-after/state/loaded")" == 1 ]] && source_remove_after_ok=1
run_cleanup "$ROOT/cleanup-reprobe-fail" com.xiaohongshu-deep-learning.qa528 1 1 sent reprobe-once-error \
  --apply --i-am-operator
reprobe_fail_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *restored* \
  && -f "$ROOT/cleanup-reprobe-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && ! -e "$ROOT/cleanup-reprobe-fail/home/Library/LaunchAgents/retired-20260819" \
  && "$(cat "$ROOT/cleanup-reprobe-fail/state/loaded")" == 1 ]] && reprobe_fail_ok=1
run_cleanup "$ROOT/cleanup-remove-rollback-fail" com.xiaohongshu-deep-learning.qa528 1 1 sent rollback-remove-fail \
  --apply --i-am-operator
remove_rollback_fail_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *rollback-failed* \
  && -f "$ROOT/cleanup-remove-rollback-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && -f "$ROOT/cleanup-remove-rollback-fail/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist" \
  && "$(cat "$ROOT/cleanup-remove-rollback-fail/state/loaded")" == 1 ]] && remove_rollback_fail_ok=1
run_cleanup "$ROOT/cleanup-bootstrap-rollback-fail" com.xiaohongshu-deep-learning.qa528 1 1 sent archive-rollback-bootstrap-fail \
  --apply --i-am-operator
bootstrap_rollback_fail_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *rollback-failed* \
  && -f "$ROOT/cleanup-bootstrap-rollback-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && "$(cat "$ROOT/cleanup-bootstrap-rollback-fail/state/loaded")" == 0 ]] && bootstrap_rollback_fail_ok=1
run_cleanup "$ROOT/cleanup-rollback-fail" com.xiaohongshu-deep-learning.qa528 1 1 sent reprobe-rollback-fail \
  --apply --i-am-operator
if [[ "$archive_fail_ok" == 1 && "$source_remove_fail_ok" == 1 && "$source_remove_after_ok" == 1 \
  && "$reprobe_fail_ok" == 1 && "$remove_rollback_fail_ok" == 1 && "$bootstrap_rollback_fail_ok" == 1 \
  && "$LAST_RC" != 0 && "$LAST_OUT" == *rollback-failed* \
  && ! -e "$ROOT/cleanup-rollback-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && -f "$ROOT/cleanup-rollback-fail/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist" \
  && "$(cat "$ROOT/cleanup-rollback-fail/state/loaded")" == 0 ]]; then
  pass "archive/source-remove/reprobe faults restore state or report rollback-failed"
else
  fail "cleanup post-bootout compensation matrix is incomplete"
fi

echo "Test: cleanup never uses or deletes an archive path whose inode was replaced"
run_cleanup "$ROOT/cleanup-replaced-before-unlink" com.xiaohongshu-deep-learning.qa528 1 1 sent archive-replaced-before-unlink \
  --apply --i-am-operator
replaced_unlink_archive="$ROOT/cleanup-replaced-before-unlink/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
replaced_before_unlink_ok=0
[[ "$LAST_RC" != 0 && "$LAST_OUT" == *rollback-failed* \
  && "$(cat "$replaced_unlink_archive")" == 'operator replacement bytes' \
  && -f "$ROOT/cleanup-replaced-before-unlink/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && "$(cat "$ROOT/cleanup-replaced-before-unlink/state/loaded")" == 1 ]] && replaced_before_unlink_ok=1
run_cleanup "$ROOT/cleanup-replaced-before-rollback" com.xiaohongshu-deep-learning.qa528 1 1 sent archive-replaced-before-rollback \
  --apply --i-am-operator
replaced_rollback_archive="$ROOT/cleanup-replaced-before-rollback/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
if [[ "$replaced_before_unlink_ok" == 1 && "$LAST_RC" != 0 && "$LAST_OUT" == *rollback-failed* \
  && "$(cat "$replaced_rollback_archive")" == 'operator replacement bytes' \
  && ! -e "$ROOT/cleanup-replaced-before-rollback/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && "$(cat "$ROOT/cleanup-replaced-before-rollback/state/loaded")" == 0 ]]; then
  pass "inode replacement is preserved and never becomes a restore/delete authority"
else
  fail "cleanup trusted a path after its transaction-owned inode was replaced"
fi

echo "Test: cleanup rollback retains source ownership when archive publication never succeeds"
run_cleanup "$ROOT/cleanup-source-replaced-before-publish-fail" \
  com.xiaohongshu-deep-learning.qa528 1 1 sent \
  active-source-replaced-before-publication-failure --apply --i-am-operator
prepublish_active="$ROOT/cleanup-source-replaced-before-publish-fail/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist"
prepublish_archive="$ROOT/cleanup-source-replaced-before-publish-fail/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
if [[ "$LAST_RC" != 0 && "$LAST_OUT" == *rollback-failed* \
  && -f "$prepublish_active" && ! -e "$prepublish_archive" \
  && "$(cat "$prepublish_active")" == *'operator active replacement before failed publication'* \
  && "$(cat "$ROOT/cleanup-source-replaced-before-publish-fail/mutations")" \
    == 'bootout gui/501/com.xiaohongshu-deep-learning.qa528' ]]; then
  pass "failed publication cannot bootstrap a foreign same-payload active inode"
else
  fail "cleanup rollback forgot signed source ownership before archive identity existed"
fi

echo "Test: cleanup rollback preserves a foreign active source and its owned archive"
run_cleanup "$ROOT/cleanup-active-source-replaced" com.xiaohongshu-deep-learning.qa528 1 1 sent \
  active-source-replaced-after-publication --apply --i-am-operator
active_replacement="$ROOT/cleanup-active-source-replaced/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist"
owned_archive="$ROOT/cleanup-active-source-replaced/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
if [[ "$LAST_RC" != 0 && "$LAST_OUT" == *rollback-failed* \
  && -f "$active_replacement" && -f "$owned_archive" \
  && "$(cat "$active_replacement")" == *'operator active replacement bytes'* \
  && "$(cat "$owned_archive")" != *'operator active replacement bytes'* \
  && "$(cat "$ROOT/cleanup-active-source-replaced/mutations")" \
    == 'bootout gui/501/com.xiaohongshu-deep-learning.qa528' ]]; then
  pass "same-payload foreign active bytes block archive removal and bootstrap"
else
  fail "cleanup rollback trusted a foreign same-payload active source"
fi

echo "Test: atomic archive publication cannot overwrite a raced operator file"
run_cleanup "$ROOT/cleanup-collision-race" com.xiaohongshu-deep-learning.qa528 1 1 sent collision-race \
  --apply --i-am-operator
race_archive="$ROOT/cleanup-collision-race/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
if [[ "$LAST_RC" != 0 && "$(cat "$race_archive")" == 'operator raced file' \
  && -f "$ROOT/cleanup-collision-race/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && "$(cat "$ROOT/cleanup-collision-race/state/loaded")" == 1 ]]; then
  pass "create-if-absent publication preserves a raced destination and restores launchd"
else
  fail "cleanup archive publication overwrote a race or failed compensation"
fi

echo "Test: valid cleanup bootouts, archives without delete, and proves absence"
valid_root="$ROOT/cleanup-valid"
run_cleanup "$valid_root" com.xiaohongshu-deep-learning.qa528 1 1 sent normal --apply --i-am-operator
valid_archive="$valid_root/home/Library/LaunchAgents/retired-20260819/com.xiaohongshu-deep-learning.qa528.plist"
if [[ "$LAST_RC" == 0 \
  && "$(cat "$valid_root/mutations")" == 'bootout gui/501/com.xiaohongshu-deep-learning.qa528' \
  && -f "$valid_archive" \
  && ! -e "$valid_root/home/Library/LaunchAgents/com.xiaohongshu-deep-learning.qa528.plist" \
  && "$LAST_OUT" == *'remaining references before archive:'* \
  && "$LAST_OUT" == *'after: missing'* ]]; then
  pass "valid cleanup moves the exact plist to the dated archive and re-probes missing"
else
  fail "valid cleanup mutation/archive/re-probe mismatch: rc=$LAST_RC out=$LAST_OUT"
fi

echo "Test: already absent cleanup is an honest idempotent success"
run_cleanup "$ROOT/cleanup-absent" absent 0 1 sent normal --apply --i-am-operator
if [[ "$LAST_RC" == 0 && "$LAST_OUT" == *'already absent/retired'* \
  && ! -s "$ROOT/cleanup-absent/mutations" && ! -s "$ROOT/cleanup-absent/audit.calls" ]]; then
  pass "already absent/retired state returns success without mutation or audit"
else
  fail "already absent cleanup was not idempotent"
fi

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
