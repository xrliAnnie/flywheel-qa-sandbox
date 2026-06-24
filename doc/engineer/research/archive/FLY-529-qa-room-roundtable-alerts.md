# Research: QA Testing Room — Roundtable + Alerts mirrors — FLY-529

**Issue**: FLY-529 (QA Testing Room 隔离环境 — 自己的 runs table + 报错 channel)
**Date**: 2026-06-24
**Source**: `doc/engineer/exploration/` (brainstorm 经 BRAINSTORM GATE 与 Tadashi 确认, 见下 §0)

---

## 0. Brainstorm 结论 (gate-confirmed)

经 BRAINSTORM GATE 与 flywheel-eng-lead (Tadashi) 逐条确认:

- **Q1 范围 = YES**: 529 交付 QA *能力/房间* — channel + 接线 + runs table + suite 脚手架。FLY-314 / FLY-368 各自的 E2E 留它们自己下游 QA,不在 529 内。
- **Q2 形态 = YES**: 扩展现有 `scripts/test-deploy.sh` + `~/.flywheel/test-slots.json` + `packages/qa-framework` + 复用 `flywheel-qa-sandbox`,**不另起新 sandbox**。
- **Q3 代码改动 = YES 接受**: alert 隔离需一处生产代码改动 (plugin.ts env-override),default 不设 env = 字节兼容,走 Codex code review。
- **Q4 = 同意 (a) + 硬要求**: 529 只把房间接好 + smoke 证 bridge-side auto-thread 触发 + 隔离不漏生产;多-lead reply-in-thread 真 E2E 留 FLY-314。**硬要求**: 529 房间必须能 **host ≥2 个 test lead 在 test roundtable** (≥2 slot 能同在该 channel),否则 314 下游 QA 没法做。529 验收 = "房间能放 2 lead + auto-thread 触发 + alert 隔离" 即够,不用真起 Codex lead 跑完整 reply-in-thread。

---

## 1. 现有 QA Testing Room (already built — 复用基线)

"GeoForge3D 已搭好的 QA Room" 实指**这套共享的 4-slot 测试框架** (extracted from GeoForge3D QA Agent v2 / GEO-308;test slot 的 identity 从 `~/Dev/GeoForge3D/.lead/*/identity.md` source)。`~/Dev/GeoForge3D` 没有独立的 test-slots — QA Room = 共享的 `~/.flywheel/test-slots.json`。

| 组件 | 位置 | 说明 |
|------|------|------|
| Slot 配置 | `~/.flywheel/test-slots.json` | 4 slot: cos-test / product-lead-test / ops-lead-test / finance-lead-test。每 slot: 自有 bot + channel + bridgePort + role/identitySource。已有 `mirrorChannel` (FLY-153 共享频道)。 |
| Deploy | `scripts/test-deploy.sh` | 起一个 slot 的 Bridge + Lead。`--mode slot|mirror`,`--from-branch`。每 slot 自己的 `TEAMLEAD_DB_PATH=${SLOT_DIR}/teamlead.db` + `${SLOT_DIR}/discord-state/`。 |
| Inject runner | `scripts/inject-linear-issue.sh` | POST `/api/runs/start` 起真 Runner。 |
| Teardown | `scripts/test-teardown.sh` | 杀 Runner/Lead/Bridge + 清 worktree + CommDB。 |
| Mirror 模式 | FLY-153 (`--mode mirror`, `mirrorChannel`) | **最接近的 analog**: slot 1-3 共享一个 `test-core-mirror` channel,allowBots 互加。 |
| 框架包 | `packages/qa-framework/` | suites/、templates/、orchestrator/、config loader。 |
| Sandbox | `xrliAnnie/flywheel-qa-sandbox` | Runner push 目标 (standalone repo seeded from main)。`doc/qa/framework/sandbox-sync-guide.md`。 |

**Discord QA guild**: `1485787271192907816` / category `1493080958889496760` ("QA Testing")。新 channel 由 **Annie 手建** (test bot 无 `MANAGE_CHANNELS` 权限,perms `68608`),setup helper 探测 + patch test-slots.json (见 `setup-mirror-channel.sh` 模式)。

**已确认的隔离基线** (`packages/qa-framework/README.md:83-89` "Key wire facts"):
- StateStore = `${SLOT_DIR}/teamlead.db` (= `/tmp/flywheel-test-slot-N/teamlead.db`)。**`roundtable_topic_threads` runs table 已天然隔离** (每 slot 独立 db)。
- CommDB = `~/.flywheel/comm/test-slot-N/comm.db`。
- **缺口实证 (README:88)**: "V3 alert evidence comes from `~/.flywheel/alerts/claims.db` + `~/.flywheel/alert-queue/*.json` … Discord channel push is **not** validated in this suite because **test-slot config does not wire `alertChannel`**." → 这正是 529 要补的 alert 缺口。

