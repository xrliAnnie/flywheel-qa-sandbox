CHANGES REQUESTED

# Flywheel v2 设计稿 v4 复审 R4

- 评审对象：`/tmp/design/design-v4.md`
- 设计稿 SHA-256：`19c3554d188625a948a740979299ce9c406728429b5cd1d1629c6061417e0b78`
- R3 基线：`/tmp/design/codex-verdict-r3.md`
- 仓库基线：`main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`
- 评审边界：只复核 R3 §4 的 5 项最小修改集；不重开 R3 已判闭合的设计。

## 结论

v4 已完整关闭第 1、2、4 项；第 3、5 项仍各有可直接导致 DDL 无法落地或合同无法唯一实现的缺口，因此本轮不能批准。

| R3 最小修改项 | R4 判定 |
|---|---|
| 1. business retention 单个 kernel 事务 | **已闭合** |
| 2. 旧 writer 三重围栏与实弹 Go/No-Go | **已闭合** |
| 3. mailbox 约束、索引、`next_retry_at`、有界退避 | **部分闭合：pending index 是非法 SQLite DDL** |
| 4. admission 强制依赖、notification 基例、无环 | **已闭合** |
| 5. schema/P12/规模与维护合同 | **部分闭合：列名仍自相矛盾，P12 audit 仍未定型** |

## 阻断项

### HIGH-1：`mailbox_pending` 把动态时间写进 partial-index predicate，SQLite 无法创建该索引

v4 把以下内容列为具体索引合同（`design-v4.md:29-31`）：

```sql
INDEX mailbox_pending ON (to_agent, seq)
WHERE state='pending'
  AND (next_retry_at IS NULL OR next_retry_at<=now)
```

这不是可执行的 SQLite DDL。使用稿中原文，SQLite 在 prepare 阶段报：

```text
no such column: now
```

即使把伪代码 `now` 改成 `CURRENT_TIMESTAMP`，SQLite 仍报：

```text
non-deterministic functions prohibited in partial index WHERE clauses
```

因此迁移会在建索引时失败，R3 要求的“有界 pending/claim 查询”也没有兑现。动态截止时间只能作为 claim 查询的绑定参数，不能进入 partial-index predicate。

最小修订：把索引 predicate 限制为静态条件，并在查询中绑定 `:now`。例如拆成：

```sql
CREATE INDEX mailbox_pending_immediate
ON mailbox(to_agent, seq)
WHERE state='pending' AND next_retry_at IS NULL;

CREATE INDEX mailbox_pending_scheduled
ON mailbox(to_agent, next_retry_at, seq)
WHERE state='pending' AND next_retry_at IS NOT NULL;
```

claim 用两个有界分支（或等价、经 `EXPLAIN QUERY PLAN` 证明命中索引的查询）合并候选；scheduled 分支以 `next_retry_at <= :now` 过滤。补迁移实测与 query-plan 验收。

### HIGH-2：`command_dependencies` 的列名修订没有在全文统一

§1.0 已写成：

```text
PK(command_id, depends_on_command_id)
```

（`design-v4.md:19`）

但紧接着 §1.1 仍写：

```text
PK(command_id,depends_on)
```

（`:24`）

`depends_on` 并不是该表声明的列。两段同时属于 schema 合同，实施者无法判断哪段是权威；若照 §1.1 建表会直接得到不存在列的 DDL 错误。把 `:24` 同步改为 `PK(command_id, depends_on_command_id)`，并保留两列对 `commands(id)` 的明确 FK。

### MEDIUM-1：P12 的 audit 仍是字段占位，不是上一轮要求的确切审计合同

P12 已补齐真实 bypass 的 command kind、actor、凭据类别、TTL 上限和正反测试，且把 recovery transition 分离出来，这部分方向正确（`design-v4.md:75-84`）。但三行写的仍是：

```text
events(kind=bypass_used,result_code)
```

（`:79-82`）

它没有给出 `result_code` 的确切值，也没有说明该字段在哪里。继承的 `events` schema 只有 `payload`，没有 `result_code` 列（`design-v1.md:20`）；v4 明确定义的 `result_code` 是 `commands.result_code`（`design-v4.md:23`）。所以实现可能分别把结果写进 event 列、event payload 或 command 行，审计查询与验收没有唯一答案。

