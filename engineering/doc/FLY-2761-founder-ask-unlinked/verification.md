# FLY-2761 固定页漏报「无会话、不在 Epic」的 founderAsk — 验证
Issue: FLY-2761 (https://linear.app/geoforge3d/issue/FLY-2761/固定页漏报-founderask-挂在无会话不在-epic-范围的-issue-上时-现在要你看静默丢掉它attentionaudience)
日期: 2026-09-25
基于: plan.md

> 产品判据：founder 面的任何清单，过滤条件只能是「这件事还需不需要她」，不能是「我们能不能把它渲染出来」。

## 1. 复现样本

线上样本 ask `9c090bb4`（FLY-2736）已于 2026-09-22T03:00:16Z 由 founder 回复 settle（`settled_by=founder_reply`，
`sqlite3 -readonly` 只读查询）。按 issue 约定，其行状态已落成 fixture：
`packages/teamlead/src/epic-page/__tests__/founder-ask-outside-scope.test.ts`
（真 StateStore + CommDB；无 session、无 Epic 快照、Linear 读成功但边界外返回空）。

## 2. 阴性对照

同一 fixture，未改代码（HEAD `637752fcc`）与改后（HEAD `75076d908`）各跑一次「打 ask 前 / 后」：

| 代码 | 打 ask 前 | 打 ask 后 |
|---|---|---|
| 改前 `637752fcc` | `⚡ 现在要你看 · 0 件` · 现在没有等你的事 | `⚡ 现在要你看 · 0 件` · 已知 0 条记录，清单不完整（1 条记录缺少讨论串链接；身份尚未核齐，同一件事可能暂列多条） |
| 改后 `75076d908` | `⚡ 现在要你看 · 0 件` · 现在没有等你的事 | `⚡ 现在要你看 · 1 件` · 有 1 件等你处理的事（行内链接 = ask 的讨论串） |

复现测试在改前 3/3 失败（`expected [] to deeply equal [ 'FLY-2736' ]`、`expected [] to have a length of 1 but got +0` ×2），改后 3/3 通过。

## 3. 验收对照

| 验收项 | 证据 |
|---|---|
| 无 session、无 parent 的 issue 打 founderAsk → 计数 +1，行内可点到 thread | fixture 用例 ①：`attentionAudience(page,true)` = [FLY-2736]，链接 `https://discord.com/channels/<guild>/1550543837552713790`，标题「· 1 件」 |
| settle 后消失 | fixture 用例 ③：`recordFounderAttentionReply` → `settled_by=founder_reply` → 列表空、「· 0 件」、「现在没有等你的事」 |
| 阴性对照 | §2 |
| 单测覆盖 `attentionAudience` 的无链接分支 | `attention.test.ts`「keeps a founder item whose guild/thread/thread_url is missing in the founder audience」 |
| 链接缺失时显示 issue 标识 +「（无讨论串链接）」并计数 | fixture 用例 ②（guild 未配置）；`attention-render.test.ts`「FLY-2761: founder attention lists and counts items it cannot link」 |
| 两类不完整分开写，数字对得上 | 「要你看 1 件，其中 1 件缺讨论串链接」；清单不完整时「已知 1 条记录，清单不完整（…）。其中 1 件缺讨论串链接」 |
| `pendingDecisions` 覆盖边界 | `bridge/lead-runtime.ts` 字段 JSDoc |

## 4. 校验器守卫的阴性对照（变异测试）

临时删掉 `founderAskIdentity` 里的 `source.fact.value.id === askId` → 「rejects the identity when fact id differs…」变红；
临时删掉 since provenance 核对 → 「rejects the identity when since provenance names another ask」变红。两次均已还原文件。

## 5. 本地定向验证（最终字节，HEAD `75076d908` 源码）

| 项 | 结果 |
|---|---|
| `pnpm lint` | exit 0（仓库既有 27 个 warning，改动文件 `biome check` 0 诊断） |
| `pnpm --filter "flywheel-teamlead..." build` | exit 0 |
| `tsc --noEmit -p packages/teamlead` | exit 0 |
| `pnpm --filter "...flywheel-teamlead" typecheck` | 首跑 **exit 2**：`voice-codex` 报 `Cannot find module 'flywheel-voice-bridge'`（新 worktree 只构建了 teamlead 的上游，`flywheel-voice-bridge` 没有 dist）。此前记录成 exit 0 是读错了（读到的是管道末尾 `tail` 的退出码），在此更正。`pnpm --filter "flywheel-voice-codex^..." build` 补建后重跑 **exit 0**（teamlead、voice-codex 均 Done） |
| 直接消费者目标集（见 §6），`TMPDIR=/tmp`，forks≤2 | 46 文件 / 690 tests 通过 |
| `flywheel-comm` `dependency.test.ts`（引用 attention fixture） | 42/42 |
| `vitest related`（6 个 epic-page 源文件） | 617 文件中 610 过、7 失败；7 个失败文件对最终字节以 `TMPDIR=/tmp`、单 fork 重跑：6 文件 203/203 + `lifecycle-closeout.test.ts` 64/64 全过 |

related 首跑的 7 个失败均为环境性：runner 的 `TMPDIR` 位于 `~/.flywheel/runner-state/<exec>/browser-tmp/`，
Unix socket 路径超长（`listen EINVAL`）且触发 full-access 根目录与 `~/.flywheel` 重叠守卫；负载下 5s 超时。
它们是经传递依赖被 related 选中的文件，失败点都在 socket 监听、临时目录守卫或超时，不在本单改动的代码里；最终字节上重跑全绿。

`lead-runtime.ts` 只加了字段 JSDoc（无运行时字节），其 `vitest related` 图近乎整个 teamlead 包，本节点禁止本地全包 suite，
故以 tsc/build/dependents typecheck 覆盖。

## 6. 消费者发现（`git grep -lF`：完整路径 / 文件名 / 目录）

保留并执行：

- `epic-page/__tests__/` 全目录（33 文件，含新 fixture）
- `bridge/__tests__/founder-attention-sync.test.ts`、`founder-attention-facts.test.ts`、`epic-page-route.test.ts`、`epic-residual-scan.test.ts`、`epic-residual-plugin-wiring.test.ts`
- `__tests__/StateStore.attention-gates.test.ts`、`epic-page-liveness.e2e.test.ts`、`lead-note-e2e.test.ts`、`epic-intake.e2e.test.ts`、`epic-page-publisher.test.ts`
- bootstrap：`__tests__/bootstrap-generator.test.ts`、`lead-token-savings-bootstrap.test.ts`、`lead-token-savings-generator-oracle.test.ts`
- `flywheel-comm/src/commands/__tests__/dependency.test.ts`

排除：

- `packages/token-usage/src/__tests__/render-html.test.ts`：匹配的是它自己包的 `render-html.js`，不导入 teamlead。
- `lead-runtime.ts` 的 30+ 个文件名/目录匹配：本单对该文件只有类型 JSDoc，无运行时行为。
- `engineering/doc/**` 下历史评审 JSON、CI 路径数据：静态文档，不在运行时读取。

## 7. 与 plan 的偏差

- C6 原计划同时在 `bootstrap-generator.ts` 加一句注释。该文件受 FLY-2567 兼容性 manifest
  （`__tests__/fixtures/fly2567/compatibility.json`）sha256 守护，其政策明确「纯 digest 刷新不是有效处置」。
  为一句注释改 digest 不值得，故只保留 `lead-runtime.ts` 字段 JSDoc（`pendingDecisions` 的类型定义处）。
- 合入了 `origin/main` 的两个纯文档提交（`e5451989c`、`0138f403c`），不涉及任何改动文件。

## 8. qa@1 返工：完成态 issue 上未 settle 的 founder_ask（2026-09-25）

QA（106ba2ad）在 head `8f506b77` 上确认第 1–7 节全部成立，并在线上找到同一症状的第二条路径（Lead 裁定进本 PR）：
FLY-2775 的 ask `d2184079`（19:31Z 发出，此前 18:56Z 会话已 completed，run 已完成、已 ship、讨论串随合入自动归档）
不在「⚡ 现在要你看」。成因：`attention-sources.ts` 的 `visible` 过滤要求 `readEffectiveFounderAttention` 的 level 等于来源 level，
而 FLY-2597 的标题规则（`issue-display.ts:291`，badge 为 completed 时不给 answer）让 level 为 null，于是 ask 被丢且 gates 计数减一，页面无标记。

**修复**：`visible` 过滤对 `founder_ask` 来源直接放行——未 settle 的 founder_ask 等她回答，与会话、run、讨论串状态无关。
FLY-2597 的规则只继续管普通 answer 徽章（thread 标题不变）。ship 门在时，ask 并入同一 issue 的 ship 行（不再被丢）。
没有加「单已完成」「讨论串已归档」标记：指令写的是「可带」，加标记需要扩 attention.v1 schema，本次不做。

**先红后绿**：`founder-ask-outside-scope.test.ts` 新增 d2184079 形状 fixture（completed 会话 + `post_ship_finalization_completed` + 讨论串已归档 + 无活 run）。
改前（提交 `ff1147f75`，只加测试）失败：`expected { count: 1 } to deeply equal { count: 2 }`；改后（`b33fbda34`）通过。
另一用例证明 founder 在该讨论串回复 settle 后它消失。`founder-attention-sync.test.ts` 原先钉住的 FLY-2597 页面行为按裁定改写：
ship 行的来源变为 `[founder_gate, founder_ask]`；blocked / completed / approved_to_ship 时标题仍不显示「要你答」，页面保留该 ask。

**线上只读复算**（复用 QA 的回放方法：`StateStore.openForMaintenance(..., { readonly: true })`，写探针报 `SQLITE_READONLY`；
comm.db 只读；真 Linear；构建产物 dist；脚本放在 runner scratchpad，未入仓库）。「改前」= 当前代码去掉本次一行放行：

| 代码 | 未 settle 的 ask（已送达） | gates 计数 | 标题 |
|---|---|---|---|
| 改前 | d2184079/FLY-2775 **不在**；a6f5f1ce/FLY-2711 **不在**；1614b71e/FLY-2757 在 | 4 | `⚡ 现在要你看 · 5 件` |
| 改后 | 三条都在，均带各自讨论串链接 | 6 | `⚡ 现在要你看 · 7 件` |

复算时又出现一条同形状的 FLY-2711 ask（a6f5f1ce），同样被修复。公开 HTML/Markdown 字节不含任何 ask_id。

**本地点名验证**：`epic-page/__tests__/` 全目录 + `founder-attention-sync`、`founder-attention-facts`、`epic-residual-scan`、
`epic-residual-plugin-wiring`、`epic-page-route`、`StateStore.attention-gates`（`attention-sources.ts` 的直接消费者）：39 文件 / 624 tests，exit 0。
`pnpm lint` exit 0（仓库既有 27 warning，改动文件 0 诊断）；`pnpm --filter flywheel-teamlead build` exit 0。
第 1–7 节的已通过项未回退（同一目标集全绿）。
