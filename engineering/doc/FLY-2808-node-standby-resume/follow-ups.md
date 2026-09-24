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

## 1.2 沙箱设计评审 R2（CHANGES REQUESTED → 全部采纳，已回写 plan）

| 严重度 | 问题 | disposition |
|---|---|---|
| HIGH | writer 需求创建时无法冻结尚未产生的 activation/TURN epoch（生产 rework 先持久化请求，holder 激活 → admission → grantTurn 后才有 epoch） | 采纳。§2.1 需求 episode 只冻结不可变的 provenance / 目标 / 旧状态 fence；新增 set-once grant receipt 子记录，§5.3 第 3 步真实 grant 后封存，第 4 步投递精确匹配 receipt + carrier generation；矩阵 P 加「创建后 TURN 变化再恢复，旧 demand/旧 receipt 不投递」 |
| HIGH | conversation_only 坏 handle 只 hold 没有兜底，违背 PRD §4.4 与成功标准 5 | 采纳。§6 新增 conversation-only fresh fallback：可新建无写权限的会话/载体（无 activation/TURN/credential，写工具与 complete 路由服务端拒绝），原消息按独立 fallback 预算投递，`contextLoss=true`；矩阵 I 分 writer / conversation_only 两路验收 |
| HIGH | 「被后继提交修改」与「dirty 先丢失、同路径后被替换」在当前 HEAD 上同构，仅凭基线 digest 无法区分 | 采纳。§5.2 自动通过收窄为：工作树/index 仍有同 digest，或基线精确 blob+mode 先进入谱系（`git log --find-object`）后再被改；A→删除→B 同路径提交必须 hold；mutation receipt 明确不在本设计；矩阵 E 加该反例 |
| HIGH | 基线 `workflow_engine_park_outbox.event` 有 CHECK，SQLite 无法用 ADD COLUMN 扩宽，v2 event 插入即失败；而 §9 又禁止此迁移 | 采纳。§9 新增第二个迁移例外：outbox 事务性表重建（保留 row_id/event_id/generation，旧行 schema_version=1，新 CHECK 按版本约束 v1/v2，旧 writer 仍可写 v1）；回滚不回退表结构；矩阵 Q 改为从 abce27a27 真实建表 SQL 起跑迁移 |

## 1.3 沙箱设计评审 R3（CHANGES REQUESTED → 全部采纳，已回写 plan）

| 严重度 | 问题 | disposition |
|---|---|---|
| HIGH | 单张 set-once grant receipt 绑定 carrier generation，grant 后、首条输入消费前换代重试会永久锁死同一 demand；receipt 也不能证明投递瞬间仍持 TURN | 采纳。§2.1 receipt 改为按 (demand_id, carrier_generation) 追加的不可变记录，旧记录保留、当前代数的为投递候选；§5.3 第 4 步入队事务重核 activation / TURN holder+epoch / demand 有效性 / generation；矩阵 F 加「grant 后载体丢失→新代重试可继续、预算不重置」，P 加「receipt 后 TURN 转授→不投递」 |
| HIGH | conversation-only 的「写工具被服务端拒绝」只落在 Claude hook seam 与 complete 路由，基线 CodexTmuxAdapter 固定 workspace-write，Codex 兜底仍能改工作目录 | 采纳。§2.1 新增 execution profile 绑定行：Codex conversation_only 必须 read-only sandbox / 无 writable roots / 无外部 mutation credential / 网络写关闭，Claude 用 generation+nonce hooks 拒 mutating tool；首条 prompt 前核验 observed profile；conversation_only → writer 不原地扩权、必须重建新代载体；矩阵 I 改为两 vendor 真载体实际尝试写文件 / git / 外部 mutation / complete 全部被拒 |

## 1.4 沙箱设计评审 R4（CHANGES REQUESTED → 采纳，已回写 plan）

| 严重度 | 问题 | disposition |
|---|---|---|
| HIGH | §5.3 第 4 步「入队事务同时重核 activation/TURN/demand/generation」跨 StateStore 与 CommDB 两库，与 §2.2 无跨库事务矛盾；预留后转授、入队后取消/终态/换代的陈旧首条输入竞态未闭合 | 采纳。§5.3 第 4 步改为四阶段双库线性化协议：a) StateStore CAS 预留 delivery authorization（唯一 delivery_id，与 cancel/终态/换代共用同一 CAS 行）并写 durable outbox；b) CommDB IMMEDIATE 事务核 exact turn 元组并幂等入队同一 delivery_id，`grantTurn` 转授在同库事务取消旧 epoch 未消费项；c) transport claim / 首次模型消费前回核 StateStore 投影，未知或落后 fail closed；d) 按 delivery_id 幂等 ACK/取消与崩溃重放。§2.1 新增 delivery authorization 行；矩阵 P 加两库各缝隙的 TURN transfer / cancel / terminal / generation change / crash 断言 |

## 1.5 沙箱设计评审 R5（CHANGES REQUESTED → 全部采纳，已回写 plan）

