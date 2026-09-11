# FLY-2506 合并权限范围 — 实施计划
Issue: FLY-2506 (https://linear.app/geoforge3d/issue/FLY-2506/病根-runner-合同before-any-merge-必须-verify-approval把冲突返工的)
日期: 2026-09-10
基于: research.md

## 锁定范围

1. 在现有 codex-home 物化测试增加一个回归用例：进入 main / ship 仍需 verify-approval 且 approved:true；origin/main 合入当前 feature 解冲突不需 ship approval；移除 before ANY merge 泛化；仍禁止自行合 PR。先运行确认 RED。
2. 仅修改合同 Merge authority 段：审批限定为合入 main 或任何 ship 动作；明示已授权 conflict rework 的 origin/main → 当前 feature 技术合并无需此审批，也无需因 review_question_unbound 向 Lead 请示。保留 TURN、任务范围及禁止自行 ship 的边界。运行测试确认 GREEN。
3. 执行 pnpm lint、pnpm -r build、pnpm test:packages:run，记录真实结果；无新增 shell 测试。此变更没有渲染、迁移、数据库或部署面。
4. 提交代码及验证记录，最后一个提交新增 engineering/doc/milestones/FLY-2506.md；开 PR，登记正式 code review，处理 blocking findings 后重新审查。使用 needs_review 路由交接并 park。

## 验收

- 物化后的合同明确区分同步 main 进 feature 与将 PR 合入 main。
- ship 校验命令、approved:true、消息不携带合并授权及禁止自行合 PR 均保留。
- 生产审批校验代码、已物化 AGENTS.md、CLAUDE.md 不变。
- 完整验证结果、正式审查结论和 PR 随交接提供。
