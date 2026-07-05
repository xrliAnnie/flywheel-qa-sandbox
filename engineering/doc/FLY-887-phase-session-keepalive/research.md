# FLY-887 三段式 phase-session 并存保活 — 调研

Issue: FLY-887 (https://linear.app/geoforge3d/issue/FLY-887/pipeline-三段式-phase-session-并存保活-designimplementqa-不跑完就关qaimplement)
日期: 2026-07-05
基于: exploration.md

## 0. 结论摘要

> **R2 修订（2026-07-05）**：初版 gate 后 Lead 给的「QA 只读 checkout」约束被 Annie 亲自纠正**收回**（三段都要写分支）；Annie steer 定 **🅱️ 单物理 worktree + TURN 轮流写**。本文 §3 已按 🅱️ 重写；§4/§5 受影响行随之修订。TURN 机制设计 + 权威图见 exploration.md R2。

方案 A（brainstorm gate 已批）完全可落地：所需基建（park 标记、mailbox wake、alive→wake/dead→spawn 双路、finalizeDone 收尾边、活跃态保护查询）**全部已存在**，改动集中在 PhaseOrchestrator 的两个动作点 + Blueprint 的 worktree 准备/prompt + 轮次账本 + 新增 TURN 记录。🅱️ 下 worktree 结构零变化（三段本就共享一个 key/目录），git「一 branch 一 checkout」硬约束天然满足（全程只有一个 checkout）。

## 1. 现行机制精确解剖（file:line 为准）

### 1.1 交接链（Design→Implement / Implement→QA）

```mermaid
graph LR
    C[complete --route<br/>phase_design_complete / needs_review] --> M[marker → /events<br/>session_completed]
    M --> S[event-route.ts:2080 +<br/>DirectEventSink.ts:725<br/>每个 session_completed 都调]
    S --> O[PhaseOrchestrator.onPhaseComplete<br/>re-gate: 三段 role + HANDOFF_STATUS]
    O --> H[handoff: capturePhaseHeadSha<br/>→ closePhaseRunner ← 改这里<br/>→ startDispatcher.start]
```

- `phase-orchestrator.ts:194-197`：`HANDOFF_STATUS = {design: "design_done", implement: "awaiting_review"}`。
- `phase-orchestrator.ts:585-653 handoff()`：capture head（fail-closed）→ `closePhaseRunner(prev)` → dispatch next（`shareParentBranch: true`, `startPoint=head`, `resolvePhaseModel(next)`）。
- **`closePhaseRunner` 效果（plugin.ts:4012-4081）比 close-runner 本身更重**：`closeRunner({finalizeDone: true})`（FSM 转 completed + kill tmux/Terminal/CommDB row）**之后还做 `phaseWorktreeCleanup` 把共享 worktree 删掉**（dirty→fail-closed；删不掉→fail-closed）。即今天交接后 worktree 也不在了，下一段 dispatch 在 `startPoint` 重建。
- `event-route.ts:2080-2092`：`onPhaseComplete` 在**每个** `session_completed` 上无条件调用（按 session 当前状态 re-gate）→ 被唤醒的 implement **二次** `complete --route needs_review` 会再次进入 handoff 判定——wake-or-spawn 可直接挂在现有触发点，无需新事件。FSM 无 `awaiting_review` 自环（workflow-fsm.ts:143-150），二次 complete 的 FSM 转移是 no-op，但事件照发、session 行仍读 awaiting_review（FLY-191 的 re-request review 生产已验证此形态）。

### 1.2 QA FAIL 修复循环（FLY-859）

- `phase-orchestrator.ts:354-427 onQaResult()`：verdict intent 持久于 QA session_params `three_stage_verdict`，**一个 QA session 一个 verdict**（`:367-371` "one verdict per lifecycle"）——保活后同一 QA 要出多轮 verdict，**intent 模型必须改为按轮记录**。
- `runFailFlow()（:429-561）`：capture head → `closePhaseRunner(QA)` → `startDispatcher.start({sessionRole:"implement", phaseFixContext:{round, qaSummary}})`。qaSummary **truncate 600 字符**（:415）。
- **轮次 cap**：`countImplementPhases(issueId)`（plugin.ts:3930，数 implement session 行数）`>= 1 + maxFixRounds(3)` → refuse+升级 Lead。**保活后 fix 轮不再新建 session → 此计数永远不涨，账本必须换**（durable per-issue fix_round 计数）。
- 崩溃恢复：`getActiveImplementSession`（:458-469）已实现「活体 implement 在 → adopt 不双开」——wake-or-spawn 判定的现成半成品。

### 1.3 worktree

- `WorktreeManager.resolveWorktreeKey（:79-85）`：`shareParentBranch` → 三段共享 main key（同 branch B 同目录）。
- `Blueprint.runInner（:719-733）`：每次 dispatch **无条件 `removeIfExists()` + `create()`**（`git worktree add -B <branch> <startPoint>`）。
- `-B` 在 branch 已被别的 worktree checkout 时会失败（WorktreeManager.ts:188-189 注释明示）→ **保活下 implement worktree 不删，QA 若仍用共享 key 会直接创建失败**——Lead 的「QA 只读 checkout」约束是结构必然。

### 1.4 三段 prompt 现行协议（Blueprint.ts:889-944）

- design（:903-909）：commit docs → `complete --route phase_design_complete`。
- implement（:911-928）：TDD → PR → APPROVE GATE 流（`needs_review`）；fix 轮（`phaseFixContext`，:921-928）：findings 已在分支上、PR 已存在、push 后走标准 APPROVE GATE。
- QA（:938-944）：**是 branch B 的 writer**（Annie 2026-07-02「give it more permissions」，:862-867）：commit 测试/报告到 B；PASS → qa-result pass + 自己走 APPROVE GATE（QA = ship-gate holder + ship executor）；FAIL → commit findings 到 B → qa-result fail → STOP，**明文「Do NOT park for retest」**（要翻转）。

### 1.5 FSM 边（workflow-fsm.ts:120-167）

- `running → design_done`；`design_done → [completed, blocked, failed, terminated]`（无回边——parked design 被咨询式唤醒不需要变状态，够用）。
- `awaiting_review → [approved_to_ship, completed, rejected, deferred, shelved, terminated]`（无自环、无回 running——woken implement 修复期间状态就停在 awaiting_review，与 FLY-191 单 session 修复循环同形态）。
- **不需要加 FSM 边**（gate 批的「不改 FSM」成立）。

## 2. 可复用基建清单（全部已在生产）

| 基建 | 位置 | 保活用途 |
|---|---|---|
| `declare-state park`（FLY-626） | flywheel-comm declare-state.ts | phase 完成后自 park：CommDB 持久（过 Bridge 重启）、watchdog 全抑制、`flywheel-comm send` 即清（re-engagement）；死 parked runner 仍被 Heartbeat 收割 |
| `parked-alive` class（FLY-229） | terminal-mcp lifecycle.ts:12, index.ts:162 | CommDB completed/timeout + tmux 活 = RE-ENGAGEABLE 的既有分类；Lead 侧可见性已就绪 |
| `sendRunnerWake`（FLY-191/142） | bridge/runner-wake.ts:98 | mailbox wake，带 feedbackText（cap 1500）、no-transport 防护、失败→`runner_wake_failed` 事件 |
| `retestWakeQa` alive→wake / dead→respawn（FLY-752） | auto-qa-effects.ts:464、auto-qa-coordinator.ts:796-868 | wake-or-spawn 双路的完整参考实现（含 CAS retarget、durable retest 标记、wake 失败 held-for-reconcile） |
| `FINALIZE_DONE_SOURCE_STATES` 含 design_done/awaiting_review | close-runner.ts:68-78 | ship 后统一收尾：对活体 parked 段 `closeRunner({finalizeDone:true})` 即可（FSM 边合法） |
| active 查询保护 design_done | StateStore.ts:2462,2487 | parked design 不会被 stale prune / 允许新 run 的判定误伤 |
| FLY-742 stale-blocker guard | plugin.ts:286-300, runs-route.ts:293-300 | PR open 时不误收 parked implement（PR-state 权威检查）；PR merged 后反而是漏收尾的兜底 |
| runs-route 三段防双开守卫 | runs-route.ts:560-571 | issue 有活跃 phase 时拒新 main dispatch——保活后依旧成立（活跃集合更大） |
| `onMainAwaitingReview` 的 freshTransition + merge_block suppressor 模式 | event-route.ts:2053-2075 | 二次 needs_review 判「新一轮」的参考模式；FLY-869 merge_block 姊妹守卫要对齐 |

## 3. worktree 并发模型（R2 重写）：🅱️ 单物理 worktree + TURN 轮流写

> Annie 定案方向（Lead relay）：设计/实现/QA **三段都是 writer**（设计 commit 文档、QA commit test-report/补测试）；🅰️ 各自子分支→汇聚被她否掉（交叉 rebase 链 = 错误温床）；🅱️ 的关键洞察 = 三段基本不同时干活 → 一个物理 worktree 够用，剩下是「写锁/轮流」实现。TURN 机制完整设计 + 权威时序图见 **exploration.md R2.2/R2.3**。

1. **单 worktree 全程存续**：共享 worktree **创建一次、ship 后才删**——handoff 时跳过 `phaseWorktreeCleanup`，后续 phase dispatch 跳过 `removeIfExists+create`，校验（registered + clean + `HEAD==startPoint`）后原地接手；校验不过 → fail-closed 告警（绝不静默拆活人目录）。三段 cwd 同一目录（与现状 `resolveWorktreeKey` 共享 key 完全一致，**worktree key 派生零改动**）。
2. **git 硬约束天然满足**：「一条 branch 不能被两个 worktree checkout」在 🅱️ 下不构成问题——全程只有这一个 checkout；三个 session 只是三个进程共享同一 cwd。
3. **TURN = 显式化的激活权**：任一时刻只有 TURN 持有者碰 worktree（git 写 + 跑测试 + 改文件），其余 parked 完全不碰。授予点=PhaseOrchestrator 既有交接/唤醒决策点；释放点=既有完成/verdict 信号（`phase_design_complete` / `needs_review` / `qa-result`）；真相源=CommDB 新表 `three_stage_turn`（Bridge 独写、跨进程可读、过重启）；runner 写前 `flywheel-comm turn` 自查作 belt；死 holder 由 Heartbeat 收割 + reconcile 重授予。无死锁（事件驱动授予，无阻塞等待）。
4. **QA 协议不变（writer 保留）**：FAIL 时照旧 commit findings/failing tests/report 到 branch B（FLY-793 Step 8 原协议、Blueprint :941-944 文案主体保留）——只把「STOP 等 close」改成「park 等 RE-TEST」。`capturePhaseHeadSha` 语义照旧（QA 有 commit，头就是它的头）。
5. **修复循环零编舞**：implement 在同一目录修完 commit+push → QA 被 RE-TEST wake 时 worktree **已经在新 head**——不需要 fetch/re-checkout/re-pin（这是 🅱️ 对比「独立 QA checkout」模型的直接简化收益）。

## 4. 改动面盘点（现状 → 目标）

| # | 位置 | 现状 | 目标 |
|---|---|---|---|
| a | `phase-orchestrator.ts handoff()` | capture head → close+删 worktree → spawn | capture head → **park**（Bridge 侧 upsert 标记；不 close 不删）→ **wake-or-spawn**（活体 parked 下段在→wake；无→spawn）；前段已死→现行 close-clean+spawn 兜底 |
| b | `runFailFlow()` | close QA → spawn implement-fix | QA 自 park（prompt）→ **wake 活体 parked implement**（带 QA 报告 + round + TURN）；implement 死→现行 spawn 兜底；`capturePhaseHeadSha` 语义照旧（QA 是 writer） |
| c | verdict intent 模型 | 一 QA session 一 verdict | 按轮记录（round-indexed intent 数组或 latest+counter）；**fix_round 账本改 durable per-issue 计数**（替代 countImplementPhases 的 session 数语义），cap=3 语义不变 |
| d | `Blueprint.runInner` worktree 准备 | 无条件 removeIfExists+create | `shareParentBranch` 且共享 worktree 存在且有活体前段 → 校验后原地接手（implement 与 QA 同此路径；**worktree key 零改动**）；不存在/前段死体已清 → 现行 create |
| e | Blueprint 三段 prompts | 完成即 STOP（被关）；QA「Do NOT park」 | design/implement：complete 后 `/compact`+释放重资源 → `declare-state park` → STOP 不退出、parked 期间不碰 worktree；QA：FAIL → commit findings（不变）→ qa-result → park 等 RE-TEST（翻转禁令）；三段共同的 TURN 契约（非 TURN wake 先 `flywheel-comm turn` 自查再动 worktree） |
| f | 二次 needs_review → QA 复验触发 | 不存在（每轮新 QA session） | 复用 onPhaseComplete 现触发点 + wake-or-spawn；对齐 freshTransition/merge_block 守卫模式；QA wake = RE-TEST（worktree 已在新 head，零 checkout 编舞） |
| f2 | TURN 记录（新） | 不存在（激活权隐含在「其余已被 kill」里） | CommDB 新表 `three_stage_turn(issue_id PK, holder_exec_id, phase, epoch, granted_at)` Bridge 独写；orchestrator 授予/翻转；新 `flywheel-comm turn --exec-id` 查询子命令（runner belt） |
| g | ship 后收尾 | 交接时人已关光，finalization 只关 QA 窗 | verified merge → finalization 对 issue 全部三段活体依次 `closeRunner({finalizeDone:true})` + worktree 清理 + archive cascade（既有 FLY-369/855 链扩容） |
| h | `reconcileOnStartup` / 各 sweep | stranded → 重驱 handoff（close+spawn） | 同一 wake-or-spawn 判定；重启后核对 park 标记 vs tmux 活体（死体→Heartbeat 收割→spawn 兜底） |

## 5. 风险确认（研究结论）

- **watchdog 误报**：park 标记全抑制 stall wake（FLY-626）；`parked-alive` 分类已存在；FLY-878（loop/watchdog park 态识别缺口）为姊妹 issue——本 issue 只保证标记正确写/清，识别缺口不重做（gate A6 已批）。
- **stale 检测误伤**：StateStore 活跃查询保护 design_done；FLY-742 guard 以 PR 状态为权威（loop 期间 PR open → 不收）。
- **内存**：3 claude 进程/issue；park 前 /compact + 释放 Chrome（FLY-752 文案现成）；FLY-751 已默认剥非-QA runner 的 chrome MCP；three-stage 仅 flywheel opt-in。**A5 已由 Lead 转 Annie 知情确认中。**
- **双写者**：TURN 记录（Bridge 独写）+ parked-不碰-worktree 协议 + runner 写前 `flywheel-comm turn` 自查；同刻激活段唯一；git commit 冲突为可见兜底。
- **byte-compat**：所有改动在 `shareParentBranch`/phase-role 门内；单 session、auto-QA（QA·FLY-XX 独立 issue 流）、`isQaRunner` 路径零变化。auto-QA 与三段互斥既有守卫（event-route.ts:2053 gate on session_role==='main'——三段 phase role 不进 auto-QA）。

## 6. 留给 plan 定稿的点

1. 二次 `needs_review` 的 marker/事件重放语义验证（FSM no-op 下 session_completed 事件确认重发——FLY-191 生产已验，需测试钉死）。
2. TURN 表 schema/`flywheel-comm turn` 子命令输出契约 + 授予/翻转与既有事件处理的原子性（先记 TURN 还是先 wake——倾向先记后 wake，wake 失败 held-for-reconcile 镜像 FLY-752）。
3. fix_round durable 账本的落点（issue 级 session_params vs QA session intent 数组）。
4. park 后 runner 的等待姿态（STOP 不退出 = 等 mailbox wake；PostToolUse hook 注入 vs inbox-check 轮询——沿用 FLY-752 QA park 的既行姿态）。
5. ship 收尾的 hook 位置（event-route merged 分支 vs fanout-finalization 扩展）。
6. 每处 fail-closed 兜底的告警文案与 `three_stage_stuck` 事件复用。
