# FLY-1758 产品线互动回合:founder_review checkpoint — 探索

Issue: FLY-1758 (https://linear.app/geoforge3d/issue/FLY-1758/产品线互动回合-阶段性产出必须先经-founder-review-才准继续-新-founder-review-checkpoint复用)
日期: 2026-08-13
基于: 无(本单第一份文档;输入 = issue 正文,由 Honey Lemon 提出、Annie 逐轮定稿拍板)

## 1. 问题重述

Annie 对产品线(prd / design / prototype 三条流)的核心不满,用她自己的话:

> 「runner 他可能就一直在那里闷头在那里做,做完就说可以 ship 了,但是中间完全没有在跟我互动的这个一个环节。」

她定稿的规则:**每有一个阶段性产出,runner 必须先交给她 review**,不许把「我做完了」当成「可以 ship 了」。产出必须是**可互动**的(她能逐处留言、打回去),据此修改、再交、再 review;**只有她最后说「都可以了」才准 ship**。

- 普通问题 runner 问 Lead、Lead 答 —— 这块不变,她明确说没问题。
- 送达路径 runner→Lead→她 或 runner→bridge→她直发,两者她都接受,实现方挑一条做成机制。

### 阶段性产出粒度(她已拍「对」)

| 流 | 必须交她 review 的产出 |
| -- | -- |
| PRD | research explainer 一页 → 第一版 PRD(可互动)→ 之后每一版按她意见改完的 |
| Design | mockup 几个方向 → 她挑定方向后的高保真版 |
| Prototype | 第一个能跑的版本 → 之后每一轮修订 |

**不打扰她的**:runner 问 Lead 的技术/执行问题、中途的研究笔记、commit 级改动。

## 2. 根因(issue 正文实测数据,2026-08-13,非推测)

```
八月全库 runner question 收件人:
  flywheel-eng-lead 1961 · flywheel-product-lead 78 · founder 0
Honey 那 78 条:78 问 78 答,全部由 Lead 自己接掉。

FLY-1688:produce 跑 18 分钟 → 首条消息「DONE」→ +13 分钟「🚀 ready to ship」

七月共创单(1038/1045/1140/1343/1059/1022/1098):零 workflow_run 记录
  ⇒ 「interactive 很好」的时期根本没进过模板引擎;产品线首次上模板 = 2026-08-10
```

**结构性结论**:runner 的 question 通道在结构上就是发给 Lead 的;FLY-605(gate 十分钟无人答 → 贴 founder thread + @她)是唯一通到 founder 的路,而且是超时兜底 —— **Lead 答得越快越称职,founder 越彻底看不见任何一轮**。上模板前不存在这条 Lead 收件管道,Lead 只能手工把 explainer 早早投给她再转话 —— 那正是她记得的好体验。

**退化的不是图,是「一轮」的收件人从 founder 变成了 Lead。**

## 3. 硬约束(⛔ 三不做,issue 明令)

1. **不给三个产品模板加 founder kickback 环。** FLY-1691 已被 Annie 冻结、前提已由 Honey 撤回。每一轮本来就发生在 produce **节点内部**,不是图上的边。
2. **不新增 gate 节点。** 引擎限制:每个 workflow 只允许一个 gate 节点(第二个在 expected map 里没有合法出边,会 throw)。
3. **不新造送达设施或审阅件格式。** FLY-1404(design 节点 founder HTML 送达合同)、FLY-1508(可互动 comment layer)、FLY-914(可留言审阅件 skill)已存在。

另一条 issue 定的档位约束:**中等(plan only)、不碰引擎的图结构**。参照 FLY-1693 教训:「要小心 ≠ 要大动干戈」,小心指的是爆炸半径,不是流程重量。

## 4. 方向空间与选择

### 4.1 「一轮 review」物理上走什么通道?

| 选项 | 描述 | 判定 |
| -- | -- | -- |
| A. 新 gate 节点 per 产出 | 图上加 founder gate 边 | ⛔ 违反约束 1+2,直接排除 |
| B. 新 checkpoint kind `founder_review` | 复用现有 question/gate 基建,新增一种**非终局、只有 founder 能答、一个 session 可多次**的回合;发生在 produce 节点内部 | ✅ issue 建议方案,采纳 |
| C. 纯提示词合同(agent.md 只写「发 HTML 给 founder 等回复」) | 零代码 | ❌ 没有可执行的归属校验 —— Lead 用 respond 代答不会被拒,今天的病(Lead 接掉一切)原封不动;也无法做 ship 前置的机器校验 |

选 **B**。C 的致命伤正是 issue 点名的命门:「Lead 用 respond 回这个 checkpoint 必须被拒绝 —— 不拒绝,今天的病原封不动」。

### 4.2 founder 归属判定复用什么?

`packages/flywheel-comm/src/founder-attribution.ts` 的 `isTrustedApprovalAttribution()` 已是「谁算 founder 侧写入」的唯一定义(founder Discord id / `bridge` / `bridge-founder-consent`;Lead id 明确不算,注释写死)。配套的 `isReservedApprovalAttribution()` 已防止 caller 伪造这三类身份。**直接把同一判定套到 `founder_review`**,不另造第二套归属定义。

### 4.3 「阶段性产出可互动」复用什么?

FLY-1404 已为 design 节点落地「必须产出 founder HTML + 必须送达 issue thread」(报告格式 `DESIGN-HTML ready: <hosted-url> | repo: <path> | issue: <ID>`);FLY-1508 已规定该 HTML 必须可互动(逐节 comment + 一键汇总复制)。**把同一合同套到 prd/design/prototype 三条流的每一个阶段性产出**。

**关键差异,必须显式实现**:FLY-1404 明文是非阻塞的(must produce + must deliver, **NOT** must receive approval)。产品线三条流要**阻塞**:没拿到 founder 的 review 结果,不许继续下一版、不许进 ship。

### 4.4 ship 前置怎么防「18 分钟直奔 ship」?

进 `approve_to_ship` 之前必须满足:本 run 至少发生过一次 `founder_review`,且最后一次裁定为通过。这是机器校验,不是提示词约定 —— 验收要求「一个主动去破它的测试」。

### 4.5 行为面:三个 agent.md 的回合协议

`pm-executor.md` 现在写「First response comes from your **Lead**」—— issue 点名这句就是病根。三个 executor(.md)都要写进「阶段性产出 → 开 `founder_review` 回合」的协议。

## 5. 已知缺口(不许粉饰)

Annie 在 HTML 页面上留的言,**没有自动回到 runner 的通道**(回写后端 FLY-298 仍在 Backlog)。**本单不含回写后端。** 真实闭环:她留言 → 「一键汇总复制」→ 丢回 thread → Lead 转给 runner。实现时不得在任何 founder-facing 文案里暗示这一步已自动化。

## 6. 待 research 落实的代码事实

1. 现有 checkpoint/question kind 的类型定义与存储 schema —— `founder_review` 作为新 kind 的最小落点。
2. `respond.ts` 拒绝 `approve_to_ship` 的现有形态 —— `founder_review` 照抄哪段。
3. `approve_to_ship` gate 的 admission 位点 —— ship 前置(≥1 次 founder_review 通过)插在哪。
4. FLY-1404 合同文本的注入位点(Blueprint? seed node prompt?)—— 阻塞版产品线合同注入在哪。
5. tpl_prd/tpl_design/tpl_prototype 三个 seed 的节点结构 —— 确认「不碰图结构」的边界。
6. 非终局 question 的先例(普通 QUESTION GATE 是否天然非终局)—— 多次回合的机制成本。
7. 送达路径选型:runner→Lead→她 vs runner→bridge→她直发 —— 看 FLY-605 兜底与 publish-report 的现状再定。

## 7. 状态

Draft → 待 research.md 用代码事实回填 §6,再进 plan。
