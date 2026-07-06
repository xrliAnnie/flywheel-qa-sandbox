# Research: Lead-Driven Runner Lifecycle — FLY-102

**Issue**: FLY-102
**Date**: 2026-04-13
**Source**: Round 1 `doc/engineer/research/new/FLY-102-event-path-exit-research.md`
**Status**: Complete

## 背景

FLY-102 Round 2 QA 暴露出一个更深的架构问题：**Runner 结束后 tmux window 没被关掉**。GEO-362 的 Peter Runner 写完 `ready_to_merge` 并 `exit` 了 Claude CLI，但 tmux window 被 `remain-on-exit on` 保留；Bridge 的 `postMergeCleanup` 只在 `onApproved`（ship 动作）和 PR merged webhook 两条路径被触发，Lead **没有** MCP 工具可以主动关 Runner。

Annie 明确：**Lead 负责关 Runner，不是 Runner 自关**。触发时机是 **ship PR + worktree 清理 + docs 归档之后**。

本研究目标：
1. 总结 GeoForge3D orchestrator 的 Lead-driven lifecycle pattern
2. 梳理当前 Flywheel Runner exit 路径和差距
3. 汇总 Codex Q3+Q5 讨论结果
4. 沉淀设计决策 + tradeoff，供 plan 引用

## 1. Orchestrator Pattern（GeoForge3D）

路径：`~/Dev/geoforge3d/.claude/orchestrator/`

### 1.1 状态机

SQLite schema v6（`schema-v6.sql`）定义 agent 状态：

```
spawned → running → awaiting_approval → shipping → completed | failed | stopped
                                     ↘ waiting_for_impl（qa-parallel 专用）
```

关键不变量：
- `completed / failed / stopped` 是 **terminal state**，在 `state.sh` 里通过 `AND status NOT IN ('completed','failed','stopped')` 的 UPDATE 保护为不可改写
- `awaiting_approval` 是合法 **idle 状态**——agent 活着但在等 Annie review，**不自动关**
- `shipping` 是 Annie 批准后的主动收尾阶段（执行 ship + cleanup）

### 1.2 Cleanup 由 Lead 驱动

`cleanup-agent.sh:1` 注释：「called by lead after agent finishes or is stopped」

Lead 调 `cleanup-agent.sh $AGENT_NAME $DOMAIN $VERSION $FILENAME $TERMINAL_STATUS` 后，脚本按顺序：

1. `state_critical update_agent_status` — 写 terminal state 到 SQLite
2. 检查 incomplete plan steps（warning only）
3. **Doc archival**（锁保护的 git mv transaction）：exploration/research/plan `new/` → `archived/`
4. **Domain-specific cleanup**（按 executor type 分发）：
   - `backend` — destroy PD（personal-dev）+ worktree remove + local branch delete
   - `frontend` / `designer` — worktree remove + branch delete
   - `qa` — artifact preserve + report archive
   - `qa-parallel` — worktree artifacts preserve + skill-update temp branch delete
   - `plan-generator` — handoff rollback（失败时）
5. Release locks（`backend-env-lease` / `frontend-live-lease` / `docs-update` / `version-bump`）
6. Audio notification

### 1.3 启示（for Flywheel）

- **Lead 是 authority，agent 是 passive**。Agent 不自行 terminate；状态机语义 + cleanup 时机都由 Lead 掌控
- **Terminal state 不可改写**是一个强不变量，防止后续 bug 把 completed 覆盖成 running 再被错误 retry
- **Cleanup 按 executor type 分发**是已被验证可行的扩展点
- **`awaiting_approval`** 明确表达「活着但空闲」的语义，使得 Lead 不会误把 idle 当 stuck

---

## 2. Flywheel 现有 Runner Exit 路径梳理

当前 Flywheel 有 **8 条 exit 路径**散落在不同层，归为 4 类：

### 2.1 Runner 自身退出

| 路径 | 触发 | 位置 | 结果 |
|------|------|------|------|
| **(1) Blueprint system prompt** | Claude CLI 写完 `ready_to_merge` 或 `failed` 后 exit | `packages/edge-worker/src/Blueprint.ts:278,286` | Claude 进程结束，tmux pane dead（`remain-on-exit on` 下 window 仍存在） |
| **(2) TmuxAdapter timeout** | active 24h / waiting 12h（FLY-97） | `packages/tmux-adapter/` | tmux kill-window，session status → `timeout` |

