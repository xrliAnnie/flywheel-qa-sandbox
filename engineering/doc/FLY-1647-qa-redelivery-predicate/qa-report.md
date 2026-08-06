# QA 独立复核报告 — FLY-1646 重投谓词修复 (PR #784)

**Issue**: FLY-1647 (QA·FLY-1646 独立复核)
**URL**: https://linear.app/studio/issue/FLY-1647
**审对象**: PR #784 branch `flywheel-FLY-1646` head `657d6d60`（与派单 pin 一致，复核期间未变）
**Base**: `f02ecbc8` = `origin/main`（PR 恰好领先 main 一步）
**日期**: 2026-08-06
**判定**: **PASS**

---

## 0. 复核方法（为什么这不是实现者报告的回声）

三处刻意与实现者的证据 harness 不同：

1. **对照组是真代码，不是模拟**。实现者的 `repro-livelock.ts` 用一个进程内 `Set`
   模拟「迁移前语义」。本复核唯一变量是磁盘上 `packages/flywheel-comm/src/mailbox-queue.ts`
   检出的是哪个 revision；每次运行都打印该文件的实时 git blob hash，结果自带
   「是哪份代码产出的」凭据。
2. **`quarantine` 接真实现**（实现者 stub 成 no-op）。这恰好是「隔离行会不会丢」
   论证的关键状态。
3. **计数谓词手抄自三个 revision 的源码**（`counts.mjs`），不 import 被审代码。

安全：所有命令前 `unset FLYWHEEL_COMM_DB`（agent shell 里它默认指向生产
`~/.flywheel/comm/flywheel/comm.db`）；所有迁移/循环只跑在 /tmp 副本库。

---

## 1. 活锁复现对照（核心）

真 `flywheel` 分片 pre-1572 备份 → 只读复制 → 跑真迁移脚本 → 跑真 Discord 插件
`ChatReceiptRuntime.workerLoop()`；两次运行的库是**同一份迁移产物的 byte-identical 拷贝**
(`sha256 12905272…`)。

| 代码版本 | blob | 判定 | 重投数 | 不同收据 | 单条最多 | 耗时 |
|---|---|---|---|---|---|---|
| shipped（754541aa 语义） | `6923fcbe` | **不终止** | **6,340** | 42 | **151** | 卡满 20s |
| PR #784 | `62d4d0d3` | 终止 | **0** | 0 | 0 | **65ms** |

**与实现者数字对照**：判定一致、不同收据数 **42 逐字一致**；重投总数 6,340 vs 7,810、
单条最多 151 vs 186 —— 20 秒窗口内的吞吐差异来自机器负载，不是分歧。修复后 65ms
vs 36ms 同量级。

## 2. 迁移把已结清历史变成待重投

同一分片，迁移前（legacy 谓词，手抄自 `754541aa^` 的
`listExternalPendingForLane`）与迁移后（shipped / PR 谓词）逐 Lead 对照：

| Lead | 迁移前 legacy | shipped 谓词 | PR 谓词 |
|---|---|---|---|
| claude-infra-bot-lead | 0 | 5 | 0 |
| flywheel-cos-lead | 0 | 17 | 0 |
| flywheel-eng-lead | 0 | 42 | 0 |
| flywheel-product-lead | 0 | 1 | 0 |
| flywheel-test-1 | 3 | 3 | 3 |
| **合计** | **3** | **68** | **3** |

68 条里 **65 条 `state='ACKED'`（已投递过）**。与实现者「0 → 68，其中 65 条 ACKED」
**逐字吻合**。PR 谓词把它恢复到与 legacy 完全一致的 3 条 —— 既没多，也**没少**。

## 3. 反向断言：不是「拿丢消息换风暴」

`flywheel-test-1` 的 3 条是真未送达收据，且创建于 48h 之前 —— 循环里会**真的**
先 quarantine（`state → DEAD`）再重投。三向对照：

| 变体 | pass1 送达 | pass1 `complete` 失败 | pass2 重投 | 结局 |
|---|---|---|---|---|
| shipped | 3 | **3** | 3（每轮如此） | 永不收敛，反复重投 |
| 被否决的窄谓词草案 `state IN ('QUEUED','LEASED')` | 3 | **3** | **0（行已不可见）** | **静默丢消息** |
| **PR #784** | 3 | **0** | 0 | 送达并收回（`state=ACKED`，`acked_at` 落地） |