| 严重度 | 问题 | disposition |
|---|---|---|
| HIGH | `turn_stale` 回到第 3 步无法在同 demand/generation 上取得新 epoch：receipt 主键固定、基线 `grantTurn` 对同一 source event 回放冻结旧 epoch、`workflow_activation_turn` 以 activation_id 为主键 no-update | 采纳。引入追加式 grant episode：receipt 主键改 (demand_id, carrier_generation, grant_id)，demand 行 `current_grant_id` CAS 推进；每个 grant episode = 新 activation（`activation:${requestId}:g${grant_id}` + 含 grant_id 的 TURN source event），activation_turn 追加新行、execution binding 不变、凭证按 §5.4 刷新；delivery authorization 引用 grant_id；「转授即永久取代」作为未采用的替代方案注明 |
| HIGH | reserve 与 cancel/终态/换代「先提交者赢」会让失效被已 reserve 的投递吞掉，且与 stage c/d 矛盾；cancel 在 delivery 行不存在时无法与 insert 同行 | 采纳。§5.3 新增 delivery authorization 闭集转换表：reserve 由 source facts（demand/run/carrier 行）守门，失效操作在各自事务里把活动 delivery CAS→cancelled 且永不被 reserve 阻止；consume 只从 enqueued 且同事务重核 source facts；turn_stale 是该 delivery 终态；迟到 projector/ACK 一律 no-op；明确 cancel-vs-consume 提交顺序与被撤销凭证 fenced 的一轮残余；矩阵 P 分「cancel 先于 reserve」「reserve 后失效」「转授后新 grant episode 恰好消费一次」验收 |

## 1.6 沙箱设计评审 R6（CHANGES REQUESTED → 全部采纳，已回写 plan）

| 严重度 | 问题 | disposition |
|---|---|---|
| HIGH | 「每个 grant episode 新建 activation、binding 不变」在基线 schema 上不可表示：`workflow_execution_binding` 以 activation_id 为主键、tuple 唯一、no-update，admission 对同 tuple 不同 activation 返回 activation_conflict | 采纳。既有 activation/binding 完全不动；新增独立追加式 `workflow_turn_grant_episode`（(demand_id, grant_id) 主键，引用既有 activation_id、含 grant_id 的 source_event_id、epoch、generation、credential_nonce），`grantTurn` 用新 source event 拿新 epoch；凭证按 episode nonce 轮换；矩阵 P 从真实 schema 建库验同 tuple 连续两个 episode |
| HIGH | 「push 后失效允许跑完一轮、只撤销提交凭证」不是 writer fence：workspace-write+network 的旧 turn 可与新 holder 并发写，且与 §5.3/矩阵 P「陈旧输入不进模型」矛盾 | 采纳。delivery 新增 in_flight / fencing / aborted 状态与 §5.3 e 两阶段 fence：失效触发先 CAS in_flight→fencing 并关 intake，CommDB 转授只落 `transfer_pending`；等旧 turn drain 或精确同代 stop 确认（§3 机制）后才提交转授 / close carrier / 启用新 writer；Claude hook 逐工具回核为纵深、Codex 无逐工具闸靠 stop；§4 第 3 行、§2.1 delivery 行、矩阵 P（push 后首个工具前 / mid-turn）同步；旧「接受一轮残余」表述删除 |

## 1.7 沙箱设计评审 R7（CHANGES REQUESTED → 全部采纳，已回写 plan）

| 严重度 | 问题 | disposition |
|---|---|---|
| HIGH | grant episode 无可重放的 pre-grant intent；凭证轮换写在 `grantTurn` 之后，与基线（先轮换、明文 token 作 grant 参数、CommDB 同事务写入该 epoch 的 `runner_workflow_activation`）相反；崩溃恢复会再 +1 分配新 grant_id | 采纳。§2.1 新增可变 `workflow_turn_grant_operation`（allocated → credential_rotated → granted → finalized / failed，记 credential_attempt 与凭证行 id/digest），不可变 episode 行只在 finalized 写；§5.3 第 3 步按生产顺序拆阶段，恢复只续接当前未 finalized 的 grant_id：source event 不存在→以新 credential_attempt 再轮换并撤销未投递 token 后 grant，已存在→读冻结 epoch 与 CommDB 投影补写 finalized，不再轮换/grant；矩阵 F 加三处崩溃点断言 |
| HIGH | `transfer_pending` 只有状态名，没有 CommDB 持久身份/payload/prepare-commit 协议；基线 `grantTurn` 单事务立即改 holder/epoch 并写不可变 source event，提前调=过早转授，提前占 source event=frozen replay | 采纳。§2.1 新增 CommDB `turn_transfer_intent`（intent_id = 将来的 source_event_id，expected/target 元组、fencing delivery_id、pending/committed/cancelled/superseded，同 worktree 唯一 pending）与 StateStore `workflow_invalidation_operation`（cancel/终态/换代的 durable 身份）；§5.3 e 写明 prepare（核 expected、置 admission_closed、不改 holder/epoch、不写 source event）与 commit（终态投影到达且 expected 仍匹配时原子 epoch+1 + 全部写入，重复 commit 幂等）及并发 transfer / 终态 supersede / 迟到投影闭集；矩阵 P 加 prepare 前后、投影前后、commit 中途重启与并发 transfer |

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
