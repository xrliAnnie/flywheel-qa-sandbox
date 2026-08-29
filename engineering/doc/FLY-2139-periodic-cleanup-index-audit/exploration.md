# FLY-2139 Bridge 全方位定期清理与 index 审计 — 探索

Issue: FLY-2139 (https://linear.app/geoforge3d/issue/FLY-2139/bridge-稳定全方位定期清理-文件db-陈旧数据的机制化清理与-index-审计保证-bridge-常快founder-已令开工)
日期: 2026-08-28
基于: 无

## 1. 问题重述

founder 拍板(2026-08-29 04:06):Bridge 不应该总在读旧信息 —— 需要**全方位定时清理**(文件 + DB)+ **index 审计**(确认「只读进行中 status」的查询真的走索引),保证 Bridge 常快。已有两次手动先例(01:21 mailbox 66,272 终态行归档 p99 30752→279ms;04:00 codex-gates 6,682 个记号归档 p99→65ms),本单把它们**机制化**。

操作基线(不可违背):备份 + 归档式(非删除)+ 只动可证终结项 + 每类清理带 before/after 证据。

## 2. 现场盘点(2026-08-28 实测)

### 2.1 文件面残留

| 路径 | 体量 | 身份 | 现有清理 |
|---|---|---|---|
| `~/.flywheel/state/codex-gates/*.json` | 1,344 个(04:00 归档后余量) | gate marker(Codex runner 门记号) | **无**——只有 CodexTmuxAdapter 消费路径删(:1495),其余路径(session 异常终止、adapter 未接管)永久残留 |
| `~/.flywheel/state/codex-gates/ask/*.json` | **14,667 个 / 57MB** | ask marker(FLY-142 非阻塞 ask 的唤醒记号) | 答复时 best-effort 删(gate-marker.ts:248);**未答复的永久残留**,且源码注释自认「orphaned ask-markers are tiny」——单个小,总量不小 |
| `~/.flywheel/state/codex-gates/FLY-2024-xhs-mcp/` | **162MB** | 误放进 marker 目录的完整 repo clone(一次性垃圾) | 无 |
| `~/.flywheel/state/fly2054-playwright/` | **520MB** | Playwright 浏览器二进制缓存(FLY-2054 视觉 QA 遗留,可重新下载) | 无 |
| `~/.flywheel/state/push-guard/worktrees/` | **265MB** | force-push guard 的 worktree 证据副本 | 无 retention |
| `~/.flywheel/comm/flywheel/comm.db.pre-*` / `*.migrated-r2-failed*` | **~1.3GB**(7 个历史备份文件) | 迁移/修复时代的 DB 备份(最新 2026-08-08) | 无 |
| `~/.flywheel/state/` 其余 | codex-gates-archive 26MB、codex-sessions 15MB、log-janitor 11MB、launch-commits 11MB、review-requests 5.9MB 等约 40 个小目录 | 各类 episode/证据目录 | 无统一 retention |

### 2.2 DB 面(live 实测,均 read-only)

**teamlead.db(318MB 文件)** 按字节 top:

| 表 | 字节 | 行数 | 备注 |
|---|---|---|---|
| lead_events | 102MB | 58,102 | **FLY-2006 8/23 清过一次后 5 天回弹到此**——增长率 ~1.2 万行/天 |
| workflow_run_event | 46MB(+18MB autoindex) | 103,483 | 陈年 workflow 事件 |
| codex_review_job | 40MB | — | review 任务留痕 |
| session_events | 21MB | 54,409 | |
| workflow_alert_outbox | 18MB | — | |
| sessions | 7.9MB | 2,612(terminal 2,598 / running 10) | 终态行占 99.5% |
| dead_letter_alerts | 小 | 352 | |

**comm.db(497MB 文件 / WAL 160MB)** 按字节 top:mailbox_archive 133MB、mailbox_log 90MB、mailbox_identity 32MB(+48MB autoindex)、**mailbox 活表仅 1.5MB**(01:21 归档奏效)。
⚠️ dbstat 总和 ≈ 330MB < 497MB 文件 ⇒ 01:21 删除 66K 行留下的 **free page 从未回收**(auto_vacuum=none);WAL 160MB 说明 checkpoint 不充分。

两库均为 better-sqlite3(StateStore.ts:11、db.ts:12),同进程内嵌,库文件大小直接影响页缓存与 I/O。

### 2.3 已存在的机制(必须复用,不造新)

1. **flywheel-log-janitor.sh(FLY-1330)+ launchd 每日 04:15 `--apply`**:模块化(6 个 `run_*` 模块 + `module_enabled` 开关)、dry-run 先行门、audit.jsonl、Discord 报告。**但生产上处于失败循环**:err.log 连日报 `apply requires a matching full-scope dry-run`——dry-run marker 过期后 launchd 的 `--apply` 永远被自身安全门挡住,最后一次成功 apply 是 2026-08-22。**定时清理框架存在但断链**,这本身是 2139 的第一修理项。
2. **FLY-2006 retention sweep engine(已合入 #932,8/23 实跑)**:`scripts/fly-1998-database-retention-sweep.mjs` + registry(182 表全分类)+ consumer gate + evidence 流程,founder 批过 2.89M 行清扫。**一次性、操作员驱动**,无复发调度 ⇒ lead_events 5 天回弹 10 万级字节。
3. **FLY-2136(分支,未合)**:mailbox 两个 partial index + Bridge 内 60s 周期归档(archiveDueFamilies + ring cursor)+ gate-marker 读缓存。其 plan §5 明确把「gate marker 残留清扫 + 谁在铸残留」留给后续 —— 即本单。
4. **FLY-2058(分支,未合)**:读路径(去 marker 扫描热路径)。本单不碰读路径。
5. **部署班车**:`com.flywheel.updater.plist` 00:00/12:00 跑 `update-flywheel.sh` → 重启服务,天然的 Bridge 停机窗(VACUUM 类需要 quiescence 的动作唯一合法宿主)。

### 2.4 index 现状初勘

teamlead.db 热表已有针对性索引:sessions(idx_sessions_status/status_revision/project/issue_id)、lead_events(dedup/recent/ack_due/patrol)、dead_letter_alerts(pending_recipient/due)、lead_inbox(ref/pending/resend)、codex_review_job(exec/status/question)。已有 EQP 固化测试先例:`StateStore.patrol-tick.test.ts`、`StateStore.workflow-engine-transition.test.ts`(teamlead)与 fly2008/fly2136 pattern(flywheel-comm)。审计 = 逐条热查询 EQP 固化 + 查漏,预期缺口是少数,而非推倒。

## 3. gate marker「用完即删」的根因

- marker 只在 Codex runner env(`FLYWHEEL_GATE_MARKER_DIR`)下写(gate.ts:239 no-block 路径);
- 唯一删除点是 CodexTmuxAdapter 消费后(:1495)。session 崩溃/终止、adapter 未跑到消费步 ⇒ 残留;
- ask marker 只在「被答复」时 best-effort 删;未答复的(大量)永不删;
- ⇒「用完即删」缺的是**终态兜底**:execution 到终态时清它名下 marker + 定期扫尾兜底孤儿。

## 4. 方案方向(brainstorm 结论)

**不造新子系统。三个既有载体各归其位:**

| 载体 | 承接 | 理由 |
|---|---|---|
| launchd janitor(04:15 日跑) | 文件面全部扫尾模块 + DB retention sweep 定时化(inventory 常跑,apply 在已批政策内) | 模块框架/审计/报告现成;进程外,不占 Bridge 事件循环 |
| 部署班车停机窗(00:00/12:00) | WAL checkpoint(TRUNCATE)+ 周期 VACUUM(备份先行) | 需要 quiescence 的动作唯一安全窗 |
| Bridge 进程内 | 只保留 FLY-2136 已实现的 mailbox 60s 归档 + gate 关闭路径的就地删 marker | 重活不进事件循环(本单要治的正是事件循环被拖慢) |

三面的具体刀法、政策阈值、与 2006/2136 的接缝在 research.md 展开。

## 5. 边界(issue 原文 + 本次确认)

- 不改任何业务语义;读路径归 FLY-2058;mailbox 归档机制本体归 FLY-2136;
- FLY-2006 的 founder 授权是一次性的 —— 定时化 apply 的授权边界是设计要点(fail-closed:超政策即停并报 Lead);
- 每类清理带 before/after 性能/体量证据;备份 + 归档优先于删除。
