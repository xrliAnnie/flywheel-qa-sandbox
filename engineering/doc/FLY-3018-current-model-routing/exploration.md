# FLY-3018 新派单按当前模型配置选模型 — 探索
Issue: FLY-3018 (https://linear.app/geoforge3d/issue/FLY-3018/引擎路由-派单不带覆盖时老单的实现节点opus被解析成-codex-模型gpt-6-astra-gpt-56-sol回执仍写-opus)
日期: 2026-09-28
基于: 无

## 0. 本次 run 的性质（先读）

这是 FLY-3018 的**重开 run**，Lead 2026-09-28 16:1x PDT 明确「只重做 QA」：

- 代码已在 PR #1381（真仓 `xrliAnnie/flywheel`，分支 `flywheel-FLY-3018`）落地，并经 Codex 代码复审 3 轮。
- 上一轮 QA 体（94aed2f4）在 8245a81f 上**产品证据全过**，但 workflow 判 FAIL 只因流程缺口：强度二记录走了 `manual_test_deploy` 通道（被 judge 写死为 `lane_unproven`），且 primary PR identity 缺失。
- 上一轮 QA 体已死，引擎不换替身，故终结重开。本 run 的 implement 节点 ⛔ 不改代码，QA 节点重跑证据。

因此本设计节点的交付物不是「设计一个修复」，而是：

1. **审计**已落地修复与 Lead 重开说明之间的事实差异（尤其是精确头）；
2. 把上一轮 QA 的缺口翻译成本轮 **可执行、可判定** 的验收计划；
3. 给 implement 节点一份「零改动、直接交卷」的边界说明。

本 worktree 是 QA 沙箱仓（`flywheel-qa-sandbox`），里面**没有** `workflow-menu.ts` 等产品代码；产品代码只在真仓与 QA 房源（`~/.flywheel/state/qa-rooms/<room>/src`）。设计文档落在本沙箱分支，是本 run 的过程产物。

## 1. 问题回顾（founder 视角）

founder 2026-09-28 07:56 PDT 直问：「每一个节点我们要用哪些模型、effort 以及比例……你为什么不能 follow 那个去走呢」。

同日 15:12Z 不带任何覆盖派单（`taskCategory: simple_code`）：

| 单 | run | 回执 | 实际起体 |
|---|---|---|---|
| FLY-2405（老单） | 50dec89a | `implement: opus (= gpt-6-astra)` | gpt-6-astra（Codex） |
| FLY-2909（老单） | 0fa033c1 | `implement: opus (= gpt-5.6-sol)` | gpt-5.6-sol（Codex） |
| FLY-3017（新单） | — | `implement: opus (= claude-opus-5-5)` | 正确 |

models.json 当前 implement 为 opus 3 : codex 1（arm `impl_opus` / `impl_sol56`，没有 astra），`bindings.opus = claude-opus-5-5`。回执标签与实际模型不一致；48h 统计 implement 节点 Codex 175 : Opus 26，其中 gpt-6-astra 53 个。

## 2. 已查实的根因（继承上一轮设计，本轮在源码上复核）

根因**不是** `opus` 别名绑定变成 Codex。是两层叠加：

1. **选择层**：`workflow-template-selection.ts` 的 `resolveAutomaticModelSplit` 先按当前 modelSplit 算出选择，随后用 `StateStore.listWorkflowModelAssignmentEventsForIssue` 查这张 issue **所有历史 run** 的 weighted assignment 并覆写当前结果——不比较策略版本、已终止 run 也算（origin/main `:125` 仍存在此分支）。老单沿用旧 policy 时代的 `impl_astra` / `impl_sol56`，新单没有历史所以正确。
2. **显示层**：`workflow-menu.ts` 的 `pinMenuReceiptsToRun` 用正则拆出当前菜单别名，只替换括号里的 exact、保留别名与 effort，拼出 `opus (= gpt-6-astra)`。

## 3. PR #1381 已落地的修复（本轮复核形态）

| 层 | 修复 | 位置（PR 头） |
|---|---|---|
| 选择 | 删除跨 run 历史覆写；新 start 只读当前 models.json 的节点 arm、权重、bindings、arm effort；同 reservation 重放与同 run 恢复仍读本 run 冻结记录 | `workflow-template-selection.ts:99` `resolveAutomaticModelSplit`（无 store 参数、无历史查询） |
| 预准入 | `readFrozenRunModelAssignments` 对每条 start 路径校验本 run 冻结 assignment，自损 run 在准入前拒绝（稳定 409），原 run/reservation 原样保留 | `workflow-template-selection.ts:136` |
| 回执 | 回执从本 run 冻结记录重建；别名只在「同 runtime vendor 且同 id 或同注册表家族+同 1M 变体」时保留，否则用 exact 自标；effort 走与 launch 相同的 `narrowEffort` | `workflow-menu.ts:1094` `aliasNamesModel`、`:1124` `pinMenuReceiptsToRun` |
| QA 工具 | 驱动 `qa-529-generalized-e2e.mjs --no-overrides`；`noOverrides` 纳入 `GeneralizedRerunSpecV1.driver`；`room drill --no-overrides` 贯通 CLI→Bridge schema→driver argv→`rerun_spec` | `strength-two-contract.ts`、`commands/room.ts`、`qa-room-contract.ts`（提交 `16847c397`、`950870cee`） |

## 4. 本轮发现的事实差异（需要 Lead 裁定）

**Lead 重开说明写房子精确头 = `76cf3c249`；但 PR #1381 当前头是 `7e28dd51c`。**

`76cf3c249..7e28dd51c` 多出：

- `5dab14d4c` merge origin/main（带入 FLY-2957/3027/2909/2407/qa-rooms 五个已合并 PR）；
- `950870cee` fix: preserve no-overrides in room reruns —— 正是上一轮 QA 指出「注册的 rerun driver 写死了 overrides」的修复；`76cf3c249` 只有直连 driver 的 `--no-overrides`，强度二的 `rerun_spec` **表达不了** no-overrides；
- `97db7c68e` fix: sync QA prompt fixture —— 修 `76cf3c249` 之后 exact-head full CI 在 `Blueprint.generalized-workflow.test.ts:620` 的红灯（qa.md 加了 `--no-overrides` 说明后 FLY-2533 pinned fixture 与预算失配）。

两头 full CI 均绿（`76cf3c249` run 36496804828；`7e28dd51c` run 36504079616）。但只有 `7e28dd51c` 才能在真房用 `generalized_e2e_real` 通道拿到「rerun_spec 带 noOverrides:true」的可判定强度二证据，也只有它 = local = origin = PR 头（implement 节点被要求核对三者一致再交卷）。

已通过 `ask` 提交 Lead 裁定（question `c43580f2-d4cb-41db-835f-65e1971d6813`）。本设计**默认按 `7e28dd51c` 规划**；若 Lead 坚持 `76cf3c249`，则 QA 计划 §4.3 的强度二一项须显式记录缺口并 ask Lead，不硬判。

## 5. 方案空间（本轮只有验收方式可选）

| 方案 | 内容 | 判断 |
|---|---|---|
| A. 沿用 `manual_test_deploy` 通道 | 手动起房、手动派单、手动记录 | ✗ judge.ts:110 写死 `lane_unproven`，上一轮就是这样 FAIL 的 |
| B. `generalized_e2e_real` + `room drill --no-overrides` | 由 Bridge 起房（Lead 起）、runner 用 `room drill --real --no-overrides` 驱动，服务生成的 `rerun_spec` 含 `noOverrides:true`，`evidence-run record` 用同一 spec | ✓ 推荐；这是 `950870cee` 存在的全部意义 |
| C. 只跑单测/CI 不进真房 | 局部绿 | ✗ 不满足 Lead「真房重跑不带 overrides 派单矩阵」的判据；也不能证明 receipt = runtime = sessions.runner_model |

选 B。

## 6. 假设（显式列出）

1. Lead 会把房头改为 `7e28dd51c`，或明确说不改。
2. 房是 slot 3、`--generalized`、Claude runner（`room drill` 对 Codex-runner 房和非可复现设置会拒 `drill_config_not_reproducible`）。
3. 房内 models.json 与生产同形（implement opus 3 : codex 1）；如需在两次 drill 之间改房内权重来证明「历史不再牵引」，参数变更由 Lead 做。
4. 本设计节点不派单、不起房、不终止任何 run。

## 7. 非目标

- 不重新设计路由（已批准方案「新 run 读当前配置、同 run 冻结」不变）。
- 不改代码、不重开代码评审、不扩大到统计平台或 quota fallback。
- 不替 QA 节点做判定；只给可执行的判据与命令。
