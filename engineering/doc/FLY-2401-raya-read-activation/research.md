# FLY-2401 Raya 读侧激活 — 调研
Issue: FLY-2401 (https://linear.app/geoforge3d/issue/FLY-2401/raya读侧-按-fly-2131-激活清单把-raya-codex-leadagentidraya真正激活生产里-summary-6h)
日期: 2026-09-06
基于: exploration.md

## 0. 权威来源

本调研按“运行中状态 > 当前 deployed checkout > 已 merge 文档 > 历史快照”取证：

| 主题 | 权威 |
| --- | --- |
| B/C 原始合同 | `engineering/doc/FLY-2131-raya-brain-absorb/activation-checklist.md:21-70` |
| 后继常驻配置 | FLY-2216 carrier + FLY-2259 `projects.raya-row.json`、plist、wrapper、runbook |
| rider 是否会响 | `packages/teamlead/src/bridge/summary-absorption-rider.ts` 与 live `~/.flywheel/teamlead.db` |
| roster 装载时机 | `packages/teamlead/src/index.ts:19-22,77` 与 `plugin.ts:9892-9897` |
| 当前生产字节 | `~/.flywheel/projects.json`、`~/.flywheel/raya/**`、`~/.codex-raya`、launchd、live DB |
| summary unread queue | GitHub `xrliAnnie/raya` PR current state + installed `summary verify-pr` |

FLY-2259 的 plan/runbook 是已审历史，FLY-2401 不修改它们；后继差异在本文件和新的
activation checklist 中显式叠加。

## 1. 为什么 6h 读钟为 0

`createSummaryAbsorptionPass()` 捕获 `startBridge()` 收到的 `projects` 数组。每个 60s
GatePoller rider cadence 调用时先运行 `resolveRaya(projects)`：它只筛
`lead.agentId === "raya"`；0 个命中直接 return，多个命中抛错，只有恰一条才按
`floor(now/cadence)*cadence` 生成 deterministic round。

生产证据：

```text
$ jq '{projectCount:length,rayaProjects:[.[]|select(.projectName=="raya")|.projectName],rayaLeads:[.[] as $p|($p.leads // [])[]|select(.agentId=="raya")|($p.projectName+"/"+.agentId)]}' ~/.flywheel/projects.json
projectCount=6, rayaProjects=[], rayaLeads=[]

$ sqlite3 -readonly ~/.flywheel/teamlead.db \
  "SELECT COUNT(*) FROM lead_events WHERE event_type='summary_absorption_round';"
0

$ sqlite3 -readonly ~/.flywheel/teamlead.db \
  "SELECT last_effective FROM flag_values WHERE flag_name='summary_absorption_cadence_ms' AND scope='*';"
21600000
```

结论：不是 cadence flag 关闭，也不是事件投递失败；生产从未装载过唯一 `raya/raya`
roster，所以 producer 根本没有 append。修 registry 之后仍须重新装载 Bridge：
`packages/teamlead/src/index.ts` 只在 `main()` 启动时 `loadProjects()` 一次，传给
`startBridge()`；summary pass 捕获这份数组。热改文件不会改变现进程里的 rider。

## 2. B 段：唯一 registry 行

### 2.1 候选单一来源

复用 FLY-2259 已审 row，不复制第二份：

`engineering/doc/FLY-2259-raya-brain-cutover/materials/projects.raya-row.json`

它是 FLY-2131 B 段的超集，只新增常驻所需：

```json
{
  "codexResidencyPatrol": true,
  "match": { "labels": ["raya-lead"] }
}
```

其余承重坐标保持：`projectName=raya`、`projectRoot=~/Dev/raya-lead-workspace`、
`projectRepo=xrliAnnie/raya`、channel `1542079099928059987`、`agentId=raya`、
`botTokenEnv=RAYA_BOT_TOKEN`、`botUserId=1542068543645024257`、
`backend=codex-app-server`、`codexProfile=full-access`、`role=cos`、
`canSpawnRunners=false`、`gpt-5.6-sol/xhigh/1000000`、`summaryRole=recipient`。

### 2.2 写入与验证形状

写入只能在 Lead 批准的窗口内复用 FLY-2259 registrar，并持 canonical config lock：

```bash
bash "$FLYWHEEL_REPO/scripts/flywheel-config-lock.sh" "$PROJECTS.cfglock" 5 \
  python3 "$MATERIALS/register-codex-lead.py" "$PROJECTS" \
  "$MATERIALS/projects.raya-row.json"
```

期望不是“命令 rc=0”这一条弱证据，而是三项同时成立：

1. `jq` 统计 `projectName=raya/agentId=raya` 恰一条；
2. `lead-identity resolve --project raya --lead raya --format json` 精确投影上述字段；
3. `summary-registry migrate` 后 receipt 与新 registry digest 相等，并新增且只新增
   `raya/raya=recipient`，不新增 aggregator。

当前 FLY-2259 assignments 仍新鲜：live receipt 16 条，material 17 条，集合差只有
`raya/raya`；aggregator 两边均 6 条。

## 3. C 段：workspace、memory、env

### 3.1 一次性移动的两态合同

激活前：

- source `~/.flywheel/raya/memory` 是 regular directory、不是 symlink；
- repo branch 为 `fly-2029-raya-v1-foundation`，HEAD `444ce00f…`，worktree clean；
- destination `~/Dev/raya-lead-workspace` 不存在；
- `com.xrli.raya.brain` running 且唯一 pid；voice not running。

激活后：

- `~/Dev/raya-lead-workspace/{memory,state}` 都存在，workspace mode 0700；
- `memory/MEMORY.md` 可读、git clean；source 不存在；
- 同一 checkout 被整体 `mv`，不得第二次 clone；
- product brain/voice preflight 通过后恢复 product brain。

FLY-2259 runbook §4.3 已钉停 brain、查 `lsof`、建目录、拒绝残留、整体 move、preflight、
恢复和 R2 回滚。本单不复制这套 mutation 逻辑，只在新 checklist 引用并补 delta。

### 3.2 `raya.env` 的真实 delta 是三项，不是两项

当前非秘密值：

```text
RAYA_MEMORY_FILE=/Users/xiaorongli/.flywheel/raya/memory/MEMORY.md
RAYA_WORKSPACE_ROOTS_JSON=["/Users/xiaorongli/.flywheel/raya/code","/Users/xiaorongli/.flywheel/raya/memory"]
RAYA_VOICE_OPTIONS_JSON=ABSENT
```

目标：

```text
RAYA_MEMORY_FILE=/Users/xiaorongli/Dev/raya-lead-workspace/memory/MEMORY.md
RAYA_WORKSPACE_ROOTS_JSON=["/Users/xiaorongli/.flywheel/raya/code","/Users/xiaorongli/Dev/raya-lead-workspace/memory"]
RAYA_VOICE_OPTIONS_JSON={"startInstructionsFile":"/Users/xiaorongli/.flywheel/raya/code/apps/voice/assets/start-instructions.zh.md"}
```

第三项来自 FLY-2131 activation-checklist C.5。FLY-2259 的 editor 与 runbook 有意只处理
前两项，不能把“旧工具绿”误报成 C 段完整。本单的 renderer 在内存中合并该 JSON：如果
live 已有其它 voice options 必须原样保留，只新增/替换 `startInstructionsFile`；非法 JSON、
非 object、重复 key 一律 fail-closed。输出不得带 env 中任何其它行，避免泄露 secret。

asset 当前存在，780 bytes，含 Raya/Annie/李晓蓉；Raya voice config 会 canonicalize 路径并
在 preflight 中组合退出指令，超过 8,192 字符即拒起。

## 4. launchd / wrapper / manifest

当前已准备：

- installed `~/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh` 存在，mode
  0555，和 deployed repo source byte-equal；
- template `packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist`
  通过 `plutil -lint`；
- template 固定 label `com.flywheel.lead.raya-raya`，只执行 installed fixed wrapper，
  `KeepAlive=true`，日志固定 `~/.flywheel/logs/lead-raya-raya.log`；
- launcher 固定 windowed TUI、single full-access root、`~/.codex-raya`、prompt chain
  `{raya code/IDENTITY.md, relocated MEMORY.md, governance bundle}`。

当前尚未出生：正式 plist、manifest、launchd label 全不存在。正确顺序必须是：registry +
summary receipt → workspace/env → full activation preflight → converge → materialize 唯一 manifest
→ 复制模板为不带 `.tui` 的正式 plist → lint → bootstrap。不能先 bootstrap 再补 registry。

验证输出：

- `raya-activation-preflight.sh` 最后一行：
  `[raya-activation-preflight] PASS: summary latch, canonical identity, workspace, and TUI launcher`；
- manifest 五字段为 `raya/raya`、external workspace、canonical projects file、
  `backendId=codex-app-server`；
- `launchctl print gui/$UID/com.flywheel.lead.raya-raya` 有 `state = running` 与唯一 pid；
- tmux 恰一窗 `flywheel:raya-raya`，pane 是 `codex resume --remote`；
- heartbeat 两次 `state=online,lastGatewayPollStatus=ok` 且 `updatedAt` 推进；
- recovery `--probe` 返回 `state=exact` 与 `codexHome=/Users/xiaorongli/.codex-raya`。

## 5. 身份投影

有两类投影，不可混称：

1. **Lead canonical identity**：registry row 经 `lead-identity resolve` 投影为 launcher env；这是
   summary rider/Lead 路由的权威，必须完全来自 registry，禁止 launcher env 覆盖。
2. **Raya constitutional prompt**：新 Lead launcher 当前读取 deployed Raya repo
   `~/.flywheel/raya/code/IDENTITY.md`；其 digest `b2c7e522…`，已含 summary unread/merge、
   round ledger、memory provenance 与 visible reporting。产品 brain/voice 仍读取 0444
   `~/.flywheel/raya/identity/IDENTITY.md`，digest `704695ab…`，内容明显较旧。

复核 FLY-2131 plan §2.10 后，0444 副本被明确列在“不动”集合；Raya Lead launcher 也只读
`RAYA_CODE_ROOT/IDENTITY.md`，不读 product projection。因此本单只报告 source/projection
digest drift，标成 `audit_only/non_blocking`，不 copy/chmod，也不把 projection 相等纳入 Lead
active-ready。用户要求的“身份投影”由两条验证满足：registry → Lead env 必须精确；product
0444 projection 则明确证明非 Lead authority、保持 0444 且本单零写。

## 6. Discord 与 Codex home/account

### 6.1 Discord

不打印 token 的 live GET 结果：

```json
{
  "botUserId": "1542068543645024257",
  "bot": true,
  "channelId": "1542079099928059987",
  "guildId": "1485787271192907816",
  "channelType": 0,
  "channelReadable": true
}
```

这证明 token 身份与目标 text channel 的只读访问；没有发送测试消息。激活后仍须由 founder
在 `#raya` 发一句、Raya 回复一句，才证明新 Lead 的 outbound 路径，而不是只证明旧产品
brain 的 token 可用。

### 6.2 Codex home/account

`~/.codex-raya` 当前不存在。存量 Mufasa 与 InfraBot standalone 都是 `codex-cli 0.153.4`；
Raya 必须由 founder 在生产 Mac 独立 `codex login`，不得复制其它 home 的 `auth.json`，再
安装/验证同版 standalone。成功谓词：home 0700、auth 0600、`login status` 为
`Logged in using ChatGPT`、standalone `-V` 与两位存量 Lead byte-equal、全局 codex symlink
前后不变。

## 7. 全 fleet identity 换代、Bridge runtime 与 6h 验收

registry 写入只改变磁盘；live Bridge 的 `projects`/summary pass 是启动快照。Lead 必须在受控
班车或 founder 单次授权窗口 reload Bridge，且验 `/health` 后才开始计“激活完成”。本实现
节点不执行 reload。

设计审查 round 1 复核出更大的运行面：`compileSummaryAssignmentRows()` 对全 registry Leads
计算一个整体 `summaryAssignmentDigest`，该值进入每一席的 `identityDigest`；launcher 又只在
进程出生时把两者写入 env。因此从 16 席加到 17 席会同时使所有旧 Lead 的
`FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST` 与 `FLYWHEEL_LEAD_IDENTITY_DIGEST` 失效，`send/respond`
在 lease mode 判定前即 fail-closed。安全窗口必须在 registry 写入前冻结旧 Lead 写流量，并把
registry + receipt + Bridge reload + **全 Lead fleet restart** 视为同一事务；新 digest 逐席验绿
前不能解冻。回滚 registry 后同样必须再做一次全 fleet restart，不能只 reload Bridge。

Bridge 的 `/health` 200 也不足以证明 Raya runtime 存在。`createLeadRuntime` 首次失败只记
`Skipping runtime for "raya"` 并每 30 秒重试；rider 却会先落去重 DB row，再因
`No runtime registered for lead "raya"` 而不能 enqueue。窗口必须从本次 Bridge generation
日志证明 Raya 首次注册成功，或看到 exact late-registration 成功行；否则不能等 6h 才发现
一条永久 `delivered_at=NULL` 的 slot。

`restart-services.sh` 不是纯 restart：它先 fetch/必要时 fast-forward 到 origin/main，再 build、
converge installed bin，最后 reload Bridge 与全 fleet。因此 activation window 的硬前置是 fresh
remote、checkout HEAD、`~/.flywheel/deployed-sha` 三者相等，deployed dry-run 全绿，且 Lead 在
窗口内冻结 main merge；只要 `deployed..origin/main` 非空，就先在独立部署窗口完成部署并重新
生成 activation 基线。registry 已写后不得顺带部署未审 commit range。

cadence 来自 live `flag_values.last_effective=21600000`。next slot 计算必须用 epoch：

```python
next_ms = (now_ms // cadence_ms + 1) * cadence_ms
event_id = "summary-absorption:" + utc_iso(next_ms)
```

验收查询必须指向 canonical `~/.flywheel/teamlead.db`（不是没有 `lead_events` 的
`~/.flywheel/state/teamlead.db`）：

```sql
SELECT seq, lead_id, event_id, event_type, session_key,
       created_at, delivered_at, delivery_attempts, last_delivery_error
FROM lead_events
WHERE event_type='summary_absorption_round'
  AND lead_id='raya'
  AND event_id=:expected_event_id;
```

期望恰一行，`session_key=summary-absorption`、`delivered_at IS NOT NULL`。StateStore 成功
投递不会清旧 `last_delivery_error`，所以非空只作人工 advisory，不推翻已成功投递。只出现 DB
row 仍不够：至少一张当轮 snapshot 的 PR 还要同时有
以下证据：

- `summary merge` receipt 含 `verifiedHeadSha` 与 roundId；
- GitHub PR current state 为 MERGED，merge 绑定该 verified head；
- canonical `summaries/$PROJECT/...md` 文件存在；
- relocated `MEMORY.md` 有 summary path + roundId provenance，且该 round commit 已产生；
- first-round verifier 用 Raya bot token 对真实 message URL 现场做只读 Discord REST GET；
  API 响应的 channel/author/message id 精确，content 含 roundId 与 reviewed/absorbed 数字，
  不能接受 operator 自填 message JSON envelope 作为自证。

PR #15 当前 installed verifier 输出：`ok=true`、head
`b8078338d552453f45f5e275406c0f3526de4ce0`、单文件
`summaries/flywheel/2026-09-06--flywheel-eng-lead--01.md`。它可作 preflight fixture；真正
read-receipt merge 必须由 Raya 自己在首轮按 R1 窄例外执行，operator 不代 merge。

## 8. 回滚边界

文件/运行时回滚按依赖逆序：

1. carrier：bootout exact label，归档/移除正式 plist、Raya state/log、唯一 tmux window；
2. manifest：仅移除本次 before/after 集合差产生的 `raya-raya.json`；
3. product workspace/env：停 product brain，用 FLY-2401 三键 transition helper 从逐字备份原子
   逆转 env，把 memory checkout 移回，跑 product preflight 后恢复 brain；0444 identity 本单没写；
4. registry/summary receipt：持锁恢复 `projects.json` 与 migration receipt 备份，跑
   `verify-activation`；
5. Bridge/fleet：只有前四层回滚已验证后，才由同一受控 transaction reload Bridge + restart
   全 Lead fleet，使旧 roster/digest 同时生效并逐席验绿。

Raya 已经 merge 的 summary 是“已阅事实”，不是激活配置事务，禁止在回滚时重开/改写 PR。

## 9. 实现约束

- renderer/verifier 必须只读；唯一 writer 是需显式 `apply|rollback` subcommand 的三键 env
  transition helper；所有 production paths 都可通过参数替换成 temp fixtures；
- 不 source `.env`，不输出任何非目标 env 行或 token 值；
- regular-file / symlink / duplicate-key / JSON-type / exact-row 校验 fail-closed；
- renderer 只输出 JSON Patch/零上下文目标行 diff/identity or plist safe diff，不创建 proposed
  production 文件；
- renderer/verifier 测试必须 hash 对比 fixture before/after，证明成功与失败路径都零写；
  transition 测试证明原子 apply/verify/rollback、失败零部分写、rollback 恢复 exact bytes/mode/owner；
- 最终 activation checklist 不复制 801 行 runbook mutation 细节，而是给出明确引用、
  FLY-2401 delta、逐步命令/期望/回滚与最终验收。
