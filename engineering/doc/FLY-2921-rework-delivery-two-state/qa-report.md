# FLY-2921 返工投递收成两态 — QA 报告
Issue: FLY-2921 (https://linear.app/geoforge3d/issue/FLY-2921/病根修复-6-返工投递收成两态送达-失败交还-lead投给死体改投替身不再把整条-run-打-held6-张-46)
日期: 2026-09-26
基于: implementation.md

## 结论状态

**候选结论：等待 529 双 Lead 实机证据与最终 exact-head CI，尚未提交 PASS。**

代码、迁移、六张历史事故的本地独立验证均已通过。此文件在 529 前冻结进候选
HEAD；529 的 room-info、buildSha、Discord thread、driver receipt、strength-two receipt、
最终 exact-head CI 与正式 verdict 写入发布给 founder 的 ship report，而不在实机运行后
改动本候选 HEAD。

## 用户流程判断

实际用户是处理返工的 Runner 与接管失败投递的 Lead。正确流程是：返工 wake 成功就继续；
投不到或换体耗尽就把同一个请求交还 Lead，并保持 run active、目标节点保留。任何投递失败
都不应再把整条 run 置 held。对跨 Runner/Lead 的投递与替身路径，单元测试不足以形成 PASS，
因此本轮把双 Lead 529 generalized E2E 作为硬门。

## 六张事故验收

| 原事故 | 本轮构造 | 结果 |
|---|---|---|
| FLY-2330 | 终态/死体收件人、替身无内容、卡住的 rework TURN wake、legacy staged cancel | 交给 coordinator 或返回 Lead；无 run hold；暂存取消收敛为 applied/failed |
| FLY-2821 | 同 run 第二轮返工、legacy `woken` resident hold | 第一轮完成后 re-park，第二轮正常投递；仅 closed 才视为过期 |
| FLY-2185 | 死目标、死替身、回滚替身、generic dead scan、已 admitted 替身 | 每版最多一个 actor；前三次换体，第四次返回 Lead；generic scan 不另造 writer |
| FLY-2473 | 投递失败耗尽；Lead resume 后同 wake 连续 push 失败；re-arm/grant 崩溃窗 | `returned_to_lead`，run 仍 active；同 wake 可幂等 re-arm，busy 不误计失败 |
| FLY-2092 | 耗尽后的 target/credential 清理 | target node 保留；resume 重新投递并走正确 credential rotation |
| FLY-2202 / FLY-2472 | 零提交、仅 progress.md 提交、真实产品提交 | 前两种分别拒绝为 `rework_head_unchanged` / `rework_no_product_change`；真实产品变化可交卷 |

## 两态、删除分支与兼容

`workflow_rework_delivery` 现存状态只有 `pending`、`turn_granted`、
`wake_delivered`、`completed`、`returned_to_lead`。删除的返工投递中间态为：

- `awaiting_receipt`：迁移为 `turn_granted`，并把已发送事实落在 `wake_sent_at`；
- `replacement_pending`：迁移为 `pending`，原因保存在 `last_error`；
- `needs_lead`、`held`：迁移为 `returned_to_lead`。

实现同时删除 held pane-loss recovery、`markReplacementPending`、
`settleHeldReworkRecoveryFailure`、`validateNeedsLeadReworkQuiescenceTx`、
`resident_hold_already_woken` 与 rework undeliverable-hold 分支。旧 hold shape 仍可解码，
但前置条件读取 `returned_to_lead`。迁移不会自动解冻旧 held run：active run 的 returned 行获得
delivery-scope door，旧 held run 保留原 run-level door，由原门、FLY-2922 或 terminate 处理。
回滚脚本 `scripts/fly-2921-rollback.sql` 保留反向兼容。

字面值 discovery 中，旧状态的生产命中只保留在迁移、回滚、历史兼容读口，或独立的
ship-carrier/DOA 状态机；历史文档与夹具不作为新 rework delivery writer。相关保留测试全部纳入
changed-file related 或下列显式文件验证。

## 独立测试证据

### FLY-2921 显式文件（一文件一命令）

- teamlead：440/440（FLY-2921 行为 416；兼容消费者 24）
  - `fly2921-undeliverable-rework-owned` 5/5
  - `fly2921-resident-rewake` 5/5
  - `fly2921-rework-completion-head` 13/13
  - `fly2921-delivery-operations` 7/7
  - `fly2921-rework-wake-no-freeze` 2/2
  - `workflow-rework-coordinator` 104/104
  - `StateStore.workflow-rework` 109/109
  - `workflow-engine-dispatcher` 146/146
  - `workflow-rework.e2e` 9/9
  - `fly2921-event-route-rework-evidence` 10/10
  - `fly2921-resident-wake-fence` 6/6
- 兼容消费者：`workflow-engine-dispatcher.fly2531-legacy-staged-cancel` 17/17、
  `fly2567-compatibility-matrix` 2/2、`StateStore.fly2567-contract` 5/5
- flywheel-comm：167/167
  - acceptance：`complete` 78/78、delivery reroute 8/8、turn-wake rearm 9/9
  - related-run failure isolation：runner-stop race 5/5、qa-result lock 5/5、CLI 62/62
- scripts：205 个测试/断言全部通过：retention consumer gate 10/10、
  `qa-generalized-e2e-lib` 55/55、`qa-fly-2456-rework-adopt` 51/51、
  `fly1674-residue.test.sh` 89 assertions PASS；实际 retention gate 对当前配置返回 `ok:true`。

### Changed-TypeScript related

- teamlead related：663 files；656 files / 9658 tests passed，7 files / 27 tests failed，5 skipped，
  另有一次 worker RPC timeout。该本机相关图扩张到 9690 tests、运行约 99 分钟；失败集中于
  5 秒超时和本 sandbox 的 `spawnSync ps EPERM`。逐文件隔离复验中，
  `StateStore.workflow-ship-ready` 10/10、`flag-routes` 36/36、`fly2478-resident-release` 31/31、
  `codex-quota-route` 5/5、`epic-residual-plugin-wiring` 3/3、
  `StateStore.fly2341-terminal-archive` 27/27 均 green（合计 112/112）。
  `lead-activity-service.real-tmux` 仍在调用 `ps` 时被 sandbox 以 `EPERM` 拒绝，测试体未执行；
  这是环境边界，未作为产品通过证据。相同 head 的远端完整 CI 全绿。
- flywheel-comm related：81 files，1245/1245 passed。
- config related：18 files，329/329 passed。

### 静态门、构建与类型

- `pnpm lint`：exit 0；25 warnings，均为未改动的仓库现存告警。
- `pnpm --filter "flywheel-teamlead..." build`：13 个相关包 exit 0。
- dependent typecheck：`pnpm --filter "...flywheel-comm" --filter "...flywheel-config" typecheck`
  全部 green。
- 本报告提交前再次执行 `git diff --check`。

## 评审与 CI

- R8 对合并 main、解决唯一夹具冲突后的产品 head 做了完整 cross-family re-review，结论
  APPROVED，0 findings。
- PR #1364 的 exact product-head `e9a72127f146ecde109fb002091b9df844f050e1` full CI run
  `36287077917` 为 `full_green`，所有 quick gate、teamlead/unit/script/payload jobs 成功：
  https://github.com/xrliAnnie/flywheel/actions/runs/36287077917
- 本 QA 报告会形成新的 docs-only PR head。正式 PASS 前必须在该不变 head 上再运行
  `ci-full ensure` 并取得 exit 0；上述 CI 只作报告提交前的产品证据，不替代最终硬门。

## 529 硬门与诚实边界

本改动触及 Runner↔Lead、替身与跨 actor 协调，因此属于 Discord-capable；不能以“无 UI”豁免。
529 必须满足：单 Bridge、两位真实 Lead、候选 buildSha 与本 HEAD 一致、generalized driver exit 0、
真实 Discord thread 可访问、run 保持 active、相关 rework request 已完成且无
`returned_to_lead`/poisoned row，也没有 rework hold 冻结 run。room 由 Lead 部署和拆除，QA 不自行
部署/拆房。完成 driver 后、room 尚存时，先发布可访问的 QA report，再立即写 strength-two receipt。

当前未测边界：FLY-2919 尚未合入，因此“受信进程证据证明死体后立即换体”的第三种 proof 仍关闭；
terminal label 或 pane 消失不会被误当成死亡。未推送 wake 最终约 15 分钟返回 Lead，已推送未签收
约 2 小时返回 Lead，`wake_delivered` 后只告警。这是计划内 fail-closed，不是本轮缺失实现。
