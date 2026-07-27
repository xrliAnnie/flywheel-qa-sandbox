# FLY-1497 v2 权威库落地(批次1) — 实施计划

Issue: FLY-1497 (https://linear.app/geoforge3d/issue/FLY-1497/v2批次1-flywheel-v2db-权威库落地-17-表-schema-迁移-kernel-单写路径设计终版-1)
日期: 2026-07-27
基于: research.md(上游: exploration.md;设计权威 = `doc/engineer/plan/v2/design-FINAL-v2.md`,Codex R13 APPROVED)
状态: **codex-approved**(design review 5 轮:R1=9 项/R2=3/R3=2H+1L/R4=1H 全采纳 → R5 APPROVED;评审链存 `design-review/`)

---

## 0. 目标与边界

交付 flywheel-v2.db 数据层地基:**17 表 schema 迁移 + 全部设计索引 + kernel 单写路径骨架 + 迁移/备份合同 + 验收测试**。

- 纯新增包 `packages/v2-kernel`,**零接线**:不 import 进任何现有运行路径,不改任何现有包,生产行为零变化。
- 设计已 R13 APPROVED,本 plan 不重开设计;凡设计给了 SQL 原文的**原样复制**(出处逐条标注;**唯一例外 = D14**:v9 两表 textual PK 补 `NOT NULL` 的方言正确性修正案,见 §3.3),凡设计只给要点的,展开处标 `[落地]` 并给出处版本。
- 不在本单(批次 2-3):消费循环 / dispatcher / 探针 / 告警 / 注入垫片 / 切换手册执行 / kernel HTTP API。

## 1. 包结构

```
packages/v2-kernel/
├── package.json          # name: flywheel-v2-kernel; deps: better-sqlite3 ^12.8.0(仓内既定版本,零新依赖)
│                         # 必须含 root-only exports map(见下)——脚手架参照 token-usage 但此处刻意加严

├── tsconfig.json         # 参照 packages/token-usage
├── vitest.config.ts
└── src/
    ├── index.ts              # 导出面
    ├── paths.ts              # 默认库路径 ~/.flywheel/flywheel-v2.db;一切 API 显式传 path,测试注入临时目录
    ├── connection.ts         # 连接工厂(唯一 PRAGMA 落点)
    ├── migrator.ts           # 迁移器(schema_migrations 记账,fail-loud)
    ├── migrations/
    │   ├── index.ts          # MIGRATIONS 有序数组
    │   ├── 0001-base-schema.ts
    │   ├── 0002-obligations-rebuild.ts
    │   ├── 0003-activations-processing-attempts.ts
    │   └── 0004-mailbox-index-family.ts
    ├── kernel.ts             # 唯一写库入口(单写路径骨架)
    ├── fence.ts              # generation fence 谓词族
    ├── backup.ts             # WAL-safe backup 钩子
    ├── sql/candidates.ts     # 四条候选 SELECT + detector SQL 常量(逐字,§1.2f 原文;引擎批次唯一取用点)
    └── __tests__/
        ├── migrator.test.ts
        ├── migrator-failure.test.ts
        ├── obligations-migration.test.ts
        ├── query-plan.test.ts
        ├── concurrency.test.ts
        ├── kernel-write-path.test.ts
        ├── schema-contract.test.ts
        └── backup.test.ts
```

### 1.1 package.json 边界合同(deep-import 封口)

```json
{
  "name": "flywheel-v2-kernel",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
}
```

- **root-only exports map**:只开放 `"."`,无 wildcard、无内部 subpath——`flywheel-v2-kernel/migrator`、`/connection`、`/backup`、`/dist/*` 一律被 Node 以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 拒绝。`files:["dist"]` 照旧,但它是发布内容清单,不是访问控制。
- §5.4 的 consumer fixture 必须针对**构建后的包 / bare specifier** 验证:root 白名单可用 + 上述 subpath 全部被拒(类型检查或运行时);包内源码 grep 只作 monorepo 相对路径 import 的次级扫描,不冒充完整防线。

## 2. 连接工厂(connection.ts)—— 设计 §0.5b 的机器化

公开与内部选项类型**分离**(readonly 不进 public API——public 入口的读写语义由入口自身决定,不由调用方混选):

```ts
// public(type-only export,见 §5.4):
export interface KernelOpenOptions {
  path: string;                          // 必填;默认值只在 paths.ts 提供,工厂不猜
  busyTimeoutMs?: number;                // 默认 5000
  synchronousMode?: 'FULL' | 'NORMAL';   // 默认 'FULL'
  verbose?: (sql: string) => void;       // 写纪律审计钩子(正式类型,工厂必须透传给 Database 构造)
  txBudgetMs?: number;                   // 事务时长闸预算,默认 1000;须为有限正数,否则抛错
}
export type MigrateOptions = Omit<KernelOpenOptions, 'txBudgetMs'>;   // migrator 恒为可写连接
// internal(不导出):
interface InternalConnOptions extends KernelOpenOptions { readonly?: boolean }
function openKernelDb(opts: InternalConnOptions): Database;           // 包内部函数,不导出
```

行为合同(每条入测试):
1. `new Database(path, { readonly, timeout: busyTimeoutMs, verbose })` —— busy_timeout 与 verbose 均经构造项统一设置(§0.5b「连接工厂统一」;实证:timeout 构造项映射 sqlite3_busy_timeout)。
2. 建库时:父目录 0700、库文件 0600(设计 v1 §1.1)。
3. PRAGMA(写连接):`journal_mode=WAL`、`foreign_keys=ON`、`synchronous` **按 `synchronousMode` 应用**(默认 FULL `[落地]`:设计未钉档位,权威账本正确性优先)。
4. 只读连接(仅包内部使用,如 backup 的源连接):`readonly: true` + 同 busy_timeout + foreign_keys=ON。
5. **一切连接必须出自本工厂**——包内其他模块不直接 `new Database`(测试用 grep 断言源码,防旁路)。
6. `txBudgetMs` / `busyTimeoutMs` 非有限正数 → 构造即抛错;时长测量用 monotonic clock(performance.now)。

## 3. 迁移器(migrator.ts)与迁移链

```ts
export interface Migration {
  id: string;                        // '0001-base-schema' …
  ddl: string;                       // 该迁移的【全部】SQL 文本(含全部 CREATE TRIGGER 全文)= checksum 对象;
                                     // 迁移执行 = exec(ddl),不存在 ddl 之外的隐藏语句
  fkMode: 'on' | 'rebuild';          // rebuild = SQLite 官方表重建步骤
}
export function runMigrations(db: Database, migrations = MIGRATIONS): { applied: string[] };
```

行为合同:
1. 首先(FK=ON,immediate 事务)确保 `schema_migrations` 存在——它是 17 表之一,由迁移器自建:
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY NOT NULL,
  checksum   TEXT NOT NULL,          -- ddl 文本的 sha256
  applied_at TEXT NOT NULL
);
```
2. 逐迁移:已记账 → 校验 checksum 一致(不一致 = fail loud,绝不静默重跑);未记账 → 执行:
   - `fkMode:'on'`:保持 `foreign_keys=ON`,`BEGIN IMMEDIATE` 事务内 `exec(ddl)` + 记账行,一体提交;
   - `fkMode:'rebuild'`(仅 0002):入口断言 `foreign_keys=1`(否则抛错)→ **事务外** `PRAGMA foreign_keys=OFF` → immediate 事务 { exec(ddl) + `PRAGMA foreign_key_check` 结果必须为空(非空=抛错回滚)+ 记账行 } → **finally 块**(无论成败)**事务外** `PRAGMA foreign_keys=ON` 并再次断言 =1——失败路径绝不把连接留在 FK OFF。依据:实证 #9,事务内改 foreign_keys 是 no-op;官方表重建程序要求此顺序;仓内先例 StateStore 的 rebuild 迁移同样 try/finally 恢复。
3. **并发迁移器防护**:每个迁移在取得 `BEGIN IMMEDIATE` **之后**重新读 `schema_migrations`——已被并发实例记账则本实例按已应用处理(校验 checksum 后跳过),避免「锁前都判未应用」双跑。
4. 任何错误整体抛出,不吞;重复运行 = no-op(幂等)。
5. 时间戳统一 `[落地]`:TEXT ISO-8601 UTC;触发器内用 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`,应用层写入由 kernel 传入。

