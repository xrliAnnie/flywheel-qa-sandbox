# FLY-1230 多-agent 编排会不会被单 agent 取代 — 探索

Issue: FLY-1230 (https://linear.app/geoforge3d/issue/FLY-1230/research-多-agent-编排会不会被单-agent-模型能力取代-业界视角-chatgpt-deep-research)
日期: 2026-07-13
基于: 无（上游 = Annie 2026-07-13 的战略疑问 + issue 正文；DR 报告为本任务现做）

## 一句话

Annie 的战略疑问:我们做这么多 DAG / multi-agent 编排,会不会是**过度设计** —— 到时候一个足够强的单 agent 就把活全干完了,根本不需要?本任务用 **ChatGPT Deep Research** 收集**业界视角**(研究 + 头部实践者 + 产品),用 Annie 给的**「拐杖 vs 信任地基」框架**当**验证/挑战对象**(不是结论),做一份**中文互动 co-eval explainer**,把决定权留给 Annie + HL,并把结论落到我们四个 DAG 程序(1020/1135/1140/1141)上按「拐杖 vs 地基」尺子取舍。

## Annie 的疑问原样（研究要回答的核心）

> 「多-agent 编排 / workflow DAG」在模型能力快速提升的趋势下,**哪些部分会被单 agent 吸收掉、哪些部分是持久的?** 业界怎么看「multi-agent 编排会不会被单 agent 取代」。

## 她给的判断框架（供验证/挑战,不是结论）

| 类别 | 定义 | 命运 | 例子 |
|---|---|---|---|
| **拐杖类编排** | 多 agent 的**唯一理由**是「模型扛不住整块活,切成一步步喂」 | 模型变强 → 多余,该砍薄 | 僵硬的 design→implement→QA 死步骤 |
| **信任地基类编排** | 提供**独立性 / 交叉检查 / 安全 / 审计 / 人对不可逆动作的控制** | agent 越强越重要,会长 | reviewer ≠ doer 且跨公司(自己审自己=假审,再聪明也有盲区);ship 闸 / founder 批准(FLY-1211) |

**判据(Annie 的尺子):**
- **「就算 agent 聪明 10 倍也依然需要」→ 护城河**(地基);
- **「只是替不够强的模型打拐杖」→ 该砍薄**(拐杖)。

这套框架是我们**已有的一个判断**,不是定论 —— 本研究就是拿业界视角来**验证或挑战它**:哪里对、哪里过简、有没有它没覆盖的第三类。

## 四个 DAG 程序(结论要能直接指导它们)

这四个是 Tadashi 的 DAG 建设程序,也正是 Annie 疑问的落点 —— 每一块都要用「拐杖 vs 地基」量:

| 程序 | 是什么 | 初判(待业界视角验证) |
|---|---|---|
| **FLY-1020** | 任务类别 → DAG 模板(静态模板 = 现状) | 偏拐杖?静态死步骤最像被吸收的一类 |
| **FLY-1135** | 编排引擎 + **ship 闸机理**(required-checks 按最新 sha、stale-approval 自动作废、task-token 短时效 claim、in-toto/SLSA digest 绑定) | 偏地基?这是安全/审计/不可逆动作控制的机理层 |
| **FLY-1140** | 动态编排(Lead 派发、决策权覆盖层、record/复盘、进化阶梯) | 混合?派发/复盘偏地基,固定步骤偏拐杖 |
| **FLY-1141** | 花名册 / 人才库(一堆 Agent File;谁演角色、冲突归属路由) | 混合?独立角色供给偏地基 |

> 弹药:FLY-1135 已有一份 ChatGPT DR《Workflow-Orchestration Patterns for a Multi-Agent Coding System》(21 引用),讲 required-checks/stale-approval/in-toto —— 本研究可交叉印证,但主 DR 是**新做的、面向 Annie 这条疑问**。

## 关键决策

### 决策 1 — DR 主路径 + 回退（技术,非产品）
- **主**:ChatGPT Deep Research(deep-research skill,骑 ChatGPT Plus)。Browser 1 本地 headed 已连,主路径可用。
- **回退**:若 claude-in-chrome 配对/跨域 iframe 受阻 → `last30days` / web research,并在报告顶部**标明用了回退**。
- **诚实红线**:查不到的标 **UNKNOWN**,绝不编来源、不编数据。

### 决策 2 — explainer = co-eval,不下结论（产品红线,Lead 二次强调）
- HTML = **业界怎么说 + 对照我们的框架 + 把决定权留给 Annie**,**不是「结论是 X」**。
- 逐块(四个 DAG 程序)留 **Annie 的留言框**;摆多方观点(含互相矛盾的),不替她/HL 拍「该不该做 DAG」。

### 决策 3 — 交付模型 = A（Lead 已拍板）
- Runner **产出** HTML 写进 doc 文件夹 + **host-only 发布**(POST `/api/reports/publish`,不发 Discord、不 deliver)→ nonce URL 经 `ask --report` 交 Lead。
- Lead **实读内容 QA**(核诚实/有来源/没编 + 渲染正常)后**投 Annie**。守「founder 不收未过审产出」靠 Lead 的 QA,不靠「Lead 自己产」。

## 边界

不下结论、不投 Discord、不 ship、不动 main、不自 merge、不自建 Linear issue。纯:做 DR + 写 co-eval explainer + host-only 发布 + 交 Lead。doc-flow full(exploration/research/plan 随分支走、随 docs PR 合 main)。
