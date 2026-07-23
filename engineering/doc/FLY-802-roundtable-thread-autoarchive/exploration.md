# FLY-802 Roundtable thread 1h 自动归档(重开根修)— 探索

Issue: FLY-802 (https://linear.app/geoforge3d/issue/FLY-802/roundtable-topic-thread-1h-无活动自动归档-描述性命名-别一排排堆在侧栏)
日期: 2026-07-22
基于: 无(重开后首篇;历史 plan.md 对应已合入的 PR #423)

## 1. 问题与历史

Annie 的诉求(2026-07-03):`#leads-roundtable` 的 per-topic thread 讨论完 / 1h 无活动就自动从侧栏收起(archived,非删除),并且用描述性命名。

**第一轮修复(PR #423,2026-07-03)已合入但 false-Done**:

- PR #423 把 Bridge 侧两条创建路径(poller `RoundtableThreadManager` + 共享 `ensureThreadFromMessage`)的创建 body 设为显式 60,并给 poller 的 exists-recovery 路径加了 name+archive 合一 PATCH 收敛。
- 2026-07-11 重开:roundtable 堆了 86 条 thread、一条没归档,大量 `auto_archive_duration` 仍是 4320(3 天)。
- 2026-07-17 Cass 现场查证根因(Linear comment 有完整记录)+ Annie 拍板修复 spec。

## 2. 已验证的根因(三层)

**根因 A — Discord 语义**:频道的 `default_auto_archive_duration` **只是客户端 UI 默认值,对 API/gateway 创建的 thread 不生效**。founder 已把 #leads-roundtable 的频道默认设成 60(本轮 live 探测再次确认),但 bot 建 thread 不带显式字段时 Discord 给 API 默认 4320。

**根因 B — creator 3(plugin fork)硬编码 4320**:本轮探索的新实锤 ——
fork plugin(`~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts:199`)的 `ensureRoundtableThread` 创建 body 是:

```ts
body: JSON.stringify({
  name: opts.desiredName || 'Roundtable topic',
  auto_archive_duration: 4320,   // ← 硬编码 3 天
}),
```

Lead 回帖走 reply-in-thread 时,plugin 秒级抢在 Bridge poller(3s 轮询)前建 thread → 该 thread 4320。这不是"不带字段被 Discord 默认",而是 fork 自己显式写死了 4320。

**根因 C — poller 的 converge 半修死于权限**:PR #423 的 exists-recovery PATCH 需要 MANAGE_THREADS(或 thread owner)。生产 poller bot = Cass(`FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV=CASS_BOT_TOKEN`,Lead bot,无 MANAGE_THREADS)→ PATCH 403 → 代码按"permanent"fail-soft 吞掉并提交 row → **该 thread 永不再被收敛**。一次 403 = 永久卡 4320。

## 3. Live 取证(2026-07-22,本节点用 claw bot 只读探测)

距 Cass 2026-07-17 手动清理仅 5 天:

| 指标 | 值 | 含义 |
|---|---|---|
| roundtable active thread 总数 | 13 | |
| 其中 4320(3 天) | **5** | **复堆确认,最新一条今天 09:45 建** |
| 其中 60(1h) | 8 | Cass poller 自建的(显式 60 生效) |
| 占位名「Roundtable topic」 | **0** | **命名半已修好**(fork 用 `deriveRoundtableThreadName`) |
| 4320 条目的 owner | 全是非 Cass 的 Lead bot | 全部来自 plugin reply-in-thread 抢建 |
| 全 guild 39 频道中 default 非 null 的 | **只有 #leads-roundtable(=60)** | 其余 28+ 频道 default=null |

结论:**命名问题已闭环**(老占位残留已被 07-17 清理归档);**duration 问题仍在持续产生**,来源就是 fork plugin 的硬编码 4320 + poller converge 403 双杀。

## 4. Founder 需求(Annie 2026-07-17,Linear comment 原文要点)

1. 大多数频道**保持 3 天** thread —— 不改任何全局默认。
2. roundtable 是特例(1h)。
3. **代码里不许硬编码频道名/id**。
4. 方案 = channel-default-driven:创建时读父频道自己的 `default_auto_archive_duration` 显式带上;另加周期 reconciler 收敛存量(claw-infra-bot,有 MANAGE_THREADS,已验证);founder 通过 Discord 频道设置完全掌控"哪个频道特殊"。
5. null 规则(07-17 follow-up comment):父频道 default **非 null → 原样用**;**null → 显式 4320**(= founder 的"多数频道保持 3 天")。

## 5. 方向(三件套,create 半 + converge 半)

1. **create 半 · fork plugin(跨仓)**:`ensureRoundtableThread` 的硬编码 4320 → 读父频道 default(带 TTL 缓存),null→4320。这是掐掉 ongoing 来源的根修。
2. **create 半 · 本仓**:`ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES = 60` 常量(本身就是 Annie 禁止的"代码知道 60")→ 换成共享 resolver(读频道 default,null→4320)。poller create、`ensureThreadFromMessage` create、poller converge 目标值三处同源。
3. **converge 半 · 新 reconciler(Bridge 内,claw bot)**:周期扫描 + 收敛 duration ≠ resolve(父频道 default) 的 active thread、显式归档 idle 超时的 thread。claw-infra-bot(`CLAUDE_INFRA_BOT_TOKEN`,MANAGE_THREADS 已在 roundtable 验证)。scheduler 复用 FLY-1165 的 `startDoneThreadReconcileScheduler`(它对 runOnce/resolveConfig 泛型,可直接复用 —— 呼应 Tadashi 07-11"802 复用这套、别造两个")。

**关键 scope 决策(与 Annie spec 字面的唯一偏差,见 research.md §5)**:reconciler 只收敛 **default 非 null 的频道**(= founder 在 Discord 里显式设置过的频道)。若按字面对 null 频道也收敛到 4320,会把 AlertChannelHub 故意设的 1440(1 天)alert thread 翻成 4320 —— 静默回退既有行为。null-opt-out 规则下,今天 reconciler 恰好只覆盖 roundtable(全 guild 唯一非 null),且 founder 想让任何频道被管,只需在 Discord 设一下频道默认 —— 完全符合"founder 通过 Discord 设置掌控"的意图。

## 6. 范围红线

- **不碰** `ChatThreadCreator.ts`(issue chat thread,3 天 + 完成归档,FLY-292)。
- **不碰** `AlertChannelHub.ts`(alert thread,1440)。
- **不碰** `done-thread-reconcile.ts` 的既有行为(只复用其导出的 scheduler)。
- 命名半:已验证修好,**不再加代码**(reconciler 不做 rename)。

## 7. Scope 追加(Lead 指令 8d610404,founder 现场加,2026-07-22)

Annie 派 802 时指出 **unified alert 频道(1518793447165661254)也堆了一大堆 thread**,要 802 一并治。Lead 核实:alert thread 走 `AlertChannelHub.ts` `createDiscordOps().createThreadFromMessage` 的硬编码 `auto_archive_duration: 1440`(24h)—— 与 roundtable 同族(Discord auto-archive 旋钮)不同值。

- **802 的边界(Lead 明确)**:alert 频道堆积主要由当晚假告警风暴(watchdog 误报)催生;**真正减量归 FLY-1386(generic watchdog)**,802 只做「堆了的自动收起」这一层,不越界修告警量。
- **对本设计的影响**:channel-default-driven 架构天然覆盖 —— alert 频道在 Discord 设个 default(推荐 60,理由见 plan)即被 reconciler 纳管收敛存量;create 半把 1440 硬编码换成同一 resolver(fallback=1440 保住未 opt-in 时的字节兼容)。原 research.md §5 的"保护 alert 1440"论证升级为:**未 opt-in 时保护现状,opt-in 后按 founder 设置收敛** —— 正是合同本来的语义,零新机制。

## 8. 侧发现(已单独报 Lead,不入本 issue scope)

`~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/server.ts`(MCP 实际运行副本)在 2026-07-22 10:00 被 vanilla 上游 0.0.4 覆盖(33KB,`allowBots`/roundtable/reply-guard 全缺;fork 完整版仍在 `cache/.../0.0.4/`,65KB)。新启动的 Lead 会话将丢失 fork 行为。属部署/infra 修复项,与本设计并行处理;本设计的 plugin 修复落在 fork repo,随 `update-discord-plugin.sh` 两处分发一并生效。
