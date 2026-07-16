# FLY-1307 — QA 验证报告 Round 2（当前 head 5304f12fd）

Issue: FLY-1307
日期: 2026-07-16
基于: plan.md (v1.35, Codex design APPROVED 5 轮) · qa-report.md (Round 1, 旧 head) · PR #617

## 0. 结论

**PR-7 = PASS**（本分支实际提交的切片，head `5304f12fd`）。

**FLY-1307 (子单D) ≠ 完成** —— PR-8 在本分支**完全不存在**（§3 铁证）。合入 #617 只落
1/3 片。这不是 QA 缺陷（plan §1 预定的增量切法），但**关单标准未达**（plan 纪律 a）。

新增 1 条 MEDIUM（§4：plan §2.3 首条验收「eng 等价 harness」未实现），非阻塞、建议
随 PR-8 处理，交 Tadashi 裁定。

## 1. 本轮范围 = Round 1 之后的 delta

Round 1 (qa-report.md) 验的是旧 head。其后两个提交：

| commit | 内容 | Round 1 是否覆盖 |
|---|---|---|
| `a6695f9fb` | chore(progress) 7/8 | 否（无语义） |
| `5304f12fd` | **fix(workflow): contain engine dispatcher reconcile failures**（code review R1 HIGH 修复）| **否 —— 本轮主目标** |

## 2. R1 HIGH 修复核验（`5304f12fd`）

**修复对象是真生产路径**：`plugin.ts:4742` `workflowEngineDispatcher?.start()` 在 Bridge
boot 路径上。修复前 `void this.reconcile()` 无 `.catch`，reconcile 一旦 reject =
Bridge 进程 unhandled rejection。修复加两层围栏：`start()` 的初次+定时 `.catch` +
`reconcile()` 内 top-level catch（返回 partial `result`，`finally` 复位 `reconciling`）。

### 2.1 两条新测**突变验证**（非空过 —— 关键，不接受「绿=有效」）

| 突变 | 期望 | 实测 |
|---|---|---|
| `start()` 还原成裸 `void this.reconcile()` | test 1 红 | ✓ **恰 test 1 红**（1 failed \| 8 passed）|
| 删 `reconcile()` top-level catch | test 2 红 | ✓ **恰 test 2 红**（1 failed \| 8 passed）|

每个突变**只**打红它对应的那条 → 两条测试各自真的在守自己的断言，且互不遮蔽。
突变后**逐字还原**，`git diff HEAD` 空。

### 2.2 观察（非缺陷，记录备查）

`reconcile()` 内层 try 只包 `consume(intent)`；若 `getWorkflowRun()` 对某 intent 抛，
top-level catch 会**中断整个循环**，该 tick 剩余 intent 既不 started 也不 held（静默跳过）。
因 outbox 行是持久的、下 tick 重试，且此路径只在 DB 不可用时触发（届时全局已坏），
判定为**可接受的有意收敛**，非缺陷。

## 3. 范围铁证 —— PR-8 不存在（**带阳性对照**）

plan §4.1 钉死 PR-8 的唯一新杆 = `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH`。同一把尺子
同时量三个（前两个为**已知存在**的阳性对照，证明尺子没坏）：

| flag | 结果 |
|---|---|
| `FLYWHEEL_WORKFLOW_CLAIMS_READ` | **PRESENT (9 files)** ← 阳性对照 |
| `FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES` | **PRESENT (12 files)** ← 阳性对照 |
| `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH` | **ABSENT (0 files)** ← PR-8 的杆 |

旁证：`git diff main...HEAD -- scripts/` = **0 行** → plan §4.3 要求的真机 E2E
`scripts/qa-fly-1307-template-dispatch-e2e.mjs` 不存在；无 enable 决策材料；
PR-7.5 materializer 仍是 `unavailableMaterializedHeadAuthority`（fail-closed 接口）。

> **方法论留痕**：本节初版用 `grep ... | head` + `|| echo ABSENT` 得出「absent」——
> `head` 吞掉退出码使 `|| echo` 永不触发，且首个阳性对照串写错（漏 `_WORKFLOW`）返回空。
> 「absent」当时**是坏尺子的产物**。改用 `grep -rl | wc -l` + 两个真阳性对照后才成立。

**结论**：合入 #617 后，D 仍需 PR-7.5（materializer）+ PR-8（派发启用）两次独立 dispatch。

## 4. MEDIUM —— plan §2.3 首条验收「eng 等价 harness」未实现

