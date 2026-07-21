# FLY-1385 死 exec 楔死 DAG node — QA 验证报告
Issue: FLY-1385
日期: 2026-07-21
基于: plan.md(codex-approved,design review 11 轮)

**最终结论:PASS**(第 3 轮,head `3de114247`;含 founder 增量 A 加强版护栏)。

- 第 1 轮 FAIL:重试 backoff 把 UTC 时间戳当本地时间解析,生产机上重试被推迟约 7 小时(§1 存档)。
- 第 2 轮 PASS(head `5e4035c08`):修复复验通过(§0)。
- 第 3 轮 PASS(head `3de114247`):founder 裁定的增量护栏(可在线直切的 kill switch + 误判绊线)复验通过(§0.5)。
  这一轮同时把第 1 轮 §4 遗留项 1(sweep 无 kill switch)真正消解了。

---

## 0.5 复验(第 3 轮,2026-07-21,head `3de114247`) — founder 增量 A 加强版

**背景**:第 1/2 轮我把「sweep 没有关闭开关、且这段会改生产 DAG 账」列为遗留项交给 Annie 拍板。
Annie 裁定补护栏,实现方交付了这一轮(plan §7、founder-design-draft「追加安全护栏」)。

**增量做了两件事**:

1. **可在线直切的 kill switch**:`FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP` **default ON**,
   `workflow-engine-dispatcher.ts:133` 每次 reconcile tick **现场读取**(不在构造时缓存),
   控制台改 env 后同一 dispatcher 下一 tick 立即生效、不需重启 Bridge。OFF **只**暂停新的
   死亡判定/换人,已持久化的告警与仍在运行的绊线 watch 不受影响。
2. **误判绊线(tripwire)**:每次判死换人时,在**同一个 rollback 事务**里登记一条绑定旧
   execution 身份的 durable watch(`StateStore.ts:16774`,与 node 易主同事务,不会单独丢失)。
   基线只用不会串到替补 runner 的信号(launch-commit marker mtime、session commit_count、
   该 execution 的 CommDB 写游标、其**原** tmux target 输出摘要)。之后任一游标前进 ⇒ 判定
   前一次死亡是**已证实的误判** ⇒ 恰一次 severe 告警,**同时**发 Lead escalation
   (`workflow_engine_escalation`)与 issue-thread(`workflow_engine_issue_alert`)两路。
   同一 run/node/attempt 第二次及以后死亡换人 ⇒ 另发 `repeated_dead_execution_pattern`。

**验证证据(证据驱动,非读代码定论)**:

| 检查 | 结果 |
|---|---|
| kill switch 每 tick 现场读取(OFF→ON 同 instance 生效) | 突变「拆掉 flag 门,永远跑 sweep」→ **红** |
| tripwire 恒跑(即使 sweep OFF) | 突变「关掉 tripwire reconcile」→ **红** |
| repeated-pattern 只在第 2 次死亡起触发 | 突变「首次死亡也触发」→ **红** |
| issue-thread 告警不能只发 Lead 那一路 | 突变「丢掉 issue-thread 那份 alert」→ **红** |
| patrol 分页有界、201 条不饿死第 201 条 | 突变「冻住 patrol cursor」→ **红** |
| 无 session row 时告警仍到 thread | 身份从 watch 行持久化的 `issue_id` 取,不依赖 session;`wf:{runId}` 不当 execution id(§0.5 路由核查) |
| alertSink 生产已填(否则告警静默滞留 outbox) | `plugin.ts:9087` holder 填充 + `:9088` boot one-shot 补发,新告警走同一已填 holder |
| flag registry 声明 call-time + direct proof | `registry.ts` `engine_dead_exec_sweep`:default_on / kill_switch / call_time / toggleable:direct / directToggleProof |
| 附带改动(LeadAlertNotifier/LeadWatchdog/infra-event-router/kind-contract) | 全为配套新事件类型贯穿,无 scope 蔓延;`workflow_engine_issue_alert` 正确进 `ISSUE_PROGRESS_KINDS`、escalation 那条不进(两路分开) |
| FLY-1385 相关 + 邻接套件(8 文件) | **111/111 全绿** |
| PR #662 CI(head `3de114247`) | **9/9 全绿**(含此前被预算封顶的聚合门 CI OK) |
| code review 记录 | `approved`,绑定 head `3de114247` |

本轮 tripwire 突变 5/5 全被抓 + 第 1/2 轮 W1 核心突变 8/8 全被抓,新代码测试非空过。

---

## 0. 复验(第 2 轮,2026-07-21,head `5e4035c082b33e9`)

## 0. 复验(第 2 轮,2026-07-21,head `5e4035c082b33e9`)

**修复**:`workflow-engine-dispatcher.ts:362` 改用仓库既有的 `parseSqliteUtcMs()`
(`bridge/founder-notify-utils.ts`)替代裸 `Date.parse` —— 该 helper 把
`YYYY-MM-DD HH:MM:SS` 的空格换成 `T` 再补 `Z`,按 UTC 解析。
`Number.isFinite(x)` 相应改成 `x !== null`,不可解析时仍然跳过守卫(fail-open 语义未变)。
方向正确:`parseSqliteUtcMs` 本就是本仓读 SQLite 时间戳的既有约定
(`detection-gap-scan.ts`、`detection-reconcile-tick.ts` 都在用),不是新造的东西。

