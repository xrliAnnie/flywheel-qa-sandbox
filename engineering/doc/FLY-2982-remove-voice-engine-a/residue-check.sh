#!/usr/bin/env bash
# FLY-2982: prove engine A (OpenAI Realtime over WebSocket + platform key) has no
# entry point or caller left in the repository.
#
# usage:
#   residue-check.sh [--root <repo>] [--allowlist <tsv>]   scan; exit 0 = no unallowed hit
#   residue-check.sh --self-test                            prove the check fails closed
#
# Every hit of PATTERN outside the history docs, and every hit of KEY_PATTERN
# (the platform key engine A billed to) inside the voice path KEY_SCOPE, must
# match one allowlist row exactly:
#   <exact path> TAB <whole-line ERE> TAB <category> TAB <reason>.
# A category may only be used in the files listed for it below (no directory or
# package wildcards, no whole-file exemptions). An allowlist row that matches no
# hit is stale and fails the check too.
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"

PATTERN='openai-realtime|openai_realtime|RealtimeFrontend|realtime-transport|OPENAI_REALTIME_URL|createRealtimeSocket|realtimeVoice|REALTIME_V2_VOICES|RealtimeV2Voice|isRealtimeV2Voice|realtimeApiKey|FLYWHEEL_VOICE_BACKEND|voice_api_key_unset|realtime_capacity|gpt-realtime-1\.5|api\.openai\.com/v1/realtime|check-voice-api-auth|invalid_realtime_voice|readManagedOpenAiKey|isApprovedRealtimeModel|buildFrontendPrompt'

# FLY-2982 Codex R1: engine A's key forwarding (e.g. `OPENAI_API_KEY:
# input.openAiApiKey`) must not come back on the voice path. The key has
# legitimate uses elsewhere (Codex Leads, edge-worker), so this scan is scoped.
KEY_PATTERN='OPENAI_API_KEY|openAiApiKey'
KEY_SCOPE=(
  packages/voice-codex
  packages/voice-core
  packages/voice-bridge
  ':(glob)packages/teamlead/src/bridge/voice-*'
  ':(glob)packages/teamlead/src/bridge/__tests__/voice-*'
  scripts/flywheel-voice-wrapper.sh
  scripts/voice-host-configure.mjs
  ':(glob)scripts/lib/*voice*'
  ':(glob)scripts/qa/*voice*'
  scripts/qa/fly2655-voice-room.mjs
  scripts/qa/fly2799-codex-container.mjs
  scripts/test-deploy.sh
  ':(glob)scripts/__tests__/*voice*'
  ':(glob)scripts/__tests__/*fly2655*'
  ':(glob)scripts/__tests__/*fly2799*'
)

# category -> the only files it may exempt lines in (plan T6 table)
category_allows() {
  local category="$1" path="$2"
  case "$category" in
    tombstone)
      [[ "$path" == packages/voice-codex/retired-outputs.json ]]
      ;;
    legacy-strip)
      [[ "$path" == packages/teamlead/src/ProjectConfig.ts ||
        "$path" == scripts/voice-host-configure.mjs ]]
      ;;
    scrub)
      [[ "$path" == packages/voice-codex/src/config.ts ||
        "$path" == scripts/flywheel-voice-wrapper.sh ]]
      ;;
    bridge-env-hygiene)
      [[ "$path" == scripts/test-deploy.sh ||
        "$path" == scripts/__tests__/fly2655-voice-room.test.mjs ]]
      ;;
    fixture-placeholder)
      [[ "$path" == scripts/__tests__/install-voice-launchd.test.mjs ]]
      ;;
    negative-test)
      case "$path" in
        packages/voice-codex/src/__tests__/config.test.ts | \
          packages/voice-codex/src/__tests__/codex-container.test.ts | \
          packages/voice-codex/src/__tests__/projection.test.ts | \
          scripts/__tests__/fly2655-voice-room.test.mjs | \
          scripts/__tests__/fly2799-codex-container.test.mjs | \
          packages/teamlead/src/__tests__/huddle-config.test.ts | \
          packages/teamlead/src/bridge/__tests__/voice-session-services.test.ts | \
          packages/teamlead/src/__tests__/StateStore.voice-session.test.ts | \
          scripts/__tests__/flywheel-voice-wrapper.test.sh | \
          scripts/__tests__/voice-host-configure.test.mjs)
          return 0
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

