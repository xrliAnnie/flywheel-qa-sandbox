# FLY-2028 thread 过期归档不生效 — 实施计划
Issue: FLY-2028 (https://linear.app/geoforge3d/issue/FLY-2028/返工1435-thread-过期归档仍然不生效-设置对了但-discord-原生-auto-archive)
日期: 2026-09-02
基于: research.md(Codex design review R1–R3 共二十条意见已全部采纳,见 §8)

## 0. 一句话与两段

**一条规则治两种线程:「没人说话满一小时、且这条线程的使命已经结束 ⇒ 归档;有人再说话 Discord 自动打开,之后再满一小时再收。」**

| 段 | 线程 | 「使命结束」的证据 | 「一小时」来源 | 执行者 |
|---|---|---|---|---|
| **A(主验收)** | issue chat thread | issue 在 Linear 已 Done/Canceled(fresh 查)或 ship 已 merged | 常量 `ISSUE_THREAD_QUIET_WINDOW_MS = 60min` | 既有归档链(post-ship / targeted / 6h reconcile / 端点),项目 bot 身份 |
| **B** | `#leads-roundtable` 话题线程、`#flywheel-alerts` 告警线程 | 频道性质(讨论/告警本身就是临时的) | 线程自己的 `auto_archive_duration`(60 / 1440) | 新增 `idle-thread-archive-sweep`,claw-infra-bot 身份 |

零新 `FLYWHEEL_*` env、零 StateStore schema、零新 HTTP 路由、零新身份。

## 1. 段 A:issue thread 在 Done/ship 后真的归档

### 1.1 合同

1. **终态权威(`authority`)**:调用方用自己已有的证据声明 `"terminal"`;sink 不自己查 Linear。
   - `post-ship-finalization`:ship merged ⇒ terminal。
   - `done-thread-reconcile`(6h):fresh Linear Done/Canceled 双门已过 ⇒ terminal。
   - `terminal-thread-archive`(targeted,分钟级):fresh Linear Done 复核已过 ⇒ terminal。
   - 端点 `POST /api/chat-threads/archive`:**新增** fresh Linear 查询(经 `QueryRouterOptions.lookupIssueForArchive?: ReconcileLinearLookup` seam,默认 `lookupLinearIssueByIdentifier`,key 取 `process.env.LINEAR_API_KEY`);Done/Canceled ⇒ terminal;key 缺失 / 查询失败 / 非终态 ⇒ `"none"`(今天的行为)。响应体新增 `authority` 字段。
   - close cascade(`maybeArchiveThreadOnClose` → `archiveIssueThreadIfNoOtherActive`):`"none"`(无 Linear 证据;它只走首次归档路径)。
2. **活动时钟(Linear 08-24 founder 原话:只认 `last_message_id`)**:
   - 段 A:最新消息 = `getLatestThreadMessageId`(`messageId` 为 null 或获取失败 ⇒ **没有时钟,不归档**:返回 `{archived:false, reason:"reopen_check_failed", error:"no message clock"}`,可重试)。
   - 段 B:`last_message_id` 必须是合法 snowflake,否则 `skippedNoClock`;**不用 `thread.id`(创建时刻)回退**。
   - `thread_metadata.archive_timestamp`(创建 / 归档 / 解档 / 改 aad 时都会变)**只作「不早于」守卫**:有合法消息时钟之后,若 `archive_timestamp` 合法且更晚,则要求它到现在也满窗(解档算活动,B5 用例)。它永远不能替代消息时钟。
   - 任一时钟在未来 ⇒ 视为不静默(fail-safe)。
3. **静默窗(`quietWindowMs`)**:自动路径一律 `ISSUE_THREAD_QUIET_WINDOW_MS`(60min);端点(人为显式)传 `0`。
4. **terminal 权威下不再问「谁说的」,只问「还有人在说吗」**:human / bot 分类只在 `authority:"none"` 时参与决策。terminal 下所有原本返回 `founder_reopened` 的出口一律改为 **`deferred_quiet_window`**(线程保持/恢复打开,调用方稍后重试)。
5. **`in_active_use`(epoch 后新 admission / 活 pane)在任何权威下都保留** —— 它保护的是正在跑的 runner,不是发言者。
6. **首次归档也等静默,且带围栏**(`archived_at` 为空的路径):这就是 founder 08-31「等收尾话说完再归档」的实现。post-ship 在 ship 当刻只「试一次」,不静默就把 issue 交给 targeted 队列(退避 1→30min)重试;不再在 Lead 收尾话之前把线程收掉。「静默检查 → PATCH」之间到达的消息会被埋进归档(归档前到的消息不会触发 Discord 自动解档),所以首次归档复用 FLY-1709 的 frontier 围栏 + 补偿收据(§1.2)。
7. 延后不写审计事件(每次重试写一条会灌满 `session_events`),只写一行日志;最终归档照旧写 `chat_thread_archived`。

### 1.2 sink 决策表(`done-thread-archiver.ts::archiveThreadAndRecord`)

新增类型与 deps:

```ts
export type ArchiveAuthority = "terminal" | "none";
export const ISSUE_THREAD_QUIET_WINDOW_MS = 60 * 60_000;
export interface ArchiveThreadDeps {
  …既有…
  /** 调用方已证明 issue 终态;"terminal" 覆盖 human-reopen 否决。默认 "none"。 */
  authority?: ArchiveAuthority;
  /** 自动路径的最小静默时长;0 = 人为显式调用不等。默认 ISSUE_THREAD_QUIET_WINDOW_MS。 */
  quietWindowMs?: number;
}
// chat-thread-utils.ts
export type ArchiveReason = … | "deferred_quiet_window"; // 线程在静默窗内有消息;可重试
export type GetChannelNameResult = { ok: true; name; archived?; archiveTimestamp?: string } | …; // 新增 archiveTimestamp(加法)
```

`quiet(frontierMessageId, archiveTimestamp, now, W)`:`t_msg = snowflakeToMs(frontierMessageId)`(必须合法,否则「无时钟」);`t_arc = Date.parse(archiveTimestamp)`(finite 才用);`last = max(t_msg, t_arc ?? −∞)`;`last > now ⇒ false`;否则 `now − last ≥ W`。

```
run():
  有 compensation receipt → resumeCompensation(不变;首次归档的收据也走这里)
  archived_at 已置:
    probe → 404 missing | archived → already_archived | 字段缺 → reopen_check_failed(不变)
    resolveReopenVeto → in_active_use(不变,所有权威)
    authority = terminal:
      frontier = getLatestThreadMessageId(失败 / null → reopen_check_failed)
      quiet 不满足 → deferred_quiet_window
      → reArchiveWithQuietWindow(archivedAtRaw, afterMs, frontier)(既有 frontier 围栏 + 补偿收据);其内所有 founder_reopened 出口 → deferred_quiet_window
    authority = none(今天的逻辑 + 静默窗):
      classify → human → founder_reopened | unknown → reopen_check_failed
               → bot_only → quiet 不满足 → deferred_quiet_window;满足 → reArchiveWithQuietWindow(不变)
  archived_at 为空(首次):
    quietWindowMs = 0(端点):removeUser + PATCH + markChatThreadArchived + 审计(今天的路径,逐字节不变)
    quietWindowMs > 0(自动):**围栏式首次归档**
      probe₀ = getChannelName(archived + archiveTimestamp),**按状态分支**:
        404 → markChatThreadMissing → 经既有 `audit()` 写 `chat_thread_archive_failed`(sink「无论如何都留审计」合同不变)→ {archived:false, status:404, reason:"missing"}(保住今天的 missing 收敛,别让已删线程永远当候选)
        archived===true(外部已归档:Lead 手动 PATCH / 段 B 清扫等)→ **原子收敛** `commitThreadArchive(threadId, skip 审计事件)`,事件 id 沿用现有唯一形态 `chat-thread-archive-skip-fly1709-<uuid>`(此时还没有收据 epoch),payload `reason:"already_archived"` → {archived:true, reason:"already_archived"}(幂等真话)
        archived 字段缺失 / 其他失败 → reopen_check_failed(fail-closed,零写)
        archived===false → 继续
      F0 = getLatestThreadMessageId(失败 / null → reopen_check_failed)
      quiet(F0, probe₀.archiveTimestamp) 不满足 → deferred_quiet_window(零写)
      removeUser(不变,仍在 PATCH 前:归档线程上不能移除成员)
      epoch = <now ISO>;setChatThreadCompensationPending({ version:1, state:"prepared", archiveEpoch: epoch, frontier: F0, cause:"unknown", at })
      PATCH archived:true,按 archiveChatThread 的结果分三类:
        ① 确定没写(404 missing / 401·403 unauthorized / 非 400 的其他 4xx client_error)→ 清收据,原样返回
        ①′ 400 client_error(含 Discord code 50083「线程已归档」:probe₀ 与 PATCH 之间被别人归档)→ 按 ③ 的 verify 处理(probe 已归档 ∧ F1===F0 → 提交;F1≠F0 → 补偿;probe 开着 → 清收据按 client_error 返回)
        ② 不确定(网络/超时 error、429·5xx 耗尽 exhausted、2xx 但回读 archived:false 耗尽)→ probe:已归档 → compensateKnownArchived("verify_failed") → reopen_check_failed;证明开着 → 清收据,返回 PATCH 结果;probe 失败 → **收据保留** → reopen_check_failed
        ③ archived:true → verify = probe + getLatestThreadMessageId
             archived===true ∧ F1===F0 → **一次原子提交** `store.commitThreadArchive(threadId, 审计事件)`(epoch + 清收据 + 审计事件同一事务;**event id = `chat-thread-archived-fly2028-<threadId>-<epoch>`,按归档 epoch 唯一** —— `session_events.event_id` 唯一而 `commitReactivation` 保留历史事件,固定 id 会在第二个生命周期撞键回滚)→ archived:true
             F1≠F0 或 metadata 开着 → compensateKnownArchived(必要时 unarchive 并验证开着)→ deferred_quiet_window(不 mark,不写 archived 事件)
             verify 读失败 → 收据留着 → reopen_check_failed(下次调用先 resumeCompensation,与 FLY-1709 R3 #3b 同款)
```

端点路径(`quietWindowMs = 0`)保留旧的固定 event id `chat-thread-archived-fly369-<threadId>` 与三步写法,逐字节不变(它今天就有的行为不在本单范围内改)。

- `StateStore.commitReArchive` 已是「epoch + 清收据 + 插审计」的单事务且不要求既有 epoch → **改名为 `commitThreadArchive`**(唯一旧调用点同步改),首次围栏归档与 re-archive 共用;不再分三步写。审计事件失败 ⇒ 事务整体回滚(测试:注入 insert 失败,`archived_at` 与收据均不变)。
- 围栏首次归档不新增收据字段:`archiveEpoch` 填本次尝试时刻;`frontier` 恒为合法 snowflake 字符串(无时钟就不进这条路径),`ThreadArchiveCompensationReceipt.frontier: string` 合同不变。
- 补偿后 founder 已被 removeUser 移出线程 —— 与今天「归档后被消息顶开」的状态一致(她本来就已被移出),不是新回归;下一条 @ 她的消息会把她加回来。

### 1.3 调用方改动

| 文件 | 改动 |
|---|---|
| `terminal-thread-archive.ts` | sink 调用带 `authority:"terminal"`;`mapArchiveSinkResult`:`deferred_quiet_window` → 新 outcome `{ kind: "deferred_quiet_window" }`,`isRetryableOutcome` 返回 true;`founder_reopened` outcome 在 terminal 下不可达 → 删除该 kind 与映射分支(dead code)。**入队回执**:`export type TerminalArchiveAdmission = "accepted" \| "deduped" \| "refused"`;`createTerminalArchiveEnqueueBuffer().enqueue` 与 `bind` 的 consumer 都返回它(buffer 内缓冲 → accepted,重复 → deduped,满 → refused,已 bind → 透传 consumer 的回执) |
| `done-thread-reconcile.ts` | scheduler `enqueue(issueId)` 返回 `TerminalArchiveAdmission`(未接 `runTargeted` → refused + 日志;stopped → refused;已在队/在飞 → deduped;满 → refused;否则 accepted);sink 调用带 `authority:"terminal"`;结果映射新增计数 `deferredQuiet`(不计 failed);候选补全见 §1.4 |
| `post-ship-finalization.ts` | `PostShipDeps.enqueueTerminalArchive?: (issueId: string) => TerminalArchiveAdmission`(**独立 dep,不藏在 bundle 里**);sink 调用带 `authority:"terminal"`;`isArchiveObligationSettled` 不再单独裁决 deferred:`deferred_quiet_window` 时调用 `enqueueTerminalArchive` —— `accepted \| deduped` ⇒ `threadArchived=true` + log `thread archive deferred (quiet window) → targeted queue (<admission>)`;`refused` 或 dep 缺失 ⇒ `threadArchived=false`,resumable 归 `partial`,reason `land_archive_deferred_unqueued`(land 重试通道会再来);`archive_waiver_notified` 分支:`founder_reopened` 文案在 terminal 权威下不可达 → **删除该分支文案**,保留 `in_active_use` 分支 |
| **六个** post-ship 生产入口 | 五个 `runPostShipFinalization(`:`DirectEventSink.ts:1144`、`event-route.ts:2186`、`event-route.ts:2599`(经 `...lifecycleInfra` 之外**显式**传 `enqueueTerminalArchive`)、`merge-ship-gate.ts:545`(`finalizeRecoveredMerge` 的 deps,由其两个上游 `actions.ts:445 approveExecution` 与 `founder-consent/wiring.ts:202` 各自把回调穿进来)、`external-merge-reconcile.ts:459`(直接构造 `PostShipDeps`);**加一个** `runResumablePostShipFinalization(`:`plugin.ts:6293`(canonical land 的 resumable 路径,deps 里显式传)。全部接 `plugin.ts:6062` 的 `terminalArchiveBuffer.enqueue`(它 bind 到 `doneThreadReconcile.enqueue`);implement 时 `git grep -n "runPostShipFinalization(\|runResumablePostShipFinalization(" packages/teamlead/src` 逐一核对六处都传了,且回调都源自同一个 buffer |
| `tools.ts` 端点 | `QueryRouterOptions.lookupIssueForArchive` seam → authority;`quietWindowMs: 0`;响应 `{ threadId, authority, ...result }` |
| `done-thread-archiver.ts::archiveIssueThreadIfNoOtherActive` | 显式 `authority:"none"`,quietWindow 默认;deferred 只 log(非 post-ship 完成已由 `DirectEventSink:1195` 入 targeted 队列) |
| `DirectEventSink.ts:1195` | 不改(post-ship 归属的 deferred 由 post-ship 自己入队) |

### 1.4 候选集用 Discord 真相补全(6h reconcile)

新模块 `packages/teamlead/src/bridge/discord-guild-active-threads.ts`(段 A/B 共用):

```ts
export interface InfraDiscordIdentity { botToken: string; guildId: string }
/** CLAUDE_INFRA_BOT_TOKEN + (DISCORD_GUILD_ID ?? FLYWHEEL_ROUNDTABLE_GUILD_ID);缺任一 → null */
export function resolveInfraDiscordIdentity(env = process.env): InfraDiscordIdentity | null;
export interface DiscordActiveThread { id: string; parent_id: string; owner_id?: string; last_message_id?: string | null;
  thread_metadata?: { archived?: boolean; archive_timestamp?: string | null; auto_archive_duration?: number; locked?: boolean } }
export type ListActiveThreadsResult = { ok: true; threads: DiscordActiveThread[] } | { ok: false; status?: number; retryAfterMs?: number; error: string };
/** GET /guilds/{gid}/threads/active,5s 超时,never-throw,只收 isActiveThread 形状合法的条目 */
export async function listGuildActiveThreads(identity, opts?: { fetchImpl?; timeoutMs?; signal? }): Promise<ListActiveThreadsResult>;
export function isDiscordSnowflake(v: unknown): v is string;   // /^\d{17,20}$/ + BigInt > 0
export function snowflakeToMs(v: unknown): number | null;
/** §1.1 时钟合同:last_message_id 必须合法;archive_timestamp 只能把结果推晚;否则 null */
export function lastActivityMs(t: DiscordActiveThread): number | null;
```

`done-thread-reconcile.ts` 新 dep:

```ts
export type DiscordOpenThreadDiscovery = { ok: true; ids: Set<string> } | { ok: false; error: string };
listDiscordOpenThreadIds?: () => Promise<DiscordOpenThreadDiscovery>;   // 未注入 = openDiscovery=absent
```

**独立的 archive-only 第二段**:位置 = 主线程循环之后、**FLY-1185 residue union 之前**,同一次 `runOnce` 内;与主循环共用**同一套**预算(`maxCandidates` 按 `result.scanned` 计、`maxArchives`、`runDeadlineMs`、`shouldAbort`、`spacingMs`、`dryRun`),residue 只消费剩余预算(它本就按 Codex R1#14「ONE budget across the whole run」):

```
if aborted / deadlineHit / capped / scanned ≥ maxCandidates(主循环已停)→ 不发 discovery 请求,openDiscovery=skipped
discovery = await listDiscordOpenThreadIds?.()      // absent | unavailable(<error>) | ok
reopened = [ row | id ∈ discovery.ids, row = getChatThreadByThreadId(id) 存在, getChatThreadArchivedAt(id) 非空, id ∉ 主循环候选 ]
for row in reopened:                                 // 计数 discoveredReopened;每条 scanned++
  abort / deadline / cap / candidate 预算检查(与主循环同款)
  linear₁ = lookupIssue(row.issue_id):失败 → skippedUnresolved;非 Done/Canceled → skippedNotDone
  aliasKeys = {row.issue_id, linear₁.id, linear₁.identifier}
  checkLiveness(aliasKeys).live → skippedActive              // 含 await
  linear₂ = lookupIssue(row.issue_id)(**sink 前 fresh 复读,不缓存**):失败 → skippedUnresolved;非终态 → skippedNotDone(founder 在 liveness await 期间 reopen issue 必须赢)
  project / botToken 解析(与主循环同一段逻辑抽成 helper;0 或 >1 → skippedNoProject / skippedNoToken)
  dryRun → dryRunWouldArchive++,continue
  ⛔ 不做:observeLinearState、retireIssueGates、husk finalize、lifecycleCloseout、isChatThreadArchived 否决(这一段的前提就是 DB 已记归档)
  sink(authority:"terminal")→ 与主循环同一映射(archived / deferredQuiet / skippedAlreadyArchived / in_active_use→skippedReopenProtected / failed)
  sleep(spacingMs)
```

pass 日志新增 `discoveredReopened=<n> deferredQuiet=<n> openDiscovery=<absent|skipped|ok|unavailable(<error>)>`;discovery 失败不静默、不抛,退回 DB-only。

### 1.5 dead code(implement 时列出并删)

- `post-ship-finalization.ts` `land_archive_waiver` 的 `founder_reopened` 文案分支;
- `terminal-thread-archive.ts` `{ kind: "founder_reopened" }` outcome 与映射;
- `done-thread-reconcile.ts` `skippedReopenProtected` 中 `founder_reopened` 分支(保留 `in_active_use`)。
`founder_reopened` reason 本身**保留**(`authority:"none"` 路径与端点在 issue 未终态时仍返回它)。

## 2. 段 B:`idle-thread-archive-sweep`

### 2.1 模块 `packages/teamlead/src/bridge/idle-thread-archive-sweep.ts`

```ts
export const IDLE_THREAD_SWEEP_INTERVAL_MIN = 10;
export const IDLE_THREAD_SWEEP_MAX_ARCHIVES_PER_RUN = 25;
export const IDLE_THREAD_SWEEP_RUN_DEADLINE_MS = 60_000;
export const IDLE_THREAD_SWEEP_SPACING_MS = 500;
export const IDLE_THREAD_SWEEP_REQUEST_TIMEOUT_MS = 5_000;
export const IDLE_THREAD_SWEEP_RETRY_AFTER_FALLBACK_MS = 60_000;

/** FLYWHEEL_ROUNDTABLE_CHANNEL_ID / FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID,trim 非空去重;空 → [] */
export function resolveIdleThreadSweepChannelIds(env = process.env): string[];

export interface IdleThreadSweepResult {
  scanned: number; archived: number; skippedNotIdle: number; skippedNoPolicy: number; skippedNoClock: number;
  benignMissing: number; alreadyArchived: number; clientError: number; transient: number; denied: number;
  capped: boolean; deadlineHit: boolean; notBeforeSet: boolean; aborted: boolean;
}
export function makeIdleThreadArchiveSweep(opts: {
  identity: InfraDiscordIdentity; channelIds: string[];
  fetchImpl?; now?; sleepImpl?; log?;
  /** 401/403 闩锁:每个「被拒 episode」只回调一次。闩锁记住被拒层级(list | thread);解闩只认**同层级的确凿成功**:list 级被拒 → 一次完整成功的列表请求;thread 级(fresh GET / PATCH)被拒 → 一次成功的 2xx PATCH。not-before 空转、abort / deadline 在请求前、429、5xx / 网络 / 形状非法 都**不**解闩。plugin 接 MetaAlertNotifier。 */
  onDenied?: (detail: { status: number; context: string }) => void;
}): { runOnce: (shouldAbort?: () => boolean) => Promise<IdleThreadSweepResult> };

/** 显式 adapter 给 startDoneThreadReconcileScheduler(scheduler 只读 enabled/intervalMin) */
export const IDLE_THREAD_SWEEP_SCHEDULER_CONFIG: DoneThreadReconcileConfig = {
  enabled: true, intervalMin: IDLE_THREAD_SWEEP_INTERVAL_MIN, dryRun: false,
  maxArchivesPerRun: IDLE_THREAD_SWEEP_MAX_ARCHIVES_PER_RUN, maxCandidatesPerRun: IDLE_THREAD_SWEEP_MAX_ARCHIVES_PER_RUN,
  runDeadlineMs: IDLE_THREAD_SWEEP_RUN_DEADLINE_MS };
```

### 2.2 `runOnce` 流程(never-throw,一行计数日志收尾)

1. `now < notBeforeMs` ⇒ 直接 finish。
2. `listGuildActiveThreads`:429 ⇒ 解析一次 `Retry-After` header / JSON `retry_after`(都缺 ⇒ 60s)→ `notBeforeMs`、`notBeforeSet`、结束本轮;401/403(列表、fresh GET、PATCH 任一处)⇒ `denied++` + **闩锁未上时**调 `onDenied` 并上闩(记层级)+ 结束本轮;**解闩只认同层级确凿成功**(list 级:一次完整成功列表;thread 级:一次 2xx PATCH);not-before / abort / 429 / transient 轮不解闩;5xx / 网络 / 形状非法 ⇒ `transient++` + 结束。
3. 逐条:`parent_id ∉ channelIds` ⇒ 不计数跳过;`scanned++`;`thread_metadata.archived` ⇒ `alreadyArchived++`;`aad ∉ {60,1440,4320,10080}` ⇒ `skippedNoPolicy++`(没有合法窗口就不动);`lastActivityMs` 为 null(`last_message_id` 缺失或非法)⇒ `skippedNoClock++`;`lastActivity > now` 或 `now − lastActivity < aad·60000` ⇒ `skippedNotIdle++`;否则候选。
4. 候选:`PATCH 尝试数 ≥ 25` ⇒ `capped` 停(cap 按尝试计,不按确认数计,写面有界);`sleep(500ms)`;`checkStop`(shouldAbort / 60s 期限);**fresh `GET /channels/{tid}`**:404 ⇒ `benignMissing`;已归档 ⇒ `alreadyArchived`;`parent_id` 变了 ⇒ `benignMissing`;用 fresh 的 aad + 时钟重算,不再静置 ⇒ `skippedNotIdle`;`PATCH /channels/{tid} {archived:true}`:2xx **且响应体 `thread_metadata.archived === true`** ⇒ `archived++`;2xx 但显式 `false` / 形状非法 ⇒ `transient++`(不确定,留给下一轮 active 列表收敛);404 ⇒ benign;400 + code 50083 ⇒ `alreadyArchived`;429 / 401 / 403 / 5xx ⇒ 同第 2 步的全局处置并结束本轮;其他 4xx ⇒ `clientError++` 继续下一条。
5. 每个请求独立 `AbortController`,超时 = `min(5s, 剩余期限)`;`stop()` 的 drain 有界。
6. 写面只有 `archived: true`。不改名、不改 aad、不发消息、不读写 StateStore。

### 2.3 接线(`plugin.ts`)

紧接 `doneThreadReconcile` 构造之后(`:7704` 附近):

```ts
const infraDiscord = resolveInfraDiscordIdentity();
const sweepChannels = resolveIdleThreadSweepChannelIds();
let idleThreadSweep: ReturnType<typeof startDoneThreadReconcileScheduler> | undefined;
if (infraDiscord && sweepChannels.length > 0) {
  const sweep = makeIdleThreadArchiveSweep({ identity: infraDiscord, channelIds: sweepChannels,
    onDenied: (d) => void metaAlertNotifier.notify({ reason: "idle_thread_sweep_denied", title: "FLY-2028 idle thread sweep denied",
      body: `Discord ${d.status} during ${d.context}; claw-infra-bot token/MANAGE_THREADS changed — idle threads will pile up until fixed.` }) });
  idleThreadSweep = startDoneThreadReconcileScheduler({
    runOnce: async (abort) => { await sweep.runOnce(abort); return undefined; },
    resolveConfig: () => IDLE_THREAD_SWEEP_SCHEDULER_CONFIG,
    log: (m) => console.log(`[idle-thread-archive-sweep] ${m}`) });
  console.log(`[Bridge] FLY-2028 idle thread sweep ready — channels=${sweepChannels.join(",")}`);
}
// close 路径(:11670 前):await idleThreadSweep?.stop();
// 段 A §1.4:doneThreadReconcile 的 listDiscordOpenThreadIds 用同一个 infraDiscord(缺失则不注入)
```

`MetaAlertReason` += `"idle_thread_sweep_denied"`。

## 3. 文件清单

| 文件 | 动作 |
|---|---|
| `bridge/discord-guild-active-threads.ts` | 新增(identity / 列表 / snowflake / 时钟) |
| `bridge/idle-thread-archive-sweep.ts` | 新增(段 B) |
| `bridge/done-thread-archiver.ts` | authority + quietWindow + `deferred_quiet_window`;围栏式首次归档;§1.2 决策表 |
| `bridge/chat-thread-utils.ts` | `ArchiveReason` 加 `deferred_quiet_window`;`getChannelName` 返回 `archiveTimestamp` |
| `bridge/terminal-thread-archive.ts` | terminal 权威;`deferred_quiet_window` outcome;`TerminalArchiveAdmission` 回执;删 founder_reopened outcome |
| `bridge/done-thread-reconcile.ts` | `enqueue` 回执;terminal 权威;`deferredQuiet` 计数;`listDiscordOpenThreadIds` + archive-only 第二段 |
| `bridge/post-ship-finalization.ts` | terminal 权威;`enqueueTerminalArchive` dep + 回执裁决;`land_archive_deferred_unqueued`;删 founder_reopened 文案 |
| `DirectEventSink.ts`、`bridge/event-route.ts`(×2)、`bridge/merge-ship-gate.ts`(+ 上游 `bridge/actions.ts`、`bridge/founder-consent/wiring.ts`)、`bridge/external-merge-reconcile.ts`、`bridge/plugin.ts:6293`(resumable land) | 六个 post-ship 入口传 `enqueueTerminalArchive`(各自的构造/组合 seam 补 dep) |
| `StateStore.ts` | `commitReArchive` → `commitThreadArchive`(改名,行为不变;首次围栏归档复用) |
| `bridge/tools.ts` | `QueryRouterOptions.lookupIssueForArchive` seam;端点 authority;quietWindow 0;响应带 authority |
| `MetaAlertNotifier.ts` | reason 加 `idle_thread_sweep_denied` |
| `bridge/plugin.ts` | sweep 构造 + scheduler + stop;reconcile 注入发现函数;`enqueueTerminalArchive` 接到五处 |
| 对应 `__tests__` | 见 §4 |
| `engineering/doc/FLY-1709-archive-once-deadlock/plan.md` | 顶部加一行 dated note:terminal 权威下 any-human 规则由 FLY-2028 收窄(不改写历史正文) |

## 4. TDD(RED → GREEN)

| 测试文件 | 断言 |
|---|---|
| `bridge/__tests__/discord-guild-active-threads.test.ts`(新) | identity:缺 token / 缺 guild → null,两个 guild env 的优先级;列表:5s 超时斩断 never-resolving fetch、形状非法条目被丢、429 带 retryAfterMs;snowflake:短数字拒绝、真 18-19 位转换;`lastActivityMs`:仅 last_message_id → 用它;last_message_id 缺失/非法 → **null(不回退 thread.id)**;archive_timestamp 更晚 → 取更晚;archive_timestamp 更早/非法 → 不影响 |
| `bridge/__tests__/idle-thread-archive-sweep.test.ts`(新) | 范围:其他 parent 零 PATCH 且不计 scanned;两个频道 env 只配一个;静置:idle ≥ aad → PATCH archived:true(body 逐字节 `{"archived":true}`)、idle < aad 零写、aad 非法 → skippedNoPolicy 零写、future 时钟 → 不静置、无 last_message_id → skippedNoClock 零写、解档更晚且未满窗 → 零写;fresh 复核:快照静置但 fresh 有新消息 → 零 PATCH、fresh 已归档 → alreadyArchived、fresh 404 → benignMissing、parent 变 → benign;PATCH 结果:**2xx 体 `archived:true` → archived++;2xx 体 `false` / 形状非法 → transient 不计 archived**;404 / 400+50083 / 其他 4xx 继续下一条;cap 按 PATCH 尝试数计;**401/403 闩锁:列表级 403 连续三轮 → onDenied 恰一次;`list 200 → fresh GET 200 → PATCH 403` 连续三轮 → 恰一次(列表成功不解 thread 级闩);`denied → not-before 空转 → denied`、`denied → 429 → denied`、`denied → 5xx → denied` 都仍恰一次;list 级被拒后一次完整成功列表再被拒 → 再次回调;thread 级被拒后一次 2xx PATCH 再被拒 → 再次回调**;429 三形态(header / JSON / 缺失→60s)+ `retry_after=0` 也结束本轮 + 下一次 runOnce 在 notBefore 前零请求;5xx 结束本轮;cap 25 → capped;spacing 被调用;deadline → deadlineHit;shouldAbort → aborted;never-throw;adapter 结构满足 `DoneThreadReconcileConfig`(无 cast) |
| `__tests__/done-thread-archiver.test.ts`(改) | 首次(自动):静默窗内 → deferred 零 PATCH 零 removeUser 零事件零收据;静默满 → removeUser → 收据 → PATCH → verify → **一次 `commitThreadArchive`**(event id 含 epoch、收据清、archived_at 置);**生命周期回归:自动归档成功 → `commitReactivation` → 再次自动归档成功,Discord 仍归档、epoch 置、收据清、两条审计事件都在(id 不同)**;**probe₀ 分支:404 → markChatThreadMissing + missing;archived:true → `commitThreadArchive` skip 事件 + already_archived 零 PATCH;archived 字段缺 → reopen_check_failed 零写**;**probe₀ 开着 → PATCH 400/50083:F1===F0 → 提交;F1≠F0 → 补偿 deferred**;**竞态 (a) 静默检查后、PATCH 前来消息(F1≠F0)→ 补偿解档、Discord 开着、archived_at 未置、deferred**;**竞态 (b) PATCH 后 verify 前来消息 → 同上**;verify 读失败 → 收据留、reopen_check_failed,下次调用先 resumeCompensation;**PATCH 不确定(网络 error / exhausted)且 probe 已归档 → 补偿 + reopen_check_failed;probe 开着 → 清收据;probe 失败 → 收据留**;PATCH 确定没写(404/401/403/非 400 的 4xx)→ 清收据原样返回;**skip 事件与 missing 事件形态断言(id 前缀与 payload reason)**;初始 probe 失败 → reopen_check_failed 零写;无消息时钟(frontier null)→ reopen_check_failed 零写;端点(quietWindow 0)→ 不取 frontier 不写收据,今天的路径逐字节;re-archive:terminal + human 消息 + 静默满 → 真 PATCH + reArchived 审计;terminal + human + 静默内 → deferred;terminal + **合法旧 last_message_id + 更新的 archive_timestamp(人工 unarchive)** → 解档未满窗 deferred / 满窗归档;terminal + in_active_use → 仍 waived;none + human → founder_reopened 不变;none + bot_only + 静默内 → deferred;PATCH 后人类插入(补偿路径)terminal → deferred 而非 founder_reopened;future 时间戳 → deferred |
| `__tests__/StateStore.fly1709-archive-reopen.test.ts`(改) | `commitThreadArchive`:无既有 epoch 也能提交;审计 insert 失败 → 事务回滚,`archived_at` 与收据均不变 |
| `__tests__/post-ship-finalization.test.ts` + `bridge/__tests__/post-ship-finalization.*.test.ts`(改) | sink 收到 `authority:"terminal"`;deferred + enqueue accepted/deduped → `threadArchived=true`、enqueue 恰一次、无 `land_archive_waiver` 通知、land 完成;deferred + refused → partial `land_archive_deferred_unqueued`;deferred + dep 缺失 → partial;in_active_use 通知保留;founder_reopened 文案不存在(源码 grep-zero 于该文件) |
| `__tests__/terminal-archive-enqueue-sites.test.ts`(改) | **枚举全部六个** post-ship 生产入口(五个 `runPostShipFinalization(` + `plugin.ts` 的 `runResumablePostShipFinalization(`)都传 `enqueueTerminalArchive` 且回调源自同一 buffer(源码扫描,新增调用点未传即红);`actions.ts` / `founder-consent/wiring.ts` 把回调穿到 `finalizeRecoveredMerge`;buffer 回执:缓冲 accepted、重复 deduped、满 refused、bind 后透传 |
| `bridge/__tests__/terminal-thread-archive.test.ts`(改) | sink 收到 terminal;deferred → outcome retryable;scheduler `enqueue` 回执四态;集成:deferred 项留队并按退避重试,quiet 满后 archived 出队 |
| `bridge/__tests__/done-thread-reconcile.test.ts`(改) | 第二段:`listDiscordOpenThreadIds` 返回 {A(DB 已归档), B(DB 未归档,已在主循环), C(非 chat_threads 行)} → 第二段只处理 A,B 不重复,C 忽略;**A 调用了 sink(authority terminal),且 `retireIssueGates` / `closeRunnerFn` / `lifecycleCloseout` 对 A 零调用**;**竞态:lookup₁ completed、lookup₂ started → 零 sink;lookup₂ 抛错 → skippedUnresolved 零 sink**;A 活 pane → skippedActive;discovery `{ok:false}` → 日志 `openDiscovery=unavailable(<error>)` + DB-only + 不抛;未注入 → `openDiscovery=absent`;**主循环已 deadline/cap/candidate 耗尽 → 零 discovery 请求,`openDiscovery=skipped`;dryRun → dryRunWouldArchive 零写;第二段的 scanned 计入 maxCandidates,residue 只得剩余预算**;deferred → `deferredQuiet` 不计 failed;`FLYWHEEL_DONE_THREAD_RECONCILE=0` 仍整体不跑(byte-compat) |
| `bridge/__tests__/chat-thread-routes.test.ts`(改) | 端点:`lookupIssueForArchive` 返回 Done → sink `authority:"terminal"` 且 `quietWindowMs:0`,响应 `authority:"terminal"`;返回 started → none;seam 未注入且无 `LINEAR_API_KEY` → none;lookup 抛错 → none 且 200 |
| `__tests__/archive-outcome-consumers.test.ts`(改) | `deferred_quiet_window` 在全部消费方有映射(post-ship 回执裁决 / targeted retryable / reconcile 计数) |
| `__tests__/meta-alert-notifier.test.ts`(改) | 新 reason 可 notify |
| `__tests__/chat-thread-utils.test.ts`(改) | `getChannelName` 返回 `archiveTimestamp` |
| plugin composition 类既有测试 | 保持全绿(byte-compat:无 claw token 时零 sweep、零发现注入) |

精确命令(包名是 `flywheel-teamlead`,零匹配 = FAIL):

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/discord-guild-active-threads.test.ts \
  src/bridge/__tests__/idle-thread-archive-sweep.test.ts \
  src/__tests__/done-thread-archiver.test.ts \
  src/__tests__/post-ship-finalization.test.ts \
  src/bridge/__tests__/post-ship-finalization.fly1434.test.ts \
  src/bridge/__tests__/post-ship-finalization.fly887.test.ts \
  src/bridge/__tests__/terminal-thread-archive.test.ts \
  src/bridge/__tests__/done-thread-reconcile.test.ts \
  src/bridge/__tests__/done-thread-reconcile.fly1185.test.ts \
  src/bridge/__tests__/chat-thread-routes.test.ts \
  src/__tests__/terminal-archive-enqueue-sites.test.ts \
  src/__tests__/archive-outcome-consumers.test.ts \
  src/__tests__/chat-thread-utils.test.ts \
  src/__tests__/meta-alert-notifier.test.ts \
  src/__tests__/StateStore.fly1709-archive-reopen.test.ts
```

验收:implement 先在改动前用**去掉两个新文件的 13 文件版本**跑同一命令记录基线(`Test Files 13 passed (13)` / `Tests M passed`),PR body 写明基线与终数;RED/GREEN 与最终验收用上面的 15 文件命令,终态必须 `Test Files 15 passed (15)` 且 `Tests` ≥ 基线 + 上表新增条数;`No projects matched` / 零匹配 = FAIL。全量 CI 绿。grep-zero:`git grep -n "founder_reopened" packages/teamlead/src/bridge/terminal-thread-archive.ts` 为零;`post-ship-finalization.ts` 只允许命中 `isArchiveObligationSettled`。

## 5. QA 合同(qa 节点执行;行为级,Lead 明令「529 房真 Discord 回归,两段都要」)

**Ground truth = Discord REST `thread_metadata.archived` + `archive_timestamp`**(本单的归档动作由我们自己发 PATCH,REST 标志就是行为本体,不再是 FLY-1431 那种错误信号)。侧栏截图作为 founder 视角补证。**不许人工代跑一轮**(Linear 08-24 评论):必须真等「过期窗 + 一个周期」。

### 5.1 台架

- 529 房:`scripts/test-deploy.sh <slot> --generalized --stub-runner --alerts`;slot Bridge env **显式注入** `CLAUDE_INFRA_BOT_TOKEN`(生产同一 token,它在四个测试频道都有 MANAGE_THREADS,research §1.3)与 `DISCORD_GUILD_ID`。对照臂:不注入 token 的同房 Bridge,证明段 B 与发现补全 dormant(启动日志无 `idle thread sweep ready`,`openDiscovery=absent`)。
- 段 A 的「fresh Linear Done」以注入 `lookupIssue` seam 给定(模块驱动,先例 `scripts/qa-fly892-real-discord-thread-e2e.mjs`),Discord 侧全真。

### 5.2 段 A 用例

| # | 步骤 | PASS 判据 |
|---|---|---|
| A1 ship 后不抢收尾话 | 真 issue thread(slot 项目 bot 建)→ 触发 post-ship 归档(模块驱动 `runPostShipFinalization`,merged 证据)→ 立刻由 bot 发一条「收尾话」 | ship 当刻 REST `archived=false`(deferred,日志含 `deferred (quiet window) → targeted queue (accepted)`);**T0 = 收尾话时间,T0+60min 之后、下一次 targeted 重试内** REST `archived=true`;之后无任何自动 POST 进该线程;整个过程线程**从未**被归档过再打开(REST 轮询每 5min 记录 `archived` 恒 false 直到最终 true) |
| A2 顶开后再收(bot) | 已归档线程 → bot 发一条(Discord 自动解档,REST `archived=false`)→ 等 | 60min 静默后一次 reconcile / targeted 内 `archived=true`,`archive_timestamp` ≥ 消息时间 + 60min |
| A3 顶开后再收(human) | 同 A2,但由**真人账号**(founder / Lead 本人)发一句 | 同 A2 判据。做不到真人发言 ⇒ 本条记「未在真机覆盖,由 done-thread-archiver 单测 classify seam 覆盖」,不许用 bot 消息冒充 |
| A4 发现补全 + 重启 | 让 DB `archived_at` 已置、Discord 开着的线程存在(A2 的中间态)→ **重启 slot Bridge**(清空内存队列)→ 跑一次 `reconcileDoneThreads`(注入 Linear Done) | 日志 `discoveredReopened=1 openDiscovery=ok`;线程被收;对照:discovery `{ok:false}` → `openDiscovery=unavailable(...)`,线程不收 |
| A5 负向:issue 未终态 | 同 A3 场景但注入 Linear `started` | 保持打开;端点返回 `founder_reopened, authority:"none"` |
| A6 负向:活 runner | 注入 `probeLiveness → alive` | `in_active_use`,零 PATCH |
| A7 端点终态 | 同 A3 中间态 + 注入 Linear Done → `POST /api/chat-threads/archive` | 立即 `archived:true, authority:"terminal"`(不等 60min) |
| A8 首次归档竞态 | 模块驱动:注入 `archiveFn` 包装器 —— 在委托给真实 `archiveChatThread` 之前阻塞(Promise 门闩),期间真发一条消息到线程,再放行让真实 PATCH 发出 | Discord 最终 `archived=false`,DB `archived_at` 为空,返回 deferred;消息可见未被埋;补偿的 unarchive PATCH 在日志/REST 可见 |

### 5.3 段 B 用例

| # | 步骤 | PASS 判据 |
|---|---|---|
| B1 主行为 | 在 `#test-leads-roundtable`(default=60)建线程 + 1 条消息,T0 = 消息时间;**不 @ 任何人** | `archived=false` 直到 T0+60min;**T0+60min 之后 ≤ 10min + 一轮耗时内** `archived=true`;bridge.log 一行 `archived=1`;founder 侧栏截图该线程不在列表 |
| B2 对照:窗内有活动 | 同窗建第二条,T0+50min 再发一条 | T0+70min 仍 `archived=false`;T0+110min+周期内 `archived=true` |
| B3 对照:范围外 | 在 `#product-lead-test`(aad=60,不在 scope)建一条静置 | 全程 `archived=false` |
| B4 存量一次扫 | `#test-flywheel-alerts` 现有 60 条超窗线程(research §1.1) | 首轮 `archived=25 capped=true`,三轮内全部归档;每轮 PATCH 间隔 ≥ 500ms(日志时间戳) |
| B5 解档即活动 | 手动 unarchive 一条已被扫的线程,不发言 | 至少 aad 窗内不再被收;窗后被收 |
| B6 权限失效 | 对照 Bridge 用 Tadashi token 充当 `CLAUDE_INFRA_BOT_TOKEN`(research §1.3 无 MANAGE_THREADS) | 日志 `denied=1`,meta-alert 文件出现 `idle_thread_sweep_denied` **恰一次**(连续 ≥3 轮不再新增),零归档 |
| B7 关机 drain | 扫描中 `SIGTERM` Bridge | 干净退出,无未处理 rejection |

### 5.4 纪律

- 全部在测试频道,零触生产 Bridge / 生产频道;真人发言只在测试线程。
- 先拷证据再拆房(bridge.log、REST 回读 JSON、截图)。
- 判 PASS 前拉 exact head 的 CI。

## 6. Rollout / 回滚 / 迁移

1. 单 PR(两段,按 §3 两组 commit),founder-gated ship;canonical `restart-services.sh` 一次正常路径部署(stop → build → start → /health)。
2. 部署后 15s boot 延迟 + 首轮:生产 `#leads-roundtable` 当前 9 条超窗线程在首轮被收(cap 25 内);`#flywheel-alerts` 当前 0 条超窗,自然到期后收。段 A:下一次 6h reconcile 起,`openDiscovery=ok`,被顶开的 Done 线程在静默满后被收。
3. 生产验证:boot 日志 `idle thread sweep ready — channels=<两 id>`;首轮 pass 行 `archived=9`(或当刻实际数);之后一条真实 roundtable 话题在最后消息 +60~70min 内 REST `archived=true`;一个真实 ship 单在 Lead 收尾话后 60~90min 内归档且中间无顶开。
4. **迁移**:无 schema、无数据回填。`archive_timestamp` 字段是读取加法;compensation 收据复用既有列。
5. **回滚**:revert PR + 重启。已归档线程保持归档(可手动 unarchive);无状态需要清理。回滚后行为回到今天(founder_reopened 永拒、ship 当刻归档)。
6. **不做的运维项**:不改 Discord 频道设置、不加 bot、不改权限(claw 已具备)。

## 7. 风险与诚实边界

| 风险 / 边界 | 处置 |
|---|---|
| 60min 静默让 ship 后线程多留一小时 | 这是 founder 08-31 的原话诉求(收尾话说完再收);同 roundtable 的一小时口径 |
| Done 线程 founder 再发言 → 打开 → 静默 1h 后又收 | Lead 09-03 明示可接受;静默窗保证不会在她说话当中关 |
| 只按「有没有人说」不按「谁说」:founder 在 Done 线程的提问 60min 后被收 | 同上;想长期保留应 reopen issue(Linear 非终态 ⇒ 权威回到 none) |
| **targeted 队列在内存(上限 64),Bridge 重启即丢** | 明示接受:重启后由 6h DB 清扫兜底 —— 首次归档的行 `archived_at` 为空本就在候选集;顶开的行由 §1.4 发现补全兜底。入队被拒(满)时 post-ship 不当 settled,land 重试通道会再来 |
| 发现补全依赖 claw 能 VIEW 各项目频道 | 实测 claw 看得到 328 条活跃线程含 engineer/product;看不到的频道退回 DB-only,日志可见 |
| 围栏首次归档补偿后 founder 已被移出线程 | 与今天「归档后被顶开」状态一致(她本就被移出);下一条 @ 她的消息会加回 |
| 段 B 最坏时延 = aad + 10min + 轮耗时 | 不是整点;写进 founder HTML |
| 段 B 只管两个频道;零消息线程永不归档 | test 频道 / 其他 Lead 频道不动;要扩频道 = 改 env 指向,不改代码;零消息线程(极罕见)按「无时钟不归档」fail-safe |
| Discord 客户端对「已归档但未读」的侧栏行为 | 三次人工大扫除已证明会消失;QA B1 截图钉死 |
| 端点 `force`(founder 在**未终态** issue 线程直令归档) | 不做;§1.4 实例全在 Done 单,终态权威已覆盖;真需要时另开单 |
| Lead 归档后追话防呆 | 不做(发送路径在 plugin);追话只会带来一次「打开→1h 后再收」 |
| 告警产生量 | FLY-1386,不碰 |

## 8. 评审记录

- Codex design review R1(2026-09-02,xhigh,隔离 CODEX_HOME):CHANGES REQUESTED,8 条,**全部采纳**:
  1. [BLOCKING] 补全候选会被主循环的 `isChatThreadArchived` 否决,且会误走 observation / gate retirement / husk finalize / closeout → 改为独立 archive-only 第二段(§1.4),测试断言三类 mutator 对其零调用;
  2. [BLOCKING] 首次归档「静默检查→PATCH」之间的消息会被埋 → 复用 FLY-1709 围栏 + 补偿收据做围栏式首次归档(§1.2),两种竞态各一条测试;
  3. [BLOCKING] 时钟合同与 founder 08-24 原话冲突(thread.id 回退、空集视为静默)→ 只认 `last_message_id`,`archive_timestamp` 只作不早于守卫,无时钟不归档(§1.1 ②);收据 `frontier` 保持 `string`;
  4. [HIGH] post-ship 生产调用点是五个不是四个 → `PostShipDeps.enqueueTerminalArchive` 独立 dep,五处显式接线,enqueue-sites 测试枚举全部;
  5. [HIGH] 「deferred = settled」没绑入队成功 → 入队回执 `accepted|deduped|refused`,refused / 缺 dep 归 partial;重启丢队列明示由 6h 清扫兜底(§7);
  6. [HIGH] 端点测试落错套件、SDK mock 缺 `rawRequest` → 加 `lookupIssueForArchive` seam,断言移到 `chat-thread-routes.test.ts`,命令表更新,基线由 implement 记录不硬编码;meta-alert 测试路径改为小写实名;
  7. [MEDIUM] 发现函数返回值表达不了错误 → `{ok:true,ids}|{ok:false,error}`,未注入 = absent,三态各有测试;
  8. [MEDIUM] 401/403 每 10 分钟都会打 meta-alert → 被拒 episode 闩锁,成功列表后再上膛,测试断言恰一次。
- Codex design review R2(2026-09-02,xhigh,同一线程 resume):CHANGES REQUESTED,8 条,**全部采纳**:
  1. [BLOCKING] 首次围栏归档「mark + 审计 + 清收据」三步不抗崩溃;PATCH 失败一律清收据会丢掉补偿 owner → 成功用 `commitThreadArchive`(原 `commitReArchive` 改名)单事务提交;PATCH 结果分「确定没写 / 不确定 / 已写」三类处置;初始 probe 失败 fail-closed;StateStore 回滚测试(§1.2);
  2. [BLOCKING] 漏了 `runResumablePostShipFinalization`(`plugin.ts:6293`)这个第六个入口,`finalizeRecoveredMerge` 的回调要经 `actions.ts` / `founder-consent/wiring.ts` 穿入 → 六个入口全部列出并测试枚举(§1.3, §3, §4);
  3. [BLOCKING] 第二段只查一次 Linear,liveness await 期间 founder reopen 会被过期终态覆盖 → sink 前不缓存复读一次,两条竞态测试(§1.4);
  4. [HIGH] 第二段没继承 `maxCandidates` / `dryRun`,位置未定,可能吃掉 residue 预算 → 共用同一套预算、dryRun 归 `dryRunWouldArchive`、主循环已停则不发 discovery、置于 residue 之前(§1.4);
  5. [HIGH] 闩锁在列表成功即解开,`list 200 → PATCH 403` 每轮都会告警 → 只有整轮零 401/403 才解闩,两种形状测试(§2.1, §2.2, §4);
  6. [MEDIUM] 测试表「零消息人工 unarchive」与「无时钟不归档」矛盾 → 改为「合法旧 last_message_id + 更新的 archive_timestamp」,另加 null-frontier 零写断言(§4);
  7. [MEDIUM] QA A8 引用了不存在的 `sleepImpl` seam → 改用阻塞式 `archiveFn` 包装器,真实 PATCH 照发(§5.2);
  8. [MEDIUM] 段 B 把任何 2xx 计成归档 → 只认响应体 `thread_metadata.archived === true`,否则 transient;cap 按尝试数计(§2.2, §4)。
- Codex design review R3(2026-09-02,xhigh,同一线程 resume):CHANGES REQUESTED,4 条,**全部采纳**:
  1. [BLOCKING] 固定 event id `chat-thread-archived-fly369-<threadId>` 在 `commitReactivation` 后的第二个生命周期撞 `session_events.event_id` 唯一键,原子提交回滚 → 收据留下 → 归档/补偿死循环 → 自动路径 event id 改为 `…-fly2028-<threadId>-<epoch>`;端点旧路径保留旧 id;加「归档 → reactivation → 再归档」回归(§1.2, §4);
  2. [HIGH] 首次归档 probe₀ 没定义 404 / 已归档 / 字段缺失分支,且 400·50083 竞态被当成确定没写 → 显式分支:404 → missing 收敛;archived:true → 原子 already_archived 收敛;缺字段 → fail-closed;400(含 50083)→ 走 verify 提交/补偿(§1.2, §4);
  3. [MEDIUM] 「整轮零 401/403」会被 not-before / abort / 429 / transient 轮误解闩 → 闩锁记层级,只认同层级确凿成功(list:完整成功列表;thread:2xx PATCH)解闩,补三条「denied → 无结论轮 → denied 仍恰一次」测试(§2.1, §2.2, §4);
  4. [LOW] 基线命令含两个尚不存在的新文件跑不动 → 基线用 13 文件版本,RED/GREEN 与验收用 15 文件版本(§4)。
