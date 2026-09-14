# FLY-2556 容量测量超时 — 探索
Issue: FLY-2556 (https://linear.app/geoforge3d/issue/FLY-2556/main-红热修-founder-budgettestts60measures-the-combined-child-cap-200)
日期: 2026-09-14
基于: 无

范围锁定：只修改 founder-budget.test.ts 第三条容量测量测试的 timeout；其它两条测试、所有断言、fixtures 和生产代码不变。

main f31b75af9 的 CI run 34876679969，teamlead 1/4 原跑和 rerun 均超时（任务提供）；已读取 rerun job 104091594957 日志，确认唯一失败是该测试 5000ms 超时，其余 233 文件 / 2525 测试通过。
