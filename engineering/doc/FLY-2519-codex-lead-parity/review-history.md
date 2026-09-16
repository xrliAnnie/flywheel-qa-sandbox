# FLY-2519 Codex Lead 能力对等 — 调研
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-13
基于: plan.md

## Review protocol

Codex author 使用 `gate review_design --no-block` 与 `request-review --type design --question-id ... --plan ...`。只有结构化 `reviewVerdict` 为有效门禁；reviewerVerdict/advisories 不替代它。待注册首轮，注册后保持同一 gate/request 轮询。

## Lead 设计约束

问题 cda893ee-a0cc-41e8-ba66-ffb05fb4a480 的答复已落实到 plan.md §2/§4/§5；回报 receipt `2fa77750-4960-429c-9dae-69045f9a7576`。broker 只返回结果，禁止 ship/merge/close/restart；CLI 等价须逐项测；不改 Claude secret handling。本答复不是 review-ruling 或 ship authority。

## R1 — CHANGES_REQUESTED

- head: bbd5a4c98；question: 97e9793c-68e7-4a75-93cb-7a9e026c9e8a；request: 81cb31fb-27a8-4201-ae93-ac3e8129b1fb。
- reviewVerdict=CHANGES_REQUESTED，reviewerVerdict=CHANGES_REQUESTED。原始结构化 findings 保存在 review-r1.json。
- 1 HIGH：browser-mcp-unsandboxed-bypass，已按 plan.md §6/§11 修订。3 个相关 advisory 随同一连接/隔离链收敛；其余 broker-socket-no-caller-binding 和 single-issue-scope-size 留 Follow-ups，没有自行 governance ruling。
- R2 必须新 gate+request；原 gate 不复用。

## R2 — APPROVED

- reviewed head: 0e8318be2；question: c2a10f39-eec6-4ee4-8db1-895dee044167；request: 03da9402-6dc7-48a2-b755-3fd58c17e4c8。
- reviewVerdict=APPROVED，reviewerVerdict=APPROVED，round=2。结构化原文见 review-r2.json。R1 HIGH 已无 blocking finding。
- 1 MEDIUM / 4 LOW 仅作为 Follow-ups 留档：browser-seatbelt-nesting-feasibility、browser-filter-enforcement-location、broker-socket-no-caller-binding、fixture-attach-dynamic-seatbelt、single-issue-scope-size。没有设计修复、新工单、治理 settled 或 R3。
- 最重要的限制：外层 sandbox-exec 与 Chrome helper 自身 Seatbelt 的嵌套可能导致无法启动；设计维持 fail-closed。后续需在非嵌套宿主先验证可行性；不得因本设计 APPROVED 就宣称浏览器可用，或擅自加入 --no-sandbox。

## 2026-09-14 重派补充 R1 — CHANGES_REQUESTED

- 当前 execution `4c428168-c403-4b03-b2b9-ffa47bf68433`；question `bff1650a-b08a-48ad-99d4-015cf0f6df77`，request `2d282cfd-d213-446f-89fe-ebfb38b38bb5`。原始结构化 verdict 见 `review-resume-r1.json`；effective CHANGES_REQUESTED，1 HIGH、4 MEDIUM、1 LOW。
- HIGH `identity-claim-write-via-bridge-authz-undefined` 属实：初版附录误将“经身份/部门/claim 校验后的业务写”写成“更新授权数据”，并错误引用旧 chat-threads/send 的幂等。已改为既有授权只读校验、原治理通道负责身份变更、Bridge 只执行业务写；明确 projects.json/CommDB/StateStore 分工，共享 master token 不足以授权，复用真实 carrier/department 校验与持久 outbox。未新增能力或 governance ruling。
- 同链 `chat-threads-send-idempotency-miscited` 已以真实 broker UUID/digest、parent journal-context 与持久出站去重引用修正，并保留跨进程重启、改 payload、unknown 负例。
- 其余 advisory 留档，不设新增 QA 门槛。Preserved 实现事实上已有 `materializeAndPushV2` + parent Git HTTP transport，以及 Chrome MCP 1.9.0/21-tool schema pin；附录补精确引用以避免把 design checkout 的 legacy 实现误当 v2。本轮没有为 advisory 更改代码、延长其他 deadline 或关闭 Chrome 沙箱。
- 评审过程中收到 `[lead-instruction b1077734-89fe-4664-a170-c7dbe61015f7]`。按指令从具名 stash 的父提交 `ce0e761a9` 只读审计已有实现；最终设计只补 `gap-checklist.md` 五项差距，附录保留注入裁定，HTML 说明已有实现和剩余工作。该最终内容须使用新 gate/request，不能复用本轮拒绝结果或原 R2 作为完成。
