# FLY-2509 合并措辞对齐 — 实施计划
Issue: FLY-2509 (https://linear.app/geoforge3d/issue/FLY-2509/2506b-同源措辞对齐role-文件仍写禁止-mergeblueprint-仍写before-any-merge-与-19bff5181)
日期: 2026-09-10
基于: research.md

1. TDD：增加跨角色/Blueprint 生成提示回归，先证旧提示失败；覆盖无审批 checkpoint、启用审批 checkpoint、generalized implement writer 与 no-write 权限边界。角色/合同测试保留 ship 审批、approved:true、禁止自行合 PR、TURN、review/force-push 约束。
2. 最小措辞修改：ship 或进入 main 必须 verify-approval；origin/main → 当前 feature 同步/冲突返工不需要该审批，不因 review_question_unbound 停机/问 Lead。修正 engineer、implement、general、eng_design 同族无限定文字，不新增角色写权限。Blueprint legacy 与 generalized writer 保持一致：仅表示不矛盾；generalized 保持无 MERGE AUTHORITY/verify-approval 命令，只对有 shared_branch_writer 权限者说明技术同步不需 ship 审批，no-write 约束保持。合同版本升至 3（FLY-2509），同时修改 packages/flywheel-comm/src/commands/gate.ts 同步回复 caution 及 src/__tests__/gate.test.ts 断言，将其限定为 ship/main；不改审批逻辑。
3. 隔离台架制造真实 Git 冲突，消费真实生成提示核验技术 merge 无审批调用且可解冲突完成；ship 方向保留拒绝/审批守卫。明确这是确定性台架而非真实 LLM/生产证明。全仓含隐藏文件扫描，逐项分类剩余历史引文、否定测试及有明确目标的禁止语句。
4. 补 FLY-2506 milestone PR #1152（本任务明确授权的单字段修正）。运行 pnpm lint、pnpm -r build、pnpm test:packages:run 和所有新增 shell 测试，诚实记录结果，无关失败不扩范围。
5. 提交实现与验证记录，维护 progress；创建 PR 并在最后提交写 FLY-2509 milestone 的实际 PR number；登记 code review，修 blocking finding 后重新请求。保持计划字节不变，经 needs_review 路由完成实现交接并 park，不自行 QA/ship/deploy。

## 审查修订说明

R1 HIGH gate-note-still-unqualified：已将 gate.ts 运行时注入句和对应测试明确列入步骤 2，不把它归类为历史引文或限定禁止。

- 预计需更新的现有断言：Blueprint.fly208-report-back 的 ship authority 语义、Blueprint.fly191-approve-gate 的 only path into main、Blueprint.fly1188-codex-prompt 当前 snapshot/fixture；codex-home 原有技术 merge 许可与 ship 守卫断言保留并加版本检查。不把这些预期变化当作无关失败。
- FLY-2506 milestone 的 PR 字段更新直接来自本任务“milestone PR number 绑定”，是相对 README 单写者规则的一次明确授权例外，不形成通用先例。仅修 PR 字段，Status 历史字段留给所属 issue 的后续串行状态更新。
- 生效需正常部署并新建 workflow snapshot / provision runner；运行中 pinned role 或 AGENTS.md 不会自动刷新，本任务不修改生产或现有家目录。
- 全仓测试命令来自本次注入角色硬门；基线已执行并记录失败。tmux-viewer.macos 是有真实 Terminal.app 副作用的既有测试，后续验证先核其环境禁用机制，仍执行同一完整包命令并披露该测试跳过，不将聚焦测试替代全包结果。