plan §2.3 第一条要求：内建 engine_owned v1 eng run，驱动
design→implement→qa→founder_gate 全链 + qa_fail 回环 + max 超限 escalate，**逐事件比对
今天 phase-orchestrator belt 的行为快照**（交接顺序/回环轮数/门行为逐字等价）。

**未找到**（阳性对照：`engine_owned` 命中 2 个测试文件 = 尺子有效）：
`equivalence` 仅命中 `StateStore.fly663-migration`（getRowsModified 等价）与
`companion-safety-contract` —— 均与本主题无关；`belt snapshot` / `phase-orchestrator belt`
均 0 命中。即**没有对照 legacy belt 的差分 harness**。

**为何仍判非阻塞**：
- 覆盖并非空白 —— 转移事务矩阵已逐条覆盖 plan §2.3「新增矩阵」：合法边恰一/
  非法转移拒/qa_fail 有界回环/qa_pass 门边/loop-limit escalate 重放/竞争写者 fail-closed/
  非当前节点拒（9 条，全绿）。
- **default-off**：`engine_owned DEFAULT 0`，等价性只在 enable 后才有意义，而 enable 属 PR-8。
- Codex code review 已在**同一 head** APPROVED（§5），设计段 5 轮过审。

**建议**：harness 随 PR-8 落（PR-8 本就要跑全链真机 E2E，天然同址）。**交 Tadashi 裁定**——
若判 PR-7 必须自带，则本条转 kickback。

## 5. 门禁与回归实测（全部对**当前 head**）

| 项 | 结果 |
|---|---|
| CI「Build & Test」 | ✓ **绿**，run 29539445730 `head_sha=5304f12fd4…` = PR head **逐字一致** |
| Codex code review | ✓ **approved** @ `5304f12fd4`（exec `1476385e`，author=codex / reviewer=claude，**跨厂商倒置不变量满足**，22:28:28）|
| PR-7 面定向套件（11 文件）| ✓ **169/169** |
| `flywheel-config` 全量 | ✓ **439/439** |
| 注册表 drift 防护 | ✓ **真有效**（见下）|
| 工作树 | ✓ 突变后 `git status --porcelain` 空；HEAD == PR headRefOid |

### 5.1 progress.md 的 nextStep 是**陈旧**的（更正记录）

ledger 写 `nextStep: ... commit, push, and request R2`。**DB 权威推翻它**：R2 已跑且
approved（22:28:28，commit 22:24 后 4 分钟）。「待 R2」是账本没回写，不是活儿没干。

### 5.2 注册表 drift 防护 —— 独立突变验证（不采信 Round 1 的转述）

- `node-type-registry.test.ts` 第 4 条是**自突变**哨兵：运行时把 `design.isPhaseRole=false`
  再断言 `isThreeStagePhaseRole("design")` 跟着变 → 结构上不可能空过 ✓
- **但**第 1 条「byte-compatible」的 badge 腿是**同义反复**：`PHASE_THREAD_BADGE[p]`
  就是 `NODE_TYPE_REGISTRY[p].badge`（three-stage-phases.ts:281-287），等于自己比自己。
- **真突变裁决**：registry `badge: "🎨设计"` → `"🎨DRIFT"` 跑 config 全量 →
  **`fly892-phase-tag.test.ts`「returns Annie's locked stage badges」红**。
  → **badge byte-compat 确有硬钉**（FLY-892 里的字面量），只是不由该哨兵的这条腿守。
  该腿冗余，**非缺陷**。（初判疑似空过 → 突变后证伪，据实修正。）

## 6. 交付判定

- **PR-7（#617 @ 5304f12fd）：PASS** —— 可作为独立 default-off 切片合入（plan §1 三片
  各自 review+merge 即此意）。生产零行为变化。
- **FLY-1307：未闭**，缺 PR-7.5 + PR-8。**合入 #617 不得标 D 完成。**
- 待 Tadashi：① §4 harness 归属（PR-7 补 or 随 PR-8）；② 是否现在就单独 ship PR-7。

## 7. head 纪律警告（FLY-945 / 影响 ship）

Codex 批准 **sha-bound 到 `5304f12fd`**。本报告一旦 commit+push，head 即变 →
该批准不再匹配新 head → `verify-approval` 会拒 → ship gate 无法绑定，**除非**对新 head
重跑 Codex code review + 新 head 的 QA PASS 裁决。
本轮 QA 的**代码**结论针对 `5304f12fd`；其后 delta 为**纯文档**，无代码语义变化。
