# FLY-1165 Done-thread 积压扫清 + 归档级联根因修 — 探索

Issue: FLY-1165 (https://linear.app/geoforge3d/issue/FLY-1165/infracleanup-扫清-flywheel-engineer-已完成但未归档的-thread-积压-48-根因修-auto)
日期: 2026-07-10
基于: 无

---

## 1. 问题

Annie 要求：做完的东西必须能正确 resolve + 关闭 + **归档 thread**，Discord thread 列表只显示还没做完的活。现状：#flywheel-engineer（channel `1516209714097291335`）挂着大量 Done issue 的未归档 thread（Tadashi 扫出 ~48，本次 read-only 实测**当前还剩 35 个**——部分已被手动清，如 967/980/1047）。说明 FLY-369 建的 close→归档级联**一直不可靠**。

两个交付：

- **交付 1（数据操作，无源码）**：安全扫清积压——逐 thread fresh 核实 Linear 状态，Done/Canceled 才归档，active 一律跳过；顺带清 Done issue 的 stale awaiting_review husk。
- **交付 2（源码，根因修）**：调查级联为什么漏 + 修成「issue 转 Done / runner 完成」可靠归档 + **boot/周期 reconcile sweep** 兜底。

## 2. 现有机制审计（代码证据）

归档只有 4 条触发路径，全部有明确的不覆盖面：

| 路径 | 位置 | 触发条件 | 不覆盖 |
|------|------|---------|--------|
| FLY-369 close 级联 | `bridge/done-thread-archiver.ts` `maybeArchiveThreadOnClose`，挂 `closeRunner`（`close-runner.ts:278,370`） | close 成功 **且** `status==="completed"` **且** issue 无其它 active runner（running/awaiting_review/approved_to_ship） | terminate/rejected/blocked/failed 关闭；completed 但没人调 close_runner；husk 卡 guard |
| FLY-720 crash reaper | `plugin.ts:3842`（`allowStatuses:["terminated"]`） | 仅 reaper 亲手 reap 的行 | 手动 terminate 的行 |
| FLY-742 stale-blocker guard | `stale-blocker-guard.ts` | **仅** run-start 409 碰撞时才检查 done+parked husk | 从没有下一次 run-start 的 issue |
| post-ship finalization | `post-ship-finalization.ts` | `landingStatus==="merged"` 硬卡 | 一切非 ship 收尾 |

另有按需 endpoint `POST /api/chat-threads/archive`（FLY-369 建的 backlog-backfill 通道，Bridge 持 token，archive-once，audit 落 `session_events`）。

**关键架构事实**：StateStore 是 sql.js（内存库 + 周期全量 `export()` 落盘）。Bridge 运行时**任何外部进程直接写 `teamlead.db` 都会被下一次 save() 整库覆盖**（参见 FLY-663 corruption 根因记录）。issue 文本里「UPDATE chat_threads.archived_at=now」**不能**用 sqlite CLI 直写实现，必须走 Bridge endpoint。

## 3. 取证（生产 teamlead.db，read-only，2026-07-10）

35 个未归档 `FLY-%` thread 按 sessions 状态分类：

| 泄漏类 | Issue（样本） | 数量 | 为什么级联没跑 |
|--------|--------------|------|----------------|
| A. terminate-only | 599/712/733/796/826/866/903/583 | ~8 | 手动 terminate 关闭：级联 gate 只认 `completed`，crash-reaper 的 `["terminated"]` 只覆盖它亲手 reap 的 |
| B. husk-blocked | 901/913/944/968/1049/1062(+1041 approved_to_ship) | ~7 | completed 行 close 时，同 issue 还挂着 awaiting_review/approved_to_ship husk（进程早死）→「no other active」guard 拒绝归档（FLY-980 同款） |
| C. completed-but-never-closed | 631/636/663/742/748/739/761/794/786 | ~9 | runner 到了 completed 但从没人调 `close_runner` → 级联根本没被调用 |
| D. blocked/failed-only | 718/723/792/814/962 | ~5 | crash-preserve 状态由设计不归档，但 issue 在 Linear 早已 Done/Canceled，永远漏 |
| E. active（必须跳过） | 1160（running）/1165（本票）/1159（无 session）/1073（有 running 行） | ~4 | 不是泄漏——交付 1 必须逐个 fresh 查 Linear 后跳过 |
| F. 归档失败重试 | （无） | 0 | 51 条 `chat_thread_archive_failed` 审计全是 404 missing（thread 已删）——**35 个积压从未被尝试归档**，是触发缺失不是归档失败 |

结论：四条泄漏路径（A/B/C/D）没有一条能靠「再修一个触发点」全堵；**唯一结构性兜底是 reconcile sweep**。

## 4. 历史约束（必须尊重）

- **FLY-369 演进史**（`doc/engineer/plan/inprogress/v1.49.0-FLY-369-archive-on-done.md`）：四版触发设计，Annie 最终拍板「中央 close 级联」，当时**明确否掉** standalone auto-poll-on-Linear-Done（怕 premature——「Done 但还在聊」如 FLY-351）。但同一演进里 Annie 也曾拍「Done 即归档，去掉 24h inactivity 等待」——她对 premature 的接受度依赖两个安全网：**Discord auto-unarchive（发消息即重开）+ archive-once（`archived_at` 记过就永不再扫，不与重开对抗）**。本票 issue 文本 Annie 明确要求补 reconcile sweep——政策更新有据。
- **FLY-117 红线**：绝不归档还在干活的 issue 的 thread（把在跑的活藏起来）。另有已知 bug（task #117）：重启时 crash-reaper 级联曾误归档+锁 active thread——本设计必须双保险（Linear fresh 状态 + 本地 active-runner 检查，两票都过才归档）。
- **Tadashi 安全硬约束（FLY-369 §0）**：归档一律走 Bridge 内 `archiveChatThread`（Bridge 持 token）；绝不在 Bridge 进程外手搓 token PATCH。→ 交付 1 也遵守：脚本只调 Bridge endpoint，不碰 token、不直写 DB。
- **Tadashi 亲测**：缓存 list_issues 会污染 protect-set → **逐 issue fresh 查询**（`lookupLinearIssueByIdentifier` 逐个直查，也符合 FLY-369 Codex R1 #1 的「逐候选直查防截断」教训）。

## 5. 方案选项

### 交付 2 触发面（三选一）

- **方案 ①（推荐）：保留 close 级联 + 新增 reconcile sweep（boot 一次 + 周期）**。级联管即时性（close 当下归档），sweep 管完备性（A/B/C/D 全兜住，含 pre-FLY-369 积压与今后一切漏网）。sweep 双票 gate：Linear fresh Done/Canceled **且** 本地无活 runner。husk（active 状态但进程死 + Linear Done）→ 复用 `closeRunner({finalizeDone:true})` 的 FSM-legal 流转再归档——同时根治 B 类卡 guard + FLY-560 标题误显示「🔴受阻」。
- 方案 ②：只加触发点（terminate 也归档、blocked 关闭时查 Linear 归档、close 时 husk-finalize）。堵得住 A/B，堵不住 C（没人调 close）和存量积压；触发点越多越碎。否。
- 方案 ③：Linear webhook 驱动（issue → Done 事件即归档）。Bridge 现无 issue-state-change 事件路径（FLY-369 审计核实），要新建 webhook 面 + 仍需 sweep 兜漏 → 复杂度不换可靠性。否（可作未来优化）。

### 交付 1 执行方式（二选一）

- **方式 A（推荐）：脚本驱动 Bridge endpoint**。逐 thread：fresh Linear 查询 → Done/Canceled → `POST /api/chat-threads/archive`；husk → `POST /api/sessions/:id/close-runner {done:true}`。安全（不碰 token/不直写 sql.js 库）、有审计事件、幂等（archive-once）。
- 方式 B：等交付 2 的 boot sweep 上线自动清。慢（要过 review+ship+重启），Annie 要的是现在清。否——但交付 2 上线后 boot sweep 会自动把交付 1 之后新漏的再兜一遍，两者互补。

## 6. 推荐设计（一句话）

**交付 1 = 方式 A 的一次性安全扫清（脚本 + 报告）；交付 2 = 方案 ①：done-thread reconcile sweep（boot + 周期，默认 ON，`FLYWHEEL_DONE_THREAD_RECONCILE=0` 关），双票 gate + husk-finalize + 逐 issue fresh Linear 直查 + 限速 + archive-once。**

## 7. 已定决策（headless 自决，gate 时向 Lead 汇报）

1. **sweep 不加「Done 后静默期」**：跟随 Annie 在 FLY-369 里的既有拍板（「Done 即归档」，安全网 = auto-unarchive + archive-once）。若 Lead/Annie 想要保守护栏，plan 里留一个 env（默认 0h）一行可调。
2. **sweep 范围是全 Bridge（所有 project 的 issue chat_threads）**，不只 #flywheel-engineer——机制本来就 project 无关；交付 1 的清扫范围按 issue 限定单 channel。
3. **交付 1 归档动作也走 Bridge**（不像 issue 原文写的直发 Discord PATCH + 直写 DB）——原文机械步骤与 sql.js 架构冲突 + 违反 FLY-369 token 硬约束，改走现成 endpoint 语义完全等价且多拿审计。
