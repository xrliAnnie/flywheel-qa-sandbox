# Design Review — plan.md (Round 1)

Date: 2026-09-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案的 B3 边界、三态纯函数、版本伴表以及 GatePoller/日报复用方向与现有架构相容，具备实施基础。当前仍有五类证据可被永久漏掉或错误归属、随后产出 `green` 的路径，另有 retention 与装配事实未纳入改动清单；这些都需要在开工前写成明确合同和负向测试。

## What's Good (Keep)

- B3 只生产 readiness 证据与查询面，不越界实现 B4/B5/B6 的否决窗口、发布或分频；B0 只复用 `normalizeVersionFile` / `toDisplayLabel`，边界清楚。
- `unknown > hold > green` 的优先级、稳定 reason code、policy 快照和“收集全部原因”便于审计与回放，符合 PRD §4.1 的 fail-closed 语义。
- 复用共享 `claims.db`、GatePoller rider、StateStore、digest 脚本、token middleware 与 `escapeHtml`，没有引入另一套 scheduler 或状态机。
- 测试分层完整，特别是 NULL 归因、commit 逐字比较、非 founder reaction、HTML escaping、输入边界和 FLY-1560 命名守卫应保留。

## Issues & Recommendations

1. **[BLOCKING] 增量游标会永久跳过事件，且 ingestion 完整性没有成为 `green` 的前置条件。** 计划用秒级 `claimed_at` 单列游标和 `WHERE claimed_at > ? ORDER BY claimed_at LIMIT 500`（`plan.md:169,215`）；同一秒超过 500 行时，第一页之后的行永远不可见。非法行又被“跳过后推进游标”，而 `cursor_lag_s` 只出现在 detail 中、没有阈值或 reason；状态机还只检查“最新 heartbeat”的 `claims_db_ok`（`:75-80,102`），所以一次 sqlite 失败、积压或被拒的 severe 可在下一次健康 tick 后消失，最终误绿。改为复合游标 `(claimed_at,event_id)`、同序索引与 seek 条件；投影和游标推进必须具备原子/可重放语义。把 backlog 超阈、窗口内任一采集失败、rejected 行持久化为 `source_unhealthy`（severe 的坏归因至少保留为 unattributed），补 `501` 条同秒、非法 severe、失败后恢复但未追平、投影后推进前崩溃的负向测试。

2. **[BLOCKING] 伴表写入尚未定义“只有赢得 claim 才盖章”，Bridge 也存在 claim 前返回和 claim 失败后继续发送的漏采路径。** 当前 claimer 依赖紧跟 `alert_claims` INSERT 的 `SELECT changes()` 判断赢家（`lead-alert-helpers.ts:131-155`）；若在它前面加入伴表 INSERT，返回值会变成第二次 INSERT 的结果。若无条件给既存 claim 补 stamp，则部署前的历史 claim 会被重复调用以当前版本回填，直接违反“不回填历史”。此外 `LeadAlertNotifier.alert()` 会在 delivery disabled、invalid style、unknown lead 时于 claimer 前返回（`LeadAlertNotifier.ts:932-969`），而 claimer 返回 `null` 时仍继续发送（`:990-1012`），这些 raw event 都可能没有 stamp。计划需给出精确 SQL 顺序/获胜位：保留原 claim INSERT 的 changes 结果，仅当该 INSERT 本次为 1 时写 stamp；既存 claim 且无 stamp 必须保持无 stamp。对 claim 前 dead-letter/suppression 与 `won=null`，要么在不改变投递语义的独立捕获点落事件，要么持久化采集缺口并使相关窗口 `unknown`。补“既存 claim 无 stamp”“第二条 INSERT 不改变 winner”“claim infra 失败仍不可 green”测试。

3. **[BLOCKING] bug 信号在 Linear 成功与本地账本写入之间存在不可恢复的 crash gap。** 现有创建咽喉先完成 `client.createIssue` 再响应（`plugin.ts:3996-4014`）；计划再于成功后写 StateStore，写失败仍返回 200（`plan.md:222-225`）。进程在两步之间崩溃或本地写失败时，真实 bug 会永久不计数，客观信号仍可能为零并误绿；console warning / desktop meta-alert 不能修复 readiness 证据，而且计划使用的 `release_bug_ledger_write_failed` 也不在封闭的 `MetaAlertReason` union（`MetaAlertNotifier.ts:36-57`）。在调用 Linear 前先持久化版本化 intent；成功后以 identifier finalize，未 finalize 的 intent 必须持久存在并让 verdict `unknown`，再由幂等 reconciliation 清除。增加两个 crash/restart 测试（Linear 前、Linear 成功后 finalize 前），并把所需 outbox/状态表、reason code、MetaAlertNotifier 类型改动写进清单。

