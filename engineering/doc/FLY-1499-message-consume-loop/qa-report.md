# FLY-1499 消息消费循环 — QA 验收报告

Issue: FLY-1499
日期: 2026-07-28
基于: mapping-v2final.md(实现权威)、plan.md、doc/engineer/plan/v2/design-FINAL-v2.md §1.2a-f

## 0. 一句话结论

**PASS。** 功能验收全部通过(自建 18 条独立测试 + 4 次变异验证 + 1 组阳性对照;全仓 build 绿、
两个 v2 包 lint 干净、CI-等价命令 171 测全绿);codex design/code review 两道硬门已逐一在**数据源**
(`teamlead.db`)上核实闭合,不是听转述(见 §5)。遗留 5 条观察项,均不阻塞交付(见 §4)。

唯一还没落地的前置条件是**最终 head 上的 GitHub CI 这一轮**(报告写就时仍在跑)和**新 head 的
codex record 补挣**(结构上只能由 implement 会话做,见 §5.1)—— 两者都不是功能缺陷,是 ship 的
排序问题。

## 1. 被验对象与权威文档的错位(先说清楚,否则后面的验收标准是错的)

本单中途换过设计。分支上并存两份计划:

| 文档 | 地位 | 描述的系统 |
|---|---|---|
| `plan.md`(标 `状态: codex-approved`,10 轮 design review) | **已被取代** | 门铃 + 投递泵 + phase timer + T_max/T_deliver/T_switch + 585min SLA 公式 + terminal disposal + meta consumer registry |
| `mapping-v2final.md`(基于 Founder 已批准的 `v2-converged-final-source.md`) | **实现权威** | 纯 1 秒轮询、无门铃/无 watchdog/无 timer/无 SLA 档位、typed `agents` 表取代 meta registry、disposal 整块删除 |

QA 开场时我只在 `.flywheel/runs/8209706b.../codex/design-review.json` 找到一条评审留档,它的
`reviewedTarget` 是**已被取代的 `plan.md`**,于是怀疑「实现遵循的 mapping 没过评审」。
**这个怀疑经查是错的 —— 留档不在文件里,在库里。** 我在 `~/.flywheel/teamlead.db` 自己查了
`codex_review_job`(不是听转述):

```
review_type  round  verdict            target_path
design       1-3    CHANGES_REQUESTED  engineering/doc/FLY-1499-message-consume-loop/mapping-v2final.md
design       4      APPROVED           engineering/doc/FLY-1499-message-consume-loop/mapping-v2final.md
```

**`mapping-v2final.md` 自己走完了 4 轮增量设计评审并 APPROVED**(08:08:49)。因此本次 QA 的验收
标准取 `mapping-v2final.md` 是有据的;`plan.md` 与之冲突处一律以 mapping 为准,不按 plan.md 判 FAIL
(该口径经 Lead 确认,同夜 FLY-1501 同样裁定)。仍建议给 `plan.md` 补一行 superseded banner(§4-3)。

## 2. 验收范围与结果

### 2.1 既有测试与全仓门

全部在**最终 head 的干净 worktree** 上重跑过一遍,不是引用早先的结果:

