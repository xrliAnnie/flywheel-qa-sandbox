# FLY-2506 合并权限范围 — 实施记录
Issue: FLY-2506 (https://linear.app/geoforge3d/issue/FLY-2506/病根-runner-合同before-any-merge-必须-verify-approval把冲突返工的)
日期: 2026-09-10
基于: plan.md

## 实现与评审

设计门 0b970cbc-fce6-4b60-b1b9-1ef32a7578f4，request 56d8b28c-a894-41da-830a-7625e113a467，effective verdict APPROVED。计划保持原字节。

合同源文件 Merge authority 段按合并方向界定：进入 main 或任何 ship 动作仍须 verify-approval 且 approved:true；origin/main 合入当前 feature 做同步或解冲突不需该 ship 审批。例外无需证明具体 rework episode，且不授权 ship、push main 或绕过 review / force-push guards。仍受 TURN 和任务范围约束。

真实 provisionCodexHome 生成的 AGENTS.md 回归测试先 RED（旧 before ANY merge 不满足方向断言），后 GREEN（codex-home 全文件 164 passed）。新测试同时保留 ship 命令与 approved:true、消息不携带 ship 授权、禁止自行合 PR 的断言。

## 设计审查非阻塞建议与边界

- Blueprint.ts 非 generalized 提示、engineer.md 与 implement.md 的同类措辞不在本次锁定修改范围；仍可能引起其他运行形态的保守停顿。已通过 report 3f3907da-f725-479d-81dd-0b76ea33e381 告知 Lead，由 Lead 决定后续追踪。本次不声称清除所有指令源的此类问题。
- 本次测试覆盖合同物化，不添加跨指令源统一扫描；完整新文字将由 code review 审核。
- 生效前提：正常部署窗口更新安装包，然后 provision 新 runner。已有 AGENTS.md 不自动变化。本次未部署、未重启、未修改任何运行中 runner 的家目录。
- QA/Lead 可在新 provision 的家目录检查 Merge authority 段包含新文字，并比对已部署 agents/codex-runner-contract.md；真实 conflict rework 不再因 review_question_unbound 停顿仍属运行验证，本地物化测试不冒充生产证明。

## 验证

- pnpm lint：修改后通过，有既有警告。
- pnpm -r build：修改后通过；首次因未装依赖失败，pnpm install --frozen-lockfile 后通过。
- pnpm test:packages:run：修改前启动的基线运行退出 1，claude-runner 50 files / 1256 passed / 2 skipped，但有 unhandled onTaskUpdate RPC timeout，不能记为全绿。修改后同一命令仍退出 1：TeamLead 969 files passed / 1 failed，13058 tests passed / 1 failed / 7 skipped，且有 onTaskUpdate RPC timeout。失败用例是 claude-profile-cli.integration.test.ts 的 public use notification。claude-runner 本轮 1257 passed / 2 skipped。单独重跑失败文件 11/11 passed，末尾 voice-codex 19 files / 122 tests passed；这些独立通过不改变全包命令失败结论。
- 无新增 scripts/__tests__/*.test.sh；无渲染面、数据库迁移或服务变更。

日志保存在本次主机 /tmp/FLY-2506-{red,green,lint,build,packages-baseline,packages,profile-focused,voice-codex}.log。执行结果已报告 Lead（d0b993ad-c1b2-4569-ac8f-36edcca3ca71），本次不修改无关测试基础设施。
