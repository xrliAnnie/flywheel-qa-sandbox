# FLY-1230 实施计划 — DR + 中文 co-eval explainer

Issue: FLY-1230 (https://linear.app/geoforge3d/issue/FLY-1230/research-多-agent-编排会不会被单-agent-模型能力取代-业界视角-chatgpt-deep-research)
日期: 2026-07-13
基于: exploration.md, research.md

## 流程（轻流程 — research-explainer-first）

1. **DR**：deep-research skill 跑 §research.md-1 的五问 → verbatim 报告写进 doc 文件夹。受阻则回退 last30days/web + 标明。（实际执行:DR 跑成功但全文导出受阻 → 存为 `dr-capture.md`,含 Bottom line 逐字 + 诚实说明 + `dr-web-corroboration.md` 一手源核准。）
2. **synthesize**：读 DR 抓取（`dr-capture.md` 的 Bottom line 逐字 + `dr-web-corroboration.md` 一手源;全文导出受阻）→ 抽「哪些块被吸收 / 哪些块持久 / 有没有第三类」→ 对照「拐杖 vs 地基」。
3. **explainer**：写中文互动 co-eval HTML（结构见下）。
4. **self-QA**：grep 清单（下）+ Codex code review 核忠实（与 FLY-1164 先例一致：核 explainer 未曲解 DR、未替 Annie 下结论、来源诚实）。
5. **发布**：host-only publish → nonce URL → `ask --report` 交 Lead。
6. **收尾**：commit docs → docs PR（approve gate）→ Lead/Annie 授权后 executor-merge。Runner 不自 merge、不自 :cool:。

## explainer HTML 结构（互动 co-eval，参照 FLY-1045 coeval-card）

1. `<head>`：charset + viewport + `robots noindex,nofollow` + 中文 `<title>` + 内联 `<style>`（房子样式，零 dark）。
2. **顶部条**：一句说明「这是**业界怎么看** + 对照我们框架 + **把决定权留给你**，不是『结论是 X』。DR 来源见文末/DR 报告。」+ 若走了 DR 回退则诚实标注。
3. **§0 一句话 + Annie 的疑问原样**。
4. **§1 业界两派摆事实**：编排持久派 vs 单 agent 吸收派 vs 混合派 —— 各方论据 + 点名来源（矛盾观点并列，不调和）。每派一个 `.sec` + 留言框。
5. **§2 正在被吸收的能力**（长 context / tool-use / subagents-as-tools / 自主时限）→ 对应「拐杖类」验证。留言框。
6. **§3 持久的编排**（独立验证 reviewer≠doer / 安全审计 / 不可逆动作批准 / 并行规模 / 可靠性 barrier）→ 对应「地基类」验证。留言框。
7. **§4 框架检验**：「拐杖 vs 地基」哪里对、哪里过简、业界有没有第三类（并行吞吐 / 专业化隔离 / 组织信任边界）。留言框。
   - **§4.5 极简单-agent 派实测 — Pi Agent（Lead 指令 8db6eb55）**：pi.dev（Mario Zechner）主动砍编排的活样本 → 它砍了什么（sub-agents/plan mode/MCP/权限闸/大 prompt）· 留了什么（4 工具/透明/自扩展）· 代价（上下文漏读/无前置安全闸靠人盯+容器）· **关键分辨点（留给 founder 判，非结论）**：批准闸在 Pi 可砍，一种读法是它是本地结对（人在旁）；我们是「人稀缺的自治 fleet」→ 同一控制在我们这儿算不算地基，是留给 Annie 的开放问题。材料 = `research-pi-agent.md`。留言框。
8. **§5 逐块量四个 DAG 程序**（1020/1135/1140/1141）：每块一张卡 = 【是什么 → 业界视角落在拐杖还是地基 → 开放问题】+ **Annie 的留言框**。**不替她判**，给「看起来像拐杖 / 像地基 / 取决于 X」的多选，让她圈。
9. **§6 留白**：「这页不下结论。决定权是你 + HL 的。」+「一键复制我全部批注」按钮（`<script nonce="__CSP_NONCE__">`）。
10. 无远程资产(脚本/图片/样式表/字体);正文指向来源的 `<a href>` 链接允许保留。self-contained。

## self-QA 清单

- [ ] DR 报告：有来源、诚实、查不到处标 UNKNOWN；若回退已在顶部标明
- [ ] explainer 忠实 DR：无曲解、无替 Annie 下结论（grep 无「结论是」式断言；每块有留言框）
- [ ] 四个 DAG 程序逐块都在（1020/1135/1140/1141），各带开放问题 + 留言框
- [ ] 零 dark：grep 无 `prefers-color-scheme`
- [ ] noindex meta 在；self-contained（无远程**资源**:grep 无远程脚本/图片 `src=`、无 `@import`、无远程样式表/字体;正文指向来源的 `<a href>` 链接**允许保留**）
- [ ] nonce：交互 JS 用 `<script nonce="__CSP_NONCE__">`（发布注入真 nonce）
- [ ] HTML ≤ 512KB
- [ ] 发布 URL 200 + 实读渲染正常

## design_review 决策（轻流程 — 记录理由）

**跳过重量级 Codex design review**（对纯研究/docs 交付低价值）：
- brainstorm gate 已是本任务的设计批准（Lead 已确认走法 + 交付模型 A）；
- **无 packages/ 代码、无架构/API 改动** —— Codex design review 的价值面（架构/契约）在此不存在；
- 与 FLY-1164 先例一致（同款 DR+中文 HTML，走轻流程）；
- 契合 memory「过程轻重按风险分档」。
- **但**：explainer 建成后**跑 Codex code review**（核忠实/不曲解/来源诚实）—— 这层不跳（memory「codex 可用就别 waive」）。

## 发布 & 交付

- host-only：`POST /api/reports/publish {projectName:"flywheel", html, title}` → nonce URL
- `flywheel-comm ask --lead flywheel-product-lead --report` 交 Lead
- 不 ship、不 deliver Discord、不动 main
