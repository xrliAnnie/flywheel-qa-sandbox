# FLY-2101 flag·B1 固化删 13 个运行时 env flag — 调研

Issue: FLY-2101 (https://linear.app/geoforge3d/issue/FLY-2101/flagb1固化-13-个运行时读的-env-flag-全部固化删写死现值为常量删-env-读点与名册条目mailbox-queue)
日期: 2026-08-27
基于: exploration.md

> 逐 flag 读点普查 + 守卫机制普查。行号为本分支 2026-08-27 快照,实施时以
> `git log -S` / rg 重定位。

## 1. 逐 flag 读点账

### 1.1 founder_review_orphan_monitor(常开)
- 读点:`packages/teamlead/src/bridge/orphan-founder-review-monitor.ts:88`
  `if (input.env.FLYWHEEL_FOUNDER_REVIEW_ORPHAN_MONITOR === "0") return stats;` — 删此早退。
- 周边:`FLYWHEEL_FOUNDER_REVIEW_ORPHAN_STALE_HOURS` / `_DELIVERY_GRACE_MINUTES` 是
  NON_FLAG_ALLOWLIST 数值旋钮,**保留**。
- 测试:`orphan-founder-review-monitor.test.ts` 有 kill-switch live-observe 用例 → 改为
  「=0 无效」回归断言(验收指定形态)之一的候选;registry 的 directToggleProof 随条目删。

### 1.2 mailbox_queue(常开;连 FLY-1572 旧路 + deploy barrier 整删)
读点(生产):
- `packages/config/src/feature-flags/mailbox-queue.ts` — `mailboxQueueEnabled()` 整个模块删;
  export 链:`feature-flags/index.ts:3`、`config/src/index.ts:65`。
- `packages/inbox-mcp/src/queue-mode.ts` — `resolveLiveMailboxQueueEnabled()`(dotenv_live
  读共享 .env)整删;唯一调用 `index.ts:216` 传 `{queueEnabled}` 给
  `processPendingDeliveries`。
- `packages/inbox-mcp/src/delivery.ts:52` — `if (options.queueEnabled) return …` 之后的函数体
  **就是** FLY-1572 旧 push 投递路。queue 恒 on ⇒ 函数恒空转 ⇒ 函数 + 调用点 +
  `legacy-push-delivery.test.ts` 整删;`ack-semantics.test.ts` 里涉及处同步。
  连带候选死代码:`CommDB.getPendingPushInstructions` / `tryClaimInstructionForPush`
  (删后 rg 复核还有没有别的调用方,零引用才删)。
- `packages/teamlead/src/bridge/mailbox-queue-config.ts:56` — `enabled: mailboxQueueEnabled(env)`;
  `MailboxQueueConfig.enabled` 字段与 `DEFAULT_MAILBOX_QUEUE_CONFIG.enabled` 一起删。
  其余 7 个数值旋钮(ACK_LEASE / BATCH_WINDOW / BATCH_MAX / INFLIGHT / LEASE_RETRY /
  DEADLETTER_WINDOW / UNAVAILABLE_RETRY)**保留**。
- `packages/teamlead/src/bridge/runner-mailbox-lane.ts` — `queueConfig.enabled` 分支 6 处
  (236-239 的 `enabled:false` 兜底、245、291-309 旧 `claimRunner` 单条领取、313-322 旧
  `renderRunnerMailboxEnvelope`、325-347 旧 `recordRunnerDeliverySuccess`、352-368 旧
  `recordRunnerDeliveryFailure`)→ 全收敛到 queue 臂。
- `packages/teamlead/src/bridge/lead-inbox-loop.ts` — 同构分支 7 处(224 兜底、255、327
  `claimLead` 旧领取、461-477 transportBatchId/header/modelContent、527 起 settlement)。
  注意 `recordLeadDeliveryFailure` 在 queue 臂也用(609/625/697/718),**不是**旧路专属。
- `packages/flywheel-comm/src/mailbox-queue.ts` — 旧单条方法(`claimRunner`、`claimLead`、
  `recordRunnerDeliverySuccess/Failure` 等):分支删完后按「零引用才删」逐个处置。

deploy barrier 子系统(整删,存在目的就是部署窗口压 `=0` 再恢复):
- `packages/teamlead/src/bridge/mailbox-queue-deploy-barrier.ts`(633 行)
- `packages/teamlead/src/bridge/mailbox-queue-deploy-barrier-cli.ts`
- `packages/teamlead/src/bridge/flag-toggle.ts` — import `MAILBOX_QUEUE_ENV_VAR` +
  `prepareMailboxQueueOperatorToggleLocked` 特判段(约 38-41、68、152-163)删。
- `scripts/lib/mailbox-queue-deploy-barrier.sh`(5 处 export/unset)
- `scripts/restart-services.sh` — 58-59 source、~2610-2790 barrier begin/probe/release 编排段
- `scripts/test-restart-services.sh`、`scripts/__tests__/mailbox-queue-deploy-barrier.test.sh`、
  `scripts/__tests__/ci-shell-suite-manual-only.txt` 对应行、
  `packages/teamlead/src/__tests__/mailbox-queue-deploy-barrier.test.ts`。
- 生产残留:`.env` 的 `FLYWHEEL_MAILBOX_QUEUE=1` 行(Lead 删);若上次部署中断,可能残留
  `~/.flywheel/state/mailbox-queue-deploy-barrier.json` marker(部署说明一并删)。

### 1.3 liveness_activity_window_ms(600000)
- 读点:`packages/teamlead/src/bridge/liveness-evidence.ts:23-28` `activityWindowMs(raw=process.env.…)`
  → 固化为既有 `DEFAULT_ACTIVITY_WINDOW_MS = 600_000` 常量,函数签名去 env。
- 镜像:`packages/config/src/feature-flags/resolve.ts:273-285` 对该 envVar 的 sanitizer 特判
  (config 包不能 import teamlead 而镜像的那段)随 registry 条目删。

### 1.4 merge_approval_gate_killswitch(门常在)
- 读点:`packages/flywheel-comm/src/ship-eligibility.ts` —
  `MERGE_APPROVAL_GATE_KEY`(36)、`resolveDefaultOnGate`(45,**全仓唯一调用点在 339**)、
  `mergeGateOn` + `if (!mergeGateOn) { mergeApprovalOk=true; mergeReason="merge_gate_off" }`
  (339-351)→ 整段删,恒走 `verifyApproval`。`"merge_gate_off"` reason 字符串成为不可达值。
- 注释残留:`merge-ship-gate.ts:62`、`DirectEventSink.ts:661`、`gate-poller.ts:1075`、
  `plugin.ts:7734` 提到该 envVar → 同步改写(验收 rg 含注释)。
- 测试面(最大):`ship-eligibility.test.ts`、`verify-approval.test.ts`、
  `merge-ship-gate.integration.test.ts`、`event-route*.test.ts` 系、`db.fly1314.test.ts`、
  `fly1505-qa-ship-attempt-chain`、`fly1262-ssot-acceptance`、`complete-marker-reconciler*`、
  `terminal-archive-enqueue-sites`、`management-existing-writers` 等用 `=0` 当捷径的,
  改用真 approve_to_ship fixture(verify-approval.test 已有 builder 可复用)。

### 1.5 issue_gate_supersede_mode(enforce)
- 读点:`packages/teamlead/src/bridge/issue-gate-supersede.ts:133-134` mode 读取 + `=0` 早退;
  `:194` `if (mode === "observe")` 只记 `gate_supersede_candidate` 事件不 mutate 的分支 → 删,
  恒 enforce。
- **保留**:`FLYWHEEL_ISSUE_GATE_SUPERSEDE_MAX_MUTATIONS`(:32,NON_FLAG_ALLOWLIST 旋钮)。
  验收 rg 必须用 `\b` 词界,否则误伤此名。
- 测试:`issue-gate-supersede.test.ts` observe/0 用例 → 改「observe/0 无效仍 enforce」回归。

### 1.6-1.7 deferred_approval_ttl_ms(2700000)/ founder_reply_deadletter_age_ms(1800000)
- `approval-signal/deferred-approval.ts:44-51` `deferredApprovalTtlMs()` env parse 删,固化
  `DEFAULT_TTL_MS = 45*60_000`。
- `gate-poller.ts:2380-2386` `founderReplyDeadletterAgeMs()` env parse 删,固化 `30*60_000`。

### 1.8 / 1.11 ship_gate_grace_ms / ship_gate_card_grace_ms(各 15000)
- `gate-poller.ts:2105-2112` / `:1714-1721`:env override 段删,保留
  `this.config.shipGate(Card)GraceMs ?? 15_000` 的 DI/测试 seam(不属于 flag,测试在用)。
- 注释:`gate-poller.ts:194-207`、`founder-reply-deliverer.ts:88` 提到 envVar → 改写。

### 1.9-1.10 external_merge_reconcile(常开)/ merge_reconcile_window_days(7)
- `external-merge-reconcile.ts:814` `=0` 早退删;`:816-820` `intEnv(…WINDOW_DAYS…)` →
  `deps.windowDays ?? 7`(deps seam 保留)。注释 :40、:159 改写。

### 1.12-1.13 done_thread_reconcile_interval_min / _max_per_run(360 / 25)
- `done-thread-reconcile.ts:102-111` 两个 `parsePositiveInt(env.…)` → 常量 360 / 25。
- **保留**:`:101` `env.FLYWHEEL_DONE_THREAD_RECONCILE !== "0"`(FLAG_EXEMPTIONS QA 隔离
  seam,不在 13 个之内)。

## 2. 名册与守卫层账

- `registry.ts`:删 13 条 spec。`envSite` helper 仍被存活 flag 使用,保留。
- `store-policy.ts`:
  - `LEGACY_UNMANAGED_BASELINE` 31 → 18(只减不增 ✓)。
  - `PROTECTED_LEGACY_FLAG_NAMES` 仅含 mailbox_queue + merge_approval_gate_killswitch →
    变空集;连 `getStoreEligibilityAgainst` 的 `protected_legacy` 分支一起删(死分支),
    相关测试同步。
- `truth.ts`:**不加 tombstone**(exploration 3.1 裁决,待 design review 复核)。
  `validateFlagTruthEnvironment` 对残留 env 行的报错从「已退役假开关」退为
  「unknown FLYWHEEL environment variable」,仍 fail-loud。`NON_FLAG_ALLOWLIST` /
  `RETIRED_FLAGS` 现有内容不动。
- `exemptions.ts`:13 个名字均不在 `FLAG_EXEMPTIONS` / `LEGACY_FLAG_EXEMPTION_BASELINE`,不动。
- `resolve.ts`:liveness 特判段删(1.3)。
- drift 守卫(`feature-flags-drift.test.ts` + `drift-scan/index.ts`):机制是 AST 读点 ↔
  registry 对账,删条目+删读点后自动收敛;需改两处**点名 fixture**:
  1. 「finds known direct, helper, MJS, and shell gates」断言 `FLYWHEEL_MERGE_APPROVAL_GATE`
     存在 → 换成存活的裸读(如 `FLYWHEEL_LEAD_LEASE_BYPASS`);
  2. dynamic-pattern 点名清单(:468-473)删 `mailbox_queue:resolveLiveMailboxQueueEnabled`、
     `merge_approval_gate_killswitch:resolveDefaultOnGate` 两行。
- `fly1674-residue.test.sh`:只管 THREE_STAGE 族 token,与本单零交集,不动。
- `check-flag-truth`:CI 里跑的是 `scripts/__tests__/check-flag-truth.test.sh`(fixture 驱动);
  fixture 若用到 13 名之一则换存活名。`env-file-writer.test.ts` 同理。

## 3. 词界与残名(验收 rg 的正确写法)

存活的同前缀邻居,必须用 `\b` 词界避免误伤:
- `FLYWHEEL_ISSUE_GATE_SUPERSEDE_MAX_MUTATIONS`(留)vs `FLYWHEEL_ISSUE_GATE_SUPERSEDE`(删)
- `FLYWHEEL_FOUNDER_REVIEW_ORPHAN_STALE_HOURS` / `_DELIVERY_GRACE_MINUTES`(留)
- `FLYWHEEL_EXTERNAL_MERGE_NEGATIVE_CACHE_MS`(留)
- `FLYWHEEL_MAILBOX_ACK_LEASE_MS` 等 7 个 mailbox 旋钮(留)

## 4. 部署与外部消费者

- 生产 `.env`:删 `FLYWHEEL_MAILBOX_QUEUE=1` 行(Lead 执行,PR 部署说明);顺带检查并删
  可能残留的 barrier marker `~/.flywheel/state/mailbox-queue-deploy-barrier.json`。
- FLY-1959:merge 不触发部署;新 restart-services.sh(无 barrier)随 00:00/12:00 班车生效。
  旧脚本 + 新 .env / 新脚本 + 旧 .env 两个错峰组合均安全(default-on 语义下 `=1` 与缺行
  等价;新脚本不再读写该 key)。
- FLY-1914 消费者 sweep:本单删除 barrier CLI(`mailbox-queue-deploy-barrier-cli.ts`)与
  shell lib;实施时按 CLAUDE.md 契约对三个 root(插件 fork `external_plugins/`、本机
  `~/.claude/plugins/cache/*/`、主仓 scripts/packages)做 sweep 并在 PR body 附时间戳证据。
  初查:主仓内消费者仅 restart-services.sh(同 PR 删);包外未查,留待实施节点。

## 5. 结论

方案唯一且机械:逐 flag 删读点写常量 + 名册守卫同步 + mailbox/merge/supersede 三条旧路
回归测试。无需备选方案对比;唯一真正的设计裁决(tombstone vs 零命中、PROTECTED 空集、
barrier 整删)已在 exploration §3 列出,进 plan.md 定稿。
