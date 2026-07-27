# Flywheel v2 设计稿 v5 (2026-07-27)
> 相对 v4:吸收 Codex R4 最小修改集 3 项([R4-n])。

## 0. 目标与范围(同 v2;修复:Ship gate 引用改为 §1.5-gates)

## 0.5 消息通道选型 [R2-9 修订规模故事]
决定不变:唯一消息通道=SQLite;**但信箱表住在权威库 flywheel-v2.db 内**(仍是 SQLite,兑现 [A];comm.db 与 JSON 信箱同时退役)。
真实优势表述(修正绝对化):单条 append/update 不再解析并重写整个 JSON 文档;配合有界索引查询、批量 retention 与 checkpoint,成本不随历史行数线性增长。SQLite 是页式存储,UPDATE/DELETE/checkpoint 都写页——不宣称"永不重写/严格 O(1)"。
规模阈值(具体数字,告警线):mailbox 未清理行 >100k;**权威库文件 >2GB** [R3-5];权威库 WAL >64MB;oldest-unconsumed age >30min;消费 lag >500 条。
retention 调度 [R3-5]:唯一调度者=kernel 的 retention tick(每 10 分钟一次,单实例,tick 间互斥锁);批量删除每 tick ≤5000 行。
VACUUM 策略 [R3-5]:不做在线 VACUUM(全库重写会长时间锁库);常态只做每日 idle 窗口 `PRAGMA wal_checkpoint(TRUNCATE)`;当 freelist 占比 >30% 时,由人工在维护窗口执行离线 VACUUM(停 kernel→backup→VACUUM→verify→起)。
过载:admission 拒绝新 notice 类消息入箱(业务类不拒,进 DLQ 告警)。
retention_class 具体值:`notice`(已 applied 后 7 天删)/`business`(applied 后 90 天归档)/`dlq`(30 天,人工清)。未消费超期:**不自动变 obligation**——`notice` 类直接 tombstone;`business` 类超期处置=**单个 kernel 事务** [R3-1]:retention detector 只提交带 `message_uid` 的 proposal;kernel 在一个 flywheel-v2.db 事务内完成 (a) mailbox CAS claimed/pending→dead (b) 写唯一 decision receipt/event(UNIQUE(message_uid)) (c) 按裁决创建至多一个 obligation——**裁决为"不建"时同样落 decision event 作幂等终局证据**;proposal 重放以该 UNIQUE 拒绝,不双建不漏建。

## 1. 数据层
### 1.0 权威 schema 全量清单 [R2-5]
flywheel-v2.db 共 **15 张表** [R3-5]:
tasks / task_dependencies / attempts / events / commands / command_dependencies / gates / capabilities / obligations / source_receipts / mailbox / thread_bindings / archive_manifest / meta(含 lead_registry 键空间) / **schema_migrations**。全部入迁移与备份合同。
DDL 命名统一 [R3-5]:command_dependencies 为 `(command_id REFERENCES commands(id), depends_on_command_id REFERENCES commands(id), kind, PK(command_id, depends_on_command_id))`;thread_bindings.canonical_key = `lineage_root_id REFERENCES tasks(id)`(显式 FK)。
### 1.1 修订点
- **tasks** 增 `rework_of REFERENCES tasks(id)`(禁自引用触发器)+ `lineage_root_id REFERENCES tasks(id)`(首任务=自身;successor 继承)[R2-6/R1-1]
- **attempts** 增 `terminal_reason CHECK IN ('completed','failed','canceled','superseded')`——desired_state 仍四态,取消/被取代=terminal+reason,状态机无新态、可入库 [R2-6]
- **commands** state 增 `'rejected','canceled'`:kernel 终局裁定(stale/policy_denied/noop→rejected;依赖取消→canceled),由 kernel decision **event**(events 表行)作为其 receipt 驱动——终态驱动源:副作用类=effect receipt/terminal observation;无副作用类=kernel decision event。增列 `result_code TEXT CHECK IN ('stale','policy_denied','noop','retryable_failure','effect_unknown','succeeded')` [R2-6]
- **command_dependencies**`(command_id FK, depends_on_command_id FK, kind CHECK IN ('notify_before'), PK(command_id, depends_on_command_id))`——notify-then-do 的机器字段 [R2-7]
- **obligations** 约束修正 [R2-判定R1-3]:root=depth 0(parent NULL);child=depth 1 且 parent 必须 depth 0;触发器校验 `NEW.depth=parent.depth+1` 且继承 parent.root_episode_id;parent.depth=1 → 拒绝。target_task_id FK NOT NULL、parent FK NULL 允许、resolver_capability_id FK NULL 允许;tombstone 触发覆盖 task 终态 **与 attempt generation 终止**。
- **founder page ledger 落点** [R2-判定R1-3]:= `commands(kind='founder_page')`,succeeded(带 effect receipt)即 confirmed sent;ledger 是它的只读视图,不另设表。
- **thread_bindings** [R2-HIGH3]:`(canonical_key=lineage_root_id PK, thread_id UNIQUE, state CHECK IN ('active','archived'))` + partial UNIQUE(每 canonical_key 至多一行 active);**rework successor 经 lineage_root 继承原 thread**;重建=discord-projector 的幂等 command(稳定 effect_key=lineage_root)。
### 1.2 mailbox(住权威库)[R2-1/2]
`mailbox(seq PK, message_uid TEXT NOT NULL UNIQUE, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, payload NOT NULL, payload_digest TEXT NOT NULL, to_agent TEXT NOT NULL, kind TEXT NOT NULL, retention_class TEXT NOT NULL CHECK IN ('notice','business','dlq'), cutover_epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK IN ('pending','claimed','applied','tombstoned','dead'), claim_owner, claim_generation, lease_expires_at, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at, created_at NOT NULL, applied_at)` [R3-3]
索引 [R4-1](可执行 DDL,动态时间只作查询绑定参数,不进 predicate):
```sql
CREATE INDEX mailbox_pending_immediate ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL;
CREATE INDEX mailbox_pending_scheduled ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL;
```
claim 查询两分支合并候选:immediate 分支直取;scheduled 分支过滤 `next_retry_at <= :now`(绑定参数)。验收:真实迁移建索引成功 + `EXPLAIN QUERY PLAN` 证明两分支均命中对应索引。
退避 [R3-3]:失败回 pending 时 `next_retry_at = now + min(30s * 2^retry_count, 15min)`(base=30s,cap=15min);claim 查询必须尊重 next_retry_at。
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
- 依赖=command_dependencies 表;kernel 双重校验 [R3-4]:
  (a) **admission 时**:非豁免 action kind 的 command 必须携带 ≥1 条 notify_before 依赖,否则拒绝建立(空集不为真);
  (b) **claim 时**:所有 notify_before 依赖 state='succeeded';任一依赖 effect_unknown → action 不可 claim(先 reconcile)。
