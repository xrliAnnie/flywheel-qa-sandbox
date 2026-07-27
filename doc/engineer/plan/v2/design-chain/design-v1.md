# Flywheel v2 设计稿 v1 (2026-07-26)
> 输入:Annie 需求书(2026-07-26)/成因报告 12 病例/Codex 独立评审(CHANGES REQUESTED 已吸收)/claude-code 对照
> 状态:待 Codex 循环评审;对齐后交 Annie

## 0. 目标与非目标
**目标**:Annie 的体验契约——Discord 唯一窗口;补偿层退役换 Lead 可靠;notify-then-do(除 Ship+不可逆删除);流程可逆向打回;一次性切换不双轨。
**非目标**:不重写 Runner adapter 的 vendor 交互;不动 Linear/GitHub/Discord 外部集成;不做多机分布式。
**明确假设**:单机 macOS,单用户,进程会猝死(额度墙/503),founder 门是硬需求。

## 1. 数据层(第一章)
### 1.1 权威库:8 个核心概念,每概念单一权威(吸收 Codex 3.1)
新库 `flywheel-v2.db`(单写者=orchestrator kernel,WAL,0600,目录 0700):
1. **tasks** `(id, project_id, external_issue_id, kind, state, state_version, priority, payload JSON, created_at, terminal_at)`
   - state ∈ CHECK('draft','ready','running','blocked','review','done','canceled');terminal 单调;state_version 做 CAS
2. **task_dependencies** `(task_id FK, blocked_by_task_id FK, condition, created_at, PK(task_id,blocked_by))`
   - 真 FK;禁 self-edge;环检测在写事务内
3. **attempts** `(id, task_id FK, generation, vendor, model, worktree_id, host_epoch, desired_state, observed_state, observation_kind, observed_at, transcript_cursor, started_at, terminal_at)`
   - UNIQUE(task_id,generation);partial UNIQUE 保每 task 至多一个 active attempt
   - desired_state(权威):planned/dispatched/started/terminal;observed_state(观测):present/absent/unknown+evidence(吸收 Codex 3.3)
4. **events** `(seq PK, event_uid UNIQUE, task_id, attempt_id, kind, source_kind, source_id, payload, created_at)`
   - append-only;**retention 第一天就设计**:热区 14 天,冷区按月归档到独立文件,索引只建热区(吸收 Codex HIGH-3)
5. **commands** `(id, task_id, attempt_id, generation, kind, payload_digest, state, claim_owner, claim_generation, lease_expires_at, effect_key UNIQUE, created_at, acked_at, result)`
   - transactional outbox:状态变更与 command 同事务;dispatcher 只消费 command(吸收 Codex 3.2)
6. **gates** `(id, task_id, attempt_generation, kind, subject_digest/head_sha, state, opened_at, resolved_at, resolver_capability_id)`
   - P9 语义完整保留:批准绑精确 head;resolution 永不由 transcript 文本推断
7. **capabilities** `(id, token_hash, issuer, audience, action, task_id, attempt_generation, subject_digest, issued_at, expires_at, absolute_deadline_at, consumed_at, revoked_at)`
   - **只存 hash**;明文经进程私有通道一次性交付(修 CRITICAL);founder 凭据独立签发,绝不等于 api token(修 P7)
8. **source_receipts** `(source_kind, source_id, payload_digest, cursor, applied_at, PK(source_kind,source_id))`
   - 外部 observation/投影的幂等与游标
另:`schema_migrations`(独立迁移器,整体事务,任何错误 fail loud——修 HIGH-2)。

### 1.2 comm.db 降级纯信箱
保留 messages/lead_inbox(通知语义,机器 ack),状态类表(sessions/TURN/申报/收据机器)全部退役。runner 读权威状态走**只读 HTTP 视图**(`GET /v2/tasks/:id` 等),终结"抄一份"模式。

### 1.3 投影与 ingress(吸收 Codex 3.8)
Linear/Discord/cmux:**projector** 从 commands claim 写外部并回执;**observer** 把外部变化(founder 消息/GitHub merge/CI)转成带 provenance+幂等键的 observation event 写入 kernel,由 kernel 决定状态转移。外部系统永远不直接写状态表。

