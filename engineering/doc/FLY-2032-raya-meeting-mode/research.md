# FLY-2032 会议模式(C):骨架 + 会里交互 — 调研(重做 v2)
Issue: FLY-2032 (https://linear.app/geoforge3d/issue/FLY-2032/rayav4-会议模式c骨架-会里交互codex-原生先行)
日期: 2026-08-28
基于: exploration.md(重做 v2)

> 本文只放**可核的事实与出处**;判断在 `exploration.md`,方案与对照表在 `plan.md`。
> 纪律:本轮**只读**。未改生产代码/配置/plist,未启动服务,未跑消耗 realtime 余额的探针。
> 成色:✅ 实测或逐行核过 · 📖 读到的(源码/文档) · ⬜ 未验。
> **Codex 源码 = tag `rust-v0.150.1`**(本轮 `git fetch https://github.com/openai/codex.git tag rust-v0.150.1` 进 `~/Dev/codex`,与生产钉死的二进制同版;所有行号都指该 tag)。⚠️ 旧 research(head `f33e2628d`)读的是二进制 strings;本轮升级为源码逐行,冲突处以本文为准。

---

## 0. Founder 决策事实（2026-08-28，经 Lead 原话转达）

| 决策 | 原话 / 运行含义 | 状态 |
|---|---|---|
| C0 进程形态 | 「可能会是形态 S。主要是现在的大多数 Lead 还是用 Claude Code,那它们不管怎么样,都是需要一个新的语音容器进程,但是它会需要有 Lead 的身份记忆和能力」⇒ 每场派生新语音容器，profile 装载被点名 Lead 的身份、记忆、cwd 与 writable roots | ✅ founder 拍板 |
| C1 R-13 档位 | 「探照灯就够了」⇒ 核对并留证/显示，不阻断动作 | ✅ founder 拍板 |
| 排会可见性与唯一入口 | 任何成功排会必须同时形成共享公告与被点名 Lead 会话通知；Lead 安全裁定为同一条 Discord 卡 + 真 `@` + thread，走现有 untrusted ingress；不得给 Raya 开 Bridge mailbox 写入口。Founder 终裁只实现 founder→Raya 精确命令；roundtable 手发消息不识别、不解析、不接管 | ✅ founder 硬要求 + Lead 安全裁定 + founder 终裁 |

这三条是实现输入，不是本文推断。形态 R 的 P-N6 不再执行；形态 S 的 P-N1/P-N3 与探照灯 P-N4 转为当前验收项。

---

## 1. Codex 0.150.1 源码事实 —— 进程/身份/会话模型(本轮逐行读)

### 1.1 身份可以是 thread 级参数,不必是进程级常量

`app-server-protocol/src/protocol/v2/thread.rs:62 ThreadStartParams` 支持**逐 thread** 传入:
`cwd` · `base_instructions` · `developer_instructions` · `personality` · `sandbox` · `approval_policy` · `permissions` · `config`(HashMap 覆写)· `model` · `ephemeral` · `runtime_workspace_roots`(experimental)。📖

⇒ **一个 app-server 进程可以同时承载不同 cwd / 不同指令 / 不同沙箱能力的多个 thread。**「lead 身份不硬绑进程」在源码层面成立。

### 1.2 进程级绑死的只有 CODEX_HOME

一个 app-server 进程 = 一个 CODEX_HOME:auth(`login/src/auth/storage.rs` 的 `get_auth_file(codex_home)`)· `config.toml` · **thread store / rollout 目录**(`thread-store/src/local/helpers.rs`:rollout 落 `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)`,archive 在 `ARCHIVED_SESSIONS_SUBDIR`)。📖

⚠️ **auth.json 写入无锁、非原子**(`storage.rs:206-223`:`truncate+write` 原地写,无 flock、无 tempfile+rename)⇒ **多个进程共享同一 CODEX_HOME 并发刷新 token 会互相覆盖**(`refresh_token_reused` 事故族的结构成因)。📖

### 1.3 realtime 会话:每 thread 至多一个,活在进程内存里

- `RealtimeConversationManager` 是 `Session`(=一个 thread)的字段(`core/src/session/session.rs:62,1488`),内部 `state: Mutex<Option<ConversationState>>` ⇒ **一个 thread 同时至多一个 realtime 会话;一个进程里多个 thread 原则上可各开一个**(v1 用不到,记档)。📖
- ConversationState 持有 WS 连接与任务句柄 ⇒ **进程死 = 语音会话死**,两种进程形态在这一点上同命。📖

### 1.4 🔴 纯语音轮**不写** thread 历史/rollout;handoff 的 backend 轮写

- `core/src/realtime_conversation.rs`(2,544 行)全文 **grep `history|rollout|record` = 0 命中** ⇒ 语音一来一回(她说/它答,无交办)**不落任何持久历史**。✅(阴性证据 + 下一条阳性对照)
- handoff(交办)走 Session 的常规 turn(输出经 `handoff_out` 回流语音会话,`realtime_conversation.rs:783-…`),常规 turn 由既有 rollout 机制落盘。📖
- ⇒ **解释了 2074 的 P2**(跨进程 `thread/resume` 对纯 realtime thread 报 `no rollout found`):不是 resume 坏了,是**没有东西可 resume**。
- ⇒ 对两种进程形态的含义相同:**会中断电,语音内容都只能靠我们自己的 evidence transcript 兜**(raya 已落 `realtime_transcript` evidence);差别只在 backend 交办轮(常驻形态落在 lead 本体 thread 里,派生形态落在会议容器的 thread 里)。

### 1.5 逐字通道与自动启动上下文(全部在 `realtime_conversation.rs` / `realtime_context.rs`)

| 事实 | 出处 | 成色 |
|---|---|---|
| `realtime_start_instructions` / `realtime_end_instructions` 上限 = **8,192 估算 token**(`approx_token_count`,≈4 bytes/token)——⚠️ **修正旧口径「8,192 字符」**:限的是估算 token,不是字符 | `realtime_conversation.rs:99,1315-1333` | 📖 |
| 自动 startup context 预算 **5,300 token**,可用 `include_startup_context:false` 关掉 | `:95,1339-1347`;`ThreadRealtimeStartParams.include_startup_context` | 📖 |
| startup context 构成:**Current Thread 1,200** + **Recent Work 2,200** + **Workspace map 1,600** + Notes 300;Current Thread 取**本 thread 内存中的历史**;Recent Work 取 **CODEX_HOME thread store 的近期 threads(≤40)**——**跨进程、来自磁盘**;Workspace 扫 cwd | `realtime_context.rs:33-41,59-…` | 📖 |
| `initial_items`(带角色的初始条目,≤128 条 / 共 ≤8,192 est-token)**仅 v3;v2 直接拒**(`initial realtime items require realtime v3`) | `realtime_conversation.rs:1356-1381` | 📖 |
| `prompt` 参数与 startup context 合并进 session `instructions` | `:1335-1355` | 📖 |
| v1/v2 默认模型 `gpt-realtime-1.5`;v3 `gpt-live-1-codex`;`model`/`voice`/`version` 均可逐会话覆写 | `:104-105,1383-1390`;StartParams | 📖 |
| `thread/realtime/appendText {text, role}`,role ∈ **user(默认)/ developer / assistant**;`text_in` 无版本门槛,role=user 自动加 `[USER] ` 前缀,developer/assistant 原样进 | `v2/realtime.rs:319-330`;`protocol.rs:459`;`realtime_conversation.rs:758-781` | 📖 ⇒ **存在一条「不冒充她」的会话内系统通道**;它在 v2 上会不会触发回合 = 待真机探针(P-M1 升级版) |
| `appendSpeech {text}` = speakable text(它当成说给它的话);`thread/realtime/stop` EXPERIMENTAL 存在 | `v2/realtime.rs:336-359` | 📖 |
| AVAS(webrtc call 形态)拒 v2:`AVAS realtime calls require realtime v1 or v3` —— FLY-2021 那条 alpha 报错的出处,与「websocket transport 的 v2」无关 | `realtime_conversation.rs:1292-1307` | 📖 |

### 1.6 对「常驻 vs 按会派生」的直接推论(事实层,不是选边)

| 维度 | 常驻(附着 lead 本体 thread) | 按会派生(会议容器进程) |
|---|---|---|
| Current Thread 段(1,200 tok) | lead 本体 thread 的活历史自动进 | fresh thread ⇒ 空 |
| Recent Work 段(2,200 tok) | lead 本体 CODEX_HOME 的近期 threads | 取决于容器用哪个 CODEX_HOME。⚠️ **该段每个 thread 只含首条用户消息**(`realtime_context.rs:539-565`,Codex R1 复核),纯语音会议不产生可用条目 ⇒ **不构成「历史会议记忆」**,续会内容只认显式简报与会议存档 |
| 语音轮持久化 | 都不落(1.4);断电都靠 evidence transcript 兜 | 同左 |
| backend 交办轮落盘处 | lead 本体 thread rollout(它「本人」的历史) | 会议容器 thread rollout |
| 会话与进程同命 | lead 本体进程死 = 会死,**且反过来:会里事故可能伤到 lead 本体** | 容器死 = 会死,lead 本体无恙 |
| auth 并发 | 附着即复用本体 auth,无新增并发写 | 容器若共享某个在用的 CODEX_HOME ⇒ 1.2 的 token 覆写风险;独立 home ⇒ 无 |

## 2. 生产实测(2026-08-28,只读)

| 事实 | 数 | 出处 |
|---|---|---|
| 现役常驻 codex `app-server` 进程 RSS | **89 / 92 / 181 MB**(infra-bot / mufasa / flywheel lead 各一) | `ps aux`,2026-08-28 |
| 常驻 TUI(`codex resume --remote`)RSS | 48–92 MB | 同上 |
| raya voice 按需容器上一次真跑(r6) | 07:41:43Z 她问 → 07:42:00Z 答对(去 GitHub 查了 PR)→ 07:42:03Z SIGTERM exit0;`sent=1423 / voice=258` | `~/.flywheel/raya/data/state/voice-evidence/events.jsonl` ✅ n=1 |
| **按需容器冷启动时延(marker→进房→realtime started)** | ⬜ **未量化** —— evidence 里没有 boot 里程碑事件 | 交实现节点探针(P-N1);⛔ 不编数 |
| flywheel leads 的形态 | 大多数是 Claude Code;仅少数走 codex-app-server(as-of 2026-08-19 为 16 中 2) | FLY-1851 research §6 ✅ |
| 「Claude Lead 坐在语音接缝另一头」 | **零证据,从未验过**(Q-10) | PRD §14 ✅ |

## 3. raya 仓与旧实现现状(停驻,只读参考)

| 项 | 事实 |
|---|---|
| `origin/main` | `b7abff4`(2029 foundation + 2074 voice 已合) |
| 分支 `fly-2032-raya-meeting` | **4 个 parked commits @ `ba9165f`,工作区干净**:3 个实现提交(contracts/meeting.ts 878 行 + brain parse 70 行 + reconciliation seams)+ 1 个 Lead rescue commit(封存 founder 叫停时未提交的 1046 行在飞产物,commit 信息标明仅供参考)。**保持停驻** |
| 2074 已合入的可复用缝 | `voice-mode.requested` marker 合同 · `VoiceSupervisor`(launchctl kickstart)· Coordinator 纯 reducer(RoomIdle/Warming/Live/…)· `announce` 状态行 · EvidenceLog · `humanPresenceGraceMs` |
| 身份硬绑点(本轮逐个指认) | `apps/voice/src/cli.ts startInstructions()`(单一默认中文一句)· `config.ts`(CODEX_HOME/workspace 单值必填)· `IDENTITY.md` 单份 · 状态行第一人称 Raya |
| 2097(进/退命令化)| workflow 在 implement 节点推进中(与本单并行,rebase 联调) |

## 4. FLY-1851 侧事实(引用,不复述)

- PRD v2.0 全文 + 六轮评审 + final-review 本轮已通读;六条成色与「读证据先读这一条」在 PRD 第一屏。
- 会议机器旧代码(七月 huddle,Gemini 底座)她已定「完全重新来写」;all-listen 判死数字只属于 Gemini(FLY-1851 research §3/§4)。
- 每场一 issue / notes / 可互动 HTML = FLY-2033;会前简报内容 = FLY-2030;这两个接口面本单只留文件合同。

## 5. 未验清单(交实现节点;每条写「不成立时改哪」)

| # | 要验的 | 怎么验 | 不成立时 |
|---|---|---|---|
| P-N1 | 按需容器冷启动时延(marker→DiscordReady→realtime started 三个里程碑)。⚠️ **S 形态专属,仅 C0=S 后执行**(R1 #4) | 容器加 boot 里程碑 evidence,真跑一次量 | 只影响对照表数字,不影响结构 |
| P-N2 | `appendText role=developer` 在 v2 上的行为(注入不触发回合?触发?被念出来?) | 真 app-server:start 后各发一次,对照 `outputAudio/delta` 与 transcript | 开场触发退回 appendSpeech(旧 P-M1) |
| P-N3 | 换 leadId 后 `thread/start{cwd, baseInstructions, sandbox}` 逐项生效(它自称、能写的根、AGENTS 语境) | 两个 profile 各起一场,看 backend 交办的实际可写范围与自称 | 若 cwd/沙箱覆写有坑 ⇒ 退回每 lead 独立进程配置 |
| P-N4 | R-13 探照灯:含 FLY-**** 的指令,它念不念、念的是不是转写原文 | 真会 + 核对器(沿 PRD §5.3 完整性要求) | 指令加硬;仍不成立 ⇒ 回她 |
| P-N5 | 会中她掉线 < 会议 grace 回来,同一 thread 记得前半场 | 真会退出再进 | 记「会中失忆」给 2030 |
| P-N6 | 常驻附着形态可行性(若她选 R):对一个真 Codex 常驻 lead 的活 thread 发 `thread/realtime/start` | 取一个非生产 app-server 实验 | R 形态降级为「仅对 Codex lead、且需改造其宿主」如实回报 |

## 6. 会过期的结论

| 结论 | as-of | 重核 |
|---|---|---|
| 源码事实读自 `rust-v0.150.1`;生产二进制 = 0.150.1 | 2026-08-28 | `codex --version`;`git -C ~/Dev/codex tag -l rust-v0.150.1` |
| 常驻 app-server RSS 89–181MB(n=3) | 2026-08-28 | `ps aux \| grep "codex app-server"` |
| leads 16 中 2 走 codex-app-server | **2026-08-19**(可能已变) | `~/.flywheel/projects.json` 数一遍 |
| 分支停驻状态(4 parked commits @ `ba9165f`,工作区干净) | 2026-08-28 | `git -C ~/.flywheel/raya/worktrees/raya-FLY-2032 log --oneline -5 && git status` |
| 验收房 = voice-test-1 | 2026-08-27(`316aff4a`) | founder/Lead 新指令为准 |
