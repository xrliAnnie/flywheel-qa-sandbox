# FLY-2541 B3 reader 接线 — 实施计划
Issue: FLY-2541 (https://linear.app/geoforge3d/issue/FLY-2541)
日期: 2026-09-14
基于: research.md

## Locked scope

延续 FLY-2508 已批准设计，复用已合入 #1156 的 helper；不复制 helper，不改 B3 policy/updater/发布 workflow，不实现 reverse compare。

## Tasks

1. TDD runtime 装配：临时文件 + 实际 helper（GitHub transport 使用 fixture）；验证 env 路径、到期重新读取并冻结真实文件 SHA/source_origin，HEAD 不回退。缺失/非法文件不得 dispatch。
2. TDD 首次激活负向守卫：未注入/返回 null/非法 reader 在 local 策略下拒绝 bind，attention/beta_source_unavailable；恢复 reader 后经过既有冷却可激活；default policy 不受影响。在途恢复不重新取源。最小实现放 owner=bridge 后、首次 bind 前，保留到期检查。
3. runtime 注入 `localDeployedSha: () => readLocalDeployedSha(options.env.FLYWHEEL_DEPLOYED_SHA_FILE)`。runbook 要求部署含此装配及守卫的版本，在真实 Bridge 身份/env 下读取成功后才允许 owner 接管；失败保持 paused，记录原因。补第二轮真实 beta 的验收字段与 green/hold 要求。
4. 运行 focused tests、pnpm lint、pnpm -r build、pnpm test:packages:run 及任何新增 shell tests。记录全量失败，不将 focused green 冒充全量通过。通过注入 request-review 注册 code review，处理 blocking findings，最终 head CI 绿。
5. 更新实施/进度文档，milestone 为最后 commit，push/open PR，报告并 complete --route needs_review。真实 beta 由后续授权 QA/运维执行，handoff 必须列明未取得的真实证据，不宣称本 issue 全部验收已完成。

## Real-beta acceptance handoff

记录真实 beta version、receipt/run URL、occurrence.source_commit/source_origin、publishedSourceCommit、B3 subject.sourceCommit/evidence.localDeployedSha 及 commit 关系归因。要求 published/no_change 同 SHA，B3 verdict green 或 hold，不含 no_deployment_evidence/not_currently_deployed；beta_source_unavailable 消失。不得修改 soak policy 使验收通过。covered_by_newer 只表示安全结算，不是同源验收。
