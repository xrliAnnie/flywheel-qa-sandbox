# Research: Decision Layer 模式调研

> 来源：awesome-llm-apps (Trust Layer, DevPulseAI, AG2), MobileAgent (InfoPool), ruflo (ReasoningBank)
> 影响范围：Phase 2（Decision Loop）、Phase 5（Decision Intelligence / CIPHER）
> 状态：研究完成，待 architecture 整合

## 1. 背景

Flywheel 的 Decision Layer 规划：
- Phase 2：Haiku 做简单判断（继续 / 阻塞 / 升级给人类）
- Phase 5：CIPHER 学习（vector distance + Haiku score → 自动审批）

本研究从多个项目中提取可复用的决策模式。

## 2. 信任分数模型（awesome-llm-apps Trust Layer）

### 数据结构

```typescript
enum TrustLevel {
  SUSPENDED = "suspended",    // 0-299
  RESTRICTED = "restricted",  // 300-499
  PROBATION = "probation",    // 500-699
  STANDARD = "standard",      // 700-899
  TRUSTED = "trusted",        // 900-1000
}

interface TrustScore {
  agentId: string;
  score: number;              // 0-1000
  level: TrustLevel;
  history: ScoreAdjustment[];
}

const SCORE_ADJUSTMENTS = {
  task_completed: +10,
  stayed_in_scope: +5,
  scope_violation_attempt: -50,
  security_violation: -100,
  delegation_success: +15,
  delegation_failure: -25,
};
```

### 权限递减（DelegationScope.narrow()）

```typescript
interface DelegationScope {
  allowedActions: Set<string>;
  deniedActions: Set<string>;
  maxTokens: number;
  timeLimitMinutes: number;
  maxSubDelegations: number;  // 能否再次委托

  narrow(childScope: DelegationScope): DelegationScope {
    return {
      // 交集：只保留双方都允许的
      allowedActions: intersection(this.allowedActions, childScope.allowedActions),
      // 并集：任一方禁止的都禁止
      deniedActions: union(this.deniedActions, childScope.deniedActions),
      // 最小值：取更严格的限制
      maxTokens: Math.min(this.maxTokens, childScope.maxTokens),
      timeLimitMinutes: Math.min(this.timeLimitMinutes, childScope.timeLimitMinutes),
      maxSubDelegations: Math.max(0, this.maxSubDelegations - 1),
    };
  }
}
```

### 审计日志

```typescript
interface AuditEntry {
  timestamp: string;
  eventType: string;
  agentId: string;
  action: string;
  delegationId?: string;
  result: 'allowed' | 'denied' | 'error';
  details: Record<string, unknown>;
  trustImpact: number;        // +10, -50, etc.
}
```

### 适配 Flywheel CIPHER

Flywheel 的信任对象不是 "agent"，而是 "决策类型"：

```typescript
interface CIPHERTrustScore {
  decisionType: string;       // "auto_merge" | "skip_review" | "parallel_execution"
  projectId: string;
  score: number;              // 0-1000
  level: TrustLevel;
  history: ScoreAdjustment[];
}

// 示例：
// "auto_merge" for GeoForge3D: score=850 (TRUSTED) — 历史上 95% 的 auto-merge 成功
// "auto_merge" for new-project: score=500 (PROBATION) — 新项目，需要积累信任
```

## 3. Utility vs Agent 区分（DevPulseAI）

### 原则

> 确定性工作不需要 LLM。Agent 只用于需要推理判断的地方。

```
DevPulseAI 流水线：
  SignalCollector (utility, no LLM) → RelevanceAgent (LLM) → RiskAgent (LLM) → Synthesizer (LLM)

Flywheel 对应：
  GitResultChecker (utility) → Blueprint (utility) → Decision Layer (LLM/Haiku)
  DagResolver (utility) → DagDispatcher (utility) → Decision on blocked issue (LLM/Haiku)
```

### LLM Fallback → Heuristic

```typescript
// DevPulseAI 模式：LLM 不可用时降级
async function makeDecision(context: DecisionContext): Promise<Decision> {
  try {
    return await haikuDecision(context);     // primary: Haiku LLM
  } catch (error) {
    return heuristicDecision(context, error); // fallback: 规则引擎
  }
}

function heuristicDecision(context: DecisionContext, error: string): Decision {
  // 硬规则
  if (context.issueType === 'security') return { action: 'escalate', reason: 'security always escalates' };
  if (context.consecutiveFailures >= 3) return { action: 'escalate', reason: 'too many failures' };

  // 默认：安全选择
  return { action: 'shelve', reason: `LLM unavailable: ${error}. Shelving for human review.` };
}
```

## 4. Triage → Route → Verify 流程（AG2 Research Team）

### 三阶段决策

```
Triage Agent (轻量模型)
  ↓ 输出：route = "continue" | "escalate" | "shelve"
  ↓
Execute Agent (按 route 执行)
  ↓ 输出：action result
  ↓
Verifier Agent (中等模型)
  ↓ 输出：verified = true | false, gaps = [...]
```

### 适配 Flywheel Decision Layer

```
Issue 完成后：
  ↓
Triage (Haiku, cheap)
  输入：git diff, commit messages, test results
  输出：{ route: "auto_approve" | "needs_review" | "blocked" }
  ↓
  route=auto_approve → 直接 PR merge
  route=needs_review → Slack notify CEO，附 diff summary
  route=blocked → 分析原因，创建 follow-up issue
  ↓
Verify (Haiku, 仅 route=auto_approve 时)
  输入：PR diff, test coverage, lint results
  输出：{ approved: boolean, concerns: string[] }
```

