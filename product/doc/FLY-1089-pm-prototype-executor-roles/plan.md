# FLY-1089 建 PM + Prototype 两个 executor 角色 — 实施计划

Issue: FLY-1089 (https://linear.app/geoforge3d/issue/FLY-1089/建-pm-prototype-两个-executor-角色-三条流里剩下的两条fly-1059-只做了-designer)
日期: 2026-07-09
基于: research.md

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
| 4 | `.flywheel/config.yaml` | **改**。label 重划 + 两个新 agent 条目(双注册) |
| 5 | `scripts/__tests__/test-pm-executor-contract.sh` | **改**。从「PM 一个文件」扩成「三个 role 文件的契约」 |
| 6 | `packages/edge-worker/src/__tests__/designer-agent-dispatch.test.ts` | **改**。修掉「pm/product → product-designer」这条已过时的断言 |
| 7 | `packages/edge-worker/src/__tests__/role-agent-dispatch.test.ts` | **新建**。跑真 ConfigLoader,断言六个 agent 的标签集两两不相交 + 全映射 |
| 8 | `scripts/qa-fly-901-real-config-dispatch-e2e.mjs` | **改**。双注册 E2E 补上 pm / prototype |

**引擎零改动**:`Blueprint.ts` / `AgentDispatcher.ts` / `three-stage-policy.ts` / `ConfigLoader.ts`
一行不动。

## 3. label 重划(最终态)

| agent | labels | departments |
|---|---|---|
| `engineer` | code, feat, fix, refactor, test, infra, tooling, bug, backend, frontend, api, server, ui, web, be, fe, eng, research, plan | engineering |
| `qa` | qa, testing | engineering |
| `product-designer` | doc, docs, design, ux | engineering, product |
| `designer`(FLY-1059) | designer, mockup | engineering, product |
| **`pm`**(新) | **pm, product** | **engineering, product** |
| **`prototype`**(新) | **prototype, poc** | **engineering, product** |
| `general` | (空,catch-all) | — |

**不变式:六个标签集两两不相交** → 路由与 YAML 书写顺序无关(见 research.md §2)。
唯一移动:`pm` / `product` 从 `product-designer` → `pm`。新增:`prototype` / `poc`。
**没有任何标签被丢弃。**

> `poc` 略带黑话,但它是 **Lead 派发用的内部标签**,不是 founder 面文案 —— Annie 的
> 「去黑话」约束针对界面 / 产出。role .md 正文与 founder 面文字里不出现 DAG / poc 这类词。

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

### 7.1 `scripts/__tests__/test-pm-executor-contract.sh` → 三角色契约守卫

改成对**三个** role .md 各跑一组断言(重命名内部逻辑,文件名不动以免破坏 CI 引用):

| 文件 | 断言 |
|---|---|
| 全部三个 | 存在 + `< 40000` 字节(注入截断红线) + 含 `flywheel-comm ask`(回报通道)|
| `pm-executor.md` | `产品共创` / `有定见` / `BLOCKING gate` + `non-blocking` + `different* primitive from` / `prd.md` / `no-three-stage` / `create-issue` / `FLY-830` / **`explainer`**(新)/ **`co-eval`**(新)/ **不带 `--channel`** 语义锚点 |
| `prototype-executor.md` | `可行性` / **`drop`** / `不是生产级` / `no-three-stage` / `create-issue` / `proofshot` / 「最便宜」排序锚点 |
| `product-designer-executor.md` | `codex-design-review`(Mode B 存活) / `design` / **不再含 `产品共创`**(Mode A 已迁出,防回流) |

> 断言选的是**流程语义锚点**,删掉它们等于删掉契约 —— 而不是可以随手改的措辞。

### 7.2 `packages/edge-worker/src/__tests__/role-agent-dispatch.test.ts`(新)

跑**真** `ConfigLoader` + 真 `.flywheel/config.yaml`(照 FLY-1059 的 `designer-agent-dispatch.test.ts` 形态):

1. `pm` / `prototype` 存在且 `departments === ["engineering", "product"]`;
2. 全映射表(engineering + product 两个 dept 各跑一遍):
   `pm|product → pm`、`prototype|poc → prototype`、`doc|docs|design|ux → product-designer`、
   `designer|mockup → designer`、`qa|testing → qa`、`code|feat|… → engineer`;
3. **标签互斥不变式**:遍历所有 agent 的 `match.labels`,任意两个集合交集为空 —— 一条测试
   永久锁住「路由与 YAML 顺序无关」;
4. 未知 label + `owningDept=product` → `shipped-generic`(兜底没坏)。

### 7.3 修 `designer-agent-dispatch.test.ts`

它现在断言 `product` / `pm` → `product-designer`。改成 `design` / `ux` → `product-designer`,
并把 `pm` / `product` 的期望挪进 7.2。**这是唯一一处「推翻既有断言」,必须在 PR 里点名说明。**

### 7.4 `scripts/qa-fly-901-real-config-dispatch-e2e.mjs`

FLY-901 双注册 E2E:把 `pm` / `prototype` 加进被验证的 agent 列表。

### 7.5 回归

- `pnpm lint`(全仓,push 前必跑)
- `pnpm test --filter edge-worker --filter flywheel-config`
- `bash scripts/__tests__/test-pm-executor-contract.sh`

## 8. 明确不做的事(边界)

- ❌ **不改引擎**(Blueprint / AgentDispatcher / three-stage-policy / ConfigLoader)。
- ❌ **不加代码强制单 session** —— 靠 `no-three-stage` 纪律 + 既有频道白名单(research.md §3)。
  结构化 `issue-type → pipeline` = **FLY-830**。
- ❌ **不做 DAG mapping** —— 单独 follow-up,等 FLY-1020 的 DAG 落地。
- ❌ **不改 `product-designer` 的名字**。
- ❌ **不动 FLY-1059 的任何文件内容**(除了 7.3 那条必须改的过时断言)。
- ❌ **不 ship / 不自 merge / 不 fire approve gate** —— 改动先报 Lead,他 OK 才 publish / 开 PR。

## 9. 步骤(带 progress ledger 游标)

| 步 | 内容 | ledger |
|---|---|---|
| 0 | 文档三件套 + 分支 base 到 1059 | design 3/3 |
| 1 | 写 `pm-executor.md` | implement 1/6 |
| 2 | 写 `prototype-executor.md` | implement 2/6 |
| 3 | 收缩 `product-designer-executor.md` | implement 3/6 |
| 4 | 改 `.flywheel/config.yaml` | implement 4/6 |
| 5 | 测试:守卫脚本 + dispatch 测试 + 修过时断言 + 901 E2E | implement 5/6 |
| 6 | `pnpm lint` + 全量测试跑绿 | implement 6/6 |
| 7 | codex-design-review(本计划)→ 折 feedback | design_review |
| 8 | 报 Lead → 他 OK → 开 PR → codex-code-review → CI 绿 → approve gate | pr_created |

## 10. TDD 说明(诚实边界)

这两个交付物是**提示词文本**,不是可执行代码,没有真正的 RED→GREEN 循环可跑
(FLY-880 的原话:「It is prompt text, not runtime code, so there is no vitest surface」)。

可以、也**必须**先写测试的是**路由**这一半:

1. **RED**:先写 7.2 的 `role-agent-dispatch.test.ts`(断言 `pm` / `prototype` 存在并路由正确)
   → 此时 config.yaml 还没改,测试**必须失败**;
2. **GREEN**:改 `.flywheel/config.yaml` → 测试转绿;
3. 守卫脚本(7.1)同理:先加断言(RED,因为文件还不存在)→ 再写 role .md(GREEN)。

顺序因此调整为:**先写测试(步 5 的测试部分)→ 看它红 → 再写 role .md + config(步 1-4)。**
第 9 节表格里的编号是交付物编号,不是执行顺序。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 40k 截断静默吃掉 role .md 尾部 | 守卫测试卡 `< 40000` 字节;PM 文件预计 ~9k,Prototype ~7k,余量充足 |
| YAML 顺序耦合导致路由漂移 | 7.2 的「标签互斥」测试永久锁住 |
| 存量 `product`/`pm` issue 改路由 | 内容等价 + 净新增两步;PR 描述点名 |
| #527 被大改导致本分支失效 | Lead 已确认顺序;若 #527 变更,rebase 后重跑全部测试 |
| Runner 把 Prototype 做成生产级 | role .md 三条硬规则 + 守卫断言 `drop` / `不是生产级` |