最小修订：二选一并逐行写死。

1. 明确 audit 由 `commands.result_code` 承载，并规定成功为 `succeeded`、拒绝为 `policy_denied`，同时写一条 `events.kind='bypass_used'`，其 payload 至少含 `command_id/bypass_kind/actor/reason/capability_id/expires_at`；或
2. 正式给 `events` 增 `result_code` 列及 CHECK，并给每个正向/反向路径的精确值。

反向 403 可以是业务零副作用，但仍应明确是否以及如何留下拒绝审计，避免“未授权尝试”在实现间出现两种语义。

## 已闭合项核对

### 1. business retention：已闭合

v4 明确 detector 只交带 `message_uid` 的 proposal，由 kernel 在单个 `flywheel-v2.db` 事务内完成 mailbox CAS、唯一 decision receipt/event，以及至多一个 obligation；“不建 obligation”同样写终局 decision，重放由唯一键收敛（`design-v4.md:13`）。这覆盖了 R3 HIGH-1 指出的先置 `dead`/后交 proposal 与反向顺序的两个 crash window。

### 2. 旧 writer 围栏：已闭合

v4 同时规定启动入口撤销、旧 token/capability denylist、旧 JSON/comm.db 原路径不可写 tombstone、父目录 fence 与新库 epoch fence（`design-v4.md:67-70`），并要求真实启动两种旧 writer，断言 fail loud、无新文件/`-wal`/`-shm`、无旧 epoch 新行（`:71`）。

这与当前 JSON writer 的真实行为相匹配：它在写前调用 `ensureFileExists`（`packages/agent-team-transport/src/claude/ClaudeMailboxCodec.ts:931-934`），该函数会递归创建父目录和文件（`:1065-1086`）；因此保留原路径 fence 正好补上了“仅 archive 后可被递归重建”的缺口。

### 3. mailbox schema/retry：除索引外已闭合

`message_uid/source_kind/source_id/payload/payload_digest/to_agent/kind/retention_class/cutover_epoch/state/created_at` 已明确 `NOT NULL`，`retention_class`/`state` 有 CHECK；`next_retry_at`、30 秒 base、15 分钟 cap、指数退避以及 claim 尊重 due time 均已写入（`design-v4.md:29-35`）。只剩 HIGH-1 的非法索引。

### 4. notify-then-do：已闭合

admission 明确拒绝零 dependency 的非豁免 action；claim 要求全部 `notify_before` 成功，`effect_unknown` 必须先 reconcile；`notify/founder_page` 是 prerequisite notification 基例，四种 readonly 是穷举豁免，其余均为 action；self-edge 与环由触发器拒绝（`design-v4.md:53-58`）。R3 HIGH-3 的空集真、无限前置链和环三个缺口均已关闭。

### 5. 其余 schema/规模维护项：主体闭合

- `schema_migrations` 已进入 15 表全量清单和迁移/备份合同（`design-v4.md:16-19`）。
- `thread_bindings.canonical_key` 已有显式 `REFERENCES tasks(id)`（`:19`）。
- authority DB `>2GB` 告警线、kernel 单实例 10 分钟 retention tick、tick 互斥、每 tick 最多 5000 行均已给定（`:9-10`）。
- 不在线 VACUUM、每日 idle checkpoint，以及 freelist `>30%` 后停机/backup/VACUUM/verify/重启的维护路径已给定（`:11`）。
- P12 已把三类真实旁路和 break-glass 补回，并与 recovery transition 分开（`:75-84`）；只剩 MEDIUM-1 的 audit 落点和值未定型。

## R5 最小修改集

1. 把动态时间从 partial-index predicate 移到 claim 查询参数；给出可执行的静态 indexes，并用真实迁移 + `EXPLAIN QUERY PLAN` 验证。
2. 删除 §1.1 的旧 `depends_on` 名称，全文只保留 `depends_on_command_id`。
3. 为 P12 写死 audit 落点、payload/列形状，以及成功与拒绝的精确 result code。

完成这三处即可进行下一轮窄复审；无需改动单库 mailbox、retention 单事务、writer fence、notify admission 或其余已闭合决定。
