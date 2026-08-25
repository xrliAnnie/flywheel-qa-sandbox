# FLY-2034 Belle 完整 Lead 席位 — 调研
Issue: FLY-2034 (https://linear.app/geoforge3d/issue/FLY-2034/belle接入-belle-完整-lead-席位自有代码仓产出归档-flywheel-派工席位定时任务-skill-化随后)
日期: 2026-08-24(v2:折入 Codex design review R1 的四处事实修正,修正处标 [R1])
基于: exploration.md

> 实施期更新（2026-08-24）：Founder 后续裁定新建并使用 `personal-assistant`
> label；本文对 `life` label 的调研假设保留为历史背景，实施真相见 plan.md 与
> onboarding.md。

本文回答一个问题:**把 Belle 从 companion 升格为可派工 dept Lead,机制链路上每一环
到底怎么走、哪一环需要动什么。**全部结论来自 2026-08-24 对 worktree
`flywheel-FLY-2034`(main 同步)源码 + 生产机只读核对;行号会漂,重定位用 `git log -S`。

## 1. 席位翻转机制(逐环核对)

### 1.1 companion 标志:launch 层唯一真相源

- `packages/teamlead/scripts/claude-lead.sh:399-465`(FLY-231):启动时用 node 内联脚本读
  `~/.flywheel/projects.json`,按 `projectName+leadId` 精确匹配,输出
  `companion|noncompanion|error|notfound`。
  - `companion` → log "skipping engineering-governance rules + capability";只装
    companion 面的 rule bundle。
  - `noncompanion` → 完整 dept Lead 路径(engineering rules + Bridge token + bootstrap)。
  - inconclusive → fail-STOP + `companion_config_error` severe 告警(绝不带病启动)。
- `packages/teamlead/scripts/lead-rules-bundle.sh:328-400`:role 三分
  `companion|cos|dept`。companion 只有 `companion-safety-contract.md`(必装,缺失即失败)
  + `founder-local-time` + `cross-dept-channel-rules`;**dept 追加**
  `department-lead-rules.md`、`founder-only-authority.md`、`founder-html-delivery.md`、
  `doc-flow-rules.md`(non-cos dept)等。
- **结论:翻转不改任何 flywheel 机制代码。删掉 projects.json 里的 `companion: true` 并重启
  Belle,她下一次出生就是 dept Lead。**
- [R1] 但有一处**运行时规则内容**必须随本单更新:
  `packages/teamlead/lead-rules-base/cross-dept-channel-rules.md:64` 的 roster 把 Belle
  写成 "Life Assistant (non-eng companion)",`:68` 注记写 "Mufasa and Belle … own no
  Runners and no code"。该文件被 `lead-rules-bundle.sh` 装进所有 dept role bundle——
  不更新会让全体 Lead 继续收到"Belle 不派工"的过期事实(2026-08-24 实测行号;
  现有测试未点名 Belle,预期零测试改动)。
- [R1] 同理,她 live 的 `.lead/belle-lead/identity.md` 明令"不开 Runner"——
  claude-lead.sh 只加载 identity.md,不会加载旁放的 proposed 文件;identity 合并
  必须是 cutover 的显式步骤,否则翻转后她"有权限但被自己身份禁止"。

### 1.2 配置校验层:翻转合法性

`packages/teamlead/src/ProjectConfig.ts`(2026-08-24 head):

- `canSpawnRunners` 缺省归一化为 `true`(:600-605);显式 `true` 合法。
- `companion` 只做类型校验(:606-614),**没有** companion×canSpawnRunners 互斥;
  互斥只在:`external×companion`(:719-727)、`codex-app-server` tier 组合(:774-807)。
  Belle 是 claude-code backend(manifest `leadBackend.backendId=claude-code`)→ 不涉及。
- 先例:rafiki-lead / reflection-lead(growth)= 非工程、`companion:false`、
  `canSpawnRunners:true`、spawns docs 型 Runner。**Belle 目标形态与它们同构。**

### 1.3 Runner spawn 链:每环前置条件

```
Linear issue(label "life")
  → Bridge /api/runs/start(FLY-127 gate:issue 必须带项目路由 label,否则 403)
  → DAG dispatch(FLY-1981:pipeline.dag 缺省 true;per-category menu binding 必须存在,
    否则 DAG_ENTRY_NOT_MATERIALIZED 拒绝;Bridge boot 会为无 menu 项目"只新增、不覆盖"
    六条 exact binding)
  → EdgeWorker/Blueprint:repository 配置源自 projectRoot;[R1] worktree 建在
    主仓的 **sibling 目录**(FLY-95:`run-infra.ts:903` new WorktreeManager 无 baseDir →
    `WorktreeManager.worktreeDir()` 落 `~/Dev/personal-assistant-<ISSUE>`,
    不是 `<projectRoot>/worktrees/`;真相以 StateStore 持久化的 worktree_path 为准);
    读 <projectRoot>/.flywheel/config.yaml(agents 执行体路由 / doc_flow / checkpoints)
  → Runner(tmux)→ PR → founder-gated merge(FLY-175)
```

逐环对 Belle 的缺口:

| 环节 | 现状 | 缺口 | 补法 |
|------|------|------|------|
| 路由 label | "life" 已在 `match.labels` | 无 | 复用,零新 label |
| Linear team | growth 先例:复用 LEARN;`TEAMLEAD_ISSUE_PREFIXES=FLY,GEO,LEARN` 已含 LEARN | 需确认 "life" label 在 LEARN team 存在 | implement 期用 Linear API 核;缺失则先问 founder |
| menu binding | Bridge boot 自动物化 | cutover 后需核实 6 条存在 | checklist 验证步 |
| projectRoot 是 git 仓 | **不是**(最大缺口) | git 化 + remote | 见 §2 |
| .flywheel/config.yaml | **无** | 需新写 | 随仓 scaffold(§3) |
| 执行体 agent 文件 | 无 | life-executor.md | 仿 reflection-executor;另有 shipped generic-executor 兜底(FLY-217, AgentDispatcher step 3) |
| projectRepo | projects.json 无此字段 | [R1] **不是 spawn 前置条件**,是后续 PR/approval/diff 路径需要 | checklist 加 `"xrliAnnie/belle-workspace"` |
| memoryAllowedUsers | 无 | [R1] 缺失**不会**在 spawn 时 fail-closed——Bridge bootstrap 只是不注入 recall(FLY-284 checklist 的"fail-closed"说的是 memory 校验本身,不是派工) | checklist 补上,动机是记忆连续性,不是解锁派工 |
| skill 发现路径 | live 已有 `.claude/skills/{meal-prep,weee-weekly}` | [R1] Claude Code 只从 `.claude/skills/<name>/SKILL.md` 发现 skill;顶层 `skills/` 是死文件 | canonical 放 `.claude/skills/`,顶层 `skills` 做浏览 symlink(取舍见 plan §4) |
| cross-dept roster | rules-base 写死 Belle=companion | [R1] 运行时规则内容过期(见 §1.1) | flywheel PR 更新两行文案 |
| ConfigLoader 风险 | — | 坏 config.yaml 会把**整个项目**踢出 Bridge runtime(FLY-371/FLY-137 教训,growth config 注释原文) | config.yaml 照 growth 逐字段对照 + implement 期跑 ConfigLoader 校验 |

### 1.4 记忆连续性约束(决定 Q1 选型的硬事实)

`~/.flywheel/manifests/personal-assistant-belle-lead.json`(生产只读):
`workspace = projectDir = /Users/xiaorongli/Dev/personal-assistant`,exact-key =
`personal-assistant-belle-lead`(restart-ledger / lease / manifest 全键在它上面)。

- 改 projectRoot → manifest 重生成 + Lead cwd 变 → Claude 会话目录
  (`~/.claude/projects/<路径哈希>/`)换新 → 会话/记忆锚点断代;
- 改 projectName → exact-key 换代,restart-ledger/lease/manifest 历史全部另起炉灶。

Mufasa cutover(FLY-350)把"thread 逐字延续"当硬验收证据的先例说明:记忆连续是
founder 在意的资产。**两个名字都不动**是唯一零风险路径。

## 2. 原地 git 化的具体机制

### 2.1 冲突面(精确枚举,2026-08-24 实测)

[R1 修正:交集按 **root-relative path** 精确计算,不按 basename——live 与 scaffold 都有
`SKILL.md` 这个 basename,按文件名算会误报。]
scaffold 会带的文件 vs 她目录已存在的文件,root-relative 交集恰好 3 个:
`README.md`、`CLAUDE.md`、`.gitignore`(都是 2026-05-27 的初版,无个人隐私内容,
内容已读过——scaffold 版本会**折入其全部现有内容**再扩写)。
其余 scaffold 文件(skills/、archive/、MEMORY.md、.flywheel/、identity 升级稿)全是新路径,零冲突。

connect 配方(checklist 逐字命令;[R3#3] 备份一律仓外——repo 内 `.bak` 会变成
未跟踪残留,与 disposition 验收冲突):
```bash
BK=~/.flywheel/backups/fly2034/pre-repo && mkdir -p "$BK" && chmod 700 ~/.flywheel/backups/fly2034 "$BK"
cd ~/Dev/personal-assistant
for f in README.md CLAUDE.md .gitignore; do
  shasum -a 256 "$f" >> "$BK/digests.txt"; stat -f "%Lp %Su %N" "$f" >> "$BK/modes.txt"
done
mv README.md "$BK/README.md" && mv CLAUDE.md "$BK/CLAUDE.md" && mv .gitignore "$BK/gitignore"
git init && git remote add origin git@github.com:xrliAnnie/belle-workspace.git
git fetch origin && git checkout -b main origin/main
# 从仓外 diff:diff "$BK/README.md" README.md 等三件,确认 scaffold 已逐条折入
# (有出入则手工折回再提交);确认后备份留在 $BK,不删(cutover 全程留证)
```
之后她的存量内容(tasks/、BELLE.md、memory/ 等)由 Belle/founder 审一遍 `git add`
提交——**私人文件是否入库的决定权留在她们侧**,.gitignore 先行保护
(.mcp.json、scratchpad/、tmp/、整个 belle/ 目录已排除——[R3#3] belle/ 里还有
plist/start.sh/.bak 机器残留,不止日志)。

### 2.2 隐私边界

- BELLE.md / memory/ / tasks/ 含个人生活数据。先例:growth 私仓已托管 Annie 个人
  反思材料(MUFASA.md、weekly/)→ private repo 承载个人数据是已被接受的形态。
- 但**本单 implement runner 不替她做这个决定**:scaffold push 只含新写的通用文件;
  存量文件入库动作全在 checklist(founder/Belle 执行)。

### 2.3 仓名 ≠ 目录名

`projectRepo: "xrliAnnie/belle-workspace"` + 目录 `personal-assistant`:projectRepo 只用于
PR/gh 定向,运行时不从目录名反推 repo 名(各项目均以 projects.json 显式字段为准)。
mismatch 是纯认知成本,README 第一行 + config.yaml 注释写明。

## 3. 她仓的 .flywheel/config.yaml(照 growth 逐字段推导)

```yaml
project: personal-assistant        # 必须 = projectName(不是仓名!)
linear:
  team_id: LEARN                   # schema 必填但非运行时过滤器(growth 同款注释)
runners:
  default: claude
  available: { claude: { type: claude, model: sonnet } }
teams:
  - name: default
    orchestrators: [{ type: dag, runner: claude, budget_per_issue: 10 }]
decision_layer:
  autonomy_level: advisor          # merge/ship 保持 founder-gated(FLY-175)
  escalation_channel: discord
checkpoints:
  brainstorm: { enabled: true, timeout_ms: 86400000, timeout_behavior: fail-close }
  question:   { enabled: true, timeout_ms: 86400000, timeout_behavior: fail-open }
  approve_to_ship: { enabled: true, timeout_ms: 86400000, timeout_behavior: fail-close }
agents:
  life:
    agent_file: .flywheel/agents/life/life-executor.md   # 必须在 dept 子目录且 department 一致(FLY-371 fail 教训)
    department: life
    match: { labels: ["life"] }
default_agent: life
doc_flow:
  enabled: true
  default_department: life
roles:
  runner: { model: sonnet, backend: claude-tmux }
```

注意项(全部来自先例注释/事故):
- `pipeline.dag` **不要写**(缺省 true;显式 false 会 DAG_DISPATCH_DISABLED fail-fast,FLY-1981)。
- agent_file 必须在 `.flywheel/agents/<dept>/` 子目录且 `department:` 字段一致,
  否则 ConfigLoader throw → 整个项目掉出 Bridge runtime(growth config 注释原文)。
- 匹配不到执行体时回落 shipped generic-executor(FLY-217/AgentDispatcher step 3)——
  [R2 收窄]这条回落**只存在于非 generalized 的 AgentDispatcher 路径**。
  generalized DAG(如 `tpl_generic_menu`)的带 `role` 节点在 snapshot materialize 时
  无条件走 `resolveMenuAgentFile`(`workflow-run-snapshot.ts:462`)→ 读
  `<projectRoot>/.flywheel/menus/ic-roster.yaml`,Lead 还须在
  `.flywheel/menus/adoption.yaml` 里 adopt 该 menu(`resolveLeadMenus`)——
  **两文件缺失 = dispatch 失败,零回落**。flywheel 自己的两文件是现成模板
  (`generic: .flywheel/agents/general-executor.md` / `flywheel-eng-lead: [code,
  simple_code, generic]`);growth/tidal-echo 均无 `.flywheel/menus/`,
  说明它们从未跑过 generalized menu 路径,不能当"没有也行"的反例。
  Belle 仓必须交付这两个文件。

## 4. life-executor 要点(仿 reflection-executor,差异处)

- 工作区:worktree 内,产出写 `archive/`(+ 对应 skills/ 若是做法沉淀);
  **不碰** BELLE.md、memory/、.lead/、belle/(她的活体文件不是 Runner 工作面)。
- 硬规则继承她 CLAUDE.md:**绝不花钱/下单**(购物类只建 cart 或只写清单)、每次运行
  必写归档、不确定项写"Needs review"不瞎猜。
- 浏览器任务(weee 买菜类)依赖她本机 Chrome 登录态 → **Runner 不做需要她登录态的
  浏览器操作**,只做生成/整理/归档类;需要真开浏览器的环节留给 Belle 本体或明确升级。
- 产出语言中文;PR 流程与 merge founder-gated 同全队。

## 5. 定时任务 → skill 化的约定(为 ③ 立约,本单不迁移)

- 现状:launchd `com.belle.daymode/nightmode/keepawake.plist`(机器级)+
  tasks/<name>/runbook.md(做法)。
- 终态约定:做法进 `skills/<task>/SKILL.md`;每次执行的产出进
  `archive/<task>/<YYYY-MM-DD>-<slug>.md`;每周台账 `archive/weekly/<YYYY-Www>.md`
  记"这周每天做了什么"(一行一条,可 grep);触发器(launchd/cron)保持机器级,
  只调 skill,不在仓里存 plist(秘密/机器路径不入仓)。
- 本单交付:约定文档 + 1 个样例 skill(meal-menu,素材 = tasks/meal-prep/PREFERENCES.md,
  2026-08-24 刚由 Annie dry-run bootstrap)+ archive 骨架;存量三个任务的迁移 = ③ 随用随做。

## 6. 会过期的结论(as-of 2026-08-24;续接前逐条重核)

| 结论 | as-of | 重核命令 |
|------|-------|----------|
| Belle entry 形态(companion:true 等三字段) | 2026-08-24 | `python3 -c` 读 `~/.flywheel/projects.json` |
| manifest workspace=personal-assistant | 2026-08-24 | `cat ~/.flywheel/manifests/personal-assistant-belle-lead.json` |
| companion 检测在 claude-lead.sh:399 | 2026-08-24 | `git log -S "_companion_query" -1` / grep |
| ProjectConfig 无 companion×spawn 互斥 | 2026-08-24 | grep ProjectConfig.ts companion |
| TEAMLEAD_ISSUE_PREFIXES 含 LEARN | 2026-08-24 | grep `~/.flywheel/.env`(只看该行) |
| 冲突面 = 恰 3 文件 | 2026-08-24 | `ls ~/Dev/personal-assistant` 对照 scaffold 清单 |
| meal-prep PREFERENCES 已 bootstrap | 2026-08-24 | `head tasks/meal-prep/PREFERENCES.md` |
| xrliAnnie/belle-workspace 尚不存在(gh 实测 Could not resolve) | 2026-08-24 | `gh repo view xrliAnnie/belle-workspace`(implement 前必重跑) |
| cross-dept roster Belle 行在 :64/:68 | 2026-08-24 | grep cross-dept-channel-rules.md |
| worktree 落 sibling 目录(无 baseDir) | 2026-08-24 | 读 run-infra.ts `new WorktreeManager` + WorktreeManager.worktreeDir |
| live .claude/skills 已有 meal-prep/weee-weekly | 2026-08-24 | `ls ~/Dev/personal-assistant/.claude/skills/` |
| personal-assistant 六条 menu binding 已存在(翻转前即绿,不能当 cutover 证据) | 2026-08-24(Codex R1 查生产 DB) | 查 StateStore menu binding 表 |
| generalized role 节点无 ic-roster 即失败、无回落 | 2026-08-24 | 读 workflow-run-snapshot.ts resolveMenuAgentFile 调用点 + workflow-menu.ts loadProjectMenuConfig |
| growth/tidal-echo 均无 .flywheel/menus/ | 2026-08-24 | `ls <root>/.flywheel/menus/` |
| request-restart.sh 紧急票 = 异步受理,受理≠部署完成 | 2026-08-24(Codex R2 读脚本) | 读 scripts/request-restart.sh + updater 文档 |
| 生产 projects.json mode=0600 | 2026-08-24(Codex R2 实测) | `stat -f %Lp ~/.flywheel/projects.json` |
