#!/bin/bash
# FLY-1911:v2 还在不在。
# 和 selftest.sh 逐字相同,只有 RT_VERSION 从 v3 换成 v2 —— 一次只动一个变量。
# 只跑不改:不轮转 profile、不碰 auth.json、不 relogin。
set -u
LAB="$HOME/.fly1911"
cd "$LAB"
rm -f v2test-bridge* v2test-asker* 2>/dev/null
: > "$LAB/live.jsonl"

export GUILD_ID=1485787271192907816
export VOICE_CHANNEL_ID=1485787273193853170
export LIVE_LOG="$LAB/live.jsonl"

RT_VERSION=v2 RT_VOICE=marin \
OUT=v2test-bridge RUN_MIN=5 TOKEN_VAR=TEST_BOT_TOKEN_1 \
SW_PACER=1 SW_JITTER=1 SW_DEPTH=1 \
node bridge2.mjs > v2test-bridge.out 2>&1 &
BP=$!
echo "bridge pid $BP"

sleep 32

OUT=v2test-asker TOKEN_VAR=TEST_BOT_TOKEN_2 OGG="$LAB/question.ogg" \
ASK_AFTER_MS=6000 LISTEN_MS=225000 \
node asker2.mjs > v2test-asker.out 2>&1 &
AP=$!
echo "asker pid $AP"
wait $AP
echo "asker done"
# ⚠️ 不能只等「文件出现」—— 桩让 manifest 开跑就存在,那个条件恒真,
# 脚本会在桥还活着的时候就返回(我引入桩之后真的这么翻过一次)。
# 等的必须是**终局写入**:status 不再是 running。
for i in $(seq 1 40); do
  if [ -f v2test-bridge-manifest.json ]; then
    st=$(node -e "try{console.log(require('./v2test-bridge-manifest.json').status||'done')}catch(e){console.log('unreadable')}" 2>/dev/null)
    [ "$st" != "running" ] && break
  fi
  sleep 8
done
echo "v2 selftest finished"
