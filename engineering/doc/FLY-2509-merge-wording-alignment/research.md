# FLY-2509 合并措辞对齐 — 调研
Issue: FLY-2509 (https://linear.app/geoforge3d/issue/FLY-2509/2506b-同源措辞对齐role-文件仍写禁止-mergeblueprint-仍写before-any-merge-与-19bff5181)
日期: 2026-09-10
基于: exploration.md

生效源：.flywheel/agents/nodes/engineer.md、implement.md；同族 general.md、eng_design.md 亦需去掉无限定 merge 禁止，不增加其写权限。Blueprint 非 generalized 的 MERGE AUTHORITY、ship only path 与 generalized writer 提示须一致。合同源版本仍为 2。FLY-2506 milestone PR 字段仍是占位；本任务明确授权补绑定 #1152。不改其锁定计划与历史记录。

验证通过真实 Blueprint 生成提示、角色源和 provisionCodexHome 物化测试；用隔离 Git 冲突台架消费生成提示，技术 merge 不调用审批，ship 分支仍要求审批。台架不是生产 LLM 行为证明。全仓扫描含隐藏角色目录，历史引文和否定测试单列，不为零字面命中改历史。
