# FLY-2482 Codex 设计评审记录
Issue: FLY-2482
日期: 2026-09-09
基于: plan.md

Codex thread: 01a089b6-58fd-7573-88cd-8344fd16d867 · effort xhigh · 3 轮 · 终判 APPROVED。原始反馈文件逐轮原样附于下。


---

# Design Review — plan.md (Round 1)

Date: 2026-09-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案整体可基于现有 Cell、派生规则和 fail-loud 校验架构落地；Linear `parent` 查询、零表迁移、保留 `descendantIds` 语义以及最小渲染改动的方向都成立。但当前计划尚未真正兑现 ready.v1 / subtraction.v1 / signals.v1 的同输入回归保证，验收取数也无法证明递归 scope 与六类 counts，因此在实施前需要修正。

## What's Good (Keep)

- `parent { id identifier }` 与当前 Linear SDK 的 `Issue.parent` 能力匹配；在遍历时用 `parent.id` 对账并复用 `EpicSnapshotTruncatedError`，可以让父链漂移 fail closed（`packages/teamlead/src/bridge/linear-epic-query.ts:276-368`，`packages/teamlead/src/bridge/epic-page-refresher.ts:79-89`）。
- 用一个共享 `isSchedulable` 钉住 ready、subtraction 和 residual 的定义域是正确的收敛方向，且不会改变 `descendantIds` 的现有消费者语义（`packages/teamlead/src/bridge/linear-epic-query.ts:370-401`，`packages/teamlead/src/bridge/dependency-route.ts:813`）。
- `counts.v1` 从文档内的 roots、parent、state 和 blocked_by 重算，并要求 value 与 provenance.from 同时一致，符合现有派生 Cell 的可复算模式（`packages/teamlead/src/epic-page/model.ts:884-987`）。未知状态整根 missing、父链悬空或成环直接拒绝，也符合 fail-loud 原则。
- 不升 `schema_version`、不做表迁移是准确的：持久层只保存回执与 digest，而不是完整 EpicPage 文档（`packages/teamlead/src/storage/StateStore.ts:6947-6956`）。
- 容量复测、512KB 发布闸门和不触碰 attention/排序的边界明确，符合本单的数据层范围（`packages/teamlead/src/bridge/epic-page-publisher.ts:9-10`，`packages/teamlead/src/bridge/epic-page-publisher.ts:55-63`）。

## Issues & Recommendations

1. **[BLOCKER] 回归保证仍有两个漏口，而且计划内部对 subtraction.v1 自相矛盾。** `subtraction.ts` 会把 `blocked_by.in_scope` 原样复制到 `all_blocked.blocking_edges`；backlog 进入快照后，可排期子单指向 backlog blocker 的边会从 false 变成 true，即使节点集合已用 `isSchedulable` 过滤，`dependency_review.value` 仍会变化（`packages/teamlead/src/epic-page/subtraction.ts:116-145`）。计划一边要求 subtraction.v1 同输入逐字节不变，一边明确接受该变化，并在 G14 要求 true（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:75`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:158`）。此外，`stuck_items` 当前从所有 page items 的 signals 与 source health 构造和重算；backlog item 只要有 active/unreadable signal，就会改变 signals.v1，而计划的回归 fixture 恰好没有这种信号，测试是空洞的（`packages/teamlead/src/epic-page/generate.ts:281-312`，`packages/teamlead/src/epic-page/model.ts:893-964`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:113`）。建议让 subtraction 输出边的 `in_scope` 也基于 schedulable identifier 集合；让 stuck/signals 的生成与校验共同过滤 `isSchedulable`；增加“非 backlog 子单被 backlog 挡”和“backlog 子单带 active/unreadable signal”的同一原始快照 v1/v2 对拍。还必须明确“逐字节不变”是三个 Cell 的 `.value`，还是整个 Cell；若指整个 Cell，新增 items 会改变 index-based provenance.from，现方案无法满足。

2. **[HIGH] 测试命令会静默跑零个 teamlead 项目。** 计划使用 `pnpm --filter teamlead ...`（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:164`），但实际包名是 `flywheel-teamlead`（`packages/teamlead/package.json:2`）；静态执行 `pnpm --filter teamlead list --depth -1` 已返回 `No projects matched filters`。建议把聚焦与整包命令统一改为 `pnpm --filter flywheel-teamlead test:run -- ...` / `pnpm --filter flywheel-teamlead test:run`，并保留根级 lint/typecheck；CI 或报告脚本还应让 unmatched filter 直接失败，避免“绿色但未执行”。

