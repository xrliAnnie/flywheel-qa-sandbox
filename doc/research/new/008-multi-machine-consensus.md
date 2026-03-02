# Research 008: 多机协调 — 共识机制评估

> 优先级：Low（Phase 5+ 远期需求）
> 日期：2026-03-01
> 来源：ruflo 代码实分析 + Flywheel 场景评估

---

## 1. 需求分析

Flywheel 目前是单机运行（本地 Mac）。假设未来扩展到 2-5 台 Mac 同时执行，需要解决以下核心问题：

### 1.1 Task 分配

**问题**：哪台机器负责执行哪个 Linear issue？

- 每个 issue 只能被一台机器认领，不能重复执行
- 需要原子性的"认领"操作（claim-and-lock）
- DAG resolver 需要感知跨机器的依赖状态

**难点**：无中心化协调者时，多台机器同时轮询 Linear 可能同时认领同一个 issue。

### 1.2 状态同步

**问题**：execution state（哪些 issue 正在执行、已完成、失败）如何跨机器共享？

- 机器 A 执行完 issue-1，机器 B 的 DAG resolver 需要感知 issue-1 已完成，才能解锁依赖它的 issue-2
- 每台机器的 `.flywheel/` 本地状态不能满足跨机器可见性需求

### 1.3 冲突避免

**问题**：两台机器不能同时执行同一个 issue（会产生互相冲突的 git commit）。

- 需要 mutual exclusion（互斥锁）语义
- 两台机器操作同一 repo 的同一 branch 会产生 force-push 冲突

### 1.4 故障转移

**问题**：一台机器崩溃（断网、宕机、Claude Code 无响应），其正在执行的 task 需要被接管。

- 需要 heartbeat + timeout 机制
- 接管后需要判断 task 是否已部分完成（有 commit 但无 PR？）

---

## 2. 方案对比表

| 维度 | 中心化 Coordinator | Raft 共识 | 分布式锁（SQLite/Redis） | Message Queue |
|------|--------------------|-----------|--------------------------|---------------|
| **原理** | 一台 Mac 作为 Leader，其余为 Worker；Leader 串行分配任务 | 多节点选举 Leader，强一致 log 复制 | 每台机器竞争获取任务锁，获锁者执行 | 任务放入队列，各机器消费 |
| **实现复杂度** | 低（~200 LOC） | 极高（需完整网络层） | 中（~100 LOC） | 中（依赖 Broker） |
| **故障容忍** | SPOF：Leader 挂了整体停止 | Leader 挂了自动重选（需 ≥3 台） | 锁服务挂了整体停止 | Broker 挂了整体停止 |
| **一致性** | 强（Leader 串行分配） | 强（log 复制一致） | 强（锁互斥） | 至少一次（需幂等处理） |
| **2-5 台规模适配** | 极好（为小集群设计） | 偏大（3 台是最小实用节点数） | 好（轻量级） | 好（成熟方案） |
| **运维负担** | 低（单个进程） | 极高（Raft 库 + 网络层） | 中（依赖 Redis 或共享 SQLite） | 中（依赖 Broker 进程） |
| **网络依赖** | Worker→Leader HTTP/WS | 所有节点两两互通 | 所有节点→锁服务 | 所有节点→Broker |
| **Flywheel 适配性** | ✅ 首选 | ❌ 过度工程 | ✅ 次选 | ⚠️ 备选 |

**关键结论**：Flywheel 的 2-5 台规模，Raft 是典型的 overengineering。中心化 Coordinator 模式（一台是 Leader，其余是 Worker）是最简单且最适配的方案。

---

## 3. ruflo 实现评估

### 3.1 代码结构概览

ruflo（github.com/ruvnet/ruflo）是 AI agent orchestration 框架。v3 中包含 `@claude-flow/swarm` package，实现了三种共识算法：

```
/tmp/ruflo/v3/@claude-flow/swarm/src/consensus/
├── raft.ts        443 LOC  — Raft leader election + log replication
├── byzantine.ts   431 LOC  — PBFT-style 三阶段提交（pre-prepare / prepare / commit）
├── gossip.ts      513 LOC  — Gossip 协议最终一致性
└── index.ts       267 LOC  — ConsensusEngine factory + algorithm selector
```

总计 1,654 行，有配套测试（`__tests__/consensus.test.ts`，553 行）。

### 3.2 Raft 实现分析

**接口设计**（摘自 `raft.ts`）：

