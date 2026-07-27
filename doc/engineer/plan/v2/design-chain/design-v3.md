# Flywheel v2 设计稿 v3 (2026-07-27)
> 相对 v2:吸收 Codex R2 全部 9 项。核心架构决定:**信箱并入权威库,comm.db 整体退役**——跨库 apply/ack 问题类别性消灭。[R2-n]=修改项标记

## 0. 目标与范围(同 v2;修复:Ship gate 引用改为 §1.5-gates)

## 0.5 消息通道选型 [R2-9 修订规模故事]
决定不变:唯一消息通道=SQLite;**但信箱表住在权威库 flywheel-v2.db 内**(仍是 SQLite,兑现 [A];comm.db 与 JSON 信箱同时退役)。
真实优势表述(修正绝对化):单条 append/update 不再解析并重写整个 JSON 文档;配合有界索引查询、批量 retention 与 checkpoint,成本不随历史行数线性增长。SQLite 是页式存储,UPDATE/DELETE/checkpoint 都写页——不宣称"永不重写/严格 O(1)"。
规模阈值(具体数字,告警线):mailbox 未清理行 >100k;权威库 WAL >64MB;oldest-unconsumed age >30min;消费 lag >500 条。批量删除每 tick ≤5000 行;每日 idle 窗口 `PRAGMA wal_checkpoint(TRUNCATE)`;过载时 admission 拒绝新 notice 类消息入箱(业务类不拒,进 DLQ 告警)。
retention_class 具体值:`notice`(已 applied 后 7 天删)/`business`(applied 后 90 天归档)/`dlq`(30 天,人工清)。未消费超期:**不自动变 obligation**——`notice` 类直接 tombstone;`business` 类进 DLQ 并产生一条 detector proposal(由 kernel 决定是否建 obligation)[R2-HIGH2 修正]。

## 1. 数据层
### 1.0 权威 schema 全量清单 [R2-5]
flywheel-v2.db 共 **14 张表**(不再声称 9):
tasks / task_dependencies / attempts / events / commands / command_dependencies / gates / capabilities / obligations / source_receipts / mailbox / thread_bindings / archive_manifest / meta(含 lead_registry 键空间)。全部入迁移与备份合同。
### 1.1 修订点
- **tasks** 增 `rework_of REFERENCES tasks(id)`(禁自引用触发器)+ `lineage_root_id REFERENCES tasks(id)`(首任务=自身;successor 继承)[R2-6/R1-1]
- **attempts** 增 `terminal_reason CHECK IN ('completed','failed','canceled','superseded')`——desired_state 仍四态,取消/被取代=terminal+reason,状态机无新态、可入库 [R2-6]
- **commands** state 增 `'rejected','canceled'`:kernel 终局裁定(stale/policy_denied/noop→rejected;依赖取消→canceled),由 kernel decision **event**(events 表行)作为其 receipt 驱动——终态驱动源:副作用类=effect receipt/terminal observation;无副作用类=kernel decision event。增列 `result_code TEXT CHECK IN ('stale','policy_denied','noop','retryable_failure','effect_unknown','succeeded')` [R2-6]
- **command_dependencies**`(command_id FK, depends_on_command_id FK, kind CHECK IN ('notify_before'), PK(command_id,depends_on))`——notify-then-do 的机器字段 [R2-7]
- **obligations** 约束修正 [R2-判定R1-3]:root=depth 0(parent NULL);child=depth 1 且 parent 必须 depth 0;触发器校验 `NEW.depth=parent.depth+1` 且继承 parent.root_episode_id;parent.depth=1 → 拒绝。target_task_id FK NOT NULL、parent FK NULL 允许、resolver_capability_id FK NULL 允许;tombstone 触发覆盖 task 终态 **与 attempt generation 终止**。
- **founder page ledger 落点** [R2-判定R1-3]:= `commands(kind='founder_page')`,succeeded(带 effect receipt)即 confirmed sent;ledger 是它的只读视图,不另设表。
- **thread_bindings** [R2-HIGH3]:`(canonical_key=lineage_root_id PK, thread_id UNIQUE, state CHECK IN ('active','archived'))` + partial UNIQUE(每 canonical_key 至多一行 active);**rework successor 经 lineage_root 继承原 thread**;重建=discord-projector 的幂等 command(稳定 effect_key=lineage_root)。
### 1.2 mailbox(住权威库)[R2-1/2]
`mailbox(seq PK, message_uid UNIQUE, source_kind, source_id, payload, payload_digest, to_agent, kind, retention_class, cutover_epoch, state CHECK IN ('pending','claimed','applied','tombstoned','dead'), claim_owner, claim_generation, lease_expires_at, retry_count, created_at, applied_at)`
- UNIQUE(source_kind,source_id) 承接 canonical Discord key(P3 结构性关闭:同一消息一行,payload_digest 冲突即拒)
- **消费权威唯一**:`applied` 状态=对应 source_receipt/event/obligation 已在**同一事务**提交——"Lead 读过"不是消费;lead_cursor 概念废除(被 mailbox 状态替代)[R2-2 消双权威]
- claim=CAS(state pending→claimed, claim_owner=lead_id, claim_generation=lead_generation, lease);旧 generation 的 claim/ack 一律 CAS 失败(旧 Lead 复活无法丢信)[R2-判定R1-7]
- retry:lease 过期回 pending,retry_count+1;≥5 次→dead(DLQ);at-least-once + 幂等 apply(以 message_uid 为 apply 幂等键)
- runner/Lead 侧访问全部经 kernel HTTP API(读 pending/ack),无直连 DB
### 1.3 events 归档协议重写 [R2-4]
冻结 seq 段 → 写唯一 **staging** 文件(路径含 uuid)→ fsync 文件 → 校验 hash/行数 → **原子 rename** 至内容寻址只读终址(`cold/<sha256>.jsonl.zst`)→ fsync 目录 → **单个 DB 事务**:INSERT archive_manifest(UNIQUE(seq_lo,seq_hi),UNIQUE(sha256)) + DELETE 热区行。
启动 reconcile:删除 staging 残留;终址孤儿若 hash 匹配某待归档段→幂等 adopt,否则告警。明确:**跨 DB/文件系统不存在单事务,本协议以"先文件后账"顺序+启动对账保证可恢复**。
### 1.4 执行所有权(同 v2;github/linear projector 同样约束为 dispatcher 管理的单一 claim loop)
### 1.5 gates(同 v1/v2;Ship gate 正式编号 §1.5)

