# Research: 从零起一个全新项目 (tidal-echo) — FLY-284

**Issue**: FLY-284
**Date**: 2026-06-16
**Source**: `doc/engineer/exploration/new/FLY-284-from-scratch-onboard.md`
**Author**: runner-4059d190

> 红线遵守：本研究**先审计了真实 codebase / live 配置**（`~/.flywheel/projects.json` 6 项目全文、flywheel 2-layer CoS+Eng 条目、launchd plist 实体、sub content-executor + Asha identity、Linear teams/projects/labels 实查），不把已有的当从零设计。

---

## 0. TL;DR

1. **后半段 onboard 机制 100% 复用**（FLY-189/190/270 模板，joycon/sub/flywheel 已上线验证）。tidal-echo 的 onboard 物料与它们同构。
2. **唯一真正新的 = 前半段"建仓 + Linear + 骨架"**：现有脚本无 `gh repo create` / 无 `flywheel init`（实证 `run-issue.ts`/`run-project.ts` 都 `existsSync(projectRoot)` 失败即退）。`flywheel-cli` 包（已有 `migrate-agents-path`/`doctor`）是 `init` 的天然落点 —— 但 plan 倾向**先用一条幂等 shell setup 脚本**把 tidal-echo 立起来（最小、可复用），CLI 化作为后续。
3. **2-layer (CoS + 单 dept) 的 canonical 模板 = flywheel 自己的条目**（Aunt Cass `Flywheel-Triage` + Tadashi `Flywheel`，`generalChannel` = CoS 频道）。tidal-echo 逐字对照即可。
4. **Linear 结构照 sub**：sub = Personal(LEARN) team 下的一个 **project "Sub" + routing label `Sub`**（实查确认）。tidal-echo 同形：Personal team 下 project "Tidal Echo" + 两个 label。
5. **建 bot 必须 Annie 手动**（Discord 开发者门户 + 2FA + 邀请 + 建频道）。其余物料可脚本化/手写交付在 PR。

---

## 1. Onboard 机制（复用，不重造）

三套配置 + 一条 launch 链（FLY-270 research §1 已 trace，本次实证复核）：

| 层 | 文件 | 校验/消费点 |
|----|------|------------|
| 路由 | `~/.flywheel/projects.json` 新条目 | Bridge 启动期 `ProjectConfig.loadProjects()` 硬校验（`packages/teamlead/src/ProjectConfig.ts`） |
| Blueprint/Runner | `<repo>/.flywheel/config.yaml` | `ConfigLoader.validate()`（`team_id` 声明式，运行期不读；scoping 靠 projectName + FLY-127 label） |
| Lead 身份 | `<repo>/.lead/<leadId>/identity.md` | `claude-lead.sh` copy 到 `~/.claude/agents/<leadId>.md` |
| executor | `<repo>/.flywheel/agents/<dept>/<role>-executor.md` | Blueprint dispatch（FLY-137 label match） |
| Discord | `/setup-discord-lead`（半自动）+ `~/.flywheel/.env` token | `botTokenEnv` 在 loadProjects 期 resolve |
| 常驻 | launchd plist `com.flywheel.lead.<projectName>-<leadId>` → `flywheel-lead-wrapper.sh <manifest>` | manifest 首次 `claude-lead.sh` 自动生成 |
| 文档（可选） | `scripts/setup-doc-flow.sh <root> <dept>`（FLY-205） | 一条幂等命令 |

### 1.1 命名/唯一性约束（实证，避坑）

