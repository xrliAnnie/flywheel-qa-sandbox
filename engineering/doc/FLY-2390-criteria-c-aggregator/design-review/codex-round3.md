# Design Review — plan.md (Round 3)

Date: 2026-09-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 对 Round 2 的六条 blocking 都有实质回应：不同 commit 下的重复事件不再受 delivery claim 限制，heartbeat 改为逐 tick 追加，NULL 证据有独立查询合同，日报发送前已有 intent，UUID Bug label 进入 intent-first 路径，resolve 也加入了 master-only + CAS + receipt。这些方向都应保留。

但按提交 `21a68637c` 的 plan blob `5142b558…` 对照当前代码和计划 SQL 后，仍有七处合同会吞掉当前 episode 的负面证据、把已经知道的采集故障藏在 StateStore 之外，或让时间窗/权威收口账本无法按本文语义实现；其中多处存在直接或允许实现出 `green` 的路径。Round 3 仍不能批准。

## What's Good (Keep)

- Bridge 观测放到 `LeadAlertNotifier.alert()` 入口，确实覆盖了 delivery disabled、invalid style、unknown lead、claimsReader duplicate 和 `won===null` 等现有返回路径；`createClaimsClaimer` 保持零改动也降低了共享投递链的 blast radius。
- shell 伴表按复合 seek 游标投影，`projectSignalBatch` 将投影与游标推进放进同一事务；heartbeat 每 tick 追加、backlog 取最老未消费行，并把 `rejected_rows` / `bridge_capture_failures` 纳入 U5，均正确回应了前两轮的假绿风险。
- attributed / unattributed 两条查询合同、最近连续 production episode、窗口首尾 heartbeat gap、`localDeployedSha` 精确绑定以及 `unknown > hold > green` 的纯函数优先级应保留。
- bug 的 intent → Linear → finalize、publication 的 send-before durable intent 修正、reaction 分页与 freshness/error 门，以及 resolve 的 master-only/CAS/同事务 receipt，都是正确的 fail-closed 骨架。
- B3 仍只产 readiness 证据、查询面和日报，不实现 B4/B5/B6；复用 StateStore、GatePoller rider、digest/publish-report 样板与 B0 版本语法，边界清楚。

## Issues & Recommendations

1. **[BLOCKING] `(event_id, source_commit_key)` 仍会吞掉同一 SHA 的新 deployment episode，NULL 归因也会跨 episode 永久碰撞。** 计划以该二元组作为 shell 伴表和 StateStore 的主键，并对冲突 `INSERT OR IGNORE`（`plan.md:64,188,198-199,220,227`），但 evaluator 明确只看该 SHA 的“最近一次连续 episode”（`:107`）。我按计划 SQL 在 sqlite `:memory:` 中写入 `E/A@t100 warning`，再写 `E/A@t300 severe`，最终只剩第一行；若 A 在两次之间经历 B 回滚后再部署，t300 的 severe 不在最新 A episode 中，最终可被算成零。`source_commit_key='null'` 对所有未知版本共用同一碰撞域，问题更明显。把“投递去重身份”和“episode 内观测身份”拆开：保留 `event_id` 做计数去重，但原始观测需有 occurrence/generation（或可重放的 observation id），投影后按 deployment episode + event 去重并悲观合并 severity。补 A→B→A 后同 event、NULL→NULL 跨 episode、同 episode 重放三组测试。

2. **[BLOCKING] 捕获合同仍有位于观测前的 shell 退出，以及两个无法跨 crash 保留的“最后兜底”。** v3 只在 claim 事务处新增 shell 观测（`plan.md:193-208`），而真实脚本在 event id/事务之前仍会因 system route 配置失败、缺工具、`projects.json` 缺失/损坏或 unknown lead 退出（`lead-alert.sh:274-333,372-419`; event id 才在 `:464-480`，事务在 `:506-540`）。合法 severe 调用在这些分支只走现有 config-error/meta-alert 路径（前两类甚至尚未定义 `fire_meta_alert`），不会进入 B3。即使到达事务，gap 文件写失败也只记 stderr（`plan.md:208`）；Bridge 的 observation 与 gap 都失败时只增内存计数，并在 tick 时“读取并清零”（`:213-218,259,283`），进程在 tick 前崩溃，或 `appendHeartbeat` 在 drain 后失败，故障便永久消失。应在参数/kind/severity 验证后、任何 delivery/config preflight 前先落 durable capture intent；所有失败分支转成 rider 可见的 gap/source-health 证据。Bridge 使用独立 durable outbox 或 sticky peek→成功 append 后 ack，不能先 drain；无法写 outbox 本身也必须保持 source unhealthy，而不是只写 stderr。补 missing/corrupt projects、unknown lead、sqlite+gap 双失败后恢复、Bridge 双写失败后 restart、drain 后 heartbeat 写失败测试。

3. **[BLOCKING] durable outbox 中“系统已经知道”的 gap/publication 对 evaluator 不可见，rider 失败也没有进入 heartbeat。** `ReleaseReadinessService.collect()` 只从 store 收集（`plan.md:258`）；gap 文件插入失败会“保留重试”但不改变 `ingest_ok`（`:281-283`），publication 又在 heartbeat 之后才吸收（`:283-284`）。因此 gap/publication 文件已存在、StateStore 写失败或 rider 尚未运行时，GET 可看到旧的健康 heartbeat、零 gap、零 publication 并给出 green。损坏 outbox 文件也可无限留在目录而没有 reason。正常快路径还会在首个 60 秒 rider 前把文件从 `intent` 改写成 `published`，但 publications 状态机只写了 `intent→published|failed`，未说明首次摄取 final envelope 是否允许。让权威读在评估前同步检查 pending outbox（数量、最老时间、解析错误），或把所有 outbox 阶段的结果先纳入本 tick 的 health 再 append heartbeat；任何已知 pending/invalid/ingest failure 都必须阻断 green。明确支持“首次看到 published/failed”与“先看到 intent、后看到 final”两种合法 interleaving。补 valid-but-unlanded gap、损坏 gap/publication、StateStore upsert 失败、direct-first published 四组测试。

