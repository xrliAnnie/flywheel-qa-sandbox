# FLY-2753 本机定向测试守则 — 设计纠正
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: plan.md

R1 gate `cbd3b8fe-bf78-410b-9c57-db00f5b43221` 有效 verdict 为 CHANGES_REQUESTED。已核对两项 HIGH：原计划指向现代参考工作树存在、但当前分支不存在的文件；参考工作树已实现大部分条款，不能作为当前分支交付计划。

修订：直接更新本仓真实 engineer-executor / qa-executor / general-executor 验证条款。共同来源、限定三目标同步脚本、teamlead prebuild 与一个真实 Vitest 合同测试均明确为本单新增，不伪称已有基础设施。CI 证据按 sandbox 现存 CI workflow 的实际 job 与最终 head 验证。取消现代 prompt fixture 重锚和无依据 onTaskUpdate 禁令；新增子句精确断言、连续角色失败动作断言。

原 HTML reportId `c447441e0bd7ac6926b61b1480a743e3` 展示旧方案，后续新发布将替代它。历史验证记录保留以免把旧版本验证当成新版本证据。

适配建议 question `34f519e9-2a68-4542-a60c-e74cca1e4489` 尚待 Lead 答复；按非阻塞问答规则继续明确当前仓库映射的设计评审。任何后续 Lead 指令须按 TURN 追加修订并报告完整 instruction id。
