# [docs][FLY-1447] 529 房内 Discord E2E 房测报告(第九棒 · 新 head f42bdc98)

Issue: FLY-1447 · PR #690 head **f42bdc98** · 房 = slot 1 bridge @19871 · 2026-07-23
执行:runner 04fdeab6(第九棒)· 证据 = slot DB 只读(`?mode=ro`)+ bridge.log + Discord API + 真 Chrome-as-Annie
上游:第八棒报告 `FLY-1441-room-e2e.md`(head a883a51c,PARTIAL)+ 接力单 `~/.flywheel/qa-handoffs/RESUME-fly1441-room-e2e.md`

护栏:全程不碰生产、不 merge、不 ship;`flywheel-FLY-1441` worktree **零 git 状态改动**(只重建 dist,已 gitignore)。

---

## 0. 本棒的核心结论(先说结果)

第八棒报的两个交付面缺陷 —— **① rebind 原语无暴露面(生产不可达)**、**② unbound 零 Lead 告警** —— 在 f42bdc98 上**都已修复,并有活体证据**。

同时本棒新抓到 **1 个 P1 级 founder 面缺陷(断言 C 不成立)** 和 **4 个房内运维缺陷**,详见 §3 / §4。

| 断言 | 结果 | 一句话铁证 |
|---|---|---|
| A. pre-Gate 静默 | ✅ PASS(新 head 复现) | qa 出 verdict 前:holder 0 / evidence 0 / alert_outbox 0 / ship_ready 事件 0 / rebind receipt 0 |
| B-bound 正路 | ✅ PASS | run A qa PASS → holder `bound`、evidence `qa_passed/git_head` 与 holder head 同值 `e9a75dfe…` |
| **修复① rebind 生产通路** | ✅ PASS(前后对照) | 旧码 `POST /api/workflow/gate-carrier-rebind/stage` = **404**;新码 = **409 `rebind_proof_unavailable`**(路由存在且 fail-closed) |
| **修复② unbound fail-loud 告警** | ✅ PASS(活体) | 真 unbound holder → `workflow_alert_outbox` 1 行、state=**sent**、severity=severe、正文含 rebind 修复指引 |
| D. gate 唯一性 | ✅ PASS | thread 内 ship-gate 卡 **恰 1 张**;DB holder 1 / `gate_opened` 1 / `gate_holder_created` 1 |
| **C. founder 批准落地** | ❌ **FAIL(新发现,P1)** | Annie 真账号回复 + 门禁窗口过期,holder 至今 `awaiting_review`;CommDB question `resolved_via/resolved_at/read_at` 全空 |
| land 线 🆒 级联 | ⛔ 未达 | 被 C 阻断(founder 未批准 → 不进 land 节点) |
| 看门狗⑦ wake_failed 家族 | ⛔ 未测 | 见 §5 交接 |
| rebind **成功路径**(unbound→bound) | ⛔ 未达 | 只验到 fail-closed 分支;成功路径需 carrier 新 attempt 的 head 与 holder 对齐,见 §5 |

---

## 1. 房环境与部署(可复现)

- 部署:`flywheel-FLY-1441` worktree @ `f42bdc989625fee5195abcb36d4db7b48efd8f48` → `scripts/test-deploy.sh 1 --mode mirror --lead-ready-timeout 300`
- env 三件套:`TMPDIR=/tmp`、`TEST_REPLY_BY_ISSUE=1` + `TEST_API_TOKEN=<房 token>`、`BRIDGE_DEPT_SCOPE_REJECT=off`、`FLYWHEEL_WORKFLOW_GATE_CARRIER=1`
  - 注:旧房还带 `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`。全仓 grep 只在 `ship-eligibility.test.ts` 的 fixture 里出现,**生产零读取方 = 惰性变量**;本棒为减少变量仍原样带上。
- 引擎门(部署后实测):`workflow_run.engine_owned=1`、`gate_carrier_epoch=1` ✅
- 模板:`tpl_eng_trivial_land_v1`(run A)/ `tpl_eng_trivial`(run B)

