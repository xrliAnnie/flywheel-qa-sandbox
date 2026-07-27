# FLY-1497 v2 权威库落地(批次1) — QA 验收报告

Issue: FLY-1497
日期: 2026-07-27
基于: plan.md(§7 测试清单 / §5 验收矩阵)、design-FINAL-v2.md

被验实现 head: **见 §7** —— 实现在 `b914c265` 之后曾长期未改,但 gate 复审 R4 抓到阻断级缺陷后
做了一次最小修复(`kernel.ts` 的 prepare 守卫),所以最终被验实现 ≠ `b914c265`。
PR: #710

---

## 0. 结论

> ### ⚠️ 首版 PASS 已撤回并重发(见 §7)
>
> 我先前在 head `745293cf` 发过一次 PASS,**那次是错的**。gate 复审(R4)在实现本体
> `kernel.ts` 上抓到一条**阻断级 HIGH**,我独立复现属实:`WriteTx` 能执行事务控制与
> 连接状态 SQL —— 回调里 `COMMIT` 之后再抛错,写入照样落库(「异常整事务回滚」失效);
> `PRAGMA ignore_check_constraints=ON` 能就地关掉 CHECK,把非法枚举写进 `tasks`。
>
> **这是我的漏检**:只读面的对抗探针我做到 E2a–E2e 很细,却从没对写入面做同一套 ——
> 而 R2 那次修复本身就是不对称的。已按 Lead 授权做最小修复 + 补 13 条回归/对称探针,
> 详见 §7。本报告其余部分描述的是修复后的状态。

**PASS**(修复后)。设计终版 §1 的验收条逐条独立复核通过;发现 1 个非阻塞的**前提条件缺口**(见 §4),
已就地补测试钉死,并标记归属批次 2。

实现本体在 `b914c265` → `745293cf` 区间确实一行未改(§5 那三轮复审的 findings 全落在我写的
QA 测试代码上)。但 **gate 复审 R4 在实现上抓到了一条阻断级缺陷**,于是有了 §7 的最小修复 ——
所以「实现未改」这句只对 R4 之前的区间成立,不要当成对最终交付物的描述。

QA 方法上刻意**不复读包内测试的自我声明**:另建了一套独立 harness(不复用包内
`__tests__/helpers.ts`,只走构建产物的 public API + 裸 better-sqlite3 自行盘库),
把验收条重做一遍;候选 SQL 也是**我自己从 design-chain 原文抽**再 EXPLAIN,
而不是拿包里的常量自证。

