# Code Review — FLY-2921 (Round 7, full re-review of 6a20c5bf5)

Status: APPROVED

审查 head：`6a20c5bf5423c83bba381f74c4a5142adca9e6df`。

基于 exact-head 源码审查，未发现需报告的 BLOCKER / MAJOR 正确性问题。本轮重新审查了 `352beecbd..6a20c5bf5` 的完整实现 diff，并对照 plan.md、implementation.md 及接受的设计决策追踪了：

- 状态转换、失败交还与恢复入口；owner/generation CAS、事务回滚、重复 replacement / Lead resume 的 event UID。
- 两次 migration 的跳过条件、旧 schema、FK、状态映射、active-run 门回填及 rollback SQL。
- replacement proof、coordinator 顺序与 launching table；receipt/completion/self-heal、C5 resident re-park、C7 拒绝与审计。
- TURN wake 跨库 re-arm、forward cursor、相同时间戳及 claim lease 边界、exhausted sweep 和 alerts；退役状态消费者及相关测试断言。

QA rework 未发现削弱 guard 的改动：

- retention anti-join 登记为 `protect`；核对实际归档策略后，相关 hold/resume 回执仍受保护。
- `FLYWHEEL_REWORK_DELTA_TIMEOUT_MS` 属于数值调参；精确登记未绕过参数校验或 C7 审计。
- compatibility 中 db.ts 的 SHA-256 与 exact-head blob 一致，rationale 准确覆盖 TURN wake hunks，未改变 Lead bootstrap 相关行为。
- `returned_to_lead` fixtures 与生产守卫一致，仍保留阻止错误恢复及暴露未完成 delivery 的断言。
- residue allowlist 限定具体文件与 token；C7 测试移除耗时上限后，仍验证 timeout 配置与 `rework_delta_unverified` 审计。

本轮未运行测试或 CI，未修改仓库。
