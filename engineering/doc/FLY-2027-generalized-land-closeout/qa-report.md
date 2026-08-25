# FLY-2027 generic 收尾对等 — 独立 QA 报告

Issue: FLY-2027 (https://linear.app/geoforge3d/issue/FLY-2027/engine收尾-generalized-land-路径缺-fly-369-收尾链ship-后停驻体不收thread-不自动归档8-24-双)
日期: 2026-08-24
基于: plan.md

---

## 0. 结论

**PASS。** 四刀的产品行为均独立复核成立;未发现功能缺陷。
发现 2 个 **测试质量缺口**(其中 1 个是空过绿测)与 4 条 advisory,全部已用独立探针补证代码本身正确。

- 验证的 head:PR #941 head `4029489cd516b4b0cdea915ed13d8b2be97b9d28`(开跑前与发 verdict 前各 fetch 一次,未变)。
  本地 worktree HEAD 仅多出 `progress.md` 的 ledger commit,产品代码逐字节等于 PR head。
- PR 状态:OPEN、非 draft、`mergeable=CONFLICTING`(仅 `CLAUDE.md` 里程碑表冲突,`StateStore.ts` 可自动合并)。
- **PR CI 从未运行**(`gh pr checks 941` → no checks;`gh run list --branch flywheel-FLY-2027` → 空)。本报告的门禁证据全部来自本机。

## 1. 被测范围

四刀(见 plan.md §2),diff 仅落在 `packages/teamlead`:
`StateStore.ts` / `HeartbeatService.ts` / `bridge/{post-ship-finalization,land-closeout-cause,plugin,codex-phase-shutdown,shipped-husk-escalation,runner-shutdown-evidence}.ts`。

Discord-capable 判定:**是**(改了 founder 可见的 `land_archive_waiver` 文案 + thread 归档链路)→ 按 QA 合同必须跑真 Discord。

## 2. 硬门

| 门 | 结果 |
|---|---|
| `pnpm -r build`(22 workspace) | ✅ exit 0 |
| `pnpm lint` | ✅ 0 error / 8 条既有 warning(与 plan §7 声称一致) |
| 变更影响面 10 个测试文件 | ✅ 332/332 |
| `packages/teamlead` 全包 | 9469 pass / 41 fail / 17 skip(见 §5 归因) |

## 3. 独立验证:11 组突变检验(不是复跑作者的测试)

对生产代码逐点做反向突变,看作者的测试是否真会变红。

| # | 突变 | 结果 |
|---|---|---|
| M1 | park 判据回退 `keepalive_park` → `type==="implement"` | ✅ KILLED |
| M2 | clear 收据 reason 不再继承 `open.reason` | ✅ KILLED |
| M3 | active rework replacement 放宽到 terminal reason 集 | ✅ KILLED |
| M4 | husk 强收候选集回退 `getPhaseSessionsForIssue` | ❌ **SURVIVED**(见 F1) |
| M5 | post-ship 1.25 generic 分支关闭 | ✅ KILLED |
| M6 | Heartbeat 巡检候选集回退 | ✅ KILLED |
| M7 | `classifyIssueWorking` 不含 generic main | ✅ KILLED |
| M8 | Codex 优雅 shutdown 回退 `isWorkflowPhaseSession` | ✅ KILLED |
| M9 | founder_reopened 文案回退成旧误导句 | ✅ KILLED |
| M10 | plugin `landIssueCloseoutResultFromClosureReport` 回退成 `{outcome}` | ❌ **SURVIVED**(见 F2) |
| M11 | post-ship 不消费 typed cause | ✅ KILLED |

两个 SURVIVED 都是**覆盖缺口**,不是功能缺陷 —— 我用自建探针分别证明生产代码本身正确(§4)。

## 4. 独立探针(我自己写的,不复用作者的 fixture)

### 4.1 composition probe —— generic land 全链(acceptance ① + ③)
真 `StateStore` + 真 `makeFinalizeWorkflowPhaseRoles` + 真 `runResumablePostShipFinalization`,
只在 Discord/Linear/worktree 打 seam。种一个真 `chat_thread_role='main'` + `workflow_node_id='execute'` +
`ship_parked` 的 generic producer 作为 land source。

结果:
- `complete: true`,`{tmuxClosed, commDbFinalized, worktreeRemoved, threadArchived, issueDone}` 全 true、`linearDoneDisposition="done"`;
- 停驻的 generic producer `ship_parked → completed`(**无人工介入**);
- 走了真归档路径(`PATCH` 落到 Discord seam);
- **围栏成立**:同 issue 另一个 held run 的 generic actor 与普通非-workflow `main` session 均保持 `ship_parked` 不动。

突变敏感性:关掉 generic 分支(M5b)与去掉 exact-run 围栏(M12)**都能把它打红**。

### 4.2 husk probe —— 补 M4 的洞
`forceShippedHusks` 对真 `chat_thread_role='main'` + workflow-bound 的 husk:**能发现并强收**(`cleared=["generic-1"]`);
对普通非-workflow `main`:**不收**。突变 M4b 能把这个探针打红。
> 健康对照救了我一次:第一版探针 stub 写错了方法名(`getRunnerShutdownRequest` vs `getRunnerShutdown`),
> 导致 implement 对照组也 `cleared=[]`;修好后三组都正常。若没做对照会误报 FAIL。

### 4.3 真 Discord E2E —— 改动的 founder 可见面
module-driven:真编译产物 `dist/bridge/founder-thread-notifier.js` + 真 test bot token(TEST_BOT_TOKEN_2)+
529 QA 房真频道 `#product-lead-test` 里真建 thread、真 POST、真 GET 回读。**8/8 PASS**。

Discord 实际渲染出的两条(逐字回读):
```
🤖[自动] ℹ️ 本 thread 未自动归档:founder 已重新打开；系统会保持 thread 开放且不会自动重试归档，请 Lead 确认后手动归档。
🤖[自动] ℹ️ 本 thread 未自动归档:仍有活跃使用者；原因解除后会由清理流程重试。
```
- founder_reopened 那条不再含旧误导句「原因解除后会由清理流程重试」;
- `in_active_use` 对照组文案**未变**(它确实会重试,承诺仍然是真话);
- 全角标点无 mojibake / 截断。
- 证据 thread(已 archive+lock):https://discord.com/channels/1485787271192907816/1541581692563882117

### 4.4 529 QA 房真机(exact head)
`scripts/test-deploy.sh 2 --generalized --stub-runner --expect-head <HEAD>` 起隔离房,
slot Bridge `/health` 的 `buildSha = artifactBuildSha = 8242970e1d4a0b48003bdee445dfaabc05173c49`(= 我的 worktree head)。

真跑到的步骤:
1. generalized run authority is durable ✅
2. **design completed without ship parking** ✅ —— 活证明刀 2 的 capability 判据没有把
   `keepalive_park=true / creates_pr=false` 的 design 误 park
3. implement node dispatched with PR capability ✅
4. **implement is alive in rework-reachable `ship_parked`** ✅ —— 活证明 park 语义在本 head 上成立

step 5 之后**没跑到**:qa 节点 launch 失败(`[Blueprint] Adapter failed: tmux session ensure held: unknown`,
`policy_server_unreachable` / `policy_server_generation_changed`),run 转 `held@qa`。
根因是 529 房自身的 tmux 路由分裂(slot-local socket 与宿主 default server 各有一个 `runner-test-slot-2`),
与本 diff 无关(diff 不碰 tmux ensure / adapter)。

生产零污染取证:开房前 Bridge pid 28451 / uptime 1568s → 拆房后**同一 pid 28451** / uptime 2869s / `ok=true` / 13 sessions。
`scripts/test-teardown.sh 2` exit 0;teardown 漏掉的那个宿主 default server 上的空 `runner-test-slot-2`(裸 zsh)由我手动清掉,残留=0。

## 5. 全包测试的 41 个失败 —— 归因

41 → 逐步隔离后剩 5 个,分布在 **3 个本 diff 未触碰、且不 import 任何被改文件**的测试文件:

| 阶段 | 失败数 | 处置 |
|---|---|---|
| 默认环境全包 | 41 | runner 的 `TMPDIR` 落在 `~/.flywheel/...` 之内,`codex-lead-runtime` / `CodexLeadInboxSocket` 的生产安全护栏(禁止 workspace 与 `~/.flywheel` 重叠)正确拒绝 → 30 个 |
| 换干净 `TMPDIR`(过长) | 17 | unix socket 路径撞 `sun_path` 104 上限(`EINVAL listen … lead-inbox.sock`) |
| 换短 `TMPDIR=/private/tmp/qa2027` | 5 | 见下 |
| 逐文件串行隔离 | 5 | 仍在 |

剩余 5 个(全部为**环境错误/固定超时**,不是断言失败):
- `fly247-bash-suites` ×3 —— `flywheel-fleet` launchctl harness(CLAUDE.md 里 FLY-1628 已登记为宿主既有项)
- `fly1674-opus46-real-tmux` ×1 —— `ENOENT … /tmp/f1674-*/tmux/tmux-501`;**不设** `TMPDIR` 复跑同样失败,排除是我改环境导致
- `workflow-docs-git.integration` ×1 —— 真 git 操作撞 5s 固定预算 timeout

归因依据:①三个文件的 import 图完全不含本 PR 改动的任何文件(bash suite 甚至只跑 shell 脚本);②失败签名是 ENOENT / EINVAL / timeout,不是断言。
**诚实边界**:我没有在本 sandbox 跑出 `origin/main` 的同环境基线(成本原因),所以归因靠上面两条,不是靠 before/after 对照。

## 6. 生产账本取证(只读)

- `workflow_engine_park_outbox`:`runner_ship_gate_wait` **park_opened 42 条、park_cleared 0 条** —— 用生产数据坐实了「该 park 没有结算消费者」这个立单前提。
- 这 42 条全部挂在已 `completed`/`terminated` 的 run 上 ⇒ 本 PR 是**向前生效**,不做回填,42 条历史 open 行部署后依旧留着(见 F4)。
- 新的 replay 不变量(`clear.generation === open.generation + 1` 且 `clear.reason === open.reason`)对**现有生产数据零违例**(SQL 全表扫,0 行),所以这次收紧不会让老 run 的 land replay 抛 `workflow_engine_park_settlement_conflict`。
- 8-24 的 `cause=unknown`(run `ea76818d`)其 land step 收据是 `cleanup_requested = {requested:10, acked:0, timedOut:10}` —— 与刀 4 新增的 `phase_shutdown_unacked` 形态吻合;但当时的**原始 error 字符串没有落库**,所以「这一例部署后会不会变成 typed」**无法从账本证明**(见 F3)。
- 当前生产 `ship_parked` 只有 2 条(FLY-2022、FLY-2027 自己),都是正在等 founder gate 的活体,正常。

## 7. 发现

| # | 级别 | 内容 |
|---|---|---|
| F1 | MEDIUM | `shipped-husk-escalation.test.ts` 的 `discovers and force-reaps a workflow-bound generic main husk` 是**空过绿测**:`upsertSession` 的 `ON CONFLICT DO UPDATE` 不含 `chat_thread_role`,第二次 upsert 只写进了 `workflow_node_id`,被测 session 仍是 `chat_thread_role='implement'` —— 用旧查询也能命中,所以它证明不了新候选集。突变 M4 存活即铁证。**代码本身正确**(§4.2 探针已证)。建议把 §4.2 探针收编进该文件。 |
| F2 | MEDIUM | plan §2 刀 4 明确要求「经 plugin wiring 一路断言到 `finalization_partial` 的 typed cause,不允许只测纯函数」;实际只测了纯函数,`plugin.ts:5581` 那一行零覆盖(M10 存活)。类型上是安全的(`ClosureReport.outcome` 联合里没有 `"completed"`,早返分支覆盖完全),但这条是**计划偏离**。 |
| F3 | LOW | 新 `phase_shutdown_unacked` 只匹配 4 个 token 前缀(`phase_shutdown_ack_` / `phase_shutdown_timeout_` / `_request_disappeared` / `_failed`);仓库里真实存在的还有 `phase_shutdown_db_error` / `_lookup_error` / `_liveness_error` / `_liveness_indeterminate` / `_request_mismatch` / `_post_ack_lookup_error`,这些仍落 `unknown`。 |
| F4 | LOW | 刀 3 向前生效,不回填。生产 42 条 `runner_ship_gate_wait` open park 部署后仍是 open(所属 run 已终态,不会再触发结算器)。plan 没承诺回填,但 founder/Lead 侧的「park 账已清」口径需要知道这一点。 |
| F5 | LOW | `HeartbeatService.pickLatestNPerRole` 的分组键从 role 改成 `workflow:<node_id>`,legacy DAG phase session 也带 `workflow_node_id`,所以它们的分桶也变了。方向是**更保守**(探的行只多不少 ⇒ 更容易判 `has_working` ⇒ 更不容易回收),但源码注释里「≤9 total」的有界探测承诺已过期(实际上限约 3×节点数)。 |
| F6 | INFO | PR #941 `mergeable=CONFLICTING`,冲突仅 `CLAUDE.md` 里程碑表;`packages/teamlead/src/StateStore.ts` 可自动合并。ship 前常规 rebase 即可。 |
| F7 | INFO | **该分支从未跑过 CI**(`gh pr checks 941` = no checks,`gh run list` = 空)。FLY-1861 的 ship workflow 要求 approved head 有 `CI OK` 才 merge ⇒ 这会挡住 land。建议 ship 前先推一次让 CI 起来。 |

## 8. 诚实边界(honest boundary)

明确**没有**验到的部分:

1. **generic 单节点模板在 529 房里的真机全链**(execute → founder 批准 → engine land → 收体 + 归档)没跑到。
   529 房走的是 `tpl_code`(design/implement/qa)形状,而且在 qa 节点被房内 tmux 路由分裂卡住(§4.4)。
   替代证据 = §4.1 composition probe(真 store + 真 finalizer + 真 post-ship 管线,只在 Discord/Linear/worktree 打 seam)。
   风险:composition probe 的 land source / 归档是 seam,不是真 Discord 归档 API;真机上仍可能有房外因素。
   何时补:529 房 tmux 分裂修好后(或不从 runner pane 内开房时)重跑 `qa-529-generalized-e2e.mjs` 到 step 9。
2. **founder 真按 ✅ 的 gate 交互**没做(需要 founder 本人动作 + 一个真能 merge 的 sandbox PR)。
3. **8-24 那一例 `cause=unknown` 部署后会不会变准**证明不了(原始 error 字符串未落库,§6)。
4. **`origin/main` 同环境基线**没跑,§5 的归因靠 import 图 + 失败签名,不是 before/after 对照。
5. **PR CI 结果**无法引用(从未运行,F7)。

## 9. 复现方式

- 突变脚本:`scratchpad/mut.sh <label> <file> <old> <new> <testfiles...>`(改一处 → 跑测 → 无条件还原)
- 探针:`scratchpad/qa2027composition.test.ts`(放回 `packages/teamlead/src/__tests__/`)、
  `scratchpad/qa-fly2027-probe.test.ts`(放回 `packages/teamlead/src/bridge/__tests__/`)、
  `scratchpad/qa-fly2027-real-discord.mjs`(`node` 直跑,会真发 Discord)
- 529:`scripts/test-deploy.sh 2 --generalized --stub-runner --expect-head $(git rev-parse HEAD)` → `node scripts/qa-529-generalized-e2e.mjs 2 --issue FLY-2027` → `scripts/test-teardown.sh 2`
  (务必 `TMPDIR` 短于 ~40 字符,否则撞 `sun_path` 上限)
