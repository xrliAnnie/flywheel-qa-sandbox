# FLY-1199 研究笔记 (raw research capture — pre-gate)

Issue: FLY-1199 (https://linear.app/geoforge3d/issue/FLY-1199/mine-charlie-hills-claude-as-a-company-skill-org-chart-curated-per)
日期: 2026-07-12
用途: brainstorm gate 前的原始研究落盘,防 restart 丢失。正式 exploration/research/plan 在 gate 通过后写。

## 关键发现 1 — "org chart" 不是 Charlie 的一个 repo

- Charlie Hills = GitHub `charlie947` / X `@charliejhills`。**只有 3 个公开 repo**:
  - `charlie947/social-media-skills` (MIT, 1,671★) — 17 skills(= org chart 的 Social(17))
  - `charlie947/ai-second-brain` (Claude Code skill)
  - `charlie947/agent-harness-starter`
- 所以那条 viral tweet 的 "42 skills organized as an org chart by department" 是 **Charlie 策展(curate)社区 + 官方 skill** 拼的 org chart,**不是**他自建的 monorepo。
- tweet 本体 (status 2076221471375122811) 被 X 付费墙挡住 (HTTP 402);nitter 已死。→ org chart 用 **他命名的 skill + 部门 count + 他的博客文章** 反推(诚实标注:tweet 原文未直读)。
- 更好的一手来源:Charlie 的 Substack **《Claude Code is terrible at design》** = Designer batch 的推荐理由出处。

## 关键发现 2 — Designer batch(deliverable A 的 primary,5 个)全部溯源到

| Charlie 命名 | 真实来源 repo | License | ★ | 我们是否已有 |
|---|---|---|---|---|
| **UI/UX Pro Max** | `nextlevelbuilder/ui-ux-pro-max-skill` | MIT | **104,703** | 无 |
| **Taste** | `Leonxlnx/taste-skill` (+ `impeccable.style` 变体) | MIT | **62,441** | 无(我们有 product-taste-intuition,是 PM 味道不是设计味道) |
| **Frontend Design** | `anthropics/skills/frontend-design`(官方) | 官方 repo(无标准 OSI license 文件,THIRD_PARTY_NOTICES) | 160k★(整仓) | ✅ **已有**(designer-executor skills + frontend-design 插件) |
| **Brand Guidelines** | `anthropics/skills/brand-guidelines`(官方) | 同上 | 同上 | 无(但我们有 ~/.claude/rules/html-report-style.md 当事实 brand) |
| **Transitions** | 动效/motion 类 skill(如 `dylantarre/animation-principles` MIT 58★ = Disney 12 原则);"Transitions" 精确 repo 未 100% 锁定 | MIT(候选) | 低 | 无 |

Charlie 博客里显式命名的两个:
- `taste-skill` (github.com/Leonxlnx/taste-skill) — "anti-slop quality pass",做完迭代后抓"太 AI/generic/过度动画"。
- `Impeccable` (impeccable.style) — 专注 spacing + hierarchy 精修。

## 关键发现 3 — 官方 anthropics/skills 里的 17 个 skill(供 owned-check)

algorithmic-art, brand-guidelines, canvas-design, claude-api, doc-coauthoring, docx,
frontend-design, internal-comms, mcp-builder, pdf, pptx, skill-creator, slack-gif-creator,
theme-factory, web-artifacts-builder, webapp-testing, xlsx

→ 我们**已拥有**:frontend-design、skill-creator(+ Superpowers、Context7)。issue 要求标记 owned ✅。

## 关键发现 4 — 我们 Designer role 现有 skill 集(designer-executor.md 权威)

skills: brainstorm, frontend-design, codex-image, gemini-image, founder-html-delivery,
proofshot, dataviz, mermaid, artifact-design

→ Designer batch 与现有的 overlap/gap 是 fit 评估的核心轴。

## 初步 fit 评估(Designer role,待 Annie 圈)

- **UI/UX Pro Max** → 倾向 **VENDOR**。给 designer 结构化设计词汇(67 styles/161 palettes/57 font pairs/reasoning rules)正面打 FLY-1059 病根(dashboard"不够清楚"= generic-AI 味)。注意它体量大(CLI 装、22 stack)。
- **Taste** → **VENDOR(最推荐)**。把审美判断变成常驻 brief + anti-slop pass,直接治 FLY-1059 根因,且可**逐步编码 Annie 的品味**。MIT 62k★。
- **Frontend Design** → **OWNED**,不动作。
- **Brand Guidelines** → **SKIP-for-now / later**。Flywheel 还没定 brand;现有 html-report-style.md 当事实规则。定了真 brand 再回收。
- **Transitions/Motion** → **SKIP-for-now**。我们交付物多是静态 report/dashboard,非动效重 app;Taste 本身也警告过度动画。

## 关键发现 5 — 未来部门 count(org chart 的 ammo)+ 交叉引用

- Marketing (~45)、Social Media (17 = Charlie 自己的 repo)、Finance (~8)、Small Business (~31)、Legal (~9)。
- 后台 agent 正在 catalog 各部门源 repo + license(结果待并入)。
- **交叉引用(relate,不 re-file)**:
  - FLY-437 = [XHS-deep] Marketing-idea skill(Marketing skill 已建单)→ 关联,不重复。
  - FLY-434 = [XHS-deep] 腾讯 SkillHub / ClawHub(skill 市场模式)→ 关联。
  - 另见 `w95/awesome-claude-corporate-skills`(166 skills by role)= 可能的伞状源,待 agent 确认。

## B) per-role catalog 评估(短评,归属 FLY-216)

- Charlie 按部门/角色组织 skill。问:我们 agent 该不该有系统化的 per-role skill catalog?
- ⚠️ 与 **FLY-216(flyview-skills 全机共享能力库)** + FLY-14(Skill Marketplace)+ FLY-214(全局 Skill 框架,Done)重叠。
- 初步结论:per-role catalog **不该新建**;它更像是可以**叠在 FLY-216 之上的一层薄 per-role manifest**(每个 role 知道自己该有哪些 skill)。待写成 B 短评,推荐"关联 FLY-216,不新开 build"。
