# FLY-2030 Raya 大脑:状态吸收 + 追问 — 调研
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-27
基于: exploration.md

> 本文只记**事实**:协议、现有代码的接缝、部署现状、以及哪些还没证。每条事实标 as-of;设计判断在 exploration.md,拆法在 plan.md。

## 1. 结论

exploration 的 D1–D12 在协议层都有现成落点:Codex app-server 0.150.1 提供 `thread/start|resume`、`turn/start`(含 `outputSchema`)、`item/completed`(`agentMessage`)、`turn/completed`、`thread/tokenUsage/updated`;raya 仓已有可复用的 JSON-RPC 客户端、原子状态存储、Gateway 监听与 metrics 写入。**需要探针证明的只有四件**(§6):文本 thread 跨进程 resume、`outputSchema` 在 gpt-5.6-sol 上生效、sandbox 内可读六个项目仓、Lead 会回 Raya 的 @mention。前三件是 raya 仓内可自证的;第四件依赖 flywheel/founder 侧一次性配置。

## 2. Codex App Server 协议事实(codex-cli **0.150.1**,2026-08-27 本机 `generate-json-schema` 导出,隔离 `CODEX_HOME`)

### 2.1 线程

| 方法 | 关键字段 | 备注 |
|---|---|---|
| `thread/start` | `model, cwd, approvalPolicy, sandbox, baseInstructions, developerInstructions, config, ephemeral, personality, …` | V1 builder 已钉 model/xhigh/1M/sandbox;`ephemeral:true` 只用于 preflight。**`developerInstructions` 可放本单的机制说明**(输出合同、快照路径、SKIP 语义),不动 operator 拥有的 `IDENTITY.md` |
| `thread/resume` | `threadId` + 与 start 同一套参数 | V1 `buildThreadResumeParams` 已存在但从未被调用过 |
| `thread/resume` 响应 | `thread{ id, turns, status, cwd, … }, model, reasoningEffort, sandbox, …` | 回执可用同一个 `assertThreadReceipt` 核 model/sandbox 没被降级 |
| `thread/read` | 读线程内容 | 备用:验证 resume 后历史在不在 |

### 2.2 回合

| 方法 / 通知 | 关键字段 | 备注 |
|---|---|---|
| `turn/start` | **required: `input[]`, `threadId`**;可选 `outputSchema`, `clientUserMessageId`, `cwd`, `approvalPolicy`, `sandboxPolicy`, `effort`, `model`, `summary` | `input[]` 为 `UserInput` 联合类型;文本项 = `{type:"text", text, text_elements?}`(flywheel `CodexTurnExecutor` 用的正是 `[{type:"text", text}]`) |
| `turn/started` / `turn/completed` | `threadId, turn{ id, status, error, items, startedAt, completedAt, durationMs }` | `status ∈ completed \| interrupted \| failed \| inProgress`;`error.message` 可直接落日志 |
| `item/started` / `item/completed` | `threadId, turnId, item` | `agentMessage` 项 = `{ id, type, text, phase(commentary\|final_answer), delivery, memoryCitation }`;flywheel 侧取最终文本 = 收集 `type==="agentMessage"` 的 `text`(`extractAssistantText`) |
| `item/agentMessage/delta` | 流式增量 | 本单不需要流式(Discord 不适合逐字编辑);只用 completed |
| `thread/tokenUsage/updated` | `threadId, turnId, tokenUsage.total.totalTokens, tokenUsage.modelContextWindow` | V1 `parseContextUsage` 直接可用;FLY-2074 P5 证明 backend turn 会发 |
| `turn/interrupt` | `threadId, turnId` | 超时打断用 |
| `thread/compacted` | — | 1M 满时 Codex 自动压缩的通知;只记日志 |

### 2.3 权限与 sandbox

- V1 实测回执:`sandbox.type = workspaceWrite`,`networkAccess = true`,`writableRoots = [code, memory]`,`approvalPolicy = never`(FLY-2029 verification §2)。
- `TurnStartParams.approvalPolicy` 有 `never`;`approvalsReviewer` 默认 `user`——本单沿用 thread 级 `never`,不在 turn 级覆盖。
- workspace-write 是**写**限制;**读**是否受限未在 raya 仓实证 → 探针 P-read(§6)。
- ThreadItem 联合里有 collab/子 agent 项(`agentsStates, receiverThreadIds, senderThreadId`)⇒ sub-agent 是 Codex 原生能力,不需本单建机制(P10/§12.4)。

