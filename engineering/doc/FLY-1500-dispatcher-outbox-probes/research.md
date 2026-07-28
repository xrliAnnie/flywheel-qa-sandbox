# FLY-1500 dispatcher + outbox + 探针 — 调研

Issue: FLY-1500 (https://linear.app/geoforge3d/issue/FLY-1500/v2批次2-dispatcher-outbox-探针-外发执行与应有实际状态对账)
日期: 2026-07-27
基于: exploration.md(设计权威 = `doc/engineer/plan/v2/design-FINAL-v2.md`,Codex R13 APPROVED)

---

## 1. 批次1 kernel 地基实测(代码级,main@6caa082d)

### 1.1 已有合同(本批直接消费,不改)

| 构件 | 事实(实测出处) | 对本批的意义 |
|---|---|---|
| `Kernel.write(label, fn)` | BEGIN IMMEDIATE 事务;回调必须同步(拒 async/thenable);tx 预算默认 1s 超时抛 `TxBudgetExceeded`;`kernel.ts:273-313` | dispatcher 的**每次库内状态翻转都是一个短写事务**;外发 HTTP 绝不能进事务(§0.5b 禁网络调用)——claim/accept/intent/settle 是四个独立事务(accepted 独立提交=可入库恢复态) |
| `WriteTx.cas(sql, params, expected=1)` | 行数≠期望抛 `CasViolation`;`kernel.ts:236-245` | 状态机全部翻转走 CAS,失败=整事务回滚 |
| `WriteTx.requireIdentity(key, expected)` | 读 meta registry 比对身份,不符抛 `FenceViolation`;`kernel.ts:247-253` | dispatcher 每个写事务首行调用 → 旧世代进程写被拒 |
| SQL 关键字守卫 | 读写两面都拒连接态 SQL(PRAGMA/BEGIN/COMMIT…),EXPLAIN 外壳剥离;`kernel.ts:71-160` | 本批新 SQL 都是普通 DML,无冲突 |
| `AgentIdentity` | **封闭枚举,仅 `lead`/`runner` 两类**;`parseIdentity` 对未知 kind 抛 `FenceViolation`;`fence.ts:3-16,68-112` | dispatcher 身份必须**新增第三类**(见 §7-D1),纯加法 |
| registry 键空间 | `lead_registry:<id>` / `consumer_registry:<agent>`(meta 表);`fence.ts:37-43` | 新增 `dispatcher_registry:<id>` 键空间,同构 |
| `FENCE` 常量 | 4 条 canonical CAS(mailbox applied/processing_attempts settle/activation terminal/attempt terminal);`fence.ts:183-194` | 本批新增 commands 生命周期 CAS 常量族,同一落点 |
| migrator | 有序 DDL 数组+checksum 台账+fail-loud;`migrator.ts` | 0005 迁移沿用同形态(id/ddl/checksum) |

### 1.2 commands / command_dependencies 现状(0001 已落库,逐列核对)

`commands`(`0001-base-schema.ts:72-92`):8 态 CHECK(pending/claimed/accepted/executing/succeeded/failed/rejected/canceled)、`result_code` 6 枚举 CHECK、`claim_owner`/`claim_generation`/`lease_expires_at`、`effect_key TEXT UNIQUE`、`payload`/`payload_digest`、`cutover_epoch NOT NULL`、`accepted_at`/`completed_at`/`result`。
`command_dependencies`(`0001:95-113`):`kind CHECK('notify_before')`、PK(command_id,depends_on_command_id)、禁自环 CHECK、**递归 CTE 禁环触发器**、行不可变触发器(改=删+重插)。

### 1.3 缺口清单(本批设计必须补的,全部只加不改)

1. commands **无 `retry_count`/`next_retry_at`**(mailbox 有)——retryable_failure 重试预算没有落库位。
2. commands **无探针簿记列**(`probe_unknown_streak`/`last_probe_at`);attempts 有 observed_* 三列但**同样无 streak 列**(v1 §2.3 "计数落库不落内存"无落点)。
3. **无 claim 候选索引**:dispatcher 按 kind 扫 pending 的查询在 0001-0004 中没有任何 commands 索引(mailbox 有七索引家族,commands 零索引)。
4. `AgentIdentity` 无 dispatcher 类;`FENCE` 无 commands CAS 常量。
5. 无 `admitCommand` 类型化 op:今天任何代码都能经 `Kernel.write` 裸 INSERT commands 而不带依赖(admission 规则无 choke point)。
6. events 的 `kind` 无 intent/receipt 约定值(events 表本身够用,append-only+task/attempt 外键+payload)。

## 2. v1 外发路径盘点(全仓审计,packages/**/src + scripts,排除测试/dist/休眠链)

> 目标:command.kind 枚举以 v1 **真实存在的效果种类**为准,不发明用不上的 kind。

### 2.1 三个结构性事实

1. **v1 已长出四个"半成品 outbox 器官"**(v2 把它们统一成一个机制,全部是可引用先例):
   - `land_operation`+`land_operation_step`(`StateStore.ts:14769-14805`):唯一做全"durable step receipt + lease + generation"的外发路径;`:cool:` 评论先查 `stepReceipt(opId,'cool_triggered')` 命中即复用旧 commentId(`land-executor.ts:561-579`)。**事实澄清(Codex R1 复核)**:触发评论 body 必须逐字为 `:cool:`(嵌任何 marker 都会让 workflow 不触发);`trigger_comment_id=` marker 长在**后续 workflow receipt 评论**上(`:598-620`),v1 用它反查 workflow run——"用外部系统反查自己的命令"这个思路 v2 github_comment 探针照抄,但 marker 载体是可自由写 body 的普通评论,**exact-body 的 :cool: 本身不进 v2 词表**(v2 ship=github_merge,批次3 整体替代 :cool: 工作流)。
   - `launch_claims` INSERT OR IGNORE + **commit 文件 gate**(`run-dispatcher.ts:653-666`+`TmuxAdapter.ts:565-570`):tmux 窗口先开、gated shell 等 token、DB commit 后才 exec claude——"外发预留但未激活,账落定才释放"的提交点设计;窗口选项 `@flywheel_exec_id`(`TmuxAdapter.ts:600-607`)已是现成 effect key 标签。
   - `runner-ready-to-close-notifier.ts:58-70`:`insertEvent(event_id=…)` 靠 UNIQUE 抢占,注释明写"UNIQUE constraint is the dedupe primitive"(不是 read-then-write)——effect-key 原子 claim 的最干净范式。
   - `LeadAlertNotifier` 四级去重+queue/dead-letter+**transient/permanent 失败分类**(5xx/429/网络→重排队;401/403/404/config→dead-letter+meta-alert 绝不盲重试);生产实证:缺上限保护曾积压 1669 个 `no-channel` 队列文件(`alert-queue-drain-permanent.mjs:3-9`)。
2. **绝大多数 Discord 外发=裸 fetch+失败吞掉**(`{ok:false}` 返回、从不抛;20+ 文件各自重复 API 常量);唯一公共封装 `bridge/discord-utils.ts`。`postDiscordMessageToChannel` 的**自动分块是已知坑**:第 3 块失败时前 2 块已落地,返回的 `remainingText` 无任何调用方消费=部分失败直接丢文本。
3. **Cyrus 休眠链不进 kind 枚举**:`EdgeWorker`/`ActivityPoster`/`GitHubCommentService`/`SlackNotifier`/`reactions/ApproveHandler`(唯一的 `gh pr merge` 代码!)——`new EdgeWorker(` 仅测试/示例引用,`createReactionsEngine` 零调用方,生产不可达。v1 真实 merge 路径=`:cool:`→GitHub Actions;Runner 被 Blueprint 明令禁自 merge。

### 2.2 活外发点分组(代表性 file:line;完整 35 行明细见审计原文,已并入 §3.5 总表)

- **GitHub**:`:cool:` PR 评论(land-executor,step receipt 幂等)/ `gh pr close`(canceled-pr-close,先查 state)/ PR 创建(GitPushRunner:543,422→re-read 认领;v2 收紧为 repo+open+head+base 精确谓词)/ 远程分支删除(branch-cleanup:239,`--force-with-lease=<sha>` CAS+先 ls-remote 校验)/ docs commit push(workflow-docs-git,已到位 no-op+stale base 拒)。**无任何 label 写操作**(全仓零命中)→ label 不进 kind。
- **Discord**(真正调 API 的永远是 Bridge 本体或 lead-alert.sh 旁路):建 thread+首帖(ChatThreadCreator,`chat_threads UNIQUE(issue_id,channel_id)` 先查后写,**两步 POST 非原子,崩溃=孤儿消息+孤儿 thread,v1 最典型 non-atomic 外发**)/ thread 发消息(三档幂等:原子 claim/ledger 去重/显式 at-least-once)/ 状态行 edit(内容级去重短路)/ thread 改名归档(目标态天然幂等)/ 告警(四级去重,§2.1-4)/ reaction(founder-ack,幂等)/ DM。
- **Linear**(懒加载 @linear/sdk):置 Done(linear-issue-finalizer:108,**双次 fresh read TOCTOU guard+canceled 永不覆盖**,全 catch 永不抛)/ 建 QA 子 issue(auto-qa-effects:304,**半幂等:Linear 建完→落库前崩=重复 issue,经典 outbox gap 实证**)/ runbook-gap issue(有 ledger 去重)/ createComment(actions.ts:1422,**catch{} 完全静默吞**)/ Lead proxy 三路(plugin.ts,无幂等)。
- **进程**:tmux session ensure(has-session 幂等+reachablePid 校验)/ new-window 起 Runner(launch_claims+commit gate,§2.1-2)/ kill window/session(幂等,cmux kill 失败→`dead_pin` 下轮重试)/ **send-keys(text+Enter 两段非原子,无幂等,capture-pane 反查极不可靠)**——这正是设计把注入做成垫片(hint 可丢)而非 outbox command 的实证依据。
- **四类之外**:`publish-report` 一次调用连锁 **Vercel 部署+Discord 消息两个外部系统副作用**,仅进程内 promise 互斥,跨重启零幂等(审计判"四类之外最危险")——批次3 切换时须分解为两条 command;本批把 `vercel_deploy` 列为已知扩展位,不实现(§8)。

### 2.3 审计三条落地结论(直接进 plan)

1. kind 天然两分:**可探测型**(重启后先探再决定)与**不可探测型**(effect key 前置 claim,intent 行=claim 的一般化)。
2. **discord_post 分块必须在 admission 消灭**:单条 command ≤ 单条 Discord 消息(≤2000 字符),长文=调用方经 splitter 拆成 N 条 command,chunk i+1 带 requires:[chunk i](**跨 retry 保序靠 requires 硬门,lane FIFO 只防并发不防 retry 越序**,Codex R2-7)——把 v1 "部分失败丢 remainingText"的状态机整个删掉。
3. **失败分类沿用 LeadAlertNotifier 语义并落到 result_code**:permanent(401/403/404/参数)→ **rejected**(result_code=policy_denied/noop/stale,denied 族)绝不盲重试、永不告警;429=请求被拒未执行→安全重试(即使 Discord);5xx/超时/连接断→unknown(可能已执行)。重试预算+退避上限=对 1669 积压事故的结构性答案(账在 commands 表,有界,不在无界文件队列)。

## 3. 外部系统事实表(幂等性 × 可探测性)

### 3.1 Linear(**已实证**;版本事实经 Codex R1 纠正后复核)

- 本仓 @linear/sdk **混 pin**(实测 package.json):teamlead/flywheel-cli/根 = `60.0.0`,claude-runner/core/edge-worker/linear-event-transport = `^64.0.0`,pnpm store 两版并存。**新 dispatcher 包必须自行 pin 并加类型锁测试**,不得继承"仓内某个版本"的模糊假设。
- `CommentCreateInput.id?: string` 与 `IssueCreateInput.id?: string` 在 **60.0.0 与 64.0.0 两版的 `_generated_documents.d.ts` 中均已实测存在**,文档原文:"The identifier in UUID v4 format. If none is provided, the backend will generate one."
- **结论**:Linear 创建类效果可把 effect_key 派生的 UUID 直接作为实体 id → **真幂等**(重放=同 id 冲突失败,可判 noop)且**按 id 精确探测**(`issue(id)`/`comment(id)` 查询,查到=present)。
- 更新类(`issueUpdate` 等):天然幂等(字段 setter,last-write-wins);探测=读回字段比对。

### 3.2 GitHub(gh CLI;事实为 GitHub REST/CLI 公开语义,实施时以真机验收复证)

| 效果 | 幂等机制 | 探测 |
|---|---|---|
| PR 创建 | 自然键幂等,但 **422 只是 validation/spam 通用码,不是"已存在"的证明**(Codex R1 对照 GitHub 官方文档):422 后必须按 head+base 精确 re-read,查到 open PR 才认领,查不到=确定失败 | repo+state=open+**head+base** 唯一精确匹配(同 head 异 base 不认领);`gh pr list --head <b> --base <base> --json number,url` |
| PR 评论 | **非幂等**(每次调用都新增评论)→ 靠 body 嵌 marker `<!-- fw:ek:<effect_key> -->` | 拉该 PR 评论列表按 marker 扫 = present/absent 可判(评论量有界) |
| merge | 已 merge 再 merge → API 报错(405 类)→ 判 noop | `gh pr view --json state,mergedAt,mergeCommit`,MERGED=present |
| label/close 等 setter | 天然幂等 | 读回状态比对 |
| 错误分类 | 429/限流=**retryable_failure**(请求被拒收未执行,安全重试);超时/请求已出连接断/5xx=unknown;其余 4xx 业务错=denied→rejected(plan §6.2 四出口为唯一权威) | — |

GitHub REST 无通用 Idempotency-Key 头;上表全部依赖自然键或 marker 约定。

### 3.3 Discord(设计终版已裁决,不重开)

- 消息发送 `POST /channels/:id/messages`:**API 无幂等键机制**。崩溃窗口(POST 已发出、receipt 未落库)= unknown 且**结构上不可靠探测**(翻历史受权限/分页/thread 归档噪声影响)。
- **设计裁决**(FINAL §1.2e):接受罕见重复 + 幂等键诚实入基线;补偿=追加更正帖(saga 表 discord_post→compensate)。本批**不**为 Discord 造历史扫描探针(over-reaction:为毫秒级崩溃窗造一个自身不可靠的机制)。
- 例外:**message 上开 thread** 天然唯一(一条消息至多一个 thread)→ 自然键幂等,可按源消息探测;**频道内独立 thread 创建**非幂等——kind 定义时区分。

### 3.4 进程(tmux,单机)

- 枚举:`tmux has-session -t <name>` / `list-sessions`;session 名编码 execution id(v1 已有此约定,FLY-269)→ **spawn 幂等=同名 session 已在则 adopt 不重 spawn**(v2 §2.2 "generation-bound process marker 判 adopt-or-terminate,绝不盲目重 spawn"逐字落地)。
- host_epoch:区分"同机重启前后"的枚举证据代际;跨 epoch 的 absent 不可信(设计 v1 §2.3:枚举成功+同 host_epoch+明确 absent 才判 dead)。
- terminate 幂等:目标 absent 即成功(noop)。
- unknown 来源:tmux server 无响应/命令超时(本机实证先例:FLY-1234 watchdog 误报家族=把"探不到"当"死了",v2 三态就是为此)。

### 3.5 汇总:v2 kind 词表定稿(设计终版给定集 + 审计校准的活效果扩展)

词表纪律:设计终版 §2.5/§2.9 点名的 kind 全保留;扩展 kind 每个都有 §2 审计的活代码出处;审计见到但**不进**词表的效果在 §8 列明理由。

| kind | 出处 | 幂等机制 | 可探测性 |
|---|---|---|---|
| spawn / terminate | 设计 §2.5;audit #26-27 | session 名=execId+adopt;absent=noop | **A**(has-session+`@flywheel_exec_id` 窗口选项) |
| discord_post | 设计 §2.5;audit #9 | 无(admission 限单条≤2000,分块=多命令) | **C** 非探测 |
| discord_thread_create | 设计 §2.5;audit #13 | **v2 强制锚定消息**:thread id==源消息 id,天然键(v1 两步孤儿 gap 由 payload 引用依赖 receipt 的 message_id 关闭) | **A**(GET channel by id) |
| discord_thread_rename / discord_thread_archive | audit #14/#15(活:stage emoji/归档) | 目标态天然幂等 | **A** |
| notify / founder_page | 设计 §2.9(prerequisite_notification 基例);audit #20 | 无(同 discord_post) | **C** |
| linear_update | 设计 §2.5;audit #24 | setter 天然幂等(TOCTOU guard 先例) | **A**(读回) |
| linear_issue_create | audit #23(活:auto-QA 子单,**落库前崩=重复的实证 gap**) | **客户端 UUID=effect_key 派生**(§3.1 实证)→ 根治该 gap | **A**(按 id 查) |
| linear_comment_create | audit #25(活:retry 派发说明,现状静默吞) | 客户端 UUID 同上 | **A** |
| github_pr_open | 设计 §2.5;audit #1 | 自然键(head branch;422→认领先例) | **A** |
| github_pr_close | audit #5(活:取消 issue 清 PR) | 已关=noop | **A** |
| github_comment | 设计 §2.5;audit #4/#7 | body 嵌 `<!-- fw:ek:<effect_key> -->`(marker 反查思路来自 land-executor 的 workflow receipt;exact-body :cool: **不进词表**,v2 ship=github_merge) | **A-marker**(评论列表有界扫描) |
| discord_correction_post / github_correction_comment / linear_correction_comment | saga 表静态自洽(Codex R1-6) | 同基 kind;saga disposition=none(补偿不再生补偿) | 同基 kind |
| github_branch_delete | audit #3(活:merge 后清分支) | `--force-with-lease=<sha>` CAS;**不入 manual_gate 的完整前提=plan §5 两互斥模式**(merged-cleanup:fresh binding+merge proof / recovery-delete:fresh binding+bundle verify 含 expected_sha)——**单靠 sha 入 payload 不足够**(Codex R4-4 纠正) | **A**(ls-remote) |
| github_merge | 设计 §2.5(**manual_gate,不入自动 saga**);audit #6(v1 生产不可达,真路径=:cool:→Actions) | 已 merge=API 拒可判 noop | **A** |
| destructive_delete | 设计 §2.5(**manual_gate**) | — | 按目标 |
| mute_reminder/extend_timeout/route_override/emergency_transition | 设计 §5-P12 bypass 矩阵(库内,无外发) | effect_key | 库内事务,无崩溃窗 |
| status_read/probe_query/mailbox_read/events_read | 设计 §2.9 readonly 豁免 | — | — |

unknown 处置两族:probeable → 探针(present 补 receipt/absent 按 kind 处置/unknown 有界升级);non-probeable → executing 崩溃窗**重发一次**(预算内,罕见重复诚实入基线,更正帖补偿在),预算耗尽才 obligation(§7-D6)。

## 4. 参数族(对齐设计 §1.2c T_* 风格;全部集中配置,禁散落魔法数)

| 参数 | 拟值 | 依据 |
|---|---|---|
| T_dispatch_tick | ≤60s | 门铃(可丢)为快路,tick 只兜活性——与 mailbox 唤醒三路同构;门铃丢失最坏延迟=一个 tick |
| T_lease(commands 执行 claim) | 2min | **唯一用途=僵尸副作用静默窗**:fence 挡得住旧世代 DB 写,挡不住已在途的外部 HTTP;新世代 reconcile 必须等旧 claim 的 lease 过期才动手,把双发窗口约束到"旧进程一次外发调用的存活上限"。取 2min > 最慢外发(spawn ~60s)+超时余量 |
| 外发单次超时 T_effect | 60s(spawn)/ 30s(其余) | gh/Linear/Discord 单调用秒级;超时=unknown 或 retryable(按错误形态,§7-D5) |
| 重试退避 | 30s×2^n,cap 15min | 逐字镜像 mailbox 家族(FINAL §0.5),同一套心智 |
| 重试预算 | retry_count≥5 → failed(terminal)+ obligation(通知 owning Lead) | 镜像 mailbox ≥5→dead;C7 场景"重试 N 次→仍失败升级给人" |
| T_attempt_probe_tick(进程探针) | 20s | P2 验收硬约束:"spawn 后立杀,60s 内 observed=absent 且重派或 obligation"——20s 保证 60s 窗内 ≥2 拍,首拍失败仍达标 |
| T_probe(单次探针超时) | 10s | tmux/gh 只读查询秒级;超时即记 unknown 一次 |
| unknown 有界升级 | 连续 N=3 **且** 跨度≥5min → result_code='effect_unknown' 冻结 + obligation | 双条件防两个反向误报:只计次→毫秒级风暴误升级;只计时→单次瞬断挂满 5min 才动。计数落库(0005 列) |

## 5. 模式先例(设计已裁决,只引用不重开)

- transactional outbox:FINAL §1.2e + §7(DR 对标"模式狠抄"清单第 3 项)。
- K8s reconcile(desired vs observed):§7 清单第 1 项;attempts 表 desired_state/observed_state 双列即其机器形态。
- saga 选择性补偿:§7 清单第 4 项;Alertmanager 分组+抑制(claim predicate 接缝归 FLY-1501)。

## 6. 姊妹批次接缝合同(草案,plan 定稿)

| 对手 | 接缝面 | 草案 |
|---|---|---|
| FLY-1499(生产侧) | `admitCommand(tx, spec)` 类型化 op:一次调用插 command+全部 notify_before 依赖+分类校验;转化事务内调用;**必须消费返回的 canonical commandId** | 签名与校验规则见 plan §admission;1499 的"处理完成=回复 command 已入 outbox"引用此 op 的提交语义 |
| FLY-1501/1498(kernel-action delegates) | bypass 四 kind 的业务 CAS 注册面(plan §6.7):mute_reminder/extend_timeout→1501,route_override/emergency_transition→1498;未注册=fail-closed rejected | delegate=纯函数 `buildBusinessCas(cmd)→BusinessCasSpec{specKey,params}`,**不持 WriteTx、不返回 SQL**;canonical UPDATE 常量+kind→specKey allowlist 住 v2-kernel,changes 1/0=granted/denied |
| FLY-1498(binding) | 只读 `resolveBranchBinding(repo,branch)` 接缝(plan §6.6-④):branch-delete executor 外发前 fresh resolve;批次3 切换期 v1 StateStore 只读 transitional adapter 供数,退役条件=v2 backfill 双向核对后、原路径 fence 前删除 | — |
| FLY-1501(抑制) | notify 类 kind 的 claim SQL 谓词插槽:`AND NOT EXISTS(<suppression_predicate>)` | 本批交付插槽位置+默认恒真;谓词内容/抑制规则表由 1501 填 |
| FLY-1498(门) | `github_merge`/`destructive_delete`:disposition=manual_gate,claim 谓词要求有效 capability 引用(gate 绑定 exact head 的语义归 1498) | 本批只验证"capability 行存在且未消费未撤销";head 绑定校验归 gate 侧 |

## 7. 结论 → plan 决策清单

| # | 决策 | 依据 | 被拒替代 |
|---|---|---|---|
| D1 | dispatcher 身份=AgentIdentity 新增第三类 `{kind:'dispatcher', dispatcherId, instanceId, generation}`,registry 键 `dispatcher_registry:<id>` | §1.1:parseIdentity 封闭枚举,加法安全;与 lead/runner fence 对称 | 复用 consumer_registry(语义混淆,见 exploration Q1-B) |
| D2 | intent/receipt 载体=events 行(`effect_intent`/`effect_receipt`)+ commands.state CAS **同事务** | append-only 审计天然;重试多轮痕迹全保留;commands 不加证据列 | commands 加列(可变状态与不可变证据混行,历史只剩最后一次) |
| D3 | 0005 迁移(只加不改):commands +5 列(retry_count/next_retry_at/probe_unknown_streak/first_unknown_at/last_probe_at)、attempts +3 列(probe_unknown_streak/first_unknown_at/last_probe_at)、commands 索引家族(pending-immediate/pending-scheduled 尾列含 id 承载稳定 tiebreaker、in-flight,三条 partial) | §1.3 缺口 1-3;Lead 强化③ | 独立 probes 表(高频低值行膨胀);数 events(COUNT 扫描+还是要写行) |
| D4 | admission=`admitCommand` 类型化 op 单点 + claim SQL 硬门双保险 | SQLite 无 deferred trigger,INSERT 时无法校验"稍后同事务才插的依赖行"→触发器方案物理不可行;claim 谓词是唯一能在 SQL 层强制的位置 | 纯触发器(不可行);纯 op 层(裸写绕过则零防护) |
| D5 | 错误三分类判据(可执行):**确定失败**=外部系统明确业务拒绝(4xx 类/CLI 明确错误输出)→ retryable 或 rejected 按 kind;**unknown**=请求可能已到达但结果未知(超时/请求已出连接中断/5xx;**限流 429 不算**——被拒收未执行,归 retryable)且该 kind probeable → 走探针;**non-probeable 的 unknown**=按 §3.5 重发一次策略 | Lead 强化②"可执行判据";HTTP 语义:4xx=服务器收到并拒绝(没做),超时/5xx=可能做了 | 把一切失败都当 unknown(过度冻结,吞吐死);都当确定失败(重发风暴,P2 复发) |
| D6 | non-probeable(Discord 族)executing 崩溃窗恢复=直接重发(至多重试预算次),接受罕见重复 | 设计裁决"罕见重复+幂等键诚实入基线";崩溃窗毫秒级,重复概率极低;更正帖补偿存在 | 冻结等人工(把毫秒级窗口变成必然人工介入,over-reaction) |
| D7 | 探针=dispatcher 内部只读动作,**不走 commands 表**;`probe_query` kind 保留给外部调用方 | 为对账动作再造对账=递归 over-reaction;探针无副作用,无需 outbox 保证 | 探针也入 outbox(行数×每 tick,账本被噪声淹没) |
| D8 | 补偿 command 静态防递归:disposition 表内 compensate 目标 kind 的 disposition 必须 ∈ {none, forward_repair} | 编译期可查,零运行时成本 | 运行时 depth 计数(把结构问题变成运行时状态) |
| D9 | Linear 创建类 effect_key 直接派生实体 UUID(uuidv5(effect_key)) | §3.1 实证:SDK 接受客户端 id | 靠查询去重(多一跳,弱于原生冲突拒绝) |
| D10 | dispatcher 驱动=门铃(可丢)+T_dispatch_tick 兜底扫描,单进程内 per-kind 串行、kind 间并行 | 唤醒三路同构(§1.2a);同 kind 串行天然保序(如同一 PR 的两条评论);kind 间无序依赖(有依赖走 command_dependencies) | 全局串行(一个慢 spawn 堵死全部外发);per-command 并发(同 kind 保序丢失) |

## 8. 审计见到但不进本批词表的效果(诚实边界,防"v2 会误以为没这些")

| 效果 | 为什么不进 |
|---|---|
| tmux send_keys(注入指令) | 设计已裁决:注入=垫片(hint 可丢,1501),非 outbox command;审计实证其 C/D 级不可探测+两段非原子,正是不该给它对账语义的原因 |
| vercel_deploy(publish-report 链) | 审计判"四类之外最危险"(跨两外部系统零幂等);批次3 切换时分解为两条 command;本批词表留位不实现 |
| discord message edit/delete/pin/typing/bot 改名 | 表现层/瞬态效果,丢失=外观损失可重投影修复;进 outbox=账本被高频低值行淹没(over-reaction)。edit 的内容级去重短路(auto-qa-effects)在投影层保留 |
| ~~discord DM~~(Codex R1 纠正:**不排除**) | severe alert 的 DM 是活业务通知路径(LeadAlertNotifier.ts:903-909,1509-1536)——**由 notify/founder_page 的 payload `target: channel\|dm` 覆盖**,进词表不另立 kind |
| discord reaction(founder-ack 章) | 审批回路构件,归 FLY-1498 的 gate 侧;kind 空间开放+未知 fail-closed,后续加=一行处置表 |
| launchd kickstart/bootstrap、Lead 进程 spawn、fleet apply | 基础设施自愈/舰队管理,不是 kernel 编排的业务效果;监督权在 supervisor/AutoRepairBot,v2 kernel 不收编 |
| GitHub label、Slack 全家 | 全仓零活调用(label)/休眠(Slack),不发明 |
| git push(runner 干活产物) | attempt 内工作,不是 orchestrator command;GitPushRunner(Codex Lead gateway)属 lead backend 域,批次3 再议 |

## 9. 开放问题(带进 plan 落定)

1. 【已定】kind 词表见 §3.5;排除清单见 §8。
2. saga 补偿 command 的 notify_before:补偿是 action 类,若强制通知前置,saga 因等通知而慢;拟:saga planner 产出的补偿 spec **自动附带同事务的 notify command 作为依赖**(不豁免、不特权,通知与补偿一起入账)——plan §5 定稿并过反 over-reaction 检查。
3. github_branch_delete 不入 manual_gate 的裁决(§3.5 行内理由)交 Codex design review 复核。
