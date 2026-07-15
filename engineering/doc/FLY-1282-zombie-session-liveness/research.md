# FLY-1282 僵尸 session 探真修复 — 调研

Issue: FLY-1282 (https://linear.app/geoforge3d/issue/FLY-1282/fix-bridge-会话状态说谎tmux-窗口已死仍报-running-重启后监控已重新接管是假接管-存活判定必须探真-pane2026)
日期: 2026-07-15
基于: exploration.md(brainstorm gate 已获 Lead 批准,两个拍板点均确认:复用 failed 不新增 lost 终态;告警走现有 lead_events guardrail 通道)

## 1. 改动落点总览

全部改动集中在 `packages/teamlead/src/`,核心是 `HeartbeatService.ts` 的 readopt 消费逻辑;探测器(tmux-lookup.ts)不改,只新增一个组合函数。

| # | 文件 | 改动 |
|---|---|---|
| 1 | `HeartbeatService.ts` | tri-state 探活消费 + 僵尸宣告 + 未推送检查调用 + reestablished 证据 |
| 2 | `bridge/tmux-lookup.ts` | 无改动(现有 `probeRunnerProcessLiveness` / `probeTmuxServer` 够用) |
| 3 | 新 `bridge/worktree-inspect.ts` | 只读 git 检查(untracked/modified/unpushed + 文件路径清单) |
| 4 | `bridge/lead-runtime.ts` | `GUARDRAIL_EVENT_TYPES` 加 `session_zombie_detected` |
| 5 | `bridge/EventFilter.ts` | 新 rule:`session_zombie_detected` → high |
| 6 | `bridge/hook-payload.ts` | `HookPayload` 加可选 `liveness_probe` / `unpushed_work` 字段(event_type 是开放 string,无 union 要改) |
| 7 | `bridge/plugin.ts` | 无新 wiring(HeartbeatService 已注入 transitionOpts/notifier;新逻辑全在服务内部) |
| 8 | 测试 | `HeartbeatService` 相关测试 + 回退哨兵 |

## 2. 现状代码事实(逐条核实过)

### 2.1 探测器(不改)

- `probeRunnerProcessLiveness(tmuxWindow)` (`tmux-lookup.ts:371`):4 态 `alive | dead_pin | absent | indeterminate`,读 `#{pane_dead}`。`absent` 仅在 tmux 明确报 "can't find window/session / no server running" 等证明性消息时返回(`isTmuxAbsenceMessage`)。
- `probeTmuxServer(runTmux)` (`tmux-lookup.ts:270`):3 态 `up | down | unknown`(list-sessions)。
- `lookupTmuxTarget(execId, project)` (`tmux-lookup.ts:164`):`found | gone | error` 三态,error=CommDB 读失败。

注意:`absent` 包含 "no server running"——server 整个死时所有窗口都 absent。这就是宣僵尸必须先验 `probeTmuxServer()==="up"` 的原因(exploration §4.2 条件 2),否则绕过 FLY-1082 server-loss 的成组处理。

### 2.2 现状消费(要改的病灶)

`isSessionTmuxAlive(session)` (`HeartbeatService.ts:921-946`) 返回 boolean:

```
lookup gone          → false   (保持)
lookup error         → true    ← 病灶:无证据被当 alive
probe alive          → true    (保持)
probe indeterminate  → true    ← 病灶:无证据被当 alive
probe dead_pin/absent→ false
probe throw          → true    ← 病灶(同 indeterminate)
```

readopt 消费 (`reconcileCandidateReadopt`, `HeartbeatService.ts:702-749`):
- `alive===true` → `enterReconnecting()`:每 cycle `updateHeartbeat()`(续命)+ 首次发 `session_monitoring_reestablished`(庆祝)。
- `alive===false` → 静默 `clearReconnecting()`,不转态不告警,等 `reapOrphans`(orphanThreshold 默认 60min,`config.ts:42-46`)force-fail 成 failed。

`enterReconnecting()` (`HeartbeatService.ts:785-817`)、`emitMonitorLostOnce()` (`HeartbeatService.ts:881-898`,legacy 路径专用,readopt 路径现在不用)。

### 2.3 事件投递链(复用,不新建)

`RegistryHeartbeatNotifier.deliverHook()` (`HeartbeatService.ts:2096-2179`):resolve lead runtime → `appendLeadEvent`(lead_events 持久化)→ `runtime.deliver` → guardrail 失败记 `recordDeliveryFailure` 由下一 cycle `retryUndeliveredGuardrailEvents()` 重投(max 3-5 次)。`session_zombie_detected` 进 `GUARDRAIL_EVENT_TYPES`(`lead-runtime.ts:18`)即自动获得可靠投递;`RETRYABLE_LEAD_EVENT_TYPES` 是 guardrail 超集,自动包含。

`EventFilter`(`bridge/EventFilter.ts:20-157`)只做 priority 注解;新 rule 放 `session_stuck` 同段,priority high。

命名核实:`zombie_session_backlog`(`bridge/kind-contract.ts:182`)是 FLY-1066 infra-alert Hub 的跨 Lead 积压 kind,与本单无关且通道不同(alert hub vs lead_events);新事件命名 `session_zombie_detected` 无冲突,且与 `session_*` 家族一致。kind-contract 不需要改(它管的是 AlertEventType,不是 lead_events event_type)。

### 2.4 状态转换

`applyTransition()` (`applyTransition.ts:42`):FSM 校验 → persistTransition → onTransition hook(FLY-907 display refresh 自动跟上,zombie 转 failed 后 issue 标题自动刷新,不需要额外处理)。`reapOrphans` 用 trigger `orphan_reap` 转 failed(`HeartbeatService.ts:1795-1810`)——running→failed 是 FSM 合法边,zombie 用同边不同 trigger `zombie_reap`。`transitionOpts` 不存在时(旧测试)fallback `store.forceStatus`,与 reapOrphans 同款。

### 2.5 未推送工作素材

- `sessions.worktree_path` 生产可靠(事故 session fe00ae3e 就有 `/Users/xiaorongli/Dev/flywheel-FLY-1260`)。
- Session 类型里 `worktree_path?: string`;缺失 → 告警写 "worktree unknown" 照发。
- git 检查(新 `bridge/worktree-inspect.ts`,execFile + 5s timeout + cwd 校验存在):
  - `git status --porcelain` → 行分类计数 + 前 N 条文件路径(Lead 要看到路径,gate 强调);
  - `git rev-parse --abbrev-ref HEAD` → branch;
  - `git log @{u}..HEAD --oneline` → 未推 commit;无 upstream(exit≠0 且 stderr 含 "no upstream")→ fallback `git log --oneline -n 20` 计数并标注 "no upstream, N local commits"。
  - 任何失败 → `{ ok:false, error }`,告警文案降级为「未推送检查失败(<error>),请人工查看 <worktree_path>」——检查失败绝不吞告警。

### 2.6 触发面与节奏

- 心跳来源:runner 事件(`DirectEventSink.ts:1096`、`event-route.ts:463`)+ readopt 续命(`HeartbeatService.ts:798`)。窗口死 → 前两个源停。
- 候选集:`getOrphanSessions(stuckThreshold=15min)`(running + heartbeat stale)∪ `reconnecting` 成员(每 cycle 重新处理,`reconcileMonitorLossReadopt`)。
- heartbeat cycle:`intervalMs` 生产 60s。
- 时延推算:re-adopt 成员死亡 → ≤1 cycle 进入探测 → 连续 2 次 absent → **~2-3 分钟宣告**;非 reconnecting 的 running 死亡 → 15min(stale)+2 cycle → **~17 分钟宣告**。均满足验收「N 分钟内」。事故场景(FLY-1260)属于前者。

### 2.7 交互边界(逐个确认不碰)

- **crash reaper(FLY-720)**:只 claim `dead_pin`。tri-state 把 dead_pin 映射为「非 alive 非 absent」——保持现状返回路径(不庆祝不续命,留给 reaper)。宣僵尸只对 `absent`。
- **server-loss(FLY-1082)**:`serverLoss.check()` 在 reconcile **之后**跑。宣僵尸前置 `probeTmuxServer()==="up"` 守卫;server down/unknown → 本 cycle 不宣告(计数器也不推进),交给 server-loss 分组。server probe 每 cycle 只跑一次(缓存在 pass 级局部变量,只有出现 absent 候选才探)。
- **stuck confirm 层(FLY-1234)/quiet 分类(FLY-626)**:不碰——它们管 session_stuck advisory;zombie 是状态转换,层级不同。
- **FLY-1264 reconnect title**:zombie 宣告走 applyTransition → FLY-907 onTransition hook 自动刷 issue 标题;`clearReconnecting()` 在转态后调用(清 title set)。顺序:先转态再 clear(clear 内部读 store.getSession 拿到的已是 failed,`stampReconnect("clear")` 走 issueDisplayRefresh canonical 路径,行为正确)。
- **awaiting_review keep-alive(FLY-191/887)**:候选集只含 status=running;awaiting_review 的 idle runner 不进 zombie 通路。三段式 parked phase(design_done 等)status 也是 running?——核实:parked keep-alive 阶段 session status 仍为 running,但其窗口活着(探测 alive → re-adopt/无事)。窗口真死的 parked phase 被宣僵尸是**正确行为**(它已经死了,keep-alive 已失效)。
- **legacy 路径**:`FLYWHEEL_HEARTBEAT_READOPT=0` 的 `reconcileMonitorLossLegacy` 完全不动(其 boolean 语义保留;FLY-172 行为字节不变)。

## 3. 回退设计

`FLYWHEEL_ZOMBIE_RECONCILE`(每 cycle 读,默认 ON;`=0` 回退):

- OFF 时:`probeSessionLiveness` 结果折叠回旧 boolean 语义(`alive|indeterminate→旧 true 路径`,`dead→旧 false 路径`),不宣僵尸、不发新事件、reestablished 不带新字段、indeterminate 照旧庆祝——**逐字节回归**(哨兵测试:OFF 下对 indeterminate 候选断言 enterReconnecting 被调 + reestablished 发出 + payload 无 liveness_probe)。
- `FLYWHEEL_LIVENESS_PANE_DEAD=0`(FLY-720 逃生口)优先级更高:它把探测退回窗口存在性 boolean,此时 tri-state 输入天然缺失,zombie 通路自动只对「窗口不存在」生效(absent 语义一致,可组合,不需要特判——window-existence 探测的 catch 分支返回 false 会被映射为??)。→ 组合行为在 plan 里定死:PANE_DEAD=0 时 zombie 通路也整体 OFF(最保守,避免语义混线)。

## 4. 测试面

- 既有:`packages/teamlead/src/__tests__/HeartbeatService.test.ts`(含 readopt/monitor-loss 大量用例,mock store + fake notifier + 注入 monitorReconcile deps 的模式直接复用);`isSessionTmuxAlive` 无直接导出,经由行为测。
- 新增单测:
  1. tri-state 分派:alive→庆祝+续命;indeterminate/CommDB error→monitor-lost advisory、无庆祝无续命、suppression 生效(checkStuck/reapOrphans skip);absent×1→无动作(计数 1);absent×2→applyTransition(failed, zombie_reap)+事件含证据与未推送清单;absent→alive 交替→计数清零。
  2. server down 时 absent 不宣告、不推进计数。
  3. dead_pin 不宣告(crash reaper 分工)。
  4. worktree-inspect:git 失败→告警仍发(降级文案);正常→路径清单进 payload。
  5. 回退哨兵:ZOMBIE_RECONCILE=0 逐字节旧行为;PANE_DEAD=0 → zombie 整体 OFF。
  6. reestablished payload 含 liveness_probe 且仅 alive 发。
- 真机 E2E(验收,Lead 三点强调之三):kill window → bridge-only restart → 断言无 reestablished + 收到 zombie 告警(lead_events 行 + Discord)+ /api/sessions 非 running;对照组活 runner 正常 re-adopt。QA 由独立 session 做(FLY-1211 硬门),本 runner 提供重演脚本。

## 5. 风险

1. **误杀窗面**:absent 需要 tmux 明确证明 + 连续 2 cycle + server up,三重防护;瞬时 tmux 抖动(timeout)只会产生 indeterminate(不推进计数)。残余风险:窗口被人工 kill 后 runner 进程其实还活着?——不可能,runner 进程就在 pane 里,窗口没了进程即收 SIGHUP。
2. **告警噪音**:每僵尸恰好一次(状态转 failed 后离开 running 候选集,天然幂等);Bridge 重启后不重发(status 已非 running)。
3. **indeterminate 长期驻留**:CommDB 持续报错的 session 永远停在 monitor-lost advisory(一次性)+suppression——与 FLY-172 legacy 同等待遇,不比现状差且不再谎报庆祝;真死后一旦 CommDB 可读即进入 absent 通路。
4. **性能**:server probe 仅在出现 absent 候选的 cycle 触发一次;worktree git 检查仅在宣告时刻跑(每僵尸一次),5s timeout。
