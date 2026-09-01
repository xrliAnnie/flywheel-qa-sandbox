#!/bin/bash
SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SP/results.tsv"
: > "$OUT"
printf 'label\tts\ttotal_input_tokens\tdeferred\tconnected\tts_result\trc\n' >> "$OUT"
for arm in base gbrain flywheel-terminal flywheel-inbox linear-api xiaohongshu-mcp context7 playwright lead-all; do
  for ts in on off; do
    "$SP/measure.sh" "$arm" "$(cat "$SP/cfg/$arm.json")" "$ts" >> "$OUT" 2>>"$SP/matrix-err.log"
  done
done
echo DONE >> "$OUT"
