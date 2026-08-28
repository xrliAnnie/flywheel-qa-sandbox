# FLY-2111 重构 pane-SHA 接力证据 — 调研
Issue: FLY-2111 (https://linear.app/geoforge3d/issue/FLY-2111/返工2080-runner-patrol-rules-的-pane-sha-段落触发-fable-5-safeguardreasoning)
日期: 2026-08-27
基于: exploration.md

## 1. 旧操作形状的完整边界

`rg` 与 FLY-2080 引入提交 `a8cf9e3bf` 的 diff 显示，风险形状集中在三个相互引用的位置：

1. 步骤 A 把 `workflow_run_event seq/kind` 与 `pane full-scrollback state hash` 并列为成功证据。
2. 附录 A 在事务前执行 `capture-pane -p -S -` 并保存 `BEFORE_PANE_SHA`，事务后生成 `AFTER_PANE_SHA`，以两者不等作为 `AFTER_EVENTS` 为空时的成功条件。
3. 附录 B 复用“DB path、backup、event baseline 和 pane hash 步骤”，末尾再次允许“新 event 或 pane hash 变化”。

这三处共同构成一个完整操作合同，必须一起重构。仅改变量名、仅删除一条命令或仅改步骤 A 会留下同一执行形状。STEP 2 的整机巡检仍需要抓取 canonical pane 来识别 session limit、卡住与交互菜单；它不是本单的“修复前后指纹比较”链，且 FLY-1855 的检测面验收明确依赖它，因此不在本单删除范围。

## 2. `workflow_run_event` 是否足以作为推进证据

`packages/teamlead/src/StateStore.ts` 的权威实现给出：

- 表上有 `UNIQUE (run_id, seq)` 与全局唯一 `event_uid`；
- `appendWorkflowRunEventTx()` 在同一 run 内取 `COALESCE(MAX(seq), 0) + 1` 后插入；
- `listWorkflowRunEvents()` 按 `seq` 排序返回；
- receipt 正常路径写 `rework_delivery_wake_delivered`；replacement 正常路径写 `execution_dead_rolled_back`、`rework_replacement_materialized` 及后续 resume/dispatch 事件；workflow transition 还写 `edge_traversed`、`loop_iteration` 等。

因此“baseline 后出现由引擎写入的新 `seq:kind`”直接证明引擎消费了修复后的状态，比完整 pane 文本变化更接近要验证的属性。反假绿条件应排除 `event_uid LIKE 'patrol:%'`，因为所有 patrol-authored event 都只证明修复 transaction commit；现状只排 `patrol:FLY-2080:%`，本单在把 event 升为唯一接力成功门时一并收紧。

## 3. event-first 完成门

新的**事务后接力**合同应把 StateStore 事件变成唯一的 `fixed|advanced` 成功证据；这不替代事务前防伪条件：

1. 修复前保存 `BASELINE_SEQ`，不创建 pane 输出指纹；但 receipt 配方仍必须用 pane/commit/TURN 另行证明 `preferred_actor_execution_id` 已完成该 rework，否则属于伪造 receipt 并停手。pane 如需参与此真实性证明，也只能有界读取并只记非敏感 marker。
2. 修复后等待至少一个 reconcile tick，再查询同 run 中 `seq > BASELINE_SEQ` 且排除 `patrol:%` 的 event。
3. `AFTER_EVENTS` 非空才允许以本段证据写 `advanced|fixed`；静态 DB 状态与 SQL changes 仍需先通过，但不能替代 engine event。
4. 一个 tick 后没有新 event 时，不把它归为“成功”或“修复失败”。Lead 可做一次有界 pane 诊断，记录当前生命周期标记，并把 finding 留在 `escalated-with-plan`/继续观察的可执行计划中。

这个门比 FLY-2080 原形状更严格：删掉了“任何 pane 文本变化都可过门”的弱替代项，同时保留了对 Bridge 真推进的行为要求。

## 4. pane 诊断的安全形状

`pane_current_command` 不能承担进度判断：项目既有 FLY-758 调研已实测 scaffold 与 Runner 在多个时点都显示相同命令，会误判。可用的最小 fallback 是：

- pane 有两个严格分开的用途：事务前可参与证明 actor 已完成 rework 的真实性 precondition；事务后只在 `AFTER_EVENTS` 为空时诊断为什么尚未推进。两者都先校验 exact canonical `TARGET_PANE`，再用 `TMUX= tmux capture-pane -p -S -40 -t "$TARGET_PANE" | tail -40` 把实际读取上限收紧到最终 40 行；
- 不读取完整 history，不保存原文，不计算内容摘要，不和修复前输出做比较；
- 报告只写 Lead 从片段中识别出的非敏感生命周期标记与观察时间，例如 `pane_marker=<stage-or-wait-state>`，原始输出若可能含 secret 不落盘；
- pane marker 只指导 `inspect|repair|retry` 的下一动作，不能单独把 result 提升为 `fixed|advanced`。

这满足“确需 pane 证据时仍可行动”，但彻底去掉“完整抓取另一个 agent 输出 → 建指纹 → 前后比较”的操作形状。

## 5. 测试策略

现有 `fly369-patrol-rule.test.ts` 已钉住 FLY-2080 的修复事务、event 排除条件与接力语义，但只用 `/pane|workflow_run_event/` 做了宽松检查，无法阻止 pane-SHA 段落回流。新增内容契约应：

- 在整个 `## 0.` 拒绝 `BEFORE_PANE_SHA`、`AFTER_PANE_SHA`、`full-scrollback state hash`、`pane hash`，只在 FLY-2080 appendix 拒绝无限历史 `capture-pane -p -S -`；
- 要求 `BASELINE_SEQ`、`AFTER_EVENTS`、`seq > BASELINE_SEQ` 与 `event_uid NOT LIKE 'patrol:%'` 继续存在；
- 要求 event 非空是成功条件，且明确 pane marker 不能单独证明 `fixed|advanced`；
- 要求 bounded pane read 是 `-S -40 | tail -40`、不落原文、不哈希、不前后比较；
- 要求事务前仍保留“`preferred_actor_execution_id` 已完成这次 rework / 否则伪造 receipt”的真实性合同；
- 既有 FLY-1855 STEP 2 full-scrollback 测试继续通过，证明没有误删整机检测面。

基线首次因 `node_modules missing` 无法启动；随后已运行 `pnpm install --frozen-lockfile` 恢复既有依赖，lockfile 无修改，现有 22 条定向测试通过。实现阶段继续完成 RED/GREEN 证据。

## 6. QA 返工：原假设被否定后的重新定位

首次 PR head `a79e9322f` 接受独立 QA 后，真实
`claude -p --model claude-fable-5` 单变量台架否定了本调研第 1 节的因果假设：事故包
与 pane-SHA 重构候选都为 100% 命中，而从候选删除附录 A/B 后仍然命中。二分实验把
必要且充分的触发面收敛到步骤 A 的两行“打开抛出错误的源码并逐条抄下每个
`WHERE` / `if` 守卫”：

- 候选包保留该两行时 14/14 命中；仅删该两行时 0/11；
- 在已证干净的 pre-FLY-2080 包只加回该两行时 5/5 命中；
- QA 报告与全部原始结果保存在 `~/.flywheel/qa/FLY-2111/`。

因此返工不撤销 event-first 收紧，而是把实际触发项整段换成 Bridge 已提供的结构化
诊断：稳定错误码、run/request/execution id、state/revision、可复跑的只读 query 与
`workflow_run_event seq/kind`。source symbol/path 只作为 owner 入口，不再摘录或枚举
实现条件；证据不足时明确写 `UNAVAILABLE`、owner 和下一动作，仍不允许凭错误文案
猜账。

同一生产 bundle 原件、同一消息、同一模型、同一时间窗下交替复测：只重写触发条目
时，旧候选包 8/8 命中，新包 0/8，且两包的内容差仅为该完整条目；随后一并清掉
两个与 event-only 合同矛盾的旧 `pane/event` 报告模板，最终包再次得到旧候选 5/5、
最终包 0/5。两轮共 26 次均为 valid run，证据保存在
`~/.flywheel/qa/FLY-2111-rework/`。这证明部署前台架已恢复分离，不替代生产长驻
会话的 100-message 验收。

Lead 要求的 add-back 充分性反证也独立通过：从干净的 pre-FLY-2080 包出发，只加入
新 Step A 条目时 0/5 命中；同一位置加入旧触发两行时 5/5 命中，10 次均为 valid
run。两包内容差只有 bundle sentinel 与该条目的旧/新写法，原始结果在同目录的
`clean-addback-trial/`。

## 7. 部署后行为验收

静态内容契约只能证明风险操作形状已被移除，不能证明黑盒 safeguard 不再触发。PR 合并并由常规 updater 部署后必须保留原判定线：

1. Founder 将 Tadashi 切回 Fable 5。
2. 观察至少 100 条 mailbox 消息，`reasoning_extraction` 拦截为 0 才通过。
3. 同期确认 CoS(Fable) 仍为 0，作为阴性对照。
4. 只要出现一次同类拦截，本次改写仍判失败，回到提示词包重新定位；不以样本量或概率解释掉失败。

本 implement node 只交付可部署 PR 与该验收合同，不擅自换生产模型、部署或重启 Lead。

## 会过期的结论

| 结论 | as-of | 失效条件 | 重核命令/证据 |
|---|---|---|---|
| `workflow_run_event` 以 run 内 `MAX(seq)+1` 追加并受唯一约束 | 2026-08-27 `HEAD` | StateStore schema/append 方法变化 | `rg -n "UNIQUE \(run_id, seq\)|MAX\(seq\).*\+ 1|appendWorkflowRunEventTx" packages/teamlead/src/StateStore.ts` 后重读实现 |
| Fable 台架的必要且充分触发面是旧步骤 A 第 1 项 | 2026-08-27，QA 143 次 + 返工 16 次 valid run | Fable 分类器或 rules bundle 漂移 | 重跑 `~/.flywheel/qa/FLY-2111/` 的旧候选/去两行对照，并与 `~/.flywheel/qa/FLY-2111-rework/pack-M-rework.md` 交替比较 |
| 触发条目最小返工包为 0/8、旧候选为 8/8；最终包为 0/5、旧候选为 5/5 | 2026-08-27 20:24–20:32 PDT | 模型/包/消息或分类器变化 | 检查两目录的原始 jsonl 后重新生成当前 rules bundle 并交替运行 |
| 干净 pre-FLY-2080 包只加新条目为 0/5；同位置加旧条目为 5/5 | 2026-08-27 20:34–20:36 PDT | 模型/包/消息或分类器变化 | 对照 `pack-P-pre2080plus-new-stepA.md`、`pack-L-pre2080plus142_143.md` 与 `clean-addback-trial/` |
| post-deploy 100-message 验收未完成 | 2026-08-27 pre-PR | 部署并完成观测 | Founder/Lead 留存的模型配置、mailbox 计数和 safeguard 错误日志 |
