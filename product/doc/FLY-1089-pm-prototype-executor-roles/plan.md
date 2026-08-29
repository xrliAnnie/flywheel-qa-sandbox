# FLY-1089 建 PM + Prototype 两个 executor 角色 — 实施计划

Issue: FLY-1089 (https://linear.app/geoforge3d/issue/FLY-1089/建-pm-prototype-两个-executor-角色-三条流里剩下的两条fly-1059-只做了-designer)
日期: 2026-07-09
基于: research.md

---

> ## ⛳️ Post-ship 状态更新(2026-07-10 — 计划下方部分描述的是当时的中间态)
> 计划里「叠在 FLY-1059 上、待 rebase」「新建 role-agent-dispatch.test.ts」等是**当时**的
> 中间设计;实际落地状态如下(以此为准):
> - **FLY-1059 已 merge 进 main;本分支已 rebase 回 main**(去掉 1059 commit,只留 1089 净
>   改动),PR #536 base = `main`。下方 §1「叠在 1059 上、顺序 1059 先 ship」= 已完成。
> - **dispatch 测试实际文件名 = `pm-prototype-agent-dispatch.test.ts`**(不是计划里写的
>   `role-agent-dispatch.test.ts`,已全文改正)。
> - **命名按 Annie co-eval 定稿**:PM = **Product Manager**(不是 Program Manager);
>   Prototype = **Prototype Engineer**。下方旧称保留为历史。
> - **Prototype 加了 Annie 要的 iterate 回环**(Step 3.5,founder-feedback→iterate→re-show,
>   带 bounded escalation 第三出口 + fail-closed 语义;对称 Designer loopable gate)。
> - **order-independence 收窄**:pairwise-disjoint 只保证「一 label 一 agent」→ 单 label
>   路由确定;多-label issue 仍 first-match(YAML 顺序),前提「一 issue 一 executor-family
>   label」,真 ambiguity 拒绝 = 引擎 follow-up(不在本 scope)。测试已加 multi-label 用例。
> - Codex code review post-rebase(xhigh)已跑,4 条 findings 全折入。

---

## 0. 一句话

新建 `pm-executor.md`(把 FLY-880 的 Mode A 抽出来 + 按 v5 补 research/explainer/co-eval 两步)
和 `prototype-executor.md`(全新),重划 `.flywheel/config.yaml` 的 label 路由,加守卫测试。
**不碰引擎。**

## 1. 基线与顺序

- 分支 `flywheel-FLY-1089` **base 在 `origin/flywheel-FLY-1059`**(commit `8b70b2ed`)。
- ship 顺序:**FLY-1059(PR #527)先 merge → 本分支 rebase 回 `main` → FLY-1089 再 ship。**
- **绝不动 1059 的 head**(upstream 已显式解绑,防止误推)。

## 2. 改动清单

| # | 文件 | 动作 |
|---|---|---|
| 1 | `.flywheel/agents/engineering/pm-executor.md` | **新建**。Mode A 正文搬入 + 补 v5 两步 |
| 2 | `.flywheel/agents/engineering/prototype-executor.md` | **新建**。全新四步流 |
| 3 | `.flywheel/agents/engineering/product-designer-executor.md` | **改**。抽掉 Mode A,只留文档/设计产出;头部改写 |
| 4 | `.flywheel/config.yaml` | **改**。label 重划 + 两个新 agent 条目(双注册)+ **同步更新上方注释块**(Codex R2#5:`:128-145` / `:164-175` 的注释仍把 `product-designer` 描述成拥有 product/PM planning、说 FLY-1059 只移了 `designer` —— 改成最终 split:`pm`→pm/product、`prototype`→prototype、`product-designer`→doc/docs/design/ux、`designer`→designer/mockup) |
| 5 | `scripts/__tests__/test-pm-executor-contract.sh` | **改**。从「PM 一个文件」扩成「三个 role 文件的契约」+ 结构性检查 |
| 6 | `packages/edge-worker/src/__tests__/designer-agent-dispatch.test.ts` | **改**。修掉「pm/product → product-designer」这条已过时的断言 |
| 7 | `packages/edge-worker/src/__tests__/AgentDispatcher.test.ts` | **改**(Codex R1#1 HIGH)。`:469-528` 的 FLY-901 双注册 fixture 仍写死 `product-designer` 含 `product`/`pm` 并断言其路由 —— 改成最终映射 |
| 8 | `packages/edge-worker/src/__tests__/pm-prototype-agent-dispatch.test.ts` | **新建**。跑真 ConfigLoader,断言六个 agent 的标签集两两不相交 + 全映射 |
| 9 | `scripts/qa-fly-901-real-config-dispatch-e2e.mjs` | **改**。双注册 E2E 补上 pm / prototype |
| 10 | `.flywheel/agents/general-executor.md` | **改**(Codex R1#2 MED)。`:13` 的 manual-routing pointer:PM/product 共创指 `pm-executor`,不再笼统指 `product-designer` |
| 11 | `.flywheel/agents/engineering/engineer-executor.md` | **改**(Codex R1#2 MED)。`:18` 「product/UX 探索 + design spec 归 product-designer」→ 拆清:产品共创/PRD 归 `pm`、可行性验证归 `prototype`、文档/设计 spec 才归 `product-designer` |
| 12 | `.flywheel/agents/engineering/designer-executor.md` | **改**(Codex R1#2 MED,**碰 FLY-1059 文件的 3 行**)。`:37-43` 把 `product-designer` 描述成「PM / product co-creation / PRD」已过时 → 指向 `pm-executor` |

**引擎零改动**:`Blueprint.ts` / `AgentDispatcher.ts` / `three-stage-policy.ts` / `ConfigLoader.ts`
一行不动。

> ⚠️ #12 是**唯一一处改到 FLY-1059 引入的文件正文**(designer-executor.md 的 3 行边界描述)。
> 因为本分支 base 在 1059 之上,这是对 1059 文件的干净增量编辑,1059 merge 后 rebase 到 main
> 依然干净。但它超出「只碰 1059 一条过时测试断言」的原始边界 —— **报 Lead 时必须点名**。
> 理由:PM 从 product-designer 抽走后,designer 里「product-designer = PM/PRD」这句就成了
> 谎话,不改边界描述就自相矛盾。

## 3. label 重划(最终态)

| agent | labels | departments |
|---|---|---|
| `engineer` | code, feat, fix, refactor, test, infra, tooling, bug, backend, frontend, api, server, ui, web, be, fe, eng, research, plan | engineering |
| `qa` | qa, testing | engineering |
| `product-designer` | doc, docs, design, ux | engineering, product |
| `designer`(FLY-1059) | designer, mockup | engineering, product |
| **`pm`**(新) | **pm, product** | **engineering, product** |
| **`prototype`**(新) | **prototype** | **engineering, product** |
| `general` | (空,catch-all) | — |

**不变式:六个标签集两两不相交** → **单-label** issue 路由与 YAML 书写顺序无关(多-label issue
仍 first-match YAML 顺序,前提「一 issue 一 executor-family label」;见 research.md §2)。
唯一移动:`pm` / `product` 从 `product-designer` → `pm`。新增:`prototype`。
**没有任何标签被丢弃。**

> **去掉 `poc`(Codex R1#3 MED)**:原稿给 prototype 配了 `prototype` + `poc` 两个 label。
> `poc` 是黑话,Annie 明确要求去黑话,且容易被误用到「泛泛 spike」而非「founder 体验的可行性
> 验证」。v1 **只上 `prototype` 一个 label** —— 心智模型更干净:`prototype` = 「用最便宜的
> 真原型验证这件事做不做得成」。dispatch 测试断言未识别的 `poc` 走 shipped-generic 兜底
> (证明它**不是** alias、没被偷偷保留)。将来真需要别名,用清楚的非黑话词(如 `validation`)
> 且先核对既有 label 习惯,不在本 issue 做。

### label 边界的显式例子(Codex R1#6 LOW — 写进 role .md + dispatch 测试)

`design`/`ux`(→ product-designer)与 `designer`/`mockup`(→ designer)的分界不直觉,用例子钉死:

| 真实 issue | 该打的 label | 路由到 | 因为 |
|---|---|---|---|
| 「给这个功能写一份 UX spec / 交互规范」 | `ux` / `design` | product-designer | 文档/规范/planning |
| 「把这个界面做出 2-3 版视觉方向让我挑」 | `designer` / `mockup` | designer | 独立视觉 mockup-first 执行 |
| 「这个需求到底要做什么,一起收敛个 PRD」 | `pm` / `product` | pm | 产品共创 / PRD |
| 「这事技术上做不做得成,搭个原型验证」 | `prototype` | prototype | 可行性验证 |

## 4. `pm-executor.md` 的内容契约

**来源**:`product-designer-executor.md` Mode A **逐字搬运**(五条铁律 / 轮次协议 /
per-sub-block 探定见 / PRD 逐版收敛 / create-issue 拆单 / 边界 / skill map),
Annie 亲口拍的文字**不改写**。

**在此之上补 v5 的两步**(这是本 issue 的净新增):

```
1 搞懂你到底要什么   →  已有(法则 4 + Round 1 复述+topic 树+探定见)
2 research + 出 explainer HTML   ← 新增
3 跟 founder co-eval             ← 新增(把「一起评」写成显式环节)
4 收敛 PRD                       →  已有(prd.md 逐版 commit)
5 拆成 build issue 交工程         →  已有(create-issue)
```

新增两步的硬规则:

- **explainer HTML**:用 `founder-html-delivery` / `publish-report` 出**一页**解释卡
  (Apple 风浅色主题)。**发布不带 `--channel`**,拿 URL **交 Lead 投递** —— Runner 绝不
  直投 founder 物料。一轮攒齐发一次,别每次微调就发新卡;出新版先告诉 Lead 哪个作废。
- **co-eval ≠ 汇报**:explainer 不是「我想好了给你看」,是「我把选项和取舍摊开,**一起评**」。
  每张 explainer 必须带:选项(≥2)、每个选项的代价、我的推荐 + 为什么、以及**我不确定的地方**。
  然后开 `gate question` 请 founder 评。
- **仍然一轮一问**:co-eval 也遵守「一个 `gate question` = 一轮 = 一个问题」。

**session 模型**(写进文件):整条流在**一个 session** 里跑完,founder 决策点 = session 内
用阻塞 gate **暂停**,不拆多 session。派发时带 `no-three-stage`。

## 5. `prototype-executor.md` 的内容契约

四步 + 一条排序 + 一条边界(全部取自 research.md §7/§8):

```
1 定要验证什么       →  写成一条可证伪的假设 + 一条「什么结果算成功」的判据(先写,后做)
2 搭最便宜的真原型   →  processize → 一次性脚本 → 静态假界面+假数据 → 一条真链路最小切片
                        能停在前一档就绝不进下一档
3 跑给 founder 体验  →  proofshot 截真运行 / 托管 URL 交 Lead;开 gate question 请她判
4a 能做 → create-issue 拆 productionize issue 交 engineer
4b 不能做 → drop,写一页「为什么不行 + 学到了什么」,这是**成功的结局**
```

必须写死的三条:

1. **原型不是生产级**。一次性代码、可以很丑、可以硬编码。要写进 CRITICAL rules。
2. **drop 是成功**。不许为了「有产出」把不可行的东西做成半成品。
3. **与 Designer 的边界**(research.md §8 那张表原样写进去):
   Designer 问「长什么样才好用」出视觉高保真;Prototype 问「做不做得成」出可行性判定。

## 6. `product-designer-executor.md` 的收缩

- 删掉 Mode A 整段(≈第 26–140 行 + 「Two trigger modes」/「How to dispatch me」中 Mode A 的部分)。
- 头部改写:说清它现在**只**负责文档 / 设计产出(`doc` / `docs` / `design` / `ux`),
  并**指向** `pm-executor.md`(产品共创)/ `designer-executor.md`(视觉稿)/
  `prototype-executor.md`(可行性原型)。
- **不改名**(scope discipline)。
- 保留:Mode B 全文、CRITICAL rules、Docs & branch、Reporting。
- `FLY-830`(PM 验收边界)这条移到 `pm-executor.md` —— 它属于 PM。

## 7. 测试

### 7.1 `scripts/__tests__/test-pm-executor-contract.sh` → 三角色契约 smoke(Codex R1#5 LOW)

这是**便宜的 smoke sentinel,不是 contract test** —— role .md 是提示词,守卫证明不了行为,
只能挡住两个真实风险:(a) 文件超 40k 注入截断红线;(b) 流程语义锚点被静默删掉。
真正证明**路由行为**的是 §7.2/§7.3 的 dispatch 测试。

> 措辞修正:运行时截断是 JS `slice(0, 40_000)` **字符**;shell 守卫用 `wc -c`(字节),
> 对多字节中文更严格 —— 这是**故意留余量的 byte-budget sentinel**,不冒充精确运行时契约。

改成对**三个** role .md 各跑一组断言(重命名内部逻辑,文件名不动以免破坏 CI 引用):

| 文件 | 断言 |
|---|---|
| 全部三个 | 存在 + `< 40000` 字节(byte-budget sentinel) + 含 `flywheel-comm ask`(回报通道)|
| `pm-executor.md` | `产品共创` / `有定见` / `BLOCKING gate` + `non-blocking` + `different* primitive from` / `prd.md` / `no-three-stage` / `create-issue` / `FLY-830` / **`explainer`**(新)/ **`co-eval`**(新)/ **不带 `--channel`** 语义锚点 |
| `prototype-executor.md` | `可行性` / **`drop`** / `不是生产级` / `no-three-stage` / `create-issue` / `proofshot` / 「最便宜」排序锚点 |
| `product-designer-executor.md` | `codex-design-review`(Mode B 存活) / `design` / **不再含 `产品共创`**(Mode A 已迁出,防回流) |

**加结构性检查(比裸 grep 难被误满足,Codex R1#5)**:PM 与 Prototype 各自必须含四类
必需小节标题 —— 「一个 session / 单 session」、「founder 门 / gate」、「产出 / 交付契约」、
「交工程 / handoff」。锚点删一个,守卫红。

> 断言选的是**流程语义锚点**,删掉它们等于删掉契约 —— 而不是可以随手改的措辞。

### 7.2 `packages/edge-worker/src/__tests__/pm-prototype-agent-dispatch.test.ts`(新)

跑**真** `ConfigLoader` + 真 `.flywheel/config.yaml`(照 FLY-1059 的 `designer-agent-dispatch.test.ts` 形态):

1. `pm` / `prototype` 存在且 `departments === ["engineering", "product"]`;
2. 全映射表(engineering + product 两个 dept 各跑一遍):
   `pm|product → pm`、**`prototype → prototype`**、`doc|docs|design|ux → product-designer`、
   `designer|mockup → designer`、`qa|testing → qa`、`code|feat|… → engineer`;
3. **标签互斥不变式**:遍历所有 agent 的 `match.labels`,任意两个集合交集为空 —— 一条测试
   永久锁住「单-label 路由与 YAML 顺序无关」(多-label 仍 first-match);
4. **`poc` 不是 alias(Codex R2#1 HIGH)**:断言 `poc` 出现在**任何** agent 的 `match.labels`
   里 = false,且 `poc + owningDept=product → shipped-generic` —— 证明砍掉 `poc` 是真的、
   没被偷偷当别名保留;
5. 未知 label + `owningDept=product` → `shipped-generic`(兜底没坏)。

### 7.3 修两处已过时的 dispatch 断言(推翻旧契约 —— PR 点名)

两个文件都写死了「`product` / `pm` → `product-designer`」的旧契约,label 重划后必须改:

- **`designer-agent-dispatch.test.ts`**(FLY-1059 引入):现断言 `product`/`pm` → `product-designer`。
  改成 `design`/`ux` → `product-designer`,`pm`/`product` 期望挪进 §7.2。
- **`AgentDispatcher.test.ts:469-528`**(Codex R1#1 HIGH):FLY-901 双注册 fixture 把
  `product-designer` 的 labels 写成 `["doc","design","product","pm","ux"]` 并断言 `product`/`pm`/
  `ux`/`design` → `product-designer`。改成最终映射:`pm`/`product` → `pm`、`prototype` → `prototype`、
  `doc`/`design`/`ux` 留 `product-designer`;**保留** FLY-901 那条「双注册 agent 被 product Lead
  派发时 `department: "product"`」的断言(它验的是机制,不是标签)。

> 这是全 issue 仅有的「推翻既有断言」两处,PR 描述必须点名。

### 7.4 `scripts/qa-fly-901-real-config-dispatch-e2e.mjs`

FLY-901 双注册 E2E:把 `pm` / `prototype` 加进被验证的 agent 列表。

### 7.5 回归(Codex R2#4 —— 用准确包名)

包名是 `flywheel-edge-worker` / `flywheel-config`,**不是** `edge-worker`(`pnpm --filter edge-worker`
会「No projects matched」静默跳过 —— 恰恰跳过路由改动所在)。用:

- `pnpm lint`(全仓,push 前必跑)
- `pnpm --filter flywheel-edge-worker --filter flywheel-config test:run`
- 开发中针对性跑新/改的 dispatch 测试:`pnpm --filter flywheel-edge-worker exec vitest run
  src/__tests__/pm-prototype-agent-dispatch.test.ts src/__tests__/designer-agent-dispatch.test.ts
  src/__tests__/AgentDispatcher.test.ts`
- `bash scripts/__tests__/test-pm-executor-contract.sh`
- `node scripts/qa-fly-901-real-config-dispatch-e2e.mjs`

## 8. 明确不做的事(边界)

- ❌ **不改引擎**(Blueprint / AgentDispatcher / three-stage-policy / ConfigLoader)。
- ❌ **不加代码强制单 session** —— 靠 `no-three-stage` 纪律 + 既有频道白名单(research.md §3)。
  结构化 `issue-type → pipeline` = **FLY-830**。⚠️ 单 session 是**运行前提(precondition),不是
  代码保证的不变式**(Codex R1#4 MED)—— 见 §8.1 的三格矩阵,不吹成 code-enforced 属性。
- ❌ **不做 DAG mapping** —— 单独 follow-up,等 FLY-1020 的 DAG 落地。
- ❌ **不改 `product-designer` 的名字**。
- ❌ **不改 FLY-1059 的设计/实现逻辑**(Codex R2#2 —— 与 §2 对齐)。仅允许两类 stacked cleanup,
  且都在 PR / Lead handoff 里点名:(a) §7.3 那条过时的 dispatch 断言;(b) `designer-executor.md`
  的 3 行边界描述(把「product-designer = PM/PRD」指向新 `pm-executor`)。除此之外不碰 1059 文件。
- ❌ **不 ship / 不自 merge / 不 fire approve gate** —— 改动先报 Lead,他 OK 才 publish / 开 PR。

## 8.1 单 session 的三格矩阵(Codex R1#4 —— 前提,不是不变式)

「一个工种 = 一个 session」在**当前配置下**成立,但它是操作前提,取决于**从哪个频道派 + 带没带
`no-three-stage`**。三种情况写清楚。

> **覆盖归属澄清(Codex R2#3)**:这三格属于 **role .md 派发纪律 + 本文档的 QA checklist**,
> **不是** §7.2 能验的 —— §7.2 是 ConfigLoader + AgentDispatcher 的 label 路由测试,
> AgentDispatcher **不知道** `dispatchChannelId` / `three_stage_channels` / `no-three-stage`
> (那些活在 teamlead 的 `resolveThreeStageEntry` / `resolveThreeStagePolicy`)。这条 channel 行为
> 是**既有机制**、已被 FLY-793/887 自己的 `three-stage-policy.test.ts` 覆盖,本 issue 不新增引擎
> 测试(纯配置 scope)。§7.2 只证 label→agent 路由。

| 派发来源 | 带 `no-three-stage`? | 结果 | 机制 |
|---|---|---|---|
| 产品频道(Honey Lemon,非白名单) | 无所谓 | **单 session** | `dispatchChannelId` 不在 `three_stage_channels` → fail-close(three-stage-policy.ts) |
| 工程频道(白名单内) | 带 | **单 session** | `no-three-stage` label per-issue override |
| 工程频道(白名单内) | **不带** | **会进三段式** ← 这是 role .md 明令禁止的派发方式 | 无代码拦截,靠纪律 |

**结论**:PM / Prototype 的正确派发 = 产品频道(天然单 session),或工程频道**必带
`no-three-stage`**。role .md 的「派我时带 `no-three-stage`」写成硬规则,守卫测试断言这句在。

## 8.2 in-flight label 迁移 —— pre-ship checklist(Codex R1#7 LOW)

label 重划部署 / reload 后,已打开的、带 `product` / `pm` 标签的 issue 会从 `product-designer`
**改路由到 `pm`**。这**基本是预期**(它们本就是产品共创),但 label 是共享的人类工作流状态,
必有一小撮把 `product` 当「文档/设计 planning」用的会被顺带迁走。ship 前:

- [ ] 审一遍当前 open 的 Flywheel Product issue 里带 `product` / `pm` 的,确认它们确实是产品共创而非
      文档 planning;把纯文档 planning 的改标成 `doc` / `design` / `ux`。
- [ ] PR 描述里写明这是**有意的 reroute**:今后文档/设计 planning 用 `doc`/`design`/`ux`,
      产品共创用 `pm`/`product`。

## 9. 步骤(带 progress ledger 游标)

| 步 | 内容 | ledger |
|---|---|---|
| 0 | 文档三件套 + 分支 base 到 1059 | design 3/3 |
| 1 | 写 `pm-executor.md` | implement 1/7 |
| 2 | 写 `prototype-executor.md` | implement 2/7 |
| 3 | 收缩 `product-designer-executor.md` | implement 3/7 |
| 4 | 改 `.flywheel/config.yaml` | implement 4/7 |
| 5 | 改 3 处 manual-routing pointer(general / engineer / designer executor) | implement 5/7 |
| 6 | 测试:守卫脚本 + 结构性检查 + 3 个 dispatch 测试(新 role-agent + 修 designer-agent + 修 AgentDispatcher fixture) + 901 E2E | implement 6/7 |
| 7 | `pnpm lint` + 全量测试跑绿 | implement 7/7 |
| 7 | codex-design-review(本计划)→ 折 feedback | design_review |
| 8 | 报 Lead → 他 OK → 开 PR → codex-code-review → CI 绿 → approve gate | pr_created |

## 10. TDD 说明(诚实边界)

这两个交付物是**提示词文本**,不是可执行代码,没有真正的 RED→GREEN 循环可跑
(FLY-880 的原话:「It is prompt text, not runtime code, so there is no vitest surface」)。

可以、也**必须**先写测试的是**路由**这一半:

1. **RED**:先写 7.2 的 `pm-prototype-agent-dispatch.test.ts`(断言 `pm` / `prototype` 存在并路由正确)
   → 此时 config.yaml 还没改,测试**必须失败**;
2. **GREEN**:改 `.flywheel/config.yaml` → 测试转绿;
3. 守卫脚本(7.1)同理:先加断言(RED,因为文件还不存在)→ 再写 role .md(GREEN)。

顺序因此调整为:**先写测试(步 5 的测试部分)→ 看它红 → 再写 role .md + config(步 1-4)。**
第 9 节表格里的编号是交付物编号,不是执行顺序。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 40k 截断静默吃掉 role .md 尾部 | 守卫测试卡 `< 40000` 字节;PM 文件预计 ~9k,Prototype ~7k,余量充足 |
| YAML 顺序耦合导致路由漂移 | 7.2「标签互斥」测试锁住单-label 归属;多-label 仍 first-match(前提:一 issue 一 executor-family label)|
| 存量 `product`/`pm` issue 改路由 | 内容等价 + 净新增两步;PR 描述点名 |
| #527 被大改导致本分支失效 | Lead 已确认顺序;若 #527 变更,rebase 后重跑全部测试 |
| Runner 把 Prototype 做成生产级 | role .md 三条硬规则 + 守卫断言 `drop` / `不是生产级` |
