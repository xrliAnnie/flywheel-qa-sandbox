# FLY-2140 Epic 页面内容模型与首版生成 — 实现说明
Issue: FLY-2140 (https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳)
日期: 2026-09-02
基于: plan.md、design-correction.md

## 500 子单读取的诚实边界

首版把活动父单子树的原始子单数量硬限为 500：Linear 每页读取 50 张，每个父节点默认最多 10 页；超过任一上限 fail-closed，不写入 `epic_page` 回执。这个计数发生在过滤 Backlog 之前，避免大量隐藏 Backlog 绕过资源边界。

StateStore 执行事实当前不是跨子单批量读取。路由对每张子单调用一次 `readEpicItemFacts`：固定读取 session、land、run 三组事实；若存在 active/held run，再读取 attempt 与 open gate/carrier authority，最多五组同步本地 SQLite 投影。因此 500 子单的最坏路径最多触发约 2,500 组 StateStore 投影调用。这一上限证明了工作量有界，不等于证明 500 子单时有可接受的延迟；本轮也没有用 500 张、且每张都有 active run 的真实账面数据做延迟 SLO 验证。

当前实测/估算边界按 Lead 裁定写清：今天常见的 5–30 张子单约为 7–40ms；当规模到约 200 张、账面累计约 2.4 万条 session 相关行时，同步 N 读会来到约 1.4s，已经会明显痛。这个数字是当前读取形状的性能警戒线，不是 SLO，也不能外推为 500 张仍可接受。后续异步/批量物化由 FLY-2143 承接。

本轮按 Lead 决策不把读取改成批量 SQL，也不改变 500 上限、按 project 串行化或其它机制。500 应视为正确性/资源保护上限，而不是性能承诺。若生产出现接近该规模的活动范围，应另开性能工作，把 session/run/land 等按 `(project_name, issue aliases)` 成批物化，并对 active run 的 attempt/authority 做有界批量读取后再设定延迟预算。

## Markdown 原始 HTML 的消费边界

HTML 视图对用户文本执行 HTML 转义，非 `https://linear.app/` URL 不会成为链接；Markdown 视图也会先转义 `&`、`<`、`>`，再处理 Markdown 控制字符，因此送入允许 raw HTML 的下游 renderer 时不会执行 Linear 标题或验收文本中的标签。两种视图均有恶意 title/acceptance 回归测试。

单格读取失败的正确性边界是显式可见：该格保持 `missing: statestore_error`，页面级 gaps 列出子单 id、格名与稳定 token。`ready.v1` 只依赖 Linear 的 state/priority/blocked_by，所以 StateStore 执行事实读取失败不会伪造或改变 ready 顺序；这个可见性保证不解决 N×读取的延迟问题。