```typescript
export type RaftState = 'follower' | 'candidate' | 'leader';

export interface RaftNode {
  id: string;
  state: RaftState;
  currentTerm: number;
  votedFor?: string;
  log: RaftLogEntry[];
  commitIndex: number;
  lastApplied: number;
}

export class RaftConsensus extends EventEmitter {
  async initialize(): Promise<void>
  async propose(value: unknown): Promise<ConsensusProposal>
  async vote(proposalId: string, vote: ConsensusVote): Promise<void>
  async awaitConsensus(proposalId: string): Promise<ConsensusResult>
  handleVoteRequest(candidateId: string, term: number, lastLogIndex: number, lastLogTerm: number): boolean
  handleAppendEntries(leaderId: string, term: number, entries: RaftLogEntry[], leaderCommit: number): boolean
}
```

**已实现的算法逻辑**：
- follower / candidate / leader 状态机
- currentTerm + votedFor 持久化字段（但只在内存中）
- 随机选举超时（默认 150-300ms）
- Leader heartbeat（默认每 50ms）
- RaftLogEntry 数据结构（term + index + command + timestamp）
- appendEntries / requestVote 协议接口（`handleVoteRequest` / `handleAppendEntries`）
- 多数派 quorum 检查（majority = floor((peers+1)/2) + 1）
- commitIndex 更新逻辑

**致命缺陷 — 无网络传输**：

```typescript
// raft.ts line 257-269
private async requestVote(peerId: string): Promise<boolean> {
  const peer = this.peers.get(peerId);
  if (!peer) return false;

  // Local vote request - uses in-process peer state
  // Grant vote if candidate's term is higher
  if (this.node.currentTerm > peer.currentTerm) {
    peer.votedFor = this.node.id;
    peer.currentTerm = this.node.currentTerm;
    return true;
  }
  return false;
}
```

`peers` 是同一个 Node.js 进程内的 `Map<string, RaftNode>`。节点间"通信"是直接操作内存对象，没有任何网络调用。对整个 `consensus/` 目录搜索 `http`、`tcp`、`socket`、`websocket`、`grpc`、`fetch`、`net.` 关键词，返回零结果。

`federation-hub.ts` 中有一句注释自白：

```typescript
// In real implementation, this would send to the target swarm's endpoint
// For now, we emit an event that can be listened to
this.emit('message', message);
```

### 3.3 BFT 实现分析

`byzantine.ts` 实现了 PBFT 三阶段协议的消息类型和状态机：

```typescript
export type ByzantinePhase = 'pre-prepare' | 'prepare' | 'commit' | 'reply';

export interface ByzantineMessage {
  type: ByzantinePhase;
  viewNumber: number;
  sequenceNumber: number;
  digest: string;
  senderId: string;
  timestamp: Date;
  payload?: unknown;
  signature?: string;   // 字段定义了，但实现中永远不填充
}
```

容错计算公式正确（`f = floor((n-1)/3)`，需要 `2f+1` 节点），视图切换（view change）也有基本实现。

但 `computeDigest()` 是玩具级别的 djb2 hash，没有任何加密签名验证，`signature` 字段从未被赋值或校验。`broadcastMessage` 同样只是 `EventEmitter.emit()`。

### 3.4 Gossip 实现分析

`gossip.ts` 是三者中相对最完整的实现：

- 消息有 TTL + hop 计数，防止无限传播
- 支持 fanout（默认 3）随机邻居选择
- 有 anti-entropy 接口（`antiEntropy()`）做全量状态同步
- last-writer-wins 的状态合并策略

同样限制在单进程内，`sendToNeighbor()` 直接操作内存中的 `GossipNode` 对象。

### 3.5 测试完整度

测试文件覆盖：
- 单元测试：状态转换、vote 处理、quorum 计算
- 时序测试：等待选举超时（`setTimeout(resolve, 150ms)`）
- 边界情况：non-leader propose 抛异常、超时 resolve

测试可以通过，但仅测试了进程内逻辑，不能验证真实分布式场景。

### 3.6 v2 vs v3 对比

v2 中的 `ConsensusEngine.ts` 实现更简单直接，vote 是 `Math.random()` 模拟：

```typescript
// v2/src/core/ConsensusEngine.ts line 208-215
const votes: Vote[] = [];
for (const agentId of agentIds) {
  const vote: Vote = {
    decision: Math.random() > 0.2, // 80% approval rate
    confidence: 0.8 + Math.random() * 0.2, // High confidence in Raft
    reasoning: `Raft consensus vote for decision ${decision.id}`
  };
  votes.push(vote);
}
```

