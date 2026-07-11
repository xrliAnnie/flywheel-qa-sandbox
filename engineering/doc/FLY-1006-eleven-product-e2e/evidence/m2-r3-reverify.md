# FLY-1006 R3 复验 — 3 条 defect 修复真机复验（QA PASS）

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-11
基于: qa-fix-round3.md（implement 修复,head 11ad1b96）、m2-annie-p6-session.md（QA-FAIL 3 条）

## 结论

**PASS（四条全绿）**。implement 3 条修复（head 11ad1b96,Codex 4 轮 APPROVED）经机器 +
逻辑 + 真机三层复验通过。Annie P6 的三条诉求（延迟雪崩 / 对话不可见 / 缺处理状态）
全部真机坐实修好。

## 机器 + 逻辑层

- build（voice-core / voice-bridge）过;**voice-bridge 246/246**（含 implement 13 条
  新测:EarsReceiver holdoff 6 / ElevenSession idle-barge-in+tiv 6 / wiring tiv 1 /
  shim 2）;voice-core 196/196;spike shim 17/17。
- **独立对抗性测试**（`qa-fly1006-r3-bargein-storm.test.ts`,QA 新增）:真 EarsReceiver
  喂 Annie P6 精确场景（8 段 burst + 段间 400ms 停顿）→ 断言新 holdoff 下
  **≤1 barge-in**（P6 是 8+）、真打断（≥1s 静音后）仍触发、holdoff 内续说不解闩,
  **3/3 绿**。我 round1/2 的 cue 测试仍绿。

## 真机层（分段 WAV 复现真人自然停顿,3 轮,General VC,shim=sonnet,load 6-8）

分段 WAV `probe-segmented-48k.wav`（3 段 speech + 段间 500/600ms 停顿 = 一 utterance,
复现 Annie 说话的呼吸/停顿多 burst）灌入 audio 腿 3 轮。session jsonl
`fly1006-loop-state-BHF59o` + 语音频道文本消息:

### ① barge-in 风暴消失 ✓

- `interruption`（旧毒 suppress 路径）= **2 次,全 `source:platform`**（来自 leg2 注入的
  真打断 —— 真打断照常触发 ✓）;**`source:local` = 0**（自然停顿误打断的旧路径根除）。
- `barge_in_idle`（新 idle 路径,不 suppress）= 3 次 = 3 轮各 ≤1。**P6 单 utterance
  8+ 次 barge-in 的风暴消失**;idle barge-in 不再污染 interruption 计数、不再毒
  suppress 答案。

### ② 逐轮延迟不雪崩 ✓

- `first_audio.sinceSpeechEndMs` = **12069 / 4692 / 3716 ms**（逐轮**下降**）。
- 首轮 12s = 冷启动（shim 刚起 + claude -p 冷）;轮 2/3 落到 3.7-4.7s（sonnet 正常区间）。
- 与 P6 的 **1.5s → 28.5s 单调雪崩完全相反** —— 修复后延迟随轮次收敛,不累积。

### ③ 对话文本落 Discord 可见 ✓

语音频道（1485787273193853170）文本区实测:`🗣` caption（她的话）8 条 + `🤖` caption
（Eleven 回话）3 条。双向对话完整上屏,不再只写文件。样本:
`🗣 帮我看一下,哈豆模式今天能不能用?` → `🤖 这边我这个语音通道没法直接连系统去查状态哦…`

### ④ 等待期「正在处理」文字状态 ✓

`🧠 正在处理…` 4 条 + 完整状态生命周期 `🎙 在听` 11 → `🧠 正在处理…` 4 →
`💬 回话中` 10。每轮干净流程:
`🎙 在听 → 🧠 正在处理… → 🗣 <她的话> → 💬 回话中 → 🤖 <回话> → 🎙 在听`。
Annie 永远能从文本分清「在想 vs 坏了」。🧠 不依赖 cue clip（文字通道独立）。

## 其它

- STT 逐字准、回话连贯、`droppedLateChunks=0`、零 mid-session error（唯一 error =
  会话末 `ElevenWs: websocket error` 收尾 WS 关闭,良性,同 leg0 冒烟）。
- 起 venue 时 load 全程 6-8,没碰 40 止损。

## 复现命令

```bash
# rig 沿用（shim=sonnet + tunnel + agent）
cd packages/voice-bridge
export HUDDLE_ORCH_BOT_TOKEN=$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-06/token)
export HUDDLE_EARS_BOT_TOKEN=$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-04/token)
export INJECTOR_BOT_TOKEN=$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-05/token)
export ELEVENLABS_AGENT_ID=agent_2401kx1say3vf988f28x07bhbwkt
export STAGED_GUILD_ID=1485787271192907816 STAGED_VC_ID=1485787273193853170
export PROBE_WAV=/tmp/fly1006-qa/probe-segmented-48k.wav  # 分段 = 复现真人停顿
export INTERRUPT_WAV=/tmp/fly1006-interrupt-48k.wav STAGED_HEALTH_PORT=9881
# ELEVENLABS_API_KEY 从 ~/.flywheel/.env;剥 FLYWHEEL_BRIDGE_URL/API_TOKEN
ELEVEN_LOOP_LEGS=audio node e2e/eleven-voice-loop.mjs
# 然后 jsonl 数 barge_in_idle(≤1/utterance)+ first_audio(不雪崩);
# 拉语音频道消息看 🗣/🤖/🧠
```