## 2. 引擎
### 2.1-2.3 同 v2(结果分类的持久化=commands.result_code,终态映射见 §1.1)
### 2.4 resume 同 v2
### 2.5 rework saga 补全 [R2-判定R1-1]
- 下游取消=attempts desired→terminal + terminal_reason='superseded'(可入库)
- **外部 effect 处置总表(穷举 command.kind)** [R2-判定R1-1]:
  spawn→terminate 对应进程(补偿)/ terminate→无需 / discord_post→追加更正帖(补偿)/ discord_thread_create→归档(补偿)/ linear_update→重投影(forward-repair)/ github_pr_open→关闭 PR(补偿)/ github_comment→追加更正(补偿)/ github_merge→**不可逆:不入自动 saga,独立高权限 gate** / destructive_delete→同左 / founder_page·notify→无需(信息类)。**未知 kind→fail closed(saga 拒绝启动)**
- successor 继承 thread(§1.1 thread_bindings);rework_of/lineage 约束见 §1.1
### 2.6-2.7 同 v2
### 2.8 Lead 可靠性(同 v2;lead_generation 记 meta;**消费保护改由 mailbox claim CAS 承担**,见 §1.2)
### 2.9 notify-then-do 机器化补全 [R2-7]
- 依赖=command_dependencies 表;kernel 校验:action command 可 claim ⇔ 所有 notify_before 依赖的 command.state='succeeded'
- **豁免 allowlist(穷举,command.kind 级)**:`status_read`,`probe_query`,`mailbox_read`,`events_read`——只读四种;其余一律先知会;Ship/destructive_delete 走各自 gate(非豁免)

## 3. 告警(同 v2;detector proposal→kernel 原子写 obligations;超期 business 消息的 proposal 路径见 §0.5)

## 4. 切换手册增补 [R2-3]
九步不变,新增**消息通道切换步骤**(并入步 2-6):
- 冻结两条旧 producer/consumer(JSON 信箱 + 旧 comm.db);枚举两源未消费消息
- 按 canonical key(source_kind,source_id)对账去重 → 迁移未读入权威库 mailbox(带原 message_uid 与 payload_digest 校验,row count 双向核对)
- 旧 comm.db:WAL-safe backup(online backup API)→ integrity_check → chmod 只读归档;JSON 信箱目录归档
- epoch fence 覆盖 mailbox(cutover_epoch 列);旧 JSON writer/旧 comm.db writer 复活=写只读文件即失败(fail loud)
Go/No-Go 增至九条:原七条 + ⑧两旧消息源冻结且未读已按 canonical key 迁移对账 ⑨旧信箱归档只读、新 mailbox epoch fence 生效。

## 5. 病例回归矩阵(验收补全)[R2-8]
- P10:人为制造 carrier 错位 → rework saga 从命令提交到改道完成 **≤5 分钟**(起点=saga 首事务 commit)
- P12:**bypass inventory 穷举**={notify 豁免 4 种只读 kind;break-glass founder transition(独立凭据);probe unknown→obligation 升级;archive orphan adopt}——每项:所需 capability/TTL/audit + 正反自动化测试(可达+未授权被拒)
- 新增测试 [R2-8]:旧 Lead consume CAS 失败;apply 事务中途崩溃重放(同 message_uid 幂等);retention handoff(notice tombstone/business 进 DLQ+proposal);JSON+comm 双源 cutover 对账;archive 断电(staging 残留/孤儿 adopt)
- 其余同 v2;诚实基线保留
