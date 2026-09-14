# FLY-2496 Raya 宿主激活 — 调研
Issue: FLY-2496 (https://linear.app/geoforge3d/issue/FLY-2496/raya宿主激活-生产-raya-卡在旧壳-0f77e977班车判-host-capability-absent缺)
日期: 2026-09-13
基于: exploration.md

本文只记代码事实与它们对设计的约束；每条都带 `file:line`（worktree HEAD `26ebc4931`）。生产宿主数据见 exploration.md §1，本文不重复。

## 1. 班车 Raya 段的真实状态机

### 1.1 入口与闸

- `scripts/update-flywheel.sh:714-727`：只有 `UPDATER_WAKE_KIND=scheduled` 才进 Raya 段；`raya_host_capable` 假 → `not_configured host-capability-absent`，一行日志，**无告警、无回执**（`scripts/__tests__/update-flywheel-sources.test.sh:316-327` 把这个"静默"钉成合同）。urgent wake 恒 `skipped wake=urgent`。
- `raya_host_capable` = `raya_validate_canonical_manifest`（`scripts/lib/updater-raya-deploy.sh:89-101`）：`~/.flywheel/manifests/raya-raya.json` 普通文件、`projectName/leadId=raya`、`leadBackend.backendId=codex-app-server`、`projectDir` 绝对路径且是存在的非 symlink 目录。
- 班车 `source ~/.flywheel/.env`（`update-flywheel.sh:20`、经 `launchd-census.sh` 再 source 一次 `:58-61`），所以 Bridge 的 `RAYA_BOT_TOKEN` 及全部 `*_BOT_TOKEN` 在班车环境里可见；plist 自身只带 `PATH`。

### 1.2 `updater_raya_pass`（`updater-raya-deploy.sh:774-807`）

```
host_capable → lock → raya_prepare_source → raya_standard_cutover → raya_standard_collect_proof → raya_standard_finalize
```

| 步骤 | 硬前置（缺则 `raya_fail`，写 failed 回执 + severe 告警 @founder） | 行 |
|---|---|---|
| `raya_prepare_source` | canonical manifest；checkout 在 main、clean；**`raya_manifest_base_valid`**（迁移账本）；checkpoint=P2 时 `raya_ensure_legacy_quiesced`（要 `RAYA_MIGRATION_ALLOW_LEGACY_STOP=1`）→ 远端只认 `xrliAnnie/raya` → fetch ×3 → ff-only 到 origin/main → `pnpm install --frozen-lockfile` / `pnpm build`（各 600s）→ `raya_materialize_business`（把 `.lead/raya/identity.md` 与 `packages/cos/{package.json,dist}` 导出到 `<workspace>/.flywheel-managed/versions/<sha>`，`business/current` 原子指针，persona 投影到 `<workspace>/.lead/raya/identity.md`）→ 账本记 `raya_sha / flywheel_deployed_sha / canonical_manifest_digest / artifact` | 683-762 |
| `raya_standard_cutover` P2→P3 | `.old_stopped_at` 已写 | 284-289 |
| P3→P4b | 读 `.cursor.path`、`.cursor.seed_input`（都须绝对路径）→ `seed-lead-inbound-cursor.js --path --input` → 回执 `status ∈ seeded/already_seeded`（`already_advanced` 拒绝）且 `migrationId` 等于账本 → 写 `.cursor.{status,sha256,seeded_at}` | 290-295、265-275 |
| P4b→P5 | `raya_standard_preinstall_ready`（账本 P4b、`unresolved=[]`、cursor 文件 sha256 = 账本 `cursor.sha256`）→ `raya_bridge_token_ready`（只核账本字段：`bridge.token_env=="RAYA_BOT_TOKEN"`、`token_resolved==true`、`bot_user_id` 17–20 位且 == `lead_bot_user_id`、`alert_channel_id` 非空）→ `flywheel-lead.sh preflight <manifest>` → `install --project raya --lead raya` → `verify --stage installed <manifest>` → `.activated_at` | 296-307、254-261 |
| `raya_standard_collect_proof` | 账本 P5：`proof.json` 缺 → rc 2 → `awaiting_proof / p5-awaiting-real-p6-evidence`，写 **refused** 回执、**无告警**；存在但不合 → `proof-invalid` severe | 367-387、793-800 |
| `raya_standard_finalize` | `raya_validate_p6_manifest` + `raya_verify_frozen_source` + `verify --stage live` → 写 `deployed`（或 `current`）回执 → 前移 `deployed-sha` → P6→P7 | 504-519 |

**结论 1**：一次 scheduled 班车最多推进到 P5；P6→P7 至少要**第二班**（≥12h 后），中间需要有人产 `proof.json`。issue 里"下一班车跑 P0–P7"至少是两班。

**结论 2**：`raya_manifest_base_valid` 在 `raya_ensure_legacy_quiesced` 之前（`:695` vs `:711`），所以账本缺席时旧壳不会被碰，只会告警。

### 1.3 迁移账本的完整字段（由本单新工具产出的 P2 初始态）

综合 `raya_manifest_base_valid:170-178`、`raya_standard_manifest_checkpoint`（`raya-standard-migration.sh:34-46`，要求 `cursor` 对象存在）、P3/P4b/P6 读取、以及测试夹具 `updater-raya-deploy.test.sh:48-56`：

```jsonc
{
  "schemaVersion": 1,
  "migration_id": "FLY-2445-standard-lead-<YYYYMMDD>-<8hex>",
  "checkpoint": "P2",
  "unresolved": [],
  "lead_bot_user_id": "<projects.json 里 raya 行的 botUserId>",
  "registry_digest": "<sha256(projects.json)>",
  "summary_receipt_digest": "<sha256(state/summary-registry/migration-receipt.json)>",
  "bridge": { "token_env": "RAYA_BOT_TOKEN", "token_resolved": true,
              "bot_user_id": "<GET /users/@me 用 Bridge env 的 token 解出的 id>",
              "alert_channel_id": "<raya 行 alertChannel>" },
  "cursor": { "path": "<stateDir>/inbound-cursor.json",
              "seed_input": "~/.flywheel/raya/migrations/FLY-2445-standard-lead/seed-input.json",
              "status": null, "sha256": null },
  // 本单新增（班车只读；旧字段语义不变）
  "authorization": { "legacy_stop": true, "granted_by": "founder",
                     "granted_at": "<ISO>", "evidence_message_id": "<Discord 消息 id>",
                     "issued_by": "flywheel-eng-lead" },
  "window_probe": { "bot_token_env": "<兄弟 bot 的 env 名>", "channel_id": "<#raya>" }
}
```

`stateDir` 用公共解析：`packages/teamlead/scripts/codex-lead.sh --print-state-dir raya raya`（`flywheel-lead.sh:471,900` 同一入口）。`cursor.path` 与 `<stateDir>/inbound-cursor.json`（`codex-lead-runtime.ts:924`）一致。

### 1.4 seed 输入文件（`packages/teamlead/src/bin/seed-lead-inbound-cursor.ts:22-30`）

```ts
{ schemaVersion: 1, migrationId, expectedBeforeSha256: string | null,
  writerStopped: true, unresolved: [],
  channels: [{ channelId, lastConfirmedMessageId }], emptyChannels?: string[] }
```
`expectedBeforeSha256` 是**必需**字段：`undefined` 既非 `null` 也非 SHA-256，`:48-52` 直接 throw `cursor seed before digest is invalid`；cursor 文件尚不存在时填 `null`。`writerStopped=false` 或 `unresolved` 非空直接 throw（`:54-56`）；snowflake 用 BigInt 比较；新 owner 已推进的游标不倒退（测试 "never moves a cursor backwards"）。

### 1.5 P6 证据（`raya_p6_evidence_valid`，`updater-raya-deploy.sh:327-365`）与可取证来源

| proof 字段 | 取证来源（全部只读或公共工具） |
|---|---|
| `lead.project/id/key` | 常量 `raya/raya/raya-raya` |
| `lead.registry_digest / summary_receipt_digest / manifest_digest` | 当场重算三文件 sha256；必须等于账本顶层同名值，否则 fail-closed（意味着 P2→P6 期间 projects.json、summary receipt、canonical manifest 三文件**冻结**） |
| `lead.pid / process_started_at` | `launchctl print gui/<uid>/com.flywheel.lead.raya-raya`（`flywheel-lead.sh:884-895` 同法）+ `ps -o lstart=` |
| `lead.activation_id` | 本单定义为 `<migration_id>:<activated_at>`（账本 P4b→P5 写下的激活事务标识，**不含 PID**）；Flywheel 全舰重启让标准 Lead 换代属于正常生命周期，不改变 activation；`lead.pid/process_started_at` 记 proof 时刻的活进程；所有 id 证据的时间戳必须晚于 `activated_at` |
| `lead.thread_id` | `<stateDir>/thread-id`（`codex-lead-runtime.ts:923`） |
| `lead.tui_visible` | `~/.flywheel/logs/lead-raya-raya.log` 在 `process_started_at` 之后含 `tui-window: real TUI up`（lead-in-any-repo.md:130 的成功判据）且 host tmux 选择上存在该窗口 |
| `business.*` | 账本 `.artifact.*` + `raya_sha` |
| `checks.preflight` | 重跑 `flywheel-lead.sh preflight <manifest>` rc 0 |
| `checks.unique_owner` | 恰一个 `com.flywheel.lead.raya-raya` pid；`com.xrli.raya.brain/voice` 未加载；无 `apps/brain/dist/cli.js run` 进程 |
| `checks.pump` | `verify --stage installed` 的 nudge 202（`flywheel-lead.sh:864-881`） |
| `checks.text_delivery_id / mailbox_acked` | `flywheel-comm message-status chat:raya:<messageId>`（`verify --message-id` #9 同法 `:912-924`）→ ACKED + delivered_at |
| `checks.outbound_message_id / bridge_sent` | `packages/teamlead/dist/bin/inspect-lead-outbound.js --state-dir --delivery-id --dedup-db`（`verify` #10 `:926-947`）→ `messageId` |
| `checks.bridge_identity_verified` | Bridge env 的 token 解出的 bot id == 注册 botUserId，且上面 `outbound_message_id` 的 Discord author id == 该 id |
| `checks.summary_round_id / summary_delivery_id` | `comm/raya/comm.db` mailbox 里 kind `summary_absorption_round`（`summary-absorption-rider.ts:228`）最近一行 delivered_at 非空 |
| `checks.alert_channel_id / alert_delivery_id / alert_reachable` | 公共 `scripts/lead-alert.sh --project raya --lead raya --kind activation_probe --strict-delivery`（新增 kind，见 §3.4）取回 messageId |
| `cutover.seed_digest / seeded_at / old_stopped_at / activated_at / channels` | 账本 `cursor.*`、`old_stopped_at`、`activated_at`、cursor 文件内容 |
| `cutover.window_message_id` | 账本 `.cutover_probe.message_id`（班车 P3 写） |
| `cutover.window_delivery_id / window_outbound_message_id` | 同 text 路径，对探针 id 查 message-status 与 outbound |
| `cutover.unresolved_count` | 0 |

### 1.6 回执与巡检

- v2 回执 30 键精确集合（`:413-422`）；`rollback_target` 首次为 null（`:424-445`）。
- 巡检 `lead-patrol-snapshot.sh:1104-1114`：`shuttle_stale=no` 需要回执 `schemaVersion 2 && carrier standard-lead && manifest carrier standard-lead` 且 `checked_at` ≤ 13h。P5 之后的 `refused` 回执已满足这三条 → 现有 `raya_checkout_overdue` 告警在**第一班之后**就会停（head 也已 ff 到 origin/main）。

## 2. 公共 Lead 生命周期（`scripts/flywheel-lead.sh`）

| 子命令 | 做什么 | 关键前置 | 行 |
|---|---|---|---|
| `register` | 拒绝 `--projects-file/--receipt-file` 覆盖；`config_write_locked projects.json.cfglock` 下 `lead-registry add`（原子改 projects.json + 重铸 summary receipt）→ `materialize-lead-manifests.sh` 渲染 `manifests/<p>-<l>.json` → 校验 manifest↔projects 绑定 → 打印 `effectiveAt:"next-bridge-restart"` | `~/.flywheel/.env`、config lock 工具、`--harness codex` 才得 `backend=codex-app-server`（`lead-registry-add.ts:92,136`） | 586-632 |
| `preflight <manifest>` | 只读：identity resolve、summary-registry `verify-activation`、bot token env 已设、`<projectRoot>/.lead/<lead>/identity.md` 可读、Codex home `~/.codex-<lead>` 存在 + `packages/standalone/current/codex` 可执行 + `auth.json` 存在 + `codex-home-link-truth.sh --inspect --lead raya/raya` 报 `state=="already"`、profile `full-access` + `codexCapabilities.eligible`、Bridge API token、dry-run runtime config | | 304-516 |
| `install` | 要求 manifest 已存在（缺则 78）；plist 若已存在必须同 label/argv；preflight 子壳；carrier 字节等同源码；写 plist `RunAtLoad+KeepAlive` 并 `launchctl bootstrap`（`supervisor.sh:241-242`） | **立刻起进程** | 746-770 |
| `verify --stage registered\|installed\|live [--message-id]` | registered：recovery intent 清、identity、verify-activation、preflight；installed：+ Bridge `/health` + `POST /api/lead-inbox/nudge` 必须 202（404 = "Bridge has not restarted"）；live：+ launchctl running 且恰一 pid + `<stateDir>/lead-inbox.sock`；`--message-id`：+ mailbox ACKED + outbound entry | | 792-949 |

`register` 支持本单需要的全部参数：`--roundtable-channel`、`--alert-channel`、`--alert-bot-token-env`、`--alert-fallback-to-core`、`--model-context-window`、`--summary-role`、`--can-spawn-runners`（`packages/flywheel-comm/src/commands/lead-registry.ts:342-349`）。2445 plan §6.3 的注册命令可原样用。

Codex home 准备（`engineering/doc/FLY-2444-flywheel-lead-launcher/lead-in-any-repo.md:71-82`）：`install -d -m 700 ~/.codex-raya` → standalone 安装（`CODEX_INSTALL_DIR=~/.codex-raya/.local/bin sh -c 'curl … install.sh | sh'`，产物 `packages/standalone/current/codex`）→ 凭据**不**由 founder 再登录一次，也不拷旧 `~/.flywheel/raya/codex-home/auth.json`（FLY-2401 前置 P2、2445 plan §3），而是 `scripts/codex-home-link-truth.sh --lead raya/raya ~/.codex-raya`（FLY-2404 helper，把 drained home 接到宿主共享真相；`--inspect` 报 `already` 即 preflight 通过条件）。

## 3. register 之后的连锁反应（必须在设计里显式处理）

### 3.1 16 席 digest 失效 → 需要立即全舰重启

- `lead-registry add` 重算 `summaryAssignmentDigest`→`identityDigest`；Lead 进程只在出生时把 `FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST / FLYWHEEL_LEAD_IDENTITY_DIGEST` 写进 env（`lead-identity.ts:574-578`）；`send/respond` 前比对不等即拒（`lead-lease.ts:2689-2699`）。
- scheduled 班车只在 Flywheel main 有新提交时重启（日志 `result=scheduled_current` 的班 20 秒结束；`restart-services.sh:1929` "Diff classification (build/install only; never restart scope)" 说明一旦重启就是全舰）。
- R4 允许的第二来源：`scripts/request-restart.sh`（founder 紧急票，目标 = `origin/main` 头，`update-flywheel.sh:598-622` 消费票后跑 `default_deploy` → `restart-services.sh` 全舰）。**同一次 founder 授权应同时覆盖 register 与这张票**。

### 3.2 全舰重启会把"已 register、未 install"的 raya 记成 failed

- `scripts/lib/lead-restart-lifecycle.sh:767-781`：`manifests/*.json` 逐个，projects.json 能解析 backend 就 `class=restart`（与 plist 是否存在无关）。
- `restart-services.sh:2405-2412` 只在 plist **存在**时做 authority 校验；codex backend 随后走 bootout/bootstrap（`:2521-2523` "bootstrap failed twice"）→ `failed+1`（`:2778-2782`）→ 部署失败处理。
- 对比：plist 在、manifest 缺 → `manifestless` → 只 warning + skipped（`:2790-2795`）。反向情况（manifest 在、plist 缺）没有对应的温和分类。

### 3.3 Bridge 对 raya 行的加载

- Bridge 在构造时读一次 roster：`resolveRaya(projects)`（`summary-absorption-rider.ts:162-176`，要求恰一行 `agentId=="raya"`）与 `findResidentCodexLeadTargets`；`register` 自己也说 `effectiveAt:"next-bridge-restart"`。
- 重启后判据：`verify --stage installed <manifest>` 在**没有 plist** 的情况下也能跑到 nudge 那一步就返回（`:882`），202 = pump 已挂。
- FLY-2401 research §7 记过 `createLeadRuntime` 首次失败会 "Skipping runtime for raya" 每 30s 重试，而 rider 先落去重行再 enqueue 失败会留下 `delivered_at=NULL` 的槽。因此 register→P5 之间的 6h 边界可能丢一槽（exploration §6 已列为边界）。

### 3.4 公共告警 kind

`scripts/lead-alert.sh:207` 的 kind 白名单是闭集，没有"探针"语义的 kind；`--strict-delivery` 才在 stdout 打一行机器可读结果（`:144-150`）。P6 的 `alert_delivery_id` 需要一个不会被误读为故障的 kind → 新增 `activation_probe`（info 级）。

## 4. 收信侧事实

- `RestPollDiscordInboundSource.ts:412` 只记录 `authorBot`；Lead 自己的 chat 频道不设 mention 门：`mention-gate.ts:151` `if (!isShared) return true`。⇒ 兄弟 bot 发到 #raya 的消息会入 mailbox。
- 旧壳没有游标文件（`~/.flywheel/raya/data/state/` 只有 `leads/`、`voice-*`）。
- Discord REST：`POST /channels/{id}/messages`（发探针）、`GET /channels/{id}/messages?before=…&limit=100` / `?after=<snowflake>`（分页回看停机前 15 分钟、按 nonce 回找已发探针）——均为公开 API，班车里已有 `lead-alert.sh` 的 REST 先例。snowflake 自带毫秒时间（`(id >> 22) + 1420070400000`），边界判定只用它，不用秒级 `raya_now_iso`。
- 旧壳（`0f77e977`）同时起 voice 与 meeting 两个独立 gateway（`apps/brain/src/cli.ts:147-226`），各自 detached async 处理，没有一条 Raya 出站能充当全入口 drain fence；两个 gateway 用 discord.js `message.reply`（`voice-mode.ts:629-638`、`meeting.ts:1036-1045`，带引用），`runtime.ts:279-305` 是 voice 告警的裸 POST；`brain.stdout.log` 为 0 字节、metrics 只记 token ⇒ **没有逐条处理的持久账**：reply 引用只能证明"某条被回过"，不能证明 calendar/meeting 副作用已完成或全入口已 drain。plan §5 B 因此不做处理推断：切换前置条件是频道已安静 15 分钟（无人类消息），停机窗口 [T0,T1] 内若有人类消息一律 `unresolved`；更早历史由 founder 授权行 `baseline=quiet15m` 明确划出补录范围（FLY-2445 §6.2 的"明确历史基线"路径，此处以 founder 授权替代"证明旧入口未运行"）。

## 5. Raya 仓侧事实（origin/main `9d63a2b2`）

- 顶层：`.lead/raya/identity.md`、`packages/cos/**`、`summaries/`、`probes/`（历史）、无 `apps/`。
- persona 要求外部工作区有 `memory/MEMORY.md`（identity.md:26-30），summary 由 `flywheel-comm summary merge --repo xrliAnnie/raya --pr <n> --round <roundId>` 合并（:54）。
- 9-9 班车已证明该 SHA 在生产宿主 `pnpm install --frozen-lockfile && pnpm build` 通过（updater 日志 5905-5952）。
- `raya_materialize_business` 只搬 `identity.md` 与 `packages/cos/{package.json,dist}`，**不搬 memory/state**；工作区 `memory/` 必须由激活包准备（从 `~/.flywheel/raya/memory` git 仓完整迁移，先把那 1 行未提交改动提交掉）。

## 6. 对设计的约束清单

1. 人手动作集合 = {workspace、Codex home、`register`、`request-restart.sh`、账本工具、文字探针、proof 工具}；不含 `install`、不含停旧壳、不含 `launchctl`。
2. Flywheel 必须新增：账本工具、proof 工具、班车 P3 探针+seed、账本缺席 info 跳过、授权字段→`ALLOW_LEGACY_STOP`、`pending-install` 分类、`activation_probe` kind。全部 source-only，随班车正常部署，不改 updater plist。
3. 顺序硬约束：register → 全舰重启（Bridge 认 raya、17 席 digest）→ 账本（工具内核 nudge 202、授权令牌行、两份旧 plist、探针 bot 真能发）→ 班车 N（pre-stop 全过才停旧壳，≤P5）→ 文字探针 + 一个 6h summary 轮 → proof → 班车 N+1（Flywheel 漂移则先自动 rebind；否则 P7）。
4. 冻结约束：账本写入到 P7 之间不得改 projects.json / summary receipt / canonical manifest（P6 digest 等式）；Flywheel 自身部署**不**冻结，由班车自动 rebind（`raya_validate_p6_manifest:394-400` 的 flywheel sha 等式在 rebind 后重新成立）。
5. 时间建议：register + 紧急重启 + 账本在 23:00–23:40 PT 完成，让 00:00 PT 班车做割接，把"Bridge 认 raya 但 Lead 未起"的窗口压到 1 小时内且避开 founder 活跃时段。
