# FLY-1260 Harness 实验室 #1：提示词/技能瘦身审计 — 调研

Issue: FLY-1260 (https://linear.app/geoforge3d/issue/FLY-1260/research-harness-实验室-1提示词技能瘦身审计-评测框架无评测数据不动生产提示词)
日期: 2026-07-14
基于: exploration.md

## 1. 三层资产真实结构（盘点对象与精确计数方法）

### 1.1 Blueprint runner 提示词（`packages/edge-worker/src/Blueprint.ts`，2320 行）

组装机制：`runInner()` 逐块拼 `systemPromptLines` 数组 → 作为 `appendSystemPrompt` 传给 runner CLI。块清单与注入条件（源码 grep 核实）：

| 块 | 源位置（行锚） | 注入条件 |
|---|---|---|
| RESUME directive（FLY-795） | 1486-1490 | 仅 progressResume 重派时 |
| PIPELINE PREAMBLE（onboard 五步） | 1445-1485 | projectName 存在；claude/codex 两变体 |
| 6-step base flow（读码→TDD→PR→land→exit） | ~1200-1290 | 基线 |
| three-stage phase 提示词（design/implement/qa 分段） | ~1000-1260 | 项目 three_stage on 时按 phase |
| QA mode 系统提示（`buildQaModeSystemPromptLines`） | 405-497 | auto-QA runner |
| DOC-FLOW（doc 落点+三档） | 1289-1374 | doc_flow.enabled 且 default_department 可解析 |
| PROGRESS LEDGER | 1375-1443 | 默认注入 |
| ask 非阻塞指引 + inbox 指引 | 1492-1530 | leadId 存在 |
| LEAD REPORT-BACK + MERGE AUTHORITY（FLY-208） | 1532-1580 | leadId 存在，**独立于 checkpoint 配置** |
| BRAINSTORM / QUESTION / APPROVE / CODE REVIEW GATE | 1582-1823 | checkpointConfig 按 checkpoint 开关逐个注入 |
| COMPLETION REPORTING | 1824-1840 | 默认注入 |
| Agent Role 文件（含角色专属流程） | 1851-1900, readAgentFile:2231 | 按 label 匹配项目 `.flywheel/agents/*.md`，fallback shipped `agents/generic-executor.md`；40k **char** 截断 |

**精确字数方法（实现阶段）**：复用测试套件的 fake-runner 模式（`Blueprint.fly205-doc-flow.test.ts:127` 捕获 `call.appendSystemPrompt`），用代表性 ctx（flywheel 项目 / generic runner / doc-flow full / checkpoints on / lead 在）生成完整 prompt，按块头锚点（"PIPELINE PREAMBLE"、"PROGRESS LEDGER"、"DOC-FLOW"、"LEAD REPORT-BACK"、"BRAINSTORM GATE"…）切分计数 → 脚本 `inventory.mjs`，产出即标注表的骨架。体感规模参考：本 runner 自身收到的注入 ≈ 角色文件 15KB + Baseline Rules ≈ 9KB。

### 1.2 Agent 角色文件

| 文件 | 字节 |
|---|---|
| `agents/generic-executor.md`（shipped fallback） | 15,005 |
| `agents/qa-executor.md`（shipped） | 6,149 |
| `.flywheel/agents/engineering/pm-executor.md` | 21,190 |
| `.flywheel/agents/engineering/prototype-executor.md` | 19,555 |
| `.flywheel/agents/engineering/designer-executor.md` | 9,875 |
| `.flywheel/agents/engineering/product-designer-executor.md` | 6,642 |
| `.flywheel/agents/engineering/engineer-executor.md` | 4,526 |
| `.flywheel/agents/engineering/qa-executor.md` | 3,330 |
| `.flywheel/agents/general-executor.md` | 1,395 |

### 1.3 lead-rules 层（`packages/teamlead/lead-rules-base/`，20 文件合计 159,239 字节，本 checkout 实测）

大头：`department-lead-rules.md` 32.9KB、`founder-only-authority.md` 24.2KB、`cos-lead-rules.md` 23.0KB、`cross-dept-channel-rules.md` 10.0KB。装载方式：`lead-rules-bundle.sh` / `claude-lead.sh` 按 role/backend/config 拼**子集** bundle——没有任何 Lead 背全部 20 个文件，`README.md` 也不是运行时指令。盘点必须报两列：原始文件大小 + **按 role 装配后的常驻大小**（cos / dept / companion 各算一列）。**注意**：lead-rules 是常驻上下文（每个 Lead 全程背着），瘦身收益按 token×session 时长放大；但 Lead 不在本次 A/B 重放范围（重放的是 Runner），lead-rules 只做盘点+标注，其瘦身条目一律标「审计假设」，不得沿用 Runner A/B 数据背书（Codex R1 #7）。

### 1.4 flywheel-skills 库（`xrliAnnie/flywheel-skills` → `~/.agents/skills/`，22 个 managed skill）

SKILL.md 合计 177,964 字节。大头：xiaohongshu-learning 31.5KB、deep-research 18.4KB、synthesize-research 16.5KB、product-brainstorming 16.3KB、chrome-repair 16.0KB。**成本结构与前两层不同**：skill body 按需加载，常驻成本只有 description 行（skill 列表）；瘦身分两个维度——①description 常驻行是否精准（影响误触发/漏触发），②body 是否 SOP 过度（调用时压制判断力）。标注表按此拆列。

### 1.5 记录但不在本单审计 scope 的表面

用户全局 `~/.claude/rules/*.md`、CLAUDE.md 链（~/Dev + 项目 + packages/）、superpowers 插件 SessionStart 注入、runner-shared MEMORY.md。这些与 Blueprint 层叠加构成 runner 真实总上下文——报告里给一张「总上下文构成图」让 Annie 看到全貌，但标注/A/B 只动 issue 点名的三层。

## 2. 重放任务候选（ground truth 已核实在仓）

| 任务 | 类型 | 重放起点 | 输入 | ground truth | 主评法 |
|---|---|---|---|---|---|
| T1 = FLY-1242 删除 dead lead_pane_readiness flag + 死代码路径 | 有界代码变更 | `7f9f401b1^` | issue 描述原文 | merge `7f9f401b1` 的代码 diff（7 文件，61+/280-） | 隐藏评估器（flag grep-zero + 定向测试绿）+ 与真实 diff 对照 + rubric |
| T2 = FLY-1245 design-phase Codex↔Fable kill-switch | 设计 | `c797a0d12^` | issue 描述原文 | `engineering/doc/FLY-1245-codex-design-killswitch/plan.md`（Codex 4 轮 approved） | 盲评 rubric，对照真实 plan 的关键决策点覆盖率 |
| T3 = FLY-1246 QA PR #584（founder_image_approval 死代码删除） | QA | 历史 PR head `ed9823622`（base=`cfb27099d` 播种为 origin/main；**不是**合并后的 squash commit `8bc3cfd99`——commit 身份/历史不同，用后者会撞 QA 自己的 head-freeze 检查，Codex R2 #3） | issue + PR 号 | `engineering/doc/FLY-1246-qa-founder-image-approval/qa-report.md`（verdict+findings；其记录的 OPEN/CLEAN/checks-passing 历史态即 gh fixture 数据源，无需再触真 GitHub） | findings 对照（查全/查准）+ verdict 一致性 |

防污染核查：三个起点 commit 均不含对应答案文档（docs 与 fix 同 commit 或后置 commit 合入）；任务均为 2026-07 完成，晚于两模型 knowledge cutoff。已知保真度残差：真实 runner 有 Lead 互动，重放用 stub 应答（见 3.3），差异记入报告 caveat。

**T1 更换记录（Codex R1 #8）**：初稿选 FLY-1193，实测 `33be9ac6b` 达 15 文件 2354+/120-（含 472 行 sensor 重写 + 645 行测试），不是小修复——本仓近期「fix」类 commit 普遍带重测试/证据行李（FLY-1239 code 部分 1167+、FLY-1236 802+、FLY-1234 3512+），pilot 30min 包络内没有真·小 bug fix 格子。故 T1 换为 FLY-1242（有界删除类代码变更）并如实标注类型；「真 bug fix」任务类型的覆盖缺口记入报告 caveat，留给实验室 #2。

## 3. Harness 技术可行性

### 3.1 Fable 腿：`claude -p`（headless）

- 本机 claude 2.1.210：`-p`、`--append-system-prompt(-file)`、`--output-format json`（返回 usage / total_cost_usd / **num_turns** / result）、`--model`、`--disallowedTools`、`--strict-mcp-config`。
- ~~**环境选型（关键决策）**：用默认 `~/.claude`~~ **已被推翻（Codex R2 #1）**：live `~/.claude` 的 settings 会真执行生产 hooks（PostToolUse inbox-check、discord-reply-enforcer、SessionEnd 等），MCP/env 隔离拦不住——违反零生产接触。终版 = plan 提案 §3.3 的 S1a/S1b/S1c 阶梯（净化版 iso CLAUDE_CONFIG_DIR 优先）+ 零 hook 执行哨兵。A/B 唯一差异仍 = `--append-system-prompt-file` 内容（与生产注入机制同构）。
- cwd = 一次性独立 clone（**非** linked worktree，见 §3.3 supersede 说明）；`--strict-mcp-config` + 空 mcp-config + 显式 no-chrome 开关。

### 3.2 gpt-5.6 腿：`codex exec`

- 本机 codex-cli 0.144.4，config.toml 默认 `model = "gpt-5.6-sol"` + `xhigh`——即 issue 说的 gpt-5.6。
- ~~机器铁律：一律 `codex-with-fallback exec`~~ **run 内已被推翻（Codex R2 #2）**：该 wrapper 的轮转会改写宿主 `~/.codex/auth.json` 与 `profiles/.active`，违反零生产配置变更。终版 = plan 提案 §3.3：run 内 pin 单一账号进 iso CODEX_HOME 直接 `codex exec`（**前台**硬 timeout + 进程树 kill 兜底以对冲挂死前科），限流记模型失败；隔离边界外（judge/review）照常 codex-with-fallback。
- prompt 注入（**Codex design review R1 更正**）：生产 codex runner 的真实机制是两层——① 持久合同 `codex-runner-contract.md` 由 `packages/claude-runner/src/codex-home.ts:326-338,457-470` 物化进 per-run `$CODEX_HOME/AGENTS.md`；② 动态 Blueprint prompt（appendSystemPrompt）由 `CodexTmuxAdapter.ts:379-391` 作为 systemLayer 与任务一起放进首个 turn/start kick 文本（`codex-daemon-adapter-helpers.ts:42-73` 明示这是 user turn）。harness 必须同构：**隔离 CODEX_HOME 按 provisionCodexHome 同形制备（含持久合同）+ 「变体 + 分隔线 + 任务」作 exec 输入**；变体绝不写 worktree AGENTS.md（会改指令优先级层、漏掉持久合同——初稿方案已废弃）。`-C <clone> --skip-git-repo-check -s workspace-write`。M0 加字节/顺序 parity 断言。
- token 计量：codex exec 输出尾部 tokens used 统计 + `--json` 事件流；轮数从事件流计。

### 3.3 隔离与插手计量：comm stub + 本地 remote + gh shim

> **已被取代（Codex R1/R2）**：本节初稿设计有多处已被 plan.md 的评测框架提案修订取代——①linked worktree 改 origin 会写共享 `.git/config` 污染主仓 → 改为 per-run 一次性独立 clone（源自 seed bare、remote 只允许 file/local）；②极简无状态 stub → 改为由 6 份捕获 prompt + role 文件**生成的命令 manifest 作唯一 allowlist**（含 `gate review_design`/`review_code`、`declare-state park`、`await-codex-gate` 等真实动词与别名，未知命令大声失败记 infra failure）；③gh shim 用每任务冻结 fixtures（T3 用 QA 证据里的历史 OPEN 态）；④live `~/.claude` 的生产 hooks 必须被净化/禁用并加零 hook 执行哨兵。以下仅存初稿思路作背景，实施以 plan 提案为准。

### 3.4 指标采集（5 指标落点）

> **已被取代（Codex R1 #6 / R2）**：初稿「交叉单评」与「gate+ask 合并计数」已修订——两位盲评各评全部 12 份（全集重叠，可算评审间一致性）；插手计量拆成 gate_compliance / discretionary_asks / simulated_human_decisions 三独立字段；轮数/token 只在模型内比较。终版见 plan 提案。初稿表保留作背景：

| 指标 | Fable 腿 | gpt-5.6 腿 |
|---|---|---|
| 产出质量评分 | 盲评 rubric（正确性/完整性/范围纪律/证据质量，1-10）；T1 加客观项（改对文件？语义等价？定向 vitest 过？） | 同左 |
| 来回轮数 | JSON num_turns（仅模型内比较） | --json 事件流计数（仅模型内比较） |
| token 消耗 | JSON usage（分 input/output/cache） | tokens used 统计 |
| 插手相关 | 三字段拆分（见上） | 同左 |
| 审查 findings 数 | 结构化 findings（severity + ground-truth 证实），不用裸计数 | 同左 |

### 3.5 变体构造（防稻草人）

- **A 臂（现版）**：`inventory.mjs` 捕获的完整 appendSystemPrompt 原文。
- **B 臂（瘦身版）**：严格按标注表推导——「砍候选」块删除或压缩为一句边界声明，「留」块（契约层：gate 协议、merge 授权、report-back、founder 物料纪律）逐字保留。每处删改在标注表可追溯。变体文本作为工件进 PR。

> **§4-6 supersede 说明（形态变更后）**：pilot 的执行、排程与 spikes **不属于本轮**（Annie 直令：评测框架保持提案章节）。以下内容作为提案背景保留，执行细节以 plan.md §3（评测框架提案）为准，由后续实验室单落地。

## 4. 成本与排程

- 12 runs = 3 任务 × 2 变体 × 2 模型。Fable 6 runs 排 5h 配额窗口宽松时（每 run 设 wall-clock 超时 ~30min）；codex 6 runs 订阅内前台跑。评审 12 产物 × 2 交叉盲评 + findings review。
- 方向性信号出来后仅对决策相关格子加 2-3 重复（Lead 拍板规则）。

## 5. 关键不确定点 → plan 前置 spike

| # | 不确定点 | spike |
|---|---|---|
| S1 | claude -p 默认 dir 下长任务稳定性（旧崩溃是 iso dir 特有） | 微型任务跑通 -p + append-system-prompt-file + JSON 输出全链 |
| S2 | codex exec 挂机风险 + gpt-5.6-sol 实际可用 | codex-with-fallback exec 前台限时跑微型任务，确认 token 统计可解析 |
| S3 | pinned worktree 内 pnpm install + 定向 vitest 可行性（T1 需要） | 在 `33be9ac6b^` worktree 装依赖跑 1 个相关测试文件 |
| S4 | inventory.mjs 能否直接 import dist Blueprint（或需 tsx 编译源码） | 试 import + 生成一份样本 prompt |

任一 spike 失败有降级路径：S1 失败→tmux 交互驱动（Runner 生产形态，capture-pane 取结果）；S3 失败→T1 评分去掉「测试过」客观项，保 diff 对照；S2 失败→codex 腿改用 exec 输出文本解析或推迟到 #2 实验室并报告。

## 6. 结论

技术路线可行，无生产变更面：全部工作发生在 scratchpad worktree + 文档/脚本工件。进入 plan：先 spike（S1-S4）→ inventory + 标注表 → harness 搭建 → 12-run pilot → 分析 + 报告素材。
