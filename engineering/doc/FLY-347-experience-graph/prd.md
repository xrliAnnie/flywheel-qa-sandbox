# FLY-347 Run 教训沉淀(Run Lessons) — PRD (draft v2, 瘦身版)

Issue: FLY-347 (https://linear.app/geoforge3d/issue/FLY-347/xhsclaude-karpathy用-llm-构建个人知识库token-从处理代码转向处理知识)
日期: 2026-07-08
基于: product/doc/FLY-347-llm-knowledge-base/proposal.md, engineering/doc/FLY-347-experience-graph/prd.md (v1)

> 状态:**draft v2**。Annie shape-review 后**大幅瘦身**(她的简化本能对):去掉图、去掉独立
> pipeline、收成一件事、时机改到 ship 前写进同一个 PR。原名『经验图谱』——**MVP 不是图**,
> 图/关系是 far-future(见 §2)。未 create build issue、未 ship。

---

## 1. 建出来是什么样(具体、够 Tadashi 直接建)

**一句话**:**Runner 在 ship 前,把这趟 run 学到的教训用 LLM 写成一个 markdown 文件、提交进
同一个 PR、跟代码一起 ship;下次 Runner 起活时,按标签/关键词捞出相关的几个教训文件读一读,
不重踩老坑。** 就这么简单 —— 几个 markdown 文件,不是图、不是数据库、不是独立服务。

### 1.1 写(ship 前,进同一个 PR)

- **触发点(写死)**:在 Runner 的 ship 准备阶段 —— **它确认要 ship、准备请求 approve 之前**
  (即 `gate approve_to_ship` / `complete --route needs_review` 之前那一步)。此时 Runner 用
  LLM **给这趟 run 写一段简短复盘**(自己回看:踩了什么坑、根因、下次怎么避)。
  - 为什么放这一步:这样教训文件**进入被 review 的 diff、跟代码一起 ship**,而且**不会在批准
    之后再改 PR head**(避免 head drift 要重审 —— FLY-945)。
- **写什么(格式,写死)**:一个文件 `knowledge/lessons/<ISSUE>-<slug>.md`,内容极简:

```markdown
---
issue: FLY-176
tags: [bridge, restart, process-kill]
---
# 改 Bridge 重启逻辑:PID 变量要加引号

**踩的坑**: restart-services.sh:523 的 multi-line PID 没加引号 → kill 静默失败 → 手动重启。
**避法**: PID 加引号,或 pgrep -f run-bridge | xargs kill -9。
```

  - frontmatter 只两项:`issue`(溯源)+ `tags`(下次按它捞;从这单碰的子系统/失败类型取词)。
  - 正文只要两块:**踩的坑** + **避法**(标题一句话点题)。需要就手加 `[[别的教训文件名]]` 链一下,
    **不强制、不搞索引**。
- **存哪(写死)**:目标 repo 里 `knowledge/lessons/`(和代码同 repo),随 PR 合进 main。
- **没值得记的就不写(白话)**:这趟 run 平淡、没踩到值得记的坑,就**跳过,不硬写一个**
  (对应『抽取不确定就不写』)。宁缺毋滥,别用废话污染。

### 1.2 读(下次 Runner 起活时)

- **何时**:Runner/Lead 起活(onboard 阶段)自动做一次。
- **怎么捞(简单,写死)**:扫 `knowledge/lessons/*.md`,按**这单 issue 的标签/关键词**(从 label +
  标题 + 大概率碰的子系统取)和各文件 frontmatter 的 `tags` 做**简单匹配**(tag 交集 / 关键词
  grep)→ 命中的几个教训文件读进来。**不搞向量、不搞图检索、不建索引** —— 小规模直接扫目录够用。
- **怎么用**:Runner 开工前读到相关教训 → 不把老坑重踩一遍。

### 1.3 一个真实例子(端到端)

1. 某 Runner 干 FLY-176(改 Bridge 重启),踩了「PID 没加引号 kill 失败」的坑,修好。
2. ship 前它写 `knowledge/lessons/FLY-176-bridge-pid-quote.md`(上面那个格式),提交进 PR,一起 merge。
3. 三周后另一个 Runner 起活要再动 Bridge restart → 起活时按 tag `[bridge, restart]` 扫到这个文件 →
   读到「PID 要加引号」→ 直接避开,不重踩。

### 1.4 闭环(简化)

```
Runner 干活 ──▶ 修好 ──▶ ship 前用 LLM 写 1 个教训 md ──▶ 提交进同一个 PR ──▶ 随代码 ship
                                                                                    │
下一个 Runner 起活 ◀──按 tag/关键词扫 knowledge/lessons/ 捞相关教训──────────────────┘
        └──读到相关教训──▶ 避坑开工
```

## 2. 明确砍了什么(直接回答『为什么不是图』)

Annie 问得对 —— **MVP 不该是图**。以下全部**砍出 MVP**,归为 far-future(真需要再说):

| 砍掉的 | 为什么 |
|---|---|
| **图结构**(节点类型/边/关系) | 过度设计。MVP 就是几个 markdown 文件,文件间需要才手加 `[[链接]]`。 |
| **正式 index / 目录文件** | 小规模扫目录 + tag 匹配够用,不用维护索引。 |
| **向量 / 语义检索(pgvector)** | 简单 tag/关键词捞够用;规模真大了再说。 |
| **独立 post-run 抽取 pipeline / 服务** | 不做后台管道。就是 ship 前 Runner 自己顺手写一个文件。 |
| **拆成 EG-1..4 多个 issue** | Annie 明确嫌多易忘。收成**一件事**(见 §3)。 |

## 3. MVP = 一件事(不拆)

**一个功能**:『**Runner ship 前写一个教训 markdown 进 PR** + **下次 Runner 起活按 tag/关键词读相关教训**』。
两半是一体(写 + 读),一个 build issue 做完。不拆 EG-1..4。

## 4. 跟现状差距 + 为什么值得

- **现状**:教训靠人事后**记得**才手写进 MEMORY(已有 123 feedback + 31 qa),大量 run 的教训蒸发;
  即使写了,起活也只能整份 `MEMORY.md` 注入靠运气命中。mem0 `MemoryService` 代码在但 pgvector 没接、
  主力人工 markdown。
- **差距 / 为什么值得**:把「写教训」**固定成 ship 流程的一步**(不靠人记得)、把「读教训」**固定成起活
  的一步**(按需捞、不靠运气)。省的是重复 debug 的真实时间。诚实:这是很**薄的一层流程 + 约定**,不是
  新系统 —— 正合 Annie 的简化本能。

## 5. 常规 PRD 段

- **Problem**:run 的教训现在靠人记得才留、且留了也难被下次精准读到 → 同类坑反复重踩。
- **Users**:Runner(ship 前顺手写、起活自动读)、Lead(间接受益:派出去的活少踩老坑)。人不直接管这些文件。
- **Goals**:① ship 前写教训成为流程一步(不靠人记得)② 起活按 tag 读到相关教训 ③ 全用 repo 里 markdown,零新基建。
- **Non-goals**:不做图/索引/向量检索;不做独立后台 pipeline;不重写 MEMORY;不跨项目;不自动删。
- **Success metrics**:① 接真实 ship 流后,有值得记的 run 能稳定产出 1 个教训文件、没值得的跳过(不硬写)②
  起活能按 tag 捞到相关教训(拿 Bridge / Discord E2E 两类真教训做验收:再动这俩能捞到已知坑)③ 一段时间后
  同类坑重踩下降(定性)④ 不拖慢 ship / 起活。
- **Open questions**(给 Tadashi):
  1. 教训写在 approve 前(进 reviewed diff)还是 :cool: 前(能记到 ship 阶段的坑)?**建议默认 approve 前**,避免 head drift。
  2. tag 从哪取(label / 标题 / diff 文件路径)?**建议 MVP:label + 标题关键词**,够简单。
  3. 起活「读」挂在 onboard 的哪一步、注入多少条(top-N/字数上限)避免撑 context?
  4. `knowledge/lessons/` 放目标 repo 根,还是 `doc/` 下?(建议 repo 根 `knowledge/lessons/`。)

## 6. 交给 Tadashi(一个 build issue —— draft 阶段不建)

> 等 Annie 确认『样子』OK,再由 Lead/Tadashi 建**一个** issue。

- **Run 教训沉淀 MVP(一件事)**:① 在 Runner ship-prep(approve 前)加一步:用 LLM 写
  `knowledge/lessons/<ISSUE>-<slug>.md`(格式见 §1.1),提交进当前 PR;没值得记的跳过。
  ② 在 Runner 起活(onboard)加一步:按本单 tag/关键词扫 `knowledge/lessons/` 捞相关教训注入 context。
  一个 PR 做完两半。**不拆子 issue。**
