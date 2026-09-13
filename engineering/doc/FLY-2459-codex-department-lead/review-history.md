# FLY-2459 Codex 部门 Lead — 评审修订
Issue: FLY-2459 (https://linear.app/geoforge3d/issue/FLY-2459/2441-能派-runner-的部门-lead-跑-codex-后端补-codex-lead-动作面的-startmanage-runner)
日期: 2026-09-10
基于: plan.md

## Round 1

Question `e8d7c343-2356-4618-9017-b62ba9cd7fc4`; request `156fa55c-7365-4730-add9-0887607351d6`。
Effective `CHANGES_REQUESTED`，raw `CHANGES_REQUESTED`。3 HIGH、7 MEDIUM、1 LOW；以下均已核源码后修订文档，仍待新轮有效批准。

| findingKey | 严重度 | 修订位置与动作 |
|---|---|---|
| identity-digest-v1-exclusion-missing | HIGH | plan §2.2/5 A：能力只在IdentityLeadRow/selector/env，不加CanonicalLeadIdentity字段，不改v1摘要；非目标Lead逐字节不变的回归 |
| tui-live-tool-inventory-gate-regression | HIGH | §3.4/5 B：保留TUI静态配置闸，禁止启动期live ready watcher；per-turn MCP无启动广播正常，真实工具调用在QA取证 |
| verified-stage-runs-under-admission-pause | HIGH | §4：窗内止于activated、写deployed_unverified有界返回；wave结束且admission实际解除后做真实验收；窗口外只读verifier补本receipt，无控制面动作 |
| converge-first-adoption-entry-missing | MEDIUM | §4.1/5 D：FILES和is_first_adoption_name同时加入lib/lead-backend-migration.sh；首次adoption无severe回归 |
| start-outcome-429-unclassified | MEDIUM | §3.1/5 C：typed admission 429为refused并投影Retry-After；未知阶段错误保留unknown，不自动POST |
| route-category-conflict-already-covered | MEDIUM | §3.1/5 C：记录既有WORK_KIND_ROUTE_DECISION_CONFLICT，移除修改runs-route条件项，本单只加回归 |
| residency-recover-not-applicable-to-generic-carrier | MEDIUM | §2.2：专用recover/roster已审计但不改、不启用；明确Honey Lemon仅KeepAlive+普通wave覆盖 |
| dept-scope-flag-must-be-pinned-on | MEDIUM | §5.1：529启动前TEST_BRIDGE_DEPT_SCOPE_REJECT=on，验证被测Bridge有效值，不用外部env变化代证 |
| codex-profile-configurable-only-nominally | MEDIUM | §2.1/2.2/4.1：公共参数可传，当前generic非full-access在planner生成intent前拒绝；标出三处硬约束 |
| taskcategory-enum-should-project-adopted-menu | MEDIUM | §3/5 C：用resolveLeadMenus投影本Lead菜单，call-time重读，未采纳零HTTP |
| verification-doc-title-mislabeled | LOW | verification.md标题改为验证 |

research/exploration/HTML同步边界，避免旧结论与修订plan矛盾。没有任何产品代码或生产状态改动。

## 后续轮次纪律

收信 `[lead-instruction c761125a-8035-45b5-ab28-ac546c81ba95]`：R1文档修订在此次收信前已完成；指令后只修blocking，advisory仅列plan Follow-ups，不开新单。R3再退回则原文报告Lead，不开R4；review运行期间不提交/推送。未申请或声称任何finding治理豁免。

## Round 2 — effective APPROVED

Question `6235e495-36f2-4b1c-8409-4bf9671dab4e`; request `cd1accb0-b633-4867-be9c-cab0918b2e9a`；reviewed design commit `fc6b2a963`。2026-09-11T02:23Z读取有效`reviewVerdict=APPROVED`、raw`reviewerVerdict=APPROVED`，无HIGH、无settled。

剩余advisories：`wave-skip-mechanism-unspecified`（MEDIUM）、`deployed-unverified-has-no-failure-edge`（MEDIUM）、`start-429-typed-reason-not-projected`（LOW）。全部仅存plan Follow-ups，未修、未开新单；按Lead指令继续交付，不开启R3。批准后仅更新评审状态、advisory留档和交付验证元信息，方案及HTML行为不变。
