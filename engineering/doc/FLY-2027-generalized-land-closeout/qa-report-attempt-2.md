# FLY-2027 generic 收尾对等 — 独立 QA 报告(attempt 2)

Issue: FLY-2027 (https://linear.app/geoforge3d/issue/GEO/issue/FLY-2027)
日期: 2026-08-24
基于: plan.md、qa-report.md(attempt 1)

> ⚠️ 本文件是 **attempt 2** 的独立报告。attempt 1 的 `qa-report.md` **原样保留、未被修改**。
> 两份报告结论一致,但证据是各自独立采的;冲突之处以本文件为准并显式标注。

---

## 0. 结论

**PASS。**

- 验证的 PR head:`81b9e4507030b4c847a25f0130690e00bc0ff1f3`(PR #941,OPEN、非 draft、`MERGEABLE`)。
  开跑前 `git fetch` 一次、发 verdict 前再核一次。
- **PR CI 在这个 exact head 上 11/11 全绿**(run `32815110741`,含 Quick Gate、Unit light/heavy、
  Unit teamlead 1–3/3、Script Tests 1–2/2、Classify CI scope、NPM payload、CI OK)。
  这条直接注销了 attempt 1 的 F7(当时该分支从未跑过 CI)。
- 本机 worktree HEAD 因 QA 自己的 progress ledger commit 比 PR head 多几个 **docs-only** commit;
  `packages/teamlead` 产品代码逐 patch 相同(见 §1)。

---

## 1. 为什么会有 attempt 2 —— 账本取证

`workflow_run ac7f43ce` 的节点账:

| 节点 | attempt | 状态 | 时间(UTC) |
|---|---|---|---|
| design | 1 | done | 17:38 → 18:31 |
| implement | 1 | done | 18:31 → 22:34 |
| qa | 1 | done | 22:34 → 08-25 00:04(attempt 1 报 PASS) |
| founder_gate | 1 | done | 00:04 → 04:25 |
| land | 1 | **pending** | 04:25 → |
| implement | 2 | done | 04:25 → 06:23 |
| qa | 2 | running | 06:23 →(本次) |

关键事件 seq 45:`engine_land_rework_requested`,告警 uid = `land-transition:**conflict_rework_started**`。
即:founder 批准后 engine land 发现 PR 是 **CONFLICTING**(正是 attempt 1 记的 F6:`CLAUDE.md` 里程碑表冲突),
按 FLY-1833 开了「合库冲突返工」,`verificationPolicy = [code_review, qa_retest, founder_gate]` → 所以要重跑 QA。

返工投递本身卡住了(seq 50 `resume_target_unrecoverable / attachment_missing`,
implement 的 exec `21d81d2d` 当时已终态;随后 30 分钟 `rework_activation_stalled_alerted`、
60 分钟 `rework_activation_stalled_held`),但**分支确实被 rebase 了**:
所有 commit 的 committer date 都是 `2026-08-24 22:59:29 -0700`(= 08-25 05:59 UTC),落在 implement attempt 2 的窗口内。

**返工的实际内容 = 只做了一次 rebase 解冲突,产品代码零改动。** 我用两种方式各自证明:

1. **patch 级等价**:
   `git diff $(merge-base 4029489cd main)..4029489cd -- packages/teamlead/src` 与
   `git diff $(merge-base HEAD main)..HEAD -- packages/teamlead/src` 各 1995 行,
   `diff` 后的 **80 行差异全部是 `@@` hunk 行号偏移**,非 hunk 行差异 **0 行**。
2. **冲突文件本体**:`CLAUDE.md` 相对新 base 是 `+1/-0`(纯新增一行里程碑),`doc/VERSION` 是 `v1.55.0 → v1.56.0`。
   PR 的完整改动面 30 个文件,全部落在 `CLAUDE.md` / `doc/VERSION` / `engineering/doc/FLY-2027-*` / `packages/teamlead/src`。

所以 attempt 2 的真实新风险不是「新代码」,而是 **「同一份改动换了一个 main base」**(`399edd8e8` → `5a8fe51bf`,
rebase 带进 360 个文件的 main 变更)。我的验证重点放在这里。

### 1.1 rebase 是否漏接了 main 新增的调用点

| 检查 | 结果 |
|---|---|
| `settleReworkParksForRunTx`(旧名)在 HEAD 的残留 | **0 处** |
| 旧 base / 新 base 里旧名出现次数 | 各 10(1 定义 + 9 调用),HEAD 新名同为 10 → 无遗漏 |
| `isWorkflowPhaseSession` 非测试消费者 | 只剩 `runner-shutdown-evidence.ts` 自身(定义 + 被新谓词复用)|
| `getPhaseSessionsForIssue` 残留消费者 | 4 处,逐一核过(见下)|

`getPhaseSessionsForIssue` 剩下的 4 个消费者:
- `HeartbeatService.ts:1777` / `post-ship-finalization.ts:508` —— **本 PR 有意保留**,都是「legacy phase 集 ∪ 新的 workflow-managed 集」的并集写法。
- `StateStore.ts:7597` —— 定义本身。
- `plugin.ts:9422` `getActorSessionsForIssue` → `turn-belt-reconcile.ts` —— **旧 base 与新 base 都有,不是 rebase 新增**;
  且 turn-belt 的候选还要再按 `TURN_RECOVERY_PRIORITY`(design/implement/qa)过滤,generic `main` 本来就不会被选中。
  属于本单 scope 之外的既有边界,不是回归(记为 I1)。

---

## 2. 硬门(全部在 exact head 上跑)

| 门 | 结果 |
|---|---|
| `pnpm -r build`(22 workspace) | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0,2598 files,**0 error / 8 条既有 warning** |
| 变更影响面 10 个测试文件 | ✅ **333/333**(并发首轮有 1 个 `FLY-1863` fake-timer 用例撞固定 5s 预算,单文件隔离 **47/47** 绿)|
| `packages/teamlead` 全包(本机沙箱) | 726 files / **9546 pass / 8 fail / 4 skip**(见 §5 归因)|
| **PR CI @ `81b9e4507`** | ✅ **11/11 全绿** |

---

## 3. 独立突变检验 —— 14 个有效突变(我自己选的点,不是复跑作者的测试)

harness:`qa-evidence-2/mutation-harness.sh.txt`(改一处 → 跑测 → 无条件还原;
`occurrences != 1` 直接 `APPLY_FAILED`,防止「没改成却报绿」)。每轮结束都核 `git status` 为空。

| # | 突变 | 结果 |
|---|---|---|
| M1 | park 判据 `keepalive_park === true` → `=== false` | ✅ KILLED |
| M2b | park 判据去掉 `creates_pr === true` 那一支 | ❌ **SURVIVED** → 见 §4.1(等价突变)|
| M3b | 结算回执 `clear.generation !== open.generation + 1` 放回 `<=` | ❌ **SURVIVED** → §4.2 |
| M4b | 结算回执 `clear.reason !== open.reason` 放回硬编码 `"rework_reachable_wait"` | ❌ **SURVIVED** → §4.2 |
| M5 | active rework replacement 也允许清 ship-gate park | ✅ KILLED |
| M6 | `getWorkflowManagedSessionsForIssue` 去掉 `workflow_node_id` 绑定 | ✅ KILLED |
| M7 | `getWorkflowManagedParkedCandidates` 候选集清空 | ✅ KILLED |
| M8 | post-ship 收体去掉 exact-run 围栏(`activation.run_id === runId`)| ✅ KILLED |
| M9 | `plugin.ts:5581` typed cause 接线退回 `{ outcome }` | ❌ **SURVIVED** → §4.3(= attempt 1 的 F2)|
| M10 | husk 强收候选集退回 `getPhaseSessionsForIssue` | ❌ **SURVIVED** → §4.4(= attempt 1 的 F1)|
| M11 | `founder_reopened` 归档豁免文案退回旧误导句 | ✅ KILLED |
| M12b | `isWorkflowManagedSession` 退回 phase-only(codex 收尾面)| ✅ KILLED |
| M13 | Heartbeat 巡检去掉 workflow 候选 | ✅ KILLED |
| M14b | `isWorkflowManagedSession` 退回 phase-only(husk 面)| ✅ KILLED |

> **harness 自查(阳性对照也要有对照)**:第一版的 M12 / M14 我直接在消费者里把
> `isWorkflowManagedSession` 换成 `isWorkflowPhaseSession`,结果 19/26 个用例齐红 —— 那是
> **符号未导入的 ReferenceError**,不是覆盖证据。改成在 `runner-shutdown-evidence.ts` 里
> 语义退化定义本身(M12b / M14b)后,才分别精确红 1 个 / 2 个。原始 M12 / M14 已作废,不计入。

---

## 4. 5 个存活突变逐个查清:是「覆盖缺口」还是「真缺陷」

### 4.1 M2b —— **等价突变**,不是缺口

park 投影整段被 `input.route === "needs_review"` 罩住;而
`commitEnrolledCompletion` 在 `StateStore.ts:36235` 有 `route !== node.capabilities.completion_route → route_mismatch` 的 fail-close。
查 `packages/config/src/node-type-registry.ts` 的能力矩阵:

| type | keepalive_park | creates_pr | completion_route |
|---|---|---|---|
| design | true | **false** | `phase_design_complete` |
| implement | true | true | `needs_review` |
| **generic** | true | true | `needs_review` |
| qa / gate / land / review | false | false | — |

→ 当前 registry 里 **不存在** `keepalive_park && !creates_pr && route=needs_review` 的节点,
所以 `creates_pr` 那一支在现网是**纵深防御**(挡未来自定义 capability),对当前行为无可观测差异。
**529 真机另有活证据**:`step 2: design completed without ship parking`(§6)。

### 4.2 M3b / M4b —— **真覆盖缺口**,代码正确(我自己写探针证的)

两处只影响 `appendWorkflowEngineParkSettlementClearTx` 的 **replay 冲突守卫**(`prior` 分支),
所以只有「同一次终态结算被重放」时才会分叉。存活 = 仓库里没有任何用例重放过
`runner_ship_gate_wait` 这一类 park 的结算 —— 而这正是本 PR 新开的能力。
**风险是实的**:旧代码写死 `clear.reason === "rework_reachable_wait"`,一旦清的是 ship-gate park,
重放会抛 `workflow_engine_park_settlement_conflict` → 事务回滚 → land 收尾失败。

我写了探针 P2(`qa-evidence-2/probe.test.ts.txt`):真编译 generic menu 模板 → 真
`materializeWorkflowRun` / `admitGeneralizedWorkflowExecution` / `commitEnrolledCompletion`
→ 真 `ship_parked` + 真 park_opened 行 → 只用 SQL 把 `reason` 改成待测的那一种 → 真
`completeWorkflowLandNode` 连调两次。两种 reason 各一例,断言:

- 首次结算后 `getCurrentWorkflowEngineParkEvidence` 变 undefined;
- `engine-park-settle:<exec>:<gen>` 这条 clear 行的 `reason` **继承 open.reason**、`generation === open.generation + 1`;
- 第二次调用 `{ ok: true, idempotentReplay: true }` **不抛**,且 `engine-park-settle:` 前缀的行仍只有 1 条。

结果 **2/2 PASS**(含 `runner_ship_gate_wait`)。**探针敏感性对照**:
`S2`(把 reason 改回硬编码)与 `S3`(终态允许集去掉 ship-gate)各把探针**精确打红 1 个用例**,证明它不是空过绿。

> 一处自我更正:我第一版探针断言「park_cleared 行总数 == 1」,实测得 2 → 一度像是重复结算。
> dump 出来看是 admission 阶段就存在的 `engine-park-clear:… reason=activation_spawn_admitted` 那条无关行,
> **我的断言写错了**,不是代码问题;改成只数 `engine-park-settle:` 前缀后 5/5 绿。

`generation` 收紧(`<=` → `=== +1`)方向是更严:`appendWorkflowEngineParkEventTx` 的
`generation = MAX(generation for execution_id) + 1`,且结算 SELECT 只取该 execution 的 MAX 代 open 行,
同事务内不可能插队,所以恒等成立。

### 4.3 M9 —— **真覆盖缺口**,类型上安全(= attempt 1 的 F2,在 rebase 后的 head 上仍然成立)

`plugin.ts:5581` 那一行 `landIssueCloseoutResultFromClosureReport(report)` 零测试覆盖。
我独立核了类型边界:`lifecycle-closeout.ts:125` 的
`ClosureReport.outcome = "complete" | "partial" | "needs_operator" | "conflict" | "blocked"` ——
**没有 `"completed"`**,所以 `landIssueCloseoutResultFromClosureReport` 里
`report.outcome === "complete"` 的早返分支对成功路径是完全覆盖的,不会给成功的收尾算出 cause。
plan §2 刀 4 原本要求「经 plugin wiring 一路断言到 typed cause」,实际只测了纯函数 —— 属**计划偏离**,不是缺陷。

### 4.4 M10 —— **真覆盖缺口**,代码正确(= attempt 1 的 F1,仍然成立)

`shipped-husk-escalation.test.ts` 里那个「discovers and force-reaps a workflow-bound generic main husk」
是**空过绿测**(`upsertSession` 的 `ON CONFLICT DO UPDATE` 不含 `chat_thread_role`,第二次 upsert 换不掉角色 —— 见记忆
`reference_upsert_session_conflict_drops_role`),用旧查询也能命中。

我写了探针 P4(真 `StateStore` + 真 `forceShippedHusks`,只在 Discord/tmux/CommDB 打 seam),三组:

| 主体 | 期望 | 实测 |
|---|---|---|
| `implement-1`(legacy phase)—— **健康对照** | 被强收 | ✅ `cleared=["implement-1"]` |
| `generic-1`(`chat_thread_role='main'` + `workflow_node_id='execute'`)| 被强收 | ✅ `cleared=["generic-1"]` |
| `ordinary-main`(普通 main,无 node 绑定)—— **阴性对照** | 不动 | ✅ `cleared=[]`,`cleanupTarget` 零调用 |

**探针敏感性对照**:`S1`(把候选集退回 `getPhaseSessionsForIssue`)精确打红 1 个用例(正是 generic 那条)。

---

## 5. 本机全包 8 个失败的归因

CI 在同一个 exact head 上是全绿的(§2),所以下面只解释**本机沙箱**为什么红:

| 文件 | 数 | 隔离复跑 | 归因 |
|---|---|---|---|
| `fly247-bash-suites`(flywheel-fleet ×4)| 4 | 仍红 | launchctl harness,CLAUDE.md 已把它登记为宿主既有项(FLY-1628)|
| `fly1674-opus46-real-tmux` | 1 | 仍红 —— `ENOENT … /private/tmp/f1674-*/tmux/tmux-501` | 真 tmux socket 宿主条件 |
| `workflow-docs-git.integration` | 1 | 仍红 —— `Test timed out in 5000ms` | 真 git 操作撞文件内固定 5s 预算 |
| `terminal-thread-archive` | 1 | **✅ 绿** | 并发负载抖动 |
| `founder-consent/wiring-postwrite` | 1 | **✅ 绿** | 并发负载抖动 |

三个仍红的文件都不 import 本 PR 改动的任何文件,失败签名是 ENOENT / timeout 而不是断言。
**诚实边界**:我同样没有在本沙箱跑 `origin/main` 的同环境 before 基线;这里不靠 before/after 对照,
靠的是「同 head 的 CI 全绿 + import 图 + 失败签名」三条。

---

## 6. 529 QA 房真机(exact head,隔离槽,生产零污染)

`scripts/test-deploy.sh 2 --generalized --stub-runner --expect-head <HEAD>` →
slot Bridge `/health` 的 `buildSha = artifactBuildSha = 708dc2dadcb90b109017468354f56f59e44f9055`
= 我本机 worktree head(产品代码与 PR head 逐 patch 相同,§1)。

`node scripts/qa-529-generalized-e2e.mjs 2 --issue FLY-2027` —— **steps 1–7 全过**:

```
step 1: generalized run authority is durable
step 2: design completed without ship parking          ← 刀 2 capability 判据的活证据
step 3: implement node dispatched with PR capability
step 4: implement is alive in rework-reachable ship_parked   ← park 语义活证据
step 5: question gate delivery works while parked implement owns no gate
step 6: QA FAIL reached wake_delivered without held/needs_lead
step 7: current implement execution completed attempt 2 and advanced head
step 8: A3 diagnosis (workflow_node_pr_binding_missing) → exit 20
```

`exit 20` 是这个 harness **自己 usage 里写明的已知出口**
(“Exit 20: steps 1-7 completed; step 8 emitted the known F2 PR-authority diagnosis”),
是 stub-runner 拿不到真 PR binding 的既有限制,**不是本 diff 的失败**。
(对照:attempt 1 只跑到 step 4 就被房内 tmux 路由分裂挡住;本次房是健康的。)

**生产零污染取证**:开房前后生产 Bridge `/health` 连续 `ok=true`、`buildSha` 不变(`399edd8e8`)、
`sessions_count=12`、`uptime` 单调增长(4431s → 4996s,**没有重启**)。
`scripts/test-teardown.sh 2` exit 0;`/tmp/flywheel-test-slot-*` 归零;
teardown 漏在宿主 default server 上的空 `runner-test-slot-2`(裸 zsh,pane %2488)由我手动 kill,残留 = 0。

---

## 7. 真 Discord E2E —— 改动的 founder 可见面(Discord-capable 判定:**是**)

本 diff 改了 founder 在 issue thread 里能读到的 `land_archive_waiver` 文案,并动了 thread 归档链路
→ 按 QA 合同必须跑真 Discord。

**module-driven**:真编译产物 `packages/teamlead/dist/bridge/post-ship-finalization.js` 的
**真 `runResumablePostShipFinalization`** + 真 `StateStore` + 真 test bot token(`TEST_BOT_TOKEN_2`)+
529 QA 房真频道 `#product-lead-test`(`1493080993173737583`)里真建 thread、真 POST、真 GET 回读。
Discord 侧**零 mock**(`fetchImpl: globalThis.fetch`)。
隔离:`HOME` / `FLYWHEEL_STATE_DIR` 指向临时目录 + 用不存在的 project 名 `qa2027b-isolated`,
避免碰到生产 `~/.flywheel/comm/flywheel/comm.db`;跑完核过真实 `~/.flywheel/comm/` 下无 `qa2027*` 目录。

**10/10 PASS**。Discord 实际渲染出来的两条(逐字回读):

```
🤖[自动] ℹ️ 本 thread 未自动归档:founder 已重新打开；系统会保持 thread 开放且不会自动重试归档，请 Lead 确认后手动归档。
🤖[自动] ℹ️ 本 thread 未自动归档:仍有活跃使用者；原因解除后会由清理流程重试。
```

- A 组(`founder_reopened`,**验收 ②**):post-ship 返回 `complete: true / outcome: completed`,
  thread **没有被归档**、保持开放;文案明说「不会自动重试归档」「请 Lead 确认后手动归档」;
  旧的误导句「原因解除后会由清理流程重试」**已消失**;全角标点无 mojibake、无截断。
- B 组(`in_active_use`,**阴性对照**):文案**未变**,仍承诺重试 —— 因为它确实会重试,这句仍是真话;
  且不含 founder 措辞。
- 证据 thread(跑完已 archive + lock):
  - A https://discord.com/channels/1485787271192907816/1541699593014743090
  - B https://discord.com/channels/1485787271192907816/1541699601164410950

---

## 8. 三条验收逐条对账

| 验收 | 证据 | 结论 |
|---|---|---|
| ① 经 founder_gate + engine land 合入后,无人工介入,停驻体全收、thread 自动归档 | 作者的 `workflow-engine-dispatcher.test.ts` 真编译 generic 模板集成(parked generic producer → `completed` + park 精确清账,我用 M5/M6/M7/M8 四个突变确认它不是空过绿)+ 我的 P2/P4 探针 + 529 steps 1–7 | ✅(尾段边界见 §9.1)|
| ② founder 在 thread 里发过话(reopened)时不强收 | §7 真 Discord A 组:thread 保持开放 + 诚实文案;M11 突变可打红 | ✅ |
| ③ 老 🆒 / legacy phase / 普通 main 路径不回归 | P4 阴性对照(普通 main `cleared=[]`)+ 作者用例 `ordinary-main` 保持 `ship_parked` + `getWorkflowManagedSessionsForIssue` 的 SQL 显式排除无 node 绑定的 main + **CI 全包全绿** | ✅ |

---

## 9. 发现

| # | 级别 | 内容 |
|---|---|---|
| F1 | MEDIUM | `shipped-husk-escalation.test.ts` 的 workflow-bound generic husk 用例是**空过绿测**(M10 存活)。**代码本身正确**(§4.4 探针 + S1 敏感性对照)。建议把 P4 探针收编进该文件。与 attempt 1 的 F1 同一条,rebase 后仍成立。|
| F2 | MEDIUM | plan §2 刀 4 要求「经 plugin wiring 断言 typed cause」,实际只测纯函数,`plugin.ts:5581` 零覆盖(M9 存活)。类型上安全(§4.3)。**计划偏离**。与 attempt 1 的 F2 同一条。|
| F3 | MEDIUM | **本次新增**:`runner_ship_gate_wait` park 结算的 **replay 路径零覆盖**(M3b / M4b 双双存活)。这是本 PR 新开的能力,而旧守卫在这条路径上会抛 `workflow_engine_park_settlement_conflict`。代码正确(§4.2 探针 2/2 + S2/S3 敏感性对照),但仓库里没有任何用例守着它 —— 以后有人把 `clear.reason` 改回硬编码,CI 不会红。建议把 P2 探针收编。|
| F4 | LOW | `inferLandCloseoutCause` 的 `phase_shutdown_unacked` 只匹配 4 个 token 前缀;仓库里真实存在的 `phase_shutdown_db_error` / `_lookup_error` / `_liveness_error` / `_liveness_indeterminate` / `_request_mismatch` / `_post_ack_lookup_error` 仍落 `unknown`。(= attempt 1 F3)|
| F5 | LOW | 刀 3 向前生效、不回填:生产 `workflow_engine_park_outbox` 里 42 条 `runner_ship_gate_wait` 的 `park_opened` 挂在已终态 run 上,部署后仍是 open。plan 没承诺回填,但「park 账已清」的口径要知道。(= attempt 1 F4,本次未重新只读复核该计数,沿用 attempt 1 的取证)|
| F6 | LOW | `HeartbeatService.pickLatestNPerRole` 的分组键从 role 改成 `workflow:<node_id>`,legacy DAG phase session 也带 `workflow_node_id`,分桶随之改变。方向更保守(探的行只多不少 ⇒ 更容易判 `has_working` ⇒ 更不容易误收),但源码注释里「≤9 total」的有界探测承诺已过期。(= attempt 1 F5)|
| I1 | INFO | `turn-belt-reconcile` 经 `plugin.ts:9422 getActorSessionsForIssue` 仍只看 `getPhaseSessionsForIssue`,generic `main` 不在里面。**旧 base / 新 base 都如此,不是 rebase 或本 PR 引入**,而且它还要按 `TURN_RECOVERY_PRIORITY`(design/implement/qa)二次过滤,generic 本来也选不中。不属本单 scope,记录备查。|
| I2 | INFO | attempt 1 的 F6(`mergeable=CONFLICTING`)与 F7(从未跑过 CI)**均已注销**:当前 PR `MERGEABLE`,CI 在 exact head 11/11 全绿。|

---

## 10. 诚实边界(honest boundary)

明确**没有**验到的:

1. **generic 单节点模板走完 land 尾段(真 merge → 收体 → 真 Discord 归档 → Linear Done)的真机全链**没跑到。
   529 房用 stub runner 拿不到真 PR binding,step 8 就是它 usage 里写死的已知诊断出口(exit 20)。
   替代证据 = 作者的 dispatcher 真模板集成用例(我用 4 个突变确认非空过绿)+ 我的 P2/P4 探针 + §7 真 Discord 的归档豁免面。
   **风险**:真机上 land 尾段仍可能有房外因素(真 merge 时序、真 Linear API)。
   何时补:等有一个能真 merge 的 sandbox PR 时,把 529 跑到 step 9。
2. **founder 本人真按 ✅ 的 gate 交互**没做(需要 founder 动作 + 可真 merge 的 PR)。
3. **本机没跑 `origin/main` 的同环境 before 基线**;§5 的归因靠 CI 全绿 + import 图 + 失败签名,不是 before/after 对照。
4. **F5 的 42 条生产 open park** 本次没有重新只读复核,沿用 attempt 1 的取证 —— 那是 08-24 的测量,现在可能已变。
5. **返工投递为什么没送达**(seq 50 `attachment_missing` → 60 分钟 held)本身是 engine 侧的活性问题,
   不在本单 scope,也不影响本次验收结论;我只把它作为「为什么有 attempt 2」的账本事实记录(§1)。

---

## 11. 复现方式

全部证据脚本在 `engineering/doc/FLY-2027-generalized-land-closeout/qa-evidence-2/`:

- `mutation-harness.sh.txt` —— 突变 harness(`mut.sh <label> <relfile> <old> <new> <testfile...>`)
- `probe.test.ts.txt` —— P2 + P4 探针(放回 `packages/teamlead/src/__tests__/` 直接 `npx vitest run`)
- `real-discord-e2e.mjs.txt` —— 真 Discord E2E(`pnpm -r build` 后,
  `HOME=<tmp> FLYWHEEL_STATE_DIR=<tmp>/.flywheel TEST_BOT_TOKEN_2=<token> node <file>`;**会真发 Discord**)
- `qa-529-e2e.log` —— 529 真机 steps 1–8 原始输出
- 529:`scripts/test-deploy.sh 2 --generalized --stub-runner --expect-head $(git rev-parse HEAD)`
  → `node scripts/qa-529-generalized-e2e.mjs 2 --issue FLY-2027` → `scripts/test-teardown.sh 2`
  (`TMPDIR` 必须短于 ~40 字符,否则撞 unix socket `sun_path` 104 上限)
