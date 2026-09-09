# FLY-2445 Raya 标准 Lead — 调研
Issue: FLY-2445 (https://linear.app/geoforge3d/issue/FLY-2445/raya-raya-迁为标准-codex-lead注册进-flywheel走-mailboxraya-仓删掉-ingest-名册)
日期: 2026-09-08
基于: exploration.md

## 1. 证据基线

2026-09-08 只读审计；没有生产配置、进程或 Raya 源码变更。路径行号基于下列 SHA；实施节点必须重新比较差异，不能把分支代码当成已部署代码。

| 对象 | 核实结果 |
|---|---|
| Flywheel 设计基线 | `ee113cab956bf3d71f186e5d72b24baf545e629c`；含 ① FLY-2442 与 ② FLY-2443 |
| ① FLY-2442 | PR #1124 已合入，`eca5feb8a`；合同 `../FLY-2442-codex-outbound-bridge/mailbox-adapter-contract.md` |
| ② FLY-2443 | PR #1125 已合入，`80cd21ac3` |
| ③ FLY-2444 | PR #1126 OPEN，`cfda01d2d6db06eb1820f7bf661b33fd01325e75`；此时不能声明已上线 |
| Raya 生产 checkout | clean `main@0f77e9772176c973eb1e09548b00c05ae550ef32`，274 个 tracked 文件 |
| 2379 文字补丁 | 仅 `origin/fly-2379-raya-text-chat@34c879475dfe05253d2d52b409ccd14f107fe9b2`，main 没有 text-chat 目录 |
| 2380 日报 | 本地分支 `fly-2380-raya-daily-report@41b26fa4e8baaddf076a33e7291772de979ffb8c`；不冒称生产功能 |
| 2381 统管判断 | 本地分支 `fly-2381-raya-brain-drift@f1905cdaeb5747445e791649741fcdf20069b5c3`；不冒称生产功能 |
| 生产 registry | 没有 `agentId=raya`；Mufasa 是 `growth/mufasa-lead` |
| 新工作区 / Codex home | `~/Dev/raya-lead-workspace`、`~/.codex-raya` 均不存在，注册准备不可跳过 |
| Bridge health | 只读 `/health` 返回 ok，buildSha 为上述基线；liveness 中没有 Raya 泵 |

Raya 源路径以下相对 `~/.flywheel/raya/code`，未合入部分用上述 Git blob 审查。精确源文件处置见 `inventory.md`。FLY-2439 v3 §C 原文是“未验证可行性”的分类，本调研补齐实际消费者。

## 2. 标准接入链及真实数据库边界

③ `scripts/flywheel-lead.sh:204` 设置 `$HOME/.flywheel/comm/${RUN_PROJECT}/comm.db`；`LeadInboxRuntime` 构造器 `:251–264` 按项目打开队列，`:341` 共用 `LeadInboxLoop`。因此：

- Raya 是 `comm/raya/comm.db` 的 `mailbox`；Mufasa 是 `comm/growth/comm.db` 的 `mailbox`。
- “同一张 mailbox 表”按现有架构意味着同一 schema、同一权威实现与泵，没有 Raya 私有收信表。两者不是同一物理数据库文件。全局合库不属于本单，也不能在报告里伪称已合库。
- `CodexDiscordMailboxStrategy.accept` → `ingestDiscordChat`；`LeadInboxLoop` → `CodexLeadDeliveryAdapter` → 已有 unix socket → Lead journal/router。Raya 不新增适配器。
- 自动回复走 `CodexOutboundSender` → `/api/lead-outbound/send` → Bridge dedup。证据键为 `chat:raya:<messageId>` → `journal_member.entry_id` → `<entry_id>:out` → outbox sent → Bridge sent/message_id。
- 断线时，消息仍由 mailbox/journal/outbox 的既有所有者保存；Raya 不写这些库，不自己补轮询器。

评审后补核：收信器本身在标准Lead进程内，停机时没有独立Bridge取信器代收。`RestPollDiscordInboundSource.ts:163–218`在cursor缺失时baseline到latest而不投历史；`InboundCursorStore.ts`格式为channelId→snowflake字符串JSON，缺失/损坏会读作空。故计划v3明确由班车P4b在install前严格seed并读回，P6验证一条真实停机窗口source id，而非只验启新后探针；旧副作用不明则停止迁移，现有平台没有待核holdback队列。

③ 的状态路径由 `codex-lead.sh --print-state-dir raya raya` 与 Bridge `resolveCodexLeadStateDir` 同规则决定；有合法旧 state dir 则续用，否则用编码路径。不能手写 `state/codex-lead/raya` 当第二套路径真相。

## 3. 注册与身份

③ 注册器仅 add 或完全相同输入的 continuation；没有 update/rename。它锁住 projects.json，验证 summary assignment receipt，事务写名册与回执，再物化 manifest。pending intent 必须 `recover`；不能手改 JSON 凑过去。

评审后补核：main的summary registry `applyManifest`只改summaryRole；③分支增加 `candidateRegistry`供完整候选写入。v3必须新增受cfglock的import-cos-context命令与更新规划器，复用③写入/恢复基础，不把现有add称为update。add还没有alert参数，本单要显式扩参数后才能登记告警落点；`scripts/lead-alert.sh:423–447`已有FLY-927统一频道/发送身份优先级，验收应记录有效落点。

必须使用 `projectName=raya, agentId=raya`：`summary-absorption-rider.ts:162–175` 寻找唯一 `raya`，零匹配只返回 null 并退化；`flywheel-comm/src/commands/summary.ts:86–87` 的读回执还检查项目名恰为 `raya`。换成 `flywheel/raya` 会破坏该授权。

`lead-identity.ts:257` 用 `generalChannel === chatChannel` 派生 CoS role。因此注册 `generalChannel=#raya` 与 `chatChannel=#raya`，`summaryRole=recipient`，backend `codex-app-server`，profile `full-access`，TUI，`canSpawnRunners=false`。显示名 Raya 不作路由键。模型保留现行 `gpt-6-astra / xhigh / 1050000` 显式配置，不做模型迁移。

`resolveFullAccessProjectRoot` 拒绝与 `~/.flywheel`/state/Codex home 重叠的工作区。旧 checkout 在 `~/.flywheel/raya/code`，不可直接拿它注册。新工作区须在 `~/Dev/raya-lead-workspace`，业务数据与只读部署材料由班车明确物化。

## 4. 四个容易遗漏的消费者

1. `codex-lead-runtime.ts:547,578,893` 对 `leadId === raya` 必须提供 `RAYA_METRICS_DIR`。③ 不设置该变量，通用 launcher 会失败。应把旧身份特判改为所有 Lead 统一、可选的指标路径合同，保留历史指标。
2. ① 已合入合同 §⑤ **支持 registry 的 roundtableChannel 及其子线程**，而 ③ 为其先前边界仍清空 cross-dept。因此若开启会议/追问，须经过中央 registry 明确声明该频道，不能沿用专用 launcher 的硬编码默认。
3. ① 合同 §6 明确：`lead_actions.discord_send` 主动发言目前仍直接发 Discord。summary 报告与追问会用到它；仅迁自动回复不足以保证 Raya 出站全走 Bridge。实施须把 bridge 模式的主动发送也接入共享 `CodexOutboundSender`，不新增 Raya REST client。
4. 现有 `ask/respond/send` 是 Runner 通信 API；`respond` 写 recipientKind=runner，`send` 也是 Lead→Runner。不能伪造 exec-id=raya 来实现 Lead 间闭环。现成中央 primitive 是 `RuntimeRegistry.enqueueLeadEvent` → `LeadInboxRuntime.enqueueLeadEvent` → `lead-event-queue.ts:15`，后续业务可以通过明确的新平台接口使用。

## 5. 保留业务与数据，移除基础设施

- `IDENTITY.md` 的 summary 吸收协议、memory provenance、round ledger、纯 summary PR 的窄 merge 权限保持；新 rider 要求每轮显示对账，包括空轮，覆盖旧 persona “空轮静默”的过时指令。
- meeting.ts 是混合文件：前半是安排/改期/取消与恢复，后半 `startMeetingGateway`、Discord announcer/publisher 是基础设施。接口 `MeetingAnnouncer`/`MeetingInvitationPublisher` 已存在，但当前 `deliverMeetingNotifications:332–340` 将同一个 Discord messageId 记为 shared-leads 和 lead-mailbox 两种回执；迁移必须区分，不能沿用假 mailbox 证据。
- 14 个 profiles 存在于默认 `data/state/leads`。另有 voice 的 `RoomText.ts:57–103` 从 `voice-leads.json` 读第二个名册；不能只删 14 个目录。
- profile 字段有 leadId、discordUserId、displayName、aliases、workspaceCwd、identityPath、memoryPaths、voice、writableRoots。前两者映射 registry agentId/botUserId；workspace 取 projectRoot；voice 已有中央字段。其余业务元数据必须迁到中央 Lead 行的受验证扩展，并保持只读派生，不能生成新的可编辑名册。
- main 的 voice 自己有 AppServerClient/CodexLeg、DiscordAdapter、installer、session coordinator；保留 `apps/voice/**` 原样会直接违反目标。语音基础设施归 ⑤，业务规则/状态归 CoS；不能把目录改名就叫完成。

## 6. 状态清单与连续性

默认路径 `~/.flywheel/raya/data/state` 只确认 `voice-session.json` 与 14 个 Lead 目录存在。默认处没有 text-chat/daily-report/portfolio/summary ledger 不代表配置的其他路径没有；切换前必须按实际非秘密路径配置逐项盘点，绝不复制/展示 credential 内容。

| 状态 | 切换要求 |
|---|---|
| summaries PR、summaries 文件、memory git history | 原仓和 PR 不迁库；snapshot PR number/head/base/state；memory 单独版本仓，不用 persona 覆盖 |
| summary-merge-receipts.jsonl、roundId/provenance | 保持精确 round/PR 标识；posting 未 settled 的追问不伪标已发；merge 事实先于 ledger 对账 |
| meeting.json、meeting-events.jsonl、meetings/UUID 下 briefing/notifications/calendar/voice-signal | 按 schema 验证、保留 UUID/状态；calendar event ID 不变，失败仍告知且不阻断本地安排 |
| voice inbox items/acks、filters/preferences、action receipts | 保存，移到新所有者后才启用；旧进程 generation/thread 不是新会话真相 |
| text-chat asks（2379） | 保留 posting/posted/answer_observed/delivered/expired/failed；保持收件人 id 与请求 id，未决外部副作用先对账 |
| thread.json、旧 voice session/thread id、PID | 只读审计存档；不导入成标准 Lead 当前 thread/PID |
| daily-report date/body、portfolio patrol/goal/snapshot | ⑥ 从已审分支提取业务与数据 schema，禁止把旧 SystemTurnRequest/私有 generator 一起合入 |

## 7. 部署消费者闭包

`scripts/lib/updater-raya-deploy.sh`：旧两 label (`:6`)、旧 preflight (`:100`)、旧 env/argv identity (`:251`)、替换探针 (`:359`)、schemaVersion=1 receipt (`:405`)、known-good anchor (`:482`)。`update-flywheel.sh:667` 还以旧 plist 存在作为 capability，删除后会直接跳过 Raya 部署。

同步核对 `scripts/lead-patrol-snapshot.sh:1010–1100` 的部署差异/回执年龄、`packages/edge-worker/src/skill-templates/linear-issue-context.ts:32`、`lead-rules-base/{founder-only-authority,summary-inflow}.md` 的旧验收文案。保留 `checked_at` 数字时间戳与 `deployed_sha`，升级 receipt 明确旧/新 carrier，不让旧 PID 判据代替新 Lead 健康。

旧 Flywheel 专用 Raya launcher/wrapper/plist/preflight 也需退役或改为仅提示公共入口的兼容命令。须同步 package/converge 清单、restart carrier allowlist、resident recovery/patrol、QA 脚本与测试，不能留下可再启一个 Raya 的备用入口。

## 8. 验证与已知缺口

本节点未运行生产文字、summary merge、会议或重启测试，未证明迁移已完成。设计需要的红绿测试、生产证据链和回滚演练见 plan.md。

Lead 已答 `9c72c361-ffb0-4da1-85bf-8607ee4bb06e` / `b2ea8602-feee-41d5-8743-380fa13e47e2`：⑤为 FLY-2446；④最低验收为文字+summary，追问/会议状态机保留但transport unavailable，Lead另开共享问答API后续单；允许中央roundtable字段投影；不加额外实现hold。完整裁定和v2处置见 plan.md §8。
