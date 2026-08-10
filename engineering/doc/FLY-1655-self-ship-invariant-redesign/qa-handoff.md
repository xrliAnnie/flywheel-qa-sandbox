# FLY-1655 self-ship 按终节点不变量重设计 — QA 交接

Issue: FLY-1655 (https://linear.app/geoforge3d/issue/FLY-1655/founder-直令唯一单-self-ship-修了又坏-n-真根因每次修复只覆盖上一次事故的状态签名要按不变量重设计)
日期: 2026-08-10
基于: plan.md

## 1. 当前结论

实现已从“修 runner-ship 账本”改为一个通用拓扑不变量：有 PR 的 DAG 由 approval gate 进入唯一 engine-owned terminal `land` 节点；QA、implement、generic 等上游节点只产出 PR/evidence，不 merge、不 land。节点 id、角色名与是否含 QA 都不是运行时判据。

slot2 的真实 FLY-202 v2 run 已保留 founder 真卡批准、terminal land merge/cleanup/archive 与完成后 5 分钟零重派证据，详见 §7；本 PR 自身仍未 merge 或部署到生产，不能把 QA slot 的闭环冒充线上部署。原始验收里的“runner 自 merge”已被 founder 2026-08-09 纠偏取代：最终 merge/cleanup/archive 必须由 terminal land 节点完成。

根因裁定不变：FLY-1648 与成功对照的唯一真差异是 gate 物化时实际运行的生产 build；FLY-1650 的 500 是旧 runner-carrier 推断抛出 `incoherent_ship_bundle`，事务回滚令 run 保持 active，随后触发补派。terminal land 让新图在进入该推断前直接得到 `mode=land`。

## 2. FLY-1625 四候选终局

| # | 终局 | 代码与验收证据 |
|---|---|---|
| ① holder/head 不取 QA cwd | **已落地** | land gate 使用上游 completion 提交的 head，并要求匹配该 run 的 current `workflow_node_pr_binding`；claim-backed 图继续使用服务端 decision claim。缺失或错 head 返回 `land_head_unavailable` 且零 mutation。 |
| ② carrier binding 周期重试/对账 | **判死** | 新 bundled/menu 图没有 runner ship carrier；gate 创建事务沿用既有 land 路径一次性写 target binding，不需要事后重试。本单删除 read/boot reconciliation 与 sweep；legacy 只保留精确缺失原因。 |
| ③ 带审计操作员杠杆 | **已落地** | `/gate-carrier-rebind`、`/loop-reentry`、`/re-qa`、run `rework/terminate` 已存在并保留给 legacy/重验；本单删除 snapshot-specific `gate-reissue` saga，不把操作员修复当新图正常路径。 |
| ④ 同 session 凭据重铸 | **判死** | `qa_verdict` submission credential 与派生 claim 使用 permanent 语义；consumed、attempt/head binding 与 terminal/dead/rework revocation仍 fail-close，因此不再需要“过期后重铸”入口。 |

没有候选或 follow-up 第三态。

## 3. 阳性对照

| 不变量 | 摘掉修复时的红 | 当前绿证据 |
|---|---|---|
| terminal land | bundled/menu 回到 gate-terminal，authority 解析为 runner ship | `workflow-menu.test.ts`、`workflow-templates.test.ts`、`workflow-run-snapshot.test.ts` 证明任意 id 的 approval gate 后接 engine land，上游 ship bits 均关闭 |
| 非 QA predecessor | 恢复旧 `source.type === "qa"` 条件会让 generic/product 图无法开 gate | `StateStore.land-lifecycle.test.ts` 与 source-projector 真 PR binding 流覆盖 claimless generic、claim-backed code、missing/mismatch typed refusal |
| founder gate | 删除单一 relay guard 后 Lead response 会消费 approve gate | `handle-receipt.test.ts` 覆盖 guard；不再有 consumed-gate 猜测、换卡或跨库 saga |
| 永久 QA 钥匙 | 恢复墙钟校验后 >2h verdict 返回 `credential_expired` | `StateStore.workflow-admission.test.ts` 覆盖 permanent 接受、一次性消费、五态撤销；`qa-result.test.ts` 证明 marker 保存 verdict 且不落 credential |
| deploy identity | stale/divergent/unknown built artifact仍能推进 receipt | build identity vitest 与 shell 10/10 覆盖 equal/descendant 放行及其余 fail-close |
| legacy 诊断 | 缺 target binding 只返回无上下文 409 | `workflow-decision-routes.test.ts` 覆盖 `required/authorityMode/reason`，且不补行、不 sweep |

## 4. 真产物证据

- 直接以 read-only 模式打开生产 `/Users/xiaorongli/.flywheel/teamlead.db`（1.5GB），用本分支 built `dist` 解析真实行：FLY-1648 `tpl_code@3` 与 FLY-1650 `tpl_generic_menu@3` 均保持可解析，均明确得到 legacy `runner_ship`；没有改写生产库或 frozen snapshot。
- 同一 built artifact 的真实 menu library 把 `tpl_code/tpl_prd/tpl_design/tpl_prototype/tpl_generic_menu` 全部编译成 `approval_gate -> engine land`；bundled `tpl_product_v1/tpl_product_designer/tpl_product_prototype/tpl_generic` 同样为 terminal land。
- 这证明兼容边界与新产物同时成立；它不等于已部署，线上仍须走 §6。

## 5. 自动化证据

- `pnpm lint`：通过，0 error；13 条仓库既有 warning。
- `pnpm -r build`：22 个 workspace project 全部通过。
- controlled TeamLead 全套：8,942 passed / 5 skipped；本单路径全绿。原并发跑的 terminal archive 与 inbox 两项单独复跑 41/41 通过；删除已经随旧 QA-marker reconciler 一起废止的悬空 heartbeat 测试后，相关四文件 70/70 通过。剩余 5 个失败来自本分支未修改的 Claude profile 固定超时及 launchd host-state harness，均不授权修改无关代码。
- shell：deploy build identity 10/10、QA ship-report 26/26、restart admission pause 13/13；此前完整 restart harness 127/127。
- canonical package sweep 的 Core 非 GUI、edge-worker、voice-bridge 与其余 package 结果保留在历史 QA 报告；不把 headless Terminal.app、固定 shell timeout 或 launchd host-state 失败伪报成绿色。

## 6. 合并后真机验收（必须回填）

1. 部署本 PR，记录 `/health` 的 `buildMode/buildSha/artifactBuildSha`；只有 built artifact 覆盖 intended commit 才推进 deployed receipt。
2. 各跑一条真实 claim-backed `code` 与 claimless `generic` v2 DAG 到 approval gate；founder 在对应 ship 卡片上批准，保存 card/question/holder/PR-binding 与批准投影证据。
3. 断言批准后 `current_node_id` 是 manifest 声明的 terminal land node；上游 runner 不执行 `verify-approval` 或 merge。可用 `verify-approval approved:true` 作为只读诊断，但 merge 权威必须由 land executor内部校验。
4. 由 land 节点完成 sanctioned merge、cleanup、archive，run 进入 completed；保存 merge SHA、land receipts 与终态。
5. 关闭全部 runner，连续观察 5 分钟 execution inventory，必须零补派。
6. 让真实 QA 超过 2 小时后提交 verdict，确认 claim/transition 成功且 marker 无 credential 泄漏。

任一项缺证，本单只能保持“代码待 review / 真机 QA pending”，不能宣称 self-ship 已在线闭环。

## 7. preserved 真库 closeout 修后回填

2026-08-10 在 slot2 保留同一份 FLY-202 真库、同一条已 merge 的 v2 `execute -> founder_gate -> land` run 做双向对照；没有运行 deploy/teardown，没有改库或手工释放 lease。

- 修前 build `dbb6e57c`：failed 历史 attempt 被 FLY-116 正确保留，但 `closeRunner` 同时返回 `commDbFinalized=false`；closeout 连续得到 `outcome=blocked`，`land_operation` 停在 `running / notification:finalization_partial / issue_closeout_incomplete`。
- 修后 build `615cac39`：只在旧 owner lease 自然到期后接管。`buildSha` 与 `artifactBuildSha` 均为完整 SHA `615cac395c54d23d5cd1e2b5a7912fd30d5f5f36`。
- 第一条修后 closeout 判决是 `session_events.id=2956 @ 2026-08-10 10:03:54Z`：`closeout_report` payload 为 `outcome=complete, nodes=2, operatorItems=[]`；没有新的 `closeout_issue_items_blocked`。
- `land_operation` generation 从 1074 变为 1075，由新 owner 接管并进入 `completed / finalization_completed`；历史 `last_error=issue_closeout_incomplete` 字符串仍留在 completed 行中，作为旧审计残留记录，不当作新失败。
- failed execution `56b08386-...` 的 StateStore 行仍是 `status=failed`，原始 branch-delete 错误原文仍在；两个 execution 的 CommDB session 行均为零。即物理取证保留，只有通信账结清。
- 真 worktree 与本地 branch 均不存在；`chat_thread_archived` 返回 HTTP 200；`post_ship_finalization_completed`、`land_completed`、`run_completed` 均已落账，run 与 terminal `land` node 都是 completed/done。
- 从 `run_completed @ 10:03:58Z` 守到 `10:09:12Z`：历史 `sessions` 始终为 2 行，workflow seq 450 之后 `node_dispatched=0`，满足五分钟零重派。

对应自动化阳性对照同样覆盖真实故障形状：移除修复时 `dead_pin` 与 `gone` 两例精确翻红而 `alive` 仍 blocked；恢复后 focused lifecycle suite 39/39，通过且 `alive` 从不调用 CommDB finalizer。Round 10 在精确实现 head `615cac39` APPROVED；GitHub 8 组 CI（含 shell suites）全部通过。