窄草案的丢消息不是纸面论证 —— 我按它的语义构造变体跑出来了：pass2 谓词返回 0 行，
而 `acked_at` 始终为 null，即这条消息再也不会被投递、也没有任何送达记录。
PR 采用 `state <> 'ACKED'`（两侧对偶）是正确的取舍。

## 4. 常态缺陷：不修谓词，重新部署一定复发（比 PR 描述更严重）

全新空库、零迁移残留，只放两条「Lead 已被通知但没用显式回复 settle」的收据：

| 代码版本 | 判定 | 重投 | 单条最多 | 耗时 |
|---|---|---|---|---|
| shipped | **不终止** | 3,744 | **1,872** | 8s 硬切 |
| PR #784 | 终止 | 0 | 0 | 94ms |

**新发现**：小库上 shipped 的自旋是**纯 microtask**，会**饿死 Node event loop** ——
我最初 10 秒的 `setTimeout` 兜底根本没触发，必须改成 `notify` 里的同步时钟检查才能
把它切下来。也就是说这条路径不只刷屏，还会让插件进程失去响应。

## 5. 契约测试真的在把门

| | 测试名 | 出处 |
|---|---|---|
| FLY-1572 **之前** | `quarantines with one stable alert and **still permits later completion**` | `754541aa^` |
| FLY-1572 **之后** | `quarantines to a stable DEAD state that **cannot later complete**` | `git log -S` 确认唯一来源 = `754541aa` |
| PR #784 | `quarantines idempotently and **still permits later completion**` | 已还原（断言 `state:'ACKED'` + `acked_at`） |

**把门验证**（只回退 `mailbox-queue.ts` 到 shipped，其余保持 PR head）：

- PR head：`chat-receipt.test.ts` + `fly1646-replay-bound.test.ts` = **17/17 绿**
- 回退后：**6 红**（`fly1646-replay-bound` 5 红 + 还原的隔离契约测试 1 红）

## 6. classify fail-loud + `--rollback` 不被挡

**真生产形态**（`growth` 分片只读副本）：

| 脚本版本 | classify | 行为 | exit |
|---|---|---|---|
| shipped | `"migrated"` | **静默跳过**（继续用陈旧 legacy 表服务） | 0 |
| PR #784 | `"mixed"` | 具名报错、零写入 | **1** |

**自建真 mixed fixture**（真迁移一个 legacy 分片 → 把迁移装的 compat **view** 换成真
**table**，还原 `growth` 的确切形状）：

- cutover → exit 1 + 具名报错
- `--rollback` → **未被 mixed 闸拦下**，成功还原成 `legacy`（280 行 `lead_inbox`）

**附带确认**：完整迁移后 `messages` / `lead_inbox` 以 **view** 形式保留；`classify` 判
`type === 'table'` 因此**不会**把正常迁移态误报成 mixed —— 我用真分片跑完整迁移验证过
（结果 `migrated`，不是 `mixed`）。

## 6b. 对偶性：真 `ExternalReceiptSaga`（xdept 通道，Tadashi 追加复核项 ②）

chat 通道之外的第二条 external 通道。复现 saga 在生产里真会产生的场景：
`begin()` → journal **临时不可用** 时 `reconcile()` 打 `markDead("journal unavailable: …")`
（**可恢复**原因）→ journal 恢复后再 `reconcile()` → 命中 `accepted` → `this.complete()`。

| 变体 | pass1 终态 | pass2 该行可见 | pass2 结果 | 终态 | 判定 |
|---|---|---|---|---|---|
| shipped | `DEAD` (journal unavailable) | 1 | **抛错** `external receipt completion failed for discord-1` | `DEAD`, `acked_at=null` | 每轮 reconcile 都抛，**永不收敛** |
| 被否决的窄草案 | `DEAD` | **0** | 不抛，`delivered=0` | `DEAD`, `acked_at=null` | **静默丢消息** |
| **PR #784** | `DEAD` | 1 | `delivered=1` | **`ACKED`** | **收敛** |

PR 关于「否则 `ExternalReceiptSaga.complete()` 遇到恢复了的 xdept 收据会直接抛错」的
说法**属实**，且我在 chat 通道之外的第二条通道上独立验到了同一组三向结果。

