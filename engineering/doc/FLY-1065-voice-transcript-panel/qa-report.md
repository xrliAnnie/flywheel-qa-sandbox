# FLY-1065 QA 报告 — /gemini 文本面板双向转写 + 会话记录持久化

Issue: FLY-1065 (https://linear.app/geoforge3d/issue/FLY-1065)
日期: 2026-07-09
基于: plan.md（4-chunk 实现，Codex design 2 轮 + delta 3 轮 + code R1 APPROVED）、evidence/live-aggregation-e2e.md（真机聚合 8/8）
QA 阶段: 三段式 pipeline QA（独立验证，非重跑实现者的测试）

## 结论:**PASS** ✅

FLY-1065 忠实实现了 Annie 在 [FLY-1047] 真机验收提出的两个文本侧诉求，且守住了 secret 红线、中英双语合同、interrupted 如实留痕。单测/typecheck/lint 全绿，我另加了一层**真实生产组件端到端集成验证**和**独立对抗式 scrub 红线验证**，均通过。

## Annie 的原始诉求（验收判据）

> 「它在 Text（文本）界面这边显示得还是不够清晰。这边能够把我说了什么、对方说了什么都显示出来吗？以及能不能实现类似对话记录的功能。」

- **诉求 1 · 实时双向转写显示**:语音会话进行中，文本频道逐轮显示「Annie 说了什么」+「助理答了什么」，谁说的标清楚、按轮次排。
- **诉求 2 · 会话记录持久化**:整场对话逐字记录落地，会后可查（落 kickoff issue 独立 comment）。

## 验证矩阵

| # | 验证项 | 方法 | 结果 |
|---|--------|------|------|
| 1 | voice-core 单测（聚合/scrub/connector/config） | `pnpm test`（246 用例） | ✅ 246/246 |
| 2 | voice-bridge 单测（TivPresenter/landing/session/wiring） | `pnpm test`（含新增 6 用例 → 223） | ✅ 223/223 |
| 3 | 两包 typecheck | `tsc --noEmit` | ✅ clean |
| 4 | FLY-1065 改动文件 lint | `biome check`（23 文件 + 新 QA 测试） | ✅ EXIT=0 |
| 5 | 实现对齐 plan + code review 修复 | 逐文件读 scrub/turn-accumulator/GeminiLiveBackend/genaiConnector/TivPresenter/AssistantLanding/AssistantSession | ✅ 逐条吻合 |
| 6 | **诉求 1+2 真实生产链端到端** | 新增 `qa-fly1065-integration.test.ts`（真 GeminiLiveBackend 聚合 → 真 TivPresenter → 真 JsonlTranscriptSink 落真文件 → 真 AssistantLanding 读同文件） | ✅ 6/6 |
| 7 | **secret 红线独立对抗** | 9 种真实凭证形态 + 7 种中/英/混说口语/URL/issue 号 | ✅ 16/16 |
| 8 | 真机聚合链（voice-core 腿） | 实现阶段 evidence/live-aggregation-e2e.md（真生产 model） | ✅ 8/8（已固化） |
| 9 | **真机 Discord staged 腿**（Tadashi 指令） | `fly1065-staged-discord.mjs`：真 Gemini→真 TivPresenter→真 Discord #General→真 AssistantLanding→真 Linear FLY-1097 | ✅ evidence/staged-discord-e2e.md |

## QA 新增:端到端集成验证（`qa-fly1065-integration.test.ts`）

把**真实生产逻辑**串成一场中英混说 5 轮会话——真跑的是聚合+scrub 链（GeminiLiveBackend/TurnAccumulator/scrubTranscript）、caption 渲染（TivPresenter）、JSONL sink、landing 分段+幂等+读行（AssistantLanding）；stub 的是 `@google/genai` 传输层（喂脚本化 server 事件，正是真机 E2E 8/8 覆盖的那道 seam）+ 两个 I/O dep（capturing TivSendDeps 顶 Discord、capturing LandingLinear 顶 Linear）。P3 sink↔landing 路径对齐由测试把两者指向同一临时文件来"建模"，生产 wiring 的对齐保证（wiring.ts assistantTranscriptPath）由 assistant-wiring.test.ts 单独覆盖，真 Discord/真 Linear 那一跑见 staged-discord-e2e.md。直接断言 Annie 的两个诉求:

1. **诉求 1（逐轮双向显示）**:5 轮对话精确产出 10 条 caption，`🗣️ **Annie**:…` / `💬 **助理**:…` 角色标注正确、按轮次严格交替、每轮一条短消息（非刷屏）;
2. **诉求 1（中英双语合同）**:纯中文轮 / 纯英文轮 / 中英混说同轮全部原样透传（字符级处理，无 CJK 特判误伤）;
3. **诉求 2（JSONL 落盘）**:每轮每角色恰 1 条 final 行（10 行），落到 `<sessionId>.jsonl`;
4. **诉求 2（会后逐字记录）**:真 `AssistantLanding.run()` 读测试指向的**同一个** JSONL 文件 → 产出「会议纪要」+「逐字对话记录」两条 comment，逐字 comment 含全部 10 轮双向逐字行、marker `assistant-transcript … chunk 1/1`、issue 被关闭 —— 此处**建模**了 P3 sink↔landing 同源（测试把 sink 与 landing 指向同一文件），生产 wiring 的路径对齐保证由 assistant-wiring.test.ts 覆盖;
5. **secret 红线（防御纵深）**:助理念出的凭证 `sk-…` 在 caption、JSONL、Linear comment **三个出口全部** `[redacted]`，原始 token 一处不漏;
6. **interrupted 如实留痕**:被打断的半句在 caption 与 JSONL 均带「(被打断)」标 / `interrupted:true`;
7. **status 单飞**:一场会 3 次状态切换只发 1 条锚消息（edit-in-place），根治 967 的 status 刷屏。

**QA 过程中的一个诚实注记（非产品 bug）**:初版驱动脚本用 `generation-complete` 作每轮终结但漏发 `turn-complete`，导致 `turnActive` 不重置、下一轮 user 字幕迟发。核对实现与 evidence 后确认这是**测试脚本保真度问题**——真实 Gemini 流每轮必发 `turn-complete`（终态重置信号，evidence 实测 generation-complete 后 +10s），是产品设计的信号契约。修正脚本忠实模拟真实信号序列后全绿。产品逻辑无误。

## secret 红线独立对抗（16/16）

不依赖实现者自己的 `scrub.test.ts`，用真实世界形态独立跑:

- **必须 redact（9/9 ✅）**:OpenAI `sk-` / GitHub `ghp_` / `github_pat_` / Google `AIza` / Slack `xoxb-` / `Bearer <token>` / `FOO_TOKEN=` / `DB_PASSWORD:` / 裸 40+ 字母数字混串;
- **必须原样通过（7/7 ✅）**:中文口语 / 英文口语 / 中英混说 / **URL（含长路径斜杠）** / issue 号（FLY-1065）/ 短字母数字（房间号）/ 纯字母长词。

其中 URL 原样通过验证了实现中 `BARE_RANDOM` 故意排除 `/` 的设计决策是对的——带长路径的 Linear URL 不被误吞（带斜杠的真 secret 仍由 Bearer/前缀锚定模式捕获）。

## 真机 Discord staged 腿（Tadashi 指令 — 已完成）

Tadashi 明确要求「单测绿不算,必须真机跑 Discord staged 腿、拿真 Discord 消息证据」,并给了 967 staged rig 现成物料（GEMINI_API_KEY 等在 `~/.flywheel/qa-fly967-staged/.env.staged`）。已跑通,证据见 `evidence/staged-discord-e2e.md` + `evidence/staged-discord-e2e.json`:

- **真 Gemini 双向转写** → **真 TivPresenter** 经 **真 discordWiring send/edit** → `flywheel-pool-05` bot 在 staged VC #General 真实渲染 `🗣️ **Annie**:…` + `💬 **助理**:…` 两条 caption + `🛬 正在落纪要…(edited)` 单飞状态（无刷屏）;两条 caption 按 message id **从 Discord 回读双证** + Claude-in-Chrome 视觉确认;
- **真 AssistantLanding** 读同一 JSONL → **真 Linear FLY-1097**（自动创建 → 自动关闭 = **Done**）落「会议纪要」+「逐字对话记录 chunk 1/1」两条 comment,逐轮角色 + 时间戳行。

覆盖 plan P7 QA 断言 1-4;断言 5（中英混说）由确定性集成测试钉死（探针音频为纯中文,渲染/落地是同一语言无关代码）。

## 边界与最终验收（诚实声明）

- 唯一不走 VC mic 的是**音频 ingestion**（EarsReceiver/VC join = FLY-967 领域,本 issue 不碰）;音频直喂真 Gemini session,与聚合 E2E 同法。FLY-1065 改的全部路径（聚合 / caption 渲染 / Discord 投递 / landing / Linear）都在真机腿里对真实服务跑通了。
- **最终验收 = Annie 真机**:她的原始抱怨就是判据（文本面板能看清谁说了什么 + 会后能翻记录）。本 issue 纯文本/渲染/持久化侧改动,**不碰任何语音行为**（plan §7 明确）,967 的语音流已有她的真机确认（「一来一回正常」）。

## 改动范围复核

FLY-1065 真实 diff = `origin/main…HEAD`（本地 main ref 落后，实际 base 已含 #501+#524）:voice-core（scrub/turn-accumulator/GeminiLiveBackend/genaiConnector/transport/types）+ voice-bridge（TivPresenter 新增/AssistantLanding/AssistantSession/config/wiring/discordWiring）+ docs + e2e。**不含 teamlead 改动**（linear comment 路由随 #501 已合并），字节兼容边界（可选字段 / 不配 huddle.assistant 零变化 / `captions:false` 逃生口 / 语言合同哨兵 `{}`）均在位。