## 5. InfoPool 共享状态 + 错误恢复（MobileAgent）

### 核心模式

```typescript
interface ExecutionContext {
  // 任务
  issueId: string;
  instruction: string;          // Linear issue title + description

  // 工作记忆
  actionHistory: string[];      // 已执行的步骤
  actionOutcomes: ('success' | 'failure' | 'error')[];
  commitMessages: string[];

  // 规划状态
  plan: string;                 // 高级计划
  currentSubgoal: string;       // 当前目标
  completedSubgoals: string[];  // 已完成的子目标

  // 错误追踪
  consecutiveFailures: number;
  errorThreshold: number;       // 默认 2
  errorFlagReplan: boolean;     // 触发重规划
}
```

### 连续失败阈值

```typescript
function checkErrorThreshold(ctx: ExecutionContext): void {
  if (ctx.consecutiveFailures >= ctx.errorThreshold) {
    ctx.errorFlagReplan = true;
    // → 触发 Decision Layer 介入
    // → Slack notify: "Issue GEO-XX failed 2 consecutive attempts"
    // → 等待 CEO 指导 或 自动 shelve
  }
}
```

## 6. ReasoningBank Pattern 晋升（ruflo）

### 模式

```typescript
interface ReasoningPattern {
  id: string;
  description: string;
  embedding: number[];
  tier: 'short_term' | 'long_term';
  usageCount: number;
  qualityScore: number;        // 0-1
  createdAt: string;
  lastUsedAt: string;
}

// 晋升规则：
// short_term → long_term 当 usageCount >= 5 AND qualityScore >= 0.7
// long_term → archived 当 lastUsedAt > 90 days ago
```

### 适配 CIPHER

```typescript
// 决策模式的晋升
interface CIPHERPattern {
  id: string;
  decisionType: string;
  context: string;              // "When PR has only test changes..."
  decision: string;             // "Auto-approve"
  embedding: number[];

  tier: 'candidate' | 'validated' | 'trusted';
  validationCount: number;      // CEO 确认次数
  overrideCount: number;        // CEO 推翻次数

  // 晋升条件：
  // candidate → validated: validationCount >= 3 AND overrideCount == 0
  // validated → trusted: validationCount >= 10 AND overrideCount <= 1
  // trusted → demoted: overrideCount > 2 in last 30 days
}
```

## 7. DanglingToolCall 修复（deer-flow）

### 问题

当 Claude Code session 被中断（tmux kill、timeout、用户 Ctrl+C），message history 里会出现有 `tool_calls` 但没有对应 `ToolMessage` 的 AIMessage，导致下次重试 LLM 报错。

### 解决方案

```python
# deer-flow: DanglingToolCallMiddleware
# 扫描 message history，在中断位置插入合成的错误 ToolMessage

for msg in messages:
    if hasattr(msg, 'tool_calls') and msg.tool_calls:
        for tc in msg.tool_calls:
            if tc['id'] not in seen_tool_responses:
                # 插入合成的 ToolMessage
                synthetic = ToolMessage(
                    tool_call_id=tc['id'],
                    content=f"Error: Tool call was interrupted. Session was terminated before completion.",
                )
                patched_messages.append(synthetic)
```

### Flywheel 适配

Blueprint 重试失败 issue 时需要此逻辑。当 TmuxRunner 超时或被手动终止，下次重试前需要清理 orphan tool calls。

## 8. 综合架构建议

### Phase 2 Decision Layer（最小可行）

```
                    ┌─────────────────┐
                    │  Hard Rules     │ ← auth/billing/security → always escalate
                    │  (no LLM)       │
                    └────────┬────────┘
                             ↓ pass
                    ┌─────────────────┐
                    │  Haiku Triage   │ ← auto_approve / needs_review / blocked
                    │  (cheap LLM)    │
                    └────────┬────────┘
                             ↓
              ┌──────────────┼──────────────┐
              ↓              ↓              ↓
         auto_approve   needs_review      blocked
              ↓              ↓              ↓
          Haiku Verify   Slack notify   Analyze + shelve
              ↓              ↓
          PR merge      CEO decides
```

### Phase 5 CIPHER（进阶）

```
Hard Rules → CIPHER Pattern Match (vector + score)
  ↓ high confidence match → auto-decide (trusted tier)
  ↓ medium confidence → Haiku verify
  ↓ low confidence → escalate to human
  ↓ no match → Haiku triage (create new candidate pattern)
```

## 9. Follow-up Session 建议

### Session R3: Decision Layer Spec

**目标**：为 Phase 2 设计 Decision Layer 的完整 spec

**输入**：
- 本研究文档
- awesome-llm-apps Trust Layer 源码
- MobileAgent InfoPool 设计
- Flywheel 当前 architecture（Haiku 决策 + Slack 通知）

**输出**：
- `doc/engineer/exploration/new/v0.2-decision-layer.md`
- Hard rules 列表
- Haiku triage prompt 模板
- AuditEntry schema
- ExecutionContext schema

### Session R3b: CIPHER Pattern Promotion

**目标**：设计 CIPHER 的 pattern 晋升机制

**输入**：
- ruflo ReasoningBank
- memU salience 排序
- Flywheel Dual-Gate 设计（vector distance + Haiku score）

**输出**：
- `doc/engineer/exploration/new/v0.5-cipher-learning.md`
- CIPHERPattern schema
- 晋升/降级规则
- sqlite-vec 集成方案
