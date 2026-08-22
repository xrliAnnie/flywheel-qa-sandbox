# FLY-1992 thread 自动归档回归 — 调研

Issue: FLY-1992 (https://linear.app/geoforge3d/issue/FLY-1992/ship回归-thread-自动归档再次漏1832-已修已-ship-后回归同日同链-3-成-3-漏1831-漏-8h1975-1h1944)
日期: 2026-08-22
基于: exploration.md

---

## 1. 机制细读(代码级,全部现行 main / 本分支同字节)

### 1.1 归档的完整前置链(涉及 5 个模块)

```
land-executor.ts::executeLandOperation
  └─ finalize(operation) → plugin.ts → runResumablePostShipFinalization (post-ship-finalization.ts)
       ├─ (1.x) postMergeTmuxCleanup (post-merge.ts)
       │     ├─ isResidentCodexPhase(session)? → prepareCodexPhaseShutdown (codex-phase-shutdown.ts)
       │     │     ├─ tmux lookup gone / probe dead_pin|absent → direct(直拆授权)
       │     │     ├─ probe ALIVE + heartbeat_at stale(>60s) → ★ blocked:
       │     │     │     phase_shutdown_controller_lease_stale_live_pane
       │     │     │     (此分支不发 shutdown request、不进 ack 窗 —— 直接返回)
       │     │     └─ probe ALIVE + heartbeat fresh → graceful request → 30s ack 窗 → …
       │     ├─ blocked → errors[] 记录,physicalGone=false
       │     └─ commDbFinalized 只在 physicalGone 后才尝试 → blocked 时恒 false
       ├─ closeoutBlocked = !cleanup.commDbFinalized ‖ issueCloseout 返回 blocked/conflict
       ├─ landReady = !closeoutBlocked && worktreeRemoved   ← FLY-1832 readiness 谓词
       └─ landReady=false → terminal-notification / archive / Linear Done 三者零调用
            → finalization partial(reason=issue_closeout_incomplete)
  └─ partial → release() → FLY-1770 退避 1/2/4/8/15/30/60/120min,第 9 次 → held(terminal)
       → StateStore::…land held → workflow_run held + land_held 事件 + engine alert
```

### 1.2 关键合同原文(`codex-phase-shutdown.ts`)

- 头注(FLY-1269):「Direct cleanup remains the backstop **only when the controller is provably absent**; uncertainty fails closed.」
- stale 分支注释:「A stale lease then means "the controller stopped beating" OR "we cannot read its beat" — never "provably absent"… Fail closed: killing a live controller's window orphans its daemon.」
- 常量:`DEFAULT_CONTROLLER_LEASE_MAX_AGE_MS = 60_000`,`DEFAULT_ACK_TIMEOUT_MS = 30_000`。
- **要点**:stale-lease 分支在 graceful request 之前返回 —— 一个「慢而未死」的 controller 连 ack 的机会都没有;一个真死的 controller 则让这里成为永久 blocked。

### 1.3 heartbeat(lease)由谁续

`sessions.heartbeat_at` 由 runner 侧活动经 Bridge 写入:`event-route.ts:606`(runner 上报事件时)、`DirectEventSink.ts:1354`、`HeartbeatService` 的 re-adopt 分支(仅 reconnect episode)。Resident Codex phase 的常态续约 = daemon 的 keepalive 腿(FLY-1269/FLY-887 族)。**daemon wedge/死 ⇒ 60s 后恒 stale;TUI pane(独立进程)可以继续活着** —— 这就是「stale lease + live pane」持续态的来源。

### 1.4 cleanup ack(澄清:它不是门)

`land-cleanup-opportunity.ts`:对 issue 全部 session 写 `runner_shutdown_controls` + mailbox instruction,等 30s。ack 数只进收据(`{requested,acked,timedOut}`),**不参与 closeout 判定**;头注明说「The subsequent lifecycle closeout remains fail-safe and closes after the bound」。生产实证:成功组的 Codex 体 cleanup 信同样 DEAD(mailbox 表),照样归档。

### 1.5 告警链现状

- `land_partial` → workflow engine alert(severe)文案:「…could not finish cleanup after merge. Reason: issue_closeout_incomplete. **The durable operation will keep retrying**; inspect `GET /api/lifecycle/land/<operation-id>`.」
- `land_held`(retry_exhausted)→ alert「Workflow run held …」。
- 两者当日均 `sent`。缺陷:(a) held 后并不会「keep retrying」,partial 文案对终局误导;(b) 只给检查命令,无修复动作;(c) thread 内 founder 可见面是生 JSON(`plugin.ts` land notify:`content: "🏁 land ${stage} — PR #N\n" + JSON.stringify(detail)`)。

## 2. 现成积木盘点(全部已在生产验证)

| 积木 | 位置 | 当日实证 |
|---|---|---|
| identity-fenced daemon 收割 | `codex-daemon-teardown.ts::reapCodexDaemonForSession` → `flywheel-claude-runner::reapCodexDaemonForExecution`(按 execution 的 cdx-sock/pgid census,绝不按名字) | 16:38/17:04 Lead 手动路径三单 `outcome:"reaped"` |
| tmux window 身份杀 | `post-merge.ts` legacy direct 分支(`getTmuxTargetFromCommDb` → reapRunnerMcp → killCmuxLinkedSession → `killTmuxWindow`) | 成功组三单走过 |
| books settle | `postMergeTmuxCleanup` 的 CommDB finalize(physicalGone 后) | 三单 resume 前由 close-runner settle |
| land 恢复 | held resume(FLY-1861,`resume_authorized` step) | 1831 `resume_authorized:1` |
| thread 说明 receipt 合同 | FLY-1832 §2.4 `archive_waiver_notified`(generation-fenced `land_operation_step`,post-success receipt,at-least-once) | 已 ship 模式,可直接沿用 |
| 归档 + Done 收尾 | FLY-1832 terminal→archive→Done 步序 | 六单(closeout 收敛后)全部自动走通 |

**结论:Fix A 不需要发明任何新机制,只需要把这些积木按 Lead 手工顺序接进 phase-shutdown 的授权矩阵,并加证据门。**

## 3. 关键设计问答

**Q1 为什么不能只等 FLY-1985 修 daemon wedge?**
teardown 腿和唤醒腿是两条独立的腿(1757 反例:信箱 wedge 但归档成功;1944 的 husk 死因是 model-switch nudge 卡死,不是信箱)。daemon 的死法是开放集合(crash/OOM/nudge 卡死/未来新病),唤醒腿修好任何一种,teardown 腿都还需要「死体不挡终局」的收敛保证。两单分工:1985 = 让活体恢复干活;1992 = 让死体不再挡路。

**Q2 强拆会不会杀掉一个「其实还在干活」的 controller?(FLY-1269 的原始担忧)**
升级门要求四件证据同时成立:
1. land `merge_confirmed` —— PR 已合入,工作产物已安全落库,worktree 即将被移除;
2. engine run 正在 land 终局推进 —— FLY-1655 合同下 land 是 engine-owned terminal,本 run 不会再有合法 rework 需要这个 husk(founder kickback 发生在 gate,在 merge 之前);
3. lease stale 持续跨 ≥2 个独立 finalization pass 且 ≥ 阈值分钟 —— 排除「刚好 60s 边界」的瞬态;
4. graceful shutdown request 已发出且等满完整 ack 窗 —— 「慢而未死」的 controller 有 ack 机会(修正现状 stale 分支直接返回的行为)。
即便如此仍拆错(理论上 controller 活着但 >N 分钟不心跳、不 ack):此时它已经丧失与系统的全部协作通道,在「PR 已 merge、run 终局」语境下,它能做的唯一合法动作就是退出。拆它的代价是丢一个已经无法交流的 TUI 现场;不拆的代价是 founder 可见的归档漏 + Lead 人工。
**orphan daemon 担忧的直接解**:强拆顺序先 reap daemon 进程组(identity-fenced)再杀窗 —— Lead 手工路径已三次实证。

**Q3 为什么不把升级放宽到所有 close-runner 场景?**
FLY-1269 的 fail-closed 对非终局场景仍然正确(活 controller 可能在 drain、在写 worktree)。只有「shipped + merge_confirmed」这一种 disposition 同时满足「产物已安全」「husk 无未来价值」两个条件。scope 越窄,合同越可审计。

**Q4 blocked 期间 founder/Lead 面怎么办(Fix B 的必要性)?**
即使 Fix A 生效,仍存在拆不动的残留(census unverifiable、tmux 异常)→ blocked 会继续存在。诚实面三件:
- thread 一条 founder 可读说明(受 FLY-1832 §2.4 receipt 合同,一次性);
- `land_partial`/`land_held` 告警文案与真实行为对齐(held=不再自动重试),并附修复命令;
- Fix A 的强拆动作本身落审计事件 + step receipt(证据快照),巡检(FLY-1687)可核。

**Q5 已 held 的存量怎么办?**
held 的出口已存在(resume API,FLY-1861)。Fix A 在 resume 后的 pass 同样生效(证据门天然满足:stale 已持续数小时)。不做自动 resume 存量 —— held 是 terminal 状态,恢复由 Lead/founder 决定(当日存量已被 Lead 清完)。

## 4. 生产取证 SQL(复核用,全部只读)

```sql
-- land 操作与终态
SELECT operation_id, issue_id, pr_number, state, retry_count, last_error
FROM land_operation WHERE created_at >= '2026-08-21T12:00' ORDER BY created_at;

-- 每单 step 收据(cleanup ack / finalization / resume)
SELECT lo.issue_id, s.step, s.completed_at, s.receipt_json
FROM land_operation_step s JOIN land_operation lo USING(operation_id)
WHERE lo.issue_id IN ('FLY-1831','FLY-1975','FLY-1944','FLY-1757','FLY-1955','FLY-1961')
  AND lo.created_at >= '2026-08-22';

-- 漏组不动点证据(注意 session_events.ts 用空格分隔符)
SELECT ts, execution_id, event_type, payload FROM session_events
WHERE event_type IN ('post_merge_partial','lead_close_runner_failed')
  AND ts >= '2026-08-22 07:00' AND payload LIKE '%lease_stale%';

-- cleanup 信投递终态(六单 Codex 体全 DEAD)
SELECT to_agent, state, created_at, content FROM mailbox
WHERE content LIKE '%land-cleanup%' ORDER BY created_at DESC;

-- 告警送达
SELECT created_at, state, escalation_uid FROM workflow_alert_outbox
WHERE payload_json LIKE '%FLY-1831%';
```

## 5. 会过期的结论(as-of 2026-08-22)

| 结论 | 依据 | 重核命令 |
|---|---|---|
| FLY-1975 land 已完成 | 17:07:40 `land_completed` | 上表 SQL#1 |
| held 存量已被 Lead 清完 | 16:38–17:07 批量 teardown | SQL#1 看 state='held' 且未 superseded |
| lease 阈值 60s / ack 窗 30s | `codex-phase-shutdown.ts` 常量 | 读该文件 |
| stale 分支不发 graceful request | 同上 L201-213 | 同上 |
| FLY-1985 仍 Backlog(daemon wedge 未修) | Linear 2026-08-22 | Linear 查 FLY-1985 |

## 6. 实施期证据修正

独立 code review 的真机 census 证明两条设计前提不成立：

1. `sessions.heartbeat_at` 会被 Bridge 的 pane readoption loop 主动刷新，不是 runner-authored heartbeat；因此不能拿它证明 controller stale。最终 gate 使用已超完整窗口仍未 ack 的 `runner_shutdown_controls`。
2. `FLYWHEEL_EXEC_ID` 会被 Runner 启动的脱离应用继承；真机存在带该 marker 的 Cursor process-group leader。按 marker 扫描并 SIGTERM/SIGKILL 整个 group 会误杀 IDE 和未保存内容。

最终实现按 Ponytail 最小化：删除本单新造的 execution-wide process reaper，只复用带 `@flywheel_exec_id` 和 land authority 双栅栏的 strict tmux cleanup。已有 `reapRunnerMcp` 仍只处理已证明 pane 的、classifier 命中的 MCP descendants。研究中「先按 execution census 收割所有进程组」的候选方案由此作废；生产对照结论与 FLY-1985 分工不变。
