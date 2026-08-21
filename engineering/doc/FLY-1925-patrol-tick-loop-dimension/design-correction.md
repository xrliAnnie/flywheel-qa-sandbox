# FLY-1925 patrol_tick 名册加「圈」维度 — 设计更正
Issue: FLY-1925 (https://linear.app/geoforge3d/issue/FLY-1925/巡检tick-patrol-tick-名册加圈维度每-run-附当前节点棒持有者开圈状态-让有人在等不存在的圈直接印成红灯founder)
日期: 2026-08-20
基于: qa-report.md

## 废弃的概念

废弃「只读账本即可判断 run / TURN 持有者是否仍在干活」的设计。`sessions.status`、`workflow_run_node.state`、TURN 行和 declared state 都只能说明账面状态，不能证明对应 pane 里的进程仍活着；账面 `running` 不得继续替死体占棒或活体空转挡掉红灯。巡检必须补真实 tmux pane / process liveness 探针，无法取得现场证据时诚实标为不可判。

## 保留的器官

保留已经实现的 tick issue 分组名册及「圈」列：current node / attempt、TURN holder / epoch、open rework / land / wake / gate / carrier，以及 `waiting-for-nonexistent-loop` 置顶红灯。新修复只把真实进程存活事实接进既有圈判定，并让 held run 也接受同一判定；不增加新告警通道、timer、flag 或自动救援写路径。

## Founder 原话

「我们做 1925 的目的，就是为了让 Leader 知道他不应该只看账本，他也需要真的去看现场。这个就是 1925 做的唯一目的。」

「QA 发现 failed 之后，implement 应该继续去修。」
