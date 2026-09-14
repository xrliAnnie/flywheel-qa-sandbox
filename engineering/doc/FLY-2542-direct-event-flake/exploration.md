# FLY-2542 DirectEventSink 时序隔离 — 探索
Issue: FLY-2542 (https://linear.app/geoforge3d/issue/FLY-2542/flake-directeventsinktestts1605-在-ci-teamlead-shard-3-间歇红9-14)
日期: 2026-09-14
基于: 无

范围：只改 DirectEventSink 测试、夹具与清理，不改生产 src，不减断言、不 skip。当前分支初始 HEAD 14866f7e5；TURN implement epoch 1。无已有 FLY-2542 文档。

目标：复现 post-upsert tail throw 用例间歇失去 updateIssue mock；本地 20 次绿，精确头相关 CI 分片连续两次绿；审查前完成台账和里程碑。