### 3.1 迁移 0001-base-schema(15 表;obligations 取 R5 旧形)

出处:tasks/task_dependencies/attempts/events/commands/gates/capabilities/source_receipts = design-chain/design-v1.md §1.1 + design-v2.md §1.1(commands 状态机/obligations/epoch/archive_manifest)+ design-final.md §1.1(R2-6/R3-4/R4 修订);mailbox = design-v6.md §1.2(终版形,无 claimed 无租约);thread_bindings = design-final.md §1.1。**以下 DDL 全文即实现文本**(实现只许复制):

```sql
-- tasks(v1 §1.1-1 + R2-6 rework_of/lineage_root_id)
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY NOT NULL,
  project_id        TEXT NOT NULL,
  external_issue_id TEXT,
  kind              TEXT NOT NULL,
  state             TEXT NOT NULL CHECK(state IN ('draft','ready','running','blocked','review','done','canceled')),
  state_version     INTEGER NOT NULL DEFAULT 0,
  priority          INTEGER,
  payload           TEXT,
  rework_of         TEXT REFERENCES tasks(id),
  lineage_root_id   TEXT NOT NULL REFERENCES tasks(id),   -- 首任务=自身(实证 #7:自引用行合法)
  created_at        TEXT NOT NULL,
  terminal_at       TEXT
);
CREATE TRIGGER tasks_no_self_rework_ins BEFORE INSERT ON tasks
WHEN NEW.rework_of IS NOT NULL AND NEW.rework_of = NEW.id
BEGIN SELECT RAISE(ABORT, 'tasks.rework_of self-reference'); END;
CREATE TRIGGER tasks_no_self_rework_upd BEFORE UPDATE OF rework_of ON tasks
WHEN NEW.rework_of IS NOT NULL AND NEW.rework_of = NEW.id
BEGIN SELECT RAISE(ABORT, 'tasks.rework_of self-reference'); END;

-- task_dependencies(v1 §1.1-2;self-edge 禁于 CHECK;环检测=kernel 写事务职责,批次2)
CREATE TABLE task_dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  blocked_by_task_id TEXT NOT NULL REFERENCES tasks(id),
  condition          TEXT,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (task_id, blocked_by_task_id),
  CHECK (task_id <> blocked_by_task_id)
);

-- attempts(v1 §1.1-3 + R2-6 terminal_reason;FINAL §1.1「每 task 至多一个 active attempt」)
CREATE TABLE attempts (
  id                 TEXT PRIMARY KEY NOT NULL,
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  generation         INTEGER NOT NULL,
  vendor             TEXT,
  model              TEXT,
  worktree_id        TEXT,
  host_epoch         TEXT,
  desired_state      TEXT NOT NULL CHECK(desired_state IN ('planned','dispatched','started','terminal')),
  observed_state     TEXT NOT NULL DEFAULT 'unknown' CHECK(observed_state IN ('present','absent','unknown')),
  observation_kind   TEXT,
  observed_at        TEXT,
  transcript_cursor  TEXT,
  terminal_reason    TEXT CHECK(terminal_reason IN ('completed','failed','canceled','superseded')),
  started_at         TEXT,
  terminal_at        TEXT,
  UNIQUE (task_id, generation),
  CHECK ((desired_state = 'terminal') = (terminal_reason IS NOT NULL))   -- [落地] R2-6「terminal+reason」耦合
);
CREATE UNIQUE INDEX attempts_one_active_per_task ON attempts(task_id) WHERE desired_state <> 'terminal';

-- events(v1 §1.1-4 + R1-9 cutover_epoch;append-only)
CREATE TABLE events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,   -- [落地] AUTOINCREMENT:归档 DELETE 后 seq 不复用,cursor 单调
  event_uid     TEXT NOT NULL UNIQUE,
  task_id       TEXT REFERENCES tasks(id),
  attempt_id    TEXT REFERENCES attempts(id),
  kind          TEXT NOT NULL,
  source_kind   TEXT,
  source_id     TEXT,
  payload       TEXT,
  cutover_epoch INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TRIGGER events_append_only BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
-- DELETE 不设触发器:§1.3 归档协议要在 manifest 事务删热区行;删除权归 kernel 单写纪律(诚实边界)

-- commands(v1 §1.1-5 + R1-2 六态 + R2-6 增 rejected/canceled/result_code;dispatcher claim 协议保留 → claim 列保留)
CREATE TABLE commands (
  id               TEXT PRIMARY KEY NOT NULL,
  task_id          TEXT REFERENCES tasks(id),
  attempt_id       TEXT REFERENCES attempts(id),
  generation       INTEGER,
  kind             TEXT NOT NULL,
  payload          TEXT,
  payload_digest   TEXT,
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK(state IN ('pending','claimed','accepted','executing','succeeded','failed','rejected','canceled')),
  result_code      TEXT CHECK(result_code IN ('stale','policy_denied','noop','retryable_failure','effect_unknown','succeeded')),
  claim_owner      TEXT,
  claim_generation INTEGER,
  lease_expires_at TEXT,
  effect_key       TEXT UNIQUE,
  cutover_epoch    INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  accepted_at      TEXT,
  completed_at     TEXT,
  result           TEXT
);

-- command_dependencies(R2-7/R3-4 + design-final §1.0 命名;禁 self-edge=CHECK,禁环=触发器,实证 #1)
CREATE TABLE command_dependencies (
  command_id            TEXT NOT NULL REFERENCES commands(id),
  depends_on_command_id TEXT NOT NULL REFERENCES commands(id),
  kind                  TEXT NOT NULL CHECK(kind IN ('notify_before')),
  PRIMARY KEY (command_id, depends_on_command_id),
  CHECK (command_id <> depends_on_command_id)
);
CREATE TRIGGER command_dependencies_no_cycle BEFORE INSERT ON command_dependencies
WHEN EXISTS (
  WITH RECURSIVE reach(id) AS (
    SELECT NEW.depends_on_command_id
    UNION
    SELECT cd.depends_on_command_id FROM command_dependencies cd JOIN reach r ON cd.command_id = r.id
  )
  SELECT 1 FROM reach WHERE id = NEW.command_id
)
BEGIN SELECT RAISE(ABORT, 'command_dependencies cycle'); END;
CREATE TRIGGER command_dependencies_immutable BEFORE UPDATE ON command_dependencies
BEGIN SELECT RAISE(ABORT, 'command_dependencies rows are immutable; delete and re-insert'); END;
-- 依赖边不可变:堵死「合法插入后 UPDATE 成环」旁路(改边=删+插,插入路径重跑环检测)

-- gates(v1 §1.1-6;[落地] state 枚举保守四值,批次3 接线若需扩展走表重建迁移)
CREATE TABLE gates (
  id                     TEXT PRIMARY KEY NOT NULL,
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  attempt_generation     INTEGER,
  kind                   TEXT NOT NULL,
  subject_digest         TEXT,        -- exact-head/subject 绑定(批准绑精确 head,P9)
  state                  TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','approved','rejected','expired')),
  opened_at              TEXT NOT NULL,
  resolved_at            TEXT,
  resolver_capability_id TEXT REFERENCES capabilities(id)
);

-- capabilities(v1 §1.1-7;只存 hash)
CREATE TABLE capabilities (
  id                   TEXT PRIMARY KEY NOT NULL,
  token_hash           TEXT NOT NULL UNIQUE,
  issuer               TEXT NOT NULL,
  audience             TEXT NOT NULL,
  action               TEXT NOT NULL,
  task_id              TEXT REFERENCES tasks(id),
  attempt_generation   INTEGER,
  subject_digest       TEXT,
  issued_at            TEXT NOT NULL,
  expires_at           TEXT,
  absolute_deadline_at TEXT,
  consumed_at          TEXT,
  revoked_at           TEXT
);

-- obligations —— R5 旧形(design-v2 §1.1 + design-final §1.1 + design-v6 §1.1 episode_key)
-- 本表在 0002 被整表重建;此处即「重建迁移五测」的旧形基线
CREATE TABLE obligations (
  id                        TEXT PRIMARY KEY NOT NULL,
  kind                      TEXT NOT NULL,
  target_task_id            TEXT NOT NULL REFERENCES tasks(id),
  target_attempt_generation INTEGER,
  root_episode_id           TEXT,
  parent_obligation_id      TEXT REFERENCES obligations(id),
  depth                     INTEGER NOT NULL DEFAULT 0 CHECK(depth IN (0,1)),
  episode_key               TEXT,
  state                     TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','tombstoned')),
  opened_at                 TEXT NOT NULL,
  resolved_at               TEXT,
  tombstoned_at             TEXT,
  resolution                TEXT,
  resolver_capability_id    TEXT REFERENCES capabilities(id),
  CHECK ((parent_obligation_id IS NULL AND depth = 0) OR (parent_obligation_id IS NOT NULL AND depth = 1))
);
CREATE UNIQUE INDEX obligations_episode_open ON obligations(episode_key) WHERE state = 'open';
CREATE TRIGGER obligations_parent_depth BEFORE INSERT ON obligations
WHEN NEW.parent_obligation_id IS NOT NULL
 AND (SELECT depth FROM obligations WHERE id = NEW.parent_obligation_id) <> 0
BEGIN SELECT RAISE(ABORT, 'obligation parent must be depth 0'); END;    -- 告警不生告警(P5)
CREATE TRIGGER obligations_inherit_root BEFORE INSERT ON obligations
WHEN NEW.parent_obligation_id IS NOT NULL
 AND NEW.root_episode_id IS NOT (SELECT root_episode_id FROM obligations WHERE id = NEW.parent_obligation_id)
BEGIN SELECT RAISE(ABORT, 'obligation child must inherit parent root_episode_id'); END;
CREATE TRIGGER obligations_hierarchy_immutable BEFORE UPDATE OF parent_obligation_id, depth, root_episode_id ON obligations
WHEN NEW.parent_obligation_id IS NOT OLD.parent_obligation_id
  OR NEW.depth IS NOT OLD.depth
  OR NEW.root_episode_id IS NOT OLD.root_episode_id
BEGIN SELECT RAISE(ABORT, 'obligation hierarchy fields are immutable'); END;
-- 层级字段创建后不可变:堵死「合法插入后 UPDATE 挂到 depth=1 父/改 root」旁路
CREATE TRIGGER obligations_tombstone_task_terminal AFTER UPDATE OF state ON tasks
WHEN NEW.state IN ('done','canceled') AND OLD.state NOT IN ('done','canceled')
BEGIN
  UPDATE obligations SET state='tombstoned', tombstoned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE target_task_id = NEW.id AND state = 'open';
END;
CREATE TRIGGER obligations_tombstone_attempt_terminal AFTER UPDATE OF desired_state ON attempts
WHEN NEW.desired_state = 'terminal' AND OLD.desired_state <> 'terminal'
BEGIN
  UPDATE obligations SET state='tombstoned', tombstoned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE target_task_id = NEW.task_id AND target_attempt_generation = NEW.generation AND state = 'open';
END;

-- source_receipts(v1 §1.1-8)
CREATE TABLE source_receipts (
  source_kind    TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  cursor         TEXT,
  applied_at     TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);

-- mailbox(design-v6 §1.2 终版 DDL 逐字段;无 claimed 态、无租约)
CREATE TABLE mailbox (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uid     TEXT NOT NULL UNIQUE,
  source_kind     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  payload         TEXT NOT NULL,
  payload_digest  TEXT NOT NULL,
  to_agent        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  retention_class TEXT NOT NULL CHECK(retention_class IN ('notice','business','dlq')),
  cutover_epoch   INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','tombstoned','dead')),
  retry_count     INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TEXT,
  created_at      TEXT NOT NULL,
  applied_at      TEXT,
  UNIQUE (source_kind, source_id)      -- canonical key(P3 关闭)
);

-- thread_bindings(design-final §1.1 已批文本照落:canonical_key=lineage_root_id 为 PK ——「每 lineage_root
-- 恰一行」;partial unique 按索引台账保留为对 PK 的冗余防御,不引入多行历史语义)
CREATE TABLE thread_bindings (
  lineage_root_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
  thread_id       TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL CHECK(state IN ('active','archived'))
);
CREATE UNIQUE INDEX thread_bindings_one_active ON thread_bindings(lineage_root_id) WHERE state = 'active';

-- archive_manifest(v2 §1.1 R1-8 + design-final §1.3)
CREATE TABLE archive_manifest (
  seq_lo     INTEGER NOT NULL,
  seq_hi     INTEGER NOT NULL,
  sha256     TEXT NOT NULL UNIQUE,
  row_count  INTEGER NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (seq_lo, seq_hi),
  CHECK (seq_lo <= seq_hi)
);

-- meta(键值;键空间:cutover_epoch / lead_registry:<lead_id> / consumer_registry:<agent>,FINAL §1.0)
CREATE TABLE meta (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 3.2 迁移 0002-obligations-rebuild(fkMode:'rebuild')—— FINAL §1.1「obligations(重建迁移)」

官方表重建步骤(foreign_keys 已由迁移器在事务外置 OFF):

```sql
CREATE TABLE obligations_new (
  id                        TEXT PRIMARY KEY NOT NULL,
  kind                      TEXT NOT NULL,
  target_kind               TEXT NOT NULL DEFAULT 'task' CHECK(target_kind IN ('task','agent')),
  target_task_id            TEXT REFERENCES tasks(id),            -- 改 nullable
  target_agent_id           TEXT,                                 -- = backlog subject
  notify_recipient_agent_id TEXT,                                 -- 通知收件人(与 subject 分离)
  target_attempt_generation INTEGER,
  root_episode_id           TEXT,
  parent_obligation_id      TEXT REFERENCES obligations_new(id),
  depth                     INTEGER NOT NULL DEFAULT 0 CHECK(depth IN (0,1)),   -- depth≤1:告警不生告警
  episode_key               TEXT,
  last_enqueued_tier        INTEGER NOT NULL DEFAULT 0,
  suppressed_tier           INTEGER,
  last_notified_tier        INTEGER NOT NULL DEFAULT 0,
  state                     TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','tombstoned')),
  opened_at                 TEXT NOT NULL,
  resolved_at               TEXT,
  tombstoned_at             TEXT,
  resolution                TEXT,
  resolver_capability_id    TEXT REFERENCES capabilities(id),
  CHECK ((target_kind = 'task'  AND target_task_id IS NOT NULL AND target_agent_id IS NULL)
      OR (target_kind = 'agent' AND target_agent_id IS NOT NULL AND target_task_id IS NULL)),   -- 恰一目标
  CHECK ((parent_obligation_id IS NULL AND depth = 0) OR (parent_obligation_id IS NOT NULL AND depth = 1))
);
INSERT INTO obligations_new (id, kind, target_kind, target_task_id, target_agent_id,
  notify_recipient_agent_id, target_attempt_generation, root_episode_id, parent_obligation_id,
  depth, episode_key, last_enqueued_tier, suppressed_tier, last_notified_tier,
  state, opened_at, resolved_at, tombstoned_at, resolution, resolver_capability_id)
