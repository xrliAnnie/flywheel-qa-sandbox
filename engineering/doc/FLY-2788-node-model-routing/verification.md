# FLY-2788 节点模型分流 — 验证
Issue: FLY-2788 (https://linear.app/geoforge3d/issue/FLY-2788/2787-a分流引擎-每个节点按定稿选模型设计三组-astraopus-55fable-51-各-13实现-opus-55qa-gpt-6)
日期: 2026-09-23
基于: plan.md

## 结论与边界

实现节点的目标验证已通过：按 issue UUID + node 稳定分组，三个节点使用互相独立的哈希输入；实际 writer model 决定设计/代码评审的跨家族路由；QA 同家族只在 QA 节点的窄豁免内留下审计；实现节点只有在服务端证实 Codex 全池耗尽时才可降级到 Opus，并写 degraded receipt、排除正常成绩。

本文件记录的是本地目标验证，不是 full-suite 或 exact-head CI。实现节点未请求 full CI、未派 QA、未改生产 `~/.flywheel/models.json` 或生产模板、未重启、未部署。`fleet/example/models.json` 只是仓库示例配置。

QA 在旧头 `625196e05` 的 exact-head CI / 隔离派单发现两个真实阻断：生产 `/api/runs/start` 使用人类可读 `issueId=FLY-2788`，同时以 UUID 作为 `issueKey` / `entryRootKey`，旧 guard 会把所有 weighted dispatch 拒为 `workflow_model_assignment_invalid:eng_design`；FLY-2775 前置新增的 147 个 rule bytes 也让两个冻结 bundle/budget oracle 变红。本次 rework 在不改分流设计的前提下修复这两点；新 HEAD 的 exact-head full CI 仍由 QA 请求和判定。

## 模型与分组证据

冻结策略版本：`fly2788-v1:5666df74cebb0c09ff245558c98775ef7ee97e2c5db83ce1f9d3610be5506408`。

1000 个固定 UUID 的实现节点计数：

| arm | 计数 | 比例 |
|---|---:|---:|
| `impl_opus` | 508 | 50.8% |
| `impl_sol56` | 246 | 24.6% |
| `impl_sol6` | 246 | 24.6% |

120 个固定 UUID 的三节点计数：

| 节点 | arm | 计数 |
|---|---|---:|
| design | `design_astra` / `design_opus` / `design_fable` | 44 / 38 / 38 |
| implement | `impl_opus` / `impl_sol56` / `impl_sol6` | 58 / 30 / 32 |
| QA | `qa_sol56` / `qa_sol6` / `qa_opus` | 56 / 35 / 29 |

设计 × QA 列联表：

| design arm | `qa_sol56` | `qa_sol6` | `qa_opus` |
|---|---:|---:|---:|
| `design_astra` | 15 | 14 | 15 |
| `design_opus` | 24 | 7 | 7 |
| `design_fable` | 17 | 14 | 7 |

固定向量测试还逐项断言：同一 issue/node 重复解析不变；同一 issue 的 design 与 QA bucket 不相等；冻结 assignment、重派、返工和恢复均重放原 arm/model receipt，而不是重新抛硬币。

## 路由、安全与负向证据

- 设计评审：`design_astra` 的实际 writer 为 Codex，评审走 Claude；`design_opus` / `design_fable` 的实际 writer 为 Claude，评审走 Codex。
- 代码评审：`impl_opus` 的实际 writer 为 Claude，评审走 Codex；`impl_sol56` / `impl_sol6` 的实际 writer 为 Codex，评审走 Claude。若 writer 因合法降级实际变为 Opus，评审也按实际 Claude writer 走 Codex，而不是按原 arm 猜测。
- QA：同家族仅允许 `node_id=qa`，服务端核对最新 producer run/node 后写审计；伪造 node、过期 producer 或不匹配 model 均拒绝。
- 候选名单：从某节点移除目标模型时，派单以 `MODEL_NOT_ALLOWED_FOR_NODE` fail closed；没有静默改派。
- Codex 降级：仅实现节点、仅 Sol arm、仅服务端可验证的全池 exhaustion；写 `model_arm_degraded` receipt，保留原 arm/assigned model，记录 actual Opus model，并从原组成绩统计排除。设计、QA 或局部/不可验证配额事实不能触发该路径。
- 分组平衡开关默认关闭；打开但没有受支持的分数/配额输入时以 `MODEL_SPLIT_BALANCE_INPUT_UNAVAILABLE` fail closed，未实现推测性的动态调权。
- 旧 percentage split、冻结运行快照、人工 override 和产品单节点默认保持既有语义；`fly2403-v1` registry 闸门保留。

## 本地验证结果

| 命令/集合 | 结果 |
|---|---|
| `pnpm lint` | exit 0；26 个既有 warning，0 error |
| `pnpm --filter "flywheel-teamlead..." build` | 13 个 workspace package 及依赖构建通过；native reclose 构建通过 |
| `pnpm --filter "...flywheel-config" typecheck` | 13 个 config 依赖方全部通过，包括 teamlead、voice-bridge、voice-codex |
| `pnpm --filter "...flywheel-teamlead" typecheck`（R2） | teamlead 与下游 voice-codex 均通过 |
| config `vitest related`（4 个改动生产文件） | 25 files，397 tests，全绿 |
| teamlead `vitest related`（16 个改动生产文件） | 605 files，8423 passed，4 skipped；1495.50s |
| R1 修正 `vitest related`（`runs-route.ts` + 路由回归测试） | 107 files，1334 passed，1 skipped；586.15s |
| R2 点名 4 文件 | 152 passed，2 skipped；含 menu、template selection 与 HTTP route |
| R2 `vitest related` | 604 files，8412 passed，4 skipped；1327.39s；巡检指令到达 inbox 时进程已完成，未重跑 |
| R3 点名 4 文件 | 152 passed，2 skipped；只跑直接文件，未再跑 related |
| QA rework weighted-dispatch RED / GREEN | 同一条生产形状回归修正前报 `workflow_model_assignment_invalid:eng_design`，修正后 1/1 通过 |
| QA rework bundle/budget 两个直接文件 | 2 files，7/7 通过；`bodyBytes=241533`，SHA-256 `ab73159f9533d9786b8179a9ba850bedaaa877b35ca40153ec8403407c024356` |
| QA rework teamlead `vitest related` | 567 files：565 passed、2 timeout；7965 passed、4 skipped；两个 timeout 分别隔离重跑 1/1 通过 |
| QA rework `pnpm lint` | exit 0；26 个既有 warning，0 error |
| QA rework `pnpm --filter "flywheel-teamlead..." build` | 13 个 workspace package 及依赖构建通过；native reclose 构建通过 |
| QA rework `pnpm --filter flywheel-teamlead typecheck` | 通过 |
| `runs-route.dag-entry.test.ts` 最终重跑 | 71/71 通过；含手动模型覆盖及带无关 effort 覆盖的冻结 arm 重放 |
| 13 个直接策略/路由测试文件 | 331/331 通过 |
| `bash scripts/__tests__/design-model-split.test.sh` | PASS：weighted/percentage CLI、rollback、safety、strict input、preservation |
| `bash packages/teamlead/scripts/__tests__/fly241-lead-model-override.test.sh` | 17/17 通过 |
| `bash scripts/__tests__/fly1496-model-policy.test.sh` | 4/4 通过 |
| `bash scripts/__tests__/fly1496-qa-acceptance.test.sh` | 11/11 通过 |
| changed-file `biome check` | 57 files checked；0 error；`StateStore.ts` 因仓库 1 MiB 上限跳过；2 个既有 `plugin.ts` useConst warning、2 个测试 useTemplate info |
| `git diff --check` | 通过 |

第一次运行 Lead shell 用例时 `inbox-mcp/dist` 尚未构建，启动器按契约禁用 inbox channel，因此 OFF bundle 不含 inbox rule。构建既有 `flywheel-inbox-mcp` 后原用例 17/17 通过，没有代码修复。第一次依赖方 typecheck 同样读取到同步前的 `voice-bridge/dist` 声明；构建 sibling dist 后，完整 13-package typecheck 一次通过。

合并主线前的 related 运行曾有 `statestore-ghost-realprobe.qa.test.ts` 因真实 tmux server 意外退出而 3 项 `indeterminate`；当时单文件立即重跑 4/4。首次实现的最终完整 related 运行中该文件直接 4/4 通过，且总汇总为 605/605 files green；没有 worker RPC timeout。

## 代码复审 R1 / R2 修正

R1 指出：HTTP 路由在调用方没有提交 `overrides` 时，仍把当前策略自动解析出的 override 作为显式 override 传给选择器。若同一 issue UUID 已有冻结 arm、期间策略权重变化，选择器先正确恢复旧 arm，随后却会把它与“当前策略的伪显式 override”比较并报 `workflow model split override conflict:<node>`，导致重派 409。

R1 的初次修正只处理“请求没有 `overrides`”的路径。R2 继续指出两条同根路径：新请求手动指定某节点模型时，路由仍把同节点的自动 arm 一并传入并报冲突；已有冻结 arm 的新 run 即使只带空 override 或另一节点的 effort，当前策略解析出的全量节点值仍会被误当作手工要求并报 409。

最终修正把调用方意图与解析结果分开：`resolveMenuOverrides` 额外返回只含调用方实际字段的稀疏 override；路由把它作为显式 override，并把原始、已验证的 menu 字段单独交给自动选择器。选择器不再为手动指定 model 的节点生成或恢复自动 arm；其他节点仍按同一 issue/node 的冻结 receipt 重放，并可合并调用方只指定的 effort。原有真实手工冲突检查没有放宽。

HTTP 回归先以新 UUID 手动指定 implement=`fable/high`：修正前稳定返回 409，修正后返回 200，且 implement 没有伪造的 `model_arm_assigned` receipt。随后同一稳定 UUID 完成首次自动派单、终止运行、修改 implement 权重，并在新请求里只覆盖 `eng_design.effort=high`；修正后仍返回 200，三个 arm receipt 与首个 run 完全一致。最终路由套件 71/71，点名 4 文件为 152 passed / 2 skipped；package-plus-dependencies build、`pnpm lint`（0 error、26 个既有 warning）、teamlead dependent typecheck、4-file Biome 与 `git diff --check` 均通过。

## 代码复审 R3 修正

R3 指出 selector 允许 `menuOverrides` 与稀疏 `override` 独立传入：在没有项目 adoption 文件或 work-kind 关闭的路径，只有前者存在。自动解析会正确跳过手动 model 节点，但合并函数只从 `override` 初始化节点，因此把手动 model 丢掉并静默回落到模板默认。

新增 selector 直接回归只传 `menuOverrides: { implement: { model: "fable", effort: "high" } }`。RED 实际 dispatch 为模板默认 `claude-opus-5-5/xhigh`；最小修正把自动解析出的节点作为合并底值，再让稀疏显式字段覆盖。GREEN 实际 dispatch 为 `claude-fable-5-1/high`，且 implement 仍没有自动 assignment。修正后仅运行 4 个点名测试文件（152 passed / 2 skipped）、lint、package-plus-dependencies build、teamlead dependent typecheck、5-file Biome 与 `git diff --check`；遵循 Lead 指令没有再次运行 related。

## 代码复审 R5 修正

R5 指出两条 HIGH。第一条是冻结 assignment 重放把“不在当前较窄模板里的旧节点”误判为模型不可用：同一 issue 从 `code` 模板重派到 `simple_code` 时，历史 `eng_design` assignment 会阻断新派单。回归先稳定 RED 为 `prior workflow model assignment unavailable:eng_design`；最小修正只跳过当前 menu 不存在的历史节点。当前节点仍存在但其 alias/model 不可用时继续 fail closed。修正后同一 UUID 从 `code` 重派到 `simple_code` 成功，且只保留 `implement` / `qa` assignment receipt。

第二条是 FLY-2788 的 reviewer-model 路由从可变的 legacy session `runner_model` 推断作者，导致没有 workflow `modelRouting` 快照的旧执行也进入新路由，并关闭 FLY-2763 既有的 sanctioned lane。新增回归先证明 legacy session 会错误返回 route、sanctioned lane 会返回 409；最小修正把路由限定为“绑定 workflow run 且快照显式含 `modelRouting`”，并仅信任 immutable workflow runtime 的 model/vendor。未采用 FLY-2788 路由的 legacy 执行继续走既有 FLY-2763 行为；已采用路由的 run 若快照损坏或缺 immutable runtime，仍显式报错。

修正后的三个核心直接文件为 196 passed / 2 skipped，legacy event-route 文件为 27/27。五个改动文件的 `vitest related` 扩展到 123 个文件，其中 122 个文件通过；唯一失败文件只有两条仍期待 legacy 执行注入 FLY-2788 reviewer-model 文案的旧断言（1704 passed / 2 failed / 3 skipped）。按新的真实边界修正这两条预期后，该文件直接与 related 均为 27/27。记录该次宽 related 含两条已修正的旧预期失败，不把它声称为最终全绿或 full-suite 证据。最终 `pnpm lint` exit 0（26 个既有 warning、0 error）、`pnpm --filter "flywheel-teamlead..." build`、`pnpm --filter flywheel-teamlead typecheck` 与 `git diff --check` 均通过。

复审的三个 MEDIUM/LOW advisory 不在本次 HIGH 修正范围：QA 自定义图同家族窄豁免的 defense-in-depth、非 xhigh 实现节点的降级可用性陷阱、旧 fixed-template reservation replay 的窄兼容性。它们不改变 effective review gate；若新一轮通过，将按协议完整回报 Lead 作为后续候选。

## QA 回流修正

生产 runs route 把卡号和 canonical UUID 分别传为 `issueId` 与 `issueKey`，并把根 UUID 传为 `entryRootKey`。旧 StateStore guard 额外要求 `entryRootKey === issueId`，这与真实入参形状冲突；而 assignment 本身已经由 `basis.issueKey === input.issueKey`、`basis.nodeId === nodeId` 和完整 weighted receipt 重算共同约束。回归测试先改为真实生产形状并稳定 RED，最小修正只删除这条重复且错误的 identifier/UUID 比较，保留其余身份、节点和 receipt 校验。负向用例改为真正篡改 assignment basis 的 root UUID，仍以同一错误 fail closed。

FLY-2775 前置对 `model-routing.md` 的 current-family alias 说明使 OFF bundle 增加 147 bytes，并让冻结 bundle hash 与 25% savings budget 同时失败。没有放宽阈值或删除前置语义；只压缩等价文案，使该文件相对 `origin/main` 净增 2 bytes，并更新冻结 oracle 的语义说明、长度与 hash。两个直接 oracle 文件 7/7 通过。

对 `StateStore.ts` 与其回归执行的 `vitest related` 扩展到 567 个文件：565 个文件通过，`actions.test.ts` 与 `ChatThreadCreator.test.ts` 各有一条在 24 分钟并发运行中超时；两条分别隔离重跑后均通过（0.8s / 0.15s）。因此记录为 related 运行含两条资源争用 timeout + 隔离通过，不把该次运行声称为全绿或 full-suite 证据。最终 lint、package-plus-dependencies build、owning-package typecheck 与 `git diff --check` 通过。

## QA@2 主线同步返工

按 Lead 指令以 merge（非 rebase）把 `origin/main` 的 `fef2dd43d` 同步进本分支。唯一文本冲突在
`StateStore.ts` 的 quota-store import，保留了 FLY-2788 的 `CodexPoolExhaustionFact` 与主线
FLY-2762 的动态 `CodexQuotaPoolMember` / `currentCodexPoolMembers` 接线。语义审计另发现静默
auto-merge 的真实缺口：FLY-2788 的 `getCurrentPoolExhaustionFact` 仍把 `observation_json` 当旧数组，
而 FLY-2762 已写成带 pool 身份的 v2 envelope，导致五号池全灭时降级 receipt 不再生成。

最小修正复用主线的 latest-evidence 与 current-pool guard，只在当前动态池与冻结证据身份一致且仍
全灭时返回 exhaustion fact，并从 v2 evidence 中只回放当前池成员。测试覆盖相同动态池可生成 fact、
新增或换号池成员时 fact 失效，以及 workflow 侧实际生成 `model_arm_degraded` receipt。

本轮点名验证：`StateStore.codex-quota`、`workflow-template-selection`、
`workflow-dispatch-resolution` 共 73 passed / 2 skipped；`workflow-review-routing` 13/13；
`codex-quota-coordinator` 13/13。`pnpm lint`、`pnpm --filter "flywheel-teamlead..." build`、
`pnpm --filter flywheel-teamlead typecheck` 与 `git diff --check` 均通过。按 changed-file 运行的
`vitest related` 因 quota store 经 `StateStore` 扩展成近似整包集合，违反本地不得跑整包的门禁，
确认依赖扩散后以 SIGINT 停止；它不是通过证据，保留的直接消费者已由上述点名文件全部覆盖。
新 HEAD 的 exact-head full CI 仍只由 QA 在冻结头发起。

## Founder 催发货后的第二次主线冲突返工

按 Lead 指令再次以 merge（非 rebase）把 `origin/main` 的 `049fbf194` 同步进本分支，merge commit
为 `a6bf34b85`。本次文本冲突严格限于 `StateStore.ts` 与 `workflow-model-assignment.ts`：前者同时
保留 FLY-2788 的 weighted assignment / identifier-to-UUID 根键校验、降级与 QA 审计事件，以及主线
FLY-2789 的 scorecard activation 写入；后者同时保留 weighted receipt 校验器与主线 assignment /
degradation scorecard reader。没有改动权重、候选、review 路由或生产配置。刷新时 FLY-2775 尚未进入
`origin/main`，预告的 `model-routing.md`、`legacy-bundle.json`、`workflow-menu.test.ts` 三处没有发生
第二轮冲突；其前置提交仍已存在于本分支。

本轮按返工范围只跑点名测试与 Biome：`StateStore.generalized-execution`、`StateStore.codex-quota`、
`workflow-template-selection`、`workflow-review-routing`、`workflow-scorecard` 共 143 passed / 2 skipped。
Biome 对 `workflow-model-assignment.ts` 检查通过；`StateStore.ts` 因仓库既有 1 MiB 上限（文件 2.8 MiB）
被工具明确跳过，不把它声称为已格式化检查。主线带入文档中的既有尾随空格未在本次顺手改写；两处
手工冲突文件自身的 diff check 通过。没有运行本地 full package suite，也没有请求 full CI。

## 消费者发现与取舍

对每个改动生产文件分别以完整路径、文件名和父目录执行 `git grep -lF`。保留并运行所有语义消费者：config 导出/registry/split 测试，workflow admission、snapshot、retry/rework、review routing、quota/degradation、event/manifest/runs route 测试，三个 shell acceptance，以及 claude-runner 与 token-usage 的直接消费者。

R1 / R2 / R3 修正对 `workflow-menu.ts`、`workflow-template-selection.ts`、`runs-route.ts` 与两个回归文件重复执行了同样三组查询。可执行消费者由点名的 menu、selection 与 route 测试覆盖；测试文件没有被其他生产代码引用。父目录查询的大量命中按下列既有分类逐项排除，未发现新的语义消费者。

QA rework 对 `StateStore.ts`、`workflow-template-selection.test.ts`、`model-routing.md` 与 `legacy-bundle.json` 同样以完整路径、文件名和父目录查询。保留 StateStore related closure、workflow selection 直接回归、rule bundle/budget 两个 oracle；纯文档、历史清单、生成物和只含通用 basename/目录名的命中按下列分类排除。文本 rule 与 JSON fixture 自身的 `vitest related` 无测试命中，因此以其直接 oracle 文件为证据。

R5 对六个改动文件也完成完整路径、文件名和父目录三组查询。保留的可执行消费者是 `runs-route.ts`、`design-review-manifest.ts`、`event-route.ts`、`review-request-coordinator.ts`，以及 workflow menu/selection、review routing、review coordinator、Codex trigger 的直接测试和 123-file related closure。源码自身、纯文档/静态清单、生成物、通用 basename/父目录命中及仅测试 fixture 的命中按下列同一分类排除。

排除项逐类记录如下：

- 改动源文件自身：不是独立消费者。
- `engineering/doc/**`、milestone 与本任务 HTML：说明/证据，不执行生产逻辑。
- `dist/**`、coverage、构建缓存和 `node_modules/**`：生成物或第三方文件；验证前已重建需要的 sibling dist。
- 仅命中通用 basename 的非消费者：`index.ts`、`actions.ts`、`plugin.ts`、`StateStore.ts`。
- 仅命中通用父目录名的非消费者：`src`、`bridge`、`config`、`scripts`；这些匹配没有引用具体改动符号。
- 测试 fixture 中只用于字符串/源码扫描的匹配：保留其所属直接测试，但不把 fixture 文件单独当作可执行消费者。
- 未改的生产 `models.json` / 模板与生产数据库：任务明确禁止本节点修改或用其作为本地证明。

## 设计页验证

提交的 HTML 结构检查通过：10 sections、10 textareas、13 个唯一 id、内联 script 语法通过、无旧文案。托管静态源码/CSP 已在设计阶段核验。macOS 沙箱拒绝 Mermaid/QuickLook 的 MachPort/GUI 渲染，因此没有伪造截图；这不是浏览器视觉通过证据，真实 pane/视觉验收仍属于后续 QA。

## 未声称的证据

- 旧头 `625196e05` 的 exact-head full CI 已由 QA 判为失败并触发本次 rework；新 HEAD 尚无 exact-head full CI，也不把本地 related 或 `CI Scope OK` 当作 CI 通过。
- 没有生产 session/run、真机 pane 首屏或部署后 30+ 实单证据；这些由 QA/部署窗口在冻结 HEAD 上完成。
- 没有改生产模型配置、发布模板、重启服务、合并 PR 或部署。
