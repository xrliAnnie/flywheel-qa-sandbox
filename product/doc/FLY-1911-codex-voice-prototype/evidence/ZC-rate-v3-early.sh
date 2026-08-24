#!/bin/bash
# FLY-1911 —— 她自己设计的那个实验:让合成音在会话建立后【很早】就开口。
#
# 它要判的是她那条假说:v3 是不是「一段时间内没检测到声音就自动断连」。
# 整批 v3 从来没测过这个条件 —— 因为 rate.sh 里那个 sleep 32 把提问推到了约 +36 秒,
# 而死线在约 33-35 秒。⇒ 那批测的是「无人说话时 v3 能活多久」,不是「v3 有多可靠」。
#
# ⚠️ 只动一个数:sleep 32 → sleep 5。ASK_AFTER_MS 保持 6000。
#   ⇒ 提问落在会话建立后约 +8 秒,远在死线之内。
#   一个变量不是洁癖,是保住结论的可读性:同时动两个数,一旦结果是「还是死」,
#   「是不是提问太早太挤」这个问题当场没人能答。
#
# 判据(先写死再跑,不许事后改):
#   全活或大部分活   ⇒ 她的假说成立
#   仍然约 34 秒死   ⇒ 推翻
#   ⚠️ 第三格:如果仍然【有的活有的死】,说明死线的不确定性和音频无关
#      ⇒ 她那条假说即使成立也解释不了全部,那一格喂给「同样没声音为什么有时不触发」那条待查。
set -u
LAB="$HOME/.fly1911"
cd "$LAB"

export GUILD_ID=1485787271192907816
export VOICE_CHANNEL_ID=1485787273193853170
export LIVE_LOG="$LAB/live.jsonl"

for i in $(seq 1 8); do
  TAG=$(printf "early-%02d" "$i")
  rm -f "$TAG"-* 2>/dev/null

  RT_VERSION=v3 RT_VOICE=cove ACK_FILLER=1 \
  OUT="$TAG-bridge" RUN_MIN=4 TOKEN_VAR=TEST_BOT_TOKEN_1 \
  SW_PACER=1 SW_JITTER=1 SW_DEPTH=1 \
  node bridge2.mjs > "$TAG-bridge.out" 2>&1 &

  sleep 5                      # ← 唯一改动的那个数(原来是 32)

  OUT="$TAG-asker" TOKEN_VAR=TEST_BOT_TOKEN_2 OGG="$LAB/question.ogg" \
  ASK_AFTER_MS=6000 LISTEN_MS=165000 \
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
console.log('EARLY $TAG '+JSON.stringify({
  verdict:v, durationMs:m.durationMs, closeReason:m.closeReason,
  heard:hv?m.通不通.听见她:null, spoke:hv?m.通不通.它说了话:null,
  rtStart:m.realtimeStartedAt, ct:m.concurrentTasks&&m.concurrentTasks.count
}));" 2>&1
done
echo "EARLY-DONE"