SELECT id, kind, 'task', target_task_id, NULL,
  NULL, target_attempt_generation, root_episode_id, parent_obligation_id,
  depth, episode_key, 0, NULL, 0,
  state, opened_at, resolved_at, tombstoned_at, resolution, resolver_capability_id
FROM obligations;
DROP TRIGGER obligations_tombstone_task_terminal;      -- 必须先于 DROP TABLE/RENAME(见下)
DROP TRIGGER obligations_tombstone_attempt_terminal;
DROP TABLE obligations;
ALTER TABLE obligations_new RENAME TO obligations;
CREATE UNIQUE INDEX obligations_episode_open ON obligations(episode_key) WHERE state = 'open';
CREATE TRIGGER obligations_parent_depth BEFORE INSERT ON obligations
WHEN NEW.parent_obligation_id IS NOT NULL
 AND (SELECT depth FROM obligations WHERE id = NEW.parent_obligation_id) <> 0
BEGIN SELECT RAISE(ABORT, 'obligation parent must be depth 0'); END;
CREATE TRIGGER obligations_inherit_root BEFORE INSERT ON obligations
WHEN NEW.parent_obligation_id IS NOT NULL
 AND NEW.root_episode_id IS NOT (SELECT root_episode_id FROM obligations WHERE id = NEW.parent_obligation_id)
