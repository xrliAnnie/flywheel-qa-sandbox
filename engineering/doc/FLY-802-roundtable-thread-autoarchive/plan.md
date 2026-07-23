# FLY-802 Roundtable thread 1h 自动归档(重开根修)— 实施计划

> **已由 FLY-1435 取代。** 本文保留为历史记录；Discord 现行 `auto_archive_duration` 语义、零 reconciler 方案与验收 ground truth 以 `../FLY-1435-native-autoarchive-rootcause/research.md` 和 `plan.md` 为准。

Issue: FLY-802 (https://linear.app/geoforge3d/issue/FLY-802/roundtable-topic-thread-1h-无活动自动归档-描述性命名-别一排排堆在侧栏)
日期: 2026-07-22
基于: research.md

> **历史**:本文件此前版本对应已合入的 PR #423(创建路径显式 60 + poller converge PATCH)。该轮修复 false-Done(见 exploration.md §1-2):plugin fork 硬编码 4320 抢建 + poller bot 无 MANAGE_THREADS 使 converge 永久 403。本版按 Annie 2026-07-17 拍板的 channel-default-driven spec 重写,git 历史保留旧版。Codex design review R1 反馈已全部折入(idle 语义、BigInt snowflake、bounded I/O、provider 生命周期、scheduler 接缝、opt-in/opt-out 合同、文件清单)。

## 0. 目标与合同

- **Scope(含 Lead 指令 8d610404 的追加)= stale 讨论 thread 自动归档,两个来源**:
  ① roundtable topic thread(原 scope,目标 1h);
  ② unified alert 频道(1518793447165661254)per-error thread(FLY-368,现 24h 太长;**推荐 60**,理由见 research.md §5 —— 最终值由 founder 在 Discord 设置定,随时可调零代码)。
  **减量边界**:alert 堆积主因是假告警风暴(watchdog 误报),真正减量归 **FLY-1386**;802 只做「堆了的自动收起」,不碰告警产生量。
- 无活动自动收起 = archived,消息保留、可搜、有新消息自动解 archive。
- **零硬编码频道**:代码不出现频道名/id,也不出现"60"这种频道专属值;"哪个频道特殊"完全由 founder 在 Discord 频道设置里控制。
- 不碰 issue chat thread(FLY-292 / `ChatThreadCreator.ts`)、`done-thread-reconcile.ts` 既有行为(只在 composition 层复用其 scheduler,经显式 adapter)。

**resolve 规则(Annie 07-17 follow-up,create 路径完整执行;fallback 按 call site)**:
```
resolveAutoArchiveMinutes(channelDefault, fallback = 4320):
  channelDefault ∈ {60,1440,4320,10080} → 原样返回
  null / undefined / 非法值           → fallback
    - roundtable 三入口: fallback = 4320 (Discord API 默认;founder 的"多数频道保持 3 天")
    - AlertChannelHub:   fallback = 1440 (= 今天的硬编码;频道未 opt-in 时字节兼容)
```

**reconciler 纳管合同(Codex R1#6 定稿口径 —— 这是运维语义,写死在文档与测试里)**:

- 父频道 `default_auto_archive_duration` **非 null = 显式 opt-in**:该频道下**全部** active thread(含任何代码/人为的 per-thread 故意值)都被收敛到该 default。opt-in 频道内不存在"个别 thread 豁免"。
- **null = 完全 opt-out**:reconciler 对该频道零动作,现值全部保留(包括 alert 1440、issue 4320)。
- **非 null → 清回 null**:立即退出纳管、保留清空时刻的现值(不会"收敛回 4320")。想回 3 天**且**继续纳管 = 显式设 4320。
- 推论:"任何 creator 最终收敛到 resolve(父频道 default)"**仅对 opt-in 频道成立**;这是方案 B(research.md §5)的刻意取舍,不是全局不变式。

## 1. 交付物一:本仓 create 半 + resolver(PR-1 part A)

### 1.1 新模块 `packages/teamlead/src/bridge/roundtable/channel-archive-default.ts`

```ts
export const DISCORD_API_DEFAULT_AUTO_ARCHIVE_MINUTES = 4320; // Discord API 默认,非频道硬编码
export const VALID_AUTO_ARCHIVE_MINUTES = new Set([60, 1440, 4320, 10080]);

/** 纯函数:见 §0 resolve 规则(fallback 按 call site,默认 4320)。 */
export function resolveAutoArchiveMinutes(
  channelDefault: number | null | undefined,
  fallback?: number,
): number;

/** 长生命周期 provider(构造一次、随处传引用):GET /channels/{id} →
 *  default_auto_archive_duration(number|null),按 channelId 做 TTL 缓存(默认 10 min)。
 *  - 每次 GET 带 AbortController timeout(5s);
 *  - token 支持静态串或 **call-time accessor**(Codex R5#1):accessor 在每次 GET 时
 *    求值,返回有序 token 列表;401/403/404 视为该 token 无频道读权限 → 试下一个
 *    (镜像 REPAIR 链的 isPermFallthrough 语义)。roundtable 传静态 Cass token;
 *    alert 传共享 accessor(见 §1.5)—— sender-override 优先级与 env 运行时变化
 *    的既有合同不被 boot 时快照破坏。
 *  - 失败:有 stale 缓存 → 用 stale;没有 → null(→ resolver 落 fallback),并
 *    logger.warn(降级必须可见,Codex R1#4);**绝不 throw / 绝不 reject**。
 *  - 注入 fetchImpl / now / logger 供测试。 */
export function makeChannelArchiveDefaultProvider(opts: {
  channelId: string;
  botToken: string | (() => string[] | string | undefined);
  fetchImpl?: typeof fetch; ttlMs?: number;
  now?: () => number; logger?: { warn: (m: string) => void };
}): () => Promise<number | null>;
```

### 1.2 `roundtable-text.ts` + `roundtable-text.test.ts`

删除 `ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES`;`roundtable-text.test.ts` 现在 import 该符号,**同 PR 改写该测试文件**(Codex R1#7)。合入前 grep-zero 多形态 sweep(import、注释、字符串)。

### 1.3 `RoundtableThreadManager.ts`

- 构造参数新增 `archiveDefaultProvider?: () => Promise<number | null>`;生产在 plugin.ts 构造**一次** §1.1 provider(绑 poller channelId + Cass token —— GET 权限足够)传入。
- `createThreadFromMessage`:create body 的 `auto_archive_duration` = `resolveAutoArchiveMinutes(await provider())`。
- `processMessage` "created" 分支:`currentArchiveMinutes` 传同一 resolved 值(保持自建零冗余 PATCH)。
- `commitThread` 收敛目标值:同一 resolved 值。converge PATCH 的 403 fail-soft **保持现状**(Cass 无 MANAGE_THREADS,预期失败;真正的收敛由交付物二负责)。

### 1.4 `ensure-thread-from-message.ts` + 调用方 wiring(Codex R1#4)

- `EnsureThreadDeps` 新增 `archiveMinutes?: number`(已 resolve 好则直传,优先)与 `archiveDefaultProvider?: () => Promise<number | null>`(次优)。两者都缺 → 显式 4320(兼容路径,warn 一次)。`archiveMinutes` 非法枚举值 → 按 4320 处理并 warn。
- **真实调用方 `roundtable-reply-in-thread-wiring.ts` 的 `buildReplyInThreadWiring()` 是长生命周期 composition seam**:在这里构造一次 provider(绑 parentChannelId + token)并在每次 ensure 传入 —— TTL/stale 语义才真实生效,不是每次 new 闭包。
- exists 分支行为不变(只 confirm)。

### 1.5 AlertChannelHub 路径(scope 追加,Lead 指令 8d610404;落点按 Codex R5#1 修正到真实 composition seam)

**Ownership 事实(Codex 核实)**:`unifiedAlertChannelId` 与 token 解析闭包(`FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 存在时为权威单 sender,否则 Cass→fleet REPAIR 链;**每次调用时重新解析 env**)都在 `plugin.ts`(约 :8117-8129 / :9417-9430);`AlertChannelHubDeps` 只持有封装好的 `discord` ops。Hub 层拿不到 channel id / token 链 —— provider 不能落在 Hub 内。

- **`plugin.ts`(composition)**:抽出共享 `getAlertDiscordTokens()`(与现闭包同源:sender-override 优先、否则 REPAIR 链、call-time 解析),同时传给 `createDiscordOps` 与 **唯一一个**绑定 `unifiedAlertChannelId` 的 §1.1 provider(token 走 accessor 形态);把可选 `archiveDefaultProvider` 注入 `AlertChannelHubDeps`。
- **`AlertChannelHub.ts`**:deps 增可选 `archiveDefaultProvider`;建 thread 前 `resolveAutoArchiveMinutes(await provider(), 1440)`,**外层 try/catch:provider 任何 rejection → 按 1440 照常创建**(绝不让 rejection 落进外层 handle() catch 而退化 root-only —— provider 合同本身 never-reject,这里是双保险)。deps 未注入 → 1440(字节兼容)。
- **`createDiscordOps().createThreadFromMessage(channelId, messageId, name)`**:签名扩为可选第 4 参 `archiveMinutes?: number`;body 用 `archiveMinutes ?? 1440`(未传 = 今天行为,ops 层字节兼容)。
- provider 返回 null/失败/频道未设置 → 1440(现状);频道 opt-in 后 → 出生即 founder 设的值。
- **rollout 配套(一次性 Discord 操作,非代码)**:给 unified alert 频道设 `default_auto_archive_duration = 60`(推荐值;founder 可随时改)→ reconciler 立即纳管:收敛存量堆积 + 归档 idle。

## 2. 交付物二:converge 半 —— channel-default reconciler(PR-1 part B)

### 2.1 新模块 `packages/teamlead/src/bridge/channel-default-thread-reconcile.ts`

**身份**:claw-infra-bot(`CLAUDE_INFRA_BOT_TOKEN`,MANAGE_THREADS 已验证)。绝不降级用 Lead bot。

**config resolver**(env 每 tick 重读,FLY-1165 同款纪律):

| env | 默认 | 说明 |
|---|---|---|
| `FLYWHEEL_THREAD_ARCHIVE_RECONCILE` | on(`!=="0"`) | kill-switch |
| `FLYWHEEL_THREAD_ARCHIVE_RECONCILE_INTERVAL_MIN` | 30 | 0 = boot-only。上限 clamp 55 + warn(**保证的是有界 staleness,不是"1h 前必收起"** —— 见 §6 时序口径) |
| `FLYWHEEL_THREAD_ARCHIVE_RECONCILE_DRYRUN` | off(`==="1"` 开) | 只报告不写 |
| `FLYWHEEL_THREAD_ARCHIVE_RECONCILE_MAX_PER_RUN` | 50 | 每轮 PATCH 上限 |
| (硬编码)runDeadlineMs=60s,spacingMs=500,每请求 timeout=5s | | 见 I/O 纪律 |

**启用前置(缺任一 → 整体 OFF,不构造 scheduler,byte-compat)**:`CLAUDE_INFRA_BOT_TOKEN` 存在 且 guild id 存在(`FLYWHEEL_DISCORD_GUILD_ID ?? FLYWHEEL_ROUNDTABLE_GUILD_ID`,后者生产已有)。QA slot / sub / joycon 没配 → 天然 OFF。

**I/O 纪律(Codex R1#3,适用于 discovery GET + PATCH 全部请求)**:

- 每个 Discord request 独立 AbortController timeout = min(5s, 剩余 runDeadline);候选循环每条检查 shouldAbort/deadline;spacing sleep 可协作取消 → `stop()` 的 drain 有界,Bridge 关闭不被挂住。
- **429 确定性合同(Codex R2#3,任意阶段)**:只解析一次(Retry-After header 或 JSON retry_after,都缺/非法 → 固定保守 fallback 60s)→ 设 `notBefore = now + retryAfter` → **立即结束本轮,绝不 in-pass retry**(retry_after=0 也不许在本轮内重试);后续 tick 先看 `notBefore` 再跑。
- 401:LOUD warn(token 失效)+ 结束本轮。403:LOUD warn(claw 权限被动过)+ 结束本轮(当前唯一 scope 频道下等价于 stop-parent)。5xx/网络/malformed body:该阶段按 transient 结束本轮,计数。
- **PATCH / revalidation 链上的预期竞态分类(Codex R2#3)**:404 = thread 已消失 → benign skip(计数);400 + Discord code 50083(thread 已 archived)→ benign already-archived skip(计数);其余 4xx = per-candidate client error,LOUD + 计数 + continue 下一条(不结束本轮、不混入 transient/denied)。

**runOnce 流程**(never-throw,计数器汇总一行日志):

1. GET `/guilds/{gid}/channels` → **opt-in 频道集** = `type ∈ {0,5}` 且 `default_auto_archive_duration != null`(id → default 映射)。空集 → 直接返回。
2. GET `/guilds/{gid}/threads/active` → 取 `parent_id ∈ opt-in 集` 的 thread。
3. 逐 thread:
   - `desired = resolveAutoArchiveMinutes(parentDefault)`;
   - **lastActivity 候选集合合同(Codex R1#1 + R2#2,遵循 Discord activity 语义)** —— 先验证、过滤,再取 max:
     1. `last_message_id` 先过 `isDiscordSnowflake()` 验证(`snowflakeToMs()` 本身不是 validator,短数字会被解成 2015 年附近 —— R2#2);非法再试 `thread.id`(同样先验证);合法者经 `snowflakeToMs()`(BigInt)入候选集;
     2. `thread_metadata.archive_timestamp` 仅当 `Number.isFinite(Date.parse(...))` 时入候选集;
     3. `lastActivity = max(全部 finite 候选)`;候选集**为空**才 `skippedNoClock`(只做 duration 收敛,计数 + warn —— fail-safe:宁可晚收不误收);future timestamp 直接判 not-idle(fail-safe)。
   - 需要的字段合成**一个 PATCH**:duration ≠ desired → 带 `auto_archive_duration: desired`;`now − lastActivity ≥ desired 分钟` → 带 `archived: true`。两者都不需要 → skip(幂等零写)。
   - **mutation-time fresh recheck(Codex R2#1 + R3#1,镜像 FLY-1165"slow await 后、mutation 前 fresh veto"纪律;适用于每个将发 PATCH 的候选,duration-only 也不例外)**:顺序 = spacing → ① bounded `GET /channels/{parentId}` 重读**父频道** fresh `default_auto_archive_duration`:fresh 为 **null → 整条零写 skip**(founder 已 opt-out,计 `optOutRace` —— §0"立即退出纳管"在 mutation 粒度成立);fresh 值变化 → 按 **fresh** 值重算 desired 与 idle 判定(绝不按旧快照值归档);② 若仍将携带 `archived: true` → 再 bounded `GET /channels/{threadId}` 复核:仍 active、`parent_id` 匹配、用 **fresh** `last_message_id / archive_timestamp` 重算 idle;不再 idle → 去掉 `archived`(按 fresh 状态仍可 duration-only);已 archived / 404 → benign skip。→ ③ PATCH。Discord 无 conditional PATCH,残余 race = fresh parent/thread reads 到 PATCH 的单请求间隔(诚实边界)。
   - 注:manual-unarchive 是 activity(archive_timestamp 刷新)→ 刚被 founder 解 archive 的老 thread **不会**被立刻回收;duration PATCH 本身也是 activity → 收敛后从 PATCH 时刻重新起算 idle。
4. 结束日志(Codex R3#2,与失败分类一一对应):`scanned / patchedDuration / archivedIdle / skippedInSync / skippedNoClock / optOutRace / benignMissing / alreadyArchived / clientError / transient / denied / capped / deadlineHit / notBeforeSet`。

**调度(Codex R1#5,不 cast、不改 FLY-1165 类型)**:复用 `startDoneThreadReconcileScheduler`,在 plugin.ts composition 写**显式 adapter**:`runOnce` 包一层丢弃自有 result(返回 `undefined`);`resolveConfig` 返回结构完整的 `DoneThreadReconcileConfig` 形状对象(enabled/intervalMin 用本 feature 的值,其余字段填本 feature 等值参数 —— scheduler runtime 只读 enabled/intervalMin,结构化类型天然满足)。新 scheduler handle 为 optional(前置缺失不构造),Bridge close 路径独立 `await stop()`。

### 2.2 明确不做

- 不 rename(命名已闭环,live 0 占位名;见 exploration.md §3)。
- 不读写 StateStore(候选集以 Discord 为准,覆盖三个 creator + Bridge 宕机窗口的漏网 thread)。
- 不碰 archived thread(active 列表天然不含)。
- 不做 per-thread 豁免(§0 合同:opt-in 频道全量纳管)。

## 3. 交付物三:fork plugin create 半(PR-2,跨仓 xrliAnnie/claude-plugins-official)

- `server.ts` `ensureRoundtableThread`:删掉硬编码 `auto_archive_duration: 4320`,换成**模块级长生命周期缓存**的 `resolveParentArchiveMinutes(parentChannelId)`(GET channel,TTL 10 min,每请求 5s timeout;失败 → stale,无 stale → 4320 + stderr warn —— 与 §1.1 同语义,进程内共享缓存,不是每次 ensure 新建闭包,Codex R1#4)。
- **测试 seam(Codex R1#7)**:fork 的 `roundtable-thread-policy.test.ts` 只测 pure 模块、不 import 有启动副作用的 server.ts —— 把 resolve 规则 + create body 组装抽成 pure helper(进 roundtable-thread-policy.ts 或新 pure 模块),对其做 create body 断言与 resolver 单测;server.ts 只留接线。
- 分发:合入 fork → `~/.flywheel/bin/update-discord-plugin.sh`(marketplaces + cache 两处);运行中 Lead 会话重启后生效,重启前的增量由交付物二收敛 —— **两半互为兜底,部署顺序无硬依赖**(建议 PR-1 先,reconciler 先把存量清掉)。
- ⚠️ 前置运维项(不在本 issue scope,已单独报 Lead):marketplaces 运行副本 2026-07-22 被 vanilla 覆盖,需先恢复 fork 版,否则 PR-2 无处生效。

## 4. 修改文件清单(PR-1)

| 文件 | 动作 |
|---|---|
| `bridge/roundtable/channel-archive-default.ts` | 新增(resolver + provider) |
| `bridge/roundtable/roundtable-text.ts` | 删常量 |
| `bridge/roundtable/__tests__/roundtable-text.test.ts` | 删对应断言/import |
| `bridge/roundtable/RoundtableThreadManager.ts` | provider seam + 三处用 resolved 值 |
| `bridge/roundtable/ensure-thread-from-message.ts` | deps 扩展 + 兼容路径 |
| `lead-backends/codex/roundtable-reply-in-thread-wiring.ts` | 构造一次 provider 并传入 ensure |
| `bridge/AlertChannelHub.ts` | ops 签名扩 archiveMinutes + deps 增可选 archiveDefaultProvider(fallback 1440,rejection 双保险) |
| `bridge/channel-default-thread-reconcile.ts` | 新增(runOnce + config resolver) |
| `bridge/plugin.ts` | manager provider 构造 + **共享 getAlertDiscordTokens() 抽取 + alert provider 构造(唯一实例)+ 注入 Hub deps** + reconciler scheduler adapter 接线 + close 路径 stop() |
| 对应 `__tests__` | 见 §5 |

## 5. TDD(RED → GREEN)

| 测试 | 断言 |
|---|---|
| `channel-archive-default.test.ts`(新) | resolver 纯函数五例;provider:TTL 内零重复 GET、TTL 后刷新、刷新失败返回 stale、无 stale→null+warn、GET 5s timeout 生效 |
| `RoundtableThreadManager.test.ts`(改) | create body 带 resolved 值(provider=60→60;null→4320;抛错→4320);exists-recovery:thread 4320 + provider 60 → PATCH 60;自建零冗余 PATCH 保持 |
| `ensure-thread-from-message.test.ts`(改) | archiveMinutes 直传优先;provider 次之;都缺→4320;非法值→4320+warn |
| `AlertChannelHub.test.ts` + plugin composition 测试(改/新) | create body:未传 archiveMinutes→1440(ops 字节兼容);Hub 传 resolved(provider=60→60;provider **null 与 reject 两形态**→仍创建且 body 1440,绝不退化 root-only);**生命周期/wiring**:同一 Hub 连续建两条 thread、TTL 内 channel GET 只发一次;sender-override 与 REPAIR 链路径不漂移(token accessor call-time 求值 —— R5#1) |
| reply-in-thread wiring 测试(改) | **连续两次 ensure 只发一次 channel GET**(长生命周期 provider 生效,Codex R1#4) |
| `channel-default-thread-reconcile.test.ts`(新) | **null 频道保护**(default=null 频道下 1440 thread 零动作 —— alert 回归哨兵);**non-null→null 保留现值**(60 thread 不被收敛回 4320);opt-in 频道内 per-thread 故意值被收敛(合同测试);duration 收敛;idle→archived;两者合一 PATCH;**mutation-time fresh recheck**(active 快照显示 old-idle、PATCH 前 fresh GET 显示刚有新消息 → **绝不发 archived:true**,可 duration-only;fresh 已 archived/404 → benign skip —— R2#1);**parent opt-in 新鲜度**(snapshot non-null → fresh parent null:duration-only 与 archive 候选**均零 PATCH**;snapshot 60 → fresh parent 1440:绝不按旧 60 归档、desired 用 1440 —— R3#1);**manual-unarchive 不被回收**(archive_timestamp 新于 last_message);**lastActivity 候选集三例**(valid snowflake + invalid timestamp → 用 snowflake;短数字假 snowflake + valid timestamp → 用 timestamp;二者皆坏 → skipNoClock —— R2#2,真实 18-19 位 snowflake fixture + isDiscordSnowflake 验证路径);future timestamp → not-idle;in-sync 零写;maxPerRun/deadline;**429 确定性合同**(header 与 JSON 两形态、retry_after=0 也结束本轮不 in-pass retry、缺失→60s fallback、notBefore 跨 tick 遵守 —— R2#3);**PATCH 竞态分类**(404 benign、400+50083 benign already-archived、其他 4xx LOUD+continue —— R2#3);401/403 结束本轮 + LOUD;never-resolving fetch 被 5s timeout 斩断;stop() drain 有界;dry-run 零写(含不发 fresh-recheck 之外的写);token/guild 缺→不构造 |
| scheduler adapter(plugin.ts 层) | 现有 done-thread-reconcile / terminal-thread-archive scheduler 测试保持全绿(byte-compat);新 handle optional + close 路径 stop() |
| grep-zero | `ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES` 全仓归零(含注释多形态) |
| fork 仓 | pure helper 的 create body 断言 + resolver 单测 |

## 6. 验收(QA 节点执行,设计给口径)

1. 单测/集成全绿 + `pnpm lint`。
2. **真机 E2E(生产 guild,claw 只读探测 + 前后对照)**:
   - before 快照:active roundtable thread 的 duration 分布(本轮 design 探测:13 条,5×4320)+ alert 频道 active thread 数;
   - 部署 PR-1 后一个 reconcile 周期内:roundtable 4320 → 0;idle 超时的被显式归档;**founder 手动 unarchive 一条老 thread → 下一轮不被回收**(R1#1 行为验证);
   - **alert 频道两段验证**:opt-in 前(default 未设)alert thread 逐字节不变(哨兵);在 Discord 设 default=60 后一个 reconcile 周期内 → 存量收敛 + idle 归档;**newborn=60 断言必须等 provider TTL(10min)过期或重启/显式刷新后再做**(设 60 前若哨兵段触发过 GET,null 会被合法缓存到 TTL 到期 —— 这是已批准的缓存语义,别误判为失败;Codex R5#2);
   - **零误伤对照**:issue chat thread duration 逐字节不变(guild active threads 快照 diff);
   - 部署 PR-2 + 重启一个 Lead 后:该 Lead 回帖新 topic → 新 thread 出生即 60(GET thread_metadata 验证,不认工具 success 行)。
3. Codex code review(xhigh)。
4. founder-gated ship(不自 ship)。

## 7. 风险与诚实边界

- **1h 粒度是 Discord 原生最短**;<1h 需自定义短窗 sweeper,Annie 已拍不做。
- **时序口径(Codex R1#1 修正)**:旧 plugin 抢建的 4320 thread,侧栏收起最坏发生在 `其 idle 起点 + 60min + 一个 reconcile interval`(duration PATCH 本身是 activity,idle 从收敛时刻重新起算)——即默认配置下最坏 ~90min、interval clamp 55 时最坏 ~115min,**不是**"1h 前必收起"。这是 PR-2 部署+Lead 重启完成前的过渡态;若 founder 要求过渡期也严格 1h,需要更短 interval 或 targeted due-time 调度(本计划不做,显式留边界)。
- **纳管合同见 §0**:opt-in 频道全量纳管(无 per-thread 豁免);null 频道完全不管;non-null→null 保留现值。issue thread 不被碰**当且仅当**其父频道 default 保持 null;alert 频道按本计划 rollout 时**主动 opt-in**(推荐 60,founder 可改可退)。
- **alert 频道的量**:802 只收起已堆的 thread;告警风暴的产生量归 FLY-1386,本设计不碰告警逻辑。
- **founder 改 opt-in 频道 default** → create 路径 TTL(≤10min)+ reconciler(≤interval)内自动跟随,零代码。
- reconciler 依赖 claw token/权限;401/403 LOUD warn 但不自愈 —— 运维信号。
- 运行中 Lead 会话的旧 plugin 继续产 4320 直到重启;reconciler 兜住,非阻塞。**该兜底与上面的时序上界仅在 reconciler enabled 且 intervalMin>0 时成立**;`intervalMin=0`(boot-only)或 kill-switch OFF = 显式放弃 ongoing guarantee(Codex R2#4)。
- 所有 mutation 的残余 authority/default 竞态 = fresh parent(archive 时再含 fresh thread)reads → PATCH 的单请求间隔(Discord 无 conditional PATCH);轮级快照竞态已由 mutation-time fresh recheck 消除(R2#1 + R3#1)。
