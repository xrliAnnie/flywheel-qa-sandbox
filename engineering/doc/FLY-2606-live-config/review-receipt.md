# FLY-2606 设计评审与后续建议 — 实施计划
Issue: FLY-2606 (https://linear.app/geoforge3d/issue/FLY-2606/热生效-founder-2026-09-16-0038z改模板effort-要等重启才生效本来就有问题-工作流模板从仓库种子发布到)
日期: 2026-09-15
基于: plan.md

## 有效通过证据

- question: `143fa0c1-eff9-4b94-bbe8-d3eb0d47dd25`
- request: `637f806c-e620-45ab-aa84-2d910d47f227`，round=2
- reviewVerdict=APPROVED；reviewerVerdict=APPROVED；settled=[]，没有治理豁免
- 原始结构化回执：design-review-r2.json
- 评审方案提交：`bcd8cb4b0`；评审时plan SHA-256（后附Lead交接处置不属于被评审正文）：`ae8895916a5f35fd93a8d246b2db8b602da68c3b4bbe22b8fff7c38921123b55`
- 初轮2项HIGH的逐项处置：design-review-r1-disposition.md

## 非阻断 Follow-ups

有效review已通过，不重新开启设计。以下5项是reviewer建议，尚未宣称已实施或已验证；通过ask --report完整摘要送Engineering Lead，由Lead选择实施细节/跟进。后续节点应在实现时记录具体处置，不把本表当成新的治理批准。

| findingKey | 严重度 | 需要记录的处置 | Owner |
|---|---|---|---|
| drift-flag-vs-fresh-pair-resume-precedence | MEDIUM | 明确会话内TUI选择与冷启动/重连registry优先规则；实际重新一致时状态如何消除drift；补drift期间重连验收。 | Engineering Lead |
| readruntimeconfig-failure-on-router-preflight-unspecified | MEDIUM | 明确router preflight的readRuntimeConfig时限、读取失败状态和是否放行，不默默以registry摘要代替实际设置证据。 | Engineering Lead |
| t3-refactor-not-covered-by-its-own-suites | MEDIUM | 提取文件写入原语时纳入现有lead-registry-add、cli、cos-context、cos-context-cli、recover、verifier六套回归。 | Engineering Lead |
| workflow-menu-file-in-evidence-column | LOW | workflow-menu.ts是T1必改文件，已在§2.3和T1证据列列明；实现任务应把它放进文件清单。 | Engineering Lead |
| same-payload-gate-spans-two-distribution-paths | LOW | 能力门核实下次真实启动读取的bin副本与repo源文件字节及路径，不能仅信单一build标签。 | Engineering Lead |

另保留首轮非阻断Follow-up：相同seed hash时的人工版差异提示；以及已由Lead裁定单独跟进的Claude热更新能力。本次不重开范围、不调整生产值。

Lead通过question 790a5784-0cdc-4dee-97a2-16c260ce53b2明确将上述5项全部保留为非阻断Follow-ups，允许implement继续。没有改写R2有效APPROVED，也没有对HIGH作治理豁免。
