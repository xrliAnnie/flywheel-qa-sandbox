# FLY-2165 mailbox 撕裂 identity 自愈 — 调研
Issue: FLY-2165 (https://linear.app/geoforge3d/issue/FLY-2165/病根-mailbox-清理不盖-identity-归档章-inspectdeliverystate-硬抛-patrol-tick)
日期: 2026-08-29
基于: exploration.md

## 1. 现有归档合同与漏口

### 1.1 schema 已保护的三面

`packages/flywheel-comm/src/mailbox-schema.ts` 当前有：

- `mailbox_identity_no_delete`：identity 永久；
- `mailbox_identity_update_guard`：只允许 `archived_at NULL → non-NULL`；
- `mailbox_identity_guard`：live mailbox insert 必须已有 active identity；
- `mailbox_log_no_update/no_delete`：log append-only。

缺的第四面是 `DELETE mailbox` guard。当前测试甚至演示了「先手写 archived_at，再裸删 live row」
可以成功，且不要求 archived snapshot。事故止血事务正是从这个口穿过。

### 1.2 所有仓内 delete path 审计

| 路径 | 当前合同 | 本单处置 |
|---|---|---|
| `MailboxQueue.archiveFamily()` | 完整四步，正确 | 不改；加 trigger parity 回归 |
| `scripts/lib/fly-2006-mailbox-archive.mjs` | 完整四步，正确 | 不改；现有 parity 测试继续覆盖 |
| `receipt-teardown-closeout.ts::archiveExternalRow()` | archived full snapshot → identity CAS → delete | 不改；新 trigger 成为额外守卫 |
| `mailbox-migration.ts::persistMapped(keep=false)` | 只写 legacy source coverage log，再 stamp + delete；没有 `event='archived'` live-row snapshot | 改为调用 `queue.archiveFamily({retentionMs:0})` |
| 2026-08-29 手工 `mailbox_archive` 止血 | copy → raw delete | schema trigger 将确定性拒绝再次发生 |

因此 trigger 不能只检查 `identity.archived_at`。它还要找到 matching `event='archived'`，并核验
`row_json` 至少与 `OLD.id/delivery_id/state/terminal timestamp` 一致，才允许 delete。这样一张 `{}`
假 log 也不能绕过。

## 2. typed torn state 的语义

`MailboxSettlement` 增加精确分支：

```ts
{ kind: "torn_identity" }
```

判定只覆盖：identity 存在、`archived_at IS NULL`、live row 不存在。它不把以下 archive corruption
吞成 torn：

- archived identity 无 archived snapshot；
- archived snapshot JSON malformed；
- archived snapshot 非 ACKED/DEAD 或缺 terminal timestamp。

后三类仍 throw，保持既有 fail-closed archive authority。torn 是已知历史撕裂，不是假定终态。

### 2.1 typed consumer sweep

| consumer | 新态行为 |
|---|---|
| `message-status` | human/JSON 显示 `location:'torn'`、空 stamps，exit 2，不能误报 absent/archived |
| `flag-retirement-production` | 既非 acked 也非 dead，现有 guard 自然 fail-closed |
| `lead-event-queue` / infra alert enqueue | 不把 torn 当 archived；若尝试复用 poisoned id，enqueue 仍明确失败 |
| `patrol-tick` | 专门的 wall-clock recovery，见下节 |

不在 `enqueue()` 中自动复活 torn identity：permanent identity 的 projection hash 是 replay fence；
无原行时重插不能证明内容和状态，删除/reuse identity 又被 schema 明令禁止。

## 3. patrol recovery 算法

当前代码先读 settlement anchor，再解析上一钟的 `scheduled_at`。torn 没有可信 anchor，需把
wall-clock slot 计算提前为独立步骤：

1. 解析上一条 durable event payload 的 `scheduled_at ?? generated_at`；坏 timestamp 仍 throw；
2. 算 `previousSlotStart` 与当前 `currentScheduledAt`；
3. settlement 为 torn 时：
   - `previousSlotStart >= currentScheduledAt`：本 slot 已有 durable tick，记 success 并返回；
   - previous slot 已旧：记录结构化 log，跳过 poisoned delivery id，继续 mint
     `patrol_tick:...:after-<previous.seq>`；
4. 其他 settlement 继续用既有 settlement anchor 与 60 秒 double-tick guard。

该算法不 replay torn id，所以不会在 `enqueue()` 再撞同一 active identity；新 event 的 deterministic
delivery id 以新 journal seq/event id 为键，天然绕开坏账。最坏影响是 torn 的那一钟不再补发，
但 cadence 在当前/下一 slot 恢复，且不会同 slot 双发。

## 4. 历史数据 repair 设计

新脚本 `scripts/fly-2165-repair-torn-mailbox-identities.mjs`：

- 默认只读 dry-run；`--apply` 必须同时给尚不存在的 `--backup <path>`；
- apply 前用 SQLite online backup，核 `quick_check='ok'`，再打开写事务；
- authority 只取 `mailbox_archive` preserved row + matching active identity + no live row + zero log；
- 只修 ACKED + `acked_at` 或 DEAD + `dead_at` 的 terminal row；
- 每批写 canonical full `row_json`，追加 `lead_repair` provenance，写 `event='archived'`，
  再 CAS `identity.archived_at`；若有 content_ref，必须可读且按现有合同嵌入 bytes/hash 并写 GC intent；
- 3 条 DEAD 但 `dead_at` 缺失的记录不猜时间，receipt 列为 `unrepairable_missing_terminal_at`；
- 不删除 `mailbox_archive`，脚本可重跑；已修 identity 不再进入 candidate。

apply 分批提交，避免 63k snapshots 形成单个超大 WAL transaction；失败可从 backup 回滚，或直接
幂等续跑。stdout JSON receipt 含 candidate/repaired/skipped/remaining、source digest、backup path/hash。

## 5. TDD seam 与验证矩阵

### RED 1 — schema contract

`mailbox-schema.test.ts` 新增：active row raw delete 被拒；仅 stamp 仍被拒；伪 archived `{}` 仍被拒；
valid matching archived snapshot + stamp 可删。既有 `archiveFamily` 与 closeout tests 是正门回归。

### RED 2 — typed reader/CLI

`mailbox-settlement.test.ts` 手工删 trigger（仅 fixture）、raw delete live row，断言不 throw 且返回 torn；
`message-status.test.ts` 断言 human/JSON 与 exit code。

### RED 3 — patrol restart recovery

`patrol-tick.test.ts` 两条：current slot torn 不双发；old slot torn mint 一个 after-previous 新钟，下一 pass
不再卡旧记录。`patrol-tick-loop.integration.test.ts` 用 real `MailboxQueue` 造 torn，证明 loop 连续推进。

### RED 4 — migration bypass

扩展 mailbox migration fixture：retention-old mapped row 必须留下 `event='archived'` full snapshot，
`inspectDeliveryState()` 返回 archived_terminal，新 delete trigger 不阻断正门。

### RED 5 — repair CLI

新增 `scripts/__tests__/fly-2165-repair-torn-mailbox-identities.test.sh`：dry-run 零写；缺 backup fail；
apply 创建 valid backup；terminal rows 被修、invalid terminal time 被报告并保持 torn；重跑 repaired=0；
content_ref snapshot/GC intent 与 receipt digest 可复核。

### 命令

focused：

```bash
pnpm --filter flywheel-comm test:run -- src/__tests__/mailbox-schema.test.ts src/__tests__/mailbox-settlement.test.ts src/commands/__tests__/message-status.test.ts
pnpm --filter @flywheel/teamlead test:run -- src/__tests__/patrol-tick.test.ts src/__tests__/patrol-tick-loop.integration.test.ts
bash scripts/__tests__/fly-2165-repair-torn-mailbox-identities.test.sh
```

full repo：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`，再单独运行新 shell harness。
