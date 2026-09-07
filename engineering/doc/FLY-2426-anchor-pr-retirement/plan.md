# FLY-2426 主仓锚 PR 误退休 — 实施计划
Issue: FLY-2426 (https://linear.app/geoforge3d/issue/FLY-2426/批准通路2394-founder-的两条批准通路对同一张卡全部失效-reaction-挂-13-小时reply-to)
日期: 2026-09-07
基于: research.md

## 目标

让 external-merge 驱动的 `superseded_merged` 退休只接受**当前 ship gate 自己绑定的主仓 anchor PR**；`founder_review` 不接受任何 PR merge 代替本轮 artifact review。只要 ship anchor PR 仍 OPEN，嵌套仓同号 PR、历史 session PR、issue alias 或其他输入都不能退休该 gate；当主仓 anchor 确有 fresh `mergedAt` 时，现有 ship retirement 与 legacy ship-gate 收敛继续工作。

## 锁定范围

### 修改

- `packages/teamlead/src/bridge/terminal-gate-retirement.ts`
- `packages/teamlead/src/bridge/external-merge-reconcile.ts`
- `packages/teamlead/src/bridge/__tests__/terminal-gate-retirement.test.ts`
- `packages/teamlead/src/bridge/__tests__/external-merge-reconcile.test.ts`
- 本 issue 文档与最终 milestone

### 不修改

- `StateStore.ts`：已有 exact holder / ship-target / node-binding API 足够，且 FLY-2427 正在改此文件。
- `plugin.ts`：现有 dependency wiring 不变。
- FLY-2427 的 respond / write-gate-response / lifecycle / recovery 文件。
- reaction/reply parser、approval/claim/authority ledger、`pr_head_sha`、Runner 终局、merge/deploy。

## 不变式

1. current workflow question 的 merged retirement authority 不是 issue-global 的。
2. current `approve_to_ship` holder 的 active run、ship-target 和 current node PR binding 必须对 question / run / current gate node / issue / project / head / repo identity / probe slug 全部一致。
3. current workflow ship gate 只接受 `target_repo_identity='__main__'` 且号码等于 binding 的 anchor PR。
4. `founder_review` 永不由 external PR merge 退休，包括 `active`、可恢复的 `held` 和终局 run；它只由正常 review/newer-family transition 或 issue-done 路径收敛。
5. ship holder 的 `authority_mode='land'|'runner_ship'` 才存在 PR retirement authority；`engine_terminal`、旧 `null`、缺失、歧义、superseded、跨仓或号码不等全部 fail closed。代价是异常 active 卡可能保持 open，但不会被伪 merge authority 静默杀死；FLY-2427 的卡恢复和 issue-done retirement 才是对应收敛面。
6. retirement 前 fresh revalidation 必须观察到同一 anchor PR 的有效 `mergedAt`。
7. 无 current workflow holder 的 legacy `approve_to_ship` 保持原有 merged-retirement 行为；founder-review 的 PR-merge retirement 不再保留，因为 PR merge 从来不是 artifact-review authority。
8. 本单不改变 external merge 的 finalization、TURN belt reclaim、预算/rotation/negative cache；parked finalization 的同号残余明确写进 PR，交由 Lead 决定 follow-up，不在本节点建票或修改。

## TDD 切片

### Slice 1：主仓 anchor 硬红

在 `terminal-gate-retirement.test.ts` 通过真实 StateStore + CommDB 建立：

- active workflow run；
- current `approve_to_ship` holder；
- question-local ship target `__main__`，head 对应 node binding PR `#1103`；
- 同 issue 外部 merged input `prNumber=25`，`revalidate=authorized`。

先断言 question 仍 open。当前实现会因只看 issue alias 而退休，测试必须红且错误精确为 `resolved_via=superseded_merged`。

最小实现：在 `retireExternalAuthority()` 的 merged reason 分支、每张 question 不可逆写入之前，调用一个无写入的 retirement-authority classifier：

1. `approve_to_ship` 无 current holder → legacy allow；
2. 有 holder → 仅 `land|runner_ship` 可继续，读取 active/current run、ship target、current node binding；
3. 比较完整 identity 与 `input.prNumber`；不完全一致则 skip；
4. `founder_review` 对 merged reason 一律 skip，不依赖 run status，避免 artifact review 被 PR merge 代答。

identity mismatch 段旁写明其 sibling 是 `gate-origin-preflight.ts` 的 holder → run → target → binding 检查，提醒后续编辑者同步审计；不抽共享 allow predicate，因为 display 与 irreversible retirement 的 authority-mode/PR-number 语义不同。

运行单测变绿。

### Slice 2：founder review 硬红（含 held）

以 `active` 与 `held` 参数化建立结构化 founder-review family 的 open question；同 issue 输入嵌套 PR 同号 + `revalidate=authorized`。旧实现会写 `superseded_merged`，新 classifier 必须保持 open。随后重跑既有 `retireIssueDone` founder-review 正例，证明真正的 issue-done authority 仍能从 immutable run identity 收敛它。

### Slice 3：正确 anchor 与 authority-mode 对照

新增同形测试，把 merged input 改为 node binding 的 `#1103`，断言 `land|runner_ship` gate 仍以 `superseded_merged` 退休。新增（不是“保留”）无 workflow holder 的 legacy `retirePrMerged` 用例，证明主仓 merged 收敛不退化；增加 `engine_terminal` / legacy-null current holder 无 PR binding 时保持 open 的负例，把 fail-closed 代价锁进测试。

### Slice 4：fresh `mergedAt` 复核

在 `external-merge-reconcile.test.ts`：

1. 扩展 `PrMergeInfo` 保留 `mergedAt`。
2. 正向：initial merged candidate 后，retirement mock 调用 `revalidate()`；fresh probe 有合法 `mergedAt` → `authorized`。
3. 负向：fresh probe 报 `state=merged` 但 `mergedAt` 缺失或非法 → `unknown`。

先写负例并看到旧闭包错误返回 `authorized`，再最小修改 `checkPrMergeViaGh()` 解析结果和 revalidation predicate。其他 merged finalization 语义保持不动。

这一条来自 Lead 的冻结验收条件，不是两次事故的 load-bearing 根因；flywheel `#25/#27` 都有合法 `mergedAt`。实现时显式更新所有会执行 retirement revalidation 的 merged fixture（尤其现有 “offers only a fresh MERGED proof”），并保留初次 merged classification/finalization 的现状，避免把防御性 freshness 变化误报成根因修复。

### Slice 5：跨仓号码碰撞调用点回归

在 external reconciler 的公开 `pass()` seam 组合两个 candidate：

- 历史 session `#25`，主仓同号 probe 为 merged；
- 当前 gate anchor `#1103`，probe 为 open。

接入真实 `TerminalGateRetirement` 或一个忠实执行其 revalidation 合同的 sink，断言 gate 不退休、所有 probe 对象可审计。测试名明确记录 FLY-2394 production shape。

随后仅在工作树临时恢复旧的“issue alias + 任意 candidate PR”比较，运行这一个测试并保存红灯输出；立即还原修复，再跑绿。变异不提交。

## 真数据副本复算

对 WAL-consistent backup 副本做只读分类，不向生产写：

1. 从 CommDB current + archive 取 `resolved_via='superseded_merged'` questions。
2. 对 current workflow questions，以 holder → ship target → current node binding 解析 anchor。
3. 用 `gh pr view --repo <probe_repo_slug> <anchor> --json state,mergedAt,...` fresh 复核。
4. 统计：
   - FLY-2394 / FLY-2381：旧逻辑会退、修复逻辑不退；期望 `2 → 0`。
   - 历史正确退休 FLY-1687 `#827`、FLY-1679 `#801`：主仓 PR 都有 mergedAt，legacy path 仍退；期望 `2 → 2`。
5. 单列 FLY-2379：无 `#26` ordinary candidate，anchor `#1106` OPEN，保持不退休。

结果写入 PR 描述和 milestone；副本本身不提交。

另列 founder-review 分类回放：不论关联 run 为 `active`、`held`、`completed` 或 `terminated`，candidate 同号主仓 PR merged 都不能代替 artifact review；这类卡不计入“legacy correctly retired ship gate”分母。

另附只读历史 census，不扩大实现范围：按“同 issue 已有主仓 binding、session PR number 却不属于该 issue 任一主仓 binding”的严格口径，记录可证明的跨仓候选下界，并列出 external reconciler 之外的 `sessions.pr_number` 直接生产读取点供后续审计。

## 验证顺序

1. 每个 slice 独立 red → minimal green；不批量先写所有测试。
2. focused：两个测试文件。
3. TeamLead package test 与 typecheck/build。
4. 精确全仓门：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`。
5. 检查本次新增 `scripts/__tests__/*.test.sh`；预计为 0，若非 0 全部逐个执行。
6. `rg '\[DEBUG-'` 确认无临时 instrumentation；检查未留下 throwaway harness。

首次基线误用了 `pnpm --filter flywheel-teamlead test:run -- <files>`，该 script 把 `--` 后参数当成分隔而运行了整包；同时尚未 build workspace packages，得到大量 `dist`/package entry 缺失的 harness 失败。这不算产品红灯。后续 focused 命令固定用 `pnpm --filter flywheel-teamlead exec vitest run <files>`，且先完成 workspace build；两类结果在 PR 中分开记录。

## 代码审查

1. 固定点为 `origin/main`，核验 `git diff origin/main...HEAD` 与 commits。
2. 通过规定的 `codex:rescue` 跑 standards/spec 两轴 review；不使用 raw `codex exec`。
3. `stage set code_review` 后注册 `review_code` gate + `request-review`，等待 structured verdict。
4. CHANGES_REQUESTED：只修 blocking finding，提交后开新 review gate；review 运行期间除 `engineering/doc/**` 进度提交外不推。
5. APPROVED with advisories：硬门通过，advisories 通过 `ask --report` 告知 Lead。

## 并行分支碰撞验证

在最终代码 head 上分别运行：

- `git merge-tree $(git merge-base origin/main HEAD) origin/main HEAD`
- 以 `flywheel-FLY-2427` 当前 head 为对侧，三方 merge-tree 模拟。

记录两个模拟的冲突文件数。若 FLY-2427 在期间新增 code commit，交付前重新取 head 并重跑；不自行合并该分支。

## 提交与交付

1. 小提交：设计文档；每个完成的 TDD 行为批次；验证/证据文档。
2. 推 feature branch，创建 PR，PR 描述必须包含：两次旧判定实际值、FLY-2379 反例解释、红绿/变异证据、真数据两侧数字、全门状态、merge-tree 结果、明确不碰项。
3. **字面最后一个 commit** 只新增 `engineering/doc/milestones/FLY-2426.md`；其后不再改代码或普通文档。
4. 写 runner-memory closeout（最多 5 条 durable judgments；无新判断则明确不写）。
5. 通过唯一报告通道向 Lead 报告，再执行 `complete --route needs_review --pr <NUMBER>`；不 dispatch QA、不请求 ship、不 merge/deploy。

## 回滚

代码仅增加 fail-closed comparison 和 fresh-evidence requirement。若需回滚，revert 对应代码/测试 commit 即恢复旧行为；不涉及 schema、数据迁移或生产状态写入。已误退休的历史 gate 不在本单补写或恢复。
