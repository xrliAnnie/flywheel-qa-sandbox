# FLY-1498 R5 映射修订 — 增量评审记录
Issue: FLY-1498
日期: 2026-07-28
基于: `mapping-v2final.md`@923908f0 与 R5 `failure_raw` 可恢复 findings

## 0. 记录性质与评审范围

R5 reviewer 已完成但服务返回 `no_verdict`；以下只收敛原始输出中可恢复的五项。
本轮只审这些增量是否与 founder 批准终稿一致且完整，不重开此前已经收敛的
完成合同、ship 通用三条、DAG 零特判、同 task 返工、agent-first ship 主方向。

本文件是 parser 故障下缩小 payload 的**非权威评审记录**。唯一规范来源是
`mapping-v2final.md`；本文件的摘录不替代、削弱或另立其中任何 subject/事务约束。
评审完成后本记录留在 FLY-1498 doc folder 作审计，不并入
`design-FINAL-v2.md` 或 design-chain。

## 1. 逐项 close

| finding | close |
|---|---|
| retry defaults miss real CI duration | 自动重试策略缺省改为 max=6、base=2min、cap=15min；间隔 2/4/8/15/15min，总窗口 44min，覆盖本仓一次 10-15min 矩阵 CI 后恢复 |
| reconciler mints merge capability | 穷举两个 mint 点：founder approval 的首次授权；同一批准/head 未变且未超限时 ActionReconciler 的有界再武装，后者落独立审计事件且不构成新授权 |
| retry exhausted expire self-conflict | 超限结算先 CAS action `executing→failed`，再在同事务直接 expire gate；不调用会对 executing 自冲突的通用失效原语 |
| canonical branch ref recording undefined | admission 与 span/writer state 同事务写 `canonical_worktree:<worktree_id>`；rework/handoff 不改 branch，重建只可 CAS path，换 branch 必须换 worktree identity/span |
| lost open family over-inclusion | 明记为 fail-closed 取舍：即使不可观测产出被丢弃，旧 family 仍留在当前 span author set，接手完成前不能做 reviewer |

## 2. 送审增量摘录（非权威）

### 2.1 canonical worktree 身份

issue/worktree admission 与 `span_tip`、`writer_chain` 同事务写：

```text
meta['canonical_worktree:<worktree_id>'] = {
  repo_identity,
  worktree_path,
  branch_ref
}
```

rework/handoff 只换 attempt，不改 branch_ref。清理后重建同一 worktree identity 只能
CAS 更新 path，且 repo_identity+branch_ref 必须仍匹配；改变 branch 必须创建新的
worktree identity 与 span anchor。worktree 路径不存在时，先以 cleanup receipt +
process absent 证明清理，再读同 repo 的 exact recorded branch ref。

若 worktree 与 ref 都不可恢复，`adopt_writer_gap(lost_open_attempt)` 仍要求
resolution_head=span_tip、attribution_family=open_attempt.family，并在同事务把
attempt 标 failed、折入 family、清槽、落 event+mailbox。task 不 done。折入一个已
丢弃产出的 family 是有意保守：直到接手者完成并推进 span tip 前，该 family 不能
做 reviewer。

### 2.2 merge capability 的全部签发点

`github_merge` capability 只有两个签发点：

1. founder approval 事务为 action attempt 1 签发新授权；
2. ActionReconciler 在 current founder approval、target head、DAG 成功状态均未变，
   且 action 未超限时，为 attempt 2..N 有界再武装，并落
   `action_capability_rearmed` event。

第二点只是同一 founder authority 的受限续用，不是 agent/reconciler 自授权；除这
两点外 kernel 拒绝 mint。

### 2.3 有界重试与超限结算

项目配置与版本化缺省：

```text
actions.max_attempts_per_effect = 6
actions.retry_backoff_base_ms = 120000
actions.retry_backoff_cap_ms = 900000
actions.executing_reconcile_after_ms = 300000
```

有效策略只固化在 actions 行；event 只存 action uid + policy digest。确定失败且
未超限时：

```text
next_retry_at =
  failed_at + min(base * 2^(action_attempt_no - 1), cap)
```

ActionReconciler 是唯一自动重试触发者。未到点不能新建 attempt；到点后仍须重验
current approved gate 绑同 head、DAG 全 done、PR 未 merged、observed head 未漂移。

若本次 `action_attempt_no == max_attempts`，失败结算事务按固定顺序：

1. CAS 本 action `executing→failed`；
2. 直接 CAS expire 仍指向同 gate/head 的 current gate；
3. `next_retry_at=NULL`；
4. 写去重 `action_retry_exhausted` event + founder mailbox。

此路径不调用 `invalidate_ship_authority`：后者保护并发业务变更与 executing action
的竞态，不能用于 action 自身结算。SQLite 写串行化使并发 rework/revision 只能看到
整笔结算前或结算后。超限后必须 fresh founder approval 才能重新开始。

合法 rework/revision/revocation 在通用失效事务内还会把同 gate/effect 的 failed
action `next_retry_at` 清 NULL。若旧行仍到达 reconciler，发现 gate 已合法失效时
只静默清理，不重复 expire 或告警；只有 gate 仍 current approved 而 head/DAG 等
谓词意外变化才发 `action_retry_precondition_changed`。

## 3. R6 recovered findings close

| finding | close |
|---|---|
| failed retry row not cleared on invalidation | §5.4 失效事务清 failed.next_retry_at；reconciler 将“gate 已合法失效”列为静默终局 |
| reconcile threshold default missing | `actions.executing_reconcile_after_ms` 版本化缺省=300000（5min），随其它策略固化在 actions 行 |
| delta doc normative status | 抬头与本节明确本文件仅为非权威评审记录；唯一规范=`mapping-v2final.md`，不并入 FINAL/design-chain |

## 4. 一致性断言

- ship 仍只验：founder approval 绑 current head、DAG 全成功、GitHub head 未漂移；
  本增量没有加入 review/QA/docs/session-role 第四条。
- ActionReconciler 只有 GitHub read-only credential；merge 仍由 agent 亲手执行。
- dispatcher 仍只看库拉进程；不路由、不读内容、不执行外部 effect。
- 本增量只完善已枚举的 lost worktree、CI 暂拒、外呼断电场景，没有按 PRD/QA/
  三段式写特例。

## 5. 评审结果记录

reviewer 在 head `8edee28167184763dd34c868d4f978ed5731111d` 返回
`APPROVED`，但 review 服务因序列化缺陷把 verdict 记录为 `no_verdict`。Lead 从
`failure_raw` 恢复该结果；其中 1 MEDIUM + 2 LOW 已在 head `0b3b7c0e` 关闭，Lead
逐条核过 `8edee281..0b3b7c0e` diff 后放行并入 FINAL/design-chain。

这不是把失败当通过，也不标作“supervised-approved”；准确口径是：
**reviewer APPROVED，verdict 丢失后由 Lead 恢复，findings 修复由 Lead 复核。**
