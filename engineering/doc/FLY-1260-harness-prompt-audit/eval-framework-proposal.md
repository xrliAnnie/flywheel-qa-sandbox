# FLY-1260 Harness 瘦身审计 — 评测框架提案

Issue: FLY-1260 (https://linear.app/geoforge3d/issue/FLY-1260/research-harness-实验室-1提示词技能瘦身审计-评测框架无评测数据不动生产提示词)
日期: 2026-07-15
基于: plan.md §3、annotation-table.md

## 0. 本文档的定位

**这是提案，不是执行记录。本轮（FLY-1260）不跑 A/B。**

Annie 直令（2026-07-14 17:53 PDT）把本单收敛为一段式：交付 = 审计 + 评测框架 + 建议。**A/B 实测不在本轮执行**——因此 `annotation-table.md` 的每条「砍」都标「审计假设（待评测）」，本文档是**后续实验室单的执行蓝本**。

> **定位（Lead 拍板）**：pilot 的目的是**验证评测框架本身**（rubric 有没有区分度、隔离干不干净），**不是**下最终结论。
> 规模 = **3 任务 × 2 变体 × 2 模型 = 12 runs** 单次。

**为什么必须先有这个框架**：`annotation-table.md` 能论证「B8 Pipeline stages 是重复上下文」，但**论证不了「删掉它 Fable 的表现不会变差」**。重复 ≠ 无效——重复也可能起强化作用。这个「我不知道」正是铁律「无评测数据不动生产提示词」的来源，也是本框架要消除的东西。

---

## 1. 重放任务集（ground truth 已核实在仓）

| 任务 | 类型 | 重放起点 | ground truth | 主评法 |
|---|---|---|---|---|
| **T1** = FLY-1242 删除 dead `lead_pane_readiness` flag + 死代码路径 | 有界代码变更（7 文件，61+/280−） | `7f9f401b1^` | merge `7f9f401b1` 的真实 diff | **隐藏事后评估器**（flag grep-zero + 定向测试绿）+ 与真实 diff 对照 + rubric |
| **T2** = FLY-1245 design-phase Codex↔Fable kill-switch | 设计 | `c797a0d12^` | `engineering/doc/FLY-1245-codex-design-killswitch/plan.md`（Codex 4 轮 approved） | 盲评 rubric，对照真实 plan 的**关键决策点覆盖率** |
| **T3** = FLY-1246 QA PR #584 | QA | **历史 PR head `ed9823622`**（base `cfb27099d` 播种为 origin/main） | `engineering/doc/FLY-1246-qa-founder-image-approval/qa-report.md` | findings 查全/查准 + verdict 一致性 |

**T3 起点说明（Codex R2 #3）**：必须重放**历史 PR head `ed9823622`**，**不是**合并后的 squash commit `8bc3cfd99`——commit 身份/历史不同，用后者会撞 QA 自己的 head-freeze 检查。gh fixture = QA 证据记录的 OPEN/CLEAN/checks-passing **历史态**（数据已在仓，无需触真 GitHub）。T3 评的是**独立取证质量**，不是复述可见文档的能力。

**防污染核查**：三个起点 commit 均不含对应答案文档（docs 与 fix 同 commit 或后置 commit 合入）；任务均为 2026-07 完成，**晚于两模型 knowledge cutoff**。

**已知格子缺口（Codex R1 #8，如实声明）**：**pilot 里没有「真·小 bug fix」这一格。** 初稿选 FLY-1193，实测 `33be9ac6b` 达 15 文件 2354+/120−（含 472 行 sensor 重写 + 645 行测试）——不是小修复。本仓近期「fix」类 commit 普遍带重测试/证据行李（FLY-1239 code 部分 1167+、FLY-1236 802+、FLY-1234 3512+），30min 包络内没有真·小 bug fix 格子。故 T1 换为 FLY-1242（有界删除类）并如实标注类型；**该类型的覆盖缺口留实验室 #2**。

**保真度残差**：真实 runner 有 Lead 互动，重放用 stub 应答（见 §3）——差异记入报告 caveat。

---

## 2. 处理（treatment）与变体

### 2.1 六基线

T1–T3 × Claude/Codex 各自捕获**完整注入文本**（任务/phase/role/config/vendor 特异，全部输入字段与 env flag 记录进 manifest）。

### 2.2 B 臂构造（防稻草人）

对六基线施加**同一套块级变换**，**由 `annotation-table.md` 逐行推导**：

- 「砍候选」块 → 删除，或压成一句边界声明
- 「留」块 → **逐字保留**
- 每处删改在标注表**可追溯**（不许凭手感改）

得六份 B；12 份文本 + 哈希入库。**不设目标压缩率**——压缩率是结果不是目标，设了就会为凑数去砍契约。

### 2.3 处理范围声明（Codex R3 #7 — 关键边界）

> pilot **只变换捕获的 Blueprint 注入 Runner 块**。
> **持久合同、所选 role 文件、lead-rules、skills、全局面，在两臂间字节一致。**
> 这些表面的瘦身需**另立评测单获批**后才可实验。

**这条对本次审计的直接后果（诚实提示）**：`annotation-table.md` 的最大发现是「**层 B 角色文件约 1/3 可动**（23% 纯删候选 + 部分压缩）」，但角色文件**恰好在上述 pilot 的处理范围之外**（role 文件两臂字节一致）。

也就是说：**按当前范围跑 pilot，验证的是框架本身，验不到审计的主结论。** 两条路（执行单开跑前必须先定，不能默认漂移）：

- **(a) 保持范围**：pilot 只验框架（层 A 可动 <600 B，效应量大概率淹没在噪声里——**这本身就是有信息量的结果**：它会证明「Blueprint 层没什么可砍」）。
- **(b) 扩范围**：把 role 文件纳入处理面 → 需**另立评测单获批**（本文档不替它做决定）。

**推荐 (b)**，理由：审计已给出层 A 可动 <4% 的结构性结论，pilot 若只动层 A，等于花 12 runs 去测一个已知接近零的效应。**但这是 scope 变更，必须 Annie/Lead 拍板，不由执行 runner 自决。**

### 2.4 注入机制（必须与生产同构）

- **Claude 腿**：`claude -p --append-system-prompt-file`（与生产 `appendSystemPrompt` 同构）。
- **Codex 腿（Codex R1 #1 更正）**：生产 codex runner 是**两层**机制——
  1. 持久合同 `codex-runner-contract.md` 由 `packages/claude-runner/src/codex-home.ts:326-338,457-470` 物化进 per-run `$CODEX_HOME/AGENTS.md`；
  2. 动态 Blueprint prompt 由 `CodexTmuxAdapter.ts:379-391` 作为 systemLayer 与任务一起放进首个 turn。

  harness 必须**同构**：隔离 CODEX_HOME 按 `provisionCodexHome` **同形制备（含持久合同）** + 「基线 systemLayer + 分隔 + 任务」作 exec 输入，并与 `CodexTmuxAdapter.ts:379-391` 拼装做**字节/顺序 parity 断言**。
  **变体绝不写 worktree AGENTS.md**（会改指令优先级层、漏掉持久合同——初稿方案已废弃）。

---

## 3. 隔离（Codex R1 #3 / R2 #1 #2）

> 总原则：**零生产接触**。这不是洁癖——本机的 `~/.claude` / `~/.codex` / 生产 repo 是活的生产系统，评测跑崩它们的代价远超评测本身的价值。

### 3.1 git 隔离

- **per-run 一次性独立 clone**（源自 seed bare）。
- **绝不用 linked worktree**——共享 `.git/config` 会被 remote 改写污染主仓。
- remote **仅允许 file/local**，启动断言违规即 fail。
- 真实 GitHub 访问**只在交付步**，隔离环境之外。

### 3.2 claude 腿：零生产 hook 执行（硬要求）

live `~/.claude` 带 PreToolUse/PostToolUse/Stop/SessionEnd/PostCompact 生产 hooks，**MCP/env 隔离拦不住**。阶梯方案：

| 选项 | 做法 | 状态 |
|---|---|---|
| **S1a** | 净化版隔离 `CLAUDE_CONFIG_DIR`（FLY-572/670 配方：rsync + creds relocate，iso 内 hooks 置空、插件裁剪），实测 `-p` 是否仍崩 | 首选 |
| **S1b** | 默认 dir + `--settings` 净化覆盖 | 仅当 merge 语义实测**可禁 hooks** |
| **S1c** | iso dir + tmux 交互驱动（配方已证），指标从 transcript jsonl 抽取 | 兜底 |

**任何选项都要 hook 哨兵**：transcript **零 hook 事件** + 已知 hook 副作用路径快照前后无变化。
外加 `--strict-mcp-config` + 空 mcp-config + 显式 `--no-chrome` 开关。

### 3.3 codex 腿：零宿主变更（Codex R2 #2）

- run 内 **pin 单一账号**（active auth 复制进 iso CODEX_HOME），直接 `codex exec` **前台** + 硬 timeout + 进程树 kill 兜底。
- **不用 `codex-with-fallback`**——其轮转会改写宿主 `~/.codex/auth.json` 与 `profiles/.active`（违反零生产配置变更）。限流按失败政策记**模型失败**。
- 宿主 `auth.json` / `.active` 哈希**每 run 前后断言不变**。
- judge/review 等**隔离边界外**的调用照常走 `codex-with-fallback`（遵守机器铁律）。

### 3.4 env 卫生

白名单化，剥除 GH/Linear/Discord/Bridge token 与 `FLYWHEEL_*`；隔离 `GH_CONFIG_DIR`、`GIT_CONFIG_GLOBAL/SYSTEM`；禁 credential helper。

### 3.5 comm stub / gh shim

- **stub allowlist 由六基线 prompt + 所选 role 文件生成的命令 manifest 唯一确定**——真实动词（`gate review_design` / `review_code`、`declare-state park`、`await-codex-gate` 等）**以捕获为准，不手写清单**。
- 有状态确定性应答（approve/ship 给终态）。
- **未知命令大声失败**并记 infrastructure failure（不静默吞）。
- **绝对路径与裸 `flywheel-comm` 两个入口都要重写**。
- gh shim 用**每任务冻结 fixtures**（T3 用历史 OPEN 态）。

### 3.6 对抗性冒烟（隔离的证明，不是声明）

必须实证：真 gh 未认证 / 生产 comm 不可达 / credential helper 失效 / push 只落本地 bare / 生产 repo `.git/config` 与 remotes 无 diff / **零 hook 执行** / 宿主 `~/.codex` 无变化。

---

## 4. 指标（构念拆分，Codex R1 #6）

| 指标 | 口径 | 陷阱规避 |
|---|---|---|
| **质量** | 双盲评 rubric（**两位评审各评全部 12 份**，全集重叠 → 可算评审间一致性）+ 任务客观评估器 | 不用单评审交叉 |
| **轮数 / token** | **仅模型内比较**；token 分 input/output/cache | 跨模型比 token 无意义 |
| **插手** | `gate_compliance` / `discretionary_asks` / `simulated_human_decisions` **三独立字段，不相加** | 合并计数会把「守协议」和「烦人」混成一个数 |
| **findings** | 结构化（severity + ground-truth 证实） | 不用裸计数（裸计数奖励刷 finding） |

**真实成本模型（founder 定调）**：订阅 token 近零、Claude 配额按量。
→ **模型内 A/B 用原始 token；「省钱」结论必须用真实成本口径**（不能拿 token 数直接当钱说）。

---

## 5. 预注册（执行单在跑前冻结 `analysis-plan.md`；数值现已定死，Codex R2 #7）

> 预注册的意义：**跑完再定阈值 = 自欺**。以下数值在看到任何数据前就定死。

| 项 | 规则 |
|---|---|
| 格子质量值 | 两盲评**均值**；**实质分歧** = \|J1−J2\| ≥ 3 → **盲态仲裁分替代均值**（不是平均掉分歧） |
| 决策相关格子触发 | 成对质量差 (B−A) 绝对值 **≥ 2.0**（用上述聚合值）**或**客观评估器翻转 |
| 触发后 | 该格**恰好 +2 次重复** |
| 非劣界 | **B−A > −1.0**；恰等于 −1.0 记「未达非劣」→ **不确定**（不四舍五入成通过） |
| 失败政策 | infra failure → 修 harness 后同格重跑 1 次并**保留失败记录**；模型失败（超时/放弃）→ **保留为数据，不填零**；失败格子**不外推** |
| 对位 | A/B 在 task×model 内**交替对位**；每 run 全新 clone/CODEX_HOME |
| provenance | CLI/model/账号 profile/config 哈希入 manifest |
| **结论上限** | **n=1 → 方向性**。「强证据」**仅**来自客观不变量，或满足上述规则的重复格子 |

### 5.1 评审效度（Codex R3 #7）

> **两盲评一致只证信度，不证效度**（两个评审可以一致地错）。

对策：预注册**评审身份**与 **rubric 锚点**（锚到专家决策例）；加一小撮 **Lead/人工校准样本**；**有客观评估器的项，客观结果优先于评审分**。

### 5.2 重复格升级规则（Codex R4 #3，跑前冻结）

> 选择性加测的重复格（n=3，由首个观察到的效应触发）**默认仍以「方向性」为上限**。
> 升「强证据」**仅当**该格有确定性客观评估器背书，**或**另行独立 powered study。
> **不因为重复了就自动升级**——选择性加测本身带选择偏倚（我们只加测了看起来有效应的格子）。

### 5.3 M0 spikes

产出**能力矩阵**：S1（claude 隔离阶梯）、S2（codex parity）、S3（依赖安装）、S4（捕获）。

**fallback 仅当保住：同注入层 + 同工件 + 同指标 schema**；否则该腿 **infeasible**、**显式改 scope**（不偷偷降级）。

### 5.4 provenance

committed `manifest.json`：Blueprint SHA、agents/lead-rules 哈希、skills lock 快照、任务/变体/fixture/rubric 哈希、CLI 版本、config 快照、run 顺序。
结果行**引用哈希**；no-diff 门用 `git status --porcelain` **全量路径**校验（`git diff` 看不到 untracked——Codex R2 #5）。

---

## 6. 这个框架能回答什么 / 不能回答什么

| 能 | 不能 |
|---|---|
| 「删掉标注表的砍候选块，同任务同模型下产出质量是否非劣」（方向性，n=1） | 「瘦身在所有任务类型上都安全」（3 个格子，且缺真·小 bug fix 格） |
| 「隔离是否干净」（对抗性冒烟实证） | 「Lead 侧 lead-rules 瘦身如何」（Lead 不在重放范围，**证据不得混用**——Codex R1 #7） |
| 「rubric 有无区分度」（pilot 的首要目的） | 「skills body 的 SOP 是否压制判断力」（另一类实验，见 annotation-table §4） |
| 「客观不变量是否翻转」（强证据来源） | 「长会话下判断质量」（单任务重放测不到） |

**执行单开跑前必须先解决的一件事**：§2.3 的范围决策（(a) 保范围 vs (b) 纳入 role 文件）。**不解决就开跑 = 花 12 runs 测一个已知接近零的效应。**

---

## 7. 后续单建议（不在本轮）

| 单 | 内容 |
|---|---|
| **实验室 #2 — 执行单** | 落地本框架：M0 spikes → 12-run pilot → 分析。**先答 §2.3 范围决策** |
| **实验室 #3 — lead-rules** | dept 常驻 114KB（全系统单点最大常驻）。**评测方法与本框架不同**：要评长会话判断质量，不是单任务产出 |
| **实验室 #4 — skills 形状** | 同一 skill 的「SOP 版 vs 判断框架版」A/B。与 **task#16（de-AI writing skills 评估）方法论同源，建议合并** |
| **任务集补格** | 真·小 bug fix 格子（本仓近期 fix 均带重行李，需专门找或构造） |
