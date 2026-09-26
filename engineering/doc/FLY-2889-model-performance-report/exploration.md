# FLY-2889 模型表现报告 — 探索
Issue: FLY-2889 (https://linear.app/geoforge3d/issue/FLY-2889/模型表现报告-设计-实现-qa-各节点分流的各模型正确度速度花费三维度实测-结合额度给调整比例的建议一页可评论-html)
日期: 2026-09-25
基于: 无

## 问题
founder 2026-09-25 13:28 PDT：分流跑了一段时间，想按 正确度 / 速度 / 花费 看每个模型在设计、实现、QA 节点的表现，并结合额度判断要不要调比例。只读分析，不改配置。

## 实际分流历史（由生产 teamlead.db 只读查出，UTC）

| 时段 | 设计 eng_design | 实现 implement | QA |
|---|---|---|---|
| 09-08 19:18Z 起 | 旧规则 `design_model_arm_assigned`（Astra vs Fable，按单号百分比；118 条） | 非随机：按时间换默认（Sol 5.6 xhigh → Astra medium 09-09~16 → Sol 5.6 → 少量 Fable/Opus 5） | 固定 Opus 5 high |
| 09-24 23:15Z 起 | 新规则 `model_arm_assigned` 三臂 Astra/Opus 5.5/Fable 各 1/3 | Opus 5.5 xhigh / Sol 5.6 xhigh 各 1/2 | Sol 5.6 high 3/4，Opus 5.5 high 1/4 |

`models.json` 备份显示设计百分比曾在 75/50/0/100/0 之间多次调（09-20~09-24），所以旧设计段也不是固定 50/50。

## 关键判断
1. **两段必须分开**：随机分组段只有约 21 小时、35 条分组事件，样本极小；观察段（09-08 起按实际运行模型）样本大，但实现/QA 模型随时间整体切换，和当时的单子难度、系统故障期混在一起（时间混杂）。Lead 已同意：分开标注、不合并下结论。
2. **评审路径不对称**：Codex 作者（Astra 设计、Sol/Astra 实现）的评审走 Bridge `codex_review_job`，每轮 verdict 在库里；Claude 作者（Fable/Opus 设计与实现）的评审由 runner 自己跑 Codex，轮数只在 worktree 回执或 transcript 里，worktree 大多已清理。这会影响「复审轮数」可比性，必须写明。
3. **评审者也不同**：按作者家族反转——Claude 作者由 Codex 审，Codex 作者由 Claude 审。「首轮 APPROVED 率」同时反映作者和评审者的严格度。
4. **花费**：FLY-2789 scorecard 表只从 09-23 23:46Z 起有逐 turn 用量；更早的要从 transcript / rollout 解析。
5. **执行数 ≠ 单数**：重启误杀、换体（replacement）让同一节点有多条执行；统计单位要用「单 × 节点」而不是执行行。

## 不做
不改 models.json、不改代码、不跑测试套件、不打印消息正文或凭据。