scan() {
  local root="$1" allowlist="$2"
  local -a al_path=() al_regex=() al_used=()
  local path regex category reason extra n=0 bad=0

  while IFS=$'\t' read -r path regex category reason extra || [[ -n "$path" ]]; do
    [[ -z "$path" || "$path" == \#* ]] && continue
    if [[ -z "$regex" || -z "$category" || -z "$reason" || -n "${extra:-}" ]]; then
      echo "residue-check: malformed allowlist row: $path" >&2
      return 2
    fi
    if [[ "$path" == *'*'* || "$path" == */ ]] || ! category_allows "$category" "$path"; then
      echo "residue-check: category '$category' is not allowed for $path" >&2
      return 2
    fi
    if [[ "$regex" != ^* || "$regex" != *\$ ]]; then
      echo "residue-check: allowlist regex must be anchored to the whole line: $path" >&2
      return 2
    fi
    al_path[n]="$path"
    al_regex[n]="$regex"
    al_used[n]=0
    n=$((n + 1))
  done <"$allowlist"

  # git grep exits 1 for "no match"; anything above 1 is a scan failure and
  # must never read as a clean result.
  local hits key_hits grep_rc=0
  hits="$(git -C "$root" -c color.grep=never grep -n -I -E "$PATTERN" -- . \
    ':!engineering/doc' ':!doc' ':!product/doc')" || grep_rc=$?
  if [[ $grep_rc -gt 1 ]]; then
    echo "residue-check: git grep failed (exit ${grep_rc}) in ${root}" >&2
    return 2
  fi
  grep_rc=0
  key_hits="$(git -C "$root" -c color.grep=never grep -n -I -E "$KEY_PATTERN" -- \
    "${KEY_SCOPE[@]}")" || grep_rc=$?
  if [[ $grep_rc -gt 1 ]]; then
    echo "residue-check: voice-path key scan failed (exit ${grep_rc}) in ${root}" >&2
    return 2
  fi
  # A line can hit both scans; judge it once.
  hits="$(printf '%s\n%s\n' "$hits" "$key_hits" | LC_ALL=C sort -u)"

  local line hit_path rest lineno content i matched
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    hit_path="${line%%:*}"
    rest="${line#*:}"
    lineno="${rest%%:*}"
    content="${rest#*:}"
    matched=0
    i=0
    while [[ $i -lt $n ]]; do
      if [[ "${al_path[i]}" == "$hit_path" ]] && [[ "$content" =~ ${al_regex[i]} ]]; then
        matched=1
        al_used[i]=1
      fi
      i=$((i + 1))
    done
    if [[ $matched -eq 0 ]]; then
      echo "UNALLOWED ${hit_path}:${lineno}:${content}"
      bad=1
    fi
  done <<<"$hits"

  i=0
  while [[ $i -lt $n ]]; do
    if [[ "${al_used[i]}" -eq 0 ]]; then
      echo "STALE allowlist row matches nothing: ${al_path[i]}	${al_regex[i]}"
      bad=1
    fi
    i=$((i + 1))
  done

  local total
  total="$(grep -c . <<<"$hits" || true)"
  if [[ $bad -ne 0 ]]; then
    echo "residue-check: FAIL (hits=${total}, allowlist rows=${n})"
    return 1
  fi
  echo "residue-check: OK — ${total} hit(s), all matched by ${n} line-scoped allowlist row(s); zero unallowed hits"
  return 0
}

self_test() {
  local repo tmp rc failures=0
  repo="$(git -C "$SELF_DIR" rev-parse --show-toplevel)"
  tmp="$(mktemp -d)"
  SELFTEST_TMP="$tmp"
  trap 'rm -rf "$SELFTEST_TMP" "$SELFTEST_TMP".*' EXIT

  # A tracked copy of every file that currently hits, plus one production file
  # that must never be exempt.
  local files
  local list_rc=0 key_files
  files="$(git -C "$repo" -c color.grep=never grep -l -I -E "$PATTERN" -- . \
    ':!engineering/doc' ':!doc' ':!product/doc')" || list_rc=$?
  if [[ $list_rc -gt 1 ]]; then
    echo "residue-check self-test: git grep failed (exit ${list_rc})" >&2
    return 1
  fi
  list_rc=0
  key_files="$(git -C "$repo" -c color.grep=never grep -l -I -E "$KEY_PATTERN" -- \
    "${KEY_SCOPE[@]}")" || list_rc=$?
  if [[ $list_rc -gt 1 ]]; then
    echo "residue-check self-test: voice-path key scan failed (exit ${list_rc})" >&2
    return 1
  fi
  files="${files}"$'\n'"${key_files}"
  files="${files}"$'\n'"packages/voice-codex/src/cli.ts"$'\n'"scripts/qa/fly2655-voice-room.mjs"
  local f
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    mkdir -p "$tmp/$(dirname "$f")"
    cp "$repo/$f" "$tmp/$f"
  done <<<"$files"
  git -C "$tmp" init -q
  git -C "$tmp" add -A
  git -C "$tmp" -c user.email=t@t -c user.name=t commit -q -m baseline

  expect() {
    local want="$1" label="$2"
    rc=0
    scan "$tmp" "$SELF_DIR/residue-allowlist.tsv" >"$tmp.out" 2>&1 || rc=$?
    if [[ $rc -eq $want ]]; then
      echo "self-test ok   [$label] exit=$rc"
    else
      echo "self-test FAIL [$label] exit=$rc want=$want"
      sed -n '1,10p' "$tmp.out"
      failures=$((failures + 1))
    fi
    git -C "$tmp" checkout -q -- .
  }

  expect 0 "unchanged copy passes"

  printf '\tconst frontend = new RealtimeFrontend({});\n' \
    >>"$tmp/packages/voice-codex/src/__tests__/config.test.ts"
  expect 1 "engine A call injected into an allowlisted test file"

  printf '\t\t\tconst voice = lead.realtimeVoice ?? "marin";\n' \
    >>"$tmp/packages/teamlead/src/ProjectConfig.ts"
  expect 1 "engine A read injected into the legacy-strip file"

  printf 'const voice = projection.realtimeVoice;\n' \
    >>"$tmp/packages/voice-codex/src/cli.ts"
  expect 1 "engine A read injected into a non-allowlisted file"

  printf '\t\tOPENAI_API_KEY: input.openAiApiKey,\n' \
    >>"$tmp/scripts/qa/fly2655-voice-room.mjs"
  expect 1 "platform key forwarding revived in the QA room launcher"

  grep -v 'delete (lead as Record<string, unknown>).realtimeVoice;' \
    "$tmp/packages/teamlead/src/ProjectConfig.ts" >"$tmp.pc"
  cp "$tmp.pc" "$tmp/packages/teamlead/src/ProjectConfig.ts"
  expect 1 "allowlist row whose line disappeared is stale"

  printf 'packages/voice-codex/src/cli.ts\t^.*$\tnegative-test\twildcard\n' \
    >"$tmp.bad-allowlist"
  rc=0
  scan "$tmp" "$tmp.bad-allowlist" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 2 ]]; then
    echo "self-test ok   [category outside its permitted files is refused] exit=$rc"
  else
    echo "self-test FAIL [category outside its permitted files is refused] exit=$rc want=2"
    failures=$((failures + 1))
  fi

  mkdir -p "$tmp.not-a-repo"
  : >"$tmp.empty-allowlist"
  rc=0
  scan "$tmp.not-a-repo" "$tmp.empty-allowlist" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 2 ]]; then
    echo "self-test ok   [a failed git scan is an error, not zero hits] exit=$rc"
  else
    echo "self-test FAIL [a failed git scan is an error, not zero hits] exit=$rc want=2"
    failures=$((failures + 1))
  fi

  rm -rf "$tmp.out" "$tmp.pc" "$tmp.bad-allowlist" "$tmp.not-a-repo" "$tmp.empty-allowlist"
  if [[ $failures -ne 0 ]]; then
    echo "residue-check self-test: FAIL ($failures)"
    return 1
  fi
  echo "residue-check self-test: OK"
}

ROOT=""
ALLOWLIST="$SELF_DIR/residue-allowlist.tsv"
case "${1:-}" in
  --self-test)
    self_test
    exit $?
    ;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --allowlist) ALLOWLIST="$2"; shift 2 ;;
    *) echo "usage: residue-check.sh [--root <repo>] [--allowlist <tsv>] | --self-test" >&2; exit 2 ;;
  esac
done
[[ -n "$ROOT" ]] || ROOT="$(git -C "$SELF_DIR" rev-parse --show-toplevel)"
scan "$ROOT" "$ALLOWLIST"