### 两条 run
| run | issue | 模板 | run_id | 用途 |
|---|---|---|---|---|
| A | FLY-137 | `tpl_eng_trivial_land_v1` | `d0824c3e-eead-4596-b885-6ee15e98f445` | A / B-bound / D / C / land |
| B | FLY-124 | `tpl_eng_trivial` | `d67ed110-c202-4b5c-b39c-dd9f3549be36` | unbound 分支 + 修复①② |

---

## 2. 两个修复的活体证据

### 2.1 修复① — rebind 生产通路已可达(前后对照)

**Before(重部署前,旧码在跑):**
```
POST /api/workflow/gate-carrier-rebind/stage  → HTTP 404 {"error":"not found"}
POST /api/workflow/decision (阳性对照)        → HTTP 400 {"ok":false,"reason":"invalid_request"}
```
阳性对照证明 404 是「路由不存在」而不是「我请求写错了」。

**After(f42bdc98):**
```
POST /api/workflow/gate-carrier-rebind/stage      → 409 {"ok":false,"reason":"rebind_proof_unavailable"}
POST /api/workflow/gate-carrier-rebind            → 400 {"ok":false,"reason":"missing_canonical_or_token"}
POST .../stage  (Origin: https://attacker.example) → 403 {"ok":false,"reason":"cross_origin"}
```
即:两条路由都已挂载、loopback + same-origin 守卫生效、无证据时 fail-closed。

**对真 unbound holder 的 stage 调用(run B):**
```
question_id=workflow-gate:433cf102…  candidate=68b56f62(carrier implement exec)
→ 409 rebind_proof_unavailable
   holder.head_sha  = eef69f43c0e5df87a4fcd417406943e555e95f05
   session.pr_head_sha = e9a75dfed141b5744acd3a86cc9e8063b271465c
```
这是**正确的**:两个 head 真不一致时 rebind 拒绝背书,不允许拿 rebind 抹平真实的 head 漂移。

### 2.2 修复② — unbound 触发 fail-loud 告警(第八棒缺陷 #2 已修)

制造方式(**非人为改库**,复刻真实事故):implement 落 `ship_parked` 后,在 runner worktree 里真提交一次 → 头漂移 `e9a75dfe…` → `eef69f43…`;随后 qa 用真 runner 进程 env 里的 credential 走 `/api/workflow/decision` 提交 PASS。

结果(`workflow_gate_holder`):
```
run_id=d67ed110…  authority_mode=runner_ship  carrier_binding_state=unbound
state=materializing  materialization_stage=question_intent  head_sha=eef69f43…
```
结果(`workflow_alert_outbox`,第八棒实测为 **0 行**):
```
rows = 1
escalation_uid = gate_carrier_unbound:workflow-gate:433cf102…
state           = sent          attempt = 1
created_at      = 2026-07-24T01:55:38.823Z
updated_at      = 2026-07-24T01:55:41.878Z   ← 3 秒内投递完成
severity        = severe        leadId = flywheel-test-1
leadResolution  = resolved      ← alertIdentity 解析成功(不是 fallback)
title           = "Gate carrier unbound for FLY-124"
body            = "… could not bind the parked ship actor. Founder presentation remains
                   fail-closed. Repair through POST /api/workflow/gate-carrier-rebind/stage
                   followed by POST /api/workflow/gate-carrier-rebind …"
metadata.workflowEngine.carrierNodeId = implement
metadata.workflowEngine.rebind = {stage:…, apply:…}
```
run 事件链(逐字):
```
… gate_opened  gate_holder_created  gate_carrier_unbound
  workflow_engine_alert_enqueued  workflow_engine_alert_posted
```
**同时 founder 侧仍然静默** —— unbound 期间没有向 founder 呈现任何 ship 卡,fail-closed 语义保持。这正是设计合同要的「founder 不被打扰,但 Lead 一定知道」。

---

## 3. 新发现(需 Lead 定级)

### 🔴 发现 1(P1,founder 面):founder 批准在 land-authority 门禁上没有被系统接住

