# Design Review — plan.md (Round 2)

Date: 2026-09-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 对 R1 七项均有实质回应：复合游标、原子投影、intent-first、subject/current-deployment 绑定、reaction 分页和 14 天 retention 减法都应保留。重新按提交 `660dee2a7` 的 plan blob `7a0a55e…` 对照当前代码后，仍发现六条可漏掉负面证据或错误解除 `unknown` 的路径，因此尚不能批准。

## What's Good (Keep)

- `(claimed_at,event_id)` seek、同序索引、`projectSignalBatch` 内投影与游标同事务，以及最多 10 页/tick，正确关闭了 R1 的同秒分页和 crash/replay 问题。
- evaluator 现在显式要求 current deployed SHA、最近一次连续 production episode、真实 heartbeat 分钟覆盖，并把窗口首尾 gap 纳入计算；subject API 同时绑定 `commit + baseVersion`。
- bug 路径在调用 Linear 前落 pending intent，Linear/finalize 任一失败都不会再被当成“零 bug”；不扩大 `MetaAlertReason` 是更简单的收口。
- binding outbox、reaction `after` 分页、canonical founder 身份和未完成首次扫描时 `unknown` 的方向正确。
- retention 改为三张证据表复用现有 14 天 policy、其余表 protected，并补 registry/engine/gate 与 inventory/apply/receipt 测试，符合当前 FLY-2006 架构。
- 删除动态 report hour、补全真实改动文件、保持 B3 不触碰 B4/B5/B6，scope 控制得当。

## Issues & Recommendations

1. **[BLOCKING] claim 缺口仍未覆盖 shell 基础设施失败与跨版本 duplicate，两者都能让新版本漏掉 severe 后 green。** shell 当前 sqlite 事务失败后明确把 `DELIVERY_DB_OK=0`、继续投递（`scripts/lead-alert.sh:539-546`）；Round 2 只让 `LeadAlertNotifier` 的 pre-claim return / `won===null` 写 `release_signal_gaps`（`plan.md:235-242`），shell 没有任何 durable gap。更根本的是 `event_id` 不含版本（shell hash 只含 project/lead/kind/signature，`lead-alert.sh:470-480`），而 `alert_claims` / `alert_version_stamps` 都以它为永久 PK。事件 E 已在 commit A claim 后，commit B 再出现同一 severe，§3.1 的 `NOT EXISTS alert_claims` 必然不写 B stamp，Bridge 的 fast reader 又会直接 duplicate return（`lead-alert-helpers.ts:73-96`; `LeadAlertNotifier.ts:974-982`）。我用计划 SQL 在 sqlite `:memory:` 回放，结果为 `winner=0, commit_b_stamps=0, stored_commit=A`；B 无 event、无 gap。最小修正是把“投递 claim”与“每 subject 的观测证据”分开：对 `(event_id,subject)` 另做幂等 observation/gap，或在 duplicate 时读取既存 stamp，若缺失/subject 不同则为当前 subject 写 capture gap；shell 也必须在 sqlite claim 失败时先落可由 rider 吸收的本地 gap outbox。增加 A 已 claim → B 同 event，以及 shell sqlite 失败但 Discord 发送成功两条负向测试。

2. **[BLOCKING] heartbeat 的三个字段语义仍会丢失败或把正常静默误判为永久不健康。** `cursor_lag_s = now - last_claimed_at`（`plan.md:256-257`）衡量的是“距最后一条告警多久”，不是“尚未消费的 backlog 多老”；源已完全追平但 11 分钟没有告警时，它就超过默认 600 秒，健康静默永远不能 green，空库/初始游标更严重。`rejected_rows` 虽写入 heartbeat，却没有出现在 U5 谓词或 `source_unhealthy` detail（`:86,115,202`），无 event_id 的坏行仍可消失。最后，同一分钟 heartbeat 是 last-write-wins upsert（`:202`），一次失败后同分钟成功会覆盖 `claims_db_ok=0` / `ingest_ok=0` / rejected count，与“窗口内任一失败都 unknown”矛盾。把 lag 定义为：无 cursor 后继行时为 0，有 backlog 时取最老未消费行到 now 的年龄；把 `rejected_rows>0` 纳入 U5；同分钟用悲观合并（布尔 AND、lag/rejected 取 MAX）或保存每 tick 行。补“追平后静默 12h”“同分钟 fail→success”“rejected_rows>0”三例。