**附带发现（非阻塞 advisory）**：现有 `ExternalReceiptSaga.test.ts` **4/4 在两个版本下都绿** ——
它没有覆盖这条 journal-unavailable → 恢复 → complete 的路径。真正把门的是
`fly1646-replay-bound.test.ts` 里 MailboxQueue 层的那对断言（「隔离行仍可重投」在窄草案下红、
「隔离行可被送达收回」在 shipped 下红，两个方向都盖住了）。所以谓词层有回归保护，
saga 层没有专属用例。建议作为 follow-up 补一条，不阻塞本 PR。

## 7. 边界：只动读取侧

- 全仓仅 **2 个生产文件**改动：`mailbox-queue.ts`、`scripts/migrate-fly1572-mailbox.ts`
- `mailbox-queue.ts` 非注释生产 delta = **9 行**：新增 `QUARANTINE_DEAD_REASONS` 常量、
  `markExternalDelivered` 一处 WHERE、`listExternalPending` 一个可选入参 + 两条谓词 + 两个绑定参数
- **`settle()` 两版 sha256 逐字相同**（`5d0cdbb2…`）→ settle 写入侧零改动，
  与 FLY-1645 的边界成立

## 8. 套件 / CI

| | 结果 |
|---|---|
| `flywheel-comm` 全套件（PR head，本机） | 93/94 文件绿；1302 测 1301 绿 |
| 唯一红 `qa-result.test.ts` | 把 `mailbox-queue.ts` 回退到 shipped 后**同样红** → 既有本机环境项 |
| `scripts/__tests__/migrate-fly1572-mailbox.test.sh` | PASS |
| PR #784 GitHub CI | **9/9 全绿** |

## 9. 生产零写入核证

| 检查 | 结果 |
|---|---|
| 7 个 `comm.db.pre-fly1572-*` 备份 sha256 前后对照 | **7/7 逐字一致** |
| 各分片目录文件清单（新增/删除） | **零变化** |
| 分片 schema 状态（复核后重新取样分类） | 6 × `legacy` + `growth` × `mixed`，与开工前基线一致 |

---

## 10. 发现的偏差 / advisory（均不影响 PASS）

1. **PR test plan 措辞低估了自己的门**。PR 写「新增 TDD 修前 3 红」，实测 shipped 语义下
   该文件 **5 红**（连同还原的契约测试共 6 红）。门比 PR 自己写的更严，属文档措辞偏差。
2. **重迁 checklist 建议补一条 footgun**：`comm.db.migration-swap-intent.json` 里的
   `backupPath` / `dbPath` 是**绝对生产路径**。把它连同库一起拷到 /tmp 演练 `--rollback`
   会去读生产备份文件。`rollbackMailboxMigration` 写的是**传入的 dbPath**（所以不会写坏生产），
   但演练前必须清楚这点 —— 本复核因此没有拷贝生产 intent，改为自建 fixture。
   *（既有行为，非本 PR 引入。）*
3. **小观察**：`rollbackMailboxMigration` 成功还原时返回 `status: "already_migrated"`
   （这是该函数里唯一的 status 字面量）。重迁窗口里容易被误读成「没做事」，实际已还原。
   *（既有代码，非本 PR 引入。）*
4. 本复核**不含**真机部署 E2E（生产现处全面回滚态 `4857d999`），按派单归重迁 checklist。

---

## 11. 证据位置

会话 scratchpad：
`/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1647/04fcc862-e416-4ce5-b888-f7a69207901e/scratchpad/fly1647/`

| 文件 | 用途 |
|---|---|
| `qa-loop.ts` | 独立编写的真插件 workerLoop 驱动器（真 quarantine + blob 自证） |
| `qa-loop2.ts` | 同上 + 同步时钟兜底（用于会饿死 event loop 的 shipped 空库场景） |
| `counts.mjs` | 三个 revision 的 pending 谓词手抄实现 |
| `classify.mjs` / `objs.mjs` | 独立 schema 分类器（区分 table / view） |
| `mkmixed3.mjs` | 真 mixed fixture 构造器 |
| `saga-recover.ts` | 真 ExternalReceiptSaga 的 journal-unavailable → 恢复 → complete 三向对照 |
| `baseline/` | 生产零写入前后对照（inventory + 备份 sha256） |
| `dbs/` | 所有 /tmp 副本库（含各运行的终态） |
