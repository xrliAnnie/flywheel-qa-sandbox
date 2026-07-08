# FLY-347 用 LLM 构建个人知识库 — 调研(讲清源头:Karpathy 的方法 + 通用做法)

Issue: FLY-347 (https://linear.app/geoforge3d/issue/FLY-347/xhsclaude-karpathy用-llm-构建个人知识库token-从处理代码转向处理知识)
日期: 2026-07-08
基于: exploration.md

---

> 本轮任务(Lead 6477fff6 / Annie):**不 close**。先把「用 LLM 构建个人知识库到底
> 怎么做」从源头讲清 —— 重点扒 Karpathy 的原始说法 + 研究通用做法。判重(我们已有 vs
> Karpathy)降级为一个对比小节,不作 close 理由。查不到的标 **UNKNOWN**。

## 0. 主源(primary sources)

| 源 | 链接 | 性质 |
|---|---|---|
| Karpathy 原推 "LLM Knowledge Bases" | https://x.com/karpathy/status/2039805659525644595 | 一手(推文,x.com 需登录,**未逐字核到全文**) |
| Karpathy gist "LLM Wiki"(**idea file**) | https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f | **一手,已逐字核到全文** —— 本文引用以此为准 |
| VentureBeat 报道(bypasses RAG) | https://venturebeat.com/data/karpathy-shares-llm-knowledge-base-architecture-that-bypasses-rag-with-an | 二手(fetch 时 429,未核) |
| 多篇 how-to(MindStudio/codersera/Medium 等) | 见 §7 sources | 二手实操指南 |

**对 Annie「他大概没 GitHub」的更正**:他**有**公开产出,但那是一份 GitHub **gist
『思路文件(idea file)』,不是一个可跑的仓库/工具**。gist 开头原话:"This is an idea
file, it is designed to be copy pasted to your own LLM Agent... Its goal is to
communicate the high level idea, but your agent will build out the specifics in
collaboration with you." —— 即他给的是**模式(pattern)**,不是实现;具体目录/脚本/
schema 由你和你的 agent 一起搭。

## 1. 一句话 & 源头 framing

Karpathy 的核心 framing(原推,~2026 年 4 月,16M+ 阅读;**这段是二手转述,未逐字核**):
> "using LLMs to build **personal knowledge bases** for various topics of research
> interest. ... a large fraction of my recent token throughput is going less into
> manipulating **code**, and more into manipulating **knowledge**"(以 markdown +
> 图片存储)。

规模(**UNKNOWN / 二手**):据报道他某个研究主题的 wiki ~100 篇文章 / ~400K 字。
gist 里只写"~100 sources, ~hundreds of pages",没给 400K 字这个数 → 标 UNKNOWN。

## 2. 核心思路:为什么这不是 RAG(gist 逐字)

gist 开篇就把它和 RAG 对立(以下引号内为原文):

- RAG 的问题:"you upload a collection of files, the LLM retrieves relevant chunks
  at query time... **the LLM is rediscovering knowledge from scratch on every
  question. There's no accumulation.**"(NotebookLM / ChatGPT 文件上传都是这样)
- 这个方法不同:"the LLM **incrementally builds and maintains a persistent wiki** —
  a structured, interlinked collection of markdown files that sits between you and
  the raw sources." 新来一个源,LLM 不是只索引待查,而是"reads it, extracts the key
  information, and **integrates it into the existing wiki** — updating entity pages,
  revising topic summaries, noting where new data contradicts old claims..."
- 关键差异:"**the wiki is a persistent, compounding artifact.**" —— 交叉引用已经在了、
  矛盾已经标了、综述已反映你读过的一切;每加一个源、每问一个问题,wiki 都更富。
- 分工:"You never (or rarely) write the wiki yourself — the LLM writes and maintains
  all of it." 你负责选源、探索、问对问题;LLM 干所有 grunt work。他的原话工作流:
  "**Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase.**"

## 3. 三层架构(gist 逐字)

1. **Raw sources** —— 你精选的源文档(文章/论文/图片/数据)。**不可变**,LLM 只读不改,
   是 source of truth。
2. **The wiki** —— 一堆 LLM 生成的 markdown(摘要页/实体页/概念页/对比/综述/overview)。
   "**The LLM owns this layer entirely.**" 建页、更新、维护交叉引用、保持一致 —— 你读、
   LLM 写。