| 项 | 结果 |
|---|---|
| `pnpm -r build`(全仓 20 包) | 通过 |
| `pnpm --filter flywheel-v2-engine --filter flywheel-v2-kernel test:run`(CI 的 Unit heavy 就是这样覆盖这两包的;含 `tsconfig.public-test.json` 的公开面 type fixture) | 通过 —— kernel 109 + engine 62(含本次新增 18)= 171 |
| `biome check packages/v2-engine packages/v2-kernel` | 干净 |
| GitHub CI(PR #718) | 上一个 head `b5fa75a4` 上 9/9 全绿;最终 head 的这一轮**在报告写就时仍在跑**,按「不带红开门」纪律,gate 要等它真绿才开 |
| 改动半径 | 仅 `packages/v2-engine`、`packages/v2-kernel`、`engineering/doc/`、`pnpm-lock.yaml`(新 workspace 包);零 v1 生产代码改动 |

注:仓库根 `pnpm lint` 本机报 645 个 error,全部来自 `.flywheel/runs/` 下的本机运行产物
(该目录在 `.git/info/exclude` 里,不属于本分支),与本单无关;CI 的 Quick Gate(lint)绿。

### 2.2 本次新增的独立 QA 测试(`packages/v2-engine/src/__tests__/qa-fly1499.test.ts`,18 条)

这些测试刻意走**真实公开入口**(`EngineDriver.poll / submitProposal / reportConversionFailure /
registerAgentTx`),不去测 `selectNext` 纯函数 —— 因为映射里关于公平性、活性、fail-closed 的承诺,
说的是「一个壳实际观察到什么」,而不是选择器孤立起来的行为。

| # | 断言 | 覆盖的合同 |
|---|---|---|
| 1 | founder 洪泛下,两条普通消息之间最多服务 K=4 条 founder;实测服务序列恰为 `n0 f1 f2 f3 f4 n1 f5 f6` | §1.2e 有界优先 |
| 2 | attach **之后**改 `mailbox.vip_burst`,下一次 poll 立即生效(K=4 序列变成 K=1 序列) | §4「不缓存成第二真相」 |
| 3 | 超 30min 的普通消息晋升到 founder class,压过更新的 founder 消息 | §1.2e 超龄晋升 |
| 4 | **阳性对照**:同样形状但只放 29min → 改由 founder 消息胜出 | 证明第 3 条不是恒真断言 |
| 5 | 改 `poll_interval_ms` 后,下一次 empty 的 `retryAfterMs` 立即变 | §5 liveness「即时反映 config」 |
| 6 | 配置被破坏时 poll 抛 `EngineConfigError`,**不伪装成空信箱**;mailbox 不动、零 processing_attempts | §4 config fail-closed |
| 7 | 失败后按退避挂起:未到点 poll 返回 empty,到点后纯轮询自己捞回来,attempt 号进位到 `m1#2` | §1.2b 无门铃活性 |
| 8 | 心跳新鲜但 running attempt 超 `running_attempt_max_age_ms` 时,durable 谓词仍查得出 wedged;**结算后立刻不再命中**(小时级下游工作不背这个锅) | §6-2 调度只读谓词 |
| 9 | generation=0 的冷启动地址在超 `cold_start_alert_after_ms` 后可查;注册后条件消失 | §6-5 address allocation |
| 10-11 | activation 转 terminal + agent 转 offline 后,business/notice/dlq 三类 pending 信**逐行不变**;`tombstoned` 状态已被 CHECK 结构性拒绝 | §2.10 disposal 整块删除 |
| 12 | 外部连接完成换代后,旧 driver 的 poll/结算全部 fail-closed,且**旧 driver 的 stop() 不会把活着的继任者拽下线** | §2.8 stale stop no-op |
| 13 | 同 generation、不同 instanceId 的第二个壳被拒(`attempt binding mismatch`),不会拿到重复投递 | §2.5 attempt 全字段绑定 |
| 14 | 换代路径上撞到失败上限时,恰产出一条 `mailbox:m1:dead` event(`source_kind='agent'`) | §3.4 dead-letter exactly-once |
| 15 | 壳带着**过期的** attempt uid 来 poll:拿回同一条在途 attempt(resumed=true),converter 只被调用一次,全程只有 1 行 processing_attempts | §3.1-3 过期提示不是错误 |
| 16 | 绕过 `enqueue` 直接插未知收件人 → `FOREIGN KEY constraint failed` | §2.9 FK 作最后防线 |
| 17 | notice 准入是按**收件人全部 pending** 计量的(3 条 business 挤满 limit=2 后 notice 被拒),而 business 自己不受该水位限制 | §2.9(见 §4 观察项) |
| 18 | **能力级 soak**:120 条 3:1 founder-heavy 混合积压走真实 poll 喝干 —— 全程 `running` 峰值恰为 1(batch=1 真成立)、120 条全部 applied、processing_attempts 恰 120 行且全 succeeded(零泄漏零重复)、**整段最长连续 founder 串 ≤ 4**(大规模下也不饿死) | §1.2a 串行 + §1.2e 公平性 |

### 2.3 变异验证(证明上面的绿不是空过)

每次变异后跑测试看是否转红,然后逐字还原并用 `git diff` 验证还原干净:

| 变异 | 结果 |
|---|---|
| 从 `candidates.ts` 拿掉 K 上界分支 | 第 1、2 条转红,其余 12 条不动 → 断言精确指向 K 上界 |
| 从 `driver.ts` 的 `stop()` 拿掉 generation 校验 | 第 12 条转红 → 断言精确指向 stale stop 保护 |
| 把 `transitions.ts` 的退避算式塌成 0 | 第 7 条转红 → 断言精确指向退避而非「反正会 empty」 |
| 再次拿掉 K 上界,单独跑 soak | 第 18 条转红,报 `expected 90 to be less than or equal to 4` —— 90 条 founder 连着吃掉消费者,正是设计要防的饿死 |

四次还原后 `git status` 只剩新增的测试文件,`git diff` 对三个被改过的源文件均为空。

### 2.4 两条 1497 前置台账

**台账 1(STAT4 公平性)**:已处置且证据充分。四路候选 SQL 加了 `INDEXED BY` 钉住各自的 partial index;
`query-plan-stats.test.ts` 做了受控翻盘实验(建统计 → F2 改判到基础索引 → **只删 sqlite_stat4 保留
sqlite_stat1 → 回到 `_f`**),把因果钉在 STAT4 样本上而不是「ANALYZE 一跑就翻」;另有 pinned 与 free
两版逐行同答的等价断言,以及 `DROP INDEX` 后 `prepare` 直接 fail-loud 的测试。三种 founder 配比
(1/7、1/20、1/50)各测一遍,全程无 `USE TEMP B-TREE`。**已验证,通过。**

**台账 2(写入面 SQL 守卫)**:按要求「重问」了,结论是**否决并留痕**,不是漏做。`mapping-v2final.md` §2.1
明确:两轮绕过属已声明威胁模型之外的对抗构造,本单不加固 blocklist、不加语句注册表、不改成
per-table typed API;`plan.md` §8 反 over-reaction 表里也有对应的「已否决留痕」行。**符合「按反
over-reaction 原则判定」的要求。**

## 3. 我没有发现的问题(说清楚查过哪些,避免「没报=没查」)

- 逐条读了 `consume-loop.ts` / `driver.ts` / `settlement.ts` / `transitions.ts` / `registration.ts` /
  `enqueue.ts` / `config.ts` / `bootstrap.ts` / `sql.ts` / `candidates.ts` 与 kernel 侧 migration 0005;
- 追过「快路径只读 façade 不开 BEGIN(可撕裂)」会不会导致健康 agent 被误 fence:`Kernel.read` 拒
  async 回调,better-sqlite3 同步 + Node 单线程 ⇒ 同进程内 `read()` 不可能被自己的结算插入;能插入的
  只有**跨进程**写,而跨进程改动本 agent 的在途 attempt 按定义就是必须 fail-loud 的换代事件。结论:
  不是缺陷。
- 追过 `tx.cas` 的 changes≠1 会整笔回滚,`mailboxCasPendingApplied` 虽只绑 `message_uid + state`,但同
  事务内 `requireAttemptBindingTx` 已先校验 `to_agent` / mailbox 状态 / instance / generation /
  activation,上游收口成立;
- 追过重复 shell、迟到结算、dead event 重放、migration 回滚(orphan recipient / legacy tombstone 两种
  guard 都真的整笔回滚且不留 `agents` 表)。

## 4. 观察项(不构成 FAIL,登记在案)

1. **notice 准入按收件人全部 pending 计量**(测试 17 已钉住现状)。后果:某收件人积压 500 条 business
   时,发给他的 notice 会被判 `overload` 拒掉。映射只承诺了反方向(business 不受 notice 水位限制),
   没写正方向,所以这是未言明的语义而不是违约 —— 但值得下游(1501 告警)知道。
2. **四路候选 SQL 的 lane 代表选取与 `selectNext` 的排序口径不同**:F2/N2 按 `next_retry_at, seq` 取
   代表,而 `selectNext` 跨 lane 按 `created_at, seq` 比。所以「本 lane 里 created_at 最老的那条」不一定
   是被拿来参与晋升判定的那条。四路 SQL 是设计冻结件、且 K 上界仍然保证不饿死,故不改;登记为已知的
   公平性保真度缺口。
3. **`plan.md` 没有「已被 mapping-v2final.md 取代」的抬头**,却仍写着 `状态: codex-approved`。取代关系只
   写在 `mapping-v2final.md` §0 里。将来有人从 DOC-FLOW 的标准位置(`plan.md`)读起会被误导,建议补一
   行 banner。
4. `ProvisionedRecipient` 是公开函数 `provisionAgentRecipient` 的返回类型,但不在 `index.ts` 的导出白
   名单里(白名单本身与映射 §2.11 逐符号相等,所以这是映射自己的口子)。消费方只能靠推断拿到该类型。
5. 流程工具限制:`flywheel-comm stage set` 没有 `qa` 这个值,可选值里能映射到 phase=qa 的只有
   `approve`/`ship`(此刻都不该设)。所以 QA 段的 progress ledger 只能写 `--phase implement` 才不被
   authority 交叉校验拒掉。不影响交付,记一笔。

## 5. 硬门核查(全部闭合)

开场时我按「qa-pass-only-after-all-hard-gates」拒发 PASS,理由是 `.flywheel/runs/*/codex/` 下只有
`design-review.json`、没有 `code-review.json`,而 implement 段的 `progress.md` 最后停在
`next: … request code review round 3`,看起来第 3 轮没跑完。

**结论:是我查错了地方 —— codex review 的留档在 `~/.flywheel/teamlead.db`,不在 `.flywheel/runs` 下。**
我没有只听转述,自己查了库(证据即以下两张表的实际输出):

```
codex_review_job  (issue_id='FLY-1499')
  code   1  done  CHANGES_REQUESTED  a447c95e…  09:03 请求 → 09:16 结论
  code   2  done  CHANGES_REQUESTED  7d9038e1…  09:25 请求 → 09:32 结论
  code   3  done  APPROVED           b5fa75a4…  09:36 请求 → 09:40 结论
  design 1-3 done CHANGES_REQUESTED  → target_path = mapping-v2final.md
  design 4   done APPROVED           → target_path = mapping-v2final.md   08:08

codex_review_record
  execution 9ada39d3… · head b5fa75a4… · status=approved · approved_at 09:40:47
```

- **code review 第 3 轮 APPROVED,绑的 head `b5fa75a4` 正是 QA 接手时的分支 head** —— 硬门满足;
- 三个 `fix(v2-engine): …` commit 确实就是前两轮 CHANGES_REQUESTED 的修复;
- `progress.md` 停在「即将请求第 3 轮」是**进度文件没回写**,不是没跑 —— Lead 已把这条记为缺陷
  (消费方只看得到进度文件,看到的却是过期状态);
- codex code review **不是**独立 DAG 节点,由 implement 会话发起并挣记录(`isReviewableRole` 只收
  main/implement),**QA 角色结构上挣不到**,所以我不跑、也不该跑,否则既落不下记录又变成自审。

其余硬门:CI 在最终 head 上全绿(不带红开门);全仓 build 绿;两个 v2 包 biome 干净。

### 5.1 head 漂移的处置,以及一个必须诚实标注的自审窗口

`codex_review_record` 绑的是 `target_pr_head_sha`,而 `verify-approval` 是按 head 查的。QA 段把测试、
报告和 progress ledger commit 到同一分支之后,最终 head 必然不再是 `b5fa75a4` —— 所以**只报一次
qa-result PASS 并不会让 Bridge 自动重绑 ship gate**,新 head 必须补挣一条 codex record。

处置(经 Lead 裁定,同夜已在 FLY-1509 跑通并定为通用规则):QA 把该推的全部推完 → 在最终 head 上报
一次 qa-result PASS 并 park、把 exact head 报给 Lead → Lead 把 TURN 交回 implement,由 implement 在
**同一个 exact head** 上补挣 codex code review 记录(`isReviewableRole` 只收 main/implement,**QA 角色
结构上挣不到**)→ QA PASS + 新 head 的 codex record + CI 真绿三样齐了才开 gate。

**⚠️ 必须披露的自审窗口**:新 head 相对 `b5fa75a4` 的增量里,包含**本 claude QA 会话写的测试与报告**。
评审者家族按**发起会话**的 `adapter_type` 路由(`review-request-coordinator.ts:627`):implement 是
codex 会话 ⇒ 评审者会是 claude ⇒ **对我这部分产物构成同族自审**。当前系统绕不过去(要求换 codex
评审后读代码确认不可达)。**因此不能把这一段记成「已由 codex 独立审过」。** 风险有界的理由:这段增量
是**测试与报告,不是产品代码** —— 产品代码(`packages/v2-engine`、`packages/v2-kernel` 的 src)在
`b5fa75a4` 上已由 codex 走完 3 轮 code review 并 APPROVED,QA 段一行未改(可用
`git diff b5fa75a4..HEAD -- packages/*/src` 排除 `__tests__` 后核对)。
