# FLY-543 voice-core — evidence & real-machine gap

Issue: FLY-543 · phase: implement · date: 2026-07-06
基于: engineering/doc/FLY-543-pluggable-voice-skill/plan.md（r2 双面架构）

本文件如实区分 **本 implement 阶段已用客观证据验证的部分** 与 **需要 Annie 真机 /
真 key 才能补的部分**（Lead 明确要求：建成「能跑」+ evidence 里标出哪些要真机）。
Phase 0 spike 机器事实见 `engineering/doc/FLY-543-pluggable-voice-skill/evidence/spike-phase0.md`
（S0.1 claude -p 零工具/resume + S0.1b mic 已完成；**S0.2 Gemini Live 连通性 spike 待做**）。

## ✅ 已验证（CI 可复现，无需真机）

| 验收 | 证据 | 命令 |
|------|------|------|
| A1 vitest 全绿 | 12 测试文件全过 | `pnpm --filter flywheel-voice-core test` |
| A1 typecheck 干净 | tsc 0 error | `pnpm --filter flywheel-voice-core typecheck` |
| A1 lint 干净 | biome 0 error | `npx @biomejs/biome check packages/voice-core/src` |
| A5 可插拔实证 | registry 按 id 解析、capability/factory 一致性 fail-fast、双面（edge-tts announce + gemini-live converse）各自可建 | `registry.test.ts` / `cli-factory.test.ts` |
| A6 失败路径显式 | component-missing / subprocess-failed / timeout / cancelled / backend-protocol 全有单测 | `config.test.ts` / `edge-tts.test.ts` / `headless-brain.test.ts` |
| A7 argv 卫生 | edge-tts 文本走 0600 `--file`；brain prompt 走 stdin；`say` 文本只经 --stdin/--file（无位置参数）；mock argv 断言无文本 | `edge-tts.test.ts` / `headless-brain.test.ts` / `cli-factory.test.ts` |
| A8 取消合同（两个面） | announce：mid-speak interrupt 杀播放+清队列+queued 全 reject cancelled;converse：**barge-in（服务端 interrupted）与手动 interrupt() 两路径分测**——各自停播+response-cancelled+cancel 后无 assistant transcript;toolCallCancellation abort 进行中 ask_lead(无 function-response) | `announcer.test.ts` / `gemini-live.test.ts` |
| brain S0.1 参数 | 零工具=`--tools "" --strict-mcp-config`（每轮重传）、persona=`--append-system-prompt-file`（resume 轮不重传）、stream-json+partial 只取 text_delta、session_id 捕获→`--resume` | `headless-brain.test.ts` |
| 真子进程 seam | 真 `node` 子进程验 stdin 管道 / timeout kill / abort kill / spawn 流式 | `process.test.ts` |

## ✅ 补测（QA round 3 后，Annie 要求真 API 别 defer）

| 验收 | 证据 | 命令/文件 |
|------|------|-----------|
| **S0.2 Gemini Live 连通性 spike** | 真 `@google/genai` transport（非 mock）连上真实 Gemini Live API；顺带发现 `config.ts` 钉的默认模型名 `gemini-live-2.5-flash-preview` 已 404，真实可用模型见 `real-live-models-list.json` | `poc-converse.md` §①/③ |
| A2 POC-A 播报闭环（真机播报 + 三指标 + mp3 样本） | 两条独立真机路径（CLI 全链路 + 直调核心引擎）产出可 ffprobe/afplay 核验的真实 mp3 | `poc-announce.md` |
| A3 POC-B 对话闭环（自动化部分：ASR + 回复 + 回复音频） | 喂真录音样本（edge-tts 合成后转 16kHz PCM16）进真 API，两次独立跑 ASR + 回复文本 + 回复音频（wav，afplay 可听）一致 | `poc-converse.md` §③、`gemini-live-e2e-events.json` |

**仍需 Annie 本人真麦克风** 的部分（结构性测不到，见 `poc-converse.md` 结尾）：真实
硬件采集链路、Annie 本人声音/口音的 ASR 表现、真人连续对话下的 barge-in 手感、
≥3 轮对话 + resume 的完整 POC-B 体验验收。A4 zh-en eval set（真 mic 逐句）同样待补。

**说明**：`genaiConnector.ts`（真 @google/genai transport）现已过真实 API 连通验证
（`poc-converse.md`），但仍未被单测覆盖到行为级——它薄封装 SDK，映射逻辑
（mapMessage）纯函数可后补测；被单测覆盖的合同是 `GeminiLiveBackend` 对注入
transport 的完整行为（mock ws 事件序列全覆盖）。

## FLY-959 回归（4 处已知 bug 修复，2026-07-07）

| 验收 | 结果 | 证据 |
|------|------|------|
| R1 mic 跟随系统默认（`:default`） | PASS（设备打开铁证 + `:0` 对照；声学收音留白天真人补） | `fly-959-regression.md` |
| R2 session 过期自动续期 | PASS（真 CLI + 真麦克风跨 goAway `[session resumed]`；driver 跨续期问答成立） | `fly-959-regression.md`、`fly-959-e2e-events.json` |
| R3 ask_lead 全 schema 真调用 | PASS（真 tool-call 事件 + 真 brain 回答、不再瞎编） | 同上 |
| R4 默认模型 `gemini-3.1-flash-live-preview` 直连 | PASS（Task 0 复核 models.list + 两条真会话无 404） | 同上 |

## 范围说明（承 plan r2 §0 安全边界）

POC 脑 = **只读的 Lead persona 近似**（`claude -p` 零工具）：语音里说 approve/ship/merge
只得到口头回应，不触发任何动作。动作能力的语音路由 + ConfirmedTranscriptGate（防 STT
误识别高危指令被执行——round-1 脑零工具结构性无此路径）随动作路由 issue 一起 defer,
设计留档于初版 plan git 历史。
