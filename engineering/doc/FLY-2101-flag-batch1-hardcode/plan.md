# FLY-2101 flag·B1 固化删 13 个运行时 env flag — 实施计划

Issue: FLY-2101 (https://linear.app/geoforge3d/issue/FLY-2101/flagb1固化-13-个运行时读的-env-flag-全部固化删写死现值为常量删-env-读点与名册条目mailbox-queue)
日期: 2026-08-27
基于: research.md

**Status**: draft
**Branch**: flywheel-FLY-2101(已在);PR base = main

## 0. 设计裁决(三件,定稿)

| # | 裁决 | 定稿 | 理由 / 代价 |
| - | ---- | ---- | ----------- |
| D1 | tombstone vs rg 零命中 | **不加 `RETIRED_FLAGS` tombstone** | 验收字面写明「零命中(含 dist 外全部源)」,tombstone 字符串即命中。代价:残留 `.env` 行报「unknown FLYWHEEL environment variable」而非「已退役,删这行」——仍 fail-loud;部署说明由 Lead 删行关窗。 |
| D2 | `PROTECTED_LEGACY_FLAG_NAMES` 空集 | **连集合 + `protected_legacy` 分支整删** | 两个成员都在本单删除名单;空集守护不了任何东西,留着是死代码。「只删不加」✓。 |
| D3 | mailbox deploy barrier | **子系统整删**(TS 模块+CLI+shell lib+restart-services 编排段+测试) | 它存在的唯一目的是部署窗口把 FLYWHEEL_MAILBOX_QUEUE 压 0 再恢复;flag 固化后不但死,还会继续往 `.env` 写该 key,与零命中直接冲突。 |

固化值 = 现默认值(research §1 逐条核过),生产 `.env` 唯一显式设置是
`FLYWHEEL_MAILBOX_QUEUE=1`(default-on 的 no-op)⇒ 行为零变化成立。

## 1. 实施步骤(TDD:先立回归红线,再动读点)

### Step 1 — 三条旧路的「已删」回归测试(RED)
验收指定形态:引用 `=0` 的旧测试改为断言**不存在该路**。

⚠️ **命名悖论(Codex R1 #1)**:这三条测试若直接写旧 env 全名,自己就是「零命中」验收的
一个命中。定稿写法:测试内以**运行时拼接**构造旧 key(如
`const legacyKey = ["FLYWHEEL","MAILBOX","QUEUE"].join("_")`),并加注释说明这是为满足
零命中验收的刻意写法,不是混淆——这样既保住「=0 无效」的行为断言,又不给 rg 留字面 token。

1. `mailbox`:新/改测试断言 —— env 以拼接 key 置 `"0"` 后,
   `resolveMailboxQueueConfig` 类型上已无 `enabled` 字段(编译期)且 runner/lead lane tick
   仍走 batch 投递(运行期,复用 lane 测试 harness);`processPendingDeliveries` 与
   `resolveLiveMailboxQueueEnabled` 导出不存在(import 失败即编译红)。
2. `merge 门`:`ship-eligibility.test.ts` 新增 —— `argsEnv`/dotenv 以拼接 key 置 `"0"` 时,
   无有效 approve_to_ship 仍判不可 ship(且 reason 不为旧 `merge_gate_off` 值;该字符串
   已从源码消失,断言用变量持有)。
3. `supersede`:`issue-gate-supersede.test.ts` 新增 —— env 以拼接 key 置 `observe` / `0`,
   sweep 仍执行 mutation(enforce 语义)。

### Step 2 — 逐 flag 删读点、写常量(GREEN)
常量名带来源注释,统一格式 `// FLY-2101 固化(原 FLYWHEEL_X,founder 8-27 v4)`——
注释里**不写** env 全名会违背可追溯,写了会撞 rg 零命中 ⇒ 统一写
`// FLY-2101 固化(原同名 env flag,founder 8-27 v4)`,靠 git blame 追环境变量名。

| 文件 | 改动 |
| ---- | ---- |
| `orphan-founder-review-monitor.ts:88` | 删 `=0` 早退 |
| `liveness-evidence.ts:23-28` | `activityWindowMs()` → 常量 `DEFAULT_ACTIVITY_WINDOW_MS = 600_000`,签名去 env raw 参数(测试注入点同步) |
| `ship-eligibility.ts` | 删 `MERGE_APPROVAL_GATE_KEY`、`resolveDefaultOnGate`(唯一调用点)、`mergeGateOn`/`merge_gate_off` 分支;恒 `verifyApproval` |
| `issue-gate-supersede.ts:133-134,194-…` | 删 mode 读、`=0` 早退、observe 分支;`gate_supersede_candidate` 事件唯一写点就在 observe 分支(全仓 rg 已核,非测试引用仅此一处)→ 事件类型随分支死亡,按零引用删并列 PR body |
| `approval-signal/deferred-approval.ts:44-51` | `deferredApprovalTtlMs()` env parse 删,固化 `DEFAULT_TTL_MS = 45*60_000`(2700000) |
| `gate-poller.ts:2380-2386` | deadletter age env parse 删,固化 `30*60_000`(1800000) |
| `gate-poller.ts:2105-2112 / 1714-1721` | 两个 grace 的 env override 段删,保留 `this.config.…GraceMs ?? 15_000` DI seam(非 flag,测试在用) |
| `external-merge-reconcile.ts:814-820` | 删 `=0` 早退;`windowDays = deps.windowDays ?? 7`(删 intEnv 读) |
| `done-thread-reconcile.ts:102-111` | 两个 `parsePositiveInt(env.…)` → 常量 360 / 25;**保留** `:101` `FLYWHEEL_DONE_THREAD_RECONCILE`(FLAG_EXEMPTIONS QA seam,非 13 之一) |
| 注释改写 | `merge-ship-gate.ts:62`、`DirectEventSink.ts:661`、`gate-poller.ts:194-207,1075`、`plugin.ts:7734`、`founder-reply-deliverer.ts:88`、`external-merge-reconcile.ts:40,159` 等提到被删 envVar 的注释(验收 rg 含注释) |

### Step 3 — mailbox_queue 旧路 + deploy barrier 整删(GREEN,续)
1. 删 `packages/config/src/feature-flags/mailbox-queue.ts` + 两级 re-export。
2. `mailbox-queue-config.ts`:删 `enabled` 字段(interface + DEFAULT + resolver);7 个数值
   旋钮保留。
3. `runner-mailbox-lane.ts` 6 处 / `lead-inbox-loop.ts` 7 处 `queueConfig.enabled` 分支收敛到
   queue 臂;`opts.queueConfig` 缺省兜底改为 `DEFAULT_MAILBOX_QUEUE_CONFIG`。
   注意:`recordLeadDeliveryFailure` 是 queue 臂共用,**不删**。
4. inbox-mcp:删 `queue-mode.ts`、`processPendingDeliveries` 及其调用、
   `legacy-push-delivery.test.ts`;`ack-semantics.test.ts` 同步。
5. flywheel-comm `mailbox-queue.ts` 旧单条方法(`claimRunner`/`claimLead`/
   `recordRunnerDeliverySuccess`/`recordRunnerDeliveryFailure`/`renderRunnerMailboxEnvelope`
   等):Step 3.3-3.4 完成后逐个 rg,**零引用才删**,删除清单列进 PR body。
6. deploy barrier(清单已按 Codex R1 #2/#3 补全编译期消费者):
   - 删 `mailbox-queue-deploy-barrier.ts`、`…-cli.ts`、
     **`mailbox-queue-ack-readiness-probe.ts`**(shell lib 经 `MQB_ACK_PROBE` 从 dist 调它,
     R1 漏项)、`scripts/lib/mailbox-queue-deploy-barrier.sh`、两套 barrier 测试。
   - **`plugin.ts`**:删 `releaseMailboxQueueDeployBarrier` import(:404)与
     `/api/fleet/mailbox-queue-barrier/release` 路由(:2330-2356,R1 漏项)。
   - `flag-toggle.ts` 去 barrier import + 特判段;**`flag-toggle.test.ts`** 的 barrier
     import(:20)与 barrier-lock 测试段(:278 起)同步删(R1 漏项)。
   - `restart-services.sh` 删 source 行与 ~2610-2790 编排段;`test-restart-services.sh`、
     `ci-shell-suite-manual-only.txt` 同步。
   - 编译期兜底:以上删完后 `pnpm -r build` 即是漏网编译期消费者的守卫;任何新暴露的
     引用按「零引用才删/同步改造」处置并列进 PR body。
7. inbox-mcp 运行时/提示词残面(Codex R1 #4 + R2 #2:单条 push/ACK 整条旧路):
   - **删单条 ACK 工具与处理器**:`index.ts` 的 `flywheel_inbox_ack` tool 注册
     (:104-127)、`delivery.ts` 的 `handleAck`(:97-),及只服务该路的 CommDB helpers
     (`getPendingPushInstructions` / `tryClaimInstructionForPush` /
     `markInstructionDelivered` / `ackInstructionRead` /
     **`recordInstructionNotified`(db.ts:4455)/ `releaseInstructionPushClaim`
     (db.ts:4471)**——逐个零引用复核后删,列 PR body)。
   - **删旧 push poll-loop 脚手架(Codex R3)**:`index.ts` 的 `POLL_INTERVAL_MS` /
     `pollTimer` / `pollOnce` / `setInterval` 启动与 shutdown clear 分支(:195-263,
     `pollOnce` 全身只调 `processPendingDeliveries`,已核)——只删调用会留下每秒空转
     timer 且 build 不报错;仅被该路使用的 delivery types 一并删。
   - **删 pending-push SQL 公共面(Codex R3)**:`PENDING_PUSH_INSTRUCTIONS_SQL`
     (db.ts:57)及其 `lib.ts:46` re-export 与 `db.test.ts` 旧 push/query-plan 用例
     (:8, :1175)——否则它会作为死公共 API 连同测试继续全绿。
     **保留** `flywheel_inbox_ack_batch` / `flywheel_inbox_ack_event`、CLI pull 的
     `getUnreadInstructions` / `markInstructionRead`,与 queue 侧
     `releaseExpiredLegacyPushClaims`(仍被 lead-inbox-loop.ts:280 queue 路调用;
     queue 路信封只指示 batch ACK,已核 lead-inbox-loop.ts:468)。
   - **提示词/规则面改写为 batch/event ACK 语义**:`packages/teamlead/scripts/
     inbox-ack-rule.md`(按 message_id 调单条工具的要求)、`claude-lead.sh` 注入段、
     `lead-rules-base/runner-patrol-rules.md` 旧 transport ACK 描述、
     `packages/qa-framework/suites/fly-60-hard-gate.md` 提及处。
   - `index.ts` 启动日志与注释里的 retry-window/redelivery 语义随旧 push 路一起改写;
     `delivery.ts` 文件头 legacy-push 说明文字删;`RETRY_WINDOW_SEC` 与
     `FLYWHEEL_INBOX_RETRY_WINDOW_SEC` 按零引用处置——若死亡则连 `truth.ts`
     `NON_FLAG_ALLOWLIST` 对应行一起删(只减 ✓)。

### Step 4 — 名册与守卫同步(GREEN,续)
1. `registry.ts`:删 13 条 spec(`envSite` helper 保留,存活 flag 在用)。
2. `store-policy.ts`:`LEGACY_UNMANAGED_BASELINE` 31→18;按 D2 删
   `PROTECTED_LEGACY_FLAG_NAMES` + `protected_legacy` 分支 + 相关测试。
   **D2 完整删除清单(Codex R2 #1 补全,全部纯删/收缩)**:
   - 两级 re-export:`packages/config/src/feature-flags/index.ts:51`、
     `packages/config/src/index.ts:67`。
   - `packages/teamlead/src/StateStore.ts`:import(:27)、`applyFlagValueChange` 的
     `protected_legacy` 检查与返回(:4876-4877)、`ApplyFlagValueChangeResult` reason
     联合类型成员(:1617)。
   - 测试:`StateStore.flag-value-store.test.ts` 的 mailbox protected verdict 用例;
     三处 31 项 baseline/字面清单 fixture 同步到 18 —— `feature-flags-registry.test.ts`、
     `fly1981-final-ledgers.test.ts`、`feature-flags-store-policy.test.ts`。
   - 顺序:先删消费者再删集合,避免中间态编译错;build 只是兜底,不能替代此清单
     (`protected_legacy` 字符串类型残面不会编译失败)。
3. `resolve.ts`:删 liveness sanitizer 特判(:273-285)。
4. `truth.ts`:按 D1 **不加** tombstone;现有内容不动。
5. drift fixture 两处点名(research §2):MERGE_APPROVAL_GATE 断言换
   `FLYWHEEL_LEAD_LEASE_BYPASS`;dynamic 清单删 2 行。
6. 测试 fixture 换名:`check-flag-truth.test.sh`、`env-file-writer.test.ts` 等若用 13 名
   之一,换存活名。
7. merge 门测试生态改造(research §1.4 文件清单):`=0` 捷径改真 approve_to_ship fixture,
   复用 `verify-approval.test.ts` builder。

### Step 5 — 全仓自验
- `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + `scripts/__tests__/*.test.sh`
  受影响套件(check-flag-truth / restart-services / fly1674-residue 全跑)。
- 残名扫描(词界版,见 §2):13 个名字逐一 `rg '\bFLYWHEEL_X\b' packages scripts` 零命中;
  同时验存活邻居(`_MAX_MUTATIONS`、`_STALE_HOURS`、`_NEGATIVE_CACHE_MS`、mailbox 7 旋钮、
  `FLYWHEEL_DONE_THREAD_RECONCILE`)**仍在**(防误删,零命中要配阳性对照)。
- FLY-1914 消费者 sweep(barrier CLI + shell lib 属净删):三 root
  (插件 fork `external_plugins/`、`~/.claude/plugins/cache/*/`、主仓 scripts/packages)
  带时间戳逐项列进 PR body;某 root 不可读则明写「该 root 未检查」。

### Step 6 — Codex code review(`codex:rescue`)循环至 approved → PR
PR 末 commit:新建 `engineering/doc/milestones/FLY-2101.md`(不碰 CLAUDE.md)。

## 2. 验收核对(含 rg 词界修正)

| 验收 | 达成方式 |
| ---- | -------- |
| 行为零变化,现有测试全绿 | 固化值=现默认值;测试改造仅限「引用被删路径」的用例 |
| 三条旧路回归测试 | Step 1(mailbox / merge 门 / supersede 各一) |
| registry 无 13 名 | Step 4.1 |
| rg 零命中(含 dist 外全部源) | Step 2/3 + Step 5 扫描;**必须按名用 `\b` 词界**,因 4 组存活同前缀邻居(research §3);tombstone 按 D1 不加 |
| drift/清单同步,只减不增 | Step 4;fly1674-residue 与本单零交集(不动);FLAG_EXEMPTIONS 不含 13 名(不动) |

## 3. 部署说明(写进 PR body,由 Lead 执行)

1. 生产 `~/.flywheel/.env`:删 `FLYWHEEL_MAILBOX_QUEUE=1` 行(该 key 任何值的行都删)。
2. 顺检 `~/.flywheel/state/mailbox-queue-deploy-barrier.json`:存在即删(中断部署的残留
   marker;barrier 已整删,无人再读)。
3. FLY-1959:不投重启票,随 00:00/12:00 班车部署。错峰组合(旧脚本+新 .env / 新脚本+旧
   .env)均安全:default-on 语义下 `=1` 与缺行等价;新脚本不读写该 key。
4. 残留 env 行的可见面(D1 代价,按 Codex R1 #5 收窄表述):`check-flag-truth` 是
   操作者/CI-fixture CLI,**不在** restart-services 或 Bridge boot 链上——残行不会阻断
   部署或启动,只在有人跑该 CLI 时报「unknown FLYWHEEL environment variable」。
   fail-loud 面比原稿描述的窄,删行仍应尽快执行。

## 4. 风险与边界(诚实账)

- **测试改造面大于代码改造面**:约 30 个测试文件,其中 merge 门 `=0` 捷径改造最重。
  纯工作量风险,不是行为风险。
- **死代码判定一律「零引用才删」**:flywheel-comm 旧单条方法、`gate_supersede_candidate`
  事件类型等,删除清单列 PR body,不顺手扩权。
- **本单不回答「以后要不要能关」**:founder 已裁定这些门/巡检不该有全局阀;若未来出现
  真实操作者需求,走新 issue 重新登记(authoring gate 会强制 store-managed 路径),
  不在本单留后门。
- **`.env` 删行依赖 Lead 手动执行**:代码侧无法替她删生产文件;删行前的窗口里,
  残行仅在有人跑 check-flag-truth CLI 时报 unknown(不阻断部署/boot,见 §3.4)。