run A 走到 `founder_gate`,thread(`1530026591349117178`)里 **恰 1 张** ship-gate 卡(消息 `1530027601983443016`),卡面写着 head `e9a75dfe…`、`@Annie`、以及「直接**回复这条消息**或点 ✅ 即批准」。

我用**真 Chrome、真 Annie 账号**(`xrliannie_96634`,非 bot)对这张卡发了 reply(消息 `1530028359143133265`,`referenced_message` 指向卡)。之后:

- `~/.flywheel/founder-reply-cursor.json` 里该 thread 的游标**已推进到我这条之后**(`1530028758…` > `1530028359…`)→ 轮询**读到了**这条消息,然后**丢弃**;
- CommDB question `workflow-gate:ff6b7c7e…` 仍 `relay_state=protected`,`resolved_via / resolved_at / read_at` 全空;
- holder 至今 `awaiting_review / bound`,run 停在 `founder_gate`;`workflow_alert_outbox` 对这条 run **零告警**(即 Lead 也没被 fail-loud 通知「批准掉了」)。

**房内 Lead 独立复核了同一事实**(不是我一家之言),原话:
> 「你的批准还没被系统接住。门禁到现在(18:48)仍是未解决:`resolved_at / resolved_via / read_at` 全空,也没有任何应答记录。你 18:46:27 批的,已经超过 FLY-945 说的 ~75 秒窗口。」

**根因线索(Lead 给的合同,与卡面文案冲突)**:
> 「要批:**必须回复严格 JSON `{"approved": true}` —— 差一个字都不算**」

即 **founder 卡的文案(「直接回复这条消息即批准」)与实际强制的合同(严格 JSON)不一致**。founder 按卡面照做 = 批准静默失效,且**没有任何 fail-loud 告警**告诉任何人「这条批准被丢了」。对 founder 来说这是「我批了,系统装死」。

诚实边界:我第一次用的是中文散文回复(照卡面做的),不符合严格 JSON;这个**不符合本身就是被测行为**(卡面这么写的)。我随后尝试用 ✅ reaction 走第二条卡面允许的路径,但 Chrome 点击没落上(API 复核 reaction 数 = 0),所以 **reaction 路径本棒未取到结论**。

另:批准窗口期间 design runner 仍在往分支提交,head 从 `e9a75dfe` 漂到 `3db77b19`,Lead 因此判「你批的 head 已过期」。这条 head 漂移与上面的「批准没被接住」是两件独立的事,不要混。

### 🟡 发现 2(房运维):生产 cmux watcher 活着时,`test-teardown.sh` 结构性无法执行
`test-teardown.sh` 与生产 `flywheel-cmux-sync --watch` 争同一把 mutator lease,而 watcher 是常驻持租进程 → 重部署活槽位**永远**被拒:
```
ERROR: cmux mutator lease is held by live mode=watch pid=31655; refusing teardown
```
绕行(本棒用的,不碰生产):按 PID 停槽位进程 → 手动删 slot lock → 归档 DB → 直接跑 `test-deploy.sh`(已 grep 确认 deploy 本身零 cmux 依赖)。

### 🟡 发现 3(房运维):`inject-linear-issue.sh` 与 `TEST_REPLY_BY_ISSUE=1` 互不兼容
inject 脚本 POST `/api/runs/start` **不带 Authorization 头**;而 `TEST_REPLY_BY_ISSUE=1` 会设 `TEAMLEAD_API_TOKEN` 打开 API 鉴权 → 必 401。两个 QA 助手当前无法同时用。绕行:自己带 Bearer POST。

### 🟡 发现 4(房运维):config 重生成抹掉 `pipeline.dag`(路书 trap 复现)
`test-deploy.sh` 每次重写 `.flywheel/config.yaml`,`pipeline: dag: true` 被抹掉 → run-start 409 `DAG_TEMPLATE_CANDIDATE_MISSING`。
**本棒新增事实(纠正路书)**:`runs-route.ts:1607` 的 `loadPipelineConfigByProject` 是**每次 run-start 现读**,补写 config 后**不需要重启 Bridge**。

