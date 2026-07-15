# FLY-1006 M2 staged venue 机器验证（P5）— 取证

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md §S8

## Verdict 总表 — 三次调用全 PASS（fail-closed，exit code 为准）

| harness | 覆盖 | exit | 结果 |
|---------|------|------|------|
| `e2e/eleven-staged.mjs`（leg 0） | 真 bots + 真 daemon + /eleven autostart 起一轮 | 0 | PASS |
| `e2e/eleven-voice-loop.mjs`（`ELEVEN_LOOP_LEGS=mutex`，Boot A） | /gemini 持房 → /eleven founder-facing 拒入 | 0 | PASS |
| `e2e/eleven-voice-loop.mjs`（`ELEVEN_LOOP_LEGS=audio`，Boot B） | 注入 WAV→STT→claude 脑→TTS→VC 回放 + barge-in 停播 + 存活 | 0 | PASS |

## Leg 0 — /eleven 真机起一轮（2026-07-09 14:47 PT）

- daemon up（隔离 health :9879，生产端口拒跑守卫在位）；orchestrator + note-taker
  真 bots online；note-taker 常驻 VC；`/eleven` 真注册进 guild `1485787271192907816`。
- autostart → preflight（agent GET + shim 探针）→ 共享 slot acquire → ElevenSession
  live → orchestrator 进 VC（`[deferred-player] real player attached`）。
- **M2 硬门运行时断言过**（jsonl 留档）：`conversation_initiation_metadata` 实报
  `agentOutputAudioFormat=pcm_24000` + `userInputAudioFormat=pcm_16000`，平台真会话
  `conv_1201kx4dkehefdwrkak90ygqne3p`；干净 `session_ended`，`droppedLateChunks=0`。

## Boot A — 跨模式 slot 互斥（mutex leg）

/gemini autostart 先入（黑洞 Bridge URL 让 kickoff 在 slot acquire 之后悬停 = 确定性持房）
→ /eleven autostart 拒入，founder-facing 话术真落 staged 频道（injector 读频道历史断言）：

> 「有一场 /gemini 正在进行(0fba7a1e-…),先结束它再开新的。」

反向（/eleven 持房拒 /gemini）由单测覆盖（eleven-wiring + assistant-wiring 共享 slot 用例）。

## Boot B — 音频三断言（2026-07-09 14:58-15:00 PT）

| 腿 | 断言 | 实测 |
|----|------|------|
| leg 1 IN | 注入 u1 中文 WAV → 平台 STT → `user_transcript` 落 session jsonl | ✅ 「帮我看一下，哈豆模式今天能不能用？」逐字准 |
| leg 1 OUT | agent 音频回放落 VC（录播非静音） | ✅ 3,244,800 bytes（≈16.9s 48k 立体声），RMS 0.0772 |
| leg 2 STOP | 播放中注入第二段人声 → 停播 | ✅ barge-in 后 **+0 bytes** 尾巴（`interruption source:platform`+`local` 双路都真触发；platform 侧真截断——`agent_response:"我现在在语..."`） |
| leg 2 SURVIVAL | 打断后会话存活再答一轮 | ✅ transcript 2→4 条 user_transcript |

`droppedLateChunks=0`；`turn_end reason:gap`（1.5s 间隙兜底）真跑。

### 延迟（speech-end→真答案首音，无垫话配置，冷 claude -p 逐轮）

8848ms / 7141ms / 7739ms / 10283ms（n=4，中位 ~8.3s）。归因与 M1 拆段一致：
脑（冷 claude -p haiku，RESUME=0）占大头，STT/TTS 合计 ~1-3s。warm 脑 + 真 Lead
identity 注入是既定 follow-up 主战场（plan §4 追加要求④）。实测时 load ~6-7。

## 两个事故与修法（复现命令的一部分）

1. **同进程双 boot 撞 @discordjs/voice 连接注册表**：Boot A close 后 3s Boot B 重进
   VC，库的 group connection 注册表（guild+bot 键）残留已销毁连接 → ears 常驻 join
   永远到不了 Ready → `entersState` AbortError 崩进程。修法 = harness 加
   `ELEVEN_LOOP_LEGS=all|mutex|audio` seam（默认 `all` 行为不变），mutex 与 audio
   两腿**分进程**跑，各自 exit-code gated（与 967 staged/loop 双脚本隔离同精神）。
