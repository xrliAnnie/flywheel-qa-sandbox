# FLY-2727 Epic 运行真相 — 生产证据
Issue: FLY-2727 (https://linear.app/geoforge3d/issue/FLY-2727/epic-页可信-在跑不许照抄-linear-started按机器会话真相判活linear-状态单独显示-discord-链接改)
日期: 2026-09-18
基于: plan.md

## 采集边界

受管快照在实现构建完成后的唯一重试返回
`{"ok":false,"reason":"snapshot_owner_unavailable","retryable":true}`。没有继续重试，
也没有复制 live DB。以下生产事实来自此前的只读采集；最终头重放同时带入
StateStore 对 held run 必然投影出的 `run_held` 信号。页面片段由最终头代码在
`2026-09-18T05:00:00Z` 用这组固定事实重新生成。freshness cutoff 使用项目既有
`stuckThresholdMinutes=15`，没有再次读取或复制 live DB。

## FLY-2598 只读账本事实

```text
session_machine_running  run_status  current_node_id  attempt_state  execution_id                          current_node_machine_live
-----------------------  ----------  ---------------  -------------  ------------------------------------  -------------------------
0                        held        land             pending        cfd72ba5-4882-4282-b416-1afbe5447acc  0
```

最新可归因会话是 QA 的 `8575b98f`，状态 `completed`；当前 `land` 节点的 pending
execution 在 `sessions` 中没有会话行，所以不能冒充 live。

同一个 held run 由 StateStore 投影出 `run_held` 显式卡住信号；最终头因此把它判为
「停着·卡住」，而不是旧证据中的「停着·等验收」。这不改变 live 三数对账。

三数对账：

```text
页面 root_counts.live       = 0
session machine_running     = 0
current-node machine_live   = 0
```

重新生成页面的计数行：

```text
0 在跑 · 1 停着 · 0 说不准 · 0 未开始 · 共 1
```

## FLY-2598 卡片 HTML 片段

```html
<div class="kid" data-item="FLY-2598" data-class="stopped_stuck"><div class="kid-h"><span class="s s-stopped_stuck">停着·卡住</span><span class="s st-linear">In Progress</span><span class="kid-id mono"><a href="https://linear.app/geoforge3d/issue/FLY-2598">FLY-2598</a></span><span class="kid-t">Runtime recovery: provider-specific configs + correct context windows</span></div><div class="kid-a">↳ 流程被 held·请看 land 重试耗尽·卡住 · <span class="jump-off">这张单还没有 thread</span></div></div>
```

片段中没有“在跑”或“心跳”，把 Linear 的 `In Progress` 独立保留在 `st-linear`，
并给出真正驱动分类的 held / land 重试耗尽原因。