3. **[HIGH] counts.v1 所依赖的输入形状尚未被计划完整校验，且 C2 → C3 的红绿顺序不能独立编译。** 当前 `assertCell` 只做通用 Cell/来源校验，`header.roots` 也只被当作通用 Cell；没有证明 roots.value 是合法数组、root identifier 唯一，也没有证明 parent.value 只能是 string/null、missing 只能是 `no_parent`、其 Linear provenance 必须是该 item 的 `issue/parent`（`packages/teamlead/src/epic-page/model.ts:683-712`，`packages/teamlead/src/epic-page/model.ts:790-816`）。这会使父链归属含糊，甚至由错误形状触发原生 TypeError，而不是稳定的 `EpicPageSchemaError`。同时计划在 C2 校验器中调用 `computeRootCounts`，却到 C3 才新增该函数；其拟定签名也没有 `generated_at` 参数，却要求函数产出 `observed_at = generated_at`（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:59-65`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:94-100`）。建议先落 RootCounts/parent 类型与纯计算 API，再落校验器：纯函数返回 timestamp-free value/missing/from，由 generate 包装 Cell，或显式接收 generatedAt。校验器应先检查 roots 非空值、每项 exact shape、identifier 唯一且与 item identifiers 不冲突，并对 parent 的值、missing 与 provenance 做专门校验；补充错误 parent 类型/来源/缺失原因、null roots、重复或碰撞 identifier 的负向测试。