- **agentId 全局唯一**：agent 文件 copy 到 **共享** `~/.claude/agents/<leadId>.md`。geoforge3d 先占了 `cos-lead`/`product-lead`，flywheel 因此用 **project-prefixed** `flywheel-cos-lead`/`flywheel-eng-lead`。→ **tidal-echo 必须用 `tidal-echo-cos-lead` + `tidal-echo-content-lead`**（避免撞 geoforge3d）。persona（Triton/Ariel）放 identity.md + bot 显示名 + memory，不进 agentId。
- **manifest 名 = `${projectName}-${leadId}.json`**：project-prefixed agentId 会得到"双前缀"名（如 `tidal-echo-tidal-echo-cos-lead.json`）—— flywheel 实体就是这样（`flywheel-flywheel-cos-lead.json`），可接受、已是既定形态。
- **exact-key 唯一**：`${projectName}-${agentId}` 全局唯一（ProjectConfig 校验），tidal-echo-* 与现有不撞。
- **CoS 必须 `FLYWHEEL_LEAD_ROLE=cos`（launchd plist env）**：实证 flywheel-cos-lead plist 带 `FLYWHEEL_LEAD_ROLE=cos`，否则 cos-lead 被当 dept lead、加载错规则（`cos-lead-rules.md` 不装）。dept plist 不设此 env（默认 dept）。

### 1.2 `.lead/shared/` 红线（FLY-189/190 已踩）

单/双 Lead 项目**不要建 `.lead/shared/`**：一旦存在，claude-lead.sh 对非 cos dept Lead 强制 `common-rules.md` + `department-lead-rules.md` 同时存在否则 launch fail。具体规则折进各自 `identity.md`；base 规则（`founder-only-authority.md` 等）由 claude-lead.sh 从 `lead-rules-base/` 另行装载。

### 1.3 lead-rules-base 自动装载（按角色）

`packages/teamlead/lead-rules-base/`：
- **Triton (CoS)** 装：`cos-lead-rules.md`（FLY-127 路由纪律 + FLY-152 共享频道回复 + FLY-161 runner question）、`founder-only-authority.md`、`cross-dept-channel-rules.md`、`founder-html-delivery.md`。
- **Ariel (Content dept)** 装：`department-lead-rules.md`（FLY-127 action gate + executor-routing + FLY-159 gate timeout）、`founder-only-authority.md`、`cross-dept-channel-rules.md`、`founder-html-delivery.md`、`doc-flow-rules.md`（若 tidal-echo 开 doc-flow）。

---

## 2. tidal-echo 的 onboard 物料形状（实读现状后的草案）

### 2.1 `~/.flywheel/projects.json` 新条目（draft，**不写进 live 文件**，照 flywheel 2-layer 逐字对照）

```jsonc
{
  "projectName": "tidal-echo",
  "projectRoot": "/Users/xiaorongli/Dev/tidal-echo",
  "projectRepo": "xrliAnnie/tidal-echo",
  "memoryAllowedUsers": ["annie", "tidal-echo-cos-lead", "tidal-echo-content-lead", "tidal-echo"],
  "leads": [
    {
      "agentId": "tidal-echo-cos-lead",
      "chatChannel": "<NEW #tidal-echo-core 频道 id>",
      "match": { "labels": ["Tidal-Echo-Triage"] },
      "botTokenEnv": "TRITON_BOT_TOKEN",
      "canSpawnRunners": false,
      "alertFallbackToCore": true
    },
    {
      "agentId": "tidal-echo-content-lead",
      "chatChannel": "<NEW #tidal-echo 频道 id>",
      "alertChannel": "<NEW #tidal-echo 频道 id>",
      "match": { "labels": ["Tidal-Echo"] },
      "botTokenEnv": "ARIEL_BOT_TOKEN",
      "department": "content",
      "canSpawnRunners": true
    }
  ],
  "generalChannel": "<NEW #tidal-echo-core 频道 id>"
}
```

- `projectName=tidal-echo`（= 目录 basename = config.yaml `project:` = comm.db key = Runner worktree 根 `~/Dev/tidal-echo/worktrees/`；四处一致）。
- CoS 频道 = `generalChannel`（core 频道，reply-guard 豁免、CoS 的统一入口），与 flywheel 的 Aunt Cass 同。

### 2.2 `<repo>/.flywheel/config.yaml`（新建）

