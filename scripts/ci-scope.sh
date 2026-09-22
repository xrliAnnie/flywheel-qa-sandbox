#!/usr/bin/env bash
# FLY-2681: choose the heavy CI tier from immutable event and git evidence.
set -uo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

tested_tree="$(git rev-parse 'HEAD^{tree}' 2>/dev/null)" || tested_tree=""
heavy=run
mode=full
reuse_run=""

if [[ "${NO_CODE:-}" == "true" ]]; then
  heavy=skip
  mode=docs_only
elif [[ "${CI_SCOPED_MODE:-}" != "on" ]]; then
  : # The rollout switch is fail-closed: retain the full matrix.
elif [[ "${EVENT_NAME:-}" == "push" ]]; then
  if [[ "${REUSE:-}" == "true" && "${REUSE_RUN:-}" =~ ^[0-9]+$ ]]; then
    heavy=skip
    mode=reuse
    reuse_run="$REUSE_RUN"
  fi
elif [[ "${EVENT_NAME:-}" == "pull_request" &&
  "${EVENT_ACTION:-}" == "labeled" && "${LABEL_NAME:-}" == "ci:full" ]]; then
  :
elif [[ "${EVENT_NAME:-}" == "pull_request" &&
  "${HEAD_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  parents="$(git rev-list --parents -n 1 "$HEAD_SHA" 2>/dev/null)" || parents=""
  read -r -a parent_fields <<<"$parents"
  if [[ "${#parent_fields[@]}" -ge 3 ]]; then
    : # Merge heads always receive the full matrix.
  elif [[ "${#parent_fields[@]}" -eq 2 ]]; then
    case "${EVENT_ACTION:-}" in
      opened | synchronize | reopened | labeled)
        heavy=skip
        mode=scoped
        ;;
    esac
  fi
fi

printf 'heavy=%s\n' "$heavy" >>"$GITHUB_OUTPUT"
printf 'mode=%s\n' "$mode" >>"$GITHUB_OUTPUT"
printf 'tested_tree=%s\n' "$tested_tree" >>"$GITHUB_OUTPUT"
printf 'reuse_run=%s\n' "$reuse_run" >>"$GITHUB_OUTPUT"
