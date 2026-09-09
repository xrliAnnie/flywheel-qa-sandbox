# FLY-2445 Raya 标准 Lead — 删留清单
Issue: FLY-2445 (https://linear.app/geoforge3d/issue/FLY-2445/raya-raya-迁为标准-codex-lead注册进-flywheel走-mailboxraya-仓删掉-ingest-名册)
日期: 2026-09-08
基于: research.md

## 1. 基线、范围与判读方法

这是实施前的逐文件处置清单，不是已经删除、已迁移或已部署的回执。Raya 仓为 `xrliAnnie/raya`；本页全部 Raya 路径相对 `~/.flywheel/raya/code`。2026-09-08 只读核实 main 为 clean `0f77e9772176c973eb1e09548b00c05ae550ef32`；该提交恰有 **274 个 tracked 文件，其中 177 个 .ts/.mjs 文件**。附录 A 从该 checkout 的 `git ls-files` 生成，一文件一行，包含源码、测试、资源和历史文档；不要把 274 误写成 274 个源程序。

| 来源 | 精确 SHA | 使用方式 |
|---|---|---|
| Raya main | `0f77e9772176c973eb1e09548b00c05ae550ef32` | 274 文件基线；⑤提取原语音规则/资产的 Git 引用 |
| 2379 旧壳文字分支 | `34c879475dfe05253d2d52b409ccd14f107fe9b2` | `origin/fly-2379-raya-text-chat`；main 没有 text-chat，不能写成生产已运行 |
| 2380 日报分支 | `41b26fa4e8baaddf076a33e7291772de979ffb8c` | 本地 `fly-2380-raya-daily-report`；只提取业务 |
| 2381 统管分支 | `f1905cdaeb5747445e791649741fcdf20069b5c3` | 本地 `fly-2381-raya-brain-drift`；含旧文字壳，不能整分支合入 |
| FLY-2439 v3 §C | Flywheel `engineering/doc/FLY-2439-lead-paths-uml/build-v3.py:251–268` | 原文明确“归类推演、未验证可行性”；本清单补齐消费者和处置 |

目标目录是 Raya 的 `packages/cos/`：CoS 即统管各项目的业务。该包只拥有 persona 消费、summaries 吸收、追问、会议、日报和统管状态；通过平台提供的能力收取已投递事件、发出业务请求。它不创建 Discord 客户端、不驱动 Codex、不安装或监督常驻进程、不维护另一份 Lead 名册。旧 `apps/brain/` 和 `apps/voice/` 从活动树删除；业务提取并通过回归验证后才删除来源。⑤从上述 Git SHA 提取语音专属资产与规则，活动 Raya 树不另设 archive/legacy 可执行目录保存旧壳。

分类：**保留**＝原路径继续存在；**改写**＝去掉旧入口/依赖；**提取后删**＝业务移动到明示目标，旧路径删除；**删除·⑤引用**＝从活动树删除，⑤可按已固定 SHA 提取；**删除**＝旧驱动/安装器/探针及对应测试退役；**历史保留**＝审计文档或纯数据，不可被运行入口加载。附录的测试行与对应行为同步处理，不能仅为了“有测试”保留私有驱动。

## 2. 生产消费者闭包

| 来源与行号 | 保留的业务 | 必须删除/替换的基础设施及消费者 |
|---|---|---|
| `apps/brain/src/cli.ts:142–250` | 将 metrics/meeting 等独立业务入口提取到 `packages/cos/src/cli.ts` | `:154` voice gateway、`:175` profile loader、`:207` meeting gateway、`:237` runBrain 均不保留 |
| `runtime.ts:190–371`；`metrics.ts:1–293` | 指标解析、历史报表及采样函数提取到 cos metrics | 删除 PID 所有权、常驻循环、`postDiscordAlert:279` 私发；移除旧 brainAlive/voice 进程命令假设 |
| `installer.ts:15–59`；`launchd.ts`；`scripts/install-launchd.mjs` | 无独立安装器业务 | `installer:22–37` 同时生成 brain/voice 两个 job；二者均退役，不能只删 brain 的 plist |
| `preflight.ts:41–111` | 验收条件迁入通用 Lead 注册/部署验证 | `:101` 自己 spawn app-server；Discord identity REST；及专用 Codex preflight 均删除 |
| `config.ts:47–65,143–279`；`env.ts` | persona、memory、CoS 状态/日历选项；私密配置不暴露给模型 | 删除 bot/daemon/launchd/重复模型驱动配置；从 cos options 输入平台验证后的配置 |
| `voice-mode.ts:38–369` | 进入/退出意图、期望状态与停止语义进入 cos voice-intent | `:373–581` launchctl supervisor、`:612+` gateway 删除；⑤能力未就绪时明确返回 unavailable，不启动旧 voice |
| `meeting.ts:155–872` | 解析、安排/改期/取消、状态、通知对账、日历警告恢复 | 注入 canonical Lead 目录、mailbox 和 Bridge 能力；不使用本地 roster |
| `meeting.ts:1013–1064,1086–1230` | 保留通知业务回执模型 | 删除 gateway、Discord REST announcer/publisher、私有建线程实现；`:332–340` 原来把同一 Discord messageId 当 lead-mailbox 回执，必须改为分别验证真实队列与出站回执 |
| `meeting-calendar.ts:11–235+` | 日历投影保留到 cos；`:110` argument-array execFile；`:162` 用 meeting UUID 查重；保存 eventId | 日历不是 Discord/Codex 驱动；保留参数验证、失败披露以及不阻断本地会议状态的规则 |
| `packages/contracts/src/meeting.ts:60–82,323–490` | 类型与规范化规则按 canonical 目录调整 | `:431–459` 读取 `leads/<id>/profile.json` 的本地权威删除；所有名字解析消费者一起改 |
| 同文件 `:18–58,84–148,494–1282` | meeting、briefing、notifications、calendar、voice-signal、原子写与 schema 迁到 cos contracts | `:905+` instruction assembly 改用中央目录读模型，不自行扩大 workspace |
| `apps/voice/src/meeting-context.ts:37–58` | 会议上下文的 Lead/记忆/权限选择规则提取到 cos meeting-context | 原 loader、private profile 和 own voice runtime wiring 删除 |
| `apps/voice/src/codex/AppServerClient.ts:91–98`；`CodexLeg.ts` | ⑤从固定 SHA 提取需要的协议规则 | 私有 spawn/thread/turn 驱动全删；直接消费者 `cli.ts`、`preflight.ts`、`runtime.ts`，间接消费者 RealtimeTransport/Tap、Speaker、readback、VoiceTextMirror 全部纳入 |
| `apps/voice/src/discord/DiscordAdapter.ts`、VoiceRoom、VoiceTextMirror | ⑤可提取语音 I/O 规则 | SDK 连接与文本发送移出 Raya 活动树；不是仅删一个 import |
| `apps/voice/src/discord/RoomText.ts:57–103` | 路由授权要求留在平台接口与业务测试 | 第二份名册 `voice-leads.json` 删除；消费者 runtime、OutboxWatcher、ReadbackGate、ShipGateFlow 与 `config.ts:649` 同时调整 |
| `apps/voice/src/security/ApprovalCredential.ts`、approval/*、actions/* | founder 身份、当前会话归属、readback、receipt、拒读凭据的规则作为⑤验收输入 | 不能因为旧文件移除就把 full-access Lead 视作有 ship/credential 权限；平台拒读验证先满足才能开放相应能力 |
| `packages/contracts/src/{codex-session,integration-contract,runtime-env}.ts` | CoS 的纯状态/验证最小子集迁到 cos | 删除独立模型/RPC/env/PID/entrypoint 权威；voice 纯规则由⑤按 SHA 提取 |
| package manifests、root scripts、README、tsconfig、lockfile | 只构建/运行 cos 包 | 移除 brain/voice 包与 Discord/Codex/launchd 可运行依赖、旧安装说明；清理发布输出及旧可执行 probes |

纯 voice 音频/过滤/朗读/退出/收件处理不在④实现新音频能力；其现有源、测试、模型和 fixture 在附录标为“删除·⑤引用”。不是宣称语音已经能在新 host 工作。会议业务及状态不能随 voice 一起丢弃；⑤能力可用后依照 cos 接口接回，具体上线条件见 plan.md。

## 3. 名册：逐字段迁移，禁止静默丢字段

FLY-2439 `research.md:515` 所说的**四个额外字段精确为 `identityPath / memoryPaths / workspaceCwd / writableRoots`**，不是任选四项。Raya 当前声明在 `packages/contracts/src/meeting.ts:60–70`；Flywheel 中央 `ProjectConfig.ts:12+` 提供 agentId/botUserId 等，`:194` 已有 voice。

| 旧字段 | 新的权威与迁移规则 | 直接消费者/负面约束 |
|---|---|---|
| leadId | 中央 `projectName + agentId` 身份，转换有明确唯一映射；旧持久状态保留原 id 的迁移记录 | meeting、ask、summary；不得拿 displayName 当键 |
| discordUserId | 中央 Lead.botUserId | 精确回答者归属校验；不得从消息内容猜身份 |
| displayName | 中央受验证的显示元数据（若无现成字段就扩展同一 Lead 行） | 会议卡、日历标题、中文回复；改名不迁移稳定 id |
| aliases | 中央同一行受验证显示元数据 | NFKC/大小写规范化，别名碰撞 fail-closed；不能生成第二份可编辑 roster |
| workspaceCwd ★ | 中央 Lead 元数据的显式工作目录或经过等价证明的 projectRoot 派生值 | 旧 profile 可能是项目子目录；**不能不核实就无条件等同 projectRoot** |
| identityPath ★ | 中央同一 Lead 行的受验证受保护 persona 路径 | 文件存在、非空、只读；模型 writable root 不得包含它 |
| memoryPaths ★ | 中央同一 Lead 行的受验证记忆文件集合 | 保留逐文件列表与顺序；不存在/无权限须披露，不自动补空文件 |
| writableRoots ★ | 从中央 profile 的受验证权限边界取得，记录旧→新逐项映射 | 不能被 profile 导入扩大；cwd 在允许根内、state/secret/identity 不可重叠 |
| voice | 中央已存在的 voice 元数据 | 原值/null/default 映射明确；不同声线提供方格式不兼容时不得静默冒充 |
| schemaVersion | 导入 schema 版本及逐条校验记录 | 未知字段/版本 fail-closed；旧文件只读存证，不继续作权威 |

默认 `~/.flywheel/raya/data/state/leads/` 只读核到 14 个目录：tidal-echo-cos-lead、tidal-echo-content-lead、flywheel-eng-lead、rafiki-lead、sub-lead、flywheel-cos-lead、mufasa-lead、product-lead、flywheel-product-lead、belle-lead、reflection-lead、cos-lead、ops-lead、joycon-lead。名册实际记录迁移需要按当前配置再次校验；这个目录清单不证明字段已迁移。默认处 `voice-leads.json` 不存在，也不能因此略过其代码消费者或其他配置路径。

## 4. 业务和持久状态必须保留

| 状态/业务 | 边界与迁移要求 |
|---|---|
| persona 和 MEMORY | `IDENTITY.md:1–103` 保留；受保护 identity 与独立版本 memory 仓不互相覆盖。旧 persona 的空轮静默与新 summary rider 的每轮对账冲突，采用新版 rider 并修正 prompt |
| summaries | `summaries/`、未读 PR、原 Git 历史继续在 xrliAnnie/raya；读懂才 merge。项目/Lead 均须注册为 raya，`summary.ts:86–87` 对两者精确检查 |
| summary round ledger | `state/summary-merge-receipts.jsonl` 的 roundId、PR/head、posting/posted、report 和 memory provenance 原样对账；只有 `flywheel-comm summary merge` 窄授权，不扩为代码 merge |
| meetings | `meeting.json`、`meeting-events.jsonl`、`meetings/<UUID>/{meeting.json,briefing.md,notifications.json,calendar.json,voice-signal.json}`；保留 UUID、状态和日历 eventId，通知 inbox/Discord 回执分开 |
| 2379 asks | 保留 `posting/posted/answer_observed/delivered/expired/failed`、askId、收件人/source/answer/message 回执；posting 外部副作用先对账，答案必须匹配真实发信 Lead |
| old thread/PID | `text-chat/thread.json`、voice-session 的 threadId/processGeneration、PID 只读存证；**不导入成标准 Lead 活跃会话** |
| voice business state | voice inbox items/acks、filters/preferences、action receipts、hold history 保存到明确所有者；不开启旧独立进程作为恢复捷径 |
| 日报和统管 | 2380 `daily-report/<date>.json`、body/hash/provenance；2381 goals 和 `portfolio/{patrol-state.json,patrols.jsonl,latest.json,snapshots/*}` 保留，⑥按分支 SHA 提取 |
| 历史指标 | resource/context JSONL 保留读取能力，新的 host 健康不能沿用旧 PID 存活作成功证据 |

默认 state 由 `brain/config.ts:57–59` 取 `<RAYA_HOME>/data/state`。只读检查该处确认 voice-session.json 和上述 14 个目录存在；其他状态路径默认处未见，不等于运行配置的其他路径没有。实施以实际非秘密路径配置清点，不读/复制凭据内容。本设计没有读取被禁止的 approval-credential。

## 5. 2379 / 2380 / 2381 的提取标准

- 2379 `text-chat/controller.ts:197–797` 的 queue/busy/replay/thread/turn/output 驱动删除；`:798–1252` 的问 Lead 生命周期提取到 cos asks，④保留状态机并返回transport unavailable；未来由共享Lead事件/Bridge回执驱动，删除Discord answer poller。store 的 thread 状态 `:15–21,84–134` 删除，asks 原子状态 `:23–81,136–194` 提取。secret-isolation `:59–68` 的“memory 可读、env 拒读”要求转到平台验证，不能取消安全条件。
- 2380 collector 保留 pinned-main summaries、来源与 Judgment 校验；controller 保留日期状态机/恢复/幂等，替换 `DailyReportTextChat:77`、`DailyReportDiscordRest:89`；generator 的 `thread/start:224`、`turn/start:264` 删除，生成工作成为标准 Lead 已投递业务轮次。codex-config 不导入。repo-writer/storage/contracts 保留。
- 2381 portfolio 的 goals、采样、evidence gate、patrol 状态和 rendering 保留；`patrol.ts:10,26,262,345` 对旧 SystemTurnRequest/submitSystemTurn/sendPlain 的依赖替换。采样不另建 Lead 名册，使用中央只读目录。
- 附录 B 逐一列出各分支相对共同基线的变更；新增行是**分支独有路径**，修改行是**待审覆盖层**。同一路径可在不同分支重复出现，不代表要多次导入。实施前比对依赖最新 head，选择已审业务块，禁止整分支 merge 重新引入旧壳。

## 6. 可执行零驱动检查与历史例外

检查对象涵盖所有活动源码/脚本/测试、包清单、运行命令、构建入口、生成发布物，以及从这些入口可达的文件；不只扫描 apps/brain。迁移后 apps/brain 与 apps/voice 均不存在；旧 launchd 安装器和 probes 的可执行源不存在；packages/cos 中不能导入 Discord SDK、Codex RPC/child driver、本地 registry loader 或 launchctl。workspace 的 build/test/package 脚本不得恢复旧包，发布物不得含遗留 dist 入口。通用平台程序在 Flywheel 仓，不属于 Raya 的隐藏兼容壳。

附录 A 中“历史保留”的 engineering/doc 与 probes/evidence 仅含既有审计文档/图/数据，不可被 package scripts、运行代码或发布入口执行/导入。它们会出现旧术语，因此验收报告必须同时写清“历史检索仍有命中”和“活动程序/发布物零旧驱动”；不得声称字面全仓 grep 零结果。若任一历史文件变成运行依赖，该文件立即回到零驱动检查范围。逐路径覆盖与 imports/commands/产物检查一起做，不能仅靠正则未命中证明无旧路径。

## 7. v3补充的平台改动清单

Raya的274路径清单不变；以下新增/扩展均位于Flywheel，按plan.md批次A/E/F/G实施，不是Raya的新驱动：

| 平台文件 | v3明确处置 |
|---|---|
| `packages/flywheel-comm/src/lead-registry-cos-context.ts`（新增） | 只更新已有中央行cosContext的纯规划器；拒绝身份/角色改写，14行逐字段校验 |
| `packages/flywheel-comm/src/commands/lead-registry.ts`、`scripts/flywheel-lead.sh` | import-cos-context、受cfglock的CAS与pending/recover；add扩alert/roundtable参数 |
| `packages/flywheel-comm/src/summary-registry-migration.ts` | 复用③candidateRegistry写入；不让main仅写summaryRole的applyManifest冒充update；对应两文件失败恢复测试 |
| `scripts/lib/raya-standard-migration.sh`、`packages/teamlead/src/bin/seed-lead-inbound-cursor.ts`（新增） | 仅现有updater调用的一次性迁移工具；P4b标准cursor格式、摘要、原子写入/读回、无活writer；未知旧副作用阻止install |
| `scripts/__tests__/updater-raya-deploy.test.sh` | v1=22/v2=30完整键集pin；null失败证据、两SHA rollback_target；不得删pin避开漂移 |
| `scripts/lead-alert.sh`与既有相关tests | 审计并保持FLY-927统一落点优先级；注册显式per-lead字段作为无统一落点时的配置；测试有效告警到达 |
| `packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist` | 退役专用模板；生产是否存在现场检查，同label异构占用拒绝覆盖 |
| `scripts/package-onboard.sh`、`scripts/package-onboard-files.allow`、`scripts/converge-flywheel-bin.sh`与batch G整链夹具 | PO_SCRIPT_FILES与allowlist纳入shell helper，converge全部适用FILES包含lib/raya-standard-migration.sh；TS工具由src/bin编译为dist/bin/seed-lead-inbound-cursor.js，在隔离打包树验证存在且非symlink并可运行；已知窗口消息source id→真实mailbox delivery→回复，缺seed/未知副作用零install |

## 附录 A. main 全量 274 文件处置

以下表格由 `git ls-files` 生成；分类规则覆盖所有 274 项，未知路径会使生成失败。文件数包含二进制资产和文档。固定源 SHA 见 §1；所有“⑤引用”均指该 SHA 下相同路径。


| # | 基线路径 | 处置 | 目标/约束 |
|---:|---|---|---|
| 1 | `.gitignore` | 改写 | 仅保留 cos 构建/验证与业务依赖；清理旧包/产物入口 |
| 2 | `IDENTITY.md` | 提取后删 | `.lead/raya/identity.md` 成为唯一 persona 源；修正 summary 空轮规则，删除重复旧源 |
| 3 | `README.md` | 改写 | 标准 Lead 注册/CoS 用法，移除旧 launchd/app-server 操作入口 |
| 4 | `apps/brain/package.json` | 删除 | 旧 brain 包边界；新 packages/cos 自有 manifest/tsconfig |
| 5 | `apps/brain/src/cli.test.ts` | 提取后删 | `packages/cos/src/cli.test.ts`；仅独立业务命令；去掉常驻 run 与网关组合 |
| 6 | `apps/brain/src/cli.ts` | 提取后删 | `packages/cos/src/cli.ts`；仅独立业务命令；去掉常驻 run 与网关组合 |
| 7 | `apps/brain/src/config.test.ts` | 提取后删 | `packages/cos/src/options.test.ts`；仅 CoS 受验证配置，不带 bot/driver/daemon |
| 8 | `apps/brain/src/config.ts` | 提取后删 | `packages/cos/src/options.ts`；仅 CoS 受验证配置，不带 bot/driver/daemon |
| 9 | `apps/brain/src/env.ts` | 提取后删 | `packages/cos/src/env.ts`；只读业务配置接口；密钥由平台持有 |
| 10 | `apps/brain/src/installer.test.ts` | 删除 | 旧宿主/安装/驱动及对应测试；安全验收移到平台 |
| 11 | `apps/brain/src/installer.ts` | 删除 | 旧宿主/安装/驱动及对应测试；安全验收移到平台 |
| 12 | `apps/brain/src/launchd.test.ts` | 删除 | 旧宿主/安装/驱动及对应测试；安全验收移到平台 |
| 13 | `apps/brain/src/launchd.ts` | 删除 | 旧宿主/安装/驱动及对应测试；安全验收移到平台 |
| 14 | `apps/brain/src/meeting-calendar.test.ts` | 提取后删 | `packages/cos/src/meeting-calendar.test.ts`；保留 UUID 对账/日历投影与参数验证 |
| 15 | `apps/brain/src/meeting-calendar.ts` | 提取后删 | `packages/cos/src/meeting-calendar.ts`；保留 UUID 对账/日历投影与参数验证 |
| 16 | `apps/brain/src/meeting.test.ts` | 提取后删 | `packages/cos/src/meeting.test.ts`；保留状态/安排/恢复；删除 gateway/REST/profile loader |
| 17 | `apps/brain/src/meeting.ts` | 提取后删 | `packages/cos/src/meeting.ts`；保留状态/安排/恢复；删除 gateway/REST/profile loader |
| 18 | `apps/brain/src/metrics.test.ts` | 提取后删 | `packages/cos/src/metrics.test.ts`；历史指标解析与报表，去掉旧 PID/进程入口假设 |
| 19 | `apps/brain/src/metrics.ts` | 提取后删 | `packages/cos/src/metrics.ts`；历史指标解析与报表，去掉旧 PID/进程入口假设 |
| 20 | `apps/brain/src/preflight.test.ts` | 删除 | 旧宿主/安装/驱动及对应测试；安全验收移到平台 |
| 21 | `apps/brain/src/preflight.ts` | 删除 | 旧宿主/安装/驱动及对应测试；安全验收移到平台 |
| 22 | `apps/brain/src/runtime.test.ts` | 提取后删 | `packages/cos/src/metrics-sampler.test.ts`；只提取采样函数/测试；无 daemon/PID/私发 |
| 23 | `apps/brain/src/runtime.ts` | 提取后删 | `packages/cos/src/metrics-sampler.ts`；只提取采样函数/测试；无 daemon/PID/私发 |
| 24 | `apps/brain/src/voice-mode-ux.test.ts` | 提取后删 | `packages/cos/src/voice-intent-ux.test.ts`；保留请求/停止规则；平台能力未就绪返回 unavailable |
| 25 | `apps/brain/src/voice-mode.test.ts` | 提取后删 | `packages/cos/src/voice-intent.test.ts`；保留请求/停止规则；平台能力未就绪返回 unavailable |
| 26 | `apps/brain/src/voice-mode.ts` | 提取后删 | `packages/cos/src/voice-intent.ts`；保留请求/停止规则；平台能力未就绪返回 unavailable |
| 27 | `apps/brain/tsconfig.json` | 删除 | 旧 brain 包边界；新 packages/cos 自有 manifest/tsconfig |
| 28 | `apps/voice/assets/start-instructions.zh.md` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 29 | `apps/voice/models/LICENSE.silero-vad` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 30 | `apps/voice/models/silero_vad.onnx` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 31 | `apps/voice/package.json` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 32 | `apps/voice/src/__fixtures__/fly2178-always-on-no-interrupt-1c71cd2.json` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 33 | `apps/voice/src/actions/OutboxWatcher.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 34 | `apps/voice/src/actions/OutboxWatcher.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 35 | `apps/voice/src/actions/ReadbackGate.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 36 | `apps/voice/src/actions/ReadbackGate.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 37 | `apps/voice/src/approval/ApprovalClient.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 38 | `apps/voice/src/approval/ApprovalClient.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 39 | `apps/voice/src/approval/ShipGateFlow.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 40 | `apps/voice/src/approval/ShipGateFlow.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 41 | `apps/voice/src/audio/AudioClock.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 42 | `apps/voice/src/audio/Bed.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 43 | `apps/voice/src/audio/FrameQueue.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 44 | `apps/voice/src/audio/JitterBuffer.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 45 | `apps/voice/src/audio/Mixer.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 46 | `apps/voice/src/audio/PcmFingerprint.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 47 | `apps/voice/src/audio/PcmFingerprint.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 48 | `apps/voice/src/audio/Resample.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 49 | `apps/voice/src/audio/Silence.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 50 | `apps/voice/src/audio/audio.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 51 | `apps/voice/src/cli.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 52 | `apps/voice/src/cli.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 53 | `apps/voice/src/codex/AppServerClient.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 54 | `apps/voice/src/codex/AppServerClient.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 55 | `apps/voice/src/codex/CodexLeg.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 56 | `apps/voice/src/codex/CodexLeg.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 57 | `apps/voice/src/codex/RealtimeTap.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 58 | `apps/voice/src/codex/RealtimeTap.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 59 | `apps/voice/src/codex/RealtimeTransport.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 60 | `apps/voice/src/codex/RealtimeTransport.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 61 | `apps/voice/src/config.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 62 | `apps/voice/src/config.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 63 | `apps/voice/src/discord/DiscordAdapter.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 64 | `apps/voice/src/discord/DiscordAdapter.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 65 | `apps/voice/src/discord/RoomText.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 66 | `apps/voice/src/discord/RoomText.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 67 | `apps/voice/src/discord/VoiceRoom.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 68 | `apps/voice/src/discord/VoiceRoom.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 69 | `apps/voice/src/discord/VoiceTextMirror.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 70 | `apps/voice/src/discord/VoiceTextMirror.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 71 | `apps/voice/src/evidence.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 72 | `apps/voice/src/evidence.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 73 | `apps/voice/src/filter/FilterRules.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 74 | `apps/voice/src/filter/FilterRules.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 75 | `apps/voice/src/inbox/Backchannel.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 76 | `apps/voice/src/inbox/Backchannel.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 77 | `apps/voice/src/inbox/InboxArbitrator.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 78 | `apps/voice/src/inbox/InboxArbitrator.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 79 | `apps/voice/src/inbox/InboxReader.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 80 | `apps/voice/src/inbox/InboxReader.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 81 | `apps/voice/src/inbox/SpeechBrief.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 82 | `apps/voice/src/inbox/SpeechBrief.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 83 | `apps/voice/src/lifecycle.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 84 | `apps/voice/src/lifecycle.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 85 | `apps/voice/src/meeting-context.test.ts` | 提取后删 | `packages/cos/src/meeting-context.test.ts`；canonical Lead 上下文规则，删除私有 roster/voice wiring |
| 86 | `apps/voice/src/meeting-context.ts` | 提取后删 | `packages/cos/src/meeting-context.ts`；canonical Lead 上下文规则，删除私有 roster/voice wiring |
| 87 | `apps/voice/src/pipeline/Downlink.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 88 | `apps/voice/src/pipeline/SileroVad.smoke.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 89 | `apps/voice/src/pipeline/SileroVad.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 90 | `apps/voice/src/pipeline/SileroVad.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 91 | `apps/voice/src/pipeline/Uplink.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 92 | `apps/voice/src/pipeline/UplinkSpeechGate.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 93 | `apps/voice/src/pipeline/UplinkSpeechGate.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 94 | `apps/voice/src/pipeline/fixtures/README.md` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 95 | `apps/voice/src/pipeline/fixtures/true-speech.wav` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 96 | `apps/voice/src/pipeline/pipeline.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 97 | `apps/voice/src/preflight.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 98 | `apps/voice/src/preflight.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 99 | `apps/voice/src/readback.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 100 | `apps/voice/src/readback.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 101 | `apps/voice/src/runtime.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 102 | `apps/voice/src/runtime.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 103 | `apps/voice/src/security/ApprovalCredential.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 104 | `apps/voice/src/security/ApprovalCredential.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 105 | `apps/voice/src/session/Coordinator.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 106 | `apps/voice/src/session/Coordinator.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 107 | `apps/voice/src/session/ExitProtocol.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 108 | `apps/voice/src/session/ExitProtocol.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 109 | `apps/voice/src/speech/HeardPosition.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 110 | `apps/voice/src/speech/HeardPosition.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 111 | `apps/voice/src/speech/Phrases.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 112 | `apps/voice/src/speech/Speaker.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 113 | `apps/voice/src/speech/Speaker.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 114 | `apps/voice/src/speech/TranscriptLog.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 115 | `apps/voice/src/speech/TranscriptLog.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 116 | `apps/voice/src/store.test.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 117 | `apps/voice/src/store.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 118 | `apps/voice/tsconfig.json` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 119 | `assets/raya-avatar-square.png` | 保留 | persona 品牌资源及来源说明 |
| 120 | `assets/raya-avatar.SOURCE.txt` | 保留 | persona 品牌资源及来源说明 |
| 121 | `biome.json` | 改写 | 仅保留 cos 构建/验证与业务依赖；清理旧包/产物入口 |
| 122 | `engineering/doc/FLY-2031-raya-mobile-voice/bot-qa-summary.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 123 | `engineering/doc/FLY-2031-raya-mobile-voice/c9-emitter-plan.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 124 | `engineering/doc/FLY-2031-raya-mobile-voice/diagrams/d1-core-flow.mmd` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 125 | `engineering/doc/FLY-2031-raya-mobile-voice/diagrams/d1-core-flow.svg` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 126 | `engineering/doc/FLY-2031-raya-mobile-voice/diagrams/d2-readback.mmd` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 127 | `engineering/doc/FLY-2031-raya-mobile-voice/diagrams/d2-readback.svg` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 128 | `engineering/doc/FLY-2031-raya-mobile-voice/diagrams/d3-ship.mmd` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 129 | `engineering/doc/FLY-2031-raya-mobile-voice/diagrams/d3-ship.svg` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 130 | `engineering/doc/FLY-2031-raya-mobile-voice/diagrams/d4-files.mmd` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 131 | `engineering/doc/FLY-2031-raya-mobile-voice/diagrams/d4-files.svg` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 132 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/FLY-2031-P1-system-broadcast-adjudication.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 133 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/FLY-2031-P1-system-broadcast-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 134 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/FLY-2031-P1-system-broadcast.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 135 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/FLY-2031-P1b-backend-outbox-write-p1b-198647f5-184e-4244-b1d1-30467e9cc539-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 136 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/FLY-2031-P1b-backend-outbox-write-p1b-198647f5-184e-4244-b1d1-30467e9cc539.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 137 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/FLY-2031-P1b-backend-outbox-write-p1b-b98e6435-47c8-4bc3-9f88-91ba09b89533-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 138 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/FLY-2031-P1b-backend-outbox-write-p1b-b98e6435-47c8-4bc3-9f88-91ba09b89533.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 139 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/c9-evidence.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 140 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/c9-p0-r3-summary.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 141 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/founder-r2-speech-samples.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 142 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/founder-round-baseline-20260828.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 143 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/founder-round-failed-20260828.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 144 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/founder-round-opening-checklist-20260829.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 145 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/founder-round-r1-partial-20260829.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 146 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/founder-round-runbook.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 147 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/p1-evidence.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 148 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/r2-founder-free-selfcheck-20260829.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 149 | `engineering/doc/FLY-2031-raya-mobile-voice/evidence/rotated-credential-and-nonfounder-negative-20260829.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 150 | `engineering/doc/FLY-2031-raya-mobile-voice/exploration.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 151 | `engineering/doc/FLY-2031-raya-mobile-voice/founder-design.html` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 152 | `engineering/doc/FLY-2031-raya-mobile-voice/founder-design.template.html` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 153 | `engineering/doc/FLY-2031-raya-mobile-voice/founder-r1-design-amendment.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 154 | `engineering/doc/FLY-2031-raya-mobile-voice/founder-r1-remediation-plan.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 155 | `engineering/doc/FLY-2031-raya-mobile-voice/plan.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 156 | `engineering/doc/FLY-2031-raya-mobile-voice/progress.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 157 | `engineering/doc/FLY-2031-raya-mobile-voice/research.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 158 | `engineering/doc/milestones/FLY-2031.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 159 | `package.json` | 改写 | 仅保留 cos 构建/验证与业务依赖；清理旧包/产物入口 |
| 160 | `packages/contracts/package.json` | 删除 | 旧 contracts 包结束；所需业务 schema 并入 packages/cos |
| 161 | `packages/contracts/src/codex-session.test.ts` | 删除·⑤引用 | 重复 Codex policy/RPC 契约退役；平台保留安全验收，⑤按 SHA 取参考 |
| 162 | `packages/contracts/src/codex-session.ts` | 删除·⑤引用 | 重复 Codex policy/RPC 契约退役；平台保留安全验收，⑤按 SHA 取参考 |
| 163 | `packages/contracts/src/index.ts` | 删除 | 以 cos 显式 exports 替代，不能再导出旧宿主契约 |
| 164 | `packages/contracts/src/integration-contract.test.ts` | 提取后删 | `packages/cos/src/contracts/state-paths.test.ts`；仅保留业务状态路径；删 PID/entrypoint/env 驱动契约 |
| 165 | `packages/contracts/src/integration-contract.ts` | 提取后删 | `packages/cos/src/contracts/state-paths.ts`；仅保留业务状态路径；删 PID/entrypoint/env 驱动契约 |
| 166 | `packages/contracts/src/meeting.test.ts` | 提取后删 | `packages/cos/src/contracts/meeting.test.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 167 | `packages/contracts/src/meeting.ts` | 提取后删 | `packages/cos/src/contracts/meeting.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 168 | `packages/contracts/src/metrics.test.ts` | 提取后删 | `packages/cos/src/contracts/metrics.test.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 169 | `packages/contracts/src/metrics.ts` | 提取后删 | `packages/cos/src/contracts/metrics.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 170 | `packages/contracts/src/runtime-env.test.ts` | 提取后删 | `packages/cos/src/contracts/runtime-env.test.ts`；仅 owner-private 配置校验，不创建独立 host |
| 171 | `packages/contracts/src/runtime-env.ts` | 提取后删 | `packages/cos/src/contracts/runtime-env.ts`；仅 owner-private 配置校验，不创建独立 host |
| 172 | `packages/contracts/src/voice-actions.test.ts` | 提取后删 | `packages/cos/src/contracts/voice-actions.test.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 173 | `packages/contracts/src/voice-actions.ts` | 提取后删 | `packages/cos/src/contracts/voice-actions.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 174 | `packages/contracts/src/voice-inbox.test.ts` | 提取后删 | `packages/cos/src/contracts/voice-inbox.test.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 175 | `packages/contracts/src/voice-inbox.ts` | 提取后删 | `packages/cos/src/contracts/voice-inbox.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 176 | `packages/contracts/src/voice-mode.test.ts` | 提取后删 | `packages/cos/src/contracts/voice-mode.test.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 177 | `packages/contracts/src/voice-mode.ts` | 提取后删 | `packages/cos/src/contracts/voice-mode.ts`；纯业务模型/验证；meeting 去掉本地名册权威 |
| 178 | `packages/contracts/tsconfig.json` | 删除 | 旧 contracts 包结束；所需业务 schema 并入 packages/cos |
| 179 | `pnpm-lock.yaml` | 改写 | 仅保留 cos 构建/验证与业务依赖；清理旧包/产物入口 |
| 180 | `pnpm-workspace.yaml` | 改写 | 仅保留 cos 构建/验证与业务依赖；清理旧包/产物入口 |
| 181 | `probes/c0-lib.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 182 | `probes/c0-lib.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 183 | `probes/c9-approval-test-server.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 184 | `probes/c9-approval-test-server.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 185 | `probes/c9-voice-emitter-lib.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 186 | `probes/c9-voice-emitter.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 187 | `probes/c9-voice-emitter.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 188 | `probes/evidence/P2-0.148-raya-home/P2-resume-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 189 | `probes/evidence/P2-0.148-raya-home/P2-resume.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 190 | `probes/evidence/P2-0.149-chatgpt/P2-resume-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 191 | `probes/evidence/P2-0.149-chatgpt/P2-resume.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 192 | `probes/evidence/P2-resume-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 193 | `probes/evidence/P2-resume.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 194 | `probes/evidence/P2-voice-key-settle/P2-resume-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 195 | `probes/evidence/P2-voice-key-settle/P2-resume.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 196 | `probes/evidence/P2-voice-key/P2-resume-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 197 | `probes/evidence/P2-voice-key/P2-resume.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 198 | `probes/evidence/P3-P4-voice-key/P3-P4-runtime-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 199 | `probes/evidence/P3-P4-voice-key/P3-P4-runtime.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 200 | `probes/evidence/P5-busy/P5-busy-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 201 | `probes/evidence/P5-busy/P5-busy.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 202 | `probes/evidence/P5-separate-home-apikey/P5-busy-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 203 | `probes/evidence/P5-separate-home-apikey/P5-busy.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 204 | `probes/evidence/P5-separate-home/P5-busy-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 205 | `probes/evidence/P5-separate-home/P5-busy.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 206 | `probes/evidence/P6-lifetime-concurrency/P6-lifetime-concurrency-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 207 | `probes/evidence/P6-lifetime-concurrency/P6-lifetime-concurrency.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 208 | `probes/evidence/P7-launchd-fixture-direct/P7-launchd-fixture-direct-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 209 | `probes/evidence/P7-launchd-fixture-direct/P7-launchd-fixture-direct.jsonl` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 210 | `probes/evidence/P7-launchd-successful-exit-load/P7-launchd-successful-exit-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 211 | `probes/evidence/P7-launchd-successful-exit-user/P7-launchd-successful-exit-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 212 | `probes/evidence/P7-launchd-successful-exit/P7-launchd-successful-exit-manifest.json` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 213 | `probes/evidence/README.md` | 历史保留 | 原路径，仅审计文档/数据；不可成为运行依赖 |
| 214 | `probes/fly2031-voice-experience-run.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 215 | `probes/fly2031-voice-experience-run.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 216 | `probes/fly2031-voice-experience.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 217 | `probes/fly2031-voice-experience.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 218 | `probes/fly2178-bargein-probe.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 219 | `probes/fly2178-bargein-probe.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 220 | `probes/fly2178-bargein-room-run.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 221 | `probes/fly2178-bargein-room-run.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 222 | `probes/fly2178-realtime-interrupt.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 223 | `probes/fly2249-gate-calibrate.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 224 | `probes/fly2249-gate-calibrate.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 225 | `probes/fly2249-silero-clock.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 226 | `probes/launchd-successful-exit-fixture.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 227 | `probes/p1-system-broadcast-lib.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 228 | `probes/p1-system-broadcast.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 229 | `probes/p1-system-broadcast.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 230 | `probes/p1b-backend-outbox-write-lib.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 231 | `probes/p1b-backend-outbox-write.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 232 | `probes/p1b-backend-outbox-write.test.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 233 | `probes/p2-resume.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 234 | `probes/p3-p4-runtime.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 235 | `probes/p5-busy.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 236 | `probes/p6-lifetime-concurrency.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 237 | `probes/p7-launchd-fixture-direct.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 238 | `probes/p7-launchd-successful-exit.mjs` | 删除 | 旧私有 runtime 探针/测试退役；⑤可按固定 SHA 查历史，活动树无 probe driver |
| 239 | `scripts/install-launchd.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 240 | `scripts/qa/fixtures/fly2097/s1-pass.jsonl` | 删除·⑤引用 | 旧语音 QA fixture 移出活动树；⑤可按 SHA 提取 |
| 241 | `scripts/qa/fly2249-dead-code.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 242 | `scripts/qa/lib/env-compose.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 243 | `scripts/qa/lib/env-compose.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 244 | `scripts/qa/lib/judges.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 245 | `scripts/qa/lib/judges.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 246 | `scripts/qa/lib/orchestrator.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 247 | `scripts/qa/lib/orchestrator.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 248 | `scripts/qa/lib/scenario-runner.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 249 | `scripts/qa/lib/scenario-runner.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 250 | `scripts/qa/lib/session.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 251 | `scripts/qa/lib/session.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 252 | `scripts/qa/lib/time.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 253 | `scripts/qa/lib/time.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 254 | `scripts/qa/lib/tts-fixture.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 255 | `scripts/qa/lib/tts-fixture.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 256 | `scripts/qa/raya-voice-529.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 257 | `scripts/qa/raya-voice-529.sentences.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 258 | `scripts/qa/raya-voice-529.sentences.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 259 | `scripts/qa/raya-voice-529.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 260 | `scripts/qa/root-test-gates.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 261 | `scripts/voice-inbox-fixture.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 262 | `scripts/voice-inbox-fixture.test.mjs` | 删除 | 旧安装/voice QA/fixture 执行器及测试退役；新 host 在 Flywheel 验证 |
| 263 | `summaries/README.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 264 | `summaries/flywheel/2026-09-06--flywheel-eng-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 265 | `summaries/flywheel/2026-09-06--flywheel-product-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 266 | `summaries/geoforge3d/2026-09-06--ops-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 267 | `summaries/geoforge3d/2026-09-06--product-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 268 | `summaries/growth/2026-09-06--rafiki-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 269 | `summaries/growth/2026-09-06--reflection-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 270 | `summaries/joycon-typeless/2026-09-06--joycon-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 271 | `summaries/personal-assistant/2026-09-06--belle-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 272 | `summaries/tidal-echo/2026-09-06--sub-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 273 | `summaries/tidal-echo/2026-09-06--tidal-echo-content-lead--01.md` | 保留 | 原 summaries 仓和未读/已阅语义 |
| 274 | `tsconfig.json` | 改写 | 仅保留 cos 构建/验证与业务依赖；清理旧包/产物入口 |

覆盖统计：改写 7；保留/修订 1；删除 66；提取后删 32；删除·⑤引用 92；保留 13；历史保留 63。总计 274；没有未分类路径。

## 附录 B. 分支独有路径与待审覆盖层

本表从固定 main 与各分支的 merge-base 差异生成；新增路径单独标注。这里列的是可审素材，不是已合入/已部署清单。每个分支固定 SHA 见 §1。

### 2379：29 个分支变更路径，19 个新增路径

| 路径类别 | 路径 | 处置 | 目标/约束 |
|---|---|---|---|
| 修改·待审覆盖层 | `README.md` | 改写 | 标准 Lead 注册/CoS 用法，移除旧 launchd/app-server 操作入口 |
| 修改·待审覆盖层 | `apps/brain/src/cli.test.ts` | 提取后删 | `packages/cos/src/cli.test.ts`；仅独立业务命令；去掉常驻 run 与网关组合 |
| 修改·待审覆盖层 | `apps/brain/src/cli.ts` | 提取后删 | `packages/cos/src/cli.ts`；仅独立业务命令；去掉常驻 run 与网关组合 |
| 修改·待审覆盖层 | `apps/brain/src/config.test.ts` | 提取后删 | `packages/cos/src/options.test.ts`；仅 CoS 受验证配置，不带 bot/driver/daemon |
| 修改·待审覆盖层 | `apps/brain/src/config.ts` | 提取后删 | `packages/cos/src/options.ts`；仅 CoS 受验证配置，不带 bot/driver/daemon |
| 新增·分支独有 | `apps/brain/src/text-chat/codex-client.test.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/codex-client.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/controller.test.ts` | 提取后删 | `packages/cos/src/asks/controller.test.ts`；仅问 Lead 状态/对账/答案验证；删除 turn/Discord poller/queue |
| 新增·分支独有 | `apps/brain/src/text-chat/controller.ts` | 提取后删 | `packages/cos/src/asks/controller.ts`；仅问 Lead 状态/对账/答案验证；删除 turn/Discord poller/queue |
| 新增·分支独有 | `apps/brain/src/text-chat/discord-rest.test.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/discord-rest.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/fallback.test.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/fallback.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/secret-isolation.test.ts` | 不导入驱动 | 正控制可读/secret 拒读要求迁到平台注册验收 |
| 新增·分支独有 | `apps/brain/src/text-chat/secret-isolation.ts` | 不导入驱动 | 正控制可读/secret 拒读要求迁到平台注册验收 |
| 新增·分支独有 | `apps/brain/src/text-chat/store.test.ts` | 提取后删 | `packages/cos/src/asks/store.test.ts`；保留 asks/metadata 事件；删除 thread.json 读写 |
| 新增·分支独有 | `apps/brain/src/text-chat/store.ts` | 提取后删 | `packages/cos/src/asks/store.ts`；保留 asks/metadata 事件；删除 thread.json 读写 |
| 修改·待审覆盖层 | `apps/brain/src/voice-mode.test.ts` | 提取后删 | `packages/cos/src/voice-intent.test.ts`；保留请求/停止规则；平台能力未就绪返回 unavailable |
| 修改·待审覆盖层 | `apps/brain/src/voice-mode.ts` | 提取后删 | `packages/cos/src/voice-intent.ts`；保留请求/停止规则；平台能力未就绪返回 unavailable |
| 修改·待审覆盖层 | `apps/voice/src/discord/VoiceTextMirror.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 修改·待审覆盖层 | `apps/voice/src/security/ApprovalCredential.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 新增·分支独有 | `engineering/doc/milestones/FLY-2379.md` | 历史保留 | 该分支审计材料按需要导入；不作运行输入 |
| 新增·分支独有 | `packages/contracts/src/codex-sandbox-probe.test.ts` | 不导入驱动 | 平台负责 sandbox 拒读验证；保留负面验收要求 |
| 新增·分支独有 | `packages/contracts/src/codex-sandbox-probe.ts` | 不导入驱动 | 平台负责 sandbox 拒读验证；保留负面验收要求 |
| 新增·分支独有 | `packages/contracts/src/discord-text.test.ts` | 提取后删 | `packages/cos/src/formatting/discord-text.test.ts`；仅纯安全文本格式；共用 Bridge 出站 |
| 新增·分支独有 | `packages/contracts/src/discord-text.ts` | 提取后删 | `packages/cos/src/formatting/discord-text.ts`；仅纯安全文本格式；共用 Bridge 出站 |
| 修改·待审覆盖层 | `packages/contracts/src/index.ts` | 删除 | 以 cos 显式 exports 替代，不能再导出旧宿主契约 |
| 新增·分支独有 | `packages/contracts/src/lead-ask.test.ts` | 提取后删 | `packages/cos/src/contracts/lead-ask.test.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/lead-ask.ts` | 提取后删 | `packages/cos/src/contracts/lead-ask.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |

### 2380：20 个分支变更路径，19 个新增路径

| 路径类别 | 路径 | 处置 | 目标/约束 |
|---|---|---|---|
| 新增·分支独有 | `apps/brain/src/daily-report/codex-config.test.ts` | 不导入 | 重复 Codex 配置/校验属于平台 |
| 新增·分支独有 | `apps/brain/src/daily-report/codex-config.ts` | 不导入 | 重复 Codex 配置/校验属于平台 |
| 新增·分支独有 | `apps/brain/src/daily-report/collector.test.ts` | 提取后删 | `packages/cos/src/daily-report/collector.test.ts`；保留 collector/repo/body/provenance 等业务 |
| 新增·分支独有 | `apps/brain/src/daily-report/collector.ts` | 提取后删 | `packages/cos/src/daily-report/collector.ts`；保留 collector/repo/body/provenance 等业务 |
| 新增·分支独有 | `apps/brain/src/daily-report/controller.test.ts` | 提取后删 | `packages/cos/src/daily-report/controller.test.ts`；保留状态/恢复；替换旧 textChat/REST 接口 |
| 新增·分支独有 | `apps/brain/src/daily-report/controller.ts` | 提取后删 | `packages/cos/src/daily-report/controller.ts`；保留状态/恢复；替换旧 textChat/REST 接口 |
| 新增·分支独有 | `apps/brain/src/daily-report/delivery.test.ts` | 提取后删 | `packages/cos/src/daily-report/delivery.test.ts`；保留 nonce/回执对账；发信归 Bridge |
| 新增·分支独有 | `apps/brain/src/daily-report/delivery.ts` | 提取后删 | `packages/cos/src/daily-report/delivery.ts`；保留 nonce/回执对账；发信归 Bridge |
| 新增·分支独有 | `apps/brain/src/daily-report/generator.test.ts` | 提取后删 | `packages/cos/src/daily-report/generator.test.ts`；只保留 prompt/格式验证/业务接口；删除 thread/turn RPC |
| 新增·分支独有 | `apps/brain/src/daily-report/generator.ts` | 提取后删 | `packages/cos/src/daily-report/generator.ts`；只保留 prompt/格式验证/业务接口；删除 thread/turn RPC |
| 新增·分支独有 | `apps/brain/src/daily-report/options.test.ts` | 提取后删 | `packages/cos/src/daily-report/options.test.ts`；保留 collector/repo/body/provenance 等业务 |
| 新增·分支独有 | `apps/brain/src/daily-report/options.ts` | 提取后删 | `packages/cos/src/daily-report/options.ts`；保留 collector/repo/body/provenance 等业务 |
| 新增·分支独有 | `apps/brain/src/daily-report/repo-writer.test.ts` | 提取后删 | `packages/cos/src/daily-report/repo-writer.test.ts`；保留 collector/repo/body/provenance 等业务 |
| 新增·分支独有 | `apps/brain/src/daily-report/repo-writer.ts` | 提取后删 | `packages/cos/src/daily-report/repo-writer.ts`；保留 collector/repo/body/provenance 等业务 |
| 新增·分支独有 | `apps/brain/src/daily-report/storage.test.ts` | 提取后删 | `packages/cos/src/daily-report/storage.test.ts`；保留 collector/repo/body/provenance 等业务 |
| 新增·分支独有 | `apps/brain/src/daily-report/storage.ts` | 提取后删 | `packages/cos/src/daily-report/storage.ts`；保留 collector/repo/body/provenance 等业务 |
| 新增·分支独有 | `packages/contracts/src/daily-report-export.test.ts` | 提取后删 | `packages/cos/src/contracts/daily-report-export.test.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/daily-report.test.ts` | 提取后删 | `packages/cos/src/contracts/daily-report.test.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/daily-report.ts` | 提取后删 | `packages/cos/src/contracts/daily-report.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 修改·待审覆盖层 | `packages/contracts/src/index.ts` | 删除 | 以 cos 显式 exports 替代，不能再导出旧宿主契约 |

### 2381：58 个分支变更路径，46 个新增路径

| 路径类别 | 路径 | 处置 | 目标/约束 |
|---|---|---|---|
| 修改·待审覆盖层 | `README.md` | 改写 | 标准 Lead 注册/CoS 用法，移除旧 launchd/app-server 操作入口 |
| 修改·待审覆盖层 | `apps/brain/src/cli.test.ts` | 提取后删 | `packages/cos/src/cli.test.ts`；仅独立业务命令；去掉常驻 run 与网关组合 |
| 修改·待审覆盖层 | `apps/brain/src/cli.ts` | 提取后删 | `packages/cos/src/cli.ts`；仅独立业务命令；去掉常驻 run 与网关组合 |
| 修改·待审覆盖层 | `apps/brain/src/config.test.ts` | 提取后删 | `packages/cos/src/options.test.ts`；仅 CoS 受验证配置，不带 bot/driver/daemon |
| 修改·待审覆盖层 | `apps/brain/src/config.ts` | 提取后删 | `packages/cos/src/options.ts`；仅 CoS 受验证配置，不带 bot/driver/daemon |
| 修改·待审覆盖层 | `apps/brain/src/installer.test.ts` | 删除 | 旧宿主/安装/驱动及对应测试；安全验收移到平台 |
| 新增·分支独有 | `apps/brain/src/portfolio/coordinator.test.ts` | 提取后删 | `packages/cos/src/portfolio/coordinator.test.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/coordinator.ts` | 提取后删 | `packages/cos/src/portfolio/coordinator.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/evidence-gate.test.ts` | 提取后删 | `packages/cos/src/portfolio/evidence-gate.test.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/evidence-gate.ts` | 提取后删 | `packages/cos/src/portfolio/evidence-gate.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/goal-store.test.ts` | 提取后删 | `packages/cos/src/portfolio/goal-store.test.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/goal-store.ts` | 提取后删 | `packages/cos/src/portfolio/goal-store.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/patrol-state.test.ts` | 提取后删 | `packages/cos/src/portfolio/patrol-state.test.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/patrol-state.ts` | 提取后删 | `packages/cos/src/portfolio/patrol-state.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/patrol.test.ts` | 提取后删 | `packages/cos/src/portfolio/patrol.test.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/patrol.ts` | 提取后删 | `packages/cos/src/portfolio/patrol.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/render.test.ts` | 提取后删 | `packages/cos/src/portfolio/render.test.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/render.ts` | 提取后删 | `packages/cos/src/portfolio/render.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/sampler.test.ts` | 提取后删 | `packages/cos/src/portfolio/sampler.test.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/sampler.ts` | 提取后删 | `packages/cos/src/portfolio/sampler.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/snapshot-store.test.ts` | 提取后删 | `packages/cos/src/portfolio/snapshot-store.test.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/snapshot-store.ts` | 提取后删 | `packages/cos/src/portfolio/snapshot-store.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 新增·分支独有 | `apps/brain/src/portfolio/types.ts` | 提取后删 | `packages/cos/src/portfolio/types.ts`；替换旧 SystemTurnRequest/submitSystemTurn/sendPlain；中央目录只读 |
| 修改·待审覆盖层 | `apps/brain/src/preflight.test.ts` | 删除 | 旧宿主/安装/驱动及对应测试；安全验收移到平台 |
| 新增·分支独有 | `apps/brain/src/text-chat/codex-client.test.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/codex-client.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/controller.test.ts` | 提取后删 | `packages/cos/src/asks/controller.test.ts`；仅问 Lead 状态/对账/答案验证；删除 turn/Discord poller/queue |
| 新增·分支独有 | `apps/brain/src/text-chat/controller.ts` | 提取后删 | `packages/cos/src/asks/controller.ts`；仅问 Lead 状态/对账/答案验证；删除 turn/Discord poller/queue |
| 新增·分支独有 | `apps/brain/src/text-chat/discord-rest.test.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/discord-rest.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/fallback.test.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/fallback.ts` | 不导入 | 旧 Codex/REST/fallback 驱动及测试 |
| 新增·分支独有 | `apps/brain/src/text-chat/secret-isolation.test.ts` | 不导入驱动 | 正控制可读/secret 拒读要求迁到平台注册验收 |
| 新增·分支独有 | `apps/brain/src/text-chat/secret-isolation.ts` | 不导入驱动 | 正控制可读/secret 拒读要求迁到平台注册验收 |
| 新增·分支独有 | `apps/brain/src/text-chat/store.test.ts` | 提取后删 | `packages/cos/src/asks/store.test.ts`；保留 asks/metadata 事件；删除 thread.json 读写 |
| 新增·分支独有 | `apps/brain/src/text-chat/store.ts` | 提取后删 | `packages/cos/src/asks/store.ts`；保留 asks/metadata 事件；删除 thread.json 读写 |
| 修改·待审覆盖层 | `apps/brain/src/voice-mode.test.ts` | 提取后删 | `packages/cos/src/voice-intent.test.ts`；保留请求/停止规则；平台能力未就绪返回 unavailable |
| 修改·待审覆盖层 | `apps/brain/src/voice-mode.ts` | 提取后删 | `packages/cos/src/voice-intent.ts`；保留请求/停止规则；平台能力未就绪返回 unavailable |
| 修改·待审覆盖层 | `apps/voice/src/discord/VoiceTextMirror.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 修改·待审覆盖层 | `apps/voice/src/security/ApprovalCredential.ts` | 删除·⑤引用 | 活动树删除；⑤按固定 main SHA 提取相同路径，不在 Raya 保留可运行副本 |
| 新增·分支独有 | `engineering/doc/milestones/FLY-2379.md` | 历史保留 | 该分支审计材料按需要导入；不作运行输入 |
| 新增·分支独有 | `engineering/doc/milestones/FLY-2381.md` | 历史保留 | 该分支审计材料按需要导入；不作运行输入 |
| 新增·分支独有 | `packages/contracts/src/codex-sandbox-probe.test.ts` | 不导入驱动 | 平台负责 sandbox 拒读验证；保留负面验收要求 |
| 新增·分支独有 | `packages/contracts/src/codex-sandbox-probe.ts` | 不导入驱动 | 平台负责 sandbox 拒读验证；保留负面验收要求 |
| 新增·分支独有 | `packages/contracts/src/discord-text.test.ts` | 提取后删 | `packages/cos/src/formatting/discord-text.test.ts`；仅纯安全文本格式；共用 Bridge 出站 |
| 新增·分支独有 | `packages/contracts/src/discord-text.ts` | 提取后删 | `packages/cos/src/formatting/discord-text.ts`；仅纯安全文本格式；共用 Bridge 出站 |
| 新增·分支独有 | `packages/contracts/src/drift-envelope.test.ts` | 提取后删 | `packages/cos/src/contracts/drift-envelope.test.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/drift-envelope.ts` | 提取后删 | `packages/cos/src/contracts/drift-envelope.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/fixtures/projects-registry.json` | 提取后删 | `packages/cos/src/contracts/fixtures/projects-registry.json`；仅验证 fixture；不得加载作生产名册 |
| 新增·分支独有 | `packages/contracts/src/goals.test.ts` | 提取后删 | `packages/cos/src/contracts/goals.test.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/goals.ts` | 提取后删 | `packages/cos/src/contracts/goals.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 修改·待审覆盖层 | `packages/contracts/src/index.ts` | 删除 | 以 cos 显式 exports 替代，不能再导出旧宿主契约 |
| 新增·分支独有 | `packages/contracts/src/lead-ask.test.ts` | 提取后删 | `packages/cos/src/contracts/lead-ask.test.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/lead-ask.ts` | 提取后删 | `packages/cos/src/contracts/lead-ask.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/portfolio-marks.test.ts` | 提取后删 | `packages/cos/src/contracts/portfolio-marks.test.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/portfolio-marks.ts` | 提取后删 | `packages/cos/src/contracts/portfolio-marks.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/projects-registry.test.ts` | 提取后删 | `packages/cos/src/contracts/projects-registry.test.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |
| 新增·分支独有 | `packages/contracts/src/projects-registry.ts` | 提取后删 | `packages/cos/src/contracts/projects-registry.ts`；保持业务 schema；projects-registry 只读中央权威，不生成副本 |


## Lead 边界裁定（v2）

Lead 已通过问题 b2ea8602-feee-41d5-8743-380fa13e47e2 明确：④最低验收为标准文字+summary收件/吸收；question/meeting保留状态机但transport unavailable，新的Lead问答API由Lead另开后续单。本清单中的mailbox/通知端口替换要求是业务边界，不能据此在④新增问答传输。⑤语音重挂为FLY-2446；不留第二driver、私有Discord fallback。