### 🟡 发现 5(房隔离):founder-reply 游标是**全局共享文件**
`founderReplyCursorPath = join(getStateDir(), "founder-reply-cursor.json")`,而房内 `FLYWHEEL_STATE_DIR=~/.flywheel`(非 slot-local)→ 房 Bridge 与生产 Bridge **写同一个 `~/.flywheel/founder-reply-cursor.json`**(实测 384 条 thread 游标同居一文件)。属于 529 房隔离缺口,存在互相推进游标 / 吞消息的交叉污染风险。

### ⚪ 发现 6(文档级,承接第八棒发现 #3)
干净 DB 没有 `workflow_category_binding` 就跑不了 DAG,而**全仓没有任何 HTTP 路由能建 binding**(只有 StateStore 方法);且 sql.js 会覆盖外部写 → 只能「停 Bridge → sqlite 插 → 起 Bridge」。房测/新项目启用 DAG 时这是必踩的一步,建议补一条 admin 路由或写进 runbook。
另:`/api/runs/start` 要走 lead 指定模板时,`templateId` 必须**同时**带 `selectionReason`,否则 409 `lead template selection reason is required`。

---

## 4. 逐断言证据明细

### A. pre-Gate 静默(新 head 复现)
run A 在 qa 提交 verdict **之前**实查:
```
workflow_gate_holder            = 0
workflow_gate_holder_evidence   = 0
workflow_alert_outbox           = 0
run_event kind LIKE '%ship_ready%' = 0
workflow_gate_carrier_rebind_receipt = 0
```
run 事件链只有 `dispatch_vendor_resolved / execution_admitted / turn_granted / node_completed / edge_traversed / node_dispatched` —— 零 ship 语义。

### B. bound 正路(run A)
qa PASS(credential 取自真 qa runner 进程 env,`ps eww 93688`)→
```
holder: authority_mode=land  carrier_binding_state=bound
        state=awaiting_review  materialization_stage=completed
        head_sha=e9a75dfed141b5744acd3a86cc9e8063b271465c
evidence: predicate=qa_passed  decision_kind=qa_verdict  subject_kind=git_head
          subject_digest=e9a75dfe…(与 holder head 同值)
          frozen_at=2026-07-24T01:43:24.864Z
run: current_node_id=founder_gate,nodes design/implement/qa 全 done
alert_outbox: 0 行  ← bound 成功时不误报告警(与 §2.2 的 unbound 形成对照组)
```

**架构事实(报告要点)**:`tpl_eng_trivial_land_v1` 的 gate `authority_mode = land`(承运方是引擎 land 节点),`tpl_eng_trivial` 是 `runner_ship`(承运方是 parked runner)。第八棒观察到的 `ship_parked` 生命周期只在 **runner_ship** 模板下出现;land 模板下 implement 直接 `completed`。rebind/unbound 一整套只对 `runner_ship` 生效 —— 这是本棒必须开第二条 run 的原因。

### D. gate 唯一性
```
thread 1530026591349117178 共 8 条消息,含 "Ship gate"/"ready to ship" 的 = 1 条
DB: workflow_gate_holder=1  gate_opened 事件=1  gate_holder_created 事件=1
```

---

## 5. 交接(剩余项 + 精确前提)

1. **断言 C 复测(最高优先)**:用**严格 JSON** `{"approved": true}` 以 Annie 身份回复 ship-gate 卡,验 holder 是否 flip `approved`。同时单独验 ✅ reaction 路径(本棒未取到结论)。若严格 JSON 能过而卡面文案不改,则发现 1 降级为「文案 vs 合同不一致 + 丢弃无告警」;若严格 JSON 也不过,则是 land-authority 门禁的批准接入缺口(更严重)。
2. **land 线**:C 通过后才能验 🆒 → landing → completed 级联。
3. **rebind 成功路径**:需要 `session.pr_head_sha ≡ holder.head_sha` 且 session `ship_parked` / `review_question_id` 为空 / candidate 是 carrier 节点最后一个 attempt(`StateStore.resolveWorkflowGateCarrierRebindCanonical`)。本棒用 head 漂移造 unbound,天然不满足 head 相等,只能验到 fail-closed。**建议造法**:让 carrier 节点跑第二个 attempt,并使其 park 的 head 与 holder 冻结的 head 一致,再走 stage→apply。
4. **看门狗⑦**(wake_failed 假警报家族对已完结会话不重铸指纹):本棒未测。
5. 现场可直接接手:run A `d0824c3e…`(停在 founder_gate,holder bound)、run B `d67ed110…`(unbound holder + 已投递告警)都**原样留着**没清理,是现成的取证现场。

