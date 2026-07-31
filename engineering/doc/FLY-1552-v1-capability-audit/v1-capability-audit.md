# FLY-1552 v1 能力逐条对账表 — v1 有什么、v2 有没有、缺的算不算缺
Issue: FLY-1552 (https://linear.app/geoforge3d/issue/FLY-1552)
日期: 2026-07-30
基于: packages/{teamlead,edge-worker,flywheel-comm} 全量源码逐文件盘点(9 路并行,零遗漏)+ packages/v2-* 全 8 包盘点 + engineering/doc/FLY-{1497,1500,1502,1518,1520,1543}/ 设计权威 + FLY-1544 交付形态

---

## §0 结论速览

拿着这张表能回答的两个问题:

**「v2 现在还差什么?」** → §5 必须补清单,按严重度排序,共 13 条(另有 3 条悬置项单列,不占必须补队列)。前五条:
1. Lead 在 issue thread 的发言工具面 + 投递分流(chat-thread 工具缺失,已实际撞过)→ **无单**(最近邻 FLY-1547/1551 需显式扩 scope)
2. ship 前 CI 绿灯:**v2 现在红 CI 也照合**(`ship.ts` 只核 HEAD/票据,零 checks 查询)→ FLY-1545(In Progress)
3. issue 三显示面(标题徽章/置顶头/状态行,从真实状态派生)→ FLY-1549(Urgent)
4. founder 审批 UX:Discord 文本/reaction → `approve-ship` 的翻译层 → **无单**
5. Linear 接入(水合含附件、状态回写 Done、label 路由)→ **无单**

另单独一条 founder 点名级(⚑ §5-7):**runner/会话停摆不可见** —— v2 里「活着但不推进」与「在思考」对系统完全不可分辨,本单执行当天实测撞了两次(48min + 24min,均由 founder 先发现)。v1 的 timeout/stuck 看门狗族判「故意不要」不搬;真实缺口是 **runner 会话没有结构化进展/心跳合同**(显式信号,不靠 pane 猜测),连同 dlq/skip 账本无人消费一起补。

**「v1 哪些东西我们是故意不要的?」** → §6,五大结构性绕路家族(多真相源对账层、投递追讨/收据层、看门狗族、per-vendor 分叉、岗位层+上一代泛化引擎)+ 它们在 v1 里的全部化身(约 130 个模块),每族都给出 v2 的替代结构和设计出处。**这些永不搬进 v2。**

规模实测:v1 三大件非测试源文件 **639 个**(teamlead 484 / edge-worker 77 / flywheel-comm 78),另有 lead-rules-base 20 份行为合同、~40 个 scripts、12 份 workflow seeds。v2 全 8 包 **101 个**源文件、19 张业务表、15 个 CLI verb。

---

## §1 范围与方法

- **范围**:issue 指定的 v1 三大件 `packages/teamlead`、`packages/edge-worker`、`packages/flywheel-comm`(源码 + bin 入口 + prompts/rules/scripts/static 资产)。相邻 v1 包(`claude-runner` 的 adapter 家族、`agent-team-transport` 的 JSON 信箱真身、`voice-*`、`qa-framework`、`dag-resolver` 等)只在被三大件直接牵出时点名,不逐条展开。
- **方法**:9 路并行子盘点,逐文件读头注释/导出/关键签名,按能力聚类;v2 侧对 8 个 `v2-*` 包全量盘点并从 FLY-1497/1500/1502/1518/1543 设计文档提炼结构性原则作为「故意不要」的判据出处。交叉评审(codex,xhigh)做了 21 文件随机抽样覆盖核对与 8 项源码级事实核对。
- **粒度**:每个源文件都落在某一行里;同族模块(如 `detection-*`)合并为家族条目但成员逐个列名。**没有「其余类似」。**一行只给一个判定;一个模块族里若不同成员判定不同,拆成多行。
- **本单不改任何代码、不开子单**;残骸(已无活调用/已收敛的表面)判「故意不要」并在 §8 汇总,处置权交 Lead/founder。

### 判定词表(每条精确四选一)

| 判定 | 含义 |
|---|---|
| **v2已有** | v2 有对应物,指到具体位置;不算缺 |
| **必须补** | v2 没有,缺了会出具体的事;进 §5 排序 |
| **故意不要** | v1 的结构性绕路(或已死残骸),v2 用别的结构替代或无需替代;进 §6/§8 |
| **可共用** | 谁都能调的工具/配置/脚本,v2 直接用,永不重建 |

---

## §2 判据(founder 红线,照此分类)

- **A 类 = 共用工具/配置/脚本 → 用,永不为 v2 重建一份。**
- **B 类 = v1 的结构性绕路 → 永不搬进 v2。**
- 判断方法一句话:**「它是个谁都能调的工具,还是一个为了补架构缺陷而存在的机制?」**
- ⚠️ 不许写成「凡 v1 已有的一律照搬」。

### v2 结构性替代速查(B 类的「为什么当初存在 / v2 用什么替代」总表,出处见 §3)

| v1 结构 | 它当初为什么存在 | v2 替代结构 | 出处 |
|---|---|---|---|
| 多真相源 + 对账族(StateStore 90+ 表 vs comm.db vs tmux vs marker 文件,互相猜) | 每个子系统各自记账,谁也不是权威,只能事后互相对账 | 单一 SQLite 权威库 `~/.flywheel/flywheel-v2.db` + 唯一写入口 `kernel.write()`(禁嵌套写、事务预算、CAS/fence) | FLY-1497 plan §0-§2 |
| 投递追讨/收据层(lead_inbox 5 时间戳、ACK 链、marker 回放、receipt patrol、obligations) | Discord/CommDB/mailbox 投递无事务保证,「送达≠消费≠已处理」,只能账本+游标+看门狗兜 | mailbox 表唯一投递账本 + 一投递=一提案结算(capability 票据)+ `effect_key` 幂等;`obligations`/`commands` 表在迁移 0008 DROP | FLY-1518 §3 D3、§5.1 |
| 看门狗家族(GatePoller 3982 行、HeartbeatService 3277 行、LeadWatchdog、几十个 reconciler) | 状态会飘、投递会丢、进程会僵,只能外部轮询把状态掰回来 | 整族删除:host coordinator 单条 tick(recovery→dispatch→closure→doorbell)+ launchd 一次性 scheduler(心跳修复,跑完即退)+ actions 黑匣子「不认领、不重试、不探测、不补偿」 | FLY-1500 mapping §1、§2.2 |
| per-vendor JSON 信箱(claude teams JSON + sidecar vs codex-teams JSON,锁协议/格式/唤醒全不同) | 白拿 claude-code Agent Team 的 harness 注入,codex 再镜像一套 | DB mailbox 表 + `session:` 前缀按 session 寻址 + doorbell(引擎摁铃贴进终端,runner 不轮询);founder 原话「压根没打算用它那套 JSON」 | FLY-1543 plan §0、断点 4-5 |
| 岗位/角色层(config.yaml `agents:` 段、logicalAgentId、按岗位名寻址 → 同角色全局串行、错投) | 想复用「岗位」概念做提示词和寻址的双重键 | 删除;指令书直接挂 DAG 节点种类 `.flywheel/agents/nodes/<tasks.kind>.md`,fail-closed | FLY-1544 ①,`v2-host/src/role-instruction.ts` |

---

## §3 v2 现状速览(对账的匹配目标)

### v2-* 八包

| 包 | 有什么 |
|---|---|
| `v2-kernel`(25 文件) | 唯一权威库:19 张业务表(tasks/task_dependencies/attempts/events/gates/capabilities/source_receipts/mailbox/thread_bindings/archive_manifest/meta/activations/processing_attempts/agents/config/actions/scheduler_runs/scheduler_leases/scheduler_repair_leases);`kernel.write()` 单写入口;generation fence;四车道候选 SQL(F1/F2/N1/N2,founder 优先);actions 黑匣子四动词;cutover authority + 回滚闸;WAL-safe 备份;migration checksum 台账 |
| `v2-cli`(5) | `flywheel-v2` 15 个 verb:socket 面 `health/register-lead/enqueue/ask/next/submit/ack`;直连库面 `admit/complete/evidence/approve-ship/ship/reconcile-ship/status`;纯外部 `probe-github-lane` |
| `v2-host`(10) | 常驻 host:HMAC 签名 Unix socket 协议(6 action);投递合同随信封下发;coordinator 每 tick 串 recovery→dispatch→closure→doorbell;节点指令解析(fail-closed);tmux runner 启动器(窗口名=issue+节点种类,注入 `FLYWHEEL_V2_*` env);session 证据;**runtime-ports 直接复用 v1 的 `gitWorktreeClean`/`casDeleteRemoteBranch` 等 A 类工具** |
| `v2-engine`(14) | mailbox 消费循环 + 心跳(`agents.last_poll_at`,仅覆盖挂驱动器的 lead)+ 一投递=一提案结算 + 注册/顶替(bump generation、crash-settle 旧代)+ conversion action 接缝 |
| `v2-dag`(25) | admission(图校验 ≤500 节点)、dispatch(15 种带标签 skip 原因)、recovery、closure(整单关闭:停 session、删干净 worktree、CAS 删远端分支、清 registration;fire-once,失败/dirty 留 residue 标记不重试)、doorbell、节点完成合同、evidence、ship gate(`founder_ship_approval` + merge 能力票)、ship 执行/对账、rework 血缘、writer-gap 领养、Discord outbox(固定收件人 `discord-messenger`) |
| `v2-scheduler`(10) | launchd 定时唤起的一次性 tick:全局租约 → 心跳过期 lead → per-lead 修复租约 → 重启(内存水位闸 + 并发闸)→ 记账。非常驻 |
| `v2-actions`(1) | `runRecordedAction` 薄壳:intent → 真实工具 → outcome。明确不是 dispatcher |
| `v2-cutover`(11) | 九步割接 + GO/NO-GO + 旧 writer 围栏 + 数据迁移 + 人工裁定。**窗口已耗尽**(authority=live,已有外部效果,只能 forward repair) |

### v2 在 teamlead 包里的适配层(v1 树上仅有的三个 v2 件)

- `v2-discord-ingress.ts`(bin `flywheel-v2-discord-ingress`):Discord REST 轮询 → v2 CLI socket verb → mailbox。
- `v2-discord-outbound.ts`:以 `discord-messenger` 身份 register-lead → next → submit,消费引擎生命周期事件,建 `[FLY-XX]` issue thread、拉 founder、发进展、归档(FLY-1544 ③④)。⚠️ 内含硬编码 founder Discord user id。
- `lead-backends/codex/{V2DiscordIngress,ExternalReceiptSaga}.ts`:ingress 实现体 + v1↔v2 迁移期 receipt saga。

### v2 目前没有的外部面(v2-* 包内为零,§5 的候选池)

standup/日报、triage、fleet/management console、HTML 报告发布、voice、memory/CIPHER、Linear 接入(issue 只以 `external_issue_id` 字符串存在,admission 由外部递 descriptor;**ship/merge 路径零 CI/checks 查询**)、告警族自身(刻意留在 v1,FLY-1518 §5.2「不删 v1 告警族」)。

---

## §4 对账表(逐条)

列说明:**v1 能力 | 干什么 | v2 对应(有→指到哪;没有→「无」)| 判定 | 说明/归单**。判定精确四选一;残骸行判「故意不要」并注 §8。

### 4.1 flywheel-comm(78 文件,bin `flywheel-comm`,46 subcommand)

#### 4.1.1 CLI 骨架与存储

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| CLI 入口 + 46 subcommand 分发(`index.ts`) | Runner/Lead 的本地控制面总入口 | `flywheel-v2` CLI 15 verb | 故意不要 | 入口自身启动即过 `requireLegacyWriterAllowedFromEnvironment`(v2-kernel 的旧 writer 封口闸)——v1 CLI 在 v2 里被整体定性为 legacy writer |
| comm.db 全 schema + `CommDB` ~130 方法(`db.ts`) | 每项目一库的消息/会话/wake/park/turn 真相 | kernel 19 表单库 | 故意不要 | 多真相源本尊之一;messages 表 17 个 `ALTER TABLE ADD COLUMN` + 三次整表重建,schema 是补出来的不是设计出来的 |
| DB 路径解析(`resolve-db-path.ts`)、输入校验(`validate.ts`) | `--db`/env/`--project` 寻址;路径穿越与 ReDoS 防护 | kernel `paths.ts` 显式传路径 | 故意不要 | 每项目一库的寻址问题在单库结构下不存在;校验思路(边界验证)v2 已内建 |
| 大内容外置(`utils/content-ref.ts`,>2KB 落 refs/ 文件) | 绕开消息表大正文 | mailbox payload 直存 + 1MiB 帧上限 | 故意不要 | v2 信封有体积闸,无需两阶段文件外置 |

#### 4.1.2 问答与 gate 体系

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `ask` / `check` / `pending` / `respond` / `send` / `inbox` | Runner↔Lead 单条消息六件套 | `ask` verb(收件人服务端解析)+ mailbox `next`/`submit` + doorbell | v2已有 | v2 的 ask 刻意无 `--to-agent`(按 session 的 issue 解析 lead),消灭了 v1 的错投面;`send` 的 mailbox 双写(FLY-168 补丁)不再需要 |
| `gate <checkpoint>` 阻塞门 + `--no-block` + 48h 超时 + fail-close | Runner 停下等 Lead/founder 决策 | gates 表(`founder_ship_approval`)+ 节点合同 + brainstorm 类 gate 由节点指令书驱动 | v2已有 | v2 只保留 founder ship gate 为硬门;评审/设计对齐降为 DAG 节点间合同,不再是通用阻塞原语 |
| ship CI 绿灯探测(`ship-ci-guard.ts`) | `approve_to_ship` 进门前查 PR checks,红/未知直接 throw | 无:`v2-dag/src/ship.ts` 只核 HEAD/票据后直接 merge,零 checks 查询;`probe-github-lane` 只体检 lane 配置,未接入 ship | 必须补 | **§5-2 / FLY-1545(In Progress)**。FLY-1545 自己记录「全仓零处 CI/checkRun 检查,红的也合」 |
| gate/ask marker 文件(`gate-marker.ts`) | Codex Runner 跨进程 `awaiting_gate` 判定 + 唤醒路由 | 无需:session 寻址 + doorbell | 故意不要 | marker 是 per-vendor 唤醒不对称的补丁 |
| `await-codex-gate` | 轮询 review json 文件的阻塞门 | DAG review 节点 + 节点完成合同 | 故意不要 | 文件轮询门被节点间依赖边替代 |
| founder-UX 三段(`founder-ux.ts` declare/record/await) | founder UX 签核门(CLI declare/await + Bridge 特权签字,三段共同构成 fail-closed 硬停;fleet 级默认退役是 FLY-900 的显式开关) | 无 | 故意不要 | 替代依据是结构性的:v2 `design_iterate` 节点合同本身要求 founder 选定方向后才 handoff,「founder 对齐」内化为图内节点,不需要旁挂签核库与三段协议 |

#### 4.1.3 授权对账(verify 家族)

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `verify-approval --pr-head`(四路本地复核,「唤醒永远不是权威」) | ship 前强制权威复核 | capabilities 一次性 merge 票(approve-ship 铸票,ship 验票即耗) | v2已有 | v1 要四路对账才敢信,v2 结构上只有一张票、consumed 即失效——同一目的,结构性达成 |
| `verifyLifecycleConsent`(库能力,无 CLI) | runner 生命周期动作的 founder 授权校验 | capabilities + founder gate(生命周期动作走 founder-gated 通道) | 故意不要 | FLY-245 gateway 专用;v2 的能力票模型覆盖同类需求 |
| `evaluateShipEligibility` / `evaluateQaShipGate` | 「能不能进 Done」的双子门(merge approval + QA) | ship gate + DAG QA 节点前置边 | v2已有 | QA 在 v2 是图内节点依赖,不是事后资格核查 |
| founder 归因白名单(`founder-attribution.ts`) | 谁写的 approve 算 founder 侧 | gates.resolver + capability issuer/audience | v2已有 | 归因内建于票据结构 |
| founder-consent 审计库(`founder-consent-audit.ts`,独立 SQLite) | FLY-175 决策语料 | events 事实账本 | 故意不要 | 独立库的存在理由是「teamlead 的 sql.js 不能跨进程并发写」——kernel 单库后不成立 |
| 审批意图分类(`approval-intent.ts`,中英文 approve/reject/neutral) | 自由文本 → 意图 | 无 | 必须补 | 随 **§5-4** founder 审批 UX;是 Discord→`approve-ship` 翻译层的现成组件 |

#### 4.1.4 complete 家族与阶段上报

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `complete --route`(7 route:auto_approve/needs_review/blocked/ship_attempt_failed/no_code/pr_handoff/phase_design_complete)| Runner 终局事件,4 次重试 + fail-close marker | `complete` verb(节点完成合同)+ submit 结算 | 故意不要 | route 膨胀本身是病:`no_code`/`pr_handoff` 都是为绕开「唤不醒就永卡 awaiting_review」;v2 无 wake 依赖,一个完成合同足够 |
| 设计 HTML 证据铸造(`design-html-evidence.ts`) | design 完成必须证明 HTML 已提交 | `evidence` verb + 节点合同 | v2已有 | 证据模型泛化了这一特例 |
| `stage set`(fail-open) | 向 Bridge 报流水线阶段 | 节点状态即阶段(tasks.state) | 故意不要 | 阶段是图的派生属性,不再需要 Runner 自报 |
| `qa-result` / `codex-review-result` / `request-review` / `review-ruling` | 评审/QA 回执发射器(4 重试 + marker) | DAG review 家族节点(`families.ts`)+ 完成合同 + 跨厂商评审为节点指令书规则(FLY-1544 ②) | v2已有 | 回执发射器族的重试/marker 机制随投递层一起退役 |
| `codex-resume`(零插值周期启动器) | tmux watcher 安全拉起 codex | v2 tmux-runner-launcher 注入 bootstrap 信封 | v2已有 | 启动器统一,不再 per-vendor 各写一个 |

#### 4.1.5 lead_inbox / receipt 队列(投递补偿层)

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `lead-inbox-queue.ts`(2115 行:priority 0-3、claim/lease、resend_of/resend_round、processed_evidence、receipt_alert_outbox、5 个时间戳) | 「Lead 收到了但可能不处理」的全套追讨状态机 | mailbox pending 即活 todo:lead 机械通知读即结(ack),runner_ask 只有回了才结 | 故意不要 | v2 协议原文「no receipt table, no second ledger」;v1 的 delivered/consumed/read/processed/disposed 五时间戳是投递不可靠的架构自白 |
| `chat-receipt` begin/complete/settle/pending/quarantine | Discord 聊天消息持久回执 | 同上 | 故意不要 | |
| `route-founder-reply` / `handle-receipt` / founder 回帖候选冻结(`founder-reply-routing.ts`) | founder 回帖 → pending question 的转投与幂等处置 | founder 回复经 ingress 入 mailbox,lead 按信答复 | 故意不要 | 候选冻结的存在理由(FLY-910 歧义噪声)源于多真相源匹配,v2 单账本下不复现 |
| `lead-inbox-nudge`(门铃)/ `ack-event` | 入队后提示 + backend 中立 ACK | doorbell(引擎摁铃)/ ack verb(空提案结算) | v2已有 | 语义同名但结构反转:v2 的 ack 是消费型结算而非回执追讨 |

#### 4.1.6 Lead 租约与唤醒

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `lead-lease.ts` + `lead-lease-mode.ts` + `canonical-lead.ts` + `lead-lease` CLI(单活保证、authorizeLeadWrite、双活 episode 簿) | 同一 Lead 只许一个进程写 | agents 表 generation fence + `register-lead` 即顶替(旧 credential 随注册废止,旧代拉取被拒) | 故意不要 | v1 用租约+审计+旁路 env(`FLYWHEEL_LEAD_LEASE_BYPASS`)拼单活;v2 用世代围栏结构性达成,无旁路 |
| mailbox 唤醒(`wake.ts`,「wake is a HINT never authority」三处重复声明) | best-effort 唤醒空闲 Runner | doorbell + 四车道公平拉取 | 故意不要 | 「唤醒不是权威」的反复声明本身就是通道可伪造的自白 |
| `turn`(三段式单写者自检)/ `park`/`busy`/`unpark`(自声明存活) | 共享 worktree 写权 + 看门狗降噪 | attempts 单 active attempt 约束 + `pa_one_running` 唯一索引;无看门狗故无需降噪声明 | 故意不要 | |
| workflow activation/credential 解析、`workflow-output` | v1 泛化工作流的凭证与产出提交 | submit effects + capability 票据 | 故意不要 | v1 泛化工作流引擎整体被 v2-dag 取代(见 4.3.9) |

#### 4.1.7 报表与外围投递

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `publish-report`(publish→proofshot→deliver 三步,不可猜 URL) | HTML 报告发布 + Discord 截图卡投递 | 无 | 必须补 | **§5-10 / FLY-1532 已有单**(HTML 发布器从旧 Bridge 拆出);founder 的 triage/token/flag 报告全走这条 |
| `feature-flags report/apply` | flag 报表 + founder copy-paste 翻 flag | 无(v2 config 表 + runtime-config.json,且 FLY-1456 已把 62 flag 定值收敛) | 故意不要 | flag 治理面随 flag 群退役;v2 新 flag 政策 = 尽量不设 |
| `token-report`(薄委托 flywheel-token-usage) | token 用量日报 | 无 | 可共用 | 读 CC 日志的独立工具,只依赖发布管线(随 FLY-1532 迁移) |
| `report-deployed`(at-least-once + 本地 spool) | 「真的上线了」部署账本 | 无 | 必须补 | 随 **§5-6** standup/日报数据面一起归 |
| `notify` / `visual-capture` / `set-artifact` + proofshot 六件(lock/free-port/local-server/artifact-discovery/manifest/选片) | 截图证据采集与投递 | 无 | 可共用 | proofshot 是独立 CLI 工具链,谁都能调;投递端点随 FLY-1532 换 |
| `account-rotation-notify` | Codex 账号轮换上报 Alerts | 无(告警族刻意留 v1) | 可共用 | 走保留的告警通道 |
| `founder-time` | Annie 本地时间(FLY-1319) | 无 | 可共用 | 纯工具,v2 侧文案/调度直接调 |
| `runner-config apply` | 改项目 `.flywheel/config.yaml` runner 默认值 | 无(v2 executor 定义在 task payload/envelope) | 故意不要 | v1 的 roles.runner 配置面随岗位层退役 |
| `sessions`/`sessions register` / `progress`(单写者 progress.md)/ `cleanup`(消息 TTL)/ `cleanupStaleSessions`(库) | session 登记、进度账本、消息清理 | activations + session 证据 + FLY-1544 ④ 进展自动推送 | v2已有 | v1 的 progress.md 单写者被 progress ask 替代;消息 TTL 由 retention_class/archive 承接 |
| `capture --exec-id` / `search --exec-id --pattern` | tmux 抓屏 / 安全正则搜屏 | 无 | 可共用 | 运维刚需的独立小工具(`tmux capture-pane` 薄封装 + `buildSafeRegex`),不挂 comm.db 也能活;建议独立化保留 |

#### 4.1.8 小红书线(v1 唯一业务垂直线)

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `xiaohongshu-state.ts` + `xhs-state` 21 子命令(collection 状态机、lease、op-intent 对账) | 定时学习的状态所有者 | 无 | 可共用 | 独立 state dir(`FLYWHEEL_XHS_STATE_DIR`),不挂 comm.db,skill 驱动,v2 直接用 |
| `xiaohongshu-final.ts` + `xhs-validate-final` | prune-gate FINAL 信封校验 | 无 | 故意不要 | 头注释自陈是「gate 释放语义太松」的直接补丁;v2 gate 不存在同类松动 |
| 分析/反馈数据层(`xiaohongshu-analysis-store.ts`)+ review 定位器/投递产物 + `xhs-analysis` CLI | 事后 review 模型与手机端回执 | 无 | 可共用 | 原子写 0600 的本地存储,接口即复用缝 |
| (teamlead 侧)`xiaohongshu-routing.ts` + `xiaohongshu-scheduler.ts` | 路由校验 + 定时派发(POST /api/runs/start) | 无 | 故意不要 | 派发机制绑死 v1 runs API(cutover 后不可达),机制本身不搬;**这条产品线是否续 → §5 悬置项 H2**,续则新归一个「定时 admission 入口」小单 |

### 4.2 edge-worker(77 文件,纯库无 bin)

> 本包实际住着两条互不相干的链:**链 A** = Runner 执行侧(DagDispatcher→Blueprint→adapter→Bridge,FLY 时代主链);**链 B** = Linear webhook 侧(EdgeWorker→AgentSessionManager→ClaudeRunner,Cyrus/CYPACK 遗留)。

#### 4.2.1 链 A:Runner spawn 主干

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `Blueprint.ts`(3029 行编排:PreHydrate→worktree→skill→prompt→execute→git 检查→证据→Decision→终局) | 一次 Runner 执行的全流程 | v2-dag dispatch + v2-host tmux-runner-launcher + 节点指令书 + complete/evidence 合同 | v2已有 | v1 把编排/提示词/证据/判路揉在一个类;v2 拆成图引擎 + 启动器 + 指令书 + 合同 |
| `DagDispatcher.ts` + `flywheel-dag-resolver` | DAG ready 节点并发派发 | v2-dag `dispatchOnce`(15 种带标签 skip 原因) | v2已有 | v1 的布尔坍缩(能不能派)在 v2 变成带标签的拒绝理由 |
| `PreHydrator.ts` | 从 Linear 抓 issue title/description/labels | 无(v2 只存 `external_issue_id`,admission 由外部递 descriptor) | 必须补 | 随 **§5-5** Linear 水合入口 |
| `AttachmentService.ts` | 从 issue 描述/评论抽 `uploads.linear.app` URL 下载到 Flywheel attachments 目录(`<flywheelHome>/<workspace>/attachments`);原生 attachments 以链接形式列入 manifest(不下载) | 无 | 必须补 | 随 **§5-5**:没有附件水合时,runner 拿不到 issue 所附的设计图/日志/截图——「按附图实现」类 issue 直接盲做 |
| `ExecutionEventEmitter.ts` | 生命周期事件 POST Bridge(带重试) | submit effects(结算式上报) | v2已有 | |
| `GitResultChecker.ts` / `ExecutionEvidenceCollector.ts` | 「成功=有 commit」判定 + diff 证据 | manifest.ts(git manifest 构造+分类)+ evidence verb | v2已有 | |
| `resume-mode.ts`(DEAD runner 重派提示词,双层 fail-closed) | 断点续跑 | `resume.ts`(T7 后恢复 activation)+ rework 血缘 | v2已有 | |
| worktree 管理(`WorktreeManager.ts`:生命周期、key 派生、generation nonce、in-place takeover、canonicalize) | worktree 创建/复用/防删错 | dispatch 的 worktree receipts + closure 整单清理(v2-host runtime-ports **直接复用** v1 `gitWorktreeClean`/`casDeleteRemoteBranch`;closure.ts 停 session、删干净 worktree、CAS 删远端分支) | v2已有 | A 类复用的正面样本。真实残差(closure fire-once、residue 无人对账、进程树收割)见 4.3.4 与 **§5-8** |
| Decision Layer(`DecisionLayer/HardRuleEngine/rules/HaikuTriageAgent/HaikuVerifier/FallbackHeuristic`) | 执行后 LLM 判路(auto_approve/needs_review/blocked) | 无:founder ship gate + review 节点 + 完成合同 | 故意不要 | v2 把「机器判能不能自动过」整个撤掉——merge 一律 founder-gated,评审是图内节点;不存在 auto_approve 通道 |
| `AuditLogger.ts`(判路审计 sql.js) | decision 审计库 | events 账本 | 故意不要 | 又一个并列真相文件(与 cipher.db/comm.db/teamlead.db 并存) |
| adapter 消费面之 claude/codex(backend 查表、spawn 参数、codex 语义分叉 20+ 处、skill framework 分臂) | per-backend 执行差异 | v2-engine 注入垫片(claude/codex)+ executor 字段(vendor/model/effort)随 envelope | v2已有 | v1 在 prompt 层 per-vendor 发散的教训:vendor 差异应收敛在 adapter/垫片层(§6 尾注 b) |
| adapter 消费面之 antigravity/kimi(+ ponytail/matt-skills 探针对其硬编码不支持) | agy/kimi 后端(FLY-493/494 均 Done,Linear SSOT 明确立为 first-class Runner backend) | 无(**v2-host `tmux-runner-launcher.ts` 只接受 claude/codex** 两种 vendor,launcher 侧无 agy/kimi 装配) | 必须补 | **§5-13**:派 agy/kimi 型任务时 v2 launcher 拒收,任务无法启动;缺口落点 = v2-host launcher 的 vendor seam(v1 Antigravity/KimiTmuxAdapter 的 4-seam 覆写设计可平移) |
| transport 家族(agent-team 身份透传、`runnerTransportMode:"none"`、pr_handoff 硬规则、wake-guard) | 「谁有邮箱谁没有」的四层补丁 | mailbox 对所有 session 一致 + doorbell | 故意不要 | v1 注释自承 transport 分支曾是 dead code;no-transport 整个概念在 v2 不存在 |
| 三阶段(共享分支 key 收敛、phase prompt、QA 钉 commit、keep-alive takeover) | Design→Implement→QA 单 issue 三段 | DAG 模板节点边(design→implement→qa 即三条边) | v2已有 | v1 用 worktree 复用+turn belt 模拟图;v2 直接是图 |
| SkillInjector + 5 模板 | 往项目注入 SKILL.md | 无(flywheel-skills 全局分发 + 节点指令书) | 故意不要 | FLY-214/216 已把 skill 分发全局化;seed 注释自陈「剩 5 个等 de-template 后再迁」 |

#### 4.2.2 CIPHER 与 memory

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| CIPHER 挂点(接在 Decision Layer 的 pattern 注入/预测反馈) | 决策自学习的消费点 | 无(Decision Layer 已判故意不要) | 故意不要 | 挂点随 auto_approve 通道一起撤;「学习层要不要在 v2 复活」→ **§5 悬置项 H1**,产品决策交 founder |
| CIPHER 算法库(Writer 944 行 8 表/Reader/SyncService/dimensions/pattern-keys/statistics) | Beta-Binomial 后验、pattern key、skill→principle 晋升 | 无 | 可共用 | dimensions/pattern-keys/statistics 是纯函数,Writer/Reader 是独立 sql.js 库;若 H1 拍板复活,直接复用不重写 |
| mem0 MemoryService(Gemini + Supabase pgvector) | Lead/Runner 语义记忆 | 无 | 可共用 | 独立服务化的库(带 patch),不依赖 v1 编排;v2 Lead 可直接调。Bridge memory-route 只是转发面 |

#### 4.2.3 链 B:Cyrus/Linear webhook 遗留 + Slack

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `EdgeWorker.ts`(5807 行)/ `AgentSessionManager`(2037 行)/ `GlobalSessionRegistry`(自称未完成重构 Phase 1)/ `RepositoryRouter` / `ConfigManager` / `ActivityPoster` / `AskUserQuestionHandler` / `UserAccessControl` / `SharedApplicationServer` | Linear webhook → ClaudeRunner SDK 会话的完整第二链 | 无 | 故意不要 | Cyrus 遗产;与链 A 各有一套 runner 选择/worktree/prompt 装配。生产主链早已不走这里。注意:其中 AttachmentService 承载的「附件水合」能力单独判必须补(见 4.2.1) |
| `PromptBuilder`(1388 行)+ prompts/ 角色与 19 份 subroutine 提示词 + procedures/ + validation/ | label 路由提示词 + subroutine 流水线 | 节点指令书(9 份 nodes/*.md) | 故意不要 | `ProcedureAnalyzer` 头注释自陈 AI 路由已废、永远回落 "code" |
| `GitService` + `WorktreeIncludeService` + `RunnerSelectionService` | 链 B 自己的 worktree/runner 选择 | — | 故意不要 | 与链 A 并行的第二套实现,本身就是重复建设 |
| Slack 族(`SlackInteractionServer`/`parseActionId`/`ReactionsEngine`/reactions/*/`SlackNotifier`/`SlackChatAdapter`/`ChatSessionHandler`) | Slack 按钮审批回路 | 无 | 故意不要 | Slack 时代残骸(§8) |
| `HookCallbackServer` | Claude Code hook 回调(session-end) | v2 无需(complete 合同自报) | 故意不要 | |
| `sinks/`(IActivitySink 抽象) | 平台无关 activity 投递抽象 | Discord outbox 单收件人 | 故意不要 | 包内唯一干净的抽象层,但服务的是链 B |

### 4.3 teamlead(484 文件 + 资产;Bridge = `plugin.ts` 11506 行组合根)

#### 4.3.1 核心状态面

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `StateStore.ts`(33518 行,90+ 表,sql.js) | Bridge 全部运行态单点 | kernel 19 表 + better-sqlite3 单写 | 故意不要 | 多真相源的最大本尊;90+ 表里约三成是「记录观察到的偏差留给巡检收敛」的对账表 |
| `applyTransition.ts` + WorkflowFSM + `DirectiveExecutor.ts` | 唯一状态迁移入口 + FSM 校验 + directive(仅 audit) | tasks.state CHECK 约束 + kernel CAS/fence | v2已有 | v2 把「合法迁移」下沉到库约束层 |
| `DirectEventSink.ts`(1533 行,自陈 mirrors event-route) | Bridge 进程内事件直写 | 单写入口天然无「HTTP 自 POST vs 进程内直写」双路 | 故意不要 | 逻辑双写(与 event-route 镜像维护)是 v1 结构病灶的典型标本 |
| `EventFilter.ts` | 事件优先级标注(FLY-163 后只标注不过滤) | 四车道候选 SQL(founder 优先) | v2已有 | 优先级进了拉取序,不再是事件属性 |
| `config.ts` / `ProjectConfig.ts` / `department-registry.ts` | Bridge env 配置、projects.json 名册、部门授权 | runtime-config.json + config 表;projects.json 仍是舰队真相 | 可共用 | projects.json(Lead 名册/频道/token env)是全机共用配置,v2 ingress/outbound 同样要读;部门授权(label→lead 唯一路由)v2 尚未接 Linear,随 §5-5 |
| `operational-terminal-status.ts` / `stage-utils.ts` / bridge `types.ts` | 终态词表/stage 常量/类型 | tasks.state 词表 | 故意不要 | 词表随状态模型更换;bridge types.ts 的 `@deprecated notificationChannel` 为残骸字段(§8) |
| 顶层 `src/types.ts`(空 `export {}`) | — | — | 故意不要 | 残骸,确定 dead(§8) |

#### 4.3.2 事件摄取与动作面

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `event-route.ts`(3160 行,POST /events + heartbeat) | Runner/CLI 全部生命周期事件入口 | host socket 6 action + submit 结算 | 故意不要 | 「事件摄取 + FSM + 收尾 + 通知」的巨型入口被「一投递=一提案」结构替代 |
| `actions.ts` 之 FSM 动作执行(transition/terminate/retry 的状态推进) | dashboard/Lead 动作 → FSM 迁移 + 副作用 | approve-ship/ship verb + rework/attempt-terminal | v2已有 | |
| `actions.ts` 之 founder 一键动作面(dashboard/手机上的 approve 按钮通道) | founder 无 CLI 时的动作入口 | 无(v2 只有 CLI verb) | 必须补 | 并入 **§5-4** founder 审批 UX |
| `artifact-event.ts` | artifact_emitted 投递 | 无 | 可共用 | 截图证据投递随 FLY-1532 管线走 |
| `design-html-admission.ts` | design 完成证据校验 | evidence 合同 | v2已有 | |
| `account-switch-route.ts`(永久 410) | 已退役壳 | — | 故意不要 | FLY-1456 收敛残骸,待删(§8) |

#### 4.3.3 gate 轮询、ship/land、founder 审批链

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `gate-poller.ts`(3982 行,v1 最大常驻 poller) | question/gate 分发 + 误投巡检 + milestone + founder 通道健康 | coordinator tick + 四车道拉取 + doorbell | 故意不要 | 看门狗族头号成员;它身兼的「分发」由 mailbox 结构性解决,「巡检」族整体退役 |
| `gate-materializer.ts` / `question-admission.ts` / `issue-gate-supersede.ts` / `merged-gate-guard.ts` / `lead-pending-escalation.ts` | gate 物化 6 段 stage、准入、僵尸 gate 清扫、已合并抑制、压 gate 升级 | gates 表单行 + capability;superseded 场景由 fresh-authority recheck 覆盖 | 故意不要 | 全族是「多真相源收敛 + storm 抑制」补丁 |
| `merge-ship-gate.ts` / `head-authority.ts` / `materialized-head-authority.ts` | 权威发货判定 + 可信 HEAD | ship gate 绑 exact head + merge 票 + `deriveTargetPrHead` rev-parse-only | v2已有 | 「调用方 SHA 不可信」教训已内建 v2 票据 |
| `land-executor.ts` / `land-cleanup-opportunity.ts` / `post-merge.ts` / `post-ship-finalization.ts` | land 推进、清场、tmux 收尾、统一终结 | `executeShip` + closure 循环 + FLY-1544 ⑤ 整单结束收会话 | v2已有 | |
| `linear-issue-finalizer.ts` | 确认合并后把 Linear issue 翻 Done(写前重读,canceled 不覆写) | 无(v2 零 Linear 写入) | 必须补 | **§5-5**:issue 做完 Linear 还停在 Todo,triage 视图与事实漂移 |
| approval-signal 家族(19 文件:canonical-founder-id、Tier-2 精确白名单、Tier-3 Haiku 分类、text/reaction/voice 三源、gate-message-binding±store、gate-authority-view、write-gate-response、response-guard、handler/factory ×2、deferred-approval 890 行、founder-ack) | founder 在 Discord 的批准 → 权威写入 | `approve-ship` verb + gates + capability;**Discord→verb 的桥接无** | 必须补 | **§5-4,无现成单**(FLY-1545 只含 CI 绿 + 既有 gate 真机验证,不含 Discord ingestion/意图/reaction 桥)。v1 这 19 个文件是「founder 说了句话」到「机器敢 merge」的全部翻译层;v2 结构端已就绪,缺的是 Discord 侧翻译;tier2-allowlist/reaction 观察原语可直接搬(§7) |
| founder-consent 家族(10 文件:config/reserved-endpoints/evaluator/prompt/cache/discord-fetch/audit/middleware/gate-response-router/wiring) | FLY-175 Haiku 硬闸(默认 off) | founder ship gate 结构闸(merge 无票不可行) | 故意不要 | 语义闸(LLM 判 founder 是否同意)被结构闸(没票就是不行)替代 |
| founder-ux 家族(5 文件:routes/verify/signoff/stage-guard/trigger) | founder UX 签核门(与 4.1.2 的 CLI 三段共同构成 fail-closed 硬停) | 无 | 故意不要 | 同 4.1.2:v2 用 design_iterate 节点合同内化 founder 对齐;fleet 级退役是 FLY-900 显式开关,不是「本来无强制力」 |
| founder-* 投递族(founder-thread-notifier 801 行、founder-reply-deliverer 777 行、founder-reply-watchdog、founder-action-drain、founder-approval-projector、founder-decision-convergence、founder-milestone-config-source) | founder 面向投递 + 回复摄取 + 账本 drain | ingress(founder 消息入 mailbox,F1 车道优先)+ outbound(通知出 mailbox) | 故意不要 | 「持久化意图账本 + 有界 at-least-once + 游标钉住检测」全族是投递不可靠补偿;v2 mailbox 单账本结构性解决 |
| `founder-notify-utils.ts` | snowflake 判定/时间互转/截断等纯工具 | — | 可共用 | A 类小工具 |

#### 4.3.4 Runner 派发、生命周期与清理

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `run-dispatcher.ts`(1606 行)/ `run-infra.ts`(1248 行)/ `runs-route.ts`(3438 行)/ `retry-dispatcher.ts` | 派发实现 + 每项目基础设施 + HTTP 面 | dispatchOnce + launch claim + tmux-runner-launcher | v2已有 | runs-route 里的 `workflow_v2`/`pipeline_dag_v1` 双轨分支是迁移脚手架(§8) |
| `retry-dispatch-wal.ts` / `started-evidence.ts` / `session-wait.ts` / `launch-claim-store.ts` / `generalized-launch-recovery.ts` | retry 幂等 WAL、权威启动证据、落库等待、launch 去重、恢复探活 | dispatch 的 durable launch claim + recovery 循环 + `recovery_*` skip 标签 | v2已有 | v1 为「retry 是唯一非幂等动作」打的全部补丁,v2 在 claim 结构里原生化 |
| `runner-admission.ts`(per-core load + 内存下限准入)/ `run-quiescence.ts` | 起 runner 前的资源背压 | 无(scheduler 的 memory-watermark 只闸 Lead 重启;dispatch 起 runner 零背压) | 必须补 | **§5-12,无单**(FLY-1540 只收 1538 R6 转出的 credential/lock/installer 五项,不含背压) |
| `close-runner.ts`(808 行)/ `crash-reaper.ts` / `runner-teardown.ts`(会话级关闭) | 按状态关/保 tmux 现场 | closure + attempt-terminal + terminal-mail | v2已有 | |
| 进程树级收割(`mcp-descendant-reaper.ts` / `chrome-session-reaper.ts` / `terminal-tab-reaper.ts` / `viewer-session-reaper.ts`) | MCP 后代/Chrome/Terminal 标签/viewer 会话回收 | 无 | 必须补 | **§5-8**:v1 实测 MCP 子进程 reparent 到 launchd 活 12 天、viewer 僵尸一次 36 个;v2 长跑同样会积累 |
| lifecycle 编排(lifecycle-admission/closeout 1483 行/routes) | park/unpark/closeout HTTP 面 | closure + closeShippedIssues;park 语义=gates open + mailbox pending | v2已有 | |
| `lifecycle-root-key.ts` | identifier/UUID/QA 子 issue 折叠到同一把锁 | 单一 canonical key 结构 | 故意不要 | 「同 issue 两把锁」缺陷补丁 |
| `lifecycle-sweep.ts`(1163 行,worktree/branch 四类周期扫)+ worktree 族(worktree-cleanup/reconciler/quarantine/inspect)+ `branch-cleanup.ts` + `cleanup-policy.ts` + `repo-mutation-lock.ts` | 清理纵深:即清/boot 对账/删前隔离归档/未推送取证/CAS 删分支/保护分支闸 | closure 整单清理**已有**且复用 v1 A 类工具(`gitWorktreeClean`/`casDeleteRemoteBranch`,v2-host runtime-ports);**但 fire-once**:dirty/unknown 或任一步失败留 `issue_closure_residue`/failed marker 后不重试,无 operator 对账/boot audit | 必须补 | **§5-8,无单**。补的是「residue 对账工具(operator 可跑)」,不是重建常驻 sweep;quarantine(删前归档+restore-smoke)与 protected-branches 闸的思路随之平移 |
| runner wake/追讨族(`runner-wake.ts` / `runner-receipt-patrol.ts` / `runner-recovery-nudge.ts` / `runner-ready-to-close-notifier.ts` / `stale-approved-ship-reconciler.ts` / `stale-blocker-guard.ts` / `workflow-ship-ready-arm.ts`) | 唤醒 + 回执巡逻 + 轻推 + 停滞重唤 | doorbell + mailbox 结算 | 故意不要 | 投递追讨族 |
| runner 观测之 auth/quota 扫描(`runner-auth-scan.ts` / `runner-quota-scan.ts`) | 登出/配额封顶识别 | 无 | 可共用 | 判据与告警走 account-heal daemon + 告警族(均保留);不再挂 Bridge 轮询 |
| runner 观测之抓屏原语(`session-capture.ts` / `tmux-lookup.ts` 694 行) | pane 抓取 + tmux 目标解析 | 无 | 可共用 | 同 4.1.7 capture/search:独立小工具化保留 |
| `runner-status.ts` / `runner-model-display.ts` | 四态判定 / 模型展示串 | 无需(状态=tasks.state;展示见 §5-3) | 故意不要 | |
| `ship-relevant-diff.ts` / `retest-head-delta.ts` / `ship-gate-rebind.ts` / `ship-approval-route.ts` | docs-only 豁免 + 重测抑制 + gate 重绑 + 请求式 ship | ship gate 绑 head + reconcile-ship verb | v2已有 | docs-only 豁免在 v2 刻意不设:founder gate 对一切 merge 生效 |
| 三阶段编排(phase-orchestrator 2359 行/phase-actor-reentry/holder-wake-activation/liveness-evidence/codex-phase-shutdown/three-stage-policy/three-stage-config-source) | Design→Implement→QA 跨 session 编排 | DAG 节点边 | 故意不要 | 见 4.2.1;2359 行编排器 vs 三条边 |
| `destructive-verdict.ts` / `dead-exec-activity.ts` | 四输入破坏性动作裁决 / 死 exec 二次探测 | recovery 的 reap_* 标签闸(grace/process_present/head_unreadable/lineage_diverged) | v2已有 | FLY-1329 教训(absent≠死)已进 v2 skip 语义 |

#### 4.3.5 看门狗/巡检/对账族(v1 最大类,整族 B 类)

> 依据 FLY-1500 mapping §2.2 原文:v2 「不提供 lease、retry budget、probe、reconcile、desired/observed 对账、saga、notify-before 或自动告警/义务」。替代 = coordinator tick + scheduler-once + doorbell + crash-settle + 15 种带标签 skip。**这包括 v1 的 timeout/stuck 停摆检测机制本身**——它们是「补观测缺陷的 watchdog/probe」;停摆可见性的真实缺口另以「结构化进展合同」形态单列必须补行(本表末行),不以重建检测器形态回归。**成员逐行,每行独立判定**:

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `HeartbeatService.ts`(3277 行,≥8 条 sweep) | Runner 心跳/僵尸/stale/monitor loss/reap | agents.last_poll_at + scheduler-once(Lead 侧) | 故意不要 | runner 侧显式进展合同 → §5-7 |
| `LeadWatchdog.ts` + `LeadWindowLocator` + pane 族(pane-frames/pane-live-region/quiet-classifier/stuck-pane-confirm) | Lead pane 文本冻结判定 | scheduler-once 心跳修复 | 故意不要 | pane 猜测式判定整族退役 |
| `RunnerIdleWatchdog.ts` + stuck 族(stuck-candidate/stuck-runner-detector/stuck-escalation/stuck-remanage-routes)+ `watchdog-judge(.assembly)`(LLM 判官)+ `watchdog-health` / `watchdog-minimum-set`(退休墓碑) | Runner 空闲/卡死检测 + 判官 + 看门狗健康度 | 无(刻意) | 故意不要 | 「看门狗的看门狗」= 负债自白;在「停摆与思考不可分辨」前提下,timeout 推断必然把长思考误报为停摆——不搬 |
| detection 族 11 文件(gap-scan/focused-frame-scheduler/detector-wiring/escalation/escalation-sinks/reconcile-tick/suspicious/config-source/disposition-receipt/checkpoint-park/orphan-escalation-reconcile) | 缺口扫描→升级→回执 | 无(刻意) | 故意不要 | FLY-1048/1282 一整代检测管线 |
| zombie/ghost 族(zombie-scan/zombie-evidence/zombie-gate-hygiene/statestore-ghost-reconcile/terminal-commdb-sync/terminal-receipt-settlement/residue-harvest/server-loss 778 行) | 两库不一致的全部排列 | 单库结构性消除 | 故意不要 | 病灶不存在 |
| CommDB 对账族(commdb-fsm-reconcile/commdb-session-prune/done-running-reconciler/complete-marker-reconciler 1081 行/external-merge-reconcile 928 行/canceled-pr-close) | comm.db↔StateStore↔GitHub 对账 | reconcile-ship 只读对账(external-merge 场景) | 故意不要 | |
| 投递看门狗族(lead-receipt-patrol/inbox-loop-health-checker/founder-reply-watchdog/notify-digest-expect/notify-receipts) | 「该发的没发出去」自证回路 | 无(刻意) | 故意不要 | 「无声失败要被看见」的需求以 §5-7 消费面形态承接 |
| Bridge 自体检(BridgeEventLoopWatchdog/bounded-shutdown/bridge-exit-marker/boot-sha-check) | 进程卡死自杀/有界关停/脏退出/陈旧 checkout | launchd KeepAlive + 告警族 | 故意不要 | boot-sha-check(防跑陈旧 checkout)思路值得 v2 host 复用,记入 §5-7 说明 |
| fleet-sensors(swap/bot/zombie 三传感器)/ machine-watermark / launchctl / quota-daemon-wake / quota-daemon-cutover(24 行常量) | 机器层观测 | memory-watermark(v2-scheduler 已复刻)+ launchctl kickstart 白名单思路已进 scheduler | 故意不要 | quota-daemon-cutover 是 FLY-1456 残骸(§8) |
| ticket 族(ticket-owner-map/ticket-escalation/runbook-gap) | 告警工单归属/升级/runbook 缺口自动开单 | 无(告警族保留在 v1) | 可共用 | 随保留的告警族存续 |
| **Runner 会话结构化进展合同 + 无声失败消费面**(v1 无直接对应——该需求在 v1 由上述 watchdog 族隐式承担) | 「活着但不推进」要能被系统看见:runner 显式 progress/blocked 信号 + dlq/skip/failed 账本要有人消费 | 无 | 必须补 | **⚑ §5-7**;补显式合同与消费面,不复活 pane/timeout 检测器 |

#### 4.3.6 Lead 投递总线与 ACK 链

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| `lead-runtime.ts` / `commdb-lead-runtime.ts` / `mailbox-lead-runtime.ts` / `runtime-registry.ts` / `lead-delivery-adapter.ts` / `lead-inbox-loop.ts` / `lead-inbox-runtime.ts` / `lead-event-queue.ts` | LeadRuntime 抽象 + 双后端投递 + at-least-once 消费循环 | mailbox + `next --delivery-credential-file` + lead 按 kind 结算(mechanical=ack,ask=答后结) | v2已有 | v1 的「backend 专属批交付」抽象消失:所有 lead 一条拉取协议 |
| ACK 链(lead-event-delivery/lead-event-ack-policy/lead-event-ack-render/protocol-ingress/legacy-ack-drain/legacy-lead-event-reconciler/legacy-delivery-watchdog-policy) | HMAC ACK 投递 + 迁移胶水 | — | 故意不要 | 残骸:`deliveryAckEnabled` 已定值 false(返回类型写死 `: false`),整链休眠(§8) |
| `delivery-secret.ts` / `bootstrap-generator.ts` | 投递签名密钥 / Lead 崩溃恢复引导包 | host secret + register-lead credential;bootstrap 由 lead 自身 session resume 承担 | 故意不要 | |
| Lead 租约/双活(lead-dual-active-scan/lead-lease-diagnostics/lead-lease-self-check/lead-resume-enter) | 双活扫描 + 租约诊断 + 恢复按键 | generation fence(见 4.1.6) | 故意不要 | |
| `lead-alert-helpers.ts` | claims.db 跨进程告警去重 + blocked 标记读 + pane 抓取 | 无(告警族保留) | 可共用 | 与 `scripts/lead-alert.sh` 共写同一 claims.db 的通道层组件 |
| `lead-scope.ts` / `linear-scope.ts` / `linear-query.ts` | label→Lead 归属、Linear 查询 | 无 Linear 面 | 必须补 | **§5-5**;linear-query 是全系统 Linear 读的共用件,v2 水合直接搬 |

#### 4.3.7 Discord 面(threads、display、roundtable、alerts)

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| 基础工具(discord-utils 分片/编辑/typing、discord-post-file 附件、automated-message 前缀、thread-validator) | Discord REST 原语 | ingress/outbound 复用同族实现(chat-thread-utils 注释自陈 v2 messenger 共享) | 可共用 | A 类标本:纯工具,v2 直接用 |
| `chat-thread-utils.ts` / `ChatThreadCreator.ts`(1321 行)/ `chat-thread-register.ts` | per-issue thread 建/注册/渲染 | v2-discord-outbound 建 `[FLY-XX]` thread + thread_bindings 表 | v2已有 | FLY-1544 ③ 落地;FLY-1548(标题带内容)补文案质量 |
| **Lead 发言进 issue thread 的工具面**(Bridge /api/chat-threads/send + tools.ts 路由) | Lead 往 thread 发消息的通道 | 无 | 必须补 | **§5-1,无单**——撞过的「chat-thread 工具」缺口本尊:v2 Lead 只能收 mailbox、回 ask,没有主动往 issue thread 发言的工具。最近邻 FLY-1547(mailbox MCP 面,现 scope 为 send/next/settle/ask/status,**未含 thread-targeted Discord send**)需显式扩 scope 才能收编;从 Lead tool 到 `discord-messenger`/`thread_bindings` 的落点需在归单时定 |
| display 三张脸(issue-display 纯推导/issue-display-refresher/reconnect-title-restore)+ reply-guard + report-issue-thread-resolver | 标题徽章/置顶头/状态行统一推导 + 顶层发言拦截 | 无 | 必须补 | **§5-3 / FLY-1549 已有单(Urgent)**;v1 的 derive-from-real-state 单一状态机设计正确,可平移思路 |
| 归档族(done-thread-archiver/done-thread-reconcile 1112 行/terminal-thread-archive/legacy-phase-thread-sweep) | thread 归档 + 四类漏归档兜底 | outbound 关闭归档(FLY-1544 ⑤) | v2已有 | 兜底扫描不搬(投递可靠后单出口) |
| roundtable 族(RoundtableThreadManager/topic-trigger/roundtable-config/roundtable-text/ensure-thread-from-message/channel-archive-default + roundtable-allowbots±cli) | 圆桌话题线程 + allowBots 自愈 | 无 | 可共用 | 跨 Lead 协作面挂在保留的 Lead/Discord 层,不依赖 runner 编排;随 Lead 舰队迁移(FLY-1534)决定去留 |
| core-room 门禁(core-room-gate±cli) | 非 CoS 在核心房只应 @ | 无 | 可共用 | 纯决策核 + CLI,两后端共用 |
| 告警通道层(lead-alert.sh 侧 + `LeadAlertNotifier`/`MetaAlertNotifier`/`AlertChannelHub` 1055 行/alert-bot-chain/alert-rate-limiter/error-signatures/infra-event-router/infra-alert-wiring/kind-contract/infra-notify/drained-alert-routing/hook-payload/milestone-report-policy) | 告警构造/限流/路由/kind 契约/回声防护 | **刻意保留在 v1**(FLY-1518 §5.2「不删 v1 告警族」;scheduler 经 `FLYWHEEL_LEAD_ALERT_BIN`/`FLYWHEEL_META_ALERT_BIN` 已接) | 可共用 | A 类:v2 自身不实现告警,统一走这族 |
| 告警自动修复/巡检成员(`AutoRepairBot`/`park-watch`) | 保守自动修复(continue 轻推/resume 回车)+ parked 看护 | 无 | 故意不要 | 依赖 v1 状态面与 pane 判定的 watchdog/auto-repair 语义,属 B 类;告警**通道**保留,自动**修复**不搬 |
| `rescue.ts`/`rescue-runtime.ts`/`rescue-route.ts` | 登出 Lead 原地重启自愈 | scheduler-once 心跳修复重启 | v2已有 | |

#### 4.3.8 管理台、报表与产品外围面

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| management console 机器层(contract/snapshot/change-coordinator/writer/section-registry/project-source/topology-source/ssot-providers/cron-source/cron-writer/existing-writers 1092 行/project-runner-model-source) | stage→confirm→apply 两段式管理 launchd/cron/config/模型档位 | 无 | 可共用 | 管的是机器层对象,不依赖 runner 编排;随拆薄 Bridge 存续 |
| management console 之 DAG source/writer(management-dag-source/management-dag-writer) | v1 workflow 模板的投影与发布 | — | 故意不要 | 随 4.3.9 v1 泛化引擎退役 |
| fleet 族(fleet-console±html/model/routes/admin/admin-audit/capabilities/progress/apply-command/data 971 行)+ dashboard-data/dashboard-html + runner-routes | Lead 舰队控制台 + 旧 dashboard | 无 | 可共用 | 机器层运维面;session 数据源随 §5-6 换轨后才有活数据 |
| feature-flag 族(flag-routes/flag-toggle/env-file-writer/feature-flag-config-source/feature-flag-render/feature-flag-report-html/dag-flag-panel±render) | flag 治理 + 手机报告 | config 表;flag 群已被 FLY-1456 定值收敛 | 故意不要 | dag-flag-panel 的 v1/v2 双轨四杆是迁移期驾驶舱,v1 退役后拆除(§8) |
| `standup-service.ts` / `standup-route.ts` / `triage-data-route.ts` / `triage-template-route.ts` + static/triage-template.html + `digest-service.ts` / `digest-route.ts` / `deployments-route.ts` | 日报聚合投递 + 分诊数据/模板 + 部署日报 | 无 | 必须补 | **§5-6,无单**。数据源(StateStore sessions/deployment_events)cutover 后是死账 |
| `report-registry.ts` / `reports-route.ts` / `publish-html-route.ts` / `vercel-deploy.ts` | HTML 发布(不可猜 URL + 保留集重部署) | 无 | 必须补 | **§5-10 / FLY-1532 已有单**;flywheel-comm publish-report 的服务端半边 |
| `memory-route.ts` | mem0 search/add 转发 | 无 | 可共用 | 薄转发面,MemoryService 本体见 4.2.2 |
| `manual-qa-routes.ts` / voice-routes(语音审批窗口) | 手动 QA spawn / 耳机审批 | 无 | 可共用 | 依赖 v1 编排的部分随之退役;voice 产品线独立决策(悬置项 H3) |
| publish-broker 族(10 文件:publish-broker/approval-registry/socket-server/types/release-commit/endpoint-client/registry-client/shell-publish/shell-verify/wire) | 对外发布(npm/customer-release)唯一执行点,founder 三元组审批 | 无 | 可共用 | 面向「对外发布」而非 runner 编排;默认 OFF。若 Bridge 退役需迁宿主(注记,不阻塞) |
| xhs-review 面(xhs-review-html/xhs-review-routes) | 小红书本地评审页 | 无 | 可共用 | |
| `xhs-review-channel.ts` | web-local ReviewChannel 适配器 | — | 故意不要 | 残骸:全仓零引用(§8) |
| `loopback-origin.ts` / `path-hygiene.ts` / `sync-flywheel-hooks.ts` / `tools.ts`(1261 行查询面) | 反 DNS-rebinding、路径卫生、hooks 同步、session 查询 HTTP 面 | host socket 无 HTTP 面;查询由 `status` verb 承接 | 可共用 | 前三者纯工具(path-hygiene 与 shell 版双宿主);tools.ts 的 chat-thread send 部分见 4.3.7 必须补行 |
| autocontinue 族(armer/arming/goal/state,FLY-818) | 空闲 runner 自动 `/loop` 续跑 | 无 | 故意不要 | 「runner 闲下来没人叫」的补丁;doorbell + DAG 依赖驱动后无此空窗 |
| proofshot 触发(proofshot-trigger/proofshot-session/proofshot-deliver) | stage_changed 自动截图 + session_params 读改写 | 无 | 可共用 | proofshot-session 是 StateStore 覆写语义补丁不搬;触发时机在 v2 = 节点合同产出 |

#### 4.3.9 v1 泛化 workflow 引擎域(FLY-13xx 世代,v2-dag 的前身)

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| 模板域(workflow-template 1614 行 schema v1/v2、workflow-menu、work-kind、workflow-run-snapshot、workflow-template-selection、workflow-template-dispatch、workflow-dispatch-resolution、workflow-claims、workflow-submission-expiry、workflow-docs-output、workflow-ship-ready、workflow-template-routes、workflow-menu-routes)+ StateStore 40+ 张 workflow_* 表 + menus/shapes | v1 泛化工作流(模板/运行/claims/gate holder/PR 绑定/返工) | v2-dag 全域(admission/dispatch/completion/gate/ship/rework)+ IssueDagDescriptor | 故意不要 | 同一目标的上一代实现,v2-dag 就是它的重写 |
| workflow-seeds 12 份 YAML 模板内容 | 节点形状/vendor/handoff 知识 | admission descriptor 素材 | 可共用 | 内容是有效知识,形态换掉 |
| 引擎域(workflow-engine-dispatcher 1947 行、workflow-decision-routes 993 行、workflow-shadow-writer 701 行、workflow-engine-park-evidence/projector、workflow-rework-coordinator、workflow-route-reminder-drain、workflow-completion-settled、workflow-docs-materializer、workflow-docs-git、workkind-cutover 869 行、skill-framework-participation)| v1 引擎派单/决策路由/影子双写/割接 | 同上 | 故意不要 | shadow-writer 与 workkind-cutover 是迁移脚手架,使命已尽(§8);workflow-docs-git 复用的 GitPushRunner 安全配置思路已进 v2 |
| review 治理域(review-request-coordinator 1713 行、review-gate-checkpoints、review-verdict-policy、review-governance-effects/prompt、review-ruling-route、claude-review-runner、codex-gate、codex-instruction、codex-global-health) | 跨家族评审绑定协议 + codex 硬闸 | DAG review 家族节点 + 跨厂商评审节点契约(FLY-1544 ②) | 故意不要 | v1 用 request↔gate 显式绑定 + fail-close 修评审错绑;v2 里评审就是图内节点,绑定即依赖边 |
| auto-QA 族(auto-qa-coordinator 2361 行、auto-qa-effects、auto-qa-policy、auto-qa-config-source、auto-qa-held、fanout-finalization) | code review 过→独立 QA Runner→PASS 才见 founder | DAG qa 节点前置于 ship gate | 故意不要 | 编排器 vs 一条边 |

#### 4.3.10 lead-backends(56 文件)+ mailbox(2)

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| Codex Lead 运行时骨架(lead-backend.ts、CodexLeadProcess、CodexLeadRuntime、codex-lead-runtime 1856 行、codex-lead-tui-runtime 995 行、WsTransport、daemon-ws、DaemonConnectionSupervisor、TurnDemux、tui-window±alert、LeadHealthProbe、CodexTurnExecutor) | Codex 当 Lead 的进程/thread/TUI 全套 | v2 不定义 Lead 运行时——lead 是任何能跑 `register-lead`+`next`+`submit` 的会话 | 可共用 | **FLY-1534 已有单**(13 Lead 迁上新引擎)。运行时本体保留为 Lead 宿主;TUI 共 thread 的 fencing 族是形态复杂度,迁移时按需带 |
| 输入路由与 journal(LeadInputRouter、LeadJournal、SqliteJournalStore、CodexLeadInboxSocket、ExternalReceiptSaga) | exactly-once 入账 + Bridge→Lead socket + v1↔v2 receipt saga | mailbox 拉取即入账(credential + 结算) | 故意不要 | journal 是「投递与消费分进程」画错边界后的补账;InboxSocket/ExternalReceiptSaga 是迁移期胶水(§8) |
| Discord 入站(CodexDiscordGateway、RestPollDiscordInboundSource、InboundCursorStore、mention-gate、DiscordTypingNotifier) | Codex 侧自建 Discord 收链 | v2-discord-ingress **正是复用这族**(RestPoll + cursor + gateway) | 可共用 | A 类标本:v2 ingress 没重写,直接装配了它们——正确姿势的现成例证 |
| roundtable 五件(ThreadRegistry/Discovery/reply-route/thread-budget/reply-in-thread-wiring) | 圆桌 reply-in-thread(与 Claude 插件 lockstep) | 无 | 可共用 | 同 4.3.7 roundtable;「人肉 lockstep 两份实现」教训记入 §6 尾注 |
| Discord 出站共享内核(discord-send-core:alias 解析 + 限速 + 幂等 + 审计) | 主动发送的防重复建设收口 | outbound 走 mailbox 单收件人 | 可共用 | |
| Discord 出站三路并存形态(DirectDiscordOutboundSender 默认直发;CodexOutboundSender+CodexLeadOutboundHandler+SqliteOutboundDedupStore+leadDiscordSend 经 Bridge durable outbox,事实冷路径) | 三条投递路径三套去重语义 | mailbox 单出站账本 | 故意不要 | 三路并存本身是 B 类形态;bridge 路四文件为冷路径残骸(§8) |
| confinement 五件(buildCodexLeadMcpArgv、action-surface、mcp-inventory、confinement、secret-broker)+ gateway 9 件(gateway-main 1116 行、GatewayDispatcher、ship-preflight、CodexFounderPreflight、founder-confirmation、lifecycle-orchestrator、lifecycle-requests、retry-dispatch、resolve-target、GitPushRunner 667 行)+ lead-actions 5 件 | write-capable Codex Lead 的沙箱与动作面(FLY-245/350) | founder ship gate + capability 结构闸 | 故意不要 | 「三道防线」的复杂度全部源于 v1 让 Lead 有条件触碰 merge/lifecycle;v2 里 merge 只认 kernel 的票。founder-confirmation 的 reaction 观察原语可为 §5-4 复用(§7) |
| mailbox 薄壳(MailboxTransport) | writeVerified 封装 | DB mailbox | 故意不要 | per-vendor JSON 真身在 `agent-team-transport`(claude teams JSON+sidecar vs codex-teams JSON,锁/格式/唤醒全不同)——B 类最实锚点 |
| `StructuredInboxRouter.ts` | chokidar 结构化收件 | — | 故意不要 | 残骸:零实例化(§8) |
| `bin/validate-projects.ts` | projects.json 校验 CLI(bash 与 Bridge 共用同一权威) | — | 可共用 | A 类 |
| `ci/workflow-permissions.ts` | CI 权限扫描(仅测试消费) | — | 故意不要 | 准残骸(§8) |

#### 4.3.11 account-heal(39 文件)— 配额/账号自愈体系

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| quota daemon 本体(quota-monitor-cli/quota-monitor 1854 行/runtime/config/state 1028 行/alert/credentials + pidfile/runtime-tree-hash) | launchd 常驻 `com.flywheel.quota-monitor`,v1 唯一自动切号权威 | 无(v2 明确不管账号) | 可共用 | **A 类标本**:机器级 daemon,服务所有 Claude 会话(v2 runner/lead 同样受益),FLY-1456 已把它定为唯一切号执行者 |
| 探针层(quota-usage-api/usage-gauge/account-identity/freshness±cli/model-cap/quota-trigger/quota-revive-scan/quota-confirmation/detection-classifier/quota-incident) | 用量/身份/新鲜度/封顶探测 | 无 | 可共用 | 随 daemon 走 |
| 执行器与真相(switch-executor/claude-profile-cli/account-store/account-ledger/accounts-lock/mkdir-lock/machine-account) | Keychain 切号 + 账号池真相 + 跨语言互斥锁 | 无 | 可共用 | mkdir-lock 是 Node/bash 共用并发底座(9 处引用) |
| 告警接线仍活件(account-limit/derive-account-limit/runner-quota-detector/account-rotation-notice) | 封顶元数据 + 轮换通知 | 无(告警族保留) | 可共用 | |
| Bridge 侧被动切号残骸(account-switch-repair/account-switch-watchdog/pending-store 写路径/quota-daemon-cutover) | FLY-1456 cutover 后不可达 | — | 故意不要 | 残骸(§8) |
| 运维 CLI(account-summary-cli/quota-guard-cli/quota-pool-rebuild±cli/rescue-lead-cli) | 日报/活额度校验/池重建/救援 | 无 | 可共用 | 独立 bin,谁都能调 |

#### 4.3.12 资产:lead-rules-base、scripts、launchers、prompts、static

| v1 能力 | 干什么 | v2 对应 | 判定 | 说明 |
|---|---|---|---|---|
| lead-rules 之治理/协作合同(founder-only-authority 481 行、cos-lead-rules、department-lead-rules、cross-dept-channel-rules、companion-safety-contract、external-agent-contract、discord-reply-contract、founder-html-delivery、founder-local-time、default-enable-policy、founder-ux-rules、doc-flow-rules、executor-routing、model-routing、xiaohongshu-memory-rules) | Lead prompt 层治理(改一行=改产品行为) | 节点指令书 9 份承载 runner 侧纪律;lead 侧规则待舰队迁移重编 | 可共用 | **FLY-1534 迁移素材**:与 v1 编排无关的合同直接复用。已知 v1 缺陷勿带入:4 份合同只在 claude 链加载、codex 链缺 |
| lead-rules 之 v1 机制绑定合同(auto-qa-pipeline、runner-messaging-rules、runner-patrol-rules、runner-reengage-rules、stuck-runner-remanage) | 描述 v1 机制操作法的合同 | — | 故意不要 | 所述机制(auto-QA 编排/SendMessage 双写/巡逻/复用/卡死接管)全部退役,合同随之 |
| Lead 启动链(claude-lead.sh 3397 行、codex-lead.sh、lead-rules-bundle.sh、check-rules-truth、post-compact-bootstrap、expect-dev-channels、find-window)+ Codex launcher 家族(run-codex-infra-bot-tui、run-codex-lead-mufasa ×4 档、codex-lead-tui-home、rollback、launchd 模板 ×3) | Lead 拉起/规则拼装/崩溃恢复 | scheduler-once 只管重启,拉起仍走这链 | 可共用 | FLY-1534 迁移中 |
| scripts/lib 单例补丁三件(reap-orphan-adapters/resume-recovery/tmux-supervisor-guard) | 「同一身份两个进程」清理 | generation fence | 故意不要 | fence 后自然消亡;lib 其余(lead-identity-preflight/mcp-inherit)随启动链可共用 |
| 一次性运维脚本(add-roundtable-allowfrom、apply-core-room-mention-gate、archive-roundtable-orphan-threads、decommission-legacy-companion-daemon、fly-513-repoint-global-codex) | 事故补账 | — | 故意不要 | 残骸:使命已尽(§8) |
| 验证/QA 脚本(verify-windowed-lead±self-test、verify-merge-actor-denied、test-lead-alert-dedup、test-tui-window-lost-alert、test-fly26-rules-split、test-fly205-doc-flow-lead、test-rotation、qa-fly259-mufasa-tui-slot) | 取证/回归工具 | — | 可共用 | verify-merge-actor-denied 是 probe-github-lane 的姊妹,v2 车道体检可用 |
| `prompts/runner-lifecycle.md`(自陈 NOT auto-loaded,零引用) | — | — | 故意不要 | 残骸(§8) |
| static/triage-template.html | triage HTML 模板 | 随 §5-6 | 可共用 | 模板内容直接复用 |

---

## §5 必须补清单(按严重度排序)

> 每条给出:缺了会出什么事(具体场景)、v1 对应物、归单建议。排序依据:当天已撞 > 正确性风险 > founder 体验断供 > 运维债 > 低频/低损。已有单的标注当前 Linear 优先级。**本单不开子单**,归属由 Lead 报 founder 后定。

| # | 缺口 | 缺了会出什么事(具体场景) | v1 对应物 | 归单建议 |
|---|---|---|---|---|
| 1 | **Lead 在 issue thread 的发言工具面 + 投递分流** | 已撞过(chat-thread 工具):runner `ask` 进了 lead mailbox,lead 想在 `[FLY-XX]` thread 里和 founder 三方对齐,却没有任何「往 thread 发消息」的工具——只能把回答塞回 ask_response,founder 在 thread 里看到的是单向机器播报。progress/blocked 的分流(谁该看到什么)也没有 | Bridge `/api/chat-threads/send` + tools.ts + GatePoller 分发 | **无单**。最近邻:FLY-1547(mailbox MCP 面)需显式扩 scope 加 thread-targeted send(落点:Lead tool → `discord-messenger` outbox + `thread_bindings`);分流语义=FLY-1551 |
| 2 | **ship 前 CI 绿灯** | **v2 现在红 CI 也照合**:`v2-dag/src/ship.ts` 只核 HEAD/merge 票后直接 `gh` merge,零 checks 查询(FLY-1545 自查原话「全仓零处 CI/checkRun 检查,红的也合」);`probe-github-lane` 只体检 lane 配置未接 ship。founder 批准的瞬间若 CI 未跑完,坏 build 直接进 main | ship-ci-guard(红/未知直接 throw)+ FLY-2 CI 绿 gate 经验 | **FLY-1545 已有单(In Progress)** |
| 3 | **issue 三显示面(标题徽章/置顶 header/状态行)** | founder 扫一眼 Discord 判断不了每张单到哪一步;v1 的教训是 Lead 手写状态必然漂,必须从真实状态自动派生 | issue-display(纯推导)+ refresher(derive-from-real-state 单一路径) | **FLY-1549 已有单(Urgent)**;v1 纯推导设计直接平移 |
| 4 | **founder 审批 UX(Discord → `approve-ship` 翻译层)** | founder 在 thread 里说「批了」/点 ✅,没有任何东西把它翻译成 `approve-ship` verb——现在靠人肉跑 CLI。审批语义(Tier-2 精确短语/否定句/错引 issue 降级)与 reaction 观察是 v1 已交学费的成熟件;dashboard/手机一键动作面同缺 | approval-signal 19 件 + approval-intent + founder-confirmation reaction 原语 + actions.ts founder 动作面 + FLY-1448 durable receipt 经验 | **无单,建议新归**(FLY-1545 现 scope 不含此;扩 scope 或另开由 Lead 定) |
| 5 | **Linear 接入(水合含附件、状态回写、label 路由)** | 已撞过(迁移入口):issue 做完 Linear 还停在 Todo,triage 视图与事实漂移,同一 issue 可能被再次派发;admission 侧「真 Linear issue → DAG descriptor」靠 Lead 人肉拼 JSON;**附件不水合:「按附图实现」类 issue,runner 根本拿不到图** | linear-query/linear-scope/PreHydrator/AttachmentService/linear-issue-finalizer(写前重读、canceled 不覆写) | **无单,建议新归**(FLY-1534 是 Lead 信箱迁移,不含 Linear;勿并) |
| 6 | **standup / triage / 部署日报的数据源换轨** | 每天早上的 standup 与 `/api/triage/data` 读的是 v1 StateStore——cutover 后是死账。founder 失去「昨晚发生了什么/今天有什么在跑」的每日视图;CoS triage 拿不到容量与在途数据 | standup-service/triage-data-route/digest-service/deployments-route + report-deployed spool + triage-template | **无单,建议新归**(数据面:v2 db 的 tasks/attempts/events 是现成更优数据源;呈现复用 §7 发布管线) |
| 7 | ⚑ **Runner 会话的结构化进展合同 + 无声失败消费面** | **本单执行当天两次活证据**:FLY-1548 的执行会话等一个早已死掉的评审进程 48 分钟、本会话在等后台评审时静默 24 分钟——都是 founder 在 Discord 先发现的。v2 里「活着但不推进」与「在思考」对系统不可分辨:心跳只覆盖挂驱动器的 Lead,runner 不挂驱动器、无 poll 即无心跳;mailbox `state=dead`(dlq)行、dispatch 15 种 skip、scheduler `failed` 记账也全部只落库无人消费——投不出去的 founder 通知会安静躺在 dlq 里。**v1 的 timeout/stuck 检测器族判「故意不要」不搬**(pane 猜测 + timeout 推断必然把长思考误报成停摆);要补的是**显式合同**:runner 进入任何等待/长任务须发 `ask --ask-kind progress/blocked`(行为面已由 Lead 下达,应进节点指令书),引擎侧把「合同违约」(超窗无 ask/submit 的 running 会话)与 dlq/skip 积压作为**结构化信号**接入保留的告警族;boot-sha-check(防跑陈旧 checkout)同属此消费面 | RunnerIdleWatchdog/stuck 族(不搬,见 §6-3)+ notify-digest-expect 的「该发没发也是告警」自证思路 + boot-sha-check | **无单,建议新归**(FLY-1540 只收 1538 R6 的 credential/lock/installer 五项,不含此;勿并) |
| 8 | **closure 残差对账 + 进程树收割** | 已撞过(worktree 清理):v2 closure 已复用 A 类工具做整单清理(§4.2.1),但 **fire-once**——dirty/unknown 或任一步失败留 `issue_closure_residue`/failed marker 后不重试、无人消费;长跑积累残 worktree/未删分支,下一个 runner `git worktree add` 撞同名。进程树级(MCP 后代 reparent 到 launchd 活 12 天、Chrome-for-Testing 泄漏、Terminal 标签/viewer 僵尸——v1 一次实测 36 个)v2 零对应 | lifecycle-sweep 四类扫 + worktree-quarantine(删前归档+restore-smoke)+ mcp-descendant/chrome/terminal-tab/viewer reaper | **无单,建议新归**。形态=operator 可跑的一次性对账工具(消费 residue 标记),不是常驻看门狗 |
| 9 | **v2 隔离测试房** | v2 引擎改动(dispatch/recovery/结算)只能生产实弹验证——FLY-1543/1544 都是拿生产窗口试的;一次坏 dispatch 就是真 runner、真 Discord、真 founder 打扰 | v1 的 4-slot QA Room + FLY-529 roundtable/alerts 镜像 | **FLY-1539 已有单** |
| 10 | **HTML 报告发布管线独立化** | token 日报、triage HTML 全走 `flywheel-comm publish-report` → 旧 Bridge `/api/reports/*` → Vercel;Bridge 拆薄/退役后 founder 手机上一张报告都收不到 | report-registry/reports-route/publish-html-route/vercel-deploy + publish-report CLI | **FLY-1532 已有单** |
| 11 | **v2 自 ship(三服务自动更新)** | host/scheduler/ingress 改动 merge 后要 founder 手动重启;自托管开发闭环断在最后一步 | restart-services.sh + FLY-20 CD 流 | **FLY-1541 已有单** |
| 12 | **Runner 派发资源背压** | DAG 一宽(≤500 节点)dispatch 按依赖就绪全速起 runner;v1 实测过 13 runner 同死(server-loss 事故)。scheduler 只对 Lead 重启有内存水位闸,dispatch 起 runner 零背压 | runner-admission(per-core load + 内存下限)+ memory-watermark(v2-scheduler 已有实现可复用) | **无单,建议新归**(FLY-1540 不含此,勿并) |
| 13 | **antigravity / kimi 执行后端垫片** | Lead 派 agy/kimi 型任务时 **v2-host `tmux-runner-launcher` 直接拒收**(vendor 解析只认 claude/codex)——而 FLY-493/494 均已 Done,Linear SSOT 明确把两者立为 first-class Runner backend,无任何撤销决策 | AntigravityTmuxAdapter/KimiTmuxAdapter(claude-runner 包,4-seam 覆写设计健康,可平移到 v2-host launcher 的 vendor seam) | **无单,建议新归** |

### 悬置项(非必须补:无即时事故,产品决策交 founder,不占队列)

| # | 项 | 现状 | 决策点 |
|---|---|---|---|
| H1 | CIPHER/学习层挂点 | 挂点(Decision Layer)已随 auto_approve 通道故意移除;算法库可共用(4.2.2) | 「Lead 自主度随时间增长」主张要不要 v2 载体 |
| H2 | 小红书学习线 | 定时派发打 v1 runs API,cutover 后事实停摆;状态机/存储可共用(4.1.8) | 产品线是否继续;续则新归「定时 admission 入口」小单 |
| H3 | voice 审批面 | voice-* 包独立,Bridge 侧只有薄窗口(4.3.8) | voice 产品线独立决策 |

> 撞过的五个坑对号:chat-thread 工具→#1;worktree 清理→#8;statusline(显示面)→#3(FLY-1549);cmux 同步→FLY-1550 已有单(runner/lead 同环境 + cmux 自动出现,不在三大件范围内故未列行);迁移入口→#5。

---

## §6 故意不要清单(B 类:v1 结构性绕路,永不搬进 v2)

五大家族 + 化身计数(成员逐条见 §4 各表的「故意不要」行):

1. **多真相源 + 对账层**(≈45 模块):StateStore 90+ 表、comm.db、AuditLogger、cipher.db 并列真相;zombie/ghost/commdb-fsm/done-running/statestore-ghost/terminal-commdb-sync 等全部 reconciler;head-authority/root-key/gate-materializer 等「谁是权威」补丁。**当初为什么存在**:每个子系统各记各账,出了事只能事后互对。**v2 替代**:单库单写入口 + CAS/fence(FLY-1497)。
2. **投递追讨/收据层**(≈35 模块):lead_inbox 五时间戳状态机、chat-receipt、ACK 链、complete-marker 回放、founder-action-drain、receipt patrol 族、route 膨胀(no_code/pr_handoff)。**为什么存在**:投递无事务保证,「送达≠消费≠已处理」。**v2 替代**:mailbox 唯一账本 + 一投递=一提案 + capability 票据 + effect_key 幂等(FLY-1518)。
3. **看门狗家族**(≈40 模块):GatePoller/HeartbeatService/LeadWatchdog/RunnerIdleWatchdog + stuck/detection/watchdog-judge + 各健康自检 + AutoRepairBot/park-watch 自动修复面。**为什么存在**:状态会飘、投递会丢、进程会僵,只能外部轮询掰回来;v1 后期「不加新 timer」纪律本身就是负债自白。**v2 替代**:coordinator 单 tick + scheduler-once + doorbell + crash-settle + 带标签 skip(FLY-1500);停摆可见性以显式进展合同承接(§5-7),不以 pane/timeout 推断回归。
4. **per-vendor 分叉**(≈25 模块):claude/codex 两套 JSON 信箱(agent-team-transport)、gate-marker、transport 家族、journal+socket、出站三路、Blueprint 里 20+ 处 `isCodexRunner` prompt 分叉、三处「与 Claude 插件人肉 lockstep」注释。**为什么存在**:白拿各家 harness,再逐家补齐。**v2 替代**:DB mailbox + session 寻址 + doorbell 对所有 vendor 一致(FLY-1543)。
5. **岗位/角色层 + 上一代泛化引擎**(≈50 模块):config.yaml agents 段、logicalAgentId、role-adapter-resolver 的岗位寻址;StateStore 40+ workflow_* 表 + 模板/引擎/claims/审批治理全域;三阶段编排器;Decision Layer(auto_approve 通道);founder-consent 语义闸;auto-QA 编排器;founder-UX 旁挂签核门。**为什么存在**:泛化工作流的第一代实现,在 v1 地基(多真相源+投递不可靠)上越垒越高。**v2 替代**:v2-dag 图引擎 + 节点指令书 + founder ship gate 结构闸 + design_iterate 节点合同(FLY-1520/1544)。

**教训尾注**(写进 v2 的负面清单):(a) 「人肉 lockstep 的两份实现」必然漂移——共享实现或不做;(b) vendor 差异收敛在 adapter/垫片层,一旦漏进 prompt 层就按家发散(Blueprint 之鉴);(c) 每个硬门配逃生 env(v1 有 9 个 bypass/kill-switch)等于没有门——v2 的门不设旁路。

---

## §7 可共用清单(A 类:直接用,调用方式)

| 资产 | 调用方式 | 已被 v2 用? |
|---|---|---|
| **account-heal 全家**(quota daemon + 探针 + 切号执行器 + mkdir-lock + 运维 CLI) | launchd `com.flywheel.quota-monitor` 常驻;bin:`flywheel-quota-monitor`/`flywheel-account-summary`/`flywheel-claude-{freshness,quota-guard,pool-rebuild}`/`flywheel-rescue-lead` | 机器级,天然覆盖 v2 会话 |
| **告警通道族**(lead-alert.sh + claims.db + AlertChannelHub/LeadAlertNotifier/MetaAlertNotifier 通道层 + kind-contract + ticket 族 + lead-alert-helpers) | shell:`scripts/lead-alert.sh`;v2-scheduler 经 `FLYWHEEL_LEAD_ALERT_BIN`/`FLYWHEEL_META_ALERT_BIN` 已接 | ✅(FLY-1518 §5.2 明文保留;自动修复面除外,见 4.3.7) |
| **git/worktree 原语**(`gitWorktreeClean`/`casDeleteRemoteBranch` 等) | 直接 import | ✅ v2-host runtime-ports 已复用 |
| **Discord 基础件**(discord-utils/discord-post-file/chat-thread-utils/automated-message/founder-notify-utils/thread-validator) | 直接 import(chat-thread-utils 注释自陈 v2 messenger 共享同一实现) | ✅ outbound 在用 |
| **Codex Discord 收链**(RestPollDiscordInboundSource/InboundCursorStore/CodexDiscordGateway/mention-gate)+ discord-send-core | 直接装配 | ✅ v2-discord-ingress 就是这么装的 |
| **审批翻译组件**(approval-intent、tier2-allowlist、reaction 观察 checkReactionConfirmation/founder-confirmation) | §5-4 实现时直接搬 | 未接 |
| **proofshot 工具链**(lock/free-port/local-server/artifact-discovery/manifest/选片)+ visual-capture/notify | `flywheel-comm visual-capture`(或独立化后同名 CLI) | 未接;随 FLY-1532 |
| **tmux 抓屏原语**(capture/search、session-capture、tmux-lookup) | 薄封装 `tmux capture-pane` + `buildSafeRegex`,建议提成独立小工具 | 未接;运维刚需 |
| **projects.json + 校验器**(ProjectConfig/parseAndValidateProjects/bin validate-projects) | `~/.flywheel/projects.json`;`dist/bin/validate-projects.js` | ✅ ingress/outbound 读频道与 token env |
| **Lead 启动链与治理合同**(claude-lead.sh 族、lead-rules-base 中与 v1 机制无关的合同) | FLY-1534 迁移素材 | 迁移中 |
| **管理台/fleet console 机器层**(launchd/cron/config/模型档位部分) | Bridge HTTP(loopback);随拆薄 Bridge 存续 | — |
| **memory**(mem0 MemoryService + memory-route)+ **CIPHER 算法库** + **小红书 xhs-state/analysis-store/review 面** + **token-usage** + **founder-time** + **path-hygiene/loopback-origin/sync-flywheel-hooks** + **publish-broker** | 各自独立 bin/库,见 §4 对应行 | — |
| **workflow-seeds 12 份模板内容** + static/triage-template.html | 作 admission descriptor / §5-6 呈现素材 | 部分(nodes/*.md 已承接) |
| **验证脚本**(verify-merge-actor-denied/verify-windowed-lead 等) | scripts/ 直接跑 | — |

---

## §8 附:残骸清单(§4 中判「故意不要」的已死/已收敛子集,处置权交 Lead)

盘点顺手确认的确定性残骸(**本单不删**):

- **定值收敛后的空壳**:account-switch-route(410 壳)、quota-daemon-cutover(24 行常量真值表)、legacy-delivery-watchdog-policy(`: false`)、lead-event-delivery/ack-policy/ack-render(ACK 链休眠)、legacy-ack-drain(one-shot 已耗尽)、watchdog-minimum-set/watchdog-health 的墓碑数组。
- **零引用/零实例化**:StructuredInboxRouter、xhs-review-channel、teamlead 顶层 `types.ts`(空)、StuckWatcher(7 行 @deprecated re-export)、prompts/runner-lifecycle.md、ci/workflow-permissions(仅测试消费)、bridge `types.ts` 的 `@deprecated notificationChannel` 字段。
- **迁移期脚手架(v1 退役时一并拆)**:workflow-shadow-writer、workkind-cutover、runs-route 的 workflow_v2/pipeline_dag_v1 双轨分支、dag-flag-panel±render、ExternalReceiptSaga、CodexLeadInboxSocket、protocol-ingress、legacy-lead-event-reconciler。
- **冷路径**:Codex Lead 出站 bridge 路四件(CodexOutboundSender/CodexLeadOutboundHandler/SqliteOutboundDedupStore/leadDiscordSend,`FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge` 非默认)。
- **Bridge 侧被动切号残骸**:account-switch-repair、account-switch-watchdog、pending-store 写路径(仅 quarantine 调用仍活)。
- **Cyrus/Slack 遗留**:edge-worker 链 B 全域(EdgeWorker 5807 行起)、Slack 族、SharedWebhookServer、prompt-template.md(+package.json 指向不存在的 prompt-template-v2.md)、examples/electron-integration.ts、build/config.gypi、GlobalSessionRegistry(自称未完成重构 Phase 1)、ProcedureAnalyzer(AI 路由已废)。
- **一次性运维脚本已耗尽**:archive-roundtable-orphan-threads、decommission-legacy-companion-daemon、fly-513-repoint-global-codex、add-roundtable-allowfrom、apply-core-room-mention-gate。
- **v2 适配层已知瑕疵**(非残骸,记录在案):v2-discord-outbound 硬编码 founder Discord user id(应走 canonical 解析);`DISCORD_MESSENGER_AGENT_ID` 跨包手工同步。
