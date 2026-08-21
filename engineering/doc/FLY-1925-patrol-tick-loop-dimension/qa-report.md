# FLY-1925 patrol_tick 名册加「圈」维度 — 独立 QA 报告

Issue: FLY-1925 (https://linear.app/geoforge3d/issue/FLY-1925/巡检tick-patrol-tick-名册加圈维度每-run-附当前节点棒持有者开圈状态-让有人在等不存在的圈直接印成红灯founder)
日期: 2026-08-20
基于: plan.md(同文件夹)、PR #903 @ 902e1988

---

## 0. 判词

**FAIL** —— 一条硬门缺陷(CI 红,且归因确定在本分支),外加一条真实数据上的可用性缺陷。
被测逻辑本身没有发现正确性错误;失败点是「改动打断了一条既有的跨语言契约守卫」和
「主交付列在生产真实数据上有约 90% 渲染成不可读哈希」。

被测 head: `902e1988303d7368e8fcd91a4a5cabee6869608b`(= PR #903 head,verdict 前复核一致)。

| 门 | 结果 |
|---|---|
| `pnpm -r build` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0(8 条既有 warning,非本分支新增) |
| 本卡定向单测(teamlead 5 文件 57 例 + flywheel-comm 3 例) | ✅ 全绿 |
| **GitHub CI(`gh pr checks 903`)** | ❌ **红** —— `Script Tests 2/2` 失败,`CI OK` 失败 |
| 真机 529 隔离房 E2E | ✅ 真 Bridge 跑被测 head 印出红灯正文;并有 main 同房同种子的 BEFORE 对照(§3、§3.1) |
| 生产真实数据回放 | ⚠️ 零误报,但暴露 §2.2 与 §4.1 两条 |

---

## 1. 我实际做了什么(每条都可复跑)

1. **真实生产 schema 校验** —— 把 6 条新增 StateStore SQL 逐字拿到只读打开的**生产** `~/.flywheel/teamlead.db`
   上 prepare + execute,再用真实活跃 run 的参数跑一遍。6/6 全部成立,返回真行。
2. **join 键核对** —— 确认 `sessions.issue_id` / `workflow_run.issue_id` / `land_operation.issue_id` /
   `three_stage_turn.issue_id` 在生产里都是 Linear identifier 形态(如 `FLY-1934`),不存在
   identifier↔UUID 错配(那会让 run 查询恒空 → 结构性假红)。
3. **生产数据整盘回放** —— 用生产 `teamlead.db` + `comm/flywheel/comm.db` 的离线快照,经**真实**
   `StateStore.getPatrolRosterSessions` → `collectPatrolLoopEntries` → `formatPatrolTick`
   跑当刻的真名册(12 个 session / 11 个 issue):**11 个 not_triggered,零红灯,零 unknown**。
   渲染出的名册见 §5 附录 A。
4. **事故回放** —— 把 founder 当晚点名的 1855/1859/1887 三单,从生产账本逐行读出 06:44 时刻的
   真实状态,喂进**编译产物里的真** `judgeLoopLight`(§2.2)。
5. **真机 529 隔离房 E2E** —— 从被测 worktree 起 slot 2,`/health` 核 `buildSha == 902e1988`,
   在 slot 自己的 `teamlead.db` + `comm/test-slot-2/comm.db` 里造「体在 turn-poll + 无开圈」形态,
   真 Bridge 的 GatePoller rider 自己铸出 `light: "red"` 的 tick 并渲染成 Lead 正文(§3)。
6. **对抗渲染** —— 换行/指令词注入、非法数值、旧 payload 回放(§4)。
7. **性能** —— 真 480MB comm.db 上 `readPatrolTurnSnapshot` 0.2–1.8ms;
   12 session 全量 `collectPatrolLoopEntries` 冷 96ms / 热 3.3–7.8ms;无事件循环风险。

---

## 2. 阻塞项 / 主要发现

### 2.1 🔴 BLOCKER — CI 红:改动打断了 FLY-1330 的跨语言契约守卫

`scripts/__tests__/flywheel-log-janitor.test.sh:876-885` 用 `sed` **从
`packages/teamlead/src/StateStore.ts` 的源码里逐字抽取** `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`
的字面量数组,和 janitor shell 里的 `terminal_session_status()` 做对齐校验。

本分支把这个常量搬到了新文件 `packages/teamlead/src/workflow-ledger-states.ts`,
`StateStore.ts` 只剩 re-export ⇒ 抽取结果变成空串 ⇒ 守卫(它是 fail-closed 的)判否。

CI 原文(job 96513174284):
```
[TEST] Case: shell terminal statuses stay in parity with StateStore
[TEST] ✗ terminal-state parity drifted (ts= shell=completed|failed|terminated|blocked|rejected|deferred|shelved)
[TEST] flywheel-log-janitor: 24 passed, 1 failed
##[error]Process completed with exit code 1.
```

**归因证据(同一段未改动的抽取脚本 × 两个 head)**:

| 被抽取的文件版本 | `ts_statuses` |
|---|---|
| `origin/main:packages/teamlead/src/StateStore.ts` | `completed\|failed\|terminated\|blocked\|rejected\|deferred\|shelved` |
| 本分支 `packages/teamlead/src/StateStore.ts` | *(空串)* |
| 本分支 `packages/teamlead/src/workflow-ledger-states.ts` | `completed\|failed\|terminated\|blocked\|rejected\|deferred\|shelved` |

唯一变量是被抽取文件的版本 ⇒ 归因确定。**常量的值一个没变**,坏的只是守卫的指针。

**建议修法(实现相位)**:把那两行 `sed` 的目标改成 `packages/teamlead/src/workflow-ledger-states.ts`
(或让它按顺序在两个文件里找、第一个非空即用),并保留 `-n "$ts_statuses"` 的 fail-closed 判据。
我已经确认全仓只有这一处这样抽取(`grep -rn 'ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES\|WORKFLOW_RUN_NODE_STATES' scripts/ .github/` 只命中它),
所以是一处单行修改。**本地没有跑这个 janitor 套件**(它会造 fake home 做删除动作,不适合在生产宿主上跑);
上面的归因用的是同一段抽取逻辑的隔离复跑,CI 日志是原始证据。

### 2.2 🟠 MEDIUM — 真实数据上 `land` 开圈的 `step` 约 90% 渲染成 `unsafe-<hash>`

`land_operation.current_step` 走的是 `canonicalPatrolToken`,而它的文法是
`hook-payload.ts:235` 的 `/^[A-Za-z0-9._-]{1,64}$/` —— **不含冒号**。

生产 `land_operation` 的真实 `current_step` 取值分布(72 行):

| current_step | 行数 | 渲染 |
|---|---|---|
| `finalization_completed` | 49 | ✅ 原样 |
| `notification:merge_failed` | 12 | ❌ `unsafe-<hash>` |
| `notification:activated` | 3 | ❌ |
| `terminal_notified` | 2 | ✅ |
| `rework` | 2 | ✅ |
| `notification:finalization_partial` | 2 | ❌ |
| `notification:cool_triggered` | 1 | ❌ |
| `notification:cleanup_requested` | 1 | ❌ |

**只看当刻真正「开着」的 land(`state != completed AND superseded_at IS NULL`)共 21 行,
其中 19 行(90%)的 step 带冒号** —— 也就是说 Lead 在名册上看到的是
`圈=land:held@unsafe-3f2a1b0c`,而被藏掉的恰恰是 `notification:merge_failed` 这种
最能说明「这个圈为什么不动」的信息(12/21 就是这一种)。

判定不受影响(step 只用于展示),但这是本卡主交付列的可读性,不是边角。
**建议修法**:给 step 单独一个消毒器,文法放宽到 `[A-Za-z0-9._:-]`(冒号只是分隔符,
不构成注入面 —— 换行/指令词仍由现有 `PATROL_DIRECTIVE_WORDS` 和长度上限挡),
或把 `notification:` 前缀在渲染前剥掉。同时建议补一条以**真实取值集合**为夹具的回归。

### 2.3 🔵 INFO(范围问题,不据此判 FAIL)— 红灯打不到 founder 当晚点名的那三单

把三单 06:44 的真实账本状态喂进真 `judgeLoopLight`:

| issue | 当时真实账面 | 判定 | 渲染 |
|---|---|---|---|
| FLY-1855 | `land_operation` state=`running` step=`rework` `superseded_at=NULL`(06:29:54 才 superseded);`land@1` attempt 仍 running | `not_triggered` | `圈=land:running@rework` |
| FLY-1859 | `founder_gate@2` = `review`(exec 为 NULL),gate holder 未 superseded(`awaiting_review`);真实 waiter `cea85134` 已等 233 分钟 | `not_triggered` | `圈=gate:awaiting_review` |
| FLY-1887 | 棒在 implement `2218259c` 手里、它自己 attempt running;账上**没有任何在册 waiter**(唯一那条 wait 行属于已 `completed` 的 `63fa337b`,不在名册) | `not_triggered` | `圈=无` |
| 对照组:卡里假设的形态(aged waiter + 零开圈) | —— | **`red`** | 置顶 🔴 行文案正确 |

另外:**FLY-1855 在整个事故窗里 `turn_wait_ledger` 一行都没有** ——
它压根不是 issue 正文假设的「体在 turn-poll」那个形态。

这**不是实现缺陷**:plan §8 明确把「圈开着但卡住(rework held / land held / gate 久候)」
划到本卡范围外,并写明「死 actor 的 running 残留会 bias-to-green」。实现与已批准的 plan 一致,
对照组证明谓词按设计工作。但 issue 正文的验收锚
「复现当晚 1855 形态(体 turn-poll + 无 attempt)」**与真实账本不符**,
所以需要 Lead/founder 拍一下:如果期待的是「这三单会变红」,那要另开一卡把
「开着但长期不动的圈」纳入判定。

**值得说清楚的另一半**:名册那三列在事故窗里**确实有用** —— 它会直接印出
`圈=land:running@rework` / `圈=gate:awaiting_review` 和 `等待账=turn-poll(账龄234m)`,
比现状那份只有 `- FLY-1855 [7b3502dd] (implement, running)` 的扁平名册强得多。
(注意 §2.2 会把 `land:held@notification:merge_failed` 这半句吃掉,两条要一起修才完整。)

### 2.4 🟡 LOW — 红灯置顶区的计数与明细可能对不上

`formatPatrolTick` 的置顶区先按 `redLoops.length` 打印「有 N 个 issue」,
再逐条筛出 `redQualified === true && waitedMinutes 是安全整数 && execId8 != holder` 的 waiter 出明细行。
筛不出时明细为空,标题仍写 N。生产路径下 `toPatrolLoopEntry` 保证红灯行必有合格 waiter,
所以只有**畸形/手造 payload** 能触发(我的对抗夹具就是这么复现的:见 §4 第 3、4 例)。
纯观感,建议顺手改成按实际明细行数计数,或至少在筛空时补一行说明。

---

## 3. 真机 529 隔离房 E2E(slot 2)

- 从**被测 worktree** 起房(`cd ~/Dev/flywheel-FLY-1925 && TMPDIR=/tmp/ bash scripts/test-deploy.sh 2`),
  `curl localhost:19872/health` → `buildSha = 902e1988…`,与 PR head 逐字一致
  (避开了「Bridge 跑的是 main」的假绿)。
- 起房前必须清掉从 runner pane 继承的 `FLYWHEEL_LEAD_BACKEND` / `FLYWHEEL_CODEX_LEAD_*` 等一族环境变量,
  否则 slot Bridge 会把测试 Lead 当成 Codex Lead 去探 `lead-inbox.sock` 并失败
  (**仪器问题,不是被测代码问题**;已是这一类环境坑的第四例)。
- 在 slot 自己的库里造形态:`QA-1855`,两个 running session(implement `aa111111` / qa `bb222222`),
  active run(current_node=implement,`implement@1` = `done`),
  `three_stage_turn` 棒在 `bb222222`/qa/e4,`turn_wait_ledger` 里 `aa111111` 等 e4 已 47 分钟,
  无 rework / land / gate / wake。
- 真 Bridge 的 patrol rider 自己铸出 `lead_events` 一行,payload 里
  `"light": "red"`、`"redQualified": true`、`"waitedMinutes": 47`。
- 这一行经真实投递路径渲染进 slot mailbox 的 `content`,**逐字如下**:

```
[patrol_tick] 巡检时间到。
🔴 按账面有 1 个 issue「有人在等不存在的圈」(账面自检,非结论,仍需独立核验):
- QA-1855: aa111111 TURN 等待账记录账龄 47 分钟(棒=bb222222/qa/e4),账上无活动 attempt/返工圈/land/可重试 wake/gate 会向它发棒
按 Bridge 的账,你名下有 2 个未终结 runner(此名册是待核声明,不是结论):
QA-1855 | run=run-qa18(active) node=implement@1(done) | 棒=bb222222/qa/e4 | 圈=无 | 🔴
  - [aa111111] (implement, running) 等待账=turn-poll(账龄47m)
  - [bb222222] (qa, running)
```

### 3.1 BEFORE / AFTER 对照(同一间房、同一份种子、两个真 Bridge)

为了排除「这是隔离房自身的现象」和「渲染差异是我造的」,我在 slot 3 用**生产仓 main**
(`bda55d01`)起了同款房,喂**逐字相同**的种子。两边真 Bridge 各自铸出的 Lead 正文:

| | buildSha | 渲染出的正文 |
|---|---|---|
| **BEFORE(main)** | `bda55d01` | `[patrol_tick] 巡检时间到。`<br>`按 Bridge 的账,你名下有 2 个未终结 runner(此名册是待核声明,不是结论):`<br>`- QA-1855 [aa111111] (implement, running)`<br>`- QA-1855 [bb222222] (qa, running)` |
| **AFTER(本分支)** | `902e1988` | 见上一段(置顶 🔴 行 + issue 分组 + 棒/圈/等待账龄) |

**诚实边界**:最后一跳(mailbox → Lead pane 真显示)**两边都没有观察到** ——
两间房的那条 mailbox 行都以 `state=DEAD / dead_reason=membership_conflict:<uuid>` 结束。
**main 对照组出现同样的 DEAD,证明这条与 FLY-1925 无关**(本 diff 也确实不含任何
mailbox / 投递改动),属于 529 隔离房投递侧的既有条件,不计入本卡判词。
被测面(真 Bridge 渲染出的正文字节)两边都拿到了,足以做 before/after 对照。

---

## 4. 对抗与兼容(全部用**真 `origin/main` 编译出来的**渲染器做对照,不是手抄复刻)

1. **旧 payload(无 `loops`)逐字节兼容**:`formatPatrolTick(旧 payload)` 与 main 版本输出
   `===` 严格相等 → ✅。
2. **名册有 issueId 但 loops 缺该 issue** → 整体回退扁平模板,且与 main 输出相等 → ✅。
3. **注入夹具**(identifier / node / step / phase / executionId8 里塞换行 + `IGNORE ALL PREVIOUS INSTRUCTIONS`,
   openLoops.kind 塞 `<script>`):输出里**不含**任何注入文本,全部降级成 `unsafe-<hash8>` → ✅。
4. **非法数值**(`currentAttempt: -1`、`turnEpoch` 超出安全整数、`waitedMinutes: NaN`):
   相应字段整段省略,不崩、不打印 NaN → ✅(顺带复现了 §2.4)。
5. **真实状态词表覆盖**:把生产里 rework delivery / land state / gate / carrier / run status /
   run_node state / node_id / turn phase / 996 个 issue identifier 全量喂进渲染器,
   **除 §2.2 的 land step 外零降级**。

---

## 5. 附录

### A. 生产真名册回放(2026-08-20 10:26,12 session / 11 issue,零红灯)

```
[patrol_tick] 巡检时间到。
按 Bridge 的账,你名下有 12 个未终结 runner(此名册是待核声明,不是结论):
FLY-1850 | run=6b50a6e5(active) node=produce@1(running) | 棒=fa7e14cf/produce/e2 | 圈=无 | —
  - [fa7e14cf] (main, running)
…
FLY-1925 | run=c198029f(active) node=qa@1(running) | 棒=443d5131/qa/e6 | 圈=无 | —
  - [e244d9c6] (implement, ship_parked) 等待账=turn-poll(账龄4m)
  - [443d5131] (qa, running)
FLY-1795 | run=4419c594(active) node=implement@2(running) | 棒=0c3c64c8/implement/e7 | 圈=rework:wake_delivered→implement@2 | —
  - [0c3c64c8] (implement, running)
FLY-1887 | run=19e9caef(active) node=implement@5(running) | 棒=50701003/implement/e15 | 圈=rework:wake_delivered→implement@5 | —
  - [50701003] (implement, running)
```

注:FLY-1925 这一行是本 QA 会话自己 —— 棒在 qa(我)手里、implement 体 `ship_parked` 在等,
`qa@1` attempt 是 running 且属于持棒者 ⇒ 正确判为 `not_triggered`(圈确实存在,就是我在干活)。
这是一个有价值的真阴性:如果谓词把「持棒者自己的 attempt」也排除掉,这一行现在就会误红。

### B. 复跑入口

QA 期间用的一次性脚本都在本次会话 scratchpad
(`real-schema-probe.mjs` / `joinkey-probe.mjs` / `real-data-replay.mjs` /
`incident-replay.mjs` / `render-adversarial.mjs` / `vocab.mjs` / `perf.mjs` /
`seed-slot.mjs`),**不入仓**。要复跑 §2.1 的归因只需要:

```bash
git show origin/main:packages/teamlead/src/StateStore.ts > /tmp/a.ts
for f in /tmp/a.ts packages/teamlead/src/StateStore.ts packages/teamlead/src/workflow-ledger-states.ts; do
  echo "$f => $(sed -n '/export const ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES = \[/,/] as const;/p' "$f" \
    | grep -Eo '"[a-z_]+"' | tr -d '"' | paste -sd '|' -)"
done
```

### C. 没有测到的

- janitor 套件本地未跑(见 §2.1 说明);
- mailbox → Lead pane 的最后一跳(见 §3.1;main 对照组同样 DEAD,已排除归因到本卡);
- 长时间运行下 `turn_wait_ledger` 残留(生产现有 47 行,最老 8 天,该表不清理)在
  **在册**体上的误红概率 —— 本轮生产回放里没有出现,但这依赖「体一旦拿到棒 wait 行就被删」,
  属于账面语义假设,建议 ship 后观察一两轮真 tick;
- Codex code review 是独立节点,本节点不重跑、不据它出判词。

---

# 复测第 2 轮(QA attempt 2 · TURN epoch 8 · head 4a5a6ef0)

日期: 2026-08-20
被测 head: `4a5a6ef08baa7031117c9c73855df192e88f30f5`(与 rework base / origin / PR #903 head 四者逐字一致,工作树干净)

## 判词:**FAIL**(三条,按 Tadashi 2026-08-20 裁决合成一圈)

上一轮那两条修复**已验证正确**;本轮 FAIL 不是因为它们,而是因为下面 (1)(2)。

### (1) 🔴 PR 与 main 冲突,CI 零 run —— 必须先 rebase

- `gh pr checks 903` → `no checks reported on the 'flywheel-FLY-1925' branch`;
  `mergeable=CONFLICTING`、`mergeStateStatus=DIRTY`。
- 唯一冲突文件:`scripts/__tests__/fly1674-residue.test.sh` —— 本分支与 main **都往同一个
  `allowed_hits` 数组里加了条目**,是加性冲突,合起来即可。
  `git merge-tree --write-tree --name-only origin/main HEAD` 只报这一个文件。
- 目标:rebase 到 `main@33682ea2`(实测时的 main),然后让 CI 真跑一轮。
- **`gh pr checks` 全绿是 PASS 的硬前提**,现在它连跑都没跑过,所以 PASS 无从谈起。
- 解冲突不由 QA 做(实现相位的活;而且 QA 一动工作树就移 head)。

### (2) 🔴 范围未实现:founder 追加判据在本 head 里一行都没有

`packages/teamlead/src/bridge/patrol-loop-ledger.ts` 自上一轮 FAIL 以来**零改动**,谓词未动。
Tadashi 已确认这是**他的派发疏漏**(判据给了 QA、没给实现体),不是实现体的问题。

**要实现的谓词(通用,不依赖节点名 —— 任何 DAG、任意节点都适用)**:

「棒在 H 手里,而 H 在账面上可证地没在干活」⇒ 红灯。可证子集三条:

1. H 在选中 run 上的**当前 attempt 已终态**(`done` / `failed` / `superseded`);
2. H 的 **session 状态已终态**(`failed` / `blocked` / `terminated` / `completed`)或 `ship_parked`;
3. H **在册且有未过期的 park 声明**(`runner_declared_states`)。

**触发条件放宽**:`run 仍 active 且持棒者已终态` —— **不要求有等待者**
(FLY-1855 事故窗里 `turn_wait_ledger` 一行都没有,要求有等待者就永远看不见它)。

**明确禁止**(2026-08-20 生产实测,详见下表)用这三样当判据:

| 想当然的判据 | 实测为什么不能用 |
|---|---|
| 棒龄(持棒时长) | 当刻 12 条 TURN 里 5 条已握棒 197–228 分钟,holder 全是 `running` 的正常长任务 |
| run 事件静默 | 同上 5 条的 `workflow_run_event` 最后一条同样是 3–4 小时前 —— 跑长任务期间本来就不写 run 事件 |
| 裸 `runner_declared_states` | 未过期行 341 条、`expires_at` **全为 NULL**(表本身不过期),340 条属已终态 session,**属于当前名册成员的是 0 条** |

一开就会点亮舰队近一半的行 —— 这正是本卡最不该犯的错。

**必过的正反控制组(两条都要)**:

- **真阳** FLY-1859 @ 2026-08-20 03:11:50:holder `3d74ad4f` 的 `qa@2` 已 `done`,棒仍在它手上(e7),
  waiter `cea85134` 已等 233 分钟 ⇒ **必须红**。
- **真阴** FLY-1925 自身:棒在 qa 手里、`qa@1` 是 `running` **且属于持棒者**、implement 体 `ship_parked` 在等
  ⇒ 这是健康态(持棒者正在干活)⇒ **必须不红**。
- 附加:生产整盘回放的红灯数必须可解释,不能因为新判据从 0 跳到一半。

### (3) ✅ 上一轮两条修复:已在本 head 验证正确,新 head 上只需回归、不必重做

**修复 A — janitor 守卫指针**(`scripts/__tests__/flywheel-log-janitor.test.sh:876`)
sed 目标改到 `packages/teamlead/src/workflow-ledger-states.ts`,`-n "$ts_statuses"` fail-closed 判据原样保留。

三 head 抽取对照:

| 抽取目标 | 结果 |
|---|---|
| `origin/main:packages/teamlead/src/StateStore.ts` | 完整七态 |
| 本分支 `StateStore.ts` | 空串 |
| 本分支 `workflow-ledger-states.ts` | 完整七态 |

**突变检验(证明修完不是空过绿)**:真实文件 → PASS;leaf 里删掉 `shelved` → FAIL;leaf 置空 → FAIL。三态全对。

**修复 B — land step 冒号**(`hook-payload.ts` 新增 `canonicalPatrolStep`)
只放宽 `:` 一个字符,只作用在 `land` 的 `step` 上;`PATROL_DIRECTIVE_WORDS` 与 64 字符上限不变。

- 生产真实 8 个 `current_step` 取值**零降级**(修前 5 个降级,且开着的 21 行里 19 行中招);
- **15 条 step 专项对抗 15/15 符合预期**:换行 / 回车 / `check` / `verify` / 中文「建议」/ 空格 /
  斜杠 / 反引号 / 零宽字符 / emoji / Discord 提及 / 65 字符超长 **全部照常降级成哈希**;
  64 字符边界与两个真实值原样保留;注入正文零泄漏(逐行核过渲染结果)。

**修复 C — `fly1674-residue` 白名单三条:必要,不是放宽**
三处 `three_stage_turn` 都是对**现存活表**的真引用,与白名单里已有的 `db.ts` / `commands/turn.ts` 同性质。
另核:该守卫在上一轮 CI 日志里出现 **0 次** —— job 在 janitor 那步就中止了,它**根本没执行过**,
所以不是「以前绿、现在被放宽」。本轮本地跑它 **56 项全过**。

## 本轮回归(全绿)

| 门 | 结果 |
|---|---|
| `pnpm -r build` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0(8 条既有 warning) |
| teamlead 定向 5 文件 | ✅ 58 例全绿 |
| flywheel-comm `db.patrol-loop` | ✅ 3 例全绿 |
| `fly1674-residue.test.sh` | ✅ 56/56 |
| 生产整盘回放(12 session / 10 issue) | ✅ 零红灯、零 unknown |
| **`gh pr checks 903`** | ❌ **零 check**(见 (1)) |

## 本轮真机 529(head 4a5a6ef0,`/health` buildSha 逐字一致)

一次跑完两个证据:①红灯形态 ②真实 `land held @ notification:merge_failed` 形态。
真 Bridge 渲染进 slot mailbox 的 Lead 正文**原文**:

```
[patrol_tick] 巡检时间到。
🔴 按账面有 1 个 issue「有人在等不存在的圈」(账面自检,非结论,仍需独立核验):
- QA-1855: aa111111 TURN 等待账记录账龄 47 分钟(棒=bb222222/qa/e4),账上无活动 attempt/返工圈/land/可重试 wake/gate 会向它发棒
按 Bridge 的账,你名下有 3 个未终结 runner(此名册是待核声明,不是结论):
QA-1855 | run=run-qa18(active) node=implement@1(done) | 棒=bb222222/qa/e4 | 圈=无 | 🔴
  - [aa111111] (implement, running) 等待账=turn-poll(账龄47m)
  - [bb222222] (qa, running)
QA-1833 | run=run-qa18(active) node=land@1(running) | 棒=cc333333/land/e2 | 圈=land:held@notification:merge_failed | —
  - [cc333333] (implement, running)
```

第二行的 `圈=land:held@notification:merge_failed` 就是修复 B 的收口证据 ——
**修前是 `unsafe-<hash>`,现在在真 Bridge 上原样可读**。

两行的 `run=run-qa18` 相同是我夹具里两个 run id 前 8 位撞了(真实 run id 是 UUID),**不是缺陷**。
slot 已 teardown;生产 Bridge `/health` 200、12 session 正常;全程只读生产库。

## 下一轮(第 3 次 = 最后一次复测)我会验什么

1. rebase 到最新 main 后 `gh pr checks` **全绿**;
2. 新谓词的**正反控制组两条都过**,且实现里**不出现**棒龄 / 事件静默 / 裸 declared_states 三种判据;
3. 生产整盘回放红灯数可解释;
4. (3) 三项修复的回归(不重做);
5. 真机 529 复跑,含新谓词的真阳形态。

---

# 复测第 3 轮(QA attempt 3 · TURN epoch 10 · head ffae5b7a)

日期: 2026-08-20
被测 head: `ffae5b7a0e678b872d75318decdc6d4716b415e2`(local / origin / PR #903 / rework base 四者逐字一致,工作树干净)

## 判词:**FAIL** —— 只有一条缺陷

上一轮三条里,**(1) 已解、(3) 回归通过**;**(2) 已实现但实现方式有一个会污染生产信号的缺陷**。
另外我**主动撤回了自己上一轮提的那条「必过真阳 A」**——真实数据把它证伪了(见 §R3.2)。
Tadashi 2026-08-20 已逐条裁决同意上述三点。

### R3.1 🔴 唯一缺陷:持棒者不活跃的红灯**没有过「圈是否存在」这道闸**

`judgeLoopLight` 里新增的三条持棒者规则 **`return` 得比 S1–S5 早**
(`patrol-loop-ledger.ts`,`if (run?.status === "active" && facts.turn) { … }` 整块位于
`classifyTurnWaits` 与 S1–S5 之前),所以**圈明明开着也照样红**。

**四形态实证(喂真 `judgeLoopLight`,编译产物)**:

| 形态 | 账面 | 应当 | 实得 |
|---|---|---|---|
| ① | 持棒者 session=`completed` + founder gate `awaiting_review` 开着 | 不红(在等 founder) | 🔴 `holder_terminal_session` |
| ② | 持棒者 session=`completed` + rework delivery `pending` 开着 | 不红(返工圈开着) | 🔴 同上 |
| ③ | 持棒者 session=`completed` + land `running` 开着 | 不红(land 在跑) | 🔴 同上 |
| ④ | 持棒者 session=`completed` + 账上确实一个圈都没有 | **红** | 🔴 ✅ |

**真机 529 的自相矛盾铁证**(head `ffae5b7a`,slot `/health` buildSha 逐字一致,
真 Bridge 渲染进 slot mailbox 的 Lead 正文原文):

```
[patrol_tick] 巡检时间到。
🔴 按账面有 2 个 issue「有人在等不存在的圈」(账面自检,非结论,仍需独立核验):
- QA-NOLOOP: 棒持有者 solo0003 的当前 attempt implement@3 已终态(done),run 仍 active
- QA-GATE: 棒持有者 qaqa0001 的 session 已终态(completed),run 仍 active
按 Bridge 的账,你名下有 2 个未终结 runner(此名册是待核声明,不是结论):
QA-NOLOOP | run=runsolo1(active) node=implement@3(done) | 棒=solo0003/implement/e5 | 圈=无 | 🔴
  - [solo0003] (implement, running)
QA-GATE | run=rungate1(active) node=founder_gate@2(review) | 棒=qaqa0001/qa/e6 | 圈=gate:awaiting_review | 🔴
  - [imim0002] (implement, ship_parked)
```

**同一条消息**:标题说「有人在等**不存在**的圈」,两行之后自己印着 `圈=gate:awaiting_review` ——
圈就在那儿。`QA-NOLOOP` 那条(`圈=无`)才是真红。

**为什么这条必须修**:每张卡走到 `founder_gate` 都会进入「QA 交完卷 → 它的 attempt 变 `done` /
session 收工 → 棒还在它手上 → run 停在 founder_gate 等 Annie」这个形态。
不修的话,**每张卡进 founder 闸后一小时内必假红**,恰好污染 Annie 最看重的那个信号。

**修法(Tadashi 已批)**:把这三条持棒者规则挪到 S1–S5 **之后**,改成双条件与 ——
「账上不存在任何会发棒的圈(S1–S5 全空)」**且**「持棒者可证不活跃」才红。
这才和本卡的定义(有人在等**不存在**的圈)以及渲染标题对得上。

**顺带**:实现体的测试把这个缺陷**钉住了** ——
`patrol-loop-ledger.test.ts` 的 `marks the real FLY-1859 shape red when the active run's
TURN holder owns a done current attempt` 夹具里**显式带着
`gateAuthorities: [{ kind: "gate", state: "awaiting_review" }]` 并断言 `red`**。
修的时候这条测试要一起改。另外该夹具用 `currentNodeId: "qa"`,而真实 1859 在 03:11:50
的 `current_node_id` 已经推进到 `founder_gate`,所以它的名字「the real FLY-1859 shape」
与真实账本不符。

### R3.2 ⚠️ 我撤回自己上一轮提的「必过真阳 A」(1859 @ 03:11:50 必须红)

**理由:真实分布证伪。** 拿当刻生产扫一遍,与该形态**完全同形**的 issue 有四个:

| issue | 棒 | TURN 目标 attempt | run.current | holder session | gate |
|---|---|---|---|---|---|
| FLY-1687 | `19e0456b/qa/e3` | `qa@1` = `done` | `founder_gate` | `completed` | 无 |
| FLY-1758 | `705aad0d/qa/e5` | `qa@1` = `done` | `founder_gate` | `completed` | `awaiting_review` **开了 152.8h** |
| FLY-1887 | `55f8ebd3/qa/e16` | `qa@2` = `done` | `founder_gate` | `running` | `awaiting_review` 开了 0.4h |
| FLY-1867 | `ab557f54/qa/e6` | `qa@2` = `done` | `founder_gate` | `running` | `awaiting_review` 开了 0.6h |

FLY-1867 / FLY-1887 是**此刻健康的、正在等 Annie 的卡**。
⇒ 这个形态是**正常路径**,不是真阳。我当初只描述了 1859 的账面形状就断言「必须红」,
**没回头量这个形状在生产里有多普遍**,是我的错;现在用数据更正。

**新的真阳定义(Tadashi 已批)**:
「账上不存在任何会发棒的圈(S1–S5 全空)**且**持棒者可证不活跃」才红。

- **必过(必须红)**:形态 ④;上一轮报告里的 E(持棒者 session `failed` 且无圈)、F(零等待者 + 持棒者 attempt 终态且无圈)。
- **必不红**:形态 ①②③;以及 FLY-1867 / FLY-1887 的当刻实况。

### R3.3 ✅ 上一轮 (1)(3) 已解 / 已回归

| 项 | 结果 |
|---|---|
| PR 与 main 冲突 | ✅ 已 rebase,`mergeable=MERGEABLE`、`mergeStateStatus=CLEAN` |
| **`gh pr checks 903`** | ✅ **11/11 全绿**(含 Script Tests 1/2、2/2、Unit ×5、Quick Gate、CI OK) |
| `pnpm -r build` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0(7 条既有 warning) |
| teamlead 定向 5 文件 | ✅ **81 例全绿**(含实现体新增的 36 例谓词测试) |
| 生产整盘回放(13 session / 11 issue) | ✅ **零红灯、零 unknown** —— 当刻没有假红,但那是因为 R3.1 的规则恰好键在 `current_node` 上而 1867/1887 的 gate 节点 attempt 是 `execution_id=NULL`;把规则按真阳 A 改成键在持棒者自己的 attempt 上,它们**立刻**变红。这条侥幸不能当安全证据。 |

### R3.4 渲染侧顺带修好的一条(上一轮 LOW)

置顶区的计数改成按**实际证据行数**(`redEvidenceLines.length`)而不是 `redLoops.length`,
上一轮那个「标题说 N 个、明细却是空」的观感问题已消失。

**但新引入一个文案不一致**:标题固定写「有人在等不存在的圈」,而
`holder_terminal_*` 那两种证据行描述的是**另一种现象**(持棒者没在干活)。
修 R3.1(加上「圈不存在」这道闸)之后两者就一致了,不必单独改文案。

### R3.5 另一个维度的观察(不进本卡,已上报)

**FLY-1758 的 founder gate 已经开了 152.8 小时(6.4 天)**,但它在巡检名册上**完全看不见** ——
它的 session 都已终态,不在名册里(名册只收 `running/ship_parked/awaiting_review/approved_to_ship/pending/design_done`)。
这大概率正是 founder 想要的那种「没人管的东西要浮出来」,但属于**闸龄监控 + 名册对终态 session 的盲区**,
不是本卡红灯能覆盖的。Tadashi 已按机制缺陷记账上报 Annie。

## 下一轮我会验什么

1. R3.1 修完:形态 ①②③ **必不红**、形态 ④ / E / F **必红**;
2. 那条钉住缺陷的测试已同步改正(含它的 `currentNodeId` 与真实账本对齐或改名);
3. 生产整盘回放红灯数仍可解释,且 FLY-1867 / FLY-1887 这类等 founder 的卡不红;
4. 回归:CI 全绿、build/lint、定向套件;
5. 真机 529 复跑,同时验真红(`圈=无`)与必不红(`圈=gate:awaiting_review`)两条。

---

# 复测第 4 轮(QA attempt 4 · TURN epoch 12 · head 54a0262e)

日期: 2026-08-20
被测 head: `54a0262e69ec4bc28764e0444c5e600676044ef2`(local / origin / PR #903 / rework base 四者逐字一致,工作树干净)

## 判词:**PASS**

上一轮那条唯一缺陷已修:持棒者不活跃的三条规则被整块挪到 S1–S5 **之后**
(`redWaiters.length === 0` 的早退也一并后移,等待者红灯语义未变),
现在是「账上不存在任何会发棒的圈 **且** 持棒者可证不活跃」双条件与才红 —— 与本卡定义和渲染标题一致。

### R4.1 约定的两组用例:全过

**必红(3/3)**

| 用例 | 实得 |
|---|---|
| 形态④ 持棒者 session=`completed` + 账上零圈 | 🔴 `holder_terminal_session` |
| E 持棒者 session=`failed` + 零圈 | 🔴 `holder_terminal_session` |
| F 零等待者 + 持棒者 attempt 终态 + 零圈 | 🔴 `holder_terminal_attempt` |

**必不红(6/6)**

| 用例 | 实得 |
|---|---|
| 形态① 持棒者终态 + founder gate `awaiting_review` 开着 | — |
| 形态② 持棒者终态 + rework delivery `pending` 开着 | — |
| 形态③ 持棒者终态 + land `running` 开着 | — |
| A 1859 真实账面(gate 开着;真阳 A 已撤回) | — |
| B 同上但 `current_node` 停在 qa | — |
| C FLY-1925 自身(持棒者正在干活) | — |
| FLY-1867 / FLY-1887 当刻生产实况 | — (见 R4.3) |

### R4.2 我自己加的 12 条对抗(未事先告知实现体),全过

| # | 用例 | 期望 | 实得 |
|---|---|---|---|
| G | 原有等待者红灯没坏:aged waiter + 零圈 + 持棒者健康 | red | ✅ |
| H | fresh-only waiter + 零圈(证明 `redWaiters` 闸后移没漏) | not_triggered | ✅ |
| I | **held** run + 持棒者 session 终态 | not_triggered | ✅ |
| J | 零 run + aged waiter(卡的原始形态) | red | ✅ |
| K | 账面不可读优先于新红灯 | unknown | ✅ |
| L | 指纹漂移优先于新红灯 | unknown | ✅ |
| M | 持棒者**不在名册** + parked 声明(不信 off-roster 声明) | not_triggered | ✅ |
| N | 持棒者在名册 + parked + 零圈 | red (`holder_parked`) | ✅ |
| O | 持棒者在名册 + parked 但 gate 开着 | not_triggered | ✅ |
| P | 持棒者终态 + **可投递** wake 指向它 | not_triggered | ✅ |
| Q | 持棒者终态 + 只有**已耗尽**的 wake | red | ✅ |
| R | gate=`approved`(无后继)+ 持棒者终态 | red | ✅ |

I / K / L / M / P / Q / R 这几条是**这次挪动最容易弄坏而约定用例没覆盖**的面(held-run 门、
unknown 优先级、off-roster 声明、wake 可投递性、approved 不算源),全部保持原语义。

### R4.3 生产整盘回放:零红灯,且**可解释**

14 session / 11 issue,零红灯、零 unknown。关键是**上一轮点名的两张卡现在如实不红**:

```
FLY-1867 | run=76cefc5b(active) node=founder_gate@1(review) | 棒=ab557f54/qa/e6 | 圈=gate:awaiting_review | —
FLY-1887 | run=19e9caef(active) node=founder_gate@2(review) | 棒=55f8ebd3/qa/e16 | 圈=gate:awaiting_review | —
```

零红灯之所以是**可解释**而不是「探针坏了」:同一批控制组里必红那 3 条确实红了(尺子本身有效),
而当刻生产上每个 issue 都有活圈(running attempt / rework / gate),没有一个符合「零圈 + 持棒者不活跃」。

### R4.4 真机 529:同一份种子、两个 head 的 BEFORE / AFTER

因 slot 2 被另一个 QA 会话占用(`ERROR: Slot 2 is in use`,其 Bridge 在 `c102c99d`),
本轮改用 **slot 4**;`/health` buildSha = `54a0262e`,与被测 head 逐字一致。**没有碰别人的房。**

同一份种子(`QA-NOLOOP` = 零圈 + 持棒者 attempt 终态;`QA-GATE` = 持棒者 session `completed` + gate `awaiting_review` 开着):

**BEFORE(第 3 轮 head `ffae5b7a`,slot 2)**
```
🔴 按账面有 2 个 issue「有人在等不存在的圈」(账面自检,非结论,仍需独立核验):
- QA-NOLOOP: 棒持有者 solo0003 的当前 attempt implement@3 已终态(done),run 仍 active
- QA-GATE: 棒持有者 qaqa0001 的 session 已终态(completed),run 仍 active
QA-NOLOOP | ... | 圈=无 | 🔴
QA-GATE   | ... | 圈=gate:awaiting_review | 🔴      ← 假红:标题说圈不存在,自己却印着圈
```

**AFTER(本轮 head `54a0262e`,slot 4)**
```
🔴 按账面有 1 个 issue「有人在等不存在的圈」(账面自检,非结论,仍需独立核验):
- QA-NOLOOP: 棒持有者 solo0003 的当前 attempt implement@3 已终态(done),run 仍 active
QA-NOLOOP | run=runsolo1(active) node=implement@3(done) | 棒=solo0003/implement/e5 | 圈=无 | 🔴
QA-GATE   | run=rungate1(active) node=founder_gate@2(review) | 棒=qaqa0001/qa/e6 | 圈=gate:awaiting_review | —
```

假红消失、真红保留、正文不再自相矛盾。

### R4.5 硬门与回归

| 门 | 结果 |
|---|---|
| `gh pr checks 903` | ✅ **11/11 全绿** |
| PR 状态 | ✅ `MERGEABLE` / `CLEAN` / 非 draft |
| `pnpm -r build` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0(7 条既有 warning) |
| teamlead 定向 5 文件 | ✅ **88 例全绿**(谓词测试 43 例) |
| flywheel-comm `db.patrol-loop` | ✅ 3 例 |
| 前几轮修复回归 | ✅ janitor 守卫指针、land step 冒号、residue 白名单均未回退 |

## 诚实边界(未测到的)

1. **mailbox → Lead pane 的最后一跳没观察到**:529 房里 `lead_event` 投递以
   `state=DEAD / dead_reason=membership_conflict` 收场;我在第 2 轮用**生产仓 main** 起同款房
   喂同样种子复现了同样的 DEAD,已排除归因到本卡(本 diff 不含任何 mailbox / 投递改动)。
   被测面(真 Bridge 渲染出的正文字节)每轮都取到了。
2. **`turn_wait_ledger` 长期残留的误红概率**未做长时观察:生产现有 47 行、最老 8 天,该表不清理。
   四轮回放均未出现,但这依赖「体一旦拿到棒 wait 行就被删」这一账面语义假设,建议 ship 后观察一两轮真 tick。
3. **「活着但空转的 pane」账本零信号**:本卡只覆盖可证的三种终态形状,live-but-idle 无法证明。
   这是 plan §8 就写明的边界,不是本轮新增。
4. **founder 当晚点名的三单仍不会变红**(1855 是 land 开着、1859 是 gate 开着、1887 无在册等待者)——
   它们属于「圈开着但长期不动」,按定义在本卡范围外;但名册的圈列会如实印出
   `land:running@rework` / `gate:awaiting_review`,Lead 一眼能看见。
5. **FLY-1758 的 founder gate 已开 152.8 小时却在名册上完全看不见**(session 全终态、不在名册六种状态里)——
   属闸龄监控 + 名册盲区,另一个维度,Tadashi 已记账上报。

---

# 复测第 5 轮(独立 QA · founder liveness 更正后 · head b5cb4b44)

日期: 2026-08-21
被测 head: `b5cb4b4429de0fdfe8d0f052f3c3e4d990fdcba4`(worktree HEAD = PR #903 `headRefOid` 逐字一致;
`isDraft=false` / `state=OPEN` / `mergeable=MERGEABLE`;工作树除本报告外干净)
本轮新增面: 3c590c7c8 之后的 **真实现场存活探针**(`patrol-process-liveness.ts` + ledger/render 接线),
即 founder 那句「不应该只看账本,他也需要真的去看现场」的落地。第 1–4 轮验的账面维度本轮只做回归。

## 判词:**PASS**

Tadashi 指定的三条真机形态全部命中,且全部是在**真 tmux / 真 pgrep / 真 Bridge**上取的证,不是 mock。

## 0. 一句话结论

打上探针之前,「节点 running 但体已经死了」在名册上是**绿的**;打上之后是**红的**,
并且每个体旁边多印一列 `现场=alive|dead`。同一份种子、同一个二进制的前后对照见 §3。

## 1. Tadashi 三条判据 —— 真机结果

被测二进制:`packages/teamlead/dist`(本 head `pnpm -r build` 产物),不是 mock 出来的谓词。

| 判据 | 形态 | 结果 | 证据出处 |
|---|---|---|---|
| ① 死体占棒 | node `implement@3(running)`、session `terminated`、**无 tmux 窗**、**无宿主进程** | 🔴 `holder_process_dead`,`现场=dead` | §2 真 Bridge tick 正文 + §4 harness4 |
| ② 活体空转 / 等不存在的圈 | 实现体 `ship_parked` **活着**、连续 `turn-poll` 等 94 分钟;棒在交完 PASS 后 `声明=parked` 的 QA 手里(**也活着**);`rework delivery = needs_lead` | 🔴 `holder_terminal_attempt`,两个体都 `现场=alive` | §2 真 Bridge tick 正文 |
| ③ 绝对 absent 必须判 `dead` 而非 `unknown` | 会话终态 + CommDB 无行 + tmux 无 marker + `pgrep` 无宿主进程 | `dead` | §4 case C(真 `pgrep` 返回码 1)+ §2 第一次 tick 的 `[s1dead00] 现场=dead` |
| ③ 反面:`unknown` 只留给真冲突/超时 | 同一 execution id 被**两个真 tmux 窗**同时挂 marker(真歧义) | `unknown`,且**压过**本会成立的红灯 | §4 harness6 |

## 2. 真机 529 房(slot 4)—— 真 Bridge、真 head、真渲染

- 起房:`scripts/test-deploy.sh 4`(从本 worktree 起,故 slot Bridge 跑的就是被测字节);
  `GET :19874/health` → `buildSha=b5cb4b4429de0fdfe8d0f052f3c3e4d990fdcba4`,与被测 head 逐字一致。
- 种子:三个 issue 写进 slot 自己的 `teamlead.db` + `~/.flywheel/comm/test-slot-4/comm.db`。
  「活着」的体故意指向**真实存在的生产 runner 窗口**(`runner-flywheel:@287 / @25 / @12`),
  探针对它们只做 `list-panes` 只读,**没有在生产 tmux 上新建/删除任何窗口**。
  「死」的体指向一个不存在的窗口 `@99999`。
- 巡检间隔在 slot 的 `.flywheel/config.yaml` 里设 10 分钟(隔离沙箱,未碰全局 `~/.flywheel/patrol.json`)。

真 Bridge 在 `lead_events` seq=6 铸出的 tick,渲染正文逐字如下:

```
[patrol_tick] 巡检时间到。
🔴 按账面有 2 个 issue「棒持有者不在干活」(账面自检,非结论,仍需独立核验):
- QA4-S1-DEADBODY: 棒持有者 s1dead00 的现场探针=dead,run 仍 active
- QA4-S2-LIVEIDLE: 棒持有者 s2qa0000 的当前 attempt qa@2 已终态(done),run 仍 active
按 Bridge 的账,你名下有 4 个未终结 runner(此名册是待核声明,不是结论):
QA4-S1-DEADBODY | run=run-s1(active) node=implement@3(running) | 棒=s1dead00/implement/e5 | 现场=dead | 圈=无 | 🔴
  - [s1dead00] (main, running) 现场=dead
QA4-S2-LIVEIDLE | run=run-s2(active) node=qa@2(done) | 棒=s2qa0000/qa/e7 | 现场=alive | 圈=rework:needs_lead→implement@4 | 🔴
  - [s2qa0000] (main, running) 现场=alive 声明=parked
  - [s2impl00] (main, ship_parked) 现场=alive 等待账=turn-poll(账龄94m)
QA4-S3-CONTROL | run=run-s3(active) node=qa@1(running) | 棒=s3live00/qa/e2 | 现场=alive | 圈=gate:awaiting_review | —
  - [s3live00] (main, running) 现场=alive
```

对照组 S3(体活着、圈开着)如实不红 —— 尺子会区分,不是见谁都红。

**顺带抓到一条真 Bridge 行为(不是缺陷,是范围事实,见 §6-A3)**:第一次 tick 时 S1 是「绝对 absent」
(连 CommDB 行都没有),既有的 `turn-belt` 协调器在开机时把这条 stale TURN **主动释放**了
(`bridge.log`: `STALE TURN on slot4-s1 (holder process absent) … TURN released`),
所以那一发 tick 上 S1 没有棒、不红,但**roster 行照样印了 `现场=dead`**。
把 S1 改成更接近真实事故的形态(CommDB 行还在、窗口已没)后重铸,第二发 tick 就是上面这段。

## 3. BEFORE / AFTER(同一份种子、同一个二进制)

`collectPatrolLoopEntries` 在**不注入** liveness 快照时保留改造前的判定路径(源码里写明的
legacy 行为)。同一份种子跑两遍:

**BEFORE(不注入现场快照)**
```
QA-S1-DEADBODY | run=run-s1(active) node=implement@3(running) | 棒=s1dead11/implement/e5 | 圈=无 | —
  - [s1dead11] (main, running)
```
**AFTER(注入真探针)**
```
QA-S1-DEADBODY | run=run-s1(active) node=implement@3(running) | 棒=s1dead11/implement/e5 | 现场=dead | 圈=无 | 🔴
  - [s1dead11] (main, running) 现场=dead
```

账面上那句 `node=implement@3(running)` 两边一模一样 —— 这正是 founder 说的「只看账本会被骗」。
(这是同二进制的前后对照;**编译版 origin/main** 的 BEFORE/AFTER 第 4 轮已做过,本轮不重复。)

## 4. 现场探针本体:真 tmux + 真 pgrep(9 条,全绿)

隔离 tmux server(`TMUX_TMPDIR=/tmp/f1925q5`),被测对象是 `dist/bridge/patrol-process-liveness.js`,
依赖**全部不打桩**。

| # | 形态 | 期望 | 实得 |
|---|---|---|---|
| A | 真活窗 + marker 发现 | alive | ✅ |
| B | `remain-on-exit` 尸体 pane(实测 `pane_dead=1`) | dead | ✅ |
| C | 绝对 absent(无 CommDB 行 / 无 marker / `pgrep` 返回码 1) | dead | ✅ |
| D | 无窗但有真宿主进程(真 `pgrep` 命中) | alive | ✅ |
| E | tmux server 整个不在(discovery indeterminate) | unknown | ✅ |
| F | CommDB 行 → 真活窗 | alive | ✅ |
| G | CommDB 行 → 窗口已没(真 tmux `can't find window`) | dead | ✅ |
| H | CommDB `:pending` + 无 marker + 无宿主进程 | dead | ✅ |
| I | 真歧义:两个窗挂同一个 exec marker | unknown | ✅ |

> 尺子的尺子:D 第一次跑出 `dead`,查下来是**我的 harness 写错了** —— `bash -c 'sleep 60' <id>`
> 会被 bash 的单命令优化 exec 掉,argv 里的 marker 消失。改成 `'sleep 60; :'` 后 `ps` 能看到 marker,
> 探针立刻返回 alive。记录下来是因为它证明这一格不是空过绿的。

## 5. 对抗矩阵(9 条,真 tmux 存活事实喂进真 ledger,全绿)

这些是**没有事先告诉实现体**的面,专挑「把现场证据接进圈判定」最容易弄坏的接缝:

| # | 用例 | 期望 | 实得 |
|---|---|---|---|
| ADV1 | 持棒者 dead **但 founder gate 开着** | not_triggered | ✅ 圈存在优先,不红 |
| ADV2 | 持棒者健康 + 等待者 90 分钟 + 零圈(老红灯没坏) | red | ✅ |
| ADV4 | `running` attempt 的 exec **已死** + 等待者 90 分钟 | red | ✅ 死体不再替活人挡红 |
| ADV5 | rework `turn_granted` 但 preferred actor **已死** | red | ✅ 不算推进源 |
| ADV5B | 同上但 actor **活着** | not_triggered | ✅ 算推进源 |
| ADV7 | **held** run + 持棒者 dead | red (`holder_process_dead`) | ✅ held 已纳入 |
| ADV8 | 持棒者活着在干活,**非持棒**的在册体死了 | not_triggered | ✅ 不误红 |
| ADV9 | 持棒者 dead + land 圈开着 | not_triggered | ✅ |
| ADV3 | 真歧义导致 `unknown` vs 本该成立的红灯 | unknown | ✅ unknown 压过红灯(fail-safe 方向) |

## 6. 生产只读回放(2026-08-21 00:50,7 issue / 9 session)

用**逐字抄自 `StateStore.ts`** 的那几条 patrol SQL,经 better-sqlite3 `readonly + query_only`
读生产 `teamlead.db`,配真 `comm.db` 只读快照 + 真现场探针,喂进本 head 的真 ledger 与真渲染器:

```
lights: {"not_triggered":7}     ← 零红灯、零 unknown
```

零红灯是**可解释的**,不是探针坏了:

- 9 个在册体的现场探针**全部 alive**,而且每一条都能独立复核(`tmux list-windows -t runner-flywheel` 有窗);
- 同一批探针在生产 `sessions` 里**确实抓出一个 dead**(`5aeda442` → `runner-flywheel:@359`);
  独立复核:`tmux list-panes -t 'runner-flywheel:@359'` 返回 `can't find window: @359`,
  进程表快照里也没有它 ⇒ **真阳性**,不是误报;
- 也就是说 11 个候选里 10 alive / 1 dead(真) / 0 unknown,**没有出现「一夜之间全体变红」的假红**。

生产 `three_stage_turn` 现有 **158 行**活棒,其中大量持有者现场探针 = `dead`、棒龄最长约 1008 小时。
它们**不会**自动变红(不在巡检名册、或圈还开着),但这说明 `holder_process_dead` 这条红灯
在生产里是**够得着的**,不是死代码。

## 7. 硬门与回归

| 门 | 结果 |
|---|---|
| `gh pr checks 903`(exact head) | ✅ **11/11 全绿**(含 Unit heavy / teamlead 1-3 / Script Tests 1-2 / Quick Gate / CI OK) |
| PR 状态 | ✅ `OPEN` / `MERGEABLE` / **非 draft** |
| `pnpm -r build` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0(7 条既有 warning) |
| teamlead 定向 6 文件 | ✅ **108 例全绿**(含新 `patrol-process-liveness.test.ts` 10 例) |
| `flywheel-comm` `db.patrol-loop` | ✅ 3 例 |
| 生产 Bridge 未受影响 | ✅ `:9876/health ok=true`,9 session;`runner-flywheel` 10 个窗一个没少 |
| 529 slot 4 已拆干净 | ✅ `Slot 4 teardown complete`;slot 2(别人的房)没碰 |

## 8. 上报给 Lead 的观察(都不阻塞 ship)

**A1 · MEDIUM —— 探针会继承 pane 的 `TMUX`,理论上能造成「全体假红」**
`patrol-process-liveness` 走的 `tmux-lookup` 默认 runner 不剥 `TMUX`/`TMUX_PANE`。
tmux 客户端在 `TMUX` 有值时会去那个 socket 找 server;若 Bridge 曾经从某个 pane 里被拉起
(例如 Lead 直跑 `restart-services.sh` 的紧急兜底路径),它会去探**那个 Lead 的私有 v2 socket**,
于是每个 runner 窗都 `can't find window` → `absent` → `dead` → **一次 tick 全线红**。
- **实测证据**:同一个 CommDB 行 + 同一个真活窗,`TMUX` 未设时探针 = `alive`;
  把 `TMUX` 指向另一个真 tmux 私有 socket 后 = `dead`。
- **当前不成立**:`ps -E` 读生产 Bridge(PID 7501)的 8544 字节环境,**没有任何 `TMUX*` 变量**
  ⇒ 走的是默认 socket,与 runner 同一个。所以这是「换个拉起方式才会踩」的隐患,不是现状缺陷。
- **既有先例**:`scripts/lead-patrol-snapshot.sh` 就是用 `TMUX= tmux …` 防这一手;
  FLY-1681 的 `execTmux` 也正是为同一类问题剥掉 `TMUX`/`TMUX_PANE`。

**A2 · LOW —— `pgrep -f <execId>` 没有 argv 锚定**
最后一跳用裸 `pgrep -f <执行 id>`。任何**恰好**在命令行里带这个 id 的进程
(例如 Lead 手敲的 `flywheel-comm … --exec-id <id>` 诊断命令)都会让一个真死的体被读成 `alive`,
把该亮的红灯遮掉一发 tick。方向是「漏报」不是「误报」,下一发 tick 会自愈。
同一个 bug class 在 FLY-1482 里被治过(改成逐 PID 读 command + 锚定 argv 语义)。
> 附:macOS `pgrep` 默认排除**自己和自己的祖先**(`man pgrep -a`)。我一度以为
> `pgrep -f <我自己的 execId>` 空返回是产品 bug,查 man 才确认是自测姿势问题 —— Bridge 探的是别人的 id,不受影响。

**A3 · INFO(范围事实)—— `turn-belt` 已经会在开机时释放「持有者不在」的 stale TURN**
529 房实测:Bridge 开机时 `turn-belt` 对「绝对 absent」的持棒者直接 `TURN released`。
所以 `holder_process_dead` 这条红灯在**健康 Bridge 刚开机后**的窗口里可能先被 turn-belt 抹掉。
但生产 158 行活棒里大量持有者现场 = dead(棒龄上千小时)说明 turn-belt 并不做全量清扫,红灯仍够得着。
两者是互补的:turn-belt 治「让棒能继续传」,本卡治「让 Lead 看见」。

**A4 · LOW** —— 渲染按 exec id **前 8 字符**把现场状态贴到体上;同一 issue 内两个体撞 8 位前缀会贴错。
真实 UUID 下概率约 1e-9 量级,只作记录。

## 9. 诚实边界(没测到的)

1. **「活着但空转」仍然证不出来**。探针证明的是「有个进程在」,不是「它在推进」。
   ②那条红是靠账面证据(attempt 终态 / `声明=parked`)成立的,不是靠现场证据。
   founder 的目标里这半边只做到了「把现场事实印出来给 Lead 看」,判定仍需要人。
2. **生产回放的 StateStore 那一侧不是 StateStore 类**。用 sql.js 把 1.76 GB 的生产库整个读进内存
   会有掐死生产 Bridge 的实绩风险(见项目记忆),所以我把 `StateStore.ts` 里那 7 条 patrol SQL
   **逐字抄出来**用 better-sqlite3 只读跑。SQL 文本是同一份,行→对象的映射层是我写的。
3. **BEFORE 对照是同二进制不注入快照**,不是编译版 `origin/main`。编译版对照第 4 轮做过(账面维度)。
4. **529 房 `mailbox → Lead pane` 最后一跳仍是 `DEAD`**(既有隔离条件,第 2 轮已用生产仓 main 复现并排除归因)。
   本轮的被测面(真 Bridge 铸出的正文字节)取自耐久的 `lead_events.payload` 与 `mailbox.content`。
5. **本机没跑全包 vitest**(会把生产 Bridge 压死);全包由 exact-head CI 的 11/11 覆盖。
6. **`flywheel-comm stage set` / `progress --phase qa` 在本节点被拒**
   (`Invalid stage: qa` / `contradicts the authoritative stage brainstorm`),
   所以进度只落在 `progress.md` 文件里,没有进 stage 账本。属工具面,与被测代码无关。
