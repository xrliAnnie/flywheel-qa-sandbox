# FLY-1059 Designer Agent 角色 — 实施计划

Issue: FLY-1059 (https://linear.app/geoforge3d/issue/FLY-1059/add-a-designer-agent-role-mockup-first-design-concept-images-founder)
日期: 2026-07-09
基于: research.md · exploration.md(同文件夹)
Status: draft(待 Codex design review)

## 0. 范围(brainstorm gate 已拍 + Peter 4 条已折入)

**本 PR 交付**:① Designer role spec(本三件套)② `designer-executor.md` 角色 playbook ③ DAG 接线(label 路由 + 三段式 design-phase mockup-first,仅 UI/design)④ 测试(证明接线)⑤ FLY-1038 concept 方向轮 A/B/C(双模型,folding Annie 反馈)作证据。
**Follow-up(交 Annie)**:founder-pick 设计门 + 高保真 + 真跑整条 design→impl→qa。

Peter 4 条(进 spec + prompt):① 设计门**可循环**(A/B/C 都不满意→再出一轮)② 第 0 步「确认 mockup 类型」= **必答 gate**(静态图 vs 真 app 增量)③ handoff = **被批准的高保真本体 + 一页真数据/mock/交互说明**(不止 spec 文字)④ dogfood **验 role 接线**(测试证明 DAG 接得通,mockup 是副产品)。

## 1. 变更清单(文件级)

| # | 文件 | 变更 | 类型 |
|---|---|---|---|
| C1 | `.flywheel/agents/engineering/designer-executor.md` | **新增** Designer 角色 playbook | 内容(prompt) |
| C2 | `packages/config/src/designer-labels.ts` | **新增** `UI_DESIGN_LABELS` + `isUiDesignFlavored(labels)` 单一真相 | 代码 |
| C3 | `packages/config/src/index.ts` | 导出 C2 | 代码 |
| C4 | `packages/edge-worker/src/Blueprint.ts` | design-phase 分支加 UI-flavored 守卫 → mockup-first prompt(否则原 prompt,byte-compat) | 代码 |
| C5 | `.flywheel/config.yaml` | 加 `designer` agent(labels `designer`/`mockup`,dual-register `[engineering,product]`);`designer` 从 `product-designer` 移出 | 配置 |
| T1 | `packages/config/src/__tests__/designer-labels.test.ts` | `isUiDesignFlavored` 正/负例 | 测试 |
| T2 | `packages/edge-worker/src/__tests__/designer-agent-dispatch.test.ts` | `designer`/`mockup`→designer;`product`/`design`→product-designer;label 互斥 | 测试 |
| T3 | `packages/edge-worker/src/__tests__/blueprint-designer-phase.test.ts` | design-phase + UI label → mockup-first prompt;非 UI → 原 prompt(byte-compat) | 测试 |
| D1 | `product/doc/FLY-1059-designer-agent-role/1038-concept-round.md` + 图 + 一页 founder 卡 | FLY-1038 A/B/C 证据 | 文档/产物 |

## 2. C2 — `isUiDesignFlavored`(单一真相)

```ts
// packages/config/src/designer-labels.ts
export const UI_DESIGN_LABELS: readonly string[] = [
  "ui", "ux", "web", "frontend", "fe", "dashboard",
  "design", "designer", "mockup", "visual",
];
/** 传入的 labels 应已 lowercase(边界 runs-route 已规范化);函数内再兜底 lower。 */
export function isUiDesignFlavored(labels: readonly string[] | undefined): boolean {
  if (!labels?.length) return false;
  const set = new Set(UI_DESIGN_LABELS);
  return labels.some((l) => set.has(l.toLowerCase()));
}
```
- 语义:issue 是否值得一个视觉 mockup pass。**只读判定,无副作用**。
- 负例保证:`backend`/`api`/`infra`/`tooling`/`doc`/`pm`/`product`/`research`/`plan`/`test`/`qa` → false。

## 3. C4 — Blueprint design-phase mockup-first 分支

位置:`Blueprint.ts` `isDesignPhase` 的 prompt(`:958`)与 systemPromptLines(`:970`)。

```ts
const effectiveLabels = (ctx.issueLabels ?? hydrated.labels ?? []).map((l) => l.toLowerCase());
const designerMode = isDesignPhase && isUiDesignFlavored(effectiveLabels);
```
- `designerMode` 为真时,design-phase 的 `prompt` + `systemPromptLines` 换成 **mockup-first designer 工作流**(见 §3.1);否则**保持现通用 design prompt 逐字不变**(byte-compat)。
- 其余 phase(implement/qa)完全不变。
- 依赖已有的 `ctx.issueLabels ?? hydrated.labels` 取值(同文件 `:607` 既有用法),不新增 threading。

### 3.1 mockup-first design-phase systemPromptLines(要点,详见 C1 playbook)
1. 你是三段式 Design 节点的 **Designer**(视觉 mockup-first),同一 branch B。
2. **第 0 步(必答 gate)**:先用 `flywheel-comm gate question` 跟 founder 确认 **mockup 类型**——一次性静态方向图 vs 必须落真 app 的 UI 增量。**未答不得往下**(Peter ②)。
3. **概念方向探索**:`codex-image` ∥ `gemini-image` **并行**出 2–3 个方向 A/B/C(双模型对比),`founder-html-delivery`/`publish-report` 托管成 founder 卡。
4. **设计门(可循环)**:`gate question` 让 founder 点一个方向;**都不满意 → 再出一轮 → 再开门**(Peter ①),直到定方向或 founder 让你发挥。
5. **高保真**:`frontend-design` → 生产级 HTML(真观感 + mock 数据);静态→托管,真 app 增量→说明落点。
6. **handoff**:提交 **被批准的高保真本体 + 一页真数据/mock/交互说明**到 branch B(Peter ③),再 `flywheel-comm complete --route phase_design_complete`;**不写实现代码**(Implement 阶段做)。
7. 保留 design-phase 通用纪律(读 CLAUDE.md/产品体验 spec;push back;假设显式)。

## 4. C5 — config.yaml agents

```yaml
  designer:
    agent_file: .flywheel/agents/engineering/designer-executor.md
    department: engineering
    departments: [engineering, product]   # 与 product-designer 同可达范围
    match:
      labels: ["designer", "mockup"]
  product-designer:
    # ... 去掉 "designer"
    match:
      labels: ["doc", "docs", "design", "product", "pm", "ux"]
```
- 放在 `product-designer` **之前或之后皆可**(label 互斥 ⇒ 顺序无关);为可读性紧挨 product-designer。
- 不动 engineer/qa/general。

## 5. C1 — designer-executor.md(角色 playbook 结构)

frontmatter(documentary,parity):`name/description/model:sonnet/permissionMode/skills:[frontend-design, codex-image, gemini-image, founder-html-delivery, proofshot, dataviz, mermaid, artifact-design, brainstorm]` + 注释说明 frontmatter 仅文档、body 是合同(照 product-designer-executor)。

body:
- 角色定位(视觉 mockup-first,dispatched by Tadashi/Lead)。
- **工作流 0→5**(= §3.1,含 Peter ①②③)。
- **技能地图**(显式 invoke):frontend-design(核心,避免「一眼 AI」)/ codex-image ∥ gemini-image(双模型招牌)/ founder-html-delivery·publish-report / proofshot(真 UI→异步截图/GIF 给 founder,FLY-1038 正解)/ dataviz(图表/dashboard)/ mermaid / artifact-design / brainstorming。
- **两种 mockup 类型分流**(step 0 决定):静态方向图 = designer 用 frontend-design 出;真 UI 增量 = designer 出高保真 mockup+spec,**生产 wiring/data/tests/PR 交 implement**。
- **边界**:designer=观感/UX/mockup+founder 批;不写生产代码;不 bolt 新 phase;不新建 founder 通道(复用 gate/relay)。
- **设计门 = 复用 gate**(阻塞),循环直到定方向。
- **reporting**:`flywheel-comm ask`(禁 stock SendMessage,FLY-208)。
- **DAG 位置**:design→implement→qa,design 在 implement 前;设计门(founder 批 mockup)独立于 implement 的 review gate。

## 6. 测试细节

- **T1** `designer-labels.test.ts`:正例(ui/ux/web/frontend/fe/dashboard/design/designer/mockup/visual 各命中)+ 负例(backend/api/infra/doc/pm/product/research/plan/test/qa/空/undefined → false)+ 大小写兜底。
- **T2** `designer-agent-dispatch.test.ts`:用真 `.flywheel/config.yaml`(或等价 fixture)构 `AgentDispatcher`:`{labels:["designer"]}`→designer;`{labels:["mockup"]}`→designer;`{labels:["product"]}`→product-designer;`{labels:["design"]}`→product-designer;**断言 designer 与 product-designer label 集互斥**(交集为空);engineer 集与 designer 集互斥。
- **T3** `blueprint-designer-phase.test.ts`:最小构造 design-phase ctx(`shareParentBranch:true, sessionRole:"design"`)+ labels=["ui"] → prompt 含 mockup-first 标记(如「确认 mockup 类型」/「概念方向」);labels=["backend"] → prompt 逐字等于现通用 design prompt(byte-compat 快照)。若 Blueprint prompt-gen 不易单测,退化为对 `isUiDesignFlavored` + 分支选择逻辑抽出的纯函数测试(把 prompt 选择抽成可测 helper)。

## 7. 里程碑(dogfood)

- **完成条件(本 PR)**:C1–C5 + T1–T3 全绿 + D1(1038 A/B/C 概念图 + 一页 founder 卡)+ Codex design/code review 过 + PR 开。
- **Peter ④ 验接线**:T2(label→designer)+ T3(UI design-phase→mockup-first)即「DAG 里接得通」的客观证据;真跑含 founder 门 = follow-up(需 Annie)。

## 8. 风险 / 假设

- **生效路径**:Blueprint 属 edge-worker;需确认 Runner 用编译产物还是源码(生产 `git pull` 后是否需 build)。纯 prompt/config 生效通常无需重启 Bridge(Runner spawn 时现读 agent 文件);Blueprint 改动随 edge-worker 构建生效。**在 PR 描述标明部署步骤**。
- **label 互斥不变量**:若存在既有「全项目 config 校验」测试,保持其绿;否则 T2 补上该守卫。
- **三段式仅 `#flywheel-engineer`**:本 issue 由 product lead 派、单 session;designer 角色与三段式解耦(可单 session label 派,也可作三段式 design-phase 身份)——两条路都接。
- **图像成本**:codex-image 走订阅(免费),gemini-image 付费(~$0.13/图);A/B/C 控制在少量图。
- 不改 `decision_layer` / gate 基建 / ship 路径。**绝不自 merge / 自 ship**。
