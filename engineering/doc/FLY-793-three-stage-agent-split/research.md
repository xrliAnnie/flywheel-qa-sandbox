# FLY-793 三段式 agent 拆分 — 调研(前半 / 非 795 部分)

Issue: FLY-793 (https://linear.app/geoforge3d/issue/FLY-793/pipeline-三段式-agent-拆分-designimplementqa-各一个-agent-各配模型-可开关-77-前-fable)
日期: 2026-07-02
基于: exploration.md

## 0. 范围

只调研**前半**(不依赖 FLY-795 地基):phase-split 的 session 交接骨架 + 每 phase 模型 + toggle + 阶段可见性。**深交接的执行状态(`progress.md` schema)= 消费 FLY-795 接口,不在此定死**(schema/位置由 795 定、Lead relay 对齐)。锁定架构见 exploration §2A(一个 issue / 一次 RPCI / 内部三 phase-session)。

## 1. 核心发现:前半 ≈ 90% 复用现成原语

三段式的 session 交接骨架**几乎全是现成原语的接线**,新代码很少。逐一核实(代码锚点):

| 需要的能力 | 现成原语 | 代码锚点 |
|---|---|---|
| **一个 issue 多个 session** | **FLY-59 `session_role`** —— sessions 表有 `session_role TEXT DEFAULT 'main'` 列;dispatch 时 `role = req.sessionRole ?? "main"`。三 phase = 同一 `issueId` 上 `session_role` = design/implement/qa 的三个 session。 | `StateStore.ts:921`(列)/`run-dispatcher.ts:255,348`(threaded) |
| **每 phase 各自模型** | **FLY-728 `dispatchModel`** —— `StartRequest.dispatchModel`,在手动 label 下、项目默认上。 | `retry-dispatcher.ts:132` / `run-dispatcher.ts:118,371` |
| **phase 起在同一条分支 B** | **① 分支从 issueId 派生** `branch = worktreeName(mainRepoPath, issueId)` → **同 issueId ⇒ 同分支 B(白送!)**;② **FLY-579 `startPoint`** 让 worktree checkout 到 B 的当前 head(而非 origin/main),`WorktreeManager.create({startPoint})`。 | `WorktreeManager.ts:144,260` / `retry-dispatcher.ts:134-140` |
| **phase 边界触发下一段** | **auto-QA 的 `session_completed`/`awaiting_review` hook 模式** —— `onMainAwaitingReview` 在 completion 事件上起下一段(QA)session。三段式镜像它:phase 边界 completion → 起下一 phase session。 | `event-route.ts:97,554,790`;`auto-qa-coordinator.ts` |
| **每 phase 各自 agent 提示词** | `StartRequest.agentName`(FLY-137 override,校验 `validateAgentName`)。 | `retry-dispatcher.ts:96,200` |
| **QA phase 的 fix-loop wake** | **FLY-752 `retest_wake` + `requireMailboxTransport`** —— QA 保活等重测、`feedbackWakeMain` 唤实现者。 | `auto-qa-coordinator.ts`;`retry-dispatcher.ts:171` |
| **worktree 交接/重启清理** | **FLY-99 `-B` + prune / FLY-603 dirty-safe remove**(exploration §3.2)。 | `WorktreeManager.ts:159,207,424` |
| **toggle 配置** | **ConfigLoader `doc_flow` 那套 optional-mapping 加载 + `resolveAutoQaPolicy` default-off/fail-closed**。 | `ConfigLoader.ts:317`;`auto-qa-policy.ts:38` |
| **阶段可见性** | FLY-560 thread-title stage emoji + FLY-728 模型短码。 | `event-route.ts stampStageEmojiForSession` |

**结论**:「一个 issue / 内部 phase」这个架构让**分支延续白送**(同 issueId → 同 B)、且**多 session/issue 已由 FLY-59 支持**,所以前半的新代码集中在一小块编排 + 两处 phase 停点 + 一个 toggle。

## 2. 真正要新写的(前半)

1. **PhaseOrchestrator(镜像 AutoQaCoordinator)**:在 phase 边界的 completion 事件上,起下一 phase 的 session ——
   - 同 `issueId`、`sessionRole` = 下一 phase(design→implement→qa)、`dispatchModel` = 下一 phase 模型(Fable/Opus/Sonnet;拿不准→prefer-Fable §5)、`startPoint` = 分支 B 的当前 head、`agentName` = 该 phase 的 executor。
   - 触发点:Design phase 到「design_review 完」的边界;Implement phase 到「pr_created」的边界(QA 复用 auto-QA 现路径 or 内部化——见 §3 待定)。
2. **phase-aware 停点(两处)**:
   - **Design phase** 系统提示 = onboard→brainstorm→research→plan→design_review、把 docs + `progress.md` commit 到 B、然后 complete(**不进 implement**)。
   - **Implement phase** 系统提示 = 读 B + `progress.md` 续 → implement→test→code_review→pr_created(**不重跑 brainstorm/design**)。
   - 复用 Blueprint 现有「按 sessionRole 定制 prompt」的位置(QA-mode 已是先例:`Blueprint.ts:786` `isQaRunner` 分支按 role 换 prompt)。
3. **toggle config**:`.flywheel/config.yaml` 新 key(如 `pipeline.three_stage`),ConfigLoader 加载 + policy default-off。开时按三 phase 起、模型映射 = §6 表(prefer-Fable 旋钮);关时 = 现状(单 session,byte-compat)。
4. **progress.md 读写点(消费 795 接口)**:每 phase 起始读、结束/边界写(字段见 exploration §8.1)。**schema 引用 795,不在 793 定死**;795 未定前用一个最小占位(plan 里标 TODO-795)。

## 3. 待定 / plan 阶段敲定(与 795/799 对齐)

- **Q-autoqa-reconcile**:三段式的 QA phase 与现有 auto-QA(FLY-579/752 在**独立 QA·FLY-XX sub-issue** 上跑)怎么合?两个方向:(a) QA phase 复用 auto-QA 的 coordinator/wake/cleanup,只是 `session_role="qa"` 挂在**同 issueId + 分支 B**(不建 QA·FLY-XX);(b) 三段模式下走新 PhaseOrchestrator、非三段仍走旧 auto-QA。倾向 (a)(最大复用、独立性靠 role+model 保住)。**plan 阶段定,且与 795 的 progress.md/交接接口对齐。**
- **progress.md schema**:等 795(Lead relay);793 只给消费需求(§8.1)。
- **收尾简化(FLY-799)**:completion/收尾与三段的 QA-pass→ship gate 对齐同一甲模型。
- **深交接执行状态(重启中途续 phase)**:骨架(重起 session 读 progress.md)属前半;「干净非有损快照」的保证属 795。

## 4. 风险 / 边界

- **byte-compat**:toggle 默认 OFF = 单 session 现状零变化(对齐 doc_flow/auto-QA opt-out 纪律)。
- **两处 completion 落库路径**(event-route loopback + DirectEventSink)——若 PhaseOrchestrator 挂 completion,需两处都接(FLY-728/752 同样教训)。
- **单 writer 不变量**:phase 顺序起,天然同时刻一个 writer;git 同分支 checkout 硬拦 + FLY-99 清理兜底。
- **gate 位置**:brainstorm gate + Codex design-review gate 在 Design phase;approve/ship gate 在 QA-pass 之后。三段不改 gate 语义、只是 gate 落在对应 phase 的 session 里。
- **部署**:纯代码 + config 键 + 可能 StateStore 无新列(session_role 已有);生效需 Bridge 重启(boot 读 config/orchestrator)。Tier-3 攒批。
