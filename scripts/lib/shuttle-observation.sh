#!/usr/bin/env bash
# FLY-2669: Bash 3.2-compatible adapter for the durable shuttle observer.

SHUTTLE_OBSERVATION_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

shuttle_observation_state_root() {
  if [[ -n "${SHUTTLE_OBSERVATION_STATE_ROOT:-}" ]]; then
    printf '%s\n' "$SHUTTLE_OBSERVATION_STATE_ROOT"
  else
    printf '%s/state/shuttle\n' "${FLYWHEEL_HOME:-$HOME/.flywheel}"
  fi
}

_shuttle_observation_helper() {
  if [[ -n "${SHUTTLE_OBSERVER_BUNDLE_DIR:-}" ]]; then
    case "$SHUTTLE_OBSERVER_BUNDLE_DIR" in
      "$(shuttle_observation_state_root)"/bundles/*)
        [[ -f "$SHUTTLE_OBSERVER_BUNDLE_DIR/shuttle-observation.py" \
          && ! -L "$SHUTTLE_OBSERVER_BUNDLE_DIR/shuttle-observation.py" ]] || return 1
        printf '%s\n' "$SHUTTLE_OBSERVER_BUNDLE_DIR/shuttle-observation.py"
        return 0
        ;;
      *) return 1 ;;
    esac
  fi
  printf '%s\n' "$SHUTTLE_OBSERVATION_LIB_DIR/shuttle-observation.py"
}

_shuttle_observation_catalog() {
  if [[ -n "${SHUTTLE_OBSERVER_BUNDLE_DIR:-}" ]]; then
    printf '%s\n' "$SHUTTLE_OBSERVER_BUNDLE_DIR/shuttle-reasons.json"
  else
    printf '%s\n' "$SHUTTLE_OBSERVATION_LIB_DIR/shuttle-reasons.json"
  fi
}

_shuttle_observation_run() {
  local helper="" catalog="" state_root=""
  helper="$(_shuttle_observation_helper)" || return 2
  catalog="$(_shuttle_observation_catalog)"
  state_root="$(shuttle_observation_state_root)"
  python3 "$helper" --state-root "$state_root" --catalog "$catalog" "$@"
}

shuttle_observation_build_inventory() { # $1=projects.json $2=output path $3=optional candidate tsv
  local projects_file="$1" output="$2" candidates_file="${3:-/dev/null}" temporary=""
  [[ -f "$projects_file" && ! -L "$projects_file" ]] || return 2
  [[ -f "$candidates_file" && ! -L "$candidates_file" ]] || candidates_file=/dev/null
  temporary="${output}.tmp.$$"
  jq -e --rawfile candidates "$candidates_file" '
    if type != "array" then error("projects.json must be an array") else . end |
    ([{
      projectName: "flywheel", unitKind: "core_repo", ownerKey: "flywheel",
      displayName: "Flywheel core"
    }, {
      projectName: "raya", unitKind: "external_repo", ownerKey: "raya-repo",
      displayName: "Raya"
    }, {
      projectName: "flywheel", unitKind: "inventory", ownerKey: "deployment-inventory",
      displayName: "Deployment inventory"
    }] + [
      .[] as $project |
      ($project | select(.projectName != "raya") | {
        projectName: $project.projectName,
        unitKind: "project_repo",
        ownerKey: $project.projectName,
        displayName: ($project.projectName + " Lead config")
      }),
      ($project.leads[]? | {
        projectName: $project.projectName,
        unitKind: "lead",
        ownerKey: ($project.projectName + ":" + .agentId),
        displayName: ($project.projectName + "/" + .agentId)
      })
    ] + [
      $candidates | split("\n")[] | select(length > 0) | split("\t") |
      select(length >= 3 and .[1] != "-" and .[2] != "-") |
      {
        projectName: .[1], unitKind: "lead", ownerKey: (.[1] + ":" + .[2]),
        displayName: (.[1] + "/" + .[2])
      }
    ]) | unique_by([.projectName,.unitKind,.ownerKey])
  ' "$projects_file" >"$temporary" || { rm -f -- "$temporary"; return 2; }
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$output"
}

shuttle_observation_begin() { # $1=wake kind $2=inventory path $3=receipt path
  local wake_kind="$1" inventory="$2" receipt="$3" digest="" state_root=""
  _shuttle_observation_run begin --wake-kind "$wake_kind" --inventory "$inventory" \
    --owner-pid "$$" --owner-start "${SHUTTLE_OBSERVATION_OWNER_START:-pid-$$}" >"$receipt" \
    || return $?
  SHUTTLE_OBSERVATION_CYCLE_ID="$(jq -er .cycleId "$receipt")" || return 2
  digest="$(jq -er .observerBundleDigest "$receipt")" || return 2
  state_root="$(shuttle_observation_state_root)"
  SHUTTLE_OBSERVER_BUNDLE_DIR="$state_root/bundles/$digest"
  [[ -d "$SHUTTLE_OBSERVER_BUNDLE_DIR" && ! -L "$SHUTTLE_OBSERVER_BUNDLE_DIR" ]] || return 2
  export SHUTTLE_OBSERVATION_CYCLE_ID SHUTTLE_OBSERVER_BUNDLE_DIR
}

shuttle_observation_write_result() { # $1=cycle $2=result json
  _shuttle_observation_run record --cycle-id "$1" --result "$2"
}

shuttle_observation_record_values() { # cycle project kind owner display outcome reason evidence log deployed target behind drift receipt
  local cycle="$1" project="$2" kind="$3" owner="$4" display="$5"
  local outcome="$6" reason="$7" evidence="$8" log_ref="$9"
  shift 9
  local deployed="$1" target="$2" behind="$3" drift="$4" receipt="$5"
  local state_root="" temporary="" deployed_json=null target_json=null behind_json=null rc=0
  state_root="$(shuttle_observation_state_root)"
  mkdir -p "$state_root/runtime" || return 2
  chmod 700 "$state_root/runtime" || return 2
  temporary="$(mktemp "$state_root/runtime/result.XXXXXX")" || return 2
  if [[ -n "$deployed" ]]; then deployed_json="\"$deployed\""; fi
  if [[ -n "$target" ]]; then target_json="\"$target\""; fi
  if [[ -n "$behind" ]]; then behind_json="$behind"; fi
  jq -n \
    --arg projectName "$project" --arg unitKind "$kind" --arg ownerKey "$owner" \
    --arg displayName "$display" --arg outcome "$outcome" --arg reason "$reason" \
    --arg evidenceRef "$evidence" --arg logRef "$log_ref" \
    --argjson deployedSha "$deployed_json" --argjson targetSha "$target_json" \
    --argjson behindCommits "$behind_json" --arg driftBasis "$drift" \
    '{projectName:$projectName,unitKind:$unitKind,ownerKey:$ownerKey,displayName:$displayName,
      outcome:$outcome,reason:$reason,evidenceRef:$evidenceRef,logRef:$logRef,
      deployedSha:$deployedSha,targetSha:$targetSha,behindCommits:$behindCommits,
      driftBasis:$driftBasis}' >"$temporary" || { rm -f -- "$temporary"; return 2; }
  chmod 600 "$temporary"
  shuttle_observation_write_result "$cycle" "$temporary" >"$receipt" || rc=$?
  rm -f -- "$temporary"
  return "$rc"
}

shuttle_observation_fill() { # $1=cycle $2=reason $3...=unit kinds
  local cycle="$1" reason="$2"
  shift 2
  local args=() kind=""
  for kind in "$@"; do args+=(--unit-kind "$kind"); done
  _shuttle_observation_run fill --cycle-id "$cycle" --reason "$reason" \
    ${args[@]+"${args[@]}"}
}

shuttle_observation_finish() { # $1=cycle $2=legacy result
  _shuttle_observation_run finish --cycle-id "$1" --legacy-result "$2"
}

shuttle_observation_prepare_dispatch() { # $1=cycle $2...=copy projects
  local cycle="$1"
  shift
  local args=() project=""
  for project in "$@"; do args+=(--copy-project "$project"); done
  _shuttle_observation_run prepare-dispatch --cycle-id "$cycle" \
    ${args[@]+"${args[@]}"}
}

shuttle_observation_intent() { # $1=batch intent id
  _shuttle_observation_run intent --intent-id "$1"
}

shuttle_observation_delivery() { # batch state message channel binding
  local intent="$1" state="$2" message="$3" channel="$4" binding="$5"
  local args=(delivery --intent-id "$intent" --state "$state")
  [[ -z "$message" ]] || args+=(--message-id "$message")
  [[ -z "$channel" ]] || args+=(--channel-id "$channel")
  [[ -z "$binding" ]] || args+=(--binding-digest "$binding")
  _shuttle_observation_run "${args[@]}"
}

shuttle_observation_export() { # $1=cursor $2=limit
  _shuttle_observation_run export --after-change-seq "$1" --limit "$2"
}