---

## 2. Gap 1 — Round Table 镜像

### 2.1 生产 roundtable 机制 (要镜像的对象)

- **Bridge-side auto-thread** (`RoundtableThreadManager`,vendor-neutral): 轮询 roundtable channel,识别 topic 消息 (按 trigger mode),建 Discord thread,把 member lead 拉进 thread。
  - 启动: `plugin.ts:2654` `loadRoundtableConfig(process.env)` → 非 undefined 时 `new RoundtableThreadManager({...})` + `.start()`。
  - 配置契约 (`packages/teamlead/src/bridge/roundtable/roundtable-config.ts:66-137`):

    | env | 必需? | 说明 |
    |-----|------|------|
    | `FLYWHEEL_ROUNDTABLE_ENABLED` | gate | 必须 `=1` 才启用;否则返回 undefined (字节兼容,不建 poller)。 |
    | `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` | ✅ | roundtable 频道。 |
    | `FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV` | ✅ | 持有 bot token 的 env var **名**。 |
    | `FLYWHEEL_ROUNDTABLE_BOT_USER_ID` | ✅ | poller bot 自己的 Discord user id。 |
    | `FLYWHEEL_ROUNDTABLE_TRIGGER_MODE` | 可选 | `disabled`(默认)`|explicit_prefix|any_lead_mention|broadcast|any_top_level`。坏值 warn→disabled。 |
    | `FLYWHEEL_ROUNDTABLE_TRIGGER_PREFIXES` | 可选 | CSV,默认 `📋,TOPIC:`。 |
    | `FLYWHEEL_ROUNDTABLE_MIN_MENTIONS` | 可选 | 默认 2。 |
    | `FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS` | 可选 | 建 thread 时拉进的成员。 |
    | `FLYWHEEL_ROUNDTABLE_POLL_INTERVAL_MS` | 可选 | 默认 3000。 |
    | `FLYWHEEL_ROUNDTABLE_INBOUND_CURSOR_PATH` | 可选 | **默认 `~/.flywheel/roundtable-inbound-cursor.json` (共享!)** — 隔离需指向 SLOT_DIR。已 env-override,无需改代码。 |

- **runs table** = `roundtable_topic_threads` (`StateStore.ts:559-573`): `(thread_id PK, channel_id, source_message_id, author_id, trigger_mode, created_at, discord_missing_at, archived_at)`,UNIQUE(channel_id, source_message_id) 去重。CRUD: `upsertRoundtableTopicThread` / `getRoundtableTopicThread` / `markRoundtableTopicThreadMissing`。**每 slot 的 teamlead.db 独立 → 已隔离。**

- **Lead-side reply-in-thread** (Codex-lead,FLY-314 Phase 2): `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` + `FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD=1` + `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` + `FLYWHEEL_ROUNDTABLE_GUILD_ID`。**Q4(a): 留给 314 下游 QA,529 不跑。**

### 2.2 529 要补的 (Round Table)

1. **隔离 channel**: Annie 在 QA guild 手建 `test-leads-roundtable` → setup helper 探测 + patch `test-slots.json.roundtableChannel`。
2. **≥2 test lead 同在 channel** (硬要求): ≥2 slot 的 Lead 订阅该 channel (access.json groups + identity override + cross-bot allowBots),mirror FLY-153 拓扑。
3. **恰 1 个 Bridge 跑 auto-thread manager** (关键): 每 slot 自有 Bridge + 独立 dedup db;若 ≥2 Bridge 同跑 manager 对同 channel → **重复建 thread**。故须**指定唯一 host slot** (config `hostSlot`),仅它的 Bridge 设 `FLYWHEEL_ROUNDTABLE_ENABLED=1`。
4. **隔离 cursor**: host Bridge 设 `FLYWHEEL_ROUNDTABLE_INBOUND_CURSOR_PATH=${SLOT_DIR}/roundtable-inbound-cursor.json` (否则吃/污染生产 cursor)。
5. **runs table**: 已天然隔离 (host slot 的 teamlead.db)。

---

## 3. Gap 2 — Flywheel Alerts 镜像 (FLY-368)

### 3.1 生产 alert 机制

