# FLY-2896 满额时征得同意用充值卡续号并切过去 — 探索
Issue: FLY-2896 (https://linear.app/geoforge3d/issue/FLY-2896/claude-切号充值卡-5-小时额度到-80-90percent-且没有别的可用号时挑最晚自然重置的号征得-founder)
日期: 2026-09-25
基于: 无

## 0. 问题（founder 原话摘要）

2026-09-25 16:05 PDT：Claude 只剩 personal 有额度，5 小时窗打满后自动切号「停在那了」；而 business / school / shopping 周额度虽满，却各有一张「额度重置卡」（下称**充值卡**：Anthropic 发的一次性「把用量窗清零」权益）。founder 手动给 business 用卡并切号。她要：

1. 在用号 5h（或周）用量 ≥ 80~90%（默认 85%，可配），且**没有别的可直接切的号**时，进入充值卡候选流程；有可直接切的号就照常切，不打扰她。
2. 在「有卡、但额度已满」的号里挑**自然重置最晚**的那个（越晚重置，用卡越划算）；并列取剩余卡多的。
3. 用卡前必须先问她（要你批）；只有明确同意才执行；拒绝/超时 = 不动，并在额度页/告警标「已满、等你决定」。**任何情况下不自动用卡。**
4. 同意后：用卡 → 走现有切号 → 用真实读数确认新号可用 → 记审计。
5. 切完衔接 FLY-2830 的「切号后全量重读」。

## 1. 现状审计（file:line 以本分支 HEAD `9e3ba1175` 为准）

路径均相对 `packages/teamlead/src/`。

### 1.1 谁在切号、何时切

- **唯一的自动切号执行者是外部守护进程 quota-monitor**（launchd KeepAlive：`scripts/com.flywheel.quota-monitor.plist.template` → `scripts/flywheel-quota-monitor-wrapper.sh` → `account-heal/quota-monitor-cli.ts:252 main`）。Bridge 的切号执行面在 FLY-1456 已永久退役（`bridge/quota-daemon-cutover.ts:9-21`，`attachAccountSwitch:false`）。⇒ **本单的「用卡 + 切号」也必须由守护进程执行**，Bridge 只能做它擅长的事（发 Discord 卡、读 founder 的回应）。
- 轮询：`pollOnce`（`quota-monitor.ts:1547`）。在用号 usage 每 20 min 读一次，5h >70%（`acceleratePct`）时 10 min 一次；SIGUSR1 可提前唤醒（`installWakeCapability`，Bridge 侧 `bridge/quota-daemon-wake.ts:68`）。
- 阈值：`account-heal/quota-monitor-config.ts:21-35`，文件 `~/.flywheel/quota-monitor.json`。`trigger5hPct` 默认 **90**；**周窗固定 100% 才触发**（`triggerScope`，`quota-monitor.ts:268-278`）；`order` 为空 = monitor-only，永不切。
- 候选：`verifyAndRankCandidates`（`account-candidate-selector.ts:160-378`）。排除码：`pool` / `auth` / `cooldown`（`switchCooldownUntil` 未到，**在读 usage 之前就排除**，`:227-247`）/ `model` / `unverifiable`（凭据校验或 usage 读失败）/ `quota`（`fiveH≥100 || sevenD≥100`，`:300-308`，这些号**已被真读过一次**）。
- 没有候选：7d 主导时先试一个冷却回退（`quota-monitor.ts:2054-2080`），仍无 → `openBlockedEpisode`（`:913`）发 `quota_no_target` 严重告警「No verified Claude account has quota」，`finish("no_target")`。每 30 min 重发、每个 episode 最多 10 条。**没有任何卡相关逻辑** —— 这就是 founder 看到的「停在那了」。

### 1.2 切号怎么执行

`attemptSwitchWithDriftRecovery`（`quota-monitor.ts:1149`）→ `switchAccount`（`switch-executor.ts:679`）：在 `withAccountsLock`（`accounts-lock.ts:126`，mkdir 锁 + 过渡日志回放）内做 generation CAS → `selectNextAccount`（`account-store.ts:496`）→ `applyProfile`（`flywheel-claude-profile use <name>`）→ `commitSwitch`（`switch-executor.ts:565`）：generation+1、`activeAccount`、`lastSwitch{generation,triggerKind,from,to,at}`，并把**被切走的号**的 `quotaExhaustedUntil` 与 `switchCooldownUntil` 设为其重置时刻（`:594`），入队 `account_switched` 通知。切后 `refreshNewActive`（`quota-monitor.ts:1225`）best-effort 读一次新号 usage，读不到就算了，无回滚。

两个会咬本单的事实：

- **冷却会挡住用卡后的号**。被切走过的号 `switchCooldownUntil = 其重置时刻`；selector 和 `selectNextAccount`（`account-store.ts:526`）都排除它；live 读数从不清它（`account-store.ts:67`）。现有旁路只有 manual override（仅 `trigger.kind==="manual"`）与 cooldown fallback（仅 7d 主导的 quota 触发，`switch-executor.ts:800-829`）。⇒ 需要一条**只放行「刚用过卡的那一个号」**的窄旁路。
- **`lastSwitch.triggerKind` 是闭集校验**（`account-store.ts:266-280`，`ACCOUNT_SWITCH_TRIGGER_KINDS`）。若新增一个 `reset_card` kind，回滚到旧二进制时旧校验会把整个 `claude-accounts.json` 判为非法 ⇒ **不能新增 triggerKind**；用卡后的切号在 store 里仍记为 `quota`，用卡事实另写审计。

### 1.3 充值卡读数（FLY-2864 已上线）

- `claude-quota/account-detail-observer.ts`：`GET /api/oauth/usage?cedar_ember=1&skip_spend=1`（UA 必须是 `claude-cli/<本机版本> (external, cli)`，否则服务端报 `surface` 不给卡），`parseClaudeResetGrants`（`:111`）解析成 `{known, reason, grants:[{resetsLeft,resetsTotal,endsAt}]}`。
- 只在 Bridge 进程里、按需（额度页 `?refresh=1`）跑；store `~/.flywheel/claude-quota/account-details.json`。**不存 grant id**（`account-detail-store.ts:39-44`），也**不存** `next_grant_id / usable_now / paused / clears / at_limit / exhausted`。守护进程读不到新鲜的卡数据。
- 仓内**没有任何领卡代码**，并明确声明永不发 `reset_rate_limits`（`account-detail-observer.ts:28-31`）。本单是第一个会花卡的代码 ⇒ 必须把「只有 founder 批准才发 POST」做成结构性保证，而不是约定。

### 1.4 founder 同意的现成机制

- 仓内**没有**「自动化 infra 动作等 founder 同意」的先例；切号/Codex/重启都只发告警。
- 最接近、已在 Bridge 里用的是 **✅ 反应确认**：`lead-backends/codex/gateway/founder-confirmation.ts:122 checkReactionConfirmation`（按 founder 精确 id 分页读 reactors，任何 403/404/429/畸形 = 不算同意，fail-closed），Bridge 的 `bridge/gate-poller.ts:3558-3600` 已在 GatePoller tick 里用它。完整状态机样板在 `lifecycle-orchestrator.ts`（请求 id + nonce、过期即编辑卡为「已过期」、确认一次即终局、重启后已 claim 的不盲目重跑）。
- founder id：`bridge/approval-signal/canonical-founder-id.ts:22 deriveCanonicalFounderId`（两处配置不一致 → null，fail-closed）。
- Bridge 发/改 Discord：`bridge/discord-utils.ts:212 postDiscordMessageToChannel`、`:333 editDiscordMessageInChannel`、`:461 reactDiscordMessageInChannel`。
- 按钮方案（customer-release，`bridge/customer-release/*`）需要独立 bot token 与 websocket 会话、按钮 id 模式写死为 release，不适合。`founder_ask`（Lead 在 thread 里问）没有批准/拒绝语义也没有超时，不适合。

### 1.5 FLY-2830（切号后全量重读）

PR #1330 未合入 main。它新增 `bridge/switch-refresh-trigger.ts`：Bridge 每个 tick 读 `claude-accounts.json` 的 `lastSwitch.generation`，**变大即**触发 Claude 全量 sweep 请求 + Bridge 侧全量刷新（含卡）。⇒ 只要本单的切号走现有 `switchAccount`（generation 照常 +1），2830 的全量重读**自动发生，零接线**。本单不应复制它。

## 2. 充值卡的服务端合同（从本机 Claude Code 2.1.283 二进制读出，只读）

详见 research.md §1。要点：

- 领卡：`POST https://api.anthropic.com/api/organizations/{orgUuid}/reset_rate_limits`，body `{program:"cedar_ember", grant_id, request_id}`，OAuth Bearer + `anthropic-beta: oauth-2025-04-20` + CLI UA；`request_id` 是幂等键（客户端对 10 min 内未确认的请求复用同一个）。
- 结果 `result ∈ {reset, already_used, not_limited, cooldown, ineligible, unavailable}`。
- **卡默认只能在「已触顶」时用**（`use_requires_limit` 默认 true；否则服务端回 `not_limited`，什么都不花）。卡的 `clears[]` 必须覆盖该号已触顶的窗（`exhausted[]`），`blocking[]` 非空表示有它清不掉的窗。
- 客户端只提供 `next_grant_id` 指定的那张卡，且要求 `usable_now && !paused` 且未过期。

⇒ 天然契合本单：卡用在**已满的目标号**上（满足「已触顶」），不是用在在用号上。

## 3. 设计选项

### 3.1 由谁执行「用卡 + 切号」

| 选项 | 说明 | 结论 |
|---|---|---|
| A. 守护进程提议、Bridge 征得同意、守护进程执行 | 守护进程写「提议」文件；Bridge 发卡、读 ✅/❌、写「决定」文件并 SIGUSR1 唤醒；守护进程复核后用卡 + `switchAccount` | **选定**。遵守 FLY-1456「守护进程是唯一自动切号执行者」，凭据刷新/锁/CAS 全在守护进程里现成 |
| B. Bridge 全包 | Bridge 自己领卡、调 `flywheel-claude-switch use` | 否：重开 Bridge 切号执行面（违反 FLY-1456 真值表），与守护进程的锁/冷却/generation 竞争 |
| C. 守护进程全包（自己读 Discord 反应） | 守护进程拿 bot token 轮询反应 | 否：守护进程今天只有单向 `lead-alert.sh`，给它 Discord 读能力是新的凭据面 |

### 3.2 怎么问 founder

| 选项 | 结论 |
|---|---|
| ✅/❌ 反应卡（复用 `checkReactionConfirmation`） | **选定**。Bridge 已在用，fail-closed，重启可续（消息 id 持久化） |
| Discord 按钮 | 否：需独立 bot 与 gateway 会话 |
| Lead 代问（founder_ask） | 否：无批准语义、无超时，且让 Lead 进入花卡链路 |

### 3.3 怎么花卡

| 选项 | 结论 |
|---|---|
| 直接 HTTP POST，逐字复刻 CLI 合同（UA、body、幂等 request_id） | **选定**。可测、可审计、幂等 |
| 在该 profile 下起一个交互式 `claude` 会话发 `/limit-reset` | 否：驱动 TUI 脆弱、难以拿到结构化结果、难以测试 |

### 3.4 选号口径

- 「自然重置」= 让该号**恢复可用**的时刻 = 它所有已触顶（≥100%）窗的 `resets_at` 的**最大值**（5h 满且周满时，要等周重置才真的可用）。
- 选最晚的；并列（同一分钟）取 `resets_left` 总和多的；再并列按名字。
- 只考虑：被排除原因**仅**是额度（`quota`）或额度引起的冷却（`cooldown`）的号；`auth / pool / model / unverifiable / unavailable / 已取消订阅` 一律不碰。

## 4. 本单不做

- 不改现有 90%/100% 切号阈值与候选排序；不改 FLY-2864 额度页读卡逻辑；不做 Codex 兑换卡（另一套）。
- 不自动用卡；不在 founder 未回应时「先斩后奏」；不重试被拒绝的提议（同一 episode 内不再问）。
- 不实现「预计能撑多久」的精确预测，只给基于当前用速的粗估并写明口径。