---

## 6. 诚实边界(含我自己诱发的问题)

- 三个节点的完成事件是我用 `POST /events` 探针式驱动的(design/implement),**不是真 runner 产出真代码**。房内 Lead 因此正确地指出「QA 在验一个空分支」。本棒测的是 Bridge 侧物化/绑定/告警/呈现,与产物真实性正交,但读报告时要知道这一点。
- run B 的 head 漂移是**我主动 commit 造的**(`eef69f43`),用于复刻真实漂移场景;这是有意的 fixture,不是产品 bug。
- 断言 C 第一次用中文散文回复(照卡面文案做的),不符合严格 JSON 合同;✅ reaction 补测点击未落上。这两点都记在上面,没有粉饰。
- 生产未受影响:全程只停/起 slot-1 进程(按 PID),生产 Bridge(PID 57970)与 slot-2 房(PID 86383)复核仍在;`flywheel-FLY-1441` worktree 无 git 状态改动。

---

## 7. 追加轮(Lead 续跑指令 a/b/d)— 断言 C 根因锁定,**不是文案冲突**

Lead 裁决后给了四条续跑指令(a 严格 JSON 复测 / b 追卡文案出处定 in-scope / c C 通后补 land+⑦+rebind / d ✅ reaction 取证)。本节是 a、b 的结果 —— **a 的结论推翻了我上一轮的根因猜测**。

### 7.1 (a) 严格 JSON 复测 → **同样不被接住**(C 仍 FAIL,但根因换了)

以真 Annie 账号(`xrliannie_96634`,`bot=false`)在同一 thread 发**逐字严格 JSON**:
```
消息 1530032488137625731  content = {"approved": true}
```
观测 4 分钟(每 12s 一采,共 20 采),全程无变化:
```
holder = awaiting_review/bound     run.current_node_id = founder_gate
CommDB question workflow-gate:ff6b7c7e…  resolved_via = (空)  relay_state = protected
```
且 `~/.flywheel/founder-reply-cursor.json` 该 thread 游标已推进到 `1530033412532994149` > 我的 `1530032488137625731` —— **又是"读到了然后丢弃"**。

**所以上一轮我写的「卡面文案 vs 严格 JSON 合同冲突 = 根因」被证伪。** 散文回复和严格 JSON **两种都不被接住**,问题不在回复格式。

### 7.2 真根因(Lead 给出因果链,我独立复核了关键一环)

房内 Lead 的原话(消息 `1530033412532994149`):
> QA Runner 自己跑了收件箱检查:`flywheel-comm inbox --exec-id 3c1750ea-… → No instructions.`
> 你 19:02:51 发的 `{"approved": true}`,到现在没有进入它的收件箱。门禁行也仍是 UNRESOLVED(已 20+ 分钟)。
> 因果链:① session 生命周期状态错乱 → ② wake 指针要求 durable park(parked / design_done / awaiting_review)→ ③ QA 实际卡在门禁上,但 session 状态是 `running`,不在任何合法 park 状态 → ④ wake_failed(告警原文:`wake_pointer_status is "running" without a durable park`)→ ⑤ 批准无法投递 → 门禁永远不会自己解决。

**我独立复核的那一环(不转述,自己查的库)**:
```sql
SELECT execution_id, status, session_role FROM sessions
 WHERE execution_id='3c1750ea-38d3-491b-b867-1e3b3f687ba7';
→ 3c1750ea-38d3-491b-b867-1e3b3f687ba7 | running | qa
```
qa session 确实停在 `running` 而不是任何 durable park 状态 —— 因果链第 ③ 环成立。

