# FLY-1596 cmux 视图运维重建 Runbook
Issue: FLY-1596 (https://linear.app/geoforge3d/issue/FLY-1596/cmux承接1578-legacy-grouped-a1-迁移-运维重建-cmux-视图的合法通路现在缺口)
日期: 2026-08-04
基于: engineering/doc/FLY-1596-cmux-a1-ops-rebuild/plan.md

## 先回答 Annie 的问题

FLY-1482 和 FLY-1605 都修好了各自负责的层，并不是修复无效：

- FLY-1482 修的是显示层 mutator 的单写者 authority、lease 丢失后的 fail-close，以及 QA handoff；
- FLY-1605 修的是 workspace/tab title 与既有 cmux/tmux topology 的对账收敛；
- 过去没有一张单把最终结果定义成「打开侧栏，永远是全的、对的」，也没有 watcher 在线时可合法执行的全链重建入口。cmux generation 更换、外来 legacy grouped 行与 ledger authority 在两层接缝处相遇时，只能拒绝自动处置，运维又拿不到锁，于是留下这次缺口。

FLY-1596 补的是这条接缝：同一 writer authority 下的 audited handover、逐 title 重建事务，以及统一的只读终态判官。最终验收不再看某个 repair 函数是否返回成功，只看侧栏是否全且对。

## 铁律

从本单部署起，修复侧栏时禁止手敲 `tmux new-session`、`cmux new-workspace`、`cmux close-workspace`，也禁止为抢锁而 `launchctl bootout` watcher。pin 不提供存活或 ownership 语义，也不得作为保护方案。

合法入口只有：

```bash
~/.flywheel/bin/flywheel-cmux-sync --rebuild-views ...
~/.flywheel/bin/flywheel-cmux-sync --verify-sidebar ...
```

## 1. 先做只读判定

不带 `--target` 时，判官覆盖 canonical Lead roster 与当前全部 managed live/dead window subject：

```bash
~/.flywheel/bin/flywheel-cmux-sync --verify-sidebar
```

机器消费用：

```bash
~/.flywheel/bin/flywheel-cmux-sync --verify-sidebar --json
```

退出码：

- `0`: 所有目标满足终态；
- `1`: 证据完整，至少一个目标明确不满足终态；
- `2`: inventory、generation、roster、ledger、surface 或 restored state 不可判定；不得继续变异。

终态同时要求：活窗口有且只有一行、死窗口无行、A1 单窗 topology、pane PID/存活/render 正确、至少一个真实 client、当前 generation 恰一条 committed receipt、无任何当前或历史 restored marker。

## 2. 只读生成重建计划

全部 Lead：

```bash
~/.flywheel/bin/flywheel-cmux-sync \
  --rebuild-views --all-leads
```

精确目标；有歧义时把 title 与当下 exact ref 绑定：

```bash
~/.flywheel/bin/flywheel-cmux-sync \
  --rebuild-views \
  --target FLY-1596-implement \
  --target flywheel-flywheel-cos-lead=workspace:60
```

dry-run 只做两阶段校验，不拿 mutator lease、不发布 claim、不创建报告、不做 tmux/cmux 变异。任何未知 title、重复 target、冲突参数、畸形 ref 或不可达 exact ref 都在变异前退出。

## 3. 让 watcher 合法让位并执行

先通知正在看侧栏的人：逐 title 事务期间对应行可能短暂消失并重建。然后执行：

```bash
~/.flywheel/bin/flywheel-cmux-sync \
  --rebuild-views --all-leads --execute --handover
```

或只处理判官列出的目标：

```bash
~/.flywheel/bin/flywheel-cmux-sync \
  --rebuild-views \
  --target FLY-1596-implement=workspace:123 \
  --execute --handover
```

`--handover` 发布 owner-bound `ops_rebuild` claim。watcher 自己释放 lease；命令最多等待 90 秒，拿到 lease 后重新计算全部 preflight。等待期间任何 topology/ref/source 漂移都会使本次在第一项变异前失败。QA teardown 与 ops claim 互斥，后到者退出。

每个 title 都执行：迁移前 judge → exact guard 下收编/拆解 → A1 重建 → workspace/tab 命名 → committed receipt → client/render readback → 同一 judge 迁移后复核。一个 title 失败即停，后续 title 不动。

## 4. 审计与复核

每次执行报告写到：

```text
~/.flywheel/state/cmux-rebuild-reports/<UTC>-<nonce>.txt
```

报告包含 immutable preflight、逐 title 前置 judge 摘要、动作与最终结果。执行完成后再次运行全量判官：

```bash
~/.flywheel/bin/flywheel-cmux-sync --verify-sidebar
```

只有全量 exit `0` 才算运维完成。mismatch 告警必须因为现实已收敛而消失；不得靠删日志、整类静音或手改 episode state 宣告成功。

## 5. 失败处理与回滚

- exit `2`: 保留现场与报告，不重试变异；先修 inventory/roster/generation 可判定性。
- exit `1`: 查看报告中第一个 FAILED title；修复其具名 guard 原因后，对同一 target 重新 dry-run，再显式执行。
- handover 超时会撤销自己的 claim；不得 bootout watcher 抢锁。
- 只有确认 claim owner 已死亡且正常两次观察回收没有生效时，才可在 Lead 监督下删除残留 claim。
- 要关闭日志限频，设置 `FLYWHEEL_CMUX_LOG_REPEAT_SECONDS=0`；这会恢复逐条输出，不会静音任何类别。
- 要停止新的 restored adoption，设置 `FLYWHEEL_CMUX_RESTORED_ADOPTION=0`；已有 marker 必须由恢复状态机 drain，禁止手删。

## 6. 发布后的真实 QA

本 runbook 的生产操作只能在代码部署后由 QA 节点执行。验收必须使用真实 watcher、真实 cmux 侧栏和真实 `read-screen`，禁止 stub：

1. 用合法 handover 路径迁移现存 legacy grouped 行；
2. cmux app 重启一次；
3. fleet/tmux 全量重启一次；
4. 两次都要求五分钟内 `--verify-sidebar` 全绿；
5. 注入一个受控 grouped 违规，确认首条 mismatch 仍立即出现，恢复后 episode 自动 re-arm。
