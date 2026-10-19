# FLY-145 S6 retry Product-Test — 实施计划
Issue: FLY-145 (https://linear.app/geoforge3d/issue/FLY-145/qa-fly-127-sandbox-s6-retry-product-test)
日期: 2026-09-26
基于: research.md

> **For agentic workers:** 本任务是 no-code QA fixture。DAG orchestrator 负责推进后续节点；Implement 节点不得借机修改产品代码，QA 节点按本计划执行一次真实矩阵并产出证据。

**Goal:** 在生产镜像的四 Lead 矩阵中证明 `Product-Test` issue FLY-145 只由 `flywheel-test-2` 发起 start 并启动 Runner，其他三个 Lead 保持沉默，然后仅在 PASS 和依赖迁移后归档 fixture。

**Architecture:** 测试以 `cos-test` 中唯一一条、只 @ `flywheel-test-2` 且带明确执行语义的消息为根事件。QA 将该根事件与四个稳定 slot 身份、`/api/runs/start` receipt 和 Runner session 关联，生成一张闭合的证据矩阵；prompt 层证明只有被点名的所属 Lead 行动，Bridge/session 层证明唯一副作用。

**Tech Stack:** Discord QA channels、Flywheel test slots、Linear fixture issue、Bridge/CommDB/StateStore 只读证据、Markdown QA report。

**Current QA readiness:** 暂不可执行。当前 repo harness 没有让 slot 1–4 同时读取 `cos-test` 的拓扑，本 design DAG 所在 slot 4 的 `bridge-launch.json` 明确记录 `BRIDGE_DEPT_SCOPE_REJECT=off`，cos 测试 identity 也未证明认识测试 dept bot id，Bridge 还没有通用 HTTP access log。只有独立 campaign 同时提供 fan-out、cos roster、四闸门 enabled 与四 Bridge `/api/runs/start` ingress capture receipts 后，QA 才能发送根消息；否则必须保持 `INCONCLUSIVE`，不能声称两层防线 PASS。

---

## 文件边界

| 路径 | 责任 | 下游动作 |
|---|---|---|
| `engineering/doc/FLY-145-s6-retry-product-test/exploration.md` | 范围、方案与成功标准 | 只读 |
| `engineering/doc/FLY-145-s6-retry-product-test/research.md` | 当前机制、风险与证据模型 | 只读 |
| `engineering/doc/FLY-145-s6-retry-product-test/plan.md` | 本执行计划 | 只读 |
| `engineering/doc/FLY-145-s6-retry-product-test/qa-report.md` | QA attempt、四 slot 证据与最终 verdict | QA 创建 |

产品源代码、配置文件、数据库 schema 和测试代码都不在修改范围内。

### Task 1: Implement 节点确认 no-code 边界

**Files:**

- Read: `engineering/doc/FLY-145-s6-retry-product-test/exploration.md`
- Read: `engineering/doc/FLY-145-s6-retry-product-test/research.md`
- Read: `engineering/doc/FLY-145-s6-retry-product-test/plan.md`
- Modify: none
- Test: none

- [ ] **Step 1: 核对 issue 目标**

确认唯一产品行为是：`flywheel-test-2` start + spawn；`flywheel-test-1/3/4` reply=0、start=0、spawn=0；PASS 且依赖迁移后 archive。

- [ ] **Step 2: 核对 branch change scope**

Run（`d6562f909` 是本次 redispatch 指定的 branch continuity base）：

```bash
git diff --name-only d6562f909
```

Expected: FLY-145 的新增/移动只位于 `engineering/doc/FLY-145-s6-retry-product-test/`；若出现产品代码改动，停止并移交 Lead 判断，不把它们当成本 issue 的实现。

- [ ] **Step 3: 明确跳过本地测试**

Expected: 不运行 Vitest、package suite、部署脚本或真实 QA harness。原因是没有代码变化，且真实 S6 行为只能由 QA 节点验证；“没有本地测试”必须在 handoff 中写明，不能表述为 tests passed。

- [ ] **Step 4: 完成 no-code handoff**

Expected: Implement 节点只报告“no code required; ready for QA against FLY-145”，不创建替代实现、不 dispatch successor，交由 DAG orchestrator 推进。

### Task 2: QA 建立可执行 topology 与唯一 attempt

**Files:**

- Create: `engineering/doc/FLY-145-s6-retry-product-test/qa-report.md`
- Read: `/Users/xiaorongli/.flywheel/test-slots.json`（只读取非敏感字段）
- Read: `scripts/qa-fly-1189-preflight.sh`

- [ ] **Step 1: 建立 attempt identity**

在 `qa-report.md` 记录一个唯一 `attempt_id`、UTC `started_at`、issue=`FLY-145`、label=`Product-Test`、source channel=`cos-test`。同一 attempt 只允许一个根消息。

- [ ] **Step 2: 验证 Linear fixture**

通过 QA 节点可用的 Linear 读取能力确认 FLY-145 存在、尚未归档且精确包含 `Product-Test`。若 issue 不存在、已归档或标签不同，写 `INCONCLUSIVE` 并停止；不要现场改标签来继续。

- [ ] **Step 3: 读取安全 slot 投影**

Run:

```bash
jq '{slots:[.slots[]|select(.id<=4)|{id,role,identitySource,department,deptLabel,botName,channelName,bridgePort}]}' /Users/xiaorongli/.flywheel/test-slots.json
```

Expected:

```text
slot 1 → flywheel-test-1 / PM-Test
slot 2 → flywheel-test-2 / Product-Test
slot 3 → flywheel-test-3 / Ops-Test
slot 4 → flywheel-test-4 / Finance-Test
```

不要读取或记录 token 值。

- [ ] **Step 4: 证明 fan-out 条件；当前条件不满足时停止**

在发送根消息前，记录独立 production-mirror campaign 的 fan-out receipt，证明 bot user id `flywheel-test-1/2/3/4` 都订阅并实际读取同一个 `cos-test` channel id。默认 channel 名不同不构成 fan-out 证明。

当前 `test-deploy.sh` 的三种模式都不能直接提供这个四 Lead 拓扑：slot mode 只订阅本 slot channel；mirror mode 使用 `test-core-mirror` 且拒绝 slot 4；roundtable mode 使用 `test-leads-roundtable`。因此没有新的外部 campaign receipt 时，本步骤必须写 `INCONCLUSIVE` 并停止，禁止临时改 access.json、重复投递四条消息或把不同频道的消息伪装成一个根事件。

- [ ] **Step 5: 证明 cos identity 认识测试 dept Lead**

从独立 campaign receipt 取得实际 staged cos identity 路径，逐个验证 test-2/3/4 的 bot id 在 cos Lead 的 dept roster/abstain set 中：

```bash
rg -nF '1493072948683341976' "$QA_FLY145_COS_IDENTITY"
rg -nF '1493075160025272452' "$QA_FLY145_COS_IDENTITY"
rg -nF '1493079116780408932' "$QA_FLY145_COS_IDENTITY"
```

Expected: 三项都命中明确的 dept Lead roster。仅在 `test-slots.json` 里存在这些 id 不够；实际 staged identity 必须认识它们，才能证明 cos 会因 test-2 被点名而 abstain。任一缺失写 `INCONCLUSIVE` 并停止。

- [ ] **Step 6: 证明四个 Bridge 的 scope gate 开启**

对独立 campaign receipt 中列出的四个 `bridge-launch.json` 逐一判定：

若 launch receipt 显式携带该变量，接受 `on/true/1`（大小写不敏感），拒绝 `off/false/0`。若变量缺失，只有 receipt 还能证明 Bridge 进程由显式、已清洗的完整环境启动且没有从 parent 继承该 key 时，才可按代码的 default-on 语义接受；否则写 `INCONCLUSIVE`。把脱敏后的 `slot → explicit-enabled | verified-default-on` 矩阵写进报告。当前 design DAG 的 `/private/tmp/flywheel-test-slot-4/bridge-launch.json` 为显式 `off`，所以它不能充当 S6 受测 campaign。

- [ ] **Step 7: 要求四 Bridge ingress capture，并记录基线**

Bridge 自身没有通用 HTTP access log；`workflow_route_decision` 只覆盖进入路由决策的接受路径，FLY-127 reject 只写特定日志，某些早期 4xx 不留可查询事实。因此独立 campaign 必须在四个 Bridge 的 HTTP ingress 前提供脱敏 request/response capture，至少记录：UTC time、path、issueId、leadId、status、response code/reason、request correlation id；不记录 token 或正文秘密。缺少任一 Bridge 的 capture 就无法证明 start=0，写 `INCONCLUSIVE` 并停止。

随后对 FLY-145 记录发送前的 Discord reply、ingress capture、workflow route decision、Bridge log byte offset 和 session 计数与最后事件时间。矩阵必须运行在与本 design DAG 分离的 campaign state 中；所有查询还必须限定 root 之后，并显式排除本 design execution `b2a57a9e-7f4f-4963-afef-7ce23d6330de`。旧行可以存在但不得计入本 attempt；若无法按时间与 execution id 隔离，写 `INCONCLUSIVE`，不要删除旧证据。


### Task 3: 发送一次测试输入并观察四 slot

**Files:**

- Modify: `engineering/doc/FLY-145-s6-retry-product-test/qa-report.md`

- [ ] **Step 1: 发送根消息**

在 `cos-test` 顶层发送且只发送（bot id 来自当前 test-slots 配置）：

```text
<@1493072948683341976> 起 Runner FLY-145
```

这条消息只 @ `flywheel-test-2`，包含一个 issue id 和明确执行语义，符合 department Lead Action Gate；cos Lead 因 dept Lead 被点名而 abstain，slot 3/4 因未被点名而静默。立即记录 Discord message id、channel id 和 UTC `root_ts`。

- [ ] **Step 2: 关联 Product-Test 正向链路**

在 `root_ts + 5 分钟` deadline 内确认：

1. 唯一成功 `/api/runs/start` receipt 的 `leadId/selected_by` 是 `flywheel-test-2`；
2. 唯一新建 spawn/session 与该成功 receipt 的 execution id 相同；
3. session 的 issue 是 FLY-145；
4. session labels 精确包含 `Product-Test`。

任何第二个 start/spawn 立即判 FAIL；test-2 在 deadline 内未完成 start + spawn 也判 FAIL。

- [ ] **Step 3: 固化 start 与 spawn 的可复现数据源**

本计划不使用没有数据实体的“claim”作为独立证据；统一观察 `/api/runs/start` admission：一个带 `leadId` 的请求及其 HTTP receipt。每个 slot 都必须保存从 `root_ts` 起的 ingress capture；接受路径再用 `workflow_route_decision.selected_by` 和 session execution id 交叉验证，dept-scope reject 再用 Bridge log corroborate。

对每个独立 campaign slot 的 `teamlead.db` 用 SQLite 只读 URI 查询；不得复制 live DB：

```bash
sqlite3 "file:${QA_FLY145_SLOT_DIR}/teamlead.db?mode=ro" \
  -cmd '.parameter init' \
  -cmd ".parameter set @root_ts '${QA_FLY145_ROOT_TS}'" \
  "SELECT execution_id, issue_identifier, project_name, status, started_at
     FROM sessions
    WHERE issue_identifier = 'FLY-145'
      AND julianday(started_at) >= julianday(@root_ts)
      AND execution_id <> 'b2a57a9e-7f4f-4963-afef-7ce23d6330de'
    ORDER BY started_at;"
```

`QA_FLY145_SLOT_DIR` 来自独立 campaign receipt，`QA_FLY145_ROOT_TS` 保留 Discord 原生 ISO-8601 UTC 值。两张表的时间文本格式不同，所有比较都必须用 `julianday(column) >= julianday(@root_ts)` 归一化；禁止直接用字符串 `>=`。对 workflow route decision 查 `issue_id='FLY-145' AND julianday(created_at) >= julianday(@root_ts)` 的 `selected_by/execution_id/status/route`。

```bash
sqlite3 "file:${QA_FLY145_SLOT_DIR}/teamlead.db?mode=ro" \
  -cmd '.parameter init' \
  -cmd ".parameter set @root_ts '${QA_FLY145_ROOT_TS}'" \
  "SELECT selected_by, execution_id, status, route, created_at
     FROM workflow_route_decision
    WHERE issue_id = 'FLY-145'
      AND julianday(created_at) >= julianday(@root_ts)
    ORDER BY created_at;"
```

每个 Bridge 还要保存根消息发送前的 `bridge.log` byte offset，并只搜索之后追加的字节。dept-scope 拒绝的精确模式是 `[runs/start] FLY-127 dept-scope reject:`，结果必须同时含 `lead="<slot lead>"` 与 `issue="FLY-145"`。Bridge log 不覆盖所有早期 4xx，所以它只能 corroborate ingress capture，不能单独证明零请求。`scripts/qa-fly-1189-preflight.sh` 也只能补充静态 owner routing 和旧 chat-thread 存在性；它不证明本 attempt 的 actor，也可能命中旧 thread，因此不得作为 PASS 必选项。

- [ ] **Step 4: 闭合完整负向观察窗口**

从根消息 `root_ts` 起观察到 `root_ts + 6 分钟`：覆盖 5 分钟正向 deadline，再留 1 分钟余量。对 slot 1、3、4 分别记录 reply=0、ingress start requests=0、spawn sessions=0。Discord reply 用 channel history 按 bot user id + `root_ts` 过滤；start 用每个 Bridge 的 ingress capture，并以 route decision / reject log 补强；spawn 用每个 slot 的只读 sessions 查询。三个数据面必须同时为零。任何 ingress capture 缺口、无法解释的 4xx 或时间归一化失败都判 `INCONCLUSIVE`；单独“没看到 Discord 回复”不足以证明无副作用。

- [ ] **Step 5: 固化四行矩阵**

在 `qa-report.md` 写出：

| slot | received input | reply | start receipt | spawn | evidence | result |
|---|---:|---:|---:|---:|---|---|
| 1 | 1 | 0 | 0 | 0 | message/event refs | PASS row |
| 2 | 1 | observed | 1 | 1 | start/session refs | PASS row |
| 3 | 1 | 0 | 0 | 0 | message/event refs | PASS row |
| 4 | 1 | 0 | 0 | 0 | message/event refs | PASS row |

所有引用必须来自本 attempt；不得把历史日志或单元测试结果当成本次 row evidence。每行至少列出 input delivery ref、Discord author-filter result、Bridge ingress-capture result、route/log corroboration 和 sessions query result。

### Task 4: 判定、清理与报告

**Files:**

- Modify: `engineering/doc/FLY-145-s6-retry-product-test/qa-report.md`

- [ ] **Step 1: 按机械规则计算 verdict**

`PASS` 当且仅当：四个 slot 都确认收到输入；cos identity roster 包含三个测试 dept bot id；四个 Bridge 都有 scope gate enabled 证据；四路 ingress capture 连续完整；slot 2 start=1 且 spawn=1；slot 1/3/4 reply=start=spawn=0；观察窗口覆盖 root+6 分钟；证据均属于同一 attempt。

`FAIL`：完整观察下任一行为偏离预期。

`INCONCLUSIVE`：输入 fan-out、基线、观察窗口或证据关联无法证明。

- [ ] **Step 2: 处理失败或不确定结果**

若 verdict 为 FAIL/INCONCLUSIVE：保留 FLY-145 为未归档状态；记录违规 slot、时间线和最小诊断。只有越界 Lead 确实尝试 start 时才检查 `DEPT_SCOPE_REJECT`；不要重发根消息，也不要关闭保护开关。

- [ ] **Step 3: PASS 后处理归档依赖，再归档**

本 issue 明确要求 PASS 后归档，但 `scripts/qa-fly-1189-room-smoke.sh` 当前仍把 FLY-145 当成“kept open”的常开 Product-Test fixture。归档前必须取得 Lead 对该依赖的处理结果：确认 FLY-1189 已退休，或先把它迁到一个明确的新 fixture issue。不得静默破坏该 harness，也不得因此取消本 issue 的归档要求。

只有 `qa-report.md` 已写明行为 PASS 且依赖处理 receipt 完整后，才通过 QA 节点被授权的 Linear 操作归档 FLY-145，并记录 archive receipt/time。行为 PASS 但依赖未迁移或归档失败时，整体 cleanup 状态必须标为未完成并报告 Lead。

- [ ] **Step 4: 提交 QA 报告**

提交 `qa-report.md`，commit message：

```text
docs(FLY-145): record S6 Product-Test matrix verdict
```

推送当前 feature branch，不 force-push，不 merge，不请求 ship authority。

## 验收映射

| issue requirement | proof |
|---|---|
| only test-2 starts | 单 attempt `/api/runs/start` receipt + selected_by |
| only test-2 spawns | start receipt + route decision + matching session execution id |
| test-1/3/4 silent | 每 slot input receipt + reply/start/spawn zero window |
| Bridge defense retained | 四个 launch receipt 的 scope gate enabled / verified-default-on 证据；越界 attempt 存在时再附 403 diagnostic |
| no code work | branch scope + implement no-op handoff |
| cleanup after PASS | Linear archive receipt after verdict |

## 计划自检

- exploration/research 的每个成功标准都有对应 Task 与证据。
- 没有占位内容、模糊的“测试一下”或全包 test 命令。
- 稳定身份使用 slot/bot/lead id；显示名仅用于阅读。
- PASS、FAIL、INCONCLUSIVE 与 archive 边界明确。
- 不实现代码、不部署、不关闭保护、不 dispatch successor、不 merge。
