# FLY-1260 Harness 实验室 #1：提示词/技能瘦身审计 — 实施计划

Issue: FLY-1260 (https://linear.app/geoforge3d/issue/FLY-1260/research-harness-实验室-1提示词技能瘦身审计-评测框架无评测数据不动生产提示词)
日期: 2026-07-14
基于: research.md（含 Codex design review R1/R2 更正）

## 0. 形态变更与铁律（本节盖过早期版本的执行范围）

**Annie 直令（2026-07-14 17:53 PDT，lead-instruction 0701c844，盖过之前所有形态假设）**：本单为**一段式**——本 session 是唯一一段，不做 implement/QA 交接（auto-QA 取消），本 session 产出 = 最终交付物。交付物形态 = **可互动 HTML 审计报告**，发到 issue thread 后由 Annie 逐条批注，按批注迭代。

- **红线不变**：生产提示词/skill 一行不动（不改 `packages/**` 除本 doc 文件夹、`agents/`、`lead-rules-base/`、flywheel-skills repo、任何生产配置）。
- **评测框架保持提案章节**：A/B 实测**不在本轮执行**。因此本轮产出的每一条「砍」建议一律标注**审计假设（待评测）**，不得写成已证结论——这是「无评测数据不动生产提示词」铁律的自然推论。评测框架提案（§3）承载全部 Codex R1/R2 修正，供后续实验室单执行。
- 发布方式为 Lead 显式指定：`flywheel-comm publish-report --html <file> --project flywheel --channel 1526749610771484712 --title 'Harness 瘦身审计 · 互动版'`（channel = 本 issue 的 thread；这是对「Runner 不 publish founder 物料」纪律的**指令性例外**，由 Annie 直令 + Lead 给定参数）。
- 迭代纪律：批注一轮攒齐改一版，**每轮发布一个版本化新链接**（`publish-report` 每次调用生成新 token URL，不存在同链接更新——Codex R3 #1 核实；不为此加任何生产端点）。thread 里最新一条消息 = canonical，旧链接留作历史（7 天 retention 自然过期）。跨版本批注不丢：靠稳定的 issue 级 localStorage schema + 确定性卡片 ID（§4），同 Vercel origin 下新版本页自动导入未变 ID 的已选/已评。不逐条微调刷新卡片。
- 本段停在 approve gate；绝不自 merge / 自 ship。

## 1. 交付物（全部落 `engineering/doc/FLY-1260-harness-prompt-audit/`）

| 文件 | 内容 |
|---|---|
| `inventory.md` | 三层盘点（真实测量）：Blueprint 全部条件块（含互斥/禁用块）× 注入条件 × 实测字数；agents 角色文件；lead-rules 原始大小 + 按 role（cos/dept/companion）装配常驻大小两列；skills 22 个（description/body 分列，以 `.skill-lock.json` 的 22 项名单 + 各自 `skillFolderHash` 为复现单位）；runner 总上下文构成全貌（scope 外表面只记录不审计） |
| `harness/inventory.mjs` | 本轮**唯一**要写的脚本：测试同款 fake-runner 驱动 pinned commit 的 Blueprint，显式 context 矩阵捕获全部条件块并计数；任一源码块未被矩阵捕获 → 脚本 fail |
| `harness/inventory-manifest.json` | 本轮盘点的 provenance（Codex R3 #5）：Blueprint/agents/lead-rules 的精确 SHA/哈希、22 条 skill lock 项 + 各 `skillFolderHash`、context 矩阵输入与 flag、切块锚点、脚本/runtime 版本；**计数单位定义**：每块同时报 UTF-8 字节 + Unicode 字符，装配态另报含分隔符的 post-assembly 常驻大小；互斥 context 绝不加总成单一常驻数。每张报告卡引用其 manifest/inventory 行 |
| `annotation-table.md` | 标注表：每块归类（留/砍候选/部分砍）+ 理由 + 瘦身建议 + 证据层级标签（全部为「审计假设」，无评测数据不升级）；契约类块一律标留 |
| `eval-framework-proposal.md` | 评测框架**提案**（§3 全文落档，含 R1/R2 全部修正），供后续单执行 |
| `report.html` | 可互动审计报告（§4 规格） |
| `report-material.md` | 报告文字素材源（卡片文案 + 章节内容），与 HTML 同步 |

## 2. 里程碑

### M1 — 盘点（真实测量）
1. `harness/inventory.mjs`：复用 `Blueprint.fly205-doc-flow.test.ts:127` 的 fake-runner 捕获模式，从当前 pinned commit 驱动 Blueprint 的**显式 context 矩阵**（lead/no-lead、checkpoints 各型、doc-tier 三档、three-stage 各 phase、QA mode、resume/retry、claude/codex vendor 变体、founder-UX、keep-alive、land/PR 等），按块头锚点切分计数；源码块清单与捕获结果对账，未捕获 → fail。
2. lead-rules 按 `lead-rules-bundle.sh` 逻辑算三种 role 装配常驻大小；skills 以 lock 快照（22 名单 + folderHash）计 description/body 字数；agents 文件实测。
3. 汇总 → `inventory.md`。

### M2 — 标注表
逐块按 Annie 公式归类（留 = 模型推断不出的经验/长期偏好/权限风险边界/跨 Agent 协议/真正改变结果的判断框架；砍候选 = 通用操作步骤/流程仪式/重复上下文/假想边缘穷举/模型本来就会的方法论），三层框架（契约/协作/方法论）作 sanity check。每块：归类 + 理由 + 建议动作（删/压成一句/原样留）+ 「审计假设」标签。**契约类块（gate 协议、merge 授权、report-back、founder 物料纪律、权限边界）一律标留。**

### M3 — 评测框架提案落档
§3 全文写入 `eval-framework-proposal.md`（含预注册细则、隔离方案、六基线捕获、stub/fixture 契约——即 R1/R2 修正后的完整设计）。

### M4 — 互动 HTML 报告（§4 规格）+ 冒烟
构建 `report.html`；本地打开自测交互（评论框、toggle、汇总、导出、未审计数）；对抗性转义 fixture 过测（§4）；确认 `<script nonce="__CSP_NONCE__">` 形态正确；**发布预检（Codex R4 #2）**：完整文档结构（含 `<head>`）+ UTF-8 字节数 ≤ 512KiB 断言（publish-report 的硬限），在 code review 前就跑，避免卡量爆限到 M6 才发现。

### M5 — PR + Codex code review（先审后发，Codex R3 #8）
lint → commit → push → PR → CODE REVIEW GATE（per prompt 流程）跑到 APPROVED——让 review 有机会抓转义/nonce/导出/事实缺陷**再**给 founder 看。

### M6 — 发布 + gate
1. 用已审 head 的 `report.html` 执行 `publish-report`（§0 给定参数），hosted 页复测交互；`ask --report` 向 Lead 报 DONE（含 hosted 链接）。
2. APPROVE GATE 非阻塞挂审 → 停，等 wake。
**批注迭代**：Annie 批注到达（wake）→ 攒齐一轮修改 → 更新 HTML/docs → push 新 head → Codex 增量 re-review（HEAD DISCIPLINE）→ 发布**新版本链接**（Round N）→ 重开 gate。

### 提交前置门（每次 commit 前）
`git status --porcelain` 全量（含 untracked）路径必须仅在 `engineering/doc/FLY-1260-harness-prompt-audit/**`（Codex R2 #5：`git diff` 看不到 untracked）；生产 repo remotes/config 零变化。

## 3. 评测框架提案（本轮不执行；后续实验室单的执行蓝本）

> 定位（Lead 拍板）：pilot 的目的是**验证评测框架本身**（rubric 区分度、隔离干净性），不是下最终结论。规模 = 3 任务 × 2 变体 × 2 模型 = 12 runs 单次。

### 3.1 重放任务集（ground truth 已核实在仓，见 research §2）
- T1 = FLY-1242 dead-flag 删除（有界代码变更，7 文件 61+/280-）：起点 `7f9f401b1^`；隐藏事后评估器 = flag grep-zero + 定向测试绿 + 与真实 diff 对照。真·小 bug fix 格子缺口如实声明（本仓近期 fix 均带重行李），留实验室 #2。
- T2 = FLY-1245 kill-switch 设计：起点 `c797a0d12^`；盲评 rubric 对照真实 Codex-approved plan 的关键决策点覆盖率。
- T3 = FLY-1246 QA PR #584：**在历史 PR head `ed9823622` 重放**（base `cfb27099d` 播种为 origin/main），gh fixture = QA 证据记录的 OPEN/CLEAN/checks-passing 历史态（数据已在仓，无需触真 GitHub）；评 findings 查全/查准 + verdict 一致性，评「独立取证质量」而非复述可见文档。

### 3.2 处理（treatment）与变体
- **六基线**：T1-T3 × Claude/Codex 各自捕获完整注入文本（任务/phase/role/config/vendor 特异，全部输入字段与 env flag 记录进 manifest）。
- **B 臂**：对六基线施加**同一套块级变换**（由标注表逐行推导；砍候选删/压成一句边界声明，留块逐字保留），得六份 B；12 份文本 + 哈希入库。不设目标压缩率。
- **处理范围声明（Codex R3 #7）**：pilot 只变换**捕获的 Blueprint 注入 Runner 块**；持久合同、所选 role 文件、lead-rules、skills、全局面在两臂间**字节一致**——这些表面的瘦身需另立评测单获批后才可实验。
- **Claude 注入**：`claude -p --append-system-prompt-file`（与生产 appendSystemPrompt 同构）。
- **Codex 注入**（R1 #1 更正）：隔离 CODEX_HOME 按 `provisionCodexHome` 同形制备（持久合同 → `$CODEX_HOME/AGENTS.md`）；「基线 systemLayer + 分隔 + 任务」作 exec 输入，与 `CodexTmuxAdapter.ts:379-391` 拼装做字节/顺序 parity 断言；变体绝不写 worktree AGENTS.md。

### 3.3 隔离（R1 #3 / R2 #1 #2）
- **git**：per-run 一次性独立 clone（源自 seed bare，绝不用 linked worktree——共享 `.git/config` 会被 remote 改写污染）；remote 仅允许 file/local，启动断言违规即 fail；真实 GitHub 访问只在交付步、隔离环境之外。
- **claude 腿零生产 hook 执行**（硬要求；live `~/.claude` 带 PreToolUse/PostToolUse/Stop/SessionEnd/PostCompact 生产 hooks，MCP/env 隔离拦不住）。阶梯：S1a 净化版隔离 CLAUDE_CONFIG_DIR（FLY-572/670 配方 rsync + creds relocate，iso 内 hooks 置空、插件裁剪，实测 `-p` 是否仍崩）→ S1b 默认 dir + `--settings` 净化覆盖（仅当 merge 语义实测可禁 hooks）→ S1c iso dir + tmux 交互驱动（配方已证，指标从 transcript jsonl 抽取）。任何选项都要 **hook 哨兵**：transcript 零 hook 事件 + 已知 hook 副作用路径快照前后无变化。`--strict-mcp-config + 空 mcp-config + 显式 --no-chrome 开关`。
- **codex 腿零宿主变更**（R2 #2）：run 内 **pin 单一账号**（active auth 复制进 iso CODEX_HOME）直接 `codex exec` 前台 + 硬 timeout + 进程树 kill 兜底；**不用 codex-with-fallback**（其轮转改写宿主 `~/.codex/auth.json` 与 `profiles/.active`）；限流按失败政策记模型失败。宿主 auth.json/.active 哈希每 run 前后断言不变。judge/review 等隔离边界外照常走 codex-with-fallback。
- **env 卫生**：白名单化，剥除 GH/Linear/Discord/Bridge token 与 `FLYWHEEL_*`；隔离 `GH_CONFIG_DIR`、`GIT_CONFIG_GLOBAL/SYSTEM`、禁 credential helper。
- **comm stub / gh shim**：由六基线 prompt + 所选 role 文件**生成的命令 manifest 作唯一 stub allowlist**（真实动词如 `gate review_design`/`review_code`、`declare-state park`、`await-codex-gate` 等以捕获为准，不手写清单）；有状态确定性应答（approve/ship 给终态）；未知命令大声失败记 infrastructure failure；绝对路径与裸 `flywheel-comm` 两入口都重写。gh shim 用每任务冻结 fixtures（T3 用历史 OPEN 态）。
- **对抗性冒烟**：证明真 gh 未认证、生产 comm 不可达、credential helper 失效、push 只落本地 bare、生产 repo `.git/config`/remotes 无 diff、零 hook 执行、宿主 `~/.codex` 无变化。

### 3.4 指标（构念拆分，R1 #6）
质量 = 双盲评 rubric（两位评审各评全部 12 份，全集重叠）+ 任务客观评估器；轮数/token 仅模型内比较（token 分 input/output/cache）；`gate_compliance` / `discretionary_asks` / `simulated_human_decisions` 三独立字段不相加；findings 结构化（severity + ground-truth 证实）。真实成本模型（founder 定调）：订阅 token 近零、Claude 配额按量；模型内 A/B 用原始 token，「省钱」结论用真实成本口径。

### 3.5 预注册（执行单在跑前冻结 `analysis-plan.md`，数值现已定死，R2 #7）
- 格子质量值 = 两盲评均值；**实质分歧** = |J1−J2| ≥ 3 → 盲态仲裁分**替代**均值。
- 决策相关格子触发 = 成对质量差（B−A）绝对值 ≥ 2.0（用上述聚合值）或客观评估器翻转；触发后该格**恰好 +2 次重复**。
- 非劣界 = B−A > −1.0（恰等于 −1.0 记「未达非劣」→ 不确定）。
- 失败政策：infra failure → 修 harness 后同格重跑 1 次并保留失败记录；模型失败（超时/放弃）→ 保留为数据不填零；失败格子不外推。
- A/B 在 task×model 内交替对位；每 run 全新 clone/CODEX_HOME；CLI/model/账号 profile/config 哈希入 manifest。n=1 结论上限 = 方向性；「强证据」仅来自客观不变量或满足上述规则的重复格子。
- **评审效度（Codex R3 #7）**：两盲评一致只证信度不证效度——预注册评审身份与 rubric 锚点（锚到专家决策例），加一小撮 Lead/人工校准样本；有客观评估器的项以客观结果优先于评审分。
- **重复格升级规则（Codex R4 #3，执行单跑前冻结）**：选择性加测的重复格（n=3，由首个观察效应触发）**默认仍以「方向性」为上限**；升「强证据」仅当该格有确定性客观评估器背书，或另行独立 powered study——不因重复了就自动升级。
- M0 spikes（S1 阶梯、S2 parity、S3 依赖安装、S4 捕获）产出能力矩阵；fallback 仅当保同注入层+同工件+同指标 schema，否则该腿 infeasible、显式改 scope。
- **provenance**：committed `manifest.json`（Blueprint SHA、agents/lead-rules 哈希、skills lock 快照、任务/变体/fixture/rubric 哈希、CLI 版本、config 快照、run 顺序）；结果行引用哈希；no-diff 门用 `git status --porcelain` 全量路径校验。

## 4. 互动 HTML 报告规格（Annie 直令形态）

- **形态**：Apple-style light 主题（用户 HTML 规范），mobile-first。
- **结构**：
  1. 头部：**审计摘要（待验证假设）**——不写「结论」（本轮无评测数据，Codex R3 #6）+ 总上下文构成图（三层 + scope 外表面；**原始资产大小与按 role/context 装配常驻大小分开展示，互斥 context 不加总**）。
  2. **卡片区**：每个瘦身候选一张卡——现状（块名/所在层/实测字节与字符/注入条件/manifest 行引用）、证据（公式归类理由 + 正反例）、建议动作（删/压缩/改写，附压缩后示意）；**每卡**：评论输入框 + 「建议改 / 不动」toggle，**初始态 = 未审**（未审计数显式展示，绝不预选——预选会把报告建议冒充成 Annie 的决定）。排序 = **审计优先级启发式**（实测常驻 footprint × 常驻/条件注入），明确标注为启发式，不称「预估收益/节省」。
  3. 必须留清单章节（契约层，逐块一句理由）。
  4. 评测框架提案章节（§3 摘要 + 指向 proposal 文档）。
  5. 局限与 caveat（全部建议为审计假设、无 A/B 数据、任务类型缺口、发布链接版本化等）。
  6. 底部汇总条：「建议改」数 / 「不动」数 / 未审数 / 已留言数，**一键复制导出**。
- **卡片 ID 与状态（Codex R3 #4）**：确定性资产 ID = `层:路径:块锚点`（跨版本稳定）；localStorage key = `FLY-1260:audit:v1`（issue+schema 级，避免同 origin 其他报告碰撞）；Round N 新页自动导入未变 ID 的已有选择/评论，导出含：报告版本、inventory manifest 哈希、每卡 ID/选择/评论（未审 = 显式 null）、相对上一版新增/移除的 ID 清单。复制按钮用仓内已验证的 mobile-safe 模式：可见只读 textarea + 同步 `execCommand('copy')` fallback + `navigator.clipboard`，成功/失败如实提示。
- **安全契约（Codex R3 #3）**：报告会渲染 prompt/rule/skill 原文——**所有源文本一律 HTML 转义**；运行时评论/导出只经 `value`/`textContent`，绝不 `innerHTML`；事件全部 `addEventListener`（无 `onclick`、无外部/网络代码）；对抗性冒烟 fixture 含引号/标签/`</script>`/nonce 占位符字样/`&`/Unicode，**本地裸文件与 hosted CSP 注入页两态都测**。
- **发布**：§0 给定的 publish-report 命令，发本 issue thread（先审后发，见 M5/M6）。

## 5. 风险与应对

| 风险 | 应对 |
|---|---|
| 无评测数据的建议被误读为结论 | 每卡「审计假设」标签 + 报告头部铁律声明 + 汇总导出带标签 |
| 卡片过多淹没 Annie | 按审计优先级启发式（实测常驻 footprint × 常驻/条件注入）排序置顶，长尾折叠；明确标注为启发式非收益预估 |
| inventory.mjs 驱动 Blueprint 失败 | **显式降级结果（Codex R3 #8）**：改为本 runner 实收 prompt + 源码人工切块，标「人工提取」置信级，**须经 Lead 确认接受 + 同步修订验收标准 1**（或补独立的源码↔输出交叉核对）；不允许一边宣称人工提取可接受一边要求断言通过 |
| publish-report 落错频道 | 严格用 Lead 给定 --channel；发布后核 delivered 回执 |
| 批注迭代 head 漂移 | 每轮攒齐 → push → Codex 增量 re-review → 发布新版本链接 → 重开 gate（HEAD DISCIPLINE） |

## 6. 验收标准

1. `inventory.md` + `harness/inventory-manifest.json`：context 矩阵覆盖源码全部条件块（脚本断言通过；若走人工提取降级，须 Lead 确认 + 本条按降级版收窄）；计数为实测（UTF-8 字节 + Unicode 字符 + 装配态常驻），非估算；lead-rules 双列；skills 以 lock 快照（22 名单 + folderHash）为复现单位。
2. `annotation-table.md`：每块归类+理由+建议+「审计假设」标签；契约层无一进砍候选。
3. `report.html`：卡片/评论框/toggle/未审态/汇总/一键导出在本地裸文件与 hosted（nonce 注入后）两态均可用；对抗性转义 fixture 过测；**发布用已过 Codex code review 的 head**；publish-report 发到指定 thread 有 delivered 回执。
4. `eval-framework-proposal.md` 完整承载 §3（含预注册数值、处理范围声明、评审效度条款）。
5. `git status --porcelain` 全量路径仅本 doc 文件夹；生产 repo remotes/config 零变化；PR 过 Codex code review + approve gate 挂审。
