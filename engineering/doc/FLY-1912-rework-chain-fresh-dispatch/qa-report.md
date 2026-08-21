# FLY-1912 rework 验证链撞未跑节点 — QA 独立验证报告

Issue: FLY-1912 (https://linear.app/geoforge3d/issue/FLY-1912/引擎rework-verification-链含未跑节点时-completeworkflowrunnode-直接-throw-http)
日期: 2026-08-20
基于: plan.md

**判定: PASS**
**验证 head**: `9c6a838f62abc85680255ca685f8b3a7264df10d`(PR #908,分支 `flywheel-FLY-1912`)

---

## 0. 一句话

真机 529 隔离房里,事故当天那条必死的交棒(`complete --route needs_review`)**第一次就 200**、
qa 被全新派发、零 `complete-failed` marker;不变量路径从 500 变成**带名字的 409 + 恰 1 条耐久告警**;
marker 回放从"每次心跳重放同一个必失败请求"变成**每小时慢探一次、证据永不丢、状态修好即自动收敛**。

## 1. 验证方法(独立于实现者)

| 手段 | 说明 |
|---|---|
| **RED/GREEN 对照** | QA 自写 harness(13 例),**同一份文件**分别跑在 merge-base 沙箱与 PR head 沙箱。沙箱按记忆里的「冻结 head 只读」配方搭:`rsync` 出 `packages/teamlead`,再用 `git show <merge-base>:<file>` 覆盖 9 个生产文件 + 删掉新模块,`node_modules` 软链回真仓 —— 全程未在共享 worktree 里 `checkout` |
| **真机 529** | 从**被测 worktree** 起 slot 2(`test-deploy.sh 2`),`/health` 逐字核对 `buildSha == 9c6a838f`;用**真** `flywheel-comm complete` CLI 打真 Bridge |
| **回归扫** | 153 个相关测试文件(workflow / rework / marker / heartbeat / auto-qa / alert / event-route / decision / gate) |
| **全仓门** | `pnpm lint` + `pnpm -r build` |

## 2. RED/GREEN — 同一把尺子,两个世界

QA 自写 harness `qa-fly1912-independent.test.ts`(13 例,场景全部用生产公开 API 搭)。

| 世界 | 结果 |
|---|---|
| merge-base `3c41a16f` | **3 passed / 10 failed** |
| PR head `9c6a838f` | **13 passed / 0 failed** |

merge-base 上 A1/A2/A3/B1 四例全部死于生产原话:

```
Error: workflow_rework_preferred_actor_missing
    36616|      throw new Error("workflow_rework_preferred_actor_missing");
```

—— 这就是 FLY-1330 事故现场,用真代码复现出来了。

**尺子本身的阳性对照**(证明 harness 不是"一律红"):
`A4`(qa 有历史 → 链式仍复用旧 actor)、`B2`(非不变量异常仍原样上抛)、`C7`(普通 4xx 仍隔离)
在**两侧都绿** —— 三条既有行为没被这次改动碰过。

merge-base 上 `C1` 的结果是 `quarantined`:修前一个带不变量名的 409 会被**隔离掉证据**;修后是 `held_for_lead`,marker 留在原地。

## 3. 真机 529(slot 2,Bridge = PR head)

`/health` → `buildSha 9c6a838f62abc85680255ca685f8b3a7264df10d`(= 被测 head,不是 main)。
在 slot 的真 `teamlead.db` 上,用 PR head 的**已编译 dist StateStore** 铺出 FLY-1330 的 deadend-⑮ 形状
(`tpl_code` 真模板:design→implement→qa→founder_gate→land;implement/1 done、qa 从未存在、run 走完终态、
operator rework 重开 implement/2 且 wake 已投递)。

### E1 · 核心修复(事故当天那条命令)

```
[complete] session_completed delivered (attempt 1/4)
```

| 断言 | 结果 |
|---|---|
| HTTP | **200,第一次就过**(事故里是连 4 次 500) |
| `complete-failed` marker | **0 个**(事故里落盘且永远清不掉) |
| 新事件 | `rework_verification_fresh_dispatch` @ node `qa`,`reason=target_actor_history_missing` |
| 派发形态 | `node_dispatched` @ qa,`via=engine_intent`,`ordinal=1` —— 与首跑逐字一致 |
| qa 节点 | attempt 1 `pending`,execution_id `8b7146c7-f92c-4498-a923-e9273c80c94e`(全新 uuid) |
| 链可追溯 | `edge_traversed` 的 `edgeId` 仍是 `rework_verify:<req>:implement:qa` |

### E2 · 不变量边界(第 2 件要修的事)

第二个真 run(qa **有**历史 ⇒ 走链式分支),故意把 `workflow_rework_delivery` 提前置 `completed`,
让链式分支的 delivery CAS 必然落空:

| 断言 | 结果 |
|---|---|
| HTTP | **409**(不是 500),`reason=transition_refused` |
| 诊断 | `detail.transitionReason = engine_invariant:workflow_rework_delivery_chain_cas_failed` —— runner 屏幕上看得到名字 |
| 事件 | `completion_transition_refused` 带同一个名字 |
| 告警 | `workflow_alert_outbox` 恰 **1** 条 `engine_invariant:qa1912-run2:implement:2:workflow_rework_delivery_chain_cas_failed`,severity `severe`,disposition `engine_invariant_refusal`,正文含"不要删除 marker" |
| 回滚 | verification path 仍 `active@(implement,2)`、qa/1 仍 `pending`、gate holder **0** 个 |

### E3 · marker 回放断路(第 3 件要修的事)

同一个 marker,连续两次重启 slot Bridge:

```
[complete-reconciler] boot drain: scanned=1 reconciled=0 quarantined=0 held=1
[complete-reconciler] boot drain: scanned=1 reconciled=0 quarantined=0 held=1
```

| 断言 | 结果 |
|---|---|
| 第 1 次 | `held=1`;marker 写入账本 `mode=held`、`invariant=workflow_rework_delivery_chain_cas_failed`、`next_probe_at = +1h`、`alert_state=accepted` |
| 隔离目录 | **不存在**(没有被 quarantine) |
| 第 2 次(仍在 1h 窗内) | `held=1`,`completion_transition_refused` 事件数**不增**(2→2 ⇒ **根本没 POST**),告警仍 **1** 条,`next_probe_at` 未变 |
| 恢复 | 把 delivery 修回 `wake_delivered`、把探针窗口拨到过期 → 下一轮回放**自动 reconciled**:marker **被删除**、implement/2 → `done`、qa/2 `admitted`、path `completed@(qa,2)`,告警仍 1 条 |

—— 「held 不是死路」这条承诺,在真机上跑通了闭环。

**生产零触碰**:全程只动 slot 2;teardown 干净(`Slot 2 released`);生产 Bridge 前后同一个
`buildSha bda55d01`、11 个 session 未变。

## 4. 回归 / 全仓门

| 门 | 结果 |
|---|---|
| 定向套件(实现者写的 10 个文件) | **465 / 465 通过** |
| 相关面广扫(153 文件) | **1881 通过 / 2 skip / 1 失败** |
| `pnpm lint` | **0 error**(7 条既有 warning) |
| `pnpm -r build` | 22 个 workspace 全绿 |

唯一那 1 个失败 = `AlertChannelHub.contract-escalate.test.ts` 的
「byte-identical legacy line」用例(期望 `Annie`,实得 `<@1138241636057481306>`)。
**在 merge-base 沙箱上逐字复现同一个失败** ⇒ 宿主环境项(本机 runner 环境带着 founder Discord ID),
不是本 PR 的回归。

## 5. 诚实边界(没测到的,和为什么)

1. **HTTP 500 的 RED 没在真 Bridge 上亲眼看到**。我把 merge-base 的 Bridge 立起来需要另一套 checkout,
   时间上没做。修前的 500 由两条证据支撑:(a)merge-base **真代码**在 QA harness 里抛出
   `workflow_rework_preferred_actor_missing`;(b)base 的 `commitEnrolledCompletion` catch 只在
   `transitionRefusal` 有值时收口,裸 `Error` 会原样 rethrow ⇒ express 兜底 500。这是**代码核对**,不是真机观测。
2. **新告警的 Discord 最后一公里没渲染出来**。slot 2 里所有 `workflow_engine_escalation` 类告警
   都以 `unknown infra alert owner: claude-infra-bot-lead` 收场 —— 包括**本 PR 完全没碰过的**
   `completion_receipt_missing`(同房同样失败)⇒ 这是 529 房的 infra-bot 未配置,不是本 PR 的回归。
   本 PR 新增的那一段(**入队 + 去重 + 原子性**)在真机上验到了;Discord 渲染那一段走的是既有
   `LeadAlertNotifier` + 一张静态文案表,只有单测覆盖。房间本身的 Lead 投递腿是活的
   (slot Lead launchd 在跑,`lead_events.session_started` 有 `delivered_at`)。
3. **5xx 退避阶梯(1m/2m/4m/8m…封顶 1h)+ 第 3 次告警一次**,是拿真 reconciler 代码在 QA harness 里验的
   (C2/C3:实测 delays `[60s,120s,240s,480s]`、4 次 POST 只 1 条告警、窗口内 0 次 POST),
   **没有**在真 Bridge 上人为制造 500。
4. 没做 Claude-in-Chrome 的 founder 视觉核对 —— 本单没有 founder 交互面改动。

## 6. 给 Lead 的 advisory(不阻断 ship)

**A1 · 永久 pending 的告警会把一次本可恢复的 5xx episode 卡死。**
Rule 0(`alert_state === "pending"` 压倒一切)在 sink 抛错时只重试告警、**永不 POST**。
`durableAlertAccepted` 认 `queued`,所以 Discord 挂掉不会触发这条;但如果
`resolveLeadForIssue` 因**配置**永久解析不出 lead(会 throw → `no lead`),
那么 5xx 第 3 次写下的 pending 就再也翻不过去 —— 即使 Bridge 早就恢复,completion 也不会重放。
这是 plan R2 #2 明确选择的 fail-closed 姿态(比修前的"每次心跳无限重放"好得多,证据也保住了),
所以我不判 FAIL;但值得记一条 follow-up:给 pending 一个"重试 N 次仍失败 → 记录并放行 POST"的出口,
或至少让这种永久 pending 发一条**不同 sink** 的响声。
我在 slot 里确实观测到了"告警 owner 解析不出来"这类真实环境(`unknown infra alert owner`),
但那是引擎 outbox 那条腿,**不等于**已经证明 Rule 0 这条路可达 —— 只说明 sink 失败在现实中不稀奇。

**A2 · 诊断形状是刻意的,别读成损坏。**
fresh dispatch 之后,`workflow_rework_route_revision.target_node_id` 仍是 `implement`,
而 `workflow_rework_verification_path.current_node_id` 已经是 `qa`。真机 E1 复现了这个形状。
plan §2.1 写明是刻意保留;运维读到"route 目标 ≠ path 当前节点"应读作"链在推进"。

**A3 · `alertPending` 兜底的 eventId 与源头不同形。**
reconciler 在 `generalizedBinding` 与 marker activation **都缺**时,退化成
`engine_invariant:${execId}:${invariant}`,与源头的 `...:${runId}:${nodeId}:${attempt}:...` 不同形,
理论上会绕开去重。生产上两个 HTTP 边界身份永不为空(所以 `alertPending` 不出现),影响面接近零。

## 7. 复现命令(证据可再跑)

```bash
# RED/GREEN(沙箱路径见报告正文;harness 文件随本报告留在 scratchpad)
cd <sbx-base>/packages/teamlead && npx vitest run src/__tests__/qa-fly1912-independent.test.ts   # 3 pass / 10 fail
cd <sbx-head>/packages/teamlead && npx vitest run src/__tests__/qa-fly1912-independent.test.ts   # 13 pass

# 真机 529(必须从被测 worktree 起,并先洗掉继承的 FLYWHEEL_* 环境)
for v in $(env | grep -oE '^FLYWHEEL_(CODEX|LEAD|ROUNDTABLE|RUNNER|THREE_STAGE|AGENT|COMM)[A-Z_]*'); do unset "$v"; done
TMPDIR=/tmp/ TEST_REPLY_BY_ISSUE=1 bash scripts/test-deploy.sh 2
curl -s localhost:19872/health | python3 -c "import json,sys;print(json.load(sys.stdin)['buildSha'])"   # 必须 == 被测 head
```
