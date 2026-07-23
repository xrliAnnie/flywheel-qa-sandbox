# FLY-802 Roundtable thread 1h 自动归档(重开根修)— 调研

Issue: FLY-802 (https://linear.app/geoforge3d/issue/FLY-802/roundtable-topic-thread-1h-无活动自动归档-描述性命名-别一排排堆在侧栏)
日期: 2026-07-22
基于: exploration.md

## 1. Discord API 事实(设计的硬约束)

| # | 事实 | 来源/验证 |
|---|---|---|
| F1 | 频道 `default_auto_archive_duration` 是**客户端 UI 默认**,API/gateway 创建 thread 时 Discord **不会应用它**;不带显式字段 → API 默认 4320 | Discord docs 原文 "the default duration that the clients use (not the API)";Cass 07-17 live 诊断 + 本轮探测复证(频道 default=60,plugin 建的 thread 全 4320) |
| F2 | `auto_archive_duration` 合法枚举:60 / 1440 / 4320 / 10080(分钟) | Discord docs;`roundtable-text.ts:25` 注释同源 |
| F3 | PATCH thread 的 name/auto_archive_duration:非 owner 需要 **MANAGE_THREADS**;Lead bot 都没有该权限 → 403 | Cass 07-11/07-17 实测(cross-lead PATCH 403);claw-infra-bot 有 MANAGE_THREADS(07-17 已验证 + 手动清理 48 patch + 47 archive 0 失败) |
| F4 | 归档不删消息:archived thread 消息保留、search 可找回、有新消息自动 unarchive(duration 不变,之后再次按 60 收起) | Discord 语义,issue 验收口径 |
| F5 | thread-from-message 不变量:thread id == 源消息 id | 现有代码依赖(recovery anchor),多处注释 |
| F6 | GET /guilds/{gid}/threads/active 一次拿全 guild active thread(含 thread_metadata + parent_id + owner_id);archived 不在内 | 本轮 live 探测实际使用 |
| F7 | 把已 idle 超过新 duration 的 thread PATCH 到更短 duration,Discord 的自动归档时点并不保证立即触发 | Cass 手动清理时对 idle 的 47 条是**显式 PATCH archived:true**,不是等 Discord;reconciler 照做(确定性) |

## 2. 三个 creator 的代码现状审计

| Creator | 位置 | create 的 duration | 命名 | 收敛能力 |
|---|---|---|---|---|
| 1. Bridge poller | `packages/teamlead/src/bridge/roundtable/RoundtableThreadManager.ts:563` | 显式 60(常量) | 描述性 ✓ | exists-recovery 有 PATCH 但 **Cass bot 403 → fail-soft 提交 row → 一次失败永不重试**(`commitThread`:patchThread 返回 permanent 也照样 upsert) |
| 2. Codex-lead reply 共享 helper | `packages/teamlead/src/bridge/roundtable/ensure-thread-from-message.ts:78` | 显式 60(常量) | 描述性 ✓(共享 helper) | exists 分支只 confirm,不 PATCH(设计如此,poller 兜) |
| 3. plugin fork(Lead 回帖实时抢建,**生产主要 creator**) | fork repo server.ts(`ensureRoundtableThread`,本机 cache 0.0.4 副本 :199) | **硬编码 4320** ← ongoing 根因 | 描述性 ✓(desiredName 经 deriveRoundtableThreadName 镜像) | 无 |

共享常量 `ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES = 60` 在 `roundtable-text.ts:34` —— 本身违反 Annie 的"零硬编码"要求(代码知道 60),本轮一并消除。

poller 身份与配置(`roundtable-config.ts` + 生产 env):bot = Cass(FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV=CASS_BOT_TOKEN,user 1516205086890786917),channel 1512578695468941333,guild env FLYWHEEL_ROUNDTABLE_GUILD_ID=1485787271192907816(已存在),trigger any_top_level,poll 3s。

## 3. FLY-1165 可复用面(Tadashi 07-11:"802 复用这套、别造两个")

`done-thread-reconcile.ts` 本体是 **issue chat thread + Linear 权威**驱动的(StateStore 候选集、Linear 双门、husk finalize)——与 roundtable 场景(权威 = Discord 频道设置,候选集 = Discord active threads,无 Linear/session 语义)不同构,**本体不复用**。真正可复用的:

1. **`startDoneThreadReconcileScheduler`(直接 import 复用)**:它对 `runOnce` / `resolveConfig` 完全泛型(boot 延迟 + 周期 tick + env 每 tick 重读 + single-flight + 可 drain stop)。新 reconciler 只需提供自己的 runOnce + config resolver,零复制。
2. **纪律模式(照抄形状)**:env kill-switch + dry-run + maxPerRun cap + run deadline + per-op spacing(500ms)+ 计数器汇总日志 + never-throw。
3. **claw 单 bot 收敛**:绕开 creator-403 约束的做法与 FLY-1165 的 token-bearing sink 同思路(单一有权 bot 做写),但 sink 本身(`archiveThreadAndRecord`,绑 chat_threads 表 + audit)不适用 —— roundtable thread 不在 chat_threads 表,且 plugin 抢建的 thread 在 Bridge 宕机窗口可能连 roundtable_topic_threads row 都没有。**候选集以 Discord 为准(F6),不以 DB 为准** —— 这是覆盖三个 creator + 任何历史残留的唯一闭合方式。

## 4. claw-infra-bot(reconciler 执行身份)

- Token env:`CLAUDE_INFRA_BOT_TOKEN`(已在 ~/.flywheel/.env,Bridge 侧 infra-notify.ts 已有使用先例)。
- MANAGE_THREADS:07-17 已验证(48 patch + 47 archive,0 失败);本轮只读探测(channels/threads/active)亦通过。
- Bridge 内新 reconciler 用它,不用任何 Lead bot。token 缺失 → 功能整体 OFF(fail-safe,不降级到 Lead bot)。

## 5. 关键设计问题:reconciler 对 default=null 频道怎么办

Annie 07-17 follow-up 字面:reconciler 用 resolve(parent.default ?? 4320) 对比每条 thread。字面执行 = null 频道的 thread 也被收敛到 4320。

**冲突证据**:`AlertChannelHub.ts:87` 显式建 1440(1 天)的 alert thread,其父频道 default=null(本轮探测:全 guild 39 频道仅 roundtable 非 null)。字面执行会把 alert thread 1440→4320,静默回退 FLY-927 时代的既有行为 —— Annie 的 comment 列举后果时只提到 roundtable(60)与"其他频道(null)→3 天",没有覆盖"频道 null 但 thread 被代码故意设了非 4320"这一格。

**取舍**:

| 方案 | 行为 | 评价 |
|---|---|---|
| A. 字面执行(null→收敛到 4320) | alert thread 被翻成 3 天 | 引入回归;founder comment 未明示此后果 |
| B. **null = opt-out(选定)** | 只收敛 default 非 null 的频道;null 频道 reconciler 完全不碰 | 今天恰好只覆盖 roundtable;alert/issue thread 零影响;founder 想纳管任何频道 = 在 Discord 设该频道 default(含设成 1440 保住 alert 语义)——"founder 通过 Discord 设置掌控"的意图完整保留 |
| C. 字面执行 + 代码里豁免 alert 频道 | — | 违反"零硬编码频道"红线,直接排除 |

选 **B**。注意 B 只影响 **reconciler** 的扫描范围;**create 路径**仍完整执行 null 规则(非 null→原样,null→显式 4320)——在 null 频道显式带 4320 与 Discord API 默认一致,零行为差,而规则完整。此偏差在 plan.md 显式标注,交 design review 把关。

**Scope 追加后的补充(2026-07-22,Lead 指令 8d610404)**:unified alert 频道(1518793447165661254)进入 802 scope。方案 B 对它的语义正好是想要的两段:
- **opt-in 前**(现状,default=null):reconciler 不碰,1440 现值保留 —— 上面的"alert 回归哨兵"测试继续成立;
- **opt-in 后**(rollout 时在 Discord 给该频道设 default,推荐 60):reconciler 立即纳管 —— 收敛存量堆积 + 归档 idle,这正是 Annie 要的"堆了的自动收起"。
- create 半:`AlertChannelHub.ts` `createDiscordOps().createThreadFromMessage`(:87)的硬编码 1440 → 同一 resolver,**per-call-site fallback=1440**(频道未设置时字节兼容今天的行为;设置后出生即正确)。Hub 是长生命周期对象、自己持有 channel id + token 链 → provider 在 Hub 层构造一次。
- **建议值 60 的理由**:per-error thread 的讨论窗口短;同一错误再爆时 bot 往既有 thread 发帖会自动解 archive(Discord 语义 F4),不丢上下文;60 与 roundtable 一致好记。最终值 = founder 在 Discord 里设什么就是什么,随时可调零代码。
- **减量边界**:告警风暴的量治理归 FLY-1386;802 只收起,不动告警产生逻辑。

## 6. 其余设计输入

- **guild id 来源**:`FLYWHEEL_ROUNDTABLE_GUILD_ID` 已在生产 env。reconciler 读 `FLYWHEEL_DISCORD_GUILD_ID ?? FLYWHEEL_ROUNDTABLE_GUILD_ID`(前者留将来去 roundtable 化的名字,后者保证今天零新增配置)。
- **父频道类型**:只扫 guild text/announcement 频道(type 0/5)。forum(15)有自己的 thread 语义,不碰。
- **idle 判定**:idle = now − snowflakeTime(last_message_id ?? thread.id) ≥ resolve(default)。snowflake→时间戳是纯位运算((id >> 22) + 1420070400000)。
- **rename 限速**:不适用 —— reconciler 不做 rename(命名半已验证闭环,live 0 占位名;scope 最小化)。
- **重启/幂等**:reconciler 无持久状态,每轮从 Discord 现状全量对比,PATCH 幂等(相同值不发,发了也收敛),天然 restart-safe。
- **plugin 分发**:fork 修复合入 xrliAnnie/claude-plugins-official 后经 ~/.flywheel/bin/update-discord-plugin.sh 覆盖 marketplaces + cache 两处;运行中的 Lead 会话要重启才吃到(plugin MCP 进程随会话生命周期)。在此之前 reconciler 已把增量收敛住 —— 两半互为兜底,部署顺序无硬依赖。
