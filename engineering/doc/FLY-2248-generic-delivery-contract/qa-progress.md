# FLY-2248 通用投递合同 — QA 真机场景执行计划(交给下一轮 QA)
Issue: FLY-2248 (https://linear.app/geoforge3d/issue/FLY-2248/引擎loop稳定性-通用投递合同-欠条必达超时升级工人常驻收信失联判据先问送达每种冻结配正门覆盖所有-dag-loop非)
日期: 2026-09-03
基于: plan.md;attempt 1 QA(判决 fail,claimId=714,绑定头 aa02a86c2)的真机实跑

## 0. 这份文档是什么

Lead 2026-09-03 03:24 指令:attempt 1 的旧头证据下一轮作废,但**台架步骤要留下**。
下面五条判据的观测点、造故障的手法、以及三个「会绊倒你」的坑,都是 attempt 1 在真 529 房实测出来的,
下一轮 QA 在**返工头**上照跑即可,不用再摸索一遍。

attempt 1 的两条 bug 也要在返工头上复验,复现脚本形状见 §4。

## 1. 台架:把「绑定头」搭起来(不要用共享 worktree)

共享 worktree `~/Dev/flywheel-FLY-2248` 在 QA 期间**会被实现体继续推进**(attempt 1 实测:判决落库 20 分钟后
HEAD 就从 aa02a86c2 漂到了 391608194,并带着对 `fly2248-delivery-transition-table.test.ts` 的未提交改动)。
`test-deploy.sh` 是**从调用方 checkout 构建 Bridge 的**,所以直接在共享 worktree 里起房 = 在动靶上取证。

```bash
# 1) 不可变检出(<SHA> = 你要验的返工头)
git clone --no-hardlinks ~/Dev/flywheel-FLY-2248 /private/tmp/fly2248-head
cd /private/tmp/fly2248-head
git checkout --detach <SHA>
git branch -f flywheel-FLY-2248 <SHA>      # 少了这步 --from-branch 类操作会找不到分支
pnpm install --frozen-lockfile && pnpm -r build
cat packages/teamlead/dist/build-identity.json   # artifactBuildSha 必须 == <SHA>

# 2) 起房(TEAMLEAD_STUCK_INTERVAL 把维护 tick 压到 30s,期限常量本身没有旋钮)
cd /private/tmp/fly2248-head
TEAMLEAD_STUCK_INTERVAL=30000 scripts/test-deploy.sh 2 \
  --generalized --stub-runner --no-lead --alerts --expect-head <SHA>
```

`--expect-head` 校验的就是上面那个 `artifactBuildSha`,它是「房子真在跑这个头」的唯一硬证据,**必须带**。

### 三个会绊倒你的坑(全部 attempt 1 实测)

1. **`--from-branch` 选的是 `xrliAnnie/flywheel-qa-sandbox` 仓的分支,不是 flywheel 的。**
   传 `flywheel-FLY-2248` 会在 preflight 挂:`fatal: Remote branch flywheel-FLY-2248 not found in upstream origin`。
   直接不传(默认 sandbox `main`)。Bridge 跑的是你的 checkout,和这个 flag 无关。
2. **Lead 大概率起不来,而且不是被验代码的锅。**
   `/tmp/flywheel-test-slot-N/lead.log` 会刷:
   `host-tmux-selection-gate: post-S1 PATH selected unexpected tmux: /opt/homebrew/bin/tmux -> .../tmux/3.7c/...`
   → `FAIL-LOUD [host_tmux_selection_gate_unavailable_lead] refusing Lead birth`。
   日志自己点名了原因(宿主 tmux 授权门),**不用再跑对照臂**。用 `--no-lead`:
   **告警是 Bridge 发的,不是 Lead agent 发的**,隔离频道照样收得到,①③④和真 Discord 升级全都验得了。
3. **slot bridge launch spec 会把调用方 shell 的整个 env 拍进去。**
   attempt 1 的 `FLYWHEEL_COMM_DB`(指着生产 comm.db)就这么进了 slot Bridge 环境。
   这次没咬到只因为 Bridge 按 project 名解析 comm 库(`~/.flywheel/comm/test-slot-2/comm.db`),
   但从那个 env 派生出去的任何进程都会读生产。**跑完必做污染审计(§5)。**

## 2. 起一个真 DAG run

```bash
TOKEN=$(cat /tmp/flywheel-test-slot-2/state/api-token)
curl -s -X POST http://localhost:19872/api/runs/start \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"issueId":"FLY-2248","projectName":"test-slot-2","leadId":"flywheel-test-2",
       "taskCategory":"code","sessionRole":"main","idempotencyKey":"qa2248-'"$(date +%s)"'",
       "overrides":{"eng_design":{"model":"fable"},"implement":{"model":"codex"}}}'
```

attempt 1 实测:一条 run 会自然产出 3 个 execution(eng_design / implement / qa)和 3 条 `launch` 欠条。

## 3. 五条判据:观测点与造法

所有观测都读 slot 的 StateStore `/tmp/flywheel-test-slot-2/teamlead.db`:

```sql
SELECT family, root_id, minted_at, granted_at, sent_at, received_at, consumed_at,
       settlement_reason, contract_ref_json FROM workflow_delivery_attempt;
SELECT episode_id, stage, run_id, opened_at, alerted_at, severe_alerted_at, closed_at,
       closed_reason FROM workflow_delivery_contract_episode;
SELECT escalation_uid, run_id, state, attempt, last_error FROM workflow_alert_outbox;
```

### ① 欠条被铸出 — 零造法,run 一起就有

跑完 §2 直接查表。attempt 1 得到的形状(全部来自产线代码路径,无注入):
`root=test-slot-2:FLY-2248:launch:<execId>`,`minted=granted -> sent -> received -> consumed`,
`contract_ref={table: workflow_execution_binding, pk: <execId>, runId: <runId>}`。
真 Bridge projector 还会从真 CommDB 行铸出 `mailbox` 欠条。

### ② 到期按级升级 — 用 native 家族种一条过期 attempt,**不要用 mailbox**

> 🔴 **「让工人不读某封信」这个实验在 mailbox 家族上做不出来。**
> Bridge 在 push 那一刻就同时写 `delivered_at` / `notified_at` / `acked_at`。attempt 1 实测:
> 往活会话注入一条 runner instruction,工人什么都没干,**0.1 秒后就 `state=ACKED`**;
> 往已结束的会话注入,立刻 `DEAD / dead_reason=recipient_terminal`。
> 也别指望 `kill -STOP` 停 tmux pane 里的 stub —— 实测发不停,`ps -o stat` 仍是 `Ss+`。
> ⇒ 合同的 `received/consumed` 记的是**「推进 pane 了」**不是**「工人读了」**;
> 卡死的工人在台账上等于「已消费」。**这本身是个待裁决的产品问题**(见 §6)。

可行造法 —— 直接往 slot StateStore 种一条 3 小时前的 `gate_holder` 欠条,让**真维护 tick** 去分类:

```js
const rootId = `test-slot-2:FLY-2248-${MARK}:gate_holder:h1`;
db.prepare(`INSERT INTO workflow_delivery_attempt (root_id, generation, attempt, attempt_id,
  family, contract_ref_json, minted_at) VALUES (?,1,1,?,'gate_holder',?,?)`)
 .run(rootId, `${rootId}:g1:a1`,
      JSON.stringify({table:"question_intent", pk:`h1-${MARK}`}),
      new Date(Date.now() - 3*3600*1000).toISOString());
```

3 小时 > `minted` 期限 10min,也 > 3× 的 30min,所以 warning 和 severe 会在**相邻两个 tick**内先后出现。
attempt 1 观测到:03:46:44 开 warning episode,03:47:14 追加 severe(`severe_alerted_at` 落值),
之后每个 tick 幂等不再重复。**期限常量**在 `bridge/delivery-contract/policy.ts`:
minted 10min / granted 5min / sent 15min / received 30min(只对 launch+carrier),severe = 3×。

Discord 侧核验(隔离 529 告警频道):

```bash
TOK=$(grep '^TEST_BOT_TOKEN_1=' ~/.flywheel/.env | head -1 | cut -d= -f2- | tr -d "\"'")
curl -s -H "Authorization: Bot $TOK" \
  "https://discord.com/api/v10/channels/1519421055805165842/messages?limit=30" \
  | python3 -c "import json,sys; [print(m['id'], (m.get('content') or '')[:200]) for m in json.load(sys.stdin) if '$MARK' in json.dumps(m)]"
```

**必须数条数**:一条欠条应当只产生 **1 条 warning + 1 条 severe**。attempt 1 在 aa02a86c2 上数到 **6 条**(3+3),
这就是 §4 的 BLOCKING bug。频道:https://discord.com/channels/1512577412069658634/1519421055805165842

### ③ owning run 终态后按 run_terminal 核销

```bash
curl -s -X POST "http://localhost:19872/api/runs/<runId>/terminate" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"reason":"QA run_terminal probe","clientRequestId":"qa2248-terminate-1"}'
```

> 🔴 `clientRequestId` **必带**,否则回 `{"success":false,"code":"INVALID_RUN_MANAGEMENT_REQUEST"}`。

期望:**一个维护 tick 内**三条 `launch` 全部 `settlement_reason='run_terminal'`,且此后稳定;
终结的 run **不得**留下未关闭的 episode 或新告警。

边界(attempt 1 实测,别误判为 bug):终结后两条 `mailbox` 欠条**仍是 `null`** —— mailbox 家族按
自己的物理终态核销,不按 run 状态,这是 plan 声称的解耦,是对的。

### ④ run 仍 active 的欠条不被误销

run 处于 `active` 期间连续观测。attempt 1 的窗口:8 次观测跨 **11+ 个维护 tick**(30s 一个),
5 条欠条全程 `settlement_reason=null`,`0 episode / 0 alert`。
窗口别开太短——「都还在」的短窗什么都不证明。

### ⑤ absent-source 崩溃证据仍可见 — **attempt 1 没做出来,下一轮请重点攻**

两条路都堵了:
- slot 里删 CommDB 源行被完整性触发器拒:`mailbox delete requires matching archive evidence`
  (先 `UPDATE mailbox_identity SET archived_at=...` 也不够)。**不要绕数据完整性触发器造证据。**
- 去生产快照找真实例:41 条 CommDB-backed 未核销 attempt 里 **0 条**是 absent-source,没有活样本。

建议下一轮换思路:让 projector 先铸出 attempt,再**把整个 slot CommDB 换成一份不含该行的副本**
(停 Bridge → 换文件 → 起 Bridge),这样不用碰触发器就能造出「物理行不存在」。
或者从 native 家族入手(`land` / `gate_holder`),它们的源在 StateStore 自己表里,删除路径不同。
现状只有单测覆盖:`fly2248-r6-projector-recovery.test.ts` 的
`observes an orphan attempt even when its CommDB row was never written`。

## 4. attempt 1 抓到的两条 bug — 返工头上必须复验

**BLOCKING(已在真 Bridge 上复现,不只是 harness)**
`watch.ts` 在没有活 `workflow_run` 时铸合成 run_id `delivery:<root_id>` 写进 `workflow_alert_outbox.run_id`;
入队走私有 `enqueueWorkflowEngineAlertTx` 不校验 run,但 Discord 发出去**之后**
`finishWorkflowAlertDelivery(sent)` 调 `appendWorkflowRunEventCheckedTx` 抛 `workflow run not found`,
把 `sent` 回滚 → dispatcher 记 failed → 重投到 `attempt>=3`。
- 复验判据:种一条 §3-② 的 gate_holder 欠条(它天然没有 run),数 Discord 消息条数,并查 outbox 终态。
  **期望 warning 1 条 + severe 1 条,outbox `state='sent'`**;若仍是 6 条 / `state=failed` 即未修好。
- 阳性对照(证明台架有判别力):同样的欠条,但 `contract_ref` 里带一个**真实存在**的 `runId`,
  且 `workflow_run` 里有对应行 → 应当恰好 1 条消息、`state=sent attempt=1`。
- 附带产品问题:`workflow_engine_escalation` 在 `infra-event-router.ts:188-196` **自动 @ founder**,
  所以每条重复投递都是一次真 founder ping(attempt 1 在隔离频道数到 6 次 `<@…>`)。

**SECONDARY(墙钟回退)**
「未超期」分类会无条件把开着的 episode 以 `closed_reason='advanced'` 关掉(哪怕 attempt/stage/进入时刻完全没变);
`now` 一旦回退(NTP step / 调过表的重启),下一个前进 tick 重插同一 `episode_id` →
`UNIQUE constraint failed: workflow_delivery_contract_episode.episode_id` 抛出 `runPass`。
`watch.runPass` / `projector.runPass` **没有逐行隔离**,一条毒行拖垮整个项目的这一轮 pass,
`plugin.ts` 只 `console.warn` ⇒ 看门狗确定性地静默死掉。
- 复验(内存库 3 拍即可,不用起房):`t=+11min`(超期,开 episode)→ `t=+5min`(时钟回退)→ `t=+12min`。
  第三拍**不得**抛异常;并且要放**两条**欠条,断言第一条出问题时第二条**仍被观察到**(证明有逐行隔离)。

## 5. 收工:污染审计 + 拆房(必做)

```bash
# 生产必须一条痕迹都没有
#   ~/.flywheel/teamlead.db : workflow_alert_outbox 无本轮 MARK;workflow_run 无 project_name='test-slot-2'
#   ~/.flywheel/comm/flywheel/comm.db : mailbox 无本轮注入 id;sessions 无 slot 的 execution_id
cd /private/tmp/fly2248-head && scripts/test-teardown.sh 2
```

拆房**之前**先把证据拷走(`teamlead.db`、`bridge.log`),拆完就没了。

## 6. 留给 Lead / founder 的裁决项(attempt 1 提出,未解决)

1. **两级不是三级,且第一级就 @ founder。** issue 写的是「自动升级告警给 **Lead**」,
   实现是 warning / severe 两级,两级都以 `workflow_engine_escalation` 发出 → 自动 @ founder。
   没有 Lead-only 那一档。
2. **mailbox 家族的「送达」不等于「读到」**(§3-② 的红框)。若 founder 要求
   「没被读的关键信必须升级」,这个家族今天不满足;这属于 issue 第 2/3 点(工人常驻收信、判死先问送达),
   已分别在 FLY-2268 / FLY-2278,不在本 PR 范围内 —— 但下一轮 QA 报告里要写清楚这条边界。

## 7. attempt 1(绑定头 aa02a86c2)本轮结论

判决 **fail**,qa-result claimId=714。证据归档在 `~/.flywheel/artifacts/fly2248/qa-round1/`(含 README 索引)。

| 判据 | 结论 | 关键事实 |
|---|---|---|
| ① 欠条铸出 | **PASS**(全自然,无注入) | 真 DAG run `2bc751b3` 的 3 个 execution 走产线路径铸出 3 条 `launch` 欠条,五个时钟全真;projector 另从真 CommDB 行铸出 `mailbox` 欠条 |
| ② 到期升级 | **梯子对,投递坏** | warning 03:46:44 / severe 03:47:14,后续 tick 幂等;但两条 outbox 都 `state=failed attempt=3`,隔离 529 频道**一条欠条收到 6 条真消息** |
| ③ run_terminal 核销 | **PASS** | terminate 后**一个 tick 内**三条 launch 全部 `settlement_reason=run_terminal`,连续 5 次观测稳定,无残余 episode/告警 |
| ④ active 不误销 | **PASS** | run=active 期间 8 次观测跨 11+ tick,5 条欠条全 `null`,0 episode 0 告警 |
| ⑤ absent-source | **未验证** | 两条路都堵(见 §3-⑤),生产快照 41 条里 0 条真实例。只有单测覆盖 |

补一条 bridge.log 里的独立信号(报告里没来得及写):同一个合成 run_id 还让 **Lead 归属解析不出来** ——
`[delivery-contract] workflow engine alert routing fell back for delivery:...: no configured run owner or session-label owner`,
每个 tick 刷一次。所以合成 run_id 坏的不只是事件回写,**告警该发给谁也定不下来**。

### 🔴 取证教训:拷 slot StateStore 不要用 `cp`

拆房前我拷了 `/tmp/flywheel-test-slot-2/teamlead.db`,但用的是裸 `cp`。SQLite 在 WAL 模式下
`-wal` 边车没跟着拷,副本里 `workflow_delivery_contract_episode` 和 `workflow_alert_outbox` **都是 0 行**,
`settlement_reason` 全 `null` —— 拆房已删 WAL,**行级证据不可恢复**。
承载判据的证据靠 Discord 的 6 条消息和 bridge.log 才保住。

⇒ 下一轮拷证据用 `sqlite3 <db> "VACUUM INTO '<dst>'"`(或先 `PRAGMA wal_checkpoint(TRUNCATE)`),
并且**拷完立刻回读断言关键表非空**再拆房。