### 2.2 Bridge 自动清理

| 路径 | 触发 | 位置 | 结果 |
|------|------|------|------|
| **(3) `postMergeCleanup` via `onApproved`** | Lead 执行 ship action（actions.ts approveExecution） | `packages/teamlead/src/bridge/plugin.ts:326` | 调 `killTmuxWindow` + audit event `post_merge_completed` |
| **(4) `postMergeCleanup` via PR merged webhook** | GitHub webhook → `event-route.ts` | `packages/teamlead/src/bridge/event-route.ts:480` | 同上 |

**⚠️ 命名误导**：`postMergeCleanup` 现在只做 tmux close + audit event，**不做** worktree/docs 归档。注释（post-merge.ts:4-6）已注明「Other cleanup (worktree, doc archive, MEMORY.md) is Runner/Orchestrator responsibility」，但函数名和调用方仍会让读者误以为它是 full cleanup orchestrator。

### 2.3 运维 / Guardrail

| 路径 | 触发 | 位置 | 结果 |
|------|------|------|------|
| **(5) HTTP `/api/sessions/:id/close-tmux`** | Stale patrol / 手工运维调用 | `plugin.ts:410` | kill tmux window（受 FLY-44 guard 保护） |
| **(6) FLY-44 guard** | `close-tmux` endpoint 调用时 | `plugin.ts:423-428` | 拒绝 `running` / `approved_to_ship` 状态（**但允许** `awaiting_review`）|

### 2.4 健康监测（只观察，不关）

| 路径 | 触发 | 位置 | 结果 |
|------|------|------|------|
| **(7) HeartbeatService** | Runner 定期 ping | `packages/teamlead/src/HeartbeatService.ts` | 更新 last_heartbeat，timeout 时把 session 标成 `timeout` |
| **(8) RunnerIdleWatchdog（FLY-92）** | system-level idle 检测 | `packages/teamlead/src/RunnerIdleWatchdog.ts` | 观察 `executing` / `waiting` / `unknown`，bubble up 到 CommDB，不直接关 |

### 2.5 差距分析

1. **Lead 没有 MCP 工具主动关 Runner**。`flywheel-terminal` 和 `flywheel-inbox` 两个 MCP server 都没暴露 close_runner 能力（grep 验证）
2. **`close-tmux` endpoint guard 太松**。允许关 `awaiting_review` 是 stale-patrol 的合理行为，但暴露给 Lead 就会误关正在等 review 的 Runner
3. **"Done" 信号缺失**。Runner 退 shell 不等于 "done"：`ready_to_merge` 写了不代表 PR merged；PR merged 不代表 worktree 清了
4. **Ship 完成后没有通知机制**。`postMergeCleanup` 做完 tmux close 就结束，Lead 没有收到「Runner X 完工可关」的触发信号，只能靠 Annie 在 Discord 里说
5. **状态机单薄**。CommDB session 只有 `running / completed / timeout / awaiting_review / approved / approved_to_ship` 等散落 status，没有像 orchestrator 那样的正交 `runtime_health × workflow_state × close_eligibility` 三轴分解

---

## 3. Codex Q3+Q5 讨论

完整讨论：`/tmp/codex-fly102-q3q5-feedback.md`。摘要：

### 3.1 Q3 — Lead 怎么关 Runner

**结论：方案 D（MCP tool + Bridge HTTP）**

Codex 把 5 个候选方案（A/B/C/D/E）分解后，推荐 **D = A 的 UX + D 的控制面**：

- Lead 侧新增 MCP tool `close_runner`
- tool **不直接 tmux kill**，而是调 Bridge 已存在的 `POST /api/sessions/:executionId/close-tmux`
- Lifecycle authority 留在 Bridge（scope check + audit + eligibility guard 集中在一处）

