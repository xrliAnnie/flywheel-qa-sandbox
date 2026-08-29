# FLY-1199 Charlie Hills「Claude as a company」skill org-chart 挖矿 — 探索

Issue: FLY-1199 (https://linear.app/geoforge3d/issue/FLY-1199/mine-charlie-hills-claude-as-a-company-skill-org-chart-curated-per)
日期: 2026-07-12
基于: 无(本文件夹最上游;原始研究见同目录 research-notes.md)

> ⚠️ 定位说明:本文档是**内部底稿**,不是给 Annie 看的 PRD/提案。给 Annie 的交付主体 =
> 那张「一眼能勾 vendor/skip」的交互 HTML 清单(见 plan.md)。Lead(Honey Lemon)在
> brainstorm gate 明确:Annie 今天对 PRD 极敏感,交付要一目了然、别写成长篇提案。

## 1. 起点(Annie 的原始输入)

Annie 2026-07-12 在 #flywheel-product 发了 Charlie Hills 的爆款推
(https://x.com/charliejhills/status/2076221471375122811):
「I turned Claude into an entire company: 42 skills organized as an org chart by department」——
Developers / Designers / Marketing / Social / Finance / Small-Business / Legal,全部可从
GitHub / claude.com plugins 安装。跟 Annie 共读后她选了 **A + B** 两块。

## 2. 我们要解决什么(问题定义)

不是「Flywheel 缺 skill 能力层」——那是 FLY-216/14/214 的地盘。本 issue 解决的是一个**更小、更具体**的问题:

> Charlie 这张 org-chart 里,**哪些 skill 值得为我们现有 / 未来的 agent role 收编(vendor)**?
> 给 Annie 一张能**一眼勾选**的清单,而不是又一份要她读的提案。

拆成两问:
- **(A) 策展清单**:Designer role 立即用;其它部门当未来 agent 的「弹药目录」。
- **(B) 短评**:该不该给每个 agent 做系统化的 per-role skill catalog?(答案大概率:归 FLY-216,别新建)

## 3. 关键探索发现(反直觉的三点)

### 3.1 「org-chart」不是一个 repo,是策展拼盘
Charlie Hills(GitHub `charlie947`)**只有 3 个公开 repo**。那「42 skills as an org chart」
是他**策展**社区 + Anthropic 官方 skill 拼出来的一张图,不是自建 monorepo。
→ 影响:我们不能「clone 一个 repo 拿全部」;要**逐 skill 溯源到各自的上游**,逐个判 license。

### 3.2 tweet 本体读不到 → 诚实反推
tweet 被 X 付费墙挡(HTTP 402);nitter 镜像已死。
→ 我们用**他命名的 skill + 各部门 count + 他的博客**《Claude Code is terrible at design》反推
org-chart 内容,并**诚实标注**「tweet 原文未直读」。宁可标不确定,不假装读过。

### 3.3 未来三部门其实是 Anthropic 官方产品插件
Finance(8)/ Small-Business(31)/ Legal(9)全部溯源到 **Anthropic 官方
`knowledge-work-plugins`**(Apache-2.0)——不是社区作品。
→ 好消息:license 干净、治理好。坏消息:作为「差异化弹药」价值低(= Anthropic 已经在卖的同底),
未来做这些部门 agent 更像「装官方插件」而非「收编独特资产」。

## 4. 与我们现状的接口(为什么 Designer 优先)

我们**已经有** Designer role(designer-executor.md,FLY-1059),它现有 skill 集:
`brainstorm, frontend-design, codex-image, gemini-image, founder-html-delivery, proofshot,
dataviz, mermaid, artifact-design`。

FLY-1059 的病根:Annie 看 implement-first 做的 dashboard 觉得「不够清楚」= 缺真正的设计/审美
把关。**Charlie 的 Designer batch 恰好是冲着「Claude 默认设计很 generic-AI」去的**——所以
Designer 是这张 org-chart 与我们现状**最直接对得上**的一格,故优先。

## 5. 假设(显式列出,别偷偷填)

- **A1**:Annie 要的是「勾选清单」不是「读提案」。(Lead gate 已确认 → 高置信)
- **A2**:Designer batch 5 个 skill 就是 org-chart 里的那 5 个(issue 原文列了名;tweet 未直读 → 中置信,已标注)。
- **A3**:license 是硬门 —— 非 permissive(MIT/Apache)或来源混杂的,默认不 vendor、先核 provenance。(采纳,w95 那种即例)
- **A4**:B 的 per-role catalog **不新建**,归 FLY-216。(待 research.md 论证)
- **A5**:交付是 docs-only research/eval PR,不建 build 单、不 re-file、不 close 别人的 issue。(Lead 确认)

## 6. 明确不做(scope discipline)

- ❌ 不新建 skill 能力层/marketplace(= FLY-216/14/214)。
- ❌ 不 re-file FLY-437(Marketing skill)/ FLY-434(SkillHub)—— 只 relate。
- ❌ 不给 Annie 写 PRD、不建 build issue、不 close 任何 issue。
- ❌ 不真的去 vendor/安装 skill —— 本 issue 只到「清单 + Annie 圈选」,安装是后续 build。

## 7. 下一步

→ research.md:逐 skill 溯源表(Designer batch + 未来部门 ammo)+ license 判定 + B 短评论证。
→ plan.md:交互 HTML 清单的结构 + 数据 + 构建计划。
