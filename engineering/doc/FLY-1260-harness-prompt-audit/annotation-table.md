# FLY-1260 Harness 瘦身审计 — 标注表

Issue: FLY-1260 (https://linear.app/geoforge3d/issue/FLY-1260/research-harness-实验室-1提示词技能瘦身审计-评测框架无评测数据不动生产提示词)
日期: 2026-07-15
基于: inventory.md

## 0. 怎么读这张表

### 0.1 铁律（先说结论的边界）

> **本表每一条「砍」都是「审计假设（待评测）」，不是已证结论。**
> 本单**无评测数据**，**不动任何生产提示词/skill**。任何砍的动作必须先过 `eval-framework-proposal.md` 的评测。
> 这不是免责话术——是「无评测数据不动生产提示词」铁律的直接推论：我能论证某块「看起来像模型本来就会的方法论」，但**我证明不了删掉它 Fable/gpt-5.6 的表现不会变差**。这正是要建评测框架的原因。

### 0.2 归类公式（Annie 给定）

| 归类 | 判据 |
|---|---|
| **留** | 模型推断不出的经验 / 用户长期偏好 / 权限风险边界 / 跨 Agent 协作协议 / 真正改变结果的判断框架 |
| **砍候选** | 通用操作步骤 / 流程仪式 / 重复上下文 / 假想边缘穷举 / 模型本来就会的方法论 |
| **部分砍** | 同一块内两类混杂 → 拆开分别处理 |

### 0.3 三层框架 sanity check（2026-07-14 #flywheel-engineer 讨论）

契约层（安全/权限/生命周期）→ **一律留，不进砍候选**；协作层（跨 Agent 协议）→ 默认留；方法论层（模型本来就会）→ 砍候选主产地。

**契约类块一律标留**，无一例外：gate 协议、merge 授权、report-back、founder 物料纪律、权限边界。

### 0.4 审计深度（诚实标注——这决定了每行的可信度）

| 标记 | 含义 |
|---|---|
| **逐字** | 本 runner 自身收到的注入原文即该块（S02+resume 生产形态），我逐字读过 |
| **源码** | 读了 `Blueprint.ts` 对应行的模板与注入条件 |
| **结构** | 读了文件的章节结构与各节实测字节，**未逐字通读全文** |
| **口径** | 只做了成本口径测量（description/body 分列），未逐条评内容 |

**结构/口径 深度的行，其瘦身建议的置信度显著低于逐字行**——不要把它们当同一强度的判断。

---

## 1. 层 A — Blueprint runner 注入块（S02 生产形态，16 块 / 30,785 B；land 分支）

| # | 块 | 字节 | 三层 | 归类 | 理由 | 建议动作 | 深度 |
|---|---|---:|---|---|---|---|---|
| A1 | `agent-role` | 15,021 | 混合 | **部分砍** | 整份角色文件注入；内部 10 节混杂契约与方法论 → 见 §2 逐节 | 见 §2（逐节，不整块处理） | 逐字 |
| A2 | `approve-gate` | 4,392 | 契约 | **留** | merge/ship 授权边界。`verify-approval` 是唯一授权源、消息文本无授权力、head 漂移作废批准——**模型绝对推断不出**，且错了=未授权 ship（不可逆） | **原样留**。注：块内 a–i 九步含可压缩的重复叙述，但压缩=改契约文本，风险/收益比最差，**不列砍候选**。（R1 误把 review 两门折进此块记成 5,349，R2 已拆） | 逐字 |
| A2b | `review-design-gate` | 482 | 契约 | **留** | design review checkpoint 门（generic loop）。gate 协议 | 留 | 逐字 |
| A2c | `review-code-gate` | 475 | 契约 | **留** | code review checkpoint 门（generic loop，与 A17 codex-author 块不同） | 留 | 逐字 |
| A3 | `lead-report-back` | 2,993 | 契约 | **留** | FLY-208 真实事故：Runner 用 stock `SendMessage to:"team-lead"` 报告 → 黑洞（product-lead 积压 184 条），Runner 真心以为报到了。这是「模型推断不出的经验」的教科书例 | **原样留** | 逐字 |
| A4 | `doc-flow` | 1,446 | 协作 | **留** | 项目落盘约定（文件夹形态/抬头 3 行/三档）——纯约定，推断不出 | 留 | 逐字 |
| A5 | `pipeline-preamble` | 1,012 | 混合 | **部分砍** | (1)(3)(4)(5) = stage 上报 + blocked 终态通道 = 协议，留；**(2)「Attempt the `onboard` skill」= 模型本来就会**（它有 skill 列表，会自己调） | 压缩 (2)；保留 (1)(3)(4)(5) | 逐字 |
| A6 | `ask-nonblocking` | 956 | 契约 | **留** | 「ask 非阻塞 + 必须轮询 check + 无 mailbox 唤醒」= 机制事实。推断错=永久挂起（Codex R2 在 FLY-217 抓到过这个真洞） | 留 | 逐字 |
| A7 | `progress-ledger` | 811 | 协作 | **留** | restart-resilient 机制 + 「只 commit progress.md 不带代码」的路径限定——推断不出 | 留 | 逐字 |
| A8 | `brainstorm-gate` | 804 | 契约 | **留** | gate 协议 + fail-close 非零退出即停 | 留 | 逐字 |
| A9 | `question-gate` | 531 | 契约 | **留** | 同上 | 留 | 逐字 |
| A10 | `lead-inbox` | 508 | 契约 | **留** | PostToolUse hook 注入 + 手动兜底 = 机制事实 | 留 | 逐字 |
| A11 | `stage-reporting` | 454 | 协作 | **留** | 阶段上报是 Bridge 可观测性的唯一来源。**但与 A1 角色文件的「Pipeline stages」节（1,261 B）重复** → 重复在 role 侧砍（见 B8），Blueprint 侧留 | 留（去 role 侧重复） | 逐字 |
| A12 | `base-flow` | 553 | 方法论 | **砍候选** | 「读码→TDD→建分支→提交→PR→land→exit」：前 4 步是模型本来就会的通用操作步骤，且与角色文件 + `flywheel-tdd`/`flywheel-git-workflow` skill 三重重复。**唯二不可推断的是 landing signal 路径与 land skill 指针**（land 分支 553 B，其中这两项 land-specific 内容 ~150 B 属留） | **压成一句边界声明**：保留 landing-signal 路径 + land skill 指针，删通用步骤叙述（可压 ~400 B） | 逐字 |
| A13 | `completion-reporting` | 329 | 契约 | **留** | `stage set completed` 是终态信号；不报=session 悬挂 | 留 | 逐字 |
| A14 | `baseline-rules` | 18 | — | **留** | 仅分隔标题 `## Baseline Rules`，非指令 | 留 | 源码 |

**层 A 小计**：砍候选 1 块（A12, 553 B，可压 ~400 B）+ 部分砍 2 块（A1 见 §2；A5 约 ~200 B 可压）。
**除角色文件外，层 A 的 15,764 B 里，可动的约 600 B（3.8%，<4%）。** 这是本次审计最硬的一条结构性发现：**Blueprint 层没有瘦身空间可言**——它 75.6% 是契约层，按公式本就该留。

### 1.1 互斥 context 块（不与 S02 并存，单独判）

| # | 块 | 字节 | 归类 | 理由 | 深度 |
|---|---|---:|---|---|---|
| A15 | `qa-verdict` | 1,830 | **留** | auto-QA 的 verdict 是 pipeline gating founder 的机制信号，格式即契约。auto-QA runner（S06）注入总 16,869 B，角色是 shipped qa-executor 6,149 B（非 15KB generic） | 源码 |
| A16 | `founder-ux-gate` | 1,546 | **留** | founder 物料纪律 = 契约层（三层框架点名不砍） | 源码 |
| A17 | `code-review-gate`（codex 腿） | 1,805 | **留** | Codex review 记录是 ship 的硬前置（FLY-827） | 源码 |
| A18 | `resume-directive` | — | **留** | 重启续跑指令；错了=重做已完成工作 | 逐字 |
| A19 | `three-stage-{design,implement,qa}` | 见 data.json | **留** | 分段交接协议 | 源码 |

### 1.2 vendor 变体（codex +4,648 B）

**归类：留（全部）。** 逐项核对后，codex 腿的增量**几乎全是机制性补偿**，不是冗余修辞：无 mailbox wake → 必须教 `--no-block`+轮询（approve/brainstorm/question +1,216 B）；无 Skill 工具 → 手动 onboard（doc-flow/preamble +861 B）；无 teammate 工具 → 反而**删掉** SendMessage 禁令（−62 B）。
**这层已经是「按 backend 能力裁剪」的正面样板**，不是瘦身对象。

---

## 2. 层 A1 展开 — `agents/generic-executor.md`（15,005 B，占 S02 注入 48.8%）

> **为什么这里是重点**：它是**shipped fallback**——任何没有 label 匹配到项目角色文件的 runner 都拿它（本 session 即是）。单文件占生产注入的一半。

> **字节口径（R2 精修）**：以下逐节字节按**锚点到锚点**精确切分，全表 + overrides 小标题(74) 合计 = **15,005 = 文件总字节**（R1 曾把 Scope note 误并进 override C，B15 被记成 ~65；已修正为 560）。

| # | 节 | 字节 | 归类 | 理由 | 建议动作 | 深度 |
|---|---|---:|---|---|---|---|
| B1 | `Default Workflow` 节引言（4-skill RPC 列表 + 不可用 fallback） | 1,272 | **部分砍** | 「本机装了 superpowers、按 brainstorm→plan→TDD→review 走」= 环境事实，**留**；但「若插件不可用就手动照同样 shape 做」= 冗长的假想边缘 | 压缩：保 skill 指针，fallback 压成一句 | 逐字 |
| B2 | `headless-Runner rule` | 1,349 | **留** | **「没有真人在这个终端」= 模型绝对推断不出**，且推断错 = 在终端等真人 → 永久挂死。这是整份文件里价值密度最高的一段 | 原样留 | 逐字 |
| B3 | override A（设计批准走 gate） | 2,087 | **留** | 契约 + 「**exit 0 本身不是批准**」——这是 Codex code review 抓出的**真洞**（gate 对更正/fail-open 超时也返 0）。典型「模型推断不出的经验」 | 原样留 | 逐字 |
| B4 | override B（文档落 doc-flow 路径） | 741 | **留** | 项目约定 + 条件化（有 DOC-FLOW block 才走） | 留 | 逐字 |
| B5 | override C（简单档留过程跳文件） | 549 | **部分砍** | 核心是一句「docTier 只控文档产出，不控是否思考」；其余是同义反复的解释 | 压成 2–3 句 | 逐字 |
| B6 | `Critical rules`（NEVER/ALWAYS） | 2,062 | **部分砍** | 混杂：「不 skip onboard/brainstorm」「stage 上报」「TDD」= **与 A5/A8/A11 + Blueprint 三重重复**（重复上下文）；「不擅自做产品/架构决定」「不 silently fallback」= 权限边界，留 | 删与 Blueprint 重复项；保留权限边界项 | 逐字 |
| B7 | `Escalation triggers` | 1,483 | **留** | 「何时该找 Lead」= 跨 Agent 协作协议 + 判断框架（真改变结果：错了要么烦 Annie 要么擅自决定） | 留 | 逐字 |
| B8 | `Pipeline stages` | 1,281 | **砍候选** | **纯重复上下文**：stage 清单与 Blueprint `stage-reporting`（A11, 454 B）说同一件事，且 A11 是权威版（带真实命令）。附带的 auto-QA 段落也与 `qa-verdict`/auto-QA 契约重复 | **删**，保留一句指向 A11 | 逐字 |
| B9 | `Skills you can assume exist` | 946 | **砍候选** | 枚举 onboard/brainstorm/research/write-plan/implement/codex-review 六个 skill 并解释各自用途——**模型本来就有 skill 列表**（带 description），会自己发现自己调。此节是「模型本来就会的方法论」+ 枚举 | **删**（或压成一句「项目可能提供 onboard/brainstorm 等 skill，缺失则手动照做」） | 逐字 |
| B10 | `When you're being used` | 716 | **砍候选** | 解释 dispatcher 为何 fallback 到 generic（三种情形穷举）——**读完不改变任何行为**。典型流程仪式/假想边缘穷举 | **删**（保留一句身份说明即可） | 逐字 |
| B11 | 文件头 preamble | 577 | **留** | 身份定义（你是 Flywheel Runner、无角色匹配）——短且定调 | 留 | 逐字 |
| B12 | `Interaction principles` | 515 | **砍候选** | 「一次问一个问题」「先听再说」「push back 不做应声虫」「surface assumptions」——**通用方法论，且项目 CLAUDE.md 的 Core Behaviors 已逐条覆盖**（重复上下文 × 模型本来就会） | **删**（CLAUDE.md 已覆盖） | 逐字 |
| B13 | `Output convention` | 406 | **留** | **用户长期偏好**（代码/commit/PR 用英文；设计文档默认中文；标题用英文）——公式点名的「留」 | 留 | 逐字 |
| B14 | `Failure path` | 387 | **留** | `complete --route blocked` 终态通道 = 契约；不知道=挂死或硬扛 | 留 | 逐字 |
| B15 | `Scope note`（Superpowers 边界） | 560 | **留** | 「不把控制权交给 Superpowers 编排 skill」= 权限边界（R1 误记 ~65，实测 560） | 留 | 逐字 |

**层 B 小计（审计假设，待评测）**：

| 动作 | 节 | 字节 |
|---|---|---:|
| **砍候选（删）** | B8 1,281 + B9 946 + B10 716 + B12 515 | **3,458（23%）** |
| **部分砍（压缩）** | B1 1,272 + B5 549 + B6 2,062 = 3,883，其中约 **~1,900** 可压 | ~1,900 |
| **留** | B2 B3 B4 B7 B11 B13 B14 B15（+ overrides 小标题 74） | **7,664** |

**四个「删」候选合计 3,458 B（占角色文件 23%）**；其中**三个（B8 Pipeline stages / B9 Skills 列表 / B12 Interaction principles = 2,742 B ≈ 18%）是纯重复上下文**——分别复述 Blueprint 块、skill 列表、CLAUDE.md；第四个（B10）是流程仪式。再加 B1/B5/B6 的部分压缩，**合计可动约 1/3**。

> **这是本审计的核心假设**：generic-executor.md 里最该砍的不是「SOP 太细」，而是**它在复述 runner 已经从别处拿到的东西**（三大删候选 = 复述 Blueprint / skill 列表 / CLAUDE.md）。这个假设**必须过 A/B 才能动**——重复 ≠ 无效，重复也可能起强化作用（这正是评测要回答的问题）。

---

## 3. 层 C — lead-rules（dept 常驻 114,000 B）

> **深度声明：以下为「结构」深度**（章节结构 + 实测字节，未逐字通读 32KB/24KB 全文）。**置信度低于层 A/B**。
> **证据隔离（Codex R1 #7）**：Lead **不在** 评测框架设想的 A/B 重放范围（重放的是 Runner）。本节任何条目**不得**用 Runner 的 A/B 数据背书；要动 lead-rules 必须另立评测单。

| # | 文件 / 节 | 字节 | 归类 | 理由 | 深度 |
|---|---|---:|---|---|---|
| C1 | `founder-only-authority.md` → `R1 Merge/Ship Authorization` | 13,631 | **留（红线）** | **权限风险边界**，三层框架点名不砍。**cos / dept 装（companion 不装此文件）** | 结构 |
| C2 | `founder-only-authority.md` → `Future autonomy roadmap` | 3,089 | **留（撤回砍候选）** | **R1 曾误列砍候选，R2 撤回**（Codex code review HIGH-3）：本节开头是**现行时态守卫**——「下列放宽今天都未生效…**不得当作今日行动的授权**」，且「v1.29.x 严格（现在）」子节陈述**当前**规则（所有 approve/close 每次都走 founder、Lead 评估只是输入非触发）。它是**权限边界**不是纯未来叙事，按「权限边界一律留」不进砍候选。**cos / dept 装（companion 不装）** | 结构 |
| C3 | `department-lead-rules.md` → `Reply Discipline` + `Issue-Bound Reply` + `Shared Channel Reply` | 20,909 | **部分砍** | **占 dept 规则 64%**。内核（哪条消息该回、回哪个 thread）= 跨 Agent 协作协议 + 真实事故（FLY-162/152）→ 留；但 20.9KB 讲「怎么回消息」体量可疑，疑似含大量案例穷举 → **需逐字审计才能定** | 结构 |
| C4 | `department-lead-rules.md` → `Action Gate: When to Start a Runner` | 3,655 | **留** | 权限边界（起 Runner 是 founder-gated 动作） | 结构 |
| C5 | `department-lead-rules.md` → `Gate Timeout Handling` | 3,117 | **留** | 契约（fail-close/fail-open 语义） | 结构 |
| C6 | `README.md` | 7,340 | **N/A（已零常驻）** | **不进任何 role bundle**——给人读的。已经是「正确形态」的样板：文档与运行时指令分离 | 结构 |
| C7 | dept bundle 其余 9 文件 | ~46,000 | **未审计** | 未逐字读，**不给归类**——见 §5 缺口 | 口径 |

**层 C 观察（非结论）**：dept Lead 常驻 114KB 是全系统**单点最大**的常驻上下文，且成本按 token×**全生命周期**放大（Runner 注入只活一个 session）。若瘦身真有收益，**这里的收益量级远超 Runner 侧**——但也正因为它常驻且含 R1 红线，风险最高。**结论：值得单开一个实验室单（评测方法与 Runner 侧不同：要评的是长会话下的判断质量，不是单任务产出）。**

---

## 4. 层 D — flywheel-skills（22 个）

> **深度：口径**（做了 description/body 分列测量，未逐条评 22 份 body 内容）。

**关键结构事实**：description 常驻 **5,625 B**（22 条）；body **177,964 B** 按需加载（31.6×）。

| # | 维度 | 字节 | 归类 | 理由 | 深度 |
|---|---|---:|---|---|---|
| D1 | description 行（常驻，22 条） | 5,625 | **留** | 平均 256 B/条，是 skill 能被正确触发的唯一依据。砍它省不到什么、却直接伤触发准确率——**收益/风险比最差** | 口径 |
| D2 | body（按需，22 份） | 177,964 | **需逐份审计（本单未做）** | **不占常驻** → 「省 token」不构成砍的理由；真问题是调用时 SOP 是否压制判断力（= issue 的原始命题） | 口径 |

**层 D 最重要的一条（口径纠偏）**：

> **skills 的问题不是体积，是形状。** 常驻只有 5,625 B——**砍 body 省不到常驻 token**。body 的风险是「被调用时用 step-by-step SOP 压制模型判断」，与「省上下文」是**两个正交问题**。
> 因此**「skills 太大要瘦身」这个直觉在数据面前是错的**：22 份 SKILL.md 合计 177KB 听起来吓人，但它们只在被调用时进上下文，一个 session 通常只调 0–2 个。
> **正确的 skill 实验不是「删内容」，而是「同一 skill 的 SOP 版 vs 判断框架版」的 A/B**——这与 task#16（de-AI writing skills 评估）方法论同源，建议合并到实验室 #2。

---

## 5. 已知缺口（诚实声明）

| 缺口 | 影响 | 处置 |
|---|---|---|
| 层 C 有 9 个文件（~46KB）未逐字审计 | C7 无归类 | 不给归类，**不猜**。留实验室 #2 |
| 层 D 22 份 body 未逐条评 | D2 只给口径不给建议 | 同上 |
| `.flywheel/agents/*` 项目角色文件（pm 21KB / prototype 19.5KB 等）未审计 | 本单只审了 shipped fallback | 本 session 的注入即 generic fallback，是唯一有逐字证据的角色文件；项目角色文件留实验室 #2 |
| 「真·小 bug fix」任务类型在评测集里缺格 | A/B 结论无法覆盖该类型 | research §2 已记录；留实验室 #2 |

## 6. 汇总（全部为审计假设，待评测）

| 层 | 常驻/注入 | 砍候选 | 部分砍（可压） | 留 | 可动占比 |
|---|---:|---:|---:|---:|---:|
| A Blueprint（非角色） | 15,764 | ~400 | ~200 | 15,164 | **3.8%（<4%）** |
| B 角色文件 generic-executor | 15,005 | 3,458 | ~1,900 | 7,664 | **~1/3** |
| C lead-rules（dept 常驻） | 114,000 | 0（C2 撤回后无净砍候选） | 20,909 待定 | 23,492+ | 未定（审计深度不足） |
| D skills description（常驻） | 5,625 | 0 | 0 | 5,625 | **0%** |
| D skills body（按需） | 177,964 | 未审 | 未审 | — | 口径不同，不适用 |

**三条可以带去评测的假设**：

1. **Blueprint 层基本没有瘦身空间**（<4%）——它 75.6% 是契约层。想在这里砍，就是在砍安全边界。**这条几乎不需要评测就能定**（结构性事实）。
2. **generic-executor.md 有 ~23% 是纯删候选（其中 ~18% 是重复上下文，复述 Blueprint 块 / skill 列表 / CLAUDE.md），加部分压缩可动约 1/3**，是**最值得优先 A/B 的一块**——体量大（15KB × 每个无 label 匹配的 runner）、病因单一（重复/仪式）、且不碰契约。
3. **skills 的「大」是错觉**（常驻仅 5,625 B）——把它当上下文成本问题会走错方向；真命题是 body 的 SOP 形状，属另一类实验。

> 再说一次：以上**没有一条**有 A/B 数据支撑。它们是**审计假设**。
> **在 `eval-framework-proposal.md` 的评测跑出数据之前，一行生产提示词都不动。**
