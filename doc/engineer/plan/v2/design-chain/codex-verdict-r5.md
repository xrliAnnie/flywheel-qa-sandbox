APPROVED

# Flywheel v2 设计稿 v5 窄复审 R5

- 评审对象：`/tmp/design/review-prompt-r5.md`
- 设计稿 SHA-256：`91d4170bbe9893cc69cb87c22d1a5b5c3a1d1d8fa2b8222951392ec4637b6d3d`
- R4 基线：`/tmp/design/codex-verdict-r4.md`
- 评审边界：只核对 R4 给出的 3 项 R5 最小修改集；不重开既有结论。

## 结论

3 项修改均已闭合，本轮窄复审无阻断项。

| R5 最小修改项 | 判定 | 证据 |
|---|---|---|
| 1. 合法静态双索引、绑定时间参数、迁移与 query-plan 验收 | 已闭合 | v5 给出两个仅含静态 predicate 的可执行 partial index；动态截止时间只在 scheduled 查询中以 `:now` 绑定；验收明确要求真实迁移建索引成功并用 `EXPLAIN QUERY PLAN` 证明两分支分别命中索引（`:32-39`）。既有“有界索引查询”合同仍保留（`:10`）。 |
| 2. `depends_on` 残名统一 | 已闭合 | §1.0 与 §1.1 均使用 `depends_on_command_id`，PK 统一为 `(command_id, depends_on_command_id)`（`:21,26`）；设计正文未检出独立旧名 `depends_on`。 |
| 3. P12 audit 合同定型 | 已闭合 | audit 唯一落点为 `commands.result_code`，成功/拒绝分别固定为 `succeeded`/`policy_denied`；每次尝试均在同一事务写 `events.kind='bypass_used'`，payload 必填字段与 `outcome` 枚举已写死；拒绝路径明确保留审计行且零业务副作用，并有正反断言（`:92-93`）。 |

## SQLite 实证

使用 SQLite `3.51.0` 按 v5 DDL 建表、建索引成功；代表性两分支带绑定参数执行 `EXPLAIN QUERY PLAN` 的结果分别为：

```text
SEARCH mailbox USING INDEX mailbox_pending_immediate (to_agent=?)
SEARCH mailbox USING COVERING INDEX mailbox_pending_scheduled (to_agent=? AND next_retry_at<?)
```

这验证了动态时间未进入 partial-index predicate，且 immediate/scheduled 两条访问路径可分别使用目标索引。实现阶段仍须把该真实迁移与 query-plan 断言固化为验收测试；这已由 v5 明确列入合同，不构成本轮设计阻断。
