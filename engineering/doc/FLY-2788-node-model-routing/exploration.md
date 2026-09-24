# FLY-2788 节点模型分流 — 探索
Issue: FLY-2788 (https://linear.app/geoforge3d/issue/FLY-2788/2787-a分流引擎-每个节点按定稿选模型设计三组-astraopus-55fable-51-各-13实现-opus-55qa-gpt-6)
日期: 2026-09-22
基于: 无

## 目标与授权边界
本单只做工程设计，交可实施计划、有效 APPROVED 评审与已发布的 founder HTML。实现和 QA 由后续节点执行；不改生产 models.json / 模板，不重启，不请求 ship，不派 successor。
来源：用户注入 Epic FLY-2787 验收 1–4；FLY-2779 PR #1289（head 0ffd1d659，merged beeaa7410）research §6 与最新 founder 定稿。产品研究里的运营归因/额度看板不是本单任务。

| 节点/形状 | 自动选择目标 | 稳定性 |
|---|---|---|
| code.eng_design | Astra / Opus 5.5 / Fable 5.1 各 1/3 | 单+节点决定；不读 QA 抽签 |
| code/simple_code.implement | Opus 5.5 75% / GPT-6 Sol 25% | 单+节点独立分组；权威全灭可显式降级 |
| code/simple_code.qa | GPT-6 Sol 75% / Opus 5.5 25% | 单+节点决定；不读设计抽签 |
| prd.pm / product_design_flow.product_design / prototype.proto / generic.general | Opus 5.5 | 固定默认 |
| Raya / Tadashi / Sonnet Lead | 不变 | 无 Lead 配置写入 |

## 最少改动的选择
沿用现有 modelSplit 入口，新增一种按节点加权的规则，保留旧奇偶/百分比规则的读取与历史重放。不引入实验平台、随机数服务、自动优化器、额外依赖。
用标准库 SHA-256 对稳定单身份和节点名分别计算；设计权重 1:1:1，实现 Opus/Sol 权重 3:1，QA Sol/Opus 权重 3:1，避免 33.33% 凑不齐 100。所有自动选中模型仍须在对应节点候选内；缺项明确失败。
复用现有 run snapshot、assignment receipt、workflow_execution_runtime.model，逐层核对实际模型；不能把配置值当运行证据。

## 已纠正的前提
1. phases.qa 是当前解析器不消费的遗留键，不是当前 DAG 的有效覆盖层。需要验证的是模板晚绑定不会盖掉自动选择；生产遗留清理由 Lead runbook 完成。
2. FLY-2769 最新 founder-review.html 已收窄到人工换模型、持续到撤销、家族名；旧 product-definition 的自动过期方案不再是本单依据。
3. 实现 Opus + QA Opus 冲突已有守卫；Lead 已裁定仅 QA 的 Opus/Sol 两个对应组显式豁免，不能依赖全局 review_same_family_allowed。

## 取舍与排除
- 不用运行次数、时间、attempt、execId 或同一枚 issue-only 硬币；它们会破坏稳定性或节点独立性。
- 不删除 registry 的 fly2403-v1；旧调用链依赖它，新的节点策略显式适用范围消除隐式依赖。
- 不把旧运行重算到新组；不强制迁移正在运行的模型。
- 不做 FLY-2769 UI/持久覆盖服务/上游目录同步；只给该人工覆盖路径留优先级与可审计的自动组来源。

## 待 Lead 澄清（非阻塞）
已答 c0868c75-4b4a-4576-a5eb-b2d3fe03b277：禁止依赖全局开关，只为 QA Opus 组增加带审计的豁免，代码复审仍跨家族；receipt 六字段交 FLY-2789。de39e0a6-cde6-4298-bab6-fbb1ee4ad3e9 确认 phases 死键、人工覆盖按最新页面。

## Lead 决策同步
2026-09-22 PDT，Lead 答复禁止用全局 review_same_family_allowed 满足本任务；只给 QA Opus 臂节点级豁免，代码复审仍跨家族。成绩读取由 FLY-2789 负责，现有 receipt 扩展 runId/nodeId/policyVersion/arm/resolvedModel/assignedAt。详见 plan §3.3。

## Founder 最新调整
[lead-instruction 5910e061-52d8-43d9-aea3-4e1d4ee99387]：实现改为独立 Opus75/Sol25，impl_opus/impl_sol；补对称 QA Sol 特例。号池权威全灭可将 impl_sol 实际执行降级 Opus，原组不改，另写 degraded 事件，不计正常 Sol组成绩。降级合同见 [lead-instruction 16a8dafb-af31-4b79-80c2-2ce1b7a52b45] 与 plan §3.4。

最新覆盖裁定：[lead-instruction cc848d61-245f-4dd0-a00b-1c2e317ec249]：QA 节点整体允许同家族，仍由服务端验证/审计；design/code review 按实际作者家族动态跨家族，不接受全局开关替代。此前逐臂特例已被取代，正式规则见 plan §3.3/Q11。
