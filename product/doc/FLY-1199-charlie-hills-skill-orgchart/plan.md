# FLY-1199 Charlie Hills skill org-chart 挖矿 — 实施计划

Issue: FLY-1199 (https://linear.app/geoforge3d/issue/FLY-1199/mine-charlie-hills-claude-as-a-company-skill-org-chart-curated-per)
日期: 2026-07-12
基于: exploration.md + research.md(同目录)

> 交付主体 = 一张**给 Annie 一眼勾选 vendor/skip 的交互 HTML 清单**(Lead gate 确认:不是 PRD/长提案)。
> 本 plan 描述这张 HTML 的内容、交互、构建与 ship 步骤。docs-only PR。

## 1. 交付物

1. `product/doc/FLY-1199-charlie-hills-skill-orgchart/` 下 3 个 doc-flow 文档(exploration/research/plan)——**内部底稿**。
2. **交互 HTML 清单**(源文件也 commit 进本文件夹,如 `checklist.html`),发布到 host-only URL。
3. docs-only PR(含上述文件)。

**不做**:不建 build issue、不写 PRD、不 re-file FLY-437/434、不 close 任何 issue、不真装 skill。

## 2. HTML 内容结构(自上而下)

**顶部**:一句话说明 + 「怎么用这张表」(点 Vendor/Skip/Owned/Later,底部导出你的圈选)。诚实旗:tweet 付费墙未直读、org-chart 系反推。

**Section A — Designer role(立即,primary)**:5 行卡片,每行 = skill 名 + 来源 repo(可点)+ license + ★ + 一句「干什么」+ 一句「对我们 fit」+ 一组**决策 chip**(Vendor / Skip / Owned / Later,预置我的默认推荐高亮)+ 一个可选 note 输入框。
- UI/UX Pro Max → 默认 **Vendor**
- Taste → 默认 **Vendor ⭐**
- Frontend Design → 默认 **Owned**(禁用/灰,说明已有)
- Brand Guidelines → 默认 **Skip-for-now**
- Transitions → 默认 **Skip-for-now**

**Section B — 未来部门 ammo 目录**:5 行 collection 卡片(Marketing / Social / Finance / Small-Biz / Legal),每行 = repo + author + license + ★ + count + 一句性质 + license 风险旗(如有)。这一段是**目录/参考**,决策 chip 简化为 Note-only(未来加 agent 时才决),不逼 Annie 现在勾。

**Section C — Owned already**:Frontend Design / Skill Creator / Superpowers / Context7(+ 其它现有 designer skill)—— 一眼看到「这些不用收」。

**Section D — license 风险旗**:醒目一块(红/琥珀左边框),w95/awesome-corporate 的再授权风险 + Anthropic Apache NOTICE 义务。

**Section E — (B) per-role catalog 短评**:3-4 句 + 一组单选(选项1 归 FLY-216 / 选项2 建关联 follow-up / 其它)。默认高亮选项1。

**Section F — 交叉引用**:FLY-437 / FLY-434 / XHS cluster,一句话 relate。

**底部**:「导出我的圈选」按钮 → 把所有 chip 选择 + note 汇成一段可复制文本(Annie/Lead 复制回传)。

## 3. 交互与技术约束

- **FLY-930 nonce**:所有交互 JS 走 `<script nonce="__CSP_NONCE__">`(publish 时注入真 nonce,hosted CSP 下内联 JS 真可用)。不用外部 JS/CSS/字体/图。
- **Apple light theme**(`~/.claude/rules/html-report-style.md`):白/浅底、深字、白卡、12px 圆角、左边框色码、系统字体、max-width ~960px。**zero-dark**(不写 dark theme)。
- **mobile-first**:Annie 常在手机看;卡片单列、chip 够大能点、note 框全宽。(记忆偏好:每节可留言 + 可导出批注)
- **纯前端、无后端**:chip 状态存内存 + localStorage(刷新不丢);导出 = 前端拼字符串。
- **无破坏性**:纯展示 + 本地状态,不发网络请求。

## 4. 构建步骤(TDD-lite,HTML 无单测但有验证门)

1. 写 `checklist.html`(自包含,占位 `__CSP_NONCE__`)。
2. **本地验证**:浏览器打开确认 —— chip 可点/高亮切换、note 可输入、导出按钮吐出正确汇总、mobile 视口单列不横向滚动、light-only。(proofshot / 手动截图留证)
3. **Codex design review**(plan 已写)→ 若有实质意见,改 plan/HTML。
4. **Codex code review**(HTML/PR)→ 折叠意见。
5. **发布 host-only —— 唯一明确路径(fail-closed)**:
   - ⚠️ **绝不用 `flywheel-comm publish-report`**:实测其固定流程 = `POST /api/reports/publish` **然后** `POST /api/reports/deliver`,且不传 `--channel` 时 deliver 端会**回退到项目 generalChannel**(= core)。用它 = 在 Lead 审阅前就把 founder material 投进 core,违反 host-only + Runner 不直投 Annie 的硬边界。也**绝不**调 `/api/reports/deliver`。
   - **只做这一步**:Runner 直接 `POST {bridgeUrl}/api/reports/publish`,带认证头 `Authorization: Bearer $TEAMLEAD_API_TOKEN` + `Content-Type: application/json`,body `{projectName, html, title}` → 响应 `{url, reportId}`。这一步**只发布、不投递任何 Discord 消息**。(bridgeUrl 取 `$FLYWHEEL_BRIDGE_URL`;构建时若 env 缺,向 Lead 求。)
   - **验证门**:确认 publish 响应含 `url`;确认整个步骤**没有**执行任何 deliver / Discord 投递。
6. **URL 报 Lead**:`flywheel-comm ask --report --lead flywheel-product-lead` 把 host-only URL 交给 Honey Lemon(她自测结构再投 Annie)。**Runner 绝不直发 Annie**。

## 5. Ship 路径

- 分支 `flywheel-FLY-1199`,commit 3 docs + checklist.html。
- 开 docs-only PR(base=main),PR body 链 Linear issue。
- `stage set pr_created` → Bridge 触发 Codex code review。
- approve gate(`gate approve_to_ship --no-block`)→ `complete --route needs_review`。
- **停在 approve gate**;ship 仍 founder-gated。绝不自 merge / 自 :cool:。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| tweet 未直读 → org-chart 归组可能有偏 | HTML 顶部诚实旗;Designer batch 用 issue 命名(高置信);未来部门用实测 collection |
| Transitions 精确 repo 未锁定 | 标「motion 类,精确 repo 未 100% 确认」;反正默认 Skip |
| `publish-report` **无条件**投 Discord(publish→deliver,不传 channel 回退 core) | 绝不用 publish-report / 不调 /deliver;只 `POST /api/reports/publish` 拿 host-only URL → `ask --report` 交 Lead;验证门确认零 Discord 投递 |
| Annie 觉得还是太长/像提案 | 结构一眼可勾、Section B 只做目录不逼决策;可再精简迭代 |