### 2.4 会话持久化

- `~/.flywheel/raya/codex-home/sessions/2026/08/{26,27}/rollout-*.jsonl` 共 **3 份**(as-of 2026-08-27),`session_meta` 带 `cwd=/Users/xiaorongli/.flywheel/raya/code`、`base_instructions`、`context_window`、`history_mode`,后随 `response_item type=message role=user` ⇒ **文本 turn 的 rollout 确实落盘**。FLY-2074 P2 的「no rollout found」是 realtime thread 的特性,不能外推到文本 thread——但也**不能反向外推为「一定能 resume」**,故留探针 P-resume。
- `thread-writer-locks/` 目录存在 ⇒ Codex 有 per-thread 写锁;voice 与 brain 用不同 thread,理论上不互斥(FLY-2074 P6 只证了 30 分钟 realtime + 轻量 brain 请求并发,**没证过两个 backend turn 并发**;记为风险 R4)。

## 3. raya 仓现有接缝(main b7abff4)

| 接缝 | 位置 | 复用方式 |
|---|---|---|
| JSON-RPC over stdio 客户端(request/notify/onNotification/onServerRequest/onExit/stop,含 stderr 证据、退出拒绝 pending) | `apps/voice/src/codex/AppServerClient.ts`(+ `.test.ts`) | **D9:提到 `packages/codex-client`**,voice 改一行 import;brain 不需要 `writeHot` 热路径但不删 |
| `CodexControlClient` 接口 | `apps/voice/src/codex/CodexLeg.ts` | brain 的 `RayaThread` 依赖同一接口,测试用同一种 fake |
| thread 参数 builder + 回执断言 | `packages/contracts/src/codex-session.ts` | 直接用;新增 `developerInstructions` 透传 |
| 原子状态文件(temp+fsync+rename,0600;corrupt/unsupported 自动搬走) | `apps/voice/src/store.ts` `SessionStore` | 抽同款为 brain 的 `BrainStateStore`(thread id、last tick、last seen message id) |
| marker 原子写/读/清 | `packages/contracts/src/voice-mode.ts` | `tick.requested` 同形 |
| Discord Gateway 监听(`Guilds+GuildMessages+MessageContent`,guild/channel/author 过滤,串行队列) | `apps/brain/src/voice-mode.ts` `startVoiceModeGateway` / `VoiceModeController` | 扩成一个 `InboundRouter`:语音短语 → 现有 controller;其余 founder 消息 → 对话队列;roundtable thread 内 Lead 消息 → 追问回收;新增 `GuildMessageReactions` intent + `Partials` |
| Discord REST 发消息 | `apps/brain/src/runtime.ts` `postDiscordAlert` | 泛化为 `postMessage(channelId, content)`;加 2000 字分块、typing 指示、`GET /channels/{id}/messages?after=` 补读 |
| 资源采样 + `VoiceDownTracker` | `apps/brain/src/runtime.ts` | 不动;对话回路挂在同一个 `runBrain` 生命周期上,采样失败不影响对话、对话失败不影响采样(FLY-2074 §14.3 同款隔离) |
| context-usage 写入 | `packages/contracts/src/metrics.ts` `parseContextUsage` → `RAYA_METRICS_DIR/context-usage.jsonl` | brain thread 的 `thread/tokenUsage/updated` 同样写入;`metrics summary` 按 threadId 无需改 |
| 配置校验(fail-closed,敏感路径重叠护栏) | `apps/brain/src/config.ts` | 新增 `RAYA_PROJECTS_FILE`(required)、`RAYA_ROUNDTABLE_CHANNEL_ID`(optional)、`RAYA_BRAIN_OPTIONS_JSON`(optional) |
| Codex 子进程 env 白名单 | `apps/brain/src/preflight.ts`(`CODEX_HOME, HOME, PATH, SHELL, TMPDIR`) | brain 子进程沿用;**不给** `RAYA_OPENAI_API_KEY`(voice 专用)、**不给** `RAYA_BOT_TOKEN` |
| launchd | `apps/brain/src/launchd.ts` | 不动:brain 仍 `RunAtLoad=true`;对话回路在同一进程 |
| 测试形态 | vitest;voice 有 fake app-server 与注入式 spawner | 沿用 |

## 4. 部署与 Discord 事实(as-of 2026-08-27)

