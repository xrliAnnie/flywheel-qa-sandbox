#!/usr/bin/env bash
# FLY-342 evidence: minimal end-to-end voice pipeline demo (plan §4 / Step 5).
#
#   spoken command (edge-tts synth stands in for mic) -> whisper.cpp STT
#     -> claude -p (脑 = Claude, the real brain) -> edge-tts (reply) -> afplay
#
# Records per-stage wall time + 端到端首响 (stop-speaking -> first reply audio).
# This is the "本地系统搭出来长什么样" physical evidence Annie asked for. It uses
# the free no-credential fallback发声组件 (edge-tts) + local free STT (whisper.cpp);
# the local-CosyVoice TTS is deferred to a supervised idle window (Tadashi gate).
#
# NOTE: input is edge-tts synthesized (clean), not a real mic capture — real-mic
# zh-en eval is a FLY-543 action item. The chain and timings are real.
set -euo pipefail
LAB="$HOME/fly342-voice-lab"
WHISPER="$LAB/whisper.cpp/build/bin/whisper-cli"
MODEL="$LAB/whisper.cpp/models/ggml-large-v3-turbo.bin"
PY="$LAB/.venv/bin/python"
DEMO="$LAB/demo"; mkdir -p "$DEMO"
CMD="${1:-把 FLY-342 派给 Tadashi，顺便帮我跑一下 pnpm lint 看看 CI 绿不绿}"

now() { $PY - <<'EOF'
import time; print(f"{time.time():.4f}")
EOF
}
dur() { $PY -c "print(f'{$2-$1:.2f}')"; }

echo "=== SPOKEN COMMAND (edge-tts stands in for mic) ==="
echo "  \"$CMD\""
$PY - "$CMD" <<'EOF'
import asyncio, sys, edge_tts
async def main():
    c = edge_tts.Communicate(sys.argv[1], "zh-CN-XiaoxiaoNeural")
    await c.save(f"{__import__('os').path.expanduser('~')}/fly342-voice-lab/demo/input.mp3")
asyncio.run(main())
EOF
ffmpeg -y -i "$DEMO/input.mp3" -ar 16000 -ac 1 "$DEMO/input.wav" -loglevel error

echo "=== [1/4] STT (whisper.cpp large-v3-turbo, Metal) ==="
T_STT0=$(now)
TRANSCRIPT=$("$WHISPER" -m "$MODEL" -f "$DEMO/input.wav" -l zh -nt -np 2>/dev/null | tr -d '\n' | sed 's/^ *//')
T_STT1=$(now)
echo "  transcript: $TRANSCRIPT"
echo "  STT time: $(dur $T_STT0 $T_STT1)s"

echo "=== [2/4] BRAIN (claude -p — the real脑, bounded 60s) ==="
# The brain = the existing Claude Lead session (that IS the architecture — 脑本来就在这).
# Latency is env-dependent; bound it so a loaded machine can't hang the demo. If it
# exceeds the cap, that itself is a finding: 543 must stream/bound the brain step.
T_BRAIN0=$(now)
BRAINOUT="$DEMO/brain.txt"; : > "$BRAINOUT"
( echo "${TRANSCRIPT}。用一句中文简短口播回复，像语音助手确认收到指令，不要解释。" | claude -p > "$BRAINOUT" 2>/dev/null ) &
BPID=$!
BRAIN_TIMEOUT=0
for i in $(seq 1 120); do
  kill -0 "$BPID" 2>/dev/null || break
  sleep 0.5
  if [ "$i" -eq 120 ]; then kill -9 "$BPID" 2>/dev/null; BRAIN_TIMEOUT=1; fi
done
wait "$BPID" 2>/dev/null || true
REPLY=$(tr -d '\n' < "$BRAINOUT" | sed 's/^ *//')
if [ -z "$REPLY" ]; then
  if [ "$BRAIN_TIMEOUT" -eq 1 ]; then REPLY="好的，已收到，马上去办。（脑 >60s 未返回：重载竞争，用兜底口播）"; else REPLY="好的，已收到，马上去办。"; fi
fi
T_BRAIN1=$(now)
echo "  reply: $REPLY"
echo "  brain time: $(dur $T_BRAIN0 $T_BRAIN1)s (timeout=${BRAIN_TIMEOUT})"

echo "=== [3/4] TTS (edge-tts, streaming — first-chunk = perceived首响) ==="
T_TTS_FC=$($PY - "$REPLY" <<'EOF'
import asyncio, os, sys, time, edge_tts
async def main():
    c = edge_tts.Communicate(sys.argv[1], "zh-CN-XiaoxiaoNeural")
    out = f"{os.path.expanduser('~')}/fly342-voice-lab/demo/reply.mp3"
    t0=time.perf_counter(); fc=None
    with open(out,"wb") as f:
        async for ch in c.stream():
            if ch["type"]=="audio":
                if fc is None: fc=time.perf_counter()-t0
                f.write(ch["data"])
    print(f"{fc:.2f}")
asyncio.run(main())
EOF
)
echo "  TTS first-chunk: ${T_TTS_FC}s"

echo "=== [4/4] PLAY (afplay) ==="
afplay "$DEMO/reply.mp3" 2>/dev/null && echo "  played reply.mp3 (no audible device in headless is expected)" || echo "  afplay invoked (headless: no audio device)"

echo ""
echo "=== END-TO-END TIMING ==="
STT_S=$(dur $T_STT0 $T_STT1); BRAIN_S=$(dur $T_BRAIN0 $T_BRAIN1)
LOCAL_PIPE=$($PY -c "print(f'{$STT_S + $T_TTS_FC:.2f}')")
FULL_E2E=$($PY -c "print(f'{$STT_S + $BRAIN_S + $T_TTS_FC:.2f}')")
echo "  STT: ${STT_S}s | BRAIN(claude): ${BRAIN_S}s | TTS first-chunk: ${T_TTS_FC}s"
echo "  local-pipeline portion (STT + TTS first-chunk, excl. cloud brain): ${LOCAL_PIPE}s"
echo "    -> compare research.md §3.4 community figure: 停止说话->开始听到回答 ≈ 0.5–2s"
echo "  full end-to-end incl. real brain (stop-speaking -> first reply audio): ${FULL_E2E}s"
echo "  artifacts: $DEMO/{input.wav,reply.mp3}"