4. **[HIGH] QA 查询无法证明实际递归 scope 或六类 counts，残差前后邮件也不是同输入对拍。** 引擎会递归遍历每一级 children 并处理分页（`packages/teamlead/src/bridge/linear-epic-query.ts:276-368`），但 §7 只对每个 root 查询一次直接 children，且字段只有 identifier/state；这既会漏孙单，也没有 blocked_by/blocker state，无法区分 waiting、free、idle（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:169-174`）。建议 QA 复用生产查询的递归、分页、parent 和 inverseRelations 形状，或保存并审计同一份不可变原始快照，再按父链聚合全部后代。Residual 验收也应让旧版与新版逻辑运行在同一份冻结 snapshot/facts 上；“上线前最后一封”和“上线后第一封”即使附 generated_at，也不能排除期间 Linear 或 session 状态变化。

5. **[MEDIUM] 计划中的 fixture 期望值和若干覆盖场景与现有生成逻辑不相容。** 当前五张 EPX-100 子单中，EPX-1/EPX-5 无 blocker，EPX-2/3/4 有未完成 blocker，所以正确基线应是 `idle: 2, waiting: 3, total: 5`，不是计划写的 `idle 4`（`packages/teamlead/src/epic-page/__tests__/fixtures/epic-shape.ts:10-66`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:112`）。计划又把 EPX-6 设为被“范围外” blocker 阻塞，却要求 EPX-6 出现在该 blocker 的 `blocks` 中；`blocks` 只为 page.items 生成，范围外 blocker 根本没有可承载该 Cell 的 item（`packages/teamlead/src/epic-page/generate.ts:238-260`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:110-115`）。而 G14 所需的“可排期子单被 backlog 子单挡”也未出现在所述 fixture 中。建议纠正 golden 计数，并拆成三个明确 fixture：范围外 completed blocker、范围内 backlog blocker、backlog item 自身依赖；分别固定 blocked_by、blocks 与 subtraction 的预期。

6. **[LOW] SDK 版本证据引用错了，虽不影响 GraphQL 可行性。** teamlead 实际依赖是 `@linear/sdk@60.0.0`，不是 research 所称的 64（`packages/teamlead/package.json:67`，`pnpm-lock.yaml:455-459`）。60.0.0 的生成类型同样包含 `Issue.parent`（`/Users/xiaorongli/Dev/flywheel/node_modules/.pnpm/@linear+sdk@60.0.0/node_modules/@linear/sdk/dist/_generated_documents.d.ts:6144-6145`），所以建议只把研究与计划中的版本依据改成仓库实际锁定版本，避免实现者验证错依赖。

## Verdict

CHANGES REQUESTED — address items above

---

# Design Review — plan.md (Round 2)

Date: 2026-09-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 已实质采纳 Round 1 的六项反馈：三格 `.value` 的回归边界清楚，subtraction/signals 漏口有对应实现点与非空洞测试，counts 纯函数、严格输入校验、实际包名、fixture 数值、SDK 与 StateStore 依据也都已纠正。当前架构与裁定无需重开，但计划仍有四处内部矛盾或漏掉的执行路径，修正后即可进入实现。

## What's Good (Keep)

- 回归合同现在明确绑定 `canonicalJsonString` 后的三个 `.value`，不再错误承诺 index-based provenance.from 不变；这与现有 ready、stuck、dependency validator 的重算粒度一致（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:20-21`）。
- subtraction.v1 不再复制文档层 `blocked_by.in_scope`，而是按 schedulable identifier 集合计算边的范围；“可排期单被 backlog 挡”的 v1/v2 对拍能直接覆盖 Round 1 的反例（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:29`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:92`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:136`）。
- signals.v1 同时修改生成和校验重算，并保留 backlog item 自身的 signals；带 `question_pending` 的 EPX-7 让回归测试不再是无信号的空洞对拍（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:93`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:127`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:144-151`）。
- `computeRootCounts` 改为 timestamp-free 纯函数，生成器负责 Cell 包装，校验器比较 value/missing/from；roots 唯一性、root/item 不相交和 parent 来源绑定也补齐了（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:64-85`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:119-129`）。
- fixture 的基线与 v2 counts 算术现在正确；范围外 blocker、backlog 互挡和 backlog 挡可排期单被拆成了独立边形状（`packages/teamlead/src/epic-page/__tests__/fixtures/epic-shape.ts:10-66`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:142-151`）。
- 包名、SDK 版本和 StateStore 路径均已与仓库一致（`packages/teamlead/package.json:2`，`packages/teamlead/package.json:67`，`packages/teamlead/src/StateStore.ts:6947-6956`）。

## Issues & Recommendations

1. **[HIGH] 生产 QA 对 dependency_review 的断言仍与 G14 和 subtraction.v1 合同冲突。** §7 要求 `dependency_review.value` 不含任何 backlog identifier（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:224`），但 G14 和新增规则测试明确要求合法输出保留 backlog blocker 的 identifier，只把该边的 `in_scope` 固定为 false（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:136`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:195`）。这会让正确实现无法通过 QA，或诱导 QA/实现者删掉解释“为什么被挡”的跨域 blocker。建议把验收改成按字段判断：ready_items 不得含 backlog item；stuck_items 的 `item` 不得是 backlog；dependency_review 的 `canceled_blocker.item`、cycle members、`all_blocked.blocking_edges[].blocked` 必须 schedulable，而 `blocking_edges[].blocker` 可以是 backlog，但此时必须 `in_scope:false`。

2. **[HIGH] 所谓“与引擎同构”的 QA 查询仍漏掉 inverseRelations 分页。** §7 的查询固定 `inverseRelations(first:25)`，既不取它的 pageInfo，也没有按 endCursor 继续查询（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:219-221`）。生产引擎会显式读取 relation pageInfo 并循环调用 relations query 直到结束（`packages/teamlead/src/bridge/linear-epic-query.ts:304-343`）；如果前 25 条都是 completed、后续存在未完成 blocker，当前 QA 会把 waiting 误分为 free。建议在 QA 查询中加入 `inverseRelations.pageInfo { hasNextPage endCursor }`，并明确对每张后代单复用 `ACTIVE_SCOPE_RELATIONS_QUERY` 翻页到底、只保留 `type === "blocks"`，再做 counts 对账。

3. **[HIGH] C1–C5 的分块顺序仍无法兑现“每块结束 typecheck 必须绿”。** C1 把 snapshot item 的 `parent` 变为必填，但共享 `epicShapeSnapshot()` 要到 C5 才补 parent（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:98-110`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:140-153`；当前构造器见 `packages/teamlead/src/epic-page/__tests__/fixtures/epic-shape.ts:8-29`），因此 C1 后 typecheck 已会失败。类似地，C2 给 `computeGaps` 增加 parent 访问，而 EpicItem.parent 在 C3 才加入；C3 又令 `header.root_counts` 必填，但 generate 的投影要到 C5 才补（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:112-128`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:141`；当前投影见 `packages/teamlead/src/epic-page/generate.ts:368-415`）。建议把所有受必填类型影响的 fixture/构造器与类型变更放在同一编译切片，或把 C2–C5 合并成一个红绿循环；若坚持现有顺序，就删除“每块 typecheck 必须绿”，只在完整投影落地后执行全量 typecheck。

4. **[MEDIUM] `state.value === null` 的预期仍被 subtraction 的前置校验截断。** v2 明确把该 item 判为 not schedulable，并要求对应根仅以 `unknown_state_type/detail:"missing"` 缺失（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:20`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:81`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:186`）；但 `computeDependencyReview` 当前在任何域过滤之前遍历全部 items，只要任一 state/blocked_by missing 就抛错（`packages/teamlead/src/epic-page/subtraction.ts:10-20`），validator 随后必定调用它重算 dependency_review（`packages/teamlead/src/epic-page/model.ts:965-987`）。C4 列出的修改点没有覆盖这段 guard，因此计划声称的“该根 missing、其它根正常”文档无法通过校验。建议二选一并写测试固定：最简单是规定 Linear state Cell 必须非 null，删除 state-null 的 counts 降级路径；或者让 subtraction 的 known-state/blocked_by guard 只作用于 schedulable items，并增加一条完整 `assertEpicPage` 正向测试，证明 state-null item 只令所属 root_counts missing 而不会整页失败。

