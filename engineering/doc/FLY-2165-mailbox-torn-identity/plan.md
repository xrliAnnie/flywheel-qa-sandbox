# FLY-2165 mailbox 撕裂 identity 自愈 — 实施计划
Issue: FLY-2165 (https://linear.app/geoforge3d/issue/FLY-2165/病根-mailbox-清理不盖-identity-归档章-inspectdeliverystate-硬抛-patrol-tick)
日期: 2026-08-29
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: use the inline execution workflow and complete every checkbox in order. This DAG node must not dispatch successor/review nodes; Flywheel gates own review advancement.

**Goal:** 从 schema 根部禁止无归档证据的 mailbox 删除，让 torn identity 成为可判定态，恢复 patrol cadence，并交付可审计的一次性历史 repair。

**Architecture:** SQLite trigger 是所有 writer 的最终合同；`inspectDeliveryState()` 只读分类，不偷偷修库；`patrol_tick` 以 durable journal 的 wall-clock slot 绕过 poisoned delivery id；独立 repair CLI 从 preserved `mailbox_archive` 原行重建 archive evidence。

**Tech Stack:** TypeScript、better-sqlite3、Vitest、Node.js ESM、Bash harness、pnpm monorepo。

---

## 文件闭集

| 文件 | 责任 |
|---|---|
| `packages/flywheel-comm/src/mailbox-schema.ts` | 新增 delete contract trigger |
| `packages/flywheel-comm/src/mailbox-queue.ts` | typed `torn_identity` reader result |
| `packages/flywheel-comm/src/mailbox-migration.ts` | old-row deletion 改走 `archiveFamily()` |
| `packages/flywheel-comm/src/commands/message-status.ts` | torn 的 CLI view/exit |
| `packages/flywheel-comm/src/__tests__/mailbox-schema.test.ts` | raw-delete negative/positive contract |
| `packages/flywheel-comm/src/__tests__/mailbox-settlement.test.ts` | torn reader regression |
| `packages/flywheel-comm/src/commands/__tests__/message-status.test.ts` | human/JSON torn output |
| `packages/flywheel-comm/src/__tests__/mailbox-migration.test.ts`（按现有 fixture 定位，若实际 owner 文件名不同则只用现存 owner test） | migration archive snapshot |
| `packages/teamlead/src/bridge/patrol-tick.ts` | torn wall-clock recovery |
| `packages/teamlead/src/__tests__/patrol-tick.test.ts` | current/old slot behavior |
| `packages/teamlead/src/__tests__/patrol-tick-loop.integration.test.ts` | real queue restart regression |
| `scripts/fly-2165-repair-torn-mailbox-identities.mjs` | dry-run/backup/apply/receipt repair CLI |
| `scripts/__tests__/fly-2165-repair-torn-mailbox-identities.test.sh` | repair E2E harness |
| `engineering/doc/milestones/FLY-2165.md` | PR 最后一提交的交付账本 |

计划自审时必须用 `rg --files packages/flywheel-comm/src/__tests__ | rg 'migration'` 确认 migration owner test 的真实文件名；不新造平行 owner。

## Task 1: schema delete guard 与 migration 正门

### RED

- [ ] 在 `mailbox-schema.test.ts` 写四个独立断言：active raw delete 拒绝；仅 stamp 拒绝；
  `{}` fake archived log + stamp 拒绝；matching terminal snapshot + stamp 成功。
- [ ] 运行：

```bash
pnpm --filter flywheel-comm exec vitest run src/__tests__/mailbox-schema.test.ts
```

预期：前三条中的至少 active raw delete 在当前 main 上错误地成功，测试以 contract mismatch FAIL。

### GREEN

- [ ] 在 `MAILBOX_SCHEMA` 的 `mailbox_log` 定义之后创建 `mailbox_delete_requires_archive`：

```sql
CREATE TRIGGER IF NOT EXISTS mailbox_delete_requires_archive
BEFORE DELETE ON mailbox
WHEN NOT EXISTS (
  SELECT 1 FROM mailbox_identity i
   WHERE i.id=OLD.id AND i.delivery_id=OLD.delivery_id
     AND i.archived_at IS NOT NULL
)
OR NOT EXISTS (
  SELECT 1 FROM mailbox_log l
   WHERE l.message_id=OLD.id AND l.event='archived'
     AND json_valid(l.row_json)
     AND json_extract(l.row_json,'$.id')=OLD.id
     AND json_extract(l.row_json,'$.delivery_id')=OLD.delivery_id
     AND json_extract(l.row_json,'$.state')=OLD.state
     AND (
       (OLD.state='ACKED' AND OLD.acked_at IS NOT NULL
         AND json_extract(l.row_json,'$.acked_at')=OLD.acked_at)
       OR
       (OLD.state='DEAD' AND OLD.dead_at IS NOT NULL
         AND json_extract(l.row_json,'$.dead_at')=OLD.dead_at)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'mailbox delete requires terminal archive evidence');
END;
```

- [ ] 把 `mailbox-migration.ts::persistMapped()` 的 `keep=false` branch 改为：

```ts
const outcome = queue.archiveFamily({ id: mapped.input.id, now, retentionMs: 0 });
if (outcome !== "archived") {
  throw new Error(`migration_mailbox_archive_failed:${mapped.input.id}:${outcome}`);
}
```

- [ ] 在现有 migration owner test 断言 `event='archived'` snapshot 可被
  `inspectDeliveryState()` 读为 `archived_terminal`。
- [ ] 重跑 schema + migration focused tests，预期 PASS；再跑
  `packages/flywheel-comm/src/__tests__/fly-2006-mailbox-archive-parity.test.ts`，预期 PASS。
- [ ] commit：`fix(mailbox): enforce terminal archive before delete`。

## Task 2: typed torn settlement 与 CLI

### RED

- [ ] 在 `mailbox-settlement.test.ts` 用 raw `better-sqlite3` fixture 先 `DROP TRIGGER
  mailbox_delete_requires_archive`，enqueue 后 raw delete，保留 active identity/zero log；断言：

```ts
expect(queue.inspectDeliveryState("delivery:torn")).toEqual({
  kind: "torn_identity",
});
```

- [ ] 在 `message-status.test.ts` 造同形数据库，断言 human 输出 `torn <id>`、JSON
  `location:'torn'` 且命令 exit 2。
- [ ] 跑两份 focused test，预期当前实现 throw，RED 原因精确包含
  `active mailbox identity has no row`。

### GREEN

- [ ] `MailboxSettlement` 增加 `{kind:'torn_identity'}`；active identity no row 分支返回它。
- [ ] `MessageStatusView.location` 增加 `torn`，null state/evidence；human renderer 明示 torn；
  `messageStatus()` 对 absent 返回 1、torn 返回 2、可判定 live/archive 返回 0。
- [ ] `rg` sweep 全部 `MailboxSettlement` consumers，逐个确认 torn 不被误当 ACKED/DEAD；只改需要
  exhaustive handling 的 owner，不扩 scope。
- [ ] 重跑 focused tests与 `pnpm --filter flywheel-comm typecheck`，预期 PASS。
- [ ] commit：`fix(mailbox): classify torn active identities`。

## Task 3: patrol cadence 自愈

### RED

- [ ] `patrol-tick.test.ts` 增加 `current slot torn identity does not double mint`：上一 event slot
  等于 current，`inspectDeliveryState -> torn_identity`，断言 append/enqueue 均无新增且 failure rearm。
- [ ] 增加 `old slot torn identity advances with a fresh delivery id`：上一 slot 已旧，断言只 append
  一条 `after-<previous.seq>`，不调用旧 envelope re-enqueue；第二 pass 不再读取 poisoned id。
- [ ] integration test 用 real `MailboxQueue` 建 row，drop trigger 后 raw delete，再跑两次 patrol pass；
  断言新 tick live/queued，loop 没有永久停在旧 delivery id。
- [ ] 跑：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/patrol-tick.test.ts src/__tests__/patrol-tick-loop.integration.test.ts
```

预期：type 尚未处理或 `settlementAnchor` 访问缺失字段而 FAIL。

### GREEN

- [ ] 抽出/前移 previous payload slot parsing；torn current slot 直接 success+continue；torn old slot
  `deps.log` 一条含 project/lead/delivery id 的 recovery 日志后进入 mint branch。
- [ ] 保持 archived/live 的 anchor、60 秒 guard、absent replay 完全不变。
- [ ] focused tests + `pnpm --filter flywheel-teamlead typecheck` PASS。
- [ ] commit：`fix(patrol): advance past torn mailbox identities`。

## Task 4: backup-first 一次性 repair CLI

### RED

- [ ] 新建 Bash harness，在 temp DB 安装 `MAILBOX_SCHEMA` 等价 fixture，再建事故表
  `mailbox_archive AS SELECT * FROM mailbox WHERE 0`，种：ACKED、DEAD、缺 dead_at、content_ref 四类。
- [ ] 断言 dry-run 零写；`--apply` 无 `--backup` exit nonzero；apply 后 backup `quick_check=ok`；
  三类合法 row archived 可读；缺 dead_at 仍 torn；二次 apply repaired=0。
- [ ] 先运行 harness，预期 script 不存在而 RED。

### GREEN

- [ ] 新建 ESM CLI，参数合同：

```text
--db <comm.db> [--apply --backup <new.db>] [--now <UTC ISO>] [--batch-size <1..1000>]
```

- [ ] 用 `createRequire(packages/flywheel-comm/package.json)` 加载 `better-sqlite3`；所有 SQL 参数化。
- [ ] dry-run query 只选 exact torn + preserved archive；按 id 排序计算 SHA-256 source digest。
- [ ] apply 前拒绝 symlink/existing backup，`await db.backup()` 后用 readonly handle 验
  `quick_check='ok'` 并算 backup SHA-256。
- [ ] 每 batch immediate transaction：canonical snapshot + `lead_repair`；content_ref 可读才修并写
  `content_ref_gc_outbox`；insert archived log 后 identity CAS，任一步 changes/compare 不符即 rollback。
- [ ] stdout 只输出一份 JSON receipt：`mode/candidates/repairable/repaired/unrepairable/
  remainingTorn/sourceDigest/backup`。
- [ ] harness PASS；`node ... --db <fixture>` dry-run JSON 可重复、digest byte-stable。
- [ ] commit：`fix(mailbox): add torn identity repair tool`。

## Task 5: refactor、全量验证、review 与 PR

- [ ] 全部 focused tests 再跑一遍；如有重复 fixture，只在 GREEN 后抽 helper，并重跑保持绿。
- [ ] `git diff --check` 与 scoped `rg` 审计：所有 production `DELETE FROM mailbox` 都受 trigger，
  所有 `MailboxSettlement` consumer 已审。
- [ ] 更新 progress ledger 至 implement 完成；查 Lead inbox。
- [ ] fresh full gates（不得用旧输出代替）：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/fly-2165-repair-torn-mailbox-identities.test.sh
```

- [ ] 注册 code review gate + `request-review --type code`，按 structured verdict 修所有 blocking
  finding；每轮新 questionId，直到 `reviewVerdict=APPROVED`。
- [ ] review APPROVED 后，按 `engineering/doc/milestones/README.md` 新建
  `engineering/doc/milestones/FLY-2165.md`，与 doc-flow final state 同一最后 commit；不改 `CLAUDE.md`。
- [ ] 在未 push 前对 milestone last commit 再做 exact-head code review；若需修，amend 尚未 push 的
  last commit并重审，直到 latest exact head APPROVED。
- [ ] 再查 inbox，push feature branch，`gh pr create --base main`；核 exact-head CI，不 merge、不请求 ship。
- [ ] requirement-by-requirement completion audit 后报告 Tadashi，运行：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete --route needs_review --pr <NUMBER>
```

## 自审结果

- spec coverage：root prevention、typed degradation、patrol self-heal、historical repair、full gates、review/PR
  均有独立 task；
- placeholder scan：未发现占位词或跨 task 的省略引用；每个 code change 有 exact path、RED、GREEN、命令与预期；
- type consistency：统一使用 `kind:'torn_identity'`、CLI `location:'torn'`、repair receipt
  `unrepairable_missing_terminal_at`；
- scope：不把 `mailbox_archive` 升格为常驻协议，不触碰 alert ack≠fix 另案，不执行生产 repair/部署。
