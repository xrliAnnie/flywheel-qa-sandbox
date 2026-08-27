# FLY-2080 巡检推进与病根记账 — 实施计划
Issue: FLY-2080 (https://linear.app/geoforge3d/issue/FLY-2080/巡检升级-发现即补账推进-病根记录进-epic所有-lead-巡检强制两步founder-8-26-直令)
日期: 2026-08-26
基于: research.md

## 1. 范围

只改巡检发现后的处置合同：

- `packages/teamlead/lead-rules-base/runner-patrol-rules.md`：目的段、STEP 6、完成门、两个 8-26 配方附录；
- `packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts`：新增 FLY-2080 内容与 gate 契约测试；
- `packages/teamlead/scripts/lead-rules-bundle.sh`、`scripts/claude-lead.sh` + bundle/FLY-369 tests：同时修 full-access resolver 与 live Claude `cos-lead` 的独立 role→file map，把同一 patrol rule 装入 `cos` bundle；
- `engineering/doc/FLY-2080-patrol-action-ledger/`：本单 doc-flow、progress、最终 qa-report；
- `engineering/doc/milestones/FLY-2080.md`：PR 最后一笔 milestone。

明确不改：`scripts/lead-patrol-snapshot.sh`、STEP 1–5 检测 SQL、canonical pane 定义、patrol cadence、六步数量、任何 Bridge/StateStore runtime 行为。CoS 已在 tick eligibility 内；bundle wiring 只补 A/B post-finding contract，不扩大检测面或频率。

## 2. 规则正文结构

### 2.1 目的段

在文件开头现有“Lead 是唯一真相通道”的背景后先定义「巡检的 goal」，逐字加入 founder 2026-08-26 19:42/19:43 两段直令：每个 Lead 要把 orchestrator 一直推到每个 issue 的 Ship card，只有确需 founder 回答才停；founder 派完事应能休息，回来时工作已到可 review 状态。随后并列加入 19:13 的两步直令，并明确“推进器 + 账本”：A（补账推进）/B（病根记账）是实现 goal 的手段，不能只记录待撞。

规则与内容测试 pin 以下原文：

> 2026-08-26 19:42:58：「既然这样的话,巡检还有一个 goal 需要写进去,就是每一个 Lead 都需要知道,他们的 goal 是要把 orchestrator 一直推到每个 issue 最后到达 Ship card 那个地方。唯一需要停下来的情况,就是如果有真正的问题必须要我来回答才可以,那 OK,可以停下来等我回答。但除此以外,必须非常激进地去推进这些项目,比如有问题了就去修、runner 卡住了就去推,必须非常激进地往前推进,而不是记录一下发生了什么情况然后就去休息了。我希望在 2080 中,也能够通过巡检让 Lead 明确知道必须做到这一点」

> 2026-08-26 19:43:17：「我希望的是,我把事情派给你之后,我就可以去休息了。在这个过程中,你有问题就来问我;没有问题你就往前推,一直推到我有时间来看的时候,这个东西已经推进到我可以 review 的状态。而不是我中途发现好像有一堆问题,而你又坐在那什么都不干。」

### 2.2 STEP 6 强制步骤 A

在现有跨界/UNAVAILABLE 逻辑之前加入每个 finding 都执行的强制判定：

1. 读报告中的 exact shape，再定位 Bridge 日志错误码和源码守卫；把 WHERE/if 条件逐条写入报告。
2. 分类：
   - 防篡改/真实性守卫：digest、authority、head fingerprint、approval、founder consent 等。禁止修改；result 只能 `escalated-with-plan`，上报 founder/owner、下一步与证据。
   - 防漏账守卫：引擎已产生真实事实，但漏写/漏联一笔账。按 8-19 / 8-23 / 8-26 三次 founder 直令当场补，不再逐次请示；同时逐字写死 scope：只补 ledger/route/delivery/event 这类“补上即真”的账。
3. 四条硬边界：真实性 guard 停手；永不写 authority/gate/approval/claim；永不终结 Runner 或丢工作；每次 before/after evidence + FLY-2072。并注记 R5 registry 正式 entry 另单修订，本文件不扩 universal contract。
4. 漏账当场按 exact recipe 补；补后必须等 Bridge 至少一个 reconcile tick，并记录 pane hash/change 或新 `workflow_run_event` seq/kind，证明不是“SQL 成功但引擎未接力”。
5. 禁止 `known-waiting` / “已知，等着”；recipe precondition 不满足的项必须有明确 owner、动作与 evidence，成为 `escalated-with-plan`。

### 2.3 STEP 6 强制步骤 B

对 `bridge_problem=yes` 的每个 finding：

1. 用现有 `GET /api/linear/comments?issueId=FLY-2072&limit=100[&after=...]`（省略 `projectName`）分页读完 FLY-2072 comments，按错误码、表/字段和断裂剧本查先例。
2. 用 `POST /api/linear/comment` 追加固定四段 comment：
   - 形状：错误码 / 卡点 / run/request/execution 稳定标识；
   - 根因：漏的表/字段或断裂剧本；
   - 处置：改了什么 + Bridge 接力 pane/event 证据；
   - 是否重复：引用先例 comment id/url；无先例则明确当次检索未找到。
3. comment 内嵌唯一稳定行 `patrol-finding:<report>:<step>:<ordinal>:<64hex>`；`POST /api/linear/comment` body 只含 `{issueId:"FLY-2072",body}`，响应 `.ok == true` 后按 id 复读并要求该 marker substring 存在（不比较可能被 Linear newline/Markdown normalize 的 whole body）。只有 UUID 与 marker receipt 都成立才写 finding 行；失败写 `UNAVAILABLE_CAUSE step=6 class=transient token=linear_epic_unavailable`。

### 2.4 finding 行与完成门

Lead 定稿时，每个 distinct finding 追加一行：

```text
FINDING step=<1-6> bridge_problem=<yes|no> result=<fixed|advanced|escalated-with-plan> evidence=<stable-token> owner=<agent:agent-id|founder|n/a> next=<inspect:token|repair:token|authorize:token|route:token|file:token|retry:token|n/a> epic=<FLY-2072#comment-uuid|n/a|unavailable> epic_marker=<64hex|n/a>
```

语义：

- `fixed`：finding 已消失且接力证据成立；
- `advanced`：Bridge 已接力到下一可执行状态，仍需正常 pipeline 收口；
- `escalated-with-plan`：真实性/越权/跨界或 recipe guard 不成立的形状未改账，但已给 owner、下一动作和证据。

在现有 gate 中加入一个 POSIX `awk` validator：

- 解析 `STEP n: FINDING`，要求同 step 至少一条 `FINDING step=n`；
- validator 的输入只取 `/^FINDING /`，逐行解析 `bridge_problem/result/epic/epic_marker`，避免误吃 `PANE_EVIDENCE result=`；result 非三值立即失败；
- `bridge_problem=yes` 正常只接受 UUID-shaped `epic=FLY-2072#...` 与 64-hex marker digest；Linear 不可用时只接受 `epic=unavailable epic_marker=n/a`，且报告必须有 `UNAVAILABLE_CAUSE step=6 class=transient token=linear_epic_unavailable`；`no` 仅接受两者 `n/a`；
- 单一 STEP 6 cause 的状态行直接用其 class/token；同时多个 cause 时每个写一条 `UNAVAILABLE_CAUSE`，唯一状态行用 `multiple_unavailable` aggregate（任一 structural 则 structural，否则 transient）。搜重/建单仍逐个 `UNAVAILABLE_CAUSE` 的 token 生成 title，不用 aggregate title，不覆盖既有 cause；
- `fixed|advanced` 要求 `owner=n/a next=n/a`；`escalated-with-plan` 的 owner 只接受 `founder` 或 `agent:<registered-id-shape>`，next 只接受有限 verb prefix `inspect|repair|authorize|route|file|retry:<token>`；因此 `tbd` 无法过 gate；
- validator exit 非 0 就没有完成。

这会结构性拒绝任何 known-waiting 类 result，而不靠枚举所有拼写。

## 3. 附录 A：receipt 死结配方

规则中提供可复制的 shell + `sqlite3 -bail` 事务。权威 DB 路径沿用快照脚本：

```sh
STATE_DB="${FLYWHEEL_STATE_DB_PATH:-${TEAMLEAD_DB_PATH:-$HOME/.flywheel/teamlead.db}}"
REQUEST_ID='<exact request_id from the read-only probe>'
```

执行前固定 `PRAGMA foreign_keys=ON`、`PRAGMA busy_timeout=5000`，把 DB `.backup` 到 mode 0600 的 patrol repair 目录，并记录 `MAX(workflow_run_event.seq)` baseline。只读 probe：

- 只读 join `workflow_rework_delivery d → workflow_rework_request q → workflow_run r → workflow_rework_route_revision rr`；
- 必须恰好一行，且 `d.state='held'`、`d.last_error='delivery_awaiting_receipt'`、`r.engine_owned=1`、`r.status='held'`、`d.route_revision` 是 latest route；
- pane/commit/turn evidence 证明 `rr.preferred_actor_execution_id` 确已收到并完成该 rework；否则这是伪造 receipt，立即按真实性类停手；
- target `workflow_run_node` 必须恰为 `admitted` 且 execution 与 latest route actor 相同；verification path 若存在必须恰为 `pending`；
- `workflow_carrier_delivery` 对该 run 不得有 `state='held' AND last_error LIKE 'run_inactive:%'`。存在时说明还有第三本联动账，本两行配方不适用，必须把 exact carrier repair 加入 plan，禁止留下 stranded card。

`BEGIN IMMEDIATE` 内建 TEMP CHECK table 并逐步断言：

1. 用完整 join 重证 precondition 恰好一组；
2. append `workflow_rework_route_revision revision=old+1`，复制 target/policy 且保持同 actor，`interpreted_by='patrol:FLY-2080'`；这样既有 `rework_stalled_*:rev<old>` receipt 不会永久禁用新一轮 watchdog；delivery/path 后续都切到 new revision；
3. `workflow_rework_delivery` 以 `(request_id,old_revision,state='held',last_error='delivery_awaiting_receipt')` CAS 改 `route_revision=new,state='wake_delivered',hold_count=0`，清 `owner_id/lease_expires_at/last_error`，`next_retry_at=NULL`、`updated_at=NOW`，要求 `changes()==1`；
4. `workflow_run_node` 用完整 `(run_id,node_id,attempt,execution_id,state='admitted')` CAS 改 `state='running'`，要求 `changes()==1`；
5. verification path 存在时用 `(request_id,old_revision,state='pending')` CAS 改 `route_revision=new,state='active',updated_at=NOW`，变化数必须等于 preflight path count（0 或 1）；
6. `workflow_run` 以 `(run_id,engine_owned=1,status='held')` CAS 改 `status='active'`，并在 WHERE 反查同 request delivery=`wake_delivered`、node=`running`、path 不存在或=`active`，要求 `changes()==1`；
7. append `rework_delivery_wake_delivered:<request_id>` event，payload 如实写 `{requestId,generation,from:'held',fromReason:'delivery_awaiting_receipt',to:'wake_delivered',routeRevision:new}`；同 UID/同事实已存在或任何 CHECK 失败都 rollback。delivery/run 核心两字段必须同拨，route/node/path/event 也在同一 transaction。

这不是伪装调用正常 receipt API，而是修复 8-26 已证实“工作真实完成、receipt 剧本漏记”后被 stall escalator 锁住的完整 receipt state。transaction 后的静态验收必须是 delivery=`wake_delivered` + node=`running` + path absent/`active` + run=`active`；再连续读 baseline 之后的新 engine event 与目标 pane，必须出现 Bridge 自己的 reconcile/dispatch/complete 证据，才能记 `advanced|fixed`。

## 4. 附录 B：replacement 铸造漏账配方

### 4.1 主事务

输入 `REQUEST_ID` 与引擎已经 reserve 的 `NEW_EXECUTION_ID`。只读 probe 必须恰好一组：

- request/run 存在，`engine_owned=1`、run 是 `active|held`、base revision 是 40-char lowercase SHA；
- latest route 仍指旧 execution，delivery 指该 latest revision 且处于非终态；
- `workflow_actor` 已有新 execution；
- `workflow_run_node` 已在同 run/node/attempt 指向新 execution，state 为 `pending|admitted|running`；
- 对 `NEW_EXECUTION_ID` 恰好一条、且该 attempt 最大 `launch_ordinal` 的 `workflow_side_effect_ledger` dispatch row，`state IN ('intent_recorded','launch_committed')`、`reason IS NULL OR trim(reason)=''`；同 attempt 的旧 execution 历史 rows 允许存在；
- 没有任何 route revision 已指向新 execution。

若新 actor/run-node/dispatch 任一不存在，属于“铸造事实不存在”，禁止由 Lead 造身份。

先记录 event seq baseline；`BEGIN IMMEDIATE` 内：

1. 以完整 `(run_id,node_id,attempt,kind='dispatch',launch_ordinal,execution_id,state,reason-empty)` CAS 把 reason 改为 `rework_replacement:<REQUEST_ID>`；
2. 从旧 latest route 复制 immutable JSON/policy 字段，append `revision=old+1`，只把 `preferred_actor_execution_id` 改为新 execution，`interpreted_by='patrol:FLY-2080'`；
3. delivery 以 `(request_id,old_revision,old_state)` CAS 改为 `route_revision=new`、`state='replacement_pending'`、清 owner/lease/retry；
4. 若 verification path 存在且是 `pending|active`，同事务把它的 route revision 改到 new；若存在但不是这两个 state 就 rollback；
5. 若 run 因同一 `delivery_replacement_pending` hold 处于 `held`，同事务 CAS 回 `active`；要求当前没有 held carrier delivery，否则本配方退出并给扩展 repair plan；
6. 每个必需写均以 TEMP CHECK table 断言恰好一行，可选 path/run 写断言 0 或 1 且与 preflight count 相等；任一步不满足全部 rollback。

补后 dispatcher 的 replacement guard 应全部成立：reason prefix、request/run、route node/attempt/execution、delivery revision/state、base SHA。

### 4.2 predecessor 事件诊断分支

仅当后续 generic replacement 明确报 `engine_predecessor_unavailable` 执行。replacement-context dispatch 本身不走该分支；generic replacement 的 reason 为空，会沿 rollback 链回溯到最初 rework target，因此要先证明：

- rollback chain 中每个 `execution_dead_rolled_back.payload.newExecutionId` 对应唯一 predecessor execution，最终落到最初 target execution；
- 最初 target execution 没有 `edge_traversed.payload.successorExecutionId`；
- 恰好一个既有 QA `node_completed outcome='qa_fail'` / rework request / target node+attempt / snapshot loop 组合证明实际 transition，得到 source node/execution/attempt、`edgeId` 与 target；`loopIteration = COUNT(kind IN ('loop_iteration','loop_limit_escalated') AND edge_id=<edge>) + 1`，与 `workflowLoopIterationCount` 同口径；候选 0 或多条都停手；
- source QA execution 的 `sessions` row 仍存在，并用引擎同一 `resolveWorkflowHeadAuthority` read-only probe 得到 40-hex `prHeadSha`；缺 session 或 head invalid 都停手，不写 append-only event。

一个 `BEGIN IMMEDIATE` 事务内 append canonical pair：先写 `edge_traversed`（source QA node/execution + 完整 payload `{edgeId,targetNodeId,targetAttempt,sourceAttempt,outcome:'qa_fail',successorExecutionId,reworkRequestId,loopIteration}`），再写配套 `loop_iteration`（同 source/edge/execution，payload `{iteration:loopIteration,maxIterations}`）；两条各取连续 next seq 与 deterministic repair UID。INSERT 前重复唯一性/absence guard；任一已存在/冲突则全部 rollback。

最后同样必须以新 event 或 pane 变化证明 dispatcher 已 launch/advance；只见 SQL rows changed 不算完成。

## 5. TDD 与验证顺序

1. RED：扩展 `fly369-patrol-rule.test.ts`，断言步骤 A/B、founder 原话、result allowlist、FLY-2072 receipt、两个 recipe 的 exact 表/字段/guard anchors；运行单测确认因规则未改而失败。
2. GREEN：只编辑 `runner-patrol-rules.md` 达成内容合同。
3. REFACTOR：压缩重复措辞，确保 STEP 1–5、cadence、STEP 6 既有 `TRUNCATED...jq` 和首个 `FINAL_STEP_COUNT="$(grep -Ec...)"` 命令文本/相对顺序不改；新 validator 只追加在这两个 extraction anchor 之后。
4. 定向验证：
   - `pnpm --filter flywheel-teamlead test src/__tests__/fly369-patrol-rule.test.ts`；
   - `pnpm --filter flywheel-teamlead test src/__tests__/lead-rules-bundle.test.ts`，证明 dept/cos 两种 backend 都装同一 patrol rule；
   - 对规则内提取出的 `awk` validator 运行正反 fixture：三种合法值通过，`known-waiting`、漏 epic、FINDING step 无 detail 均失败；
   - `git diff -- scripts/lead-patrol-snapshot.sh` 必须为空。
5. Runner 全仓门：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`；遵守 host 资源纪律，若全量测试对生产 Bridge 造成负载风险，先用现有安全命令/CI 证据并如实报告。
6. Codex code review：按 review gate 注册，CHANGES 则修复并新开 review，直到 `reviewVerdict=APPROVED`。
7. commit/push/PR；最后一 commit 新建 `engineering/doc/milestones/FLY-2080.md`，不改 `CLAUDE.md`。
8. 当前 DAG implement node 以 `complete --route needs_review --pr <number>` 交回 orchestrator，不请求 ship、不 merge。

## 6. 风险与控制

| 风险 | 控制 |
|---|---|
| 把真实性守卫当漏账 | 明确分类 + exact source guard transcription；真实性类只升级 |
| raw SQL 留下半状态 | A 同事务覆盖 delivery/run/node/path/event 并排除 carrier；B 同步 route/delivery/path/run；extra ledger 出现即退出 |
| R5 authority 漂移 | 三次 founder 直令逐字引用 + 四条硬边界；正式 registry entry 明示另单，不借本文件扩 authority |
| 覆盖并发新状态 | 每次写带 identity/state/revision CAS，TEMP CHECK + 单事务失败回滚 |
| 人工铸造 identity/provenance | 禁止新建 actor/execution/authority；event 仅补唯一证据已证明的 missing transition，歧义停手 |
| 记账流于模板 | comment 必带接力证据和 prior reference；用 stable marker 复读 pin comment id，不依赖 whole-body normalization |
| “所有 Lead”名不副实 | cos bundle 同样装 `runner-patrol-rules.md`；不改 tick eligibility/cadence |
| always-loaded context 变长 | 验收明确要求两配方在本规则附录可独立执行；正文只留分类/gate，附录压缩为 command template，不重复源码解释 |
| 范围漂移 | snapshot 脚本、STEP 1–5、cadence 零 diff；测试继续 pin 既有六步合同 |
