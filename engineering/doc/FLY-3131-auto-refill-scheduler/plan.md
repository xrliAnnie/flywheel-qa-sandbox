# FLY-3131 在飞空位自动补单 — 实施计划(第二版设计)
Issue: FLY-3131 (https://linear.app/geoforge3d/issue/FLY-3131/epic在飞空位自动补单-按-fly-3103-prd-做开工前先和-annie-过设计)
日期: 2026-10-01
基于: research.md

> 状态:设计节点产出,**还没有和 Annie 过完**(PRD §6.0:开工前先和她过一遍设计)。本文是第二版设计页(founder-design.html)的工程底稿;
> 标「待 Annie 定」的地方以她在页面上的选择为准。不写产品代码、不动 Bridge。
> 已定:1A(共用 FLY-3147 后台线程)、2B(接 Linear webhook,可用 Cloudflare)、4A(走 Lead 收件箱)、5A(不依赖 Epic 页,从 Linear 增量算)。第 3 题待定。
> 修订记录:R1(Codex 14 条)→ 本版:占位按「单」计、释放写持久评估意图、提醒状态机、跨库投递键、依赖 SQL 未知即挡、拷贝完整快照、
> 新鲜度闸门 + 发送前复核、C 改为「申请修改 PRD §3.2」、「主线程过渡」改为需另批的 PRD §3.1 临时变更、webhook 入队后才回 200、token 权限按账号级写。
> R2(Codex 6 条)→ 本版:释放按「本次交付全部 PR 合入」且核对派单身份(§2.2)、复核结果写回拷贝并有界暂缓(§2.4)、
> 拷贝 mutation revision + 发布 CAS(§4.4)、事实与范围成员分表(§5.2)、可投递凭据 + 投递时再检查(§6)、thread 留痕独立条件与回执(§6)。
> R3(Codex 2 条)→ 本版:unknown 只认 comm.db 正面入队证据(不认 lead_events 日志)、主线程投递前核对凭据里的范围版本与新鲜度(§6)。

## 1. 一句话

**Linear 的变化只增量更新一份本地拷贝(不挑单);空出位子(持久记录)、或「有空位时拷贝变了」,才在拷贝上挑出下一张,发送前再向 Linear 核一次,
投进 Lead 收件箱;定时对账兜住漏掉的变化;拷贝不新鲜时宁可不发也不发过时的建议。**

## 2. 触发时机(回答 founder「每 5 分钟都要算吗」)

### 2.1 信号与职责

| 信号 | 来源 | 做什么 | 会不会挑单 |
|---|---|---|---|
| S1 位子释放 | 见 §2.2 入口矩阵;释放提交时**同一事务**写一条持久「评估意图」 | 评估器消费意图 | **会** |
| S2 Linear 有变化 | Cloudflare 取来的 webhook + 本地事件(`/api/dependency`、收尾标 Done) | 只更新拷贝里受影响的部分 | 只在该 Lead **有空位**时写评估意图 |
| S3 对账 | 定时:10 分钟增量 + 每天全量(§4.4) | 把拷贝和 Linear 对齐 | 同 S2 |
| S4 提醒到期 | 定时检查提醒状态机(§3) | 30 分钟再提醒 / 60 分钟到期 | 到期、过时都写评估意图 |
| S5 兜底巡查 | 每 5 分钟,读本地库,不读 Linear | 发现「有空位、拷贝新鲜、最近一次释放之后没有评估结论」→ 写评估意图;Worker 启动 / 重启 / 开关打开 / 配置变更时也跑一次 | 会 |

- **位子满(最常见)时,S2 / S3 只写拷贝,不挑单**。这就是 founder 的 ①「有 capacity 时再算」。
- founder 的 ②「每次 Linear 变化重算 DAG」被拆成两半:变化时只增量更新拷贝;有空位时才挑。
- S5 解决 R1#3:即使释放后进程崩溃、Linear 又没变化,空位也不会一直闲着。
- 和成熟系统对齐:Kubernetes(事件放回队列 + 每 30 秒兜底)、Buildkite / Temporal(有空位才放行)、Airflow(排队多于空位时排序才有意义)(research.md §1)。

### 2.2 S1 入口矩阵(R1#3:现有代码并没有统一的「位子释放」事件)

| 现有路径(主仓 main `9fcbdebb1`) | 今天表示什么 | 在新设计里 |
|---|---|---|
| `event-route.ts:3982`、`DirectEventSink.ts:1472` 的 `notifyEpicChanged(…,"session_completed")` | 一次 session 状态变化,**早于**收尾,不代表合入 | **不算释放**(阶段之间、重试都会触发) |
| land 收尾 `plugin.ts:9198`(可恢复 finalizer)、`DirectEventSink.ts:1655`、`event-route.ts:4128` 进入 `runPostShipFinalization`,**且本次交付的全部必需 PR 都已合入**(单 PR = 已验证的合入回执;多 PR = 当前 run 的 PR manifest 全部合入,`post-ship-finalization.ts:1200-1245` 返回 `workflow_pr_manifest_partial` 时**不释放**) | 本次交付完成 | **释放**,来源 id = project + 仓库 + issue + dispatch/run id + manifest revision |
| 只有部分 PR 合入(manifest partial / held) | 同一张单还在做 | **不释放** |
| `merge-ship-gate.ts:579-582`、`external-merge-reconcile.ts:503-506` 的 `linear_done` 回调 | 补救路径确认合入 | 同上条件与来源 id(幂等:同一交付只释放一次) |
| Linear 上被占位的单变成 canceled / duplicate(拷贝或对账看到) | 不做了 | **释放**,来源 = Linear 状态变化 |
| Lead 明确放弃(新增:`/api/refill/release`) | 不做了 | **释放**,来源 = Lead 操作 id |
| 无 PR 的工作流(如只出文档)以工作流终态 completed 结束 | 做完了 | **释放**,来源 = workflow 终态 id(实现第一步列全现有无 PR 路由) |
| runner 失败 / 被停 / 重试 / 换 runner / 等批准 / park | 同一张单还在做 | **不释放** |

- 释放 = 在占位表把这张单标 released(带来源 id,唯一约束防重复)+ 同一事务插一条 `refill_eval_intent`。
  **释放前核对派单身份**:来源里的 dispatch/run id 必须等于占位行的 `dispatch_id`;不等(例如同一张单已重新派出,旧回执迟到)→ 不释放,只记日志。线程无关:3147 把 land / external merge 巡检搬进 worker 后,
  释放仍然写同一个库,评估器只看库,不依赖跨线程消息。
- 每条评估意图必须落一条 `refill_decision`:选中了哪几张,或「为什么没补」(位子满 / 没有能开始的单 / 读数不新鲜 / 开关关着)——一周验收「每次合入都有下文」从这里出。

### 2.3 占位(R1#2:按「单」计,不按 runner 计)

- 占位表 `refill_slot` 以 `(project, issue_id)` 为键:**第一次被 `/api/runs/start` 接纳派出**时写入(和派单同一事务;主线程,很小的一次写),
  记录派出时的 owner Lead;阶段交接、等待批准、park、重试、换 runner 都保持占位。
- 释放只按 §2.2 的证据;**拿不准(unknown)一律算占着**,宁可少补不误补。
- 转交:Lead 改派时在同一事务里改占位行的 owner,不新增行(防双计 / 漏计)。
- 上线时一次性回填:按现有活跃 workflow / session 把在飞的单写进占位表(只读推导,结果给 Lead 看一眼)。
- 在飞数 = 该 Lead 名下未释放的占位行数。上限 `cap`(项目配置,默认 12);13–14 不自动提醒(PRD 2.7)。

### 2.4 评估器(每个 Lead 一个,single-flight)

```
消费一条或多条评估意图(同一 Lead 合并):
BEGIN IMMEDIATE                                       -- SQLite 写锁,等同 Airflow 关键区
  1. 收敛提醒:过时的标 stale、到 60 分钟的标 expired(§3)
  2. 新鲜度闸门:该项目拷贝不新鲜 / 不完整 → 写 decision(read_unavailable),发告警,结束
  3. free = cap − 未释放占位 − 有效提醒(pending/reminded)
  4. free ≤ 0 → 写 decision(full),结束
  5. 候选 = readyQuery(lead, limit = free)                 -- §5.3
  6. 为每个候选插 suggestion(pending)+ outbox(key = refill:<sid>:initial)
  7. 写 decision(picked: [...]),标意图 consumed
COMMIT
发送前复核(事务外,worker 做):按单号向 Linear 现拿这张单(含完整 relations / inverseRelations)+ 它的 blockers + 所属 Epic。
  · 取全了:按 §4.4 的单张刷新协议(revision CAS)把结果**写回拷贝**;同一短事务里,仍满足 → outbox 置 deliverable(§6);
    不满足 → suggestion 标 stale、outbox 撤销、写评估意图。因为拷贝已更新,重挑不会再选中它,而是继续挑下一张(Y)。
  · 没取全(网络 / 限流 / 无权限):**不算 stale**;suggestion 标 recheck_failed、该候选写 `hold_until`(有界退避 2→4→8 分钟,上限 30 分钟)、
    释放名额并写评估意图;就绪查询排除 `hold_until > now` 的候选,下一轮挑 Y,不会反复复核 X。
```

- 评估过程中到达的新意图留在表里,下一圈处理(对应 K8s 对「正在调度」期间事件的处理)。
- 手动派单(急活或 Lead 自选)与评估器的竞争:`/api/runs/start` 写占位时,若该单有有效提醒,在同一事务里把提醒转成 dispatched(释放提醒占的名额、换成真占位);
  派的是别的单则只加占位。两者都在 SQLite 写锁里,不会超卖;最坏结果是在飞到 13(落在 PRD 允许的 13–14 区间)。

## 3. 提醒状态机(R1#4)

| 状态 | 进入条件 | 占不占名额 | 离开 |
|---|---|---|---|
| pending | 评估器选中 | 占 | 投递成功后 30 分钟 → reminded;派出 → dispatched;过时 → stale |
| reminded | 30 分钟内没派(只再提醒**一次**,key = `refill:<sid>:reminder:1`) | 占 | 再 30 分钟 → expired;派出 → dispatched;过时 → stale |
| dispatched | `/api/runs/start` 接纳这张单(同事务转成占位) | 不再单独占(由占位表占) | 终态 |
| stale | 拷贝或发送前复核发现它已不能开始(Epic 放回 Todo、单子被改、依赖新增等;复核结果已写回拷贝) | 不占 | 终态;写评估意图重挑 |
| recheck_failed | 发送前复核没能从 Linear 取全 | 不占 | 终态;候选进有界暂缓(`hold_until`),写评估意图 |
| expired | 提醒后 60 分钟没动 | 不占 | 终态;记进验收数据;写评估意图 |

- 约束:同一张单同一时刻最多一条 pending / reminded 提醒(SQLite 部分唯一索引)。
- expired 的单**冷却**:拷贝里这张单的版本变化前、或 24 小时内,不再重复提醒(防「换个 epoch 无限重发」),下一个空位会给下一张。
- 「投递成功」= 主线程拿到 comm.db 持久入队回执(§6),不是 Lead 已读。

## 4. 第 2 题:怎么拿到 Linear 的变化(已选 B:webhook;推荐 Cloudflare Worker + Queues)

### 4.1 链路

```
Linear ──webhook──▶ Cloudflare Worker(*.workers.dev)
   · 限 body 大小;校验 organizationId / type / 字段合法
   · 验 Linear-Signature(原始 body,HMAC-SHA256,Worker secret)
   · 用 body 里**被签名覆盖的** webhookTimestamp 判 ±60 秒(只在入口判,不在消费时重判)
   · await QUEUE.send({deliveryId, type, action, issueId, 改动字段名}) 成功 → 回 200;入队失败 → 回 5xx(让 Linear 重试)
Bridge refill.pull(每 30 s)── HTTP 拉取(batch ≤ 100,可见超时 5 min)
   · 每条先写本地 refill_inbound(delivery_id 主键,状态 received)→ 本地提交成功后才 ack Cloudflare
   · 按 issueId 合并(10 秒内同单只重拿一次)→ 回 Linear 重拿 → 写拷贝 + 必要时写评估意图 + inbound 标 applied,同一本地事务
本地事件(/api/dependency、收尾)──▶ 直接写拷贝(同事务写评估意图)
```

- 去重与「已处理」分离(R1#10):`received` 只表示收下;只有和拷贝改动同一事务提交才 `applied`。崩溃后 received 未 applied 的会被重做。
- 重拿失败:按 §4.5 退避;同一条连续失败 N 次(默认 5)→ 标 dead,发告警,等对账覆盖。
- 为什么不信 payload:Linear 不保证顺序、重试可晚到 6 小时;重拿最新状态让乱序和迟到无害。

### 4.2 为什么 Worker + Queues

不要域名(FLY-3102 的 F2「隧道 / Tailscale」还没定,不被它卡住)、本机不开任何入口、本机关机时消息在队列里存 24 小时(免费)/ 最多 14 天(付费 5 美元 / 月)。
诚实说明:Cloudflare 自身入队失败时会回非 200,仍要靠 Linear 的重试;Linear 长时间收不到 200 仍可能停用 webhook——由 §4.6 的健康检查发现。

### 4.3 密钥与权限(R1#11)

- Linear 签名密钥:只在 Worker secret。
- 本机的 Cloudflare token:按官方拉取文档,权限是**选定 Cloudflare 账号的 Queues 读写**,不是「只能动这一个队列」。所以推荐给 Flywheel 用一个
  **只放这条队列的 Cloudflare 账号**(或接受账号级权限);存 `~/.flywheel/.env`,不进仓库、不进命令行参数。落地前实测 token 实际范围,文档只承诺实测过的。

### 4.4 拷贝协议(R1#7)

- **范围(scope)**:每个项目「进行中的 Epic」;每个 Epic 一个范围,含它的全部子单和这些子单的全部 `blocks` 关系;范围外的 blocker 只作为「依赖证据」被引用。
- **事实与成员分开**(§5.2):单子的事实(状态、优先级、父单…)每张一行,和范围无关;「谁属于哪个范围、以什么身份」另存成员表。
  同一张 X 可以同时是 Epic A 的子单(可派)和 Epic B 的依赖证据,两者互不覆盖。边按「被挡的那张单」整体替换,和范围无关。
- **完整快照 + 代号(generation)**:对一个范围,按稳定分页游标取全子单和全依赖;**全部页成功且 CAS 通过**才把新代号发布为当前快照(mark-and-sweep 只清**本范围**的成员行;
  事实行只在没有任何范围的成员引用时才回收;边按被挡单替换);
  任何一页失败 → 保留上一份完整快照,范围标 stale。依赖对账**不以 updatedAt 没变为跳过条件**(改依赖不一定刷新 updatedAt)。
- **单张单的增量更新**(webhook / 本地事件 / 发送前复核):单张单的**字段**按 `updatedAt` 比较,旧的丢弃;删除 / 404 / 无权限 → 标 tombstone 或 unknown,**不可派**。
  单张单的依赖变化以「重拿这张单的 relations + inverseRelations 全集」替换它的边(全集取全才替换)。**依赖不按 updatedAt 判新旧**(改依赖不一定刷新它)。
- **冲突协议(mutation revision + 发布 CAS)**:每个范围有一个本地计数 `mutation_rev`;任何写入这个范围内单子或边的操作(单张刷新、`/api/dependency`、
  webhook 应用、快照发布)都在同一事务里把它加一。
  · 范围快照开始时记下 `start_rev`;所有页取完后,在一个短事务里检查 `mutation_rev == start_rev`,相等才发布;不等说明期间有更新的增量,
    **丢弃这次扫描重来**(最多 3 次;仍冲突则范围标 stale 并告警,下一轮再试)。
  · 单张刷新同理:取前记下涉及范围的 `mutation_rev`,写回时 CAS;冲突则重拿这一张。
  · 网络请求期间**不持有** SQLite 写事务;只在最后的短事务里检查和发布。
  · 这样「旧的全量扫描晚到、覆盖了新加 / 新删的依赖」不会发生。
- **Epic 进出 In Progress / 移父单**:增量对账发现后,对受影响范围做一次完整快照。
- **水位线**:每次增量对账固定扫描上界,全部所需页提交后才前移;重叠 5 分钟。
- **每天全量**:全部范围重建快照,顺带清掉不再在范围内的行。
- 需在真 Linear 上实测:改父单是否带 `updatedFrom.parentId`、改依赖是否刷新 `updatedAt`、删掉的依赖用 `includeArchived` 能否查到(子单 1 第一步)。

### 4.5 用量与限流(R1#12)

- 估算(待实测校准):11 个进行中 Epic、约 200 张子单;每轮增量对账 ≈ 1 次「改过的单」+ 受影响范围的快照(每个范围 1–3 页)≈ 5–30 次请求;
  每天全量 ≈ 30–60 次;webhook 重拿按单合并,估计每小时 ≤ 100 次。合计每小时约 300 次以内,个人 key 上限 2,500 次 / 小时(和同一用户其他 key 共享)。
- 共享一个有上限的并发 / 预算;HTTP 429 和 **HTTP 400 + `errors[].extensions.code = RATELIMITED`** 都按限流处理,按返回的重置信息退避,未提交的页保留重试。

### 4.6 健康(区分三种情况,不把「安静」当故障)

| 情况 | 怎么判断 | 怎么办 |
|---|---|---|
| 最近没人改 Linear | 对账也没发现变化 | 正常,不告警 |
| 推送链坏了 | 对账发现了变化,但同一单在 webhook 里没出现(连续 N 次);或拉取 Cloudflare 连续失败;或每日查 Linear webhook 配置显示已停用(待验证 API 字段) | 告警 Lead「推送断了」;**仅在 Linear 预算健康时**把增量对账临时缩到 3 分钟 |
| 读 Linear 失败 / 被限流 | 对账或重拿失败 | 退避;超过新鲜度预算 → 闸门关闭、告警「补单读数坏了」;恢复后发恢复通知 |

## 5. 第 3 题:待派的单存在哪(待定)

### 5.1 先说清:A 和 C 都需要同一份 Linear 拷贝

要「随变化增量更新」就得先有 Linear 事实的本地拷贝(§4.4),否则不知道哪些单受影响。第一版的 A 隐含了这一层。所以 A 和 C 共用:拷贝、对账、新鲜度闸门、提醒状态机。
**区别只在:要不要再多维护一份「排好序的就绪队列」。**

| | 做法 | 好处 | 代价 |
|---|---|---|---|
| A(PRD §3.2 字面) | 拷贝之外,再维护一份排好序的就绪队列(持久表或可重建的内存优先队列);拷贝一变,算出受影响的单进出队列;有空位取队头 | 和 PRD 字面一致;单子极多时挑单最省 | 多一层要和拷贝保持一致的派生数据:每种变化(依赖、Epic 进出、优先级、Lead 归属、配置)都要写「影响哪些单」的规则,写漏一个就出错;需要对账把队列也重建一遍来兜底 |
| B(第一版) | 不存,每次去 Linear 现拉现算 | 最少代码 | 就是今天 ready.v1 的读法:20 秒截止、43/200 超时、1.5 MB 超限 |
| **C(建议,需改 PRD §3.2)** | 只维护拷贝;有空位时在拷贝上跑一次就绪查询挑前 N 张 | 少一层派生数据,不存在「队列和拷贝对不上」;拷贝坏了删掉重建即可 | 每次挑单要在本地扫一遍候选并排序(几百行,预计毫秒级,**待实测**);字面不符合 PRD §3.2「维护一条队列」 |

- C 和 PRD §3.2 的关系(R1#1):PRD 要的是「增量维护队列、有空位取队头、不全量重排」。C 做到「增量维护事实、不去 Linear 全量拉、位子满时不挑」,
  但**有空位时会在本地重新筛选和排序候选**——这不是「取队头」。所以 C 是**申请修改 PRD §3.2**:「增量同步事实,有空位时在本地按需重算候选,接受小规模本地扫描」,
  需要 Annie 明确同意。她不同意就做 A(可重建的派生队列),拷贝层不变。
- 成熟系统里两种都有:Kubernetes 维护内存优先队列(像 A,但重启就扔、从真相重建);Airflow / Prefect 在挑的那一刻从库里查(像 C)。**没有一家把派生队列当真相**。

### 5.2 表(StateStore,`migrate()` 里幂等建表;A 额外多一张 `refill_ready_queue`)

| 表 | 主键 / 唯一 | 字段(要点) |
|---|---|---|
| `refill_issue` | `issue_id` | 只放事实:identifier、title、project_key、parent_id、state_type(经 `normalizeLinearState`)、priority、labels_json、owner_lead、owner_match_method、owner_config_revision、workflow_hint、tombstone、linear_updated_at、hold_until |
| `refill_scope_member` | (`project_key`,`epic_id`,`generation`,`issue_id`) | kind(child = 可派 / evidence = 仅依赖证据) |
| `refill_relation` | (`blocker_id`,`blocked_id`) | relations_fetched_at(按被挡单整体替换) |
| `refill_scope` | (`project_key`,`epic_id`) | current_generation、mutation_rev、last_complete_at、status(fresh / stale / unknown)、last_error |
| `refill_sync_state` | `project_key` | watermark、last_incremental_at、last_full_at、budget_state |
| `refill_inbound` | `delivery_id` | issue_id、status(received / applied / dead)、attempts、received_at |
| `refill_slot` | (`project_key`,`issue_id`) 未释放唯一 | owner_lead、occupied_at、dispatch_id、released_at、release_source_kind、release_source_id(唯一) |
| `refill_eval_intent` | `id` | project_key、lead_id、source_kind、source_id、created_at、consumed_at |
| `refill_decision` | `id` | intent_id、lead_id、outcome(picked / full / no_ready / read_unavailable / disabled)、picked_json、created_at |
| `refill_suggestion` | `id`;部分唯一(issue_id)where state in (pending, reminded) | lead_id、issue_id、decision_id、state、reason_json、suggested_at、reminded_at、resolved_at、cooldown_until |
| `refill_outbox` | `event_key` 唯一 | suggestion_id、lead_id、payload、status(pending / delivered / unknown / canceled)、attempts |

- **owner Lead**(R1#9):复用 `resolveLeadForIssue`(`ProjectConfig.ts:1432`):项目内按配置顺序、大小写不敏感的 label 首次匹配,无匹配回第一个 Lead;
  general fallback 照 `epic-page/residual.ts:310-316` 检查能否起 runner。存 labels、匹配方式、配置 revision;配置或 label 变化 → 重算 owner,
  旧 owner 的有效提醒标 stale,新旧两个 Lead 都写评估意图。占位按**派出时**的 owner 计,直到转交。
- **流程类型**(PRD 2.3):派单接口接的是 `templateId` / `taskCategory`(`runs-route.ts`)。提醒里的流程类型取自单子上的流程类型标记
  (实现第一步确认现有约定并写入 `workflow_hint`);取不到就在提醒里写「这张没定流程类型,请定类型再派」。
- 项目开关、cap、Lead 队列都以 `(project_key, lead_id)` 为范围;开关关闭时评估器只写 decision(disabled),零行为变化。

### 5.3 就绪查询(C;A 用同一谓词维护队列。参数化,示意)

```sql
SELECT c.issue_id, c.identifier, c.title, e.priority AS epic_pri, c.priority AS pri
FROM refill_scope s
JOIN refill_scope_member m ON m.project_key = s.project_key AND m.epic_id = s.epic_id
                          AND m.generation = s.current_generation AND m.kind = 'child'
JOIN refill_issue c ON c.issue_id = m.issue_id
JOIN refill_issue e ON e.issue_id = s.epic_id
WHERE s.project_key = :project AND c.owner_lead = :lead
  AND s.status = 'fresh'
  AND c.parent_id = s.epic_id                                             -- 移父单后旧范围不再算
  AND e.state_type = 'started' AND e.tombstone = 0
  AND c.tombstone = 0
  AND c.state_type <> 'backlog'
  AND c.state_type NOT IN ('completed','canceled','duplicate')            -- = isTerminalForScheduling
  AND NOT EXISTS (SELECT 1 FROM refill_slot sl WHERE sl.project_key = c.project_key AND sl.issue_id = c.issue_id AND sl.released_at IS NULL)
  AND (c.hold_until IS NULL OR c.hold_until <= :now)                     -- 复核失败的有界暂缓
  AND NOT EXISTS (SELECT 1 FROM refill_suggestion g WHERE g.issue_id = c.issue_id
                  AND (g.state IN ('pending','reminded') OR g.cooldown_until > :now))
  AND NOT EXISTS (                                                         -- 只有「已知且 completed」的 blocker 才放行
      SELECT 1 FROM refill_relation r
      LEFT JOIN refill_issue b ON b.issue_id = r.blocker_id
      WHERE r.blocked_id = c.issue_id
        AND (b.issue_id IS NULL OR b.tombstone = 1 OR b.state_type IS NULL
             OR b.state_type <> 'completed'))                              -- = isSuccessForDependency
ORDER BY pri_rank(e.priority), pri_rank(c.priority), identifier_number(c.identifier)
LIMIT :free;
```

- 取消 / 重复的 blocker **不放行**(和现有 `isSuccessForDependency` 一致,需要人工复核依赖)。
- 设计验收样例:blocker 缺失、state 为空、无权限(tombstone)、canceled、duplicate、跨 Epic、范围 stale —— 都必须不出现在结果里。
- `pri_rank` / `identifier_number` 用确定的 SQL 表达式或注册的确定性函数实现;所有值走绑定参数。

## 6. 投递(R1#5:跨库,不承诺原子,靠稳定键幂等)

- 每次逻辑通知一个固定 `event_key`:首次 `refill:<suggestionId>:initial`,再提醒 `refill:<suggestionId>:reminder:1`;`refill_outbox.event_key` 唯一。
- 主线程(唯一能写 Lead 收件箱的一方,和 3147 边界一致)按 key 投递:`appendLeadEvent` 用 `event_id = event_key`(现有 `(lead_id, event_id)` 去重,`StateStore.ts:29753-29757`),
  再走现有 `enqueueLeadEvent`(canonical deliveryId `lead_event:<lead>:<eventId>`,`lead-event-queue.ts:8-12`)。
- outbox 状态:`awaiting_recheck` →(worker 复核通过)`deliverable` → `delivered`;另有 `unknown`、`needs_recheck`、`canceled`。
- **可投递凭据**:置 deliverable 时写入 `valid_until`(复核后 10 分钟)、`config_rev`(项目开关 / cap / Lead 配置版本)、相关范围的 `mutation_rev`
  ——取 worker 把复核结果 CAS 写回**之后**的值(避免自己的写回让凭据立刻失效)。
- **主线程产生外部效果前再检查**:项目开关仍开、suggestion 仍 pending / reminded、`valid_until` 未过、`config_rev` 未变、
  **相关范围的当前 `mutation_rev` 等于凭据里的值、范围仍 fresh 且 `last_complete_at` 在新鲜度预算(§8)内**;任何一条不满足 →
  outbox 改 `needs_recheck` 交回 worker(重新复核或撤销),**不发**。所以「关开关前已有的待投消息」「复核后停机到过期再启动」都不会直接发出。
- 只有拿到 comm.db 持久入队回执(`lead-event-queue.ts` 的 DurableQueueReceipt)才标 delivered。
- 超时 / 不确定 → unknown。恢复时**只认 comm.db 的正面证据**:按 canonical deliveryId `lead_event:<lead>:<eventId>` 查 comm.db 活动队列记录或持久归档状态;
  查到 → 只补标 delivered,不再发;**`lead_events` 日志里有这条不算入队证据**(append 与 enqueue 不是原子的,`lead-inbox-runtime.ts:711-716` 有 append 后队列关闭的路径)。
  只有日志、comm.db 查不到 → 先按上一条重新核对当前发送条件,仍成立才用同一 key、同一 envelope / seq 补投;comm.db 无法查询 → 保持 unknown,下轮再查。
- outbox 由主线程在启动时和每个 GatePoller 维护轮次 drain。
- **thread 留痕(PRD 2.9)是另一种事件**,条件和回执都不同:只在 `/api/runs/start` 接纳、suggestion 变 dispatched **之后**创建
  (key `refill:<sid>:thread-note`),绑定占位行的 `dispatch_id` 和那张单的 Discord thread;thread 还没建好就等着重试。
  它的 delivered 依据是 **Discord 消息回执**,不是 comm.db 回执;响应丢失按 FLY-3147 plan 的 marker / 历史读回收敛,不靠本地 key 宣称防重。
  不用 Lead 收件箱代替真正的 thread 留言。

## 7. 第 1 题:补单放在哪个后台线程(已选 A,本节讲清 A / B)

两者**业务逻辑完全一样**(§2–§6);区别只在「跑在哪个线程、谁照看这个线程」。两者都是**同一 Bridge 进程里的线程**,
都隔离不了原生模块崩溃、进程内存耗尽、同一 SQLite 的争用(FLY-3147 plan §1「诚实边界」)。

### 7.1 A:作为 FLY-3147 任务目录里的一组任务

- 在 `bridge/patrol-worker/task-registry.ts` 注册组 `refill`:`refill.pull`、`refill.reconcile`、`refill.evaluate`、`refill.remind`、`refill.sweep`;
  稳定 taskId、cadence、资源互斥 key 按 3147 规则写。
- 线程内:自己的 SQLite 连接 + 短事务;Linear / Cloudflare 的 HTTP 在线程内发。
- 写 Lead 收件箱 / thread 留言 → 经 3147 effect port 由主线程按 §6 投递。
- 释放与派单占位在主线程(派单接口、收尾)或 3147 worker(land / external merge)里写库;评估器只读库,与在哪个线程产生无关。
- 由 3147 supervisor 管重启、熔断;由 3147 分组开关管启用。

| Pros | Cons |
|---|---|
| 只有一套线程框架:启动、重启、熔断、锁中介、日志、开关都复用 | 补单要等 3147 骨架和数据库争用保护先落地(3147 又等 3146 合入);3147 现在只有设计 |
| 3147 已过 3 轮 design review,「谁能写收件箱、谁能动 runner」的边界已想清楚 | 和其他巡检共用一个线程:某个巡检任务慢(3147 文档提到 land 最长 460 秒)可能拖慢补单,要靠 3147 的「每任务 single-flight、等 I/O 时让出」 |
| 以后其他 Lead 的队列也在同一框架下 | 3147 接口中途改,补单跟着改;排查要懂 3147 框架 |

### 7.2 B:补单自己先起一个线程,3147 以后复用或合并

| Pros | Cons |
|---|---|
| 不等 3147 / 3146,线程部分可以先开工 | 两套线程框架(启动 / 重启 / 熔断 / 消息协议 / 锁),3147 已设计的那套再造一遍 |
| 补单的普通 JavaScript 异常和慢操作不占其他巡检的线程,排查范围小 | 同一进程:原生崩溃、内存耗尽、SQLite 争用照样互相影响;多一条常驻线程多一份内存(几十 MB 量级,推断) |
| | 以后合进 3147 是一次额外迁移(或永远两套);「谁能写收件箱 / 动 runner」规矩要再写一遍、再审一遍 |

### 7.3 建议(R1#13)

**默认按 1A:3147 骨架和数据库争用保护落地后启用 `refill` 组。**不推荐也不默认「先在主线程跑」:那是对 PRD §3.1(独立后台 worker)的临时变更,
需要 Annie 另外批准;它的风险是同步 SQL / JSON 解析会直接占主线程(设耗时告警只能事后发现,不能中断),「单次毫秒级」也还没实测。
若她批准这个临时变更,启用门槛 = 实测单次评估与单页对账的主线程耗时、上线后持续记录,3147 就绪后切开关迁回 worker。

## 8. 读数坏了一定有声音(PRD 2.8)

- 新鲜度闸门(§2.4 第 2 步):范围 stale / unknown,或最近一次完整快照超过 20 分钟(= 2 个对账周期)→ 不发新的「可以做」,decision 记 read_unavailable,
  给 Lead 投「补单读数坏了」,**手上没 runner 的 Lead 也投**(修 `patrol-tick.ts:377-390` 那种静音);恢复后发一条恢复通知。
- 允许的陈旧窗口:两次对账之间,Linear 里手改依赖、暂停 Epic 不会马上进拷贝;发送前复核(§2.4)把「发出时已过时」挡住,
  但 Lead 看到之前仍可能过时——所以第一版保留「Lead 看一眼」,页面上明说。

## 9. 拆单(更新版,子单由 Tadashi 定)

| # | 子单 | 依赖 | 对应 |
|---|---|---|---|
| 1 | Linear 拷贝:范围 / 完整快照 / 增量 / 对账 / 新鲜度 / 限流 + 读数坏了告警;实测三条 Linear 行为;取代 FLY-2971 的读法 | 和 Annie 过完设计;**不受第 3 题影响**(A、C 都需要) | 5A、2.8 |
| 2 | 占位表 + 释放入口矩阵 + 评估意图 + 评估器 + 提醒状态机 + outbox 投递 + 30 分钟再提醒 + 上限 / 开关 + thread 留痕 + 「为什么没补」 | 1;线程按第 1 题;挑单方式按第 3 题 | 4A、2.2–2.7、2.9 |
| 3 | Cloudflare Worker + Queue + Bridge 拉取 + 推送健康检查 | 1;Cloudflare 账号、Linear 管理员建 webhook | 2B |
| 4 | 测试房演练 + 上线一周数据 | 2(3 可后补) | PRD §5 |

## 10. 测试证据(实现阶段要交,本轮不跑)

- 单元:就绪查询全部反例(§5.3 样例);占位不因阶段交接 / 重试 / runner 失败释放,只因 §2.2 证据释放、同一来源只释放一次;
  提醒状态机每条边;部分唯一索引挡住同单两条有效提醒;冷却期不重发;outbox 同 key 重放不双发;webhook 验签(原始 body、篡改、过期签名时间戳、错组织);
  inbound received 未 applied 崩溃后重做;快照缺页不发布;旧 updatedAt 不覆盖;RATELIMITED(HTTP 400)退避;
  两 PR 只合入第一张不释放、最后一张合入只释放一次、旧派单回执不释放新占位;X 被新 blocker 挡住 → 复核写回拷贝 → 下一轮挑 Y,不反复复核 X;
  复核取不全 → 有界暂缓;旧全量扫描晚于新增 / 删除依赖到达 → CAS 冲突丢弃重来;X 同时是 A 的子单和 B 的 blocker,A/B 任意刷新顺序、B 退出范围、X 移父单都不丢资格或证据;
  关开关前已有 deliverable outbox → 不发;复核后停机超过 valid_until → 重新复核;thread 留痕只在派出后、以 Discord 回执为准;
  「日志已写、enqueue 失败 / 未发生」→ 必须补投;「enqueue 已提交、回执丢失」→ 只补回执不双发;
  deliverable 后、凭据未过期且配置未变,但范围变 stale 或 mutation_rev 改变 → 主线程不投,转 needs_recheck。
- 集成:3 张能开始的单 → 合入 1 张 → 收件箱 1 条「可以做 X」;Linear 标过时 → stale → 下一张;Epic 放回 Todo → 不再给;
  释放后杀掉 worker、Linear 不变 → S5 补上评估;丢一条 webhook → 对账补上;对账失败超预算 → 闸门关、「读数坏了」;Lead 无 runner 也收到告警;
  手动急活与评估器并发 → 不超过 13。
- 反向守卫:位子满时 S2 / S3 不调用就绪查询(计数断言);项目开关关闭时零行为变化。

## 11. 要 Annie 在设计页上定的

1. 触发时机:推荐「变化只更新拷贝、有空位才挑 + 对账兜底」(另两个:只在释放时挑;每次变化重算)。
2. 第 1 题:A,等 3147(推荐)/ A + 先在主线程跑(需另批的 PRD §3.1 临时变更)/ 改选 B。
3. 第 2 题落地:Cloudflare Worker + Queues(推荐)/ Cloudflare Tunnel(要域名)/ 先只靠对账。
4. 第 3 题:C(需同意修改 PRD §3.2,推荐)/ A(PRD 字面,多一层派生队列)/ B(每次现拉 Linear)。

## 12. 边界

- 做:上面的设计与拆单建议。不做:产品代码、Bridge 改动、跑测试(机器负载高)、全自动派单(PRD 6.1)、模型 / 额度选择(另一份 PRD)、PM 验收(FLY-830)。
- 没实测:三条 Linear 行为(§4.4)、Cloudflare token 实际范围(§4.3)、挑单耗时(§5.1)、Linear webhook 停用状态的查询字段(§4.6)、请求量估算(§4.5)。