**验证证据**:

| 检查 | 结果 |
|---|---|
| TZ 钉 `America/Los_Angeles` 的回归测试 | **绿**(第 1 轮为红) |
| 把修复退回成 `Date.parse` | **红**,且恰好只红这一条 —— 证明测试仍真的在守它,不是空过 |
| 突变「删掉整个 backoff」(`delay = 0`) | **红** —— 第 1 轮此突变为绿(空过),缺口确认闭合 |
| bug class 重扫 | 全仓生产代码已无对 DB 默认时间戳列的裸 `Date.parse`,无第二处漏网 |
| FLY-1385 相关 + 邻接套件(8 文件) | **110/110 全绿** |
| PR #662 CI | 9/9 全绿 |
| code review 记录 | `approved`,绑定 head `5e4035c08` |

§4 的两个遗留项(无 kill switch、teardown fact 已强证仍跑探针)**状态不变**,
仍建议 ship 前由 Annie/Tadashi 就第 1 项表态。

---

## 1. 第 1 轮阻断缺陷(已修复,分析存档) — 重试 backoff 把 UTC 时间戳当本地时间解析

**位置**:`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:361`

```ts
const launchedAt = Date.parse(latest.created_at);
if (Number.isFinite(launchedAt) && this.now().getTime() - launchedAt < delay) {
    continue;   // ← 跳过重试
}
```

**根因**:`latest.created_at` 来自 `workflow_side_effect_ledger`,该列是
`created_at TEXT NOT NULL DEFAULT (datetime('now'))`(`StateStore.ts:18982`)。
SQLite 的 `datetime('now')` 产出的是 **UTC 瞬时**,但渲染成 `YYYY-MM-DD HH:MM:SS`
——没有 `T`、没有 `Z`、没有任何时区标记。`Date.parse` 遇到这个形状按 **本地时间** 解释。

实测(本机 = 生产机,TZ=America/Los_Angeles):

| 值 | 结果 |
|----|------|
| ledger 里的原始 `created_at` | `2026-07-21 08:56:21` |
| `Date.parse` 解出来的时刻 | `2026-07-21T15:56:21Z` |
| 它真正代表的时刻 | `2026-07-21T08:56:21Z` |
| 偏差 | **+7 小时**(PDT;PST 时为 +8) |

**后果**:launch 看起来发生在 7 小时之后,于是 `now - launchedAt` 恒为 **负数**,
对任何一档 delay 都满足 `< delay` → 每一秒的 sweep 都 `continue`。
死 exec 要等 **约 7 小时**(时区偏移 + 该档 delay)才会被重试,而不是 1 分钟。

事故当晚 FLY-1335 是 ~50 分钟无重试;带着这个缺陷上线,同样的场景会变成
**约 7 小时无重试** —— 症状比修之前更久,而不是被修好。

**为什么 CI 全绿**:GitHub Actions Linux runner 默认 UTC,偏移为 0,算式恰好正确。
这正是 [生产=Mac / CI=Linux 平台盲区] 那一类。
现有那条 dispatcher 死 exec 测试之所以通过,是因为它把假时钟设在
`2026-07-22`(比真实墙钟晚一天),差值大到把 7 小时偏移淹没了 —— 它从来没有断言过
「多久之后允许重试」。

### 判别实验(证明根因就是时区解析,而非别的原因)

同一条新测试,只改 TZ 一个变量:

| TZ | 结果 |
|----|------|
| `America/Los_Angeles`(生产) | **FAIL** —— launch 后 61 秒仍未重试 |
| `UTC`(CI) | **PASS** |

### 复现/回归测试

`packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts`
→ `spaces replacement launches by the 1/5-minute retry ladder in a non-UTC zone`

该测试把 TZ 钉在 `America/Los_Angeles`,所以修好之前它在 **任何** 宿主上都会红(包括 UTC 的 CI),
不再依赖开发者本机时区才能暴露问题。当前状态:**红**(第一档 61 秒处未发生重试)。

### 修复方向(供实现方参考,未代改)

把 ledger 时间戳按 UTC 解析,例如 `Date.parse(created_at.replace(" ", "T") + "Z")`,
或让写入方显式写 ISO-8601 带 `Z`。**建议同时**给该列的读取加一个统一的解析辅助函数,
避免以后再有第二处踩同一个坑。

**波及范围已扫过**:全仓生产代码中,对 `datetime('now')` 默认值列做时间运算的
**只有这一处**(48 张表用了该 DEFAULT,但没有其它地方对它做算术)。
本次新增的 `workflow_alert_outbox.created_at` / `lease_expires_at` 由调用方写入
ISO 串,不受影响。缺陷局限在本分支新增的代码里。

---