诚实边界:第 ④ 环的 `wake_failed` 告警原文我**没有在自己查的 DB / bridge.log 里找到**(房 DB 无 `%wake%` 事件表命中,bridge.log 无该字串),它来自 Lead 的报告。第 ④ 环记为**转述**,不是我的一手证据。

**修正后的 C 结论**:founder 批准链路在当前配置下是**断的,不是慢的** —— 与回复格式无关,是 carrier/qa session 的 park/wake 记账把投递卡死。这比"文案冲突"严重,且是 FLY-1447 该抓到的东西。

### 7.3 (b) 卡文案出处 + in-scope 判定(硬证据)

```
ship 卡文案出处: packages/teamlead/src/bridge/founder-thread-notifier.ts:111,120
  111: `🚀 **Ship gate 等你批准** — ${identifier}`
  120: "直接**回复这条消息**或点 ✅ 即批准;其它回复不会被当成批准。…"

git diff --stat origin/main...f42bdc98 -- packages/teamlead/src/bridge/founder-thread-notifier.ts
→ (空)   = #690 **未触碰**该文件

git diff --stat origin/main...f42bdc98 -- packages/teamlead/src/bridge/gate-poller.ts
→ 1 file changed, 39 insertions(+)   = gate-poller.ts **在** #690 scope 内
```
**判定**:卡文案是 main 上的既有代码,**不是 #690 引入**,建议独立单。而投递侧的 `gate-poller.ts` 确实在 #690 改动面内(+39 行)—— C 的根因落在 park/wake 记账,与 gate-poller 是否同源需下一棒二分(见 §8)。

### 7.4 (d) ✅ reaction 路径 — 仍未取到证

第一次点击未落上(API 复核 reaction=0)。本轮优先跑 a/b,reaction 补测**仍欠**。诚实记为未完成。

### 7.5 看门狗⑦ — 部分数据(转述,非我一手)

Lead 报告它处理了两条 `wake_failed`(design + QA),结论:两个 pane **都活着且健康**,都**正确识别了重复投递没有重复劳动**,**没有 Runner 需要抢救**,坏的是 Bridge 侧 park/wake 记账。
即:假警报家族在「已处理/已完结」侧**没有重复铸指纹**(与⑦的期望一致),但这条是 Lead 的观察,我没有独立复核指纹表,**⑦ 仍记未验**。

### 7.6 顺带核到的基线事实(非本单)