`project: tidal-echo`、`linear.team_id: TIDE`（**Annie 拍定专属 team**；声明式，运行期不读）、`decision_layer.autonomy_level: advisor`、checkpoints（brainstorm + question，照 sub content 项目；approve_to_ship 不启用）。**executor**：content 项目 → 单 `content-executor`（照 sub `.flywheel/agents/content-executor.md` 的"内容工程师"框架，非 code 模板）+ top-level `general-executor`（catch-all，可选）。**doc-flow**：tidal-echo 从第一天部门优先，倾向开 `doc_flow.enabled: true, default_department: content`（无历史搬家债，FLY-205 理想场景）。

### 2.3 `.lead/tidal-echo-cos-lead/identity.md`（Triton，照 Aunt Cass）+ `.lead/tidal-echo-content-lead/identity.md`（Ariel，照 Asha）

- **frontmatter**：`model: opus`、`memory: user`、`disallowedTools: Write, Edit, MultiEdit, Agent, NotebookEdit`、`permissionMode: bypassPermissions`。
- **Triton (CoS)**：triage→present to Annie→等确认→打 dept label→route 给 Ariel（经 `/api/chat-threads/send`，非顶层 Discord）；**绝不走 #leads-roundtable**（内部 handoff 留 #tidal-echo-core）；不开 Runner、不碰内容；给 Annie 汇总。
- **Ariel (Content dept)**：照 Asha —— 管 content Runner 端到端产内容；Linear 查询 `?project=Tidal Echo`；每个交 Runner 的 issue 必带 `Tidal-Echo` label 否则 403；媒体试听/审阅 gate（Ariel 贴、Annie 拍）；不替 Annie 做审美判断。
- **memory `user_id` 共享桶** = `tidal-echo`。

### 2.4 launchd plist + manifest（两个 Lead 各一）

照 `com.flywheel.lead.flywheel-flywheel-cos-lead.plist`（CoS，带 `FLYWHEEL_LEAD_ROLE=cos`）+ `...eng-lead.plist`（dept，无该 env）。`KeepAlive=true`、`RunAtLoad=true`、`ThrottleInterval=30`、ProgramArguments = wrapper + manifest。manifest 由首次手动 `claude-lead.sh` 生成。

### 2.5 repo 骨架（照 sub，最小化）

```
tidal-echo/
├── README.md                 # 项目概述 + workflow
├── AGENTS.md                 # onboarding + 内容硬规则（占位，Ariel/Annie 后续填实）
├── .gitignore                # 含 worktrees/
├── .flywheel/
│   ├── config.yaml
│   └── agents/
│       └── content/content-executor.md   # 照 sub，内容工程师
├── .lead/
│   ├── tidal-echo-cos-lead/identity.md   # Triton
│   └── tidal-echo-content-lead/identity.md # Ariel
└── content/                  # doc-flow + 内容工作区骨架
    ├── doc/                  # setup-doc-flow.sh 产出（README + retro/.gitkeep）
    ├── brief/                # 占位（内容方向，Ariel 后续填）
    └── references/           # 占位
```

> 注：`content/brief`、`references` 是**占位骨架**，具体内容方向 = Ariel 上线后跟 Annie 定（出界）。AGENTS.md 内容硬规则也留占位，不预设她要做什么内容。

---

## 3. Linear 结构（照 sub 实证）

- **实查**：teams = Personal(LEARN) / GeoForge3D(GEO) / Flywheel(FLY)。**sub project "Sub" 挂在 Personal(LEARN) team 下**（不是新建 team），routing label `Sub`（紫，描述写明 FLY-127 dept-scope gate）。
- **tidal-echo（Annie 2026-06-16 拍定）= 新建专属 team「TIDE」**（不走 sub 的 project-under-LEARN，要更干净的隔离 + `TIDE-NN` key）+ 两个 routing label：
  - `Tidal-Echo`（content，给 Ariel 的 Runner；每个交 Runner 的 issue 必带）。
  - `Tidal-Echo-Triage`（CoS Triton 的 triage 项；照 flywheel `Flywheel-Triage`）。
  - issue key = `TIDE-NN`。team + label 创建归 cutover（live 写，Annie 闸后）。

