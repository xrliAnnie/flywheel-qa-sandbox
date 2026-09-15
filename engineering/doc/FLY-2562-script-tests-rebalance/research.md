# FLY-2562 Script Tests 分片再平衡 — 调研
Issue: FLY-2562 (https://linear.app/geoforge3d/issue/FLY-2562/ci容量-script-tests-15-超预算1022s-1020s85percent-门限fly-2519-1029s-与-fly)
日期: 2026-09-14
基于: exploration.md

## 实现定位
- `.github/workflows/ci.yml`：FLY-2331 含 4 分钟 step timeout；FLY-1663 含 18 条 shell/node 命令。保留整个 step 与注释。
- `scripts/__tests__/ci-structure.test.sh`：`expected_shard_tests` 固定每个 shard 的 step 名称与顺序；只迁移两条清单项。
- `scripts/ci-job-elapsed-tripwire.sh`：20m × 85%=1020s，elapsed >= budget 时失败。保持文件原样。

## 验证边界
结构测试覆盖每个 shard 的 setup、测试顺序、timeout、tripwire。额外用 YAML 解析比较前后每个完整测试 step 的多重集合，证明没有丢失、重复或更改命令/env/timeout。job 1 保留 FLY-2007 所需 full history；迁移目标已有 build 与工具安装。
真实耗时须读取最终 PR head 的 Actions tripwire 日志/summary。两步名称、命令和 timeout 原样保留使前后测量可对照。

## 复审核验与最终选择
GitHub jobs API run 34889528445：job4=608s，FLY-2331=174s、FLY-1663=152s，相加934s；job5=191s，相加517s。采用任务允许的现有分片再平衡，将完整两步改投 job5。job4/job5 非测试 setup/tripwire 对象完全相同；逐项核对浅克隆兼容性并以 exact-head job5 运行证明。job1/job4 的任务 <900s 验收保留，并增加接收方 job5 <900s。此前 job4 方案被本节及 plan.md 复审修订取代。