## 2. 引擎(第二章)
### 2.1 三层分工(吸收 Codex 3.5,修正"LLM 全权")
- **LLM orchestrator(Lead)**:提议——`proposed_action + rationale + referenced_event_seq + expected_state_version`;解释模糊反馈;设计返工路径。无直接 SQL 写权。
- **决定性内核(kernel,~几百行)**:authenticate → CAS → 校验 7 不变量 → append event+command → commit。**必须拒绝**:stale generation/终态 task 的 command/幂等键冲突/依赖未满足/capability 不匹配/worktree 写者冲突/ship gate 未满足。
- **dispatcher**:claim command → 执行外部副作用(spawn/Discord/GitHub) → 写 observation/receipt。
产品红线 3 条(单 worktree 单写者/批准绑 head/CI 红不 ship)+ 内核 7 机械不变量(one active attempt/terminal 单调/command 幂等/generation fence/依赖引用完整/capability 单次+绝对过期/append-only 审计)。

### 2.2 派发协议(修 P2,吸收 Codex 3.2)
同一事务写 attempt+generation+launch command → dispatcher 领取 → 稳定 execution id 幂等 spawn → 提交 started/failed observation。两个崩溃窗口:commit后spawn前=command 可重放;spawn后ack前=generation-bound process marker 判 adopt-or-terminate,绝不盲目重 spawn。**登记失败=派发失败(fail loud),但不假装能把 spawn 塞进 SQL 事务。**

### 2.3 探针(吸收 Codex 3.3)
desired vs observed 分离;枚举成功+同 host_epoch+明确 absent 才判 dead;枚举失败=unknown 但**有界升级**(N 次 unknown → 建 obligation 交人裁决,绝不无限 hold;计数落库不落内存——修 MEDIUM)。

### 2.4 resume 协议(吸收 Codex 3.4)
app transcript(按 seq)为权威;activation=generation-bound command;runner 先 ack 再执行;vendor handle 可恢复则 resume,否则从 transcript checkpoint 重建新 thread;副作用先写 intent 后写 receipt;恢复先 reconcile effect。wake/park/TURN/pane-typing 全家族退役。
已知工程缺口(实施单里补):Claude TmuxAdapter 现未接 --resume;codex turnless thread 无 rollout→重建路径。

### 2.5 逆向打回(Annie 需求 3)
打回=kernel 事务:目标节点新 attempt(generation+1)+ 失效下游 attempts + revert command(旧代码 revert 由 Lead 判断,默认丢弃)。结构上就是加行,不存在"卡住不能回滚"。

### 2.6 旁路分级(吸收 Codex 3.6)
可旁路(带 reason/actor/TTL/audit):提醒/超时建议/路由策略。不可直接旁路:3 红线+capability/generation。安全类 break-glass=独立更强凭据的显式 transition,不是隐藏 flag。**设计评审验收题保留:每个机制答"它错了 Lead 怎么绕"。**

### 2.7 凭据生命周期(吸收 Codex 3.7,修 P6)
工作票据可自动续(条件:attempt active+identity 匹配+task 未 cancel+gate scope 未变+不超首发冻结的 absolute deadline);founder/merge 凭据绝不心跳续,绑 exact head,单次。TTL 集中配置,禁散落魔法数。

## 3. 告警(第三章,吸收 Codex 3.9)
- delivery receipt(机器 ack)与 human obligation(需 Lead/founder 决策)彻底分离,后者独立表/gate
- alert 带 root_episode_id/parent/depth,CHECK depth IN (0,1);parent 是 alert 时禁止再造 alert(结构性禁自繁殖——修 P5)
- 目标 task/attempt 终态→原子 tombstone 关联 obligation(修终态短路缺失)
- founder page ledger 只记 confirmed sent;失败尝试进 delivery outbox(修 9053 vs 3683 之乱)
- 告警器只读权威库,永不写回被监管管道
- 只报三类事:founder 决定在等/执行体死了没人管/权威账与现实矛盾

## 4. 切换手册(9 步 stop-the-world,吸收 Codex §4)
预演(隔离路径 standalone migrator 反复跑+抽样重放)→冻结(关 admission,枚举全部在途)→停全部旧写者(Bridge+Lead+runner CLI+巡逻,记 host epoch)→一致快照(SQLite online backup API,**必须含 WAL**)→迁移到新文件(FK/CHECK/UNIQUE+integrity_check)→安全重置(撤旧明文凭据,重签;目录 0700 库 0600)→epoch fence(v2 拒绝旧 epoch)→顺序启动(kernel→projector/observer→runner supervisor)→回滚点(首个 v2 外部副作用前可原子回切;之后 forward-repair)。附 go/no-go 清单 7 条(照 Codex 原文)。

## 5. 病例回归矩阵
P1/P3/P4/P11→单写者+投影只读+observation ingress;P2→outbox 派发协议;P5/P8→告警三章;P6→凭据生命周期;P7→真凭据分级;P10/P12→旁路分级+kernel 拒绝而非业务门卫;P9→gates 表原语义保留。