3. **The schema** —— 一份 `CLAUDE.md`(Claude Code)或 `AGENTS.md`(Codex)文档,告诉
   LLM wiki 怎么组织、约定是什么、ingest/query/维护各走什么 workflow。"**it's what
   makes the LLM a disciplined wiki maintainer rather than a generic chatbot.**" 你和
   LLM 随时间共同演化它。

## 4. 三个操作 + 两个特殊文件(gist 逐字)

- **Ingest**:把源丢进 raw,让 LLM 处理 —— 读源 → 和你讨论要点 → 写摘要页 → 更新 index
  → 更新相关实体/概念页 → 追加一条 log。"A single source might touch **10-15 wiki
  pages**." 可一次一条盯着做,也可批量少监督。
- **Query**:问 wiki,LLM 搜相关页 → 综合 + 引用。答案形态可以是 md 页 / 对比表 /
  Marp 幻灯 / matplotlib 图。关键:"**good answers can be filed back into the wiki as
  new pages.**" —— 探索的产物也 compound 进库。
- **Lint**:定期让 LLM 体检 wiki —— 找矛盾、过时断言、孤儿页(无入链)、缺自己页的重要
  概念、缺失交叉引用、可用 web 搜补的数据缺口。

两个导航文件:
- **index.md**(内容维度):全库目录,每页一链 + 一行摘要,按类别组织,每次 ingest 更新。
  答 query 先读 index 再钻。"works surprisingly well at moderate scale (~100 sources,
  ~hundreds of pages) and **avoids the need for embedding-based RAG infrastructure**."
- **log.md**(时间维度):append-only,记 ingest/query/lint。前缀一致(如
  `## [2026-04-02] ingest | Article Title`)就能 `grep "^## \[" log.md | tail -5`。

## 5. 工具与技巧(gist 逐字)

- **Obsidian Web Clipper**:浏览器扩展,把网页转 markdown 进 raw。
- **图片本地化**:Obsidian 设置里把附件目录设成固定路径(如 `raw/assets/`)+ 绑热键
  "Download attachments for current file",clip 完一键把图下到本地。注意:"**LLMs
  can't natively read markdown with inline images in one pass**" —— 变通是先让 LLM 读
  文字、再单独看图。**他明说这一步"a bit clunky but works well enough"**(诚实的局限)。
- **Obsidian graph view**:看 wiki 形状(枢纽页 / 孤儿页)。
- **Marp**(md 幻灯)、**Dataview**(按 frontmatter 查询生成动态表)。
- **wiki 就是一个 git repo**:白拿版本历史 / 分支 / 协作。
- **可选 CLI 工具**:小规模 index 就够;大了要真搜索,推荐 **qmd**(本地 markdown 搜索,
  BM25+向量+LLM 重排,有 CLI 也有 MCP)。https://github.com/tobi/qmd

## 6. 为什么行 + 它像什么(gist 逐字)

- "The tedious part of maintaining a knowledge base is not the reading or the
  thinking — **it's the bookkeeping.**" 人放弃 wiki 是因为维护负担涨得比价值快;LLM
  "don't get bored, don't forget to update a cross-reference, and can touch 15 files
  in one pass." 维护成本≈0,库就一直活着。
- 思想血缘:**Vannevar Bush 的 Memex(1945)** —— 私人、主动策展、文档间的关联和文档
  本身一样值钱。Bush 没解决的是"谁来维护";"**The LLM handles that.**"

## 7. 能用在哪(gist 列的场景)

个人(目标/健康/心理/自我提升,把日记+文章+播客笔记沉淀成结构化自画像)、研究(数周数月
深挖一个主题,论文/报告 incrementally 建综述,thesis 不断演化)、读书(每章归档,建人物/
主题/情节页 —— 像 fan wiki 那样)、business/team(内部 wiki 喂 Slack/会议纪要/项目文档,
LLM 做没人愿做的维护)、竞品分析/尽调/行程规划/课程笔记/爱好深挖。

