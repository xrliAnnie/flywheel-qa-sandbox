# Exploration: Cron 被 done-but-uncleared session 静默挡死 — FLY-742

**Issue**: FLY-742 (Cron silently blocked forever by a done-but-uncleared runner session)
**URL**: https://linear.app/geoforge3d/issue/FLY-742
**Date**: 2026-07-01
**Status**: Complete
**Brainstorm gate**: flywheel-eng-lead (Tadashi) 已确认方案 + 3 决定拍板

---

## 1. 问题(founder-facing P1,已第 2 次发生)

一个**跑完活但从没发终态事件**的 runner session 永久卡在 "active" 状态,挡住同一 issue 上的下一次 scheduled/cron run-start。整条链路静默——每日 job 停摆到人肉发现为止。

### 实际时间线(Sub daily-loop,LEARN-80 / issue da40694f)

1. 2026-06-30 daily-loop runner `be891592` 完成工作、交付 PR #83、被 Lead 确认 park,但**从没发** `stage set completed` 终态事件 → session 永久停在 `awaiting_review`。
2. 2026-07-01 03:07 cron tick 触发(exit 0),但 Bridge run-start 返 `success:false`(issue already has an active session … awaiting_review)。tick 探 liveness(`executing`)后跳过:"a live run already occupies the slot; no new run needed this tick."
3. 净结果:当晚 daily job **没跑,且静默**。只因 founder 发现没输出才被抓到。

## 2. 根因(lifecycle gap + 409-quiet-skip 语义混淆 + 零告警)

三个叠加因素:

**(a) 终态事件不可靠。** runner 可以 finish + park(在 `awaiting_review`,或成功 ship 后 founder 还没 ship/reject 的 `approved_to_ship`,或在发 `stage set completed` 前 exit)而**没有任何终态事件**。Bridge 于是把它当"active session"无限期保留。

**(b) `getActiveSessions()` 含 park 态。** `StateStore.getActiveSessions()` = `status IN ('running','awaiting_review','approved_to_ship')`。`/api/runs/start`(`runs-route.ts:190-206`)对同一 (issue, role) 命中任一 active 态即返 409。

**(c) 409 被当良性 quiet skip + 零告警。** scheduler(外部 Sub cron / repo 内的 `xhs-scheduler`)把 409 当"in-flight guard 命中、不是 error"直接静默跳过(`xhs-scheduler.ts:314-327` 原话 "Not an error … skip")。**没有告警**。于是 scheduled job 静默停摆,只有 human 巡检才发现。

一句话:409-quiet-skip 是**为正常 in-flight guard 设计的**(别对真在跑的 run 重复 spawn),但它把"真在跑"和"跑完没清"**混为一谈**——后者应当自愈或立即告警,而不是静默跳过。

## 3. 影响范围 = PLATFORM 级(非 Sub 专属)

任何在固定 issue 上 run-start 的 Flywheel scheduled/cron job 都会被同样方式静默杀死。repo 内 `scripts/xiaohongshu-scheduler.ts` 就是同一模式(POST `/api/runs/start`,409→quiet skip),带同样漏洞。特征:静默(无告警)+ 复发 + 每次要人肉介入。

## 4. 已有基建(不是从零 —— 复用而非重造)

| 基建 | 覆盖 | 对 FLY-742 的缺口 |
|------|------|------------------|
| FLY-191 awaiting_review 超时 → `gate_timed_out` 升级(`HeartbeatService`) | 有升级路径(Lead + Annie) | 框成"founder 去 approve/reject PR"、**不释放 slot**、窗口(小时~48h)比 24h cron 周期长 → tick 早已静默跳过 |
| crash-reaper(FLY-720,`crash-reaper.ts`) | 收 `running`+dead-pin,heartbeat tick 上 teardown→terminated | **只碰 running**;显式 `continue` 掉 `alive`/`awaiting_review`;park 态不在候选集 |
| `probeQuietSignals` / quiet-classifier(FLY-324/626) | done/idle/parked 分类器 | 现成可复用的 "done-but-idle" 信号 |
| GEO-270 `/api/patrol/scan-stale` | 扫 stale **completed** session,按 Lead 分组发 Discord 通知 | 只扫 completed;不碰 awaiting_review blocker;不 auto-clear |
| event-route `awaiting_review/approved_to_ship → completed`(gated on `landingStatus.status==="merged"`) | 已有 merge-proof 的收尾 transition | 只在 runner **主动发终态事件**时走;lingering session 从不发 → 永不触发 |

