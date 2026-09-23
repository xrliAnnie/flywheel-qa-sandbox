# FLY-2547 评审体 end_turn 无判决 — 调研

Issue: FLY-2547 (https://linear.app/geoforge3d/issue/FLY-2547/病根-跨家族-claude-评审作业-end-turn-无判决-no-verdict门关到-lead-令体同-requestid)
日期: 2026-09-22
基于: exploration.md

## 代码事实

### 1. prompt 的唯一构造点

`packages/teamlead/src/bridge/review-request-coordinator.ts`

- `buildPrompt(job, resume, policyEnabled, governancePrompt)` — 2380 行，`private`。
- `legacyContract`（2399–2407）是**所有** round / resume / head_move / fresh-re-review 分支
  共享的前缀：四个 return 分支全部以 `${contract}` 开头。改这里 = 一处改全覆盖。
- `policyEnabled` 分支（2408–2414）对 `legacyContract` 做一次 `String.replace`，
  匹配串是 `"findings": [{"severity": "HIGH|MEDIUM|LOW",`。
  → 只要新增文本不碰这个子串，policy-on / policy-off 都自动继承新约束。
- 唯一调用点：1562 行，`prompt: this.buildPrompt(...)`，喂给 `ClaudeReviewInvocation`。

### 2. 失败判定点

`packages/teamlead/src/bridge/claude-review-runner.ts:552–565`

```ts
const parsed = parseClaudeReviewOutput(res.stdout);
if (!parsed) {
  return { kind: "failed", reason: "no_verdict", ... };
}
```

退出码为 0（`end_turn` 是正常收尾）、没超时（`DEFAULT_TIMEOUT_MS = 30 * 60_000`，
观测到的 97–300s 和 6–8min 都远没到），只是 stdout 里没有可解析的判决。
**这是正确的 fail-closed 行为，本单不动它。**

### 3. no_verdict 的下游

- `review-request-coordinator.ts:2110` `reviewFailureRecovery()` — 把 `no_verdict`
  翻成「retry this same requestId」的告警文案。
- `StateStore.ts:20234` — `no_verdict` / `reviewed_wrong_head` 计入同代连续失败。

两处都在判定**之后**，与 prompt 正交，本单不动。

### 4. 会被 prompt 文本改动影响的既有测试

`packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts`

| 行 | 断言 | 影响 |
|---|---|---|
| 1013–1057 | `FLY-1278: policy-off prompt stays byte-identical` — `toBe()` 全串比较 | **必须同步更新**期望串 |
| 1086 | `toContain("Never run \`pnpm -r\`")` | 不受影响（子串保留） |
| 2635–2637 | `toContain("Your very last line must be that JSON object itself.")` | 不受影响 |
| 1083 | `toContain("Run only single-package tests for the changed package and related test files.")` | 不受影响 |

1013 那条是**故意的**字节级锁：它的作用是保证 policy flag 关掉时 prompt 一个字节都不变。
本单是有意改 prompt，所以同步更新它的期望串是正确做法，不是绕过。

### 5. 超时预算

单轮 30 分钟。观测到的 4 次失败各 6–8 分钟。所以给「单套件超过 N 分钟就停止等待」
定 N = 5 分钟，既能踩住真正的慢套件，又给「读代码 + 出判决」留下 20+ 分钟余量。

## 约束

- Lead 派工明确：不动判决解析、不动 `no_verdict` 重试状态机、不动 request payload、不碰其它文件。
- PR 要小到评审员只需跑 `review-request-coordinator` 相关测试文件（否则评审员自己会再踩同一个坑）。
