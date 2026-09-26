#!/usr/bin/env bash

# FLY-2874: side-effect-free validation for the configured 529-room slot pool.
# This file is sourced by deploy, teardown, and focused QA drivers.

qa_slot_pool_count() {
  local slots_file="${1:?slots file required}"

  jq -er '
    .slots as $slots
    | ($slots | type == "array" and length > 0)
      and ([range(0; ($slots | length)) as $index
        | ($slots[$index] | type == "object")
          and ($slots[$index].id == ($index + 1))
      ] | all)
    | if . then ($slots | length) else error("invalid slot sequence") end
  ' "$slots_file"
}

qa_slot_pool_size() {
  local slots_file="${1:?slots file required}"

  jq -er '
    .slots as $slots
    | ($slots | type == "array" and length > 0)
      and ([range(0; ($slots | length)) as $index
        | ($slots[$index] | type == "object")
          and ($slots[$index].id == ($index + 1))
          and ($slots[$index].bridgePort | type == "number" and . == floor)
          and ($slots[$index].channelId | type == "string" and length > 0)
          and ($slots[$index].botAppId | type == "string" and length > 0)
          and ($slots[$index].tokenEnvVar | type == "string" and length > 0)
      ] | all)
      and ([$slots[].bridgePort] | length == (unique | length))
      and ([$slots[].channelId] | length == (unique | length))
      and ([$slots[].botAppId] | length == (unique | length))
      and ([$slots[].tokenEnvVar] | length == (unique | length))
      and (
        ([
          $slots[]
          | ((.voiceChannelId // "") != "")
            or ((.voiceChannelName // "") != "")
        ] | any) as $hasVoiceMap
        | ($hasVoiceMap | not)
          or (
            ([
              $slots[]
              | (.voiceChannelId | type == "string" and test("^[0-9]{17,20}$"))
                and (.voiceChannelName == ("voice-test-" + (.id | tostring)))
            ] | all)
            and ([$slots[].voiceChannelId] | length == (unique | length))
            and ([$slots[].voiceChannelName] | length == (unique | length))
          )
      )
    | if . then ($slots | length) else error("invalid slot pool") end
  ' "$slots_file"
}

qa_slot_pool_require_member() {
  local slots_file="${1:?slots file required}"
  local slot="${2:?slot required}"
  local total

  [[ "$slot" =~ ^[1-9][0-9]*$ ]] || return 1
  total="$(qa_slot_pool_size "$slots_file")" || return 1
  (( 10#$slot <= 10#$total ))
}
