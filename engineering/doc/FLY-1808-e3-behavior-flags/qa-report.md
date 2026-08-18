# FLY-1808 E3 会改变行为的 flag 逐条固化 — 独立 QA 报告

Issue: FLY-1808 (https://linear.app/geoforge3d/issue/FLY-1808/flag执行e3-会改变行为的-10-条逐条删-显式固化值不许批量)
日期: 2026-08-17
基于: plan.md · PR #871

---

## 0. 结论

**PASS**（含 7 条非阻塞 advisory，见 §6）。

被验版本：worktree HEAD `2c0795cc`（= PR head `cb4851203` + 仅 `progress.md` 的 QA 账本 commit；产品代码逐字相同）。
529 隔离房的 slot Bridge `/health` 实测 `buildSha=2c0795cceeb5d4acef350cd8c40d95674eeae88d`，即真机验的就是被测字节，非 main。

12 条逐条核对：**固化值 == 生产当前生效值**，全部成立。生产 `.env` 与 **活 Bridge 进程环境**双向取证，非只读 PR 描述。

---

## 1. 生产现值取证（只读，我自己取的，不引用 PR）

`~/.flywheel/.env`：
```
136:FLYWHEEL_CMUX_LINKED_VIEW=0
141:FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1
142:FLYWHEEL_WORKFLOW_CLAIMS_READ=1
150:FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES=1
151:FLYWHEEL_WORKFLOW_GATE_CARRIER=1
160:FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1
162:FLYWHEEL_MAILBOX_DISCORD=1      ← D-3，未被本 PR 触碰
```
活 Bridge 进程（pid 11387）`ps eww` 实测同值；`FOUNDER_UX_GATE_ENABLED` / `RUNNER_AUTOCONTINUE` /
`COMM_BYPASS_BRIDGE` / `DONE_THREAD_RECONCILE` / `LEAD_DRY_RUN` **在活进程环境里不存在**。

absent-read 分支从 `origin/main` 源码逐条取证（不是从 PR 描述抄）：

| 项 | main 上的判读式 | absent ⇒ | 生产现值 | 固化值 | 一致 |
|---|---|---|---|---|---|
| founder_ux_gate_killswitch | `=== "1"`（`founder-ux-config.ts:79`） | OFF | absent=OFF | 门不在 | ✓ |
| founder_ux_gate（config key） | raw absent → `enforce`，但四个消费点全部 `&& isFounderUxGateEnabled()` | 无有效门 | 无有效门 | 门不在 | ✓ |
| runner_autocontinue | `=== "1"`（`plugin.ts:10305`） | OFF | absent=OFF | OFF | ✓ |
| comm_bypass_bridge | `!== "1"` 守卫（`respond.ts:88`） | 无旁路 | absent=无旁路 | 无旁路 | ✓ |
| cmux_linked_view | `:-1` 缺省 ON | ON | 显式 `=0` | OFF | ✓ |
| workflow ×5 | `=== "1"` | OFF | 显式 `=1` | ON | ✓ |
| lead_dry_run | `=== "1"` | OFF | daemon absent；两个 per-invocation setter | 读点/setter 一字不改 | ✓ |
| done_thread_reconcile | `!== "0"` | ON | absent=ON | 读点/注入一字不改 | ✓ |

**killswitch 短路是我自己核的**：`origin/main` 上 `isFounderUxGateEnabled()` 的全部消费点 =
`Blueprint.ts:2275` / `event-route.ts:2445` / `founder-ux/routes.ts:122` / `claude-lead.sh:2631`，
四处都以它为前置；其余 `founder_facing_ux` 位点全是 writer/propagator，无独立 reader。
⇒ killswitch OFF 时整个门确实惰性，删除即零行为变化。

---

## 2. 「删的是真分支，不是名字」——RED 基线（本次 QA 的核心取证）

近似检查（grep 到名字）证明不了分支被删。我把**新写的 inert 断言拿到 `origin/main` 上跑**，
看它们是否真的红——红=断言确实压在被删分支上；绿=空过。

**A. `comm_bypass_bridge`**（`respond.gate.test.ts` → main 树，跑完即删，生产仓 `git status` 事后为空）
- main 上 **2 failed / 12 passed**：`FLYWHEEL_COMM_BYPASS_BRIDGE=1` 时 main **不抛异常**（received `undefined`），
  即旁路真的写了 gate；PR head 上同一文件 14/14 绿。

**B. Wave B 五条**（`StateStore.workflow-templates.test.ts` + `workflow-template-selection.test.ts` → main 树）
- main 上 **15 failed / 29 passed**，逐条点名：
  `ignores retired FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=0`（schema v1 + v2）、
  `..._CLAIMS_WRITE=0`（v1+v2）、`..._CLAIMS_READ=0`（v1+v2）、`..._GENERALIZED_TEMPLATES=0`（v2）、
  `keeps historical epoch 0 while retired gate-carrier zero cannot disable new engine runs`、
  `ignores retired zeros across schema-v2 authoring, publish, and materialization`，
  以及 selection 侧四条 + 两条 binding 用例。PR head 上全绿。
- 另有 `runs-route.dag-entry.test.ts` 两条在**真 HTTP 路由**上注 `=0`：main 返 409
  （`ACTIVE_WORKFLOW_RUN_RECOVERY_HELD` / `WORK_KIND_ENTRY_NOT_MATERIALIZED`），head 返 200。

⇒ 五条派工开关 + 旁路的固化是**可证伪地**逐条成立的，不是整体表述。

---

## 3. 消费点逐处核对（ON 分支是否被逐字保留）

`origin/main` 上五个谓词的 12 个生产调用点，逐处比对新旧语义：

| 位点 | main | head | 等价（flag=ON 时） |
|---|---|---|---|
| `workflow-template-selection.ts:186/189` | `if(!enabled) return null` + blockReason throw | 直落 | ✓ |
| `StateStore` createRevision / publish（v2 generalized 检查） | throw when OFF | 删 throw | ✓ |
| `StateStore.materializeWorkflowRun` blockReason | throw when blocked | 删 | ✓ |
| `StateStore` gate_carrier 写列 | `startReservation && enabled ? 1 : 0` | `startReservation ? 1 : 0` | ✓ |
| `StateStore` generalized admission blockReason | `ok:false` | 删 | ✓ |
| `workflow-engine-dispatcher.ts:2059` | throw `engine_dispatch_*` | 删 | ✓ |
| `runs-route.ts:2087 / 2169` 及 4 处 `&& workflowDispatchEnabled` | 分支 | 内联 ON | ✓ |
| `workkind-cutover.ts:862/863` | 读 env | 常量 `true` | ✓ |
| `merge-ship-gate.ts:300` | READ OFF → legacy/fail-closed 早退 | 删早退 | ✓ |
| `external-merge-reconcile.ts:750` | `if(READ)` 包 head authority | 直接取 | ✓ |
| `ship-eligibility.ts` 三层解析 + qa claim 门 | default-off 三层 | 删解析，恒走 enrolled 路径 | ✓ |
| `verify-approval.ts` live-`.env` 三层 | OFF → 退回 `verifyApproval` | 删退回 | ✓ |

`Blueprint` 构造器**中段位置参数**被摘（原注释明写"必须留在最后"）——唯一生产构造点
`run-infra.ts:563` 与 `createRunBlueprint` 定义/调用三处同步更新，位置未错位；22 workspace build 绿。

StateStore 三条历史 migration（`founder_facing_ux` / `founder_ux_signoff_json` / `founder_ux_gate_mode`）
**保留**（`StateStore.ts:2894/2901/2910` 实测在），旧库可重放。

---

## 4. 真机 E2E（529 隔离房，生产零触碰）

房型：`test-deploy.sh 2 --generalized --lead-label Flywheel --extra-lead 3:Ops-Test`
（单 Bridge + **两个真 test Lead** = N-to-N 拓扑），`TEST_REPLY_BY_ISSUE=1`，
从**被测 worktree** 起房（不是生产仓），`/health buildSha` 逐字核过。

**跑法一（真 Runner）**：DAG 派工把真 Claude Runner 拉起进 tmux（窗名
`FLY-1808-design-claude-Fable-...`）、真 Discord thread 建成（`thread=1539066782310993920`）、
DB 落 `workflow_run(schema=2, gate_carrier_epoch=1, claims_read_enrolled=1, engine_owned=1)`。
Runner 随后撞 **Fable 5 额度封顶**（7d 94% / Fable 100%），按规矩**只上报不换模**，该跑法止步。

**跑法二（`--stub-runner`，同房重开）**：`qa-529-generalized-e2e.mjs` **步骤 1–7 全绿**
```
step 1 generalized run authority is durable
step 2 design completed without ship parking
step 3 implement node dispatched with PR capability
step 4 implement is alive in rework-reachable ship_parked
step 5 question gate delivery works while parked implement owns no gate
step 6 QA FAIL reached wake_delivered without held/needs_lead
step 7 current implement execution completed attempt 2 and advanced head
```
终局 DB：`workflow_run(schema=2, epoch=1, claims_read_enrolled=1, engine_owned=1)`、
`workflow_claims` **1 行**（claims WRITE 真发生）、sessions = design `completed` /
implement `ship_parked` / qa `terminated`、真 Discord thread `1539069457144487968`。

step 8 退出码 **20** = 脚本 usage 自己写明的 `known F2 PR-authority diagnosis`
（`workflow_node_pr_binding_missing`）。**归因已证**：`qa-529-generalized-e2e.mjs` /
`qa-generalized-e2e-lib.mjs` / `qa-generalized.sh` / `test-deploy.sh` 本 PR **零改动**，
且 exit-20 的文档在 `origin/main` 上就存在 ⇒ 既有已知项，非 FLY-1808 回归。

**其它真机断言（都带阳性对照）**：
- 退役的 `/api/founder-ux/status` 与 `/api/founder-ux/signoff` → **404**；对照 `/health` → 200。
- `lead-alert.sh --kind cmux_flag_state` → `unknown --kind`；**同一条烂 lead** 用保留 kind
  `cmux_cleanup` → 越过 kind 闸、在后面的 lead 解析处报错 ⇒ 尺子有效，不是全拒。
  隔离 queue/deadletter 目录事后为空，Discord 零副作用。
- 操作台渲染（Claude-in-Chrome，chrome-repair preflight 先跑过、`list_connected_browsers` = 1）：
  用被测 `dist` 直渲 `flag-report.html` 与 `fleet-console.html`。44 条 flag 渲染正常、
  12 条退役 flag **一条不在**、保留 flag 仍在（阳性对照）、`DAG 控制 · 五杆三事实` 面板
  与 `dag-control/data-dag-copy/renderDagControl/dagPanel` 标记全消失、
  **零 JS 异常**（`MANAGEMENT_CONSOLE_APP` 是内嵌 JS 字符串，lint/tsc 覆盖不到，这一条只能靠真浏览器）。

生产 Bridge 全程未被触碰：QA 前后 `127.0.0.1:9876/health` = `ok:true`、11 sessions、`buildSha=e54ece67b`(main)。
房子已 teardown，端口/目录零残留。

---

## 4b. 生产 census（我自己重跑的只读快照，非引用 PR）

`sqlite3 -readonly ~/.flywheel/teamlead.db`，观测于 **2026-08-18 00:44:20 UTC**：

| 指标 | 我的快照 | PR 快照(20:46 UTC) | Lead 口径 |
|---|---|---|---|
| workflow_run 总数 | **317**（schema1=36 / schema2=222 / NULL=59） | 314（36/219/59） | 313 |
| workflow_claims | **269** | 263 | 261 |
| 已发布未退役模板 | **5 个，全部 schema 2**（tpl_code·tpl_design·tpl_generic_menu·tpl_prd·tpl_prototype） | 5 全 schema2 | 5 全 schema2 |

数字随时间单调上行（三次快照相隔数小时），**结构结论三方一致**。

**零行为变化的决定性一格** —— 活跃/held 的 engine run 逐个核：

```
status | gate_carrier_epoch | claims_read_enrolled | count
active |         1          |          1           |  17
held   |         1          |          1           |  20
```
37 个全部 `epoch=1` + `enrolled=1`，**epoch-0 的活跃 engine run 为 0**。
⇒ 焊死成 ON 之后，现存每一条活 run 都已经在被冻结的那个状态里，切换瞬间零观测差。

## 4c. 两条搬迁的「字节不变」硬验（Lead 判据 ③）

在 `origin/main` 上 git grep 出**所有** 36 个 touch `FLYWHEEL_LEAD_DRY_RUN` /
`FLYWHEEL_DONE_THREAD_RECONCILE` 的文件，逐个 `git diff --quiet origin/main HEAD -- <file>`：
**36/36 全部字节相同**。读点与 setter 阳性对照仍在：
`done-thread-reconcile.ts:101` `env.FLYWHEEL_DONE_THREAD_RECONCILE !== "0"`、
`test-deploy.sh:916` 注入 `=0`、`verify-anna-isolation.sh:122` 与
`scripts/lib/buddy-captain-preview.sh:148` 的 `FLYWHEEL_LEAD_DRY_RUN=1` per-invocation setter。
⇒ 这两条确实只在**台账层**移动（registry 行删除 → `FLAG_EXEMPTIONS` 显式 object，
`persistentEnvAllowed:false` / `owner:flywheel-eng-lead` / `issue:FLY-1808`），代码零改动。

（注：exemption reason 里写的路径是 `buddy-captain-preview.sh`，实际在 `scripts/lib/` 下——
措辞小瑕，不影响 exemption 生效。）

---

## 5. 门（我自己跑的）

| 门 | 结果 |
|---|---|
| `pnpm lint` | rc=0，**0 error / 8 warning**（既有） |
| `pnpm -r build` | rc=0，22 workspace 全过 |
| config 包 | 605 tests：首轮 4 failed 全部是宿主高负载下的 5s timeout（load 52→78）；`--testTimeout=120000` 隔离复跑 **22/22 绿** ⇒ 环境项，非缺陷 |
| flywheel-comm 包 | **1522/1522 绿**（106 files）；尾部 1 个 Vitest worker RPC timeout = 既有负载项 |
| edge-worker 包 | **1297 pass / 5 skip** |
| teamlead 定向 16 文件（workflow/StateStore/merge-ship-gate/external-merge-reconcile/runs-route/rework e2e/autocontinue-retired） | **425 pass / 2 skip / 0 fail** |
| `scripts/test-cmux-sync.sh` | **536/536** |
| `scripts/__tests__/test-cmux-autostart-flags.test.sh` | 6/6 |
| `scripts/__tests__/check-flag-truth.test.sh` | 首轮 0/2（runner TMPDIR 88 字符撞 sun_path 104，`listen EINVAL … .pipe`）；`TMPDIR=/tmp/` 复跑 **2/2** ⇒ 环境项 |
| `fly231-companion-launch-plan` / `fly1402-single-bundle` | 52/52 · 39/39 |
| `fly879-external-launch-plan` | **15 failed —— 已证为 main 既有失败**：同一脚本在生产仓 main(`e54ece67b`) 上同样 15 failed（25 pass vs 本分支 24 pass，差的那 1 条正是本 PR 从 forbidden 列表移除的 `founder-ux-rules.md`）⇒ 非本 PR 回归 |

退役 env 残留扫（`packages/` `scripts/` `.github/`，排除 `__tests__`/`dist`）：
10 个 env 在**生产源码**里各自只剩 1 行 FLY-1808 tombstone。**例外我如实点出**（见 advisory 1）。

---

## 6. Advisory（非阻塞，交 Lead 定夺）

1. **PR 「Verification」小节的一句残留声称需要收窄**（**注意：该残留本身 PR 已披露**，
   见 PR「Known limitations and follow-up ledger」第 1 条，Lead 已分诊到 FLY-1824 式尾巴批次）。
   只是 Verification 那句写成「the five workflow env names occur only in their FLY-1808 tombstones」，
   与同一 PR 后文自陈的 `scripts/lib/qa-generalized.sh`（5 处 export + 5 处透传）、
   `scripts/qa-fly-1707-incident-dispatcher.ts`（4 处）互相打架。行为上惰性（无 reader），
   但 `qa_generalized_write_env_attestation()` 会**写一份 attestation 文件断言「五个 flag =1」**——
   那是给未来 QA 读的证据文件，断言的是一组已不存在的开关。建议把 Verification 那句改成
   「生产源码只剩 tombstone；QA 房注入/attestation 的残留见 known-limitations 第 1 条」。

2. **plan §3.4 指定的 `cmux_linked_view` inert 断言未交付**。交付形态是**删掉**
   `test_fly1272_flags_default_on_and_explicit_off` 与 `test_fly1364_a0b1_flag_latch_survives_restart_and_rearms`，
   没有新增等价断言。我认为该属性仍成立、且证据比原计划更强：main 上生产读点**恰 2 处**（我 git grep 独立核过）、
   head 上 0 处、`fly1808-wave-a.test.ts` 对 7 个文件做限域正则守卫、`test-cmux-sync.sh` 536/536 绿证明
   view 机器本就无条件、且**生产 latch 已是 `A0B1|1`**（我读的 `~/.flywheel/state/cmux-flag-state`）⇒ 该告警本来就
   再也不会触发。但这是**对计划的偏离**，不该被默默接受。
3. **陈旧 Runner 的残余语义差**（已被 PR 以「门不在」口径披露，我补量化）：`/api/founder-ux/*` 从
   200`{approved:true}` 变 404；`founder_ux_declared` 事件类型消失；`stage set --ux-file` 选项消失。
   FLY-900 之后 Blueprint 的注入受 killswitch 把守 ⇒ 现网无任何发起方，今日风险为 0。
4. **部署窗顺序小项**：`lead-alert.sh` 已拒 `cmux_flag_state`，若合入/重启窗内某份**旧的**已部署
   `flywheel-cmux-sync` 副本发该 kind，会拿到 `config_error` 而不是告警。因 latch 已 `A0B1|1`、
   状态再不可能变化，实际不可能发生。
5. `claude-lead.sh:2533-2536` 新引入 **tab 缩进**注释，邻行是 2 空格。纯观感。
6. `StateStore.workflow-templates.test.ts` 仍向 `materializeWorkflowRun` 传已不存在的 `env:` 属性
   （类型卫生项；该断言的 RED-on-main 我已实测，断言本身有效）。
7. `fly879-external-launch-plan.test.sh` 15 failed 是 **main 既有**（§5），与本 PR 无关，但它长期红着，值得单独立项。

---

## 7. 诚实边界（没测到的，逐条写明）

- **没有做系统级 `=0` 负对照**（重启 slot Bridge 把五个开关设 0 再发一次 `/api/runs/start`）。
  529 房的 attestation 在 exec 边界硬要求 `=1`，绕开它要手搓 Bridge 启动，风险高于收益。
  该属性改由**路由级 inert 断言**覆盖：`runs-route.dag-entry.test.ts` 在真 HTTP 路由上注
  `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH="0"`，main 409 / head 200（§2）。
- **真 Runner 跑法只走到 design 节点**就撞 Fable 额度封顶；1–7 步的完整链路由 `--stub-runner`
  跑法覆盖（Bridge 侧的 gate/claims/ship-parking 逻辑是真的，只有 agent 本体是 stub）。
- **`--generalized` 房不挂 fleet-console 路由**（`/api/fleet/flag-report.html` 在 slot 上 404），
  所以操作台是用被测 `dist` 直渲后在真浏览器里验的，不是经 slot Bridge 服务的。
  「经真 Bridge 服务 + 真后端数据的 Feature Flags 页面」未验——需生产重启后自然观察。
- **`pnpm test:packages:run` 全量聚合未报绿**：宿主 load 一度 78，且既有的 headless
  Terminal.app / npm cache / Vitest worker RPC 环境项在本机复现。我跑的是定向包与定向文件，
  逐项在 §5 留证；无沙箱结论以 CI 为准。
- **生产部署后的效果不在本节点**：`.env` 删行（S2/S4）、Bridge 重启、全舰观察都属 ship 步骤。

---

## 8. 验收对照（plan §9）

| # | 要求 | 结果 |
|---|---|---|
| 1 | PR 12 行逐条表，零整体表述 | ✓ PR 正文逐条给了固化值 + 三格证据 |
| 2 | 具名集合守卫（Wave A 5 行 / 4 env + 1 companion / 1 config key / 2 搬迁四联；答 A 后 union 10/9+1） | ✓ `fly1808-wave-a.test.ts` 全部覆盖并绿；tombstone 实测 10 条 |
| 3 | 历史合同：epoch-0 / non-enrolled / legacy 逐条 | ✓ epoch-0 用例保留且 RED-on-main 已证；`gate_carrier_epoch===1` 的下游分支本 PR 一行未动 |
| 4 | D-3 排除、`.env:162` 未触碰 | ✓ `FLYWHEEL_MAILBOX_DISCORD=1` 原样 |
| 5 | 全仓门 + codex review + 独立 QA | lint/build 绿；定向套件绿；本报告 = 独立 QA |
| 6 | Wave B 仅在 D-2 答 A 后存在 | ✓ PR 引 Annie `【D-2 决策卡】A`（2026-08-17 19:33 UTC，issue thread） |

---

## 9. Lead 判据回灌逐条核对（`[lead-instruction FLY-1808 QA 判据回灌]`）

| # | 判据 | 结果 | 证据位置 |
|---|---|---|---|
| ① | 十条删除逐行 absent-read 复核，读代码实测，不抄 registry / 不抄 PR | ✓ | §1 表格全部取自 `origin/main` 源码；registry.default 未作依据 |
| ② | 五个派工开关焊 ON，对照 census 口径验零行为变化，含≥1 次真派发路径实跑 | ✓ | §4b census（37 活/held engine run 全 epoch=1+enrolled=1，epoch-0 为 0）+ §4 两次真派发实跑（真 Runner 拉起 + stub 跑通 1–7 步，claims 真写 1 行） |
| ③ | 两条搬迁字节不变 + 显式 object 逐条带出处 | ✓ | §4c：36/36 文件字节相同；exemption object 两条各带 owner/issue/reason |
| ④ | 零静默 descope：12 条各有归宿；known-limitations 五条 + 六个 tombstoned env key 显式在 PR body | ✓ | PR body 12 行表齐全（10 删 + 2 搬）；`## Known limitations and follow-up ledger` 恰 5 条；`### Lead-owned ship-window task` 列出 6 个 key 且逐个带 `.env` 行号与当前值，与我独立读到的 136/141/142/150/151/160 逐字一致 |
| ⑤ | exact-head `cb4851203` 与 PR #871 head 一致再开验 | ✓ | 开跑前 `gh pr view 871` = `cb4851203274f88445c30c30766b61b35446cbeb`；PASS 前重新 fetch 复核 |
