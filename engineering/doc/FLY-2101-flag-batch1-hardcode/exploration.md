# FLY-2101 flag·B1 固化删 13 个运行时 env flag — 探索

Issue: FLY-2101 (https://linear.app/geoforge3d/issue/FLY-2101/flagb1固化-13-个运行时读的-env-flag-全部固化删写死现值为常量删-env-读点与名册条目mailbox-queue)
日期: 2026-08-27
基于: 无(上游是 founder 8-27 v4 裁定,直接落在 issue 正文)

## 1. 问题界定

Founder v4 裁定:13 个「运行时读的 env flag」全部固化删。理由:`.env` 从没人设过这些值,
没有人能回答「谁、在什么场景会去动它」。一个没有操作者的旋钮不是能力,是审计负担 —— 每个
flag 在名册(`registry.ts`)、真值守卫(`truth.ts`)、drift 扫描、dashboard 渲染、退役扫描里
各占一行账,而它唯一的「使用记录」是每周被巡检问一次「留还是清」。

本单是 Batch 1(无依赖);B2(9 个启动/CLI 时读的)、C(config.yaml)不在本单;D 依赖本单。

## 2. 裁定内容(固化值即现默认值)

| # | flag | envVar | 固化 | 附加删除 |
| - | ---- | ------ | ---- | -------- |
| 1 | founder_review_orphan_monitor | FLYWHEEL_FOUNDER_REVIEW_ORPHAN_MONITOR | 常开 | `=0` 早退分支 |
| 2 | mailbox_queue | FLYWHEEL_MAILBOX_QUEUE | 常开 | **FLY-1572 旧投递流整条**(=0 回切路)+ deploy barrier 子系统 |
| 3 | liveness_activity_window_ms | FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS | 600000 | resolve.ts 镜像 sanitizer 特判 |
| 4 | merge_approval_gate_killswitch | FLYWHEEL_MERGE_APPROVAL_GATE | 门常在 | **`=0` 绕过 verifyApproval 分支**(founder 8-22:不应有全局 Hard Gate 阀) |
| 5 | issue_gate_supersede_mode | FLYWHEEL_ISSUE_GATE_SUPERSEDE | enforce | observe 分支 + `=0` 早退 |
| 6 | deferred_approval_ttl_ms | FLYWHEEL_DEFERRED_APPROVAL_TTL_MS | 2700000 | — |
| 7 | founder_reply_deadletter_age_ms | FLYWHEEL_FOUNDER_REPLY_DEADLETTER_AGE_MS | 1800000 | — |
| 8 | ship_gate_grace_ms | FLYWHEEL_SHIP_GATE_GRACE_MS | 15000 | 「设 600000 回 FLY-605 旧行为」路 |
| 9 | external_merge_reconcile | FLYWHEEL_EXTERNAL_MERGE_RECONCILE | 常开 | `=0` 早退分支 |
| 10 | merge_reconcile_window_days | FLYWHEEL_MERGE_RECONCILE_WINDOW_DAYS | 7 | — |
| 11 | ship_gate_card_grace_ms | FLYWHEEL_SHIP_GATE_CARD_GRACE_MS | 15000 | — |
| 12 | done_thread_reconcile_interval_min | FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN | 360 | — |
| 13 | done_thread_reconcile_max_per_run | FLYWHEEL_DONE_THREAD_RECONCILE_MAX_PER_RUN | 25 | — |

关键事实(行为零变化的根据):**13 个固化值全部等于代码里的现默认值**,且生产
`~/.flywheel/.env` 中唯一被显式设置的是 `FLYWHEEL_MAILBOX_QUEUE=1` —— 对 default-on flag
是 no-op。删读点 = 行为不变。

## 3. 核心张力(需在 plan 里裁决的三件事)

### 3.1 tombstone vs「rg 零命中」
既有退役惯例(FLY-1806/1807/1808/1981/2075)是往 `truth.ts` 的 `RETIRED_FLAGS` 加
tombstone,让残留的 `.env` 行报「已退役假开关,删这行」。但本单验收明确写
「`rg 'FLYWHEEL_(…)' packages scripts` 零命中(含 dist 外全部源)」—— tombstone 字符串本身
就是一个 rg 命中。两者不可兼得。
**倾向:遵循字面验收,不加 tombstone。** 代价:残留 env 行从「已退役,删这行」降级为
「unknown FLYWHEEL environment variable」—— 仍 fail-loud,只是措辞不带历史。部署说明里
由 Lead 删掉那一行,把这个窗口关掉。(交 codex-design-review 复核。)

### 3.2 mailbox_queue 的「旧路」半径
`=0` 回切路不止是几个 if:整个 **deploy barrier 子系统**(TS 模块 + CLI + shell lib +
restart-services.sh 编排段 + 两套测试)存在的唯一目的,就是在部署窗口把
`FLYWHEEL_MAILBOX_QUEUE` 压成 0 再恢复。flag 固化后它不但死,而且**有害**——它还会往
`.env` 里写 `=0` 行,与「零命中/删行」目标直接冲突。必须连根删。
同族:inbox-mcp 侧 `processPendingDeliveries`(queue on 时恒空转)与
`resolveLiveMailboxQueueEnabled`、flywheel-comm 的单条 claim/settle 旧方法、
`MailboxQueueConfig.enabled` 字段本身。

### 3.3 merge 门测试生态
不少测试用 `FLYWHEEL_MERGE_APPROVAL_GATE=0` 当捷径绕过 merge 门来测别的东西。
`resolveDefaultOnGate`(单一调用点)删除后,这些测试必须改用真的 approve_to_ship
fixture。这是本单最大的测试改造面,不是行为风险,是工作量风险。

## 4. 影响面速览(细账在 research.md)

- 名册/守卫层:`registry.ts`(-13 条)、`store-policy.ts`(`LEGACY_UNMANAGED_BASELINE`
  31→18;`PROTECTED_LEGACY_FLAG_NAMES` 变空集→整删)、`resolve.ts`(liveness 特判)、
  `truth.ts`(不加 tombstone,见 3.1)、drift 测试 fixture(两处点名 fixture)。
- 运行时读点:teamlead bridge 9 个文件 + flywheel-comm 1 + config 1 + inbox-mcp 2。
- 死子系统:mailbox deploy barrier(4 文件 + restart-services 编排段)。
- 测试:约 30 个测试文件涉及(改 fixture / 删专属测试 / 换真 approval)。
- 豁免清单:`fly1674-residue` 守卫与本单 token 无交集(它管 THREE_STAGE 族),无需动;
  `FLAG_EXEMPTIONS` 不含这 13 个名字,无需动。

## 5. 不做

- 不动 9 个启动/CLI 时读的 flag(B2):flag_store、converge_cmux_symlink、cmux_view_helper、
  cmux_node_presence、voice_qa_presence_override、issue_display_sweep_ticks、
  ghost_guard_wait_ms、lead_lease_bypass、publish_broker。
- 不动 project_config flag(C)。
- 不动周边 tuning knob(FLYWHEEL_MAILBOX_ACK_LEASE_MS 等 7 个 mailbox 数值旋钮、
  FLYWHEEL_ISSUE_GATE_SUPERSEDE_MAX_MUTATIONS、FLYWHEEL_FOUNDER_REVIEW_ORPHAN_STALE_HOURS /
  _DELIVERY_GRACE_MINUTES、FLYWHEEL_EXTERNAL_MERGE_NEGATIVE_CACHE_MS)——它们是
  NON_FLAG_ALLOWLIST 数值参数,不在裁定的 13 个之内。
- 不加任何新旋钮、新告警层、新豁免。
