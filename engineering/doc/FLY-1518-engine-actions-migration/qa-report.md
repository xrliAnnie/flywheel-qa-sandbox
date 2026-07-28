# FLY-1518 引擎迁入 actions + 删退役表 — 独立 QA 报告

Issue: FLY-1518
日期: 2026-07-28
基于: plan.md(§4 验收矩阵 M/E/Z 三族)

被测 head: `8800df97` (PR #722)
QA 执行会话: `65e81f76-2baf-43eb-86b1-29023b851675`(role=qa,与 implement 会话 `0fcbe0cd` 分离)

---

## 0. 结论

**PASS。**M/E/Z 三族全部独立复核通过,并且用变异测试证明了「这些测试真的抓得住回归」,不是空过绿测。

本报告新增两个测试文件(随本次 QA 提交):

| 文件 | 内容 |
|---|---|
| `packages/v2-engine/src/__tests__/qa-fly1518.test.ts` | 10 例。退役 `commands` outbox 五条保证在纯 actions 下的**独立等价证明**(O1-O6) |
| `packages/v2-actions/src/__tests__/qa-fly1518-advisories.test.ts` | 5 例。advisories A1/A2/A2b/A3/A4 的行为级独立复核 |

独立性原则:实现方的 `conversion-actions.test.ts` 断言的是**接缝自己的返回值**;本报告的用例在**durability 是主张时一律另开一条 kernel 连接读库**,断言的是「已提交的行」,而不是接缝说了什么。

---

## 1. 迁移族(M)—— 独立探针,不复用实现方 helper

用一个独立脚本直接开真 SQLite 文件、跑 shipped 迁移链、读 `sqlite_master` / `PRAGMA`,不经过实现方的 `seedRetiredRows` 与断言:

| 项 | 结果 | 实测证据 |
|---|---|---|
| M1 全新库 0001..0008 | PASS | 8/8 applied;表恰 20 张(逐一列出与设计一致);退役表 0、obligation/command 触发器 0、`obligations_episode_open` 索引已消失;`schema_migrations` 8 行;`foreign_keys=1` 且 `foreign_key_check` 空 |
| M1 弃行回执诚实性 | PASS | 全新链回执 = `{"commands":0,"command_dependencies":0,"obligations":0}`(不是伪造的非零) |
| M2 幂等 | PASS | 第二遍 `applied=[]`;回执行**未**重复(count=1) |
| M3 带数据升级 | PASS | 自行塞入 3 commands / 2 条 `notify_before` 依赖边 / obligations 父行 + `depth=1` 自引用子行 → 0008 干净删除;回执计数**逐字等于**塞入数 `{3,2,2}`;零 FK 违反;FK 重新启用;两个 tombstone 触发器消失 |
| M3 阳性对照 | PASS | 先断言 pre-0008 库**确实**三表俱在,排除「本来就没有所以当然删干净了」的空过 |
| M4 中途失败回滚 | PASS | 注入坏 DDL → 响亮抛错;三表俱在**且数据未失**;两个 tombstone 触发器恢复;**DROP 前已写的弃行回执行随事务回滚**(count=0);台账无 0008 行 |
| M5 备份恢复 | PASS(复核实现方具名用例) | `backup.test.ts` → `restores the pre-0008 database as the active runtime path`。此条我复核了用例存在且通过,**未**另行独立重写 |

---

## 2. 等价族(E)—— 退役 outbox 的五条保证,逐条在纯 actions 上重证

旧 `commands` outbox 给的保证 → 现在由谁给:

| 编号 | 保证 | 独立断言方式 | 结果 |
|---|---|---|---|
| O1 | 外部效果之前先有**持久** intent | 在 `perform` **执行当中**另开连接读库,必须已看到 `state='intended'` 的行 | PASS |
| O2 | 至多一次:崩溃 + 换代重投后不重发 | 效果做完不结算 → `driver.stop()` 模拟崩 → death-evidence 换代接班 → 重跑;`performCount` 必须 =1,actions 恰 1 行且 id 与首次相同 | PASS |
| O2b | 一条消息两个效果互不相撞 | 第一个做完崩,接班后第一个 replay、第二个新做;两个计数各 =1 | PASS |
| O2c | 诚实窗不自动重做 | 效果已发生但**从未写下 outcome**(见下方自查)→ 另开连接确认库里那行确实停在 `intended` 且 `result` 为 NULL → 换代重投返回 `replayed` + `intended`;`performCount` 保持 1(若自动重做即第二次外发) | PASS |
| O3 | 不丢:intent 前崩 | 崩时 actions 0 行、mailbox 未 applied;接班后恰执行一次 | PASS |
| O4 | 结算原子性 | proposal = 一条**合法** event + 一条 FK 非法 task;抛错后 events/tasks 计数不变、mailbox 未 applied 且 `applied_at` 为 NULL、`processing_attempts.outcome` 仍 running;已结算的 action 不受影响 | PASS |
| O5 | 顺序:action outcome 先于消息结算 | converter **故意不 await** `ctx.performAction`;在 action 挂起期间读库,mailbox 必须未 applied;放行后才 applied | PASS |
| O5b | 直接入口同样受闸 | action 挂起时 `driver.submitProposal` / `reportConversionFailure` 均被 `FenceViolation` 拒;await 后可结算 | PASS |
| O6 | 退役表真的没了 | 迁移后的引擎库无三表;任何残留写入 `commands` 会 `no such table` 响亮失败,而不是静默 | PASS |

---

## 3. 变异测试(阳性对照)—— 证明尺子没坏

只跑绿测不能证明测试有效。注入三个真实回归,逐个确认**恰好**杀掉声称守它的用例:

| 变异 | 本报告用例 | 实现方用例 |
|---|---|---|
| 删掉 `submitProposal` / `reportConversionFailure` 的 in-flight 闸 | O5b 红 | 3 例红 |
| `#runLead` 跳过 action drain | O5 红 | 4 例红 |
| `invocationUid` 加随机分量(重投递不再 replay) | O2 / O2b / O2c 红 | 4 例红 |

结论:两套测试都**不是**空过绿测;实现方的 `conversion-actions.test.ts` 同样抓得住这三类回归。变异全部还原,工作树干净。

### QA 自查:一个被我自己抓回来的过度声称

O2c 第一版写成「perform 抛异常 = 效果后崩」,但这**不是** E4 窗口:perform 抛出时
`runRecordedAction` 仍会尽力写一条 `failed` outcome,库里那行是 `failed` 而不是 `intended` ——
测试名声称的东西和它实际验的东西对不上。改成忠实形态:效果执行**当中**被换代夺走写权,
outcome 写入撞 generation fence 落不下去,库里那行才真的停在 `intended` + `result IS NULL`
(用独立连接读已提交状态确认),再验换代重投只返回 `replayed`+`intended`。修正后的 O2c
同样被「invocationUid 不稳定」变异杀掉,证明它现在真的在守这条。

---

## 4. Advisories(A1-A5)独立复核

| # | 断言 | 结果 |
|---|---|---|
| A1 | supersede 重用 predecessor invocationUid → 响亮抛错(不被 replay 静默吞掉),且**不落新行** | PASS |
| A2 | 效果成功但 result 无法 canonical 化(`Date`)→ 行终态化为 `succeeded` + `serialization_error` + `value_kind='Date'`,**不**停在 `intended` 谎称没发生 | PASS |
| A2b | 真 CAS 冲突原样上抛,**不**被伪装成序列化失败;原行状态不被改写 | PASS |
| A3 | 显式传入非 canonical ISO 的 `createdAt` → `TypeError`,零落行 | PASS |
| A4 | 同 effect_key 不同 authorization → `replayed` 返回旧行,旧 authorization **不被覆写** | PASS |

---

## 5. 收尾族(Z)

| 项 | 结果 | 说明 |
|---|---|---|
| Z1a grep-zero | PASS | 独立多形态 sweep:`packages/v2-{kernel,actions,engine,scheduler}/src` 排除 `__tests__/` 与 `migrations/` 后,`commands` / `obligations` / `command_dependencies` / `insertCommand` / `commandKind` **零命中** |
| Z1b allowlist | PASS | 残留引用只在 0001/0002/0008 迁移本体、`obligations-migration.test.ts`(0001..0002 子链)、`migrator-failure.test.ts`、`schema-contract.test.ts` 负断言与迁移测试内 |
| Z2 lint | PASS | 全仓 `pnpm lint` **0 error**;15 条 warning 全在本 PR 未触碰的 `packages/teamlead`,为既存基线 |
| Z2 build | PASS | 全仓 `pnpm -r build` exit 0 |
| Z2 tests | PASS | 见 §6 |
| Z3 文档一致性 | PASS | design-FINAL §1.0 的 20 张表清单与真实 schema **双向零差**;`dispatcher` / `ActionReconciler` / `command_dependencies` / `prepared→executing` / `outbox command` / `consumer_registry` 残留计数全为 0;actions 三态 `intended→succeeded\|failed` 已成文;仅存的 2 处「病历卡」是**否定式**表述(声明该表族已删),正确 |
| A9 横幅 | PASS | FLY-1500 旧 plan 顶部已挂 superseded 横幅并指向 `mapping-v2final.md` |

---

## 6. 测试执行结果

改动波及的四个包全绿:

| 包 | 结果 |
|---|---|
| `flywheel-v2-kernel` | 17 files / 142 tests passed |
| `flywheel-v2-actions` | 3 files / 18 tests passed(含本报告新增 5 例) |
| `flywheel-v2-engine` | 14 files / 117 tests passed(含本报告新增 10 例) |
| `flywheel-v2-scheduler` | 9 files / 35 tests passed |

### 全仓 `pnpm -r --no-bail test`:不冒充全绿,逐条归因

全仓跑完 exit=1。失败集中在三个包,**全部 0 changed files**(`git diff origin/main...HEAD -- packages/<pkg>` 为空),逐条做了对照:

| 包 | 全仓跑失败 | 归因与对照 |
|---|---|---|
| `flywheel-cli` | 1 | **环境**:本会话 `TMPDIR=~/.flywheel/runner-state/<exec>/browser-tmp`,祖先 `~/` 下有 `.flywheel/` → `resolveProjectPath` 向上一定找得到 root,于是不抛。换到 `~/.flywheel` 之外重跑:**95→31 tests 全过**(4 files / 31 tests) |
| `flywheel-comm` | 3 | **负载抖动**:三例都是秒级 CLI 子进程用例(5.5s/5.8s/7.1s)。单独重跑:**95 files / 1279 tests 全过** |
| `flywheel-claude-runner` | 7 | **机器状态**:`claude-profile.test.ts` 会改真实 `~/.claude.json` / profile store,跑之间互相干扰;`scaffold-prune.real-tmux.test.ts` 依赖真 tmux 状态。**origin/main 对照同样失败**(main:1 failed / 2 skipped;branch 隔离跑:5 failed)——同一 test-file 家族,计数随全局状态波动 |
| `flywheel-teamlead` | 41 | **既存 machine-state flake 基线**。同条件隔离对照:**origin/main = 11 files / 28 tests failed**,**branch = 13 files / 31 tests failed**,失败文件集几乎完全重合(`claude-profile-cli.integration` / `createLeadRuntime-preflight` / `fly247-bash-suites` / `quota-pool-rebuild-cli` / `run-dispatcher` / `runs-route-registration` / `workflow-docs-git.integration` / `terminal-thread-archive` / `worktree-quarantine` / `zombie-gate-watchdog` …),逐次运行有波动 |

**诚实结论**:本 PR 波及的四个 v2 包 **100% 绿**;仓内其余失败在 `origin/main` 上同样存在、且都落在本 PR 一行未改的包里,判定为既存环境/机器状态问题,不是本次回归。**我没有把全仓测试报成"全绿"。**

一个 QA 自身的教训留档:我第一次"修"环境时把 `TMPDIR` 指到了 139 字节的 scratchpad 长路径,反而触发 `claude-runner` 的 `SUN_LEN (103)` unix socket 上限、制造出 4 个假失败。换 `/tmp/qa1518`(11 字节)后消失。控制环境本身也会造假信号。

---

## 7. 尚未由本报告覆盖的部分(诚实边界)

- **M5 备份恢复**:复核了实现方具名用例存在且通过,**没有**另写一份独立实现。
- **生产真机**:本单是 v2 上线**前置**,v2 引擎此刻尚未接线,`commands` 无生产数据 —— 因此没有、也不可能有生产库上的真机验证。0008 的生产执行纪律以 design-FINAL §4 的恢复 runbook 为准(quiesce → 验证备份 → 跑 0008 → 核对 20 表/8 条 ledger/零 FK → 再部署配对代码)。
- **E4 诚实窗的产品语义**:O2c 锁死的是「不自动重做」这一 founder 已接受的语义;窗内到底发没发出去,系统按设计**不知道**,需外部证据 + 显式 supersede。这是设计选择,不是缺陷。
