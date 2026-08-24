#!/bin/bash
# 一个对照臂 = 一次完全相同的实验,只有开关不同。
# 用法: arm.sh <名字> <SW_PACER> <SW_JITTER> <SW_DEPTH>
set -u
NAME=$1; P=$2; J=$3; D=$4
cd "$(dirname "$0")"
export GUILD_ID=1485787271192907816 VOICE_CHANNEL_ID=1485787273193853170
: > ~/.fly1911/live.jsonl
rm -f ${NAME}-bridge* ${NAME}-asker*
( RT_VERSION=v3 OUT=${NAME}-bridge RUN_MIN=4 TOKEN_VAR=TEST_BOT_TOKEN_1 \
  SW_PACER=$P SW_JITTER=$J SW_DEPTH=$D node bridge2.mjs > ${NAME}-bridge.out 2>&1 ) &
sleep 32
( OUT=${NAME}-asker TOKEN_VAR=TEST_BOT_TOKEN_2 ASK_AFTER_MS=6000 LISTEN_MS=165000 \
  node asker2.mjs > ${NAME}-asker.out 2>&1 ) &
AP=$!
wait $AP
# 等桥自己收尾写 manifest
for i in $(seq 1 15); do [ -f ${NAME}-bridge-manifest.json ] && break; sleep 8; done
echo "[$NAME] 完成 pacer=$P jitter=$J depth=$D"