2. **shim 环境性崩溃（非代码缺陷）**：OOM 事故（2026-07-09 14:27）恢复期间 worktree
   被清（node_modules 与 gitignored `out/` 同批消失），14:25 起的 shim 进程在第一个
   真实 `/v1/chat/completions`（leg 1）写 jsonl 时 ENOENT 带崩 → 隧道 connection
   refused → 平台 `termination_reason: custom_llm generation failed`（平台侧回读
   `conv_3601kx…` 坐实：STT 已 commit、失败在 custom_llm 一跳）。修法 = 重启 shim
   （启动时自建 `out/`）。**runbook 注意**：shim 运行中不可对 worktree 做
   `git clean`（会删它的 out/ 日志目录）。

## 复现命令

```bash
# rig（沿用 m1-rig.md runbook；agent/tunnel/shim 已在位则只需核对）
cd engineering/spike/FLY-980-eleven
FLY980_TOKEN=$(cat ~/fly1006-eleven/.shim-token) FLY980_BRAIN=claude FLY980_RESUME=0 node shim.mjs
# 隧道已在跑(cloudflared, URL 与 agent custom_llm 一致);变了要重 patch agent
bash gen-ref-audio.sh   # ref/u1.mp3 等
ffmpeg -y -i ref/u1.mp3 -ar 48000 -ac 2 -sample_fmt s16 /tmp/fly1006-probe-48k.wav
ffmpeg -y -i ref/u5status.mp3 -ar 48000 -ac 2 -sample_fmt s16 /tmp/fly1006-interrupt-48k.wav

cd packages/voice-bridge && pnpm --filter flywheel-voice-core build && pnpm --filter flywheel-voice-bridge build
export HUDDLE_ORCH_BOT_TOKEN=$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-06/token)
export HUDDLE_EARS_BOT_TOKEN=$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-04/token)
export INJECTOR_BOT_TOKEN=$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-05/token)
export ELEVENLABS_AGENT_ID=agent_2401kx1say3vf988f28x07bhbwkt   # m1-rig.md
export STAGED_GUILD_ID=1485787271192907816 STAGED_VC_ID=1485787273193853170
export PROBE_WAV=/tmp/fly1006-probe-48k.wav INTERRUPT_WAV=/tmp/fly1006-interrupt-48k.wav
# ELEVENLABS_API_KEY 从 ~/.flywheel/.env;剥掉生产 FLYWHEEL_BRIDGE_URL/API_TOKEN
node e2e/eleven-staged.mjs                        # leg 0
ELEVEN_LOOP_LEGS=mutex node e2e/eleven-voice-loop.mjs
ELEVEN_LOOP_LEGS=audio node e2e/eleven-voice-loop.mjs
```

## Codex code review R1 修复后的复跑（2026-07-09 15:29 PT）

R1 三条（HIGH：ElevenWs.connect 预 open error/close 不 reject → 卡共享 slot；
MEDIUM：eleven-staged 定时 hold 后无条件 exit 0 可假绿；LOW：voice-loop 缺
9878 生产端口拒跑守卫）全修后真机复验：

- **正向**：`eleven-staged.mjs` exit 0，`VERDICT: PASS — session_live +
  platform metadata in jsonl`（verdict 源 = session transcript jsonl，不再是
  裸 hold）。
- **负向（fail-closed 证明）**：`ELEVEN_SHIM_HEALTH_URL` 指向死地址 → preflight
  拒开 round → `VERDICT: FAIL` + **exit 1**。
- connect 生命周期修复由 3 条新单测钉住（pre-open error/close 双路 reject +
  post-open 不受扰），voice-bridge 217/217 全绿。

## 留档

`~/fly1006-eleven/s8-voice-loop/`：4 份 harness 全量日志 + session jsonl
（`203a881f-….jsonl`，含 user_transcript/agent_response/first_audio 逐条）+
录播 PCM `eleven-out-48k-stereo.s16le`（3.2MB 非静音证据）。usage 快照
`usage-s8-{pre,post}-*.json`。QA 验收前不删。