BEGIN SELECT RAISE(ABORT, 'obligation child must inherit parent root_episode_id'); END;
CREATE TRIGGER obligations_hierarchy_immutable BEFORE UPDATE OF parent_obligation_id, depth, root_episode_id ON obligations
WHEN NEW.parent_obligation_id IS NOT OLD.parent_obligation_id
  OR NEW.depth IS NOT OLD.depth
  OR NEW.root_episode_id IS NOT OLD.root_episode_id
BEGIN SELECT RAISE(ABORT, 'obligation hierarchy fields are immutable'); END;
CREATE TRIGGER obligations_tombstone_task_terminal AFTER UPDATE OF state ON tasks
WHEN NEW.state IN ('done','canceled') AND OLD.state NOT IN ('done','canceled')
BEGIN
  UPDATE obligations SET state='tombstoned', tombstoned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE target_kind = 'task' AND target_task_id = NEW.id AND state = 'open';
END;
CREATE TRIGGER obligations_tombstone_attempt_terminal AFTER UPDATE OF desired_state ON attempts
WHEN NEW.desired_state = 'terminal' AND OLD.desired_state <> 'terminal'
BEGIN
  UPDATE obligations SET state='tombstoned', tombstoned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE target_kind = 'task' AND target_task_id = NEW.task_id
    AND target_attempt_generation = NEW.generation AND state = 'open';
