# FLY-1768 529 房 implement↔QA 返工环活体演练 — QA 报告

Issue: FLY-1768 (https://linear.app/geoforge3d/issue/FLY-1768/qafly-1765-529-房活体演练founder-直令装房-真单全环-implementship-parkedqa)
日期: 2026-08-14
基于: plan.md

## 0. 判决

**六步过,三步受阻(受阻点与 #837 无关)。**

- **FLY-1765 要证的东西 —— implement↔QA 返工环 —— 已在真机证毕。** 命门三步(4/6/7)全部拿到秒级库层证据。
- 未验证的 5/8/9 依赖 founder gate 能打开;gate 被一个**上游、既存、与 #837 diff 无交集**的阻塞挡住。
- 本报告**不出 PASS/FAIL 单字判决**送入引擎(QA 判决不进引擎,按本单纪律)。结论交 Lead 与 founder 定夺。

## 1. 被测对象与硬门

| 项 | 值 |
|---|---|
| 被测 | FLY-1765 / PR #837 @ `fbff3c1573fe8dd54713e62fe18f15f44b023092` |
| 房 | 529 隔离 slot 2,Bridge port 19872 |
| **硬门** | slot `/health` 的 `buildSha` **与** `artifactBuildSha` **都** = `fbff3c157…`,与 PR head 逐字相同 |
| Bridge 代码来源 | 从被测 worktree `~/Dev/flywheel-FLY-1765` 调 `test-deploy.sh`(脚本所在仓库决定 Bridge 版本) |
| runner 沙箱 | `xrliAnnie/flywheel-qa-sandbox` 分支 `flywheel-FLY-1765` @ 同一 head |
| 真单 | 既有夹具 FLY-202(不新建单) |
| run | `7c13c0ce-c946-4693-a94e-2ba892bdc258`,`tpl_code`,`engine_owned=1`,`gate_carrier_epoch=1`,`entry_kind=workflow_v2` |
| 真 Discord 腿 | 隔离频道内为 FLY-202 建了**恰 1 个** thread `1537853327985999892` |
| 生产触碰 | **零**。未调用任何全舰重启脚本;teardown 把生产 session 全部按 foreign owner 跳过 |

## 2. 九步逐项结果

| # | 断言 | 结果 | 库层证据 |
|---|---|---|---|
| 1 | run 判据链 + 真 manifest | ✅ | `engine_owned=1`/`gate_carrier_epoch=1`;编译后 manifest `approval_gate=founder_gate`、`terminal_node=land` → gate authority = `land`;`implement` 节点 `type=implement` 且 `capabilities.creates_pr=true`;`qa_retry` 回边 `qa→implement`(max 3)存在 |
| 2 | design 完工 → `completed`(**阴性对照**) | ✅ | `23987349` → `completed`,`terminal_at 2026-08-14 16:12:34`,`lifecycle_revision 0→1`,`route=phase_design_complete`,`completion_disposition=terminal_no_gate` |
| 3 | implement 派发 | ✅ | `dispatch_vendor_resolved`:`vendor=codex / model=gpt-5.6-sol / effort=xhigh`,与 `menus/shapes/code.yaml` 里 implement 的 `defaultModel: codex` 逐字一致 |
| 4 | **命门:completion 投 `ship_parked`** | ✅ | 见 §3 |
| 5 | 停驻期 founder gate 投递 + 停驻体不得当 gate holder | ⛔ 未验证 | gate 未打开(见 §5);`workflow_gate_holder` 0 行 |
| 6 | **QA FAIL → 自动 `wake_delivered`** | ✅ | 见 §4 |
| 7 | 原体 attempt 2 续跑 + 真新 commit | ✅ | 见 §4 |
| 8 | QA PASS → founder gate → land | ⛔ 受阻 | 见 §5 |
| 9 | `park_cleared` 结算 + `completed` + 体回收 | ⛔ 未验证 | 依赖第 8 步 |

## 3. 第 4 步(命门)—— 四条子断言逐条

implement 体真跑 22 分钟(codex `gpt-5.6-sol` xhigh,379,947 token),开出真 PR
**#106**(非 draft,head `b923ed56`)。完工瞬间:

| 子断言 | 证据 |
|---|---|
| ① session 状态 | `sessions.status(dfa4526d) = ship_parked`,`decision_route = needs_review` —— **不是** `completed` |
| ② park 台账 | `park_opened` / `reason=rework_reachable_wait` / `generation=2` / `2026-08-14T16:34:28`,`event_id = engine-park-open:activation:dfa4526d…:7c13c0ce…:implement:1` |
| ③ 无终态戳 | 同表 design 那条有 `terminal_at 16:12:34`,implement 这条 **为空** → 实证 `ship_parked` 分支不走 `applyTerminalTimestamp`,这正是 wake 闸能放行的物理原因 |
| ④ 体真停驻 | codex goal `9310cee0` `active → paused`(379,947 token / 1,314s);daemon pid 91249 存活;pane 末行逐字 `Goal paused (/goal resume)` |

**对照事故原形**:`holder-wake-activation.ts:41-51` 的闸只放行
`running / ship_parked / design_done / awaiting_review`;FLY-1655 之后这里必然是 `completed`,
闸必拒 `state_not_revivable:completed`。本轮实测走的是 `ship_parked`。

## 4. 第 6+7 步(核心一击)—— 秒级时间线

```
16:37:51  QA 落 FAIL      → workflow_rework_request 落行(authority=qa, source_node=qa, attempt=1)
16:37:52  +1 秒           → workflow_rework_delivery.state = wake_delivered
                             hold_count=0  last_error=空  generation=1  route_revision=1
```

**反例全库零命中**:`state_not_revivable`、`holder_activation_failed`、`needs_lead`、`held`
四个关键词在 `workflow_run_event` 全表扫描**一条都没有**;`workflow_run.status` 全程 `active`。

**事件链有序**:
`rework_requested → rework_route_interpreted → edge_traversed(qa_retry→implement/2) →
rework_target_reserved → rework_delivery_claimed → execution_admitted →
activation_turn_granted → rework_delivery_turn_granted → rework_delivery_wake_delivered →
turn_granted(attempt=2, fromRole=qa, toRole=implement, epoch 4)`

**回的是原体不是换体**:
- `execution_id` 仍是 `dfa4526d`;`ship_parked → running`;`lifecycle_revision 1→2`
- codex goal `paused → active`,token `379,947 → 389,829`、耗时 `1,314 → 1,343s` —— **真在续跑,不是账面复活**
- park 台账同 activation 追加 `park_cleared / activation_wake_admitted / gen=3` —— 停驻在唤醒准入时结算,无残留 open

**真产出修复代码**:同分支新 commit `2ced210d docs(FLY-1768): add attempt-2 QA drill marker`,
`doc/qa/sandbox-notes.md:101` 逐字为 `FLY-1768 drill marker attempt2`(QA 在 FAIL 判决里点名要的那行)。

**attempt 2 完工后再次停驻**:`dfa4526d` 回 `ship_parked`,`lifecycle_revision=3`,
新 `park_opened / rework_reachable_wait / gen=4 @ 16:42:15`。
第一条 rework(`rework:96f6b926…`)最终 `state=completed`;第二条(`rework:46f0e587…`,QA 复测唤醒)`wake_delivered`。两条 `last_error` 均为空。

## 5. 阻塞 —— 第 8 步:`land_head_unavailable`

### 5.1 现象(逐字)

QA attempt 2 判 PASS,服务端两次拒绝:

```
POST http://localhost:19872/api/workflow/decision
HTTP 409: transition_refused; detail={"transitionReason":"land_head_unavailable"}
```

判决 fail-close 落盘未丢:`~/.flywheel/state/qa-result-failed/9011facb-….json`。

### 5.2 排除项(两次自我更正,都以证据推翻)

- **更正 1**:最初怀疑 `implement.produces_output=false` 导致输出凭据从不铸造。
  被**生产库只读对照**推翻 —— 生产 `workflow_output_credential` 与 `workflow_node_outputs`
  **同样是 0 行**,却有 **98 条** PR binding。那条路本就不靠 implement 的输出凭据。
- **更正 2**:随后怀疑是 QA 没传 `--pr-head`(`qa-result.ts:697`:持凭据时不传就不带
  `client_pr_head_sha`)。**带 head 重发仍被拒** —— marker 里 `targetExecutionId=dfa4526d`(对)、
  `prHeadSha=f2def627…`(对),服务端照样 `land_head_unavailable`。所以缺的是 **PR binding 本身**。

### 5.3 最有价值的对照

| | implement session | qa session |
|---|---|---|
| 本房 slot 2 | `pr_number=106`、`pr_head_sha=f2def627` | **两个字段都空** |
| 生产(tpl_code run `cc736520`,PR 839) | `pr_number=839`、`head=92ef2cc8` | `pr_number=839`、`head=92ef2cc8` |

且生产的 PR binding 绑在 **`qa`** 节点上,不是 implement。
本房 `workflow_node_pr_binding` = **0 行**。

**假设(明确标为假设,未查实)**:本房 QA 体自始至终没拿到 PR 身份,而生产 QA 体有;
没有它就产不出 gate-entry binding,land 权威的 gate 转移必拒。
一个待验方向:本房 QA 与 implement 共用同一 worktree,库里查不到 worktree binding 表。
**为什么本房 QA 没拿到 PR 身份,本报告不下结论** —— 属产品侧机制,交 Lead / Codex。

### 5.4 归属:**不是 FLY-1765 引入的**(两条硬证据)

1. FLY-1765 对 `packages/` 的整个 diff,以下五个符号的增删行数**全为 0**:
   `land_head_unavailable`、`produces_output`、`recordWorkflowNodePrBindingTx`、
   `workflow_output_credential`、`workflow_node_pr_binding`。
2. `origin/main` 上同一守卫(`StateStore.ts` 的 `land_head_unavailable`)与同一份
   node-type 能力表**逐字存在**。

⇒ 该阻塞是**上游既存条件**,与 #837 的改动面无交集。

## 6. 两条 finding(Lead 已认领为 follow-up 素材)

**F1 — `qa-result` 不带 `--pr-head` 时静默不传 head。**
`packages/flywheel-comm/src/commands/qa-result.ts:697`:
```ts
prHeadSha = suppliedPrHeadSha ?? (workflowCredential ? undefined : deriveHeadSha(getGit()));
```
持有 workflow 凭据时,不显式传 `--pr-head` 就**静默**不带 `client_pr_head_sha`,
而 land 权威的 gate 转移硬要求 head。要么给 worktree HEAD 兜底默认值,要么客户端 fail-loud。
(注:本轮补传 head 后仍被拒,所以 F1 **不是**本次阻塞的充分原因,但它本身是个真坑。)

**F2 — 529 房的 QA 体拿不到 PR 身份,导致 land 权威 gate 在沙箱里打不开。**
可复现路径见 §5;判据是 `workflow_node_pr_binding` 行数与 qa session 的
`pr_number`/`pr_head_sha` 是否为空。生产 vs 沙箱的对照数据见 §5.3。

## 7. 诚实边界

- 本报告**只描述两个世界**:`[本分支 fbff3c157 在 529 隔离房实测]` 与 `[生产库只读取样]`。
  凡涉生产的陈述均为只读观测,未做任何生产侧变更。
- 第 5/8/9 步**未验证**,不是「验过没问题」。第 5 步的 FLY-1731 护栏(停驻体不得当 gate holder)
  因 gate 未开而**完全没测到**。
- 「QA 故意 FAIL」是脚本指定的判决内容 —— 判决本身走 QA 体自己的真凭据、真 CLI、真 Bridge 路径,
  只有「判 FAIL 还是 PASS」这个决定是演练脚本给的。
- 一条早先报错已作废:我曾报「codex TUI 观察窗被 hold 没建成」;那是 attempt 1 的瞬时 hold
  (`policy_server_generation_changed`),之后自愈,窗口真实存在且 pane 可 capture。

## 8. 装房踩到的两个新坑(路书素材)

1. **被测 worktree 从未装过依赖也没 build 过** → `test-deploy.sh` 预检直接挡。
   需先 `pnpm install --frozen-lockfile` + `pnpm -r build`(frozen 保证 lockfile 零改动)。
2. **路书漏了 `BRIDGE_DEPT_SCOPE_REJECT=off`**。部署默认给测试 Lead 的 `match.labels` 是
   `["*"]` 字面量,与 issue 的真实部门标签做**精确**比对永远不命中 →
   `POST /api/runs/start` 被 403 `DEPT_SCOPE_REJECT / issue_no_department_label` 挡死。
   (`test-teardown.sh` 第一次撞 cmux 租约 60s 超时,重试一次即过 —— 与既有记忆一致。)
