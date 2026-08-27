# FLY-2094 取消 QA 循环上限 — 探索
Issue: FLY-2094 (https://linear.app/geoforge3d/issue/FLY-2094/founder-直令-取消-qa实现循环上限删-codesimple-code-模板的-maxiterationsonlimit菜单校验qa)
日期: 2026-08-27
基于: 无

## 问题

内建 `code` 与 `simple_code` 工作流把 QA→实现返工分别限制为 3 轮与 10 轮。达到上限后，引擎写入 `loop_limit_escalated` 并把 run 置为 `held`；FLY-1707 为显式有界 loop 提供了携带 `escalationAck` 的人工续跑出口。与 founder 决定冲突的是两个内建模板的默认 cap：QA 与实现需要按质量收敛，不应默认被一个预设轮数截停。

2026-08-09 的前令曾尝试把 3 改为 10，但相关 PR #796 未合入；FLY-1772 仅取消了 `founder_rework` 上限，FLY-1859/PR #886 又为 `simple_code` 写入 10 轮。因此本单不是调整数值，而是补完“取消额度”本身。

## 当前事实（截至 `dedf2aed5`）

| 层 | 当前行为 | 与目标的差距 |
| --- | --- | --- |
| `menus/shapes/code.yaml` | `qa_retry` 为 `maxIterations: 3` + `onLimit: escalate` | 新 run 第 4 次 QA FAIL 停机 |
| `menus/shapes/simple_code.yaml` | `qa_retry` 为 `maxIterations: 10` + `onLimit: escalate` | 新 run 第 11 次 QA FAIL 停机 |
| `workflow-menu.ts` | parser 要求非-founder loop 必须有上限；shape 校验再分别钉死 3/10 | 无法表达内建无上限 QA loop |
| `workflow-template.ts` | v1/v2 manifest parser 要求 `qa_fail` / `review_fail` 有界 | menu 编译出的无上限 QA manifest 会被拒 |
| `StateStore.commitWorkflowTransitionTx` | 无上限非-founder loop 返回 `loop_limit_missing`；有界超限写 `loop_limit_escalated` 并 held | 无上限 QA 无法继续转移 |
| `openOperatorRework` + `/api/runs/:runId/rework` | 解析并验证 `escalationAck`，把 `heldLoopLimit` 加入 held run 的可返工白名单 | 模板仍可声明 cap，因此这条通用恢复路必须保留 |

## Founder 目标翻译

1. 两个内建 shape 的 `qa_retry` 都省略 `maxIterations` 与 `onLimit`，编译后的新 manifest 也不含 `max_iterations` / `on_limit`。
2. menu/manifest 允许 loop limit 缺席（无上限）或声明为正整数 + `escalate`；不再把 QA 固定为 3/10。
3. QA FAIL 第 4、5 以及后续任意轮都正常产生下一次 implement attempt；`loop_iteration` 只携带 `iteration`，不携带 `maxIterations`。
4. 内建路径不再产生 `loop_limit_escalated`，run 不因 QA 轮数进入 held。
5. 保留 FLY-1707 的 `escalationAck` / `heldLoopLimit` 人工续跑合同，以及通用 `onLimit=escalate` 引擎路径。
6. 旧 frozen manifest 中已有的 3/10 仍按原 schema 解析；自定义或未来模板仍可显式声明不同的正整数上限。
7. 不另建提醒或告警层。

## 明确假设

- “存量 frozen manifest 解析零变化”指旧 snapshot/manifest 字节仍被 parser 接受，不把存量 run 原地改写成无上限。
- `max_iterations` + `on_limit` 仍是合法可选对，`commitWorkflowTransitionTx` 对显式有界 loop 仍可写通用 `loop_limit_escalated` 并 held。
- 2026-08-27 12:52 PT 的 founder scope 更新收回“删除 FLY-1707 出口”这一旧范围；`escalationAck`、`heldLoopLimit`、event kind、历史查询与计数投影全部保留。
- `code` / `simple_code` 的默认 YAML 必须无 cap，但 shape validator 不禁止未来由模板明确声明正整数 cap。

## 方案

采用一条纯删除/放宽路径：让 menu 与 manifest 的 loop limit 成为与 loop 类型无关的可选对；内建 `code`/`simple_code` YAML 默认省略 QA limit pair；shape invariant 只校验拓扑，不锁死 QA 上限数值；引擎只在显式有界时执行既有超限分支。operator rework 的有界-loop 恢复合同保持不变。

不采用以下做法：

- 把 3 改为 10 或其他更大数字：仍保留 founder 明确拒绝的额度概念。
- 第 N 轮提醒/告警：违反 2026-08-25“禁新增告警层”。
- 改写 frozen manifest：破坏在跑 run 的物化快照合同。
- 删除所有通用有界 loop 能力：超出两个内建 shape 的范围，也会破坏自定义/存量 manifest。
- 删除 FLY-1707 `escalationAck` / `heldLoopLimit`：会让仍被允许的显式有界模板失去既有恢复出口。

## 会过期的结论

| 结论 | as-of | 重核命令 |
| --- | --- | --- |
| 两个内建 shape 分别钉死 3/10 | `dedf2aed5` | `rg -n "maxIterations|onLimit" menus/shapes/{code,simple_code}.yaml` |
| menu/manifest parser 拒绝无上限 QA loop | `dedf2aed5` | `rg -n "required for.*loopWhen|required for.*qa_fail|loop_limit_missing" packages/teamlead/src/{workflow-menu.ts,workflow-template.ts,StateStore.ts}` |
| FLY-1707 出口由 `escalationAck` / `heldLoopLimit` 标识且本单保留 | `dedf2aed5` | `rg -n "escalationAck|heldLoopLimit|WorkflowLoopLimitEscalationAck" packages/teamlead/src` |
| 最新 founder scope 要求 cap 可声明、默认无 cap | `2026-08-27 12:52 PT` | `node "$FLYWHEEL_COMM_CLI" inbox --exec-id c57fb9f3-5d50-471a-8ccc-89ce5a7cbf1c` |
