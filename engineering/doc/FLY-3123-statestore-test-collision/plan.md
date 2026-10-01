# FLY-3123 StateStore 测试语义相撞 — 实施计划
Issue: FLY-3123 (https://linear.app/geoforge3d/issue/FLY-3123/main-红挡全部-pr-statestoregeneralized-executiontestts5467-referenceerror)
日期: 2026-10-01
基于: research.md

**Goal:** 让任何携带测试「FLY-2919 resolves an admitted wake on the original physical owner」的头，
都用文件既有夹具 `createGreenHandoffStore(":memory:")` 构造 store，消除对被类型擦除的
`StateStore` 运行时值的调用；断言、导入、生产代码一律不动。

**Architecture:** 一行测试改动（方案 A，见 research.md §2）。`createGreenHandoffStore(...args)`
= `installGreenHandoffProofs(await StateStore.create(...args))`（`helpers/handoff-proof.ts:206`），
真实内存 StateStore + 绿色交接证明，与 #1408 对本文件其余测试的改法单一来源。

**Tech Stack:** TypeScript、Vitest、pnpm workspace、GitHub Actions。

---

## 0. 现状（2026-10-01 gh 只读核实，决定 implement 阶段走哪条分支）

| 事实 | 值 |
|------|----|
| #1425（本 issue 修复） | MERGED 2026-09-30T21:08Z，头 `5ff88e1cb`，命名测试第 5467 行已是 helper 调用 |
| #1430（回退 FLY-2919 + FLY-3123，FLY-3143） | MERGED 2026-10-01T00:31Z |
| 生产 main `e2997d2e9` | 目标文件在、命名测试**不在**、`StateStore.create(` 0 处 → 此点已不红 |
| #1431 re-land（OPEN，头 `803ed4d13`） | 命名测试第 5467 行，第 5468 行已是 helper 调用；teamlead 1–4 分片 pass |
| #1400 FLY-3041（OPEN，头 `ef8eb5cf7`） | 命名测试第 5468 行，第 5469 行已是 helper 调用 |
| 本 design 工作树 | QA 沙箱 `flywheel-qa-sandbox`，目标文件**不存在** |

交接须知（2026-09-30 13:0x PDT）描述的「检出 `flywheel-FLY-3123`、核头 5ff88e1cb、请求同头复审、交卷」
已被事实取代：#1425 已合入又被回退，没有可复审的在飞头。implement 阶段**不得**为本 issue 新开 PR
或在 #1431/#1400 上推提交（它们归各自 issue 所有）。

## 1. 文件范围

- 唯一允许修改：`packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts`（仅命名测试内一行）。
- 只读：`packages/teamlead/src/__tests__/helpers/handoff-proof.ts`、`packages/teamlead/src/StateStore.ts`。
- 禁止：改第 18 行导入（方案 B 已否决）、改断言/测试名/`try/finally`、改生产代码。

## 2. Task 1 — 判定 checkout 分支（决策表）

```bash
git remote get-url origin; git branch --show-current; git rev-parse HEAD
F=packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts
test -f "$F" && grep -n -A1 'FLY-2919 resolves an admitted wake on the original physical owner' "$F"
```

| 观察 | 动作 |
|------|------|
| 文件不存在（如 QA 沙箱） | 不伪造生产文件；记录"checkout 不含目标文件"，用 §0 gh 证据交接，零代码提交 |
| 文件在、命名测试不在（当前生产 main） | 不单独补回测试（FLY-2919 已被 #1430 整体回退）；记录"main 已回退，修复随 #1431/#1400 re-land"，零代码提交 |
| 命名测试下一行已是 `createGreenHandoffStore(":memory:")` | no-op；核对第 18 行仍是 `type StateStore`、helper 已导入；跑 §4 单文件；零代码提交 |
| 命名测试下一行仍是 `StateStore.create(":memory:")` | 执行 Task 2 |

## 3. Task 2 — 一行修复（仅在决策表最后一行时执行）

把命名测试内
```ts
const store = await StateStore.create(":memory:");
```
替换为
```ts
const store = await createGreenHandoffStore(":memory:");
```
然后：
```bash
git diff -- "$F"     # 期望：恰好 -1/+1 一行
git diff --check
sed -n '1,40p' "$F" | grep -n 'type StateStore\|createGreenHandoffStore'   # 导入不变
grep -c 'StateStore.create(' "$F"   # 期望 0
```
提交信息：`fix(FLY-3123): use green handoff fixture in FLY-2919 wake test`。

## 4. Task 3 — 验证（本机只跑相关测试）

1. 单文件：在 teamlead 包内 `pnpm exec vitest run src/__tests__/StateStore.generalized-execution.test.ts`
   （或仓库既有单文件等价命令）。期望全部 pass、0 failed、无 `ReferenceError`。
   不跑包级/全仓套件；不为复现红态回退代码（红态证据沿用 issue 记录：92 pass / 1 fail）。
2. 完整 CI：只认**精确头**的 GitHub Actions 结论（`gh pr checks <pr>` 或 `flywheel-comm ci-full`）。
   任何新提交都产生新头，必须等新头自己的完整 CI，不可沿用旧头的绿。
3. 同头复审：仅当本 issue 在 implement 阶段真的产生了新提交/新 PR 时请求；无代码提交则不适用。

## 5. QA 范围（给 QA 节点）

只核三件事：
1. 这一行的改法 = `createGreenHandoffStore(":memory:")`，导入与断言未动；
2. 该测试文件在精确头上单文件全绿；
3. 精确头完整 CI 全绿（若无新头，则引用 #1431 `803ed4d13` / #1400 `ef8eb5cf7` 的现有 CI 作为"修复在载体头上成立"的证据，并注明来源）。
529：`not_run`，`exempt_category=tests_only`（只改测试，不改运行中流程）。

## 6. 回滚边界与负向守卫

- 回滚 = 还原这一行；无数据、schema、配置影响。
- 负向守卫：命名测试所在文件 `grep -c 'StateStore.create('` 必须为 0；第 18 行必须保持 `type StateStore`。
- 不在本 issue 内加 tsc/TS1361 CI 门（research.md 方案 D，follow-up 建议）。

## 7. 完成判据

- 决策表分支已记录在 implementation 证据里（含 checkout 身份与头 sha）。
- 若有代码提交：diff 恰好一行、单文件全绿、精确头完整 CI 全绿、同头复审 APPROVED。
- 若无代码提交：§0 gh 证据重新核实一遍（状态可能已变，例如 #1431 已合），据实交接。
