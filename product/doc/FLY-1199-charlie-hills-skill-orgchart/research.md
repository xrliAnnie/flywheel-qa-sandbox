# FLY-1199 Charlie Hills skill org-chart 挖矿 — 调研

Issue: FLY-1199 (https://linear.app/geoforge3d/issue/FLY-1199/mine-charlie-hills-claude-as-a-company-skill-org-chart-curated-per)
日期: 2026-07-12
基于: exploration.md(同目录)

> 内部底稿。所有 star 数经 `gh repo view` 实测(非渲染页读数);license 经 LICENSE 文件 / GitHub API 确认。
> tweet 原文付费墙未直读 —— org-chart 内容按 issue 命名 + 各部门 count + Charlie 博客反推,已标注。

## A. Designer batch(primary — 立即用)

Charlie 的 Designer 一格 = UI/UX Pro Max · Taste · Frontend Design · Transitions · Brand Guidelines。
逐个溯源 + 对我们 designer-executor 现状的 fit 判定(**当默认推荐,最终 Annie 圈**):

| Skill | 真实来源 repo | License | ★ | 干什么 | 我们现状 | fit 初判 |
|---|---|---|---|---|---|---|
| **UI/UX Pro Max** | `nextlevelbuilder/ui-ux-pro-max-skill` | MIT | 104,703 | 设计智能:67 UI styles / 161 色板 / 57 字体配对 / 161 行业 reasoning rules / design-system 生成器,22 tech stack | 无 | **VENDOR** |
| **Taste** | `Leonxlnx/taste-skill`(+ `impeccable.style` 变体) | MIT | 62,441 | anti-slop 审美把关:做完迭代后抓「太 AI / generic / 过度动画」;把审美判断变成常驻 brief | 无(product-taste-intuition 是 PM 味道≠设计味道) | **VENDOR ⭐** |
| **Frontend Design** | `anthropics/skills` → `frontend-design`(官方) | Anthropic 官方 repo(无标准 OSI license 文件,THIRD_PARTY_NOTICES) | 160k(整仓) | 官方前端设计 skill,治「一眼 AI 味」 | ✅ **已有**(designer-executor + frontend-design 插件) | **OWNED** |
| **Brand Guidelines** | `anthropics/skills` → `brand-guidelines`(官方) | 同上 | 同上 | 把公司 brand 规则套进产出 | 无(有 html-report-style.md 当事实 brand) | **SKIP-for-now** |
| **Transitions**(动效) | 动效/motion 类社区 skill(如 `dylantarre/animation-principles`,MIT,58★,Disney 12 原则);「Transitions」精确 repo 未 100% 锁定 | MIT(候选) | 低 | UI 过渡/缓动,motion 工程指导 | 无 | **SKIP-for-now** |

### fit 判定理由(honest,不 pad)
- **UI/UX Pro Max → VENDOR**:给 designer 结构化设计词汇,正面打 FLY-1059「dashboard 不够清楚 = generic-AI 味」。注意体量大(CLI 装、22 stack)——收编时评估是全量还是裁剪。
- **Taste → VENDOR(最推荐)**:直接治 FLY-1059 根因(审美把关缺失),且能**逐步编码 Annie 的品味**成常驻 brief——这是对我们最独特的价值。MIT 62k★ 社区验证强。
- **Frontend Design → OWNED**:已在 designer-executor,零动作。
- **Brand Guidelines → SKIP-for-now**:Flywheel 还没定真 brand;现有 html-report-style.md 顶着。定了 brand 再回收。**不默认 vendor**(Lead 确认)。
- **Transitions → SKIP-for-now**:我们交付多是静态 report/dashboard,非动效重 app;Taste 本身也警告过度动画。**不默认 vendor**(Lead 确认)。

### owned-check(issue 要求)
已拥有,标记 owned、不重复收编:**Frontend Design · Skill Creator · Superpowers · Context7**
(+ artifact-design / dataviz / mermaid / codex-image / gemini-image / proofshot / founder-html-delivery)。

## B. 未来部门 ammo 目录(catalog only — 未来加 agent 时的现成弹药)

按 collection 级编目(不逐个 110+ skill 展开):

| 部门 | 来源 repo | 作者 | License | ★ | count | 性质 |
|---|---|---|---|---|---|---|
| Marketing (~45) | `coreyhaines31/marketingskills` | Corey Haines | MIT | 37,890 | 47 folder(README 处说 60,不一致) | 社区,CRO/copywriting/SEO/analytics/growth |
| Social Media (17) | `charlie947/social-media-skills` | Charlie Hills | MIT | 1,671 | 17(实测精确) | 社区,voice-first 内容全栈,最干净 |
| Finance (8) | `anthropics/knowledge-work-plugins` → finance/skills | **Anthropic 官方** | Apache-2.0 | 22,551(整仓) | 8(精确) | 官方产品插件,月结/对账/报表 |
| Small Business (31) | `anthropics/knowledge-work-plugins` → small-business/skills | **Anthropic 官方** | Apache-2.0 | 同上 | 31(精确) | 官方,现金流/发票/CRM/税季,接 QuickBooks 等 |
| Legal (9) | `anthropics/knowledge-work-plugins` → legal/skills | **Anthropic 官方** | Apache-2.0 | 同上 | 9(精确) | 官方,合同审查/NDA triage/合规 |

### 编目要点
- **三部门(Finance/Small-Biz/Legal)是 Anthropic 官方插件**,不是社区独特资产 → 未来做这些 agent ≈「装官方插件 + 调 persona」,不需要造轮子。
- **Marketing = coreyhaines31**(最热的社区 marketing pack),但:(a) 是「最像」不是 tweet 确认;(b) count 自相矛盾(README 60 vs 树 47)→ 外引前再核。
- **Social = Charlie 自己的 repo**,溯源最实(作者/count/license 全确认)。

### ⚠️ license 风险旗(vendor 前必看)
1. **`w95/awesome-claude-corporate-skills`(166 skills,自称 MIT)= 最高风险**:README 自认内容源自
   Apache-2.0(Anthropic FSP/KWP)+ 具名专有伙伴(S&P Global / Apollo / Common Room)。用 MIT 外壳
   一把罩不合规(Apache 要保留 NOTICE;专有内容不能假设可自由再分发)。**不 vendor,先逐 skill 核 provenance**。
   且其 taxonomy(Marketing 15 / Finance 42 / Legal 7)与本 issue 的 count 全对不上 → 不是伞状源,是另一套竞品目录。
2. **Anthropic knowledge-work-plugins(Apache-2.0)= 低风险但非零摩擦**:保留 NOTICE/attribution;
   保留或改写其内置免责声明(「不提供财务/税务/法律/HR 建议」),别隐含 Anthropic 背书。
3. **coreyhaines31/marketingskills(MIT)= 低风险**,但 count 不一致、tweet-映射是推断 → 外引前核。
4. **charlie947/social-media-skills(MIT)= 低风险高置信**,最干净的弹药。

## C. 交叉引用(relate,不 re-file)

- **FLY-437** [XHS-deep] Marketing-idea skill —— Marketing skill 已建单。本 issue 的 Marketing ammo **关联它**,不重复建。
- **FLY-434** [XHS-deep] 腾讯 SkillHub / ClawHub —— skill 市场/信任(审计/加速/认证)模式。关联,作 marketplace 参考。
- **XHS skill-borrow cluster**(FLY-349 引擎产出的 skill 借鉴单)—— 同一「借外部 skill」主题,归并思考、不各自为战。

## D. (B) per-role skill catalog 短评 —— 归 FLY-216

**问**:Charlie 按部门/角色组织 skill。我们该不该给每个 agent 做系统化的 per-role skill catalog(每个 role 知道自己该有哪些 skill)?

**答:不新建。它是可以叠在 FLY-216 之上的一层薄 per-role manifest,不是新 build。**

论证:
- **FLY-216(flyview-skills,High)= 天然归属**:它已经是「全机共享能力库」——skill 进独立 repo、
  各机定时 install、canonical + symlink 扇出。per-role catalog 只是在这之上加「哪个 role 声明哪些 skill」
  的一层**manifest / 视图**,不是新能力层。
- **FLY-214(全局 Skill 框架,Done)+ FLY-14(Skill Marketplace,动态加载)**:动态/全局装载层已覆盖。
- **我们其实已有「隐式 per-role catalog」**:每个 executor 的 role .md(如 designer-executor.md 的
  `skills:` frontmatter + skill-map 表)就是该 role 的 skill 清单。Charlie 的洞见 = 把它**显式化 + 跨 role 系统化**。
- **建议措辞**(给 Annie 圈的一个选项,不是我替她拍):
  - **选项 1(推荐)**:per-role catalog 的想法**已被 FLY-216 覆盖**,当作 FLY-216 的一个「per-role manifest 视图」子特性带进去,**本 issue 不新开单**。
  - **选项 2**:若 Annie 觉得值得独立跟踪,建一个**关联 FLY-216 的**轻量 follow-up(而不是并行造新目录系统)。
  - 默认走选项 1。

## E. 数据来源与置信

- Designer batch 5/5、未来 5 部门 collection:repo/star/license 全经 `gh` + GitHub API 实测。
- tweet 原文:付费墙未直读(诚实旗)。org-chart 归组按 issue 命名 + count + Charlie 博客反推。
- Marketing repo 的 tweet-映射 = 「最像」推断,已标注。