## Verdict

CHANGES REQUESTED — address items above

---

# Design Review — plan.md (Round 3)

Date: 2026-09-09
Author: Codex
Status: APPROVED

## Summary

v3 已完整闭合 Round 2 的四项问题：生产 QA 与 G14 一致，Linear 对账覆盖 children 与 inverseRelations 的完整分页，编译切片能够在必填类型传播后形成绿色边界，null state/blocked_by 也被统一改为 fail-loud。计划现在可在现有架构内按顺序实施，回归、可复算性、失败模式、容量与范围边界均有对应守卫。

## What's Good (Keep)

- 三格回归合同准确限定为 `.value` 的 canonical JSON，并用同一冻结输入对拍；subtraction 的边范围与 signals 聚合都使用 `isSchedulable`，生成器和 validator 同步修改（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:21-22`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:89-98`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:148-163`）。
- §7 已改为字段级断言：backlog blocker 可以保留为解释性跨域边，但必须 `in_scope:false`，与 G14 和 subtraction 单测完全一致（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:208`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:235-237`）。
- QA 查询现在覆盖递归 children 分页及每张子单的 inverseRelations 分页，并明确只保留 `type === "blocks"` 后再计算 waiting/free/idle；这与引擎现有的 relations 翻页路径一致（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:230-234`，`packages/teamlead/src/bridge/linear-epic-query.ts:304-343`）。
- S1–S4 编译切片正确处理了 snapshot、EpicItem、header.root_counts、规则、validator、投影和 fixtures 之间的必填类型传播；typecheck 只在完整切片末尾要求绿色，顺序可执行（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:100-109`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:214-224`）。
- null state/blocked_by 不再与 subtraction 的现有 fail-loud 行为冲突；未知但非 null 的未来 state.type 仍只使所属根 counts missing，并有完整 `assertEpicPage` 正向测试（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:64`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:82-87`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:130-141`）。
- counts.v1 的输入、父链归属、分类、确定序 provenance、Cell 包装和 validator 重算形成闭环；roots 唯一且与 items 不相交，避免 identifier 归属歧义（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:66-87`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:133-141`）。
- 实施边界仍保持克制：不改 attention/排序/CLI/StateStore，不引入迁移，不增加渲染内容，并保留 512KB 既有闸门与 QA 实测（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:167-188`，`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:238-250`）。

## Issues & Recommendations

No blocking issues.

1. **[Non-blocking implementation note]** G5b 的规范已经要求 `state.value` 或 `blocked_by.value` 为 null 时均由 `EpicPageSchemaError` 拒绝（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:199`）。实现时建议把 C2/C3 的 null 测试写成覆盖两个字段的 table-driven cases；C3 的详细测试清单目前只显式写出 state-null（`engineering/doc/FLY-2482-scope-v2-parent-counts/plan.md:141`），不要因此漏掉 blocked_by-null 分支。

## Verdict

APPROVED — ready to implement
