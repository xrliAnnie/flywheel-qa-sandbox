# FLY-2109 切号后唤醒活体 — 调研
Issue: FLY-2109 (https://linear.app/geoforge3d/issue/FLY-2109/病根-切号后活着的-runner-不接新账号旧号周额度打满即全体静默只能人眼发现-8)
日期: 2026-10-01
基于: exploration.md

## 1. 调研结论一览

| 问题 | 结论 | 证据 |
|---|---|---|
| 「一次真切号」用什么判定 | 账号库 `generation` 前进（`commitSwitch` 唯一推进点） | `switch-executor.ts:209-216`，`account-store.ts:36-54` |
| 切号成功后 Bridge 里有没有现成触发点 | 有两个 `onSwitchSuccess` 钩子，但 `attempted` 含 noop；要靠 `generation` 去重，不靠 `attempted` | `account-switch-watchdog.ts:55`，`account-switch-route.ts:260-268,90` |
| 周期性补投搭哪个 tick | `onPollComplete`（30s poll，fleet sensors / alertHub / auto-qa 都搭这里，零新 timer） | `plugin.ts:8111-8146` |
| runner 唤醒原语 | `CommDB.insertInstructionWithId` + `wakeRunnerMailbox`（= `flywheel-comm send` 的 ①④⑤） | `send.ts:31-112`，`wake.ts:30-121`，`db.ts:898-913` |
| Lead 唤醒原语 | `store.appendLeadEvent` + `registry.getForLead(id).deliver(envelope)` + `markLeadEventDelivered` | `HeartbeatService.ts:2146-2172`，`StateStore.ts:6513-6539` |
| Lead 看到什么 | 通用渲染：`[Event #seq] account_switch_wake` / `ID: — \| Issue: —` / `Summary: <文案>` | `mailbox-lead-runtime.ts` `formatEnvelope` 通用分支 |
| Lead 枚举 | `RuntimeRegistry` 无 iterator；用 `fleetConfigProvider.snapshot().projects[].leads[]`（`snapshot()` 返回 `{projects, state}`）逐个 `getForLead` | `runtime-registry.ts`，`fleet-data.ts:547-549`，`plugin.ts:3495-3527` |
| Lead 是不是 Claude | `effectiveLeadBackend(lead.backend, defaultLegacyBackendOf(project))`（显式 > 项目 config.yaml `roles.lead.backend` / `FLYWHEEL_LEAD_BACKEND` legacy > 默认 claude-code） | `lead-backends/lead-backend.ts:55-65`，`fleet-data.ts:611-627` |
| Lead pane 活性 | `locateLeadWindow(project, leadId)` → `null` = 窗口不存在 | `LeadWindowLocator.ts:40-73` |
| runner 枚举 | StateStore `getRunningSessions()`；真实 vendor 看项目 CommDB `getSession(exec).vendor` | `StateStore.ts:3610`，`db.ts:1576`，`types.ts:57-72` |
| runner pane 活性 | 从本 consumer 打开的同一 CommDB 取 `sessions.tmux_window` → `probeRunnerProcessLiveness(tmuxWindow)`；`indeterminate` 当 unknown 照投。不用 `lookupTmuxTarget`（硬编码 `~/.flywheel/comm`，无视 `FLYWHEEL_COMM_ROOT/DIR`） | `tmux-lookup.ts:172-179,371`，`commdb-path.ts:19-27` |
| 幂等 / 证据 | 审计去重 = CommDB `INSERT OR IGNORE`；投递证据 = `delivered_at`（runner）/ `lead_events.delivered_at`（Lead）；transport 重试去重 = sidecar `flywheelId`，但 `finalized:false` 的 pending 不算成功，须 `MailboxTransport.writeVerified` | `db.ts:898-913`，`ClaudeMailboxCodec.ts:144-160`，`MailboxTransport.ts:59-95`，`StateStore.ts:6513-6539` |
| 日志文件 | `FLYWHEEL_QUOTA_LOG_PATH ?? ~/.flywheel/logs/quota-monitor.log`，追加一行 JSON；仓内已有 `O_NOFOLLOW` 单 fd 写法可仿 | `reports-route.ts:126-141` |
| kill switch | 注册表 `FEATURE_FLAGS` 条目 + 读点声明；drift 测试要求 env 读点文件真含该 env 名 | `registry.ts:102-145`，`feature-flags-drift.test.ts` |
| 测试房隔离 | 不止两个 env：账号库 / 账号锁 / pending 单 / 切号日志 / profile CLI fixture / CommDB（清 `FLYWHEEL_COMM_ROOT`）/ 收件箱 / StateStore，见 plan §5.1 | `account-store.ts:116-122`，`pending-store.ts:49-53`，`claude-profile-cli.ts:53-56`，`commdb-path.ts:19-27` |

## 2. 细节

### 2.1 代次消费为什么比钩子直投稳

`accountSwitchWatchdogTick` 与 `/api/account-switch` 两处的 `onSwitchSuccess` 都在 `disposition.outcome === "attempted"` 时触发，
而 `noop_already_switched` 也是 `attempted`（`account-switch-repair.ts:190-195`）。若在钩子里直接枚举投信，重复触发会多投一轮
（虽然 id 幂等，但会多做一轮探测、多写一行日志）。改为「钩子只是门铃」：钩子调 `tick()`，`tick()` 读账号库 `generation`，
与 StateStore 回执表里最后完成的代次比较——没前进就什么都不做。于是：

- 真切号：代次前进 → sweep 一次；
- noop / failed / no_account：代次不动 → 不投；
- Bridge 在「切号已提交、唤醒未投/投一半」崩溃：重启后首个 poll 看到代次前进且回执 pending → 补投（三层幂等保证不重复）。

`readStore(path)` fail-soft（读不到返回空库，`generation` 为 0），账号库不存在（自愈关）→ 代次 0 永不前进 → consumer 静默。

### 2.2 runner 投递细节

```
id = `account-switch-wake:g${generation}:${execution_id}`
text = `【账号切换】额度已切到新账号 \`${to}\`，请接着做刚才的事。`
db = new CommDB(commDbPathForProject(project))           // 与 plugin.ts:3340 / :5124 同一打开方式；遵守 FLYWHEEL_COMM_ROOT/DIR
evidence = db.getMessageById(id)?.delivered_at           // 投递证据；有 → 只补附带动作
sess = db.getSession(exec)                               // vendor + tmux_window 同源
db.insertInstructionWithId(id, "bridge", exec, text)     // 审计行；false = 已有
wake = await wakeRunnerMailbox({ db, execId: exec, fromAgent: "bridge",
        content: `[lead-instruction ${id}]\n${text}`, metadata: { flywheelId: id, execId: exec, kind: "account_switch_wake" },
        backend: "claude-code", transportFactory: verifyThenWrite })   // 先 verifyLastWrite 认回，再 MailboxTransport.writeVerified
ok → db.markInstructionDelivered(id)                     // 只有这里写 delivered_at
```

- `wakeRunnerMailbox` 的 `skippedReason:"no_session_lead"`（CommDB 行无 `lead_id`）和 `backend_commdb`（回滚模式，`wake.ts:63-64` 直接返回、未调 transport）都不是失败：前者记 `skipped_no_mailbox`，后者记 `skipped_backend_commdb`，**都不写 `delivered_at`**（回滚模式下是否被 hook 读到没有确认信号，不能冒充投递证据）。
- 不调 `clearDeclaredState`：派单说「只唤醒」，parked / long_task 声明保留（与生产裁定一致：仅 account_dead 才清，本仓没有 account_dead 触发）。
- vendor 判定：`db.getSession(exec)?.vendor === "claude-code"` 才投；`codex` / `none` / NULL / 行缺失 → `skipped_vendor`。NULL 是 dispatcher 预注册（runner 还没自报）或 legacy 行；对尚未起来的体投唤醒没意义（它起来就用新号），legacy 行在本仓当前版本不会出现（FLY-1188 起所有 adapter 都写 vendor）。
- `[lead-instruction <id>]` 前缀会让 runner 按协议回一条 DONE——这是可核对的副作用，Lead 由此看到「谁醒了」。
- `detection-gap-scan` D6（`delivery_unconsumed`）的 SQL 按 `to_agent=? AND type='instruction' AND delivered_at IS NOT NULL AND read_at IS NULL` 扫（`:366-372`），
  mailbox 模式下 runner 侧没有可靠 ack（`send.ts:89-95`：`read_at` 故意不更新），所以一次切号自动扇出会让**每个健康 runner** 30 分钟后被报 `delivery_unconsumed`——
  与 Lead 偶发手动 `send` 不同，这是批量、周期性的。处理：D6 按 id 前缀排除自动唤醒行（plan §3.3b），普通 Lead 指令照旧。

### 2.3 Lead 投递细节

```
eventId = `account-switch-wake:g${generation}:${leadId}`
seq = store.appendLeadEvent(leadId, eventId, "account_switch_wake",
        JSON.stringify({ event_type: "account_switch_wake", execution_id: "", issue_id: "",
                         project_name, summary: text }), `account-switch:g${generation}`)
runtime = registry.getForLead(leadId)        // undefined → skipped_runtime_missing（Lead 未就绪/未注册）
if (!(await locateLeadWindow(project, leadId))) → skipped_window_absent   // 窗口不存在不投
result = await runtime.deliver({ seq, event, sessionKey, leadId, timestamp })
result.delivered ? store.markLeadEventDelivered(seq) : failed(error)
```

- `appendLeadEvent` 同 `(lead_id,event_id)` 返回已有 seq → `MailboxLeadRuntime.buildFlywheelId = <leadId>-<seq>-`（空 execution_id）稳定 → sidecar 去重 → 重放不双写。
- `account_switch_wake` **不**加入 `RETRYABLE_LEAD_EVENT_TYPES`（否则 heartbeat 会在 Lead 离线时重投 5 次并在耗尽后触发 FLY-83 stuck 告警）；重试由本 consumer 自己按目标做（最多 20 次 ≈ 10 分钟 poll）。
- `locateLeadWindow` 用 `tmux list-windows -t flywheel`，QA 房里 Lead 窗口名同样是 `<project>-<leadId>`。
- Lead 通用渲染没有 `[lead-instruction]` 前缀，Lead 看到的是一条普通事件 + Summary，不会触发 DONE 回执义务。

### 2.4 回执表（StateStore 新表）

```sql
CREATE TABLE IF NOT EXISTS account_switch_wake_receipts (
  generation   INTEGER PRIMARY KEY,
  status       TEXT NOT NULL,          -- 'pending' | 'completed' | 'skipped'
  trigger_from TEXT, trigger_to TEXT,
  outcome_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
)
```

`outcome_json` 在 pending 期间保存**冻结的目标名单 + 逐目标状态**（名单在第一次尝试时一次性枚举并落盘，之后只处理未终态目标，不重新枚举，
避免日志重试期间新起的体被并进旧代次）。`last completed generation = MAX(generation) WHERE status IN ('completed','skipped')`。
StateStore 底层是 better-sqlite3（WAL，逐 statement 落盘；`StateStore.ts:4,31-33` 是 sql.js 兼容 shim），表创建跟随现有 `CREATE TABLE IF NOT EXISTS` 迁移惯例（`StateStore.ts:1531` lead_events 同款）。

### 2.5 日志追加器

```
path = env.FLYWHEEL_QUOTA_LOG_PATH?.trim() || join(homedir(), ".flywheel/logs/quota-monitor.log")
fd = openSync(path, O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW, 0o600); writeSync(fd, line + "\n"); closeSync(fd)
line = {"ts","component":"flywheel-bridge","level":"info","event":"account_switch_wake","generation","from","to",
        "status":"completed|skipped:flag_off","counts":{enqueued,already_enqueued,skipped_*,failed,gave_up},"targets":[...]}
```

- 父目录不存在 → 抛错 → 回执停在 `logging` 阶段下个 tick 重试（生产目录由 launchd 创建；QA 房由 `FLYWHEEL_QUOTA_LOG_PATH` 指向房内路径）。
- `process.env.VITEST` 下 plugin 不接日志器（避免写真实 HOME），单测用注入的 `appendSwitchLog`。
- 短写（`writeSync` 返回字节数 < 长度）抛错。

### 2.6 feature flag

注册表新增 `account_switch_wake_sweep`：`category:"kill_switch"`，`envVar:"FLYWHEEL_ACCOUNT_SWITCH_WAKE_SWEEP"`，`polarity:"default_on"`，
`default:true`，readSite = 新文件 `bridge/account-switch-wake.ts` 的 `call_time` 读（每次 tick 读 `process.env`，`!== "0"` 惯用法），
`toggleable:"direct"` 需要 `resolve.direct-toggle.test` 里加一条 live-observe 证明（沿用 `auto_qa_killswitch` 条目的做法）。
drift 测试：readSite 文件必须字面含该 env 名。

默认 ON 的理由：本 issue 是病根修复，关掉 = 回到「全体静默」；且整条链路只在 `accountPoolConfigured()`（账号库存在）时存在，
没配账号池的部署行为逐字节不变。

### 2.7 测试房隔离（QA@1 的教训，prod lead-decisions §1）

- `FLYWHEEL_CLAUDE_ACCOUNTS_PATH`：已被 `defaultStorePath()` 读取；房内 Bridge 设到房内路径 → consumer 读房内账号库，不读生产。
- `FLYWHEEL_QUOTA_LOG_PATH`：新读点；房内 Bridge 设到房内路径 → 生产 `quota-monitor.log` 零新增行。
- 以上两个只是必要条件：账号池文件存在时 plugin 会装配**真实** `flywheel-claude-profile`（默认读写生产 profiles / Keychain / `~/.claude.json`），pending 单也有生产默认路径——完整隔离集见 plan §5.1（含 fake profile fixture 脚本、`FLYWHEEL_ACCOUNT_PENDING_PATH`、`FLYWHEEL_CLAUDE_ACCOUNTS_LOCK`、`FLYWHEEL_COMM_DIR` + 清 `FLYWHEEL_COMM_ROOT`、`CLAUDE_CONFIG_DIR`）。
- 本仓 `scripts/lib/` 没有 `qa-slot-env-contract.json`（生产 PR 新增）；plan 把隔离集作为 QA 房 Bridge 启动 env 的显式要求写进验收，不引入新 contract 文件。

### 2.8 不碰的东西（scope 纪律）

`switch-executor.ts` / `account-switch-repair.ts` / `account-switch-watchdog.ts` 的逻辑与返回形状、`rescue.ts` 的 login_expired sweep、
额度判定、Codex 路径、`RETRYABLE_LEAD_EVENT_TYPES`、CommDB schema、`send.ts`。`onSwitchSuccess` 的签名不变（钩子体内多调一次 `tick()`）。
