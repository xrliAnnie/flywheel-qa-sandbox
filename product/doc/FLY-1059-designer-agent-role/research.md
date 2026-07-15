# FLY-1059 Designer Agent 角色 — 调研(code-grounded)

Issue: FLY-1059 (https://linear.app/geoforge3d/issue/FLY-1059/add-a-designer-agent-role-mockup-first-design-concept-images-founder)
日期: 2026-07-09
基于: exploration.md(同文件夹)

> 本文把 exploration 的方向落成**可实现的 code 事实**:每处接入点的文件/行/机制,以及为什么这么接是最小正确。

## 1. 三段式 Design 节点(接入点 1)

- `packages/config/src/three-stage-phases.ts`:`THREE_STAGE_PHASE_SEQUENCE=[design,implement,qa]`,badge `🎨设计/🔨实现/🧪QA`,phase 模型表(design/implement=heavy,qa=medium)。
- `packages/edge-worker/src/Blueprint.ts:913-965`:phase 判定 = `shareParentBranch===true && sessionRole==='design'|'implement'|'qa'`。**design phase 现用通用 prompt**(`:958` + `:970-978`):brainstorm→research→plan→design review,提交 docs,不写代码。
- **三段式所有 phase 用同一个 label 匹配 agent**(`phase-orchestrator.ts` handoff 不传 agentName,由 runs-route 按 label re-dispatch);phase 差异**只来自 Blueprint 注入的 phase prompt**。
  → 推论:让 design node「mockup-first」的正确做法 = **改 Blueprint design-phase prompt**(按 label 判定 UI/design),而不是给 design phase 换 agent 文件(现基建不支持 per-phase agent)。
- **labels 在 Blueprint 生成 prompt 时可用**:`ctx.issueLabels ?? hydrated.labels`(`Blueprint.ts:607,657` 已这样用)。→ 加 `isUiDesignFlavored(labels)` 守卫零额外 threading。
- **byte-compat**:守卫默认走原 prompt;非 UI issue / 非三段式 完全不变。

## 2. Agent 路由(接入点 2)

- `packages/edge-worker/src/AgentDispatcher.ts:215-268`:`dispatch()` = step-2a(owning-dept 内按**插入顺序 first-match**)→ step-2b(top-level catch-all)→ default → shipped-generic。`this.entries = Object.entries(agents)`(YAML 顺序)。
- **first-match ⇒ label 集必须互斥**(config.yaml 注释明写「one executor per role, zero label overlap」)。label 集互斥时**顺序无关**、无歧义。
- 现 label 归属:
  - engineer:`code/feat/fix/refactor/test/infra/tooling/bug/backend/frontend/api/server/ui/web/be/fe/eng/research/plan`(**ui/frontend/fe 归 engineer = 生产前端代码**)
  - qa:`qa/testing`
  - product-designer:`doc/docs/design/product/pm/ux/designer`(dual-register `[engineering,product]`)
  - general:`[]`
- **新 designer agent 取 `designer`+`mockup`**(视觉 mockup-first 无歧义信号),**把 `designer` 从 product-designer 移出**(避免 overlap)。product-designer 留 `doc/docs/design/product/pm/ux`。两集互斥。
- `ConfigLoader.ts:682-766` 校验:`agent_file` 必填 + 路径校验;`department`/`departments`(FLY-901 dual-register)双向一致 + path-safe。`generic` 名保留。→ 新 designer agent 放 `.flywheel/agents/engineering/`,dual-register `[engineering, product]`(与 product-designer 一致的可达范围,让 product lead 也能派)。

## 3. 设计门(接入点 3)= 复用现有 gate,零新原语

- `flywheel-comm gate brainstorm|question`(阻塞)+ FLY-605 relay(~10min 兜底 @founder 进 thread)。Annie 点 A/B/C = 一次阻塞 gate;Peter ① 循环 = 都不满意→再出一轮→再开一次 gate(gate 每问一答,循环=重复开门)。
- 第 0 步「确认 mockup 类型」(Peter ②)= 同样一次阻塞 gate question(静态图 vs 真 app 增量)。
- **不新增 gate 类型**——designer 在拿到 founder 方向前不 complete design phase / 不 handoff。

## 4. 与 product-designer-executor 的边界(已核 `.flywheel/agents/engineering/product-designer-executor.md`)

| | designer(新) | product-designer(现) | implement(engineer) |
|---|---|---|---|
| 关注 | 视觉观感 / UX / mockup + founder 批准 | PRD / 产品共创(FLY-679 五律)/ docs | 生产 wiring / data / tests / PR |
| 招牌动作 | 双模型并行概念图 A/B/C → 设计门 → 高保真 HTML | 多轮 co-create 收敛 PRD → 拆 build issue | TDD 落地 |
| 触发 label | `designer` / `mockup` | `product` / `pm` / `doc` / `docs` / `design` / `ux` | `code`/`feat`/`ui`/`frontend`/… |

互补,不重叠。product-designer 已声明「no separate Designer role yet」——FLY-1059 正是补上它。

## 5. 技能可用性(已核在机)

`~/.claude/skills/`:`codex-image`✅ `gemini-image`✅ `founder-html-delivery`✅ `proofshot`✅。插件 Skill:`frontend-design`✅ `dataviz`✅ `mermaid`✅ `artifact-design`✅ `brainstorming`(superpowers)✅。role 声称技能全真。

## 6. dogfood(FLY-1038)所需

- Annie 反馈(经 Lead relay,进 concept 轮):**DAG-role 显示**(per-category workflow · per-node model)· **左竖 nav** · **Feature Flag 单 tab** · **Codex 后端出 Codex 型号** · 删「外部托管」。
- concept 轮 = 视觉方向探索,不需像素级复刻现 UI;A/B/C 用 `codex-image` ∥ `gemini-image`(双模型对比)。
- Peter ④「验 role 接线」= 用测试证明 label→designer + UI-design-phase→mockup-first(DAG 里接得通);真跑整条 design→impl→qa 含 founder 门需 Annie 在场 = follow-up。

## 7. blast-radius / 风险

- Blueprint 是核心;改动 = **加守卫 + 换 design-phase prompt 字符串**,非 UI issue 走原分支 = byte-compat(有 test 锁)。
- config.yaml label 移动(`designer` 从 product-designer → 新 agent):有 test 锁互斥 + 校验现有派发不回归。
- self-hosting repo:生效 = merge + 生产 `git pull`(prompt 在 Runner spawn 时现读);**无需重启 Bridge**(纯 prompt/config,Runner spawn 时读)。—— 注:Blueprint 是 edge-worker 编译产物,需确认生效路径(见 plan 风险节)。