| 事实 | 值 | 出处 |
|---|---|---|
| `#raya` | `1542079099928059987` | FLY-2029 verification §3 / raya.env |
| Raya bot id | `1542068543645024257` | `apps/brain/src/cli.ts` |
| 邀请权限(静态位) | `36703232` = ViewChannel + SendMessages + Connect + Speak + UseVAD | FLY-2074 plan §14.1 |
| 🔴 **生效权限(实测,更正)** | **ReadMessageHistory 与 SendMessagesInThreads 实际已有,#leads-roundtable / #raya 均可读**——Tadashi 2026-08-28 01:41 实测。我此前据邀请 URL 的静态位掩码报「缺两项权限」是**错的**(生效权限 = 邀请位 ⊕ 角色授权 ⊕ 频道覆写,静态位不含后两者);该错误也进过 v1 founder HTML §9 与本文旧版 R8,**均以本行为准,不再列为阻塞项** | Lead 实测(答 880feab1) |
| `#leads-roundtable` | `1512578695468941333`;`requireMention:true`;top-level 自动开 thread(FLY-314),被 @ 的 Lead 与 founder 成为 thread 成员 | `lead-rules-base/cross-dept-channel-rules.md` · `~/.flywheel/roundtable.json` |
| Lead 对 bot 消息的过滤 | Discord 插件按 Lead 的 `access.json.allowBots` 白名单放行;FLY-282 自愈:`~/.flywheel/roundtable-registry/<leadId>.json` 里的 `botUserId` 在 Lead 启动时并入 | `packages/teamlead/src/roundtable-allowbots.ts` |
| registry 现状 | 18 个 Lead 条目,**无 raya** | `ls ~/.flywheel/roundtable-registry` |
| 项目注册表 | `~/.flywheel/projects.json`:6 项目,16 Lead 条目;每 Lead 有 `agentId/chatChannel/botUserId`;`personal-assistant.projectRepo = xrliAnnie/belle-workspace` | 本机 |
| 六仓最后 commit | geoforge3d 2026-07-02 · joycon-typeless 07-04 · growth 07-05 · tidal-echo 07-05 · flywheel 08-27 · personal-assistant **08-25**(⚠️ PRD §5.4「不是 git 仓」已过期) | 逐仓 `git log -1` |
| Codex 子进程可用工具 | `PATH` 含 `gh`(认证走 `HOME/.config/gh`);`git` | 白名单 env |
| 三指标现状 | `resource-usage.jsonl` 670 KB 在跑;`context-usage.jsonl` 372 B(只有 voice backend turn 的几行) | `ls ~/.flywheel/raya/data/metrics` |

### 4.1 `RAYA_PROJECTS_FILE` 输入合同(Raya 侧定义,不依赖 flywheel 源码)

```json
[{ "projectName": "flywheel",
   "projectRoot": "/abs/path",
   "projectRepo": "owner/repo",            // 可选
   "leads": [{ "agentId": "flywheel-eng-lead", "botUserId": "1516…", "chatChannel": "1516…" }] }]
```
未知字段忽略;`projectRoot` 不是 git 仓时快照写 `git: null` 并给原因;`botUserId` 缺失的 Lead 不可被追问(快照里标出)。

## 5. Discord Gateway / REST 细节

- discord.js 14.26.4 已在 brain 依赖里;新增 intent `GuildMessageReactions`,并开 `Partials.Message | Partials.Reaction | Partials.Channel`(未缓存消息上的 reaction 只给 partial,要 `fetch()`)。
- thread 消息:bot 只要能看见父频道就会收到公开 thread 的 `messageCreate`;`message.channel.isThread()` + `channel.parentId === roundtableId` + `channel.id === askMessageId`(Discord 从消息开 thread 时 thread id = 消息 id,FLY-314 的自动 thread 正是 `startThread` 于该消息)——⬜ 最后一条要在 P-ask 探针里核实。
- 消息上限 2000 字符;分块按段落/代码围栏边界切;每块之间保持顺序(串行 await)。
- typing:`POST /channels/{id}/typing` 每 8 s 一次,持续到 turn 结束(Discord typing 有效 10 s)。
- 补读:`GET /channels/{id}/messages?after=<lastSeenId>&limit=100`,只取 founder/allowlist、非 bot、非语音短语的消息,合并成一轮输入(标注「你离线时她说的」)。

