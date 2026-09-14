# FLY-2543 CI 清理竞态 — 实施计划
Issue: FLY-2543 (https://linear.app/geoforge3d/issue/FLY-2543/flake-ci-classifytestsh-收尾-rm-竞态git-directory-not-empty让-shell3-在-1440)
日期: 2026-09-14
基于: research.md

1. 先验证原脚本：自然 baseline；通过 PATH rm shim 确定性注入退出清理失败，记录 144/0 + exit 1 红证据。
2. 最小修改：init 后配置 gc.auto=0 与 maintenance.auto=false；EXIT trap 的 rm 失败仅打印 warning。保留退出状态、全部原断言。
3. 回归测试覆盖清理成功/失败、原成功/非零退出，以及夹具自动维护设置。优先外部执行实际脚本；不在生产增加注入开关。运行修后脚本连续 20 次，记录逐轮计数和退出码。
4. 运行 pnpm lint、pnpm -r build、pnpm test:packages:run 和新增 shell 测试；诚实记录任何失败并调查。
5. 台账和里程碑在最终代码提交同批推送，最后 commit 包含 milestones/FLY-2543.md；评审后不再推文档。发起注入 request-review 代码评审，修复阻塞项后新轮。创建 PR，精确头相关 shell3 分片连续两次绿色（第一次 CI 后 rerun 该 job；不改 workflow）。回执保存在外部证据和结构化 handoff，避免头移动。
6. 向 Lead 报告，用 complete --route needs_review --pr NUMBER 交接，再 park；不派 QA、不合并。

设计评审 1d93bc2d-380e-44ec-9d5a-5b84b4f598ec / request 2d0873f0-947a-4f7e-8b20-900ca2cf3194：effective APPROVED。
具体回归收敛到现有 ci-classify.test.sh，不新增 suite、不改 workflow：四种清理结果与退出码组合、两项真实本仓配置读取。另以外部 rm shim 执行完整脚本。
本地 20 次仅证明回归稳定性，不等于捕获真实后台 maintenance 竞态；现场进程时间线未采集。warning 打印自身失败也不覆盖原退出码。兄弟 suite 风险已报告 Lead，留待独立 follow-up。
