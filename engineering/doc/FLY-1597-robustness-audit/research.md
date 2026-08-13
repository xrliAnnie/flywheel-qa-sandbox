# FLY-1597 系统健壮性全面摸底 — 调研(证据卷)

Issue: FLY-1597 (https://linear.app/geoforge3d/issue/FLY-1597/审计founder-直令-系统健壮性全面摸底-消息重构开工前的稳定性裁定dag-能不能用runnerlead-通不通还有什么在真坏)
日期: 2026-08-01
基于: exploration.md

> 本文只放**取证过程和原始读数**。裁定、红黄绿、修复排序在 `plan.md`。
> 所有时间戳:库里是 UTC,正文标注 PDT 时写明。审计窗口 = 2026-08-01 15:18–15:50 PDT。

---

## 0. 仪器校准(先做,否则后面全是废数)

### 0.1 时间

```
$ date "+%F %T %Z"                      → 2026-08-01 15:20:58 PDT
$ date -u "+%F %T UTC"                  → 2026-08-01 22:20:58 UTC
$ sqlite3 comm.db "SELECT CURRENT_TIMESTAMP;" → 2026-08-01 22:20:58
```

⇒ SQLite 写的是 **UTC**。本地看着「未来 7 小时」的行都是正常行。

### 0.2 四种时间戳格式(同一台机器)

| 位置 | DDL 默认值 | 实际形态 |
|---|---|---|
| `comm.db` `messages.created_at` | `CURRENT_TIMESTAMP` | `2026-08-01 22:20:15` |
| `comm.db` `lead_inbox.created_at` | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` | `2026-08-01T22:20:15.000Z` |
| `teamlead.db` `lead_events.created_at` | `datetime('now')` | `2026-08-01 22:18:00` |
| `teamlead.db` `workflow_gate_holder.created_at` | 应用写入 | `2026-07-24T07:02:54.823Z` |

**同一个 `comm.db` 里 `messages` 和 `lead_inbox` 格式不同。** 跨表按时间 join / 过滤必须先归一,否则静默返回 0。

### 0.3 HTTP 探针对照组

```
控制组(临时 python listener :9911)  → HTTP=200  0.004s
Bridge :9876 /health                 → HTTP=200 12.057s
Bridge :9876 /api/health             → HTTP=401 12.193s
Bridge :9876 /                       → HTTP=200  7.086s
```

⇒ curl 本身没问题(4 ms),**Bridge 真的慢**。这解释了为什么 `flywheel-comm stage set` 报
`This operation was aborted`(它的 fetch 超时是 10 s)。

### 0.4 两次探针自救(不校准就会写出假结论)

| 症状 | 真因 | 修正后 |
|---|---|---|
| 17 个模板全 FAIL,报 `path must be of type string` | 我没给 `buildWorkflowRunSnapshotV2` 传 `canonicalRoot` | 11 PASS / 6 FAIL |
| 10 个 live run 全报 `workflow snapshot JSON is corrupt` | `parseWorkflowRunSnapshot()` 收 JSON **字符串**,我传了对象 | 7 PASS / 3 FAIL |

⚠️ 第二版探针里我打印了「两种结果都出现 ⇒ 探针没卡死」,但那行是**无条件打印**的 —— 自检是假的。已在 exploration.md §3.1 记为反面教材。

---

## Q1 — DAG 现在到底能不能用

### 1.1 收工判据的代码位置(已核实)

`packages/teamlead/src/workflow-run-snapshot.ts` `resolveWorkflowGateAuthority()`:

```ts
const subjectKind = snapshot.manifest.ship_claims.some(c => c !== "founder_approved")
    ? "git_head" : "snapshot_digest";
...
const candidates = snapshot.resolved.nodes.filter(n =>
    n.capabilities.creates_pr || n.capabilities.can_ship || n.capabilities.can_land);
if (candidates.length === 0) return { mode: "engine_terminal", subjectKind };
if (candidates.length !== 1) throw new Error("incoherent_ship_bundle");
...
if (subjectKind !== "git_head") throw new Error("incoherent_ship_bundle");
```

三条互斥要求:**有承运节点 ⇒ 必须恰好一个 ⇒ 且 `ship_claims` 里必须有非 `founder_approved` 的项**。

### 1.2 17 个已发布模板逐个跑生产函数

探针:`buildWorkflowRunSnapshotV{1,2}` + `resolveWorkflowGateAuthority`,`canonicalRoot=/Users/xiaorongli/Dev/flywheel`。

```
PASS tpl_eng                  rev=5 schema=1  runner_ship/git_head carrier=implement
PASS tpl_eng_heavy            rev=5 schema=1  runner_ship/git_head carrier=implement
PASS tpl_eng_heavy_land_v1    rev=4 schema=1  land/git_head
PASS tpl_eng_land_v1          rev=4 schema=1  land/git_head
PASS tpl_eng_light            rev=4 schema=1  runner_ship/git_head carrier=implement
PASS tpl_eng_light_land_v1    rev=3 schema=1  land/git_head
PASS tpl_eng_trivial          rev=2 schema=1  runner_ship/git_head carrier=implement
PASS tpl_eng_trivial_land_v1  rev=1 schema=1  land/git_head
PASS tpl_code                 rev=3 schema=2  runner_ship/git_head carrier=implement
PASS tpl_product_designer     rev=1 schema=2  runner_ship/git_head carrier=design_iterate
PASS tpl_product_prototype    rev=2 schema=2  runner_ship/git_head carrier=build

FAIL tpl_generic       rev=2 incoherent_ship_bundle :: carriers=1[execute] ship_claims=[founder_approved] subjectKind=snapshot_digest missingCaps=[] route=needs_review
FAIL tpl_generic_menu  rev=3 incoherent_ship_bundle :: carriers=1[execute] ship_claims=[founder_approved] subjectKind=snapshot_digest missingCaps=[] route=needs_review
FAIL tpl_design        rev=3 incoherent_ship_bundle :: carriers=1[produce] ship_claims=[founder_approved] subjectKind=snapshot_digest missingCaps=[] route=needs_review
FAIL tpl_prd           rev=3 incoherent_ship_bundle :: carriers=1[produce] ship_claims=[founder_approved] subjectKind=snapshot_digest missingCaps=[] route=needs_review
FAIL tpl_prototype     rev=3 incoherent_ship_bundle :: carriers=1[produce] ship_claims=[founder_approved] subjectKind=snapshot_digest missingCaps=[] route=needs_review
FAIL tpl_product_v1    rev=1 incoherent_ship_bundle :: carriers=2[research,produce] ship_claims=[design_review_approved,founder_approved] subjectKind=git_head
```

**11 PASS / 6 FAIL。** 比 issue 里写的「tpl_generic ❌、tpl_product_v1 ❌、其余 10 ✅」范围更大:实际是 **6 个模板挂**,多出 `tpl_generic_menu` / `tpl_design` / `tpl_prd` / `tpl_prototype`。

两种失败:
* **A 型(5 个)** —— 承运节点能力齐全(`missingCaps=[]`)、`completion_route` 正确,唯独 `ship_claims` 只有 `founder_approved` ⇒ `subjectKind=snapshot_digest` ⇒ 最后一道 `if` 抛。
* **B 型(1 个)** —— `tpl_product_v1` 有**两个**承运节点(`research`+`produce`)⇒ `candidates.length !== 1` 抛。

### 1.3 #748 不是修好了这族病,是**制造**了它

`git show 2ed08e54^:packages/config/src/node-type-registry.ts`:

```ts
generic: { …, capabilities: noCode("no_code") },   // 12 个能力位全 false
```

当前 `main`:

```ts
generic: { …, capabilities: { ...noCode("needs_review"),
    shared_branch_writer: true, creates_pr: true, can_ship: true, can_land: true,
    approval_gate_holder: true, needs_review_evidence: true, needs_mailbox_transport: true } },
```

⇒ 748 之前 generic 不是承运节点 ⇒ `candidates.length === 0` ⇒ 返回 `engine_terminal`,**不抛**。
⇒ 748 之后 generic 是承运节点,而 `ship_claims` 没跟着改 ⇒ **抛**。

### 1.4 用生产 pinned snapshot 证明切换时刻(最硬的一条)

`workflow_run.snapshot` 存的是 run 起跑时冻结的快照。把每个 active run 的这份快照原样喂给生产函数:

```
2026-08-01 22:14:42  FLY-1597  tpl_generic_menu rev=3 node=execute      → THROW incoherent_ship_bundle
2026-08-01 07:52:41  FLY-1591  tpl_generic_menu rev=3 node=execute      → THROW incoherent_ship_bundle
2026-08-01 07:52:29  FLY-1590  tpl_generic_menu rev=3 node=execute      → THROW incoherent_ship_bundle
2026-08-01 03:55:53  FLY-1588  tpl_code         rev=3 node=design       → PASS  runner_ship/git_head
2026-08-01 03:29:00  FLY-1587  tpl_generic_menu rev=3 node=founder_gate → PASS  engine_terminal/snapshot_digest
2026-08-01 02:41:05  FLY-1586  tpl_code         rev=3 node=design       → PASS  runner_ship/git_head
2026-08-01 01:18:15  FLY-1581  tpl_generic_menu rev=3 node=founder_gate → PASS  engine_terminal/snapshot_digest
2026-08-01 01:08:26  FLY-1580  tpl_generic_menu rev=3 node=founder_gate → PASS  engine_terminal/snapshot_digest
2026-08-01 01:04:36  FLY-1578  tpl_generic_menu rev=3 node=founder_gate → PASS  engine_terminal/snapshot_digest
2026-08-01 01:04:24  FLY-1579  tpl_generic_menu rev=3 node=founder_gate → PASS  engine_terminal/snapshot_digest
```

同一个 `tpl_generic_menu` rev 3,结果分成两半。看 pin 住的能力位:

| run | 起跑 (UTC) | pinned `execute` 能力 | 结果 |
|---|---|---|---|
| FLY-1580 | 01:08 | `creates_pr=False can_ship=False can_land=False route=no_code` | PASS engine_terminal |
| FLY-1591 | 07:52 | `creates_pr=True can_ship=True can_land=True route=needs_review` | THROW |
| **FLY-1597(本 run)** | 22:14 | `creates_pr=True can_ship=True can_land=True route=needs_review` | THROW |

**切换点在 2026-08-01 03:29–07:52 UTC 之间**(Bridge 加载了含 #748 的 dist)。之后起跑的每个 generic run 都进不了自己的 gate。

### 1.5 行为面印证:gate 建没建 / run 收没收工

```sql
SELECT template_id, template_revision, status, COUNT(*), MIN(created_at), MAX(created_at)
FROM workflow_run GROUP BY 1,2,3 ORDER BY 5 DESC;
```

| template | rev | status | n | 最近 |
|---|---|---|---|---|
| (无模板) | | active | 19 | 2026-08-01 22:32 |
| tpl_generic_menu | 3 | **active** | 8 | 2026-08-01 22:14 |
| tpl_code | 3 | active | 2 | 2026-08-01 03:55 |
| tpl_code | 3 | canceled | 2 | 2026-08-01 00:27 |
| (无模板) | | **completed** | **2** | **2026-07-27 13:46** |

* **全库最近一次 run 走到 `completed` 是 2026-07-27** —— 5 天前,而且那两个是无模板 run。
* **`tpl_generic_menu` 历史上从未有一个 run `completed`**(rev1 全 `terminated`,rev3 全 `active`)。
* 切换点之后起跑的 3 个 run(FLY-1590 / 1591 / 1597)在 `workflow_gate_holder` 里**没有任何 gate 行**;切换点之前的 5 个(1578/1579/1580/1581/1587)都有 gate。⇒ 抛异常的直接后果就是 gate 建不出来。
* FLY-1590 / FLY-1591 的 PR(#750 / #749)**确实合并了** —— 但那是走 DAG 之外的人工合并;它们的 run 至今停在 `node=execute / status=active`。

### 1.6 引擎自己也知道,只是喊不出来

`lead_events` seq 61700,`event_type=workflow_engine_escalation`,severity `severe`:

```json
{ "title": "Workflow liveness is unknown for FLY-1590",
  "body": "Run 730b2992… node execute has a terminal session without a completion receipt,
           but process liveness remained unknown for three probes. The engine kept the node unchanged.",
  "metadata": { "workflowEngine": { "runId":"730b2992…", "issueId":"FLY-1590",
                 "nodeId":"execute", "disposition":"probe_unknown" } } }
```

Lead 实际收到的全文(`comm.db` `lead_inbox`,`source='lead_event:61700'`):

```
[Event #61700] undefined
ID: — | Issue: —
Timestamp: 2026-08-01T16:00:27.000Z | Session Key: wf:730b2992-9067-4938-87e2-625bbf10f5a2
```

标题、正文、severity、issue 号、disposition —— **全部丢失**。原因见 Q2 §2.3。

### 1.7 CI 绿 ≠ 护栏有效(#748 引用的那道门)

```
$ node scripts/verify-workflow-seeds.mjs
✅ tpl_generic.yaml         PASS  generic → gate
✅ tpl_product_v1.yaml      PASS  generic → generic → review → gate
ALL SEEDS PASS — 12 seed files
```

同一份 manifest(seed yaml 与库里 published revision 的 `ship_claims` 逐字一致,均为 `[founder_approved]`),运行时解析器抛 `incoherent_ship_bundle`。**种子校验器根本不调用 `resolveWorkflowGateAuthority()`。**

### 1.8 僵尸 gate

```sql
SELECT state, COUNT(*), MIN(created_at), MAX(created_at) FROM workflow_gate_holder GROUP BY state;
```

| state | n | 最老 | 最新 |
|---|---|---|---|
| awaiting_review | 15 | 2026-07-24T07:02Z | 2026-08-01T08:58Z |
| materializing | 2 | 2026-07-25T17:43Z | 2026-07-25T18:15Z |
| superseded | 1 | | |

**17 个活 gate,最老 8 天,零个 approved。** 另外 `tpl_generic_menu` 的 5 个 gate 共用同一个
`head_sha=fcd3640f612be216`,而它**不是 git 对象**(`git log fcd3640f` → unknown revision)——
它等于该 run 的 `snapshot_digest`。即 gate 绑的是快照摘要而不是 PR head,`subject_kind=snapshot_digest /
authority_mode=engine_terminal`。这与 §1.2 的裁定一致:承运型 bundle 不允许 `snapshot_digest`,
所以这批 gate 即便被批准也接不上 `runner_ship`。

---

## Q2 — runner → lead 消息到底修好没

### 2.1 好消息:消息真的被回了,而且很快(有对照)

审计过程中我自己发的那条事故上报,全链有账:

| 环节 | 证据 |
|---|---|
| CLI 输出 | `lead inbox nudge failed: This operation was aborted; durable queue row retained` + 返回 id `a0ea3215` |
| `messages` | `a0ea3215` type=question created `22:32:29`,`delivered_at=NULL` |
| `lead_events` | seq **61764** `runner_question` → `delivered_at 2026-08-01 22:32:30` |
| `lead_inbox` | seq **45048** source=`question:61764` → `delivered_at 2026-08-01T22:32:30.961Z` |
| Lead 回话 | `messages` 37b80798,parent=`a0ea3215`,`22:40:23` |

**写入 → 抵达 1.9 秒;Lead 8 分钟后回话。** CLI 那句 `nudge failed` 是装饰性的 —— 持久路径成功了。

⚠️ 顺带纠正一个容易踩的读数:**`messages.delivered_at` 不是 runner→lead 方向的抵达指标**(该方向恒为 NULL,记账在 `lead_inbox` 侧)。只看它会得出「87 条 report 全没送到」的错误结论。

### 2.2 坏消息:FLY-161 设计的中继 24 小时只响了 2 次

`ask --report` 的契约(`packages/flywheel-comm/src/commands/ask.ts` 注释,逐字):

> The Lead still receives it via the normal `runner_question` relay; the ONLY difference is that the
> founder reply deliverer excludes it from its binding candidate set.

实测(近 24h):

```sql
-- 写入侧
SELECT kind, COUNT(*) FROM messages WHERE type='question' AND created_at>=datetime('now','-20 hours') GROUP BY kind;
   (NULL)  22
   report  80
-- 中继侧
SELECT seq, lead_id, created_at FROM lead_events WHERE event_type='runner_question' AND created_at>=datetime('now','-24 hours');
   61764  flywheel-eng-lead    2026-08-01 22:32:30
   61695  tidal-echo-cos-lead  2026-08-01 15:58:36
```

**102 条 runner→lead 消息,中继事件 2 条(约 2%)。**

但 Lead **确实答了**其中大部分 —— 说明存在另一条不留 `lead_events` / `lead_inbox` 痕迹的兜底路径:

| Lead 回复 | 对应 question | kind | 该 question 有 lead_inbox 行? | 延迟 |
|---|---|---|---|---|
| 22:40:23 | a0ea3215 | — | **1** | 8 min |
| 14:11:46 | 7b5ca081 | — | 0 | 27 min |
| 13:38:48 | d159c50e | report | 0 | 18 min |
| 13:20:03 | 932cda7c | report | 0 | 11 min |
| 12:37:13 | a154f988 | report | 0 | 6 min |
| 12:21:35 | c76f457d | report | 0 | 15 min |
| 12:06:11 | ed211bd9 | report | 0 | 11 min |
| 11:50:55 | 203274a6 | report | 0 | 7 min |

⇒ **走中继:约 2 秒抵达。走兜底:6–27 分钟,且引擎侧完全没有可观测记录。**

兜底路径具体是什么,本审计**没有查清**(不在本单授权的修复范围,也不宜靠猜)。这是一个必须单独立单查的口子:目前没有任何账本能回答「这条 runner 消息 Lead 到底看没看到」。

### 2.3 `[Event #N] undefined` — 根因已定位,影响面已量化

**根因:payload 形态两分,渲染器只认其中一种。**

渲染器(`bridge/mailbox-lead-runtime.ts:336`、`commdb-lead-runtime.ts:207`、`hook-payload.ts:294`,三处同款):

```ts
`[Event #${env.seq}] ${roleLabel}${e.event_type}`
```

而生产者写了两种 payload:

| 形态 | 字段 | 渲染结果 |
|---|---|---|
| session 类 | `{"event_type":"session_monitoring_lost", "execution_id":…, "issue_identifier":…}` | ✅ 正常 |
| alert 类 | `{"leadId":…, "eventId":…, "eventType":"workflow_engine_escalation", "title":…, "body":…}` | ❌ `undefined` |

带阳性对照的实测(同一条 SQL,同时取到会正常和不会正常的行):

| seq | `lead_events.event_type` 列 | `payload.event_type` | `payload.eventType` | 渲染 |
|---|---|---|---|---|
| 61695 | runner_question | runner_question | — | `[Event #61695] runner_question` |
| 61705 | detection_escalation | detection_escalation | — | ✅ |
| 61706 | session_monitoring_lost | session_monitoring_lost | — | ✅ |
| 61699 | workflow_engine_escalation | **None** | workflow_engine_escalation | **`[Event #61699] undefined`** |
| 61701 | external_merge_suspect | **None** | external_merge_suspect | **`undefined`** |

**影响面(全库):**

```sql
SELECT CASE WHEN json_extract(payload,'$.event_type') IS NULL
            THEN 'MISSING' ELSE 'has' END, COUNT(*), SUM(delivered_at IS NOT NULL)
FROM lead_events GROUP BY 1;
```

| payload 形态 | 事件数 | 其中已投递 |
|---|---|---|
| 缺 `event_type` ⇒ 渲染 undefined | **14 228** | **13 935** |
| 有 `event_type` | 47 540 | 45 143 |

**抵达面复核**(不是推理,是查 Lead 真正收到的文本):

```sql
SELECT COUNT(*), SUM(content LIKE '%] undefined%'),
       SUM(content LIKE '%] undefined%' AND delivered_at IS NOT NULL) FROM lead_inbox;
   44948 | 6154 | 6072
```

**6 072 条真正投进 Lead 收件箱的消息,正文只有 `[Event #N] undefined` + `ID: — | Issue: —`。**
最近一条发生在审计当天 22:30:44 UTC(即审计前 12 分钟),说明**仍在发生**。

受影响的事件类型(按已投递数排序,即「Lead 真收到但看不懂」的量):

| 事件类型 | 已投递却是 undefined |
|---|---|
| detection_page_undeliverable | 8 487 |
| pane_hash_stuck | 2 165 |
| workflow_engine_escalation | 1 185 |
| rate_limit | 591 |
| auto_qa_stuck | 583 |
| zombie_session_backlog | 108 |
| codex_gate_blocked | 83 |
| runner_stuck_unhandled | 81 |
| external_merge_suspect | 62 |
| three_stage_stuck | 41 |
| bridge_abnormal_exit | 31 |
| founder_action_needed | 31 |
| usage_limit | 24 |
| inbox_loop_stalled | 16 |

**几乎每一类真正要人处理的告警都在这张表里。**

### 2.4 守卫事件的静默丢弃(0 次尝试、0 错误)

`GUARDRAIL_EVENT_TYPES`(`bridge/lead-runtime.ts:18`)是「必须可靠送达」的白名单。近 24h 未送达的守卫事件:

```
61677  flywheel-eng-lead  detection_escalation     2026-08-01 09:24:18  attempts=0  last_error=<null>
61675  flywheel-eng-lead  detection_escalation     2026-08-01 09:06:45  attempts=0  last_error=<null>
61635  flywheel-eng-lead  session_monitoring_lost  2026-08-01 07:12:08  attempts=0  last_error=<null>
61634  sub-lead           session_monitoring_lost  2026-08-01 07:12:08  attempts=0  last_error=<null>
…(共 40+ 条,全部 attempts=0 / last_error=NULL)
```

**每一条都是 `delivery_attempts = 0` 且 `last_delivery_error = NULL`** —— 不是「试了送不到」,是**根本没试过,而且没留任何痕迹**。

对应代码 `HeartbeatService.ts:2984`:

```ts
const runtime = this.registry.getForLead(leadId);
if (!runtime) continue;          // ← 静默跳过:不计 attempt,不记 error
```

后果:FLY-83 那套「靠 `last_error` 非空来发现卡住」的告警**永远看不到这一类丢失**。

### 2.5 僵尸 session 仍在持续产噪

```sql
SELECT status, COUNT(*) FROM sessions GROUP BY status;
```

`completed 1013 / terminated 474 / failed 158 / blocked 155 / awaiting_review 15 / running 2 / approved_to_ship 1 …`

`awaiting_review` 15 条,最老 **2026-04-14**(3.5 个月):

| exec | issue | 项目 | 进入时间 | PR |
|---|---|---|---|---|
| 02459bb0 | GEO-360 | geoforge3d | 2026-04-14 | 186 |
| 48f559f2 | GEO-351 | geoforge3d | 2026-05-07 | 207 |
| … | | | | |
| 060d6ca9 | LEARN-123 | tidal-echo | 2026-07-14 | 26 |
| 65e81f76 | FLY-1518 | flywheel | 2026-07-28 | 722 |

这些不是静态账面:`060d6ca9`(7-14 的僵尸)在**审计当天**还在产 `runner_question`(seq 61695)和
`detection_escalation`(seq 61705);`65e81f76` 在 22:31 还在产 `session_monitoring_lost`。
⇒ **僵尸 session 是当前告警噪音的活跃来源之一。**

---

## Q3 — 其余在真坏的

### 3.A 【进行中】tmux 抢救忙循环风暴 —— 10 个 Lead 同时自旋

**症状链:**

```
$ uptime           → load averages: 9.89 10.76 9.99   (15:22)  → 17.24 16.28 14.07 (15:41)
$ pgrep -f tmux-server-rescue.sh | wc -l   → 8–12 常驻
$ 10 秒内全机 PID 分配量                    → 6 544 个 (≈654 PID/s)
```

**抢救审计日志(`~/.flywheel/logs/tmux-rescue-audit.log`,190 MB 且在长)每一条都长这样:**

```
token=… acquiredAt=… holdSec=0.49 verb=recover caller=_wait_tmux_window rc=0 shouldAlert=0 episode=30
```

* `rc=0` —— 每次抢救都**成功**(所以不是真故障)
* `caller=_wait_tmux_window` —— 全部来自同一个调用点
* `shouldAlert=0` —— **没有任何人被告知**
* 速率:`126–137 次/分`,持续。日志增长 ≈1 MB/小时、132 行/分。
* 起点:**2026-08-01 14:56:54 PDT**(cmux 在 14:38–14:39 重建 grouped session 之后 ~18 分钟)

**12 秒采样,自旋的 Lead(观测到正在 fork 的次数):**

```
tidal-echo-cos-lead 19 | flywheel-cos-lead 18 | flywheel-product-lead 17 | belle-lead 16
ops-lead 14 | joycon-lead 13 | cos-lead 13 | reflection-lead 11 | product-lead 10 | tidal-echo-content-lead 9
```

未自旋:`flywheel-eng-lead` / `claude-infra-bot-lead` / `rafiki-lead` / `sub-lead`。

**代码定位** —— `packages/teamlead/scripts/claude-lead.sh` `_wait_tmux_window()`:

```bash
if _tmux_target_matches_archive "$target" false; then
    …
    interruptible_sleep 3      # ← 健康分支:有退避
    continue
fi
…
if recovery="$(tmux_socket_recover "$(_tmux_socket_path)")"; then   # ← 每轮 fork lockf+rescue
    if … [ "$recovered_pid" = "$TMUX_ARCHIVE_SERVER_PID" ]; then
        if _tmux list-panes -t "$target" >/dev/null 2>"$probe_err"; then
            rm -f "$probe_err"
            continue           # ← 异常分支:没有 sleep,直接下一轮
```

⇒ 只要落进「归档匹配失败 + 抢救成功 + 窗口探针成功」这个三元组合,就是**零退避无限循环**。
全局抢救锁每次持有 ~0.5 s,吞吐被锁限到 ~2 次/秒,其余 9 个 Lead 在 `lockf -t 5` 上排队 —— 这就是每秒 650 次 fork 的来源。

**尚未定死的一环(诚实标注):** 我把三条守卫逐条在同一台机上跑了一遍,**全部通过**:

```
archive: srv=13269 pane=19396 win=@6 start=[Sat Aug  1 10:45:33 2026]
live start identity                     → 完全一致 (MATCH)
tmux_supervisor_archived_process_alive  → rc=0
tmux list-panes -t @6                   → 19396  (与归档一致)
tmux_socket_inspect                     → {"verdict":"reachable","reachablePid":13269}
```

即**从外部看归档是匹配的**,所以真正失配的只能是 Lead 进程内存里的 `LEAD_WINDOW_ID` 与归档文件里的 `window_id` 不一致(例如为空 —— `tmux list-panes -t ""` 会命中「当前窗口」从而探针成功)。这一点**没有直接证据**,只有排除法推断,必须在修复单里实测确认。

**但缺陷本身不依赖这个推断成立**:一条会重试的路径没有退避,就是缺陷。

### 3.B 【进行中】Bridge 崩溃循环 + 自动重启被 held

审计期间 Bridge 的状态变化:

| 时刻 (PDT) | 观测 |
|---|---|
| 15:18 | `:9876` LISTEN(PID 78357),`/health` 12.0 s |
| 15:41 | **无 listener**;`launchctl` → `1878  143  com.flywheel.bridge`(143 = SIGTERM);日志停在 `RunInfra` 启动阶段 |

持久痕迹:

```
~/.flywheel/meta-alert/bridge_crash_loop.txt
  [2026-08-01T21:32:10Z] flywheel-bridge-wrapper.sh started >= 3 times within 60s (port :9876)
~/.flywheel/meta-alert/restart_storm_bridge.txt
  [2026-08-01T17:47:39Z] bridge crashed 6 times since 17:45:10Z; automatic restart is HELD.
                          Inspect the service, then run restart-storm-gate.py resume bridge.
```

`lead_events` 近 24h:`bridge_abnormal_exit` **7 条,0 条送达**(lead_id=`bridge`,一个没有消费者的伪 lead)。

### 3.C 【已死】2 个 Codex Lead 启动即崩,共 205 次

```
$ launchctl list | grep -E "exit=1|	1	"
   -	1	com.flywheel.lead.growth-mufasa-lead
   -	1	com.flywheel.v2-scheduler
   -	1	com.flywheel.lead.flywheel-codex-infra-bot-lead
```

Mufasa 与 codex-infra-bot **同一个根因**:

```
[codex-lead-tui-runtime] fatal: Error: codex-lead-runtime: missing required env: FLYWHEEL_COMM_DB
    at parseCodexLeadRuntimeConfig (…/codex-lead-runtime.js:316:15)
```

* 两份日志里 `missing required env` 各出现 **205 次**,采样期内不再增长 ⇒ launchd 已放弃重启,**两个 Lead 现在是死的**。
* Mufasa = Annie 的成长陪练 Lead(FLY-350 上线),**当前完全不在线**。

`v2-scheduler` 是另一回事,不是崩溃是长期 partial:

```
{"status":"partial","candidates":1,"restarted":0,"held":1,"failed":0,"memoryLimited":0}   × 每轮
```

一个候选**永久 held**,从不重启,退出码非零。

### 3.D 【单点】Tadashi(flywheel-eng-lead)跑在监管之外

```
$ pgrep -fl "claude-lead.sh flywheel-eng-lead"    → 空
$ launchctl list | grep flywheel-flywheel-eng-lead → -	0	com.flywheel.lead.flywheel-flywheel-eng-lead
$ ps -p 56623                                      → claude --agent flywheel-eng-lead … (etime 4:38)
```

Tadashi 的 `claude` 进程活着,但**既没有 `claude-lead.sh` 监管者,launchd 也没在跑它**。
它死了不会有人拉起来。(副作用:这也是它没有卷进 §3.A 自旋的原因。)

### 3.E 告警死信 2 372 条,其中 2 049 条是被队列**丢掉**的

```
$ ls ~/.flywheel/alert-deadletter | wc -l    → 2372
   2043  lead-detection_page_undeliverable
    120  bridge_abnormal_exit
     85  infra-bot-lead-notify_digest_failed
     24  lead-pane_hash_stuck
      …
$ ls ~/.flywheel/alert-deadletter | grep detection_page_undeliverable | cut -c1-10 | sort | uniq -c
      3  2026-07-15
   2049  queue-cap-        ← 文件名前缀 = 队列满被丢弃,不是投递失败
```

`~/.flywheel/meta-alert/queue_overflow.txt`:`The alert queue holds 501 entries (> 500).`

而且这些告警的 `eventId` 是**自我嵌套**的:

```
detection-page-undeliverable:…:receipt_unprocessed:lead_event:product-lead:
detection-page-undeliverable:…:receipt_unprocessed:lead_event:product-lead:78bedb45…
```

⇒ 「投不出去」这件事本身又生成一条告警,再投不出去,再生成 —— **自放大回声环**(与 FLY-220 同族)。
配套的 `alert_unreachable_config.txt` 说明 `product-lead` 根本没配告警频道,所以这个环永远收不了口。

### 3.F 邮箱积压

`~/.flywheel/meta-alert/mailbox_overflow.txt`(2026-08-01 15:32 PDT,即审计中):

```
product-lead/runner-e1(unread=8216), flywheel-eng-lead/runner-7a122951(unread=265),
product-lead/runner-10234bab(unread=1260), product-lead/runner-e-nf(unread=684),
product-lead/runner-exec-e2e(unread=657), test-lead/runner-exec-lc(unread=659)
```

### 3.G `audit.db` 索引真损坏(不是「未使用页」那么轻)

```
$ sqlite3 audit.db "PRAGMA integrity_check;"
*** in database main ***
Page 47..61: never used                     (15 行泄漏页)
wrong # of entries in index idx_fca_comm_question
wrong # of entries in index idx_fca_ts
wrong # of entries in index idx_fca_project_lead
wrong # of entries in index idx_fca_action_decision
wrong # of entries in index idx_fca_lead
```

表仍可读(仪器验证:`audit_entries` 496 行 / `fleet_admin_audit` 26 / `founder_consent_audit` 155),
**但 5 个损坏索引全部挂在 `founder_consent_audit` 上** —— 那正是 FLY-175 Track 3 的校准语料库。
走索引的查询可能**静默漏行**。

### 3.H `teamlead.db` 2.01 GB 里 88% 是空洞

```
page_size=4096  page_count=490418  freelist=432058
⇒ 文件 2.01 GB / 空闲页 1.77 GB (88.1%) / 实际数据 239 MB
```

`dbstat` 实际占用 Top:`lead_events 88 MB`、`session_events 56 MB`、其余均 < 10 MB。
⇒ 不是数据多,是**从没 VACUUM 过**。(止血单 FLY-1595 已建。)

### 3.I FLY-1594(models.json)—— 未复跑,仅静态记录

`packages/config/src/model-config.ts:129`:

```ts
path: override || join(homedir(), ".flywheel", "models.json")
```

默认落到操作员 HOME;本机 `~/.claude/models.json` 不存在。我**没有**重跑 config 套件去复现
FLY-1594(load 17 下跑测试结果不可信,且该单已立)。此处只记录默认路径事实,不下裁定。

---

## 附:全部复现命令

```bash
# Q1 模板级
node <scratch>/probe-gate.mjs                       # 见 §1.2(需 canonicalRoot)
node scripts/verify-workflow-seeds.mjs              # 见 §1.7
git show 2ed08e54^:packages/config/src/node-type-registry.ts | grep -A6 'generic: {'

# Q1 运行级
node <scratch>/probe-live-runs.mjs                  # 见 §1.4(parseWorkflowRunSnapshot 收字符串!)
sqlite3 ~/.flywheel/teamlead.db \
  "SELECT template_id,status,COUNT(*) FROM workflow_run GROUP BY 1,2;"
sqlite3 ~/.flywheel/teamlead.db \
  "SELECT state,COUNT(*),MIN(created_at) FROM workflow_gate_holder GROUP BY state;"

# Q2
sqlite3 ~/.flywheel/teamlead.db "SELECT CASE WHEN json_extract(payload,'\$.event_type') IS NULL
  THEN 'MISSING' ELSE 'has' END,COUNT(*),SUM(delivered_at IS NOT NULL) FROM lead_events GROUP BY 1;"
sqlite3 ~/.flywheel/comm/flywheel/comm.db "SELECT COUNT(*),SUM(content LIKE '%] undefined%'),
  SUM(content LIKE '%] undefined%' AND delivered_at IS NOT NULL) FROM lead_inbox;"
sqlite3 ~/.flywheel/teamlead.db "SELECT seq,lead_id,event_type,delivery_attempts,last_delivery_error
  FROM lead_events WHERE delivered_at IS NULL AND created_at>=datetime('now','-24 hours');"

# Q3
tail -3 ~/.flywheel/logs/tmux-rescue-audit.log      # verb=recover caller=_wait_tmux_window rc=0
pgrep -f tmux-server-rescue.sh | wc -l ; uptime
launchctl list | grep -E "flywheel|mufasa"
tail -8 /tmp/flywheel-lead-growth-mufasa-lead.log
ls ~/.flywheel/alert-deadletter | wc -l
sqlite3 ~/.flywheel/audit.db "PRAGMA integrity_check;"
sqlite3 ~/.flywheel/teamlead.db "PRAGMA page_count; PRAGMA freelist_count;"
```

---

# 附录 A — Tadashi 三条补充审计项(2026-08-01 追加)

审计中途收到 Lead 三条补充检查项。全部独立复跑,**其中一条结论与来源不一致**。

## A1 [6a7d4269] 僵尸 session × GitHub 合并状态 —— 独立复跑,结论与 Cass 不同

指令明确要求「独立复跑再引用 —— 单次观测不构成结论,哪怕来源可信」。照做了,结论确实不一样。

**我的查询(比 Cass 的多一条:她的 `pr_number IS NOT NULL` 会漏掉无 PR 的):**

```sql
SELECT issue_identifier, project_name, status, pr_number FROM sessions
WHERE status IN ('awaiting_review','approved_to_ship');
```
→ 16 行(15 有 PR + `LEARN-214` 无 PR)。

**逐个 `gh pr view` 核 GitHub 真实状态。**

⚠️ **PR 号是 repo 作用域的** —— 在 flywheel checkout 里裸跑 `gh pr view 103` 查到的是
`xrliAnnie/flywheel#103`,不是 `xrliAnnie/sub#103`。所以每一次查询都显式带了 `--repo`,
repo 由项目名解析(`git -C <项目目录> remote get-url origin`):

| project_name | 解析到的 repo |
|---|---|
| flywheel | `xrliAnnie/flywheel` |
| geoforge3d | `xrliAnnie/GeoForge3D` |
| joycon-typeless | `xrliAnnie/joycon-typeless` |
| sub | `xrliAnnie/sub` |
| tidal-echo | `xrliAnnie/tidal-echo` |

(Lead 独立复核过这一点:`xrliAnnie/flywheel#103`/`#105` 是完全不同的两个 PR,标题不同且无
merge commit,与本表列出的 merge sha 不符 ⇒ 确认本表解析到的是正确的仓库。)

| issue | repo | PR | state | mergedAt |
|---|---|---|---|---|
| FLY-1518 | flywheel | 722 | **MERGED** | 2026-07-28T23:31:35Z |
| GEO-360 | GeoForge3D | 186 | **MERGED** | 2026-04-14T00:48:08Z |
| GEO-351 | GeoForge3D | 207 | CLOSED | — |
| GEO-375 | GeoForge3D | 225 | **OPEN** | — |
| GEO-418 | GeoForge3D | 257 | CLOSED | — |
| GEO-430 | GeoForge3D | 265 | **OPEN** | — |
| LEARN-204 | joycon-typeless | 45 | **MERGED** | 2026-07-05T06:04:54Z |
| LEARN-136 | sub | 82 | **MERGED** | 2026-07-03T23:09:24Z |
| LEARN-80 | sub | 85 | CLOSED | — |
| LEARN-157 | sub | 103 | **MERGED** | 2026-07-04T05:18:36Z |
| LEARN-158 | sub | 105 | **MERGED** | 2026-07-02T01:53:14Z |
| LEARN-160 | sub | 108 | **MERGED** | 2026-07-02T02:00:57Z |
| LEARN-123 | sub | 120 (`approved_to_ship`) | **MERGED** | 2026-07-04T00:25:34Z |
| LEARN-80 | tidal-echo | 25 | **OPEN** | — |
| LEARN-123 | tidal-echo | 26 | **OPEN** | — |
| LEARN-214 | joycon-typeless | (无 PR) | — | — |

**分类:**

| 类别 | n | 明细 |
|---|---|---|
| PR 已 MERGED 却仍挂 awaiting_review ⇒ **真僵尸** | **8** | FLY-1518, GEO-360, LEARN-204, LEARN-136, LEARN-157, LEARN-158, LEARN-160, LEARN-123(sub) |
| PR 已 CLOSED(未合并)⇒ 也不会再被评审,**同属僵尸** | 3 | GEO-351, GEO-418, LEARN-80(sub) |
| PR **OPEN** ⇒ 确实还在等 | 4 | GEO-375, GEO-430, LEARN-80(tidal-echo), LEARN-123(tidal-echo) |
| 无 PR | 1 | LEARN-214 |

**与 Cass 的差异(逐条,不是质疑她的方法,是复跑的意义所在):**

| 项 | Cass | 本次实测 |
|---|---|---|
| 「只有 LEARN-157 / LEARN-158 是真的在等」 | 说这两个 PR **OPEN** | 两个都 **MERGED**(#103 merge commit `ff0c51a76810` @ 07-04;#105 `f7345b725a4b` @ 07-02)——**它们恰恰是僵尸** |
| 真的在等的是哪几个 | (未列) | GEO-375 #225 / GEO-430 #265 / tidal-echo #25 / tidal-echo #26,共 4 个 |
| 僵尸数 | 13 | 11(8 MERGED + 3 CLOSED),另 1 个无 PR 待定 |
| 最老 | 「3 月 16」 | 最老 `awaiting_review` session 起于 **2026-04-14**(GEO-360) |

⇒ **两次观测的分类正好相反。** 这条本身就是「单次观测不构成结论」的最好例证。

⚠️ 遵守指令:**只检测,不清理,不改任何状态**(含 FLY-1518)。

## A2 [395e742b] 重复投递 —— 收件侧 7 份,发件侧账本显示只发了 1 份

Lead 报告:`stage_changed` seq 61745/61746/61747 **每条被投递到他手里 7 次**(接收端实测)。

我查发件侧的两本账:

```sql
SELECT seq, delivery_attempts, delivered_at, last_delivery_error
FROM lead_events WHERE seq IN (61745,61746,61747);
   61745 | 0 | 2026-08-01 22:27:21 | NULL
   61746 | 0 | 2026-08-01 22:27:21 | NULL
   61747 | 0 | 2026-08-01 22:27:21 | NULL

SELECT * FROM lead_event_delivery_attempts WHERE event_seq IN (61745,61746,61747);
   (0 行)
```

仪器验证:`lead_event_delivery_attempts` 全表 **1463 行**,不是空表 —— 所以「0 行」是真的没记,不是表没在用。

收件队列侧(`comm.db` `lead_inbox`):

| source | 行数 | delivered_rounds | created → delivered |
|---|---|---|---|
| lead_event:61745 | **1** | 0 | 22:17:42.228Z → 22:27:21.824Z |
| lead_event:61746 | **1** | 0 | 22:17:48.726Z → 22:27:21.824Z |
| lead_event:61747 | **1** | 0 | 22:18:00.379Z → 22:27:21.824Z |

**三本账全部显示「写一次、排一次、投一次、零重试」。**

⇒ **如果接收端确实收到 7 份,那么重复发生在 `lead_inbox` 之下游(注入 Lead 面板/邮箱那一段),并且不留任何持久痕迹。**

诚实边界:我**没有独立观测到 Lead 面板上的那 7 份**(我看不到他的 pane),Lead 的 7 次是他的接收端观测。
我能独立证明的是发件侧三本账都记着「1 次」。两者结合的推论 —— **投递计数在最后一段是瞎的** ——
比「重投复制新行」更严重:**重投连行都不复制,它对账本完全不可见。**

另注:**created → delivered 之间隔了 9 分 39 秒**(22:17:42 → 22:27:21),与 Bridge 当时的拥塞吻合。
Lead 的假说(等确认超时 → 判未送达 → 重发)与这个时延一致,但账本没有任何 `ack_timeout` 记录来佐证,
所以**假说成立与否本审计无法判定**,需要在注入层加痕迹才能查。

⇒ 这是 messaging-rework(1570–1576)必须处理的活体样本,已写进 plan.md P1-4。

## A3 [6079dca3] session_events 写入速率 —— 数字对得上,但含义不是「表很大」

> 🔴 **本节含一条已被推翻的结论,保留原文并就地标注。**
>
> 本节初稿写于 2026-08-01 22:5x UTC。事后 Lead 告知一个**我在测量时不知道的未受控变量**:
> **他在 22:37–22:40 UTC 手工删除了 3 545 369 行 `issue_thread_infra_notify_skipped`**
> (founder 批准的应急清理,25 批 × 15 万,删前做了 1.9 G 在线备份,`quick_check ok`)。
> 他发过一条告知消息,但走的是 `chat-threads/send`,502 死掉了,没有经我能收到的信道补发。
>
> **我所有的「保留行 / 保留率」读数都取自这次删除之后**,所以:
>
> | 原结论 | 裁定 | 依据 |
> |---|---|---|
> | 「写进去的 99.9% 立刻被删 ⇒ 写放大」 | ❌ **不成立** | Lead 22:25 实测清理前表里 3 670 980 行,目标行 3 545 317 行**全部还在**。它们不是写完即删,是**积累到当晚被一次删掉** |
> | 「88% 空洞是长期 churn 堆出来的」 | ❌ **不成立** | 空洞是那次删除的直接脚印 |
> | 「每天 id 号段消耗」方法本身 | ✅ **成立** | 与 Lead 清理前的独立实测互证,误差 < 千分之二 |
> | 「07-30 起约 25 倍阶跃」 | ✅ **成立且不受污染** | id 号段是历史性的,删行不回收 id |
> | 「与 Bridge 慢无因果」 | ✅ **成立** | 时间窗隔 5 小时 + 当场写入 0.2 次/秒 |
>
> ⇒ **真正的线索是那个 07-30 阶跃,不是「写放大」。** 而且它比之前定位的 07-31 洪水起点早一天。
> 后续复测见附录 B §B.3。
>
> **方法论教训(双向)**:测量对象被运维动过手,测量者必须被告知;告知信道 502 时必须换一条补发。
> 这条已由 Lead 认领。对我这边的教训是:**一份「当前状态」快照无法自证它没被人动过** ——
> 涉及「写了多少 / 留了多少」的结论,应当同时取一个不受删除影响的量(如 id 号段),
> 而我确实取了,这也是为什么阶跃那条活了下来。

**独立复核 Lead 给的「367 万行」:**

```
当前行数                      : 128 736
AUTOINCREMENT 高水位(累计插入): 3 674 217
id 范围                       : 1 … 3 674 217
时间跨度                      : 2026-04-07 → 2026-08-01
```

⇒ **367 万是「历史累计插入」,不是「当前行数」。当前只有 12.9 万行 —— 也就是说约 354 万行被写进去又删掉了。**
这正好解释 §3.H 的 88% 空洞:**海量写 + 海量删 + 从不 VACUUM。**

**独立测「每天真实插入量」** —— 不用任何人的 delta,用 id 号段消耗量(每天 min_id/max_id):

| 日期 | 保留行 | 号段消耗(= 真实插入) | 保留率 |
|---|---|---|---|
| 07-27 | 957 | 38 352 | 2.5% |
| 07-28 | 1 955 | 41 362 | 4.7% |
| 07-29 | 852 | 14 044 | 6.1% |
| **07-31** | 347 | **956 401** | **0.04%** |
| **08-01** | 1 392 | **937 995** | **0.15%** |

⇒ **Lead 的两个日增数字(956 401 / 936 713)被独立复现,误差 <0.2%。**
但同时暴露两件他那个口径看不到的事:

1. **这是一次阶跃,不是渐涨** —— 07-27/28/29 还是 1.4–4 万/天,**07-30/31 直接跳到 ~95 万/天,约 25 倍**。
2. **写进去的 99.85–99.96% 立刻被删** —— 病不在「表大」,在「写放大」。

**burst 的时间分布(用保留行当 id↔时间标尺):**

| UTC 小时 | 该小时消耗 id |
|---|---|
| 00:00–13:00 | 每小时 29k–55k(≈12–15 次插入/秒,持续) |
| 14:00–17:00 | 33k → 16k(开始衰减) |
| 18:00–20:00 | **无保留行**(Bridge 崩溃循环窗口,`restart_storm` 17:47Z) |
| 21:00 | 13 444 |
| 22:00 | **2 101** |

**当前实测速率(72 秒窗口,直接读 `sqlite_sequence`):**

```
15:53:46 seq=3674223  →  15:54:58 seq=3674234
= 11 个 id / 72 秒 = 0.2 次插入/秒 ≈ 13k 行/天
```

⇒ **风暴已经停了**,当前速率回到 13k/天量级。

**谁在刷(近 3 天保留行的 event_type,只能看到「活下来的」那部分):**

| event_type | source | n |
|---|---|---|
| worktree_reconcile_skip | bridge.worktree-reconciler | 384 |
| lifecycle_sweep_worktree_skip | bridge.lifecycle-sweep | 382 |
| founder_reply_read_failed | bridge.founder-reply-deliverer | 295 |
| issue_thread_infra_notify_skipped | bridge.founder-thread-notifier | 196 |
| runner_recovery_nudge | bridge.stuck-remanage | 91 |

全是 Bridge 扫描器的「跳过/失败」记录 —— 形态上正是「每轮扫描 × 每个 worktree 各写一行」这种会
线性放大的东西。**但保留行只占 0.15%,所以这张表不能证明 burst 的成分**,只能说明形态可疑。
要定死是谁,需要在保留策略之外抓一次现场。

**回答 Lead 的第 3 问「与 Bridge 7–12 秒有没有因果」——** 时间线不支持:

* 写风暴的高峰在 **00:00–17:00 UTC**;
* Bridge 慢是在 **22:18–22:48 UTC** 测到的(7 → 12 → 19 秒),**风暴结束 5 小时之后**;
* 同一时段(22:xx)写入速率只有 0.2 次/秒。

⇒ **当前的 Bridge 慢不是 session_events 写放大造成的。** 时间上贴合的是 tmux 抢救风暴(起于 21:56Z / 14:56 PDT,
至今未停,load 16–17)。写放大是**另一条独立的病**(它撑起了那 1.77 GB 空洞),两者需要分开处理。

清理归 FLY-1595;**本单只审不修。**

---

# 附录 B — 第二轮测量(2026-08-02 07:30–07:45 UTC / 01:30–01:45 MDT)

Lead 在第一轮之后做了两件会改变现场的事:① 跑了正规 `restart-services.sh` 全舰队重启;
② 合入了 tmux 自旋的 hotfix `5e4d45fb`(#753)。他要求复测「风暴中 vs 风暴后」。
复测结果与预期相反,并因此产出本审计最尖锐的一条运维结论。

## B.1 风暴没有停 —— 而且 Bridge 又掉了

| 量 | 第一轮 08-01 22:18–22:48 UTC(风暴中) | 第二轮 08-02 07:38–07:42 UTC(重启+hotfix 之后) |
|---|---|---|
| 控制组 listener | HTTP=200 **0.004 s** | HTTP=200 **0.004 s** |
| Bridge `/health` | 200 / **12.06 s**、200 / 7.09 s、200 / 19.25 s、200 / 4.57 s | **HTTP=000 × 3**,均在 **1–2 ms** 内返回 ⇒ 连接被拒 = **Bridge 不在** |
| load average | 9.89 → 17.24 | **12.61** |
| rescue 进程数 | 8–12 | **10** |
| 抢救速率 | 126–137 次/分 | **92 次/分**(60 s 实测:940 310 → 940 402 行) |
| `caller=` | `_wait_tmux_window` | **仍是 `_wait_tmux_window`** |

⇒ **重启 + hotfix 之后,自旋仍在,只是速率从 ~130 降到 ~92 次/分;Bridge 从「慢」变成「掉」。**

## B.2 根因:hotfix 合进了 origin/main,但**没有上线**

```
$ git -C /Users/xiaorongli/Dev/flywheel fetch origin main
$ git rev-parse --short origin/main   → 5e4d45fb
$ git rev-parse --short main          → 51b2a64b      ← 生产 checkout 停在旧 commit
$ git rev-parse --short HEAD          → 51b2a64b
$ git status --short                  → (空,工作树干净,可直接 fast-forward)

$ git log --oneline -1 5e4d45fb
  5e4d45fb fix: add backoff to _wait_tmux_window recover-probe-success path (#753)
```

**同一段代码,两份内容:**

```bash
# origin/main(已修)
1981:        if _tmux list-panes -t "$target" >/dev/null 2>"$probe_err"; then
1982-          rm -f "$probe_err"
1983-          # FLY-1598: this recover-succeeded + probe-succeeded path had NO sleep.
1984-          # Under a legacy-grouped cmux topology the archive matcher at the loop
1985-          # top keeps failing while the probe here keeps succeeding, so this …

# 生产 checkout 实际文件(未修)
1981:        if _tmux list-panes -t "$target" >/dev/null 2>"$probe_err"; then
1982-          rm -f "$probe_err"
1983-          continue                                  ← 仍是裸 continue,没有退避
```

Lead 启动时读的就是这个本地工作树的 `claude-lead.sh`。

**时间线证明这不是「修复无效」,而是「修复没到现场」:**

| 时刻 | 事件 |
|---|---|
| 2026-08-01 16:04:58 -0700 | hotfix `5e4d45fb` 提交 |
| 2026-08-01 08:56:14 -0700 | 生产 checkout 本地 main 最后一次变动(**早于 hotfix 7 小时**) |
| 2026-08-02 01:40:50 MDT | 当前这批 `claude-lead.sh` 进程启动 |

⇒ **舰队确实在 hotfix 之后重启过,但重启时读的是一棵没有 `git pull` 过的树**,
所以重启没有把修复带上来。**merge ≠ 上线。**

已于 07:45 UTC 经 `flywheel-comm ask`(msg `9e1da003`)上报 Lead,建议顺序:
生产仓 `git pull` 到 5e4d45fb → 重启舰队 → 再量抢救速率是否归零。**本单只审不修,我没有执行。**

## B.3 session_events:阶跃的真实形状(去掉未受控变量之后)

```
当前行数      : 129 313        (第一轮 22:53 UTC 时是 128 736)
高水位        : 3 674 794      (第一轮是 3 674 234)
```

⇒ **8.7 小时只消耗了 560 个 id ≈ 64 个/小时 ≈ 1.5 k/天。**
对比 07-31 / 08-01 的 **~95 万/天** —— **洪水确实已经停了**,当前速率低了近三个数量级。

**那个被删光的 event_type 现在还在写吗?**

```sql
SELECT event_type, source, COUNT(*), MIN(ts), MAX(ts) FROM session_events
WHERE event_type='issue_thread_infra_notify_skipped' GROUP BY 1,2;
  issue_thread_infra_notify_skipped | bridge.founder-thread-notifier | 387
    | 2026-08-01 22:36:14 | 2026-08-02 07:31:28
```

⇒ 写者**仍在运行**,但速率是 387 行 / 8.9 小时 ≈ **43 行/小时 ≈ 1 045 行/天** —— 不是洪水。

**综合三个数,阶跃的形状是这样的:**

| 期间 | id 消耗/天 | 说明 |
|---|---|---|
| 07-27 → 07-29 | 1.4 万 – 4.1 万 | 基线 |
| **07-30 → 08-01 17:00 UTC** | **~95 万** | **约 25 倍阶跃,持续约 2 天** |
| 08-01 21:00 UTC 之后 | 1.3 万 → 2 千 → **~1.5 k/天** | 已回落到基线以下 |

⇒ 这是一次**有起点、有终点的洪水事件**,不是稳态写放大。
`issue_thread_infra_notify_skipped` 占了历史总量的 96.6%(354.5 万 / 367.1 万),
现在这个写者仍活着但只有 ~1 k/天。**要治本,查的是「07-30 那天什么让它涨了 25 倍、08-01 傍晚什么让它停了」**,
而不是它平时的速率。归 FLY-1595。

## B.4 抢救审计日志:只写不轮转 —— 但确实被截断过

| 时刻 | 大小 | 行数 |
|---|---|---|
| 08-01 22:27 UTC | **190 MB** | 931 588 |
| 08-02 07:38 UTC | **183 MB** | 940 291 |

**行数在涨、字节数在降** ⇒ 中间被截断/轮转过一次,但**又立刻涨了回来**(自旋没停)。
它记录每一次抢救、`shouldAlert=0`(不告警),按 92 次/分算 ≈ **1 MB/小时、13 万行/天**。

## B.5 双向通信复验(Lead 明确要求写进报告)

第一轮我的事故上报 `a0ea3215` 是**这个 runner 第一次 ask 到 Lead 手里并拿到回复**。
第二轮又跑通 5 次(3 条 DONE 报告 + 1 条 id 更正重发 + 1 条 hotfix 未上线上报),
**每一条 Lead 都回了**。

⇒ **runner → lead 双向通信在本 run 上端到端验通。** 这是 founder 那个问题的一半答案。

但同一批消息也复现了 §2.2 的病:CLI 每次都打印
`lead inbox nudge failed: This operation was aborted / fetch failed; durable queue row retained`,
且抵达面复核显示 4 条 DONE 报告里**只有 1 条被提升进 `lead_inbox`、0 条标记 delivered**
—— 而 Lead 事实上**全部读到了**。

⇒ **再次确证:`lead_inbox` 的投递记账与 Lead 实际的接收之间没有对应关系** ——
既有「记了没到」(§2.3 的 6072 条 undefined),也有「到了没记」(本次 4 条)。
**这个账本目前两个方向都不可信。** 这是 P1-4 必须查清的核心。

---

# 附录 C — 第三轮:部署为什么四次都没上去(结构性死锁)+ 一次尺子失效

## C.1 回滚逻辑:代码 + 日志 + reflog 三处坐实

`scripts/restart-services.sh`:

```bash
1523:    # Step 3: Start new Bridge
1528:        # Health check — wait for new Bridge to be ready (up to 60s)
1530:        for i in $(seq 1 30); do
1531:            if curl -sf "$BRIDGE_URL/health" | jq -e '.ok' > /dev/null 2>&1; then
1532:                hc_ok=true; break
1534:            sleep 2
1537:        if [[ "$hc_ok" != "true" ]]; then
1538:            log "ERROR: Bridge health check failed after restart. Attempting rollback."
1539:            rollback_and_restart "$DEPLOYED_SHA"
1545:    # Step 4: Restart Leads (after Bridge is confirmed healthy)
```

⇒ 健康检查窗口 = 30 × 2 s = **最多 60 秒**;超时即回滚 checkout。

**日志逐字(三份独立文件):**

```
/tmp/flywheel-restart-20260801-153812.log
  [2026-08-01 15:39:59] ERROR: Bridge health check failed after restart. Attempting rollback.
  [2026-08-01 15:39:59] Rolling back to 51b2a64
/tmp/flywheel-restart-20260801-160620.log
  [2026-08-01 16:08:01] … Rolling back to 51b2a64
/tmp/flywheel-restart-20260802-013133.log
  [2026-08-02 01:33:14] … Rolling back to 51b2a64
```

**`git reflog` 抓到比日志更多的一次,完整乒乓:**

```
01:32:23  pull: Fast-forward            → 5e4d45fb
01:33:14  reset: moving to 51b2a64b     ← 回滚,吃掉这次 pull
01:48:08  pull: Fast-forward            → 5e4d45fb
01:49:33  reset: moving to 51b2a64b     ← 再吃一次(日志里没有,只有 reflog 有)
01:58:04  pull: Fast-forward            → 5e4d45fb   (当前)
```

## C.2 这不是运气不好,是**结构性死锁**

把三件事放在一起:

1. **Lead 是风暴源**(§3.A 已证:`caller=_wait_tmux_window`);
2. **脚本只在 Bridge 健康之后才重启 Lead**(第 1545 行注释原文:
   `Step 4: Restart Leads (after Bridge is confirmed healthy)`);
3. **Bridge 在风暴烧机的 load 下 60 秒内起不来**(实测 load 17–23 时
   `/health` 要 12–19 秒甚至连不上)。

⇒ 脚本**永远走不到 Step 4**,每次都在 Step 3 超时回滚。

> **一个把「系统不健康」当回滚触发条件的部署管线,结构上无法部署治这个不健康的药。**
> 药上不去,正是因为病还在。

**这条值得单列成一个设计层缺陷**(裁定 U),它比它这次触发的那场事故更通用。
出路两条,都在设计层:
* 起 Bridge **之前**先停/重启 Lead(先掐风暴源,再验 Bridge);或
* 给 hotfix 通道一个更长的健康检查宽限 / 显式跳过。

## C.3 一次尺子失效 —— 而且我差点拿它下结论

**背景:** 修复上线后我想量「风暴停了没」,第一反应是复用第一轮那把尺子
(全机 max PID 增量,当时读到 654 个/秒)。

**结果:**

```
故意 fork 3 个进程后:max PID 99564 → 99564  (delta = 0)
20 秒窗口:            max PID 99564 → 99564  (delta = 0)
```

**尺子坏了**:macOS PID 上限 99999,此时已回绕,`max PID` 不再单调。
(第一轮那次读数取在 54858 → 61402 区间,未回绕,所以**那个数本身仍成立**;
失效的是「以后继续用这把尺子」。)

⚠️ 我在输出里写了一行「非 0 说明尺子能动」,而实测 delta **就是 0** ——
**断言与读数矛盾,我把它当成了通过。** 这是本审计第二次出现「自检语句本身不可信」
(第一次见 exploration.md §3.1)。两次都是同一个毛病:**自检必须由真实读数驱动,
不能是写死的旁白。**

**换的新尺子 + 它自己的检验:**

```
N 秒内出现过的不同 rescue/lockf PID 的并集
  10 s 窗口 → 112 个
  20 s 窗口 → 251 个     ← 计数随窗口增长 ⇒ 尺子有效
```

## C.4 还有一把尺子从头到尾就是错的:「抢救次数/分」

安静样本(Lead 在 `5e4d45fb` 上重启 18 分钟后):**115 次/分**,与风暴中的 130 次/分几乎一样。
看起来像「修复无效」。**但先查尺子:**

```
最近 200 条 holdSec 平均 = 0.519 s
⇒ 全局抢救锁的理论吞吐上限 = 60 / 0.519 ≈ 116 次/分
```

**实测 115 ≈ 上限 116。** 也就是说这个指标**修复前后都贴着锁的天花板**,
它测的是**锁的吞吐**,不是**循环的速度**。

⇒ **「抢救次数/分」从一开始就无法区分「修好了」和「没修好」。**
真正被烧掉的是 fork/进程 churn 和 load,那才是该看的量。

## C.5 当前状态 —— **不下结论,只报事实**

| 量 | 读数 |
|---|---|
| 生产仓 HEAD | `5e4d45fb` ✅ |
| 实际文件 1983 行 | 确有 `interruptible_sleep 3` ✅(`sed` 直接看的文件,不是看 git) |
| load | 23.07 → **8.90**(第二轮 12.6,风暴峰值 23.7) |
| rescue 常驻进程 | 10 → **3–7** |
| 自旋 Lead 数 | 10 → **4** |
| spawn 速率(新尺子) | **≈ 12.5 个/秒** |
| 分 Lead(30 s 窗口) | sub-lead 0.5/s、rafiki-lead 0.5/s、flywheel-cos 0.2/s、claude-infra-bot 0.2/s |
| Bridge `/health` | 200 / **14.6 s**(仍慢,但从 `HTTP=000` 回来了) |

**为什么不下结论:**

1. **舰队仍在变动。** 同一个 `rafiki-lead`,20 分钟内 PID 从 98604(起于 01:54:40)
   变成新进程(起于 02:27:01)—— 我两次采样量的不是同一批进程,靶子在动。
2. **仍有 Lead 跑在旧代码上。** `sub-lead` 起于 **01:56:22**,早于 01:58:04 那次 pull
   ⇒ 它没带修复。混在样本里,分不出「修复无效」和「这个没带修复」。
3. **带修复的 Lead 也还在自旋**(rafiki 0.5/s、cos 0.2/s、infra-bot 0.2/s)。
   与 3 秒退避的理论上限(每 Lead ≤ 20 次/分)量级相容 —— 一次逻辑抢救会派生 2 个匹配进程,
   所以 0.5 PID/s ≈ 0.25 次/s ≈ 15 次/分 —— **相容不等于证明**。

⇒ **修复是否有效,必须等舰队全部在 `5e4d45fb` 上稳定后,用 C.3 那把验过的尺子重测。**
本审计把尺子和方法交出去,**不替处置方宣布成功**。

## C.6 给 P0-1 验收判据的修订

原判据「`caller=_wait_tmux_window` 速率归零」**作废** —— 见 C.4,那个量测的是锁吞吐。
改为四条,缺一不可:

- [ ] `git -C <生产仓> rev-parse HEAD` == `5e4d45fb`
- [ ] **每一个** Lead 进程的起跑时刻晚于该 commit 落地时刻(用 `ps -o lstart`,逐个核,
      不是抽样 —— 本轮就是被 `sub-lead` 这种漏网的破坏了样本)
- [ ] Bridge `/health` 毫秒级(不是 14.6 秒)
- [ ] **spawn 速率**(C.3 的并集尺子,先做窗口翻倍自检)回到基线
