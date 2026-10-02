# FLY-3131 在飞空位自动补单 — 实施计划(第二版设计)
Issue: FLY-3131 (https://linear.app/geoforge3d/issue/FLY-3131/epic在飞空位自动补单-按-fly-3103-prd-做开工前先和-annie-过设计)
日期: 2026-10-01
基于: research.md

> 状态:设计节点产出,**还没有和 Annie 过完**(PRD §6.0:开工前先和她过一遍设计)。本文是第二版设计页(founder-design.html)的工程底稿;
> 标「待 Annie 定」的地方以她在页面上的选择为准。不写产品代码、不动 Bridge。
> 已定:1A(共用 FLY-3147 后台线程)、2B(接 Linear webhook,可用 Cloudflare)、4A(走 Lead 收件箱)、5A(不依赖 Epic 页,从 Linear 增量算)。第 3 题待定。

## 1. 一句话

**Linear 的变化只增量更新一份本地副本(不排序);空出位子、或「有空位时副本变了」,才在副本上当场算出下一张,投进 Lead 收件箱;
再用低频对账兜住漏掉的变化。**

## 2. 触发时机(回答 founder「每 5 分钟都要算吗」)

### 2.1 结论

不再「每 5 分钟算一遍能开工的单」。三类信号,各管一件事:

| 信号 | 来源 | 做什么 | 算不算「下一张」 |
|---|---|---|---|
| S1 空出位子 | 本地:收尾路径 `runPostShipFinalization` 的 5 个入口已汇到 `notifyEpicChanged(project,"session_completed")`;另含 runner 失败 / 被停 | 标记该 Lead「要评估」 | **算** |
| S2 Linear 有变化 | Cloudflare 收的 webhook(拉取)+ 本地事件(`/api/dependency` 增删依赖、Flywheel 自己改状态) | 只更新副本里受影响的那几行 | 只有这个 Lead **此刻有空位**才算 |
| S3 对账 | 定时,默认 10 分钟一轮增量 + 每天一次全量 | 把副本和 Linear 对齐(补漏掉的事件、依赖变化) | 同 S2:副本真变了且有空位才算 |
| S4 再提醒 | 定时检查「提醒了 30 分钟没回应」 | 再投一次 | 不重新算,复用原提醒(若那张单已不可开始,则重新算一张) |

- **位子满(最常见)时,零排序开销**:S2 / S3 只写副本。这就是 founder 的 ①「有 capacity 时再算」。
- founder 的 ②「每次 Linear 变化重算 DAG」被拆成两半:**变化时只增量更新副本(便宜)**,**有空位时才算**(只取一张)。
- 和成熟系统对齐:Kubernetes 调度器同型(事件只把「可能帮得上的」放回队列 + 定时 flush 兜底);Buildkite / Temporal「有空位才放下一个」;
  Airflow「只有排队多于空位,排序才有意义」(research.md §1)。

### 2.2 评估器(每个 Lead 一个,single-flight)

```
dirty[lead] = true            ← S1;或 S2/S3 且 freeSlots(lead) > 0
loop while dirty[lead]:
  dirty[lead] = false
  free = cap(lead) − inFlight(lead) − outstandingSuggestions(lead)
  if free <= 0: break
  pick = readyQuery(lead, limit = free, exclude = outstanding ∪ inFlight)
  for each: write suggestion row (idempotency key = lead + issue + slotEpoch) → enqueue lead event
  (评估过程中新到的事件会把 dirty 重新置 true,下一圈处理 —— 照 K8s 对「正在调度」期间事件的处理)
```

- `inFlight(lead)`:StateStore 里该 Lead 名下未终态的 runner(从派出占到合入,等 Annie 按卡的也占)。
- `outstandingSuggestions`:已提醒、未派、未过期(默认 2 × 30 分钟)的提醒,先占着位子,避免同一个空位连发两张。
- `cap(lead)`:项目配置,默认 12(PRD 2.7);13–14 不自动提醒。
- 结果写库与投递用同一个 SQLite 事务写 suggestion 行 + outbox 行(Temporal 式 outbox),投递失败可重放、不重复。

## 3. 第 1 题:补单放在哪个后台线程(已选 A,本节讲清 A / B)

两者**业务逻辑完全一样**(§2 的评估器、§4 的 Linear 接入、§5 的副本);区别只在「跑在哪个线程、谁管这个线程」。

### 3.1 A:作为 FLY-3147 任务目录里的一组任务

- 在 `bridge/patrol-worker/task-registry.ts` 注册组 `refill`:任务 `refill.pull`(拉 Cloudflare 队列)、`refill.reconcile`(对账)、
  `refill.evaluate`(评估器)、`refill.remind`(30 分钟再提醒)。稳定 taskId、cadence、资源互斥 key 按 3147 规则写。
- 线程内:自己的 SQLite 连接 + 短事务写副本 / 提醒;Linear / Cloudflare 的 HTTP 在线程内发。
- 要发给 Lead 的提醒 → 经 3147 的 effect port 请主线程 `appendLeadEvent` + `enqueueLeadEvent`(Lead 收件箱只由主线程写,沿用现有链路)。
- S1(空出位子)发生在主线程收尾路径 → 主线程只发一条「slot_freed(lead)」消息给线程。
- 由 3147 的 supervisor 管重启、熔断;由 3147 的分组开关管「在主线程还是线程里跑」。

| Pros | Cons |
|---|---|
| 只有一套线程框架:启动、重启、熔断、锁中介、日志、开关都复用,不重复造 | 补单的线程部分要等 3147 骨架(3147 又等 3146 合入);3147 现在只有设计 |
| 3147 已过 3 轮 design review,线程边界(谁能写收件箱、谁能动 runner)已经想清楚 | 补单和其他巡检挤同一个线程:一个巡检任务卡住(3147 文档提到 land 最长 460 秒)可能拖慢补单提醒,要靠 3147 的「每任务 single-flight、await I/O 时让出」 |
| 3147 每组「默认主线程、开关切换」:补单可以先按同一规则在主线程跑、3147 好了切开关,不必真的等(见 3.3) | 3147 的接口如果中途改,补单要跟着改 |
| 以后其他 Lead 的队列也在同一框架下,不会出现第二套 | 出问题时排查要同时懂 3147 的框架 |

### 3.2 B:补单自己先起一个线程,3147 以后复用或合并

- 新建 `bridge/refill-worker/`:自己的 `new Worker(...)`、自己的 supervisor、自己的消息协议、自己的 SQLite 连接。
- 向 Lead 投递同样要回主线程(收件箱写入方只能是主线程),所以也要自己写一套「请主线程代发」的消息。

| Pros | Cons |
|---|---|
| 不等 3147 / 3146,线程部分可以和子单 1 并行开工 | 两套线程框架(启动 / 重启 / 熔断 / 消息协议 / 锁)——3147 已经设计了一套,这里再造一套 |
| 补单独占线程,不被其他巡检任务拖慢 | Bridge 里多一个常驻线程:多一份内存(每个线程一个独立 V8,几十 MB 级 [推断]) |
| 出问题边界清楚,只影响补单 | 以后合并进 3147 是一次额外迁移(或者永久两套) |
| | 「谁能写 Lead 收件箱 / 谁能动 runner」的规矩要再写一遍、再审一遍 |

### 3.3 建议(待 Annie 确认第 1 题)

保持 **A**。补一个过渡做法给她选:**A-先主线程**——3147 线程骨架没到之前,`refill` 组按 3147 的「默认主线程」规则在主线程跑,
每次评估 / 每批同步设耗时预算(超 50 ms 记告警);3147 到了切开关搬进线程。理由:本方案下补单单次计算是毫秒级(本地副本 + 一条查询),
主线程上真正可能慢的只有对账时解析 Linear 返回;用小批量分页控制。若她坚持 PRD 第 3 节第 1 条的字面要求「不在主线程算」,则 **A-严格等 3147**。

## 4. 第 2 题:怎么拿到 Linear 的变化(已选 B:webhook;推荐 Cloudflare Worker + Queues)

```
Linear ──webhook──▶ Cloudflare Worker(*.workers.dev)
                     · 验 Linear-Signature(原始 body,HMAC-SHA256)+ 时间戳 ±60s,可选 Linear 出口 IP 白名单
                     · 只保留 {deliveryId, type, action, issueId, 改动字段名},写入 Cloudflare Queue,立刻回 200
Bridge refill.pull(每 30 s)──HTTP 拉取──▶ Queue(batch ≤ 100,可见超时 5 min)
   · deliveryId 去重 → 按 issueId 回 Linear 重拿这张单(状态/优先级/父单/子单/依赖)→ 写副本 → 成功后 ack
本地事件(/api/dependency、收尾)──▶ 直接写副本
refill.reconcile(10 min 增量 + 每天全量)──▶ Linear GraphQL(updatedAt > 水位线 − 5 min;进行中 Epic 树的依赖全拉)
```

- **为什么不信 payload、要回 Linear 重拿**:Linear 不保证顺序、重试可晚到 6 小时;重拿最新状态让乱序和迟到无害。
- **为什么对账不能省**:Linear webhook **不推送依赖关系变化**(research.md §3.1);依赖在 Linear 界面里手改,只有对账能发现。
- **为什么选 Worker + Queues 而不是 Tunnel**:不要域名(FLY-3102 的 F2 隧道 / Tailscale 还没定,不被它卡住)、本机不开任何入口、
  本机关机时消息在队列里存 24 小时(免费)/ 最多 14 天(付费 5 美元 / 月);Linear 永远立刻拿到 200,webhook 不会因本机关机被停用。
- **密钥**:Linear webhook 签名密钥只放在 Worker secret;本机只放一个只能读写这一个队列的 Cloudflare token(`~/.flywheel/.env`,不进仓库、不进 argv)。
- **健康告警**:超过 N 小时(默认 6)一条 webhook 都没收到、或拉取连续失败 → 给 Lead 发「补单读数变慢 / 坏了」(PRD 2.8);
  此时自动退回「只靠对账」,对账间隔缩到 3 分钟。
- **交付顺序上的诚实说明**:webhook 只影响「位子空着、在等新的能开始的单」这类情况的延迟,不影响正确性(正确性由对账保证)。
  所以子单顺序是先做副本 + 对账(没有 Cloudflare 也能用,最多晚 10 分钟),再把 webhook 当加速层叠上去。
- 前提(要 Annie / 运维给):用哪个 Cloudflare 账号(FLY-3102 共同前提)、Linear 建 webhook 要 workspace 管理员。

## 5. 第 3 题:待派的单存在哪(待定;推荐 C)

### 5.1 三个选项

| | 做法 | 依据 |
|---|---|---|
| A(第一版建议) | 存一张「已排好序的待派队列」表,每个变化增量改它 | 自己维护一份要和 Linear 同步的就绪表;漏一个事件就错一张、不会自愈。成熟系统没有这么做的(research.md §1.1 第 1 条) |
| B(第一版) | 不存,每次需要时去 Linear 现拉、现算 | = 今天 ready.v1 的读法:20 秒截止、43/200 超时、1.5 MB 超限 |
| **C(新,推荐)** | **存 Linear 的本地副本(增量同步);有空位时在副本上当场算、取第一张;另存我们自己的「提醒记录」** | Kubernetes informer 缓存 + 调度时当场挑;Airflow / Prefect「真相在库,就绪在查询那一刻算」 |

C 怎么满足 PRD 第 3 节第 2 条:「输入一变只增量更新受影响部分」→ 增量更新的是副本;「有空位直接取队头,不全量重排」→
取队头是副本上一条 `ORDER BY … LIMIT n` 查询(几百行、毫秒级),不去 Linear 全量拉、位子满时不算。「队列是缓存不是第二份真相」→
副本可随时从 Linear 重建(删表 + 全量对账)。字面上 PRD 说「持久队列」,C 把它落成「持久副本 + 当场算」,**需要 Annie 确认这个理解**。

### 5.2 C 的表(StateStore,`migrate()` 里幂等建表)

| 表 | 主键 | 字段(要点) | 说明 |
|---|---|---|---|
| `refill_issue` | `issue_id` | identifier、project_key、parent_id、state_type、state_name、priority、owner_lead(按现有部门 label 规则)、linear_updated_at、synced_at、archived | 只放进行中 Epic 及其子单;Epic 本身也在这张表(parent_id 为空) |
| `refill_relation` | (`blocker_id`,`blocked_id`) | synced_at | 只放 `blocks` 关系;对账时按 Epic 树整批替换 |
| `refill_sync_state` | `project_key` | watermark、last_incremental_at、last_full_at、last_webhook_at、last_error | 水位线写库成功后才前移 |
| `refill_delivery_seen` | `delivery_id` | received_at | webhook 去重,保留 7 天 |
| `refill_suggestion` | `id` | lead_id、issue_id、slot_epoch、reason_json、suggested_at、reminded_at、outcome(dispatched / stale / expired)、resolved_at;唯一键(lead_id, issue_id, slot_epoch) | 提醒台账:30 分钟再提醒、一周验收数据都从这里出 |
| `refill_outbox` | `id` | suggestion_id、event_kind、payload、delivered_at | 和 suggestion 同一事务写,主线程投递 |

就绪查询(示意,参数化):

```sql
SELECT c.issue_id, c.identifier, e.priority AS epic_pri, c.priority AS pri
FROM refill_issue c JOIN refill_issue e ON e.issue_id = c.parent_id
WHERE e.state_type = 'started' AND e.archived = 0
  AND c.owner_lead = :lead AND c.archived = 0
  AND c.state_type NOT IN ('backlog','completed','canceled')
  AND c.issue_id NOT IN (SELECT issue_id FROM <活跃 runner>)            -- 已在做
  AND c.issue_id NOT IN (SELECT issue_id FROM refill_suggestion WHERE outcome IS NULL)
  AND NOT EXISTS (SELECT 1 FROM refill_relation r JOIN refill_issue b ON b.issue_id = r.blocker_id
                  WHERE r.blocked_id = c.issue_id AND b.state_type NOT IN ('completed','canceled'))
ORDER BY pri_rank(e.priority), pri_rank(c.priority), identifier_number(c.identifier)
LIMIT :free;
```

- 「挡它的单不在副本里」(跨 Epic 依赖、或挡它的单在 Todo 的 Epic 下)→ 对账时把这些 blocker 也拉进 `refill_issue`(只用来判状态,不参与派单)。
  拉不到(权限 / 已删)→ 按「仍被挡」处理并在提醒原因里写明,宁可少补不误补。
- 台账型 Epic(FLY-2072)不进调度:按 PRD 4.3,Epic 不在 In Progress 就不进;若它常年 In Progress,用项目配置的排除名单。

## 6. 读数坏了一定有声音(PRD 2.8)

- 对账失败 / 拉取失败 / 副本过期(超过 2 个对账周期没成功)→ 给 Lead 投「补单读数坏了」,**手上没 runner 的 Lead 也投**(修 `patrol-tick.ts:377-390` 那种静音)。
- 一次合入后若没有提醒,必须写一条「为什么没补」(没有能开始的单 / 位子满 / 读数坏了),进 suggestion 台账 → 一周验收「每次合入都有下文」。

## 7. 拆单(更新版,子单由 Tadashi 定)

| # | 子单 | 依赖 | 对应 |
|---|---|---|---|
| 1 | Linear 本地副本 + 对账(增量 / 全量 / 依赖)+ 就绪查询 + 坏了告警;取代 FLY-2971 的读法 | 无,现在可开 | 5A、第 3 题 C、2.8 |
| 2 | 评估器 + 提醒台账 + outbox 投 Lead 收件箱 + 30 分钟再提醒 + 上限 12 / 项目开关 + thread 留痕 | 1;线程归属按第 1 题(A:注册进 3147 任务目录) | 4A、2.2–2.7、2.9 |
| 3 | Cloudflare Worker + Queue + Bridge 拉取(webhook 加速层)+ 静默告警 | 1;Cloudflare 账号、Linear 管理员建 webhook | 2B |
| 4 | 测试房演练 + 上线一周数据 | 2(3 可后补) | PRD §5 |

## 8. 测试证据(实现阶段要交,本轮不跑)

- 单元:就绪查询(依赖未完成 / 跨 Epic blocker / Backlog / 已在做 / 已提醒 / 优先级三级排序);评估器 single-flight + 评估中到达事件不丢;
  幂等键防同一空位重复提醒;webhook 验签(原始 body、过期时间戳、错签名拒绝);deliveryId 去重;水位线只在成功后前移。
- 集成:模拟 3 张能开始的单 → 合入 1 张 → 收件箱 1 条「可以做 X」;Linear 标过时 → 下一张;Epic 放回 Todo → 不再给;
  丢掉一条 webhook → 对账补上;拉取连续失败 → 「读数坏了」;Lead 无 runner 时也收到告警。
- 反向守卫:位子满时 S2/S3 只写副本、不调用就绪查询(计数断言);项目开关关闭时零行为变化。

## 9. 要 Annie 在设计页上定的

1. 触发时机:推荐「变化只更新副本、有空位才算 + 对账兜底」(另两个:只按空位;每次变化重算)。
2. 第 1 题:A-先主线程(推荐)/ A-严格等 3147 / 改选 B。
3. 第 2 题落地:Cloudflare Worker + Queues(推荐)/ Cloudflare Tunnel(要域名)/ 先只用对账、webhook 以后再加。
4. 第 3 题:C 本地副本 + 当场算(推荐)/ A 存排好序的队列 / B 每次现拉 Linear。

## 10. 边界

- 做:上面的设计与拆单建议。不做:产品代码、Bridge 改动、跑测试(机器负载高)、全自动派单(PRD 6.1)、模型 / 额度选择(另一份 PRD)、PM 验收(FLY-830)。
- 没在真 Linear 上实测:改父单的 `updatedFrom.parentId`、改依赖是否刷新 `updatedAt`、删掉的依赖能否查到。实现子单 1 的第一步就是实测这三条。
