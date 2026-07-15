# FLY-1251 ship-gate 契约落地 — 调研

Issue: FLY-1251 (https://linear.app/geoforge3d/issue/FLY-1251/build-fly-1211-ship-gate-契约落地-founder-approval-绑定根治r1-r9主通道-a)
日期: 2026-07-14
基于: exploration.md（含 brainstorm gate 三点拍板：①本单 implement 交 Slice1+2、Slice3 契约级设计实施拆子单；②merge 闸收紧排 1244 后、plan 写明过渡态；③代码 PR 零 policy 豁免——qa.auto:false/skip_labels 只关自动 spawn 不构成 ship 豁免，唯一豁免 = server 算 diff 的 docs-only）

---

## A. QA 证据登记路（Slice 1 核心机制的输入）

### A.1 auto-QA 轨的 verdict 验证链（现状，全部复用）

`AutoQaCoordinator.onQaResult`（`auto-qa-coordinator.ts:1180-1310`）对一条 `qa_result` 事件做五重验证：

1. 报告者 session 存在且 `session_role='qa'`（非 QA 拒 + alert Lead）。
2. verdict 必带 40-hex `prHeadSha` 且 == parent 当前 `pr_head_sha`（缺失/stale 丢弃；同分支前进走 `tryShipGateRebind` fail-closed 五条件）。
3. **必须已有 `auto_qa_record` 行**（无 record → warn + ignore）。
4. `record.qa_execution_id` 精确等于报告者（foreign/stale QA 永不释放别人的 gate）。
5. `record.status === 'running'` 才收 verdict（passed/failed 重放、stuck/superseded 不许晚到 verdict 自动释放）。

PASS → `setAutoQaStatus('passed')` → notifyShipReady → hold 释放。FAIL → `awaiting_retest`（QA park 复用）。

### A.2 结论：人肉/独立 QA 今天进不了这条链

Lead 手动 dispatch 的独立 QA runner（如今天 flag 批的 QA·FLY-1246~1250）不是 coordinator spawn 的 → 没有 record 行 → 它发的 `qa_result` 在第 3 步被 ignore。今天的 GATE RULE 靠 Lead 人肉记分板扛。**止血片若只加 hold 不给登记路，会把当前唯一合法的人肉 QA 流程也焊死。**

### A.3 登记路方案比较

| 方案 | 形态 | 评估 |
|---|---|---|
| **A（选定）manual-QA enrollment** | Bridge admission API：Lead 注册一条 manual QA attempt → 创建 `auto_qa_record`（status=running，`qa_execution_id`=指定 QA session，PK=parent_execution_id+head）→ 后续 verdict 走 A.1 的同一条五重验证链 | 完全复用现有 record 状态机（superseded/rebind/awaiting_retest）、hold 谓词（isQaHeld）与 ship 闸查询（evaluateQaShipGate qa_required=1 分支）零改动就能看见证据；一处新增 API |
| B 新表 manual_qa_evidence | 平行证据表 + hold/ship 闸两处各加一个查询 | 双轨证据 = 两个真相源，hold 与 merge 闸要各自学会第二张表；PRD 病因「同一事实两处表达」再现 |
| C 直接写 claims（qa_passed） | 走 1232 substrate | claims 读切换归 1244（READ 无生产读点，enrollment/credential 都是 1244 交付）；1251 抢跑 = 撞车 |

方案 A 的 API 形态参照 1244 §4.5c 的 `POST /api/workflow/re-qa`（loopback + confirmToken，内部运维动作非 founder 变更）；幂等键 =（parent execution, head）= record PK 天然承担。

## B. docs-only 的 server 端客观判定（唯一合法豁免）

### B.1 现有 diff 数据源盘点

- `sessions.changed_file_paths`：`ExecutionEvidenceCollector.collect`（`edge-worker/src/ExecutionEvidenceCollector.ts:55`）在 completion 时刻从 **runner worktree** 跑 `git diff --name-only <base>..HEAD` 得到。虽是 server 进程 exec，但 (a) 数据源是 runner 可写的 worktree、(b) 是 completion 时刻的快照不绑后续 head、(c) best-effort（失败落空数组 + partial 标记）。**不可作为豁免权威。**
- GitHub PR files API（`gh pr view --json files` / REST `/pulls/{n}/files`）：**merge 时真正进 main 的内容的权威**，天然绑 PR 当前状态。
- canonical repo 本地计算：Bridge 在主仓 checkout fetch 后 `git diff --name-only $(git merge-base origin/main <head>)..<head>`——权威且离线，但要保证 fetch 新鲜度。

### B.2 结论

豁免判定 = **Bridge 侧对（PR, head）二元组计算**，权威源取 GitHub PR files API，失败（网络/rate limit/字段缺失）一律 **fail-closed = 按 code PR 处理**（要 QA 证据，绝不因「判不出」而豁免）。判定结果按（execution, head）缓存；head 变了重算。allowlist 语义遵 PRD R4：**默认每个可 merge 文件都 ship-relevant**，docs-only 豁免路径集合是受信、进 run 快照的静态 allowlist（plan 给精确集合），绝不消费 runner 自报的 `changed_file_paths`、绝不认 label。

## C. 卡状态机的存储形态（Slice 2 输入）

### C.1 现有模式盘点

- `ship_gate_msg_binding`（`gate-message-binding-store.ts:28`）：session_event 承载、per (questionId, prHeadSha) **write-once**、读侧 `selectCurrentBinding` 恰一条 fail-closed。适合不可变绑定，**不适合**有状态转移（posting→active→retiring→retired）的实体。
- 1244 的 DDL 风格：专用表 + CHECK 约束 + 部分唯一索引（如 `ux_submission_live … WHERE consumed_at IS NULL AND revoked=0`）+ append-only trigger + `IF NOT EXISTS` 幂等迁移。

### C.2 结论

新表（`founder_ship_card`），**at-most-one-active 用部分唯一索引在 schema 层强制**（`CREATE UNIQUE INDEX … ON founder_ship_card(execution_id) WHERE state='active'`——DB 层机械保证 R1 不变量，不靠代码纪律），状态列 CHECK（posting/active/retiring/retired），转移走 CAS UPDATE（`WHERE state=:expected`，0 行 = 竞态失败 fail-closed）。message-id 落列 → retired 卡的 message-id 集合天然可查（R9 stale 点击回应的扫描面）。

### C.3 Discord 消息层动作

对 retired 卡：**edit 置灰**（内容改为「已过期 → 指向活卡」）优先于 delete（保审计痕迹 + founder 视觉连续性）；edit 失败降级为仅观测（binding/状态机已保证点击安全失败，edit 只是 UX 层）。edit/delete 都是 best-effort 副作用，安全性永远由 DB 态保证——与现状「安全只在 CommDB+binding 层」的架构原则一致。

## D. stale 点击回应（R9）的实现面

现状 reaction pass 只扫 pending gate 的 bound message（`gate-poller.ts:3278-3280`），retired question 不 pending → 旧卡 ✅ 根本不被读。要「每次点击有明确回应」：

- 扫描面扩展 = 对 `founder_ship_card` 中 state='retired' 且 retired_at 在观测窗口内（建议 7 天）的 message-id 也跑 reaction 检查；发现新 ✅ → 回一条 thread 消息「这张已过期，活卡是 <link>（或：当前没有待批卡，原因 X）」+ 幂等 marker（per message-id + reactor + 回应次数上限）防重复回应。
- 成本：GatePoller 已有 per-tick Discord reaction 轮询基建（`evaluateReactionSource`）；retired 集合有窗口上界。

## E. merge 闸过渡态（Tadashi 拍板 ② 的落地输入）

- 止血片（Slice 1）只堵**发卡面**（reviewHoldReason）。merge 侧 `evaluateQaShipGate` 的 `qa_required=0 → qa_not_required` 放行暂留——过渡期风险由程序性兜底盖住：所有 merge 本就 founder-gated 且 Lead 人肉执行 verify-approval 链（merge 侧在人肉闸后面，不裸奔）。
- 终态（排 1244 commit B 落地后）：`evaluateQaShipGate` 的豁免语义按拍板 ③ 重写——`qa_required=0` 不再等于 ship 豁免；merge 侧独立重算「docs-only ∨ 有 QA 证据」，与 1244 真值表 (c)/(e) 合并成一张表。此改动落 `ship-eligibility.ts` = 1244 正在改的文件 → 时序上必须后行（本单 plan 把终态语义写成契约，实施排子单或 1244 落地后的本单收尾 commit，视 implement 时 1244 进度定）。

## F. Slice 3（契约级设计，实施拆子单）的输入

- **R4 canonical ship_subject**：范式 in-toto/SLSA subject digest（PRD §12 + 1135 DR 报告）；1244 已交半步（git_head subject + 单一 head-authority resolver + verify-approval head 权威 endpoint）。全量 = versioned 序列化 schema（repo/run 身份、policy 版本、paths、operations/renames、file modes、per-file before/after blob id）+ 干净 rebase 携带 + shadow-compare 期。
- **R7 freeze_epoch**：定义域 = readiness barrier 成功后 → 授权/ship 完成。已知第一方 writer：runner `progress`（已有「session 非 running 拒绝」半保护，但 awaiting_review 状态下呢——research 确认：`progress` 的拒绝条件是 session 非 running，awaiting_review 会拒 → progress 面已闭）；QA-evidence commit（FLY-945 允许的 head 前进——freeze_epoch 语义下应算「有人按钮」的合法动作，经 rebind 链）；doc/archive commit。机制 = server-owned mutation lease + 外部写检测（对比 freeze 时 head）→ 原子作废 epoch/卡 + 显式原因。
- 两者都依赖 R1 的 gate epoch 实体先落地（founder_ship_card 就是 epoch 的载体雏形）。

## G. R5/R6 泛化的现状锚点

- `codex-gate.ts` 只认 `main|implement` 角色（1244 plan §R5 现状精确版同源事实）；反向 lane 永远选 Claude reviewer；FLY-1224 C10 未进 main。
- 1244 commit C 交 `manifestReviewFamilyOk`（resolved-family 比较器）+ 三种子模板（QA 一等节点）。
- 1251 的 R5/R6 增量收敛为：(a) 发卡 barrier 的 obligation 判定消费「required review 满足」而非「Codex 记录存在」——Slice 2 的 barrier 谓词留接口，具体 obligation 集接 1244 子单 D；(b) R6「无合格 reviewer → 顶住 + 显式原因，绝不 auto-exempt」写进 hold reason 枚举。**不在本单做存储/命名泛化迁移**（归 1244 子单 D 域）。

## H. 与 FLY-1244 的文件面冲突清单

| 文件 | 1244 动 | 1251 Slice1+2 动 | 处置 |
|---|---|---|---|
| `flywheel-comm/src/ship-eligibility.ts` | commit B 真值表重写 | 终态 merge 闸收紧（排后） | 1251 implement 期**不碰**；终态语义只进 plan 契约 |
| `teamlead/src/bridge/approval-signal/write-gate-response.ts` | commit A 增强为 writeFounderApproval | 不碰 | — |
| `teamlead/src/StateStore.ts` | commit A/B/C 多表 | 新增 founder_ship_card 表 + manual-QA API（纯加性、独立迁移块） | 加性共存，rebase 低风险 |
| `teamlead/src/bridge/auto-qa-held.ts` | 不碰（1244 只读 reviewHoldReason 语义） | **主战场**：新 hold 原因 | 1251 独占 |
| `teamlead/src/bridge/gate-poller.ts` | 不碰 | 发卡点接卡状态机 + retired 扫描 | 1251 独占 |
| `teamlead/src/bridge/actions.ts` | commit A 改路由 | 不碰 | — |
| `flywheel-comm/src/commands/qa-result.ts` | commit B 提交面（enrolled 轨） | 不碰（manual 登记走 Bridge API，verdict 仍走现有 qa_result 事件） | — |

## I. 结论（喂给 plan）

1. Slice 1 = `qa_evidence_missing` hold（auto-qa-held.ts）+ docs-only server 判定（GitHub PR files API，fail-closed）+ manual-QA enrollment API（复用 auto_qa_record 全链）+ 删 `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 旁路。零 policy 豁免语义（拍板 ③）。
2. Slice 2 = `founder_ship_card` 状态机表（部分唯一索引强制 at-most-one-active）+ 发卡链接入（GatePoller）+ retired message-id 观测 + stale 点击回应 + 通道中断 retire/block + 文字批准指向活卡（R9）。
3. Slice 3 = R4/R7 契约级 schema 写进 plan 附录，实施拆子单。
4. merge 闸终态语义写进 plan 契约，实施排 1244 后。