3. **[BLOCKING] “所有证据按 subject 精确过滤”会过滤掉计划声称要 fail-close 的 NULL 证据。** §2.1 说 events / gaps 必须 `source_commit === subject.sourceCommit`（`plan.md:101`），但 U6 又要求窗口内 `source_commit=NULL` 的 severe 触发 `unattributed_severe` / `capture_gap`（`:88-89`）；按前一条收集，后一分支不可达。相同问题存在于 bug：intent/finalized 行允许 base/commit 为 NULL（`:204,265-269`），但只按 source commit 过滤，finalized 的 unknown-version bug 没有任何 unknown reason，可能被当成零 bug。改成两条明确查询合同：有归因证据按 subject 精确匹配；无归因的 severe event、capture gap、pending/finalized bug 按当前 production episode 的时间（及可用的 project）归入“不可判归属”，一律阻断 green。为 bug 增加稳定的 `unattributed_bug`（或并入明确的 source gap）并补 NULL event/gap/pending/finalized 四组测试。

4. **[BLOCKING] founder 消息仍在 durable 记录之前发送，且首次扫描成功后没有 freshness/failure 门。** `publish-report` 内部先 POST Discord，成功后才返回 `messageId`（`publish-report.ts:263-309`）；脚本随后才写 outbox（`plan.md:273-277`）。进程在两者之间崩溃、写文件失败或成功响应缺 messageId 时，消息已经存在但系统没有 binding/pending 记录；计划甚至明确说该 day 不进入 founder evidence，却声称下一份日报能显示“未绑定”，没有持久事实可供显示。同日重跑还会再发一条消息，再撞 day PK/409。另一个 fail-open 是 U7 只检查 `first_scan_ok_at`（`:90-91,205,259`）：首次空扫描后若后续分页非 200，`last_scan_error` 被记录但 evaluator 不检查，期间新增的 👎 仍可被旧扫描结果放行。发送前先持久化 day/subject 的 publication intent（或让 `/api/reports/deliver` 在 Discord POST 前持久化），成功后 finalize messageId；pending/ambiguous intent 必须 unknown，同日脚本见 intent/binding 不得重发。再定义 `last_scan_ok_at` freshness，并让“最新 attempt 是 error / 成功扫描已过期”保持 unknown；补 send 成功后落 envelope 前崩溃、同日 rerun、已有 first scan 后新增 👎 且后续扫描失败三例。

5. **[BLOCKING] 两条真实 bug 入口仍绕过 intent/ledger。** 当前 create-issue 明确支持 UUID label 直接透传（`plugin.ts:3730-3734,3928-3979`，现有测试也锁定 UUID passthrough），但计划规定 UUID-shaped label 不判 bug（`plan.md:264`）；如果传入的 UUID 正是 Bug label 且没有 `body.bug=true`，Linear 会创建真 bug，本地无 intent。仓外 founder `/create-issue` 更只被要求“加页脚”（`:355`），页脚不会写 StateStore，仍重现 Linear 成功与后置 `release-bug-tag` 之间的 crash gap。对 UUID 输入应在 team-scoped label resolution 后与配置的 Bug label ID 比较，或把 `bug:true` 设为所有 ID-based 调用方的强制、已验证合同。founder 命令必须复用同一生命周期：先建本地 intent，再调用 Linear MCP，最后按 identifier finalize；任一步中断留下 pending，而不是仅追加可读页脚。补 UUID Bug label 与 founder intent→MCP→finalize/crash 测试，并把它们列为部署前置验收而非 checklist 文案。

6. **[BLOCKING] `--abandon` 是一条能把 `unknown` 清掉的 mutation，却没有专用权限和不可抵赖收口记录。** 路由允许 `{abandon:true, note?:…}`（`plan.md:156`），表中只有可选 note / finalized_at、没有 `resolved_by` 或独立 resolution receipt（`:204`）；通用 router auth 下，持 token 的调用方可无理由把 pending 改为 abandoned，随后 verdict 可能从 unknown 变 green。这不是 B4 发布决策，但它是 B3 证据完整性的权威写。明确使用 master-only middleware，要求非空 reason，保存 `resolved_by/resolved_at/action` 的追加式 receipt，并以 `WHERE status='pending'` CAS；重复/并发 resolve 必须返回 canonical 已落定结果而不能覆写。测试 scoped token 403、无 reason 400、双写只有一方成功、receipt 与状态同事务。

7. **[NON-BLOCKING] 修正文档中的两处事实/可用性细节。** §3.1 称两条路径同序且 `alert_claims` INSERT 是最后写语句，但 shell 现有事务在它后面还有 `alert_deliveries` INSERT/UPDATE，且 shell 不用 `SELECT changes()` 判 winner（`lead-alert.sh:523-535`）；应把 TS claimer 的 winner 合同和 shell delivery-lease 合同分开描述。`verdictId = timestamp + 12-char commit` 在同毫秒并发 GET/日报时会撞 PK（`plan.md:57,150`），建议直接使用 UUID/足够随机后缀，并增加并发 append 测试。

## Verdict

CHANGES REQUESTED — address items above
