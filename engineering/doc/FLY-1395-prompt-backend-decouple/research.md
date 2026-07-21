# FLY-1395 Prompt/技能装配层 model-agnostic 化 — 调研

Issue: FLY-1395 (https://linear.app/geoforge3d/issue/FLY-1395/foundationgate-prompt技能装配层-model-agnostic-化-prompt-后端正交解耦batch-2-硬前置)
日期: 2026-07-20
基于: exploration.md

> 全部条目为本 session 实读代码 / 实跑命令所得。真机 spike 全部带阳性对照;
> spike 工作目录 = 本 session scratchpad `spike1/`(codex-home 模拟 + config.toml 留档)。
> Codex CLI 版本:**0.144.6**(所有 spike 结论 pin 在此版本;升级时 QA 脚本复跑)。

## 1. 真机 spike(本设计的机制基石,全部已实证)

### S1. Codex skill discovery 的发现根 + 「不受控 A」实证

方法:模拟 codex-home.ts 的 per-runner 供给(隔离 CODEX_HOME = config.toml 播种自
`~/.codex/config.toml` + auth.json,**无** skills 目录),问 codex 它的
"### Available skills" 会话上下文列了什么;阳性对照 = 默认 CODEX_HOME。

| 组 | 结果 |
|---|---|
| 对照(默认 `~/.codex`) | 全量列表,含 `superpowers` + `superpowers:*` 全套 + `~/.codex/skills` 本地技能(doc/figma/github:* 等) |
| 处理(隔离 CODEX_HOME,无 skills 目录) | `~/.codex/skills` 来源的技能**消失**;但 `superpowers:brainstorming` 等 **14 个 superpowers skill 全在**,`~/.agents/skills` 同步的 flywheel skills 也全在 |

⇒ 两个发现根实证:**`$CODEX_HOME/skills`**(per-runner 可控)+
**`~/.agents/skills`**(HOME 级机器全局,**不随 CODEX_HOME 隔离**)。
⇒ **今天的生产 codex runner 全部看得到全套 superpowers** ——「不受控的 A」
从推测升级为进程级实证。`via=noop_backend` 的字面语义掩盖了这个暴露。

### S2. per-runner 隐藏机制 = config.toml `[[skills.config]]`(name 键)

探针链(`--strict-config` 做 oracle,未识别字段显式报错 = 阴性对照内建):

1. `skills.enabled` / `skills.paths` / `skills.roots` / `skills.extra_roots` /
   `skills_root` / `agents_dir` → 全部 `unknown configuration field` **拒绝**;
2. `skills={}`、`skills.config=[]` → 接受 ⇒ 顶层 `[skills]` 表存在;
3. `skills.config={}` / `skills.config."x".enabled=false`(map 形)→ `invalid type: map, expected a
   sequence` ⇒ **`skills.config` 是数组**;
4. 数组元素 `{path=..., enabled=false}`(skill 目录绝对路径 / symlink 解析后
   真实路径两种)→ 解析通过但**不生效**(skill 仍在列表);
5. 二进制内嵌 app-server 类型 `SkillsConfigWriteParams = { name, enabled }`
   ⇒ 改试 **name 键**;
6. `{name="brainstorming"}` → 不生效;`{name="superpowers:brainstorming"}` →
   **生效**(listing 消失)。**key = 全限定名 `namespace:skill`**,namespace =
   发现根下一级目录名。

### S3. B 臂端到端(matt 可见 + superpowers 隐藏)——`-c` 与 config.toml 文件双形态

- 实现期复验发现:`$CODEX_HOME/skills/matt-skills` 的嵌套目录或 symlink 会加载
  六项技能,但名称被扁平化为 `tdd` / `grilling` 等;把每项作为直接子目录复制并
  将副本 frontmatter name 命名空间化后,codex 发现为
  **`matt-skills:tdd` / `matt-skills:grilling` / `matt-skills:to-spec` /
  `matt-skills:to-tickets` / `matt-skills:diagnosing-bugs`**(+code-review),
  **不需要** 上游的 `agents/openai.yaml`(SKILL.md name+description frontmatter 足够);
- 14 条 `superpowers:*` disable + Matt 命名空间副本同时生效:`SUPERPOWERS: no` +
  `MATT: yes`;
- **文件形态等效性**:把 14 个 `[[skills.config]]` 块直接 append 进隔离
  CODEX_HOME 的 config.toml(不用 `-c`),同样 `SUPERPOWERS: no / MATT: yes`
  ——这正是 codex-home.ts `renderCodexHomeConfig` 能落的形态,B/C 机制在
  runner 真实配置面端到端跑通。

### S4. 变体文件语汇核对

`agents/generic-executor.matt.md:112-115` 引用的名字(`matt-skills:grilling` /
`matt-skills:to-spec` / `matt-skills:to-tickets` / `matt-skills:tdd` /
`matt-skills:code-review`)与 S3 里 codex 实际发现的全限定名**逐字一致**
——变体文本对 codex 直接可用。唯一冲突:现有 codex 翻译头
(`Blueprint.ts:2192-2209`)写死「你没有 Skill tool——同样步骤手动做」,
装配后这句对 codex 是**错的**(codex 原生会用 skill),需要 mode-aware 修订。

## 2. 量化(Tadashi gate 补充①:暴露对数据有效性的影响)

生产 `~/.flywheel/teamlead.db` 实查(2026-07-20):

- `adapter_type='codex-tmux'` session:**158 全期 / 152 最近 7 天**——按 S1,
  全部处于不受控 superpowers 暴露下运行;
- `skill_framework_mode IS NOT NULL` 的行:**仅 1 条**(claude-tmux / matt / hash,
  1356 QA 产物)⇒ split 未开,**存量数据没有被臂污染**(没有任何 codex 行
  声称过自己属于某臂);
- 影响是**前瞻性的**:Batch 2 一旦开 split,codex(implement)阶段若不封住
  暴露,B/C 臂在 codex 侧就是假的(C 臂 runner 实际带全套 superpowers)。
  今晚 1356 E2E 的三臂样本全在 claude 侧,不受影响。

## 3. 现有 seam map(实读代码,file:line)

### 3.1 装配硬门(本单要拆的)

| Seam | 位置 | 事实 |
|---|---|---|
| via 覆写 | `Blueprint.ts:896-901` | `backend !== "claude-tmux"` → `via="noop_backend"`,mode 照记 |
| 装配总开关 | `Blueprint.ts:940-947` | `skillModeActive = backend==="claude-tmux" && mode!=="superpowers"`;插件增删两数组由它派生 |
| prompt 变体 | `Blueprint.ts:2186-2190` + `:2621-2632` | `readAgentFileWithSkillVariant(..., skillModeActive ? mode : undefined)` ⇒ codex 恒读 baseline;变体选择本身(试 `.{mode}.md` 缺则回落)是纯文本逻辑,天然后端无关 |
| codex 翻译头 | `Blueprint.ts:2192-2209` | `isCodexRunner`(`ctx.runnerBackend==="codex-tmux"`,`:932`)→ 固定翻译规则,含「no Skill tool」句(S4 冲突点) |
| 插件 merge | `Blueprint.ts:2298-2321` | claude 专属 `--settings` 通道(1356 现状,不动) |

### 3.2 Codex runner 供给链(装配的落点)

| Seam | 位置 | 事实 |
|---|---|---|
| adapter | `CodexTmuxAdapter.ts:200-268, 478-494` | 常驻 `codex app-server --remote-control` daemon;`provisionCodexHome({executionId, ghToken})` 调用点 `:399-402` |
| CODEX_HOME 供给 | `codex-home.ts:230-243, 446-472` | per-exec `~/.flywheel/codex-homes/<execId>`;`renderCodexHomeConfig(baseToml, ghToken)`(`:367-393`)= 全局 config.toml 逐字 + flywheel 管理块(`[shell_environment_policy.set]`),**base 已声明同名段则 fail-loud**——skills 注入照抄此模式(base 今无 `[skills]` 段,出现则 fail-loud) |
| AGENTS.md | `codex-home.ts:457-470` | codex-runner-contract.md 物化;daemon 每进程读 |
| env | `CodexTmuxAdapter.ts:1390-1441` + `codex-daemon-runtime.ts:457-485` | env 洗 secrets 但**继承 HOME** ⇒ `~/.agents/skills` 对 daemon 可见(S1 的机制解释);`CODEX_HOME` 由 spawnCodexDaemon 注入 |
| prompt 通道 | `Blueprint.ts:2229-2281` + `codex-daemon-adapter-helpers.ts:56-62` | 翻译头+role 文件进 appendSystemPrompt → kick-turn;`/goal` 只带 issueId+label |

### 3.3 臂解析链(已后端无关,不动)

- 解析:`resolveSkillFrameworkMode`(`packages/config/src/skill-framework-mode.ts`)
  纯函数,无后端输入;
- sticky:run-dispatcher 按 issue_id 查库(`run-dispatcher.ts:481/494`,读失败
  fail-closed 回 A);
- override 传递:designBackend 同轨 4 个 successor 位点
  (`phase-orchestrator.ts:682-685 / 1467-1470 / 1677-1680 / 2107-2110`,
  gated on `via==="override"`)+ DAG 引擎第 5 位点
  (`workflow-engine-dispatcher.ts:464-465`);auto-QA 继承父臂;
- 归因:sessions `skill_framework_mode`/`skill_framework_mode_via` 两列 +
  `adapter_type` 列(`StateStore.ts:1401`,写入 `DirectEventSink.ts:244/260` +
  `event-route.ts:892/929`)。

### 3.4 三段式固定模型配置(实验常量,已 shipped)

`three-stage-phases.ts:183-189` `DEFAULT_PHASE_DISPATCH`:
design=claude/Fable(heavy)、implement=codex/gpt-5.6-sol(xhigh)、qa=claude/Opus
——正是 Annie 说的固定配置,对所有臂一致;phase 表无条件压过 difficulty-sorter
(FLY-887 R2,`three-stage-policy.ts:213-221`)。QA 阶段**自选** claude 后端不继承
implement 后端(`resolvePhaseDispatch("qa")` fresh + `ignoreRunnerLabelSelection`,
`run-dispatcher.ts:229-235`)——与臂继承(inherited)正交,无需新动作。
kill-switch:`FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=0` / `..._CODEX_DESIGN=1`。

### 3.5 后端注册表

`ExecutorBackend`(`types.ts:582-593`)= claude-tmux / codex-tmux /
antigravity-tmux / kimi-tmux;`EXECUTOR_TO_TRANSPORT`
(`role-adapter-resolver.ts:49-56`);agy/kimi transport=none。

## 4. 设计选型确认(基于以上证据)

1. **装配收口仍在 Blueprint**(1356 同位):mode 解析后,装配动作按
   `ctx.runnerBackend` 分派——claude 走现有插件 merge(字节不变),codex 把
   mode 传进 adapter ctx,由 provisionCodexHome 落地;变体选择的后端硬门放开
   (变体机制本身纯文本,对 codex 直接有效)。
2. **Codex 装配 = CODEX_HOME 供给时刻的两笔**:
   - `renderCodexHomeConfig` 追加 flywheel 管理的 `[[skills.config]]` disable 块
     (B/C 臂;A 臂零追加 = 字节兼容);
   - `provisionCodexHome` 在 B 臂把六项 vendor skill 复制为
     `$CODEX_HOME/skills/matt-skills:<name>/`,并只在 per-runner 副本中把
     frontmatter name 命名空间化。
3. **denylist 动态生成,不 hardcode 14 个名字**:供给时扫
   `~/.agents/skills/superpowers/*/SKILL.md`(目录名 = skill name,namespace 固定
   `superpowers`)生成 disable 列表——上游加新 skill 自动被扫到;根目录 ENOENT
   = 空名单 + warn(没有暴露项可禁),其它扫描失败 = 疑义 → **fail-closed 回落 A
   + via=`fallback_superpowers` 同款诚实记录**(1356 红线延续:绝不静默跑残缺臂)。
4. **via 语义修订**:codex-tmux 记真实 via(hash/sticky/override/inherited/
   fallback_*);`noop_backend` 只留给 agy/kimi(transport=none 组)。评测 SQL
   的 noop 过滤随之缩窄(runbook 修订)。
5. **翻译头 mode-aware 修订**:「no Skill tool」句改为「role 文本引用的
   skill 若出现在你的 Available skills 里,直接用;不在则手动照做同样步骤」
   ——对三臂 + 未装配场景都成立,一句话覆盖,不需要 per-mode 翻译头。
6. **进程级证据**(验收 1):per-runner CODEX_HOME 的 config.toml(disable 块)
   + skills 目录内容 = 静态铁证(等价 argv);QA 脚本再加行为证据
   (S1-S3 的「问 Available skills」产品化)。归因列不加新列(证据走 QA
   脚本 + 供给日志,最小化)。

## 5. 风险与未知项

| # | 项 | 处置 |
|---|---|---|
| R1 | codex 版本漂移:`skills.config` 语义 pin 在 0.144.6,CLI 升级可能变形 | QA 脚本含 S2 探针步骤(oracle 探 + 行为断言),升级即红;plan 在 QA 脚本里固化 |
| R2 | denylist 扫描与 daemon 启动之间的 TOCTOU(扫完 upstream 变了) | 供给与 spawn 同一次 execute 调用内,窗口毫秒级;接受(与 1356 探针同级) |
| R3 | Matt 技能不能依赖 worktree 生命周期,且扁平名可能与全局技能碰撞 | 六项内容复制到 per-runner CODEX_HOME,副本使用 `matt-skills:*` 命名空间;不建指向 worktree 的 symlink |
| R4 | `~/.agents/skills` 里 flywheel-skills 同步的通用 skill(notion 等)三臂都在 | **有意保留**:Claude 侧 C 臂也只拔 superpowers 插件不拔机器技能——臂定义 = 「框架 delta」,两侧同构;写进 runbook 口径 |
| R5 | A 臂依赖机器全局 symlink(`~/.agents/skills/superpowers`)存在 | split 激活前置要求目录存在且非空;B/C 供给时若目录 ENOENT,记录 warn 并使用空 disable 名单(没有暴露项可禁);QA 脚本以 A 阳性对照硬验此前置 |
| R6 | 混合 flag 状态:split 开但某 codex runner 供给失败 | fail-closed 回 A(选型 3),via 诚实;与 claude 侧 matt 探针失败同构 |
| R7 | `.system` 目录 / bundled skills(imagegen 等)不受 skills.config 控 | 臂定义外(与 flywheel 无关的 codex 内建),三臂同在 = 常量不进对比;runbook 注记 |

## 6. Tadashi gate 补充事项落点

- ①暴露量化 → §2(存量无臂污染;风险前瞻性;E2E 样本 claude 侧不受影响);
- ③流程:**Codex design review 整体豁免(Annie 7/20 直令)**——plan 完成后
  交 Tadashi 做 recite 符合性核验,过即进 implement;code review 硬门照旧。
