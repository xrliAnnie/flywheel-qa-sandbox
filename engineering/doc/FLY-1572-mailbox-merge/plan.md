# FLY-1572 合表 + 迁移:两张信箱表并成一张 mailbox — 实施计划

Issue: FLY-1572 (https://linear.app/geoforge3d/issue/FLY-1572/消息层重构-c-批次1-合表-迁移两张信箱表并成一张-mailbox)
日期: 2026-08-04
基于: research.md(Codex design review R1 反馈已折入)

> 上游权威 = `doc/messaging-rework/design.md`(FLY-1569)。本计划把 issue 的 scope 落到可实施粒度。
> **与 issue/总纲原文的偏离全部集中在 §2(带证据)** —— 其中 P9 需要按 README 规矩改 design.md 并同步 FLY-1569。

## 0. 一句话

`lead_inbox`(37 列)+ `messages`(实测 28 列)→ 一张 `mailbox`(v1 comm.db)+ 一张 append-only `mailbox_log` + 保留 `receipt_root_lineage`;投递循环扩到所有收件人(Lead + Runner + bridge);Lead 适配器一行不改;迁移 = 单事务硬 cutover + 毒药墓碑 + 自研在线备份 + 实测回滚。

## 1. 设计总图

```mermaid
graph TD
    subgraph 写入方
      A1[founder chat<br/>chat-receipt CLI] -->|carrier=external| MB
      A2[founder thread 回复<br/>founder-reply-deliverer] --> MB
      A3[Lead↔Lead xdept saga] -->|carrier=external| MB
      A4[Runner ask/gate<br/>insertQuestion] --> MB
      A5[Lead send/respond CLI] --> MB
      A6[Bridge lead_events<br/>enqueueLeadEvent] --> MB
      A7[Lead ack_receipt<br/>inbox-mcp] -->|to_agent=bridge| MB
    end
    MB[(mailbox<br/>QUEUED→LEASED→ACKED/DEAD)]
    MB --> LOOPS
    subgraph LOOPS[投递循环 1s/30s + nudge,零新增定时器]
      L1[per-Lead loop ×N<br/>只认自己 lead 的行]
      L2[per-project RunnerLane ×1<br/>只认 recipient_kind=runner]
      L3[protocol lane<br/>to_agent=bridge]
    end
    L1 -->|claim 时 fail-closed 准入+渲染| AD1[ClaudeLeadDeliveryAdapter<br/>一行不改]
    L1 --> AD2[CodexLeadDeliveryAdapter<br/>一行不改]
    L2 --> AD3[RunnerMailboxDeliveryAdapter<br/>新,自有 envelope,包住 wakeRunnerMailbox]
    MB -->|RPC family 整体终态+过保留期| LOG[(mailbox_log<br/>append-only,settlement CAS)]
    MB -.血缘触发器移植.-> RRL[(receipt_root_lineage<br/>保留,1153 行)]
```

## 2. 与 issue/总纲原文的偏离清单(全部有证据,见 research.md + 生产只读盘点)

| # | 原文 | 实况 | 处理 |
| -- | -- | -- | -- |
| P1 | `messages` 22 列 | 实测 28 列(+checkpoint/content_ref/content_type/resolved_at/delivered_at/attachments/kind) | 7 列全进拆分对照(§4) |
| P2 | 删 17 列含 consumed_at/delivered_at/carrier/next_retry_at/batch_id | 5 列活承重 | 语义由状态机接管或保留列(§3/§4) |
| P3 | DDL 草图无 msg_class/last_error,「留 14」清单里有 | issue 自身不一致 | DDL 补上 |
| P4 | DDL 无 carrier | E 单前 external 影子行记账是活的且须对循环不可见 | 保留 carrier,E 单删 |
| P5 | 未提 gate/RPC 列 | messages 是 approve_to_ship 底座 | RPC 列随行进 mailbox;verify-approval 链字节不变 |
| P6 | 「176 活行」 | 08-04 实测未消费 9 行 | 验收 5 以迁移时刻实测为准 |
| P7 | founder→Lead 一条路径 | 实际两条(chat external + thread hub root inbox) | 分别接线(§5.1/§5.2) |
| P8 | sender 6 列「不属于投递语义」压一列 | lease_key+generation 是活授权数据(fence);writer_pid 是降级梯第二级 | 压一列但结构化+版本化,malformed fail-closed(§6) |
| P9 | 总纲 §3「ACKED 由 agent 改」 | 批次 C 无租约重投,Lead 的 agent-ack 闭环(ack_receipt↔原批关联)属 D 单能力 | **批次 C 内 Lead 行 ACK = 适配器 durable-accept;Runner 行 ACK = 拉取(真 agent 动作)。此为对 design.md 的显式修订:合并前在 design.md §3 加批次口径注记并同步 FLY-1569**,不做私下偏离 |
| P10 | —(research 遗留悬案) | 生产盘点:`candidates_json` **有史以来 0 行**、live family_root_id 0 行 | routeFounderReply 的 legacy promoted-family 读取分支直接删除(证据在案);迁移脚本再断言一次 0 行,非 0 即 abort |

## 3. 新 schema 定稿(建在 v1 `~/.flywheel/comm/<project>/comm.db`)

> ⚠️ 命名冲突声明:v2-kernel(flywheel-v2.db)另有一张 `mailbox`(不同库不同包);`bridge/mailbox-lead-runtime.ts` 的 "mailbox" 指 inbox JSON 文件传输。**本表建在 v1 comm.db,与两者无关**,代码注释与文档写明。

### 3.1 mailbox

```sql
CREATE TABLE mailbox (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,   -- 逻辑消息身份(question/response 的 RPC 引用键)
  delivery_id  TEXT NOT NULL UNIQUE,   -- ★ 适配器/receipt 身份。生产 294 组 question/mirror 配对两 id 全不同,
                                       -- 必须双列:question 行保留 'question:<lead>:<qid>' 格式(在途 receipt 不断链、
                                       -- [receipt:<delivery_id>] 字节不变);ack_receipt 行同理 'ack:<lead>:<receipt>';
                                       -- 其余行 delivery_id = id。逐 type 生成/迁移规则见 §8.2
  from_agent   TEXT NOT NULL,          -- 发送者身份(纯身份,不再兼职审计血缘)
  to_agent     TEXT NOT NULL,          -- ★ 收件人:lead id / 完整 execution id / 'bridge'
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('lead','runner','bridge')),
  source_kind  TEXT,                   -- 审计血缘(原 lead_inbox.source 的职责拆出)
  source_ref   TEXT,                   -- 如 lead_event seq —— markLeadEventDelivered 依赖
  type         TEXT NOT NULL,          -- RPC/message 类型;折叠 question 时以 messages.type='question' 为权威。
                                       -- 旧镜像 gate_question/runner_question 不占此列,按 checkpoint 派生(§5.3)
  msg_class    TEXT NOT NULL DEFAULT 'model' CHECK(msg_class IN ('protocol','model')),
  content      TEXT NOT NULL,          -- 发送方原始内容(不可变)
  delivery_content TEXT,               -- claim 时物化的渲染投递内容(CAS 一次性写入后不可变;§5.3)
  content_ref  TEXT,
  content_type TEXT,
  ref_id       TEXT,                   -- 回复哪一封(旧 parent_id)。无自引用 FK:xdept 行的 ref 是 Discord msg id;
                                       -- 问→答 family 不变量由归档逻辑+断言测试维护(§7)
  kind         TEXT,
  checkpoint   TEXT,
  deadline_at  TEXT,
  expires_at   TEXT,
  relay_state  TEXT NOT NULL DEFAULT 'open'
               CHECK(relay_state IN ('open','protected','terminal_disposed')),
  resolved_at  TEXT,
  resolved_via TEXT,
  superseded_at TEXT,
  superseded_by TEXT,
  created_at   TEXT NOT NULL,

  state        TEXT NOT NULL DEFAULT 'QUEUED'
               CHECK(state IN ('QUEUED','LEASED','ACKED','DEAD')),
  claimed_by       TEXT,
  claim_expires_at TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error   TEXT,
  acked_at     TEXT,
  dead_at      TEXT,
  dead_reason  TEXT,

  carrier      TEXT NOT NULL DEFAULT 'inbox' CHECK(carrier IN ('inbox','external')),  -- E 单删
  sender_ref   TEXT,                   -- §6:versioned canonical JSON。NULL 仅限迁移史料,**新写禁止 NULL**:
                                       -- 未保护写必须落显式 {"v":1,"authority":"unprotected",...};唯一写入口校验+负向测试

  priority     INTEGER NOT NULL DEFAULT 1 CHECK(priority BETWEEN 0 AND 3),
                                       -- 保持现版有序批合同;claim 只用 ORDER BY priority, seq
  batch_id     TEXT,
  collapse_key TEXT
);
CREATE INDEX mailbox_live  ON mailbox(to_agent, seq) WHERE state IN ('QUEUED','LEASED');
CREATE INDEX mailbox_claim ON mailbox(to_agent, msg_class, priority, seq)
  WHERE carrier = 'inbox' AND state = 'QUEUED' AND recipient_kind = 'lead';      -- per-Lead 新批
CREATE INDEX mailbox_lead_reclaim ON mailbox(to_agent, msg_class, priority, seq)
  WHERE carrier = 'inbox' AND state = 'LEASED' AND recipient_kind = 'lead'
    AND batch_id IS NOT NULL;                    -- 兼容旧 Lead batch TTL 重领(§5.3a):等值前缀+排序键与
                                                 -- mailbox_claim 同构;batch 由最早行派生,claim/TTL 判定
                                                 -- 在 CAS 步做,不进索引键(R13 reclaim-index-column-order)
CREATE INDEX mailbox_claim_runner ON mailbox(priority, seq)
  WHERE carrier = 'inbox' AND state = 'QUEUED' AND recipient_kind = 'runner';    -- RunnerLane 跨 exec 谓词(R3 M5)
CREATE INDEX mailbox_claim_bridge ON mailbox(from_agent, priority, seq)
  WHERE carrier = 'inbox' AND state = 'QUEUED' AND recipient_kind = 'bridge';    -- protocol lane
CREATE INDEX mailbox_bridge_reclaim ON mailbox(from_agent, priority, seq)
  WHERE carrier = 'inbox' AND state = 'LEASED' AND recipient_kind = 'bridge';    -- 兼容旧 protocol claim TTL(TTL 判定在 CAS 步,同上)
CREATE UNIQUE INDEX mailbox_unique_response ON mailbox(ref_id) WHERE type = 'response';
CREATE INDEX mailbox_archive_acked ON mailbox(acked_at) WHERE state = 'ACKED';
CREATE INDEX mailbox_archive_dead  ON mailbox(dead_at)  WHERE state = 'DEAD';
```

三条 lane、Lead frozen-batch 重领与归档/GC 候选查询用 `EXPLAIN QUERY PLAN` 测试钉死不做全表扫描或 TEMP B-TREE 排序(R3 MEDIUM 5/R12 `priority-nullable-and-order-by`/R13 `reclaim-index-column-order`)。两个 reclaim 索引因此**不含 batch_id/claim_expires_at 键列**:排序键前不放非等值列,`ORDER BY priority, seq LIMIT 1` 直接吃索引序;§5.3a 的重领查询形状固定为「partial index 选最早行 → 派生 batch → CAS 步做三路 claim/TTL 判定」,与现版 `claimModelBatch` 选取无 claim 谓词的形状一致。

### 3.1b 身份永久占用(R3 blocker 1:归档不得释放幂等身份)

```sql
CREATE TABLE mailbox_identity (          -- registry:id/delivery_id 跨归档永久占用
  id          TEXT NOT NULL UNIQUE,
  delivery_id TEXT NOT NULL UNIQUE,
  insert_projection_hash TEXT NOT NULL,  -- versioned canonical 初始投影 hash(archived replay 的比较材料)
  archived_at TEXT,                      -- NULL = 活表在住;归档时一次性盖章
  UNIQUE (id, delivery_id)
);
-- 写协议 = registry 先行(R4 blocker 1):事务内先 reserve-or-resolve registry,后 INSERT mailbox。
-- mailbox BEFORE INSERT 只放行「存在精确同 pair 且 archived_at IS NULL」的 registry 行:
CREATE TRIGGER mailbox_identity_guard BEFORE INSERT ON mailbox
BEGIN
  SELECT RAISE(ABORT,'FLY-1572: identity not reserved or already archived')
   WHERE NOT EXISTS (SELECT 1 FROM mailbox_identity
                      WHERE id = NEW.id AND delivery_id = NEW.delivery_id
                        AND archived_at IS NULL);
END;
-- registry 自身:no-delete / no-rekey 触发器;UPDATE 只允许 archived_at NULL→非NULL 一次性盖章
```
- **写协议三分支**(事务内,DB 触发器兜底而非 TS SELECT-then-INSERT 独担;所有写入口先走 typed registry resolver,不让 raw `INSERT OR IGNORE` 直接撞 archived trigger):
  ①新身份 → registry INSERT + mailbox INSERT(同事务,DB 可证明活行必有精确配对);
  ②active 重放(pair 在住)→ resolver canonical compare 后返回 already-active/no-op;
  ③archived 重放(pair 已盖章)→ resolver canonical 投影 hash 相同则 already-settled/no-op,不同则 fail-loud。`insertInstructionWithId` 等 at-least-once sink 改走 resolver,同投影仍返回 `false`,不依赖 `RAISE(ABORT)` 被 `OR IGNORE` 吞掉(它不会)。
- **迁移填充 registry**(纳入覆盖对账:每个逻辑投递恰一条 identity):活行→active;直入 `migrated_history` 的 49k 历史行→**archived**(旧稳定 id 从此永久占用,迟到 source replay 走③);question/ack mirror 按双身份折叠成一条 pair。
- 测试:active duplicate no-op / mailbox-without-registry 必炸 / cross-pair 必炸 / 历史行迟到 replay(no-op 与异投影炸)/ registry 删改被拒 / 各事务 fault point / source crash→ACK→archive→replay / 二次归档幂等。

### 3.2 mailbox_log(append-only + settlement CAS)

```sql
CREATE TABLE mailbox_log (
  log_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE,   -- 确定性:'migrated:<src_table>:<row_id>' / 'archived:<id>' /
                                      -- 'settled:<subject_id>' / 'progress:<id>' —— crash 重放幂等键
  schema_version INTEGER NOT NULL DEFAULT 1,
  message_id  TEXT NOT NULL,
  subject_id  TEXT,                   -- settlement 主体(= 被 settle 的 mailbox/lead_inbox 行 id)
  event       TEXT NOT NULL CHECK(event IN
              ('migrated_history','migration_snapshot','archived','processed','disposed','progress')),
  at          TEXT NOT NULL,
  source_table TEXT,
  row_json    TEXT NOT NULL
);
CREATE INDEX mailbox_log_message ON mailbox_log(message_id);
CREATE INDEX mailbox_log_subject ON mailbox_log(subject_id) WHERE subject_id IS NOT NULL;
-- ★ settlement 互斥槽:每 subject 恰一条 processed/disposed,二者互斥
CREATE UNIQUE INDEX mailbox_log_settlement_slot ON mailbox_log(subject_id)
  WHERE event IN ('processed','disposed');
-- append-only 触发器(no update / no delete),照抄 workflow_source_event 模式
```

- **settlement API 合同**:`markProcessed`/`markDisposed` 的替代实现 = 事务内 INSERT settlement 行;UNIQUE 槽冲突时回读、canonical 比对证据,同值幂等、异值 fail-loud —— 与现版 CAS 语义逐条对齐(lead-inbox-queue.ts:1298-1370),受 vitest 竞争/重放测试保护。live 调用者(settleFounderHubRoot / routeFounderReply / handleReceipt / settleChatReceipt / ExternalReceiptSaga.handle / terminal-receipt-settlement)逐一列出新 API 映射(§9 步 3)。
- **settlement 主体命名空间唯一(R3 HIGH 3)**:`subject_id` **恒为 mailbox.id(逻辑 id),仅此一个 namespace**。receipt-facing API 一律收 typed `deliveryId` 参数,在同一事务内经 `receipt_root_lineage` / `mailbox_identity` 解析成逻辑 id 再插 `settled:<logical-id>`;逻辑侧 caller 直接用 message id;迁移把旧 mirror 行的 settlement 主体归一到逻辑 id(evidence 内原 receipt ref 原样保留)。测试:同一 question 先按 message id processed、再按 delivery id disposed → 必须冲突;反向竞争;归档后迟到 settlement。
- **`receipt_root_lineage` 保留不动**(生产 1,153 行,live 查询在 terminal-receipt-settlement);其 AFTER INSERT 捕获触发器移植到 mailbox,**typed 映射显式定稿**:`receipt_id = NEW.delivery_id, question_id = NEW.id, execution_id = NEW.from_agent, root_lead_id = NEW.to_agent`(question 行触发;不依赖 question 自身的 ref_id —— 那本来是 NULL)。`listReceiptRootsForExecution` / `getReceiptSettlementLineage` / terminal settlement **改为只从永久 `receipt_root_lineage` + `session_receipt_lineage` + `mailbox_identity` 解引用**,不得 JOIN 会被迁移/归档删除的 live mailbox row;一致性断言改为 lineage 的 `question_id` 与 identity 中 `delivery_id=receipt_id` 对应的 `id` 相等。迁移/归档后以及 detection 延迟到达时仍可结算。**live 正确性禁止依赖扫 row_json** —— 血缘走永久表,settlement 走 UNIQUE 槽。测试覆盖 live root、已归档 root、迁移直入 log 的 consumed root 与无效 pair fail-loud。
- progress(ProofShot)直接写 `mailbox_log(event='progress')`,attachments 进 row_json。

### 3.2b content_ref GC outbox(R2 HIGH 4:现 purge 并无可抄的账本 —— 先删文件后删行,本就有取证缺口)

```sql
CREATE TABLE content_ref_gc_outbox (
  intent_id   TEXT PRIMARY KEY,        -- 确定性:'gc:<message_id>'
  message_id  TEXT NOT NULL,
  path        TEXT NOT NULL,           -- 规范化路径
  content_hash TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,                  -- 可重试错误回 pending + 退避(R4 HIGH 3:没有回不到候选集的 failed 死态)
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX content_ref_gc_due ON content_ref_gc_outbox(next_retry_at, created_at)
  WHERE state = 'pending';
```
GC drain FSM:候选 = `state='pending' AND (next_retry_at IS NULL OR next_retry_at <= now)`(走上面索引);删除前再核 path/hash;成功或文件已缺 → done;**一切可重试错误(权限/IO/shared-path 仍有活引用)→ 留 pending + attempts+1 + next_retry_at 退避 + last_error**,不存在永久不可见的 failed 死态。测试:pending→claim/crash 重入、权限失败→到期重试→done、shared path 最后一个活引用消失后重试成功(时钟推进)。
归档事务内:row_json 先内嵌文件 bytes(base64)+ hash → INSERT GC intent → DELETE mailbox 行,同事务提交;**commit 后**有界 drain 删文件(FSM 与索引见 §3.2b)。**严格删除原语**(现 deleteContentRef 吞一切 unlink 错误,不能复用):归档**前**读文件缺失/hash 不符 → fail-closed 保留行不归档;commit **后** drain 时文件已缺 → 幂等成功;其余错误按 §3.2b 退避重试;同 path 仍被活行引用 → 留 pending。测试:commit-before-delete crash / delete-before-ack crash 两向重放。

### 3.3 附带表

`loop_owner` 不动(仍是每库单例围栏;扩容后 per-Lead loops + RunnerLane 同进程共享一个 ownerEpoch,语义不变)。`loop_heartbeat` 的 UPSERT 内嵌子查询改指 mailbox。`receipt_alert_outbox` 保持现有 live 写入点,孤儿状态记录在案(清算归 D 单),本单不扩大。FLY-1586 三张附表(freeze_install / fenced_root / sanitation_audit)内容快照进 log 后随迁移退役(freeze 是针对旧表旧存量的 one-shot,新表无存量)。

## 4. 字段拆分对照(37 + 28 → mailbox / log / 删)

### 4.1 lead_inbox(37)

| 去向 | 列 |
| -- | -- |
| 进 mailbox 改名 | to_lead→to_agent、attempts→retry_count;**非镜像行** ref_message_id→ref_id;**折叠 question/ack 镜像**的 ref_message_id 是 logical-id join key,进 mailbox.id 而不是 ref_id。**source 拆二**:审计血缘→source_kind/source_ref,发送者身份→from_agent(按 source 值域映射表:`lead_event:<seq>`→source_ref;`discord_chat` 等→source_kind) |
| 进 mailbox 原名 | id、type、msg_class、priority、content、created_at、deadline_at、last_error、claimed_by、claim_expires_at、next_retry_at、carrier、batch_id(列留,旧值不迁 —— 前置断言 pending batch=0,§8)。**折叠行例外**:messages.type 是权威,旧镜像 `gate_question|runner_question`/protocol type 只留 migration snapshot并按 checkpoint/source 派生 live event type |
| 语义进状态机 | consumed_at→ACKED+acked_at;disposition→state+dead_reason(delivered→ACKED;frozen/quarantine→DEAD);delivered_at(external)→acked_at |
| settle 证据进 log | processed_at/processed_evidence/disposed_at/disposed_evidence(settlement CAS,§3.2;F 单 task 表接手「办没办」) |
| 删(历史值经迁移快照进 log) | read_at、escalated_at、next_unprocessed_at、resend_of、resend_round、delivered_rounds、routing_state、candidates_json(P10:有史以来 0 行)、family_root_id、legacy_alias、receipt_exempt_reason、receipt_episode_id |

**`from_agent` 逐 source-family 定稿(R14 HIGH:NOT NULL 不能靠隐式「值域映射」,live 写入与迁移派生同表,未知 family fail-closed)**:

| source family | live 写入方 | from_agent(live 与迁移同一规则) | source_kind / source_ref |
| -- | -- | -- | -- |
| `discord_chat`(founder chat 影子行) | chat-receipt begin | `'founder'`(发送者事实上是 founder;08-05 实测 8 条未 settle 行按此迁移) | `'discord_chat'` / receipt id |
| `founder_reply`(hub root) | enqueueFounderHubRoot | `'founder'` | `'founder_reply'` / Discord msg id |
| `discord_cross_department` | ExternalReceiptSaga | 发送方 lead id —— **现 API 不携带,扩参显式传入**(Bridge caller 持有,缺参 fail-closed 拒写,这是授权语义不是格式问题);迁移:活行从行内 payload 解析发送 lead,解析不出 → abort 待人工(实测全机仅 2 行且均为历史行,历史行进 log 快照不受 NOT NULL 约束) | `'discord_cross_department'` / Discord msg id |
| `lead_event:<seq>` | enqueueLeadEvent | `'bridge'`(Bridge 生成的事件) | — / seq(source_ref) |
| `protocol_quarantine:*` | quarantine writer | `'bridge'` | 原值留 source_kind |
| `question:<seq>` / `ack_receipt:<id>` 镜像 | (折叠) | messages.from_agent 权威;orphan question 镜像走 §8.2 三级派生 | — |

逐 family canonical replay 测试;写侧遇不在表内的新 source family → fail-closed 拒写,**绝不落未定义 sentinel**。

### 4.2 messages(28)

| 去向 | 列 |
| -- | -- |
| 进 mailbox | id、from_agent、to_agent(+派生 recipient_kind)、type、content、parent_id→ref_id、created_at、expires_at、checkpoint、content_ref、content_type、resolved_at、kind、relay_state、superseded_at/by、resolved_via、deadline_at。与 lead_inbox 镜像折叠时这些 RPC 列(尤其 type/ref_id/checkpoint)为权威 |
| 语义进状态机 | read_at→ACKED(instruction 的 agent-ack);**delivered_at 不是 ACK**(db.ts:5854-5864 状态机注释):instruction delivered-未读→LEASED;response 被 consume(delivered_at 有值)→ACKED |
| 压缩 | 6 sender 列→sender_ref(§6) |
| 删 | logical_event_id(零 SELECT 读者);attachments(progress 随行进 log) |

每个删除列实施时逐列 `rg` 复核零 live 引用后才落 DDL;research §2.5 死代码(db.ts receipt 链 10 方法 + LeadInboxQueue 9 方法 + routeFounderReply legacy family 分支)同 PR 删除。

## 5. 流重接线

### 5.1 founder→Lead(chat 影子行,直推不动)
begin→INSERT(carrier='external', state='QUEUED');complete→ACKED;settle→log settlement(processed);abort/quarantine→DEAD。lane 查询改 state 谓词,external 行对循环 claim 结构性不可见(逐字节等价现状)。

### 5.2 founder→Lead(thread hub root)
enqueueFounderHubRoot→mailbox(inbox lane, priority 0)照旧进循环;routing_state 删;settle→log settlement;未投家族行→DEAD('superseded')。legacy promoted-family 分支删除(P10)。

### 5.3 Runner→Lead(杀双写 ①,QuestionAdmission 改造而非退役)
`insertQuestion` 写一行 mailbox(`type='question'`,to_agent=lead,id=question id,delivery_id=`question:<lead>:<qid>` —— 与现镜像行 id 同构,在途 receipt 与 Lead 可见字节不断链)。折叠后 **messages 列是 RPC 权威**:`type` 永远为 `question`,`ref_id` 永远只表示旧 `parent_id`(question 通常 NULL);原镜像 `gate_question|runner_question` 只进 migration snapshot,live event type 用 `checkpoint IS NOT NULL ? 'gate_question' : 'runner_question'` 派生。**QuestionAdmission 保留为 claim 时 fail-closed 准入服务**,合同定名 `materializeForDelivery`(R2 blocker 2):
1. 准入 discriminator 改为 `row.type='question' AND recipient_kind='lead' AND delivery_id=question:<to_agent>:<id>`,直接以 `row.id` / 同一 mailbox row 做 RPC/eligibility 检查,**不再拿 ref_id 或旧镜像 type 当开关**。missing/superseded/answered/session 存活/workflow gate ownership/Lead scope/terminal/QA hold 全套照旧(question-admission.ts:80-111,188-228)。首次 materialize 前(`source_ref IS NULL`)的 eligibility 失败沿用今天 `admitQuestion=false` 的可重试语义:释放 claim 回 QUEUED、写 `next_retry_at=now+30s`,不建 StateStore event,且 deliverable count 排除未到期行避免 1s 热循环;`revoked_superseded`/`revoked_answered` 以及**已 materialize** 后的 revalidate 失败才 DEAD(保存具体 dead_reason),fail-closed。**revoked_missing 判别子显式化(R14 HIGH)**:`source_kind='question_orphan'`(迁移合成行)的 missing 是**结构性缺席、永不重试 → 首次 claim 即 terminal DEAD**(§8.2 orphan 分支);普通行的 missing/transient hold 才走上述可重试语义。测试逐项覆盖 transient hold→解除→送达、terminal reason→DEAD、orphan-missing 一击 DEAD 与 hot-loop 计数;
2. **append-or-canonical-compare** StateStore lead event:确定性 event id;UNIQUE 冲突时回读并 canonical 比对 type/payload/session key,异值 fail-loud(现 appendLeadEvent 只回读 seq 不比对 —— 须补);
3. 在 comm.db 内按 `id + state='LEASED' + claimed_by=<ownerEpoch> + batch_id + retry_count=0` **CAS 一次性写入不可变的 `delivery_content`(renderEnvelope 产物)+ `source_kind/source_ref`**(seq);CAS 已完成 → 仅允许 canonical-equal 重放,异值 quarantine;
4. **reload 该行**再构建 batch member(loop 现拿 claim 前旧行 —— 须改为物化后重读);member content 固定为 `COALESCE(delivery_content, content)`(question 用前者,enqueueLeadEvent/founder hub 等 enqueue 时已渲染 producer 用后者);adapter 失败重试读已物化字段,**不再变化**。
loop 收 receipt 后 `markLeadEventDelivered` 从 source_ref 取 seq(lead-inbox-runtime.ts:148-153 平移)。adapter 可见 `deliveryId = mailbox.delivery_id`。测试:crash-after-StateStore-append / crash-after-CAS / adapter-failure→retry 字节不变 / event 冲突 fail-loud + **Claude/Codex 逐字节 golden**。
**priority 派生随写入点前移(R13 `question-priority-derivation`)**:现版在 admission 时刻定 priority(question-admission.ts:169),合表后行只写一次,派生逻辑移入各 producer 写入点、逐字保持现值 —— hub root=0(enqueueFounderHubRoot)/ 非 report question=1(insertQuestion)/ protocol(ack_receipt)=1 / **report question=2**(insertQuestion 按 `kind==='report'`)/ lead_event=2(enqueueLeadEvent)。`DEFAULT 1` 只是 DDL 兜底,任何 producer 不得隐式依赖;byte-golden 测试断言 `kind='report'` 的 question 仍排在非 report 之后(批序不因合表改变)。

### 5.3a Lead/bridge 旧 claim-TTL 兼容重领(C 边界澄清,R12 HIGH + R13 HIGH `lead-failed-batch-requeue-gap`)
现版 `claimModelBatch` 会先找 `batch_id IS NOT NULL AND consumed_at IS NULL` 的 frozen batch:**选取本身无 claim 谓词**,选出后仅在存在**未过期的 foreign claim** 时拒绝(lead-inbox-queue.ts:1590-1597),更新守卫是**三路条件** `(claimed_by IS NULL OR claimed_by = <本 owner> OR claim_expires_at < now)`(:1626-1628;protocol 同型 :2478/2492)。Bridge/owner-fence/adapter receipt 后 crash 可在 15s 后按同 membership 重领,adapter 用 `accepted_duplicate_same_membership` 去重。合表必须保留这条**已有**可靠性,不能把它误算成 D 的新增能力:
- 每次 Lead model tick 先查 `recipient_kind='lead' AND carrier='inbox' AND msg_class='model' AND state='LEASED' AND batch_id IS NOT NULL` **AND `(next_retry_at IS NULL OR next_retry_at <= now)`**(R14 MEDIUM:due-time 谓词入合同 —— 现版 caller `respectRetryAt: true` 对既有与新工作同样生效;缺它则 NULL-claim 行下一个 1s tick 就被重领,退避形同虚设、attempts 秒耗尽),按 `ORDER BY priority, seq` 取最早行定 frozen batch(选取无 claim 谓词,平移现版);CAS 更新 `claimed_by/claim_expires_at` 的守卫**逐字采用三路谓词 `(claimed_by IS NULL OR claimed_by = <本 owner> OR claim_expires_at < now)`** —— `claimed_by IS NULL` 一路不可省,两条投递失败路径产出的正是 NULL-claim 态(见下条);存在未过期 foreign claim → 返回空。重领**不改 state/batch_id/delivery_content/source_ref/member 顺序**。成功/冲突/failure 位点逐字平移现版。bridge protocol lane 同一 due-time 谓词。
- **Lead/bridge lane 投递失败转移与 batch_id 生命周期(显式定稿,R13 HIGH)**:adapter 失败 = 现版 `recordModelDeliveryFailure` / `recordProtocolDeliveryFailure` 平移 —— 行**保持 LEASED、保留 batch_id**,置 `claimed_by=NULL, claim_expires_at=NULL`,`retry_count+1`、`last_error`、`next_retry_at` 退避(lead-inbox-queue.ts:2170-2178, 2326-2332);因 batch_id 非空,该行**不会**进 fresh-batch claim(fresh 批次谓词恒含 `batch_id IS NULL`,平移 :1602,本计划把它列为 claim 合同的一部分),只能经上一条 frozen-batch 重领(`claimed_by IS NULL` 路 + due-time 到期)被重新领养;超限 → DEAD,**上限分立平移**(R14 MEDIUM):Lead model = `maxModelAttempts=5`,bridge protocol = `maxProtocolAttempts=3`,不得合并成一个数。§5.4 的「Runner 状态机」不覆盖本转移 —— **Lead/bridge 失败行永不回 QUEUED**。测试补两 lane 的时钟推进退避(due 前不重领、due 后重领、各自上限触 DEAD)。
- **§5.3 项 1 transient 释放同步清 batch_id**:首次 materialize 前 eligibility 失败的释放 = `state=QUEUED, claimed_by=NULL, claim_expires_at=NULL, batch_id=NULL, next_retry_at=now+30s` —— batch_id 必须一并清空:不清则该行既不满足 fresh-batch 的 `batch_id IS NULL`、也不该留在 frozen 集,永久搁浅;若带旧 batch_id 混入新批,membership 变化会触发 adapter `membership_conflict` → 整批 quarantine(lead-inbox-loop.ts:337-347)误杀好消息。
- bridge protocol lane 同样保留旧 `lead_inbox` 的 expired-claim 重领(单行 membership,同一个三路谓词);这是旧能力平移。Runner lane 原 `messages` 无这项能力,仍按 §5.4 停在 LEASED 等 pull ACK,D 才增加通用 lease-expiry 扫描/重投/死信。
- 测试:frozen batch 在 owner-fence-before-handoff / adapter-accept-after-audit-before-ACK / Bridge crash / **adapter-failure(NULL-claim 态)** 四个 fault seam,重领后同 membership 且 adapter 字节相同;未过期 foreign owner 不抢;transient 释放行进 fresh batch 不触发 membership_conflict;Runner LEASED 不被这条查询命中。

### 5.4 Lead→Runner(循环收编;R1 blocker 1 的修正案)
- **耐久 `to_agent` = 完整 execution id**;`runner-<exec8>` 只是 transport alias,仅在适配器边界经 `deriveRunnerMailboxIdentity()` 派生(8 字节碰撞与回查问题不进耐久层)。`recipient_kind='runner'` 由写入方(send/respond)落列。
- **lane 所有权**:每 project 恰一个 `RunnerLane`(挂在 MailboxDeliveryRuntime 里,与 per-Lead loops 平级、共享 ownerEpoch 与 1s/30s 节奏,零新增定时器)。claim 谓词按 recipient_kind 分区:Lead loop 只认 `recipient_kind='lead' AND to_agent=<自己>`;RunnerLane 只认 `recipient_kind='runner'`;**结构上不存在两个 loop 扫同一收件人**。
- **Runner 状态机(无通用租约到期扫描 = C 的边界)**:claim→LEASED(盖 30min claim_expires_at);doorbell 投递成功/`transport:'none'` 跳过 → **停在 LEASED**(不回 QUEUED —— 杜绝热循环与重复认领);投递失败→QUEUED+retry_count+1+next_retry_at 退避(沿用现逻辑),超限→DEAD。Runner LEASED 没有自动出路,由拉取(`flywheel-comm inbox` / `check` / `gate`)对 QUEUED **和 LEASED** 行 ACK;这不取消 §5.3a 对旧 Lead/bridge claim-TTL 重领能力的兼容平移。
- **活跃判定/deliverable count 只数 QUEUED**(LEASED 与 pull-only 行不驱动 tick)—— 循环永不为它们发任何东西(红线①)。
- **RunnerLane 自有 envelope**(不复用 LeadDeliveryBatch):`{mailboxId, executionId, type, kind, contentRef?, content, metadata, intentKey}`,足以逐字重建今天 send.ts/respond.ts 的 wake payload 与 `runner_phase_wakes` intent key(`instruction:<id>` / `gate-answer:<qid>` 映射表落在设计里,账本本身不动);`RunnerMailboxDeliveryAdapter` 内部 = 今天 send.ts:127-186 机制原样搬入(claim push→wakeRunnerMailbox→complete push)。最后一公里 transport.write 一行不改。
- **可用性变化显式接受**:普通 `send/respond` 的耐久行先入 mailbox,doorbell 改由 Bridge RunnerLane 发,因此 Bridge 停机时不再像今天 CLI 同步直推,恢复 Bridge 后再送;数据不丢、延迟上升,列入 §11。`plugin.ts` three-stage QA fix/workflow activation、`gate-poller.ts` 与 `auto-qa-effects.ts` 的现存直呼虽然携带新 instruction 内容,但属于 workflow/park control-plane,本单明确不收编、仍写 `runner_phase_wakes` + transport;所以 C 后仍有 mailbox data-plane 与 control-plane direct wake 两条 Runner 路径,不是“content-free wake”。
- 测试:full-id 无碰撞、成功后无热循环(tick 计数断言)、首 doorbell 丢失后拉取仍达、pull-ACK、no-transport、多 Lead 并发不重复认领。

### 5.5 Lead→Lead(xdept)与 Bridge 事件
xdept = external 模式(5.1)。enqueueLeadEvent 照旧(换表 + ACKED 语义)。

### 5.6 Lead→bridge(ack_receipt,杀双写 ②)+ Lead ACK 口径
inbox-mcp 写 ack_receipt 单行(to_agent='bridge', recipient_kind='bridge', msg_class='protocol');protocol lane claim `WHERE recipient_kind='bridge' AND from_agent=<lead>`,handleProtocol 处理后该行 ACKED,ProtocolIngress 镜像层退役。
**Lead 消息行的 ACK(P9)**:批次 C 内 = 适配器 durable-accept receipt(现 markConsumed 位点原样换成 setState ACKED);ack_receipt 协议照旧驱动 markLeadEventDelivered(StateStore 侧)。agent-ack 与原批的原子关联(ack 才有下一批)是 D 单「租约+in-flight 上限」能力的一半,C 单为它把 `source_ref`/batch_id 关联数据备好。design.md 修订与 FLY-1569 同步是本单交付物之一。

## 6. sender_ref(FLY-1309 五约束 + R1 blocker 8)

一列 TEXT,值 = versioned canonical JSON(键序固定):
```json
{"v":1,"lease_key":"...","generation":7,"holder_pid":123,"holder_start":"...","writer_pid":456,"writer_start":"..."}
```
- 六字段结构保留;holder 缺 history → 省略 holder 键,绝不冒充当前 holder;unprotected/carrier_passthrough → **显式** `{"v":1,"authority":"unprotected","writer_pid":...,"writer_start":...}`;SQL NULL 仅限迁移前史料。
- **fail-closed**:写侧严格校验(键集/类型/safe-integer/lease-key↔generation 成对)不合格拒写;读侧 malformed / 未知版本 → quarantine 错误,**绝不降级为 unprotected**。只有 SQL NULL 或显式 authority:'unprotected' 走 unprotected 梯级。
- `processedFenceFromProvenance` 三级梯(lease→writer_pid→unprotected)判定逻辑逐字对齐现版;handle-receipt 硬守卫不变;FLY-1309 replay 断言更新并保正反测试(含 malformed 拒绝)。

## 7. 保留期与归档(替代 72h DELETE;R1 HIGH 7 的修正案)

- 触发点:CommDB 读写 open(零新定时器),**有界批次固定为最多 10 个 family/open**,走 `mailbox_archive_*` 部分索引;单 family 事务,`BEGIN IMMEDIATE` busy 时跳过本次 sweep 而不让维护竞争使 CLI open 失败。并发测试把 10-family sweep 与 Lead tick/ask/send 对撞,断言无 `SQLITE_BUSY` 逸出、锁持有 p95 <50ms;超过预算先把 limit 下调,不另造定时器。**单 family 体积上限(R13 `archive-single-family-size-unbounded`)**:p95 的主导项是单个超大 family 的锁内 base64 内嵌,不是 family 数 —— 归档候选先估算内嵌字节(content 长度 + content_ref manifest size),超过 **2MB** 的 family 本次 sweep 跳过并计数上报,交给显式维护路径(舰队 quiesced 或专用长锁预算的 runbook 命令)处理;limit 下调只管 family-数这一维,体积维由本上限兜底。生产 content_ref 当前 0 行使该路径默认测不到 —— fixture 必须合成超阈值 family,断言「跳过 + 维护路径完成归档」两分支。
- **归档原子单位 = RPC family**(question + 其 response;无 ref 关系的行自成 family):family 内**所有行都终态**(ACKED/DEAD)且 RPC 维度终局(已答 或 relay_state='terminal_disposed'),retention anchor = family 最晚终态时间 + 72h。FLY-1279 保护语义(未答未终局的 question 永不归档)自然成立。逐行 INSERT log(event='archived', row_json **内嵌 content 与 content_ref 文件内容 bytes(base64)+ hash**)+ INSERT GC intent + **盖 `mailbox_identity.archived_at`(registry 行永不删,身份跨归档占用,§3.1b)** + DELETE,同一事务;文件删除由 §3.2b `content_ref_gc_outbox` 的 post-commit 有界 drain 承担(现 purge **没有**账本 —— 它先删文件后删行,本方案是修正而非照抄)。
- 测试:T0 ACK 问 + T+71h 答 + response 未拉 → 不归档;verify-approval 在归档边界前后语义不变;content_ref 文件删除失败可重放;归档事务 crash 重放幂等。
- **容量取舍显式接受**:`mailbox_log` 按 issue 是 append-only/永不删,本单不做 retention/compaction;这是证据保留成本,不是遗漏。cutover 的 full snapshot 即 post-cutover 容量基线;preflight 要求 `free_bytes >= source + 备份 + 估算 log/refs 峰值 + 20%`(至少原库 3×),迁移演练记录 bytes/source-row。steady-state 只允许 live mailbox 的终态 family 归档,不删除 log;运行盘点报告 post-cutover baseline、月增长率与 `QUEUED/LEASED` age。Runner LEASED/无人 Lead 的 QUEUED 在 D 前可能增长,容量验收明确接受并要求磁盘预警,不得用恢复 72h DELETE 偷删证据。`DROP TABLE` 不宣称回收文件空间;若运维要 compact,只能在备份已验证、舰队 quiesced 后单独 `VACUUM INTO` 新文件并走与 §8.4 同级的原子替换验证,不属于本单默认 cutover。

## 8. 数据迁移(R1 blocker 3/4/5 的修正案)

### 8.1 备份原语(自研,不用 v2-kernel wrapper;R3 blocker 2:`refs/` 纳入备份 authority)
`backupCommDb()`:SQLite online backup API → `.tmp`(0600)→ `integrity_check` + `foreign_key_check` + **comm.db 自己的表清单/schema hash 校验**(v2 的 `schema_migrations` 校验对 comm.db 不适用 —— 生产实测无此表)→ rename 落 `comm.db.pre-fly1572-<ts>`。
**`<comm-db-dir>/refs/` 外部大内容文件同窗备份**(content-ref.ts:24-45,DB-only 备份救不回被 GC 删掉的文件):逐文件复制 + path/hash/size manifest;恢复时逐项验证,缺失/hash 不符 fail-loud。生产当前 content_ref=0 行只是巧合,不是 invariant。
磁盘 preflight:源库 + WAL + 新表/log 峰值 + 备份 + refs ≈ 3× 现库,非只看 145MB。

### 8.2 迁移脚本(`scripts/migrate-fly1572-mailbox.ts`)
- **停机窗 = quiesce 所有 writer,舰队级、跨全部生产库**(不只 Bridge:所有 Lead/Runner/CLI 都直接写 comm.db)。runbook(normative,R8 MEDIUM 3:混合态没有可重启的 binary —— 旧 binary 撞已迁库毒药、新 binary 撞未迁库 legacy fail-loud,§8.3 三态合同保证混合态起不来,这是防呆不是恢复路径):
  1. 先按 §12.C 做**发现式 inventory**(默认项目 glob + `--db`/`FLYWHEEL_COMM_DB` 配置与 live launchd/wrapper 环境 + `~/.flywheel` 下实际含 `lead_inbox` 的 SQLite);发现集与显式迁移清单不恒等即 fail-closed。再停 Bridge → 停 Leads → **停/park 全部 Runner session 并禁止新 launch(R14 HIGH:Runner 与一次性 CLI/MCP 是按需 open 的写者,lsof 快照抓不住不持文件的它们)** → `pgrep`/launchd 断言无任何 flywheel 进程存活 → `fuser`/lsof 断言无进程持有 inventory 中**任何一个**生产 comm.db;
  2. 按冻结后的 inventory **逐库**执行**连续写闸 + staging 迁移**(R15 HIGH + R16 HIGH 修正:chmod 是文件级不是进程级,同 user 的迟到 CLI 能在任何解闸窗 open 读写 —— `CommDB` 构造即读写 open + 建 WAL + 跑 migrations + purge(db.ts:773-785)。canonical legacy 文件的写闸**一经上闸绝不解除**(唯一例外 = abort-all 回退,经 intent 显式复原);post-fence 不存在任何 canonical 写路径,cutover 不在 canonical 上原地做):
     a. (可选优化)迁移进程读写 open canonical → `wal_checkpoint(TRUNCATE)` → 关连接 —— **仅为缩小 WAL,非正确性依赖**;
     b. **chmod 0444 canonical DB + 现存 WAL/SHM = 写闸 ON**;等待 pre-fence holders 排空(lsof 轮询至零)。**冻结快照权威 = DB 文件 + 已提交 WAL 帧**:a→b 缝隙迟到的合法提交**被检出并纳入快照**,不假装它必须失败(R16 HIGH:0444 后无法回读写 checkpoint,收敛环与永不解除自相矛盾 —— 删掉收敛环,改为快照含 WAL);
     c. §8.1 online backup API **只读**跑在冻结 canonical 上(**backup API 天然含 WAL 帧**)→ integrity/FK/schema 校验 → 备份 durable 后、换入前把 canonical sidecars quarantine(其内容已入备份);
     d. staging = 备份快照的私有拷贝,cutover 单事务在 **staging** 上做(§8.2 下条)→ 对账通过 = `staging_verified`;
     e. **同文件系统原子换入(R16 MEDIUM)**:staging 目录 0700、**紧邻 canonical 且断言同 `st_dev`**(跨设备 `EXDEV` fail-closed,**绝不**降级 copy-overwrite),staging 文件 0600;rename + 父目录 fsync 换入 canonical(rename 只需父目录写权,文件级写闸不挡它);换入后的迁移库由毒药 VIEW + schema_generation 接防(chmod 恢复常规),legacy 内容自 b 起到换入落盘**连续**不可写;迟到旧 CLI 两态挨打:换入前撞 0444 `SQLITE_READONLY`/`CANTOPEN`,换入后撞毒药 VIEW —— 无窗口;
     f. **forward `migration-swap-intent-<ts>.json`(R16 HIGH:§8.4 是回滚方向 ledger,两个世界相反、无 refs 换相,不可逐字借用)**:写在被换 DB 之外,含 canonical/staging/backup hash、原文件 mode、**sidecar quarantine/restoration 状态(R17 HIGH)**;相序 **`fenced → backed_up → sidecars_quarantined → staging_verified → canonical_swapped → dir_fsynced → verified → done`**;重入先核对实际 schema/hash/世界态再推进 ledger。**abort-all(放弃本窗)的未换入库复原 = 内容 + mode 双复原(R17 HIGH:快照权威含 WAL 帧,sidecar 已 quarantine 后光复原 mode 会让 canonical 主文件独缺 pre-fence 合法提交 —— 实测裸主文件 `no such table` 而备份含该行)**:优先路径 = 用已验证的 durable online backup 拷贝**原子替换** canonical(backup 已物化 WAL 帧)→ 复原原始 mode → fsync;备选 = 按 intent 记录的 hash 复原被 quarantine 的 WAL 态后再开;**步 3(b) 的 all-legacy 出口门比对「复原后 canonical 投影/hash/行数 vs 权威备份」,不只 schema 分类 + mode**。逐相位 fault-inject 且 recovery 连跑两遍证幂等;专属 fault fixture:a→b 缝隙提交仅入 WAL 的行 → 备份完成 → sidecar quarantine → staging 失败 → abort-all → recovery ×2 → **真旧 build 重启后能读到该行**。
     race 测试语义分层:pre-fence(a→b 缝)注入的合法提交 → **检出并纳入权威备份**;post-fence 三个 seam(备份中 / staging 迁移中 / 换入后)注入 → fail-loud 零行变更。**全部库迁完前舰队保持 quiesced**;fault-injected 证明**不存在 post-backup legacy write**(备份后旧写会让回滚丢数据 —— 这是围栏要挡死的事故形态);
  3. 任一库失败 → 舰队继续 quiesced,二选一**显式**恢复,禁止第三种:(a)修复后续跑剩余库(优先;已迁库的 completed marker 幂等跳过);(b)放弃本窗 —— 已迁库**全部**按 §8.4 回滚,复验 inventory 全为 legacy 态后,才允许重启旧 binary;
  4. 全部目标库 completed marker + inventory 对账通过 → 部署新 binary → 重启舰队 → 冒烟。
  任一步失败的停止点与回退动作逐条写明。
- **单事务硬 cutover**:`BEGIN IMMEDIATE` 内完成 建表/索引/触发器 → 逐 type 迁移 → 全量 log 快照 → DROP 旧表 → 毒药墓碑 → 对账 → **completed marker 最后一条写入**(`mailbox_migration_meta`,含源行数快照与 schema_generation)。中途任何失败 = 整体 ROLLBACK,库回到未迁移态。幂等:completed 已在 → 校验后 no-op;每阶段 fault injection 测试。
- **lead_inbox 行状态分类优先级(R8 HIGH 2 + R9 HIGH 1:适用域 = 全部物理 `lead_inbox` 源行 —— 含折叠镜像行与 external 行,无豁免;`messages`-only 行**不走**此阶梯,它没有 processed_at/consumed_at/disposed_at/carrier 列、其 delivered_at 逐 type 语义不同,按下方 messages 各行映射;折叠对先用阶梯给 lead_inbox 镜像行定档,再套合行规则)**:
  ① **settled 证据优先**:`processed_at IS NOT NULL OR disposed_at IS NOT NULL`(带 evidence)→ settlement 槽 + 该行绝不 QUEUED(external 行同律 —— 现行 external-lane 查询本就排除 processed,08-05 实测存在 1 行 processed-without-delivered external);
  ② **consumed 历史次之**:`consumed_at IS NOT NULL` → log('migrated_history')(参与镜像折叠时见下方合行规则);
  ③ **delivered-only(consumed/processed 皆空)按 carrier 分支**:carrier='inbox' → 逐行人工判定并记录(08-05 全机实测 1 行);carrier='external' → ACKED(external delivered 生命周期终态,对循环不可见);
  ④ **三空按 carrier 分支**:carrier='inbox' → **真未读** QUEUED(唯一进「未读」口径的档);carrier='external' → 未 complete 且未 settle 的 external 行 QUEUED(08-05 实测 3 行;external 生命周期未完成,**不属「未读」口径**,恒等锚外单列对账)。
  任何 `lead_inbox` 物理源行必须恰好落进一档;实施测试覆盖 question 镜像 × ack 镜像 × 普通 inbox × external 的 processed-only / delivered-only / consumed-only / 三空 交叉积 fixture。
- **family-first 保留判定(R14 BLOCKER:迁移分类必须与 §7 的 RPC-family 原子保留同一把尺子)**:per-row 矩阵之上先做家族判定。迁移前把源行按 RPC family 分组(question + 其 responses(parent_id join)+ 各自镜像;无 ref 关系行自成 family):
  1. family 内**任一成员**分类结果为活行(QUEUED/LEASED)→ **整个 family 留在 mailbox**,question root 正常映射(通常 ACKED),**不得因「过期/terminal 历史」独行进 log** —— `check.ts` 先读 question 再 `consumeGateResponse`(join response→question),root 进 log 会把未消费 response 打成孤儿(08-05 只读实测:64 条 `delivered_at IS NULL` 的 response 其 question 已过期/terminal,其中 63 条 question 有 consumed 镜像 —— 逐行矩阵会正好搬丢这批 root);
  2. **未答且非 terminal_disposed 的 question 无视 expires_at 一律保留**(FLY-1279 保护语义,对齐 db.ts:1242-1252 与 getPendingQuestions 的 live 保护;08-05 实测存在 1 条过期未答非 terminal 无镜像 question,逐行规则会仅因过期把它送史);
  3. 仅当 family **全员 delivery-terminal**(ACKED/DEAD)**且 RPC 维度终局**(已答 或 terminal_disposed)**且 family 最晚终态时间 + 72h ≤ cutover 时刻**(R15 HIGH:§7 的第三个条件不可省 —— 08-05 只读实测 363 个全终局 family **全部**仍在 72h 窗内,缺此门会在 cutover 把稳态归档器必须保留的行提前送史)→ 整族进 migrated_history;**窗内终局 family 以终态行留在 mailbox**,交 §7 稳态归档到期处理 —— 与 §7 归档判据字面同一条谓词(全终局 + RPC 终局 + 72h),迁移态与运行态不许有两把尺子。
  4. **family-override 保留 root 的确定性映射(R15 MEDIUM:「正常映射」不够)**:已答或 `terminal_disposed` 的 root 被 family 保留时(无论有无镜像)→ **恒 ACKED、绝不 QUEUED**(不得重投已答/已终局问题;08-05 实测存在 terminal_disposed + 未读 response + **无镜像**的 root,矩阵「无镜像→QUEUED」对它不适用),`acked_at = COALESCE(镜像 consumed_at, messages.resolved_at, 最晚 response created_at, cutover now)`(派生序显式);受保护的过期未答非 terminal root(无镜像)→ **QUEUED**(保持可投递可答,矩阵无镜像规则越过「未过期」限定继续适用)。
  fixture:terminal-question + 未读 response(root 保留 ACKED,**fixture 必须做成无镜像形态**)/ 过期未答受保护 question(QUEUED)/ 全终局 family T+71h(留在 mailbox)/ T+73h(整族入史)。
- **lineage 迁移回填(R14 HIGH:触发器延后创建的正向补偿)**:messages-only 真 question(无旧镜像,delivery_id 迁移生成)入库是迁移 INSERT、此后 materialize 是 UPDATE,运行态 AFTER INSERT 触发器永不为它触发。迁移事务内对**每条真实迁入的 live question 行** insert-or-canonical-compare `receipt_root_lineage(receipt_id=delivery_id, question_id=id, execution_id=from_agent, root_lead_id=to_agent)`(已存在 → canonical 比对,异值 fail-loud);**合成 orphan 行除外**(其既有 lineage 保留原样,不新造)。回填完成后才创建运行态触发器。测试:messages-only question 迁移 → materialize → 归档 → terminal settlement 全程 lineage 可解析。
- **逐 type source-state 矩阵**(实施前在测试中全覆盖;涉及 `lead_inbox` 行的「状态」判定一律先过上方阶梯,messages-only 行按本矩阵各行映射;**矩阵输出再受 family-first 判定约束**):

| 源 | 状态 | 去向 |
| -- | -- | -- |
| messages question(未过期未 terminal)× lead_inbox 镜像行(join ref_message_id) | 镜像 settled / consumed / 真未读(三空)/ 无镜像 | **合一行**:settled→ACKED(见下方合行规则)/ consumed→ACKED / 三空→QUEUED / 无镜像→QUEUED。**双身份各归其位:`id`=messages.id,`delivery_id`=镜像行 id(`question:<lead>:<qid>`);无镜像 → delivery_id 按同构规则生成**;两 id 迁移时 canonical compare |
| **合行规则:settled 镜像 × 活 messages 行**(08-05 实测 50 行,不能 abort-for-manual) | 镜像有 settle 证据、question 无 response 且未 terminal_disposed | 合行 state=**ACKED**(投递维度已由授权 settle 终局,不得再投),acked_at=COALESCE(consumed_at, settle 时间);settle 证据照写 settlement 槽(processed/disposed 各归各);relay_state 从 messages 行原样带走;**迁移不造答案** —— RPC 维度保持未答,与今天语义一致。专属 fixture |
| **orphan question 镜像**(**谓词收窄到真 question 镜像,R13 HIGH `orphan-branch-overreaches-founder-hub` + R14 HIGH 收窄第二刀**:`source LIKE 'question:%'` 且 ref_message_id 无对应 messages;08-05 复测 flywheel dangling-ref 共 3,229+ = question 镜像 2,181 + founder_reply 1,046+ + discord_cross_department 2 + ack 镜像 0,**只有 question 镜像进本分支**。**orphan ack 镜像(`source LIKE 'ack_receipt:%'` 且 dangling)不支持迁移合成** —— 它是 bridge protocol 行、不带 question 型 legacy_alias,静默转 question 是类型错误;preflight 断言其计数 =0(与实测一致),非 0 fail-closed abort 待人工) | settled/consumed/delivered-only / 真未读三空 | logical identity 仍取 `id=ref_message_id`,`delivery_id=mirror.id`,identity 永久占位。历史/settled 档只进 log + archived identity,settlement subject 归一到 ref_message_id;真未读档为满足旧未读覆盖锚先建 QUEUED row(`type='question'`,`source_kind='question_orphan'`,snapshot 保留旧 mirror type),首次 claim 按现版 `revoked_missing` **不投递而 DEAD**。**NOT NULL 列派生(R13 `orphan-row-notnull-columns-undefined`)**:`from_agent` 派生序 = ① `receipt_root_lineage.execution_id`(join receipt_id = mirror.id)→ ② 解析 `legacy_alias` = `<leadId>-<seq>-<execution_id>`(question-admission.ts:178;08-05 实测 2,181/2,181 orphan 镜像全有值;lineage 全机仅 1,860 行不足以独担)→ ③ 双缺 fail-closed abort 待人工,**绝不写 sentinel**;`content` = mirror 行已渲染文本(源 messages 行已 purge,发送方原文不可恢复 —— §3.1「content=发送方原始内容」对该类行记**显式迁移例外**,snapshot 标 rendered-not-original),同字节预填 `delivery_content`;checkpoint/relay_state/expires_at 无源,留列默认。**§3.2 lineage AFTER INSERT 触发器在迁移数据装载完成后才创建** —— 迁移合成行不触发,已有 lineage 行原样保留,不产伪血缘。不凭空造 RPC answer/active source row;专属 fixture 覆盖四档、anchor→claim 转 DEAD、from_agent 三级派生与 fail-closed abort |
| **founder_reply / discord_cross_department 行**(ref_message_id = Discord msg id,**构造性 dangling —— `founder-reply-deliverer.ts:587` / ExternalReceiptSaga 传的就是 Discord id,从未有过 messages 行,不是镜像**;08-05 实测 1,046 + 2 行,100% 永久 dangling) | 全档(先过 §8.2 阶梯) | **不进 orphan 分支**:按 §4.1 非镜像规则 `ref_message_id→ref_id`,`id = delivery_id = 旧行 id`;settlement subject = 旧行 id(settleFounderHubRoot / routeFounderReply 本就按 `founder_msg:<lead>:<msg>` 行 id 结算,UNIQUE settlement 槽 namespace 不分叉);真未读 hub root 照 §5.2 正常 QUEUED(priority 0)可投递,**绝不合成 question_orphan 被 `revoked_missing` 错杀**。fixture:真未读 founder_reply 行迁移后被 Lead 正常 claim/投递;历史 hub root settlement subject 恒为旧行 id |
| messages ack_receipt(未读)× protocol 镜像行(`ack:<lead>:<receipt>`) | 同 question 行(先过全局优先级) | **合一行** to_agent='bridge';`id`=messages.id,`delivery_id`=镜像 id |
| 其余全部行 | — | `delivery_id = id` |
| messages instruction | read→ACKED;delivered 未读→**LEASED**;未投→QUEUED(retry_count 保留) |
| messages response | delivered(已 consume)→ACKED;未→QUEUED |
| messages progress | → log(event='progress') |
| messages 过期/terminal 历史 | → log('migrated_history');**content_ref 非空的历史行同样先内嵌 bytes(base64)+hash 进 row_json、同事务建 GC intent**(R3 blocker 2 —— 不留 dangling 路径) |
| lead_inbox external(chat/xdept) | 先过全局优先级:settled(processed/disposed)→ settlement 槽,不 QUEUED(processed-without-delivered 实测 1 行走这档);disposed→DEAD;delivered 未 settle→ACKED;**未 complete 且未 settle**(08-05 实测 3 行)→QUEUED |
| lead_inbox 其余 pending(inbox lane) | → QUEUED。**pending 的精确谓词 = 真未读三空条件**(§12.B1,issue 2026-08-05 迁移硬约束):`carrier='inbox' AND processed_at IS NULL AND consumed_at IS NULL AND delivered_at IS NULL`。灰区处置见全局优先级 ①-③ |
| lead_inbox frozen/quarantine/consumed 历史 | → log('migrated_history')(disposition 映射记录在 row_json)。**⚠️ 假未读陷阱**:`processed_at IS NULL` 单条件会把「送到了、消费了、只差销账」的行(08-05 全机实测 9,079 行:flywheel 8,630 / growth 301 / personal-assistant 122 / tidal-echo 23 / geoforge3d 3)当成未读搬进新库 —— 它们必须按 consumed 历史进 log,绝不 QUEUED |
- **对账 = 覆盖记录合同,不是行数求和**:每个源物理行恰有一条覆盖记录(成为 mailbox 行 或 log 行);每个「逻辑投递」恰一行 mailbox(镜像对折算一)。**成为活 mailbox 行的源行同时写 `migration_snapshot` log 行**(row_json 全列)—— 被删旧列的值永不丢。log 幂等键 = `event_id UNIQUE`('migrated:<src>:<rowid>'),crash 重放 INSERT OR IGNORE + canonical 比对。
- **未读集恒等锚 = 覆盖投影,不是裸 mailbox.id 比较(issue 2026-08-05 验收锚 + R8 BLOCKER 1 修正,写进脚本终局对账 + QA 验收)**:折叠/孤儿镜像行的旧 lead_inbox id 落在 `delivery_id`(`mailbox.id` = 旧 ref_message_id),裸比 `mailbox.id` 集合会让正确迁移必挂。正确锚:旧库每条真未读(三空)inbox 行,经覆盖记录**恰有一条** `state='QUEUED' AND carrier='inbox'` 的 mailbox 行与之对应,且 **`delivery_id` = 旧行 id**;**镜像判定三分显式(R13 HIGH + R15 MEDIUM:折叠谓词与 orphan 合成谓词自 R15 起刻意不同,不再互称「同一」)**:(a)折叠/锚镜像谓词 = `source LIKE 'question:%' OR source LIKE 'ack_receipt:%'` **且有对应 messages 行**(source-backed)—— 此类行另须 `mailbox.id = 旧行 ref_message_id`;(b)orphan 合成 = **dangling `question:%` 仅此一类**(§8.2 orphan 分支);(c)dangling `ack_receipt:%` = preflight 断零 abort。其余行(**含 founder_reply / discord_cross_department 等构造性 dangling-ref 行**)须 `id = delivery_id = 旧行 id`。锚测试的未读 ack fixture 是 **source-backed** 形态(非 orphan)。恒等比较在「旧真未读 id 集合」与「QUEUED 行的 `delivery_id` 投影集合」之间做(数量 + 逐 id),不满足即整体 ROLLBACK。测试必含真未读 question-mirror、orphan-question-mirror 与 ack-mirror fixture(两 id 不同的行过锚);orphan 随后的 `revoked_missing→DEAD` 是运行态准入,不改 cutover 时刻覆盖证明。external QUEUED 行与 messages 来源行单列对账(不属「未读」口径)。
- **前置断言(fail-closed)**:pending batch=0、pending claim=0、candidates_json 全零(生产已实测为 0;非 0 即 abort 待人工处置)。**相邻通则(issue 2026-08-05)**:`chat-receipt pending = 0` 只覆盖 `chat:` 前缀、未 disposed 的 external 收据,`founder_msg:` / `lead_event:` / `question:` 三个 lane 结构上不在其定义域 —— runbook preflight 不得拿它当「旧库已清空」证据,quiesce 断言按 per-lane 计数逐一列出。

#### RC-6 QA 补遗(2026-08-05)

- cutover 事务前先对 `lead_inbox.source` 做全库、穷尽式族预扫;允许集仅为 `question:*`、`ack_receipt:*`、`discord_chat`、`founder_reply`、`discord_cross_department`、`lead_event:*`、`protocol_quarantine*`、`receipt_resend:*`、`model_quarantine:*`。未知值按 source 聚合列出计数后 fail-loud,不得进入建表事务后才逐行撞到第一个值。QA 在六个生产库确认此前漏掉的两族为 `receipt_resend` **41,845 行**、`model_quarantine` 2 行。
- sender-less `discord_cross_department` 仍遵守已批 fail-close 口径,不加行级特例。2026-08-05 生产副本演练发现 flywheel 2 行 + growth 1 行尚在 72h 窗内;Lead 裁决维持 A:QA 用越过最晚 retention 的合成时钟验证它们自然归史,真机记录当日 abort 属预期。预扫须一次列全每条拦截行及其 `retention_expires_at`;若为非终态则显式报 `none_nonterminal`,让操作员知道它不会靠等待自动解开。
- `receipt_resend:*` 是 FLY-1570 已拆除 watchdog 生成的旧「复制一行重投」产物,发送者恒为 `bridge`;六库实测真未读为 0。它们不是合表后可重新投递的逻辑消息:迁移时 `source_kind='receipt_resend'`、`source_ref=<旧根 id>`,只进 `migrated_history` 并永久占用 archived identity;若预扫后仍出现非终态 resend copy,fail-closed 待人工,绝不把旧自激回声复活进 `mailbox`。
- `model_quarantine:*` 是 Bridge 生成的批次隔离告警,映射为 `from_agent='bridge'`、`source_kind='model_quarantine'`、`source_ref=<batch id>`,再按统一状态阶梯与 72h 保留门处理。
- 真未读锚必须做**双向集合恒等**:从 coverage log 反投影所有 `lead_inbox` 来源、迁移后仍为 `QUEUED/inbox` 的 `delivery_id` 集合,与旧三空集合同时比较数量与逐 id;不能再用 `expected.filter(exists)` 的单向子集检查,否则“多搬”不会被发现。
- WAL 写闸只把 canonical DB 与 `-wal` 设为只读;`-shm` 必须保持 owner 可写(SQLite reader 需要更新 read mark,QA 单变量实测把 `-shm` 设只读会永久挂死)。sidecar quarantine 阶段仍显式处理 `-wal/-shm` 两者。
- inventory 从无界扫描 `~/.flywheel` 收窄为显式白名单:`~/.flywheel/comm.db`、`~/.flywheel/comm/<project>/comm.db`、`FLYWHEEL_COMM_DB` 与 `--db`;`db-backups/`、`teamlead.db`、v2-era leftovers 永不自动纳入。白名单命中的 messages-only/unknown 库必须出现在 inventory 并阻断写模式,不得静默过滤。备份重入在新建临时库前清理严格匹配 `<backup>.tmp-<uuid>` 及其 `-journal/-wal/-shm` 崩溃孤儿。

### 8.3 硬 cutover 守卫(无 flag;R2 blocker 3 修正)
- **毒药 VIEW(读写全路径 fail-loud)**:DROP 后建同名 VIEW `messages`/`lead_inbox`,各指向刻意不存在的 sentinel 表(`CREATE VIEW messages AS SELECT * FROM fly1572_poison_messages_use_mailbox`)。SQLite 建 VIEW 不校验引用、prepare 时才解析 —— 旧 binary 的 `CREATE TABLE IF NOT EXISTS` 因同名对象 no-op,而 **SELECT 与一切写都会在 prepare/执行时报 `no such table: fly1572_poison_...`** —— 空表墓碑做不到的(SELECT 静默返 0 行、未命中行的 UPDATE/DELETE 不触发行级触发器)这里全覆盖。
- **新 binary 三态 open 合同(R2 HIGH 5)**:①virgin(文件不存在/零对象)→ 单事务建全套 mailbox_v1 schema + meta + 毒药 VIEW 并写 generation(新项目开箱即用,open-or-create 公开合同不变);②`schema_generation='mailbox_v1'` → 严格校验后打开;③**任何 legacy/partial/unknown schema → fail-loud 指向 migration runbook**(绝不隐式 bootstrap 跳过旧数据)。`openReadonly` 同样校验 generation。测试:全新 project / 空文件 / 旧库 / 半建 meta / 错 generation / 迁移中断库。
- **负向测试**:用真 pre-FLY-1572 build(git worktree checkout 旧 commit)对迁移后副本跑**全部 live 旧入口**:ask/gate/send/respond/inbox/check + verify-approval/pending/complete/runner-stopped + 只读路径,逐一断言 fail-loud(而非静默空读/changes=0),并断言无附带表副作用。

### 8.4 回滚(实测一次;R4 HIGH 2:DB+refs 跨资产 crash reconciliation)
两类资产(DB 文件 + `refs/` 树)的恢复是**一个带 durable intent 的分相流程**,不是顺手两步:
1. **staging 全构造先行**:DB staging copy + 完整 refs staging tree 都按 manifest 逐项 hash 验证通过后,才进入交换段;
2. **durable restore intent/phase ledger** 写在被替换 DB **之外**(`comm.db.restore-intent-<ts>.json`),相序 **`staged→refs_swapped→db_swapped→verified→done`**(R5 blocker:**refs 先换、DB swap 是最后的 commit point** —— 换 DB 之前 canonical 路径上一直是迁移后的库,旧 binary 被毒药 VIEW 挡、新 binary 被外部 intent 挡;真实 pre-FLY-1572 binary 不认识 restore-intent,所以**绝不能先换 DB**:那会在 refs 未齐时放出一个可写旧 schema 的世界。DB swap 落盘后,旧 DB 与 refs 已是一致世界,旧 binary 可以运行 —— 这正是回滚的目的);
3. **canonical DB sidecar 是显式资产**(R6 blocker;`comm.db-wal`/`comm.db-shm` 不随主文件 rename 移动,漏掉会造成「旧主库 + 迁移库 WAL」混合态):`db_swapped` 之前 —— quiesce 并断言无进程持有 DB/WAL/SHM → 对迁移库 `wal_checkpoint(TRUNCATE)` 且要求 busy=0、全帧落盘 → 关连接 → WAL 非空即 fail-closed → `-wal`/`-shm` 可恢复地 quarantine/移除 + 父目录 fsync(对齐 v2 database-lifecycle.ts:208-216,264-282 的排干纪律);
4. 每个 checkpoint/sidecar 变更与 rename/fsync primitive 都按 **intent→apply→verify→complete** 四拍走:重入时**先 verify 实际 world state(pre/post image)再推进 ledger**,不盲信可能落后的 phase 字段做第二次 rename;
5. **mixed-state 重入收敛**:重跑按 intent 相位 + 实际状态判定续作;post-backup 多出来的 refs 文件 quarantine(不静默遗留);exact-manifest 收敛后写 done、删 intent;
6. readonly integrity/FK/表清单/行数/refs manifest 校验 → 回退部署 → 起 Bridge → 旧 build 冒烟。
**真 pre-FLY-1572 build 测试覆盖每个 fault intermediate**(含 checkpoint 前后、sidecar quarantine、父目录 fsync 各点):commit point(db_swapped)之前所有旧 live/只读入口必须 fail-loud 零副作用;commit point 之后允许打开,但断言 DB+refs manifest 完整一致且**无异源 sidecar 残留**。
仿 v2 模式(database-lifecycle.test.ts:128-149 / rollback-t1.test.ts:144-175):对 intent、refs swap、DB rename、各 fsync、verification、completion marker **逐点 fault-inject,连跑两遍证明幂等**。备份文件即回滚,无 feature flag。

## 9. 实施顺序与 TDD

| 步 | 内容 | 测试先行 |
| -- | -- | -- |
| **0** | **权威文档核验(R2 HIGH 6;R14 LOW 降级为 verification-only)**:`design.md` §3 P9 批次口径注记**已落且 status=confirmed**(commit fd1eb734 + durable confirmation ids),FLY-1569 已同步 —— 实施开工时只需断言注记在位与 confirmed 状态,不再等待或重复治理动作;断言失败才升级 Lead | — |
| 1 | flywheel-comm:mailbox+log+gc_outbox schema、三态 open 合同、MailboxQueue(state 机/claim 分区/settlement CAS)、写闸门平移(normalize/truncate) | schema/state/claim/settlement 竞争与重放/三态 open/闸门(现 lead-inbox-queue.test 改写) |
| 2 | sender_ref v1 序列化 + fail-closed 校验 + fence 梯 | round-trip/四态/malformed 拒绝/降级梯逐字/FLY-1309 replay |
| 3 | settlement 调用方迁移(founder hub/chat/xdept/handle-receipt/terminal-receipt-settlement)+ receipt_root_lineage 触发器移植 | 各 caller 语义对齐 + lineage 查询等价 |
| 4 | CLI 改写(ask/gate/send/respond/inbox/check/chat-receipt/route-founder-reply/handle-receipt/runner-stopped/pending/complete/verify-approval)——语义与输出字节不变 | 各 command 测试 + verify-approval 反向兼容 sentinel |
| 5 | teamlead:per-Lead loop 换 MailboxQueue、QuestionAdmission 准入化(claim 扩展点)、RunnerLane + RunnerMailboxDeliveryAdapter、protocol lane 收编、heartbeat SQL、boot 时序平移 | Lead 适配器测试一行不改全绿 / Claude+Codex payload golden / 5.4 六项测试 / 双写死亡断言 |
| 6 | 迁移脚本 + 备份原语 + 毒药墓碑 + 归档 sweep | 矩阵全覆盖/幂等重跑/覆盖记录对账/fault injection/旧 build 负向/回滚干跑 |
| 7 | 死代码清理 + 逐列 rg 断言(进 scripts/__tests__) | — |
| 8 | 全仓门:pnpm lint + pnpm -r build + test:packages:run + shell 测试 | — |

真机 E2E(QA 节点):四条流送达+ack+状态断言;生产库副本迁移演练(含时长实测)+ 回滚实演;Bridge 重启 + fleet 12/12;现有 runner 不受影响;design.md P9 修订随主 PR。

## 10. 不做什么

**通用**租约到期扫描/重投、合批、死信闸、agent-ack 闭环(D=FLY-1573;Runner LEASED 无自动出路是刻意留白;但 §5.3a 必须平移旧 Lead/bridge 已有的 claim-TTL frozen-batch 重领)、Discord 直推收编(E;carrier 保留)、task 表(F;settle 证据暂入 log settlement 槽)、feature flag(禁令;cutover 靠 schema_generation+毒药墓碑,不靠开关)、新优先级/折叠策略、runner_phase_wakes 改革(park/workflow direct wake 与泄漏行为修复归 D;本单只把 ordinary send/respond 数据流收进 mailbox + intent key 映射表)。

## 11. 风险

| 风险 | 缓解 |
| -- | -- |
| 版本错配窗口 | 毒药墓碑写必炸 + schema_generation 守卫 + runbook quiesce/进程断言 + 旧 build 负向测试(§8.3) |
| 迁移时长/体积(49k 行全量 JSON 入 log) | 单事务批量;演练实测;磁盘 preflight 3× |
| 渲染移到 claim 时改变 Lead 可见字节 | renderEnvelope 本体复用 + Claude/Codex 逐字节 golden |
| LEASED 行滞留 | Lead/bridge 旧 frozen batch 按 §5.3a 保留 TTL 重领;仅 Runner LEASED 保持 pull-ACK、无通用扫描,D 单接管;监控按 recipient_kind 列 age/count |
| ordinary Lead→Runner 依赖 Bridge liveness | mailbox 耐久先写,Bridge 恢复后 RunnerLane 送;冒烟覆盖 Bridge down 写入→restart→送达,接受相对现版同步 CLI doorbell 的延迟变化 |
| append-only log / 非终态 live 行增长 | 永不删是 issue 证据合同;按 §7 建 baseline/增长率/磁盘预警,D 后再收敛 Runner lease,不恢复 72h 证据删除 |
| settlement 并发冲突 | UNIQUE 槽 + canonical 比对 + fail-loud(§3.2),竞争测试 |
| sender_ref 畸形 | fail-closed + quarantine,绝不降级(§6) |

## 12. 重基核查与 issue 新约束折入(2026-08-05,继任设计节点)

> 本计划成稿于 base `dd165ee5`(2026-08-04);原设计执行体死亡(FLY-1628 文档将其记为 dead-exec 案例 `FLY-1572 / run d0bc75a4`),继任节点在 base `779ebc21` 上逐项复核。§12 之前的正文语义零改动;本节只记录核查结论与 issue 08-05 新增硬约束的折入位点(已就地改 §8.2)。

### 12.A 对三个新合入 main 的 PR 的失效核查

| PR | 核查结论 |
| -- | -- |
| FLY-1631(#775,v2 运行时退役) | `packages/v2-cutover` / `packages/v2-kernel` 已从树上删除;§5(research)与 §8.4 引用的 v2 文件(migration.ts / database-lifecycle.ts / backup.ts / database-lifecycle.test.ts / rollback-t1.test.ts)**现仅存于 git 历史,锚点 commit `dd165ee5`**。判决不变:备份/回滚原语本就是「自研、不依赖 v2 wrapper」,v2 引用是模式参照 —— 实施时从历史 commit 读模式,不依赖树内文件。§3 的 mailbox 命名冲突声明降级为历史注记:v2 包已删、生产 `~/.flywheel/flywheel-v2.db` 实测不存在(2026-08-05);声明本身保留,防读旧文档的人混淆 |
| FLY-1634(#773,restart 净删除) | 仅删 lead-lease **收养**机制(`AdoptLeaseInput` / supervisor audit);§6 sender_ref 依赖的 lease/generation provenance 与 `processedFenceFromProvenance` 三级降级梯(db.ts:3068,08-05 复核在位)原样存活。无影响 |
| FLY-1628(#776,pane-loss reconciler) | db.ts 仅新增 `finalizePaneLossResidue`(触 sessions / three_stage_turn)+ `GuardedFinalizeSessionResult` 新 union 分支;**未新增任何 messages / lead_inbox 读写者**。实施步 4/5 核对 CommDB 方法清单时把它计入。另:FLY-1628 审计把「messages 4 个抵达列全空(763 条 question)」列为本单硬输入 —— 与 §4.2「列语义由状态机接管、不原样搬」一致,无需改动 |

### 12.B issue 2026-08-05 新增迁移硬约束(Cass 实测)的折入

1. **真未读谓词**(已改入 §8.2 矩阵):真未读 = `processed_at IS NULL AND consumed_at IS NULL AND delivered_at IS NULL`。按 `processed_at IS NULL` 单条件搬 = 全机 9,079 条幽灵未读(08-05 逐库实测数字见 §8.2)。
2. **未读集 id 恒等锚**(已改入 §8.2 对账):数量 + 逐 id 恒等,不满足整体 ROLLBACK;这是验收标准 5 的精确化 —— 「行数对得上」不够。
3. **chat-receipt pending=0 定义域通则**(已改入 §8.2 前置断言):preflight 不得拿它当全库清空证据。

### 12.C 多项目库迁移明确化

迁移目标不是单一 glob,而是**发现式 inventory**。seed = `~/.flywheel/comm/<project>/comm.db` + `resolveDbPath` 的 `--db`/`FLYWHEEL_COMM_DB` 来源(launchd plist、wrapper/env 文件、运行进程环境能读取者)；再受控扫描 `~/.flywheel` 下 SQLite header 文件,只读检查是否含 `lead_inbox`/`messages` 对象,把命中的任意路径并入。**库态分类不认对象名、只认结构(R13 `inventory-detects-poison-views`)**:legacy = `sqlite_master.type='table'` 的 `lead_inbox`/`messages` 且无 `mailbox_migration_meta`;migrated = `mailbox_migration_meta.schema_generation='mailbox_v1'`(此时同名对象是 §8.3 毒药 VIEW,`sqlite_master.type='view'`);两者皆非 → unknown,fail-closed。manifest fingerprint 记录 `(对象名, sqlite_master.type)` 清单 + schema_generation;§8.2 第 3(b) 步「复验 inventory 全为 legacy 态」按本分类判定 —— 已迁库的毒药 VIEW 与旧表同名,名字谓词会把它误报 legacy,回滚门不得依赖毒药 VIEW 事后炸来兜底。08-05 reviewer 另发现 glob 外 `~/.flywheel/comm.db`(含两旧表),证明该步骤不可省。脚本输出 canonical path+device/inode+schema fingerprint 的冻结 manifest;任一配置引用路径不在 manifest、同 inode 多别名、扫描命中未分类库,或 quiesce 后 inventory 漂移都 fail-closed,禁止部署新 binary。

08-05 原 glob 实测清单仅作 seed 证据:flywheel 52,309(真未读 8)/ geoforge3d 36,831 / tidal-echo 2,861 / growth 868 / joycon-typeless 278 / personal-assistant 225 / sub 0 / test-slot-2·4 0,另加上述根目录 `comm.db`;最终以迁移窗冻结 manifest 为准。仅含旧表者逐库执行;无表 QA 残库跳过并记录,但新 binary 启动前同样须被 generation 合同分类。每库独立:备份 → 迁移 → 对账 → completed marker(库内事务原子性照 §8.2)。**部分失败的舰队级出口以 §8.2 runbook 第 3 步为准**(R8 MEDIUM 3):舰队保持 quiesced,显式二选一 —— 续跑剩余库(优先)或全量回滚已迁库后重启旧 binary;**部署新 binary 必须在全部 manifest 目标库 completed marker + inventory 对账通过之后**,§8.3 三态 open 合同把混合态 fail-loud 挡死(防呆,非恢复路径)。生产快照与验收 5 以迁移时刻实测为准。

### 12.D 当前 exec 设计复审 R12 修订(2026-08-05)

正式 gate `b515d6ba-94b1-429e-a23e-4ee78097df69` / request `d1027baa-06c2-4fb9-b4dd-4d6d194587e2` 返回 `CHANGES_REQUESTED`。两项 HIGH 已就地修正:① §5.3a 明确保留 Lead/bridge 旧 claim-TTL frozen-batch 重领,只把 Runner 通用 lease expiry 留给 D;② §3.1/§4/§5.3 明确 folded question 的 `type/ref_id` 权威与新 discriminator,不再绕过 gate admission。同轮 advisories 的 lineage 永久解引用、orphan mirror、transient admission、append-only 容量接受、priority/index、Bridge 依赖、发现式 DB inventory、registry replay、delivery fallback 与 archive-open contention 也一并就地定稿;新 gate 以本版全文为审查对象。

### 12.E 继任 exec 设计复审 R13 折入(2026-08-05,review request `c51f5e70` round 2)

前任 exec 在 R12 修复(97aadb83)push 后收到 round 2 `CHANGES_REQUESTED`,随即因 founder 停机令终止;本继任设计节点(a939207a)收养并折入全部 7 项:
- **HIGH `orphan-branch-overreaches-founder-hub`**:orphan 镜像分支谓词收窄到真 question/ack 镜像(`source LIKE 'question:%' / 'ack_receipt:%'`);founder_reply(1,046)/ discord_cross_department(2)是**构造性** dangling(ref_message_id 本就是 Discord msg id),走非镜像规则新矩阵行,真未读 hub root 不再被合成 orphan 后 `revoked_missing` 错杀;§8.2 恒等锚镜像判定同一收窄谓词。
- **HIGH `lead-failed-batch-requeue-gap`**:§5.3a 重领 CAS 守卫改为逐字三路谓词(补 `claimed_by IS NULL`);Lead/bridge 失败转移显式定稿(保持 LEASED + 保留 batch_id + NULL claim,永不回 QUEUED;fresh-batch 谓词恒含 `batch_id IS NULL` 列入合同);§5.3 项 1 transient 释放同步清 batch_id,杜绝永久搁浅与 membership_conflict 误 quarantine。
- **MEDIUM ×2**:reclaim 双索引去掉排序键前的非等值列(batch/TTL 判定移 CAS 步,EXPLAIN 断言可满足);orphan 合成行 NOT NULL 列三级派生(lineage → legacy_alias → fail-closed abort,无 sentinel)+ lineage 触发器迁移后才建。
- **LOW ×3**:inventory 库态分类按 `sqlite_master.type` + schema_generation(毒药 VIEW 不误报 legacy);归档单 family 2MB 内嵌体积上限 + 显式维护路径;priority 逐 producer 派生表(report question=2 不掉档)。

### 12.F 继任 exec Codex 复审 R14 折入(2026-08-05)

R14(新 thread 全量复审,含 R13 折入核验 —— 七项全确认在位)返回 1 BLOCKER + 4 HIGH + 1 MEDIUM + 1 LOW,全采纳:
- **BLOCKER**:§8.2 增 **family-first 保留判定**(任一成员活 → 整族留在 mailbox;未答非 terminal question 无视 expires_at 保留;全员 delivery-terminal 且 RPC 终局才整族入史)—— 迁移与 §7 归档同一把尺子,救回 08-05 实测 64 条未消费 response 的 question root 与 1 条 FLY-1279 受保护过期未答 question。
- **HIGH ×4**:lineage 迁移回填(messages-only live question 显式 insert-or-canonical-compare,合成 orphan 除外,回填后才建运行态触发器);orphan 分支再收窄到 question 镜像(orphan ack 实测 0 行 → preflight 断零,不静默转 question)+ `revoked_missing` 判别子显式化(`question_orphan`=terminal,普通行可重试);§4.1 增 from_agent 逐 source-family 定稿表(discord_chat/founder_reply='founder',lead_event/quarantine='bridge',xdept=API 扩参显式传发送 lead、缺参 fail-closed);§8.2 runbook 写者围栏(停/park Runner + 禁新 launch + OS 写闸 chmod 只读 + backup 前/cutover 前双复验 + 无 post-backup legacy write 的 fault-injected 证明)。
- **MEDIUM**:§5.3a 重领合同补 due-time 谓词(`next_retry_at IS NULL OR <= now`,respectRetryAt 平移)+ attempt 上限分立(model 5 / protocol 3)。**LOW**:§9 步 0 降级 verification-only(design.md P9 已 confirmed)。

### 12.G 继任 exec Codex 复审 R15 折入(2026-08-05)

R15(R14 折入核验全确认 + 新查)返回 2 HIGH + 2 MEDIUM,全采纳:
- **HIGH**:family 入史谓词补 **72h 保留门**(08-05 实测 363 个全终局 family 全在窗内,缺门会 cutover 提前送史;窗内终局 family 留 mailbox 交 §7 稳态归档;T+71h/T+73h fixture);写闸改**连续型**(chmod 文件级非进程级,「临时解除」是 TOCTOU —— canonical legacy 一经上闸绝不解除,cutover 在 staging copy 上做、§8.4 纪律原子换入,换入后毒药 VIEW 接防;checkpoint→上闸缝隙以 hash/WAL 复验收敛;四 seam race 测试)。
- **MEDIUM**:family-override 保留 root 的确定性映射(已答/terminal root 恒 ACKED + acked_at 派生序,受保护未答 root QUEUED,terminal-root fixture 无镜像形态);锚措辞三分显式(source-backed 折叠 / dangling question 合成 / dangling ack 断零),未读 ack fixture 标 source-backed。

### 12.H 继任 exec Codex 复审 R16 折入(2026-08-05)

R16(R15 折入核验全确认)返回 2 HIGH + 1 MEDIUM,全采纳:
- **HIGH**:删掉 checkpoint→fence 收敛环(与「永不解除」自相矛盾)—— checkpoint 降级为可选优化,**冻结快照权威 = DB + 已提交 WAL 帧**,§8.1 online backup 只读含 WAL;pre-fence 缝隙合法提交改「检出并纳入备份」,post-fence 三 seam 才要求 fail-loud 零变更;forward **`migration-swap-intent` 独立 ledger**(§8.4 是回滚方向不可逐字借用):七相序 + 重入核实际世界态 + abort-all 复原每个未换入库的原始 mode + 逐相位 fault-inject 双跑。
- **MEDIUM**:staging 目录 0700 紧邻 canonical、断言同 `st_dev`、`EXDEV` fail-closed 绝不 copy-overwrite,staging 文件 0600,fsync 纳入 forward intent。

### 12.I 继任 exec Codex 复审 R17 折入(2026-08-05)

R17(R16 折入核验全确认,并本地实测验证了「0444 下只读 online backup 含 WAL 帧」的核心原语)返回 1 HIGH,采纳:
- **HIGH**:abort-all 的未换入库复原从「只复原 mode」升级为**内容 + mode 双复原** —— sidecar 已 quarantine 后裸主文件独缺 WAL-only 提交(Codex 实测:备份含该行、裸主文件 `no such table`)。intent 增 `sidecars_quarantined` 相位与 sidecar restoration 状态;优先用已验证 durable backup 原子替换 canonical(WAL 帧已物化)再复原 mode;all-legacy 出口门比对复原后投影/hash/行数 vs 权威备份;专属 fault fixture 证真旧 build 重启后读到 WAL-only 行。

### 12.J 终局:R18 APPROVED(2026-08-05)

R18 复核 R17 折入并端到端本地复现优先 abort 路径(WAL-only 行历经只读 backup → sidecar quarantine → 原子替换 → mode 复原 → integrity check 存活)后 **APPROVED — ready to implement**。全程 18 轮:R1-R7(初版)、R8-R11(继任重基核验)、R12-R13(Bridge gate lane)、R14-R18(本继任 exec)。实施期守则(R18 叮嘱):forward-intent 每相位的 fault injection 不得裁剪;内容等价 + mode 双检通过前,旧 binary 一律不得启动。
