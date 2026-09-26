# FLY-2886 语音·B·核心·大脑 — 设计复核 Round 5
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886/语音b核心大脑-codex-自带后台-agent订阅与-lead-同权-记忆与上下文三层装载-口语转述关键字段一字不差-等待话术-20)
日期: 2026-09-25
基于: plan.md v5、design-review-round4.md

## 复核参数与来源

- reviewer: `gpt-6-astra`
- reasoning: `xhigh`
- mode: read-only
- cwd/head: 本 worktree `773cad016`
- plan SHA-256: `56572943932c80b6d4d2e22ffa5e7c4552ac3b120cefe9e0834d9fc19f4fc546`
- 输入: Round 4 记录 + `2644b3a40..773cad016` 的 v4→v5 plan diff
- 范围: 只复核 R4 两条阻塞项及 v5 是否引入新 BLOCKER；不重开已关闭事项
- 执行位置: Lead 在 runner sandbox 外部执行。原因是本 runner 无法嵌套启动 Codex（`sandbox_apply: Operation not permitted`），且 implement execution 缺 immutable worktree binding，`request-review` 被 Bridge 以 422 拒绝。
- 原件: `~/.flywheel/qa-evidence/FLY-2886/review.out`

## Codex 原文

VERDICT: APPROVED

ITEM1: closed — 773cad016 的 plan.md:112–116 将解锁限定为原请求的可信成功响应、未发送证明或明确的执行前拒绝；abort、超时、5xx、含糊错误及目标未变化均保持 unknown，禁止 finally 或 TTL 自动释放。reconcile 必须取得旧请求已完成的证据；唯一例外是常驻 Lead 显式、带覆盖风险确认及审计的 force-clear。plan.md:128 已要求覆盖连接中止后迟到提交、对账读到旧值后迟到提交两个反例。设计层面关闭。

ITEM2: closed — plan.md:124–125 明确关开关后进入 draining，存量 held/unknown 目标继续通过 check-only 约束阻断常驻写，直到该 Lead 锁行清零；从未启用且无存量锁的 Lead 保持字节不变的原路径。plan.md:51、314 已同步回滚语义；plan.md:128 将“已派发或 unknown → 关开关 → 常驻同目标写 → 旧请求晚完成仍被阻断”列为必须实现的验收用例。设计层面关闭。

NEW_BLOCKERS: none

## 结论

APPROVED。可以按 plan.md v5 进入实现；代码评审必须按 plan §4.3 Lead 条件 3 专门核查「终态证据分类」和「draining 只检查约束」。

## §5.3 scoped 复核追记（v6–v10）

Bridge `request-review` 因本 execution 缺 immutable worktree binding 持续返回 422；Lead 因而在 runner sandbox 外用 `gpt-6-astra`、`xhigh`、read-only 连续执行五轮 scoped 复核，并以回执 `c757cb0b-fefc-47a6-acd1-863a3686df68` 裁定这五轮构成本修正的 effective design review。原件路径如下：

| 版本 / 固定提交 | 结论 | 原件 |
|---|---|---|
| v6 / `72a46686a` | `CHANGES_REQUESTED` | `~/.flywheel/qa-evidence/FLY-2886/review-v6-s5.3-72a46686a.out` |
| v7 / `1acd3ae2e` | `CHANGES_REQUESTED` | `~/.flywheel/qa-evidence/FLY-2886/review-v7-s5.3-1acd3ae2e.out` |
| v8 / `ca14cbea1` | `CHANGES_REQUESTED` | `~/.flywheel/qa-evidence/FLY-2886/review-v8-s5.3-ca14cbea1.out` |
| v9 / `c0b3d907a` | `CHANGES_REQUESTED` | `~/.flywheel/qa-evidence/FLY-2886/review-v9-s5.3-c0b3d907a.out` |
| v10 / `87cce6869` | `APPROVED`，prior 两条均 `CLOSED`，`FINDINGS: none` | `~/.flywheel/qa-evidence/FLY-2886/review-v10-s5.3-87cce6869.out` |

v10 批准的实现边界：逐帧 owner ledger 保留到消费或撤回；选择性重建只移除目标 `speechId`，其他未消费帧按原序且恰好重放一次；整个 live-context 撤回路径对 realtime `cancel/stop` 的调用数为零。真实语音 build-bound 准入仍属于 QA 门，不由设计批准替代。
