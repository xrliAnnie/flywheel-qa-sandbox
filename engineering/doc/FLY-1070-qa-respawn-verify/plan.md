# FLY-1070 替身 QA 验证 PR #528 — 实施计划

Issue: FLY-1070 (https://linear.app/geoforge3d/issue/FLY-1070/qa-fly-1050-独立验证-pr-528三段式死-qa-干净重生)
日期: 2026-07-09
基于: research.md

## 0. 摘要

独立真机 QA，验证 PR #528 head `5da5fd18`（三段式死 QA 干净重生）。五个验证面：定向单测复跑、回归 fixtures 逐个验（含 F8 独立行为补位）、F10 Done-否决缺口实证、隔离 module-driven 行为 E2E（**cap=3 failClosed 对照组 MANDATORY**——Lead brainstorm gate 补充硬要求）、复用全仓甄别结论。产出 qa-report.md + evidence/ + verdict（`qa-result --target-exec eb8f00a6-286e-4fa2-b830-37cd3054c201`）。**不改 PR 源码、不 push flywheel-FLY-1050 分支、生产 DB 只读、绝不 ship。**

方案取舍与 Lead 拍板见 exploration.md §3-4；全部代码/测试/取证锚点见 research.md（Implement 段直接引用，不重查）。

## 1. Verdict 判定规则（先定规则再跑证据）

| 结果类 | 触发条件 | 出口 |
|---|---|---|
| **PASS** | 面 1/2/4 全绿 + F10 结果与预期一致（缺口存在但属 fast-follow 类，或意外发现已覆盖） | `qa-result --status pass --target-exec eb8f00a6-…` + [FLY-1050] thread 报告（报告内如实含 FAIL-partial 分级段与 fast-follow 建议） |
| **FAIL** | 任一：交付路径断言失败（F1-F7/F9 复跑红、E2E 剧本断言失败、cap/escape-hatch 对照组失败）；F8 形态防御错误（崩溃/误 respawn/误算 progressed）；head 校验不符 | 不发 pass；[FLY-1050] thread 踢回具体证据（fixture、命令、输出、期望 vs 实际） |
| **FAIL-partial（随 PASS 报告分级上报，不阻塞）** | F10 Done-否决缺口被行为实证（预期结果）——issue 原文已授权「未覆盖 = 如实报 FAIL-partial 并列为 fast-follow，不阻塞主修复」 | PASS 报告内独立段：缺口描述 + 复现 fixture + fast-follow issue 建议文案 |

灰区处理：证据矛盾或无法归类时不猜——报 Lead（`flywheel-comm ask`）带证据，等答复期间继续其他面。

## 2. Step 0 — 环境准备与 head 校验（含预检门）

1. `git fetch origin flywheel-FLY-1050`；断言 `git rev-parse origin/flywheel-FLY-1050` == `5da5fd18…`（漂了 → 停，报 Lead：head 已动，QA 目标失效）。
2. `gh pr view 528 --json state,headRefOid`：state OPEN、head 一致；CI（Build & Test）GREEN at head。
3. 自建 worktree：`git worktree add worktrees/qa-fly-1070 5da5fd18 --detach`（**绝不用** `/Users/xiaorongli/Dev/flywheel-FLY-1050`——那是 parked implement 的工作区且有未 push 本地 commit）。
4. `pnpm install`；build teamlead 包产 dist（harness 一律 import dist 产物，非 src——「重建 dist」是 issue 面 1 的明文要求）。
5. 负载预检：`uptime` load 与可用内存合理（OOM 恢复期纪律）；所有测试/harness **串行**跑，禁并行 vitest 全开。
6. evidence 目录：`engineering/doc/FLY-1070-qa-respawn-verify/evidence/`（命令、原始输出、fixture 定义逐条落盘）。

## 3. Step 1 — 验证面 1：定向单测独立复跑

在 QA worktree 内（teamlead 包）逐文件串行：

```
pnpm vitest run src/bridge/__tests__/phase-orchestrator.test.ts
pnpm vitest run src/bridge/__tests__/phase-orchestrator.fly1050-qa-respawn.test.ts   # 32 tests 必须全绿
pnpm vitest run src/bridge/__tests__/phase-orchestrator.fly939-wake-not-respawn.test.ts
pnpm vitest run src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts
pnpm vitest run src/__tests__/DirectEventSink.test.ts
pnpm vitest run src/__tests__/event-route-fly921-turn-belt.test.ts                    # 绑 127.0.0.1，host 直跑
pnpm vitest run src/__tests__/actions-fly1050-terminate-qa-loss.test.ts               # 同上
pnpm vitest run src/__tests__/crash-reaper.test.ts
pnpm vitest run src/__tests__/StateStore.three-stage-qa.test.ts
```

断言：9 文件全绿零 fail/零 skip 异常；orchestrator ×4 合计 tests 数对得上 implement 交接口径（135；以实跑输出核数，差异如实记录并解释）。任何红 → 先按 systematic-debugging 甄别（QA 环境因素 vs 真回归；对照 base `355a598c` 同法复跑该文件），真回归 = FAIL。

## 4. Step 2 — 验证面 2：回归 fixtures 逐个验

**2a. F1-F7/F9 映射核对**（复跑已在 Step 1；此处逐条把 issue 提法映射到实跑通过的具体测试名，写进 qa-report 的 fixture 对照表——见 research.md §2 映射表，含 F9 的 3 条测试）。

**2b. F8a-F8d 独立行为 harness**（`evidence/qa-f8-harness.mjs`，import dist，一次性、不进 PR）。按 research.md §3 形态规格构造。**构造分两桶**（Codex R1 #1：StateStore 的 `sessions.issue_id` 是 `TEXT NOT NULL`，NULL 形态在真 StateStore 不可构造——NULL 只存在于 CommDB 侧）；**每个子 case 必须标注证据来源标签**（Codex R1 #3）：`real-store` / `CommDB-only` / `fault-injected` / `code-audit`，标签跟随进 qa-report：

- F8a（CommDB 孤儿，**CommDB-only**）：CommDB 有 row（running、issue_id=NULL）而 StateStore 无 row 的 execId → 调 `reconcileQaLoss` → 断言不 throw、`startDispatcher.start` 零调用（getSession→undefined 走 main-role 默认路径 no-op）；
- F8b（dead main-role row，**real-store**）：同断言（与 head F7 单测互证）；
- F8c（issue_id 形态矩阵，拆两半）：
  - **real-store** 半：issue_id=空串 / 跨 project issue 的死 qa row → scoped + boot 双路径 → 不崩、零误 spawn；
  - **fault-injected** 半：查询异常 fail-closed 路径——经依赖级 throwing seam（harness 包一层 deps，`listPhaseSessionRows` 抛错）注入 → 断言 `hasProgressedPastImplement` 返回 progressed（不重驱）、告警日志出现；明确记录该断言属于注入故障 case，不冒充 real-store 覆盖；
- F8d（scope-free，**code-audit** + real-store 佐证）：审计记录 reconcile 路径无 checkLeadScope 类检查（引用行号）+ harness 中跨 project fixture 可被 reconcile 遍历到但因判据 no-op。

任何形态崩溃/误 respawn/误算 progressed → **FAIL**。全过 → PASS 附注：「F8 命名 fixtures 未随 PR 落库（addendum 未落 git），QA 已独立行为验证（各 case 证据来源标签见对照表）；固化归 FLY-1066 fast-follow」。

**2c. FLY-1018 现场重构**：按 research.md §4 口径（implement@awaiting_review + qa failed ×2 均无 intent）在 harness 里独立重构 → 断言重生 spawn 恰 1 次（与 F2 单测互证）。

**2d. F9 生产真实 marker 验证**：fixture 的 implement row 带生产真实串 `merge_without_approval:review_question_unbound/qa_snapshot_missing_exempt` → `reconcileQaLoss` + boot 双路径 → 零 spawn、零告警（isMergeBlocked 非空真值检查对生产形态真截断）。

## 5. Step 3 — 验证面 3：F10 Done-否决缺口实证

1. **样本现状防御验证**（**real-store**）：按 research.md §4 的 FLY-1023/FLY-1047 真实 DB 形态（无 implement@awaiting_review）构造 fixture → 断言 #528 的 QA-respawn 对现状**不触发**（reconcileQaLoss no-op、boot skip）——证明两例实锤不是本 PR 的暴露面。
2. **缺口类实证**（**real-store** + **code-audit**）：构造「issue 已 Done（Linear 状态与 StateStore 无关联字段——正是缺口本体）+ implement@awaiting_review + 死 qa row + 无 ship claim + 无 merge_block」→ boot reconcile → 断言 **spawn 被触发**（行为证明判据无 Done 否决）；辅以判据函数的 code-audit 引用（research.md §1）。F10 各子 case 同样带证据来源标签进报告。
3. 产出：FAIL-partial 段（缺口描述、复现 fixture、真实世界后果=替身 QA 模式 ship 后父单 implement 即此形态、FLY-1050 的 eb8f00a6 将成活标本）+ fast-follow issue 建议文案（判据补 issue-Done 硬否决，或 ship 收尾时终结 awaiting_review implement row——方案取舍留给 fast-follow，QA 不越权设计修复）。
4. 意外分支：若实证发现 head 实际**已**覆盖（spawn 未触发）→ 修正结论为「F10 已覆盖」，报告说明覆盖机制，无 FAIL-partial。

## 6. Step 4 — 验证面 4：隔离 module-driven 行为 E2E

harness（`evidence/qa-e2e-harness.mjs`）按 research.md §5 接线：真 dist + 真 StateStore/CommDB（tmp）+ 真 express 双挂载 router + 真 PhaseOrchestrator/DirectEventSink/event-route/crash-reaper 闭包；fake 仅 3 面（startDispatcher 记录+落 alive row+模拟 pre-launch grant；可注入 tmux probe；Discord/alert 出口记录）。

**harness 硬规则——fire-and-forget 面的确定性等待**（Codex R1 #2）：terminate route 是 `void reconcileQaLoss(…).then(reconcileTurnBelt(…))`，HTTP 响应先于 respawn 链完成返回；crash-reaper 回调同为 fire-and-forget。因此：
- 每个经 `/api/actions`、`/actions`、crash-reaper 回调触发的剧本，断言前必须对可观察状态做**有界轮询等待**（`startDispatcher.start` 调用、CommDB turn holder/epoch、thread-note/alert 记录、belt 副作用）——模式对齐 head 既有测试的 `vi.waitFor`（`actions-fly1050-terminate-qa-loss.test.ts` 已示范这是真实时序属性）；
- **负向断言**（零 spawn、零告警）同样等满同一有界静默窗口后再判，不许「立即读到零」当通过；静默窗口时长须覆盖与正向轮询相同的异步面，**所选 timeout 记入 evidence**（后续 reviewer 能区分「事件真没发生」vs「看早了」——Codex R2 non-blocking note）。

剧本（每条独立 tmp 环境，串行）：

| # | 剧本 | 断言 |
|---|---|---|
| E1 | 基线：implement@awaiting_review + QA alive → 经 `/api/actions` terminate 杀 QA | 事件驱动（非 boot）respawn：start 恰 1 次、sessionRole=qa、startPoint=implement head、shareParentBranch；CommDB turn：holder=新 QA、epoch 严格 +1、零 STALE-TURN 告警；thread note 恰 1 条 |
| E2 | 同 E1 经 `/actions` dashboard alias | 同 E1（双挂载都触发——FLY-175 教训） |
| E3 | terminate 返回 success=false + cleanupPending=true（probe 注入 alive） | qa-loss 照触发；spawn 被 ghostGuard fail-closed 挡 + 告警；belt TURN 不动（terminated 不进终态快路径） |
| E4 | session_failed 事件路径（DirectEventSink.emitFailed 与 event-route 各一次） | qa-loss 先于 belt reconcile；respawn 同 E1 断言 |
| E5 | crash-reaper 钩子（onQaPhaseTerminated 闭包） | respawn 触发 |
| E6 | **cap 风暴（MANDATORY，Lead 点名）**：连杀 3 轮（每轮 respawn 后再杀新 QA） | 第 1、2 轮 respawn 成功（epoch 递增）；第 3 条死 row 后触发 → **failClosed 告警 + 零 spawn**；再触发仍零 spawn、告警再发（离散事件语义） |
| E7 | **escape-hatch 对照（MANDATORY）**：`FLYWHEEL_THREE_STAGE_QA_RESPAWN=0` 重放 E1 fixture | scoped no-op、boot 判据回退 row-exists（skip）——修复前行为；同时验证 stranded-pass terminated 硬化**不**随开关回退（=0 下告警仍发） |
| E8 | 幂等/并发：respawn 落 alive row 后重触发；同 issue 双并发 reconcileQaLoss | no-op；spawn 恰 1 次 |

每条剧本的 fixture 定义、注入序列、原始输出落 evidence/。E6/E7 任何偏差 = **FAIL**（防 respawn 风暴命门，无灰区）。

## 7. Step 5 — 收尾：报告、verdict、交付

1. `qa-report.md`（本文件夹）：五面结果矩阵、fixture 对照表（**每个 F8/F10 子 case 保留证据来源标签 real-store / CommDB-only / fault-injected / code-audit**，PASS 证据必须来源诚实）、F8 附注、F10 FAIL-partial 段 + fast-follow 建议、evidence 索引、head/CI 校验记录。
2. verdict 按 §1 规则判定：
   - PASS → `node …/flywheel-comm/dist/index.js qa-result --status pass --target-exec eb8f00a6-286e-4fa2-b830-37cd3054c201`；
   - FAIL → 不发 pass，证据踢回。
3. 报 Lead（LEAD REPORT-BACK 协议）：`flywheel-comm ask --lead flywheel-eng-lead --report "DONE: FLY-1070 QA verdict=… | evidence: engineering/doc/FLY-1070-qa-respawn-verify/ | PR: n/a(QA)"`，并在 [FLY-1050] thread 报告（经 Lead relay，Runner 不直投 Discord）。
4. 文档/evidence 随本分支 commit + push（QA 自己的 FLY-1070 分支；**不碰** flywheel-FLY-1050）。
5. 清理：QA worktree（`git worktree remove worktrees/qa-fly-1070`）待 verdict 被 Lead 确认后再删（QA 证据留到验收完——纪律）。

## 8. 风险与边界

| 风险 | 缓解 |
|---|---|
| head 在 QA 期间漂移 | Step 0 预检 + verdict 前复核 `origin/flywheel-FLY-1050` 仍 == 5da5fd18；漂了停手报 Lead |
| OOM 恢复期负载 | 串行跑、单 worktree、不占 529 Room、不起真 runner、不重启 Bridge |
| harness 假绿（fake 面遮蔽真行为） | fake 面最小化（3 面）且每个 fake 都记录调用供断言；关键剧本与 head 单测互证（F2/F7/F9 双源） |
| 误碰生产 | 生产 DB 只读快照；harness 全部 tmp 目录；env 开关只在 harness 子进程 env 里设，不动 shell/生产 env |
| QA 自身红测误判 | 任何红先跑 base `355a598c` 对照（implement 交接同法），QA 环境因素与真回归分清再定级 |
| 越权 | 不改 PR 源码；F10 修复方案不由 QA 设计（fast-follow 只提方向选项）；绝不 ship |