- **统一 channel** (FLY-368): `plugin.ts:2713` `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 设了就把**所有** Lead/Runner alert 路由到一个 channel。owner-attributed send (stuck agent 自己的 bot → Cass repair bot → alphabetical fleet)。
- **per-error threading + Cass auto-repair** (`AlertChannelHub`): `FLYWHEEL_ALERT_THREADS=1` + `FLYWHEEL_AUTO_REPAIR=1`。repair bot env: `FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV` (默认 `CASS_BOT_TOKEN`)。`alert_threads` 表 (`StateStore.ts:619-636`)。
- **filesystem 队列** (`LeadAlertNotifier`):

  | 路径 | env-override? | 默认 |
  |------|--------------|------|
  | claims.db | ✅ `FLYWHEEL_CLAIMS_DB` (`lead-alert-helpers.ts:31-33`) | `~/.flywheel/alerts/claims.db` |
  | queueDir | ❌ **Bridge 没接 env** (`plugin.ts:2725` 构造 `LeadAlertNotifier` 未传 `queueDir`) — config 项**存在** (`LeadAlertNotifierConfig.queueDir`, `LeadAlertNotifier.ts:149,222`) 但只走默认 | `~/.flywheel/alert-queue` |
  | deadLetterDir | ❌ **同上** (`LeadAlertNotifier.ts:156,232`) | `~/.flywheel/alert-deadletter` |

### 3.2 隔离风险 (为何必须改一处代码)

QA 期间**生产 Bridge 在跑**。若 test Bridge 把 alert queue 文件写进**共享** `~/.flywheel/alert-queue/`,生产 Bridge 的 drainer 会捞起这些文件并尝试 POST → **跨污染** (用生产 bot chain 发到测试 channel,且污染生产 dead-letter/meta-alert)。故 queue/deadletter **必须**隔离。

### 3.3 529 要补的 (Alerts) — **最小代码改动**

- **claims.db 隔离**: 设 `FLYWHEEL_CLAIMS_DB=${SLOT_DIR}/alerts/claims.db`。**已 env-override → 0 代码。**
- **queueDir / deadLetterDir 隔离**: Bridge 构造 `LeadAlertNotifier` 时**没接** env。
  → **唯一生产代码改动**: `plugin.ts` 读 `FLYWHEEL_ALERT_QUEUE_DIR` + `FLYWHEEL_ALERT_DEADLETTER_DIR`,传入构造器 (config 字段已存在)。**default undefined = 当前共享路径 = 字节兼容。**
  → 为 TDD 抽纯函数 `resolveAlertDirsFromEnv(env): { queueDir?, deadLetterDir? }`,单测 RED→GREEN,plugin.ts 调用它。
- **alert channel**: Annie 手建 `test-flywheel-alerts` → setup helper patch `test-slots.json.alertChannel`。
- test Bridge 设 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=<test alert channel>` + repair bot env + 可选 `FLYWHEEL_ALERT_THREADS=1`/`FLYWHEEL_AUTO_REPAIR=1`。

---

## 4. 结论 — 实现面 (导向 plan)

| # | 改动 | 类型 | 隔离已就绪? |
|---|------|------|------------|
| 1 | `plugin.ts` 接 `FLYWHEEL_ALERT_QUEUE_DIR` / `DEADLETTER_DIR` env-override (+ 纯函数 `resolveAlertDirsFromEnv`) | **生产代码** (字节兼容) | queue/deadletter 否→本改动补 |
| 2 | `test-slots.json` schema + example: `roundtableChannel{channelId,channelName,hostSlot,triggerMode}` + `alertChannel{channelId,channelName,repairBotTokenEnv?}` | config | — |
| 3 | `test-deploy.sh`: `--mode roundtable` (host slot 起 manager + 隔离 cursor;member slot 仅订阅;allowBots 互加) | shell | cursor/runs-table 是 |
| 4 | `test-deploy.sh`: `--alerts` 加性 flag (任意 mode 可用): 设 unified alert channel + 隔离 queue/deadletter/claims dirs (SLOT_DIR 下) + repair bot | shell | claims 是;queue/deadletter 靠 #1 |
| 5 | `setup-roundtable-channel.sh` + `setup-alert-channel.sh` (仿 `setup-mirror-channel.sh`: bot 权限探测 + patch test-slots.json) | shell | — |
| 6 | smoke: `qa-fly-529-roundtable-smoke.sh` (post topic → 验 thread + runs-table row + cursor 落 SLOT_DIR) + `qa-fly-529-alert-smoke.sh` (触发 alert → 验落 test channel + queue/claims 落 SLOT_DIR 非 ~/.flywheel) | shell/QA | — |
| 7 | 单测: `resolveAlertDirsFromEnv`;shell `__tests__/*.test.sh` 断言 deploy 在 roundtable/alerts 模式注入正确 env | test | — |
| 8 | docs: qa-framework README + real-runner-e2e-guide + suite `fly-529-*.md` | docs | — |

**版本**: 暂定 v1.56.0 (VERSION=v1.55.0;FLY-494 已占 v1.55.0)。ship 时按实际 re-version。
