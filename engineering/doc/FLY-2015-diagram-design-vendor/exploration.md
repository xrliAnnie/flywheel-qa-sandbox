# FLY-2015 diagram-design 入库 — 探索
Issue: FLY-2015 (https://linear.app/geoforge3d/issue/FLY-2015/vendor-diagram-design-%E8%BF%9B-skill-%E5%BA%93-annie-%E5%B7%B2%E8%AE%A4%E5%8F%AF%E8%A7%82%E6%84%9F%E5%B8%A6%E5%9B%9B%E6%9D%A1%E5%AE%9E%E6%B5%8B%E9%99%90%E5%88%B6)
日期: 2026-08-23
基于: 无

## 要解决的事

Annie 已在 FLY-2004 认可一张按 `diagram-design` 说明手绘的 A/B 对照图。本单只把上游 skill 以可回滚的 vendor 方式收进 `xrliAnnie/flywheel-skills`，完成安全与来源审查，并让会画架构图或交付 HTML 的 Flywheel 角色能发现它。不做字体选型、CSP 改造、报告模板改造或自动生成质量调参。

## 已知事实与边界

- 上游: `cathrynlavery/diagram-design`，MIT；FLY-2004 用的是 commit `648c2a597839301e06df1e7434a08bde9f42eed3`，插件版本 v2.6.5。
- 交付: 自包含 HTML + inline SVG/CSS；安装包内有 3 个 Python 标准库脚本，分别解析 draw.io、解析 Mermaid、检查生成 HTML。
- 本单以 pinned commit vendoring，绝不跟随漂移的 `main`；更新必须重新审查并 bump provenance。
- Founder 意图是「别复杂，一段式做掉」；装了不喜欢可直接 revert/remove，不扩建新框架。当前生产 scheduled skill sync 处于 disabled，所以本单两个 PR 不冒充成全机已分发；后续安装/回滚需受权 operator 手动 sync 并核对 lockfile。
- FLY-464 的教训是不要把能力绑到我们不用的 Obsidian；本次保留上游原生 Claude Code/Codex skill 形态。

## 四条必须随 skill 带走的限制

1. Annie 认可的是 runner 按说明书手画的图，自动生成稳定性尚未验证；QA 的首个 E2E 必须让安装后的 skill 自动画同题图，再与 FLY-2004 手画版比较。
2. Instrument Serif、Geist、Geist Mono 不含中文字形；FLY-2004 在字体已加载的对照中量中文，三款声明都与各自通用回退同宽。我们的图正文主要是中文，替代字体等真跑后再定。
3. 未自带 CSP 的报告经 `publish-report` 托管后会被注入不允许外部字体的 CSP；Google Fonts 在该路径加载不到。已有自带 CSP 的报告走 `hasCsp` 保留分支，不能扩大表述为「所有报告」。
4. 上游单人维护且增长很快，是移动靶；pin 降低供应链漂移，但后续升级仍有逐版审查成本。

另有一条本次代码审查新发现的托管兼容性边界（不冒充 FLY-2004 第五条实测限制）：原厂 motion controller 不带 `__CSP_NONCE__`，经 `publish-report` 后脚本被 CSP 拦截，只能依赖 `noscript` 静态终态。

## 角色分配假设

全机同步会安装给所有 session；Flywheel role frontmatter 只是说明性能力清单，真正调用合同是 role 正文的 skill map / 使用路由。本单会同时更新两者，最小集合为:

- `engineer-executor`: 架构/流程图、设计 review HTML、报告 UI。
- `designer-executor`（含 `.bare` / `.matt` 同步副本）: founder-facing mockup 与 HTML。
- `product-designer-executor`: UX spec、flow 和 founder-facing 设计稿。
- `prototype-executor`: 原型解释卡与 HTML。
- `pm-executor`: 一页 explainer HTML；只在图比 prose/table 更清楚时使用。

QA 不加入默认角色分配；它在本单独立验收时可以显式调用已安装 skill，避免把「验证能力」误写成 QA 的日常产出职责。

## 成功判据

- `flywheel-skills` 中存在 pinned、带完整许可证/第三方归属的 `skills/generic/diagram-design/`。
- `SKILL.md` 本体携带 provenance、四条限制和唯一关键 QA E2E，同时保留上游正文与按需 reference 路由。
- 目标角色 frontmatter 全部列出 `diagram-design`，正文明写何时调用，并有失败先行的角色合同测试。
- 上游三脚本通过安全审查与自身测试；目标仓 skill guard、Skill Creator validator、主仓相关测试与全仓门通过。
- 两个仓库分别形成可 review 的提交/PR；不安装到生产、不部署、不重启、不 merge。
