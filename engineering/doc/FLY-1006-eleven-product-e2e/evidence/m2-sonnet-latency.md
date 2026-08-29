# FLY-1006 M2 提速换档 — 脑模型 haiku→sonnet 真机前后对照

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: m2-staged-venue.md（同 harness 同房同 rig）+ FLY-980 evidence/v4-brain-latency-local.md（换档依据）

## 结论

**说完话→真答案首音（speech-end→first_audio）从 haiku 档的 ~8-10s 降到
sonnet 档的 ~3-4s（典型轮），改动 = 一个 env（`FLY980_MODEL=sonnet`）+ 重启
shim。** Annie 拍板（gate thread「那我们试一下 Sonnet」）；Tadashi 工程拍板
sonnet×fresh、不做 resume/常驻（980 V4 已实测常驻/resume 不提速甚至更慢，
地板是模型 API TTFT）。

## 前后对照（同 harness：`e2e/eleven-voice-loop.mjs` audio 腿，同 529 房、同 agent、同探针 WAV）

| 档位 | speech-end→首音（逐轮 ms） | 中位 | 口径 |
|------|---------------------------|------|------|
| haiku×fresh（implement S8，07-09 14:58，load ~6-7） | 8848 / 7141 / 7739 / 10283 | ~8.3s | m2-staged-venue.md |
| haiku×fresh（QA 复跑，07-09，load ~51） | 9089 / 8173 / 9377 / 10582 | ~9.2s | qa-report.md |
| **sonnet×fresh（本次，07-09 20:42，load ~5.8）** | **3913 / 9540 / 3034 / 3377** | **~3.6s** | 本文件 |

- sonnet 档 4 轮中 3 轮落在 3.0-3.9s；1 轮 9.5s 离群（模型 API TTFT 方差，
  980 V4 的 prespawn 区间 2069-3813 同样呈现长尾）。
- 归因：haiku 4.5 对语音短答每轮先输出 thinking 块（首 thinking 3.1-5.5s）
  才出文本；sonnet 对短答基本不出 thinking 且 TTFT 更好（980 V4 §追加）。
- 诚实预期（已由 Lead 向 Annie 讲明）：claude -p 订阅形态硬地板 ≈ 脑 2-3.5s
  + 平台 STT/TTS ~1s ⇒ **3-4.5s/轮**；进 1-2s 只有付费 API 直连（违背 D10'
  订阅约束）或换平台自带脑（失去 Claude 人格/上下文）。
- 防串味不受影响：fresh（RESUME=0）每轮零共享状态，比任何 warm 形态更彻底；
  conversation_id 分桶（M2 ElevenWs 强制携带）另在 shim 侧兜识别分桶。

## 过程事故（记账）：P6 live venue 抢 voice session → 2 次假 FAIL

前两次 staged 复测 FAIL（探针进不了 STT、`Cannot perform IP discovery -
socket closed`、ears 连接 ready↔signalling 打摆）。根因 = **P6 live venue
（`e2e/p6-live-venue.mjs`，Annie 试听用，17:42 起常驻）与 staged harness 用
同一批 pool bot 抢同一个 Discord voice session**，双方 supervisor 互相把对
方踢下线再自动重连。与 sonnet 换档无关（失败在 custom_llm 一跳之前）。

处置：停 venue → 复测 PASS → 用捕获的原 env（P6_GUILD/VC/HEALTH_PORT/CUE/
VOICE 全同）原样重启 venue，健康检查过（:9885 ok、bots online、ears 进房、
/eleven 注册）。**runbook 规矩：跑 staged harness 前必须先停 P6 venue，跑完
再拉起** —— 同 bot 同房只能有一个客户端。

## 复现

```bash
# 1) 换档重启 shim（同端口同 token，隧道/agent 不动）
kill $(pgrep -f "node shim.mjs")
cd engineering/spike/FLY-980-eleven
FLY980_TOKEN=$(cat ~/fly1006-eleven/.shim-token) FLY980_BRAIN=claude \
  FLY980_RESUME=0 FLY980_MODEL=sonnet node shim.mjs &
curl -s http://127.0.0.1:8980/health   # {"ok":true}；启动行确认 model=sonnet

# 2) 停 P6 venue（否则抢 voice session 假 FAIL）
kill $(pgrep -f "p6-live-venue")

# 3) staged audio 腿（env 同 m2-staged-venue.md §复现命令）
cd packages/voice-bridge && ELEVEN_LOOP_LEGS=audio node e2e/eleven-voice-loop.mjs
# PASS 后从 state 目录 jsonl 取 first_audio.sinceSpeechEndMs

# 4) 原样重启 P6 venue（env 见 m2-sonnet-latency.md 事故段）
```

## 留档

- 本次会话 `conv_3301kx51vd33er1965cr1nnfks80`，jsonl 在 harness state 目录
  （运行输出里打印）；失败两跑日志 `/tmp/fly1006-sonnet-audio-r2.log`。
- credits：见 credits-ledger.md（sonnet-retest 行，+1,739 含 2 次失败跑）。
