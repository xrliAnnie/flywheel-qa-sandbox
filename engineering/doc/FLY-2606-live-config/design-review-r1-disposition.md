# FLY-2606 首轮评审逐项处置 — 实施计划
Issue: FLY-2606 (https://linear.app/geoforge3d/issue/FLY-2606/热生效-founder-2026-09-16-0038z改模板effort-要等重启才生效本来就有问题-工作流模板从仓库种子发布到)
日期: 2026-09-15
基于: plan.md

R1 question: `b8f9938a-cab5-46ad-baef-770b6d38e1ce`；request: `1761aed1-5233-4844-aac8-373f3dade7b5`。有效结论CHANGES_REQUESTED；2 HIGH与9项非阻断意见全部逐项处理。原始回执见design-review-r1.json。以下是作者处置，不能代替新一轮有效reviewVerdict；没有Lead治理豁免。

| findingKey | 严重度 | 处置 | 修正与证据要求 |
|---|---|---|---|
| lead-config-desyncs-launch-manifest-and-plist | HIGH | FIXED / 待R2验证 | §3.6：registry为Codex两项可变参数唯一authority；launcher覆盖旧加载env，generator去两键，fresh start/resume和payload能力门；B6覆盖三条恢复路径。 |
| active-run-guard-state-predicate-undefined | HIGH | FIXED / 待R2验证 | §2.3显式参数化SQL status IN ('active','held')；A4覆盖held恢复。 |
| inbox-hmac-canonicalization-not-extended | MEDIUM | CLARIFIED | §3.7独立method分支覆盖所有字段，unknown拒绝，逐字段tamper测试。 |
| cfglock-path-env-override-divergence | MEDIUM | CLARIFIED | §3.7规范registry路径+.cfglock；两个override仅允许相等，冲突stage零写；slot及真实fleet互斥测试。 |
| reuse-existing-node-config-lock-and-sentinel | MEDIUM | FIXED | §3.1/T3复用withMigrationConfigLock及现成no-follow/atomic/fsync原语，删除新.mjs方案。 |
| seed-compile-not-bound-to-frozen-model-snapshot | MEDIUM | FIXED | §2.3/T1逐层显式传单一snapshot；stage冻结一次，apply不重编译。 |
| founder-tui-settings-drift-unmodelled | MEDIUM | CLARIFIED | §3.7/B7持续观察通知和readRuntimeConfig；drift撤销当前成功显示，不自动覆盖会话选择，显式set建新代际。 |
| resume-reapplies-frozen-launch-params | MEDIUM | FIXED | §3.6/B6两个runtime在每次ensureThread构建fresh pair；start/resume字段与hot字段等价；核恢复首轮。 |
| seed-hash-equal-hides-manual-divergence-report | LOW | FOLLOW-UP / 非阻断 | §2.5删除每次启动都报告差异的承诺，保留既定preserved合同。差异提示由Engineering Lead另行安排；触发条件为需要统一种子/人工版差异展示。 |
| seed-builder-symbol-name-wrong | LOW | FIXED | §2.1改为实际loadWorkflowMenuSeeds(modelSnapshot)。 |
| retention-classification-vocabulary | LOW | FIXED | §2.4/3.2指定三个per-table JSON fragment，复用protectedCurrentOrReference。 |

HIGH启动问题选择消除Codex重复参数authority，而不是三文件伪原子更新或永久拒绝非空carrier；所需launcher/generator变更纳入同一部署能力版本，旧bundle零写。此选择仍需独立R2评审通过。所有修改均为设计文档，实际代码、CI与隔离运行证据尚未产生。
