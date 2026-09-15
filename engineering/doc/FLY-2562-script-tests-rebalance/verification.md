# FLY-2562 分片再平衡 — 实施验证
Issue: FLY-2562 (https://linear.app/geoforge3d/issue/FLY-2562/ci容量-script-tests-15-超预算1022s-1020s85percent-门限fly-2519-1029s-与-fly)
日期: 2026-09-14
基于: plan.md

## 实现与不变量
完整搬迁 FLY-2331 / FLY-1663 从 job1 到既有 job5，同步固定 inventory 和两个容量注释。设计复审确认 job4 历史投影 934s 超过 900s，因此采用任务允许的现有分片再平衡方案，job5 历史投影 517s。

- 97 个完整 Test/Integration test 步骤对象的多重集合守恒。
- 分片数量：24/34/35/2/2 → 22/34/35/2/4，仅指定两步从 1 到 5。
- 排除这些已证明守恒的步骤后，整个 workflow 对象相同；所有 timeout、tripwire、依赖、setup 与配置保持原值。
- 未修改套件内容、测试断言或 rerun 策略。完整前后清单及比较回执位于 evidence/。

## 验证
- 固定清单先改：结构测试退出 1，报 job1 inventory/order drift；完整步骤搬迁后退出 0。
- 锁定依赖安装、全仓 build、最终 lint 均退出 0；lint 有 18 个既有 warnings。后续仅修改流程与文档，包源码和依赖保持相同。
- 现有 tripwire 测试 36/36 通过；start=1000、now=2022 仍因 1022s > 1020s 触发失败。
- PR：[#1201](https://github.com/xrliAnnie/flywheel/pull/1201)，非 draft。
- 已记录实现头 b625e941fd9c7b5cb8f06549ac2eabc763351bfa 的 CI [34916835167](https://github.com/xrliAnnie/flywheel/actions/runs/34916835167)：15/15 全绿。Script Tests 1/4/5 的 tripwire elapsed 分别为 **640/601/499s**，均 <900s；budget=1020s、cap=1200s。
- 该头有效代码复审 APPROVED，request 31ecc44d-d708-4eef-a8aa-a557f6263436。文档收尾后的最终头仍须在交接前取得精确头 CI 和有效复审；最终收据见 PR 检查与交接报告。

## 完整包级恢复证据
原始 `pnpm test:packages:run` 完成了 17 个包，但原始聚合结果为 failed。三个包出现失败，原始回执原样保留，不将原运行改写为 green。

- claude-runner 完整单进程恢复：50 文件，1340 passed，0 failed，2 skipped，0 errors。
- comm 完整单进程恢复：190 文件，2551 passed，0 failed，3 skipped，0 errors。
- TeamLead 两次完整运行均覆盖相同的 1116 个 project/file 键及相同测试数量。原运行仅归档文件失败；恢复运行仅 reply-guard 文件失败。归档文件在完整恢复中 4/4 通过；reply-guard 在原完整运行中 32/32 通过，原样单文件恢复也 32/32 通过。
- 逐文件选择通过结果覆盖全部 1116 文件、14405 测试（14398 passed、7 skipped），选中结果零断言失败；两个原生回执的 onTaskUpdate 错误和失败内容均保留。逐文件回执明确标记为派生证据，未冒充原生全包通过。
- gate 9ded8c3a-e84d-420b-8b47-efe9135f3e93 确认逐文件合并是允许的完成证据，不要求再次全包运行。
- `evidence/package-gate/package-gate-assembled.json` 覆盖全部 **17/17** 包，complete=true；14 个原始绿色包、两个完整包恢复、一个完整逐文件恢复。所有包源码及依赖在这些运行与收尾提交间未变。
- 原始/恢复回执、完整逐文件映射、源日志 SHA-256 和门槛答复均在同一 evidence/package-gate/ 目录；公开回执副本见 [PR evidence](https://github.com/xrliAnnie/flywheel/pull/1201#issuecomment-5673319703)。

## 非阻塞建议交接
job5 显示名称、既有 FLY-889 冗余 guard 漏项，以及 job2/job3 余量和 PR #1200 的相邻改动协调留给后续；本任务不扩大测试或产品范围。未合并、部署或派发 QA。
