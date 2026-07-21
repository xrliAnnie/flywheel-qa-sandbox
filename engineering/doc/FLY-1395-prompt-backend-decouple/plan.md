# FLY-1395 Prompt/技能装配层 model-agnostic 化 — 实施计划

Issue: FLY-1395 (https://linear.app/geoforge3d/issue/FLY-1395/foundationgate-prompt技能装配层-model-agnostic-化-prompt-后端正交解耦batch-2-硬前置)
日期: 2026-07-20
基于: research.md

> **For agentic workers:** 按 task 顺序 TDD 执行(RED → GREEN → commit),
> implement 阶段(Codex 后端)在本分支 `flywheel-FLY-1395` 继续。
> 流程注记:**Codex design review 整体豁免(Annie 2026-07-20 直令,Tadashi
> brainstorm gate 传达)**——本 plan 的设计审 = Tadashi recite 符合性核验;
> **code review 硬门不变,照跑**。
> 所有 codex CLI 行为结论 pin 在 **codex-cli 0.144.6**(research.md S1-S3 真机实证)。

**Goal:** 技能/prompt 装配(A=superpowers / B=matt / C=bare)成为后端无关的第一维度:
codex-tmux runner 按臂获得真实装载(首个新增后端);装配能力做成显式可插的
per-backend 映射(agy/kimi 显式 no-op,后续接入零 Blueprint 改造);默认 flag 下
字节兼容;任何装配疑义 fail-closed 回 A + 诚实归因。

**Architecture(一句话):** 臂解析链(1356,已后端无关)不动;Blueprint 的装配
apply 从 `backend==="claude-tmux"` 硬门改为查 `BACKEND_SKILL_ASSEMBLY` 能力表;
codex 的装配落在已有 per-runner CODEX_HOME 供给时刻——`[[skills.config]]`
逐名 disable(B/C)+ vendor matt-skills 复制(B),prompt 变体选择对
claude/codex 统一放开。

**红线(1356 三条红线全继承 + 一条新增):**
1. 默认 flag(`superpowers`)下**字节兼容**:claude spawn args / codex CODEX_HOME
   渲染产物 / envelope 均不变——哨兵测试钉死 + 突变验证;
2. 实验臂只在确定授权时进入:任何疑义(扫描失败 / vendor 缺失 / 非法值)
   一律回落 A + via 诚实记录,绝不静默跑残缺臂;
3. 评测期 generalized-workflow 模板 flag 保持 OFF(纪律,runbook 已载);
4. **新增:机器全局状态零触碰**——所有装配动作只落在 per-runner CODEX_HOME,
   绝不写 `~/.agents/skills` / `~/.codex` /  settings(被否方案 1/2 的机制化排除)。

---

## 0. 模式语义总表修订(相对 1356 plan §0 的 delta)

1356 §0 的解析优先级表**逐行不变**,唯一改动是「backend 正交标记」行与生效面:

| 项 | 1356(现状) | 本单(目标) |
|---|---|---|
| via=`noop_backend` 的范围 | backend ≠ claude-tmux 全部 | **仅 `BACKEND_SKILL_ASSEMBLY[backend]==="none"`**(agy/kimi);codex-tmux 走完整解析,记真实 via |
| codex 的 readiness 探针 | 无(不装配) | B/C 臂:superpowers 扫描(见 Task 3)+ B 臂加 vendor matt 探针;失败 → `fallback_superpowers`(语义复用,不新增 via 枚举值) |
| prompt 变体 | 仅 claude-tmux | claude-tmux + codex-tmux(能力表 `"native"` 的后端) |
| 插件层(--settings) | 仅 claude-tmux | 不变(claude 专属机制,字节不动) |
| codex skill 层 | 无 | B/C:config.toml `[[skills.config]]` 逐名 disable;B:`$CODEX_HOME/skills/matt-skills:<name>/` 复制并命名空间化 vendor 6 skill;A:**零动作**(哨兵) |

各臂在 codex-tmux 上的生效面(research S1-S3 实证机制):

| mode | CODEX_HOME config.toml | $CODEX_HOME/skills | prompt 层 |
|---|---|---|---|
| `superpowers` | 零追加(= 现状字节) | 不创建(= 现状) | 基准 agent 文件 |
| `matt` | append superpowers 全量 disable 块 | `matt-skills:<name>/` = vendor 6 skill 的命名空间副本 | `<agent-file>.matt.md`,缺则回落基准 |
| `bare` | append superpowers 全量 disable 块 | 不创建 | `<agent-file>.bare.md`,缺则回落基准 |

- disable 块形态(S2/S3 实证):`[[skills.config]]\nname = "superpowers:<skill>"\nenabled = false`;
  key = 全限定名 `namespace:skill`,namespace = `~/.agents/skills` 下一级目录名。
- **disable 名单动态生成**(research §4.3):扫 `~/.agents/skills/superpowers/*/`
  子目录,每个生成两条候选名(目录名 + SKILL.md frontmatter `name`,不同才双发;
  disable 不存在的名字无害,S2 实证 no-op)——上游加新 skill 自动覆盖。
- 扫描语义:**ENOENT(目录不存在)= 合法空名单**(机器上没装 superpowers ⇒
  C 天然成立,同时 console.warn A 臂降级的机器状态问题);**其它 fs 错误 =
  疑义 → fail-closed 回 A + `fallback_superpowers`**。
- flywheel-skills 同步的通用技能(notion 等)三臂保留——与 Claude 侧 C 臂只拔
  superpowers 插件同构,臂定义 = 框架 delta(research R4);codex bundled
  技能(imagegen 等)三臂同在 = 常量(research R7)。

## File Map

| 动作 | 文件 | 职责 |
|------|------|------|
| Modify | `packages/config/src/skill-framework-mode.ts` | 新增 `BACKEND_SKILL_ASSEMBLY: Record<ExecutorBackend,"native"\|"none">`(claude-tmux/codex-tmux=native,agy/kimi=none)+ `SUPERPOWERS_CODEX_NAMESPACE="superpowers"` + `defaultAgentsSkillsDir()`(`~/.agents/skills`,可注入覆盖) |
| Modify | `packages/config/src/__tests__/skill-framework-mode.test.ts` | 能力表覆盖全部 EXECUTOR_BACKENDS(新后端加入时测试红,强制显式声明) |
| Modify | `packages/edge-worker/src/Blueprint.ts` | ① via 门改查能力表(:896-901);② codex B/C 探针+扫描(pre-envelope,ponytail 同位);③ `skillModeActive` 拆分为插件门(claude 专属)与变体门(native 后端);④ ctx 新字段线程到 adapter;⑤ 翻译头 skill 句修订(:2201) |
| Modify | `packages/edge-worker/src/__tests__/Blueprint.*.test.ts` | codex 三臂 via/ctx/变体断言 + 哨兵(见 Task 7) |
| Modify | `packages/claude-runner/src/types.ts`(ExecutionContext) | 可选字段:`skillFrameworkMode?`、`codexSkillDisableNames?: string[]`、`codexMattSkillsSourceDir?: string` |
| Modify | `packages/claude-runner/src/CodexTmuxAdapter.ts` | `provisionCodexHome` 调用点(:399-402)透传三字段 |
| Modify | `packages/claude-runner/src/codex-home.ts` | `renderCodexHomeConfig` 接受 disable 名单 append 块(base 已有 `[skills]` 段则 fail-loud,`shell_environment_policy` 同款);`provisionCodexHome` B 臂复制 vendor skills(幂等,复制非 symlink——research R3 定死) |
| Modify | `packages/claude-runner/test/codex-home.test.ts` | 渲染/复制/fail-loud/A 臂零 delta 字节断言 |
| Create | `scripts/qa-fly-1395-codex-mode-visibility.sh` | 真机 QA(S1-S3 产品化,见 Task 8) |
| Modify | `engineering/doc/FLY-1356-skill-framework-mode-split/runbook.md` | noop 过滤缩窄 + codex 前置 + 固定模型脚注(Task 9) |

不动:`resolveSkillFrameworkMode` 解析器、sticky/override/inherited 传递轨、
StateStore schema(零新列)、event-route/DirectEventSink、TmuxAdapter(claude)、
agent 基准文件与 `.matt/.bare` 变体文件(1356 已建,S4 核对过 codex 直接可用)、
flag 注册表与 direct-toggle(控制面 1356 已完备)。

---

## Tasks

### Task 1 — config 包:后端装配能力表

- `BACKEND_SKILL_ASSEMBLY` 常量 + `SUPERPOWERS_CODEX_NAMESPACE` +
  `defaultAgentsSkillsDir()`;导出经 index.ts。
- TDD:能力表 key 集合 === `EXECUTOR_BACKENDS`(新后端未声明即红);
  claude/codex=native、agy/kimi=none。

### Task 2 — Blueprint via 门改造(拆 noop_backend 硬门)

- `Blueprint.ts:896-901`:`backend !== "claude-tmux"` → 
  `BACKEND_SKILL_ASSEMBLY[backend] === "none"` 时才覆写 `noop_backend`;
  codex-tmux 落入正常解析流。
- TDD:agy/kimi 仍 noop_backend;codex hash/sticky/override/inherited 四条 via
  与 claude 同值(现有 fixture 换 backend 参数化)。

### Task 3 — Blueprint codex 探针 + 扫描(pre-envelope)

- 位置 = matt readiness 探针同段(claude 探针旁,envelope 之前;负结果不缓存)。
- codex-tmux 且解析 mode ∈ {matt, bare} 时:
  1. 扫 `agentsSkillsDir/superpowers/*/`(注入的目录读取器,默认
     `defaultAgentsSkillsDir()`,测试注入桩)→ 生成 disable 名单
     (目录名 + frontmatter name 双发,§0 语义:ENOENT=空名单+warn,
     其它错误=回落 A + `fallback_superpowers` + console.warn);
  2. mode=matt 额外探 vendor:`<flywheelRoot>/vendor/matt-skills/skills` 下
     6 个 SKILL.md 齐全,缺 → 回落 A + `fallback_superpowers`(claude 侧 matt
     插件探针失败同构);
  3. 通过 → ctx 挂 `codexSkillDisableNames` + (matt) `codexMattSkillsSourceDir`
     + `skillFrameworkMode`;envelope 记录探针后的实际生效值(1356 同语义)。
- 扫描只做一次,via 记录与 adapter apply 用同一份名单(无 TOCTOU)。
- TDD:B/C 名单生成(含 frontmatter≠目录名 双发)、ENOENT 空名单、fs 错误回落、
  vendor 缺失回落、A 臂零字段。

### Task 4 — prompt 变体门放开 + 翻译头修订

- `skillModeActive`(:940-947)拆两个谓词:
  `claudePluginAssembly`(= claude-tmux && mode≠superpowers,插件数组沿用)与
  `variantAssembly`(= 能力表 native && mode≠superpowers);
  `readAgentFileWithSkillVariant(..., variantAssembly ? mode : undefined)`。
- 翻译头(:2201)skill 句改为:「role 文本引用的 skill / slash-command /
  Superpowers 流程:若同名或对应 skill 出现在你的 Available skills 目录里,
  直接原生使用;没有的,按相同步骤手动执行」——三臂 + 未装配场景一句话全覆盖。
  这是**默认模式下有意的 prompt 文本变更**(修正 S1 证伪的「no Skill tool」
  错误陈述),独立断言,不混进哨兵(哨兵范围见 Task 7)。
- TDD:codex+matt 读 `.matt.md` 变体、codex+bare 读 `.bare.md`、缺变体回落基准、
  claude 路径回归全绿;翻译头新文案断言(codex),claude 无翻译头不变。

### Task 5 — ExecutionContext + CodexTmuxAdapter 透传

- types 加三个可选字段(File Map);`CodexTmuxAdapter.execute` 把 ctx 三字段
  透传 `provisionCodexHome`;字段 absent 时调用形状与现状**逐字段一致**(哨兵)。
- TDD:透传断言(现有 adapter 测试基建);absent = 现状调用。

### Task 6 — codex-home:渲染 + 物化

- `renderCodexHomeConfig(baseToml, ghToken, opts?)`:`opts.skillDisableNames`
  非空时 append flywheel 管理注释头 + `[[skills.config]]` 块;base 含 `[skills]`
  段 fail-loud(`shell_environment_policy` 同款先例 :379-390)。
- `provisionCodexHome`:mode=matt 时把 `codexMattSkillsSourceDir` 下 6 个
  skill 目录**复制**进 `$CODEX_HOME/skills/matt-skills:<name>/`,并在副本中把
  frontmatter name 改为相同的全限定名(幂等重跑 diff 空;
  复制非 symlink,research R3——worktree 清理不悬空);复制失败 fail-loud
  (供给失败 = spawn 失败,与现有 provision 错误同路径,不产生静默臂降级
  ——via 已在 Task 3 记录,apply 层只许成功或响亮失败)。
- TDD:disable 块渲染字节断言;fail-loud;matt 复制幂等;
  **A 臂(opts absent)渲染输出与改动前逐字节一致**。

### Task 7 — 反向兼容哨兵 + 全套回归

- 哨兵(1356 Task 9 同款,独立文件):默认 env 下——claude spawn args /
  codex 的 provisionCodexHome 入参与渲染产物 / envelope 字段集 / agent 文件
  选择,与改动前逐字段一致;**突变验证**(设 split + codex → 哨兵能红)。
  翻译头文本变更在哨兵**显式白名单**注记(有意变更,Task 4 独立断言盯)。
- `pnpm lint` + `pnpm -r build` + 全仓测试绿(注意 QA env 污染坑:
  `FLYWHEEL_RUNNER_BACKEND` 残留会假红 teamlead 套件——memory 有案)。

### Task 8 — 真机 QA 脚本(research S1-S3 产品化)

`scripts/qa-fly-1395-codex-mode-visibility.sh`(隔离 CODEX_HOME,零全局污染):
1. 阳性对照:A 臂供给(零追加)→ 行为问答断言 superpowers **可见**;
2. C 臂:渲染含 disable 块(静态断言)+ 行为问答 superpowers **不可见**;
3. B 臂:上 + matt-skills:* **可见**(6 名逐一);
4. 打印 per-runner CODEX_HOME 的 config.toml 追加段 + skills 目录 listing
   (= 进程级铁证,等价 claude argv);
5. oracle 步骤:`--strict-config -c 'skills.config=[]'` 探针(codex 升级导致
   语义漂移即红,research R1)。
- 验收级 E2E(529 房,implement 段执行):同一 issue 强臂 override →
  design(claude)与 implement(codex)两 session 的 sessions 行同臂 +
  各自装配证据并排 = 验收 2「prompt ⊥ 后端」实证。

### Task 9 — runbook 修订(1356 runbook.md 就地改)

- §5 归因 SQL:`noop_backend` 过滤语义改为「agy/kimi(transport=none)」,
  codex 行计入臂分组;补 `adapter_type` 分层示例保留。
- §0 前置加一行:codex 参臂前置 = `~/.agents/skills/superpowers` 存在
  (A 臂机器前提,qa-fly-1395 脚本步骤 1 即验)。
- 评测口径加固定模型脚注(issue scope 3):四观测量臂间直接对比 conditional on
  `DEFAULT_PHASE_DISPATCH`(design=Fable / implement=gpt-5.6-sol / qa=Opus)
  固定配置;配置变更时抽查复验。
- 已知边界更新:「非 claude-tmux 机制 no-op」改为「agy/kimi 机制 no-op;
  codex 全臂生效(FLY-1395)」。

---

## 验收标准(implement 段完成定义,对照 issue 4 条)

1. **Codex 按臂装载 + 进程级证据**:qa 脚本 1-5 全 PASS(A 可见 / B matt 可见
   superpowers 不可见 / C 全不可见;config.toml + skills 目录铁证)。
2. **同单跨后端同臂**:529 房一张单 design(claude)+implement(codex)同臂,
   sessions 两行 mode 一致、via ∈ {override, sticky},装配证据并排留档。
3. **四观测量可采**:codex 行进入臂分组 SQL(runbook §5 修订后口径)真跑通。
4. **意图级**:默认 env 哨兵绿(两个旋钮互不干扰的机制保证)+ agy/kimi
   noop 归因不变。
5. Codex code review APPROVED(硬门,不豁免);独立 QA PASS。

## 排程与依赖

- 上游:FLY-1356 已 merge(#654)——本单直接建立其上,无 rebase 风险项。
- 下游:**本单 Done 前 Batch 2(1392/1385/1393)不开工**(issue 排期拍板)。
- implement 后端 = Codex(现阶段安排,三段式 implement 相位天然如此)。

## Ship 前置清单

- **design review = Tadashi recite 核验**(Codex design review 已由 Annie
  2026-07-20 整体豁免;本条即豁免的书面痕迹);
- Codex **code** review 照跑(APPROVED 才可请 ship);
- 四观测量数据呈 Annie;任何默认模式切换(含开 split)只认她明示(1356 继承);
- merge 后默认行为零变化(flag 默认 superpowers,哨兵为证)。

## Out of scope(明确不做)

- 评分 rubric(FLY-1260/1299)、第二刀 prompt 清理(FLY-1299)、赢家拍板(Annie);
- agy/kimi 的真实装配(本单只落能力表显式 no-op);
- Lead session 技能处置;EdgeWorker 休眠 webhook 通道(1356 R1#6 边界继承);
- app-server `skills.list` RPC 集成(QA 用行为问答足够,最小化);
- vendor matt-skills 的 `agents/openai.yaml` 补录(S3 实证不需要)。

## 风险登记(research.md §5 全量继承)

R1 codex 版本漂移(QA oracle 步骤钉)· R2 扫描 TOCTOU(毫秒级,接受)·
R3 vendor 悬空(复制而非 symlink,已消除)· R4 通用技能三臂保留(口径,runbook)·
R5 A 臂机器前提(runbook 前置 + QA 断言)· R6 混合 flag 供给失败(fail-closed 回 A)·
R7 bundled skills 常量(runbook 注记)。