v3 在接口设计上有明显进步，但底层实现局限性相同。

### 3.7 综合评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 算法接口设计 | 7/10 | 接口干净，状态机数据结构合理，EventEmitter 模式好 |
| 算法逻辑完整度 | 6/10 | 核心逻辑覆盖，但有简化（digest 是玩具 hash，signature 未实现） |
| 网络传输层 | 0/10 | 完全缺失，只有进程内内存操作 |
| 持久化 | 0/10 | 所有状态在内存中，进程重启即丢失 |
| 生产可用性 | 1/10 | 不能用于真实多机场景 |
| 可参考价值（接口） | 7/10 | TypeScript interface 和 EventEmitter 模式可直接借鉴 |

**结论：ruflo 的共识代码是 well-structured vaporware。** 接口设计和算法思路有参考价值，但没有网络层和持久化，不能直接使用，需要完整重写才能用于生产。

---

## 4. 推荐方案

### 4.1 Flywheel 多机首选：中心化 Coordinator

对于 2-5 台 Mac 的规模，推荐最简单的中心化架构：

```
┌──────────────────────────────────────────────────────┐
│  Mac-1 (Coordinator + Worker)                        │
│  - HTTP server（内网监听 :8765）                      │
│  - SQLite state DB（本地，或 iCloud/NFS 挂载供共享）  │
│  - Linear poller                                     │
│  - 同时执行自身被分配的 task                          │
└──────────────────────────────────────────────────────┘
        ^  HTTP（认领 task / 报告状态 / 心跳）
        |
┌───────┴───────────────────────────────────────────────┐
│  Mac-2 / Mac-3 / Mac-4 (Workers)                      │
│  - 定期 GET /tasks/available   → 认领一个              │
│  - 定期 POST /tasks/{id}/heartbeat （每 30s）          │
│  - 完成后 POST /tasks/{id}/done                       │
│  - Coordinator 收不到心跳 → 60s 后重置 task 为可认领   │
└───────────────────────────────────────────────────────┘
```

**Task 认领的互斥保证**（SQLite 事务）：

```typescript
// Coordinator: 原子认领，SQLite 事务保证互斥
app.post('/tasks/claim', async (req) => {
  const { workerId } = req.body;
  const task = db.transaction(() => {
    const t = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'available'
      ORDER BY priority DESC
      LIMIT 1
    `).get();
    if (!t) return null;
    // WHERE status='available' 保证 compare-and-swap 语义
    const result = db.prepare(`
      UPDATE tasks
      SET status = 'running', worker_id = ?, claimed_at = ?
      WHERE id = ? AND status = 'available'
    `).run(workerId, Date.now(), t.id);
    return result.changes > 0 ? t : null;
  })();
  return task ?? { error: 'no_task_available' };
});
```

**故障转移**（心跳超时重置）：

```typescript
// Coordinator: 每分钟扫描超时心跳
setInterval(() => {
  const timeout = Date.now() - 60_000;
  db.prepare(`
    UPDATE tasks SET status = 'available', worker_id = NULL
    WHERE status = 'running' AND last_heartbeat < ?
  `).run(timeout);
}, 60_000);
```

**实现成本**：
- Task queue + 认领 API：约 100 LOC
- Heartbeat + 故障转移：约 60 LOC
- Worker client（认领 + 上报）：约 80 LOC
- 合计：约 240 LOC，2-3 天实现

**优点**：
- SQLite 事务天然保证互斥，无需额外锁服务
- 实现简单，可测试，无外部依赖
- 故障转移逻辑清晰

**缺点**：
- Coordinator 是 SPOF。在 2-5 Mac 规模下可接受：Coordinator 宕机 → Workers 停止认领新 task，正在执行的 task 继续直到完成，不丢失工作

### 4.2 次选方案：共享 SQLite 分布式锁

如果不想维护 Coordinator HTTP server，可用网络可访问的 SQLite（iCloud Drive 或 NFS）作为分布式锁：

```typescript
// 所有机器共享同一个 SQLite 文件（通过 iCloud / NFS 挂载）
const db = new Database('/Volumes/Shared/flywheel/state.db');

