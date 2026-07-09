# FLY-347 Flywheel 的 Agent-facing compounding wiki — 提案

Issue: FLY-347 (https://linear.app/geoforge3d/issue/FLY-347/xhsclaude-karpathy用-llm-构建个人知识库token-从处理代码转向处理知识)
日期: 2026-07-08
基于: research.md（Karpathy gist 逐字核）

---

> 本轮方向（Annie via Lead fab7fd66）:**核心 = 给 Agent 用的 wiki,不是给人看的**。
> 砍掉人类 UI（不 Obsidian 不 Notion）。出一个具体提案 + 小 MVP,并**诚实评估值不值得**
> —— 现有 memory「用起来也还不错」,别硬吹。仍 design/research,不 build、不 ship、不 close。

## 决定（2026-07-08, Annie via Lead 39f91c49）:**not-now**

Annie 看完提案(HTML v2)后定:**not-now** —— **不 build** 这个 agent-wiki/consolidation
MVP,proposal **park** 着。issue 留 **backlog**,标『deferred / not-now』,**不 close**
(是 not-now、不是永不做,以后可能回来)、不 build、不 ship。

价值不是白做:诚实审计出「我们已有 Karpathy ~70% 骨架、只缺 consolidation」,帮她做了个
**干净的 not-now 决定**(而不是在 not-now 上盲目 build,或在没搞清现状时草率 close)。
以后若回来:直接从本文件 §6 的 Memory Lint MVP 起步。

---

## 0. 一句话结论（先给,不埋）

**Flywheel 不需要「从头建 Karpathy 的 wiki」—— 我们已经有它 ~70% 的骨架(页 + 索引 +
互链)。真正缺的是 Karpathy 那一条核心洞见的落地:LLM 自己跑的『维护回路(Lint)』+ 综述。**
且证据显示这个缺口是**真痛**(约 190 个记忆文件、约 126 个 feedback_*、索引 20KB,只增不并)。
所以提案 = **不建大 wiki,只补那一条最有杠杆的小 MVP:一个 agent 自己跑的记忆
consolidation/lint pass。** 更大的(综述页、query 回填)等 MVP 证明价值再说。

## 1. Annie 的 reframe:给 agent 用,不是给人看

Karpathy 的原版是**人在环里**:Obsidian 浏览、人策展、"Obsidian 是 IDE"。Annie 要的是
**去掉人这一环** —— 读者是 agent,产物是 agent ingest/query 时参考的层。含义:

- **不做任何人类 UI**(不 Obsidian、不 Notion、不 graph view、不 Marp 幻灯)。
- 存储 = 就是我们已有的 markdown 树 + agent 约定(schema/index),给 agent 读写。
- 成功标准变成「agent recall 更准/更少重复」,不是「人看着爽」。

## 2. 诚实的起点:我们已经有多少（grounded）

审计本项目的 MEMORY(`~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/`):

| Karpathy 的要件 | Flywheel 现状 | 有没有 |
|---|---|---|
| 一事一页(atomic pages) | **约 190 个 `*.md` 记忆文件**,一事一文件 + frontmatter | ✅ 有 |
| index.md（目录,查询先读它） | **`MEMORY.md`(约 140 行/20KB),每次会话注入** | ✅ 有(=Karpathy 的 index.md) |
| backlinks/互链 | **`[[name]]` 链接共 约 236 处**,已有 hub 页(如 `[[feedback_dont_manufacture_fake_decisions]]` 被链 8 次) | ✅ 有 |
| schema/约定（CLAUDE.md 式） | 记忆写入规则(frontmatter type、check-before-write、delete-wrong) | ✅ 部分 |
| raw sources | `docs/solutions`(/compound)、per-project `.flywheel/` 记忆 | ✅ 有 |

**结论:我们不是从零。骨架在了。** 这也是为什么 Annie 说现有系统「用起来也还不错」——
她是对的。

## 3. 缺的那层 & 那个回路（compiled wiki + maintenance loop）

我们有「离散的页 + 索引 + 零散互链」,缺的是 Karpathy 真正的增量:

1. **Ingest 时的『整合』,不只是『追加』**:现在新知识来了就新增一个 fact 文件;不会去
   *修订相关页、和解矛盾、加强综述*。Karpathy 的「一个源触 10-15 页」的整合,我们没有。
2. **综述/概念页(synthesis pages)**:我们是原子事实,没有*被维护的主题页*(如「关于
   Runner 生命周期我们知道的一切」这样一页,随新证据更新)。
3. **系统化的 Lint 回路**:没有定期的去重/和解矛盾/去陈旧/找孤儿页的 pass。现在的
   check-before-write 是**逐次即兴**,不是系统 pass —— 证据就是 约 190 文件 / 约 126 feedback_*
   / 一批 qa 明显有可并项,索引也在膨胀。
4. **Query 结果回填**:agent 辛苦综合出的答案蒸发在对话里,没 file back 成新页。

## 4. Karpathy 的 Ingest→Query→Lint 映射到我们（agent 怎么做）

| Karpathy op | 映射到 Flywheel agent | 现状 |
|---|---|---|
| **Ingest** | Lead/Runner 学到东西 → 写记忆:不仅新增,还更新相关页 + 标矛盾 + 更新索引 | 现在只「新增」,少「整合」 |
| **Query** | agent 答难题时先读 MEMORY.md 索引 → 钻相关页 → 综合 | 索引注入已做;**综合结果不回填** |
| **Lint** | 定期 agent pass:去重、并重叠项、标矛盾/陈旧、找孤儿 `[[链接]]`、瘦身索引 → 出**可审 diff** | **完全缺(本提案的 MVP)** |

## 5. 诚实评估:值不值得?（不硬吹）

- **反方(别做/现有够用)**:现有 memory recall 对 Lead/Runner 的活「够用」;Annie 自己
  这么说。全套 wiki(整合式 ingest + 综述页 + 语义搜索)是**明显的 over-engineering
  风险**,正是 FLY-212「做完 PR+QA 才发现没戳心坎」的坑。token 成本也真(一次整合触多页)。
- **正方(值得做的那一小块)**:唯一有**真痛证据**的缺口是 **Lint/consolidation**:
  约 190 文件、约 126 feedback_*、索引 20KB「只增不并」——这正是 Karpathy 说的「维护/bookkeeping
  是人放弃 wiki 的原因,而 LLM 不会腻」。让 agent 定期并一次,**低成本、直接对准已观测到
  的痛、纯 agent-facing**。
- **净判断**:**不建大 wiki。只做 Lint MVP。** 综述页 / query 回填 / 语义搜索 = 明确列为
  「以后再说,MVP 证明价值后」,不塞进这一版。

## 6. 小 MVP 提案（scope 小 — FLY-212 教训）

**MVP:Memory Consolidation/Lint pass（agent 自跑,输出可审 diff,绝不自动删）**

- **输入**:一个项目的 `memory/` 目录(约 190 文件 + MEMORY.md)。
- **agent 做什么**:
  1. **去重/并项**:找主题重叠的 fact 文件(如多个 qa_* / feedback_* 讲同一件事),提议
     merge 成一页(保留所有来源要点)。
  2. **标矛盾/陈旧**:找互相打架或被更新事件推翻的断言,flag 出来。
  3. **孤儿 & 断链**:找没有入链的页 + 指向不存在页的 `[[链接]]`。
  4. **索引瘦身**:提议精简/重组 MEMORY.md(它每次注入,越小越省 context)。
- **输出**:一份**consolidation 提案 diff**(哪些并、哪些删、哪些改索引)+ 理由,交
  founder/Lead review 后才落。**可逆、不自动删**(对齐记忆规则「delete 前先看、不是你建的先surface」)。
- **不是什么**:不是新数据库、不是向量 RAG、不是人类 UI、不是重写记忆系统 —— 就是一个
  跑在现有 markdown 记忆上的维护 pass。
- **验证成功 = 什么为真**:跑一遍能把 约 190→更少且不丢信息、索引更小、矛盾被标出;Lead 用
  consolidation 后的记忆一段时间,recall 不降(最好升)。

**留后(不在 MVP)**:B) 维护式综述/概念页;C) query 结果自动回填;D) 大规模上 qmd 语义搜索。

## 7. Scope 边界 / 非目标

- ❌ 不做人类 UI(Obsidian/Notion/graph)。
- ❌ 不重写 / 不替换现有 MEMORY 系统 —— 在它之上加一个维护 pass。
- ❌ 不自动删记忆 —— 只出可审 diff。
- ❌ 不上向量库 / 语义搜索(MVP 阶段 index-first 够用,Karpathy 亲述 ~100 页 index 就够)。

## 8. 给 Annie 的取舍

1. **做 MVP(Memory Lint pass)** —— 我推荐,小、对准真痛、纯 agent-facing。
2. 做**更大**的(整合式 ingest + 综述页) —— 我建议先别,等 MVP 证明。
3. **先不做**,现有够用,只把这套理解存档。
4. 改方向 / 还要深入(在 HTML 评论里写)。

> 交付:本提案 + 一页可交互 HTML(FLY-930 nonce + Apple 浅色 + 每节评论框 + 倾向选择),
> 交 Lead relay Annie co-review。**不 build code、不 ship、不 close。**
