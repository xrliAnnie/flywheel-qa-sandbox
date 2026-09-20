# FLY-2753 本机定向测试守则 — 探索
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: 无

## 问题与目标

本机全量包测试重复远端 CI，多个 runner 并发放大等待。目标是本机保留全仓 lint、受影响包 build/typecheck、所属包与直接消费者的定向测试和新增 shell 测试；完整测试证据由最终提交的 exact-head CI 提供。当前节点仅交付设计。

## R1 后的基线纠正

唯一可写仓库为 `xrliAnnie/flywheel-qa-sandbox`，起点 `1855f7a1a`。这里的真实规则载体是：

| 任务中的职责 | 本仓载体 | 当前缺陷 |
| --- | --- | --- |
| 实现/工程师 | `.flywheel/agents/engineering/engineer-executor.md` | 第 5 步明确要求全仓构建与全量包测试 |
| 独立 QA | `.flywheel/agents/engineering/qa-executor.md` | 第 3 步引用全量包测试 |
| 实现 fallback | `.flywheel/agents/general-executor.md` | 路由到 engineer 时复述 full-repo build/tests |

`.flywheel/config.yaml` 实际登记这些路径。本仓没有独立 implement node。设计修改这三份真实规则的验证部分，不创建虚假的现代 nodes，不迁移角色身份或 registry。General 只移除与本目标冲突的验证摘要，保留其他职责。

本仓也没有同步器与 prebuild check。为满足同步要求，新增一个仅覆盖本机验证段的 canonical 文本和真实投影检查器，接入 teamlead prebuild；不搬入现代 DAG phase-protocol 系统。现代参考工作树 `3d67d8350` 已含另一分支的 FLY-2753 实现，此次不写它、不继承其证据、不为它重做实施计划。

原基线问题 `7f5f22f8-74f5-4e9a-ad6f-2fb736347237` 及具体适配建议 `34f519e9-2a68-4542-a60c-e74cca1e4489` 已交 Lead，尚无回复。遵循非阻塞问题规则，以真实当前仓库和 R1 核验为依据继续最小适配设计；若 Lead 改变范围，当前 TURN holder 追加纠正。R2 将审核这个可执行映射。

## 方案选择

- 推荐：三份真实守则的同一验证段，单一文本来源、三个投影和一个检查器。新增工作仅用于用户要求的投影一致与 prebuild 检查。
- 拒绝：继续保留本机全量但串行；仍然重复 CI，违背吞吐目标。
- 拒绝：把现代 nodes/phase-protocol/runtime 整套移植进 sandbox；涉及大量无关合同。
- 拒绝：只编辑三份文字且宣称缺失的同步器已绿；无法长期防止规则分叉。

## 边界

不改 CI 执行内容、package 测试脚本、部署/审批/权限、角色 ID、registry、运行时或数据库。只替换验证段、description 的 full-repo 措辞，新增同步所必需的脚本、文本、prebuild 与定向测试。任何 CI 红 job 都要处理，QA 不修产品代码。不得用祖先绿、轻量绿或本机绿替代最终提交完整 CI。
