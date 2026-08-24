#!/bin/bash
# FLY-1911 自测:bot 扮 Annie 问一句,验 v3 桥这条链是通的,再让她进房。
# 不改任何原型代码,参数照 T3c 那个全开臂。
set -u
LAB="$HOME/.fly1911"
cd "$LAB"
rm -f selftest-bridge* selftest-asker* 2>/dev/null
: > "$LAB/live.jsonl"

export GUILD_ID=1485787271192907816
export VOICE_CHANNEL_ID=1485787273193853170
export LIVE_LOG="$LAB/live.jsonl"

RT_VERSION=v3 RT_VOICE=cove ACK_FILLER=1 \
OUT=selftest-bridge RUN_MIN=4 TOKEN_VAR=TEST_BOT_TOKEN_1 \
SW_PACER=1 SW_JITTER=1 SW_DEPTH=1 \
node bridge2.mjs > selftest-bridge.out 2>&1 &
BP=$!
echo "bridge pid $BP"

sleep 32

OUT=selftest-asker TOKEN_VAR=TEST_BOT_TOKEN_2 OGG="$LAB/question.ogg" \
ASK_AFTER_MS=6000 LISTEN_MS=165000 \
node asker2.mjs > selftest-asker.out 2>&1 &
AP=$!
echo "asker pid $AP"
wait $AP
echo "asker done"
# ⚠️ 不能只等「文件出现」—— 桩让 manifest 开跑就存在,那个条件恒真,
# 脚本会在桥还活着的时候就返回(我引入桩之后真的这么翻过一次)。
# 等的必须是**终局写入**:status 不再是 running。
for i in $(seq 1 40); do
  if [ -f selftest-bridge-manifest.json ]; then
    st=$(node -e "try{console.log(require('./selftest-bridge-manifest.json').status||'done')}catch(e){console.log('unreadable')}" 2>/dev/null)
    [ "$st" != "running" ] && break
  fi
  sleep 8
done
echo "selftest finished"
