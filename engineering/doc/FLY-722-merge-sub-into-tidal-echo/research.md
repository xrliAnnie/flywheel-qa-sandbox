# FLY-722 合并 Sub → Tidal Echo — 调研

Issue: FLY-722 (https://linear.app/geoforge3d/issue/FLY-722/org-合并-sub-tidal-echo取消-sub-coresub-变-ariel-平级内容-lead归-triton)
日期: 2026-07-03
基于: exploration.md

---

本文档 = 每一面的**精确证据**(ID / 路径 / 代码行 / 机制)。plan.md 基于此。

## 1. 运行时配置(machine-local,非 git-tracked)

`~/.flywheel/projects.json` 不在任何 repo 里(只有 `fleet/example/projects.json` 是示例)。改它 = **live/不可逆生产编辑**,须 Annie 在场(FLY-175),同 `doc/engineer/onboarding/tidal-echo/CUTOVER.md`。

### `sub` project(现状,逐字)
```jsonc
{
  "projectName": "sub",
  "projectRoot": "/Users/xiaorongli/Dev/sub",
  "projectRepo": "xrliAnnie/sub",
  "memoryAllowedUsers": ["annie", "sub-lead", "sub"],
  "leads": [{
    "agentId": "sub-lead",
    "chatChannel": "1511267947551653918",      // #sub
    "alertChannel": "1511267947551653918",      // #sub
    "match": { "labels": ["Sub"] },
    "botTokenEnv": "ASHA_BOT_TOKEN",
    "canSpawnRunners": true,
    "department": "content",
    "model": "claude-opus-4-8[1m]"
  }],
  "generalChannel": "1511889248003952641"        // #sub-core (被砍)
}
```

### `tidal-echo` project(现状,3 lead 目标态 = 加 sub-lead)
- `tidal-echo-cos-lead`(Triton):`chatChannel/generalChannel = 1517041708855197908`,`match.labels: ["Tidal-Echo-Triage"]`,`canSpawnRunners: false`,`TRITON_BOT_TOKEN`
- `tidal-echo-content-lead`(Ariel):`chatChannel = 1517041986358611998`,`match.labels: ["Tidal-Echo"]`,`department: content`,`canSpawnRunners: true`,`ARIEL_BOT_TOKEN`
- `projectRoot: /Users/xiaorongli/Dev/tidal-echo`,`memoryAllowedUsers: ["annie","tidal-echo-cos-lead","tidal-echo-content-lead","tidal-echo"]`

### schema 约束(`packages/teamlead/src/ProjectConfig.ts`)
- `ProjectEntry`(L191-210):`projectName / projectRoot / projectRepo? / leads[] / generalChannel? / memoryAllowedUsers? / linear?`。
- `LeadConfig`(L7-150):`agentId / chatChannel / match.labels / botTokenEnv / alertChannel / alertFallbackToCore / canSpawnRunners / department / companion / model / backend / codexProfile / effort`。
- **❗ `LeadConfig` 没有 `projectRoot` / `subdir` / `root`**。`projectRoot` 只在 `ProjectEntry` 级 → **一个 project 里所有 lead 共享同一 `projectRoot`**。

## 2. projectName → projectRoot(岔口的代码根因)

`packages/teamlead/src/bridge/run-infra.ts` L656-662:
```ts
projectRuntimes.set(project.projectName, {
  blueprint, projectRoot: project.projectRoot, tmuxSessionName, ...
});
```
`/api/runs/start` 用 `projectName` 查 `projectRuntimes` → 取该 project 的 `projectRoot` 建 worktree/blueprint。**没有 per-lead 覆盖路径**。

⇒ cron 传 `projectName:"sub"` → runner 跑在 `/Dev/sub`(pipeline 代码所在)。若 project 删了或改成 tidal-echo,runner 跑错目录 → **自治死**。这是 exploration §4 的岔口。

## 3. FLY-127 dept-scope 检查(第二重交互 — cron 会被 relabel 打死)

`packages/teamlead/src/bridge/runs-route.ts`:
- L71-72 `isDeptScopeRejectEnabled()`:env `BRIDGE_DEPT_SCOPE_REJECT`,**default ON**。`~/.flywheel/.env` 未设 → **生产是开的**。
- L296-308:`leadId` 必须属于该 project(否则 403)。
- L329-357:pre-flight 拉 issue labels。
- L402-434:`departmentRegistry.isLeadInScope(projectName, leadId, issueLabelNames)`,不 allowed → 403 `DEPT_SCOPE_REJECT`。

**cron-trigger issue 标签实测**(`Sub`):
- LEARN-123(sub-create nightly,UUID `c7d63e46-fd29-4f47-86e9-90584a00cac0`):labels `["no-qa","Sub"]`,In Progress,7+ 每日产出 PR(→ xrliAnnie/sub)。
- LEARN-80(daily-loop,UUID `da40694f-bd38-46f5-b227-b3ef677eef0d`):labels `["no-qa","Sub"]`,In Progress,11+ 每日产出 PR。

⇒ cron 现在 `isLeadInScope("sub","sub-lead",["no-qa","Sub"])` = 通过。**若把这两个 cron-trigger issue relabel `Sub`→`Tidal-Echo`,检查变 `isLeadInScope("sub","sub-lead",["Tidal-Echo"])` → sub project 只有 sub-lead(scope Sub)→ 不在 scope → 403 → cron 死。**

**结论(plan 硬约束):所有自治/机器 issue 必须留在 `Sub` scope —— 不 relabel、不搬 team。含 LEARN-123 / LEARN-80(nightly triggers)+ LEARN-120(growth-improve parent)+ growth-improve 自动生成的子 issue + LEARN-177(DR trigger,现 dormant)。只搬/relabel 真正的 org-facing 内容 issue(LEARN-141/142/143…)。**(见 §4b:自治面比想象大)

## 4. 两个 cron 的死写参数(`/Dev/sub/content/scripts/`)

`sub-create-nightly-tick.sh`(LEARN-122):
```
ISSUE_ID="c7d63e46-..."      # LEARN-123
PROJECT="sub"; LEAD_ID="sub-lead"
REPORT_CHANNEL="1511889248003952641"   # #sub-core (被砍!)
POST /api/runs/start {"issueId":ISSUE_ID,"projectName":"sub","leadId":"sub-lead"}
flywheel-comm send --project sub --from sub-lead --to <exec> "<brief>"
```
`sub-daily-loop-tick.sh`(LEARN-23/80):同结构,`ISSUE_ID="da40694f-..."`,同 `PROJECT/LEAD_ID/REPORT_CHANNEL`;多一层 LEARN-124 ghost-session 自愈。

**brief 文本里也嵌了 `$REPORT_CHANNEL` + 「#sub-core channel」+ 相对路径 `content/scripts/suno-daily-loop.py`、`content/scripts/sub_create_nightly_runlog.py`** —— 这些相对路径只在 `/Dev/sub` 下有意义。

`flywheel-comm send --project sub` 解析 comm DB = `~/.flywheel/comm/sub/comm.db`(存在)。改 projectName 会改 comm DB 路径。

## 4b. Sub 自治面 = 6 条 cron(不止 2 条!Codex R1 抓漏)

除 §4 两条 nightly,`/Dev/sub` 还有一整套 **growth-loop**(LEARN-150,Annie 2026-07-01 全激活 / LEARN-168):

| launchd label | 时间(PDT) | 源脚本 `/Dev/sub/content/scripts/` |
|---|---|---|
| `com.flywheel.growth-learn` | 04:30 | `growth-learn-tick.sh` |
| `com.flywheel.growth-improve` | 05:00 | `growth-improve-tick.sh` |
| `com.flywheel.growth-report` | 17:00 | `growth-report-tick.sh` |
| `com.flywheel.growth-retro` | Sun 17:30 | `growth-retro-tick.sh` |

`/Dev/sub/growth/config.json`:
- `activation`:`growth_loop_active / autonomous_publish / growth_crons_active / improve_engine_active` **全 = true**(实激活)。**回滚 = 两个 flag 设回 false**(+ 可 launchctl unload plists)。
- `report.channel_id: "1511889248003952641"`(= **#sub-core**,将被砍)+ `report.project: "sub"`。
- `dr.trigger_issue_id: ""`(DR 腿 dormant,LEARN-177 UUID `9cb2f507-...`,现安全 no-op)。
- `publish_gate.lead: "sub-lead"`(Asha shutter)。

**growth-improve 会真建 Linear issue + spawn Asha runner**(与 org 迁移直接冲突):
- `growth_improve.py resolve_ids()` 默认 team=**Personal**、label=**Sub**、parent=**LEARN-120**(L198-211),`improve_engine_active:true` 时真建主 issue + ship 子 issue(带 `Sub` label)。
- `growth-improve-tick.sh` L75:`POST /api/runs/start {"issueId":"$ISSUE","projectName":"sub","leadId":"sub-lead"}`。
⇒ 这些自动生成的 issue 若被 relabel `Tidal-Echo` → 同 §3 dept-scope 403。**故 LEARN-120 + growth-生成 issue 也必须留 `Sub` scope**(硬约束扩展)。

**报告 channel 消费者(删 #sub-core 前都要迁 / 停)**:
- `sub-create-nightly-tick.sh` + `sub-daily-loop-tick.sh`:`REPORT_CHANNEL=1511889248003952641`(§4)。
- `growth/config.json`:`report.channel_id=1511889248003952641`。
- `growth_policy.py` L19:`REPO_DEFAULT_CHANNEL="1511889248003952641"`(**代码级默认**,即使 config 设了也是 fallback)。
- `growth_report.py --deliver`:把 policy 解析的 channel 显式传 `--channel` 给 `flywheel-comm publish-report`(L349)。改 `sub.generalChannel` **救不了这个显式 --channel**。

## 4c. reply-guard 语义变化(Phase 3 副作用,Codex R1 #4)

把 `sub.generalChannel` 改成 `= sub-lead.chatChannel`(#sub)后,#sub 会被 `classify()` 判成 **core-channel**(先于 channel-top-level;`packages/teamlead/src/bridge/tools.ts:1183`),而 core-channel **一律放行 issue token**(`reply-guard.ts:94`;测试 `__tests__/reply-guard.test.ts:440` 覆盖 generalChannel==chatChannel 时 core 豁免优先)。即 **#sub 顶层发 issue 号从「被拦」变「放行」**。Asha 现有 memory/规则把 #sub-core 当 core、#sub 顶层 issue 号当拦 —— cutover 要**更新 Asha memory + 加一条 restart 后 reply-guard 探针**(projectName=sub, leadId=sub-lead, chatId=#sub)。

## 5. 其它运行时残留(re-home 清单)

- manifest:`~/.flywheel/manifests/sub-sub-lead.json`(`projectName:"sub"`,`projectDir:/Dev/sub`,pid,model)。launchd label = `com.flywheel.lead.sub-sub-lead`。
  - 方案 A 下:sub-lead 仍属 `sub` project → manifest/label **不变**。
  - 方案 B 下:变 `tidal-echo-sub-lead.json` + label `com.flywheel.lead.tidal-echo-sub-lead`(kill 旧 + 装新 = re-identify 活 Asha,不可逆)。
- roundtable-registry:`~/.flywheel/roundtable-registry/sub-lead.json`(`channelIds:["1512578695468941333"]` = #leads-roundtable)。leadId 键不变则不动。
- launchd cron:`com.flywheel.sub-create-nightly` + `com.flywheel.sub-daily-loop`(指 `/Dev/sub/content/scripts/*`)。org-first + 方案 A:脚本路径**不动**,只改脚本内 `REPORT_CHANNEL`。
- `~/.flywheel/comm/sub/comm.db`:方案 A 保留(projectName 不变)。

## 6. Linear 搬迁机制

- Sub:team **Personal**(`d4c5bc90-3180-4a13-b5de-03eb7b36669f`)/ project **Sub**(`abc9d2fb-1dac-43fd-a06f-8508f6f95d22`)/ label `Sub`。
- tidal-echo:team **Tidal Echo**(`1fdf37d6-ade4-4ec1-b14a-71b9f4610602`,key TIDE)。
- 搬 team:issue **UUID 稳定**、**key 变**(LEARN-NN → TIDE-NN)。因 cron 用 UUID 引用 → cron issueId 不受 key 变影响(但见 §3:标签 scope 才是 cron 的真风险,故 cron-trigger issue 干脆不搬)。
- label `Sub` 是否 team-scoped:搬 team 可能丢 label → 需显式设 `Tidal-Echo`(Annie 决策 #1 本就要 relabel)。
- 机制:Linear MCP `save_issue`(改 team/project/labels)。批量搬 = 不可逆(key 变,旧 LEARN-NN 链接失效)→ founder-gated。
- `ProjectLinearBinding`(ProjectConfig L182-189):project 可绑定 `{team,project?,label?}`,被 `/api/linear/create-issue` 等用。生产每个 project 现为 `linear: null`。tidal-echo 若绑 `{team:"TIDE",labelः"Tidal-Echo"}` 可让 Triton front-door 建单默认落 TIDE —— **可选增强**,非本 issue 必需。

## 7. Discord(🔴 Manage-Channels = Annie)

| room | channel id | 动作 |
|---|---|---|
| #sub-core | `1511889248003952641` | 砍(先把 cron REPORT_CHANNEL 迁走) |
| #sub | `1511267947551653918` | 移到 tidal-echo category(id 不变) |
| #tidal-echo-core(Triton) | `1517041708855197908` | 不变(接收 Sub 归属) |
| #tidal-echo(Ariel) | `1517041986358611998` | 不变 |

Bot 无 Manage-Channels 权限 → 这步整体 surface 给 Tadashi 喊 Annie。**顺序硬约束:迁走/停掉 #sub-core 的每一个 live 消费者(2 nightly `REPORT_CHANNEL` + growth `report.channel_id`/`REPO_DEFAULT_CHANNEL`,见 §4b),再砍 #sub-core**(否则当晚 cron 产出交付无处落)。

## 8. 未决路由(需 Annie/Triton;plan 标 OPEN DECISION)

**new ad-hoc Sub 内容活怎么到 Asha?** Annie 决策 #1:relabel `Tidal-Echo` 走 Triton front-door。但 `Tidal-Echo` label 在 tidal-echo project 里 map 到 **Ariel**(dept-scope);方案 A 下 Asha 住 `sub` project(scope `Sub`)。⇒ front-door 一个 `Tidal-Echo`-labeled issue 默认路由 Ariel,**dept-scope 不会把它给到跨 project 的 Asha**。

含义:纯方案 A 下,Asha 的「新活入口」有两种可能,需 Annie/Triton 拍:
- **A1**:Asha 只跑自治 cron(留 `Sub` 内部);新 ad-hoc 内容都归 Ariel。Asha ≈ 自治音乐产线 lead。
- **A2**:要 Triton 能把新内容活派给 Asha → 需给 Asha 一个可路由的落点(如保留 `Sub` label 走 sub project 派给 sub-lead,或 tidal-echo 内加 dept 区分)。这会重新引入 FLY-127 标签路由复杂度。

**倾向 A1**(最简、零 FLY-127 风险):Asha = 自治产线 lead;Triton 组织上「管」她(同 section、roll-up、协调),新 ad-hoc 内容默认 Ariel,特需时 Triton 手动直派(`/api/runs/start projectName:sub leadId:sub-lead` + issue 留 `Sub` scope)。等物理 repo 合并后再统一。

## 9. byte-compat / 安全

- projects.json / cron / launchd 全 machine-local,不进本 PR。本 runner 交付 = **repo 内设计文档 + cutover 手册**;live 编辑是 founder-gated cutover step,非 PR。
- 无 secrets 进 repo。cron 脚本改动(REPORT_CHANNEL)是 `/Dev/sub` repo 的改动(不在本 flywheel repo)—— 属 cutover step,单独在 sub repo 走 PR 或 founder-gated 手改(设计里写清)。
