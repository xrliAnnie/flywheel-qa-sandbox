# Research Plan R6: 多机协调 — 共识机制评估

> 优先级：🟢 Low
> 影响 Phase：Phase 5+（远期）
> 输入：`doc/engineer/exploration/new/v0.2-trending-repo-survey.md`（ruflo Raft/BFT 部分）
> 预期产出：`doc/engineer/research/new/008-multi-machine-consensus.md`

## 目标

评估 Flywheel 扩展到多台 Mac 执行时所需的协调和共识机制。这是远期需求，本 research 的目标是**轻量级调研 + 记录**，不做深度设计。

## 研究任务

### 1. 分析 ruflo 的 Raft/BFT 实现

- 读取 `/tmp/ruflo/` 中共识相关代码
- 评估实现完整度（真实 vs vaporware）
- 提取可参考的 TypeScript interface

### 2. 评估多机场景需求

Flywheel 多机执行时需要解决的问题：

- **Task 分配**：哪台机器执行哪个 issue？
- **状态同步**：execution state 如何跨机器共享？
- **冲突避免**：两台机器不能同时执行同一个 issue
- **故障转移**：一台机器挂了，task 如何转移？

### 3. 方案评估

对比：

- **中心化调度**（最简单）：一台 coordinator 分配任务给 workers
- **Raft 共识**：强一致性，leader election
- **简单锁**：Redis/SQLite 分布式锁
- **Message Queue**：RabbitMQ/Redis Stream

### 4. 推荐路径

基于 Flywheel 的规模（2-5 台 Mac），推荐最简单可行的方案。

## 产出

### 主要文件
- `doc/engineer/research/new/008-multi-machine-consensus.md` — 多机共识评估（轻量级）

### 文件内容要求
1. **需求分析** — 多机场景下的核心问题
2. **方案对比表** — 中心化 vs Raft vs 锁 vs MQ
3. **推荐方案** — 基于 Flywheel 规模的建议
4. **ruflo 实现评估** — 可参考程度
5. **Timeline** — 什么时候需要开始考虑多机

## 参考资料

- `/tmp/ruflo/`（已 clone）
- `doc/engineer/exploration/new/v0.2-trending-repo-survey.md`
