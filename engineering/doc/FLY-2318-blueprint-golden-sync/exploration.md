# FLY-2318 Blueprint golden 同步 — 探索
Issue: FLY-2318 (https://linear.app/geoforge3d/issue/FLY-2318/main-%E7%BA%A2%E7%B4%A7%E6%80%A5-1067-%E4%B8%8E-1056-%E8%AF%AD%E4%B9%89%E5%90%88%E5%B9%B6%E5%86%B2%E7%AA%81blueprint-%E6%8F%90%E7%A4%BA%E8%AF%8D%E6%94%B9%E5%8A%A8%E6%9C%AA%E5%90%8C%E6%AD%A5%E5%88%B0-fly-2147-%E6%96%B0%E5%A2%9E%E7%9A%84-golden5-%E6%9D%A1)
日期: 2026-09-03
基于: 无

## 问题与边界

`origin/main@7e1c93cf7` 的 edge-worker 聚焦测试稳定复现 5 条失败：

- `Blueprint.fly1188-codex-prompt.test.ts` 2 条；
- `Blueprint.fly2147-runner-memory.test.ts` 3 条；
- 其余 34 条同组测试通过。

五条 diff 都显示实际 Blueprint prompt 比 golden 多同一句规则：

```text
Treat an inbox pending summary as unread runner-mailbox traffic, not as an empty inbox. Pending runner mailbox items may include answers to outstanding questions. Run `node <COMM_CLI> check <question-id>` for every question id shown before proceeding; inbox does not consume response bodies.
```

本单只处理 #1067 与 #1056 合入后的 golden 漂移。不能修改测试、删除或放宽逐字节断言，不能修改
Blueprint 生产语义，也不能顺带整理邻近提示词。

## 已确认假设

1. #1067 的新增句必须先由设计、语义测试和已接受 snapshot 三方证明，再能成为 golden 内容。
2. 受影响的源 golden 是 `fly1188-prompt-before-fly2147.txt` 与
   `fly2147-prompt-golden-unsupported-backend.txt`；现有测试分别复用它们，所以两处内容漂移表现为
   五条失败。
3. 修复必须保留守卫判别力：把两份 fixture 临时恢复为旧内容时，同一聚焦命令应精确重现五红；恢复
   新内容后必须 39/39 绿。
4. 这是纯测试 golden 数据同步，不新增生产行为、接口、依赖、迁移或渲染面。

## 方案比较

### 方案 A：同步两份 stale golden（采用）

在两份 fixture 的既有 inbox 指令之后插入 #1067 已批准的完整规则，保持与已更新 snapshot 的字节
一致。优点是修复直接对应语义合并冲突，生产代码与断言均不动，变异阳照能证明守卫仍有效。缺点是
手工维护的多个完整 prompt fixture 仍可能在未来并行合入时漂移；该结构性问题不属于本次紧急修复。

### 方案 B：撤回 Blueprint 新规则

让生产输出重新匹配 #1056 golden。它会破坏 FLY-2222 已批准的 pending mailbox 判据，并让现有 Claude/
Codex 语义测试失败；这不是同步 golden，而是回滚已合入行为，因此拒绝。

### 方案 C：让断言忽略新增行或从当前输出自动生成 expected

可以表面恢复 CI，但会把逐字节漂移守卫变成自证或部分比较，无法捕获未来的提示词漂移，且违反本单
硬约束，因此拒绝。

## 预期设计

数据流不变：Blueprint 生成 prompt，测试做机器路径归一化，再与完整 golden 逐字节比较。唯一改动是
两份 golden 在同一语义位置各新增一行。验证顺序为：当前基线五红 → 更新两份 fixture → 聚焦 39/39
绿 → 两份 fixture 同时恢复旧内容后精确五红 → 恢复修复后再绿 → 全仓门禁。任何不是这五条的新增失败
都单独诊断，不归因于本修复。