END;
```

**以上代码块 = 0002 的完整 `Migration.ddl`**(表重建 + 索引 + 全部五个终版触发器全文),checksum 覆盖全部语句,不存在「按 0001 文本重建」的 ddl 外间接引用。

顺序与归属说明(顺序是**硬要求**,已在真库全链跑通验证):
- `obligations_tombstone_task_terminal` / `obligations_tombstone_attempt_terminal` 是 ON tasks / ON attempts 的触发器,**不随 obligations 的 DROP 消亡**,且 `ALTER TABLE ... RENAME` 会重校验全 schema——若此刻这两个触发器仍引用已 DROP 的 obligations,RENAME 直接报 "error in trigger ...: no such table"(实证抓到)。所以必须在 `DROP TABLE` **之前** DROP 这两个触发器,RENAME 之后重建,重建文本在 WHERE 增 `AND target_kind='task'`(FINAL §1.1:task 终态 tombstone 只作用 task-target);
- `obligations_parent_depth` / `obligations_inherit_root` / `obligations_hierarchy_immutable` 是 ON obligations 的触发器,随 `DROP TABLE obligations` 消亡 → RENAME 后重建(全文在上方 ddl 内)。

事务内收尾:`PRAGMA foreign_key_check` 必须为空(迁移器合同 §3-2);FK 开关的 finally 恢复见迁移器合同。

### 3.3 迁移 0003-activations-processing-attempts(fkMode:'on')—— design-v9 §1.6 / §1.2d DDL 原文

以下两段 = design-v9.md §1.6 / §1.2d 代码块复制(含空格与对齐;说明性注释一律放 SQL 之外——FK 指向 UNIQUE 列合法性见实证 #8),**唯一例外 = D14 方言正确性修正案**:两处 `TEXT PRIMARY KEY` 后补 `NOT NULL`(SQLite rowid 表的非 INTEGER PK 允许 NULL,原文按通用 SQL 语义书写未防此 quirk;design review R2 裁定为最小修正案,归档的 design-chain 原文**不改**——历史记录保真,本节文本即实现 canonical):

```sql
CREATE TABLE activations(
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  session_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','terminal'))
);
CREATE UNIQUE INDEX activations_one_per_attempt ON activations(attempt_id) WHERE state='active';
CREATE UNIQUE INDEX activations_one_per_session ON activations(session_ref) WHERE state='active';
```

```sql
CREATE TABLE processing_attempts(
  attempt_uid TEXT PRIMARY KEY NOT NULL,
  message_uid TEXT NOT NULL REFERENCES mailbox(message_uid),
  attempt_no  INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  activation_id TEXT,
  started_at  TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'running' CHECK(outcome IN ('running','succeeded','failed','crashed')),
  settled_at  TEXT,
  UNIQUE(message_uid, attempt_no)
);
CREATE UNIQUE INDEX pa_one_running ON processing_attempts(message_uid) WHERE outcome='running';
```

实现的 canonical 常量、migration checksum 与 snapshot 测试均使用上述同一文本(= 本 plan §3.3,含 D14 修正案);snapshot 测试同时断言「本节文本与 design-chain 原文的 diff 恰为两处 `NOT NULL` 插入」——修正案可审计、不静默漂移。逐字合同的适用范围 = 设计链给出 SQL 代码块的全部对象(七索引家族、四候选、detector、activations、processing_attempts)。

### 3.4 迁移 0004-mailbox-index-family(fkMode:'on')—— design-v9 §1.2f 七索引原文

```sql
CREATE INDEX mailbox_pending_immediate ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL;
CREATE INDEX mailbox_pending_scheduled ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL;
CREATE INDEX mailbox_pending_immediate_f ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL AND source_kind='founder';
CREATE INDEX mailbox_pending_scheduled_f ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL AND source_kind='founder';
CREATE INDEX mailbox_pending_immediate_nf ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL AND source_kind<>'founder';
CREATE INDEX mailbox_pending_scheduled_nf ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL AND source_kind<>'founder';
CREATE INDEX mailbox_pending_age ON mailbox(to_agent, created_at) WHERE state='pending';
```

### 3.5 索引台账(存在性断言全集)

| 类别 | 索引 | 出处 |
|---|---|---|
| mailbox 家族(7) | mailbox_pending_immediate / _scheduled / _immediate_f / _scheduled_f / _immediate_nf / _scheduled_nf / _age | v9 §1.2f 原文 |
| activations(2) | activations_one_per_attempt / activations_one_per_session | v9 §1.6 原文 |
| processing_attempts(1) | pa_one_running | v9 §1.2d 原文 |
| 约束性 partial unique(3) | obligations_episode_open / attempts_one_active_per_task / thread_bindings_one_active | v6 §1.1 / v1 §1.1-3 / final §1.1 |

= **13 个命名索引全部断言存在**(Lead 纠偏:以设计原文为准,不拿数字 9 当合同);UNIQUE 列约束的 sqlite_autoindex 不按名断言。

## 4. 候选 SQL 常量(sql/candidates.ts)—— §1.2f 原文,实现不得改写

F1/F2/N1/N2 = design-v10.md §1.2f 代码块**逐字**;detector = design-v8.md §1.2f 代码块**逐字**:

```sql
-- F1 founder·immediate(命中 mailbox_pending_immediate_f)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind='founder' ORDER BY seq LIMIT 1;
-- F2 founder·scheduled(命中 mailbox_pending_scheduled_f)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind='founder'
 ORDER BY next_retry_at, seq LIMIT 1;
-- N1 非founder·immediate(命中 mailbox_pending_immediate_nf)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind<>'founder' ORDER BY seq LIMIT 1;
-- N2 非founder·scheduled(命中 mailbox_pending_scheduled_nf)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind<>'founder'
 ORDER BY next_retry_at, seq LIMIT 1;
-- detector(per-recipient)
SELECT count(*), min(created_at) FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND created_at<=:cutoff;
```

导出为常量对象(`CANDIDATE_SQL.F1` …/`DETECTOR_SQL`),批次 2 引擎从这里取用;query-plan 测试 EXPLAIN 的就是这些常量本身(同一字符串,不可能漂移)。

## 5. kernel 单写路径骨架(kernel.ts + fence.ts)

### 5.1 唯一写库入口

```ts
type SyncOnly<T> = T extends PromiseLike<unknown> ? never : T;   // 编译期排除 async 回调
export class Kernel {
  static open(opts: KernelOpenOptions): Kernel;  // 唯一构造途径:内部经 openKernelDb 私有持连,不接收也不暴露 Database
  write<T>(label: string, fn: (tx: WriteTx) => SyncOnly<T>): SyncOnly<T>;
  read<T>(fn: (ro: ReadTx) => SyncOnly<T>): SyncOnly<T>;   // 只读访问面(get/all,无 run/cas)
  close(): void;
}
export interface WriteTx {
  run(sql: string, params?: unknown): RunResult;
  get<T>(sql: string, params?: unknown): T | undefined;
  all<T>(sql: string, params?: unknown): T[];
  cas(sql: string, params: unknown, expectedChanges?: number): void;   // 默认 1
  requireIdentity(registryKey: string, expected: AgentIdentity): void; // 见 §5.2
}
```

行为合同(逐条入测试):
1. `write()` 用 `db.transaction(wrapper).immediate()`(BEGIN IMMEDIATE,§0.5b),且 **thenable 检查发生在事务函数体内部、返回之前**:wrapper 内调用用户回调,若返回值为 PromiseLike → 在 wrapper 返回前立即 throw → better-sqlite3 回滚——堵死「async 回调在首个 await 前的写已随 wrapper 返回被提交」的窗口(better-sqlite3 官方 caveat:事务函数一返回即提交)。另在调用前直接拒绝 `AsyncFunction` 构造的回调;类型签名经 `SyncOnly<T>` 条件类型排除 `PromiseLike` 返回值,并附 `// @ts-expect-error` 编译期 fixture(async 回调在类型检查期即被拒,进 typecheck 步骤)。
2. **两层 try/finally 清理合同**(层级是硬要求——better-sqlite3 在 wrapper 之前 BEGIN、之后 COMMIT,wrapper 内的 finally 覆盖不到这两段):

```ts
if (inWrite) throw new NestedWriteViolation(label);
inWrite = true;                                  // 在 BEGIN 之前生效:verbose 回调若在 BEGIN 阶段重入 write() 必被拒
try {
  return db.transaction(() => {
    const tx = makeWriteTx();
    try {
      return invokeCallbackWithThenableAndBudgetChecks(tx);
    } finally {
      tx.invalidate();                           // 回调离开即失效(commit 前),覆盖 normal/thenable/CAS·identity/user-throw 全部出口
    }
  }).immediate();
} finally {
  inWrite = false;                               // 包住整个 invocation:BEGIN 失败(SQLITE_BUSY)、COMMIT/ROLLBACK 全部出口都复位
}
```