| 证据来源 | 结果 |
|---|---|
| 包内测试套件(`pnpm run test`) | **101/101** 通过(原 61 + QA 新增 9 + §7 三轮修复的回归/对称/反绕过探针 31) |
| 独立 QA harness(117 条断言) | 116 通过 / 1 = §4 的已刻画发现 |
| 跨进程迁移竞态 + checksum 篡改探针(10 条) | 10/10 |
| 全仓 `pnpm -r build` | 通过 |
| CI(#710 全部 9 个 job,含 Quick Gate build+typecheck+lint) | 全绿 @ `488a8c51`(其后只有本报告的定稿提交);`Unit (light)` 在 **Linux** 上真跑了 v2-kernel **12 文件 / 70 测**,含两条收尸测试各 2510/2511ms —— 跨平台复现了 helper 自行收尸 + `ESRCH` 取证 |
| Codex code review(实现) | R3 **APPROVED** @ `b914c265`(R2 的 HIGH 已修:只读面曾可 prepare `PRAGMA foreign_keys=OFF` 污染共享连接) |
| Codex code review(QA 测试增量) | R1 CHANGES REQUESTED → 3 条全部处置,见 §5 |

---

## 1. 验收条逐条复核

### 验收① 真实迁移从零建库,17 表 + 索引齐,foreign_key_check=0

- 四条迁移全部应用;重复运行 = no-op(幂等)。
- 非 `sqlite_%` 表**恰 17 张**,且表名单逐字命中设计 §1.0 名单。
- §3.5 索引台账 **13 个命名索引**全部存在(mailbox 家族 7 + activations 2 + `pa_one_running` 1 + 约束性 partial unique 3)。
  注:issue 标题写「9 个索引」,plan §3.5 已按设计原文纠偏为 13 —— 以 13 为准并已逐名断言。
- `PRAGMA foreign_key_check` 空;`integrity_check` = ok;迁移后连接 `foreign_keys` = 1;`journal_mode` = wal。
- 建库权限:库文件 0600、父目录 0700(设计 v1 §1.1)。
- 命名触发器全集(0002 之后的 10 个)逐名断言存在。

### 验收② 四条候选 SELECT + detector 的 EXPLAIN 断言

- **逐字合同**:我独立从 `design-chain/design-v10.md`(F1/F2/N1/N2)与 `design-v8.md`(detector)
  抽出 SQL 代码块,与包内 `CANDIDATE_SQL` / `DETECTOR_SQL` **byte-for-byte 相同** —— 实现确实没改写 SQL。
- 空库(无统计信息)下五条逐条 `EXPLAIN QUERY PLAN`:各自 `SEARCH` 命中目标索引,全程无 `USE TEMP B-TREE`。
- **阳性对照**:一条故意去掉 `source_kind` 谓词的查询落到基础 `mailbox_pending_immediate` 而非 `_f` ——
  证明这把尺子会动,不是恒真断言。
- 统计信息存在时的行为见 §4。

### 验收③ 并发不变量

同进程双连接(包内测试)之外,我另用**真·两个操作系统进程**重验:

- `pa_one_running`:进程 A 已提交一行 running 后,进程 B 插同 message 第二行 running → `SQLITE_CONSTRAINT`;
  旧行结算(`outcome='failed'`)后新 running 行可插 —— 约束没把重试锁死。
- `activations`:同 `attempt_id` 双 active 拒、同 `session_ref` 双 active 拒;
  旧 activation 转 terminal 后新 active 可插(换代基元可行)。
- `attempts_one_active_per_task`:同 task 第二个非 terminal attempt 被拒。
- 写锁交错:A 持 `BEGIN IMMEDIATE` 未提交时,B 的 `BEGIN IMMEDIATE` 吃 `SQLITE_BUSY`(busy_timeout 生效)。
- **迁移竞态**:6 个真进程同时 `migrateDatabase` 同一新库 → 每条迁移**恰被应用一次**,
  其余进程干净跳过;竞态后 `schema_migrations` 恰 4 行、表数仍 17、`foreign_key_check` 空、`integrity_check` ok。

### 验收④ obligations 迁移五测

- 旧行**逐列保真**(0002 重建前后 12 列全等);`target_kind` 全部回填 `'task'`;
  三 tier 默认 `last_enqueued_tier=0` / `suppressed_tier=NULL` / `last_notified_tier=0`。
- agent-target 行可插(`target_agent_id` 填、`target_task_id` 空)。
- 恰一目标 CHECK:双空拒、双填拒。
- `notify_recipient_agent_id` 可独立 UPDATE(换 owner 重路由的 schema 基础)。
- task 终态 → **只** tombstone task-target 的 open 行;agent-target 行原样保留可查。
- `episode_key`:双 open 拒;旧行离开 open 后同 key 可再开;
  多个 `episode_key IS NULL` 的 open 行可并存(partial unique 不误伤无 episode 的义务)。
- depth≤1:depth=1 行挂 depth=1 父被拒(告警不生告警,P5)。
- **UPDATE 旁路封死**(D10):改 `parent_obligation_id` / `root_episode_id` / `depth` 三条 UPDATE 全被
  `obligations_hierarchy_immutable` 拒。

### 验收⑤ 写路径审计

- **BEGIN IMMEDIATE**:经连接工厂 verbose 钩子抓全部 SQL,写事务只出现 `BEGIN IMMEDIATE`,无裸 `BEGIN` / `BEGIN DEFERRED`。
- **只读面收口**(R2 HIGH 的回归探针):`read()` 拒绝 `PRAGMA busy_timeout`、拒绝 `PRAGMA foreign_keys=OFF`、
  拒绝**带前导注释伪装**的 PRAGMA、拒绝 INSERT;且拒绝之后连接 `foreign_keys` 仍为 1(未被污染)。
- **CAS**:行数≠预期 → `CasViolation` + 整事务回滚(前序写零残留);合法 CAS(带状态谓词)提交成功。
- **identity fence**:当前身份放行;旧世代拒、错 `activationId` 拒、registry 键缺失拒(fail-closed)、
  JSON 畸形拒(抛错而非静默 null);fence 失败整事务回滚零残留。
- **生命周期**:async 回调拒;普通函数返回 thenable 被拦且首个 await 前的写零残留;
  回调抛错回滚;**外泄的 tx 句柄** 5 个方法(run/get/all/cas/requireIdentity)事务外调用全抛 `TxLifecycleViolation`;
  嵌套 write 拒;异常之后同一 Kernel 的下一次合法 write 成功(嵌套标志已在 finally 复位)。
- **事务时长闸**:elapsed 超 `txBudgetMs` → 提交前抛 `TxBudgetExceeded` 并回滚;`txBudgetMs`/`busyTimeoutMs` 非法值构造即拒。
- **导出面**:runtime 导出恰等 plan §5.4 集合 A(13 项);`openKernelDb` / `runMigrations(db)` / `Database` 均未泄漏。
- **迁移器失败路径**:rebuild 迁移语法错误 → 整体抛出、无记账行、**连接 `foreign_keys` 仍 = 1**(finally 恢复,绝不留在 OFF);
  checksum 台账被篡改 → **fail-loud**(`checksum mismatch`),绝不静默重跑。

### §6 备份合同

WAL 非空(未 checkpoint)时 backup → 副本 `integrity_check` ok、`foreign_key_check` 空、
`schema_migrations` 与源一致、**且含 WAL 里的行**(证明是 WAL-safe 快照而非只拷主库);副本权限 0600;
destPath 已存在 → 拒绝且不动现有文件、不留 temp 残渣。

---

## 2. 本次新增的测试

| 文件 | 补的是什么 |
|---|---|
| `src/__tests__/query-plan-stats.test.ts` | §4 发现的前提条件:ANALYZE 之后候选查询计划的不变量 |
| `src/__tests__/concurrency-cross-process.test.ts` | `pa_one_running` / activations 在**真·跨进程**下的拒并发(原测试是同进程两连接) |

**关键故障路径都做过变异验证**(防「空过绿测」;三条安全不变量测试与 driver 自证
没有各自的致红变异,不宣称「每条都验过」):

- 把 `pa_one_running` / `activations_one_per_*` 三个 partial **UNIQUE** 降级成普通索引
  → 跨进程的两条并发断言转红,而 driver 自证那条**保持绿** —— 这正是刻意做的诊断隔离:
  约束问题不会伪装成解析问题,反之亦然;
- 摘掉 `_f` partial index → STAT4 刻画那条转红(其余三条安全不变量正确地保持绿:
  摘掉 `_f` 之后基础索引仍在,SEARCH / 无 TEMP B-TREE 依然成立);
- 把 helper 超时从 2.5s 调回 15s(> 框架 5s)→ hung-child 收尸那条转红,
  失败形态正是 `Test timed out in 5000ms`。

变异后源码每次都逐字还原(`git diff` 空)。

---

## 3. 计划外改动的核实

PR 里有一处**超出 plan「不改任何现有包」边界**的改动:
`packages/teamlead/src/bridge/__tests__/fly707-enablement.test.ts`(±6 行)。

我实测核实了它的必要性,而不是按说明接受:把 **main 版本的该测试文件**放回来、配着
**未被本 PR 修改过的** `.flywheel/config.yaml`(与 main 逐字相同)跑 —— 结果:

```
× roles.runner defaults to the opus-1m tier ...
  AssertionError: expected 'claude-opus-5[1m]' to be 'opus-1m'
```

即:该测试**在 main 上就已经是红的** —— main 的 config 早在 FLY-1485 就改成了 CLI-native 的
`claude-opus-5[1m]`,而测试仍断言内部别名 `opus-1m`。本 PR 的改动是让断言追上 config,
并保留了该测试的原始意图(「不是 Fable」)。

判定:属于**必要的 CI 转绿修复**,不是有害的 scope creep。但它归属的是别的 issue 的遗留,
建议在 PR 描述里点一句,免得日后考古误以为是 v2 相关改动。

---

## 4. 发现(非阻塞,归属批次 2)

**两条 *scheduled* 候选(F2 / N2)命中哪个 partial index,取决于 `ANALYZE` 产生的 STAT4 样本。**
(§1.2f 七个索引**全部**是 partial —— 含下文所称的「基础」索引 `mailbox_pending_scheduled`;
`_f`/`_nf` 与它的差别只是 WHERE 里多一个 `source_kind` 谓词,不是 partial 与否之别。)

`query-plan.test.ts` 在一个刚建好、**从未 ANALYZE 过**的库上断言 F2→`mailbox_pending_scheduled_f`、
N2→`mailbox_pending_scheduled_nf`。这个断言是真的,但它成立的前提是**优化器统计缺席**。
跑过 `ANALYZE` 之后,planner 会在某些 founder/非-founder 配比下改判到**基础**索引
`mailbox_pending_scheduled`。

> **更正(Codex 复审 R1 抓出,我原先写错了)**:本报告初版把这件事归因为
> 「只在 `sqlite_stat1` 缺席时成立」。**不对**。本仓 SQLite 3.51.3 编译开了
> `SQLITE_ENABLE_STAT4`,`ANALYZE` 会同时产出 `sqlite_stat1` 和 `sqlite_stat4`;
> 我用「只删 `sqlite_stat4`、保留 `sqlite_stat1`」把变量隔离出来实测 —— **F2/N2 全部回到
> `_f`/`_nf`**。所以真正驱动翻盘的是 **STAT4 的直方图样本**,不是 `sqlite_stat1` 的存在与否。
> 这是我在没有隔离变量的情况下写下的机制断言,属于「实测支撑不了的总结句」,已按实测改正。

| 数据形态 | 无统计 | 完整 ANALYZE(stat1+stat4) | 仅删 stat4、保留 stat1 |
|---|---|---|---|
| 3000 行,founder 1/7 | F2 `_f` ✅ | F2 **基础索引** ❌ | F2 `_f` ✅ |
| 3000 行,founder 1/20 | 两条 ✅ | 两条 ✅(**不翻**) | 两条 ✅ |
| 3000 行,founder 1/50 | N2 `_nf` ✅ | N2 **基础索引** ❌ | N2 `_nf` ✅ |
| 50000 行,founder 1/20 | N2 `_nf` ✅ | N2 **基础索引** ❌ | N2 `_nf` ✅ |

**为什么不阻塞本单**:

- 不是正确性问题。基础索引的 WHERE 是 partial 索引 WHERE 的严格超集,列顺序
  `(to_agent, next_retry_at, seq)` 完全相同 → 结果集与顺序不变,`LIMIT 1` 仍能提前终止。
- 设计 §1.2f 真正依赖的性质是「ORDER BY 由索引满足」。上表 4 种数据形态 × 3 个统计阶段、
  再叠加 5 条 SQL,逐次 `EXPLAIN` **都没有出现过 `USE TEMP B-TREE`**,也从未退化成全表 `SCAN`。
- 本单交付边界明确不含消费循环(§10),库里也没有任何代码会跑 ANALYZE ——
  交付形态下现有断言成立。

**为什么仍要记账**:批次 2 消费循环落地、数据量真实起来、维护跑过 ANALYZE 之后,
`_f`/`_nf` 这层 **founder 公平性分区可能悄悄不再被使用**,退化成「扫过一堆非 founder 行才够到
第一条 founder 消息」。届时若观察到 founder 消息时延异常,这里是第一个要看的地方;
真要钉死可用 `INDEXED BY` 或调整索引列顺序,但那是对设计 §1.2f 的修订,不该在批次 1 私自做。

已就地补 `query-plan-stats.test.ts`:一半断言 ANALYZE 后依然成立的安全不变量
(SEARCH、不退化 SCAN、scheduled 家族之内、无 TEMP B-TREE),另一半做**受控翻盘观察** ——
3000 行 / founder 1/7 下真的去「看见」F2 翻到基础索引、再删掉 `sqlite_stat4` 看见它**回到** `_f`,
把因果钉在 STAT4 上。同时断言 `sqlite_stat4` 存在,这样哪天换成没开 STAT4 的 SQLite 构建,
测试会红并提醒后来者这套刻画的前提变了。

---

## 5. Codex 对 QA 测试增量的复审(R1 CHANGES REQUESTED → 全部处置)

按 head discipline,QA 提交推上去之后对新 head 重跑了 codex code review。它对我写的两个测试
文件提了 3 条,**全部处置**;其中 1 条的结论我实证推翻了,但它指出的根因我认了并修了。

### F1(codex 标 HIGH)child 用裸 `require('better-sqlite3')`,会 MODULE_NOT_FOUND → 测试超时挂死

**它的预测被实证推翻,但它的批评是对的 —— 两件事都要说清楚。**

- **推翻的部分**:codex 断言「66/66 在 committed harness 下不可复现」。实测两个独立环境都复现了:
  我的 macOS 两次实跑 + **CI 在 Linux 上真跑了这个文件**(`Unit (light)` → `concurrency-cross-process.test.ts ✓ 2 tests, 273ms`)。
  273ms 不可能是 MODULE_NOT_FOUND 挂死(那会等到 vitest 5s 超时)。codex 自陈它**没能跑起 vitest**
  (只读沙箱建不了临时目录),结论来自静态追踪 —— 所以它预测的失败模式没有发生。
- **成立的部分**:我另写探针做了隔离实测 —— 在 **plain node** 下 fork 同样的 child,裸 require
  **确实** MODULE_NOT_FOUND(临时目录向上没有 node_modules)。也就是说:测试之所以绿,
  是因为 **Vitest 的子进程环境碰巧让它能解析** —— 这是一条没写下来、没人保证的隐式依赖。
  我甚至 import 了 `createRequire` 却没用上,本来就是想显式解析忘了做。
- **处置**:父进程用 `createRequire(import.meta.url).resolve("better-sqlite3")` 解析出绝对路径,
  经 IPC 显式传给 child,不再依赖运行器环境。另加一条 `resolves the sqlite driver for the child
  out of band` 前置自证测试:解析环境若变了,先红在这条,而不是让并发断言给出误导性失败。
- **修复自证**:plain node(无 vitest)下显式 driverPath 的 child 成功连库 ✅;
  **阳性对照** —— 同一个 child 传裸名字仍然 MODULE_NOT_FOUND ✅(证明修复前的脆弱是真的,不是我编的)。

### F2(MEDIUM)IPC 生命周期不可靠:child 早死会让 Promise 悬着

**认。** 原实现有 `child.on("error", reject)`,但缺 `exit` / `close` 处理,也没有超时 —— child 若在
发结果前**正常退出**(而不是抛 error),Promise 会一直挂到 vitest 超时,失败信息还会误导
(看起来像并发约束的问题)。

- **处置**:改成「拿到结果 **且** 干净 exit 0」才 resolve;`error` / 非零退出 / 无结果退出一律显式 reject;
  加 15s bounded timeout + `SIGKILL` 兜底。child 侧在 `process.send` 的 flush 回调里 `disconnect()`,
  而不是 `process.exit()`(后者会在 send 落地前砍掉进程)。
- **修复自证**:构造一个「收到消息立刻 `exit(3)`」的变异 child → 父进程 **60ms 内** reject
  (`child exited with code 3`),靠 exit 事件立即失败,不是等超时 ✅。

### F3(MEDIUM)翻盘归因写错 + characterization test 没验证自己的标题

**全认,这是本次复审最有价值的一条。** 见 §4 的更正框:机制是 STAT4 样本,不是 `sqlite_stat1`;
我原来那条名为 "documents that ... is statistics-dependent" 的测试写的是宽松断言,
计划**完全不变也能通过** —— 名不副实。

- **处置**:§4 表格改成三列(无统计 / 完整 ANALYZE / 仅删 stat4),机制表述按实测改正;
  测试改名为 `attributes the scheduled-candidate plan flip to STAT4 samples, not to sqlite_stat1`,
  并真的做受控三阶段观察(无统计命中 `_f` → 完整 ANALYZE 翻基础索引 → 删 stat4 回到 `_f`)。

**codex 未推翻的部分**:它明确确认 SEARCH / 无全表 SCAN / 无 TEMP B-TREE / scheduled-family
这些断言本身不是恒真,约束测试里的 SQL 也不会被别的约束误拒;并且认同「planner 问题在批次 1
属非阻塞、应作为批次 2 消费循环的性能/时延验收项」——与我的判断和 Lead 的背书一致。

### R2:1 条 MEDIUM 认并修,3 条 LOW 中 2 条认、1 条据实驳回

R2 开头 codex **主动撤回了 R1 的 HIGH 误判**(「committed suite 必然超时」),并确认新 head 的 Linux CI
实跑通过(cross-process 3 tests/446ms、query-plan-stats 4 tests/269ms、v2-kernel 68/68);
同时确认 driver 解析修复可靠、STAT4 刻画确实非空泛(它自己复现了三阶段翻盘)。

**R2-1(MEDIUM)helper 超时 15s > 框架 5s —— 认,是我修 F2 时引入的真 bug。**
本包 `vitest.config.ts` 没覆盖 `testTimeout`,Vitest 3.2.4 默认 5s。child 若卡住,框架会先在 5s 判超时,
我那个 15s 的 `SIGKILL` **永远轮不到**,僵尸 child 会活过本用例去干扰后续用例;而且原来的超时分支
kill 完立刻 reject,结算时并没有证明 child 已经退出。

- **处置**:`CHILD_TIMEOUT_MS` 降到 2.5s(稳稳早于框架 5s,正常往返实测 ~100-400ms 有充足余量);
  超时分支**只负责开杀不负责结算**。另按 codex 建议**在仓内补一条 hung-child 测试**,
  把「helper 自己收尸」钉死,而不是靠框架兜底。
- **修复自证**:hung-child 测试 2514ms 结算(≈ `CHILD_TIMEOUT_MS`,证明是 helper 收的尸);
  变异回 15s → 该测试转红且失败形态正是 `Test timed out in 5000ms` ✅。

> **更正(R3 抓出)**:本节初版写「settle 一律走 `close`」——**当时不成立**。`error` 分支
> 仍在直接结算,而 `error` 不只代表 fork 失败,IPC send 失败也会走它,那时 child 可能还活着;
> codex 用独立探针复现了:Promise 在 `close` 前结算、`killed=false`、100ms 后 PID 仍在。
> 见 R3-1 的处置。

**R2-2 / R2-3(LOW)报告事实残留 —— 认,已改**:①「原实现没有 `error` handler」不准确(有 `error`,
缺的是 `exit`/`close`/超时),已改;②变异验证一节的计数与「6 种形态」表述随文件演进过期,已按当前
实际重写;③`progress.md` 的 re-review 指向已更到当前 head。

### R3(最后一轮,Lead 已划死收敛边界):1 条阻断级修一次收口

Lead 裁定 R3 为 QA 测试代码打磨的最后一轮 —— 阻断级测试正确性 bug 修一次即收口,
advisory 级记档不改。R3 恰好抓到一条阻断级的,已修。

**R3-1(MEDIUM)`error` 路径仍在 `close` 前结算,可能漏 child —— 认,codex 独立复现。**
我 R2 只把**超时**分支改成了「只开杀不结算」,却漏了 `error` 分支:它仍直接结算并清掉收尸 timer。
而 `error` 不只代表 fork 失败 —— IPC send 失败(`ERR_IPC_CHANNEL_CLOSED`)也走它,那时 child 还活着。

- **处置**:结算收口成**唯一** `settle()`,只从 `close` 或最后的 backstop 调用;
  `error` 与 send 回调里的失败只**记账 + `SIGKILL`**,不结算;另加 `CHILD_TIMEOUT_MS + 1s` 的
  backstop,保证连 `close` 都不来的极端情况下 Promise 不会悬死。
- **取证升级**:hung-child 测试不再只看错误消息和耗时(那种断言在「kill 完立刻 reject」的退化实现下
  一样能过),改为让 child 上报 pid,结算后直接 `process.kill(pid, 0)` 断言 `ESRCH` —— 真的证明它没了;
  计时改用 `performance.now()`。

**R3 的 LOW 也已改**:测试计数 68→70;「每条新测试都做过变异验证」收敛为「关键故障路径都验过」
(三条安全不变量与 driver 自证确实没有各自的致红变异);「settle 一律走 close」的过期结论已加更正框。

**一处诚实边界(我自己发现并主动记账)**:我本想补一条确定性回归测试直接覆盖 `error` 分支,
但**做不到确定性触发** —— disconnect 放在 send 的 flush 回调里、以及与 send 同 tick 两种写法都试过,
parent 收到 `ready` 后的回发**总是先于** disconnect 传播到位,实际走的是超时收尸路径。
我没有把这条测试包装成「覆盖了 error 分支」(那会是空过绿测:实测变异回旧行为它照样绿),
而是如实改名+注释,说明它保证的是「IPC 断了还赖着不死的 child 最终仍被收掉」。
`error` 分支本身**靠构造保证**(它不再有结算能力),没有确定性回归测试 —— 这是已知覆盖缺口。

**R2-4(LOW)「基础索引不是 partial index」—— 据实驳回(codex 已于 R3 撤回该条)。**
`mailbox_pending_scheduled` 的 DDL 是
`CREATE INDEX ... ON mailbox(to_agent,next_retry_at,seq) WHERE state='pending' AND next_retry_at IS NOT NULL`
—— **带 WHERE,是 partial index**;design v9 §1.2f 的七个索引**全部**是 partial,`_f`/`_nf` 与基础索引的
区别只在 WHERE 里多不多一个 `source_kind` 谓词,不是 partial 与否的区别。所以原文「命中哪个 partial
index」的表述是准确的,不改。(为免歧义,§4 正文已在提到基础索引处一并点明它同属 partial 家族。)

---

## 6. 未覆盖 / 诚实边界

- **事务时长闸是下限保护,不是同步 I/O 的完备证明**(plan D12 已自陈)。回调里的同步网络/文件 I/O
  只要跑得比 `txBudgetMs` 快就通得过;静态禁令仍靠 code review。
- `Kernel.read()` 是**只读访问面而非只读事务**(未 BEGIN)—— 同一个 `read()` 回调里的多次
  `get/all` 之间可能看到不同快照。这与 plan §5.1 的措辞(「只读访问面」)一致,不是偏离;
  但批次 2 若要做跨多次读的一致性判断,需要自己开事务。
- 备份的副本验证**不与 live 源做强相等**(plan D13 的刻意选择:online backup 期间源可继续写)。
  逻辑级行数强相等留给批次 3 的 stop-the-world 切换手册。
- 本单**零接线**已复核:`packages/v2-kernel` 未被任何现有包 import,`flywheel-v2.db`
  不在任何生产路径出现(只在测试临时目录被创建)。

---

## 7. PASS 撤回与最小修复(gate 复审 R4 抓出的阻断级缺陷)

### 7.1 缺陷

`WriteTx` 的 `run/get/all/cas` 没有连接状态 SQL 守卫 —— 那道守卫只加在只读面上。
两条实测复现(我在 codex 报出后独立跑了一遍,没有照单全收):

| 复现 | 修复前 | 修复后 |
|---|---|---|
| 回调内 `INSERT` → `tx.run("COMMIT")` → `throw` | 回调确实抛错,但**写入落库**(`persisted=1`) | 拒绝 + 零残留 |
| `tx.run("PRAGMA ignore_check_constraints=ON")` → 插非法枚举 | 成功写进 `state='not-a-state'` | 拒绝 + 库内无该行 |

我另外探到 `SAVEPOINT` / `PRAGMA foreign_keys=OFF` 同样能经写入面执行;
对照只读面则正确拒绝 —— 证明 R2 那次 HIGH 的修复是**不对称**的。

违反的合同:计划 §5.1-4 与 FINAL §1.2 支柱③(异常/CAS 失败整事务回滚)、
§0.5b(**调用方提供的** PRAGMA 一律不接受)。
措辞更正:早先我写成「连接工厂是 PRAGMA 唯一落点」,按字面不成立 ——
`Kernel.write()` 自身就有两处 `foreign_keys` 的设/读回防御性调用。
这道守卫管的是「不让调用方从 tx 句柄塞 PRAGMA 进来」,不是「进程里再无 PRAGMA 字样」。

### 7.2 这是我的漏检

我把只读面的对抗测试做到 E2a–E2e(拒 PRAGMA、拒注释伪装、拒 INSERT、拒后连接未被污染),
**却从没把同一套探针对称地打到写入面**。缺陷就在我测过的那条边界的另一半上。
「只读面已修」不蕴含「写入面已修」—— 我当时把前者当成了后者,这正是拿标签冒充事实的老毛病。

### 7.3 修复(Lead 授权的最小改动,只修这一个洞)

把守卫从只读面私有的 `prepareRead` 提到**两个 façade 共用**的 `prepare` 边界:
连接状态 SQL 读写两侧一律拒;`enforceReadonly` 缩回它本来的职责 ——
只额外管「语句必须是只读的」。错误措辞按 façade 区分,现有只读面测试零改动。

回归与对称探针共 **13 条**(83/83 通过,原 70 + 13):
上表两条复现、写入面九种连接状态 SQL 逐条拒且拒后 `foreign_keys` 仍为 1、
注释伪装、以及 `get`/`all`/`cas` 三个读辅助同样受守卫。

**变异验证**:把守卫改回「仅只读面」的旧形态 → 13 条**全部转红**。

### 7.4 守卫的范围(显式写死,Lead 划定的收敛线)

**这道守卫防的是事故,不是攻击。**

- **它要挡住的已枚举场景**:批次 2+ **我们自己的代码**在写事务回调里误用
  `COMMIT` / `PRAGMA` / `SAVEPOINT` 这类语句,从而悄悄破坏「异常整事务回滚」与
  「调用方提供的 PRAGMA 一律不接受」这两条支柱。这类误用是**无意的**,
  不会刻意伪装,所以关键字层识别足够。
- **它明确不承诺的**:对**存心绕过**的调用方完备。铁证就在手边 ——
  TypeScript 的 `protected db` 编译后是公开实例字段,纯 JavaScript 调用方可以直接
  `tx.db.prepare(...)` 绕开整道守卫。既然存心绕的路本来就敞着,
  再用穷举变体去追关键字识别的边角,就是**投入打错了地方**。

因此:**同类的「又找到一种绕过写法」记为 advisory,不作阻断**(它没有违反守卫声称的范围);
只有别的类型的缺陷才算阻断。真正的结构性根治 —— 写入面**不接受裸 SQL 字符串**、
只暴露类型化操作,句柄也真正私有 —— 记入 **FLY-1499(批次 2)**,与同族问题一起解决,本单不做。

这条边界是显式合同,不是事后开脱:上面 §7.1–7.3、§7.5–7.6 修的三轮,
修的都是**这道守卫在自己声称的范围内失效**(误用者根本没伪装,却照样穿过去了),
那些是真缺陷;而「刻意构造的绕过」从来不在范围内。

### 7.5 第二轮:同一个洞的词法绕过(守卫 vs SQLite tokenizer 的分歧)

7.3 的修复**不完整**。gate 复审下一轮(R5,中途被内容过滤器中断、无最终 verdict,
但它已执行的探针确立了这条)指出:**前导分号能绕过守卫**。我独立复现,而且比报出的更广 ——
`; COMMIT` / `;COMMIT` / `;; COMMIT` / 空白+`;` / 注释+`;` / `;`+注释 / BOM+`;`,
以及 PRAGMA 的同批变体,**12 种全部绕过**。

**根因**:`leadingSqlKeyword()` 跳空白和注释,但不跳 SQLite 视为合法空语句的 `;`;
而 SQLite 的 prepare 会跳过它去执行后面那条。**我的词法分析与 SQLite 的 tokenizer 有分歧,
分歧就是洞** —— 守卫读到空关键字于是放行。

**我没有只修被报出的那一个变体**(前两次都是「修了报出来的、漏了同类的」)。
主动搜同类分歧,又抓到一个**未被任何人报出**的:

- **`EXPLAIN PRAGMA ignore_check_constraints=ON` 确实生效** —— 非法枚举写进了 `tasks`。
  守卫只看最外层关键字 `EXPLAIN`(不在集合里)就放行了。

**修复**:`leadingSqlKeyword` 在循环里把空白、注释、**分号**三者反复跳到不能再跳;
并**剥掉 `EXPLAIN` / `EXPLAIN QUERY PLAN` 外壳**再看里面那条关键字。
剥而不是一律禁 —— `EXPLAIN QUERY PLAN SELECT …` 是只读面的合法用法,有阳性对照测试守着不被误伤。

**验证**:三组对抗探针共 29 个变体(12 分号 + 13 分歧 + 4 条原始 R4)全部归零;
阳性对照确认 `EXPLAIN QUERY PLAN`、普通 SELECT、普通 INSERT 都未被误伤;
另有 13 条回归测试入库(套件 83 → **96**)。
顺带确认多语句(`SELECT 1; COMMIT`)被 better-sqlite3 自身以 `RangeError` 拒绝,不构成绕过路径。

**这一节的教训**:同一个缺陷我修了两轮才收住。第一轮只补了被指出的那一面(写入面),
第二轮才发现守卫本身的识别逻辑可以被绕。**「我修好了报出来的那个」不等于「这一类关过了」** ——
所以第二轮我先自己搜同类,才有了 EXPLAIN 这条自己抓的。

### 7.6 第三轮:同一类还没关完(wrapper 内部的注释分隔)

7.5 结尾我写「三组探针 29 变体全部归零」,那是真的 —— 但**它证明不了「与 tokenizer 对齐了」**,
只证明我想到要探的那 29 种归零了。下一轮 gate 复审(新 thread)就抓到我没想到的第 30 种:

我剥 EXPLAIN 外壳时用的是 `^\s+QUERY\s+PLAN\b`,**只认空白分隔**;而 SQLite 在 token 之间同样忽略注释。
于是注释插在 `EXPLAIN`/`QUERY`/`PLAN` 之间时,SQLite 认完整 wrapper、我的 helper 却在 `QUERY` 提前返回,
内层受禁关键字逃检。实测 4 种变体(两处分隔位各插块注释、两处都插、行注释分隔)**全部把非法枚举写进了 `tasks`**。

**根因是同一个坏习惯**:我在同一个函数里就地写了**第二套**「跳过什么」的规则(那个 `^\s+`),
它和主循环的规则不一致。修法是把「SQLite 在 token 之间忽略什么」抽成唯一的 `skipIgnorable()`,
wrapper 内部也走它 —— 唯一区别是语句起始处额外跳空语句(`;`),token 之间**不跳**分号
(那是真正的语句边界,跳了就越界读下一条了)。

**同轮一并修的测试质量问题**(复审指出,都成立):
- 连接状态关键字矩阵漏了 `END`,已补;
- `EXPLAIN COMMIT` 那条只断言 `.toThrow()`,而回调自己必然抛错 —— **证明不了守卫命中**,
  已改为断言守卫消息。变异验证显示:改之前它在退化实现下照样绿,改之后转红;
- `EXPLAIN QUERY PLAN` 只有阳性对照,**删掉 wrapper 消费逻辑它照样通过** ——
  已补 4 条负向测试(注释分隔的 wrapper 必须被看穿),现在变异会让它们转红。

**验证**:四组对抗探针共 **35 个变体全部归零**;阳性对照确认合法用法(含**带注释分隔的** `EXPLAIN QUERY PLAN SELECT`)未被误伤;套件 96 → **101**;变异验证 6 条转红。

**教训升级**:7.5 我说「修好被报出的那个 ≠ 这一类关过了」,然后**自己又犯了一次**同型错误 ——
我把「我探过的变体都归零」写成了「与 tokenizer 对齐」。前者是我的测试覆盖,后者是关于 SQLite 的断言,
我没有能力用 29 个样本证明后者。**这类守卫的正确结论只能是「已知变体已覆盖 + 结构上共用同一套跳过规则」,
不能是「已对齐」。** Lead 已把结构性根治(写入面不接受裸 SQL 字符串、只给类型化操作)记入批次 2 台账。
