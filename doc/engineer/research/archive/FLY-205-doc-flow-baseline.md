# Research: Project doc-flow baseline — FLY-205

**Issue**: FLY-205
**Date**: 2026-06-04
**Source**: `doc/engineer/exploration/new/FLY-205-doc-flow-baseline.md`（审计 + 5 轮 brainstorm 收口，结论合同 = Part C）

---

## 1. 问题

把 Annie 拍定的部门优先文档管理 baseline（exploration Part C）落到 Flywheel 机制上：新项目可选启用、已有项目可补装（sub 物理搬家 + joycon 纯新增）、Runner 自动按三档难度产出文档、Lead 判档 + 知会 Annie。本文回答"接在哪、怎么接"，并实测验证关键机制。

## 2. 实测验证过的机制事实

### 2.1 Blueprint 注入点 — base prompt 永远生效（关键）

`packages/edge-worker/src/Blueprint.ts` L693-695：

```ts
const systemPrompt = agentContext
    ? `${agentContext}\n## Baseline Rules\n${baseSystemPrompt}`
    : baseSystemPrompt;
```

agent.md（项目 executor，如 sub 的 content-executor）是**前置**，`baseSystemPrompt`（`systemPromptLines` 拼装）**永远在**。→ doc-flow 规则块加进 `systemPromptLines`（条件注入，模式照抄 FLY-47 checkpoints / FLY-137 onboard preamble），**对所有 Runner 生效，不被项目 executor 覆盖**。职责切分干净：executor 定"流程"（gate、协议），doc-flow 块只定"文档约定"（放哪、命名、抬头、三档语义）。

### 2.2 ConfigLoader — 加新 key 向后兼容

`packages/config/src/ConfigLoader.ts::validate()` 是手写白名单校验（project / linear / runners / teams / decision_layer / checkpoints…），**未知顶层 key 原样通过**。→ `doc_flow:` 新 key：旧 flywheel checkout 读到带 doc_flow 的 config 不会炸（直接忽略）；新代码加显式校验。`FlywheelConfig` interface（`packages/config/src/types.ts` L199-224）加可选字段即可。

### 2.3 department 解析链已在生产

- `LeadConfig.department` 显式字段（FLY-137 v1.27.2）→ 缺省回退 `match.labels[0]` 小写（`ProjectConfig.ts::resolveLeadDepartment`）。
- Blueprint `ctx.owningDept` 由 runs-route 经 `DepartmentRegistry.getDepartmentForIssue` 算好传入；可能值 `string | "multiple" | undefined`。
- → 文档路径的部门段：`ctx.owningDept`（是 string 时）→ 否则 `doc_flow.default_department`。**启用 doc_flow 时 default_department 必填**（校验规则），单部门项目由它兜底，避免 "multiple"/undefined 时 Runner 乱猜。
- 配置对齐动作：sub 的 projects.json lead 补 `department: "content"`（否则 label 回退推出 "sub"，与目录名 content/ 不一致）。

### 2.4 Lead 侧规则注入

`packages/teamlead/lead-rules-base/*.md` 经 `claude-lead.sh --append-system-prompt-file` 对每个 Lead 加载（FLY-26/FLY-175 先例，缺文件向后兼容）。→ 新增一个 base 文件承载：三档判定标准、知会消息格式、Annie 否决处理、spawn 时怎么把档位传给 Runner。**条件化**：规则文本以"项目 `.flywheel/config.yaml` 有 `doc_flow.enabled: true` 才适用"开头（Lead 有 Bash，能读自己项目的 config）——未启用项目的 Lead 行为零变化。

### 2.5 档位怎么从 Lead 传到 Runner

Lead 判档发生在 spawn 时。三个候选：
- **A（推荐）：`/api/runs/start` body 加可选 `docTier: "full" | "plan_only" | "none"`**，runs-route → RunDispatcher → BlueprintContext 透传，Blueprint 按档注入对应文档指令。缺省 = `full`（fail-safe：没说就走全套，宁多勿漏）。改动面小（一个可选字段三层透传），与现有 `agentName` 字段同模式。
- B：Lead 用 inbox/mailbox 发指令 —— 时序不可靠（Runner 可能已开干）。
- C：写进 issue 描述 tag（`[doc-tier=none]`）—— 污染 issue 文本，且 Lead 改判要改 issue。
→ 取 A。

### 2.6 现有缝隙（plan 要补的）

- 基础 6 步 prompt（Blueprint L419-425）写死 "1. read → 2. TDD → 3. branch → 4. PR"，与 full 档的 "先 exploration/research/plan 落盘" 并存时要措辞衔接（doc-flow 块声明"在第 2 步之前完成文档产出"）。
- stage 遥测枚举（brainstorm/research/plan）已有，doc-flow 块顺手要求各阶段 `stage set` —— 零代码，纯 prompt。
- `agents/generic-executor.md`（shipped 兜底）提到 brainstorm/research/write-plan skills 但无文档落盘约定 → 补一段引用 doc-flow 约定（条件措辞：项目启用才适用）。
- sub 的 `content-executor.md` 已有 B/R/P 硬 gate，但文档去向写的是自有目录 → 补装 PR 里把产出路径改到 `content/doc/<ISSUE>-<slug>/`。

## 3. 方案骨架（plan 的输入）

### 3.1 配置形态

```yaml
# <project>/.flywheel/config.yaml
doc_flow:
  enabled: true
  default_department: content     # 启用时必填;部门目录名
```

不放 `~/.flywheel/projects.json`（机器本地不随 repo 走，exploration A.3 已论证）。

### 3.2 改动面六块

| # | 块 | 落点 | 性质 |
|---|----|------|------|
| 1 | config schema + 校验 | `packages/config`（types + ConfigLoader + 测试）| 代码 |
| 2 | Runner 注入块 + docTier 透传 | `packages/edge-worker/Blueprint.ts` + `packages/teamlead` runs-route/RunDispatcher（透传）+ 测试 | 代码 |
| 3 | Lead 规则 | `packages/teamlead/lead-rules-base/doc-flow-rules.md`（新文件）| 规则文本 |
| 4 | 脚手架/补装脚本 | `scripts/setup-doc-flow.sh <project-root> <department>`：建 `<dept>/doc/{,retro/}` + `doc/README.md`（约定自述：树形、命名、3 行抬头模板）+ config.yaml 注入 doc_flow key（无 .flywheel 时给指引不硬建）| 脚本 |
| 5 | spec 修订 + generic-executor 补段 | `doc/architecture/product-experience-spec.md` §4.1（v2 措辞已过 Annie）+ `agents/generic-executor.md` | 文档 |
| 6 | 补装执行 | sub PR（搬家 + content/doc/ + config + executor 路径 + projects.json department）；joycon PR（纯新增 `product/doc/` + README，挂着等分支理顺）| 跨 repo PR |

### 3.3 sub 搬家清单（实测底数）

- `git mv` 入 `content/`：`brief/ references/ research/ projects/ scripts/ docs/ nanobanana-output/`（170M+392M 大目录，git mv 元数据级，历史 `--follow` 可追）
- 改引用 ~25 处：`AGENTS.md`（projects/×3, brief/×3, references/×2, research/, docs/）、`.flywheel/agents/content-executor.md`（scripts/style-lint.sh×4, scripts/mix.sh, scripts/audio-to-video.sh, brief/×2, references/×2, research/, docs/）、`.flywheel/config.yaml`（style-lint×3）+ sub-create skill 内部
- 无 build 体系、无 CI workflow（`.github/workflows` 不存在）—— 实测
- 收口：全仓 grep 旧路径零命中 + style-lint 跑通 + sub-create 路径 dry 校验 + 合并后重启 Asha
- git/GitHub：**已就绪**（`github.com/xrliAnnie/sub`），无需 git 化动作

### 3.4 兜底与回滚

- `doc_flow` 缺省 = off：所有现有项目（GeoForge3D 含内）行为字节级不变 —— 与 FLY-175 DECISION_MODE default-off 同纪律
- docTier 缺省 = full：Lead 忘传 → 走全套文档，宁多勿漏
- Lead 规则文件缺失 → claude-lead.sh 现有行为（跳过，向后兼容）

## 4. 测试形态

- 单测：ConfigLoader doc_flow 校验（enabled 无 default_department 必须抛）；Blueprint 注入（enabled×3 档 × agent.md 有/无 = 块出现且 Baseline Rules 仍在；off = 字节不变 sentinel，照抄 FLY-175 reverse-compat 先例）；runs-route docTier 透传 + 非法值 400。
- 脚本测：setup-doc-flow.sh 幂等（重跑不重复注入 config）、对无 .flywheel 项目的指引路径。
- 补装验证：sub PR 上跑 §3.3 收口三件套（QA 真机）。

## 5. 不做的（明确出界）

- GeoForge3D 大树迁移/重命名（Annie 拍定不动）
- joycon 物理搬家（另立 issue，等分支理顺）
- 状态子目录 / archive 机制（拍定砍掉；以后要再加）
- Lead 知会的代码化通路（知会是 Lead prompt 行为，走现有 Discord 发消息能力，不新建 API）
- ~~git 化 sub~~（实测已是 git+GitHub，falls out of scope）
