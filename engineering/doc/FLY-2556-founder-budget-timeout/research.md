# FLY-2556 容量测量超时 — 调研
Issue: FLY-2556 (https://linear.app/geoforge3d/issue/FLY-2556/main-红热修-founder-budgettestts60measures-the-combined-child-cap-200)
日期: 2026-09-14
基于: exploration.md

该测试从 60 children 开始逐步渲染探测 cap（最多 200），再对 200 attention 候选应用字节预算。rerun 日志已输出 cap=69、capBytes=521503、retainedAttention=0，随后报告超时。机制是测量集大小 × 共享 2 核 runner 的执行时间超过默认 5 秒；没有证据要求修改生产行为。

选择单测试显式 timeout 60_000，保留完整容量边界验证，避免缩小测量集改变覆盖。CI 失败日志：/tmp/FLY-2556-baseline-ci.log。

本地基线验证（2026-09-14）：pnpm install --frozen-lockfile exit 0；pnpm -r build exit 0。未修改测试的单文件运行 3/3 通过，目标测试 1922ms，文件测试总计 2113ms，命令 wall duration 3.50s。本地未复现默认 5 秒失败；red 证据来自上述真实 CI。日志分别为 /tmp/FLY-2556-install.log、/tmp/FLY-2556-build.log、/tmp/FLY-2556-baseline-local.log。
