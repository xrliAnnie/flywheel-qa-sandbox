# FLY-1655 self-ship 按终节点不变量重设计 — 实施计划

Issue: FLY-1655 (https://linear.app/geoforge3d/issue/FLY-1655/founder-直令唯一单-self-ship-修了又坏-n-真根因每次修复只覆盖上一次事故的状态签名要按不变量重设计)
日期: 2026-08-09
基于: research.md

---

## 0. Founder 纠偏后的唯一设计

**有 ship 职责的 DAG 必须以 engine-owned `land` 节点收尾。** 上游节点只生产代码、PR binding、QA/review claim；founder 在 approval gate 上批准后，唯一后继是终端 `land`，由引擎 merge、清理、归档。land manifest 的 resolved snapshot 会把所有上游 executable node 的 `can_ship/can_land/approval_gate_holder` 降为 false（`creates_pr` 保留），让 prompt 与 runtime authority 同时只认终节点；node-type registry 本身不改，以免重写 frozen legacy snapshot 的语义。

实现只复用仓内已有的 `approval_gate -> land` 平台能力，不新建表、不新建路由、不加 timer/boot sweep、不做跨库 saga。节点 id、角色名、QA 是否存在都不是判据；行为只看 manifest 的 `approval_gate`、`terminal_node` 与 node type/capability。

这取代旧计划的六层补偿设计。旧计划是在错误拓扑上修账；本计划直接移除错误拓扑。

## 1. 根因裁定

### 1.1 实例 A 的唯一真差异

FLY-1572/1596/1638/1648 的 frozen snapshot 相同，carrier/session 材料相同。唯一差异是 gate 物化时生产运行的二进制：FLY-1648 全生命周期运行在 pre-#779 的 `4857d999`，该版本创建 holder 时不会写 `workflow_ship_target_binding`；三个成功对照通过旧 `setReviewBinding` 旁路事后补出了行。#779 合入后没有部署，且新代码只服务新 gate、不对账已存在 gate。

更深一层的设计错误是 schema-v2 `tpl_code` 根本没有 ship 终节点：真库的图只到 `founder_gate`，`implement` 被赋予全部 ship capability。binding 缺行只是“runner 同时做实现者、gate carrier、shipper”这个错误拓扑的一个症状。

### 1.2 FLY-1607/1650 的 500 精确成因

旧构建的 `resolveWorkflowGateAuthority()` 要从上游节点能力推断唯一 runner carrier。1650 的 `tpl_generic_menu` 只有 `founder_approved` claim，却被 generic carrier 要求 git-head authority，命中旧代码的 `incoherent_ship_bundle` 形态 A；completion 主路径裸调用该函数，异常逃逸为 HTTP 500，事务回滚，run 留 active，dead-execution 补位随后重派。形态 B(多个 ship-capable 节点)和 C(单 carrier 能力不齐)是同一推断机制的另外两个失败面。

终端 `land` 让 authority 由图显式声明，`resolveWorkflowGateAuthority()` 在进入 carrier 推断前直接返回 `mode=land`，因此三种 bundle 推断错误都不再位于新图的 ship 路径。

### 1.3 第一因

修复合入但生产仍运行旧 build，使任何正确代码都不生效。部署回执必须证明正在运行的 built artifact 包含 intended commit；只看 checkout HEAD 不够。

### 1.4 terminal source session 不能撤销 engine gate

slot 4 真机证明:上游 executable 正常完成后,FLY-1448 terminal receipt settlement 会把刚物化的 engine-owned approval question 标成 `superseded_session_terminal`,使 Annie 随后打在卡片上的 ✅ 永远进不了 reaction poll。旧逻辑把 session 当 gate owner；新 topology 中 session 只是 provenance,gate holder 才是 authority。

修复只复用 `workflowGatePresentationDisposition` 的 `holder_authoritative` 结论:session terminal settlement 保留该 question 与对应 receipt family,同 execution 的 stale/legacy question继续 dispose。不得按 node id、role或 phase 判断,不得新建恢复 sweep。

## 2. FLY-1625 四候选终局

| # | 终局 | 证据与动作 |
|---|---|---|
| ① holder head 不取 QA cwd | **已落地** | `qa-result` 的 head 由服务端 head-authority 决定；新 `land` authority 使用 gate evidence 的 approved head 与现有 PR binding，不读取任一节点 cwd。legacy `/head-authority` 缺 binding 时保留精确 `required/reason`，不做隐式补写。 |
| ② carrier binding 周期重试/对账 | **判死** | 新图没有 runner ship carrier；gate 创建事务沿用既有 land 路径一次性写 target binding，不需要事后重试。为旧拓扑建 boot sweep/读时补齐会永久保存错误架构，故删除。冻结的 legacy snapshot 保持可读并 fail-loud，不扩建恢复机制。 |
| ③ 带审计操作员杠杆 | **已落地** | 既有 `/gate-carrier-rebind`、`/loop-reentry`、`/re-qa` 和 run `rework/terminate` 均有明确入口；它们只服务 legacy/重验，不再承担新图正常 ship。删除本单新增的 gate-reissue saga。 |
| ④ 同 session 凭据重铸 | **判死** | `qa_verdict` submission credential 以 lifecycle revocation 防陈旧，不按墙钟过期；派生 claim 同为 permanent。问题类消失后不再建重铸入口。 |

## 3. 最小实现

### T — 通用 terminal land

1. schema-v2 增加明确的 legacy/land union。land 形状允许 root `approval_gate`/`terminal_node`、node `type=land`/`execution=engine`、approval gate 的 `founder_approved` edge 与可选 founder-feedback loop；land node 不要求 vendor/model/effort。parse/round-trip capability schema允许 `can_request_ship_approval`。legacy `terminal_gate` 形状继续用于 frozen snapshot 解析。
2. 新增通用 `isWorkflowManifestLand()`；现有 `isWorkflowManifestV1Land()` 只作为兼容别名。StateStore、gate authority view、dispatcher、land executor 都改用通用谓词。manifest validator保证恰一个 terminal land；authority resolver先按显式 land 拓扑返回，不进入 runner-carrier 推断。
3. menu compiler 从 node type/edge 拓扑找 approval gate；当 graph 含 PR-producing executable 时追加 engine `land` 与 `founder_approved` edge。实现不得比较 `qa`、`implement`、`founder_gate` 等 id。bundled schema-v2 ship templates同步改为显式 land。
4. claim-backed land graph 继续从 QA/review claim 取得 git head。只有 `founder_approved` claim 的 graph 从 completion 携带的 head 取得候选，并要求它严格匹配该 run 的唯一 current `workflow_node_pr_binding`；校验放在任何 transition mutation 之前，失败返回 typed `{ok:false, reason:"land_head_unavailable"}`，不得 throw。它不写新授权行、不做 fallback。这样 `generic/prd/design/prototype` 等 menu 都能使用同一 land path。
5. land snapshot 构建时对所有上游 executable capabilities 做图级降级。兼容性只留在解析边界：旧/自定义 `runner_ship` manifest 继续按既有语义运行，本单不增加全局启动拒绝、迁移器或恢复状态机；bundled/menu 新 revision 本身保证走 land。
6. 删除 `land_gate_holder_requires_qa_head`。进入 approval gate 只要求 topology predecessor 提供可证明 git head；任意 node type 均可作为 predecessor。founder transition 的目标用 `workflowTerminalNode(manifest)` 比较，删除字面量 `"land"`。
7. terminal receipt settlement 遇到 `holder_authoritative` 时不得 supersede该 question或其 receipt family。除此之外保持 FLY-1448 原行为,包括同 execution stale gate 的 disposal；不增加新状态或补偿作业。

### B — founder gate 只留一条必要护栏

`handle-receipt --action relay` 对 `approve_to_ship` 直接拒绝，和现有 `respond`/founder writer 路径一致。删除“门已被消费后再猜 founder 意图、发 reaction/alert”的补偿逻辑；护栏阻止错误发生即可。

founder 的现行批准通道只写两种：ship card 上的 ✅ reaction，或 card thread 内可被现有 Tier-2/Tier-3 解析的直接短回复。删除现行模板对未实现的 `SHIP-VERDICT:` 格式的引导；历史文档保留时标注 obsolete。

### F — 钥匙不过期与判决可恢复

1. `qa_verdict` submission credential/claim 使用现有 `permanent` 语义；consumed、attempt/head binding、terminal revocation 均保留。
2. legacy admission 有 snapshot 时使用 manifest window；无 snapshot 时保持原 30min/2h 时间戳作为审计值，不新增硬拒绝或新状态机。两者铸出的 `qa_verdict` credential 都是 `permanent=1`，因此墙钟窗口不会拒绝 >2h verdict。这同时修 QA R1 blocker 与 FLY-1649。
3. fail-close marker 保存去 credential 后的 `status/summary`，0600 权限；不引入 marker reconciler 状态机。

### G — 部署产物身份

保留 build-time artifact SHA 与 restart 回执的 ancestor 校验：built artifact 不等于/不包含 intended commit 时不得写 deployed receipt。`unknown` 永远 fail-closed；显式 `source` override只用于开发 health 说明，不能推进 production deployed receipt。只有 `built` identity 可通过部署回执闸门。

### L — legacy 失败可诊断

legacy runner-ship `/head-authority` 缺 target binding 时返回 `required=true` 与单一精确 reason；非 runner-ship 返回 `required=false/not_required`。不补行、不 sweep、不重绑。

### C — cutover 与边界

1. deploy 时不改写 frozen run snapshot。现有 runner-ship run 保留 main 已有的 legacy completion、`/gate-carrier-rebind`、`rework`、`terminate`；本 PR 新增的 A/E 补偿层删除。需要新拓扑的在途 run 由 operator `rework`，并明确接受证据重跑成本。
2. bundled/menu seed import 产生新的 current land revision，既有 category binding继续指向 template id 的 current revision；旧 run 仍 pin 旧 revision。custom runner-ship template不自动改写，也不新增拦截；其迁移由 template owner 显式发布 land revision。
3. nested target repo 在现有 runner-ship 与 engine-land 两条路径均不受支持，本单不扩展跨 repo merge。命中 `nested_land_unsupported` 时 run hold，由 Lead 在 founder approval 后走现有人工 nested-PR ship，再 terminate；不得静默当 completed。
4. land 项目必须提供现有 sanctioned ship workflow。`ship_workflow_pending` 继续复用既有 poll，但必须进入现有 `land_partial` event/alert 分支；只补一次可见性，不加新 timer、attempt ledger 或状态机。

## 4. 明确删除

- Fix A：读时 binding reconciliation、boot sweep、`ship-target-binding-boot.ts` 及其事件/诊断矩阵。
- Fix B2：consumed-gate founder intent 推断、reaction、convergence alert。
- Fix C2/C3：complete marker 多分类退避/hold/quarantine 状态机；新拓扑直接消除 bundle 500。
- Fix D：merged projection、死亡收据、proof-backed dead-execution hold。
- Fix E：carrier predicate 扩张、gate-reissue 四段 saga、新 question rotation。
- 所有仅为以上逻辑存在的表字段、事件、测试、文档说明。

目标不是“把 6940 行修到绿”，而是删除约 4–5k 行补偿代码后，用既有 land 能力补齐图。

## 5. TDD 与阳性对照

1. **拓扑 RED**：schema-v2 code/menu template 当前解析为 `runner_ship`、terminal 是 gate。实现后 bundled/menu 必须是 `land`、terminal 是 engine node；删掉 land node/edge 后该 topology 断言翻红，但兼容 parser 仍接受 frozen legacy manifest。
2. **非 QA predecessor**：构造 claimless `generic -> approval gate -> land`，completion head 与唯一 current PR binding 相符时可开 holder 并完成 approval transition；缺 binding/head mismatch 均返回 typed refusal，且 node/run/receipt 零 mutation、无 throw。恢复旧 `source.type === qa` 条件后翻红。
3. **不绑节点名**：任意 node id/role 的 land 图，上游 resolved ship bits 为 false、terminal land 为 true；纯 no-ship graph仍可使用 engine-terminal gate；legacy runner-ship 对照继续可解析，证明没有用新策略破坏旧图。
4. **QA R1**：active run 无 snapshot 仍按原 window admit；恢复 hard throw 后现有 `workflow-shadow-wiring` 翻红。
5. **relay**：去掉唯一 guard 后 approve gate 被 Lead response 消费的测试翻红；恢复后绿。
6. **permanent**：过去时 permanent QA credential 可提交并产出 permanent claim；bounded credential仍 `credential_expired`。
7. **marker**：去掉 `status/summary` 后恢复性断言翻红。
8. **deploy**：stale/divergent artifact 不写 receipt；equal/descendant 写 receipt。
9. **cutover**：frozen legacy runner-ship snapshot仍可 parse；bundled旧 template id boot 后 current revision变 land；custom旧 revision不被隐式改写或新增拒绝。
10. **terminal source**：真 StateStore + CommDB 构造任意命名的 `craft → decision → publish` land 图；source session terminal 后 authoritative question仍 pending,同 execution stale question仍 `superseded_session_terminal`。移除 holder-authority guard 后前一断言翻红。

验证门：相关 vitest + mutation 对照；`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`、新增/相关 shell harness。不得以 fixture 单独绿替代真库/真产物证据。

## 6. 真产物与真机验收

1. 从生产 `teamlead.db` 只读副本加载 FLY-1648/1650 frozen snapshot，证明它们仍可解析且得到明确 legacy reason；新 revision 的 `tpl_code` 在同一构建产物中解析为 terminal land。
2. isolated Bridge + 真 Discord 卡片各跑一条 claim-backed `code` 与 claimless `generic` DAG：到 approval gate，founder 在卡片上批准，引擎进入 `land`，`verify-approval` 不再由上游 runner 执行。
3. `land` 完成 merge、cleanup、archive，run 进入 completed；关闭所有 runner 后观察 5 分钟零重派。
4. 部署后 `/health` 的 artifact SHA 覆盖 intended commit，deployed receipt 才可写。

生产 merge 仍需 founder approval；本执行节点只提交 PR 与证据，不自行 merge。

## 7. 相对旧计划的偏离

旧计划 Fix A/C/D/E 的大量状态机全部撤销，原因是它们继续假设上游 runner 是 ship carrier，直接违反 founder 2026-08-09 两条总则。实现阶段又删除了计划草案中的 `terminal_land_required` 全局启动拒绝：它会把新策略强加给 frozen/custom graph，并导致大面积兼容分支，既不属于 terminal-land 必要路径，也违背“宁少勿多”。保留的 B/F/G 只解决与拓扑独立、已有真实事故证据的问题；QA R1 的 snapshot fallback 恢复原行为，不增加新逻辑。
