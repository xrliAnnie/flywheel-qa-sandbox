# FLY-1006 M1 rig 重建 + 操作者自测（P1/P2）— 取证

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-08
基于: plan.md §S1/§S2

## P1 — rig 重建可用 ✅

980 生产配方逐项重建，全部 GET 回读核对（不信 PATCH 返回，只信 readback）：

| 项 | 值（readback 实况） |
|----|---------------------|
| agent_id | `agent_2401kx1say3vf988f28x07bhbwkt`（name=fly1006-eleven-m1） |
| 鉴权 | workspace secret `qK8otfwoPKjCXrTPic2h`（token 走 env→secret，绝不进 argv/repo） |
| custom_llm | `<tunnel>/v1`，model_id=flywheel-claude-brain，api_type=chat_completions |
| cascade_timeout_seconds | 15 |
| soft_timeout_config | 3s；「稍等哈，我想一下。」/「嗯……让我理一理。」；randomize；max 2 |
| turn | turn_v3，turn_timeout 7 |
| tts | eleven_flash_v2_5，**agent_output_audio_format=pcm_24000** |
| override 安全位 | tts.voice_id / agent.prompt.prompt / language / first_message 全 true |
| 脑 | shim claude 档（FLY980_RESUME=0，**sonnet**，空 cwd），隧道 cloudflared quick tunnel。07-09 20:35 起从 haiku 换 sonnet（Annie 拍板「试一下 Sonnet」；依据 980 V4 实测 sonnet×fresh 首 token 3159ms vs haiku×fresh 7154ms——haiku 每轮先吐 thinking 块；前后对照见 m2-sonnet-latency.md） |

**M2 硬门运行时断言已过**：首会话 `conversation_initiation_metadata` 实报
`agent_output_audio_format=pcm_24000` + `user_input_audio_format=pcm_16000`
（jsonl 留档 `~/fly1006-eleven/e2e-archive/e2e-fly1006-m1-smoke.jsonl`）。

冒烟（2 轮脚本喂音，全链 STT→claude 脑→TTS）：

| 轮 | speech-end→首音 | STT | 结果 |
|----|-----------------|-----|------|
| u1 | 2962ms（垫话准点） | 「帮我看一下哈豆模式今天能不能用？」 | 有音频回放（143KB） |
| u2 | 上轮慢答案跨轮（980 R6 已知行为，v1 如实记录） | 「帮我 check 一下 Flight 968 的 status…」 | 垫话+真答案（753KB） |

shim 侧归因：claude -p 冷轮 first_delta ~9.2s（当时 load 6-8）；平台 abort
in-flight 请求路径真跑（jsonl `aborted` 事件）。

## P2 — per-session 声线/persona 切换 ✅

同一 agent，3 个会话分别带 talk 页同形状 override（voice_id + persona prompt +
custom_llm_extra_body.conversation_id），u6who 问「你是谁？」：

| Lead | voice | 自称（agent 原文节选） | 首音 |
|------|-------|------------------------|------|
| Tadashi | Eric `cjVigY5qzO86Huf0OWal` | 「我是 Tadashi，Flywheel 的工程负责人…」 | 3358ms |
| Aunt Cass | Sarah `EXAVITQu4vr4xnSDxMaL` | 「我是 Cass，Flywheel 的总管…陪你聊天、帮你理顺事情」 | 3176ms |
| Belle | Alice `Xb7hH8MSUJpSbSDYk0k2` | 「嗨，我是 Belle，Annie 的生活助理…」 | 3152ms |

shim jsonl 证实会话按 `elevenlabs_extra_body.conversation_id` 分桶
（key=m1-op-tadashi/cass/belle，不再塌回 single-session）。
音频 wav 留档 `~/fly1006-eleven/e2e-archive/e2e-fly1006-m1-{lead}-u6who.wav`。

## 新发现（980 runbook 缺口）：custom_llm_extra_body 有独立平台安全位

**症状**：起始帧带 `custom_llm_extra_body` 时 WS 在 init 后立即 close
code=1008（policy violation）；不带则正常。

**根因**：`platform_settings.overrides.custom_llm_extra_body` 是与
`conversation_config_override` 平级的**独立** boolean 安全位，create-agent.mjs
只开了后者。980 的 e2e 验过 extra-body 通路，但其 agent 当时该位已开、
runbook §2 未记此步。

**修法（已并入本 rig）**：
```
node patch-agent.mjs <agent_id> '{"platform_settings":{"overrides":{"custom_llm_extra_body":true}}}'
```

**影响面**：M1 talk 页与 M2 ElevenWs 都强制带 conversation_id（防 shim 串味）
——**agent 重建 runbook 必须含这步**，否则会话根本开不起来（fail-loud，好在
不是静默）。

## 复现命令（runbook，30 秒重建路径）

```bash
cd engineering/spike/FLY-980-eleven
# 0) 前置: pnpm --filter flywheel-voice-core build; ./gen-ref-audio.sh; npm install
node usage.mjs <label>                                  # 记账快照
FLY980_TOKEN=$(cat ~/fly1006-eleven/.shim-token) FLY980_BRAIN=claude \
  FLY980_RESUME=0 FLY980_MODEL=sonnet node shim.mjs      # 脑(8980)；sonnet=07-09 Annie 拍板
cloudflared tunnel --url http://localhost:8980           # 隧道(URL 每次随机)
FLY980_TOKEN=$(cat ~/fly1006-eleven/.shim-token) \
  node create-agent.mjs <tunnel-url> fly1006-eleven-m1   # agent(如已有则跳过)
node patch-agent.mjs <agent_id> "$(cat ~/fly1006-eleven/patch-prod-knobs.json)"  # 生产旋钮(隧道 URL 变了要重生成此文件)
node patch-agent.mjs <agent_id> '{"platform_settings":{"overrides":{"custom_llm_extra_body":true}}}'
node e2e-session.mjs <agent_id> --label smoke --rounds u1  # 冒烟
cd ../FLY-1006-eleven && FLY1006_AGENT_ID=<agent_id> node serve.mjs  # talk 页(8988)
```

环境备注：实测时 load 6-8（980 实测夜 20-35，延迟绝对值本轮更可信）。