4. **[BLOCKING] Bug label 的 SSOT 解析失败仍是 fail-open，且计划声称的 `bugLabelResolved=false` 没有任何持久化位置。** v3 在配置的 Bug label 无法 team-scoped resolve 时，除非调用方显式 `body.bug===true`，否则只 warn 并按非 bug 调 Linear（`plan.md:292`）。当前路由允许 UUID label 直接透传（`plugin.ts:3928-3979`）；所以配置缺失/歧义期间，一个实际 Bug label UUID 仍会成功创建 issue，却没有 intent/ledger，客观 bug 信号随后可为零。九张表、heartbeat 和 reason code 都没有 `bugLabelResolved` 字段（`plan.md:115-136,223-235`），日报也无数据可展示；现有请求校验还未包含 `bug`（`plugin.ts:3753-3785`）。配置解析是 bug 数据源健康的一部分：解析失败应拒绝无法分类的 label-bearing create，或持久化 `bug_source_unhealthy` 并使 verdict unknown，直至成功解析；同时严格校验 `bug` 为 boolean。补配置 label missing/ambiguous + UUID Bug、解析失败后恢复但窗口仍不可 green、非 boolean `bug` 测试。

5. **[BLOCKING] founder 扫描集合、U7 集合和 H1 输入没有同一个时间语义；按现文实现，长 episode 要么永久 unknown，要么可能漏掉较早的 👎。** rider 只扫描最近 2 天的 publication（`plan.md:285`），U7 却要求 deployment episode 内“每个 publication”的成功扫描都在 `freshMin` 内且旧 `intent/failed` 永久阻断（`:107,288`）。第三天开始，第一天的 published 行必然 stale 且不再被扫描；“下一日 publication”也无法清掉旧失败。与此同时表是一日一条 verdict，而状态机只接收单数 `founderVerdict`（`:69,81,99,234`），没有定义多日时取 latest、ANY down 还是当天；取 latest 会让较早真实 👎 被后来的 up/空白掩掉并放出 green。定义一个与 PRD“当天可选反馈”一致的 reaction eligibility/finalization 窗口，并让扫描集合与 U7 完全相同；明确 👎 的保留/清除规则。若当前 episode 内任一 👎 都有效，输入应为集合且 `ANY down ⇒ hold`，up 不能隐式清掉另一日的 down。补 3+ 天同一 deployment、day1 down + day2 up/无反应、旧 intent/failed 的恢复路径测试。

6. **[BLOCKING] “完整连续 episode”与统一 14 天删除互相矛盾，时间编码也未定义到现有 retention API 可执行的程度。** evaluator 从 episode 首行算到 now（`plan.md:107`），但 events/heartbeat/gaps 被 14 天删除（`:239-243`），其部署锚点 `deployment_events` 本身当前也在 14 天 `RETENTION_TARGET_POLICIES` 中（实际 `scripts/lib/fly-2006-retention-engine.mjs:179-185`）。超过 14 天的当前部署会失去首行并永久 unknown；若实现用仍存的同-SHA 后续行重新锚定，则 episode 早期的 negative 会被遗忘而可能 green。另，shell 明定 `observed_at` 为 unix 秒整数（`plan.md:187`），StateStore 新表没有声明类型/转换，而现有 static policy 用 `julianday(t.<time>)<julianday(?)`；实测 `julianday(1725926400)` 为 NULL，直接照写不会清理。先决定权威 horizon：要么保护当前 episode 的部署锚点及全部负面证据，要么把 verdict 明确定义成有界窗口并说明负面证据何时过期；不得靠 retention 静默改语义。StateStore 时间统一为 ISO UTC TEXT（shell ingest 时转换）或所有 SQL 明确用 unixepoch modifier，并为 composite-PK 表指定现有引擎支持的 `__rowid`/surrogate key。改动清单中的实际路径也应是 `scripts/lib/fly-2006-retention-{registry,engine}.mjs`，不是 `scripts/` 根目录。补 >14 天 active episode、retention 后仍保留/阻断的 severe、真实 timestamp inventory/apply/receipt 测试。

7. **[BLOCKING] resolve receipt 的 `resolved_by` 来自可伪造请求头，不满足 Round 2 要求的不可抵赖收口。** 路由虽是 master-only，但计划直接信任 `x-flywheel-actor`（`plan.md:159,168-170`）；当前 `masterOnlyAuthMiddleware` 只验证 bearer，不建立调用者身份（`dependency-route.ts:174-192`），同一个 master token 调用者可把 receipt 写成任意 64 字符。仓内同类权威写反而在服务端记固定 `master-api-token`（`plugin.ts:2086-2093`）。从已认证 principal 服务端派生 `resolved_by`（v1 可固定为 `master-api-token`）；若确实需要人名，须引入可验证的 actor credential，而不是信任 header。补带伪造 header 仍只能落 canonical server actor 的测试。另请修正文档事实：`POST /api/linear/create-issue` 并非整体 master-only，现有 master-only 只保护带 `parentId` 的请求（`plugin.ts:3735-3747`）；resolve 应直接复用 `masterOnlyAuthMiddleware` 本身。

## Verdict

CHANGES REQUESTED — address the seven blocking items above before implementation.
