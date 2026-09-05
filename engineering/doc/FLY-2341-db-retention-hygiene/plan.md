# FLY-2341 终态数据库冷热分层 — 实施计划
Issue: FLY-2341 (https://linear.app/geoforge3d/issue/FLY-2341/引擎db-卫生-数据库无保留策略终态行只增不减teamleaddb-598mb-commdb-639mb让维护扫描随历史线性变慢)
日期: 2026-09-04
基于: research.md

## 目标与非目标

目标是把固定七天窗外、已证明不再承担 current authority 的终态行从 hot 表搬进同库 cold table，
让 runtime 每次只做有界、命中时间索引的工作，并提供显式 inventory/archive/restore/vacuum operator
路径。实现不得改变 FLY-2339 的 projector/watch/operations 算法或 EventLoopGuard 阈值。

不做 sharding、Postgres adapter、retention/batch 配置旋钮、第二套 timer、后台 VACUUM，也不在
implementation 节点修改生产库。只提供 project-scoped、default-on 的 `database_archive` archive-only
kill switch。未来云端切分依赖本单稳定写下的 `source_created_at` / `terminal_at` 日期边界。

## 1. RED：先锁住 TeamLead 归档合同

新增 `packages/teamlead/src/__tests__/StateStore.fly2341-terminal-archive.test.ts`，先证明当前实现缺少：

1. migration 创建单一 `workflow_terminal_archive`、immutable triggers 和所需 eligibility indexes；
2. batch 只归档固定七天窗外、终态且在修正后 allowlist 内的行；`external_merge_suspect` durable claim、
   active/held、recent、current lineage、非白名单、仍有 child reference 的行保持 hot；
3. 一次最多 N 行，稳定时间+identity 排序，第二次执行幂等；existing cold key digest 不同 fail-close；
4. archive insert 与 source delete 同 transaction，故意触发 cold 写冲突时 source row 不丢；
5. source candidate 的 `EXPLAIN QUERY PLAN` 命中 named expression index；SQLite 时间统一通过
   `julianday()` 且显式要求 `IS NOT NULL`，invalid time/payload 留 hot；至少一条 eligibility 用
   `StateStore.create()` 生成的 production schema 执行，不只依赖手写 fixture；
6. restore 逐字段复制回 source，cold evidence 保留；hot 冲突拒绝覆盖。

先运行单文件、单 fork，确认因 API/schema 不存在而红；再写最小实现。

## 2. GREEN：TeamLead 最小实现与 maintenance wiring

- 新增 `packages/teamlead/src/terminal-row-archive.ts`：一个固定
  `TERMINAL_ROW_RETENTION_MS=7d`、schema installer、一个 `archiveTerminalRows(db,{now,limit})` 和一个
  `restoreTerminalRow(db,key)`。使用 Node stdlib `crypto` 和已安装 `better-sqlite3`，不加依赖。
- eligibility policy 复用并修正 FLY-2006 的 table/event allowlist；active snapshot 合并 TeamLead live
  sessions、active/held workflow runs/nodes、CommDB running sessions，并用 payload `json_tree` 精确 scalar
  guard。每个 candidate query 都有 cutoff、稳定排序和 `LIMIT`，总 batch hard cap 100。按表顺序消费
  剩余 budget，不做 OFFSET 或预先 COUNT 全表。
- `StateStore` migration 安装 schema；只暴露薄方法调用上述函数，不在 6 万行 class 内复制 SQL。
- 在 `HeartbeatService` 已有 detached single-flight callback 内，先从每个 CommDB 取得 running session
  lineage；任一 snapshot 失败则本 tick fail-close。三个 delivery-contract pass 完成并 yield 后调用一次
  `store.archiveTerminalRows({now,limit:100,...activeIds})`；捕获 busy/异常并延后下 tick，不影响 heartbeat。
- `database_archive` project flag 关闭或读取失败时跳过新归档；共享 TeamLeadDB 只在所有项目均开启时
  运行，任一项目 opt-out 即全局 fail-close；不提供 retention/batch 调参。schema migration 安装的
  evidence-gated delete triggers 不随 flag 回退：flag 只停新写入，已有 cold row 仍是删除所需的逐字段等值证据。
- production 历史 `workflow_run_event_no_delete` 从 unconditional abort 改为只在同一 transaction 已有
  immutable cold row、identity/time 与全部源字段等值时放行；无证据的原始 DELETE 仍失败。
- 每页 deadline 在 candidate SELECT 前启动；candidate query 固定为每页最多 64 行的时间+identity
  keyset，并强制使用能直接满足排序的 allowlist partial index，禁止 temp B-tree。进程内环形 cursor 跨 tick
  保存并严格前进，避免反复扫过同一批不 eligible 的旧行。SQLite 同步 SELECT/单行 transaction 是不可抢占
  原子单位；每页的 SELECT + 完整归档共享 25ms deadline，每次调用还固定最多 2 页并预留在 50ms 总预算内，
  完整消费已付费的当前页后若超预算即停止到下一 tick。总 batch 仍硬封顶 100 rows；production wiring 每
  tick 只处理一个 source table，用轮转避免饥饿，因此不会在同一 callback 连续跑三张表。
- 增加 wiring 测试，证明没有新增 `setInterval`、没有 `VACUUM`、调用位于 delivery pass 之后且每 tick
  至多一次。

实现后只跑上述 TeamLead 测试单文件单 fork，绿后再做机械去重。

## 3. RED：锁住 Comm cold archive 与 exact fallback

新增 `mailbox-terminal-archive.fly2341.test.ts`，并扩展 `mailbox-queue.test.ts`、
`mailbox-queue-schema.test.ts`、settlement/status 与 TeamLead runtime 测试：

1. mailbox family 默认 retention 保持 72 小时；identity/log cold compaction 固定七天；runtime 不读取
   retention 配置；
2. ACKED/DEAD whole family archive 后，mailbox/identity/log 离开 hot，cold row 保存 identity、mailbox、
   原 logs 和 FLY-1572 archived proof；partial family 或 recent row 不动；
3. naked identity/log DELETE 失败；cold evidence 不匹配时同 transaction 回滚；cold row UPDATE/DELETE
   失败；
4. `enqueue`、Discord lane、settlement/status、carrier 和 `archiveFamily` 幂等路径在 hot miss 后按 exact
   id/delivery_id 回查 cold，结果与 compact 前一致；
5. legacy archived identity 有 canonical mailbox snapshot 时完整迁移；identity-only 时 mailbox JSON 仍
   为 NULL，status 不伪造 terminal；
6. hot-history compaction 每次最多 25 identities，按 `terminal_at,id` partial index；`mailbox_log` 的
   `(message_id,event)` anti-join 保护 progress receipts；
7. restore 将 cold payload 逐字段复制回 hot，保留 cold evidence，重复恢复幂等；恢复后重新 family archive
   复用原 cold proof/archived log，再 compaction 不改 immutable cold row，也不阻塞同批其他 identity；冲突按
   identity 隔离并显式报警；
8. founder-review `subject_id` family 始终合并 hot ∪ cold，并按消息 id 去重、原 `seq` 稳定排序；question 或
   response 任一侧先进入 cold 时都返回完整 family；
9. event-id progress receipt 及所属 identity/log 保持 hot；两张 cold authority table 必须登记进 FLY-2006
   schema classification，不能成为未分类删除目标。

逐个单文件、单 fork确认 RED，避免一次并行启动多个 Vitest 包。

## 4. GREEN：Comm 最小实现

- 在 `mailbox-schema.ts` 新增一个 `mailbox_terminal_archive`，id primary key、delivery_id unique、
  terminal/archived date columns、identity/mailbox/log/proof JSON 和 digest；加 time index及 immutable triggers。
- 把 `mailbox_identity_no_delete` / `mailbox_log_no_delete` 改成 cold-evidence gated delete；现有
  `mailbox_delete_requires_archive` 原样保留，FLY-1572 的 mailbox delete 顺序不降级。与 TeamLead 一样，
  `database_archive` 关闭只停 compactor，不卸载已迁移的 evidence-gated triggers。
- `MailboxQueue` 内增加一个 private exact identity lookup（hot-first/cold-second）、一个 indexed
  subject-family hot ∪ cold reader（id 去重、`seq` 排序）和两个 bounded 方法。现有 `archiveDueFamilies` 先按 FLY-1572 协议把新 terminal
  family 从 mailbox 搬为 archived identity/log；后续 `compactArchivedIdentities` 把七天窗外的 archived
  identity/log 封成 cold row。公共 reader 只接 exact/subject 两个已有查询形状，不建 repository/interface。
- compactor 对每个 identity 用独立 immediate transaction 先写/核对 cold payload，再经 cold-evidence
  triggers 删除 hot logs/identity；单行冲突回滚该行并报警，其余 batch 继续。restore 恢复原 archived log，
  再归档复用 immutable cold 的 `archived_at`/payload，故合法回滚不会制造新 digest。legacy compactor 只打包
  现有值，不造 mailbox；progress receipt identity 不参与 compaction。
- `lead-inbox-runtime` 在既有每分钟 archive block 中紧接着调用
  `compactArchivedIdentities({now,limit:25})`，没有第二 timer；`database_archive` 只跳过该项目的新
  compactor。同步 loop 同时受 25 identities 与 25ms hard budget 限制；ready 与 legacy 两条候选 lane
  都保存环形 keyset cursor，cursor 在单 identity transaction 前推进，因此持续失败的整批身份会留账但
  不会永久挡住后面的健康身份。
- 无参 mailbox family archive 与 cleanup floor 原样保持 72 小时；cold compaction 窗口固定七天，不新增
  operator knob。

每完成一个行为只跑对应 Comm 测试文件、单 fork，全部绿色后跑这三份 affected files 一次。

## 5. Operator 命令与恢复演练

新增一个 `scripts/fly-2341-db-hygiene.mjs`，复用上面两个 package API，不另写 SQL engine：

- `inventory --teamlead-db <path> --comm-db <path>`：只读输出 JSON；
- `archive ... --now <iso>`：固定 runtime batch size 循环，batch 间 `setImmediate` yield；
- `restore --db-kind teamlead|comm --key <exact>`：只恢复一个 exact cold row；
- `vacuum --db <path>`：单独显式动作，拒绝 implicit default path。

脚本不接 retention/batch-size flag，不自动发现 `~/.flywheel`，避免误操作生产。通过 TeamLead Vitest
直接导入 exports 测参数拒绝、inventory、archive 幂等、restore 和 vacuum 分离，不新增 shell test。
每轮重新读取 Comm running lineage；单 identity 错误去重报告且不阻塞旁路行。该测试复用 gitignored
package `dist/`，单文件本地运行前需先 build Comm 与 TeamLead；正式 gate 本就按 build→tests 顺序执行。

## 6. 529 隔离 rehearsal 与数字

1. 用 online backup/copy 生成隔离 TeamLead/Comm 工作副本并记录 source digest；绝不打开生产路径写入；
2. 在 archive 前对两库 inventory，并在同一输入上分别执行 projector/watch/operations 多轮计时；
3. 跑 bounded archive 到 drained，记录 batch 数、每批 max rows、busy/error、表行数；第二次运行应为 0；
4. 显式 VACUUM，记录 hot/cold/总行数、bytes/page_count/freelist_count 和三段 pass 后测；same-file cold
   archive 只承诺 hot-path 收缩，不预设总 bytes 必降；
5. exact restore：TeamLead 每个实际归档 source table 一行、Comm 一个有 mailbox snapshot 的完整 family
   加一个 identity-only row；比较 row JSON/digest 后重新归档、再 compact，并证明旁路 identity 同批继续；
6. 记录最大 batch wall time、worst-case mostly-protected fixture 的候选检查量/query plan、总候选 drain
   速率，并与快照 backlog/`fly-2139-retention-rates.mjs` 近期增长率比较；max batch wall time 必须覆盖完整
   candidate SELECT（不只 row loop），cold 行增长按实测平均 row bytes 外推一年；100 rows/5min 的总上限是
   28,800 rows/day，三表轮转时单表上限 9,600/day，按现有约 100k 最大单表 backlog 的 runtime-only
   最坏 drain horizon 约 10.5 天；一次性 operator rehearsal 以 batch 间 yield 加速初始 debt；
7. 结果写入同文件夹 `rehearsal.md` 和 `rehearsal-results.json`，明确 production 两小时观察仍待 rollout。

若 snapshot 数据没有七天前的 Comm live terminal row，则历史 archived identity/log compaction 仍按快照
实测；新 family 路径用 snapshot copy 内的 transaction fixture 演练，不伪造生产计数。

## 已知限制与后续

Code review R8 的其余非阻塞 finding 不在本 implementation 扩围：

- MEDIUM `partial-family-restore-poisons-sweep`：只恢复 response、question 仍在 cold 时，现有 hot-only
  `familyRootId` 会令下一次 family sweep fail-close；operator rollout 必须按完整 family 恢复，后续单独补
  cold root fallback。
- MEDIUM `identity-permanence-no-longer-db-enforced`：当前所有写路径均经 hot-then-cold exact lookup 抑制 replay，
  但 cold identity 尚无 `BEFORE INSERT mailbox_identity` DB trigger；后续恢复 schema-level enforcement。
- LOW `plan-guard-covers-only-cursored-page`：query-plan 回归仍只逐一断言 cursored candidate page；未游标页
  由同一生成 SQL 与集成测试间接覆盖，后续可补独立计划断言。
- LOW `index-build-blocks-bridge-boot`：首次迁移会同步创建并校验 7 个关键归档索引，其中 4 个是
  `json_extract` expression index；该成本发生在 `StateStore.runMigrations` 启动 preflight，不在首个
  maintenance tick。现有 1.28–2.94s 演练只覆盖原 3 个 keyset index，是新启动成本的下界。
- LOW `utc-iso-pattern-widened-globally`：live enqueue 的 UTC validator 因历史 6 位小数被一并放宽。
- LOW `operator-script-no-busy-timeout`：operator 尚无 `busy_timeout`，inventory 固定执行 `quick_check`。
- LOW `archived-family-sort-nan-and-repeat-parse`（R8 名称 `archived-family-sort-by-parsed-seq`）：cold
  family 的 `seq` 排序没有 NaN fallback，且 comparator 重复 parse；后续应 parse 一次并对非有限 seq
  fail-close。
- LOW `identity-delete-evidence-omits-terminal-at`：`mailbox_identity_no_delete` 的 cold evidence 比对尚未包含
  `terminal_at`。
- LOW `settlement-missing-snapshot-throw-downgraded-to-torn`：legacy identity-only cold row 与真正 torn write
  都映射为 `torn_identity`；现有 patrol 只查询近期 delivery id，不会触达七天 cold row，后续拆分独立状态以
  恢复可观测性。
- LOW `page-deadline-evaluated-before-the-candidate-select`：25ms deadline 按 R2 设计在 candidate SELECT 前
  启动；SQLite 同步 SELECT 不可抢占，所以它是入页/页后停止条件，不是 query interrupt。partial keyset index
  给出有界尾延迟，冷 cache 实测 57.4ms 的单页超限已如实记录，不在本轮另造线程或中断抽象。

R8 的 HIGH `workflow-run-event-replay-guard-missing` 与两条要求收口的 MEDIUM 已在 implementation 修复：
archived writer 使用 cold exact lookup；keyset/cold lookup index 由单一 spec 生成并在启动时修复、复核定义
漂移；archive call 同时受 25ms/page、2 pages/call 和 50ms/call 约束。

R9 的 HIGH 与三条 retention correctness advisory 已做类级扫除：

| production 写点 | 归档后的处理或天然边界 |
| --- | --- |
| `migrateFly1427TerminalStatusCorrections` | 只写不在 archive allowlist 的 `state_correction`，永远留 hot。 |
| `insertEvent` | cold exact `event_id` 先查，hot `UNIQUE(event_id)` 后守。 |
| `registerChatThreadConditional` / `upsertChatThread` | `chat_threads` 不搬进 FLY-2341 cold table；`archived_at` 是原表逻辑状态，不存在 hot/cold 唯一约束断裂。 |
| `commitThreadArchive` | transaction 内先查 hot+cold `event_id`；重复 archive audit 在更新 epoch/receipt 前失败。 |
| `appendLeadEvent` | cold `(lead_id,event_id)` 先查并返回原 seq，hot UNIQUE 后守；`appendAndClaimDetectionEscalation` 已删除重复 INSERT 并统一调用它。 |
| `expireDispositionReceiptWithAudit` | 只写不在 allowlist 的 `disposition_receipt_expired`，且 receipt 状态转换给出 transaction 幂等 fence。 |
| `insertAuditEventRaw` | 任意 audit 写入前先查 cold `event_id`，再由 hot `INSERT OR IGNORE` 去重。 |
| `recordEnrolledTerminalSignal` | hot-first/cold-second 读取完整原 row，并沿用同一 payload/source/execution 冲突判断；cold replay 不再写 session projection。 |
| `appendWorkflowRunEventTx` | 所有 caller 统一获得 hot+cold `event_uid` 去重；新 seq 取 hot max 与 indexed cold max 的较大值再加一，restore 不再碰撞。 |

repo-wide production grep 的其他命中仅为 QA fixture/规则文档；`phase_chat_threads` 没有 runtime INSERT。
R9 RED→GREEN 覆盖 cold terminal replay + fresh 对照、direct thread archive replay、direct lead append dedup，
以及“归档→新事件→restore”逐行往返。

## 7. 验证、审查与交付顺序

1. Focused TDD gates（每次单 package / 单 fork）；
2. `pnpm lint`；
3. `pnpm -r build`；
4. 按 Lead R8/R9 裁定，只跑 affected package、单 fork Vitest；全仓矩阵以推送后 PR CI 为准；
5. 若出现任何新 `scripts/__tests__/*.test.sh` 则逐一执行（计划不新增）；
6. 通过 `codex:rescue` 运行 code review，注册 `review_code` gate；blocking finding 修复后推新 head 并重新
   发起一轮；
7. 早开 draft PR，审查期间冻结 head；把 rehearsal 数字、风险、生产 rollout/两小时观测清单写入 PR；
8. `engineering/doc/milestones/FLY-2341.md` 作为 literal last commit，推送后走 implement
   `needs_review` completion route，不发 QA、不申请 ship、不合并。

## 提交切片

1. `docs(FLY-2341): design bounded database hygiene`；
2. `test(FLY-2341): specify TeamLead terminal archiving`（RED）；
3. `feat(FLY-2341): archive bounded TeamLead terminal rows`（GREEN）；
4. `test(FLY-2341): specify Comm cold archive`（RED）；
5. `feat(FLY-2341): compact terminal mailbox history`（GREEN）；
6. `feat(FLY-2341): add reversible hygiene operator`；
7. `docs(FLY-2341): record 529 rehearsal`；
8. `docs(FLY-2341): record milestone`（必须最后）。