---

## 4. 从零建仓（真正的新增动作）

- **现状**：onboarding 脚本零建仓自动化。建仓 = `git init` + `gh repo create xrliAnnie/tidal-echo --private` + 初始 commit。
- **谁做**：建 GitHub repo 是 live、半不可逆动作 → 放 **implement 阶段、Annie 批准 plan 之后**执行（不是现在）。可由 Runner 在隔离目录跑 `gh repo create`（Annie 的 gh 已登录），或 Annie 手动建后我们 wire —— plan 给两个选项。
- **倾向**：把建仓 + 骨架 + Linear project/label 做成**一条幂等 setup 脚本**（`scripts/setup-new-project.sh` 或扩 `flywheel-cli`），tidal-echo 是它第一次真实运行 —— 这就把 FLY-284 从"一次性"升级成"可复用 zero-to-one flow"（A1=iii，FLY-205 模式）。粒度（脚本 vs CLI）plan + Codex 定。

---

## 5. 必须 Annie 手动的步骤（plan 要列清）

1. **Discord**：建 2 个 bot（Triton + Ariel）—— 开发者门户建 app、开 intents、记 token、邀请进 server（2FA）；建 2-3 个频道（#tidal-echo-core / #tidal-echo，按 option C 双频道）。
2. **token 落 `~/.flywheel/.env`**：`TRITON_BOT_TOKEN` / `ARIEL_BOT_TOKEN`。
3. **live cutover 批准**：editing live `projects.json`、装 launchd、首次 `claude-lead.sh`、重启 Bridge —— 全是 founder-gated，Annie 在场拍。
4. （建 GitHub repo + Linear project/label 可由 Runner 代跑或 Annie 手动 —— plan 给选项。）

---

## 6. plan 必须定的开放项

| # | 开放项 | research 倾向 | 谁定 |
|---|--------|--------------|------|
| 1 | 交付物形态（一次性 vs 可复用 setup 脚本/CLI） | FLY-205 模式：最小可复用脚本，tidal-echo 首跑 | Annie 已倾向、plan/Codex 定粒度 |
| 2 | Linear：project-under-LEARN vs 专属 team | project-under-LEARN（照 sub） | Annie 一句话 |
| 3 | doc-flow 开关 + 部门名 | 开，`content` | Annie/plan |
| 4 | executor 粒度（单 content-executor vs +general catch-all） | 单 content-executor + 可选 general | plan/Codex |
| 5 | 建仓执行者（Runner 代跑 gh repo create vs Annie 手动） | Runner 代跑（Annie gh 已登录），founder-gated | Annie |
| 6 | 频道拓扑（单 #tidal-echo vs +#tidal-echo-core 双频道） | 双频道（CoS 必须有 core 频道，照 flywheel/sub option C） | Annie 确认 |

---

## 附：本研究实读的真实来源
- `~/.flywheel/projects.json`（6 项目全文，flywheel 2-layer CoS+Eng）
- `~/.flywheel/manifests/*.json`（命名约定）、`~/Library/LaunchAgents/com.flywheel.lead.flywheel-flywheel-{cos,eng}-lead.plist`（CoS `FLYWHEEL_LEAD_ROLE=cos` env 实证）
- `/Users/xiaorongli/Dev/sub/.flywheel/agents/content-executor.md`、`/Users/xiaorongli/Dev/sub/.lead/sub-lead/identity.md`（Asha）
- `.lead/flywheel-cos-lead/identity.md`（Aunt Cass）、`packages/teamlead/lead-rules-base/*`
- Linear：`list_teams`（3 team）、`list_projects`（Sub project under Personal/LEARN）、`list_issue_labels`
- `doc/engineer/onboarding/new-project-flywheel-setup.md`（"Out of scope v1.28+" = flywheel init defer）
- `doc/engineer/{exploration,research,plan/archive}/FLY-270-self-onboard*`、FLY-205 doc-flow plan
