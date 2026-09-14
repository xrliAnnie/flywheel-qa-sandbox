# FLY-2541 B3 reader 接线 — 调研
Issue: FLY-2541 (https://linear.app/geoforge3d/issue/FLY-2541)
日期: 2026-09-14
基于: exploration.md

readLocalDeployedSha 接收路径，缺省使用 FLYWHEEL_DEPLOYED_SHA_FILE 或 ~/.flywheel/deployed-sha，严格验证 40 位小写 hex，失败返回 null。scheduler 已有可选 reader 和 beta_source_unavailable，禁止回退 HEAD。runtime 持有显式 env，应把该 env 的路径传给真实 helper，每次调用重新读文件。

首次激活检查置于 owner=bridge 后、assertDrained/bind 前；只影响尚未绑定的 local 策略。不阻断既有 active occurrence 恢复。到期仍重新读并做默认分支 compare，避免冻结旧文件值。

现有 runbook 在 engineering/doc/FLY-2393-project-beta-cadence/runbook.md。需明确旧 runtime 无 reader 不可接管、文件读取必须在实际 Bridge 用户/环境验证、无效时保持 paused。生产运维由授权流程执行。
