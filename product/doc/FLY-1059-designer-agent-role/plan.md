# FLY-1059 Designer Agent 角色 — 实施计划

Issue: FLY-1059 (https://linear.app/geoforge3d/issue/FLY-1059/add-a-designer-agent-role-mockup-first-design-concept-images-founder)
日期: 2026-07-09
基于: research.md · exploration.md(同文件夹)
Status: draft(待 Codex design review)

## 0. 范围(brainstorm gate 已拍 + Peter 4 条已折入)

**本 PR 交付**:① Designer role spec(本三件套)② `designer-executor.md` 角色 playbook ③ DAG 接线(label 路由 + 三段式 design-phase mockup-first,仅 UI/design)④ 测试(证明接线)⑤ FLY-1038 concept 方向轮 A/B/C(双模型,folding Annie 反馈)作证据。
**Follow-up(交 Annie)**:founder-pick 设计门 + 高保真 + 真跑整条 design→impl→qa。

Peter 4 条(进 spec + prompt):① 设计门**可循环**(A/B/C 都不满意→再出一轮)② 第 0 步「确认 mockup 类型」= **必答 gate**(静态图 vs 真 app 增量)③ handoff = **被批准的高保真本体 + 一页真数据/mock/交互说明**(不止 spec 文字)④ dogfood **验 role 接线**(测试证明 DAG 接得通,mockup 是副产品)。

## 1. 变更清单(文件级)—— v2,折入 Codex R1 全部 7 条

| # | 文件 | 变更 | 类型 |
|---|---|---|---|
| C1 | `.flywheel/agents/engineering/designer-executor.md` | **新增** Designer 角色 playbook(含 skill 缺失 graceful-degradation fallback,R1#7) | 内容(prompt) |
| C2 | `packages/config/src/designer-labels.ts` | **新增** `UI_DESIGN_LABELS` + `isUiDesignFlavored(labels)` 单一真相 | 代码 |
| C3 | `packages/config/src/index.ts` | 导出 C2 | 代码 |
| C4 | `packages/edge-worker/src/Blueprint.ts` | design-phase 抽**常量**(generic prompt/systemLines)→ 按 `isUiDesignFlavored` 在常量间分支;UI → mockup-first(**C4 = 三段式 Design phase 行为唯一真相源**,R1#3);gate 措辞**引用注入的 QUESTION GATE**(vendor-neutral,R1#4) | 代码 |
| C5 | `.flywheel/config.yaml` | 加 `designer` agent(labels `designer`/`mockup`,dual-register `[engineering,product]`);`designer` 从 `product-designer` 移出 | 配置 |
| **C6** | `.flywheel/agents/engineering/product-designer-executor.md` | **改**(R1#1):Mode B labels 去 `designer`;「no separate Designer role yet」→ 新边界(product-designer=PM/product/docs/design/UX;designer/mockup=视觉 mockup-first) | 内容(prompt) |
| T1 | `packages/config/src/__tests__/designer-labels.test.ts` | `isUiDesignFlavored` 正/负例 + **大小写兜底**(R1#6) | 测试 |
| T2 | `packages/edge-worker/src/__tests__/designer-agent-dispatch.test.ts` | `designer`/`mockup`→designer;`product`/`design`→product-designer;`ui`→**engineer**(证明 ui 不路由到 designer,R1#3);label 集互斥断言 | 测试 |
| T3 | `packages/edge-worker/src/__tests__/blueprint-designer-phase.test.ts` | **真 Blueprint 集成测试**(mirror `Blueprint.fly793-phase-prompt.test.ts`,R1#5):design-phase + `["ui"]` → prompt+systemPrompt 含 mockup-first 锚点(「确认 mockup 类型」/概念方向/无实现代码指令);`["backend"]` → **逐字等于**现 generic design 文本(byte-compat seam,R1#6) | 测试 |
| **G1** | `scripts/qa-fly-901-real-config-dispatch-e2e.mjs` | **改**(R1#2):product-designer alias loop 去 `designer`,加 `designer`/`mockup`→designer 断言 + real-config overlap 断言 | 既有 guard |
| **G2** | `packages/edge-worker/src/__tests__/AgentDispatcher.test.ts:476-493` | **改**(R1#2):dual-register fixture 去 product-designer 的 `designer` label(反映新互斥集) | 既有 guard |
| **G3** | `scripts/__tests__/test-pm-executor-contract.sh` | **改**(R1#1):断言新边界,防旧 `designer` label 文本回潮 | 既有 guard |
| D1 | `product/doc/FLY-1059-designer-agent-role/1038-concept-round.md` + 图 + 一页 founder 卡 | FLY-1038 A/B/C 证据(publish **不带 --channel**,URL 交 Lead,Runner 绝不直投) | 文档/产物 |

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

## 3. C4 — Blueprint design-phase mockup-first 分支(**三段式 Design phase 行为唯一真相源**)

**关键(R1#3)**:三段式所有 phase 加载**同一个 label 匹配 agent role 文件**。UI issue 常标 `ui`/`frontend`/`fe`(→ **engineer**)或 `design`/`ux`(→ product-designer),**其 Design phase 根本不会加载 `designer-executor.md`**。所以 **mockup-first 工作流必须完整写在 C4(Blueprint phase prompt)里**,不能只委托给 C1。C1 是**独立** `designer`/`mockup` label 派发时用的 playbook。

位置:`Blueprint.ts` `isDesignPhase` 的 prompt(`:958`)与 systemPromptLines(`:970-978`)。

**做法(R1#6 byte-compat seam)**:先把现 generic design 的 `prompt` 串与 `systemPromptLines` 抽成**命名常量**(如 `GENERIC_DESIGN_PHASE_PROMPT(...)` / `GENERIC_DESIGN_PHASE_SYSTEM_LINES(...)`),再按 `isUiDesignFlavored` 在常量间分支:
```ts
const effectiveLabels = (ctx.issueLabels ?? hydrated.labels ?? []).map((l) => l.toLowerCase());
const designerMode = isDesignPhase && isUiDesignFlavored(effectiveLabels);
```
- `designerMode` 真 → mockup-first(§3.1);否则 → **原常量逐字不变**。非 UI design / implement / qa / 非三段式 全部 byte-compat(在常量 seam 上有 T3 快照锁)。
- 依赖已有 `ctx.issueLabels ?? hydrated.labels`(同文件 `:582-607`/`:653-660` 既有用法 + dispatch 早于 prompt 生成 `:864-880`),`effectiveLabels` 只读无副作用。

### 3.1 mockup-first design-phase systemPromptLines(要点)
1. 你是三段式 Design 节点的 **Designer**(视觉 mockup-first),同一 branch B。
2. **第 0 步(必答 gate)**:**用本 prompt 里已注入的 QUESTION GATE 指令**(R1#4,vendor-neutral——Claude 阻塞 / Codex `--no-block`+resume,别硬编码单一命令)跟 founder 确认 **mockup 类型**:一次性静态方向图 vs 必须落真 app 的 UI 增量。**未拿到答复不得往下**(Peter ②)。
3. **概念方向探索**:`codex-image` ∥ `gemini-image` **并行**出 2–3 个方向 A/B/C(双模型对比),`founder-html-delivery`/`publish-report` 托管成 founder 卡(**不带 --channel**,URL 交 Lead 投,Runner 绝不直投)。
4. **设计门(可循环)**:走注入的 QUESTION GATE 让 founder 点一个方向;**都不满意 → 再出一轮 → 再开门**(Peter ①),直到定方向或 founder 让你发挥。**工作流级纪律**:未选定方向前**绝不** `complete --route phase_design_complete`。
5. **高保真**:`frontend-design` → 生产级 HTML(真观感 + mock 数据);静态→托管,真 app 增量→说明落点。
6. **handoff**:提交 **被批准的高保真本体 + 一页真数据/mock/交互说明**到 branch B(Peter ③),再 `flywheel-comm complete --route phase_design_complete`;**不写实现代码**(Implement 阶段做)。
7. 保留 design-phase 通用纪律(读 CLAUDE.md/产品体验 spec;push back;假设显式)。

> **三段式 `designer`/`mockup` label 特例(R1#3)**:若 issue 直接标 `designer`/`mockup` 进三段式,则 design/implement/qa 三 phase 都会加载 `designer-executor.md`;Implement/QA 的 phase prompt(「读已提交设计并实现/验证」)已明确覆盖,designer role 文本作背景不冲突。C1 playbook 明确「真 UI 增量的生产 wiring/data/tests/PR 交 implement」,与 phase 边界一致。

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
- **设计门 = 复用注入的 QUESTION GATE**(vendor-neutral),循环直到定方向。
- **skill 缺失 fallback**(R1#7,照 product-designer-executor):某 mapped skill 若未装,**不停摆**——手动照工作流用可用工具做,保持同样 artifact 合同,并报 Tadashi/Lead。
- **reporting**:`flywheel-comm ask`(禁 stock SendMessage,FLY-208)。**founder 物料 URL 交 Lead 投,Runner 绝不直投**(feedback_founder_artifacts_lead_only_delivery)。
- **DAG 位置**:design→implement→qa,design 在 implement 前;设计门(founder 批 mockup)独立于 implement 的 review gate。

## 6. 测试细节(折入 R1#2/#5/#6)

- **T1** `designer-labels.test.ts`:正例(ui/ux/web/frontend/fe/dashboard/design/designer/mockup/visual 各命中)+ 负例(backend/api/infra/doc/pm/product/research/plan/test/qa/空/undefined → false)+ **混合大小写**(`["UI"]`/`["Mockup"]` → true,R1#6)。
- **T2** `designer-agent-dispatch.test.ts`:用真 `.flywheel/config.yaml`(经 ConfigLoader)构 `AgentDispatcher`:`{labels:["designer"],owningDept:"engineering"}`→designer;`["mockup"]`→designer;`["product"]`→product-designer;`["design"]`→product-designer;`["ui"]`→**engineer**(R1#3,证明 ui 走生产前端不走 designer);**断言 designer∩product-designer label = ∅、designer∩engineer = ∅**。
- **T3** `blueprint-designer-phase.test.ts`:**mirror `Blueprint.fly793-phase-prompt.test.ts`**(真跑 `Blueprint.run()`)。扩 `buildPrompt` helper 同时返回 `call.prompt` 和 `call.appendSystemPrompt`。断言:
  - `{sessionRole:"design",shareParentBranch:true,issueLabels:["ui"]}` → prompt+systemPrompt 含 mockup-first 锚点(「确认 mockup 类型」、概念方向/A/B/C、无「Create a feature branch」/无实现代码指令);
  - `{...,issueLabels:["backend"]}` → design-phase 文本**等于**现 generic(含「DESIGN phase」「phase_design_complete」,不含 mockup-first 锚点)= byte-compat seam(R1#6);
  - 保留 fly793 现有断言(implement/qa/非三段式)不回归。
- **G1** `scripts/qa-fly-901-real-config-dispatch-e2e.mjs`:去 product-designer alias loop 的 `designer`,加 `designer`/`mockup`→designer + real-config **overlap 断言**(遍历 agents,任两 agent label 集交集必空,R1#2)。
- **G2** `packages/edge-worker/src/__tests__/AgentDispatcher.test.ts` `makeDualRegisterAgents`(`:476-493`):product-designer fixture label 去 `designer`(→ `["doc","design","product","pm","ux"]`),加一个 `designer` agent fixture 或调整相关断言反映新互斥集。
- **G3** `scripts/__tests__/test-pm-executor-contract.sh`:断言 product-designer-executor.md 新边界文本、**不含**旧「designer」Mode B label 声明(防回潮,R1#1)。

## 7. 里程碑(dogfood)

- **完成条件(本 PR,R2#1)**:**C1–C6 + T1–T3 + G1–G3** 全绿 + D1(1038 A/B/C 概念图 + 一页 founder 卡)+ Codex design/code review 过 + PR 开。验证命令:`pnpm --filter flywheel-config test`(T1)、`pnpm --filter cyrus-edge-worker test`(T2/T3/G2)、build 后 `node scripts/qa-fly-901-real-config-dispatch-e2e.mjs`(G1)、`bash scripts/__tests__/test-pm-executor-contract.sh`(G3)、`pnpm lint`。
- **Peter ④ 验接线**:T2(label→designer)+ T3(UI design-phase→mockup-first)即「DAG 里接得通」的客观证据;真跑含 founder 门 = follow-up(需 Annie)。

## 8-bis. R2 refinements(folding Codex R2 5 条,实现时执行)

- **R2#2 (C5 注释)**:`.flywheel/config.yaml` agent 概览注释(`:128-138`)也要改——把 `designer` 从 product-designer 归属拿掉、加一句 `designer` = 视觉 mockup-first 独立 role;保持「旧 docs/design label 仍路由 product-designer」准确。
- **R2#3 (T2 双部门 + 大小写)**:断言 `designer`/`mockup` 在 `owningDept:"engineering"` **和** `owningDept:"product"` 都路由到 designer;断言 designer 的 `departments === ["engineering","product"]`;所有 label 交集**小写后**计算(dispatcher `labelsMatch` 假定已小写)。
- **R2#4 (C1 phase 优先句)**:designer-executor.md 的「不写生产代码」边界写成「**在 Design/mockup 工作流中时**」;并明确「若三段式 Implement/QA phase prompt 在场,**phase prompt 优先**,designer role 退为设计背景」——让 plan §3「designer/mockup 三段式特例」在 prompt 文本里成立。
- **R2#5 (T3 hydrated fallback)**:加一个 Blueprint 测试:`ctx.issueLabels` 省略、mock PreHydrator 返回 `labels:["ui"]` → 仍选 mockup-first(证明 `?? hydrated.labels` fallback 路径)。

## 8. 风险 / 假设

- **生效路径**:Blueprint 属 edge-worker;需确认 Runner 用编译产物还是源码(生产 `git pull` 后是否需 build)。纯 prompt/config 生效通常无需重启 Bridge(Runner spawn 时现读 agent 文件);Blueprint 改动随 edge-worker 构建生效。**在 PR 描述标明部署步骤**。
- **label 互斥不变量**:若存在既有「全项目 config 校验」测试,保持其绿;否则 T2 补上该守卫。
- **三段式仅 `#flywheel-engineer`**:本 issue 由 product lead 派、单 session;designer 角色与三段式解耦(可单 session label 派,也可作三段式 design-phase 身份)——两条路都接。
- **图像成本**:codex-image 走订阅(免费),gemini-image 付费(~$0.13/图);A/B/C 控制在少量图。
- 不改 `decision_layer` / gate 基建 / ship 路径。**绝不自 merge / 自 ship**。
