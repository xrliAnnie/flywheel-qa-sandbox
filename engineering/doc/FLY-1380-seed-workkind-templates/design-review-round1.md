# Design Review — FLY-1380 plan.md (Round 1)
Date: 2026-07-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

整体拆分方向是对的：FLY-1380 严格停在“创建 + 发布 dormant identity”，不写 live binding、不翻 per-project/generalized flag，也不重开 FLY-1407 已落的 selection/dispatch 面；`tpl_eng` 的 effort-less base + heavy preset、`tpl_eng_land_v1` 孪生、生产形状 dormancy fixture，以及 retire 的 store seam 都是合理的边界。

但当前计划还不能进入实现。源码复核发现三处会让新模板“能过 validator、能安装发布、实际却跑不通”的阻塞合同：`tpl_product_designer` 既缺 v2 物化必需的 `effort`，又违反 cross-vendor review；两份新 executor 约定的 output 不是当前 materializer 唯一接受的 `docs_v1` payload；prototype 的 `reject/shelve = 不能做并合法终态` 在现有 v2 terminal gate 上不可表达。另有 retire 后可再次绑定、跨项目 agent_file preflight 漏掉 `generic-executor.md` 等高风险缺口。以上必须先回写 plan 与测试矩阵。

## What's Good (Keep)

- **Scope 与上游裁定对齐。** 计划明确不改 binding、selection、runs-route、dispatch 谓词及 cutover prompt 资产，并正确采用 FLY-1407 founder correction：absent taskCategory 是 generic soft-fallback + reminder，不再写成 hard reject（`plan.md:13-17,170-177`）。
- **tier 合并机制本身成立。** 三套现有 eng seed 的 diff 只落在 design vendor/model、implement effort、QA model；`applyWorkflowOverride` 只能设置 effort、不能清除（`workflow-template.ts:1146-1208`），所以无 effort base + heavy 加 `xhigh` 是正确方向。selection 在缺 tier 时取 `DEFAULT_ENG_TIER`，且 tier 进入 selection digest（`workflow-template-selection.ts:221-257`），base 在正常 resolver 路径不会裸跑。
- **prototype 的 `max_iterations: 2` 语义正确。** 引擎在第 1、2 次 loop-back 后继续，只有第 3 次失败才因 `loopIteration > max_iterations` 进入 held/escalated（`StateStore.ts:18526-18578`），因此确实表达“最多修 2 轮”。designer 把开放细节循环放在 generic 节点内、把 DAG review kickback 设为有限逃生阀，也符合 v2 图表达能力的诚实边界。
- **import ungate 的两处定位准确。** 当前 import 层确实只有 bundle skip 与 store throw 两个门（`workflow-template.ts:1305-1321`; `StateStore.ts:13484-13492`）；revision/publish guards 与共享 dispatch predicate 保留后，production generalized-off 下 v2 仍 fail-closed。
- **dormancy 验收抓住了真实生产形状。** `ensureDefaultWorkflowBindings` 对“已有任何 binding 的项目”整体跳过（`workflow-template.ts:1337-1357`），所以“恰一行 `* → tpl_eng_heavy`”fixture + binding rows/audit 均零增量，比只测空库有意义。现有精确默认三行与二次 warm 零 audit 测试（`workflow-template.test.ts:16-46`）也应保留。
- **库存决策基本合理。** `tpl_eng_land_v1` 保持 eng identity 与 land twin 成对，避免 cutover 后只能引用待退休旧 identity；生产从未安装的 `tpl_ops_light` / `tpl_research_light` 从 bundle 移除也符合新 PRD 的“替换/并入”语义，前提是处理第 6 项列出的仍存消费者。
- **retire API 的基础形状可保留。** `not_found / refused_bound / retired / already_retired`、成功写 audit、无 unretire、执行留给 cutover，都是合适的最小写入面。

## Issues & Recommendations (numbered)