拒绝理由：
| 方案 | 拒绝理由 |
|------|----------|
| B（terminal-mcp 直接 tmux kill） | 绕过 Bridge 分层，破坏 scope/guard/audit 不变量 |
| C（shutdown_request 协议） | Flywheel Runner 不是 Agent Team teammate（tmux-hosted Claude CLI，非 mailbox-addressable），过度工程且违背 Annie "Lead 关 Runner" 原则 |
| E（shell 脚本封装） | 最终还是要调 Bridge HTTP，多一层调试面，价值有限 |

**Caveat（Codex 主动提醒）**：现有 `close-tmux` endpoint guard 只禁 `running` / `approved_to_ship`，**没禁** `awaiting_review`。给 Lead 暴露主动关能力时 **必须收紧**——否则 Lead 误调用会让正在等 review 的 Runner transcript 提前消失。

### 3.2 Q5 — idle / stuck / done 区分

**结论：短期不自动 close，只做通知**

Codex 核心论点：**Done 是业务完成信号，Idle/Stuck 是运行健康信号，二者必须硬解耦**。

- **Done** = `ship PR + postMergeTmuxCleanup + （可选）worktree/docs 归档` 都走完，由 Bridge 触发「可关闭」通知
- **Idle** = `session.status == running` + heartbeat recent + watchdog 观察到 `waiting`；合法状态，**不自动关**
- **Stuck** = heartbeat timeout / watchdog 长时间 `unknown` / tmux pane dead；异常状态，保留 artifact + 人工处置
- **Running** = 有 tool call，有 heartbeat recent

解耦理由：
1. Runner 退 shell 只说明 Claude CLI 结束，不等于业务完成
2. Stuck 不是 Done 的补集——bare shell prompt 在 review 后可能是正常结束，在 running 中是异常退出
3. 处理策略完全不同：Done → 执行收尾关闭；Stuck → 保留 artifact 告警

拒绝 B（新加 `done.json` 信号文件）：Flywheel 已有 `ready_to_merge` / land-status / session status / stage / PR state 多个信号面，再加会制造冲突。

拒绝 C（Bridge 自动判定 done 并自动关）：短期会把 FLY-102 从「控制面触发」扩成「事件编排系统重构」。

### 3.3 长期 executor lifecycle contract

Codex 建议引入三个正交轴（**不在 FLY-102 实现**）：

```
runtime_health: running | idle | stuck | gone
workflow_state: running | awaiting_review | approved_to_ship | shipped | archived
close_eligibility: no | suggested | yes | force_only
```

每个 executor type 声明自己的：
1. **progress signals**（heartbeat / stage / gate / watchdog）
2. **done signal**（backend: `ready_to_merge` + PR merged + worktree cleaned；designer: handoff delivered + artifacts archived；QA: test report finalized + routed；plan-generator: doc committed + handoff emitted）
3. **cleanup contract**（保留 worktree? transcript? artifact? 谁执行关闭?）
4. **close eligibility**（`eligible` / `blocked_by_cleanup` / `blocked_by_human_review` / `force_close_allowed`）

GeoForge3D orchestrator `cleanup-agent.sh` 的 domain 分发 case 语句是现成样板。

---

## 4. 设计决策

### 4.1 采纳的设计

| 决策 | 选择 | 理由 |
|------|------|------|
| Lead 关 Runner 机制 | MCP tool → Bridge HTTP | 不破坏 Bridge lifecycle authority，现有 `close-tmux` 只差 Lead trigger surface |
| MCP tool 宿主 | `flywheel-inbox`（待 plan 定最终位置） | inbox 更贴近「Lead 决策后动作」的语义；terminal 偏 observation |
| 新 endpoint 还是复用 | **新开** `POST /api/sessions/:id/close-runner` | 复用 `close-tmux` 需要 mode 参数，会让 stale-patrol 和 lead-initiated 两种语义纠缠；新 endpoint 允许独立演进 eligibility 策略 |
| Close eligibility（lead-initiated） | strict：只允许 `completed / failed / blocked` | 避免 review/approved_to_ship 状态被误关，兜底 FLY-44 guard 盲区 |
| Done 判定 | **不自动判定**；Bridge 在 ship 链路完成后发 Discord 通知 | 短期规避状态机重构；走 FLY-91 chat thread，Annie 能直接看到+回复 |
| 通知时机 | `postMergeTmuxCleanup` 成功后 + PR merged webhook 链路完成后 | 两条现有路径都收敛到同一通知函数 |
| `postMergeCleanup` 改名 | → `postMergeTmuxCleanup` | 明示只管 tmux，避免误解为 full cleanup orchestrator |
| `executor_type` 参数 | Bridge 内部函数签名预留 `executor_type?: string`；**MCP tool 不暴露** | Annie 决定长期架构占位但不暴露给 Lead，短期 default "engineer" |
| Idle/Stuck 检测 | 沿用 HeartbeatService + RunnerIdleWatchdog，**不和 done 耦合** | Codex 建议硬解耦，watchdog 只答 liveness |
| done.json 新信号文件 | **不加** | 现有信号面已足够 |
| shutdown_request 协议 | **不做** | Runner 非 teammate，不适用 |
| worktree/docs cleanup 搬进 Bridge | **不做** | Codex 警告会炸 scope；留给长期 executor lifecycle contract |

