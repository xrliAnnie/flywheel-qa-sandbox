# FLY-347 用 LLM 构建个人知识库 — 调研(判重 / 现状覆盖参考)

Issue: FLY-347 (https://linear.app/geoforge3d/issue/FLY-347/xhsclaude-karpathy用-llm-构建个人知识库token-从处理代码转向处理知识)
日期: 2026-07-08
基于: exploration.md

---

## 目的

Lead 已认同 close 推荐,但 close 是产品方向决定、须 Annie 拍板。本文档把「Karpathy
的命题已被 Flywheel(+ Annie 现有工作流)什么机制覆盖」grounded 列清,作为:
1. **给 Annie 拍 close/build 的依据**;
2. **XHS-learning 的判重参考** —— 下次学习闭环再冒出同类"用 LLM 建知识库"草稿时,
   可直接指向本文档判为"已覆盖",不重复建草稿。

> 结论先行:Karpathy 命题的每一个环节,Flywheel 或 Annie 的现有工具都已有对应落地;
> 边际差距(§3)不痛、也不是 Flywheel 产品差异化方向。**建议 close(待 Annie 拍)。**

## 1. Karpathy 命题拆成的环节

「用 LLM 把零散输入 → 沉淀成结构化、可检索的 markdown(+图片)知识库,围绕**研究主题**组织。」

拆成四段:**采集(clip)→ LLM 结构化(structure)→ markdown 存储(store)→ 复用/检索(retrieve)**。

## 2. 逐环节的现状覆盖(grounded)

| 环节 | 已覆盖的机制 | 具体锚点(可核) | 覆盖度 |
|---|---|---|---|
| 采集 | `xiaohongshu-learning` skill 定期读 XHS 收藏夹(文/图/**视频原片**) | `~/.claude/skills/xiaohongshu-learning/SKILL.md`(v0.2.0,FLY-286 post-hoc 模型) | 单源自动(仅 XHS) |
| LLM 结构化 | 同 skill:LLM 读原片 → **自动建带 provenance 的 Linear 草稿** + **本地 review 页** | 同上;FLY-347 本条 issue 就是它的产物(见 issue 尾部 `xhs-provenance` marker) | ✅ 全自动 |
| 解法型知识沉淀 | `/compound` → `docs/solutions/`,YAML frontmatter:`track`/`problem_type`/`tags`/`module`,`Grep` 检索 | `compound` skill;项目根 `CLAUDE.md` §"Solutions Knowledge Base"(约定存在,按需生成) | ✅ 机制就绪 |
| 长期记忆(个人/项目) | 文件式 **MEMORY**:`memory/*.md`(一事一文件 + frontmatter type)+ `MEMORY.md` 索引,会话启动注入;per-Lead / per-session | `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/MEMORY.md`(本会话正在用) | ✅ 全自动注入 |
| 项目级记忆 | per-project `.flywheel/` 记忆 | 各 repo `.flywheel/` | ✅ |
| markdown + 多层目录存储 | `doc/`、`product/doc/<ISSUE>-<slug>/`、`docs/solutions/`、`memory/` 全是 markdown 树 | 本仓目录结构 | ✅ 形态一致 |
| **个人研究主题**知识库(Karpathy 的核心切面) | **Annie 的 Notion 第二大脑**(idea 库/日记/素材/notes),一次配置全 agent 零配置读写 | `notion` skill;**FLY-510 v1.56.0**(项目根 CLAUDE.md 里程碑表) | ✅ Annie 个人层已覆盖 |

**关键闭环证据**:FLY-347 = 一条 XHS 收藏 → `xiaohongshu-learning` 用 LLM 读+结构化 →
落成 markdown/Linear 草稿 → 交 founder review。**这正是 Karpathy 说的"用 LLM 把零散
输入沉淀成结构化 markdown 知识"** —— Flywheel 已在跑,且 FLY-347 自己就是它的输出。

## 3. 真正的边际差距(为什么仍建议 close)

同向、大面积已覆盖;真正的差距只有三处,且每处都不"痛":

1. **组织维度**:Flywheel 记忆是 task/solution 导向(为下次干活更快);Karpathy 讲
   topic/研究导向(为"我这个主题懂得更深")。→ 但"个人研究主题库"这层,Annie 的
   **Notion 第二大脑(FLY-510)已经是**,不需要 Flywheel 产品再长一遍。
2. **采集面**:目前自动采集只有 XHS 一源;通用网页/PDF/视频 clip 未做。→ 但这是
   工具便利,不是 Flywheel 差异化;Annie 手动存 Notion 即可。
3. **检索**:`docs/solutions` 靠 `Grep`、MEMORY 靠注入,无"主题级语义检索"。→ 真痛了
   再单独立项,和本命题不强绑定。

## 4. 判重结论(供 XHS-learning 复用)

**FLY-347 命题「用 LLM 构建个人知识库」= 已被覆盖,判重为 duplicate-of-existing。**
覆盖来源:`xiaohongshu-learning` 学习闭环 + `/compound`→`docs/solutions` + 文件式
MEMORY + per-project 记忆 + Annie 的 Notion 第二大脑(FLY-510)。
以后学习闭环再冒同类"LLM 知识库/第二大脑/主题沉淀"草稿,可直接指向本文档判重,
不重复建。

## 5. 待办(不自决)

- [ ] Lead 把 close 推荐 + 本文档 surface 给 Annie。
- [ ] **Annie 拍板**:close / build。
  - close → 我落关闭(并可把本判重结论写回 XHS-learning 反馈)。
  - build → Lead 给方向(参考 exploration.md Option B:窄 PRD 把 XHS 采集管线泛化成
    "任意主题一条命令",范围要小,FLY-212 教训)。
- 在 Annie 拍板前:**park,绝不自 close、不自 ship。**