1. **[BLOCKER] `tpl_product_designer` 目前无法物化，修完后也无法启动 review。** 计划中的 `design_iterate` 没有 `effort`，且 producer 与 review 都是 Claude（`plan.md:79-101`）。v2 validator 会接受缺 effort 的 manifest，但真正构建 snapshot 时每个非 gate 节点都强制要求 pinned vendor/model/**effort**（`workflow-run-snapshot.ts:224-276`），所以首次选择会在 materialization 抛错。即使补上 effort，review admission 还会比较直接上游 producer 的实际 vendor，与 review vendor 相同就返回 `same_vendor_review`（`StateStore.ts:15852-15881`）；仓库已有专门回归证明该 invariant（`StateStore.generalized-execution.test.ts:259-335`; `StateStore.workflow-claims.test.ts:401-410`）。**建议：**给 `design_iterate` 明确 effort，并在 designer producer/review 之间选择 cross-vendor 组合；不要依赖未来 runtime override 偶然改 vendor。P6 必须新增“真实 `buildWorkflowRunSnapshotV2` 成功 + producer admission/完成 + review admission 成功”的流程测试，而不只是 validator 测试。

2. **[BLOCKER] 两份新 executor 的 output 合同不符合当前唯一 materializer，review 会永远等不到可审 head。** 计划把 designer output 写成“artifact 路径清单 + 说明 + founder 记录指针”，prototype 写成“启动命令 + 前置条件 + 证据指针”（`plan.md:120-133`）。但凡 `produces_output: true` 且直接接 review 的 `json_v1` output，Bridge 都会送进 `WorkflowDocsMaterializer`（`StateStore.ts:21067-21118`）；它把 payload 强制解析为 exact-key `{kind:"docs_v1", operations:[...]}`（`workflow-docs-materializer.ts:199-220`; `workflow-docs-output.ts:92-158`），路径还只能落在 `doc/`、`docs/` 或 `<pkg>/doc/`。当前 plan 描述的对象会被判为 permanent `docs_v1` failure，无法产生 review 使用的 materialized head；prototype 若要把任意源码写到非 doc 路径，也超出当前 materializer 能力。review dispatch 只拿 materialized git head，不直接拿原始 output payload（`workflow-engine-dispatcher.ts:1117-1142`），内置 review prompt 也只有泛化的一句检查要求（`workflow-run-snapshot.ts:122-130`），因此“独立复跑一条命令”不能靠 output 里一个不可见的指针兑现。**建议：**在 plan 中把两个 executor 的提交协议改成 `json_v1` 外壳内的 `docs_v1` discriminator + operations；明确所有待 review 的 HTML/Markdown/静态 prototype、启动命令和证据都被 materialize 到允许路径。若 prototype 必须写 doc allowlist 外的真实应用文件，这不是 seed-only 能力，需先补 engine/materializer 前置而不能继续宣称当前形状可跑。测试必须覆盖 output submit → docs materialize/push-confirmed head → review dispatch，并断言 reviewer checkout 中真的存在启动命令与可运行资产。

3. **[BLOCKER] `reject/shelve = 不能做并合法终态` 不存在于现有 v2 gate 状态机。** plan 图和 executor 合同把 prototype founder gate 的 reject/shelve 当作合法完成（`plan.md:42-45,128-133`），但源码只有 `founder_approval` 会为 v2 写 `founder_approved` claim 并把 `workflow_run` 置 `completed`（`StateStore.ts:19704-19743,19811-19837`）。负向 gate response 会写 `founder_feedback` source（`write-gate-response.ts:483-555`），而 projector 明确只允许它作用于 **v1 land** manifest；v2 会抛 `founder feedback source payload invalid: run state`（`StateStore.ts:19615-19636`），随后被 projector 视为 terminal poison 并 dead-letter（`founder-approval-projector.ts:68-71`）。通用 dashboard `reject/shelve` 只走 session FSM（`actions.ts:1931-1960`），不会终结 engine-owned workflow run；gate 卡文案本身也是 “ready to ship / approve exact head”（`gate-materializer.ts:82-95`）。**建议：**不能再以“现有动作面”作为论据。要么为 v2 terminal gate 设计并实现有理由的 negative terminal decision（含 holder/source/claim/run completion/UX），要么取得产品方对另一套可表达语义的明确修订并把它列为 cutover 前置；在 FLY-1380 seed-only scope 下，后者通常意味着该 template 先保持不可 cutover，而不是假装 reject/shelve 已工作。验收必须分别驱动“能做”和“不能做”，两者都断言 run terminal、holder/source 无残留、零 deadletter。

4. **[HIGH] retire 只检查“退休当下零 refs”，没有封住退休后的新 binding，fail-closed invariant 不完整。** 当前 `bindWorkflowCategory` 只检查 template 存在与 project scope，不检查 `retired_at` 或 publication（`StateStore.ts:13591-13633`）；binding 选择路径也不会像 direct templateId 路径那样检查 retired（`workflow-template-selection.ts:58-103`）。因此模板可以先成功 retire，随后被重新 bind，并由 binding 路径继续选中。**建议：**同一改动补 `bindWorkflowCategory` 的 fresh-eligible guard（至少 published 且未 retired；如需最强不变量可用 DB trigger），并把模板存在/已退休/binding refs 检查、`retired_at` update、audit insert 放在同一事务。actor/reason 应 trim 后强制非空，refs 应确定性排序；异常旧库若出现“already retired but still bound”，优先 `refused_bound`/显式报 invariant，不要用 `already_retired` 隐藏。测试至少加“retire 后 bind 被拒且零 binding/audit residue”与 binding/direct 两条 fresh 路径。

   audit CHECK 重建也要钉住对象恢复顺序：现表有 append-only update/delete/no-replace triggers 与 template index（`StateStore.ts:2803-2862`），DROP/RENAME 会丢这些对象。把 rebuild 放在 trigger/index 创建之前，或显式重建它们；迁移测试除“两次开库不再重建”外，还要断言旧 rows/id 保留、CHECK 含新旧全集、UPDATE/DELETE 仍失败、index/trigger 均存在。

5. **[HIGH] cutover preflight 漏掉了 `agents/generic-executor.md`，且应该从 manifest 派生而不是硬编码两个新文件。** plan 只要求 designer/prototype 两个文件（`plan.md:179-184`），但未改的 `tpl_product_v1` 的 research/produce 都引用 `agents/generic-executor.md`（`workflow-seeds/tpl_product_v1.yaml:7-27`），新 `tpl_generic` 又逐字复制同一引用。`readAgent` 始终相对**目标项目 canonicalRoot**做 realpath/read，并不会回退到 Flywheel 安装目录（`workflow-run-snapshot.ts:99-120`）。所以非 Flywheel 项目即使有两个新文件，prd/research/generic 路由仍会在 materialization 炸掉。**建议：**cutover preflight 遍历五个目标 manifest 的全部 generic node，收集/去重 `agent_file` 并逐项目校验可读、非空、未越界、未超 contract；当前集合至少是 `generic-executor.md`、`designer-executor.md`、`prototype-executor.md` 三个。P6 也要对所有 v2 seed 在真实临时 canonicalRoot 上构建 snapshot，文件卫生测试不能替代 materialization。

6. **[MEDIUM] “bundle 消费者只有 import + 测试”的盘点不完整，删除两个 seed 会留下失败的可执行 QA 资产。** 除 `workflow-template.test.ts` 与 `StateStore.workflow-templates.test.ts` 仍直接断言/查找旧 IDs 外，`scripts/qa-fly-1281-generalized-template-e2e.mjs` 多处使用两者，`scripts/qa-fly-1307-template-dispatch-e2e.mjs:692` 也用 `tpl_ops_light` 做 v2 sentinel。删除 YAML 后这些脚本无法按原合同重跑。**建议：**在 P2/P6 文件清单中逐一决定：迁到 `tpl_generic`/新的 output-producing seed 并更新断言，或明确退役脚本并让它 fail-fast 指向替代验证；不要留下貌似可执行、实际引用已删除 identity 的脚本。历史 design/QA 文档可保留原事实，不应机械改史料。

7. **[MEDIUM] 收紧“逐字节复现”和“dormant”的可测定义，避免测试绿但合同说过头。** `applyWorkflowOverride` 会删除 `tier_presets`（`workflow-template.ts:1158-1163`），所以三档及 land twin 都可以比较**完整 effective manifest**，没有理由只 deep-equal nodes（`plan.md:75,158`）；应包含 edges/loops/gates/ship_claims。另一方面，新 template identity/revision、tier/category provenance 与 selection digest 本来就会不同，不能把“节点行为等价”写成完整 snapshot/digest 字节相同。建议明确：兼容目标是 applied manifest/dispatch config 与旧 seed 相同，selection/snapshot provenance 按新 identity 正常变化。

   同样，`leadTemplateId` 明确绕过 binding lookup（`workflow-template-selection.ts:67-71`），所以 `plan.md:114` 的“无 binding 到不了”只对普通 category selection 成立；generalized flag 打开后，显式 `templateId + selectionReason` 仍可选这些已批准 identity，这是权威 PRD 本就允许的路径。把 dormant 定义改成“不会由 boot/default/category binding 自动路由，且当前 production generalized-off 下显式 v2 也被挡”，并补 off/on × ordinary category/direct override 矩阵。warm 验收比较排序后的 binding **逻辑行集及 audit 计数**，不要把同库 template burst 下的物理 SQLite 文件 bytes 叫作 table byte-identical。

## Verdict

CHANGES REQUESTED — address items above
