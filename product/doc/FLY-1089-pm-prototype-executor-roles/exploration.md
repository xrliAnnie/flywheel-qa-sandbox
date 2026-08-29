# FLY-1089 建 PM + Prototype 两个 executor 角色 — 探索

Issue: FLY-1089 (https://linear.app/geoforge3d/issue/FLY-1089/建-pm-prototype-两个-executor-角色-三条流里剩下的两条fly-1059-只做了-designer)
日期: 2026-07-09
基于: 无

---

> **命名注(2026-07-10)**:本探索文档用的是**初稿命名** —— 「PM / Program Manager」「Prototype」。
> Annie co-eval 后**定稿命名 = Product Manager**(不是 Program Manager)+ **Prototype Engineer**。
> 下文旧称保留为历史记录;运行时角色文件 + config 用的是定稿命名。

---

## 1. 问题

Annie 在 [FLY-1059] thread 里说清楚了:她要的不是一个 Designer,是**三个 executor 工种**——
Program Manager(出 PRD)、Designer(出视觉稿)、Prototype Designer(出可行性验证原型)。
FLY-1059 只做了 Designer,PRD 里画的三条流只落地了一条。

她把事情切成两件:

1. **现在**把三个角色都搭好(她已经需要用这三个角色了)。
2. **等 DAG 做好之后**再 map 进 DAG 逻辑 —— 这是单独的 follow-up issue,不在本 issue 范围。

## 2. 审计:issue 的前提有一处不准

issue 描述写「PM / Program Manager(出 PRD)= 没建」。**审计代码后发现:已经建了。**

`git log -- .flywheel/agents/engineering/product-designer-executor.md` 的头一条:

```
32d70ae3 feat(FLY-880): internal PM agent — collaborative product thinker
         (interaction model + PM skills + PRD output) (#450)
```

PR #450 已于 2026-07-05 merge 进 main。它把 PM 做成了 `product-designer-executor.md`
里的「**Mode A — 产品共创**」:五条铁律(先摸真实意图 / 一路来回不憋 PRD / topic 树逐块钻 /
每块先探「有定见还是我来发挥」/ PRD 逐版收敛→拆 build issue)、单轮一问的 `gate question`
协议、`prd.md` 落点、`create-issue` 拆单 —— 全都在,243 行。

所以**真正缺的是三件事,不是「PM 从零建」**:

| # | 缺口 | 性质 |
|---|---|---|
| 1 | Mode A(PM)跟 Mode B(文档/设计产出)挤在同一个 agent.md 里 | 违背 Annie 拍的「一个工种 = 1 session + 1 agent.md」 |
| 2 | Mode A 的流程里没有 v5 explainer 的两步:**research + 出 explainer HTML**、**跟 founder co-eval** | 流程不完整 |
| 3 | Prototype 角色完全不存在 | **真正的从零** |

Lead 已确认这条纠正,并去改 issue 描述(账本不能撒谎)。

> 这条审计不是学术洁癖:如果照 issue 字面「从零建 PM」,会把 FLY-880 刚 merge 的
> 五条铁律重写一遍,大概率写歪 —— Annie 的互动模型是她亲口逐条拍的,不能凭记忆复刻。

## 3. 三条流(取自 FLY-1059 v5 explainer,Annie 已过目)

| 工种 | 流程 | founder 决策点 |
|---|---|---|
| **Program Manager** | 搞懂你到底要什么 → research + 出 explainer HTML → 跟你 co-eval → 收敛 PRD → 拆成 build issue 交工程 | 「一起评」(co-eval)环节 |
| **Designer**(FLY-1059 已做) | 先定 mockup 类型 → 不同 prompt 画 N 版 mock → 你挑方向 → 迭代 mock → 出高保真 → 交工程做进真产品 | 「挑方向」环节 |
| **Prototype** | 定要验证什么 → 搭最便宜的真原型 → 跑给你体验 → 能做 → 交工程 productionize / 不能做 → drop | 「体验完判可行性」环节 |

## 4. Annie 已锁的设计约束

- **session / agent.md 模型**:三个工种**各 1 个 session + 1 个 agent.md**,整条流写在这一个
  agent.md 里;founder 门 = **session 内暂停**,不拆多 session。
  对比工程三段式(design→implement→QA)= 3 个 session、每段一个 phase prompt。
  「每步一个 markdown」是三段式那种形态,**这三个工种不需要**。
- **后端**:Claude Code 跑 + 默认 Codex 出图(不总是双模型对比;多样性来自不同 prompt /
  方向,不是换模型)。
- **设计语言去黑话**:界面 / 产出里不写「DAG」这类词(受众多为非技术,DevRel 考量),换人话。
- **边界**:这是 role / agent-md 配置,归产品线自己做,不交 Tadashi(他只在需要改引擎 /
  Bridge 时才接)。**DAG mapping = 单独 follow-up**(等 FLY-1020 的 DAG 系统落地)。
- **ship / merge 仍 founder-gated。**

## 5. 关键洞察 —— 为什么这是「纯配置」而不是「改引擎」

FLY-1059 改了引擎(`Blueprint.ts` + `designer-labels.ts`),因为它要解决**另一个**问题:
一个 `ui` / `frontend` 标签的 issue 进了**三段式** pipeline 之后,它的 Design **阶段**
要跑 mockup-first 而不是通用文字设计。那是「阶段行为」,必须在 Blueprint 里判。

PM 和 Prototype 不碰三段式 —— 它们是**整 issue 单 session**。Annie 的约束(一个工种
1 session)恰好意味着:**只需要 label 路由到对的 agent.md,不需要任何引擎改动。**

排除三段式的手段沿用 FLY-880 的既有纪律,不加代码:

- `no-three-stage` label(`three-stage-policy.ts:54`,per-issue override);
- 现有 `pipeline.three_stage_channels: ["1516209714097291335"]` 已把三段式入口限死在
  `#flywheel-engineer` 频道 —— 产品线 Lead(Honey Lemon)的派发天然不进三段式。

结构化的 `issue-type → pipeline` 映射是 **FLY-830**,不在这里做(FLY-880 的原话)。

## 6. 待定问题(已在 brainstorm gate 解掉)

1. **PM 是抽出来还是原地改?** → 抽出来独立成 `pm-executor.md`,符合「一个工种 1 agent.md」。
   `product-designer-executor.md` 抽掉 Mode A 后只留文档 / 设计产出。
2. **基线分支?** → FLY-1059(PR #527)未 merge,且改了 `.flywheel/config.yaml` 的同一块 +
   有一条断言「pm/product 仍路由到 product-designer」的测试(正是本 issue 要推翻的)。
   Lead 拍板 **base 在 `origin/flywheel-FLY-1059` 之上**(叠 PR),顺序 =
   FLY-1059 先 ship → 本分支 rebase 回 main → FLY-1089 再 ship。**不动 1059 的 head。**

## 7. 假设(显式列出)

- `readAgentFile()` 把 agent.md **正文逐字**注入 Runner system prompt(40k **字符**截断),
  frontmatter 只是文档性的 —— 沿用 FLY-880 / FLY-1059 已核实的结论,本 issue 复核。
- Honey Lemon(产品线 Lead)的自动派发 `owningDept=product`,所以新 agent 必须
  `departments: [engineering, product]` 双注册(FLY-901 机制),否则掉进 shipped-generic。
- 现存打了 `product` / `pm` 标签的 issue 在 label 重划后会路由到 `pm-executor`,内容
  与原 Mode A 等价 + 补两步 —— 行为不退化。
