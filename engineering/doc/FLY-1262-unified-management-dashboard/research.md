# FLY-1262 统一管理台 — 调研
Issue: FLY-1262 (https://linear.app/geoforge3d/issue/FLY-1262/build-flywheel-统一管理台fly-1038-prd-落地-ssot-自动发现-统一提交流落盘6-硬约束为核心验收)
日期: 2026-07-14
基于: exploration.md

## Executive Summary

调研结论不是“从零建 dashboard”，而是把现有 Fleet Console 从若干拼接区块升级为一个有统一 contract 的 management control plane：

1. 当前 Bridge 已有合格的 loopback security、secret-free DTO、single-use confirm token、audit、Lead batch journal 与 config/flag writers；复用它比另建服务安全。
2. 当前 read model 不完整：live snapshot 有 16 Leads、91 flags、6 runner defaults，但通用 cron 为 0，DAG 也没有接 workflow catalog。
3. 自动发现不能依赖命名约定。真实 `com.xiaorongli.weee-weekly` 证明 label prefix 会漏；同时大多数 Flywheel job 的 argv[0] 只是 `/bin/bash`，只看首参数也会漏。正确归属必须扫描 plist 内所有 absolute path candidates，再按 registered project root 做最具体匹配。
4. model options 当前散在 `model-tiers.ts`、`three-stage-phases.ts`、`fleet-capabilities.ts`、executor backend types；需要一个 runtime 与 UI 共用的 canonical registry。
5. FLY-1135 workflow template catalog 已在开放 PR #593 提供 append-only revision、publication CAS 和 read API；DAG tab 必须直接消费这套 DB，不得另造 config 版真源。
6. 跨 source 提交不是全局 ACID。可保证的是：首写前全量 preflight、每个 writer 内部原子/CAS、能补偿处回滚、durable per-item result；不能保证的 process side effect 必须显示 partial。
7. Lead 已拍板：v1 不做跨 provider managed cutover。当前 company/provider 只读显示，控件灰掉且服务端拒绝；同 backend model/effort 继续可写。

## Research Method

本调研只使用可复核的真实来源：

- PRD 与 prototype 文件；
- 当前 worktree 的 config/teamlead/comm 源码与测试；
- `~/.flywheel/projects.json` 的 secret-free 投影；
- 六个 registered project 的 `.flywheel/config.yaml` 结构；
- live Bridge 的 loopback `/api/fleet/snapshot`；
- `~/Library/LaunchAgents/*.plist` 的 Label、Program/ProgramArguments path 与 `StartCalendarInterval`，不读取/输出 token 或 env value；
- FLY-1135/FLY-1256/FLY-1259 已提交到各自 branch 的设计/代码，以及 GitHub PR #593 当前状态。

没有使用 LM 去判断某个脚本“像不像 cron/LLM task”，也没有把原型静态数组当事实。

## 1. Current Fleet Console Substrate

### 1.1 Read path

| Evidence | Current behavior | Reuse / gap |
|---|---|---|
| `packages/teamlead/src/bridge/fleet-console.ts:64-127` | `FleetConsoleOptions` 接 live projects、flags、runner defaults、cron model providers；runner options 来自 config constants | provider seam 可复用；DTO 仍是平铺 extras |
| `fleet-console.ts:182-211` | 每次 build snapshot 从 live projects 与 providers 聚合，再用 fleet evidence 加 online 状态 | 已是投影而非持久副本；需扩成 versioned source-aware DTO |
| `packages/teamlead/src/bridge/fleet-console-model.ts:28-59` | Lead DTO allowlist，不暴露 `botToken` 等 hydrated config | 必须保留 secret-canary contract |
| `fleet-console-model.ts:123-143` | snapshot 顶层有 leads/flags/runner defaults/cron models/capabilities | 缺 projects/agents/DAG/general cron/source revision/error contract |
| `packages/teamlead/src/bridge/plugin.ts:1309-1324` | `GET /api/fleet/snapshot` loopback-only，读取前 refresh project config | 满足“一个 endpoint”的地基 |

live endpoint 只读实测：

```json
{
  "leadCount": 16,
  "leadProjects": [
    "flywheel",
    "geoforge3d",
    "growth",
    "joycon-typeless",
    "personal-assistant",
    "tidal-echo"
  ],
  "flagCount": 91,
  "runnerDefaults": 6,
  "cronModels": 0
}
```

这证明 topology/flags/config 的现有 provider 可用，也证明 cron 不能沿用 `cronModels` 的“仅特定 collection”视图。

### 1.2 Write path

| Evidence | Guarantee | Limitation |
|---|---|---|
| `packages/teamlead/src/bridge/plugin.ts:1411-1535` | Lead、flag、runner 均有 loopback+same-origin stage/apply | 三套 endpoint；client 负责 fan-out |
| `packages/teamlead/src/bridge/fleet-admin.ts` | canonical request + confirm token | 目前 canonical shape 偏 Lead batch |
| `packages/teamlead/src/bridge/fleet-admin-audit.ts` | durable audit，stage/apply fail-close tests 已存在 | 需扩展 target kind 与 per-item outcome |
| `packages/teamlead/src/bridge/fleet-progress.ts` | journal → SSE progress | 可承接长时 restart/reload；需通用 operation result |
| `packages/config/src/runner-config-writer.ts` | YAML Document 保注释、ConfigLoader validate、same-dir rename、lock、expected SHA | 适合 project config writer provider |
| `packages/teamlead/src/bridge/flag-routes.ts` | direct flag 的 `.env` 安全写 + stale guard | 只允许 registry 证明 call-time direct 的 flag |
| `scripts/flywheel-fleet.sh` | Lead model/effort journal、recover、精确 restart | backend diff 明确 UNAPPLIED/manual cutover |

`fleet-console-html.test.ts:31-110` 说明现状已经有一个 client draft/counter，但 `runApplyUnified` 仍依次调用 Lead、runner、flag 的 route；cron 还是 copy command。这满足“一个按钮”，不满足“服务端统一 preflight 与写回”。FLY-1262 必须把 fan-out 移到 Bridge，浏览器只认识一对 stage/apply。

### 1.3 Existing security boundary

`plugin.ts:1286-1307` 的安全边界值得保留：

- Host 必须解析为 loopback self-origin，防 DNS rebinding；
- write 请求必须 same-origin，防 CSRF；
- 浏览器不持有 `TEAMLEAD_API_TOKEN`；
- apply 还需 single-use confirm token；
- DTO 使用 allowlist，不直接序列化 `LeadConfig`。

统一管理 API 不应因为“只有 Annie 使用”而降低这条边界。未来 extension provider 也必须走相同 stage/apply，不允许自挂无审计写路由。

## 2. Topology, Project Grouping and Agent Links

### 2.1 True sources

`packages/teamlead/src/ProjectConfig.ts` 从 `~/.flywheel/projects.json` 加载 project roots 与 Leads；`packages/config/src/ConfigLoader.ts` 读取每个 root 的 `.flywheel/config.yaml`、`agents`、`roles`、`pipeline`。

live `projects.json` 有六个 project、16 Leads：

- flywheel：5 Leads，其中两个 `department=infra`；
- tidal-echo：3 Leads，其中 `sub-lead` 本来就在 tidal project 内；
- 其余 geoforge3d、joycon-typeless、growth、personal-assistant 均从 registry 自动出现。

因此 presentation grouping 不需要静态 project list：

- 普通 Lead/role 按 `projectName` 分组；
- `department=infra` 派生 `presentationGroup=infra`，但 DTO 保留 source project；
- `sub-lead` 自然留在 tidal-echo，不用在 UI 写特殊 id 分支。

### 2.2 Agent cards

`packages/config/src/types.ts:123-154` 的 `AgentConfig` 有 `agent_file`、department(s)、match；当前没有 per-agent model 字段。DAG tab 的角色卡应从这里自动产生。

GitHub link 生成必须有真实 repo identity：

1. 优先使用 `projects.json.projectRepo`；
2. 若缺失，可只读解析 project root 的 origin remote 并规范化 GitHub slug；
3. 无 GitHub remote（当前 personal-assistant 即无）时返回 `link:null` + 诊断，不能拼一个不存在的 URL；
4. `agent_file` 必须先经过 ConfigLoader 的 repo-relative path guard，再 URL encode。

角色卡与 workflow stage 是两个维度：roles 来自 project config；真正可编辑的 stage model 来自 workflow template manifest。不能因为 agent card 上显示 model 就把一个不存在的 per-agent override 写进 config。

## 3. Canonical Model Registry Gap

### 3.1 Current split

| Source | Facts it owns today | Missing |
|---|---|---|
| `packages/config/src/model-tiers.ts` | Claude Fable/Opus/Sonnet/Haiku tier、alias、1M selectors、display helpers | provider、effort、Codex model capability |
| `packages/config/src/three-stage-phases.ts` | default phase `{vendor,model,effort}`，Codex `gpt-5.6-sol/xhigh` | dropdown catalog、aliases across provider |
| `packages/teamlead/src/bridge/fleet-capabilities.ts` | Lead-specific Claude options、backend eligibility、effort options | 与 config registry 重复；Codex Lead model 仍 display-only |
| `packages/config/src/types.ts:546-595` | executor backend ids、RoleEffort | backend 不等于 model provider；comment 与 phase Codex effort 已出现 drift |

生产 registry 应至少描述：

- provider id + 中文/英文 display label；
- canonical model id、aliases、display label；
- allowed efforts；
- supported surfaces/backends（Lead Claude、runner Claude/Codex、workflow node 等）；
- current-only legacy values 的显示规则；
- optional context selector（如 `[1m]`）但不把它伪装成新 provider。

runtime boundary（dispatch validation、workflow manifest validation、Fleet capability）与 UI 必须从同一 registry 派生。一个 registry entry 新增后，snapshot 的 model catalog 自动多一项；若只是 UI options 数组改变而 runtime 不认，验收应失败。

当前真实 registry 没有可选择的 Google model；原型写的 “Google / …” 只是形态例子。生产 company dropdown 只能显示 registry 真有且 target writer 支持的 provider，不能为填满原型造选项。

### 3.2 Lead boundary ruling

`fleet-capabilities.ts:150-179` 明确所有 non-current Lead backend `switchable:false`；`flywheel-fleet.sh` 也拒绝 backend diff。Lead 裁定 v1 保持这条事实：

- 当前 provider/company 显示但 disabled；
- company 变化不产生 draft；
- server 对伪造 backend change 同样拒绝；
- 同 backend model/effort 使用现有 capability + writer；
- runner/workflow target 仍可从 registry 选择其真实支持的不同 provider。

这比“UI 可选、提交后给 manual note”更符合 §6：不可写就不承诺写。

## 4. DAG SSOT and PR #593 Dependency

### 4.1 Approved data model

`engineering/doc/FLY-1135-layer1-dag-templates/plan.md:244-274` 已决定：

- template edit 总是新 revision；
- published revision 在 run admission 选择一次并物化 snapshot；
- running run 不随模板编辑改变；
- publication 是 append-only row + CAS current pointer；
- FLY-1038 Dashboard 直接消费同一表/API，不另造数据层。

### 4.2 Code already present on open dependency

PR #593（调研期间 head 仍在移动，当前 CI Build & Test 绿色且尚未 merge；本单不 pin 某个 SHA）包含：

- `packages/teamlead/src/workflow-template.ts`：schema v1、node `{vendor,model,effort}`、manifest/override validation、seed import；
- `StateStore.ts` 的 `workflow_template`、`workflow_template_revision`、`workflow_template_publication`、binding、audit 表与 append-only triggers；
- `createWorkflowTemplateRevision`、`publishWorkflowTemplate(expectedRevision)`；
- `/api/workflow/templates*` loopback read routes；mutation route 故意未开放。

FLY-1262 需要补的不是 catalog，而是 management adapter：

1. snapshot 把 project/category binding、current published revision/digest 与 manifest nodes 投影成 DAG view；
2. stage 以 template id + base revision/digest + node id 定位，不接受客户端整份 manifest 为权威；
3. server 从 current manifest copy，只改允许字段，再用 canonical model registry 完整复验；
4. apply 必须在一个 StateStore transaction 内做 expected-current check、append revision、append publication、CAS pointer、audit；避免“先 create 后 publish conflict”留下用户看不懂的 orphan revision；
5. existing run snapshot tests证明旧 run 不变，新 admission 才使用新 revision。

依赖没进 main 时，Implement 可以先完成 model/cron/snapshot contract，但不能复制 PR #593 的 schema 或临时实现 config override。

## 5. Launchd Discovery Evidence

### 5.1 Scheduled plist inventory

只读扫描当前 `~/Library/LaunchAgents/*.plist`，带 `StartCalendarInterval` 的至少有：

| Label | Absolute project script candidate | Schedule | Expected grouping |
|---|---|---|---|
| `com.flywheel.daily-standup` | `.../Dev/flywheel/scripts/daily-standup.sh` | daily 03:00 | flywheel |
| `com.flywheel.growth-{learn,improve,report,retro}` | `.../Dev/tidal-echo/sub/content/scripts/...` | daily/weekly | tidal-echo |
| `com.flywheel.sub-create-nightly` | `.../Dev/tidal-echo/sub/content/scripts/...` | Mon-Fri 01:00 | tidal-echo |
| `com.flywheel.token-usage-daily` | `.../Dev/flywheel/scripts/token-usage-daily.sh` | daily 00:30 | flywheel |
| `com.flywheel.updater` | `.../Dev/flywheel/scripts/update-flywheel.sh` | daily 06:00 | flywheel |
| `com.xiaorongli.weee-weekly` | `.../Dev/personal-assistant/tasks/weee-grocery/scripts/run-weekly.sh` | Wed 09:00 | personal-assistant |
| Adobe / CleanMyMac / chezmoi / belle jobs | 不在 registered project root | 各自 | Unassigned/Unmanaged |

关键反例有两层：

1. `weee-weekly` label 不以 `com.flywheel` 开头；label filter 会漏。
2. 多数 Flywheel job 的 `ProgramArguments[0]` 是 `/bin/bash`，真实 project path 在后续 arg；argv0-only 也会漏。

### 5.2 Discovery algorithm

对每个 plist：

1. `lstat`，拒绝 symlink/非 regular file 进入 writable surface；read path仍返回诊断。
2. 用 `/usr/bin/plutil -convert json -o - <path>` 解析；不自己写 XML parser。
3. 只要有 `StartCalendarInterval` 就进入 scheduled inventory，不按 Label 筛。
4. 收集 `Program` 与全部 `ProgramArguments` 中绝对 path；对存在 path 做 realpath，保留原 path 供显示。
5. 对每个 candidate × registered root 做 path-segment-aware containment；选择最深 project root 内的最具体 candidate。
6. 无匹配 → Unassigned/Unmanaged；多 project 同样具体或 path escape → ambiguous error，默认不可写。

这套算法不会把 Adobe/CleanMyMac 混入 Flywheel project，也不会漏 shell wrapper 后面的真实脚本。

### 5.3 Schedule normalization

原型只允许 weekly Cartesian 语义：`days × times`。launchd 真源还可表达 monthly/day-of-month、wildcards 等更宽语义。可逆编辑范围应是：

- `StartCalendarInterval` 为 dict 或 array；
- 每项只有 Weekday/Hour/Minute；
- Hour、Minute 必须存在且在范围内；
- Weekday 缺失可规范成全周；0 与 7 都读作 Sunday→ISO 7；1..6 对应 Mon..Sat；
- 所有 dict 集合必须恰等于某个 unique days × unique times 的笛卡尔积；
- duplicate dict 可读时去重并给 warning，写回 canonical array；
- 出现 Month/Day/Second、缺 Hour/Minute、非 Cartesian sparse set → `scheduleWritable:false`，原结构原样保留。

派生标签只由 normalized days 计算：7 天=每日，1..5=工作日，6..7=周末，其余=自定义。

### 5.4 Runtime state

plist 声明、persistent disable override、当前是否 loaded 是三个不同事实：

- `launchctl print-disabled gui/$uid` 给 explicit disable/enable override；当前输出只列显式 override，目标 label 缺席不能当作 loaded 证据。
- `launchctl print gui/$uid/$label`（或一次 list snapshot）决定 loaded 与 last exit/pid evidence。
- plist 中 `Disabled` 若存在也要显示，但 write path 以 launchctl domain override 为运行时 authority，不能只改 XML key。

DTO 应分别暴露 `declaredSchedule`、`enabled`、`loaded`、`runtimeError`，不压成一个绿色圆点。

### 5.5 Model binding

当前 scheduled plists 没有统一的 `--model` argument 或 MODEL/EFFORT/BACKEND env key。脚本是否内部调用 LLM 不能靠文件名/源码 heuristic，更不能让 LM 扫脚本后喂前端。

所以：

- cron **发现与显示**对所有 scheduled plist 自动成立；
- model edit 只在 job 有 machine-readable binding 时开放；
- 可自动识别的 binding 包括规范 `--model <id>` argv pair 或未来统一 env carrier；
- model 真值在 project config/专用 registry 时，由 source provider 暴露 typed binding；
- 无 binding 的 job 显示“未声明模型载体”，不猜、不隐藏 cron；
- 新 LLM cron 的创建契约应要求同时声明 binding，但这不是 frontend 聚合名单。

## 6. Launchd Write and Rollback Contract

### Stage

- target 只接受 server snapshot 产生的 stable id；client path/label 不作 authority。
- 重读 exact plist bytes，计算 SHA-256；验证 uid、regular file、LaunchAgents containment、Label 唯一性。
- schedule edit 重建 `StartCalendarInterval`，保留其他 keys；enable edit 只改变 desired runtime action。
- 用 injectable plutil 生成候选 temp 并 lint；stage 不覆盖正式文件、不调用 launchctl。
- canonical item 带 old normalized value、new normalized value、raw file SHA、prior disabled/loaded state、consequence `reload-launchd`。

### Apply

1. 同一 management lock 下重读 bytes/SHA 与 runtime state；drift → 首写前拒绝。
2. 若 schedule 变且当前 loaded，`bootout gui/$uid/$label`。
3. same-dir temp write、fsync、`plutil -lint`、保留 mode/uid/gid、atomic rename。
4. 根据 desired enabled 运行 `launchctl enable|disable`；enabled 时 `bootstrap gui/$uid <plist>`。
5. 用 `launchctl print`/`print-disabled` 验证 desired state。
6. 任一步失败：恢复 exact before bytes（若文件已换）、恢复可恢复的 enable/load 状态、再验证；journal 记录 original error + rollback result。

“bootstrap command exit 0”不是成功证据，verify 才是。对未 loaded 但 enabled 的 calendar job，bootstrap 后不要求有 PID；只要求 domain 注册成功。

## 7. Feature Flag Boundary

live 91 flags 按现有 registry 分类：direct 11、conversational 42、readonly 38。它们都必须显示，但写能力不同：

| Registry capability | v1 UI | Apply |
|---|---|---|
| direct/call-time boolean | enabled toggle | existing safe env/config writer，标准确认 |
| dedicated writer + restart/reload consequence | enabled toggle，红色确认组 | provider-owned detached operation；不能 generic toggle |
| conversational but no dedicated writer | disabled toggle + 中文原因 | server refuse |
| governance/dormant/value without editor | disabled toggle + 中文原因 | server refuse |
| project-scoped resolver | project override controls | config writer + effectiveByProject refresh |
| global-only | project override 显示不适用 | 不创建 runtime 不读的假值 |

统一管理层需要把现有 `toggleable` 映射成通用 `writeCapability`/`consequence`；不需要为了原型观感把 80 个非 direct flag 误改成网页热切。

新 flag 的自动出现由 registry iteration 保证。实现测试应注入一个新增 FlagView 并证明 snapshot/UI 无名单修改；registry drift test继续保证运行时 flag 不登记就 CI 红。

## 8. Unified Change Coordinator

### Client request

```ts
type ManagementChange = {
  targetId: string;
  desiredValue: unknown;
  observedRevision: string;
};
```

client 不发送 file path、project root、current value、writer kind 或 consequence；这些均由 server target resolver 决定。

### Canonical staged item

```ts
type CanonicalManagementItem = {
  targetId: string;
  kind: "lead" | "runner" | "dag" | "cron" | "flag" | "extension";
  from: unknown;
  to: unknown;
  sourceRevision: string;
  consequence: string;
  requiresAcknowledgement: boolean;
  writerId: string;
};
```

stage 要在同一锁内 resolve 所有 target、检查互相冲突（例如同一 plist 两种 schedule edit 合并）、运行全部 writer preflight，再写 audit 和发 token。apply consume token 后再次全量 preflight。这样不会出现“第一个 domain 已写，第二个才发现 SHA stale”的可避免 partial。

### Atomicity boundary

| Layer | Promise |
|---|---|
| SQLite DAG mutation | one transaction + expected current CAS |
| one YAML/.env/plist file | same-dir atomic replace + file SHA CAS |
| Lead batch | existing durable engine + exact per-Lead journal |
| launchd/restart runtime | verified side effect + compensation attempt |
| whole mixed batch | **not ACID**；per-item durable outcome + explicit partial |

固定顺序应按“可逆文件/DB commit → 需要 runtime side effect 的 writer”分组，但不要跨独立 target 遇错全停：首写后的失败继续执行还是停止，必须由 canonical plan policy 固定。沿用 FLY-709 P5 已批准的原则：独立 group 可继续，最终摘要明确 partial；同一个 target 的后续 step 失败则立即进入该 target rollback。

## 9. Extension Contract

FLY-1256 与 FLY-1259 证明 extension 不是“随便加 iframe”，而是新 source/writer provider：

- FLY-1256 source = `~/.flywheel/quota-monitor.json`；loader 已定义阈值/轮询/order 的跨字段校验，每 tick 重读，dashboard 未来只调用同一 loader/writer。
- FLY-1259 source = per-dispatch request + locked session field，不是一个可随意落盘的全局 default。未来 tab/section 必须区分“设置下次 dispatch 输入”与“改当前 run”。

v1 可交付一个 generic section descriptor（boolean/number/select/order-list + capability + revision）和 provider registration seam；零 provider 时不显示空 tab。测试注册 fake section，证明：snapshot 自动出现 section、generic renderer 自动出现 tab、change 走统一 stage/apply。未来接 1256/1259 不改核心 UI change flow。

## 10. Prototype Shape Mapping

| Prototype shape | Production data/behavior |
|---|---|
| 实例 / Feature Flags nav | 同一 HTML shell 的两主页；都来自一个 snapshot |
| project list + search | snapshot projects/presentationGroups；无静态 names |
| model cascade | canonical model catalog + target capability |
| DAG role cards | project config agents + repo link；stage controls来自 workflow catalog |
| cron weekdays/times | launchd normalized weekly Cartesian schedule |
| cron enabled | launchctl disabled + loaded state，非 plist existence |
| flags cards | registry FlagView + write capability/effectiveByProject |
| sticky pending bar | one client draft over target ids |
| old→new modal | server canonical stage response，不信 client current value |
| confirm apply | one management apply endpoint + SSE per-item result |

Production UI source必须有 sentinel：不得出现 `com.xiaorongli.weee-weekly`、真实 project/Lead ids、手工 `PROJECTS`/`FLAG_GROUPS`/`VENDORS`。这些字符串只允许在 test fixture/acceptance docs 中作为反例。

## 11. PRD §8 Final Answers

供 Product Lead 回填 PRD：

1. **SSOT 形态**：Bridge 内一个 versioned aggregate snapshot API；它是可重建投影，不复制持久数据。每项携带 provenance/revision/capability/error。
2. **写回边界**：一个统一 modal。hot/new-run 标准确认；restart/reload 等在同一 modal 高风险分组额外勾选；governance/dormant/无 dedicated writer 只读。Lead 跨 provider v1 明确只读。
3. **cron 写回**：plist 原文件为真源，plutil render+lint、same-dir atomic replace、launchctl enable/disable/bootout/bootstrap、post-action verify；失败恢复 exact bytes 与 prior runtime state，无法恢复处报 partial。

## 12. Verification Implications

### Automated proof required in Implement

- source/provider unit tests；
- arbitrary-label + shell-wrapper argv1 cron fixture；
- new Lead/new flag/new cron → snapshot/UI 自动多项；
- one aggregate read + one stage/apply pair，生产 client 无 domain fan-out；
- model registry drift/incompatibility；
- DAG revision CAS + pinned old run；
- cron schedule property matrix、symlink/path escape、plutil/launchctl failure rollback；
- confirm token replay、audit failure、any-source preflight drift → zero first write；
- mixed result summary明确 partial；
- secret canaries与 loopback/DNS rebinding/CSRF tests。

### Independent QA proof required on same issue

1. Claude-in-Chrome 逐屏对照 prototype，覆盖两主页、分组、cascade、DAG、cron、flags、满高布局、贴底 pending bar、modal/discard。
2. 真机 live snapshot 与真实 projects/config/registry/plist/launchctl 抽样逐项对账。
3. 隔离注册一个任意 label 的 real LaunchAgent（label 不含 `com.flywheel`，script path 位于 scratch registered project），验证自动出现、schedule 写回、disable/enable、cleanup。
4. 隔离 Bridge/project registry 新增 Lead/flag fixture，证明无需改 UI。
5. 旧值→新值 modal 来自 server canonical response；改真源造成 stale 后 apply 必须拒绝且首写为零。
6. PRD §6 四条逐条给证据，不用“页面看起来对”代替架构验收。

## 13. Residual Risks for Plan

| Risk | Plan requirement |
|---|---|
| PR #593 合入时 API/head 可能变化 | DAG task前用 symbol/test gate核当前 main；按实际 API 集成，不 pin旧 SHA |
| generic section schema 过度设计 | 只支持 1256 已需的基础 field kinds；DAG/cron 继续专用 view |
| launchd writer真机副作用 | IO 全注入单测；QA 只用唯一 scratch label + exact cleanup |
| current cron 无 model binding | 自动显示不受影响；模型控件诚实只读，新增 typed binding contract |
| personal-assistant 无 GitHub remote | link null + visible diagnostic，不伪造 URL |
| full repository tests受环境 flake | focused tests先给因果证据；全量失败逐项归因，不能用“已知 flake”口头跳过 |
| visual review unavailable in design runner | QA phase 的 Claude-in-Chrome 是硬交付，不在 design 声称替代 |
