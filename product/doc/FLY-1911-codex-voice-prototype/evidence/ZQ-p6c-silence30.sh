#!/bin/bash
# P-6c:v2 + Discord 长静默 30 分钟。判据跑前已写死(见 decisions.md)。
# ⛔ 房里不需要人,不叫 Annie。只有静默时长这一个变量,其余照旧。
set -u
LAB="$HOME/.fly1911"; cd "$LAB"
rm -f p6c-bridge* p6c-asker* 2>/dev/null
: > "$LAB/live.jsonl"
export GUILD_ID=1485787271192907816
export VOICE_CHANNEL_ID=1485787273193853170
export TEXT_CHANNEL_ID=1485787273193853170
export LIVE_LOG="$LAB/live.jsonl"

RT_VERSION=v2 RT_VOICE=marin \
OUT=p6c-bridge RUN_MIN=40 TOKEN_VAR=TEST_BOT_TOKEN_1 \
SW_PACER=1 SW_JITTER=1 SW_DEPTH=1 \
node bridge2.mjs > p6c-bridge.out 2>&1 &
BP=$!; echo "bridge pid $BP"

# ⚠️ 静默期间什么都不做 —— 不探活、不发心跳。探活本身会变成流量,那就不是静默了。
# 从【会话锚】起算 30 分钟:先等 realtime started 出现,再从那一刻数。
until grep -q 'realtime started' p6c-bridge.out 2>/dev/null; do sleep 2; done
ANCHOR=$(date +%s)
echo "会话锚 $(date -u +%H:%M:%S) ⇒ 静默 30 分钟"
sleep 1800

# 30 分钟到了,才把提问的 bot 放进去问一句。它一进房就录音。
OUT=p6c-asker TOKEN_VAR=TEST_BOT_TOKEN_2 OGG="$LAB/question.ogg" \
ASK_AFTER_MS=8000 LISTEN_MS=120000 \
node asker2.mjs > p6c-asker.out 2>&1 &
AP=$!; echo "asker pid $AP  (静默已满 $(( $(date +%s) - ANCHOR )) 秒)"
wait $AP; echo "asker done"
for i in $(seq 1 40); do
  if [ -f p6c-bridge-manifest.json ]; then
    st=$(node -e "try{console.log(require('./p6c-bridge-manifest.json').status||'done')}catch(e){console.log('unreadable')}" 2>/dev/null)
    [ "$st" != "running" ] && break
  fi
  sleep 8
done
echo "p6c finished"
