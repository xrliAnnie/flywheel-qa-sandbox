#!/bin/bash
# 实验 A 给她的那一场:房里那个是 Honey Lemon 的分身(身份 + 记忆索引 + 数据地图,read-only)。
# ⛔ 别自己起 —— 等 Lead 说她要测了再跑。开跑后先自己问一次,把「链路 + 等待音 + 状态行」当场验掉。
# 开跑后先自己问一次,把「放的确实是 B」真验出来 —— 不是看配置写着 B。
set -u
LAB="$HOME/.fly1911"; cd "$LAB"
rm -f bf1-* 2>/dev/null
: > "$LAB/live.jsonl"
export GUILD_ID=1485787271192907816 VOICE_CHANNEL_ID=1485787273193853170
export TEXT_CHANNEL_ID=1485787273193853170 LIVE_LOG="$LAB/live.jsonl"
export RT_START_INSTR="你是 Honey Lemon 本人,正在语音里跟 Annie 说话。始终用中文,回答简短、口语化。不确定的事不要编,查不到就直说查不到。"
HL=1 BED=1 RT_VERSION=v2 RT_VOICE=marin OUT=bf1-bridge RUN_MIN=9 TOKEN_VAR=TEST_BOT_TOKEN_1 \
  SW_PACER=1 SW_JITTER=1 SW_DEPTH=1 node bridge-hl.mjs > bf1-bridge.out 2>&1 &
echo "bridge pid $!"
sleep 25
OUT=bf1-probe TOKEN_VAR=TEST_BOT_TOKEN_2 OGG="$LAB/hl-q5.ogg" ASK_AFTER_MS=6000 LISTEN_MS=150000 \
  node asker2.mjs > bf1-probe.out 2>&1
echo "自验那一问跑完 —— 桥继续开着等她(到 RUN_MIN 为止)"

# 第五项:中继活着(它现在是通道的一半)—— ⛔ 做成脚本的一步,别做成「记得去看一眼」
BEAT="$LAB/outbox/.relay-alive"
if [ -f "$BEAT" ]; then
  AGE=$(( $(date +%s) - $(stat -f %m "$BEAT") ))
  if [ "$AGE" -le 20 ]; then echo "第五项 中继:心跳 ${AGE}s 前更新过 ⇒ 活着 ✅"
  else echo "第五项 中继:⛔ 心跳 ${AGE}s 没更新 —— 通道断了一半,别叫她进来"; fi
else
  echo "第五项 中继:⛔ 没有心跳文件 —— 中继没起,通道断了一半,别叫她进来"
fi
