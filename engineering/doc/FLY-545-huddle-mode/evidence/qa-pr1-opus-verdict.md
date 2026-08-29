# FLY-545 PR-1 独立 QA 裁决 — voice-bridge 地基
Issue: FLY-545 (URL 不可得,只写 issue 号)
日期: 2026-07-07
基于: plan.md §8 验收表 (A1-A3, A7) + implement 阶段 evidence/(pr1-loop.md / s1-gemini-text-modality.md / bot-provisioning.md)

> **QA 阶段 = Opus,独立 session(不自验)。** 本档记录三段式 QA 阶段对 PR-1
> (PR #495,"Huddle voice-bridge foundation")committed head 的独立核验结论。

## 裁决:代码 PASS · **ship 被 main-wide lint 破损(FLY-977)结构性阻塞**

- **FLY-545 PR-1 交付代码 = PASS**(下方逐条证据)。
- **CI "Build & Test" 目前 RED,根因 = main 自身 lint 坏**(22 个 lint 错误全在
  `engineering/spike/FLY-960-dave-stt/*`、`engineering/spike/FLY-968-voice-bakeoff/*`、
  `packages/agent-team-transport/*`——**没有一个是 FLY-545 的 voice-bridge / voice-core /
  ProjectConfig 交付代码**;这些文件在 origin/main 上就已存在且报错,FLY-977 的 heal
  尚未合入,本分支 merge main 时继承)。implement 阶段 progress.md 已如实标注
  「WAITING on FLY-977 (main lint heal)」,且曾在本分支试 heal(ce56d51e)又被
  revert(1f618b50)= 刻意决定「等 FLY-977,不在本 PR 混入 spike lint 修复」。
- 结论:**代码本身可 ship,但 CI 绿门(FLY-2)在 FLY-977 落地前无法满足**,ship
  为外部 fleet-wide 依赖所阻,非本 PR 缺陷。

## 逐条证据(独立复核)

### A1 — vitest 全绿 + 本 PR 代码 lint 干净

| 套件 | 结果 |
|------|------|
| `flywheel-voice-bridge` | **59/59 PASS**(config/resample/ears-receiver/lead-speaker/bot-registry/session-slot/daemon-health) |
| `flywheel-voice-core` | **102/102 PASS**(含新增 `extra-tools.test.ts` 11 项) |
| teamlead `ProjectConfig.test.ts` + `validate-projects.test.ts` | **135/135 PASS**(parseAndValidateProjects canonical 覆盖,byte-compat 确证) |
| teamlead `huddle-config.test.ts` | **17/17 PASS** |
| biome check(本 PR 改动的 24 文件) | **干净,No fixes** |

- **teamlead 全套(5358 测)出现 46 个失败 = 环境性假失败,非本 PR 回归**。铁证:
  ①失败伴随 `vitest-worker: Timeout calling "onTaskUpdate"` RPC 超时 + 生产
  `[BridgeWatchdog] event loop stalled for 600044ms — killing process`(机器 load
  ~25,event loop 停顿 600 秒);②本 PR 只改 `ProjectConfig.ts`(其 135 个 canonical
  测试全绿)+ 新增**隔离包** voice-bridge;③teamlead 对 voice-core/voice-bridge
  **零依赖**(package.json 无 voice dep,src 无 import)。故 46 失败与本 PR 代码无因果。

### A2 — S1 引擎选型(TEXT 模态被服务端拒 → D1-A / A10 多 session)

- evidence/s1-gemini-text-modality.md 记录:当前全部 Gemini Live 模型服务端拒绝 TEXT
  响应模态。代码正确落实该结论:`types.ts` **只加** `LiveToolSpec`/`extraTools`,
  **未加** `responseModality`/`response-text`(死配置)——与 addendum A1 一致 ✓。

### A3 — 完整 mp3→opus 依赖链(独立离线复现,mock 抓不到的那层)

自建 harness `packages/voice-bridge/e2e/qa-codec-chain.mjs`,**驱动真实模块**、
不碰 Discord/Gemini/生产:真 edge-tts 中文 mp3 → **真 ffmpeg** 解码 48k stereo →
**真 prism.opus.Encoder/Decoder**(discordWiring 同款 48k/2/960 参数)→ **真
`StereoDownmixDecimator`(dist 模块)** → 16k mono。

| 检查 | 结果 |
|------|------|
| mp3→48k stereo(ffmpeg) | 732672 bytes = **3.82s**(与 pr1-loop 的 3.8s 源一致) |
| prism opus 编→解 round-trip | 729600 bytes 48k stereo ✓ |
| downmix→16k mono | 121600 bytes = **3.80s**(时长保持,resample 无漂移) |
| 能量包络 | RMS all=2583 · head=2335 · mid=2845 · tail=2542 = 非静音且**语音形态**(中段响、首尾静) |
| split-stream 字节一致(真解码流) | **PASS** — 恶意错位切分 [1,7,13,4093,65537,3,999983] bytes 与单次 push 逐字节相同 |

→ VERDICT: **PASS**。implement 阶段的真机 Discord 闭环(pr1-loop.md)另有 PASS,
且抓出并修了真 bug(`@discordjs/voice` 连接注册表按 (group,guildId) 键控 → 单进程
多 bot 互顶,修 = `group: client.user.id`;discordWiring.ts:58 已核实)——mock 抓不到、
真机才现的那一层,implement 已覆盖。本 QA 独立复现了 codec/resample 核心。

### A7 — argv/日志卫生(token/文本不进 argv)

- voice-bridge 唯一 `execFile` = preflight 的 `ffmpeg -version`(preflight.ts:20);
  token 全走 env(config.ts,`requireTokenEnv`);text→TTS 走 voice-core EdgeTts 的
  0600 temp file(LeadSpeaker.ts 注释合同)。**无 token/文本进 argv** ✓。

## 代码走查结论(关键模块,均正确)

- `resample.ts` StereoDownmixDecimator:stateful,byteRemainder+sampleRemainder 跨
  push 携带,split==single 性质(独立复现印证)。box-average 降采样、ZOH 升采样、clampS16。
- `EarsReceiver.ts`:human-only 订阅(结构性回声防护)+ `allowUserIds` QA seam;
  backchannel 门 = `speaking` start/end 事件对(start 起 350ms 计时,end 先到=不打断,
  计时到=onBargeIn 一次);speaking-start 去重(ensureSubscribed);pipeline 错误不吞。
- `LeadSpeaker.ts`:串行队列 + 事件缓冲(避免 Playing→Idle 微任务竞态丢事件挂死队列);
  stop() 同步清队+player.stop();cancel 语义 resolve(cancelled) 非 reject;真错误 reject。
- `config.ts` / `ProjectConfig.ts`:fail-fast + byte-compat(huddle null/undefined 短路;
  moveMembers/commandName present-but-invalid fail-loud;voice 可选非空校验)。
- `GeminiLiveBackend` extraTools 分发:未知 tool name → 显式错误响应(绝不静默挂 turn);
  cancel 契约与 ask_lead 统一(toolAborts 共享);turnCancelled 守卫丢弃已取消 turn 的迟到
  tool-call。11 测覆盖。

## Ship 阻塞项(需 Lead 处置,非本 PR 缺陷)

CI 绿门被 main-wide lint 破损阻塞(FLY-977 未合)。本 QA 不擅自 heal out-of-scope
spike lint(该 heal 曾被刻意 revert)。ship 时序移交 Tadashi:待 FLY-977 合入 main
→ merge main → CI 绿 → 再走 approve gate + ship。QA 代码裁决 = PASS,已就绪。