function claimTask(issueId: string, workerId: string): boolean {
  // CAS（Compare-And-Swap）语义：只在 status=available 时更新
  const result = db.prepare(`
    UPDATE tasks
    SET worker_id = ?, status = 'running', claimed_at = ?
    WHERE issue_id = ? AND status = 'available'
  `).run(workerId, Date.now(), issueId);
  return result.changes > 0;
}
```

**风险**：iCloud Drive 上的 SQLite WAL 模式在网络文件系统上存在已知并发 bug（`SQLITE_BUSY` 死锁），不推荐。NFS 更可靠但需要额外配置，且 Mac 间 NFS 配置复杂。

### 4.3 不推荐：Raft

即使引入 Raft，2-5 台 Mac 规模的成本/收益比极差：

- ruflo 的实现没有网络层，需要从零实现或引入 `node-raft` 等库
- 最小实用节点数 3（奇数），2 台 Mac 场景无法使用
- 需要处理网络分区、split-brain、log 持久化等复杂场景
- 收益是避免 Coordinator SPOF，但在 2-5 Mac 规模下这个收益可忽略不计

---

## 5. Timeline：什么时候需要考虑多机？

```mermaid
gantt
  title Flywheel 多机考虑时间点
  dateFormat  YYYY-QQ
  section 当前
    v0.1.1 Interactive Runner          :active, 2026-Q1, 2M
  section Phase 2-3（单机）
    Decision Loop + Slack              :2026-Q2, 2M
    Memory + Auto-Loop                 :2026-Q3, 2M
  section Phase 4（多机起步）
    中心化 Coordinator 实现             :2026-Q4, 1M
  section Phase 5+（扩展）
    多机稳定运行 + 考虑 Raft            :2027-Q1, 3M
```

**触发条件**（满足任一条即启动多机研发）：

1. **Issue 积压**：待执行 issue 队列长度持续 > 10，单机处理速度跟不上输入速度
2. **可靠性要求**：一台机器故障导致 task 停滞 > 1 小时，开始造成业务影响
3. **成本优化**：Claude Code API 成本需要在多个账号间分散以降低单账号用量

**当前建议**：不需要现在考虑多机。v0.1.0 ~ v0.1.1 阶段，单机 sequential 执行是正确的 MVP 选择。过早引入多机协调是典型的 overengineering。Phase 4（Auto-Loop 稳定运行后）才是多机的合理起点。

---

## 6. 附：可借鉴的 ruflo TypeScript 接口

ruflo 的实现不能直接使用，但 `IConsensusEngine` 接口设计思路 clean，未来实现 Coordinator API 时可以参考这套抽象：

```typescript
// 来自 /tmp/ruflo/v3/@claude-flow/swarm/src/types.ts

export interface ConsensusConfig {
  algorithm: 'raft' | 'byzantine' | 'gossip' | 'paxos';
  threshold: number;        // 多数派阈值，默认 0.66
  timeoutMs: number;        // 共识超时，默认 30000ms
  maxRounds: number;        // 最大轮数
  requireQuorum: boolean;   // 是否强制 quorum
}

export interface ConsensusProposal {
  id: string;
  proposerId: string;
  value: unknown;           // Flywheel 中对应 { issueId, workerId }
  term: number;
  timestamp: Date;
  votes: Map<string, ConsensusVote>;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
}

export interface ConsensusResult {
  proposalId: string;
  approved: boolean;
  approvalRate: number;
  participationRate: number;
  finalValue: unknown;
  rounds: number;
  durationMs: number;
}
```

Flywheel 的 Coordinator HTTP API 可以实现等价的 `propose()`（认领 task）+ `awaitConsensus()`（等待 SQLite 锁确认）语义，但使用远简单的实现。

---

## 总结

| 问题 | 结论 |
|------|------|
| ruflo 共识代码是真实实现吗？ | 否。接口完整、算法状态机正确，但没有网络传输层，是单进程内存模拟，不能用于真实多机场景 |
| Flywheel 需要 Raft 吗？ | 不需要。2-5 Mac 规模用中心化 Coordinator 最简单，Raft 是过度工程 |
| 何时考虑多机？ | Phase 4（Auto-Loop 稳定后），issue 积压持续 > 10 时 |
| 推荐方案 | 中心化 Coordinator + SQLite 事务认领（约 240 LOC），不引入任何分布式系统库 |
| ruflo 的参考价值 | TypeScript interface 设计可借鉴；算法实现不可直用 |

---

**参考资料**：
- ruflo v3 consensus: `/tmp/ruflo/v3/@claude-flow/swarm/src/consensus/`
- ruflo v2 consensus: `/tmp/ruflo/v2/src/core/ConsensusEngine.ts`
- Raft 论文：https://raft.github.io/
- PBFT 论文：Castro & Liskov, "Practical Byzantine Fault Tolerance" (OSDI 1999)
