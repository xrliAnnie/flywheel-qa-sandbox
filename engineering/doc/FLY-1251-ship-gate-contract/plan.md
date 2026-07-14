# FLY-1251 ship-gate 契约落地（R1/R2/R9 全量 + R8 余量；R4/R7 契约级）— 实施计划

Issue: FLY-1251 (https://linear.app/geoforge3d/issue/FLY-1251/build-fly-1211-ship-gate-契约落地-founder-approval-绑定根治r1-r9主通道-a)
日期: 2026-07-14
基于: research.md

> 三段式 pipeline：本文档由 design 段产出，**implement 段在同一分支照此执行**，QA 段独立复验。
> 上游权威 = `product/doc/FLY-1211-founder-approval-binding/prd.md` v6（Codex APPROVED，主通道 A 已拍板）。
> brainstorm gate 三点拍板（Tadashi 2026-07-14）：①implement 段交 Slice1+Slice2，Slice3（R4/R7）契约级设计、实施拆子单；②merge 闸收紧排 FLY-1244 落地后（过渡期由 founder-gated + Lead 人肉 verify-approval 链兜底，不裸奔）；③**代码 PR 零 policy 豁免**——qa.auto:false / skip_labels 只关「自动 spawn QA」这个运维动作，**不构成 ship 豁免**；skip_labels 作为 ship 豁免语义退役；唯一合法豁免 = server 算 diff 的 docs-only（绝不认 label）。

---

## 0. 交付物与红线

**两个 PR，顺序交付**（止血先行先生效，不被卡状态机拖住——issue 原文授权）：

- **PR-1（Slice 1 止血）**：`qa_evidence_missing` 发卡 hold + docs-only server 判定 + manual-QA 证据登记 + 删 `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 旁路。
- **PR-2（Slice 2）**：`founder_ship_card` 耐久卡状态机（R1）+ stale 点击回应 + 通道中断契约 + 文字批准指向活卡（R9）+ evidence-source 接口化（R2 barrier 留缝）。

**红线**：
- **最小验收（issue 原文）**：flag 批事故形状（code PR、no-three-stage、零 QA 节点）在 PR-1 后**机械不可能**开出 approve 卡——对应验收 E1。
- 有意行为改变的精确边界：(a) main 单段 code-PR run 无 QA 证据 → founder 面全部 hold（新行为，= 本单目的）；(b) `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 旁路删除（生产该 env 未设 → 生产零变化）。**除此以外旧路径字节兼容**：三段式相位、implement/design/qa 角色 hold 语义、qa_required=1 的现有链、merge 闸（本单不碰 `ship-eligibility.ts`）。
- fail-closed 方向恒为「不可逆的那一侧」：docs-only 判不出 → 当 code PR；DB/API 读失败 → hold；卡状态 CAS 竞态失败 → 不发卡。
- **绝不消费 runner 自报**：docs-only 判定只认 Bridge 侧对 (PR, head) 的 GitHub API 计算，绝不读 `sessions.changed_file_paths`、绝不认 label。
- 与 FLY-1244 零文件冲突：本单不碰 `ship-eligibility.ts` / `write-gate-response.ts` / `actions.ts` / `qa-result.ts`（冲突清单 = research.md §H）。StateStore 改动为独立加性迁移块。
- merge 即入库，生效等 Bridge 重启（攒批）；Runner 绝不自 merge / 自 :cool:。
- **吃自己的狗粮（issue 直令）**：本单两个 PR 自身的 ship 必须过本单定义的闸语义（至少人肉版）——PR 是代码 PR ⇒ 必须有独立 QA 证据才请 founder 批；docs commit 部分不豁免整个 PR。

## 1. 总验收

1. E1-E9 验收矩阵（§6）全绿；红线行为改变边界成立（不启用面字节兼容有测试锚）。
2. PRD §6 硬安全计数器中本单负责的两条落地：**能授权的 retired/stale 卡 = 0**（PR-2 后）、**stale 点击无明确回应 = 0**（PR-2 后）；「active 卡无 binding」不变量（PR-2 卡状态机 active 前置）。
3. 一次真机 E2E（§7）证据先于 gate 呈报（2026-07-14 统一标准）。
4. 全仓 lint + 全测试绿；Codex code review APPROVED。

## 2. 架构决策定稿

| # | 决策 | 落地 |
|---|---|---|
| 1 | hold 谓词是唯一杠杆点 | 四个 founder 面（GatePoller relay `gate-poller.ts:706` / event-route always-deliver / HeartbeatService gate_timed_out / DirectEventSink push）已共同消费 `reviewHoldReason`——新 hold 原因加在这一个函数里，四面同步收口，不加第二个谓词 |
| 2 | `qa_evidence_missing` 为 **main-only** | 三段式 run 的 approve gate 由 qa role session 持有（`isReviewableRole` 对 qa 返回 null，天然不经此谓词）；implement role 保持现有行为（其 hold 由 codex gate 覆盖，且无 approve gate 要发）——最小爆炸半径，三段式相位零改动 |
| 3 | 运维开关与 ship 豁免语义分离（拍板 ③） | `FLYWHEEL_AUTO_QA=0` / `qa.auto:false` / `skip_labels` / `no-qa` label 继续只控制**自动 spawn**（auto-qa-policy 不改）；它们写下的 `qa_required=0` snapshot **不再被发卡面消费为豁免**。发卡面的豁免只有一个：`ship_relevant_diff_snapshot.ship_relevant=0`（server 算的 docs-only） |
| 4 | docs-only 判定 = 异步计算 + 持久 snapshot，谓词只读 | hold 谓词是同步纯读函数，不能做网络调用。判定由 Bridge 异步算、落 `ship_relevant_diff_snapshot` 表（per execution+head，write-once）；谓词读表，行缺失 = 还没算出来 = hold（fail-closed，下 tick 重算补上后自动放行） |
| 5 | QA 证据 = 复用 `auto_qa_record` 全链，不建第二真相源 | manual 登记走「创建 record」而非新表；verdict 验证仍走 `onQaResult` 现有五重链（research §A.1）。claim 证据源（1244）到位后经 §5.4 的 evidence-source 接口作为第二实现并入 |
| 6 | 卡状态机 = 新表 + 部分唯一索引 | at-most-one-active 由 DB schema 机械强制（`WHERE state IN ('posting','active')` 部分唯一索引），不靠代码纪律；状态转移一律 CAS（`WHERE state=:expected`，0 行 = 竞态 fail-closed） |
| 7 | Discord 消息动作永远 best-effort，安全由 DB 态保证 | retire 时 edit 置灰优先于 delete（保审计痕迹）；edit 失败只降级 UX，点击安全性由卡状态 + binding fail-closed 保证——与现状架构原则一致 |

## 3. PR-1（Slice 1 止血）

### 3.1 `ship_relevant_diff_snapshot` 表 + docs-only 判定服务

**新文件** `packages/teamlead/src/bridge/ship-relevant-diff.ts`；**StateStore 加性迁移块**：

```sql
CREATE TABLE IF NOT EXISTS ship_relevant_diff_snapshot (
  execution_id TEXT NOT NULL,
  pr_head_sha TEXT NOT NULL,
  ship_relevant INTEGER NOT NULL CHECK (ship_relevant IN (0,1)),  -- 0 = docs-only
  file_count INTEGER NOT NULL,
  sample_paths TEXT,                -- 前 N 条非豁免路径（诊断用，非权威）
  computed_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, pr_head_sha)
);
```

- **数据源**：GitHub PR files API（复用仓内现有 gh/GitHub 调用模式——`ExecutionEvidenceCollector.readLandingStatus` 已有 GitHub API verify 先例；implement 期沿用同一调用形态）。输入 (prNumber, headSha)：**必须先核 PR 当前 head == 请求的 headSha**（`gh pr view --json headRefOid,files` 一次取回；不等 → 不落 snapshot，本 tick 放弃），防「取的是 PR 的另一个 head 的文件表」。
- **DOCS_ALLOWLIST（受信静态常量，代码内定义，变更走 review）**：目录前缀 `doc/`、`docs/`、`engineering/doc/`、`product/doc/`、`content/doc/`、`marketing/doc/`。**注意刻意排除**：根目录 `*.md`（CLAUDE.md / README / agents/*.md / lead-rules-base/*.md 是行为文件 = 代码）、`.flywheel/`、`.claude/`、`.github/`。语义遵 PRD R4：默认每个可 merge 文件 ship-relevant，豁免仅此 allowlist。
- **判定**：files 全部落在 allowlist 内 → `ship_relevant=0`；任一文件在外 → `1`。**任何失败（API 错、超时、分页截断、文件数为 0、head 不匹配）→ 不写行**（行缺失即 hold，fail-closed；下个 tick 重试）。
- **触发点**（幂等，行已存在即跳过）：
  1. `AutoQaCoordinator.onMainAwaitingReview`（session 进 awaiting_review 时，与 policy 评估同点）；
  2. GatePoller tick：对 awaiting_review 的 main session，若 (execution, 当前 head) 无 snapshot → 异步触发计算（防 coordinator 错过 / head 后移场景）；
  3. rebind 成功路径（`tryShipGateRebind` 之后，对新 head 触发）。
- 计算入口带进程内 in-flight 去重 + 失败退避（每 (exec,head) 最快 60s 一次），防 API 打爆。

### 3.2 `qa_evidence_missing` hold（核心止血）

改 `packages/teamlead/src/bridge/auto-qa-held.ts`：

- `ReviewHoldReason` 枚举加 `"qa_evidence_missing"`（自清除型 hold → 可 defer，语义同 `qa_not_green`：FLY-1099 的 deferred-approval 分类表同步加一行）。
- `reviewHoldReason` 在现有 `qa_not_green` 判定**之后**追加（保持既有原因优先序不变，byte-order 兼容）：

```
仅当 session_role === 'main' 且 status === 'awaiting_review' 且 pr_number != null：
  evidence = getAutoQaRecord(execution_id, pr_head_sha)?.status === 'passed'
  若 evidence → 不 hold（现有 qa_not_green 分支已覆盖 record 存在但未 passed 的情形）
  若无 record：
    snapshot = getShipRelevantDiffSnapshot(execution_id, pr_head_sha)
    snapshot 缺失        → hold 'qa_evidence_missing'   （fail-closed：还没算出来）
    snapshot.ship_relevant=1 → hold 'qa_evidence_missing'
    snapshot.ship_relevant=0 → 不 hold                   （唯一合法豁免：docs-only）
```

- **`qa_required` 不再被发卡面消费**（拍板 ③）：上述逻辑对 `qa_required=0` 的 session 一样生效——这正是 flag 批的形状。`qa_required` 列及其 auto-qa-policy 写入路径**原样保留**（merge 闸 `evaluateQaShipGate` 仍读它——merge 侧收紧排 1244 后，§5.3）。
- store 接口（`AutoQaHeldStore`）加 `getShipRelevantDiffSnapshot` 与 `getSessionPrNumber`（或把 pr_number 并入 `QaHeldSession` 类型——**选后者**，调用面已传 session 行）。四个消费面传参核对：`gate-poller.ts:706` / event-route / heartbeat / DirectEventSink 现有调用全部经同一 store + session 形参，无需逐面改动（谓词内部扩展）；implement 期逐面确认 session 行含 `pr_number` 字段，缺则补 SELECT 列。
- **Lead 可见性**：GatePoller 对 held 的 approve gate 现有行为是静默 skip——加一次性（per execution+head+reason，durable marker）Lead 通知：「FLY-XX 的 approve 卡因 qa_evidence_missing 被扣住：该 code PR 无 QA 证据。补证据路：manual-enroll API / 重派 QA」。复用现有 lead-alert 基建，绝不进 founder 面。

### 3.3 manual-QA 证据登记（enrollment）

**Bridge API** `POST /api/qa/manual-enroll`（loopback + same-origin + confirmToken，框架同 fleet console / 1244 re-qa；这是 Lead 运营动作，非 founder 授权动作——QA 证据登记 ≠ approve）：

- body：`{ executionId, qaExecutionId, prHeadSha }`（三者必填；prHeadSha 必须 == parent session 当前 `pr_head_sha`，不等 → 400 拒）。
- 校验（全 fail-closed）：parent 存在、`session_role='main'`、`status='awaiting_review'`、有 `pr_number`；qa session 存在且 ≠ parent；(execution, head) 无既有非 superseded record（有 → 409，幂等重复调用返回既有 record 状态）。
- 动作：创建 `auto_qa_record`（status='running'，`qa_execution_id=qaExecutionId`，新列 **`enrollment_source TEXT NOT NULL DEFAULT 'auto' CHECK (enrollment_source IN ('auto','manual'))`**）+ `workflow_template_audit` 同款审计行（本单落 `session_event` 审计，不新建审计表）。
- **verdict 链适配**（`auto-qa-coordinator.ts` `onQaResult` 第 1 步）：现状要求报告者 `session_role='qa'`；manual enrolled 的 QA 多为独立 issue 的 main session。放宽为：**`role='qa'` OR（该 (parent, head) 的 record 存在、`enrollment_source='manual'` 且 `record.qa_execution_id === 报告者`）**。安全性论证：manual record 的 executor 绑定由 Lead 显式 enrollment 写入（第 4 步 exact-executor 检查照跑），冒充者必须先被 enroll——比 role 检查更强的绑定；auto record 的第 1 步行为逐字不变。
- 其余四步验证（head 相等/rebind、record 存在、exact executor、running-only）**零改动**复用。

### 3.4 删 `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 旁路（R8 余量）

- `founderApprovalHoldGuard`（`auto-qa-held.ts:134-141`）删掉 env 短路，函数体变为纯 `isReviewHeld`。
- 该 env 在全仓的其它引用（测试、文档、env 注册表）同步清理；生产 `~/.flywheel/.env` 已核实未设 → 生产行为零变化。PRD R8 原文：「静默 env 旁路与 fail-closed 不变量矛盾 → 删掉」。响亮版紧急动作不在本单做（若未来需要 = founder 授权的显式动作，接 1244 的 writeFounderApproval 域）。

### 3.5 PR-1 步骤序（TDD）

RED：①事故重放测试（E1：main + awaiting_review + pr_number + 无 record + `qa_required=0` + snapshot.ship_relevant=1 → `reviewHoldReason='qa_evidence_missing'`；同形状在改动前的谓词返回 null——用 git stash 或注释验证 RED 真实红过）②docs-only 豁免正测 ③snapshot 缺失 fail-closed ④allowlist 边界（CLAUDE.md / agents/*.md / .flywheel/** 必须算 ship-relevant；doc/** 纯文档过）⑤head 不匹配不落 snapshot ⑥manual-enroll 全校验矩阵 + 幂等 409 ⑦onQaResult 放宽面的正负测（manual record + exact executor 过；manual record + 他人 verdict 拒；auto record 行为逐字不变）⑧HOLD_ALIGN 旁路删除后 guard === isReviewHeld ⑨qa_required=1 现有链回归（byte-compat 锚）。
GREEN：表迁移 + `ship-relevant-diff.ts` + 谓词扩展 + API 路由 + coordinator 触发点接线。
REFACTOR：hold 原因→deferred-approval 分类表同步；Lead 通知文案。

## 4. PR-2（Slice 2：R1 卡状态机 + R9）

### 4.1 `founder_ship_card` 表（StateStore 加性迁移块）

```sql
CREATE TABLE IF NOT EXISTS founder_ship_card (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  pr_head_sha TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,                      -- posting 阶段 NULL，Discord 发出后回填
  state TEXT NOT NULL DEFAULT 'posting'
    CHECK (state IN ('posting','active','retiring','retired')),
  created_at TEXT NOT NULL, activated_at TEXT, retired_at TEXT,
  retire_reason TEXT,                   -- head_drift|superseded|channel_down|gate_answered|post_failed|binding_missing
  UNIQUE (question_id, pr_head_sha)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ship_card_live
  ON founder_ship_card(execution_id) WHERE state IN ('posting','active');
```

- **at-most-one-live per execution = 部分唯一索引**（posting 计入占位，封并发 double-post 窗口）。
- 状态转移只经 CAS 方法（`transitionShipCard(id, from, to, fields)`，`UPDATE … WHERE id=? AND state=?`，0 行 → 返回 false，调用侧 fail-closed）。**无 UPDATE 直改 state 的第二路径**；`retired` 为终态（append 语义靠 CHECK + CAS 保证，不加 trigger——本表需要合法状态转移，与 append-only 账本不同类）。

### 4.2 发卡流程改造（`gate-poller.ts` `maybeEmitFounderThreadFallback`，approve_to_ship 分支）

顺序（每步失败的处置在括号里）：

1. `INSERT posting 行`（唯一索引冲突 → 该 execution 已有 live 卡 → 不发，log；这一步取代并**保留**现有 per-question durable marker——双保险）。
2. **binding 前置**：确认 (questionId, prHeadSha) 的 gate-message binding 可写/已写。现状 binding 是发卡后 best-effort（PRD R1 已知半失败源）——改为：post Discord 成功拿到 message_id → **先写 binding、再 CAS posting→active**；binding 写失败 → CAS posting→retiring(reason=binding_missing) + edit 卡为「稍候，正在重建」+ 下 tick 重试整个流程。**不变量：state='active' ⇒ binding 存在且唯一**（E5 测试锚）。
3. post Discord 失败 → CAS posting→retired(reason=post_failed)，释放占位（下 tick 重试）。
4. 全部成功 → 卡 active，founder 可点。

**retire 接线**（先 retire 老、再 post 新——PRD R1 顺序）：

- `retireShipGate` 的三个调用面（`event-route.ts:1167` 主路径 / `:1289` re-review / gate-poller backstop sweep `:1990`）：同步 CAS 该 execution 的 live 卡 → retiring(reason=head_drift|superseded) → best-effort Discord edit 置灰（「此卡已过期」+ 若已知新卡则附跳转）→ CAS retiring→retired。edit 失败照样 retired（安全在 DB 态）。
- rebind 路径（`ensureRebindAnchor`）：发 rebind follow-up 卡前，先 retire 旧 live 卡（同上），新卡走 §4.2 全流程。**修掉现状「rebind 多发一张、旧卡永存」**。
- gate 被回答（approve/reject 落定）→ retire(reason=gate_answered)（卡完成使命；不 edit 或 edit 为「已批 ✅」）。

### 4.3 stale 点击回应（R9）

- GatePoller reaction pass 加 retired 扫描：`listRetiredShipCards(window=7d, limit=20/tick 轮转)` → 对每张有 message_id 的卡跑现有 `evaluateReactionSource` → 发现 ✅ 且无回应 marker → 回 thread 一条：「这张批准卡已过期（原因 X）。」+ 当前该 execution 有 active 卡 → 附其跳转链接；无 → 「当前没有待批的卡（原因：审查进行中 / 通道重建中 / 已批准）」→ 写 durable marker（per message-id，一次性）。**绝不因 stale ✅ 写任何 approval**。
- 文字批准指向活卡：founder text 批准被 hold/defer 时的既有回复（FLY-1099 defer 链）文案加 active 卡跳转链接（有 active 卡时）；无 active 卡时明说原因（R9：绝不指向死卡、绝不路由 Lead 授权）。

### 4.4 通道中断契约（R9）

- 通道健康前提 = reaction 摄取可用：`FLYWHEEL_FOUNDER_AUTO_APPROVE!=0 ∧ FLYWHEEL_FOUNDER_REPLY_DELIVER!=0 ∧ canonical founder id 可解析 ∧ 项目不在 denylist`（PRD R9 列举的四个抑制源；实现期从 `founder-reaction-approval-handler` 的现有 gating 抽共享谓词）。
- GatePoller tick：通道不健康 且 存在 active 卡 → CAS active→retiring(reason=channel_down) + Discord edit「批准通道暂不可用，恢复后将重发新卡」+ Lead 告警（一次性 marker）。恢复 → 正常发卡流程重新发新卡（占位已释放）。
- 中断期间的点击：卡已 retiring/retired → 落入 §4.3 的 stale 回应路径（恢复时 reconcile 或明确告知未接受——满足 PRD R9 通道中断契约）。

### 4.5 evidence-source 接口化（R2 barrier 留缝，接 1244/子单 D）

- `auto-qa-held.ts` 内把「QA 证据存在」抽为 `QaEvidenceSource` 接口（v1 唯一实现 = auto_qa_record passed）；1244 commit B 落地后加 claim 实现（enrolled run 查 `qa_passed` head-bound claim），两源 OR。接口签名按 (executionId, prHeadSha) → boolean，同步纯读。
- `ReviewHoldReason` 预留 `no_qualified_reviewer`（R6 顶住语义）枚举 + 文案；产生它的 obligation 逻辑归 1244 子单 D，本单不实现。

### 4.6 PR-2 步骤序（TDD）

RED：①at-most-one-live（并发 double-post 第二 INSERT 冲突）②CAS 竞态（错误 from-state 0 行 fail）③active⇒binding 不变量（binding 写失败 → 卡绝不 active）④retire 三调用面各一格（head_drift / superseded / backstop）⑤rebind 先 retire 旧再发新（thread 里 live 卡恒 ≤1）⑥stale ✅ → 明确回应 + 零 approval 写入 + marker 幂等 ⑦通道中断 → active 卡 retire + 说明 + 恢复重发 ⑧gate_answered retire ⑨Bridge 重启 reconcile（posting 悬挂行 → 重试或 retire；active 卡与 binding/gate 状态对账）。
GREEN：表 + CAS 方法 + 发卡流程改造 + retire 接线 + retired 扫描 + 通道谓词。
REFACTOR：evidence-source 接口抽取。

## 5. 契约级设计（本单只写不实施）

### 5.1 R4 canonical ship_subject（实施 = 子单，挂 FLY-1211 伞下）

- versioned `ship_subject` schema（范式 in-toto/SLSA subject digest；1135 DR 报告为弹药）：`{schema_version, repo, workflow_run_id, policy_version, entries: [{path, op(add|modify|delete|rename), mode_before/after, blob_before/after}]}`；由 Bridge 从 Git 对象算，fail-closed，绝不 runner 自报。
- 分离「被审/被批的改动 manifest」（clean rebase 下不变）与「required CI 跑在的候选 head」；在卡激活 / 记批准前 / rebase 后 / merge 前四点重算比对。
- 迁移纪律（PRD §10-5）：先 shadow-compare 现有 exact-head predicate，dual-write 期，绝不 backfill 旧 head 批准到 content subject，迁移用全新 gate epoch。
- 依赖：1244 head-authority resolver（已交）+ 本单 PR-2 的卡状态机（epoch 载体）。

### 5.2 R7 freeze_epoch（实施 = 同一子单）

- 定义域：readiness barrier 通过（= 本单 hold 谓词放行 + binding 落定）→ 授权/ship 完成。
- 机制：server-owned mutation lease（第一方分支 writer 在 epoch 内必须持 lease，fail-closed）；外部写检测 = 对比 freeze 时 head，观测到漂移 → 原子作废 epoch + retire 卡（reason=head_drift，PR-2 已有该路径——freeze_epoch 是它的「检测更早、语义更强」版）。
- 已核现状：runner `progress` 对非 running session 拒绝（awaiting_review 面已闭）；QA-evidence commit 的 head 前进走 rebind 链 = 「有人按钮」的合法动作，epoch 语义下等价于换 epoch。

### 5.3 merge 闸终态（实施排 1244 commit B 落地后；可作为本单收尾 commit 或并子单）

- `evaluateQaShipGate` 的 `qa_required=0 → qa_not_required` 放行语义退役，重写为与发卡面同一豁免语义：`docs-only（server 判） ∨ QA 证据（evidence-source 两源）`，并与 1244 真值表 (a)-(e) 合并为一张表（(c) 分支的 code-PR 情形从「旧布尔放行」改为「evidence ∨ docs-only」）。
- 过渡期兜底（拍板 ②，写明）：merge 全部 founder-gated + Lead 人肉执行 verify-approval 链，merge 侧在人肉闸后面；发卡面（PR-1）已把「无证据的卡」挡在 founder 视野外，静默 no-op 面已闭。
- 时序依据：`ship-eligibility.ts` 是 1244 commit B 的主战场文件，本单先动 = 制造 rebase 冲突 + 双方各持真值表分叉。

## 6. 验收矩阵（QA 段逐格核）

| # | 用例 | 期望 | 契约 |
|---|---|---|---|
| E1 | **事故重放**：main、awaiting_review、pr_number、`qa_required=0`、无 record、diff 含代码文件 | `reviewHoldReason='qa_evidence_missing'`；四个 founder 面全 hold；卡不发；Lead 收一次性原因 | R1/R2 |
| E2 | docs-only PR（server 判 0）、无 record | 不因 QA hold；卡可发 | R4 豁免 |
| E3 | snapshot 缺失 / GitHub API 失败 / head 不匹配 | hold（fail-closed）；重试补算后自动放行 | 北极星 |
| E4 | manual-enroll → 独立 QA 发 PASS verdict（head 相等、exact executor） | record→passed；hold 解除；卡发出。负测：非 enrolled executor 的 verdict 拒；重复 enroll 409 幂等 | R2 |
| E5 | 发卡：binding 写失败 | 卡绝不 active；retiring(binding_missing)；重试收敛；**无「active 无 binding」状态**（硬计数器） | R1 |
| E6 | head 漂移 / re-review / rebind | 旧卡先 retire（edit 置灰 best-effort）再发新卡；任一时刻 live 卡 ≤1（DB 索引强制） | R1 |
| E7 | 点 retired 卡的 ✅ | 一条明确回应（过期原因 + 活卡链接或「暂无待批」）；零 approval 写入；回应幂等一次 | R9 |
| E8 | 通道中断（reaction 摄取被抑制） | active 卡 retire(channel_down) + 可见说明 + 告警；恢复后重发新卡；中断期点击按 E7 回应 | R9 |
| E9 | byte-compat 锚：qa_required=1 现有链 / 三段式三相位 / implement role hold / HOLD_ALIGN 未设 | 行为逐字不变（HOLD_ALIGN=0 已删 = 有意例外，测 guard===isReviewHeld） | 红线 |

硬安全计数器（恒为 0，测试断言 + 生产可查 SQL 落 doc）：live 卡 >1 的 execution、active-无-binding 卡、stale-点击-无-回应（7d 窗口内）、stale ✅ 写入的 approval。

## 7. 真机 E2E（隔离环境，非生产 FLYWHEEL_STATE_DIR）

1. 重放 flag 批形状：no-three-stage code-PR run 进 awaiting_review → 确认卡被扣 + Lead 收原因（E1）。
2. manual-enroll + 独立 QA PASS → 卡放行发出（E4）。
3. head 前移 → 旧卡 edit 置灰 + 新卡唯一（E6）；点旧卡 ✅ → 收到明确回应（E7）。
4. 证据：pane 截图 + DB 行 dump（sanitized）落 `engineering/doc/FLY-1251-ship-gate-contract/qa-evidence/`，先于 gate 呈报。

## 8. 文件清单（预期改动）

**PR-1**：`teamlead/src/bridge/auto-qa-held.ts`（谓词扩展 + guard 旁路删除）· `teamlead/src/bridge/ship-relevant-diff.ts`（新）· `teamlead/src/StateStore.ts`（`ship_relevant_diff_snapshot` 迁移 + `auto_qa_record.enrollment_source` 列 + 读写方法；独立加性块）· `teamlead/src/bridge/auto-qa-coordinator.ts`（onMainAwaitingReview 触发 snapshot 计算 + onQaResult 第 1 步 manual 放宽）· manual-enroll 路由注册（`plugin.ts` 路由表，同 fleet console 框架）· deferred-approval 分类表加 `qa_evidence_missing` · 各 `__tests__`。
**PR-2**：`teamlead/src/StateStore.ts`（`founder_ship_card` 迁移 + CAS 方法）· `teamlead/src/bridge/gate-poller.ts`（发卡流程改造 + retired 扫描 + 通道谓词接线）· `teamlead/src/bridge/event-route.ts`（retireShipGate 调用面接卡 retire）· `teamlead/src/bridge/auto-qa-coordinator.ts`（rebind 先 retire 旧卡）· founder-reply 回复文案（active 卡链接）· 各 `__tests__`。
若发现必须触碰 `ship-eligibility.ts` / `write-gate-response.ts` / `actions.ts`（1244 域）→ **先回 Lead 再动**。

## 9. 与后续接缝

| 接缝 | 归属 |
|---|---|
| R4 ship_subject 全量 + R7 freeze_epoch（§5.1/5.2 契约） | 新子单，挂 FLY-1211 伞下（design 已到 schema 级） |
| merge 闸终态（§5.3） | 1244 commit B 落地后（本单收尾 commit 或并入子单） |
| claim 证据源接入 evidence-source 接口 | 1244 commit B 落地后一行实现 |
| review obligation 集 + `no_qualified_reviewer` 的产生逻辑（R3/R5/R6 全量） | 1244 子单 D 汇合 |
| 非代码工作流 ship-gate（product 模板） | PRD §9 单独规格（不在本 PRD scope） |

## 10. 风险与对策

1. **误伤面**（hold 谓词变严）：main-only + docs-only 豁免 + manual-enroll 逃生口 + Lead 一次性通知（不是静默扣）；E9 byte-compat 锚锁住其余角色/相位。
2. **GitHub API 依赖**：失败 = hold 非放行（安全方向正确）；退避重试防打爆；PR files 分页上限（>100 文件翻页，翻页失败 = 不落 snapshot）。
3. **与 1244 并行 rebase**：文件面隔离（research §H）；StateStore 改动为独立迁移块；发现越界先回 Lead。
4. **卡状态机半失败**：每一步失败路径显式定义（§4.2 括号）+ 重启 reconcile 测试（E5/§4.6-⑨）；安全恒由 DB 态而非 Discord 态承载。
5. **doc drift**：全文符号/语义定位为准，行号仅提示。

## 11. 开放项

无——brainstorm gate 三点已拍板；§5 的实施时序（子单/收尾 commit）由 implement 期按 1244 实际进度定，不阻塞本单。
