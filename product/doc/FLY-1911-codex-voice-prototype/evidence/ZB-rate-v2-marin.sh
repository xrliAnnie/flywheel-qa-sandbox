#!/bin/bash
# FLY-1911 v2 重跑 —— 八场,音色 marin。
#
# 为什么重跑:上一批 v2 全废,因为传了 RT_VOICE=cove(v1 音色,不在 v2 表里)
# ⇒ v2 会话从未建立,八场 manifest 却都写着 outcome: alive(已隔离,见 Z5)。
#
# 这一批的重要性和上一批不同:她在考虑「先上 v3,不行再退回 v2」。
# ⇒ 那条退路成不成立,完全取决于这批数据。如果 v2 也是 25%,退路根本不存在。
# ⇒ 所以这不是补数据,是在验一条她准备依赖的退路。
#
# 命名:v2m-NN(不沿用上一批 rate-v2-* 那代命名 —— 那批已被整体标废,
# 复用会让作废说明和新数据混在同一个前缀下)。
set -u
LAB="$HOME/.fly1911"
cd "$LAB"

export GUILD_ID=1485787271192907816
export VOICE_CHANNEL_ID=1485787273193853170
export LIVE_LOG="$LAB/live.jsonl"

for i in $(seq 1 8); do
  TAG=$(printf "v2m-%02d" "$i")
  rm -f "$TAG"-* 2>/dev/null

  RT_VERSION=v2 RT_VOICE=marin \
  OUT="$TAG-bridge" RUN_MIN=4 TOKEN_VAR=TEST_BOT_TOKEN_1 \
  SW_PACER=1 SW_JITTER=1 SW_DEPTH=1 \
  node bridge2.mjs > "$TAG-bridge.out" 2>&1 &

  sleep 32

  OUT="$TAG-asker" TOKEN_VAR=TEST_BOT_TOKEN_2 OGG="$LAB/question.ogg" \
  ASK_AFTER_MS=6000 LISTEN_MS=195000 \
  node asker2.mjs > "$TAG-asker.out" 2>&1 &
  AP=$!
  wait $AP

  # 等终局写入(不是等文件出现 —— 桩让 manifest 开跑就存在)
  for k in $(seq 1 40); do
    if [ -f "$TAG-bridge-manifest.json" ]; then
      st=$(node -e "try{console.log(require('./$TAG-bridge-manifest.json').status||'done')}catch(e){console.log('unreadable')}" 2>/dev/null)
      [ "$st" != "running" ] && break
    fi
    sleep 8
  done

  node -e "
const m=require('./$TAG-bridge-manifest.json');
const started=!!m.realtimeStartedAt, closed=!!m.realtimeClosedAt;
const v=!started?'never_started':(!closed?'alive':(m.closeReason==='requested'?'alive':'died'));
const hv=m.通不通&&typeof m.通不通==='object';
console.log('V2M $TAG '+JSON.stringify({
  verdict:v, durationMs:m.durationMs, closeReason:m.closeReason,
  heard:hv?m.通不通.听见她:null, spoke:hv?m.通不通.它说了话:null,
  voice:'marin', rtStart:m.realtimeStartedAt,
  ct:m.concurrentTasks&&m.concurrentTasks.count, egress:m.network&&m.network.egressIp
}));" 2>&1
done
echo "V2M-DONE"