- **内层 finally**(wrapper 内):失效本次 tx 句柄——失效后任何 `tx.run/cas/...` 抛 `TxLifecycleViolation`(防 async continuation 或被回调外泄的句柄在事务外写库);
- **外层 finally**(包住 `.immediate()` 整个调用):复位嵌套标志——`BEGIN IMMEDIATE` 因竞争抛 SQLITE_BUSY(wrapper 根本未执行)或 COMMIT/ROLLBACK 阶段抛错,都**不得**把 Kernel 永久钉成「误判嵌套不可写」;标志在 BEGIN 前已置位,BEGIN/COMMIT 阶段的重入(如 verbose 回调里调 write())同样被拒。
3. **禁嵌套**:`write()` 内再调 `write()` 抛错(不静默变 savepoint)——单写路径不该出现嵌套语义。
4. `cas()`:执行后 `changes !== expectedChanges` → 抛 `CasViolation` → 整事务回滚(FINAL §1.2 支柱③「CAS 行数=1 否则整体回滚」)。
5. `requireIdentity()`:同事务内读 `meta` registry 键并按 §5.2 的 discriminated schema **全字段**比较,不匹配 → 抛 `FenceViolation` → 整事务回滚。registry 键不存在 / JSON 畸形 / 缺字段 / kind 不符 = 一律 fail-closed 拒绝。
6. **事务时长合同(「短事务」的可测化)**:wrapper 在回调返回后测量 elapsed,超过预算(`txBudgetMs`,默认 1000ms,可配)→ 在提交前 throw → 回滚并携带 label——同步回调里的长 CPU/同步 I/O 不再能静默通过;同步 I/O 的静态禁令另由 code review 约束(诚实边界:elapsed 闸是下限保护,不是完备证明)。
7. 骨架**不含**业务写操作——批次 2+ 的全部写路径必须经 `Kernel.write` 进来。

### 5.2 identity fence 谓词族(fence.ts)

registry 条目 = **discriminated schema**(design-v8 §1.2d 的 start fence 校验 `{instance_id, generation, activation_id}`;design-v7 的 consumer registry 形状):

```ts
export type AgentIdentity =
  | { kind: 'lead';   leadId: string;  instanceId: string; generation: number }
  | { kind: 'runner'; agentId: string; instanceId: string; generation: number; activationId: string };
export function leadRegistryKey(leadId: string): string;        // 'lead_registry:<leadId>'([落地] ':' 分隔,唯一 canonical helper)
export function consumerRegistryKey(agent: string): string;     // 'consumer_registry:<agent>'(同上)
export function readRegistry(tx, key): AgentIdentity | null;    // 畸形 JSON → 抛错(不是返回 null)
export function writeRegistry(tx, key, entry: AgentIdentity): void;  // 注册/换代事务用(批次2 的 cutover 点)
export const FENCE = {
  mailboxCasPendingApplied: `UPDATE mailbox SET state='applied', applied_at=:now
     WHERE message_uid=:uid AND state='pending'`,
  // …谓词模板族:每条 agent 发起写的 UPDATE 必带状态谓词,与 requireIdentity + cas(=1) 组合使用
};
```

fence 家族的合同 = 「**同一 immediate 事务内**:requireIdentity(按 kind 全字段校验——runner 含 activationId,lead 不含)+ 带状态谓词的 CAS + changes=1 校验;任一不满足整体回滚」。批次 1 用合成写路径(测试内造 mailbox 行 + registry 键)验证:旧世代 / 错 activation / 畸形 registry 的整个事务被拒、库内零残留(FINAL §1.2 支柱③;场景 N6 的 schema/kernel 层子集;processing_attempts start 的三元组校验即建立在此 helper 上,批次 2 不需破坏 API)。

### 5.3 写纪律审计(验收「全部 IMMEDIATE+短事务+busy_timeout」)