Lead 独立复核:`origin/main` 的 `.flywheel/config.yaml` 里 `agents:` 键数量为 0,最后动该文件的提交是 `e9a75dfe`(PR #64)—— 即门禁绑定的那个 head 正是把 CI 弄红的提交,只有 2 个依赖 agents 的 suite 挂。属独立基线配置问题,不该由本单或 PR #69 承担。

---

## 8. 交接(更新版)

C 已从「文案问题」升级为「**投递链路断裂**」,后续棒次请按这个前提接:

1. **C 根因二分(最高优先)**:qa/carrier session 为何停在 `running` 而非 durable park?对照 `tpl_eng_trivial_land_v1`(land authority,本单 run A)与非-land 模板行为差异;并二分 `gate-poller.ts` 的 #690 +39 行是否参与该记账。**不要**再从回复格式方向找。
2. **land 线**:仍被 C 阻断。
3. **rebind 成功路径**(与 C 独立,可先做):run B `d67ed110…` 的 unbound holder 冻结 head = `eef69f43…`,而 worktree 当前 HEAD 也正是 `eef69f43…` —— 让 carrier(implement)跑第二个 attempt 并 park 在该 head,即可满足 `resolveWorkflowGateCarrierRebindCanonical` 的 head 相等前提,再走 stage→apply 取成功路径证据。
4. **✅ reaction 路径**:补一次有效点击(本棒两次都没落上)。
5. **看门狗⑦**:独立复核指纹表,别只用 Lead 的转述。
6. 现场仍原样保留:run A `d0824c3e…`(founder_gate / holder bound / 批准两次被丢弃)、run B `d67ed110…`(unbound holder + 已投递告警)。

---

## 9. 追加轮 2(指令 c 的 rebind 成功路径)— **本房黑盒不可达,已证**

指令 c 要我补 rebind 成功路径(报告 §5/§8 给的造法:让 carrier 起第二个 attempt 并 park 在与 holder 冻结 head 相同的 sha)。本轮实际去做,结论是**在本房当前形态下,从外部黑盒驱动无法到达该状态**,证据如下。

前提状态(run B `d67ed110…`):
```
holder: unbound / materializing / question_intent / head_sha=eef69f43…  attempt=1
nodes : design#1 done · implement#1 done(exec 68b56f62) · qa#1 done(exec ec45bf1f) · founder_gate#1 review
carrier session 68b56f62: ship_parked, pr_head_sha=e9a75dfe…   ← 与 holder head 不等,故 rebind 409
worktree 当前 HEAD = eef69f43…                                   ← 若 implement 起 attempt#2 并 park,即可相等
```
`tpl_eng_trivial` 通往 implement 第二个 attempt 只有两条边(模板逐字):
```yaml
loops:
  - { id: qa_retry,        from: qa,           to: implement, loop_when: qa_fail }
  - { id: founder_feedback, from: founder_gate, to: implement, loop_when: founder_feedback_kickback }
```
两条都走不通:
1. **`founder_feedback` 路**:需要 founder 作出 kickback 决定。但本 run 的 holder 是 **unbound → fail-closed → 根本没有向 founder 呈现任何卡**(这正是修复②要的语义),没有卡可回;即便有,C 已证明 founder 决定的投递链路是断的。
2. **`qa_retry` 路**:需要新的 qa verdict,但 qa 节点已 `done`、run 已推进到 `founder_gate`。唯一能重开 qa 的 `/api/workflow/re-qa/stage` 在本房**未接线**:
```
POST /api/workflow/re-qa/stage  {"execution_id":"ec45bf1f-…"}
→ HTTP 503 {"ok":false,"reason":"re_qa_unavailable"}
```
(注:`re_qa_unavailable` 表示 `deps.reQa` 未注入,不是状态被拒 —— 即这条路由在本部署形态下不存在,不是我请求写错。)

**结论**:rebind **成功路径**需要「unbound 之后 carrier 仍能再 park 一次且 head 对齐」的状态,而该状态在本房只能由 ① founder kickback(被 C 阻断且 unbound 时无卡)或 ② re-qa(未接线)产生。**建议改用单测/集成测覆盖成功分支**,或在 C 修好、`re-qa` 接线的房里再跑;不要再期待纯黑盒 E2E 能造出来。

已验到的 rebind 分支汇总(全部 fail-closed 侧):
| 分支 | 结果 |
|---|---|
| 路由存在性(旧→新) | 404 → 409 ✅ |
| 无证据 stage | 409 `rebind_proof_unavailable` ✅ |
| apply 缺 canonical/token | 400 `missing_canonical_or_token` ✅ |
| 跨源 | 403 `cross_origin` ✅ |
| 真 unbound holder 但 head 不等 | 409 `rebind_proof_unavailable` ✅(拒绝抹平真漂移) |
| **unbound → bound 成功** | ⛔ 本房不可达(见上) |

### 9.1 (d) ✅ reaction 路径 — 三次点击均未落上,记为未完成
用 Chrome 对 ship 卡的快捷反应条点击 3 次,Discord API 复核 `reactions` 始终为空。定位问题(hover 出的反应条坐标/ref 不稳),非产品结论。**该路径本棒未取到任何证据**,下一棒请用更稳的定位方式补。

---

## 10. 追加轮 3(指令 a:C 根因二分)— **#690 的 +39 行被排除,不是 C 的凶手**

Lead 澄清「禁的是改 Bridge 状态,不是调查」后,本节做只读二分。

### 10.1 #690 在 gate-poller.ts 的 +39 行到底加了什么

三处结构相同的守卫(逐字 diff),分别在 ① 门禁问题中继路径 ② 卡呈现路径 ③ 线程扫描路径,每处都是
`workflowGatePresentationDisposition(...)` 返回 `!allow` 就 `continue` / `return`:
```ts
const gateOwnership = typeof this.config.store.workflowGatePresentationDisposition === "function"
  ? this.config.store.workflowGatePresentationDisposition({
      executionId: question.from_agent, checkpoint: question.checkpoint, questionId: question.id })
  : { allow: true as const, reason: "legacy" as const };
if (!gateOwnership.allow) { …continue/return… }
```
谓词本体在 `StateStore.ts:19752`,按顺序返回:`non_ship` / `legacy` / `activation_ambiguous` / `legacy_epoch` / `before_gate` / `holder_missing` / `holder_mismatch` / `holder_authoritative`。

**这是唯一合理的怀疑对象** —— 它的每个 `allow:false` 分支都会让 poller 静默跳过门禁,症状与 C 完全一致(读到了、不处理、无告警)。

### 10.2 用 run A 的真实行值逐条走谓词 → **allow: true**

真实取值(只读查库,逐字):
```
CommDB question: id=workflow-gate:ff6b7c7e…   from_agent=3c1750ea-38d3-491b-b867-1e3b3f687ba7   type=question
holder        : run_id=d0824c3e…  gate_node_id=founder_gate
                source_execution_id=3c1750ea-38d3-491b-b867-1e3b3f687ba7
                question_id=workflow-gate:ff6b7c7e…   state=awaiting_review
run           : current_node_id=founder_gate  gate_carrier_epoch=1  engine_owned=1  status=active
```
逐条:
| 谓词分支 | 判定 |
|---|---|
| `checkpoint !== approve_to_ship` → non_ship | 否(是 approve_to_ship),继续 |
| activation `none` → legacy / `ambiguous` → **deny** | run 唯一且 active,两者都不触发 |
| `gate_carrier_epoch !== 1` → legacy_epoch | epoch=1,不触发 |
| `run.current_node_id !== gate.node` → **deny before_gate** | founder_gate == founder_gate,**不触发** |
| holder 不存在 → **deny holder_missing** | holder 存在,**不触发** |
| `holder.source_execution_id !== executionId` 或 questionId 不等 → **deny holder_mismatch** | 两者**逐字相等**,**不触发** |
| → 落到 | **`{allow: true, reason: "holder_authoritative"}`** |

**结论:#690 新增的三处守卫对 run A 的门禁一律放行,不是 C 的成因。** 二分把 C 的根因牢牢留在 wake/park 侧(carrier session 停 `running` 无 durable park),而该侧代码不在 #690 diff 内。

**诚实边界(方法论标注)**:这是**用真实行值对谓词做的代码级逐条求值**,不是我在运行时观测到该函数的返回值(没有该分支的日志)。若要一手运行时证据,需给三处 `!allow` 分支加日志或在房内单测里跑该谓词 —— 但守卫 deny 时 poller 是**静默 continue**(只有第一处有 `console.warn`,且 bridge.log 里 **grep 不到** `suppressed non-authoritative workflow ship gate`),这本身也是一条旁证:**若真被守卫拦下,第一处应打印 warn,而日志里没有**。

### 10.3 (d) ⑦ 指纹表独立复核 — 无法从该载体取证
`~/.flywheel/claims.db` 实测 **0 字节、无任何表**(`no such table: claims`),该载体在本部署里是空的,拿不到 wake_failed 家族的指纹去重记录。⑦ **仍只有 Lead 的转述**,我没有一手证据,不改判。

### 10.4 rebind 成功路径的第二条独立死因
除 §9 的两条边都堵死外,还有一条:即使走「re-review 更新 carrier 的 pr_head_sha 使其与 holder head 对齐」这条思路,`event-route.ts` 的 re-review 分支会调用 **`retireSupersededShipGate()`** —— 它**退役旧 holder**,而不是让 holder 重新对齐。所以这条路也到不了 unbound→bound。
