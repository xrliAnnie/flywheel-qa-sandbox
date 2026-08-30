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
| `packages/flywheel-comm/src/mailbox-queue.ts` | typed `torn_identity` / `archived_nonterminal` + latest archive snapshot ordering |
| `packages/flywheel-comm/src/mailbox-migration.ts` | family 全部 materialize 后统一走 `archiveFamily()` |
| `packages/flywheel-comm/src/commands/message-status.ts` | torn 的 CLI view/exit |
| `packages/flywheel-comm/src/__tests__/mailbox-schema.test.ts` | raw-delete negative/positive contract |
| `packages/flywheel-comm/src/__tests__/mailbox-settlement.test.ts` | torn reader regression |
| `packages/flywheel-comm/src/commands/__tests__/message-status.test.ts` | human/JSON torn output |
| `packages/flywheel-comm/src/__tests__/mailbox-migration.test.ts`（按现有 fixture 定位，若实际 owner 文件名不同则只用现存 owner test） | migration archive snapshot |
| `packages/flywheel-comm/src/__tests__/receipt-teardown-closeout.test.ts` | nonterminal external closeout compatibility |
| `packages/teamlead/src/bridge/patrol-tick.ts` | torn wall-clock recovery |
| `packages/teamlead/src/__tests__/patrol-tick.test.ts` | current/old slot behavior |
| `packages/teamlead/src/__tests__/patrol-tick-loop.integration.test.ts` | real queue restart regression |
| `scripts/fly-2165-repair-torn-mailbox-identities.mjs` | dry-run/backup/apply/receipt repair CLI |
| `scripts/__tests__/fly-2165-repair-torn-mailbox-identities.test.sh` | repair E2E harness |
| `.github/workflows/ci.yml` | 在 always-on shell lane 显式运行 repair harness |
| `engineering/doc/milestones/FLY-2165.md` | PR 最后一提交的交付账本 |

计划自审时必须用 `rg --files packages/flywheel-comm/src/__tests__ | rg 'migration'` 确认 migration owner test 的真实文件名；不新造平行 owner。

## Task 1: schema delete guard 与 migration 正门

### RED

- [ ] 在 `mailbox-schema.test.ts` 写五个独立断言：active raw delete 拒绝；仅 stamp 拒绝；
  `{}` fake archived log + stamp 拒绝；matching terminal snapshot + stamp 成功；matching QUEUED
  snapshot + stamp 也成功，保护 FLY-1645 closeout。
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
     AND l.log_seq=(
       SELECT newest.log_seq FROM mailbox_log newest
        WHERE newest.message_id=OLD.id AND newest.event='archived'
        ORDER BY newest.at DESC, newest.log_seq DESC LIMIT 1
     )
     AND json_valid(l.row_json)
     AND json_extract(l.row_json,'$.id')=OLD.id
     AND json_extract(l.row_json,'$.delivery_id')=OLD.delivery_id
     AND json_extract(l.row_json,'$.state')=OLD.state
     AND (OLD.state!='ACKED' OR json_extract(l.row_json,'$.acked_at') IS OLD.acked_at)
     AND (OLD.state!='DEAD' OR json_extract(l.row_json,'$.dead_at') IS OLD.dead_at)
)
BEGIN
  SELECT RAISE(ABORT, 'mailbox delete requires matching archive evidence');
