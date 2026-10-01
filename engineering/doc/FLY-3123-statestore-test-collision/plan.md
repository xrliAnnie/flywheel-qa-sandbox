# FLY-3123 StateStore 测试语义相撞 — 实施计划
Issue: FLY-3123 (https://linear.app/geoforge3d/issue/FLY-3123/main-红挡全部-pr-statestoregeneralized-executiontestts5467-referenceerror)
日期: 2026-10-01
基于: research.md

**Goal:** 确认任何携带测试「FLY-2919 resolves an admitted wake on the original physical owner」的头，
都用文件既有夹具 `createGreenHandoffStore(":memory:")` 构造 store，从而不再调用被类型擦除的
`StateStore` 运行时值；断言、导入、生产代码一律不动。

**交付模式（R1 定稿）：验证 / 交接，不自动提交代码。** 修复本体（#1425）已合入、又随 FLY-2919
被 #1430 回退；修复现由 #1431 / #1400 承载（归各自 issue）。本 issue 没有可写的在飞 PR，
因此 implement 阶段只做"按真实头核验 + 据实交接"，不新开 PR、不向他人载体推提交。

**一行修法（供载体所属 issue 采用）：** 命名测试内
`StateStore.create(":memory:")` → `createGreenHandoffStore(":memory:")`。
`createGreenHandoffStore(...args)` = `installGreenHandoffProofs(await StateStore.create(...args))`
（`helpers/handoff-proof.ts` 206–209 行，三个载体字节相同），真实内存 StateStore + 只对
`handoff_not_ready / handoff_proof_required` 补精确 intent 的绿色证明；命名测试期望 completion 成功、
断言 activation 切换与物理 owner 不变，helper 不触碰这些路径（R1 已静态比对四份测试块一致）。

**Tech Stack:** TypeScript、Vitest、pnpm workspace（包名 `flywheel-teamlead`）、GitHub Actions。

---

## 0. 现状（2026-10-01 gh 只读核实；implement 阶段必须重新核实，状态可能已变）

| 事实 | 值 |
|------|----|
| #1379 FLY-2919 | MERGED 17:37:38Z，合入 `ef5899b51`（= 碰撞头：类型导入 + helper 已导入 + 命名测试仍调旧构造） |
| #1408 FLY-2968 | MERGED 16:31:33Z，把本文件 store 构造统一为 helper、`StateStore` 改 type-only |
| #1425 本 issue 修复 | MERGED 2026-09-30T21:08:22Z，头 `5ff88e1cb`，相对碰撞头目标文件 diff 恰好一行 |
| #1430 回退 FLY-2919 + FLY-3123（FLY-3143） | MERGED 2026-10-01T00:31:30Z，`be24a1b57` |
| 生产 main `e2997d2e9` | 目标文件在、命名测试**不在**、旧构造 0 处 → 此碰撞已不存在（不外推 main 全部 CI） |
| #1431 re-land（OPEN，头 `803ed4d13`） | 命名测试 5467 行、helper 构造 5468 行；mergeable=clean；完整 CI run 36866557125/1 success |
| #1400 FLY-3041（OPEN，头 `ef8eb5cf7`） | 命名测试 5468 行、helper 构造 5469 行；完整 CI run 36756652399/1 success（历史）；**当前 mergeable=false/dirty** |
| 本 design 工作树 | QA 沙箱 `xrliAnnie/flywheel-qa-sandbox`，目标文件**不存在** |

行号只是对应固定 SHA 的导航信息，**不是**验收条件。

## 1. 文件范围

- 只读核验对象：`packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts`、
  `packages/teamlead/src/__tests__/helpers/handoff-proof.ts`。
- implement 阶段在本 issue 下**不修改任何代码文件**；只允许更新本文件夹内的证据文档 / progress。

## 2. Task 1 — 核验前置条件（任何判断之前，逐条记录）

对每个待核验头（本地 checkout，或 gh 只读读取的载体头 `<SHA>`）：

1. 仓库身份：`git remote get-url origin` 或 gh 显式 `--repo xrliAnnie/flywheel`；记录完整 SHA。
2. 本地 checkout 时：`git status --porcelain -- packages/teamlead` 为空（相关路径未修改）。
3. 目标文件是否存在。
4. 命名测试出现次数（固定字符串）：`grep -cF 'FLY-2919 resolves an admitted wake on the original physical owner' "$F"`。
5. 导入语义（按模块路径与绑定，不按行号）：
   - 来自 `"../StateStore.js"` 的 `StateStore` 为 type-only（`type StateStore`）；
   - `createGreenHandoffStore` 为来自 `"./helpers/handoff-proof.js"` 的值导入。
6. 命名测试块内的构造表达式：恰好一处，且是 `createGreenHandoffStore(":memory:")` 或
   `StateStore.create(":memory:")` 之一。
7. 全文件旧构造计数：`grep -cF 'StateStore.create(' "$F"`（注意 grep 零匹配退出码 1 是正常结果，
   读取失败（退出码 2）才是错误）。

## 3. Task 2 — 决策表（无自动提交）

| 观察 | 结论与动作 |
|------|------------|
| 目标文件不存在（如 QA 沙箱） | 不伪造生产文件；`local_test=not_run`（原因：checkout 不含目标文件）；用 §0 gh 证据交接 |
| 文件在、命名测试 0 处（当前生产 main） | 此碰撞不存在；不单独补回测试（FLY-2919 已被整体回退）；记录"命名测试不适用"，交接 |
| 命名测试 1 处 + type-only `StateStore` + helper 值导入 + 构造为 helper | **已修复**；可运行时跑 §4 单文件；记录精确头证据，交接 |
| 命名测试 1 处 + type-only `StateStore` + helper 值导入 + 构造为 `StateStore.create(":memory:")` | **碰撞形态**；不在本 issue 提交。经 `flywheel-comm ask --lead` 把"repo + 完整 SHA + 文件 + 一行替换建议"交给该头所属 issue / Lead |
| 任何其他组合：`StateStore` 为值导入（如 #1379 原头 `b9777db5e`）、helper 未导入、命名测试多处、构造形态未知、相关路径有未提交改动 | **不匹配**；不得套用这一行、不得扩大修改范围；记录观察并交接 Lead |

## 4. Task 3 — 验证证据（本机只跑相关测试）

1. 单文件（仅在真实生产 checkout、文件存在且可运行时）：
   `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.generalized-execution.test.ts`。
   期望 0 failed、无 `ReferenceError`。不跑包级/全仓套件；不为复现红态回退代码
   （红态证据沿用 issue 记录：92 pass / 1 fail）。运行失败或环境受阻 → 如实记 failed / blocked。
2. 完整 CI：必须绑定 **repo + PR + 完整头 SHA + run ID + attempt + 链接**。
   在 QA 沙箱中必须显式 `--repo xrliAnnie/flywheel`（裸 `gh pr checks <pr>` 会查沙箱 origin）；
   用该 SHA 的 check-runs / run 元数据核对归属，记录时再确认 PR 头未变。
   聚合名「CI OK」可能来自 docs_only / reuse 路径，须同时确认 teamlead 1–4 分片在该 run 中实际 success。
   远程 CI 是外部执行证据，不得写成"本机单文件通过"。
3. 同头复审：本 issue 不产生新头 → 不适用。

## 5. QA 范围（给 QA 节点）

只核三件事，证据随决策表分支而定：
1. 改法：载体头上命名测试的构造 = `createGreenHandoffStore(":memory:")`，导入语义满足 Task 1 第 5 条，断言未动（与 #1379 原测试块归一化比对）。
2. 单文件：可运行时记录结果；QA 沙箱缺文件记 `local_test=not_run` + 原因，不补造本机证据。
3. 精确头完整 CI：按 §4.2 绑定证据（当前可引用 #1431 run 36866557125/1、#1400 run 36756652399/1、#1425 run 36757438947/2）。
529：`not_run`，`exempt_category=tests_only`；豁免**只覆盖 FLY-3123 这一行测试夹具变更**，不替代 #1431 / #1400 各自生产改动的 QA。

## 6. 回滚边界与守卫

- 本 issue 无代码提交 → 无回滚动作。
- 单独还原这一行**不是**可接受的生产回滚：在保留 type-only 导入与命名测试的头上会确定性复现 ReferenceError。
  若 helper 本身出问题，停止交付并交给所属变更处理。
- 负向守卫：命名测试所在文件 `grep -cF 'StateStore.create(' "$F"` 为 0；`StateStore` 仍为 type-only。
- 正向守卫：命名测试恰好 1 处、其构造为 helper；断言 / 导入 / `finally { store.close(); }` 不变由对固定基线的 diff 证明，不只靠 grep。
- 不在本 issue 内加 tsc / TS1361 CI 门（research.md 方案 D，follow-up 建议）。

## 7. 完成判据

- 每个被核验头的 Task 1 七项记录 + 决策表分支 + §4 证据（含 not_run 原因）写入本文件夹的证据文档。
- §0 状态在 implement 阶段重新核实一遍并据实更新（例如 #1431 已合入、#1400 仍冲突）。
- 若出现"碰撞形态"或"不匹配"分支：已用 `flywheel-comm ask --lead` 交接，并在证据里引用该问题 id。
- 无代码提交、无新 PR、无新头。