- 连接工厂 verbose 钩子(KernelOpenOptions.verbose,正式类型)记录全部执行 SQL:断言 kernel 写路径只出现 `BEGIN IMMEDIATE`(实证 #6),永不出现裸 `BEGIN`/`BEGIN DEFERRED`;
- `db.pragma('busy_timeout')` 断言 = 配置值;
- 源码级 grep 断言(次级防线):包内除 connection.ts 外无 `new Database`;kernel.ts 外无 `.transaction(`——主防线是 §5.4 的导出面收口。

### 5.4 导出面收口(index.ts 白名单)——「唯一写库入口」是 API 结构,不是口头合同

`index.ts` public exports 分**两个穷举集合**(runtime 值与 type-only 分开——type erasure 后 `Object.keys` 只见前者):

**集合 A:runtime value exports(穷举,`Object.keys(await import('flywheel-v2-kernel'))` 恰等断言)**

| 导出 | 说明 |
|---|---|
| `Kernel`(仅 `Kernel.open` 可构造) | 生产消费者唯一写/读入口;构造器私有;不接收、不暴露 `Database` |
| `migrateDatabase(opts: MigrateOptions): {applied}` | bootstrap 例外:按 path 自建**可写**连接跑迁移,自关;不接收 Database |
| `backupDatabase(srcPath: string, destPath: string): Promise<void>` | maintenance 例外:按 path 操作,内部自建 readonly 源连接;不接收 Database |
| `CANDIDATE_SQL` / `DETECTOR_SQL` | §4 常量 |
| `leadRegistryKey` / `consumerRegistryKey` | fence 键 helper 函数 |
| `CasViolation` / `FenceViolation` / `TxLifecycleViolation` / `TxBudgetExceeded` / `NestedWriteViolation` | 全部错误类(穷举,无「等」) |
| `DEFAULT_V2_DB_PATH` | paths.ts 常量 |

**集合 B:type-only exports(consumer 编译 fixture 验证可导入)**

`KernelOpenOptions` / `MigrateOptions` / `AgentIdentity` / `WriteTx` / `ReadTx`。fixture 同时用 `// @ts-expect-error` 验证:`Database` 类型不可从本包导入、async 回调传 `write()` 编译不过。

**不导出**:`openKernelDb`、任何 `Database` 值或类型、`runMigrations(db)` 内部形态、connection.ts/migrator.ts/backup.ts 模块本身。集合 A 由 T5 的 API 表面测试恰等断言;集合 B 由 typecheck fixture 锁定(防未来漂移)。

## 6. 备份合同(backup.ts)

```ts
export async function backupDatabase(srcPath: string, destPath: string): Promise<void>;
```

1. 按 path 自建连接(readonly 源连接)→ `db.backup(tempPath)` = SQLite Online Backup API(WAL-safe,含 WAL 内容;v1 §4「一致快照必须含 WAL」)。
2. **写入本调用独占的临时文件**(destPath 同目录、随机后缀、0600),验证通过后**原子发布**:`fs.linkSync(temp, destPath)`(destPath 已存在 → EEXIST 拒绝,无 TOCTOU 窗口)+ unlink temp;失败路径只清理本调用创建的 temp,绝不动别人文件。
3. 副本验证(不与 live 源做另一时刻的强相等——online backup 允许备份期间源继续写,那种断言会把健康快照误判损坏):副本 `PRAGMA integrity_check`='ok' + `PRAGMA foreign_key_check` 空 + `schema_migrations` 集合与源迁移清单一致。逻辑级行数核对留给 §4 切换手册(批次 3,stop-the-world 下源已静止,才有资格做强相等)。
4. 测试:建库 → 写行使 WAL 非空(不 checkpoint)→ backup → 副本独立打开三项验证过;destPath 已存在 → 拒绝且不动现有文件;验证失败路径 → temp 被清理、destPath 未出现;副本文件权限 0600。

## 7. 测试清单(验收矩阵映射)

全部测试 `PRAGMA foreign_keys=ON`(rebuild 迁移内部按官方程序临时 OFF,迁移完成后连接仍 ON;测试断言迁移后连接 foreign_keys=1)。

| # | 测试文件 | 断言 | 对应验收 |
|---|---|---|---|
| T1 | migrator.test | 从零跑全链:`sqlite_master` 非 sqlite_% 表恰 **17**(含 schema_migrations);§3.5 台账 13 个命名索引全部存在;`PRAGMA foreign_key_check` 空;重复 runMigrations = no-op;篡改 ddl 文本 → checksum fail-loud;0002 后连接 foreign_keys=1 | 验收① |
| T2 | query-plan.test | 五条常量 SQL(§4)逐条 `EXPLAIN QUERY PLAN`:detail 含 `SEARCH` 且含目标索引名(F1→_f immediate,F2→_f scheduled,N1→_nf immediate,N2→_nf scheduled,detector→mailbox_pending_age;接受 COVERING INDEX,实证 #3);全输出无 `USE TEMP B-TREE`;snapshot 分两类:七索引/四候选/detector 与 design-chain 原文 **byte-for-byte**;v9 两表允许且仅允许 **恰两处 `NOT NULL` 插入** 的 diff(D14) | 验收② |
| T3 | concurrency.test | 真双连接:(a) 连接 A 插 running 行提交后,连接 B 插同 message 第二 running 行 → SQLITE_CONSTRAINT(pa_one_running);(b) 交错:A immediate 事务持写锁未提交,B `BEGIN IMMEDIATE` → SQLITE_BUSY(busy_timeout 生效,实证 #5);(c) activations:同 session_ref 双 active 拒;同 attempt_id 双 active 拒;先 terminal 旧行再插新 active 行成功(换代基元可行) | 验收③ |
| T4 | obligations-migration.test | 五测:(1) 0001 停点插旧形行(含 open/resolved/带 parent 各态)→ 跑 0002 → 逐列保真 + target_kind='task' 回填 + 三 tier 默认 0/0/NULL;(2) agent 行可插(target_agent_id 填,target_task_id 空);(3) 双空拒 + 双填拒(恰一目标 CHECK);(4) notify_recipient_agent_id 可独立 UPDATE(换 owner 重路由的 schema 基础);(5) task 终态 → 只 tombstone task-target 行,agent-target 行原样保留可查(触发器 target_kind 限定)。补充:episode_key open 双行拒、resolved 后同 key 可再开;depth=1 行挂 depth=1 父被拒(P5) | 验收④ |
| T5 | kernel-write-path.test | write=IMMEDIATE(verbose 抓 `BEGIN IMMEDIATE`,无裸 BEGIN);AsyncFunction 回调直接拒;**对抗测试 a**:普通函数回调返回 Promise 且首个 await 前已 INSERT → 抛错且最终零行(thenable 在 wrapper 内被拦,整事务回滚);**对抗测试 b**:await 后用旧 tx 句柄再 run → 抛错且零写入(生命周期守卫);**对抗测试 c**:回调先 INSERT 后 throw 且外泄 tx 句柄 → 事务零残留 + escaped 句柄的 run/get/all/cas/requireIdentity 全部抛 TxLifecycleViolation;**对抗测试 d**:一次回调异常后同一 Kernel 的下一次合法 write() 成功(嵌套标志已在 finally 复位);**对抗测试 e**:双连接——连接 A 持写锁使 Kernel B 的 write() 在 BEGIN 阶段吃 SQLITE_BUSY(wrapper 未执行),A 释放后同一 Kernel B 下一次合法 write() 成功(外层 finally 覆盖 BEGIN 失败);**对抗测试 f**:verbose 回调在观察到 BEGIN IMMEDIATE 时重入同一 Kernel.write() → 被 NestedWriteViolation 拒且无 savepoint/写残留(标志在 BEGIN 前已置位);嵌套 write 抛错;cas 行数≠预期 → 整事务回滚(前序写零残留);requireIdentity:registry 缺失拒/JSON 畸形拒/kind 不符拒/世代不符拒/runner activation 不符拒(均整事务回滚零残留)+ 当前身份放行;elapsed 超 txBudgetMs → 提交前抛错回滚(txBudgetMs 非法值构造即拒);API 表面测试:runtime 导出恰等 §5.4 集合 A + 集合 B 编译 fixture(含 @ts-expect-error:async 回调编译拒、Database 类型不可导入);源码 grep 次级断言 | 验收⑤ |
| T6 | backup.test | WAL 非空时 backup → 副本 integrity_check ok + foreign_key_check 空 + schema_migrations 集合一致;destPath 已存在拒且不动现有文件;验证失败 → temp 清理、destPath 未出现;副本 0600 | §4/§6 合同 |
| T7 | schema-contract.test | 命名触发器**全集**存在断言(tasks_no_self_rework_ins/upd、events_append_only、command_dependencies_no_cycle/_immutable、obligations 五触发器、0002 后名单);每个非平凡 CHECK/FK/触发器正反例:tasks 自引用 rework 拒(INSERT+UPDATE)、events UPDATE 拒、依赖环 INSERT 拒 + 边 UPDATE 拒(先合法 a→b,b→c 再 UPDATE c 边成环 → immutable 拒)、obligations 层级 UPDATE 旁路拒(挂 depth=1 父/改 root 均拒)、attempts terminal⇔reason 耦合正反例、mailbox/commands 各 CHECK 枚举拒、thread_bindings PK 重复拒;**textual PK 的 NULL 反例全覆盖**:每张 TEXT PK 表 INSERT NULL 主键拒 + UPDATE 置 NULL 拒(SQLite rowid 表 PK-NULL quirk,D14) | 验收①④ 深化 |
| T8 | migrator-failure.test | 中途语法错误迁移 → 整体回滚、无记账行、**连接 foreign_keys 仍=1**(finally 恢复);人为造 FK 违规使 `foreign_key_check` 非空 → 0002 回滚 + FK 恢复;触发器重建段失败 → 同上;真双连接并发 runMigrations → 恰一次应用、另一实例干净跳过(锁后重读记账) | §3 合同 |

## 8. 实施顺序(Implement 节点,TDD)

1. 脚手架 `packages/v2-kernel`(build/lint/test 接入 workspace,root pnpm lint 过);
2. RED T1 → GREEN:migrator + 0001-0004(DDL 从本 plan 复制);
3. RED T4 + T7 → GREEN:0002 细节(重建步骤 + 触发器全文入 ddl)+ schema 合同(含 UPDATE 旁路正反例);
4. RED T8 → GREEN:迁移器失败路径(FK finally 恢复 + 并发迁移器);
5. RED T2 → GREEN:sql/candidates.ts(常量即测试对象 + 逐字 snapshot);
6. RED T3(真双连接);
7. RED T5 → GREEN:kernel.ts / fence.ts(含 thenable 拦截、生命周期守卫、requireIdentity、elapsed 闸、导出面白名单);
8. RED T6 → GREEN:backup.ts;
9. 全仓 `pnpm lint` + `pnpm -r build` + 包测试;`codex:rescue` code review;PR;ship 走 founder gate(CI 绿 → approve gate → verify-approval → :cool:)。

## 9. 落地决策记录(展开处清单)

| 决策 | 内容 | 依据 |
|---|---|---|
| D1 | events.seq / mailbox.seq 用 AUTOINCREMENT | 归档/retention DELETE 后 seq 不复用;cursor 单调性(§1.3/§1.2e 依赖) |
| D2 | attempts CHECK terminal⇔reason 耦合 | R2-6「取消/被取代=terminal+reason」的行内机器化 |
| D3 | events 只硬禁 UPDATE,不禁 DELETE | §1.3 归档协议要删热区行;删除权归 kernel 纪律(诚实边界) |
| D4 | gates.state 保守四值枚举 | v1 未给枚举;批次 3 接线若需扩展走表重建迁移(0002 已示范该路径) |
| D5 | thread_bindings 照落已批文本:lineage_root_id 为 PK(恰一行),partial unique 作冗余防御保留 | design-final §1.1 原文「canonical_key=lineage_root_id PK」;Codex R1-1 纠正——不以 [落地] 名义引入多行历史语义;若将来需要历史行,须作为对 authority design 的显式修订走批次 3 |
| D6 | synchronous=FULL 默认,`synchronousMode` 正式入 KernelOpenOptions | 设计未钉;权威账本正确性优先,可配置 |
| D7 | 触发器时间戳用 strftime UTC ISO-8601 | 全库时间戳口径统一(单机,库内时间) |
| D8 | obligations 旧形含 attempt-generation tombstone 触发器 | v2 §1.1「tombstone 触发覆盖 task 终态与 attempt generation 终止」;0002 重建保留并加 target_kind 限定 |
| D9 | 迁移 checksum = ddl 文本 sha256(ddl=该迁移全部语句),不符 fail-loud | v1 §1.1「独立迁移器,任何错误 fail loud」;Codex R1-4——触发器全文入 ddl,无 checksum 外语句 |
| D10 | 结构不变量的 UPDATE 旁路一律触发器堵死:依赖边不可变、obligations 层级字段不可变 | Codex R1-3——BEFORE INSERT 触发器可被 UPDATE 绕过;改边/改层级 = 删+插,重走插入校验 |
| D11 | registry 条目 discriminated schema(lead/runner 两形),runner fence 含 activationId | design-v8 §1.2d start fence 三元组 {instance_id,generation,activation_id};Codex R1-5——现在钉死,批次 2 不破坏 API |
| D12 | 事务时长闸:elapsed > txBudgetMs(默认 1000ms)提交前抛错回滚 | Codex R1-8——「短事务」可测化的下限保护;诚实边界:不是同步 I/O 的完备证明 |
| D13 | 备份 = 独占 temp(0600)+ 验证 + linkSync 原子发布;副本验证不与 live 源强相等 | Codex R1-9——online backup 语义;强相等留给批次 3 stop-the-world |
| D14 | 全部 textual PK 显式 NOT NULL(含对 v9 verbatim 两表的最小方言修正案,归档原文不改,snapshot 断言 diff 恰为两处插入) | Codex R2-1——SQLite rowid 表非 INTEGER PK 允许 NULL(官方 quirk);NULL 主键会破坏 canonical identity/FK 可达/CAS 结算 |
| D15 | public options 类型 KernelOpenOptions(无 readonly)与内部连接选项分离;SyncOnly 条件类型 + 编译 fixture;导出面拆 runtime/type 两集合 | Codex R2-2/R2-3——类型合同落到真实签名;type erasure 下 Object.keys 只见 runtime 值 |
| D16 | package.json root-only exports map(仅 "."),consumer fixture 对构建后包验证 subpath 全拒 | Codex R3-1——无 exports map 时 dist/* 可 deep-import,绕过 Kernel 唯一入口 |
| D17 | 两层 try/finally:内层(wrapper 内)失效 tx 句柄;外层(包住整个 .immediate() 调用)复位嵌套标志且标志在 BEGIN 前置位 | Codex R3-2 + R4-1——callback 抛错是正常控制流;BEGIN 失败(SQLITE_BUSY)/COMMIT 阶段也必须复位;verbose 在 BEGIN 阶段的重入要被已生效的 guard 拒 |

## 10. 不做什么(本单边界)

- 不写消费循环/候选选择/公平配额/超龄晋升(§1.2a-e = 批次 2;本单只保证其 SQL 与索引地基被 EXPLAIN 锁死);
- 不写 dispatcher/探针/告警事务/垫片/重启风暴(批次 2-3);
- 不做 comm.db/JSON 信箱的任何迁移与切换(§4 手册 = 批次 3;本单只交付 WAL-safe backup 钩子);
- 不接线任何现有包;flywheel-v2.db 不在生产路径出现(库文件只在测试临时目录被创建)。

## 11. plan 自证(设计阶段已做的实证)

本 plan §3 的 0001-0004 **全量 DDL 文本已在真库(better-sqlite3 12.8.0 / SQLite 3.51.3)端到端跑通**(scratchpad spike,Codex R1 修订后重跑):17 表齐、§3.5 台账 13 命名索引齐、`foreign_key_check` 空、四条候选 SELECT + detector 逐条 EXPLAIN HIT(无 TEMP B-TREE)、obligations 旧行保真/agent 行可插/双空双填拒/tombstone 只作用 task-target 全过、**UPDATE 旁路三探针全拒**(依赖边改环 / obligations 改 root / 改 depth)、**NULL-PK 六探针全拒**(D14 修正后 tasks/thread_bindings/meta/processing_attempts/activations/obligations 的 NULL 主键插入均被 NOT NULL 拒)。0002 的触发器 DROP 顺序即 spike 抓出的真 bug 的修正。Implement 节点从本文复制 DDL 即得绿色起点;测试仍须按 §7 全部独立重写实现(spike 不是交付物)。