## 2. 补齐的测试覆盖(已随本报告提交)

审计发现 3 处「删掉守卫、测试照样全绿」的漏测。已补测试并逐条用突变验证过
(补测试之前删守卫 → 绿;补测试之后删守卫 → 红)。

| 补的测试 | 覆盖什么 | 为什么重要 |
|---|---|---|
| `workflow-template-selection.test.ts` ×2 —— 影子 run probe 为 `alive` / `unknown` 时拒绝接管 | W3 supersession 的**安全方向** | 只有「成功接管 quiescent 影子」这条正向被测。把 `shadow_run_live` 守卫整段删掉,唯一测这条路径的文件仍 19/19 全绿 —— 也就是说「不许终结还活着的影子」当时没有任何测试兜底。误终结会把还在干活的 runner 的 run 判死,并让第二个 runner 接管同一个 issue |
| `workflow-dispatch-seams.structure.test.ts`(新文件,7 条) —— 生产 admission 调用方清单快照 | W6 三 seam(plan §3 W6 + §4 第 8 条明确要求) | plan 点名要的结构守卫当时不存在。现在断言恰好 3 个生产调用点,且每个都「先解析 dispatch 再 admit、admit 之后只读 durable runtime」。突变验证:注入第 4 个调用点 → 立刻报警 |
| `workflow-engine-dispatcher.test.ts` ×1 —— 重试梯子的**间隔** | W1.2 backoff 1/5/15 分钟 | 见上文缺陷。原先只测了「上限 3 次」,完全没测「多久之后才允许重试」。这条测试正是暴露阻断缺陷的那条 |

上述两条影子测试与 seam 清单测试当前 **全绿**(是漏测,不是 bug)。第三条 **红**(是真 bug)。

---

## 3. 验过没问题的部分

- **1335 型验收(引擎自动重试死 exec)**:走真实 `dispatcher.reconcile()` 循环,
  终态 session + dead 探针 → 分配新 execution、node 易主。逻辑正确。
  **但触发时机被缺陷 1 推迟约 7 小时** —— 功能对、时机错。
- **1356 型验收(影子 run 不再占锁)**:quiescent 影子在 `/start` 时被原子终结,
  engine run 同事务 materialize,一个 issue 的 active 槽位被正确释放。**通过**。
- **突变验证**(每条都确认测试会红,非空过):
  sweep 整段关掉 / liveness 守卫拆掉 / quota-auth 分类关掉 /
  output 守卫拆掉 / 重试上限拆掉 —— **5/5 全被现有测试抓到**。
  这部分测试质量是扎实的。
- **sweep 无 flag 门控**:每秒 reconcile 内恒跑,不存在「代码合了但没生效」。
- **CI**:PR #662 全部 9 个 check 绿(见下方遗留项 1 对此的说明)。

---

## 4. 遗留项

1. ~~**没有 kill switch**~~ —— **第 3 轮已解决**(head `3de114247`)。Annie 裁定后实现方补了
   `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP`(default ON、每 tick 现场读取、控制台可在线直切),
   OFF 立即暂停新的死亡判定/换人且无需重启。误判风险另加 tripwire 兜底(见 §0.5)。复验通过。
2. **W1.2 即使已有 durable teardown fact(死亡已强证)仍会跑一次探针**(非阻断,存档)。
   与 plan 流程图的「已强证 → 跳过探针」分支不一致。方向是更保守(探针说不准就不动账),
   不影响正确性,但与 plan 文字有出入。

---

## 5. 测试执行记录

```
第 1 轮(head 96220cfa3):相关套件 5 文件 → 73 passed | 1 failed (74)
  唯一 failed = 阻断缺陷的回归测试(预期红)
第 2 轮(head 5e4035c08,修复后):相关 + 邻接套件 8 文件 → 110 passed (110)
第 3 轮(head 3de114247,含 tripwire 增量):相关 + 邻接套件 8 文件 → 111 passed (111)
  外加 config registry 23 + comm db 95 全绿
lint:改动文件 biome check 干净;PR #662 CI 9/9 绿(三轮)
```

全包 8923 条测试跑过基线与突变多轮;本机有约 57 条既有的环境相关失败
(real-tmux / real-git / 集成类),与本分支无关 —— 各轮同样存在,已作为噪声基线扣除。

---

## 6. 结论

三轮复验后本单转 **PASS**:阻断缺陷(时区解析)已修,founder 增量护栏(可在线直切的
kill switch + 误判绊线)已交付并复验通过,原先唯一的遗留项(无 kill switch)随之消解。

QA 补的测试原样保留:TZ 钉死的 backoff 回归测试持续守住时区坑
(它在 UTC 的 CI 上同样会红,不依赖开发者本机时区才暴露);
影子 supersession 的两条拒绝测试与 W6 seam 清单守卫补上了原本删守卫也不会红的空档。

剩一个非阻断的存档观察:§4 第 2 项(死亡已强证时仍多跑一次探针),方向更保守,
不影响正确性,交给实现方后续按需收敛即可,不阻断 ship。
