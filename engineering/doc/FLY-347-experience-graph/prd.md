# FLY-347 Run 教训沉淀(Lesson Library) — PRD (draft v3)

Issue: FLY-347 (https://linear.app/geoforge3d/issue/FLY-347/xhsclaude-karpathy用-llm-构建个人知识库token-从处理代码转向处理知识)
日期: 2026-07-08
基于: engineering/doc/FLY-347-experience-graph/prd.md (v2), product/doc/FLY-347-llm-knowledge-base/proposal.md

> 状态:**draft v3**。Annie v2 shape-review(lean=tweak)后:加回**轻量 index** + **lint/合并**
> (她判定必须——光叠加会烂),加一张 **data-flow 图**,写清 **LLM 抽取 = Runner 本身**。
> **图 / 向量仍不做**(她确认 not-now)。这仍是**一个连贯功能**(库的 写/索引/lint/读 四面),
> 不是 4 个散 build。未 create build issue、未 ship。

---

## v2 → v3 变了什么(先说清)

| | v2(上一版) | v3(本版) |
|---|---|---|
| 轻量 index/目录 | 砍了 | **加回**(写时更新,查得快) |
| lint / consolidation | 砍了 | **加回**(定期去重/合并/退役过时,防库烂 —— 这是 347 最早 Memory Lint 核心,绕回来了) |
| data-flow 图 | 无 | **加**(写→索引→lint→读,inline SVG) |
| 图结构 / 向量检索 | 砍 | **仍砍**(far-future / not-now) |
| 拆分 | 一件事 | **仍一件事**(库的四面一体,不是 4 个散 issue) |

## 1. 建出来是什么样(具体、够 Tadashi 直接建)

**一句话**:一个**连贯的 lesson 库** —— 就是 repo 里 `knowledge/lessons/` 下的一堆 markdown +
一个轻量 index。它有**四面**:**写**(ship 前 Runner 把教训写进同一个 PR)、**索引**(写时更新
目录)、**lint**(定期去重合并、退役过时,防库烂)、**读**(下次 Runner onboard 先查 index 捞相关
教训)。不是图、不是数据库、不是后台服务。

### 1.1 写(ship 前,进同一个 PR)—— LLM 抽取 = Runner 本身

- **谁写**:**就是 Runner 自己**(用它手上的 LLM 给这趟 run 写段复盘)——不是另起一个抽取服务/agent。
- **时机(写死)**:Runner 确认要 ship、**请求 approve 之前**那一步(进被 review 的 diff、不 head drift)。
- **没值得记的就跳过**(白话:这趟平淡没踩坑,就不硬写一个)。
- **写成什么样**(`knowledge/lessons/<ISSUE>-<slug>.md`):

```markdown
---
issue: FLY-176
tags: [bridge, restart, process-kill]
---
# 改 Bridge 重启逻辑:PID 变量要加引号
**踩的坑**: restart-services.sh:523 的 multi-line PID 没加引号 → kill 静默失败 → 手动重启。
**避法**: PID 加引号,或 pgrep -f run-bridge | xargs kill -9。
```

### 1.2 索引(轻量 index,写时更新)

- **一个文件 `knowledge/lessons/index.md`**:每条 lesson 一行 —— `文件名 · 一句话 · tags`,按 tag/子系统归类。
- **谁更新**:写 lesson 的同一步(§1.1)顺手加/改 index 的那一行。**轻量**——不是数据库、不是图,就是一个目录 md。
- **干嘛用**:下次查(§1.4)先读 index 快速定位相关的几条,再钻具体文件,不用全扫。

### 1.3 lint / consolidation(定期,防库烂 —— Annie 判定必须)

- **为什么必须**:光往里叠加,库会长出**重复 / 矛盾 / 过时**(这正是我们现在 MEMORY 187 文件的病)。
  不 lint,库越大越没人信。
- **怎么做**:一个**定期 lint pass**(手动触发 or 低频定时)扫整库 —— **去重**(合并讲同一坑的多条)、
  **退役过时**(被新 run 推翻的标记/移出)、**清孤儿 / 修 index**。
- **安全约定(沿用 347 最早 Memory Lint MVP)**:输出**可审 diff**,人/Lead review 后才落,**可逆、绝不自动删**。

### 1.4 读(下次 Runner onboard)

- **何时**:Runner/Lead 起活(onboard)自动做一次。
- **怎么捞**:先读 `index.md`,按**这单的 tag/关键词**(label + 标题 + 子系统)匹配 → 命中的几条 lesson 读进来。
  **不搞向量、不搞图** —— index + tag 匹配足够。
- **怎么用**:开工前读到相关教训 → 不重踩老坑。

### 1.5 data-flow / 时序(写 → 索引 → lint → 读)

见 shape HTML 里的 inline SVG 图。文字版:

```
Runner 跑一个 run ──ship 前──▶ ①写 lesson.md(+②更新 index.md)──▶ 进同一个 PR ──merge──▶ lesson 库
                                                                                          │
                                                              ③定期 lint(去重/合并/退役,可审 diff)◀┤
                                                                                          │
下一个 Runner onboard ──④先读 index → 按 tag 捞相关 lesson──────────────────────────────────┘
        └──读到相关教训──▶ 避坑开工 ──(它 ship 时又写)──▶ …
```

四面构成一个自我保鲜的库:写让它长、index 让它查得快、lint 让它不烂、读让它被用上。

### 1.6 真实例子(端到端)

1. Runner 干 FLY-176(改 Bridge 重启)踩了「PID 没加引号」坑,修好。
2. ship 前它写 `FLY-176-bridge-pid-quote.md` + 在 index.md 加一行,提交进 PR,一起 merge。
3. 三周后另一 Runner 要再动 Bridge → onboard 读 index → 按 tag `[bridge,restart]` 捞到它 → 避开。
4. 半年后库里 Bridge 相关 lesson 攒到十几条、有俩讲同一件事 → 一次 lint pass 把它们合并成一条、退役一条过时的 → 库保持干净。

## 2. 仍然砍什么(图/向量 still not now)

| 砍掉的 | 为什么 |
|---|---|
| **图结构**(节点类型/边/关系) | 过度设计;库里文件需要才手加 `[[链接]]`,不搞正式图。**far-future**。 |
| **向量 / 语义检索(pgvector)** | index + tag 匹配够;Annie 确认 not-now。 |
| **独立后台抽取服务** | 不做;写 = Runner ship 前顺手,lint = 定期跑一个 pass。 |
| **拆成多个 build issue** | 仍**一件事**(库的四面一体),不是 4 个散的。 |

## 3. MVP = 一个连贯功能(库的四面,不是 4 个散 build)

**一个 lesson 库**,四面一体:**写**(ship 前进 PR)+ **索引**(写时更新)+ **lint**(定期合并)+
**读**(onboard 查)。四面服务同一个库、一起做才成立(只写不 lint 会烂、有 index 才查得快),所以是
**一个连贯功能 / 一个 build issue**,不是 4 个散活 —— 跟 Annie「别搞 4 个散的」不冲突。

## 4. 跟现状差距 + 为什么值得

- **现状**:教训靠人**记得**才写进 MEMORY(已有 123 feedback + 31 qa,而且**已经在烂**:重复/只增不并);
  起活整份 MEMORY.md 注入靠运气;mem0 代码在但 pgvector 没接、主力人工 markdown。
- **为什么值得**:把**写**固定成 ship 一步(不靠记得)、把**读**固定成 onboard 一步(按 index 捞、不靠运气)、
  用 **lint** 防它重蹈 MEMORY 越攒越烂的覆辙。省的是重复 debug 的真实时间 + 一个不会烂的库。诚实:仍是**薄的
  一层流程 + 约定**(markdown + 一个 index + 一个定期 pass),不是新系统。

## 5. 常规 PRD 段

- **Problem**:run 教训靠人记得才留、留了难被下次精准读到、且只叠不并会越攒越烂 → 同类坑反复重踩、库不可信。
- **Users**:Runner(ship 前写 / onboard 读)、Lead(间接少踩老坑 + 审 lint diff);人不直接管文件。
- **Goals**:① ship 前写教训成流程一步 ② onboard 按 index 读到相关 ③ 定期 lint 保库不烂 ④ 全用 repo markdown 零新基建。
- **Non-goals**:不做图/向量;不做后台抽取服务;不重写 MEMORY;不跨项目;lint **不自动删**(只出可审 diff)。
- **Success metrics**:① 有值得记的 run 稳定产 1 教训 + 更新 index、没的跳过 ② onboard 按 tag 捞到相关(Bridge/Discord 两场景验收)③ lint pass 能把重复/过时合并退役、出可审 diff ④ 一段时间后同类坑重踩降、库不膨胀失控 ⑤ 不拖慢 ship/onboard。
- **Open questions(给 Tadashi)**:
  1. 写在 approve 前 vs :cool: 前?**建议 approve 前**(避 head drift)。
  2. tag 从哪取?**建议 label + 标题**。
  3. lint 触发:纯手动 / 低频定时 / 攒到 N 条触发?**建议先手动 + 可低频定时**。
  4. index 格式(纯目录 md vs 带 frontmatter)+ onboard 注入量级(top-N/字数上限)。
  5. lint diff 谁审(Lead / founder)?**建议 Lead 审**(沿用 review 后才落)。

## 6. 交给 Tadashi(一个 build issue —— draft 阶段不建)

> 等 Annie 确认『样子』OK,再由 Lead/Tadashi 建**一个** issue。

- **Run 教训库 MVP(一件事,库的四面)**:
  1. **写**:Runner ship-prep(approve 前)加一步,用 LLM 写 `knowledge/lessons/<ISSUE>-<slug>.md`(§1.1 格式),没值得记的跳过;
  2. **索引**:同一步更新 `knowledge/lessons/index.md` 的一行;
  3. **读**:Runner onboard 加一步,读 index → 按 tag 捞相关 lesson 注入 context;
  4. **lint**:一个可手动/低频定时跑的 lint pass,去重/合并/退役过时 → 可审 diff(不自动删)。
  一个 PR / 一个 issue 做完这四面。**不拆子 issue。**
