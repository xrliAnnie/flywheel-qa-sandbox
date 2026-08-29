#!/bin/bash
# FLY-968 参考音频生成 — edge-tts 合成 ref/utterances.md 的话术,转 16k(Gemini)/24k(OpenAI) mono PCM。
# 幂等:重跑覆盖。音频产物 gitignored。
set -euo pipefail
cd "$(dirname "$0")"
VOICE="zh-CN-XiaoxiaoNeural"

gen() {
	local id="$1" text="$2"
	echo "$text" >"ref/${id}.txt.tmp"
	edge-tts --voice "$VOICE" --text "$text" --write-media "ref/${id}.mp3"
	ffmpeg -y -loglevel error -i "ref/${id}.mp3" -f s16le -ar 16000 -ac 1 "ref/${id}-16k.pcm"
	ffmpeg -y -loglevel error -i "ref/${id}.mp3" -f s16le -ar 24000 -ac 1 "ref/${id}-24k.pcm"
	rm -f "ref/${id}.txt.tmp"
	echo "ok ${id}"
}

gen u1 "帮我看一下，Huddle 模式今天能不能用？"
gen u2 "帮我 check 一下 FLY-968 的 status，顺便看看 PR 有没有 approve。"
gen u3a "Tadashi，帮我总结一下今天的部署进展。"
gen u3b "Honey Lemon，产品这边有什么新的想法？"
gen u3c "Hiro，Joy-Con 项目下一步做什么？"
gen u4a "Tadashi，这次部署的内部代号是什么？"
gen u4b "Honey Lemon，Tadashi 刚才说的部署代号是什么？"
gen u4c "Hiro，Tadashi 刚才说的部署代号是什么？"
gen u5 "Tadashi，我刚才说发布时间定在什么时候？"