- command.kind 机器分类 [R3-4]:`prerequisite_notification` 类={`notify`,`founder_page`}——本身无需 notify_before 即可领取(基例,消除无限前置链);`readonly` 类={`status_read`,`probe_query`,`mailbox_read`,`events_read`}——豁免;其余=`action` 类,必须走 (a)(b)。
- command_dependencies 禁 self-edge 与环(触发器)[R3-4]。

## 3. 告警(同 v2;detector proposal→kernel 原子写 obligations;超期 business 消息的 proposal 路径见 §0.5)

## 4. 切换手册增补 [R2-3]
九步不变,新增**消息通道切换步骤**(并入步 2-6):
- 冻结两条旧 producer/consumer(JSON 信箱 + 旧 comm.db);枚举两源未消费消息
- 按 canonical key(source_kind,source_id)对账去重 → 迁移未读入权威库 mailbox(带原 message_uid 与 payload_digest 校验,row count 双向核对)
- 旧 comm.db:WAL-safe backup(online backup API)→ integrity_check → chmod 只读归档;JSON 信箱目录归档
- **旧 writer 复活三重围栏** [R3-2](旧 JSON writer 会 ensureFileExists 递归重建目录,仅移走目录挡不住):
  (a) 启动入口撤销:旧 supervisor/launchd 项删除、旧 token/capability 列入拒绝清单;
  (b) **原路径 fence**:旧 JSON 信箱与旧 comm.db 的原路径放置不可写 tombstone(父目录 chmod 500 + 同名只读占位文件),重建尝试即 EACCES fail loud;
  (c) epoch fence 覆盖新 mailbox(cutover_epoch 列)。
Go/No-Go 增至十条:原七条 + ⑧两旧消息源冻结且未读已按 canonical key 迁移对账 ⑨旧信箱归档只读+原路径 fence 就位 ⑩**实弹测试**:真启动一次旧 JSON writer 与旧 comm.db writer,断言进程 fail loud、原路径无新文件/-wal/-shm、新 mailbox 无旧 epoch 行 [R3-2]。

## 5. 病例回归矩阵(验收补全)[R2-8]
- P10:人为制造 carrier 错位 → rework saga 从命令提交到改道完成 **≤5 分钟**(起点=saga 首事务 commit)
- P12:**bypass 封闭矩阵** [R3-5](escape/recovery transition 另列不混):
  | bypass | command.kind | actor | capability | TTL | audit |
  |---|---|---|---|---|---|
  | notify 豁免 | readonly 类 4 kind | any | 无需 | — | events 常规行 |
  | 提醒静默 | `mute_reminder` | Lead | lead 凭据 | ≤72h | 见下审计合同 |
  | 超时宽限 | `extend_timeout` | Lead | lead 凭据 | ≤24h | 同 |
  | 路由改道 | `route_override` | Lead | lead 凭据 | 单次 | 同 |
  | break-glass | `emergency_transition` | founder | **独立 founder 凭据** | 单次 | 同+另建 obligation 记录 |
  **审计合同(唯一实现)** [R4-3]:审计结果由 **commands.result_code 承载**(成功=`succeeded`,拒绝=`policy_denied`;events 表不增列);每次 bypass 尝试(无论成败)同事务追加一条 `events.kind='bypass_used'`,payload 必含 `{command_id, bypass_kind, actor, reason, capability_id, expires_at, outcome:'granted'|'denied'}`——未授权尝试业务上零副作用,但审计行必写(拒绝不静默)。
  每行两条自动化测试:正向可达(授权 actor 执行成功,断言 result_code='succeeded'+bypass_used 行 outcome=granted)+反向拒绝(未授权得 403,断言 result_code='policy_denied'+bypass_used 行 outcome=denied+零业务副作用)。
  (probe unknown→obligation、archive orphan adopt 归类为 recovery transition,验收在各自章节,不占 bypass 矩阵)
- 新增测试 [R2-8]:旧 Lead consume CAS 失败;apply 事务中途崩溃重放(同 message_uid 幂等);retention handoff(notice tombstone/business 进 DLQ+proposal);JSON+comm 双源 cutover 对账;archive 断电(staging 残留/孤儿 adopt)
- 其余同 v2;诚实基线保留
