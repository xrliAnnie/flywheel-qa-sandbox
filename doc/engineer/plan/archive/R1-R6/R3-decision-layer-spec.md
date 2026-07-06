# Research Plan R3: Decision Layer 模式 → Phase 2 决策层设计

> 优先级：🔴 High
> 影响 Phase：Phase 2（Decision Loop）
> 输入：`doc/engineer/research/new/006-decision-layer-patterns.md`
> 预期产出：`doc/engineer/exploration/new/v0.2-decision-layer.md`

## 目标

为 Flywheel Phase 2 设计 Decision Layer 的完整 spec，整合 awesome-llm-apps Trust Layer、AG2 Triage→Route→Verify 流程、MobileAgent InfoPool、deer-flow DanglingToolCall 修复。

## 研究任务

### 1. 深入分析 awesome-llm-apps Trust Layer

- 读取 `/tmp/awesome-llm-apps/` 中 Trust Layer 相关代码
- 重点分析：
  - 信任分数 0-1000 模型 + TrustLevel enum
  - `DelegationScope.narrow()` 权限递减
  - AuditEntry schema
  - SCORE_ADJUSTMENTS 配置
- 适配：Flywheel 的信任对象是"决策类型"（auto_merge / skip_review），不是 agent

### 2. 深入分析 AG2 Triage→Route→Verify

- 读取 `/tmp/awesome-llm-apps/` 中 AG2 Research Team 相关代码
- 提取三阶段决策流程
- 适配 Flywheel：
  - Triage（Haiku）→ auto_approve / needs_review / blocked
  - Execute（按 route 执行）
  - Verify（Haiku，仅 auto_approve 时）

### 3. 分析 DevPulseAI Utility vs Agent 区分

- 提取"确定性工作不需要 LLM"原则
- 分析 LLM fallback → heuristic 降级模式
- 定义 Flywheel 中哪些决策是 utility（规则引擎）、哪些需要 LLM

### 4. 分析 MobileAgent InfoPool + 错误恢复

- 读取 `/tmp/MobileAgent/` 中 InfoPool 相关代码
- 提取 ExecutionContext（action_history, error tracking）
- 提取 consecutive failure threshold → replan 模式

### 5. 分析 deer-flow DanglingToolCall 修复

- 读取 `/tmp/deer-flow/` 中 DanglingToolCallMiddleware
- 评估 Flywheel Blueprint 重试场景是否需要此逻辑

### 6. 设计 Phase 2 Decision Layer

基于以上分析，设计：

- **Hard Rules**（no LLM）：auth/billing/security → always escalate
- **Haiku Triage**：prompt 模板 + 输入/输出格式
- **Route 执行**：auto_approve → verify → merge / needs_review → Slack / blocked → shelve
- **ExecutionContext**：session 执行状态追踪
- **Fallback**：LLM 不可用时的 heuristic 降级
- **Audit Log**：每个决策的审计记录

## 产出

### 主要文件
- `doc/engineer/exploration/new/v0.2-decision-layer.md` — 完整的 Decision Layer 设计

### 文件内容要求
1. **Architecture overview**（Mermaid 图）— Hard Rules → Haiku Triage → Route → Verify
2. **Hard Rules 列表** — 哪些场景直接 escalate（不经过 LLM）
3. **Haiku Triage prompt** — 完整的 prompt 模板 + few-shot examples
4. **ExecutionContext TypeScript interface** — session 状态追踪
5. **AuditEntry TypeScript interface** — 决策审计日志
6. **Fallback heuristic** — LLM 降级时的规则引擎
7. **DanglingToolCall 处理** — Blueprint 重试场景的清理逻辑
8. **CIPHER 预留** — Phase 5 的 CIPHERPattern schema（候选→验证→信任）
9. **Slack 通知格式** — needs_review 时发送的消息模板

### 更新
- 更新 `MEMORY.md`：新增 Phase 2 Decision Layer 设计决策

## 参考资料

- `doc/engineer/research/new/006-decision-layer-patterns.md`（已有研究摘要）
- `/tmp/awesome-llm-apps/`（已 clone）
- `/tmp/deer-flow/`（已 clone）
- `/tmp/MobileAgent/`（已 clone）
