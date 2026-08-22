# FLY-1992 thread 自动归档回归(3 成 3 漏) — 探索

Issue: FLY-1992 (https://linear.app/geoforge3d/issue/FLY-1992/ship回归-thread-自动归档再次漏1832-已修已-ship-后回归同日同链-3-成-3-漏1831-漏-8h1975-1h1944)
日期: 2026-08-22
基于: 无

---

## 0. 一句话结论

FLY-1832 修的归档链**本身没有回归** —— 3 漏 3 成的分水岭在归档的上游前置:post-ship closeout 撞上「Codex TUI pane 还活着 + 心跳租约已 stale」时,`prepareCodexPhaseShutdown` 按 FLY-1269 合同 fail-closed 返回 `phase_shutdown_controller_lease_stale_live_pane`,**且这个状态没有任何机器升级路径** —— daemon wedge(FLY-1985 同病灶)使它成为稳定不动点,land 的 8 次退避重试全部撞同一堵墙后转 held,只有 Lead 人工拆 husk 才能解;而成功的 3 单只是 pane 在 land 时**恰好已经不在了**。

## 1. 生产取证(全部只读,`~/.flywheel/teamlead.db` + `~/.flywheel/comm/flywheel/comm.db`)

### 1.1 六单对照表(land_operation + land_operation_step + session_events)

| Issue | PR | land 创建 (UTC) | cleanup ack | closeout 首判 | 结局 |
|---|---|---|---|---|---|
| FLY-1955 | #915 | 05:32:55 | 1/3 | **pane 已不在**(`alreadyGone:true`)→ 直拆 | 05:35:34 finalization 完成,05:36:05 自动归档 ✅ |
| FLY-1961 | #917 | 05:35:23 | 1/2 | 同上 | 05:36:07 完成,05:38:49 自动归档 ✅ |
| FLY-1757 | #918 | 06:22:49 | 1/2 | 同上 | 06:23:19 完成,06:25:41 自动归档 ✅ |
| FLY-1831 | #919 | 07:27:55 | 0/2 | **pane 活 + lease stale → blocked** | 8 次重试(07:31→11:31)全同错 → held;15:44 Lead 手动归档;16:38 Lead 拆 husk + resume → 16:39 完成 ❌(8h) |
| FLY-1975 | #920 | 14:41:24 | 0/2 | 同上 | 重试至 8 次;15:44 Lead 手动归档;17:04 拆 husk → 17:07 完成 ❌(~1h 到手动归档) |
| FLY-1944 | #923 | 15:26:33 | 0/6 | 同上 | 重试 7 次;16:38 Lead 拆 husk → 16:41 完成 ❌(~70min) |

漏组三单每个 land retry pass 的 `post_merge_partial` 事件 payload **逐字相同**:

```json
{"tmuxClosed":false,"commDbFinalized":false,"retiredGateCount":0,
 "errors":["phase-shutdown: phase_shutdown_controller_lease_stale_live_pane"]}
```

成组三单首 pass 即:

```json
{"tmuxClosed":true,"commDbFinalized":true,"retiredGateCount":0}
```

且 `lead_close_runner` 均为 `"alreadyGone":true` —— **pane 在 land 时已经不存在**,phase-shutdown 走 `target_gone`/`absent` 直拆分支,秒过。

### 1.2 Lead 手工修复的原话(land_operation_step / session_events,漏组三单)

- FLY-1831 `resume_authorized:1`:「closeout was blocked by **parked Codex husk**; husk torn down + books settled, resuming finalization」
- FLY-1944 `lead_close_runner`:「husk was **wedged on Codex model-switch nudge**, dismissed + /quit; settling books for closeout」
- FLY-1975 `lead_close_runner`:「**goal-paused husk** torn down per post-approve cleanup; settling books」

Lead 的手工序列 = `/quit` 净化 pane → `exec_host_processes_reaped`(按 execution 的 cdx-sock/pgid 身份收割 daemon 进程组,三单实证 `outcome:"reaped"`)→ settle books(commDbFinalized)→ land resume → finalization 完成 → **自动归档随即补上**。这证明:归档链下游完好,缺的只是上游 closeout 的收敛。

### 1.3 排除项(逐个证伪)

- **不是 FLY-1832 修复回归**:归档步骤本身、archive-last 步序、terminal-notification 全部按 #869 行为工作(成组三单零人工全链走通;漏组在 closeout 收敛后归档也立即发生)。
- **不是 cleanup ack 计数决定**:六单的 Codex implement 体 cleanup 信**全部 DEAD**(mailbox 表实证,含成功组);漏组的 Claude QA 体其实也 ACK 了,只是晚于 30s grace(1975 晚 40s、1944 晚 31s)。ack 数只影响首 pass 等待,不是 closeout 的门。
- **不是告警缺失**:`land_partial`(severe)+ `land_held` 告警全部 `sent`(1831:07:31 partial + 11:31 held)。但文案说「The durable operation will keep retrying」(held 后其实**不再**重试)且只给了检查命令 `GET /api/lifecycle/land/<id>`,没有修复动作;修复 runbook 是 Lead 在 founder 15:43 追问后现场发明的。
- **不是 Discord 归档 API 问题**:所有 `chat_thread_archived` 调用 status 200。

## 2. 根因链(五层)

```
[FLY-1985 病灶] Codex daemon wedge(不轮询 mailbox / 不 ack shutdown / 不发 keepalive)
      ↓ 60s 后
[层1] sessions.heartbeat_at stale(keepalive 停跳;pane/TUI 是独立进程,仍活着)
      ↓ land → post-ship finalization → postMergeTmuxCleanup
[层2] prepareCodexPhaseShutdown:pane 探活 ALIVE + lease stale
      → 按 FLY-1269 authority matrix fail-closed:blocked(且 stale 分支根本不进 graceful request/ack 窗)
      ↓
[层3] commDbFinalized:false → closeoutBlocked → FLY-1832 readiness 谓词挡 archive + Linear Done(设计如此,正确)
      ↓
[层4] land 1m/2m/4m/8m/15m/30m/60m/120m 退避 9 次(FLY-1770)——每次撞同一个稳定不动点 → held
      ↓
[层5] 无机器出口:只有 Lead 人工 /quit + reap + settle + resume;founder 只看见「thread 没归档」
```

**关键设计缺口在层 2→4**:FLY-1269 的 fail-closed 合同假设「stale lease + live pane」是罕见瞬态(等下一 pass 就好),但 daemon wedge 让它成为**持续态**;而 land 的重试机制只会反复问同一个问题,得到同一个答案。fail-closed 本身没错 —— 错在 fail-closed 之后**没有带证据门的升级路径**,把一个机器可判定、机器可执行的修复(Lead 当天手工做的那套)留给了人。

## 3. 与 FLY-1985 的关系判定(issue 首要假设的修正)

**共享病灶,但不是纯下游;不应合并施治。**

- issue 假设「归档级联由 runner 消费 cleanup 信后的 ack 触发,信箱堵 ⇒ cleanup 不消费 ⇒ 归档漏」——实证**不成立**:cleanup 信的 ack 不是 closeout 的门(六单 Codex 体的 cleanup 信全部 DEAD,成功组照样归档)。
- 真正的耦合点是 **daemon wedge 的另一条腿**:wedge 的 daemon 同时(a)不消费 mailbox(FLY-1985 的症状)、(b)不发 keepalive → heartbeat stale → 本单的症状。
- **反例证明两腿独立**:FLY-1757 的 implement 体是 FLY-1985 实锤 wedge 案例之一(积压 6 封 30+ 分钟),但它归档成功 —— 因为 land 时 pane 已被(前序人工干预中)拆掉。即:**信箱堵本身不阻归档;活着的 stale husk 才阻**。
- 修 FLY-1985(唤醒/消费腿)能减少 wedge 发生,但 daemon 还有其他死法(crash、OOM、model-switch nudge 卡死如 1944)都会复现本单。teardown 腿需要**独立的收敛保证**。

## 4. 旁支发现(不属本单主病,单列)

- **FLY-1756(#916)**:同日 held,但机制不同 —— closeout 正常收敛(`commDbFinalized:true`),卡在 `worktree_cleanup_skipped: branch_mismatch`(worktree 注册分支 `flywheel-FLY-1756-pr2` ≠ 期望 `flywheel-FLY-1756`,第二个 PR 导致的绑定漂移)→ `landReady=false` → 归档同样被挡。root 是 worktree 绑定问题,**建议另立 issue**;本单的诚实面修复(§5 Fix B)顺带覆盖它的「不静默」诉求。
- thread 里的 land 叙事消息是生 JSON(`🏁 land finalization_partial — PR #919\n{"reason":...}`),founder 不可读。

## 5. 修复方向(候选)

### Fix A(主修,结构):shipped-terminal husk 的授权强拆升级

把 Lead 当天手工发明的 runbook 机器化,作为 FLY-1269 authority matrix 在「shipped 终局」这一种 disposition 下的**受证据门约束的升级层**:

- 证据门(全部满足才升级):land operation `merge_confirmed`(PR 已合入,产物安全)+ engine run 在 land 终态推进(不会再有本 run 的合法 rework 需要这个 husk)+ lease stale 跨 ≥2 个独立 pass 持续 ≥N 分钟(排除瞬态)+ graceful request 已给满一个完整 ack 窗(修正现状:stale 分支也先发 shutdown request 等 ack,给「慢而未死」的 daemon 机会)。
- 强拆动作 = 复用现成积木,顺序解决「orphan daemon」担忧:先 `reapCodexDaemonForSession`(identity-fenced,按 execution 的 socketPath/pgid census,绝不按名字杀)→ 再杀 tmux window(身份验证)→ settle books → closeout 下一 pass 自然收敛 → 归档自动补上。
- 任何证据不满足 → 维持 blocked(FLY-1269 合同对所有非 shipped 场景零改动)。

### Fix B(防御纵深,诚实面):

1. thread 的 land 叙事文案 founder 化;closeout 卡住时 thread 里有一条 founder 可读的说明(原因 + 已通知 Lead + 修复后自动归档),沿用 FLY-1832 §2.4 的 receipt-based at-least-once 合同 —— 直接落实本单验收第二句「不能归档要说明原因,不静默」。
2. held 告警文案修正:held 后不再自动重试,文案不得再说「will keep retrying」;附可执行修复命令(husk teardown + land resume)。

### 已否决的替代方案

| 方案 | 否决理由 |
|---|---|
| C1 归档与 closeout 解耦(先归档后清理) | 违反 FLY-1832/Codex R1#3 已定决策(「archive over a blocked closeout hides a still-live runner」);husk 活着时归档是假象 |
| C2 只修 FLY-1985 等 daemon 恢复 | 依赖每一种 daemon 死法都被修好;1757 反例证明两腿独立;teardown 腿仍无收敛保证 |
| C3 放宽 lease 阈值 / Bridge 代续心跳 | 掩盖真死,把「确定 blocked」变成「更久才 blocked」,不消灭不动点 |
| C4 held 后由 done-thread-archiver 强行归档 | 表皮修:Linear Done / worktree / husk 都还挂着,机器账不平,且与 FLY-1832 合同冲突 |
