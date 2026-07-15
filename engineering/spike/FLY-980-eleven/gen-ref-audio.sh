#!/bin/bash
# FLY-980 参考音频 — u1/u2 逐字沿用 FLY-968(跨 issue 可比),新增英文 u3en +
# 慢脑长问题 u4slow + issue 状态问句 u5status。edge-tts 合成→16k s16le PCM。
# 幂等重跑覆盖;音频产物 gitignored。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ref
VOICE_ZH="zh-CN-XiaoxiaoNeural"
VOICE_EN="en-US-JennyNeural"

gen() {
	local id="$1" voice="$2" text="$3"
	edge-tts --voice "$voice" --text "$text" --write-media "ref/${id}.mp3"
	ffmpeg -y -loglevel error -i "ref/${id}.mp3" -f s16le -ar 16000 -ac 1 "ref/${id}-16k.pcm"
	echo "ok ${id}"
}

# FLY-968 同款(可比口径)
gen u1 "$VOICE_ZH" "帮我看一下，Huddle 模式今天能不能用？"
gen u2 "$VOICE_ZH" "帮我 check 一下 FLY-968 的 status，顺便看看 PR 有没有 approve。"
# 英文语料(D11')
gen u3en "$VOICE_EN" "Can you give me a quick summary of what the team shipped this week?"
# 慢脑触发(V5b): 需要真思考的长问题
gen u4slow "$VOICE_ZH" "帮我想一下，如果要把语音会议做成产品，最大的三个技术风险是什么？"
# V7b 注入演示: 问 issue 状态
gen u5status "$VOICE_ZH" "FLY-980 现在是什么状态？"
# V8 override 验证: 自我介绍问句
gen u6who "$VOICE_ZH" "你是谁？一句话自我介绍一下。"
