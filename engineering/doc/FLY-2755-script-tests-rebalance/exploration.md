# FLY-2755 Script Tests 六片再平衡 — 探索
Issue: FLY-2755 (https://linear.app/geoforge3d/issue/FLY-2755/main-红挡全部-pr-script-tests-35-分片耗时-1036s-超预算-1020sfly-1870-容量闸1260-合入后)
日期: 2026-09-18
基于: 无

## 现象与目标

`main` 头 `487799b801f3147748b1c6188cadd0c035226c1e` 的 CI run
`35419985906` 同时暴露两个独立问题：

1. Script Tests 3/5 所有功能断言通过，但 FLY-1870 tripwire 报
   `elapsed=1036s budget=1020s usage=86%`。近期另外四个完整 run 也显示
   2/5、3/5 常在 900–997s，现有五片没有 30% 增长余量。
2. Script Tests 1/5 的 FLY-1572 套件完成前没有业务断言失败，最终由
   `jq: parse error: Invalid numeric literal at line 12, column 10` 以 exit 5
   退出。相同套件在 PR #1260 exact head 三小时前通过，本地 frozen install
   + build 后也通过，说明需要先检查结构化 stdout 与诊断 stderr 的边界。

本任务必须保持 20 分钟 cap、85% tripwire、所有已登记 shell suite 的覆盖，
并让最终 exact-head CI 的每片 elapsed 不超过 840s（1200s cap 的 70%）。

## 假设与锁定边界

- 只移动完整 workflow named step；不删套件、不改其命令/断言/timeout。
- 不提高 cap 或 threshold，不给测试加 `continue-on-error`，不靠 rerun 掩盖失败。
- `script-tests` 继续保留 FLY-2007 所需的 full-history checkout；其他片保持
  默认 shallow checkout。
- `.github/ci-required-jobs.json`、`ci-ok.needs`、聚合 jq、结构守卫和 shell
  suite census 必须同时纳入第六片。
- mailbox 测试只修输出通道边界；不修改迁移语义或业务断言。
- 不请求 ship，不 merge，不 dispatch QA。

## 方案比较

### 方案 A：保留五片，仅重新搬运步骤

近期五轮逐 step 的 75 分位测试耗时总和约 3390s；再加五份公共 setup，
平均单片已接近 840s，且历史 2/5、3/5 多次超过 840s，无法保留明确的增长
余量，排除。

### 方案 B：新增第六片，按历史 step 计时做完整步骤 LPT 均衡（采用）

从 run `35404015407`、`35410420823`、`35412663528`、`35408506888` 和
`35419985906` 的 jobs API 读取 named-step 时间。以成功样本的 75 分位作为
权重，按 largest-processing-time-first 分到六片，六片测试权重均为约 565s；
近期公共开销为 131–150s/片，投影约 696–715s。最终是否满足 840s 只认
exact-head CI 的 tripwire 日志，不把投影当验收证据。

优点是改动只涉及 workflow 分配和相应静态合同；缺点是增加一份公共 setup，
且 70% 目标需要真机确认。

### 方案 C：先产出共享 build artifact，再让五片复用

可减少重复 setup，但会新增 job 间 artifact/依赖链、改变启动并行度和失败形状，
属于 CI 架构重设计，不适合这张恢复 main 的容量单，排除。

## Mailbox exit 5 的处理选择

1. 只把它标为 flake 并等待三次 CI：没有消除已知脆弱点，排除。
2. 修改迁移 CLI 不输出诊断：会改变生产 CLI 可观测性，层级错误，排除。
3. 测试分别捕获 stdout/stderr（采用）：CLI 成功 JSON 只从 stdout 交给
   `jq`；stderr 留作诊断。测试内注入一条成功 stderr fixture，先证明当前
   `2>&1` 会把合法 JSON 变红，再分流后转绿。

## 成功标准

- 六个 Script Tests job 全部保留原 tripwire 语义，并被 CI OK 硬聚合。
- 当前全部 Test/Integration named step 的完整对象多重集合守恒，且每项恰好
  登记在一片。
- mailbox harness 有红→绿证据，本地重复通过；最终 exact-head CI 不再 exit 5。
- exact-head CI 六片均绿且各自打印 usage ≤70%；记录每片 elapsed。
