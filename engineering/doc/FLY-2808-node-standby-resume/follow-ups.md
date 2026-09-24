# FLY-2808 评审建议与后续项 — 调研
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-24
基于: plan.md、review-receipt.json

本文件只收「设计批准之后」产生的内容：上游评审建议的 disposition、Lead 后续决定，以及从 plan.md 移出的实现记录。plan.md 只含设计合同，评审收据绑定的是 plan.md 的 blob；本文件的变更不改变已批准的设计正文。

## 1. 上游设计评审 R2（APPROVED）建议的 disposition

| 优先级 | findingKey | 本轮 disposition |
|---|---|---|
| MEDIUM | sweep-scope-misses-core-and-claude-runner | 采纳。plan §7 的消费者普查 root 改为 `packages/ scripts/`，并把 `keepalive_park|design_done|getActiveSessions|getReadoptCandidateSessions` 加入模式；已知漏网点 `packages/core/src/workflow-fsm.ts`（ship_parked 出入边）与 `packages/claude-runner/src/codex-home.ts`（retireCodexExecutionHome）作为 N2 首批显式消费者 |
| MEDIUM | stale-worktree-context-after-head-advance | 采纳。plan §5.3「首次工作输入」前增加一步：恢复后首条业务输入必须携带 lastObservedHead→当前 HEAD 的提交/文件变更摘要与 dirty 差异，注入成功是 `resume_verified` 的条件；§8.1 场景 E 补断言「前移信息已送达被恢复会话」 |
| MEDIUM | single-issue-scope-vs-incremental-pr-landing | 澄清。「一张实现单」指 issue 粒度，不等于一个 PR；N3/N4 可按默认关闭分别合入，启用线仍以 §8 为准 |
| LOW | pane-loss-reconcile-missing-from-closure-list | 采纳。pane-loss / monitor-lost 巡检加入 plan §4 的周边闭包清单：已确认待命的节点不报 pane 丢失 |
| LOW | carrier-term-collides-with-existing-ship-gate-carrier | 采纳。实现命名避开裸 `carrier`（既有 ship gate carrier epoch 已占用该词），建议用 `process_body` / process lifecycle |

## 1.1 沙箱设计评审 R1（CHANGES REQUESTED → 全部采纳，已回写 plan）

| 严重度 | 问题 | disposition |
|---|---|---|
| HIGH | 恢复需求没有持久化权限类别，首条输入/兜底顺序可能把普通消息升级成 writer | 采纳。§2.1 新增需求 episode 记录（source_kind / `authority_mode` / 要求的 activation+TURN epoch / expiry / pending envelope）；§5.1 冻结 authority_mode；§5.3 改为固定四步：`resume_verified` 只含身份/model/cwd/进程核验 → TUI → writer 需求 TURN CAS → envelope 与原需求一次性投递；§6 兜底只继承 writer 需求权限，conversation_only 坏 handle 只 hold；矩阵新增场景 P |
| HIGH | manifest 无退下时 dirty 基线，「未提交改动仍在」不可机械验收 | 采纳。§2.1 新增 retire baseline（porcelain=v2 摘要、index tree、逐条 path+mode+digest）；§5.2 加 HEAD 祖先规则（`head_rewritten`）与逐条判定（`workspace_baseline_mismatch`）；矩阵 B/E 改为按 digest 验收 |
| HIGH | park outbox 版本兼容缺可执行 wire contract | 采纳。§9 新增 schema_version / 未知版本 hold 且 cursor 不前移 / 两阶段发布 / 回滚保留 v2 projector；矩阵新增场景 Q |
| MEDIUM | dispatch purpose 迁移与不可变 trigger 未落成合同 | 采纳。§2.1 / §9 两阶段迁移（nullable+回填 → trigger 替换）、purpose 服务端派生、NULL 按 fault_replacement 保守读、唯一计数查询；§9 允许该 trigger 替换作为「仅加字段」的唯一例外；矩阵新增场景 R |
| MEDIUM | `retirement_unconfirmed` 无收敛状态机 | 采纳。§3 新增闭集转换表（迟到同代退出→standby、仍活→fenced problem+stop-retry/safe-takeover、indeterminate→hold、Lead return-active、problem 中需求只排队）；§1 与 lifecycle 图补对应边；矩阵新增场景 O |
| LOW | PRD 引用 `25cf13506e…` 在本仓库不可解析 | 采纳。exploration.md 与 plan §2 改为 blob `f0e5610d…` + 首次可见提交 `40cde65e9…`；收据 schema 由 Bridge 固定，PRD blob 在 plan 正文固定 |

## 2. Lead 后续决定（已回写进 plan 的部分）

- question `11a10fbd`：无墙钟 TTL、单目录串行/跨目录最多 2、原会话最多 2 次 + 每需求 1 次明确丢上下文兜底、故障分账、泛化 completion/rework 一并覆盖 → plan §5.1 / §6 / §10。
- question `604dec16`：采纳一张完整实现单，内部按 N2–N5 四个可验收工作包推进 → plan §11。
- `[lead-instruction ec413437]`：`cleanup_unconfirmed` 闩锁期间 founder 面 `canResume=false`，并提供 Lead 审计重开路径（server 侧 actor/时间/原因留痕、旧尝试保留、恢复额度从审计边界重算）→ 已作为设计合同写入 plan §6 表格新增行，不再是可选 follow-up。

## 3. 从 plan 移出的实现记录（上游生产分支快照，非本设计节点交付）

上游 origin/flywheel-FLY-2808 在设计批准后于同一分支继续实现，其状态在这里只作参考：

- `workflow_execution_process_body` 保存 active → retiring → standby → resuming / resume_failed → closed 的代数化物理进程状态；整单终态才统一 close。
- completion、Heartbeat、pane-loss、Codex 自动 reowner、resident expiry、recipient terminal guard 与 writer replacement 预算读取同一 process-body 事实。
- Claude 持久实际 session id 并以精确 `--resume` 恢复；Codex 空/错 thread id fail closed；两 adapter 在身份回调前核 model/cwd，并在合法 HEAD 前移/dirty 时注入重读提示。
- rework coordinator 先领取 resume claim、拉起并核验，再激活 holder、授予 TURN、发送 wake；拉起失败不发 TURN。
- 同一 demand 原会话最多两次；耗尽后原子分配一次 `resume_fallback` 新 execution；与 `fault_replacement` 分账。
- founder 投影统一为 working / standby / problem；功能只在 `FLYWHEEL_NODE_STANDBY_RESUME=1` 的新 admission 上启用，默认关闭；路径覆盖 `FLYWHEEL_CLAUDE_SESSION_DIR` 需登记进 feature-flag truth 的 NON_FLAG_ALLOWLIST。

以上均需独立 code review 与 QA；这里的记录不是验收证据。

## 4. 仍开放、留给 N2–N5 的项

| 优先级 | 项 | 归属 |
|---|---|---|
| MEDIUM | retiring 状态缺有界 watchdog：adapter 超时 / 待命确认被拒可能把进程体留在 retiring | N2（60 秒 retirement_unconfirmed 的执行落点） |
| MEDIUM | dispatch ledger 回填 vs 不可变触发器：回滚再前滚时旧二进制可能写入待回填 purpose | N2 / N5 迁移演练 |
| LOW | 同 worktree 串行、跨 worktree 最大 2 的 admission limiter 与 queueMs / 首模型消费回执 | N2 / N5 |
| LOW | resume reason code 应为闭集，诊断原文不进 founder 面 | N2 DTO |
| LOW | admission API 的 `env` 参数在 governed flag 后成为死参数 | N2 清理 |
