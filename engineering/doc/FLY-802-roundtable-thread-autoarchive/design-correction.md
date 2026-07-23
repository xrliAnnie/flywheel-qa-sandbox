# FLY-802 Roundtable thread 1h 自动归档 — 设计纠正

> **已由 FLY-1435 取代。** 本文保留为历史记录；Discord 现行 `auto_archive_duration` 语义、零 reconciler 方案与验收 ground truth 以 `../FLY-1435-native-autoarchive-rootcause/research.md` 和 `plan.md` 为准。

Issue: FLY-802 (https://linear.app/geoforge3d/issue/FLY-802/roundtable-topic-thread-1h-无活动自动归档-描述性命名-别一排排堆在侧栏)
日期: 2026-07-22
基于: plan.md

## Founder 原话

> 「802我们不需要巡检员」
>
> 「我希望尽量减少巡检员的设计 除了非常critical的 我们都不应该拿巡检员打补丁」

## 废除

- 废除每半小时周期扫描 active threads 的 `channel-default-thread-reconcile` 层。
- 废除 reconciler 的 scheduler wiring、关闭时 drain、运行时 feature flags、Discord PATCH 收敛和对应测试。
- 不用常驻 sweeper 收敛存量 thread；若确实需要处理存量，采用一次性手动操作，不在 Bridge 内增加巡检员。

## 保留

- 创建 roundtable topic thread 时读取 Discord 父频道的 `default_auto_archive_duration`，并把解析后的值写入 create body。
- 创建 alert thread 时同样读取其父频道设置；父频道没有配置或读取失败时保持既有 fallback。
- 空闲 thread 的归档完全交给 Discord 原生 auto-archive。Discord 负责在配置时长内无新消息后归档，消息仍保留并可搜索。
- roundtable thread 名继续来自 topic 内容，不回退到占位名 `Roundtable topic`。
- issue chat thread 的 3 天策略和完成归档行为保持不变。

## 增量实施边界

本纠正只撤掉 `plan.md` 的「交付物二：converge 半」及其所有运行时接线。`plan.md` 中 creation-time channel-default provider、roundtable/alert 创建路径、描述性命名、跨仓 plugin 创建路径及其测试继续有效。若 `plan.md` 与本文件冲突，以本文件为准。

## 验收修订

1. 全仓不存在 `channel-default-thread-reconcile` 实现、测试、scheduler wiring 或 `FLYWHEEL_THREAD_ARCHIVE_RECONCILE*` 配置。
2. roundtable 和 alert 新 thread 的 create body 使用父频道 auto-archive 设置；fallback 合同保持不变。
3. 描述性命名测试保持通过，issue chat thread 行为无变化。
4. 不要求代码自动处理存量 thread；Discord 原生 auto-archive 是唯一常驻 idle 归档机制。
