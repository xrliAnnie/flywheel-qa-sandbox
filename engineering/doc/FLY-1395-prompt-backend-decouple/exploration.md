# FLY-1395 Prompt/技能装配层 model-agnostic 化 — 探索

Issue: FLY-1395 (https://linear.app/geoforge3d/issue/FLY-1395/foundationgate-prompt技能装配层-model-agnostic-化-prompt-后端正交解耦batch-2-硬前置)
日期: 2026-07-20
基于: 无(上游事实基础 = engineering/doc/FLY-1356-skill-framework-mode-split/ 全套)

## 1. 问题(Annie 原话的工程翻译)

「模型是模型,prompt 是 prompt——两个 independent 的旋钮」。FLY-1356 把三臂
(A=superpowers / B=matt / C=bare)的**解析链**建完了:per-issue 哈希分桶、issue_id
sticky、override 线程传递、auto-QA 继承、双列归因落库——这条链本身已经是
后端无关的。但**装配生效**被一道硬门挡在 claude-tmux 内:

- `Blueprint.ts:896-901`:`backend !== "claude-tmux"` → via 覆写 `noop_backend`,装配零动作;
- `Blueprint.ts:940-947`:`skillModeActive` 要求 `backend === "claude-tmux"`,否则插件层
  (disabledPlugins/enabledPluginsExtra)与 prompt 变体(`.matt.md`/`.bare.md`)双双跳过;
- `Blueprint.ts:2186-2190`:codex runner 的 `readAgentFileWithSkillVariant(..., undefined)`
  永远读 baseline agent 文件。

结果:三段式流水线上(design=Claude / implement=Codex / qa=Claude,
`three-stage-phases.ts:183-189` 已写死为 Annie 说的固定模型配置),同一张单的
implement 阶段永远逃出实验臂——「prompt 用哪套」这个旋钮对 Codex 后端失灵。
本单 = 把装配层变成 per-backend 适配器,让臂对任何后端都生效。

## 2. 审计发现(全部实读代码 / 实跑命令,file:line 见 research.md)

### 2.1 已经是后端无关的(不用动)

- **臂解析**:`resolveSkillFrameworkMode`(config 包)是纯函数,输入里没有后端概念。
- **粘性与传递**:sticky-stamp 按 issue_id 查库(run-dispatcher)、override 走
  designBackend 同轨传 4 个 successor 位点、auto-QA 继承父臂——全部与后端正交。
  「同一张单 Claude 阶段与 Codex 阶段解析出同一个臂」**今天就成立**,缺的只是
  Codex 侧把臂变成真装载。
- **归因**:sessions 两列 + `adapter_type` 列已齐;评测 SQL 只需把 noop 过滤从
  「非 claude-tmux」缩到「agy/kimi」。

### 2.2 Codex 侧的装配面(本单主战场)

Codex runner = 常驻 `codex app-server` daemon(CodexTmuxAdapter),每个 execution
有**隔离 CODEX_HOME**(`~/.flywheel/codex-homes/<execId>`,codex-home.ts 提供
config.toml 渲染 + AGENTS.md 物化 + auth 播种)。两层装配面都存在:

- **prompt 层(近乎免费)**:agent 文件对 codex 走「翻译头 + 原文」
  (`Blueprint.ts:2192-2209`);`.matt.md`/`.bare.md` 变体是纯文本,对 codex 同样
  有意义——只需放开 `skillModeActive` 的后端硬门,变体选择即刻对 codex 生效。
- **skill 层(本单新增)**:Codex 0.144.6 有**原生 skill discovery**
  (SKILL.md 格式与 Claude 同构):
  - 发现根含 `$CODEX_HOME/skills`(codex 内嵌 skill 工具脚本
    `root = os.path.join(_codex_home(), "skills")` 铁证)与 `~/.agents/skills`
    (superpowers 官方 README.codex.md 写明,机器上 3 月起就有活 symlink);
  - **A 臂落点已存在**:`~/.codex/superpowers` = obra/superpowers 5.0.7 完整
    checkout(带 docs/README.codex.md 官方 Codex 移植指引),经
    `~/.agents/skills/superpowers` symlink 对全机 codex 可见——issue 说的
    「superpowers 的 Codex 移植版已存在」核实为真;
  - **B 臂原料在手**:vendor/matt-skills 的 SKILL.md(name+description frontmatter)
    就是 codex 认的格式;上游 mattpocock/skills 还带 per-skill `agents/openai.yaml`
    (codex skill 元数据,FLY-1356 vendor 时刻意没带——当时 B 臂只打 claude);
  - config 面:`[skills]` 顶层表 + `skills.config` 子结构**存在**
    (`--strict-config` oracle 实测:`skills={}`、`skills.config={}` 被接受;
    `skills.enabled`/`skills.paths`/`skills.roots`/`skills_root`/`agents_dir`
    全部显式拒绝——oracle 本身有阴性对照);app-server 协议有
    `skills.list`/`skills.read` RPC 与 `SkillsConfigWrite`/`SkillsExtraRootsSet`
    参数类型(二进制字符串证据)。

### 2.3 一个改变问题形状的未测事实

`~/.agents/skills` 是 **HOME 级、机器全局**的发现根,superpowers 就挂在那里。
Codex runner 的 daemon env 继承 HOME(只洗 secrets)。所以**今天的 codex runner
很可能已经看得到全套 superpowers skills**——即现状 codex 不是干净的 C(裸奔),
而是「不受控、未归因的 A-ish」。`via=noop_backend` 的字面语义(机制 no-op)
掩盖了实际暴露。这既是本单要治的病,也是 research 阶段必须实测钉死的第一块
基石(spike:隔离 CODEX_HOME 的 daemon 到底 discover 到什么)。

## 3. 方向(与被否方案)

### 选定方向:装配适配器 = 「每后端用自己的机制实现同一个臂概念」

一句话架构:**臂解析保持现状(已后端无关);Blueprint 的「装配 apply」从
claude-only 硬门改为 per-backend capability;Codex 的装配落在它已有的
per-runner CODEX_HOME 供给时刻**。

- **claude-tmux**:现状字节不变(插件 merge + 变体),只是搬进接口形状。
- **codex-tmux(本单新增)**:
  - prompt 层:放开变体选择(A 读 baseline,B/C 读各自变体,缺则回落 baseline
    ——与 claude 同语义);
  - skill 层:provisionCodexHome 按臂物化 `$CODEX_HOME/skills`
    (A:superpowers 可见;B:matt 可见 + superpowers 不可见;C:全不可见);
    「对单个 runner 隐藏机器全局 superpowers」的精确机制 = research 唯一硬 spike
    (候选:per-runner config.toml 的 skills.config 逐 skill disable /
    发现根语义实测;若最终证明藏不住,按 1356 红线诚实回落 + 归因记录,
    绝不静默跑残缺臂);
  - via:codex 记真实 via(hash/sticky/override/inherited),不再 `noop_backend`。
- **agy/kimi**:仍 no-op,但从「散落 if」变成接口上显式的 no-op 实现——
  后续接入零改造(接口即交付物之一)。

### 被否方案

1. **改机器全局状态**(spawn 前摘/挂 `~/.agents/skills/superpowers` symlink):
   并发 runner 互相踩、影响 Lead 与 Annie 本人的 codex——直接违反「后端自由、
   互不约束」。否。
2. **HOME env 覆写**隔离发现根:波及 git/gh/一切子进程的 HOME 语义,半径失控。否。
3. **把 skills 塞进 kick-turn prompt 文本**(只做 prompt 层不做 skill 层):
   B 臂在 codex 上就不是「装配 matt」而是「粘贴 matt 全文」,与 Claude 侧臂定义
   不同构,评测臂间对比失效。作为 skill 层机制不可行时的降级候选保留,但必须
   归因区分,不冒充同一臂。

## 4. 实验设计简化(issue scope 第 3 条)

- 固定模型配置**已经是 shipped 现实**:`DEFAULT_PHASE_DISPATCH` = design(claude/
  Fable)/ implement(codex/gpt-5.6-sol)/ qa(claude/Opus),对所有臂一致 ⇒
  模型是常量,臂间直接对比有效,无需分层。本单在 runbook/评测文档落一行诚实
  脚注:结论 conditional on 这套配置,配置变更时抽查复验。
- 四观测量(完成率/token/纪律违规/返工轮数)按臂直接 GROUP BY 的口径修订:
  codex 行不再被 `noop_backend` 排除。

## 5. 验收对照(issue 4 条 → 机制)

| 验收 | 机制 |
|---|---|
| 1. Codex runner 按臂获得对应装载 + 真进程级证据 | per-runner CODEX_HOME 的 skills 物化内容 + rendered config.toml + daemon `skills.list`(或会话 "## Skills" 上下文)——等价于 Claude 侧 argv 铁证 |
| 2. 同一张单跨后端同臂 | 解析链现状(sticky by issue_id)+ 本单让 codex 真装配;E2E 取证:一张单 design(claude)与 implement(codex)两 session 的臂装载证据并排 |
| 3. 四观测量按臂直接分组 | runbook SQL 修订(noop 过滤缩窄)+ 固定模型脚注 |
| 4. 两个旋钮互不干扰 | 臂解析零后端输入;后端选择零臂输入;任何 runner 都参与(agy/kimi 显式 no-op 是唯一诚实例外,归因可见) |

## 6. 开放问题(research 阶段收口)

1. **[硬 spike] per-runner 隐藏 superpowers 的精确机制**:`skills.config` 条目形态
   (按什么 key、`enabled=false` 是否生效)、隔离 CODEX_HOME daemon 的真实
   discovery 集合(`~/.agents/skills` 是否被扫)。真机实测,阳性对照 = 默认
   config 下 superpowers 可见。
2. **B 臂 codex 化的完整度**:matt SKILL.md 直接被 codex 认到什么程度;
   `agents/openai.yaml` 是否必需(预判:可选元数据);要不要补 vendor。
   若不可行 → 如实报(issue 明示允许)。
3. **变体文件对 codex 的语义核对**:`.matt.md`/`.bare.md` 里的 Claude 语汇
   (插件名/Skill 工具)经现有翻译头是否足够,或变体需要 codex 注记。
4. **证据采集的落点**:装配结果是否入 envelope/sessions(如
   `skill_assembly_evidence`)或只进 QA 脚本——倾向最小:归因列不动,证据走
   QA 脚本 + 供给日志。
5. 三段式 QA 阶段自选 claude 后端(不继承 implement 后端)——臂继承(inherited)
   与后端自选的正交性已由 1356 保证,确认无需新动作。

## 7. 明确不在本单

评分 rubric(FLY-1260/1299)、第二刀 prompt 清理(FLY-1299)、赢家拍板(Annie)、
agy/kimi 的真实装配实现(仅接口 no-op 落位)、Lead session 的技能处置。
