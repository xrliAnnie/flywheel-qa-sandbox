# Task 0 — 生产配置核对 + 证据（只读，2026-07-11)

采集时间: 2026-07-11 ~14:00 PT · 采集者: implement runner be8e3e48 · 全程只读（0.3 freshness 探测只写池文件，不碰真 Keychain）

## 0.1 `~/.flywheel/.env` 核对 — PASS

| key | 值 | 判定 |
|---|---|---|
| FLYWHEEL_ACCOUNT_SELF_HEAL | 1 | ✅ |
| FLYWHEEL_CLAUDE_PROFILE_BIN | /Users/xiaorongli/Dev/flywheel/packages/claude-runner/bin/flywheel-claude-profile | ✅ 存在且可执行（test -x 通过） |
| FLYWHEEL_AUTO_REPAIR | 1 | ✅ |
| FLYWHEEL_NOTIFY_CHANNEL | 1521630422918758472 | ✅ |
| FLYWHEEL_NOTIFY_DIGEST_EXPECT | 1 | ✅ |
| CLAUDE_INFRA_BOT_TOKEN | <redacted, 已设> | ✅ |
| FLYWHEEL_INFRA_BOT_USER_ID | 1523219324561522831 | ✅ |
| FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID | 1518793447165661254 | ✅ |
| FLYWHEEL_ALERT_ROUTING / FLYWHEEL_ALERT_TICKETS | 1 / 1 | ✅ |
| FLYWHEEL_QUOTA_STUCK_RESCUE | 未设 | ~~预期 — 本单 Task 1 新建的 flag~~ **已作废**（lead-instruction flag-removal）：翻活不设独立 flag，随 self-heal enable 路径 + merge/重启直接生效 |

## 0.2 活 Bridge 进程 env — PASS（装配条件在当前实例满足）

- Bridge 主进程 PID **10469**，启动于 **Jul 11 06:06AM**（ps 实测）。
- `ps eww 10469` 过滤 FLYWHEEL_* 实测进程 env 含：SELF_HEAL=1、PROFILE_BIN=主仓 bin、
  AUTO_REPAIR=1、NOTIFY_CHANNEL、NOTIFY_DIGEST_EXPECT=1、INFRA_BOT_USER_ID、
  UNIFIED_ALERT_CHANNEL_ID、ALERT_ROUTING=1、ALERT_TICKETS=1、CLAUDE_INFRA_BOT_TOKEN（present，redacted）。
- ⇒ plugin.ts:5988 `FLYWHEEL_ACCOUNT_SELF_HEAL==="1"` 与 :6015
  `accountSwitchRepair && unifiedAlertChannelId` 两道装配条件在**当前生产实例**均满足，
  watchdog tick 已随 30s poll 运行。**引擎 live，issue 的「dormant 出厂」假设已过时**
  （与 exploration §2 审计一致）。

## 0.3 池健康 — PASS（一处 stale finding）

- `flywheel-claude-profile list`: business(active) / personal / school / shopping — 4 账号。
- `flywheel-claude-profile status`: Active profile = business。
- `~/.flywheel/claude-accounts.json`: generation=1、activeAccount=business、全员
  quotaExhaustedUntil=null（至今零切换）。
- pending 文件 `~/.flywheel/account-switch-pending.json`: **不存在**（无积压）。
- 池目录权限: `claude-profiles/` 0700，各账号目录 0700。

### freshness 探测（flywheel-claude-freshness verify，逐个非 active 账号）

| 账号 | 退出码 | 判定 |
|---|---|---|
| personal | 0 | ✅ fresh（refresh 成功，池内凭据已 rotate） |
| school | 0 | ✅ fresh |
| shopping | **30** | ❌ **STALE — refresh 被拒（HTTP 400），池内 refresh token 已死** |

**Finding F-0.3**: shopping 池凭据 stale。影响面：切换引擎若选中 shopping 为目标，
`use` 会 exit 30 fail-closed 拒切 → needs_human（**保护行为，非 bug**）。轨B 不受阻
（selectNextAccount 会有 personal/school 两个 fresh 候选）。处置：报 Tadashi 调度 Annie
重 capture shopping（founder 动作）；不算 QA FAIL。

## 0.4 bot-claim 通知接线审计 — 结论（按当前 HEAD 实读代码）

**问题**：成功切换的 pending 窗口内，Codex bot 有没有被任何帖点名？

**答：有 —— enqueue 即点名；真偏差是 20s claim 窗对 LLM bot 过紧。**

1. **Enqueue path（有 @-mention）**：`AlertChannelHub.ts:496-508` —— repair.outcome
   为 "attempted" 且 `repair.action === "account_switch"` 时，enqueue 帖即为 Codex
   Infra Bot 的 ASSIGNMENT，显式 `mentionUserId: infraBotId()` @ bot（FLY-871 R2/W6
   注释原文：让 FLY-267 mention-gate 唤醒 bot 去 claim pending switch）。env 未设 ⇒
   不 mention = byte-compat，watchdog deadline 仍兜底。
2. **Post-result path（mention 仅在 needs_human）**：`plugin.ts:6026-6048` ——
   `capOwnerId` 只在 `disposition?.outcome === "needs_human"` 时经
   `resolveAccountCapOwnerId()` 解析并 mention；成功（switched）走 plain detail 帖 +
   `postInfraNotifyDigest`（🟡 digest 到 #flywheel-notify）。
3. **时序事实**：pending claim deadline 默认 **20_000ms**（`account-switch-repair.ts:93`），
   Bridge watchdog 30s poll 兜底 ⇒ 生产里 LLM bot（Discord 唤醒 → 读上下文 → 调 route）
   几乎必输给 watchdog。

**Finding F-0.4**（进 qa-report，按实测条件化书写）：PRD CMP-1「交叉互救」叙事与接线
**无结构性偏差**（成功 enqueue 路径有点名），偏差是**时序性的** —— 20s claim 窗对 LLM
bot 过紧，bot 实际抢不到 claim，生产切换几乎总由 watchdog 执行。deadline/接线改动 =
follow-up，不进本单。轨A 2.9 用加长 deadlineAt 的注入验 bot 真路径。
