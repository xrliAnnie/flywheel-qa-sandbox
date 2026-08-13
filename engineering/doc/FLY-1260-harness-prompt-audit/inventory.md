# FLY-1260 Harness 瘦身审计 — 三层盘点（真实测量）

Issue: FLY-1260 (https://linear.app/geoforge3d/issue/FLY-1260/research-harness-实验室-1提示词技能瘦身审计-评测框架无评测数据不动生产提示词)
日期: 2026-07-15
基于: plan.md（§1 交付物、§2 M1）

## 0. 计数口径与复现

全部数字为**实测**，非估算。测量脚本 `harness/inventory.mjs` 用测试套件同款 fake-runner 驱动**真 Blueprint 源码**（经 tsx），跑一个显式 context 矩阵，捕获每次 `appendSystemPrompt`，按块头锚点切分并计数。

| 项 | 值 |
|---|---|
| 计数单位 | UTF-8 字节（`Buffer.byteLength`）+ Unicode 码点（`[...text].length`），两列并报 |
| Blueprint 源 SHA | `d8951aea20ab7b0e889a33794a790533190d3408` |
| 盘点时 repo HEAD | `796b147656a488970c27cc30c6d893d114ec3663` |
| context 矩阵 | 16 场景（S01–S16），覆盖注册的 28 个块锚点 |
| 覆盖对账（**R2 加固为 fail-closed**） | 三道断言，任一不满足 → exit 1、不产出数据：① 源码里每个 ALL-CAPS 双引号块头必须在注册表；② 注册表每个锚点必须被 ≥1 场景捕获；③ **每个捕获 prompt 里、角色文件区段之外的每一行块头，都必须映射到注册锚点**（第③道是 R2 新增：旧的双引号源扫描看不见 `${cpName.toUpperCase()} GATE:` 之类模板字面量块头，会 fail-open 把真块折进邻居；capture-driven 第③道对着真实捕获文本查，才真正闭合） |
| skills 复现单位 | `~/.agents/.skill-lock.json` 的 22 项 managed 名单 + 各自 `skillFolderHash` |
| lead-rules 装配 | 由 shipped `packages/teamlead/scripts/lead-rules-bundle.sh::compute_lead_rule_bundle` 现算（单一真相，不手抄名单） |

完整 provenance 见 `harness/inventory-manifest.json`；逐块原始数据见 `harness/inventory-data.json`。

### 0.1 R2 复测记录（Codex code review 后）

Codex code review（R1，xhigh）在盘点脚本里抓出一个 fail-open 的覆盖门：旧的双引号源扫描看不见模板字面量块头（`${cpName.toUpperCase()} GATE:`），于是 S02 把 `REVIEW_DESIGN GATE:` / `REVIEW_CODE GATE:` 两个真块**折进了 approve-gate**，S06 又用了 15KB 的 generic 角色（auto-QA 实际走 `agentName:"qa"`）。修法：**注册缺失锚点 + 加 capture-driven fail-closed 第③道门**（对真实捕获文本查孤儿块头）。加固后重跑，第③道门**又抓出两个我漏的真块**（`## Retry Context`、`FINISH (no-transport...)`），一并注册。

**本 session 已装依赖、重跑脚本**（load 降到 ~9 后 `pnpm install` + `pnpm --filter 'flywheel-edge-worker...' build`）。因此 manifest 的 `blueprintFileSha` = 当前 HEAD（`d8951aea`），**不再有 provenance 漂移**；`assetHashes` 逐一绑定每个被测资产（agent 文件 / lead-rules / skill lock）。

**修正影响（headline 三条结论全部不变）**：

| 项 | 旧（R1，误折） | 新（R2，实测） |
|---|---:|---:|
| S02 `approve-gate` | 5,349 | **4,392** |
| S02 `review-design-gate`（原折进 approve） | — | **482** |
| S02 `review-code-gate`（原折进 approve） | — | **475** |
| S02 gate 块合计 | 6,684 | **6,684**（未变——只是拆开了折叠） |
| S02 非角色 / 角色 49.1% / 契约 76.5% | 15,584 / 49.1% / 76.5% | R2 不变；R3 land 修正见 §0.2 |
| S06 total（auto-QA） | 25,725（generic 15KB 角色） | **16,869**（shipped qa 角色 6,149） |

即：**误折只影响 gate 区内部的细分标签，不影响任何 headline 数字**——契约层反而多了两块（review 门），"Blueprint 层没瘦身空间"的结论更强。

### 0.2 R3 复测记录（land-path 保真修正）

Codex code review（R2，xhigh）的 HIGH 抓出一个保真缺口：盘点脚本给 Blueprint 传了 `undefined` SkillInjector，于是 base-flow 走了 **no-land 分支**（373 B）——但**生产写代码 runner 实际都 land**（我这个 session 自己的注入就带 land 6 步：创建分支 → commit → push → PR → flywheel-land 监控 → 落地信号，铁证）。修法：脚本改用「注入成功」stub（`{ inject: async () => {} }`）镜像生产 land 路径，并为 no-land 边界另立 S16。

**修正影响（headline 三条结论仍全部不变，仅数字微调）**：

| 项 | 旧（R2，no-land 误测） | 新（R3，land 实测） |
|---|---:|---:|
| S02 `base-flow` | 373 | **553**（land 6 步） |
| S02 total | 30,605 | **30,785** |
| S02 角色占比 | 49.1% | **48.8%** |
| S02 契约层占非角色 | 76.5% | **75.6%** |
| 场景数 / 锚点数 | 14 场景 | **16 场景 / 28 锚点**（补 S15 keepalive-off、S16 no-land 边界） |

即：**land 修正只让 base-flow +180 B、总量 +180 B，headline 结论一字未改**（角色仍近半、契约层仍占非角色 3/4）。生产写代码派发全走 land；no-land 仅见于 QA / 三段式 design·qa phase / no-transport 后端 / fallback（S06/S07/S10/S13/S16）。

> **口径铁律**：**互斥 context 绝不加总。** 一个 runner 只会处于矩阵里的一个场景（例：auto-QA runner 不会同时拿到 approve-gate）。下文任何「总量」都限定在单一场景内。

## 1. 层 A — Blueprint runner 注入（`packages/edge-worker/src/Blueprint.ts`）

### 1.1 context 矩阵总览（16 场景）

| 场景 | 注入总字节 | 块数 | 形态 |
|---|---:|---:|---|
| S01-minimal-no-lead-no-gates | 3,214 | 5 | 无 Lead / 无 checkpoint / 无 doc-flow / 无角色文件 = **地板**（land 分支） |
| **S02-prod-generic-claude** | **30,785** | 16 | **生产形态（本 issue 同款）**：Lead + 全 checkpoint + doc-flow full + shipped generic 角色 + land |
| S03-prod-generic-codex | 35,433 | 18 | 同 S02，codex 腿 |
| S04-doc-tier-plan-only | 30,572 | 16 | doc-flow plan_only 档 |
| S05-doc-tier-none | 30,149 | 16 | doc-flow none 档 |
| S06-auto-qa-mode | **16,869** | 12 | Auto-QA runner（agentName=qa → shipped qa 角色 6,149 B；不 land） |
| S07-three-stage-design | 31,505 | 17 | 三段式 design phase（不 land） |
| S08-three-stage-implement | 31,914 | 17 | 三段式 implement phase |
| S09-three-stage-implement-fixround | 32,354 | 18 | 三段式 implement QA-fix round |
| S10-three-stage-qa-phase | 33,492 | 16 | 三段式 QA phase（不 land） |
| S11-retry | 30,997 | 17 | 重试派发 |
| S12-resume | 30,561 | 16 | FLY-795 restart-resume |
| S13-pr-handoff-no-transport | 27,846 | 16 | FLY-493 no-transport 后端（FINISH，非 land） |
| S14-founder-ux-gate | 32,333 | 17 | FLY-598 founder-UX gate 开 |
| S15-three-stage-design-keepalive-off | 30,774 | 16 | 三段式 design，keepalive kill-switch OFF |
| S16-no-land-fallback | 30,591 | 16 | 无 SkillInjector 成功 + 无 worktree → canLand=false → no-land base-flow |

生产写代码 runner 的注入落在 **27.8KB – 35.4KB** 区间；auto-QA（S06）走独立的更轻契约链，仅 16.9KB。

**land vs no-land（R3 修正）**：runner 的 base-flow 尾块有两种形态 —— SkillInjector 注入成功且有 worktree 时走 **land 分支**（含「创建分支 → commit → push → PR → flywheel-land 监控 → 落地信号」6 步，base-flow = **553 B**）；注入失败或无 worktree 时走 **no-land 分支**（base-flow = 373 B）。本 issue 及全部生产写代码派发都走 land 分支（我这个 session 自己的注入即为铁证），故 S02 = 30,785 B。S06/S07/S10/S13/S16 属 no-land 形态（QA / 三段式 design/qa phase / no-transport 后端 / fallback），不含 land 6 步。块数比 R1 多是因为 R2 拆开了原先被误折的 review-gate/keepalive/retry 等块（见 §0.1），R3 又补了 S15/S16 两个边界场景。

### 1.2 生产形态逐块（S02，30,785 字节 / 30,466 码点；land 分支）

| 块 | 字节 | 占比 | 注入条件 |
|---|---:|---:|---|
| `agent-role` | **15,021** | **48.8%** | 按 label 匹配 `.flywheel/agents/*.md`，无匹配 fallback shipped `agents/generic-executor.md`（本例即 fallback）；40k **字符**截断 |
| `approve-gate` | 4,392 | 14.3% | `checkpoints.approve_to_ship.enabled` |
| `lead-report-back` | 2,993 | 9.7% | `leadId` 存在——**独立于 checkpoint 配置**（FLY-208） |
| `doc-flow` | 1,446 | 4.7% | `doc_flow.enabled` 且部门可解析 |
| `pipeline-preamble` | 1,012 | 3.3% | `projectName` 存在且非 resume-suppress |
| `ask-nonblocking` | 956 | 3.1% | `leadId` 存在 |
| `progress-ledger` | 811 | 2.6% | 默认注入 |
| `brainstorm-gate` | 804 | 2.6% | `checkpoints.brainstorm.enabled` |
| `base-flow` | 553 | 1.8% | 基线 6 步（**land 分支**：创建分支 → commit → push → PR → flywheel-land 监控 → 落地信号；no-land 形态为 373 B） |
| `question-gate` | 531 | 1.7% | `checkpoints.question.enabled` |
| `lead-inbox` | 508 | 1.7% | `leadId` 存在 |
| `review-design-gate` | 482 | 1.6% | `checkpoints.review_design.enabled`（generic loop；R2 前被误折进 approve-gate） |
| `review-code-gate` | 475 | 1.5% | `checkpoints.review_code.enabled`（generic loop；同上） |
| `stage-reporting` | 454 | 1.5% | 默认注入 |
| `completion-reporting` | 329 | 1.1% | 默认注入 |
| `baseline-rules` | 18 | 0.1% | 分隔标题（`## Baseline Rules`），非指令 |

**结构性事实（本盘点最重要的一条）**：

- **角色文件独占 48.8%**——单块比其余 15 块**加起来**（15,764 字节）还多。
- 去掉角色文件后的 Blueprint 自身文本 = **15,764 字节**，其中：
  - **gate 块合计 6,684 字节 = 非角色部分的 42.4%**（brainstorm + question + approve + review-design + review-code）
  - **Lead/契约层合计 11,924 字节 = 非角色部分的 75.6%**（六个 gate 块 + report-back + inbox + ask + stage + completion）

即：**Blueprint 层的绝大部分体积，按 Annie 的公式本身就属于「留」**（跨 Agent 协作协议 / 权限风险边界）。真正的体量不在这里。

### 1.3 vendor 变体（S03 codex，35,253 字节，+4,648 vs claude）

| 块 | claude | codex | 差 | 原因 |
|---|---:|---:|---:|---|
| `codex-env-translation` | — | 833 | +833 | codex 专属翻译头（Skill/teammate 工具不可用的映射规则） |
| `code-review-gate` | — | 1,805 | +1,805 | **仅 codex 作者注入**（cross-family review 触发；claude 腿无此块） |
| `doc-flow` | 1,446 | 2,204 | +758 | codex 无 Skill 工具 → 手动 onboard 说明 |
| `approve-gate` | 4,392 | 4,708 | +316 | resident codex 无 mailbox wake → 改教 `--no-block` + 轮询 |
| `brainstorm-gate` | 804 | 1,110 | +306 | 同上（轮询语义） |
| `question-gate` | 531 | 729 | +198 | 轮询语义 |
| `review-design-gate` | 482 | 680 | +198 | 轮询语义 |
| `review-code-gate` | 475 | 673 | +198 | 轮询语义 |
| `pipeline-preamble` | 1,012 | 1,115 | +103 | 手动 onboard 变体 |
| `ask-nonblocking` | 956 | 1,053 | +97 | 轮询语义 |
| `lead-inbox` | 508 | 406 | −102 | 无 PostToolUse hook → 文本更短 |
| `lead-report-back` | 2,993 | 2,931 | −62 | 无 SendMessage 工具 → 去掉该禁令 |

codex 腿更重的增量（+4,648）**几乎全是机制性补偿**（无 mailbox wake / 无 Skill 工具 / 无 teammate 消息工具），不是冗余修辞。

### 1.4 互斥 context（不与 S02 并存）

| 块 | 字节 | 仅在 |
|---|---:|---|
| `qa-verdict` | 1,830 | S06 auto-QA（该场景**无** approve/brainstorm/doc-flow/progress-ledger——它不 ship） |
| `founder-ux-gate` | 1,546 | S14（config mode=on + env flag 同时满足） |
| `qa-fix-round` / `keepalive` / `three-stage-{design,implement,qa}` | 见 data.json | S07–S10，按 phase 互斥 |
| `retry-context` | 见 data.json | S11 重试 |
| `resume-directive` | 见 data.json | S12（本 session 即此形态） |

S06 auto-QA 只有 12 块 / **16,869 字节**，角色文件是 shipped `qa-executor.md`（6,149 B，非 15KB generic），且 `pipeline-preamble` 涨到 2,128（QA 专属 onboard 语义）——它是一条**独立契约链**，不能拿 S02 的结论套。

## 2. 层 B — Agent 角色文件

| 文件 | 字节 | 说明 |
|---|---:|---|
| `.flywheel/agents/engineering/pm-executor.md` | 21,190 | 最大（FLY-880 扩到 Mode A 产品共创） |
| `.flywheel/agents/engineering/prototype-executor.md` | 19,555 | |
| **`agents/generic-executor.md`** | **15,005** | **shipped fallback——无 label 匹配时人人拿它**（即 S02 的 15,021，差 16 字节 = Blueprint 加的 `## Agent Role` 标题+换行） |
| `.flywheel/agents/engineering/designer-executor.md` | 9,875 | |
| `.flywheel/agents/engineering/product-designer-executor.md` | 6,642 | |
| `agents/qa-executor.md` | 6,149 | shipped |
| `.flywheel/agents/engineering/engineer-executor.md` | 4,526 | |
| `.flywheel/agents/engineering/qa-executor.md` | 3,330 | |
| `.flywheel/agents/general-executor.md` | 1,395 | |

**注入即常驻**：角色文件整份进 `appendSystemPrompt`，全程占用。一个 runner 只拿**一份**（不加总）。截断阈值 40,000 **字符**（非字节）——当前最大的 pm-executor 21KB 离阈值仍有余量。

## 3. 层 C — lead-rules（`packages/teamlead/lead-rules-base/`）

### 3.1 原始资产（20 文件，159,239 字节）

| 文件 | 字节 |
|---|---:|
| `department-lead-rules.md` | 32,889 |
| `founder-only-authority.md` | 24,225 |
| `cos-lead-rules.md` | 23,011 |
| `cross-dept-channel-rules.md` | 10,012 |
| `executor-routing.md` | 7,445 |
| `README.md` | 7,340 |
| `stuck-runner-remanage.md` | 6,923 |
| `runner-patrol-rules.md` | 6,141 |
| `runner-messaging-rules.md` | 5,424 |
| `xiaohongshu-memory-rules.md` | 5,006 |
| `model-routing.md` | 4,934 |
| `auto-qa-pipeline.md` | 4,101 |
| `external-agent-contract.md` | 4,049 |
| `doc-flow-rules.md` | 3,690 |
| `default-enable-policy.md` | 3,553 |
| `companion-safety-contract.md` | 3,307 |
| `founder-ux-rules.md` | 2,891 |
| `runner-reengage-rules.md` | 2,132 |
| `discord-reply-contract.md` | 1,088 |
| `founder-html-delivery.md` | 1,078 |

### 3.2 按 role 装配后的**常驻**大小（真相列）

文件清单由 shipped `compute_lead_rule_bundle` 现算；**该脚本只输出文件清单，不做拼接**。R2（Codex code review LOW）修正：并列两个口径——**rawSum**（文件字节和，不含运行时拼接分隔）与 **assembled**（每文件 `trim()` + `\n\n` 拼接的真实常驻）。二者差极小（0.01% 量级），不影响任何结论：

| role | rawSum 字节 | assembled 字节 | 文件数 | 装配清单 |
|---|---:|---:|---:|---|
| **dept** | **114,000** | 114,011 | 13 | department-lead-rules, runner-messaging-rules, executor-routing, model-routing, stuck-runner-remanage, runner-reengage-rules, runner-patrol-rules, doc-flow-rules, auto-qa-pipeline, xiaohongshu-memory-rules, founder-only-authority, founder-html-delivery, cross-dept-channel-rules |
| **cos** | **58,326** | 58,328 | 4 | cos-lead-rules, founder-only-authority, founder-html-delivery, cross-dept-channel-rules |
| **companion** | **13,319** | 13,319 | 2 | companion-safety-contract, cross-dept-channel-rules |

**没有任何 Lead 背全部 20 个文件**——159,239 是资产池大小，不是任何人的常驻量。`README.md`（7,340）**不进任何 bundle**，是给人读的，非运行时指令。**注意 companion 不装 `founder-only-authority.md`**（cos/dept 才装）——本文档凡提及该文件注入范围，均以此为准。

**成本放大差异**：lead-rules 是 Lead **全生命周期**常驻（一个 dept Lead 每轮对话都背 114KB），而 runner 注入只活一个 session。同样字节，Lead 侧的 token×时长 放大远高于 Runner 侧。

> **不得混用证据**：Lead 不在本单设想的 A/B 重放范围（重放的是 Runner）。lead-rules 的任何瘦身条目只能标「审计假设」，**不能**用 Runner 的 A/B 数据背书（Codex R1 #7）。

## 4. 层 D — flywheel-skills（22 个 managed skill）

成本结构与前三层**根本不同**：skill body 按需加载，**常驻的只有 description 行**。

| 维度 | 字节 | 说明 |
|---|---:|---|
| description（**常驻**，22 条合计） | **5,625** | 平均 256 字节/条；进 skill 列表，每 session 全程占用 |
| body（**按需**，22 份 SKILL.md 合计） | 177,964 | 只在 Skill 工具真正调用该 skill 时进上下文 |
| 比值 | **31.6×** | body 是 description 的 31.6 倍 |

body 大头：`xiaohongshu-learning` 31,452 / `deep-research` 18,396 / `synthesize-research` 16,478 / `product-brainstorming` 16,289 / `chrome-repair` 15,962。

**因此 skills 的瘦身是两个正交问题，标注表必须分列**：

1. **description（常驻）**：是否精准？——影响误触发/漏触发，5,625 字节是所有 session 都付的固定成本。
2. **body（调用时）**：是否 SOP 过度？——这才是 issue 说的「压制模型判断力」风险面；它**不占常驻**，所以「省 token」不是砍它的理由，「不压制判断力」才是。

## 5. 记录但不在本单 scope（只记录，不审计）

这些与上述三层叠加才是 runner 的**真实**总上下文；报告里给全貌图让 Annie 看见，但标注/A-B 只动 issue 点名的三层：

- 用户全局 `~/.claude/rules/*.md`（context7 / git-workflow / codex-multi-account / …）
- CLAUDE.md 链：`~/Dev/CLAUDE.md` + 项目 `CLAUDE.md` + `packages/CLAUDE.md`
- superpowers 插件 SessionStart 注入（`using-superpowers` 全文）
- runner-shared `MEMORY.md`（已知 ~19.7KB，超限截断中——见 task #161）
- harness 自带的工具 schema / agent 清单 / skill 清单（本 session 实收里占相当篇幅）

## 6. 全貌与首要观察

单个生产 runner（S02 形态，land 分支）的 Blueprint 侧注入 = **30,785 字节**，构成：

```
S02 生产 runner 注入 30,785 B
├── agent-role（generic-executor.md）      15,021 B ── 48.8%
└── Blueprint 自身文本                     15,764 B ── 51.2%
    ├── Lead/契约层                        11,924 B ── 占非角色 75.6%
    │   ├── approve-gate                    4,392 B
    │   ├── lead-report-back                2,993 B
    │   ├── brainstorm/question gate        1,335 B
    │   ├── ask + inbox                     1,464 B
    │   ├── review-design + review-code gate  957 B
    │   └── stage + completion               783 B
    └── 其余（doc-flow/preamble/ledger/base-flow）3,840 B
```

平行层（不与上式加总，成本口径不同）：
- dept Lead 常驻 **114,000 B**（全生命周期）
- skills 常驻 **5,625 B**（description）+ 按需 177,964 B（body）

**盘点阶段可以说的三条**（均为观察，非结论——瘦身建议见 `annotation-table.md`，全部标「审计假设」）：

1. **体量重心不在 gate 块**。Blueprint 层 75.6% 的非角色文本是 Lead/契约层，按 Annie 的公式（跨 Agent 协作协议 / 权限风险边界）本就属「留」。指望在 Blueprint 层砍出大空间，与「契约层不砍」的三层框架直接冲突。
2. **真正的体量在角色文件（48.8%）与 lead-rules（dept 114KB 常驻）**。这两处才是「弱模型时代 SOP」假设最该被检验的地方——也正是本次审计标注的重点。
3. **skills 的问题不是体积是形状**。常驻只有 5,625 字节，砍 body 省不到常驻 token；body 的风险是调用时的 SOP 压制判断力，与「省上下文」是两回事，不能混为一谈。

> 以上均为**盘点事实 + 审计观察**。本单无评测数据，**不动任何生产提示词**——任何「砍」的动作都必须先过 `eval-framework-proposal.md` 的评测。
