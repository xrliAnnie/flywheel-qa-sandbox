# FLY-1309 Lead 身份唯一性 — 调研
Issue: FLY-1309 (https://linear.app/geoforge3d/issue/FLY-1309/fix-lead-身份唯一性-双进程互斥-同身份并存检测1229-改写今晚双-lead-事故根治)
日期: 2026-07-16
基于: exploration.md

> 本文是实现所需的代码事实地图。行号为 2026-07-16 main(3d862dea2)快照,实现时以符号名为准重新定位。

## 1. Lead 进程拓扑(现状)

- **Lead 真身** = tmux pane 里的 claude CLI:`claude --agent <LEAD_ID> --permission-mode bypassPermissions --channels plugin:discord@...`(`packages/teamlead/scripts/claude-lead.sh:1534-1539, :1960, :1961, :2042`)。Discord plugin 在该进程内运行;supervisor 自己不碰 Discord。
- **共享 tmux server**,session 固定名 flywheel(`claude-lead.sh:1183-1184`),socket = `${FLYWHEEL_TMUX_SOCKET_OVERRIDE}` 或默认(`:1019-1032`);每 Lead 一个 window,窗名 `${PROJECT_NAME}-${LEAD_ID}`(`:1198, :1289, :1537`)。
- **pane 的父进程是 tmux server,不是 supervisor** —— 杀 supervisor 不杀 pane(`:1357-1362` 注释明确承认 "may still hold a LIVE old Claude (ppid!=1, skipped by reap)")。
- supervisor(claude-lead.sh)身份三件套:
  - PID file `~/.flywheel/pids/${PROJECT_NAME}-${LEAD_ID}.pid`,启动守卫 `:2714-2732`(FLY-1285 argv 指纹校验),写入 `:2732`,退出清理 `:1714-1715`;
  - manifest `~/.flywheel/manifests/${PROJECT_NAME}-${LEAD_ID}.json` 含 `pid: $$`(supervisor 的,非 pane 的)(`:509-573`,pid 在 `:555`);
  - FLY-1285 tmux archive `~/.flywheel/pids/${PROJECT_NAME}-${LEAD_ID}.claude.tmux`(`:2708`),字段 `server_pid \t pane_pid \t pane_start \t window_id`(`scripts/lib/tmux-supervisor-guard.sh:15-32`)。
- pane env 注入机制已有:`-e "LEAD_ID=..." -e "FLYWHEEL_LEAD_ID=..."`(`claude-lead.sh:1406-1407`;supervisor 侧 export `:943`)—— **lease generation env 走同一条路**。
- `--model` 在 pane launch 时从 manifest 解析注入(`:1301-1327`,env fallback `:1315-1327`,argv 覆写 `:1975-1980`)⇒「旧 Opus + 新 Fable」= 孤儿 pane 活过 model flip 的签名。

## 2. 启动/停止路径与守卫矩阵(缺口 A)

| # | 入口 | 位置 | 经过的守卫 |
|---|------|------|-----------|
| 1 | launchd KeepAlive(ThrottleInterval 30s)→ flywheel-lead-wrapper.sh | plist 生成 `scripts/flywheel-daemon.sh:309-311`;wrapper exec `scripts/flywheel-lead-wrapper.sh:188-196` | wrapper PID lock `:129-138`(**只 kill -0,无身份校验**)→ supervisor 守卫 `claude-lead.sh:2714` |
| 2 | restart-services.sh kickstart | `scripts/restart-services.sh:958-965` | 先 TERM 旧 supervisor(`:912-937`,60s 等待,卡住则拒启 `:929-934`)+ launchd 单实例 |
| 3 | restart-services.sh legacy nohup | `:987-991` | 仅 supervisor 守卫 `:2714` |
| 4 | fleet daemon bootout+bootstrap(model/effort flip) | `scripts/flywheel-daemon.sh:657`(bootout)、`:666-670`(旧 supervisor 不退则**不** bootstrap)、`:718`(bootstrap) | 防双 supervisor,**不防双 pane** |
| 5 | 手动 claude-lead.sh | 文档 `flywheel-lead-wrapper.sh:10` | 仅 supervisor 守卫;PROJECT_NAME 自动解析(`claude-lead.sh:264-274`)可与 launchd 路径派生**不同 PID file key**(`:2707`)→ 守卫互看不见 |

- **FLY-1285 takeover guard**(启动时刻的 pane 级互斥,`_prepare_lead_launch` `claude-lead.sh:1197-1244`):archive 指向的旧 pane 活着 → HOLD(`ambiguous`/`split_brain`,`:1206-1218`);证明死亡(pid+lstart 指纹,`tmux-supervisor-guard.sh:51-91`)才 reap(TERM→KILL,argv 逐步复证 `:72-102`,argv 证明 = `*claude*"--agent ${lead_id}"*` `:57-60`)。
- guard 的两个结构洞:
  1. 未归档活 pane 检查被 generation 门控(`claude-lead.sh:1230-1242`):tmux server 换代后整块跳过 → 跨代活 pane 失明;
  2. `_launch_claude` 无条件覆写 archive(`:1566-1572`)→ 未被指到的活 pane 永久失踪。
- 优雅退出 `cleanup()`(`:1665-1694`)generation 不确定时**保留 archive 且不杀 pane**(`:1691-1693`);SIGKILL/crash 直接跳过 → 孤儿 pane。
- 停止路径只 TERM supervisor(`restart-services.sh:912-937`),pane 收尾全托付给垂死 supervisor 的 trap 与下次启动的 reap。
- **FLY-574 先例**(`doc/engineer/implementation/companion-lead-single-process.md`):双 supervisor 抢一个 bot token → Discord 投递分裂;同类事故的既往修法是 fail-close stub(`scripts/decommission-legacy-companion-daemon.sh:91`)。

## 3. Bridge 侧现状(缺口 B)

- Bridge = `packages/teamlead/src/bridge/plugin.ts`(默认 :9876)。
- **LeadWatchdog**(`packages/teamlead/src/LeadWatchdog.ts`,FLY-83):30s tick(`:235-247`,装配 `plugin.ts:8861-9022`),按 config `projects[].leads[]` 迭代(`:272-281`),经 `locateLeadWindow`(`packages/teamlead/src/LeadWindowLocator.ts:40-73`)`tmux list-windows` 按窗名**精确首匹配**(`:61-72`)→ capture-pane 文本分类(`bridge/lead-alert-helpers.ts:259-273`)。**不读 pane_pid、不读 manifest pid、不读 archive;同名双窗只见第一个。**
- **无 Lead heartbeat/注册表**:Lead→Bridge 仅 bootstrap POST(`claude-lead.sh:953`)与 tmux-hold 观测(`:1093`);StateStore 只有 `lead_events` 告警账本(`packages/core/src/StateStore.ts:1715-1749`,UNIQUE(lead_id,event_id) `:1748`),无活进程 registry。
- **告警链**(检测层直接复用):watchdog → `LeadAlertNotifier`(`packages/teamlead/src/LeadAlertNotifier.ts`)→ 三层去重:跨进程 claims.db `alert_claims`(`:705-728`,与 `scripts/lead-alert.sh:311-342` 字节同式,eventId=sha1(project|lead|kind|signature),`LeadWatchdog.ts:723-732` ↔ `lead-alert.sh:302`)→ StateStore `tryClaimLeadEvent`(`StateStore.ts:8031`)→ 统一频道 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 发帖(`:840-892`,失败落 `~/.flywheel/alert-queue/`)。AlertEventType 联合类型 `LeadAlertNotifier.ts:63-275`(新 kind 加在此 + shell 侧同步)。
- **防刷屏先例**:FLY-1220 episode latch(报一次直到恢复)+ FLY-1218 live-region 识别;双活告警必须沿用 episode 语义。
- Bridge→Lead 投递按 leadId(mailbox `bridge/mailbox-lead-runtime.ts:87-134`;tmux send-keys 按窗名 `bridge/tmux-lookup.ts:439-473`)→ 双窗时同样歧义(检测告警要提示这一点)。
- Runner 侧 liveness 参考:`HeartbeatService.ts:811-818` reconcileMonitorLoss(模式参考,不适用 Lead)。

## 4. 授权面与溯源现状(缺口 C)

- **respond**(Lead 答 gate/question):入口 `packages/flywheel-comm/src/index.ts:474-518`;逻辑 `packages/flywheel-comm/src/commands/respond.ts:36-145`。`--lead` 自由字符串。**两个写入位点**:常规 `db.insertResponse` `:119`;emergency bypass 分支(`FLYWHEEL_COMM_BYPASS_BRIDGE=1`,`:80-109`)内也有 `:81` —— lease 校验必须双覆盖。gated `approve_to_ship`(`GATED_CHECKPOINTS` `:13`)走 Bridge `POST /api/founder-consent/runner-gate-response`(`routeThroughBridge` `:270-330`,FLY-1251 fail-closed)。答案到达 runner:阻塞 gate 轮询直读响应行(`gate.ts:185`)/ 空闲 runner mailbox 唤醒(`src/wake.ts:57-116`;收件路径 `agent-team-transport/src/path-helpers.ts:163-168`)/ 旧 PostToolUse hook(`scripts/hooks/inbox-check.sh`)。
- **send**(Lead 指令,FLY-168 双写):入口 `index.ts:520-558`;逻辑 `send.ts:31-112`。`insertInstruction` `:34`(id=randomUUID,`db.ts:1199-1218`)→ 清 park 标记 `:43` → 按 `sessions.vendor` 路由 mailbox 唤醒 `:69, :80-87`。**runner 可见前缀 `[lead-instruction <id>]` 在 `send.ts:84` 生成**,仅为投递去重回执(runner 引用回执协议 `edge-worker/src/Blueprint.ts:1656-1671`);wake OK 后 `markInstructionDelivered` `:97`。
- **鉴别现状**:CLI = trust-by-invocation,零鉴权;Bridge = 单一共享 bearer token(`plugin.ts:836-866`,safeCompare `:790-793`),body leadId 只做审计归属(`founder-consent/middleware.ts:68-78`、`gate-response-router.ts:164`,仅拒 founder 保留名 `:177-183`)。
- **CommDB schema**(`packages/flywheel-comm/src/db.ts:13-26` + 迁移 `:251-350`):messages 列含 from/to/type/content/checkpoint/delivered_at 等,**无任何 pid/代次/lease 列**;sessions(`:27-36`,vendor `:355-368`)同样没有。幂等 ADD COLUMN 迁移先例:FLY-267 `reply_channel_id`。
- **可镜像的执法模式**:
  - fail-closed 本地核验:`packages/flywheel-comm/src/commands/verify-approval.ts:270-519`(wake 文本无授权,只有可信本地源算数);
  - server 中间件:`founder-consent/middleware.ts:39-123`(off/audit_only/enforce 三态 + 403/503),保留端点注册表 `founder-consent/reserved-endpoints.ts:37-132`;
  - 原子 CAS claim:`packages/teamlead/src/bridge/launch-claim-store.ts:62`(INSERT OR IGNORE + changes() 判定唯一赢家)—— lease 表直接镜像;
  - 进程死亡证明:`tmux-supervisor-guard.sh` pid+lstart 指纹(防 PID 复用)。
- **v1 范围外的旁路面(记 follow-up)**:terminal-mcp 直接对 runner pane send-keys;Codex lead backend(codex-lead.sh,无 claude pane,生产不 spawn runner);Bridge per-Lead credential。

## 5. 溯源可得的进程事实(CLI 进程视角)

- respond/send 由 Lead 的 claude 进程经 Bash tool 起子进程执行 ⇒ CLI 进程的祖先链里有 claude pane 进程。可直接取:自身 `process.pid`/`ppid`;pane 身份经 env(launch 注入 `FLYWHEEL_LEAD_GENERATION`、`FLYWHEEL_LEAD_LEASE_KEY`)。
- **holder 指纹校验的正确锚点是 env 携带的代次,不是 CLI 的 pid 链爬树**(Bash tool 可能多层 sh 包裹,爬树脆);pid/start 仅作溯源记录字段,不作执法判据。
- 进程表匹配注意:runner 进程 argv 是 `--agent-id runner-<x>@<leadId>`(实测 `ps` 有 `claude --agent-id runner-dd9b1f55@flywheel-eng-lead`),Lead 是 `--agent <leadId>` —— 检测/预检必须**按参数精确匹配**(`--agent` 后跟整词 leadId),子串 grep 必误报。

## 6. 事故取证结论(实现相关摘录,全文见 exploration.md)

- 昨晚 00:13 unified restart 只重启了 Bridge(00:20);Lead supervisor 与正主 pane 自 Jul 15 01:24-01:34 连续存活(HL 正主 25056 至今在跑)。
- 两组事故 PID 的第二个均为**瞬态进程**,supervisor recovery loop 日志零新行 ⇒ 不是正主 supervisor 拉起;确切触发源因零溯源+零检测不可回放。
- CommDB 事故窗口检索不到那条「未经授权」错指令 ⇒ 它可能走了 CommDB 之外的通路;溯源列落地后此类事件可回放。

## 7. 部署事实(rollout 依据)

- flywheel-comm 是每次调用起新进程的 CLI(`node .../dist/index.js`)⇒ **dist 重建后,存量 Lead/Runner 的下一次调用立即用新码**;但 enforce 依赖 pane env 里的代次,老 pane 没有 ⇒ merge 默认 audit_only,随下次批量 Lead 重启(Tier-3)翻 enforce。
- claude-lead.sh 改动需 Lead 重启生效;LeadWatchdog/告警改动需 Bridge 重启;三者可并入同一次批量重启窗口。
- 测试基建:vitest per-package;检测类需真 pane fixture(FLY-1218/1285 先例:真抓屏 fixture + 阴性样本 + 突变验证);QA framework 529 Room 可跑隔离双活注入。
