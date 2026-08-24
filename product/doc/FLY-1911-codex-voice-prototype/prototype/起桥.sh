#!/bin/bash
# FLY-1911:把 Codex 接进 Discord 语音房。跑这一条就够了。
#
# 跑起来之后,直接进 Discord 的 General 语音房跟它说话。
# 想看它在干嘛:cmux 里那扇叫「🎙 FLY-1911 语音实况」的窗。
set -eu
LAB="${FLY1911_LAB:-$HOME/.fly1911}"
export GUILD_ID=1485787271192907816          # Flywheel 测试服
export VOICE_CHANNEL_ID=1485787273193853170  # General(唯一的语音房)
export TOKEN_VAR=TEST_BOT_TOKEN_1
export RT_VERSION="${RT_VERSION:-v3}"        # v3 = 音频驱动、会先应一声;v2 = 回合制
export RT_VOICE="${RT_VOICE:-cove}"
export ACK_FILLER="${ACK_FILLER:-1}"         # 先应一声
export RUN_MIN="${RUN_MIN:-30}"              # 跑多久(分钟)
export OUT="${OUT:-$LAB/session-$(date +%H%M%S)}"
export LIVE_LOG="$LAB/live.jsonl"

# 开跑前把实况日志清空,这样那扇窗从头显示这一场
: > "$LIVE_LOG"

echo "通道 $RT_VERSION · 音色 $RT_VOICE · 先应一声 $ACK_FILLER · 跑 $RUN_MIN 分钟"
echo "实况窗:cmux 里的「🎙 FLY-1911 语音实况」"
echo "归档  :$OUT.jsonl / $OUT-manifest.json"
echo
exec node "$LAB/bridge2.mjs"
