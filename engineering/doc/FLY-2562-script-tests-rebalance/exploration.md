# FLY-2562 Script Tests 分片再平衡 — 探索
Issue: FLY-2562 (https://linear.app/geoforge3d/issue/FLY-2562/ci容量-script-tests-15-超预算1022s-1020s85percent-门限fly-2519-1029s-与-fly)
日期: 2026-09-14
基于: 无

## 范围
用户锁定搬迁 FLY-2331 与 FLY-1663 的完整 workflow steps，从 script-tests 到 script-tests-4；保持所有测试内容、timeout、tripwire、重试策略原样。同步 ci-structure 固定清单。

## 当前证据
基线 1e6a419cb。两步确实位于 job 1；job 4 有共同依赖安装、构建及 tmux/lsof/sqlite3/ripgrep setup。工作树没有先前 FLY-2562 方案或 ledger；TURN implement epoch=2 已取得，inbox 无指令。
任务给定 CI 34889528445 / 34906441662 的 job 1 为 1029s / 1022s。本机 start=1000, now=2022 的确定性重放输出 elapsed=1022s budget=1020s，触发容量失败。

## 选择
采用指定的两步整体搬迁，避免新增分片的启动成本与更广配置变动。仅移动 FLY-2331 会留下较小余量；搬迁两步预计 job 1 703–710s，job 4 853s。估计不替代 exact-head CI 实测。

## 复审核验与最终选择
GitHub jobs API run 34889528445：job4=608s，FLY-2331=174s、FLY-1663=152s，相加934s；job5=191s，相加517s。采用任务允许的现有分片再平衡，将完整两步改投 job5。job4/job5 非测试 setup/tripwire 对象完全相同；逐项核对浅克隆兼容性并以 exact-head job5 运行证明。job1/job4 的任务 <900s 验收保留，并增加接收方 job5 <900s。此前 job4 方案被本节及 plan.md 复审修订取代。