### 4.2 长期架构占位（FLY-102 不实现）

- **目录**：以后在 `packages/edge-worker/src/executors/` 按 type 分文件（`engineer-executor.ts` / `designer-executor.ts` / `qa-executor.ts`）
- **接口**：每个 executor 暴露 `doneSignal()` / `cleanupContract()` / `closeEligibility(session)` / `runtimeHealth(session)`
- **Bridge 分发**：`close-runner` endpoint 内部按 `executor_type` 查表走不同 eligibility 策略
- **状态机**：CommDB session 扩展到三正交轴（runtime_health / workflow_state / close_eligibility）
- **FLY-102 Round 3 只做**：
  - Bridge 内部 `close_runner()` 函数签名加上 `executor_type?: string`（default "engineer"）
  - 注释里标清以后怎么扩

---

## 5. Tradeoff

### 5.1 选 D 而非 C（shutdown_request 协议）的代价

- 短期：Lead 无法通过自然语言对话让 Runner 自己 graceful shutdown；必须经过 Bridge HTTP
- 长期：如果 Flywheel 未来引入 mailbox-addressable teammate runtime（类似 Claude Code Agent Team），这层 protocol 需要重新引入
- 缓解：Bridge 的 `close-runner` endpoint 是收敛点，未来加 shutdown_request 不会打破现有 API

### 5.2 选 Discord 通知而非 Lead inbox 的代价

- 短期：Annie 能看到、能回复，符合 FLY-91 chat thread 已铺好的基础设施
- 代价：Lead 需要从 Discord 消息推导"该调 close_runner 了"，不是直接收到结构化事件
- 缓解：通知消息格式固定（见 plan），Lead prompt 加识别规则；长期可加 Lead inbox 双写

### 5.3 选 strict eligibility 而非 loose 的代价

- 短期：Lead 想关 `awaiting_review` 或 `approved_to_ship` 的 Runner 会被拒，需要 Annie 先走 approve flow
- 好处：兜住 Lead prompt 判断错误的场景（误以为 Runner 完工实际还在等 review）
- 缓解：endpoint 返回明确的 `error_code` 让 Lead 知道哪个状态被拒，Lead prompt 可以向 Annie 解释

### 5.4 不做自动 done 判定的代价

- 短期：每次 Runner 完工都要 Annie 显式说「关 X」（或 Lead 根据通知按 rules 自动调 close_runner）
- 代价：不能完全自动化
- 对照长期：一旦引入 executor lifecycle contract 和 three-axis 状态机，可以把自动判定补回来

---

## 6. Open Questions（已由 Annie 答复）

| Q | Annie 决策 |
|---|------------|
| 方案 D 接受吗 | ✅ 接受 |
| 通知机制走 Discord 还是 Lead inbox | Discord（FLY-91 thread） |
| postMergeCleanup 改名还是扩功能 | 改名（不扩功能） |
| `close_runner` 带 executor_type 参数 | Bridge 内部预留，MCP tool 不暴露 |
| FLY-102 范围 "短期 5 步" | ✅ OK |

## 7. Downstream

→ 本研究 → `doc/engineer/plan/draft/v1.23.0-FLY-102-lead-driven-runner-lifecycle.md`（待 Codex design review）
