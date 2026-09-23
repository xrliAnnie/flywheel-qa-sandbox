# FLY-2547 评审体 end_turn 无判决 — 实施计划

Issue: FLY-2547 (https://linear.app/geoforge3d/issue/FLY-2547/病根-跨家族-claude-评审作业-end-turn-无判决-no-verdict门关到-lead-令体同-requestid)
日期: 2026-09-22
基于: research.md

## 目标

给跨家族 Claude 评审 prompt 加一段**回合生命周期硬约束**，让评审体不再「把测试放后台 → 结束回合等通知」
而死在 `no_verdict` 上。不动判决解析、不动重试状态机、不动 request payload。

## 改动清单（2 个文件）

### A. `packages/teamlead/src/bridge/review-request-coordinator.ts`

在 `buildPrompt` 的 `legacyContract` 里，紧接现有那句
`Run only single-package tests for the changed package and related test files. Never run \`pnpm -r\`.`
之后，插入三层语义（各一句，都在 `legacyContract` 内，因此 policy-on/off 同时生效）：

1. **前台同步**
   `Run every command in the FOREGROUND and wait for it to finish before you judge.`
2. **禁止后台 + 结束回合，并给出理由**
   `Never background a command and then end your turn to wait for a completion notification — this is a single headless session, ending your turn ends the session, and that notification will never arrive.`
3. **超时出路（tests_incomplete）**
   `If one suite is still running after 5 minutes, stop waiting on it and judge on the evidence you already have: still emit the verdict JSON, and add a {"severity": "LOW", "title": "tests_incomplete", ...} finding naming the suites that did not finish.`

约束：新增文本**不得**包含子串 `"findings": [{"severity": "HIGH|MEDIUM|LOW",`
（policy-on 分支用它做 `String.replace` 的锚点，重复会改错位置）。
第 3 句里写的是 `{"severity": "LOW", "title": "tests_incomplete", ...}`，与锚点不同，安全。

### B. `packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts`

1. 同步更新 `FLY-1278: policy-off prompt stays byte-identical` (1013) 里的
   `legacyContract` 期望串 —— 它是 `toBe()` 全串锁，不更新必红。
2. **新增**一条 `FLY-2547` 测试：断言三层语义的字面子串都在 prompt 里，
   且 policy-on / policy-off 两条路径都有。

## TDD 顺序

1. RED：先写 A 中三个字面子串的新断言测试 → 红（当前 prompt 没有这些串）。
2. GREEN：改 `legacyContract` → 新测试绿；同时 1013 那条 `toBe()` 转红。
3. 同步 1013 的期望串 → 全绿。
4. 变异验证：把 `legacyContract` 里三句删掉 → 新测试必须转红（Lead QA 判据 1）。

## 不改的东西（显式列出）

- `claude-review-runner.ts` 的 `parseClaudeReviewOutput` / `no_verdict` 分支。
- `review-request-coordinator.ts:2110` `reviewFailureRecovery()`。
- `StateStore.ts:20234` 连续失败计数。
- head_move / resume / fresh-re-review 四个 return 分支的结构（它们自动继承新 contract）。
- request payload、feature flag、其它任何 prompt。

## 验证

```
pnpm lint
pnpm --filter "@flywheel/teamlead..." build
pnpm --filter @flywheel/teamlead exec vitest run src/bridge/__tests__/review-request-coordinator.test.ts
pnpm --filter @flywheel/teamlead exec vitest related <changed files> --run
```

## 风险

- **唯一风险**：prompt 变长，评审体可能忽略。缓解：三句都放在已有测试指令旁边（同一语境），
  且第 2 句给了因果解释（headless 会话），而不是光下禁令。
- prompt 里的 5 分钟是软阈值，由评审体自己判断；硬上限仍是 runner 的 30 分钟超时，未改。