## 6. 必须先证的四件(C0 探针;结果决定分支;证据存 raya 仓 `probes/evidence/FLY-2030/`)

| 探针 | 做什么 | 通过 | 失败分支 |
|---|---|---|---|
| **P-resume** | 进程 A:`thread/start`(非 ephemeral)→ `turn/start` 让它记一个校验词 → 等 `turn/completed` → 结束进程;进程 B:`thread/resume` → 问校验词 | B 答出校验词 | 退化为 D1':每次重启新 thread + 把 MEMORY.md 当唯一跨重启记忆,并在 `#raya` 明说「记得:否」(与 FLY-2074 同款诚实) |
| **P-schema** | `turn/start` 带 `outputSchema = RayaTurnOutput` | 最终 `agentMessage.text` 是合法 JSON 且 `say/asks/reason` 齐 | 退化为 Q2-A 标记行协议,但 brain 对「标记缺失」**响亮**报错(不静默) |
| **P-read** | 在 thread 的 turn 里执行 `git -C /Users/xiaorongli/Dev/GeoForge3D log -1 --format=%cI` | 得到 2026-07-02 | 快照全部由 brain 生成(D3 已如此),Raya 侧深挖能力受限,写进边界 |
| **P-ask** | Raya bot 在 `#leads-roundtable` 发 `<@1516207680836866219> 探针:请回一个字` | Tadashi 在自动 thread 里回;brain 收到且 thread id = 消息 id | 追问退化为「在 `#raya` 说我问不到」;前置项(registry/allowBots/权限)交回 Lead |

探针 **P-resume / P-schema / P-read** 会在她的 `RAYA_CODEX_HOME` 里各留一条真实 thread 并消耗订阅额度——与 FLY-2074 C0 同类,先报 Lead 再跑;**P-ask** 会在 founder 可见的 roundtable 留一条消息,必须 Lead 明确同意后才跑。

## 7. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | xhigh 每轮对话数分钟延迟,她以为它死了 | typing 指示每 8 s;超过 `turnTimeoutMs`(默认 30 min)`turn/interrupt` 并说「我想太久被打断了」 |
| R2 | 结构化输出让对话变生硬 | P-schema 顺带看一眼回复自然度;不自然则只在 tick 用 schema,对话用标记行 |
| R3 | brain 重启期间她的消息丢失 | D11 补读;`lastSeenMessageId` 原子存 |
| R4 | voice backend turn 与 brain turn 并发(同一 CODEX_HOME) | 只记风险;若实测撞锁,brain 在 `voice-mode.requested` 存在时把 tick 推迟(不推迟对话) |
| R5 | 额度打空(FLY-2074 坑:错误被吞成正常关闭) | `turn.status=failed` + `error.message` 落日志;同一小时只在 `#raya` 说一次「额度/错误」,tick 静默跳过并记账 |
| R6 | 自动 thread 与 Lead 回复的形状(thread id、成员)与我读到的规则不一致 | P-ask 实证;失败分支已写 |
| R7 | 她用 reaction 的习惯未知,反指标「值」的分母可能长期为 0 | 只记录;HTML 明写这个分母靠她打 👍/👎 |
| R8 | ~~两个 Discord 权限要 founder 重邀~~ **已撤销**(§4 更正行:实测已有,不是阻塞项);preflight 的运行时实探仍保留(它测的就是生效权限,不是静态位) | — |

## 8. 会过期的结论

| 结论 | as-of | 怎么重核 |
|---|---|---|
| app-server schema 字段名(§2) | 2026-08-27,codex 0.150.1 | `CODEX_HOME=/tmp/x codex app-server generate-json-schema --out <dir>` 后 grep |
| 3 份文本 rollout 存在 | 2026-08-27 | `find ~/.flywheel/raya/codex-home/sessions -type f` |
| Raya 不在 roundtable-registry / allowBots | 2026-08-27 | `ls ~/.flywheel/roundtable-registry`;Lead 重启日志 `allowBots +=` |
| 邀请权限 36703232 | 2026-08-27 | Discord 服务器设置 |
| `context-usage.jsonl` 372 B | 2026-08-27 17:2x PT | `pnpm raya metrics summary --dir ~/.flywheel/raya/data/metrics` |
| 六仓最后 commit 日期 | 2026-08-27 | `node -e` 逐仓 `git log -1`(exploration Q3 的命令) |
