# FLY-2408 Ship gate 标题标记 — 探索
Issue: FLY-2408 (https://linear.app/geoforge3d/issue/FLY-2408/discordthread-标题-到-ship-gate-的单要有专属状态标记让-founder-一眼看出哪些在等她-founder)
日期: 2026-09-07
基于: 无

## 目标

Founder 在 Discord 手机侧栏扫过 issue thread 时，应能直接识别当前停在 `founder_gate`、等待她处理 ship 卡的单。Lead 已锁定行首单字符 `🔔`，不再比较其他视觉字符。

## 当前实现

- `issue-display-refresher.ts` 从 StateStore 的真实 session/park 状态重算标题、置顶 pipeline header 和状态行，并由 GatePoller 周期性 reconcile；重启后同一派生路径会再次收敛。
- 标题现有主状态标记包含 phase 标记（`🎨设计`、`🔨实现`、`🧪QA`）和聚合 stage 标记（founder 待批时为 `⏳待批`）；模型标记紧随其后。
- 当全部 phase 都处于 done-like 状态且某 phase 为 `awaiting_review` 时，`deriveIssueTitleBadge` 当前返回 `stage=approve`，标题变成 `⏳待批 …`。这个状态由 session 状态间接推断，没有读取 workflow run 的 `current_node_id`。
- `ChatThreadCreator` 当前只识别并替换一个开头状态 badge；如果简单把 `🔔` 与 `⏳待批` 拼成一个字符串，下一次返工重渲染会只剥掉 `⏳`，把手工 bell 留在 base。

## 约束与假设

1. `🔔` 的首要事实源是活动 workflow run 的 `current_node_id` 是否等于 immutable snapshot 声明的 approval gate；不写死节点名，也不从卡文案或 Discord 消息反推。
2. Ship-gate 标记是 attention overlay，不替换现有主状态/model 标记。目标形态为 `🔔 ⏳待批 [G] [FLY-2408] …`；这保留 gate 前已有的 `⏳待批` 语义，并让 `🔔` 单独表达“等 founder”。
3. Founder 批准后 workflow run 离开 `founder_gate`，标题去掉 `🔔` 并继续显示现有 ship/完成状态；打回 `design`、`implement`、`qa` 后同样去掉 `🔔`，恢复对应 phase 标记。
4. Discord 100 字符限制继续由 `composeThreadTitle` 在尾部截断；所有前缀和 issue key 保留在前方。
5. 只修改标题状态派生、前缀解析/合成以及覆盖这些行为的测试；不修改 gate、批准识别、workflow 路由或其他 display face。

## 实现方向

推荐把标题状态拆成两个正交维度：现有主 badge（phase/stage/blocked/completed）与可选 `founderGate` attention overlay。`issue-display-refresher` 对所有 workflow 类型读取活动 run，而不是只看 design/implement/QA phase；gate 节点真相与现有 `awaiting_review` 聚合共同收敛到同一个 `🔔 ⏳待批` 输出，消除状态写入先后顺序造成的额外 rename。`ChatThreadCreator` 稳定合成和剥离 `🔔 + 主 badge + model marker + base title`。

## 非目标

- 不改 `approve_to_ship` / founder verdict 处理。
- 不改 pipeline header 或 phase 状态行的视觉词汇。
- 不引入新的 Discord 消息、提醒或通知。
- 不重构标题 writer 的重试、coalescing 或归档行为。
