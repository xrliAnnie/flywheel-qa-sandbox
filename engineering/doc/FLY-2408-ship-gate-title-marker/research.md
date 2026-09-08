# FLY-2408 Ship gate 标题标记 — 调研
Issue: FLY-2408 (https://linear.app/geoforge3d/issue/FLY-2408/discordthread-标题-到-ship-gate-的单要有专属状态标记让-founder-一眼看出哪些在等她-founder)
日期: 2026-09-07
基于: exploration.md

## 结论

最小可靠实现是：把活动 workflow run 的 approval-gate 节点作为首要 gate 真相，同时保留现有 done-like + `awaiting_review` 聚合作为状态写入过渡期的同值信号；两者都只产出 `🔔 ⏳待批`。把 `🔔` 作为可选 attention overlay 合成在现有主状态/model 标记之前，并让同一个 title parser 在每次重渲染时同时剥掉旧 overlay 与旧主 badge。现有 unified issue-display refresh + sweep 已覆盖事件触发、重启和漏触发自愈，不需要新增 timer 或 gate 事件。

## 1. Ship gate 的权威事实

- `StateStore.getActiveWorkflowRunForIssue(issueId)` 返回最新 active run，包含 `current_node_id` 与不可变 `snapshot`。
- `workflowApprovalGate(snapshot.manifest).node` 已是 v1 terminal gate 与 v2/v3 approval gate 的统一解析入口；不能把标题规则写死在某个模板或从 `awaiting_review` 猜 gate。
- 现有 FLY-1424 ship-ready 设计和生产实现同样用 `run.status='active' ∧ current_node_id=workflowApprovalGate(...).node` 判定 run 到达 founder ship gate。标题应复用这个事实定义。
- `awaiting_review` 不是充分条件：implement phase 在交给 QA 时也可处于该状态。当前 `deriveIssueTitleBadge` 只有在全部已存在 phase done-like 时才把它聚合成 `stage=approve`，但仍是间接推断。

因此新增纯判断：active run snapshot 可解析且 `current_node_id` 等于该 snapshot 的 approval gate node 时，`founderGateActive=true`；缺 run、缺 snapshot、解析失败或已离开该节点都 fail-closed 为 false。该查询不能受 `getLatestPhaseSessionsForIssue` 限制，因为 `tpl_prd`、`tpl_design`、`tpl_prototype` 和 generic-menu 等 main-role workflow 同样会到 approval gate。

只用 node 真相仍会受多表提交顺序影响：批准时 workflow row 和 session status 不会原子更新。为避免 `🔔 … → ⏳待批 → 🚀ship` 这种第三次 rename，renderer 把 active gate 和现有 approval-wait 聚合映射到完全相同的标题；现有受限规则一旦把 base badge 派生为 ship 就优先移除 bell，kickback 则在 run 离开 gate且返工 session 恢复 active 后直接回对应 badge。

## 2. 标题语法与兼容性

当前标题语法是：

```text
<主 badge> <model marker> [ISSUE-ID] <title tail>
🧪QA [G] [FLY-2408] Discord thread title marker
```

Ship gate 期间目标语法是：

```text
<attention overlay> <主 badge> <model marker> [ISSUE-ID] <title tail>
🔔 ⏳待批 [G] [FLY-2408] Discord thread title marker
```

`ChatThreadCreator.writeTitleOnce` 当前调用 `splitStatusEmoji` 只剥一个开头 badge。`🔔` 目前不在受管集合；如果直接传 `🔔 ⏳待批` 而不扩展 parser，返工时整个 compound prefix 会留在 base，造成重复/残留。因此 parser 必须把受管的 `🔔` overlay 与紧随其后的既有 status/phase badge 一起剥离，再由现态完整重建。

模型标记逻辑保持不变：仍从无 badge 的 raw base 解析并在合成时放回 issue key 前。`composeThreadTitle` 继续按 100 UTF-16 code-unit 预算裁剪尾部；新增 `🔔 ` 只减少 title tail，不能裁掉 attention、phase、model 或 issue key。

## 3. 主状态标记保留与优先级

当前 gate 聚合已返回 `stage=approve`，显示 `⏳待批`。Lead 的约束是 `🔔` 不能挤掉现有阶段/模型标记，因此 bell 只叠加在这个既有 gate badge 前，目标固定为 `🔔 ⏳待批 [model] …`。这比改回“最后一个 phase”更小，也不会改变 founder 已熟悉的 `待批` 语义。

新增纯派生层的优先级是：

1. `🔴受阻` 最高：base badge 已是 blocked 时原样保留，不显示 bell。
2. `⚠️重连中` 次之：沿用 writer 前现有 reconnect ownership/defer guard，不用 gate state 覆盖不确定状态。
3. 当前 session 的持久状态明确为 `approved_to_ship` 时原样保留 base badge并移除 bell；只把它用作 gate overlay 的退出事实，不改变 base badge 的既有映射。短暂或过早的 `session_stage=ship` 标签不算批准事实，不能压掉 bell。
4. active run 正在其 snapshot approval gate：除以上三个具名例外外，覆盖所有 base badge，强制主 badge 为 `⏳待批` 并叠加 bell；因此 active phase、main stage、completed/history 都不会漏画。
5. run row 已先离开/完成，但 base badge 仍是现有 `stage=approve`（包括 phase aggregate 和 legacy single-session approval wait）：继续显示同一个 `🔔 ⏳待批`，直到批准或返工状态到位，不产生中间 rename。
6. 其余情况完全沿用现有 badge 派生；返工回 `🎨设计` / `🔨实现` / `🧪QA` 或 main stage。

规则是 deny-list：`🔔` 覆盖所有 base badge，只有 `🔴 blocked`、`⚠️ reconnect ownership`、持久 `approved_to_ship` 三个例外。前两个避免把“坏了”或“状态不确定”误报为“等你批准”；第三个保证 founder 已批准后退出。

## 4. Reconcile 与重启一致性

`IssueDisplayRefresher` 已具备：

- lifecycle 写入触发后的 per-issue coalesce refresh；
- GatePoller 周期 sweep；
- 写达成功才落 fingerprint；
- Discord title writer 的 no-op 幂等、429 coalesce/retry。

但当前 sessions fingerprint 不含 workflow run node。必须对所有 issue（不以 phase rows 为 guard）把 active run 的 `{run_id,current_node_id}` 加入 sessions-side fingerprint，并让 layer-1 sweep 使用同一函数。这样只发生 workflow node 变化、session 行未同步变化时，下一 reconcile 周期仍会检测 drift；Bridge 重启后已有 stale fingerprint 也会被同一路径纠正。

现有 `getActiveWorkflowRunForIssue` 会读取完整 snapshot。新增轻量 StateStore projection 虽可减少首次部署 sweep 成本，但会突破 Lead 锁定的 title-renderer 范围；本单复用现有只读接口，并把 fingerprint Pick 测试桩同步更新。部署后旧 fingerprint 一次性失效是预期 reconcile，不是持久性 churn。

## 5. 测试边界

需要在现有生产调用点覆盖：

1. 纯派生：active phase、main-role stage、completed/history 在 gate 都得到 `🔔 + approve`；blocked 与持久 `approved_to_ship` 是无 bell 例外；过早 `stage=ship` 仍有 bell；legacy single-session approve 也得到 bell。
2. Refresher：真实 in-memory workflow run 进入 approval gate后调用 title writer时传 `🔔 ⏳待批`；blocked/reconnecting 压过 bell；批准与三类 kickback 后不再传 `🔔`；非 phase workflow 同样覆盖。
3. Title writer：`🔔 ⏳待批 [G] …` 重渲染到返工 badge 不残留；重复 gate 渲染零 PATCH；100 字符上限且完整前缀保留。
4. Fingerprint：只改变 active run `current_node_id` 就能改变 fingerprint并在 sweep 中重新 enqueue，证明重启/漏触发自愈。
5. focused tests 使用 `pnpm --filter flywheel-teamlead exec vitest run <paths>`，并纳入 legacy `src/__tests__/stage-status-emoji.test.ts`；package full suite 的既有 skip 单独如实报告。

## 6. 范围外

- 不变更 approval gate materialization、`approve_to_ship` 问题、Founder reaction/text verdict 或 kickback route。
- 不新增 DB schema、timer、Discord 消息或 alert。
- 不改变 pipeline header 和状态行。
- 不改变 `⏳待批` 的语义；已有 single-session approval-wait 若走同一 renderer，也得到同一个 bell overlay，避免同义状态分叉。

## 7. 回滚边界

Parser 对 `🔔 + 主 badge` 的剥离支持至少保留一个发布周期。若必须回滚 renderer，先部署仍含 parser 的 cleanup/restamp 版本清掉已写入的 bell，再回退 parser；直接同时回退会让旧 `🔔` 残留在标题 base。
