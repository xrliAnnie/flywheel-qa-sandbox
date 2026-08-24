#!/bin/bash
# FLY-1911:状态显示的真机验证。v2(她选的那个)+ 状态显示发进【语音频道自带的文字聊天】。
# 和 selftest-v2.sh 的唯一差别 = 多了 TEXT_CHANNEL_ID。⛔ 不改 selftest-v2.sh,那份冻着。
set -u
LAB="$HOME/.fly1911"; cd "$LAB"
rm -f tiv2-bridge* tiv2-asker* 2>/dev/null
: > "$LAB/live.jsonl"

export GUILD_ID=1485787271192907816
export VOICE_CHANNEL_ID=1485787273193853170
export TEXT_CHANNEL_ID=1485787273193853170   # ← 她定的:就发在语音房自带的聊天里
export LIVE_LOG="$LAB/live.jsonl"

RT_VERSION=v2 RT_VOICE=marin \
OUT=tiv2-bridge RUN_MIN=5 TOKEN_VAR=TEST_BOT_TOKEN_1 \
SW_PACER=1 SW_JITTER=1 SW_DEPTH=1 \
node bridge2.mjs > tiv2-bridge.out 2>&1 &
echo "bridge pid $!"
sleep 32
OUT=tiv2-asker TOKEN_VAR=TEST_BOT_TOKEN_2 OGG="$LAB/question.ogg" \
ASK_AFTER_MS=6000 LISTEN_MS=150000 \
node asker2.mjs > tiv2-asker.out 2>&1 &
AP=$!; echo "asker pid $AP"
# ⚠️ 注入器必须在 AP=$! 之后再起 —— 否则 $! 抓到的是注入器,wait 等错了进程。
WATCH_LOG="$LAB/tiv2-bridge.out" node kill-status-msg.mjs > tiv2-kill.out 2>&1 &
wait $AP; echo "asker done"
for i in $(seq 1 40); do
  if [ -f tiv2-bridge-manifest.json ]; then
    st=$(node -e "try{console.log(require('./tiv2-bridge-manifest.json').status||'done')}catch(e){console.log('unreadable')}" 2>/dev/null)
    [ "$st" != "running" ] && break
  fi
  sleep 8
done
echo "realrun finished"
