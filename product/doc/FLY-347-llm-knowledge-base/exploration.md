# FLY-347 用 LLM 构建个人知识库 — 探索

Issue: FLY-347 (https://linear.app/geoforge3d/issue/FLY-347/xhsclaude-karpathy用-llm-构建个人知识库token-从处理代码转向处理知识)
日期: 2026-07-08
基于: 无

---

## 0. 这个 issue 到底是什么(先摆清楚,避免误做)

FLY-347 是 `xiaohongshu-learning` 学习闭环**自动生成的灵感草稿**(FLY-286 pilot),
Low 优先级 / Backlog / label `Flywheel-Product`。它是 Product Lead task 清单里
「Cass 的 5 个 XHS-learning 方向 — research → PRD/close(353/336/346/**347**/343)」
之一。

**因此它的交付物不是"写代码建功能",而是"研究这个方向 → 要么收敛成一个 PRD,要么
带理由 close"。** 这一点很关键 —— FLY-212 的教训是"整条做到 PR+QA 才被作废'没戳
心坎'";一个 Backlog 灵感草稿绝不该被独自臆想成一个功能去建。本文档是那个研究的
第一步(问题定义 + 现状审计 + keep/close 选项),给 Lead 一个有依据的方向决策。

## 1. Karpathy 讲了什么

> 用 LLM 为自己感兴趣的**研究主题**构建个人知识库。消耗的大量 token 不再主要用于
> 处理代码,而是更多用于**处理知识本身**(以 markdown 和图片形式存储)。最新一代
> LLM 在这件事上已经相当强了。

社区补充信号:
- "obsidian + 自写 web clipper 绕过限制下载图片视频,自动生成优化主题库"
  —— 即 **采集(clip)→ 沉淀(structure)→ 主题库(topic base)** 三段。
- 犀利一条:"真正原因是 Claude Code 为大量小文件多层目录优化出来的"
  —— 指向 **markdown + 多层目录**这种"人 + agent 都能读写"的存储形态本身就是
  知识库的天然载体。

核心命题:**把零散输入,用 LLM 沉淀成结构化的、可检索的 markdown(+图片)知识库。**

## 2. 现状审计 —— Flywheel 已经在做这件事(而且这个 issue 本身就是证据)

这是本次研究最重要的发现:**Karpathy 的命题,Flywheel 在"精神上"已经落地了,而且
FLY-347 这条 issue 恰恰是它跑出来的产物。**

| Karpathy 命题的环节 | Flywheel 里对应的已有机制 | 形态 |
|---|---|---|
| 采集零散输入 | `xiaohongshu-learning` skill:定期读 XHS 收藏夹(文/图/**视频原片**) | 全自动 |
| 用 LLM 沉淀成结构化 markdown | 该 skill → **自动建带 provenance 的 Linear 草稿** + **本地 review 页** | 全自动 |
| 沉淀"解决过的问题"知识 | `/compound` → `docs/solutions/`(YAML frontmatter:`problem_type`/`tags`/`module`) | 半自动 |
| 长期个人/项目记忆 | 文件式 **MEMORY**(per-Lead / per-session,`memory/*.md` + `MEMORY.md` 索引)+ per-project `.flywheel/` 记忆 | 半自动 |
| 存储形态 = markdown + 多层目录 | `doc/`、`product/doc/<ISSUE>-<slug>/`、`docs/solutions/`、`memory/` 全是 markdown 树 | ✅ 一致 |

**闭环证据**:FLY-347 = 一条 XHS 收藏 → `xiaohongshu-learning` 用 LLM 读+结构化 →
落成 markdown/Linear 草稿 → 交 founder review。这就是 Karpathy 说的"用 LLM 把零散
输入沉淀成结构化 markdown 知识"。**Flywheel 的差异只在于:它的知识库是围绕
"任务/解法/记忆"组织的,不是围绕"个人研究主题"组织的。**

## 3. Gap 分析 —— 真正的差在哪

同向、大面积已覆盖;真正的边际差距只有三处,且每处都不"痛":

1. **组织维度不同**:Flywheel 记忆是 task/solution 导向(为了下次干活更快);Karpathy
   讲的是 topic/研究导向(为了"我这个主题懂得更深")。Flywheel 没有一个"按我感兴趣的
   主题聚合的个人知识库"入口。
2. **采集面窄**:目前只有 XHS 一个自动采集源;Karpathy/社区讲的是任意网页/PDF/视频的
   通用 clip。
3. **检索/复用弱**:`docs/solutions` 靠 `Grep`,MEMORY 靠会话注入;没有"主题级"的
   语义检索或"给我这个主题的全部沉淀"的视图。

**但**:这三处都不是 Annie 当前路线图上的"痛"。个人研究主题知识库更像 Annie
**个人**用 Claude Code + Notion(已有 `notion` skill / 第二大脑 FLY-510)就能满足的
需求,而不是 Flywheel **产品**要长出的能力。

## 4. 选项(给 Lead 决策)

**Option A — Close(推荐)**
理由:命题的产品价值 Flywheel 已在精神上覆盖(§2);边际差距(§3)都不痛,且更贴近
Annie 个人工作流(Notion 第二大脑 FLY-510 已在做),不是 Flywheel 产品的差异化方向。
建议 close,并把"这条已被现有学习闭环 + Notion 第二大脑覆盖"记进 XHS-learning 反馈,
让下次学习不再重复冒同类草稿。

**Option B — 收敛成一个窄 PRD:XHS-learning 之外的"通用主题采集 → 主题库"**
如果 Annie 认为"多源采集 + 主题库视图"值得投:把 §3.1/§3.2 做成一个**小**功能 ——
把 `xiaohongshu-learning` 的"采集→结构化→review"管线泛化成"任意 URL/主题"的一条命令,
产物仍落 markdown 树。范围要小(FLY-212 教训),先 PRD 再说。

**Option C — 纯知识沉淀(不建产品):把这次审计本身写成一篇"Flywheel 知识沉淀现状"
参考文档**,放进 `doc/reference/`,作为以后同类 XHS-learning 草稿的判重依据。低成本、
有长期价值,可与 A 叠加。

## 5. 需要 Lead 定的决策

1. keep 还是 close?(我的推荐:**A. close**,可叠加 **C**)
2. 若 keep:走 Option B 的窄 PRD 方向,还是别的方向?
3. 若 close:是否要我顺手把"已覆盖"写回 XHS-learning 反馈 / 写一篇 §4-C 的参考文档?

> 说明:本任务 doc-flow tier = full(默认)。但在 keep/close 未定前不写 plan.md
> —— 对一个可能被 close 的方向写完整实施计划正是 FLY-212 要避免的浪费。keep 之后
> 再补 research.md + PRD。