END;
```

- [ ] `persistMapped()` 只 materialize member + coverage log，不再逐 member delete。每个 family 全部
  `persistMapped()` 完成后，若 `keep=false`，只对 root 调一次：

```ts
const outcome = queue.archiveFamily({
  id: family[0].input.id,
  now,
  retentionMs: 0,
  maxFamilyBytes: Number.MAX_SAFE_INTEGER,
});
if (outcome !== "archived") {
  throw new Error(
    `migration_mailbox_archive_failed:${family[0].input.id}:${outcome}`,
  );
}
```

- [ ] standalone `lead_inbox` mapped row 也走同一个 `persist family → archive once` helper。`keep=false`
  前先按 `familyRootId/loadFamily` 等价 SQL 解出 DB family，并断言 sorted IDs 与本轮 mapped family
  完全相同；不相同则保留 live row 并记录 coverage，不允许把更宽 family 误送 `archiveFamily()`。
  `receipt_resend` 的 free-form `type='question'` 且未 answered/terminal-disposed 时同样保留；
  invalid content_ref 仍 fail-closed，因为无法生成合同要求的 full snapshot；
  `Number.MAX_SAFE_INTEGER` 只移除旧 migration 没有的 2 MiB 行为变化。
- [ ] 在现有 migration owner test 断言 `event='archived'` snapshot 可被
  `inspectDeliveryState()` 读为 `archived_terminal`。
- [ ] `inspectDeliveryState()` 与 `getIdentityCarrier()` 的 archived query 都改为
  `ORDER BY at DESC, log_seq DESC LIMIT 1`；schema test 另造 newer malformed/nonmatching snapshot，
  断言 trigger 不会借 older good snapshot 放行。
- [ ] 重跑 schema + migration focused tests，预期 PASS；再跑 closeout +
  `packages/flywheel-comm/src/__tests__/fly-2006-mailbox-archive-parity.test.ts`，预期 PASS。
- [ ] commit：`fix(mailbox): enforce matching archive before delete`。

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
  `location:'torn'` 且命令 exit 3；另断言坏参数/坏 DB 仍是 2，证明两个状态可区分。
- [ ] 跑两份 focused test，预期当前实现 throw，RED 原因精确包含
  `active mailbox identity has no row`。

### GREEN

- [ ] `MailboxSettlement` 增加 `{kind:'torn_identity'}`；active identity no row 分支返回它。
- [ ] archived snapshot 为 QUEUED/LEASED 时返回
  `{kind:'archived_nonterminal',state,settledAt:null,...evidence}`，不再硬抛；malformed JSON、identity 无
  snapshot、ACKED/DEAD 缺 terminal timestamp 仍 fail-closed。consumer sweep 对该态不误判 terminal。
- [ ] `MessageStatusView.location` 增加 `torn`，null state/evidence；human renderer 明示 torn；
  nonterminal archive 仍显示 `location:'archived'`；`messageStatus()` 对 absent 返回 1、usage/runtime error
  返回 2、torn 返回 3、可判定 live/archive 返回 0。
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
- [ ] 加 schema-negative fixtures：archive 缺列、额外列、或 column SQLite affinity 不同，dry-run/apply
  均在 backup/write 前 fail-closed；positive fixture 的 ordered columns + normalized affinities 完全相同。
- [ ] 加 crash/resume seam：一个 batch transaction 在 log insert 后 fault，断言 whole batch rollback；已提交
  batch 重跑时不再入 candidate，`fly2165:archived:<id>` 不冲突。
- [ ] 先运行 harness，预期 script 不存在而 RED。

### GREEN

- [ ] 新建 ESM CLI，参数合同：

```text
--db <comm.db> [--apply --backup <new.db>] [--now <UTC ISO>] [--batch-size <1..1000>]
```

- [ ] 用 `createRequire(packages/flywheel-comm/package.json)` 加载 `better-sqlite3`；所有 SQL 参数化。
- [ ] 读取 `PRAGMA table_info(mailbox|mailbox_archive)`；只比较 ordered name + SQLite affinity，明确忽略
  CTAS 不保留的 `notnull/default/pk`。affinity 按 SQLite 规则归一：type 含 `INT` → INTEGER；含
  `CHAR|CLOB|TEXT` → TEXT；含 `BLOB` 或空 → BLOB；含 `REAL|FLOA|DOUB` → REAL；其余 →
  NUMERIC。normalized pair 必须 byte-equal，missing/extra/affinity drift 全拒；receipt 记录两边 schema
  digest；positive harness 固定覆盖 mailbox `INTEGER` 对 archive CTAS `INT`。
- [ ] dry-run query 只选 exact torn + preserved archive；按 id 排序计算 SHA-256 source digest。
- [ ] dry-run 同时算 canonical `rowJsonBytes`、可读 content-ref bytes 和预计 log/index 下界；当前生产
  原始行基线为 63,911 行、row_json **148.27 MiB**、6 个 content refs；实现后 live dry-run（同日）
  含 `lead_repair` provenance 的 `rowJsonBytes=166,108,466`（**158.42 MiB**）、
  `estimatedGrowthBytes=198,830,898`。receipt 记录主 DB/WAL 的 before bytes；apply 前要求可用空间至少
  `backup bytes + 3 * estimatedGrowthBytes`。
- [ ] apply 前拒绝 symlink/existing backup，`await db.backup()` 后用 readonly handle 验
  `quick_check='ok'` 并算 backup SHA-256。
- [ ] 每 batch immediate transaction：canonical snapshot + `lead_repair`；content_ref 可读才修并写
  `content_ref_gc_outbox`；用普通 INSERT 写唯一 `event_id='fly2165:archived:<id>'` 后 identity CAS，
  任一步 changes/compare 不符即 rollback。candidate 要求 zero log，所以 event collision 一律 fail-closed，
  不用 `INSERT OR IGNORE` 掩盖历史差异。
- [ ] stdout 只输出一份 JSON receipt：`mode/candidates/repairable/repaired/unrepairable/
  remainingTorn/sourceDigest/schemaDigests/sizeEstimate/beforeAfterBytes/backup`。
- [ ] apply batches 后执行 passive WAL checkpoint 并把 `{busy,log,checkpointed}` 写 receipt；不在 repair
  内 VACUUM。若需要 reclaim，交既有 stopped-service `scripts/db-maintenance.sh` 窗口处理。
- [ ] harness PASS；`node ... --db <fixture>` dry-run JSON 可重复、digest byte-stable。
- [ ] `.github/workflows/ci.yml` 的 always-on `quick-gate` 在 **Install dependencies 之后**加 literal
  `bash scripts/__tests__/fly-2165-repair-torn-mailbox-identities.test.sh`（CLI 需要
  `better-sqlite3`）；运行 enumeration guard。
- [ ] commit：`fix(mailbox): add torn identity repair tool`。

## Rollout / rollback（合并与部署仍解耦）

- 正常顺序：PR merge 后等 updater 窗口部署同一 build（migration family fix + trigger 原子同版）；
  后续 stopped-service maintenance window 先 dry-run → 自动 backup → apply repair → checkpoint →
  仍由 updater 启动新 build。Runner 不执行这些生产动作，也不请求 emergency restart。
- trigger 安装后即持久留在 DB。若必须回滚到 pre-FLY-2165 build，服务保持停止，先对每个 comm.db
  执行 `DROP TRIGGER IF EXISTS mailbox_delete_requires_archive;`，记录 DB backup/quick_check，再启动旧版；
  不允许旧 build 直接碰带新 trigger 的 DB。
- repair 写入的 `mailbox_log` 与 identity stamp 是真实历史证据，不随代码 rollback 撤销；
  `mailbox_archive` 保留。rollback 只移除 writer guard，不反修已补的归档章。

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
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
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

## Design Review R1 逐项处置

| findingKey | 处置 |
|---|---|
| `trigger-requires-terminal-state-breaks-closeout` | trigger 改验 matching snapshot；nonterminal state 合法，terminal timestamp 只在对应 state 核对 |
| `migration-archivefamily-not-due-hard-abort` | family 全部入 DB 后只 archive root 一次；解除 2 MiB cap，不逐 member archive |
| `new-shell-suite-not-classified-in-ci` | `.github/workflows/ci.yml` always-on lane literal 枚举 |
| `message-status-torn-exit-code-collides-with-error` | torn 专用 exit 3；2 保留 usage/runtime error |
| `no-trigger-rollback-or-deploy-ordering` | 增加 deploy/repair 顺序与 stopped-service DROP trigger rollback |
| `repair-source-schema-parity-unverified` | ordered columns + normalized affinity 双 digest fail-close |
| `repair-archived-log-event-id-unspecified` | 固定普通 INSERT `fly2165:archived:<id>`，batch transaction 原子 |
| `trigger-accepts-any-archived-log-reader-reads-latest` | trigger 与两个 reader 都统一 `at DESC, log_seq DESC` newest authority |
| `repair-db-growth-unbudgeted` | 148.27 MiB payload 基线、free-space gate、before/after bytes、checkpoint tuple |

## Design Review R3 advisories 逐项采纳

| findingKey | 采纳 |
|---|---|
| `migration-family-invariant-asserted-in-prose-only` | archive 前用 DB-resolved family IDs 对比 mapped IDs；更宽或 unanswered free-form question family 保留，不硬删/硬抛 |
| `repair-affinity-normalizer-underspecified` | 固定 SQLite 五类 affinity 算法，仅比较 ordered name+affinity；positive fixture 固定 INT/INTEGER CTAS 差异 |
| `nonterminal-archive-legal-but-reader-fatal` | 增 typed `archived_nonterminal`，保持 malformed/missing/terminal-timestamp corruption fail-closed |
| `ci-step-placement-vs-pnpm-install` | repair harness 固定置于 quick-gate Install dependencies 之后 |

## Code Review R1 逐项处置

| findingKey | 处置 |
|---|---|
| `repair-archived-log-subject-id-not-family-root`（HIGH） | RED harness 复现 question 已提交/response rollback 的半 family；repair 从 preserved `mailbox_archive` 解 root、整 family 同 transaction，并把所有 member 的 `subject_id` 写 root；fault + resume 断言 `q1/r1 → subject_id=q1` |
| `repair-free-space-gate-measures-wrong-filesystem` | backup mount 与 DB mount 分别量空间；同 device 合并要求 `backup + 3×growth`，异 device 分别验 backup bytes 与 DB growth |
| `repair-unbounded-working-set-two-full-candidate-copies` | candidate 用 `.iterate()`，不再 materialize `rows`；backup 后只保留 digest/count/size summary，再开 write handle，消除 initial/current 两份全量 row object 同驻内存 |
| `patrol-archived-nonterminal-still-permanent-throw` | 与 torn 同样按 wall-clock slot：current slot 不 double-mint，old slot 记 recovery log 后 mint fresh delivery id；新增 RED→GREEN owner test |
| `repair-cli-contract-drift-from-approved-plan` | 实装 canonical UTC `--now`，`--batch-size` 上限收紧到 1000；harness 固定 timestamp 与 1001 rejection |
| `repair-test-fault-seam-shipped-unguarded` | `--test-fault-after-log-id` 仅 `NODE_ENV=test` 接受；普通 operator invocation fail-closed |
| `migration-invalid-content-ref-now-aborts-whole-migration` | 保持 design-approved fail-closed：缺失 external bytes 时不能伪造 full snapshot；不在本 issue 改写 migration coverage 语义 |
| `migration-family-id-sort-collation-mismatch` | UUID-shaped production IDs 下无现时 correctness 影响；safe keep/fail-close 方向，留 follow-up |
| `trigger-json-extract-reparses-snapshot-five-times-per-delete` | correctness 已满足；JSON parse 性能优化不与本次事故修复混做，留 follow-up benchmark |

## Code Review R2 逐项处置

| findingKey | 处置 |
|---|---|
| `repair-family-root-ignores-live-mailbox-question`（HIGH） | 新增真实事故形状：`q1` QUEUED 且仍 live、`r1` ACKED 且 torn；RED 得到 `r1→r1`，GREEN 从 archived + live question ID union 解 root，断言 `r1→q1` 且 live question byte/state 不变 |
| `repair-family-root-question-lookup-full-scan-per-response` | 不再对无 index 的 `mailbox_archive` 每 response `.get()`；analyze 开头各扫描 archived/live question IDs 一次组成 Set，candidate loop 为 O(1) lookup |
| `repair-unbounded-working-set-two-full-candidate-copies` | 已消除双份全量 copy；remaining one-copy family grouping 是 family atomicity 的必要 working set，production 63,914-row dry-run 已验证可承受，留 root-ordered streaming follow-up |
| 其余 carried advisories | 沿用 R1 明示 disposition；均为 structured non-blocking advisory，不改变本轮 HIGH 修复边界 |

## QA 证据

- focused：`flywheel-comm` 6 files / 91 tests PASS；`teamlead` patrol 2 files / 34 tests PASS；
  feature-flag drift 13/13 PASS；repair Bash harness PASS；CI enumeration PASS。
- full lint/build：`pnpm lint` exit 0（仅 repo baseline warnings）；`pnpm -r build` 22/23 workspace
  projects PASS。
- `pnpm test:packages:run` 在本机 default parallelism 三轮均被 Vitest worker starvation 终止；失败均为本
  issue 外的 real tmux/timeout case，逐项 isolated control 全部 PASS。将最重的 `teamlead` 全包限制到 2 workers 后
  741/741 files、9,763 tests PASS（6 intentional skips）。PR exact-head CI 仍是最终 full-repo authority。
- production dry-run（只读、未 apply）：63,914 candidates、63,911 repairable、3 missing terminal、
  `familyBlocked=0`；source digest 仍为
  `71880e4c205d493ba36b89654e23e4a6cc1e197d965c3f56e662920c06e570aa`。

## 自审结果

- spec coverage：root prevention、typed degradation、patrol self-heal、historical repair、full gates、review/PR
  均有独立 task；
- placeholder scan：未发现占位词或跨 task 的省略引用；每个 code change 有 exact path、RED、GREEN、命令与预期；
- type consistency：统一使用 `kind:'torn_identity'`、CLI `location:'torn'`、repair receipt
  `unrepairable_missing_terminal_at`；
- scope：不把 `mailbox_archive` 升格为常驻协议，不触碰 alert ack≠fix 另案，不执行生产 repair/部署。
