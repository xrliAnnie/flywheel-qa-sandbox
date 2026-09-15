# FLY-2550 常驻 Lead 线程轮换 vs 退出 Codex 自动记忆 — 探索
Issue: FLY-2550 (https://linear.app/geoforge3d/issue/FLY-2550/2355e-常驻-lead-记忆蒸馏真拦点-codex-threadsid-current-thread-id-排除常驻-lead-永不换)
日期: 2026-09-14
基于: 无(上游为 engineering/doc/FLY-2360-memory-observation/report.md 与 FLY-2119 PRD(PR #1024 分支))

## 0. 一句话结论

Codex 只蒸馏「别的、已静置、未归档」的线程,而 TUI 形态的常驻 Lead(Mufasa、Infra Bot)一辈子只有一条线程,永远是「当前线程」⇒ 永远 0 候选。**本单推荐:让 TUI 常驻 Lead 按周期把对话「换到一条新线程」(fresh `thread/start` + 一张有上限的交接便签),旧线程留在原地不归档,6 小时后自然成为候选,由已有的 6 小时 `summary_due` 节奏点触发蒸馏。**不用 `thread/fork`(旧线程全文会被整份复制进新线程的 rollout,每次蒸馏都重复消化整条家谱);不为 Mufasa 退出 Codex 记忆(founder 的方案 D 与 FLY-2357 的 pin 门都以「Codex 原生记忆」为前提)。Raya:Lead 裁定(question `8b57c58e`,2026-09-14)她保留自己的 `MEMORY.md`(FLY-2131),不为她设计;她今天正从 legacy 壳(`~/.flywheel/raya/codex-home`,退役中)切到标准 Codex Lead(家 = `~/.codex-raya`,FLY-2357 pin)⇒ 本单只对 Mufasa 做设计与验收,轮换作为 TUI 运行时的通用行为对切过来的 Raya 同样生效,不特判。

## 1. 症状回顾(FLY-2360,2026-09-14 09:11Z 读数)

- 三个目标家 `rollout_summaries/` 全空;对照 `~/.codex` 有 116 篇 ⇒ 管线本身能跑。
- Mufasa:额度闸 09-06/07 跳过 45 次,09-12 起放行、phase2 跑过 3 次;**phase1 每次候选 = 0**。拦点不是四道闸,而是源码第五条件 `threads.id != current_thread_id`:主线程 `019eaf5d`(2026-06-09 建)既是唯一够新的线程,又是每次 startup 的发起者。
- Infra Bot:08-23 后零 turn,当时 launchd 崩溃循环;Raya:`~/.codex-raya` 不存在。
- FLY-2360 的验收:四道闸一道不调,不开 simple_code 子单;把「线程形态」交给设计单 = 本单。

## 2. 本单补充审计(2026-09-14,全部只读;sqlite 一律先拷贝到 scratchpad 再查)

### 2.1 生产 Codex 是 0.154.0,本单按该 tag 源码逐门核对

`~/.codex-mufasa/packages/standalone/releases/` 有 0.154.0;`version.json` `latest_version=0.154.0`。本机 `~/Dev/codex-oss`(07-28)与 `~/Dev/codex`(02-14)都比生产旧,不引用;源码用 `git clone --depth 1 --branch rust-v0.154.0` 取到 scratchpad。关键门(file:line 均为 0.154.0):

| 门 | 位置 | 内容 |
|---|---|---|
| 候选 SQL | `state/src/runtime/memories.rs:236-249` | `memory_mode='enabled'` **AND `threads.id != <当前线程>`** AND `updated_at_ms ∈ [now−max_age, now−idle]`,`ORDER BY updated_at_ms DESC LIMIT 5000` |
| 未归档 | `state/src/runtime/threads.rs:1415` | `push_thread_filters` 追加 `threads.archived = 0` ⇒ **归档的线程永不蒸馏** |
| 来源白名单 | `rollout/src/lib.rs:87-90` | `Cli` / `VSCode` / `atlas` / `chatgpt`;我们 daemon 建的线程都是 `vscode`(Mufasa 87 条、Infra Bot 157 条、Raya 197 条实测) |
| 启动触发 | `app-server/src/request_processors/turn_processor.rs:669-678` | 每个「有输入且真正开始」的 `turn/start` 都调 `start_memories_startup_task`(不是每进程一次) |
| 启动守卫 | `memories/write/src/start.rs:33-37, 60-67` | ephemeral / 特性关 / 子代理直接返回;额度 <25% 记 `skipped_rate_limit` 后返回 |
| 读路径注入时机 | `ext/memories/src/extension.rs:51-65` → `core/src/session/mod.rs:3932` `build_initial_context_with_world_state` ← `:4217` `start_new_context_window` 与 `core/src/compact.rs:105` | `memory_summary.md`(截 2500 token)**只在「新上下文窗口」开始时注入**:线程开始/恢复、或一次压缩之后;不是每轮都重读 |
| stage1 输入上限 | `memories/write/src/prompts.rs:100-117`;`lib.rs` `CONTEXT_WINDOW_PERCENT=70`、`DEFAULT_ROLLOUT_TOKEN_LIMIT=150_000` | rollout 全文按「模型有效窗口 × 70%」截断,**保头保尾丢中间** |
| 特性默认 | `features/src/lib.rs:1101-1105` | `memories` 是 Stable 但 `default_enabled: false` ⇒ 没写 pin 的家就是关的 |
| 线程级配置覆盖 | `app-server-protocol/src/protocol/v2/thread.rs:64-120` | `thread/start` 有 `config`(dotted 覆盖)、`baseInstructions`、`developerInstructions`、`historyMode` |
| `thread/fork` | `app-server/src/request_processors/thread_processor.rs:4757-5040`;`core/src/session/mod.rs:1478-1515` | 源线程是 legacy 历史模式(Mufasa 主线程 `history_mode='legacy'`)⇒ `ForkPersistence::Copied`:**整份历史被复制并 `persist_rollout_items` 写进新 rollout**;`SessionMeta.forked_from_id` 只是元数据(`rollout/src/recorder.rs:846`)。`ThreadForkParams` 没有 `historyMode` |

### 2.2 Mufasa(`~/.codex-mufasa`,TUI 全权限形态)

- 主线程 `019eaf5d-a5b7-7a72-b73f-cd1063892aa1`:2026-06-09 建,rollout `sessions/2026/06/09/rollout-…019eaf5d….jsonl` **7,096,220 B / 2,887 行**,`user_message` 238 条,`compacted` 事件 4 次;`metrics/context-usage.jsonl` 累计 `totalTokens` 36,946,771、`modelContextWindow` 258,400 ⇒ 这条线程早已靠压缩活着,「上下文连续性」本来就是摘要级的。
- `threads`:vscode 未归档 87 条(最新 = 主线程 09-14),vscode 已归档 20 条,exec 65 条(最新 08-20);除主线程外最新的 vscode 线程停在 08-20 ⇒ 每次 startup 都是 0 候选(与 FLY-2360 一致)。
- 入站节奏(`~/.flywheel/state/codex-lead/mufasa-lead/journal.db` 拷贝):最近 30 天 9 段 >6h 的静置;**09-12 起 Bridge 每 6 小时投 `summary_due`(FLY-2382,00/06/12/18 UTC)、09-14 起还有半小时级重投** ⇒ 主线程每天至少 4 次 `turn/start`,也就是每天至少 4 次 memory startup。这既是问题(主线程 `updated_at` 永远新鲜)也是解法的燃料(轮换后旧线程 ≤6h 内就会被下一次 startup 认领)。
- 记忆日志(`logs_2.sqlite` 拷贝):09-13 00:00 `Phase 2 no changes`;**09-14 19:00 又一次 `skipping memories startup because Codex rate limits are below the configured threshold`** ⇒ 额度闸今天再次生效,验收窗口要把它当成可见原因,不当成设计失败。
- 运行时:`~/.flywheel/state/codex-lead/mufasa-lead/thread-id`(36 B)是唯一线程真相;`codex-lead-tui-runtime.ts:652-677 ensureThread` 每代都 `thread/resume` 重钉;`brain/lifecycle.jsonl` 显示 09-03 以来每天 1–5 次 generation 重建(daemon WS 掉线),`DaemonConnectionSupervisor.onLoss` 负责重建;线程 id 一变,`ensureTuiHealthy`(`:535-551`)无条件杀旧 pane、以 `codex resume --remote … <newThreadId>` 重开(`tui-window.ts:139-190`)。执行器/路由/心跳都按「每代绑定一个 threadId」写死(`CodexTurnExecutor.ts:78-85`、`LeadInputRouter.ts:153-177`)。
- 持久化 pin:`config.toml` 已有 `[features] memories=true` + `[memories] dedicated_tools=true`;`codex-lead-tui-home.sh:458-545 ensure_memory_pins` **对漂移 fail-close**(`Fix … manually`)。

### 2.3 Infra Bot(`~/.codex-infra-bot`,同一 TUI 运行时)

- 线程 `019f4969-0cbc-74c0-b134-34822c57d2ad`:07-10 建,最后更新 08-20;`journal.db` 共 34 行,最后一行 08-20;`memories_1.sqlite` `jobs` 0 行。
- launchd `com.flywheel.lead.flywheel-codex-infra-bot-lead` 现在有 PID(30640),日志 `CodexLeadRuntime started { threadId: '019f4969…' }` ⇒ FLY-2360 看到的崩溃循环已不在;但 14 天内零入站 ⇒ 没有 turn 就没有 startup,**无从产生记忆,不是本单要修的**。它跑的是同一个 `codex-lead-tui-runtime`,本单的轮换对它同样生效(一旦有 turn)。

### 2.4 Raya —— 两个家,只认标准那个(Lead 裁定后更正)

- 审计时看到的在用家是 legacy 壳:`~/.flywheel/raya/raya.env` `RAYA_CODEX_HOME=/Users/xiaorongli/.flywheel/raya/codex-home`,`com.xrli.raya.brain`(raya 仓 `apps/brain/dist/cli.js run`)在用它;vscode 线程 197 条(08-26→09-08,每条 Discord 消息一条新线程),`config.toml` 无 `[features]`/`[memories]`,`memories/` 不存在。**Lead 裁定(`8b57c58e`):这个壳今天退役,不以它为设计对象。**
- 标准 Codex Lead 的家 = `~/.codex-raya`(`derive_codex_lead_home raya`),今天切换;审计时它只有 `packages/` `tmp/`。FLY-2357 evidence:「Raya 首次 activation 继承 pin」——即 `codex-lead-tui-home.sh:458-545 ensure_memory_pins` 会在首次启动时写 `[features] memories=true` + `[memories] dedicated_tools=true`。
- 记忆权威:FLY-2131 plan §2.4 钉死 Raya 的工作记忆 = `RAYA_MEMORY_FILE`(`~/.flywheel/raya/memory/MEMORY.md`,git 仓,1,837 B),经 `FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES` 接回 system prompt,并「否决 CODEX_HOME 隐式记忆当主承载」。Lead 本次重申:Raya keeps her own MEMORY.md,不为她加 Codex 记忆 pin。
- ⇒ 本单:不为 Raya 设计、不量 Raya;切到标准运行时后,线程轮换是运行时通用行为(她也是单线程常驻),不特判、不豁免。pin 是否要在 launcher 侧对她豁免,已另发非阻塞核对(question `3c0d79c9`),默认不改 launcher。

### 2.5 「Flywheel 自己的 Lead 记忆(agent-memory)」到底是什么

- Claude Lead:`~/.claude/agent-memory/<leadId>/MEMORY.md`,Claude Code 原生自动记忆写入,`scripts/lead-memory/`(sync/arrival-check launchd)把 12 个 Lead 文件夹同步到私有仓。**没有 Codex Lead 的文件夹**(Mufasa / Infra Bot 不在其中);Claude Code 的写入器不会替 Codex Lead 写。
- Codex Lead 的等价物只有一个先例:Raya(FLY-2131)——模型自己用文件工具维护 `MEMORY.md`,`FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES` 在每代重建时把它接回 system prompt。这条路对 Mufasa 可行(persona 在 `~/Dev/growth/.lead/mufasa-lead/identity.md`,writable root 就是 `~/Dev/growth`),但它是「模型手写、无蒸馏、无审阅」,与 founder 2026-09-01 的方案 D「身份记忆用 Codex 本来就有的机制」相悖。

## 3. 设计选项

### O1 什么都不做
Mufasa / Infra Bot 永远 0 候选。否决。

### O2 轮换 = `thread/fork`(旧线程全文带到新线程)
连续性最好,但 §2.1 实测 legacy 源线程 ⇒ `ForkPersistence::Copied`:新线程 rollout = 整份旧历史 + 新对话。第 N 次轮换后旧线程的 rollout 含 N 代家谱 ⇒ 每次 stage1 都重新消化整条家谱(保头保尾丢中间),摘要重复、成本随代数增长;`thread/fork` 又没有 `historyMode` 可切到分页引用模式。**否决。**

### O3 轮换 = fresh `thread/start` + 有上限的交接材料(推荐;**R1 后交接改为确定性 rollout 摘录,零模型 turn**,见 plan v2 §3.3)
到期且空闲时:在旧线程跑**一轮固定提示**「写一张 ≤N 字的交接便签(未完成事项、近期事实、founder 现在关心什么)」,把便签作为新线程的 `developerInstructions` 起一条全新线程,`thread-id` 指向新线程,旧线程**原地不动**(不归档、不改 `memory_mode`)。旧线程 `updated_at` 从此冻结,≥6h 后成为候选,下一次 `summary_due` 触发的 startup 认领它做 stage1;phase2 在 6h 冷却外时把它并进 `memory_summary.md`;新线程的下一个「新上下文窗口」(线程开始/下次压缩)读到。
- 连续性:便签 + `memory_summary.md`。主线程本来 4 次压缩、36.9M 累计 token,连续性早就是摘要级;便签把「今天在聊什么」显式带过去。
- 蒸馏输入干净:每条线程 = 一个周期的对话,stage1 输入 ≈ 一周量(§研究算过 ≈ 13 万 token < 70% × 258,400 ≈ 18 万),不重复。
- 实现落在已有缝:线程 id 的唯一真相仍是 `thread-id` 文件;「线程变了 ⇒ TUI pane 重开」「每代重钉」「journal 恢复」都是现成语义;新增的只是「何时到期」「交接一轮」「起新线程」「写回执」。

### O4 退出 Codex 自动记忆(`[features] memories=false`)+ Flywheel 自有 MEMORY.md
对 Mufasa:与方案 D 相悖;FLY-2357 的 `ensure_memory_pins` 对 `memories≠true` fail-close,要先改门;模型手写笔记无蒸馏、无审阅、两套真相。**对 Mufasa 否决;对 Raya 是既成事实(FLY-2131),不动。**

### O5 主线程不动,定期 fork 一条「只为蒸馏」的快照分支
主线程零打扰,但每个快照 = 整份历史复制(同 O2),每次都重复消化整条家谱。否决。

### O6 复用 FLY-2460 的准入蒸馏通道(触发线程 + `min_rollout_idle_hours=1` 覆盖)
可把「轮换 → 出摘要」从 ≤6h 压到 ≤1h。Mufasa 每天 ≥4 次自然 startup 已够,不加通道;若以后要更快,它是下一步,不是本单。

### O7 调四道闸 / 线程级覆盖 `memories.*`
FLY-2360 已证明零效果;本单不动任何闸、不动家级 config。

## 4. 推荐与要落的合同

- **Mufasa、Infra Bot(同一 TUI 运行时)= O3。** 到期规则、空闲判定、交接便签上限、失败转移、回执、回滚开关在 plan 里逐条钉死。
- **Raya = 「按设计不产生 rollout_summary;权威记忆是她自己的 MEMORY.md」**(Lead 裁定 `8b57c58e`),记入 PRD 补充;切到标准运行时后轮换对她同样生效但不特判、不验收。
- **PRD 补充(FLY-2119 §5.7)**:常驻 Lead 的线程形态是记忆能否累积的前置条件;逐 Lead 写清「走哪条路 + 验收」。FLY-2119 的 PRD 在 PR #1024(未合入),补充文写在本文件夹,待 #1024 落地后原样并入。

## 5. 边界与不做

- 不改 Codex 二进制、不改任何家的 `config.toml`、不动四道闸、不开 `dedicated_tools` 之外的任何新 pin。
- 不归档、不删除、不改 `memory_mode` 任何旧线程(候选 SQL 要求 `archived=0`、`memory_mode='enabled'`)。
- 不碰 legacy 的 `~/.flywheel/raya/codex-home`(退役中)、不改 launcher 对 `~/.codex-raya` 的 pin 行为、不碰 `~/.codex`、`~/.codex-honeylemon`。
- 不加 Bridge 巡逻、不加管理台开关;不派工——本单产出设计与 PRD 补充,等 founder 排期。

## 6. 待 Lead / founder 决定(非阻塞,已按默认继续)

1. ~~Raya 是否改为在真实家开 Codex 记忆~~ 已裁定(`8b57c58e`):不开,保留她的 MEMORY.md。剩余核对:launcher 是否要对她豁免 FLY-2357 pin(`3c0d79c9`),默认不改。
2. 轮换周期常量取 7 天(§研究给算式);founder 若想更细(按天),只改一个常量。