> Sources(二手实操指南,供 Annie 深挖):
> - MindStudio: https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code
> - codersera: https://codersera.com/blog/karpathy-llm-knowledge-base-second-brain/
> - Medium(Urvil Joshi): https://medium.com/@urvvil08/andrej-karpathys-llm-wiki-create-your-own-knowledge-base-8779014accd5
> - Level Up(Beyond RAG): https://levelup.gitconnected.com/beyond-rag-how-andrej-karpathys-llm-wiki-pattern-builds-knowledge-that-actually-compounds-31a08528665e

## 8. 通用做法全景(不只 Karpathy)

把「用 LLM/工具做个人知识库」放到更大图里,三条路线:

| 路线 | 代表 | 检索方式 | 特点 / 局限 |
|---|---|---|---|
| **RAG / 上传即查** | NotebookLM、ChatGPT 文件上传、向量库 | query 时取 chunk | 上手快;**不累积**,每次从头拼(Karpathy 的批评) |
| **传统 PKM(人维护)** | Obsidian、Roam、Logseq、Zettelkasten(Luhmann)、Second Brain/PARA(Tiago Forte) | 人建互链 + 全文搜 | 结构好;**维护靠人,库常烂尾** |
| **Agentic markdown wiki(LLM 维护)** | **Karpathy 的 LLM Wiki** | index-first,大了加 qmd/LlamaIndex 语义搜 | 累积 + LLM 维护;**新,吃 token,规模/新鲜度是开放问题** |

诚实的开放问题(局限):
- **规模上限 UNKNOWN**:index-first 在 ~100 源 / 数百页够用,再大要上语义搜索,成本与
  质量的曲线没有公开定论。
- **token 成本**:一次 ingest 触 10-15 页 = 明显 token 开销(正是"token 从代码转向知识"
  的字面代价)。
- **图片**:LLM 一次读不了内联图,要文字/图分开读 —— 他自己说 clunky。
- **新鲜度 vs 矛盾**:靠定期 lint 兜,不是自动强一致。

## 9. 对比小节:Flywheel 我们已有 vs Karpathy 差距(现状对照,**不是 close 理由**)

| Karpathy 方法的环节 | Flywheel 现状最接近的东西 | 差距/关系 |
|---|---|---|
| raw → 持续编译成互链 wiki | `/compound`→`docs/solutions`、文件式 MEMORY | 我们是**离散手动沉淀**,不是持续编译的互链 wiki;无 backlinks/lint/index.md/log.md 纪律 |
| LLM 把零散输入结构化 | `xiaohongshu-learning` 闭环(它生成了 FLY-347) | 已在做,但产物是 **Linear 草稿**,不是 compounding wiki |
| 个人研究主题库 | **Annie 的 Notion 第二大脑(FLY-510)** | 另一种 substrate(Notion vs markdown+Obsidian+agent) |
| schema=CLAUDE.md 把 agent 变 wiki 维护者 | 各 repo `CLAUDE.md` / `.flywheel/` | 我们的 CLAUDE.md 是给 dev agent 的,不是 wiki 维护 schema |

一句话:**同向、精神相近,但没有 Karpathy 那套「持续编译 + 互链 + lint + index/log」的
知识库形态**;Annie 个人层已有 Notion。这是理解用的对照,**要不要做由 Annie 理解后再定**。

## 10. UNKNOWN / 诚实边界

- Karpathy 原推全文**未逐字核到**(x.com 需登录);framing/规模是二手转述。gist 全文**已
  逐字核到**,本文引用以 gist 为准。
- "~400K 字" 规模数**未在 gist 出现**,来自二手 → UNKNOWN。
- 他**没有开源可跑的实现/仓库**,只有 gist idea file + 提到第三方 `qmd`。任何"他的具体
  目录结构/脚本"都是社区二手指南的演绎,非他官方。
- 通用做法里 PARA/Zettelkasten 等是既有 PKM 常识,非本命题独有。

## 11. 交付 & 下一步

- **交付**:本调研 + 一页**可交互 HTML**(讲清 Karpathy 方法 + 通用做法 + 对照小节),
  给 Annie 逐节留言/深入。HTML 用 FLY-930 nonce + Apple 浅色 + 每节评论框 + 导出。
- **下一步**:Annie 在 HTML 上继续深入再定 —— 自己用 Karpathy 法搭一个 / Flywheel 做成
  产品能力 / 先不做。**不自决、不 close。**