4. **[BLOCKING] subject 与证据窗口没有被完整绑定，不能证明查询的 `{baseVersion,sourceCommit}` 就是本机当前运行对象。** subject 被定义为二元组（`plan.md:53`），但 verdict API 只接收 `commit`，会把任意 commit 与 Bridge boot 时的当前 base 拼接（`:133`）；状态机也没有显式断言 `localDeployedSha === subject.sourceCommit`。同时事件过滤写清了 commit，但 heartbeat、bugs、founder binding 的同 subject 过滤没有成为合同；deployment research 已注明同 SHA 回滚再前进时必须取“最近一次连续 production 窗口”（`research.md:41-49`），而计划仍写 `[firstDeployedAt,nextBatchAt]`（`plan.md:91`）。要求 API 接受并校验 `baseVersion`，或从不可歧义的持久部署身份解析，缺失/冲突即 `unknown`；显式加入 local SHA 不等即 `no_deployment_evidence`。所有 heartbeat/bug/founder 证据按 subject 精确过滤，deployment 只算 `project=flywheel, environment=production` 的最近连续 episode，heartbeat gap 包含窗口首尾且 `coveredHours` 取真实 subject 覆盖。补旧 commit + 新 base、不同 commit heartbeat、回滚再部署、窗口首/尾缺口测试。

5. **[BLOCKING] 已发表的 founder 👎 仍可能被静默当成“未标”。** `publish-report` 成功后 binding 失败仅 log，计划声称“下一天再绑”但没有保存信封或任何重试来源（`plan.md:229-234`）；消息上的反应因此永远不会被扫描。rider 又限制每 emoji 每消息只 GET 一页（`:217`），而现有 `reactionFetcherImpl` 明确使用 `limit=100` + `after` 支持分页（`gate-poller.ts:3009-3026`），founder 位于后续页时会漏掉。可选反馈允许“确实没有 reaction”，不允许“无法观测”伪装成没有；否则真实 👎 后仍可 green。把成功 publish 的 `{day,channelId,messageId,subject}` 先落本地 durable binding outbox，再重试 bind、绝不重发消息；reaction 必须分页至 founder/末页，任何尚未成功完成首次扫描的 binding 要么使 verdict `unknown`，要么提供等价的可证明 fail-closed 状态。补 bind 失败重启恢复、101+ reactions、分页中途非 200 时不可 green 的测试。

6. **[BLOCKING] 30/90 天 retention 不能只改 consumer-gate config，当前改动清单会直接撞 schema census，且现有 engine 只有统一 14 天 cutoff。** `fly-2006-retention-consumer-gate.config.json` 只审计生产消费者；StateStore 的每张新表还必须进入 `TEAMLEAD_TABLE_CLASSIFICATION`，否则 `assertClassifiedSchema` 报 `schema_unclassified`（`fly-2006-retention-registry.mjs:7-14,120-145`）。实际删除策略在 `RETENTION_TARGET_POLICIES`，`staticPolicy` 只接收 `cutoff14`，inventory 也只生成 `now - RETENTION_MS(14d)`（`fly-2006-retention-engine.mjs:132-145,1043-1069`），所以计划声称的 30/90 天不会发生。C2 清单应加入 registry 分类、engine 的明确 per-policy horizon、inventory/apply/receipt 验证及对应测试；三张不删的小表和 cursor 也要归入 protected 分类。consumer-gate disposition 按真实读取语义逐项登记，不能把它当 retention policy 本身。

7. **[NON-BLOCKING] 修正几处已验证的装配假设，避免实现阶段才遇到编译/配置漂移。** `sqliteRunWithStdin` 与 `sqlString` 当前是私有 helper（`lead-alert-helpers.ts:169-223`），需明确导出还是在 rider 注入独立 adapter；`LivenessCheckTracker.snapshot` 必须传 `{wired,effectiveEnabled}`，不能按计划无参调用（`liveness-manifest.ts:219-247`）。另外 `FLYWHEEL_READINESS_REPORT_HOUR` 未列入 §2.3 / `NON_FLAG_ALLOWLIST`，而 repo-owned plist 的 `StartCalendarInterval` 是静态字节，不会读取 shell env；v1 最简单是固定 plist 为 08:00 并删除该 knob，若坚持可配则需写明谁生成/收敛 plist、值域和测试。同步补 `MetaAlertNotifier.ts`、retention engine/registry 等真实文件到 §4 清单。

## Verdict

CHANGES REQUESTED — address items above