**关键复用点**:event-route 已经在做 `awaiting_review→completed`,且**在 call site 用 merge-proof(landingStatus merged)把关**(FSM `workflow-fsm.ts:124-129` 注释明写这条纪律)。我的 auto-finalize 就是**同一条 transition + 同一条 merge-proof 纪律**,只是把关信号换成 live gh 权威查询(landing 文件可能 stale)。完全同调,非新范式。

## 5. 方案(Lead 已拍板 —— MVP = 完整正解,非 descope)

两件事,都落在 **Bridge 侧 `/api/runs/start`** 的 409 路径(覆盖所有 caller,含外部 Sub cron —— 它们都打这个 endpoint,外部 cron 本体不用动):

### (1) Never-silent 告警(issue 第 3 点,承重项)

409 路径上,当 run-start 被一个**stale/idle blocker**(park 态 + idle 超 TTL)挡住时,发 Discord 告警给该 issue 的 Lead(复用 GEO-270 hook-payload → Lead relay 路径)。按 blocker(execution_id + awaiting_review 进入戳)**去重**、只报一次。**gate 在 staleness 上**:健康在跑的 `running` in-flight blocker **不告警**(那是正常 in-flight guard,保持现状)。

### (2) 窄而安全的 auto-finalize(issue 第 1 点)

当 blocker 是 `awaiting_review`/`approved_to_ship`、**其 PR 已 merged/closed**(live `gh pr view` 权威确认)、且 idle 超 TTL → Bridge teardown 掉残留 tmux + FSM transition 到 `completed` 释放 slot,**同一 tick 继续正常 start**(这一晚的 job 真的会跑)。

**安全边界(D2,Lead 拍板)**:PR 已 merged/closed = founder 已用 merge 决策、**没有要抢的 founder 动作** = 属 Bridge system-health 清理(crash-reaper 已有自动 terminate dead-pin 的先例),不触碰 founder-only-authority。**PR 未 merged 的 blocker → 只告警、绝不自动清**(founder 仍拥有那个 ship 决定)。

## 6. 明确 NOT DO(Lead 的 design 决定,会向 Annie 点明是 surface 非漏做)

- **广义 staleness reaper(issue 第 4 点)不做** —— 它会误清"合法 park 等 founder 批"的 session(PR 没 merged、真在等 Annie)。never-silent 告警已安全冒泡这些给 Lead/founder。
- **改外部 cron tick 本体(issue 第 2 点)不需要** —— Bridge 侧 409 告警已覆盖所有 caller。

## 7. 关键决定(已定)

- **D1 scope** = MVP(告警 + merged/closed-PR 的窄 auto-finalize)= 完整正解;广义 reaper + 外部 cron 改动不做。
- **D2 边界** = auto-close 仅限 PR 已 merged/closed 的 done+idle blocker;非-merged → 只告警。
- **D3 文档** = repo 既有 `doc/engineer/`(注入的 `engineering/doc/` 本 repo 不存在)。
- **QA 红线** = 修完必须走**真 529 QA Room E2E**(非只 unit):真造 stale awaiting_review + PR 真 merged 挡真 cron run-start → 验 (a) 告警真发 Lead + (b) merged-PR blocker 真被 auto-finalize + 下 tick 真干净重跑。Lead 安排真频道。

## 8. 预期结果

任何 Flywheel scheduled/cron job 不再被 stale session 静默挡住:被挡的 scheduled run **要么自愈**(merged-PR blocker 自动 finalize、同 tick 成功)**要么立即冒泡成 Discord 告警**(非-merged blocker,交给 Lead/founder 一键清)。
