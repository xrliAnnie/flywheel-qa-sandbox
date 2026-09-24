# FLY-2788 节点模型分流 — 调研
Issue: FLY-2788 (https://linear.app/geoforge3d/issue/FLY-2788/2787-a分流引擎-每个节点按定稿选模型设计三组-astraopus-55fable-51-各-13实现-opus-55qa-gpt-6)
日期: 2026-09-22
基于: plan.md

## R3 评审与修订处置
有效 verdict=CHANGES_REQUESTED；question=99373c3e-6b0a-4b60-9e5a-6c1d5a061b4a；request=7960a37d-b88a-4c47-8de3-790199861c02。被审 plan blob=78b69ad6c0f23e7b25c4914722caa37d43fd8180。下表是设计修订，不是实现验证；须经新 gate 重新批准。

| findingKey | 严重度 | 处置 |
|---|---|---|
| replay-digest-diverges-from-draft-receipt | HIGH | §2.4: 同一语义 projection 用于初次、shadow refresh、事务三个 selectionDigest；Q2 同 K 重发 route 测试。 |
| frozen-replay-drops-fixed-node-pins | HIGH | §2.4: snapshot.modelRouting 冻结完整 selectionOverride；零事件产品节点重放仍返回 override；同时比较 requestedOverrideDigest 拒绝变更请求。 |
| manual-qa-override-same-vendor-guard-contradiction | MEDIUM | §3.2 显式指向 §3.3 的人工 QA 同家族许可，QA 以外守卫保留；Q8。 |
| degraded-dispatch-effort-unspecified | MEDIUM | §3.4 降级取目标 opus 候选 high，校验 node+catalog；保存 assigned/actualEffort 扩展，Q10。 |
| degradation-wake-seam-has-no-receipt-writer | MEDIUM | §3.4 指定 admission 内从既有 immutable runtime/receipt 恢复实际 dispatch 并写本 activation 降级事件；rework coordinator 不调用 launch resolver，Q10。 |
| degradation-actions-seam-has-no-quota-root-key | MEDIUM | §3.4 明列 createActionRouter/handleRetry provider、plugin 两 action mounts 与同一 rootKey 传递；Q10 覆盖三个入口。 |
| cross-family-review-wait-has-no-operator-unblock | MEDIUM | §6.7 容量等待通知、具体 request 定位、Lead 定期值守、额度恢复后的既有 retry 路径与明确取消选项；遵守 founder 不用同家族 review 解锁。 |
| q5-manual-override-vs-node-candidate-guard | MEDIUM | §3.2 明确本单修改 node.models 前置守卫，仅已有授权显式人工路径可越自动候选；列表外必须显式合法 effort；Q5 分开自动阴性/人工阳性/未授权阴性。 |
| runbook-missing-authority-write-path-and-ordering | MEDIUM | §4.C 扩展现有 writer set --policy-file，复用共享锁与原子写；§6.3 明确生产已部署兼容 reader 后才切配置。 |
| menu-precheck-cannot-verify-run-scoped-receipt | LOW | §3.3 拆清菜单结构层与 admission/claim 运行身份层，不要求预检读取不存在 runtime。 |
| q1-fixed-vector-tolerance-can-deterministically-fail | LOW | Q1 固定120 code UUID与精确期望计数44/38/38、88/32、91/29；区间仅诊断。 |
| cross-run-reuse-equality-wording | LOW | §2.3 就地列比较字段，排除 runId/assignedAt/display identifier；Q2 与 §2.4 同一 projection。 |

## R4 提交后的自检补充
新 snapshot replay 直接使用冻结 selectionOverride，不再重复 merge/prefix reason；原请求摘要明确在菜单自动补值前计算。QA 同家族审计改为每 activation 去重，避免 resident 返工的 producer 变化冲突；design/code review 以 snapshot.modelRouting 识别范围，让无 arm 的人工覆盖也保持跨家族。此补充需随最终 plan blob 重审。


## 最终有效评审与 Follow-ups
effective reviewVerdict=APPROVED；reviewerVerdict=APPROVED；question=c60a58fb-0fc6-4bfa-b28f-b45332425bb5；request=0f1b2387-23f2-477e-97cd-8c9b11130481；round=5；2026-09-23T04:43:50.872Z。
最终 plan blob=a0c4fc62b715e3c893efb21576c91764b9808ab6（提交 840bf4cc5），后续文档交接不修改该定稿。服务端策略 medium_low_findings_are_non_blocking_v1；无 blocking findings，settled 为空。以下是评审明确标为非阻塞的后续建议，交 Lead 决定安排，不代表已实现或验证。

| findingKey | 严重度 | Follow-up |
|---|---|---|
| snapshot-modelrouting-breaks-binary-downgrade | MEDIUM | 运行手册明确新 modelRouting 在飞时不能降级为不认识该字段的旧二进制；仅回配置/模板，并枚举受影响在飞 run。任何等待完成都必须发生在兼容 reader 仍运行时，不能先降级再等。 |
| q11-no-arm-manual-override-routing-untested | LOW | 补人工 Claude implement 无 arm、有 modelRouting 的评审用例；即使全局 same-family 开关 true，也应选 Codex reviewer。 |
| qa-exemption-audit-retention-unstated | LOW | 把 qa_same_family_exemption_applied 加入与 assignment/degraded 相同的 retention/archive 留存回归守卫。 |
| q1-simple-code-expectation-unstated | LOW | simple_code 复用同一 120 UUID，断言逐单 implement/qa 与 code 相同，计数分别 88/32、91/29。 |
