# FLY-2034 Belle 完整 Lead 席位 — 探索
Issue: FLY-2034 (https://linear.app/geoforge3d/issue/FLY-2034/belle接入-belle-完整-lead-席位自有代码仓产出归档-flywheel-派工席位定时任务-skill-化随后)
日期: 2026-08-24
基于: 无

> 实施期更新（2026-08-24）：Founder 后续裁定新建并使用 `personal-assistant`
> label；本文对“复用 life/无需新 label”的探索期判断已被取代，以 plan.md 与
> onboarding.md 为准。

## 1. Founder 意图(2026-08-24 11:56 PT 原话要点)

1. Belle 要有**自己的代码仓**;
2. 做的东西**都要归档**(菜单/买菜等定时任务产出),这样记得她每天做了什么;
3. 定时任务最后**写成 skill 存她仓里**;
4. **每周定时任务记录可归档可查询**;
5. 她要能**像其他 Lead 一样指派 runner 干活**——跟其他 Lead 有一样的 functionality。

授权:「这个你也开始做吧」(11:02 PT,指 Belle 接入短方案页)。

## 2. 现状审计(2026-08-24 实测)

### 2.1 Belle 的席位现状(~/.flywheel/projects.json,只读核对)

```json
{
  "projectName": "personal-assistant",
  "projectRoot": "/Users/xiaorongli/Dev/personal-assistant",
  // 注意:无 projectRepo、无 memoryAllowedUsers、无 generalChannel
  "leads": [{
    "agentId": "belle-lead",
    "chatChannel": "1509720034463846481",
    "match": { "labels": ["life"] },
    "botTokenEnv": "BELLE_BOT_TOKEN",
    "canSpawnRunners": false,
    "companion": true,
    "department": "life",
    "model": "sonnet", "effort": "high", "carrier": "v2"
  }]
}
```

关键机制(代码核对过,非猜测):

- `companion: true` 是**唯一真相源**(FLY-231)。`packages/teamlead/scripts/claude-lead.sh:399-465`
  在启动时查 projects.json:companion → 只装 `companion-safety-contract.md`、跳过
  engineering-governance rules + Bridge capability;noncompanion → 完整 dept Lead bundle
  (`department-lead-rules` / `founder-only-authority` / `founder-html-delivery` /
  `doc-flow-rules` 等,见 `lead-rules-bundle.sh:328-400`)。检测 inconclusive 时 fail-STOP。
- `ProjectConfig.ts` 校验层**不禁止** claude-code Lead 的 `companion:false + canSpawnRunners:true`
  ——互斥规则只存在于 external×companion 和 codex-app-server tier(FLY-245/350/879)。
  即:Belle 翻成普通 dept Lead 是配置层合法路径,先例 = rafiki-lead / reflection-lead
  (同为非工程、canSpawnRunners:true、spawns content Runners)。
- Belle manifest(`~/.flywheel/manifests/personal-assistant-belle-lead.json`):
  `workspace = /Users/xiaorongli/Dev/personal-assistant`。**她的 Lead 身体、会话状态、
  文件记忆都锚在这个路径** → 改 projectRoot = 记忆/会话连续性风险(Mufasa cutover
  的教训:记忆延续是硬验收证据)。

### 2.2 她的目录现状(~/Dev/personal-assistant,非 git 仓)

```
.gitignore          ← 已存在且为提交而设计(secrets/logs 排除)——这个目录当初就是按"将来 git 化"设计的
README.md           ← "personal-assistant" 任务自动化说明(2026-05-27)
CLAUDE.md           ← 硬规则:绝不花钱下单、必写 run log、尊重 PREFERENCES 护栏
BELLE.md            ← 她的 persona 文档(14KB,含个人信息)
.lead/belle-lead/   ← identity.md(companion 身份)
.claude/            ← settings.local.json + skills/
belle/              ← 旧 daemon(FLY-574 已退役,留档)
memory/             ← 1 个文件(computer-monitor-purchase.md)
tasks/              ← 现有任务:meal-prep(菜单,2026-08-24 刚 bootstrap)、
                       weee-grocery(买菜)、fable-monitor;结构 = PREFERENCES.md + runbook + logs/
scratchpad/ tmp/ .mcp.json(0600) ← 不可入库的运行时/私密文件
```

定时任务现状:launchd `com.belle.daymode/nightmode/keepawake.plist`(机器级,不在仓里)。

### 2.3 tidal-echo 接入先例(issue 点名的参照)

- `scripts/setup-new-project.sh`(FLY-284)= 正典脚手架,tidal-echo 是它第一次真跑。
  前半 = 纯文件系统 scaffold(repo 骨架 + .flywheel/.lead + doc-flow);
  后半 = **founder-gated cutover checklist(只打印、不执行)**:gh repo create →
  Linear team/labels → Discord bot/token → projects.json → materialize-lead-manifests →
  flywheel-daemon install → Bridge restart → 真人验证。
- growth 先例:**复用 Linear Personal team LEARN,不建新 team**,靠 label + Linear Project
  分流;`TEAMLEAD_ISSUE_PREFIXES=FLY,GEO,LEARN` 已注册 LEARN。
- 非代码执行体先例:`growth/.flywheel/agents/reflection/reflection-executor.md`
  (docs 型 Runner、工作区约束、merge founder-gated)。

### 2.4 Belle 与 tidal-echo 接入的关键差异

| 维度 | tidal-echo(从零) | Belle(已有半个身位) |
|------|-------------------|---------------------|
| Discord bot/channel/token | 要新建 | **已有**(BELLE_BOT_TOKEN 在 .env、channel 活跃) |
| launchd 席位 | 要新装 | **已有**(com.flywheel.lead.personal-assistant-belle-lead) |
| projects.json | 要新增整个 entry | **只翻三个字段**(见 §3.2) |
| Linear team/label | 要新建 | **复用**(label "life" 已在 match 里路由给她) |
| 代码仓 | scaffold 新目录 | **目录已存在、活着、含私人数据,但不是 git 仓** |
| Lead 记忆 | 无 | **有,不能断代** |

结论:Belle 不是"新项目接入",是"**存量 companion 升格为 dept Lead + 给存量目录补 git 化**"。
照抄 setup-new-project.sh 全流程会引入不必要的迁移风险;应取它的 checklist 纪律,
跳过它的"从零建目录"。

## 3. 核心问题与选项

### Q1: 仓怎么建 —— 新目录迁移 vs 原地 git 化?

- **A. 新目录 ~/Dev/belle-workspace + 迁移**:scaffold 干净,但 projectRoot 要改 →
  manifest 重生成 + Lead cwd 变 → 会话/记忆锚点漂移;她的 home 和工作仓分裂两地
  (正是 git-workflow 规则明令避免的"split project state across two locations")。
- **B. 原地 git 化 ~/Dev/personal-assistant,远端 = xrliAnnie/belle-workspace(private)**:
  projectRoot/projectName/exact-key(personal-assistant-belle-lead)全不动 → 零记忆断代、
  零 manifest 换代、restart-ledger/lease 连续;.gitignore 已就位;代价 = 仓名≠目录名
  (cosmetic,README/config 注释写明即可)。
- **C. 双 project(保留 personal-assistant + 新建 belle-workspace project)**:
  同一 bot token 两个 Lead 席位 = 双体双听(FLY-350 事故类),直接排除。

**选 B**。founder 点名"belle-workspace 或 similar"指的是仓的身份,不是要求搬家;
记忆延续 > 目录名整齐。

### Q2: founder 要的 skills/ + archive/ 怎么和现有 tasks/ 结构共存?

现有 `tasks/<name>/{PREFERENCES.md, runbook.md, logs/}` 已经是"任务做法+产出记录"的雏形,
且 meal-prep 今天刚 bootstrap——不能推倒。映射:

- `skills/<task>/SKILL.md` = founder 说的"任务做法"终态(Claude Code skill 格式,
  Belle 和 Runner 都能直接 invoke;也是 ③"定时任务 skill 化"的落点)。
- `archive/` = 产出归档:`archive/<task>/<YYYY-MM-DD>-<slug>.md`(单次产出,如一份菜单)
  + `archive/weekly/<YYYY-Www>.md`(每周台账:这周每天做了什么,可 grep 可查询)。
- `MEMORY.md` + `memory/` = 索引 + 主题文件(沿用 flywheel memory 模式;memory/ 已存在)。
- `tasks/` 保留为 legacy,③ 随用随做逐个迁入 skills/(本单不迁)。

### Q3: 派工席位要改 flywheel 代码吗?

**机制代码不要;有一处规则内容要改。**(初稿写"零代码",Codex design R1 以源码反例
收窄:`lead-rules-base/cross-dept-channel-rules.md` 把 Belle 写死为 companion,是运行时
规则内容,须随本单更新——详见 research §1.1 [R1]。)其余席位翻转 = 纯配置。
- projects.json 三处:删 `companion: true`、`canSpawnRunners: true`、加 `projectRepo`
  (+ 补 `memoryAllowedUsers`——[R1 修正]缺失不挡 spawn,只是不注入 recall,补它是为记忆连续性);
- 她仓里加 `.flywheel/config.yaml` + `life-executor.md`(Blueprint/Runner 侧配置,
  随仓 PR 走);
- Bridge boot 自动为无 menu 项目物化六条 per-category binding(FLY-1981),无需手工;
- TEAMLEAD env 零改动(LEARN prefix 已注册;复用 "life" label → 无新 label → 无需
  founder 点头新 label)。

### Q4: 边界怎么落 —— 哪些是本单工程件,哪些是 founder/Belle 侧步骤?

issue 边界原话:"Belle 的 launcher/身份配置不归本仓管——本单产出全部工程件+接入文档,
动她配置那一步单列清单交 founder/Belle 侧确认执行。"

- **本单工程件**(implement runner 可独立完成,不碰她活体):
  ① 建 remote 仓 xrliAnnie/belle-workspace(private)+ scaffold main(skills/、archive/、
  MEMORY、.flywheel/config.yaml、life-executor、样例 skill、README/CLAUDE 重写版、
  identity.md 升级稿 as `*.proposed.md` 非冲突文件);
  ② flywheel 仓 PR:本 doc folder(设计/接入文档/cutover checklist)。
- **founder/Belle 侧清单**(checklist,含逐字命令):
  连接目录(git init + remote + 三个冲突文件 mv-aside)、projects.json 翻转、
  materialize-lead-manifests、flywheel-daemon install、Bridge restart、验证步。
- **验收②**(从 Belle 席位真派 generic 工人生成菜单并归档)只能在 checklist 执行后跑
  —— DAG 上属 QA 节点,依赖 founder 时窗,设计里明示。

## 4. 已定方向(带着进 research)

1. 原地 git 化,远端 belle-workspace,projectRoot/projectName 不动。
2. skills/ + archive/(weekly 台账)+ MEMORY 叠加在现有结构上,tasks/ legacy 保留。
3. 席位 = 配置翻转 + 一处 rules-base 文案更新(零机制代码);全部 live 动作进
   founder-gated checklist。
4. 执行体 = life-executor(仿 reflection-executor,继承她 CLAUDE.md 硬规则:
   绝不花钱、必写日志、产出必归档)。
5. Linear 复用 LEARN + "life" label,零新 label。
