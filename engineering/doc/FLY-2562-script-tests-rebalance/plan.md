# FLY-2562 Script Tests 分片再平衡 — 实施计划
Issue: FLY-2562 (https://linear.app/geoforge3d/issue/FLY-2562/ci容量-script-tests-15-超预算1022s-1020s85percent-门限fly-2519-1029s-与-fly)
日期: 2026-09-14
基于: research.md

## 目标与锁定设计
把 FLY-2331 与 FLY-1663 完整步骤（连注释）移到 script-tests-5，在现有测试前顺序运行；同步 ci-structure 的两条固定清单，并刷新 job1/job5 容量注释。job 名称、依赖、所有 timeout、85% tripwire、测试内容、重试策略均不变。
预计 job 1 与 job 5 <=714s（保留 FLY-2245 的 70% sizing 目标）。任务的精确头 QA 要求仍为 job 1 和 job 4 各 <900s，并额外检查接收方 job 5 <900s；不改变其他 shard 或全局容量政策。

## 执行步骤
1. 注册设计审查并等有效 APPROVED。
2. 安装锁定依赖。先迁移 `expected_shard_tests` 中两条名称到 job 5 的列表开头，运行 `bash scripts/__tests__/ci-structure.test.sh`，应因 workflow 仍在旧分片而失败。
3. 原样移动 `.github/workflows/ci.yml` 的两段至 job 5 setup 后、FLY-2146 前。再次运行结构测试应通过；不新增测试套件，不修改搬迁套件。
4. YAML 比较基线与当前五个 jobs 的 Test/Integration test steps 完整对象多重集合；输出前后列表，并检查只有两个所有者从 job 1 改为 job 5。检查非测试配置及 timeout/tripwire 完全相等。
5. 运行 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`、结构测试和现有 tripwire 测试。保留所有失败；仅按注入 PACKAGE_GATE_RECEIPT 规则判断 RPC-only 失败，不把窄测绿算作 aggregate 绿。
6. 更新 progress，提交推送，注册 code review；有效 APPROVED 后保留 advisory 上报，修复 blocker 后新一轮审查。
7. 最后提交 `engineering/doc/milestones/FLY-2562.md`，开 non-draft PR。最终 head 跑全 CI，读取 Script Tests 1/5、4/5 与接收方 5/5 tripwire elapsed，均 <900s，写入验证/ship handoff report；若超标按证据继续处理。
8. 用注入 exec identity 上报证据，`complete --route needs_review --pr <number>`，park；不派 QA、不 merge、不 deploy。

## 验收证据
- 整体 step 多重集合、所有 suite 命令列表守恒。
- 测试内容无改动（仅 ci-structure 固定分片清单改动）。
- 所有 timeout/tripwire 原样；无 rerun。
- 本地必需 gates 与有效代码评审回执、non-draft PR、精确头全绿及三个 elapsed <900s。

## 设计复审修订（round 1）
Blocking finding `shard4-overshoots-capacity-budget` 已通过改投现有最低负载 shard 5 解决。独立 GitHub jobs API 验证 34889528445：job1=1034s、job4=608s、job5=191s；FLY-2331=174s、FLY-1663=152s。搬入 job4 预计 934s 不满足任务；搬入 job5 预计 517s，job1 预计 708s。第二个原始运行 34906441662 的 tripwire 为 job1=1022s、job4=527s。所有投影是估算，最终以 exact-head CI tripwire 为准。

用户明确允许“或按 ci.yml 现有分片机制重新均衡”，因此采用现有 job5，仍只搬迁指定两步，不引入新 shard。并保留用户 job1/job4 <900s 的 QA 条件。

附加验证：job4/job5 的非测试 setup/tripwire 完整对象相等，job1 相比目标仅 checkout full-history 不同。逐项审查两步及其调用方的 git 用法：FLY-2331 fixture stub git；FLY-1663 集合中工作树 git grep、rev-parse HEAD 可在浅克隆运行，不要求历史提交；在最终 GitHub 默认浅克隆 job5 执行全部迁移命令，作为运行证明。

刷新 job1 与 job5 的容量注释，引用本方案和经核验的估计；job4 分配不变。FLY-889 对 shard5 的冗余 guard 漏项是既存 LOW advisory；当前 ci-structure 已保护五个 shard，不改测试内容，不扩展此项。
