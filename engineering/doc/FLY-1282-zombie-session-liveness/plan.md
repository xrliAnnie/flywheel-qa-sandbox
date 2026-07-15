# FLY-1282 僵尸 session 探真修复 — 实施计划

Issue: FLY-1282 (https://linear.app/geoforge3d/issue/FLY-1282/fix-bridge-会话状态说谎tmux-窗口已死仍报-running-重启后监控已重新接管是假接管-存活判定必须探真-pane2026)
日期: 2026-07-15
基于: research.md(exploration.md 经 brainstorm gate 批准)+ Codex design review R1(7)+ R2(4)+ R3(5)+ R4(4)+ R5(4)反馈全采纳(v6)

## 0. 不变式(实现全程持守)

- **INV-1(GEO-374 + 诚实文案)**:`indeterminate` / CommDB `error` 永不导致 reap/转态——只降级为 advisory + suppression;**advisory 文案不得含 alive / working / no action needed**(现行 monitoring_lost 文案宣称 "alive and working",indeterminate 路径必须用条件化诚实文案);也永不庆祝(reestablished)、永不续命(updateHeartbeat)。
- **INV-2**:`session_monitoring_reestablished` 只在 pane 探测返回真 `alive` 时发,payload 必带 `liveness_probe`;文案只陈述 `probedAt` 时点事实,**不做任何无条件未来承诺**;**绝不声称 "restart"**(2026-07-15 16:14Z 实证:三条 reestablished 声称 restart 而 Bridge 7.9h 未重启——触发条件只是 heartbeat 陈旧,与重启无关,套话必须移除);同 pass ≥3 会话同时进入 reconnecting → payload 带 `concurrent_reestablished` 计数 + loud log「疑似监控侧断流而非 runner 侧」。
- **INV-3**:僵尸宣告 = pane 探测连续 2 个 **server-up** cycle `absent`(server-up 证明**紧邻每个候选自己的 absent probe**,不跨候选缓存——R2 #2)+ 慢取证后**重证明 = 对 fresh session 完整重跑 `probeSessionLiveness`(含 fresh CommDB lookup,防救援换窗后误杀新窗口——R3 #3)要求 verdict 仍 `dead` + 紧邻复探 server up**,`last_error`/payload 用 fresh target/probedAt + 同步 `applyTransition().ok === true`。server down/unknown 的 absent **不推进计数**(重置为 0)。
- **INV-3b(确认窗保护 + liveness 链串行化,R4 #4 收窄)**:任何本 cycle 判为 `dead` 但尚未完成僵尸决策的 session,当 cycle 必须屏蔽 session_stuck 与 generic orphan force-fail;屏蔽集合由本次 pass 持有并按参数线程化。**单飞范围 = liveness 依赖链三阶段(reconcileMonitorLoss + checkStuck + reapOrphans)作为一个 guarded 单元**,不罩全 `check()`:guard 命中(上一 liveness pass 仍在跑)→ 本 tick 三阶段整体跳过(计数+日志),`dispatchMaintenanceTick`(位于 guard 之外,FLY-1185 合同不动)、retryUndelivered、server-loss、crash reaper、staleCompleted、parkedPhases、reviewTimeout **照常运行**——一个悬挂的 liveness pass 不会冻结其余检测。单一 liveness pass 在飞 → reconcile 无并发写者 → streak 陈旧恢复竞态(R3 #2)结构性消除。伴随:pass duration + skipped-tick 计数日志,in-flight >10 分钟每 tick 响亮 warn。OFF 时无 guard,现行重叠语义字节保留(M0 golden)。
- **INV-4**:未推送检查只读、失败不吞告警(降级文案照发)、绝不自动 commit/push;告警含文件路径清单。
- **INV-5(回退)**:`FLYWHEEL_ZOMBIE_RECONCILE=0` 或 `FLYWHEEL_LIVENESS_PANE_DEAD=0` 时,readopt 消费行为与现行 HEAD 逐字节一致——以**先于重构在 HEAD 上固化的 golden 断言**(notifier 调用参数 + HookPayload JSON + arity + heartbeat/state 副作用)锁死,并反断言 OFF 时零 server probe、零 worktree inspection、零新事件。
- **INV-6(分工)**:`dead_pin` 归 crash reaper、`gone` 归 orphan 老化、server down 归 server-loss(FLY-1082);zombie 只吃 server-up 下的 `absent`。**verdict 变为 dead_pin/gone 时必须清掉本机制此前留下的 suppression 标记**(notifiedMonitorLost / streak),把 session 释放还给原 owner。
- **INV-7**:legacy 路径(`FLYWHEEL_HEARTBEAT_READOPT=0` 的 `reconcileMonitorLossLegacy`)零改动。
- **INV-8(告警持久先于依赖状态 + 完整投递生命周期)**:`session_zombie_detected` 是 guardrail;转态成功后事件必须**先落 lead_events**(可解析 Lead 时)再尝试 transport;投递生命周期与现有 deliverHook **完全同构**(成功 → `markLeadEventDelivered`;false/throw/runtime 缺席 → `recordDeliveryFailure` 留可重试行;chat_channel / chat_thread_id / filter_priority / buildSessionKey 全 parity——R2 #3,经共享 helper 保证)。runtime 缺席交现有 retry(每轮重新 getForLead)。连 Lead 都解析不到 → session_events 审计行 + 响亮 error log,绝不静默。
- **INV-9(转态→告警持久的窗口,R2 #4 + R3 #4 + R4 #1/#2/#3 + R5 #1/#3/#4)**:投递准备经**两阶段 notifier 合同**前置——同步 `prepareSessionZombieDetected(...)`(notifier 内部完成全部 store/registry/filter 读取,封装确定性 event_id;lead 不可解析 → null)在**转态之前**调用;**任何持久 mutation 都不得先于转态**(null 路径的审计行也在转态成功之后写,R5 #1);转态成功后第一条持久动作 = 非 null 路径 `persistPreparedZombieDetected(prepared)` 的 appendLeadEvent / null 路径的确定性 session_events 审计行(`zombie-alert-unroutable-<execId>`,UNIQUE 去重)。残余 hard-crash 窗口由**独立 backfill 阶段闭合**(R5 #4:位于 `check()` 中 retryUndelivered 旁、**不在 liveness guard 内**,自带 single-flight;liveness 链悬挂时 backfill 照跑):SQL 直接以 `NOT EXISTS lead_events(event_id)` 过滤已完成项、`execution_id ASC` 稳定序 + watermark 轮转公平扫描(R5 #3,parked watermark 先例;无时间淘汰——终止条件就是事件行存在,poison 行每 wrap 尝试一次并 loud log,不霸占其他行的预算;prepare 返回 null 的行**也在转态已 failed 的前提下补写确定性 unroutable 审计行再推进**,R6 #2——crash-in-null-gap 由此闭合)。门控 = 统一谓词 `zombieMachineryEnabled() = readoptEnabled() && zombieReconcileEnabled()`(READOPT=0 / ZOMBIE=0 / PANE_DEAD=0 均零查询,INV-7 保持)。**投递保证的精确表述(R6 #3)**:anti-join 终止条件证明的是「已持久入队」(lead_events 行存在),不是「Lead 已收到」——transport 走现有 guardrail 有界重试(MAX_DELIVERY_ATTEMPTS=3;打穿预算后行留 undelivered + last_error,由既有 FLY-83 stuck-alert 边界兜底,本单不新设计 exhausted-delivery 恢复)。

## 1. 改动清单

### 1.1 新文件 `packages/teamlead/src/bridge/worktree-inspect.ts`(R1 #6 修订)

```ts
export interface WorktreeInspection {
	ok: boolean;                // 至少一个子查询成功
	worktreePath?: string;
	branch?: string;
	untracked?: string[];       // cap 10
	modified?: string[];        // cap 10(staged/deleted/renamed 归此类)
	untrackedTotal?: number;
	modifiedTotal?: number;
	unpushedCommits?: number;
	unpushedSemantics?: "vs_upstream" | "not_on_any_remote";  // R1 #6:无 upstream 时语义显式标注
	warnings?: string[];        // 每条 cap 200 字符,最多 5 条
	error?: string;             // 全部失败时的原因(cap 200)
}
export type ExecFileFn = typeof execFileAsync;
export async function inspectWorktreeForUnpushedWork(
	worktreePath: string | undefined, execFileFn?: ExecFileFn,
): Promise<WorktreeInspection>
```

- path 缺失/非目录 → `{ ok:false, error:"worktree path unknown or missing" }`。
- **每个子查询独立 try**(R1 #6:一个失败不丢弃其他已成功字段,失败进 warnings):
  1. `git status --porcelain=v1 -z --untracked-files=all` → **NUL 分隔解析**(处理 rename 双记录、特殊字符路径、嵌套新目录逐文件展开);`??` → untracked,其余 → modified;
  2. `git rev-parse --abbrev-ref HEAD` → branch;
  3. upstream 存在性用 `git rev-parse --abbrev-ref --symbolic-full-name @{u}` 的 **exit code** 判断(不依赖 locale stderr 文本);存在 → `git rev-list --count @{u}..HEAD`(`vs_upstream`);不存在 → `git rev-list --count HEAD --not --remotes`(`not_on_any_remote`)。
- 每 git 调用 5s timeout,**函数总预算 10s**(超时后带已得字段返回);永不 throw。

### 1.2 `HeartbeatService.ts` — tri-state 探活 + 僵尸宣告

**(a) `probeSessionLiveness(session)`**(由 `isSessionTmuxAlive` 内部重构抽出,同 lookup/probe 调用与日志;`isSessionTmuxAlive` 保留薄壳给 legacy/OFF 路径):

```ts
type SessionLivenessVerdict = "alive" | "dead" | "indeterminate" | "dead_pin" | "gone";
interface SessionLiveness { verdict: SessionLivenessVerdict; target?: string; probedAt: string; }
```

映射:CommDB gone→`gone`;CommDB error→`indeterminate`;probe alive→`alive`;probe indeterminate/throw→`indeterminate`;probe absent→`dead`;probe dead_pin→`dead_pin`。

**(b) server-up 证明(R2 #2:不缓存,紧邻探测)**:每个 dead 候选在自己的 absent probe **之后立即**跑一次 `probeTmuxServer()`(absent 是稀有异常路径,per-candidate 成本可接受;彻底消除跨候选/跨慢取证的陈旧 verdict)。无任何 pass 级 server 缓存。

**pass-owned suppression(R2 #1)+ liveness 链单飞(R3 #2 + R4 #4 收窄)**:`reconcileMonitorLoss()` 返回本 pass 的 `zombieHeld: ReadonlySet<string>`(pass-local 变量收集,**非 class field**),`check()` 按参数线程化给同 pass 的 `checkStuck(zombieHeld)` 与 `reapOrphans(deadPinOwned ∪ serverLossOwned, zombieHeld)`。**单飞 guard 只罩 liveness 三阶段**:`zombieMachineryEnabled()`(= `readoptEnabled() && zombieReconcileEnabled()`,与 backfill 同一谓词——R6 #1:`READOPT=0` 时 legacy reconcile/checkStuck/reap 链**无 guard、不串行化**,现行重叠语义保留并进 M0 overlap 测试)为真时,`check()` 内 reconcileMonitorLoss+checkStuck+reapOrphans 作为一个 guarded 块(`livenessChainInFlight` flag,try/finally 释放);guard 命中 → 三阶段本 tick 跳过(`skippedLivenessTicks++` 日志),**`dispatchMaintenanceTick`(guard 之外,现有位置不动)与 retryUndelivered/server-loss/crash reaper/staleCompleted/parkedPhases/reviewTimeout 照常跑**(R4 #4:悬挂的 liveness pass 不冻结其余检测);in-flight >10 分钟 → 每 tick 响亮 warn。单一 liveness pass 在飞 → streak 无并发写者,「陈旧 absent 恢复→提前宣告」竞态(R3 #2 反例)结构性消除。guard 内新增 await 全部有界(pane/server probe 5s、git 总预算 10s、backfill ≤1 行/pass);既有 deliver-hang 风险量级不变(今天就会拖住当 pass),且从「pass 无限叠加」变为「跳 tick + 可观测」。OFF → 无 guard,现行重叠语义逐字保留。
**`seedReconnecting()` 返回合同不变(R3 #1)**:保持 `Promise<string[]>`(FLY-1264 boot title ids,`plugin.ts` 的 `bootReconnectExecutionIds` → `restoreReconnectTitles()` 消费链不动);内部 candidate 处理产出的 boot zombieHeld 在 seed 结束时**明确丢弃**(boot 后第一个 check() 重新探测),不改公共签名。

**跨 cycle 状态(class fields)**:
- `zombieDeadStreak: Map<string, number>`(连续 server-up absent 计数;单飞后无并发写者;**每 pass 随 notifiedMonitorLost 一起对退出 stale∪reconnecting union 的 execId prune**——R3 #2:退出再进入从 1 重计);
- `zombieDeclaring: Set<string>`(per-exec in-flight 防重入,R1 #4;单飞后为纵深防御保留);
- `livenessChainInFlight: boolean` + `skippedLivenessTicks: number` + `livenessPassStartedAt`(单飞 guard + 可观测性);
- `zombieBackfillWatermark: string` + `backfillInFlight: boolean`(backfill 独立阶段的公平轮转游标 + single-flight guard,R5 #3/#4)。

**(c) `reconcileCandidateReadopt` 消费(zombie ON;marker-first/quarantine 结构不动)**,每 verdict 的**完整清理表**(R1 #2):

| verdict | 动作 | streak | notifiedMonitorLost | reconnecting | zombieHeld(pass-local) |
|---|---|---|---|---|---|
| alive | `enterReconnecting(session, liveness)`(带证据) | 清 | **清**(结束旧 monitor-lost episode) | 加入 | — |
| indeterminate | `emitMonitorLostOnce(session, { unverified:true })`(诚实文案) | 清 | 加入(其内部) | 保持现状(不清不加) | — |
| dead + 紧邻 server probe=="up" | streak++;≥2 → `declareZombie`;<2 → 仅 suppression | ++ 或宣告成功后清 | 宣告成功后清 | 宣告经 clearReconnecting 清 | **加入**(除非宣告已成功转态) |
| dead + server down/unknown | 归 FLY-1082;仅 suppression | **重置 0**(R1 #3) | 不动 | 不动 | **加入** |
| dead_pin / gone | 释放给 crash reaper / orphan 老化 | 清 | **清**(R1 #2:释放 owner) | clearReconnecting | — |

quarantine 分支(R1 #1):`applyQuarantineFallback` 加可选 `liveness?: "alive" | "indeterminate"`——`indeterminate` 时 leave-running 分支日志改为诚实的 "tmux liveness indeterminate — leaving running (no fallback mutation)",不再借 `tmuxAlive:true` 的 "tmux alive" 日志表达;boolean 参数与缺省行为对既有调用者字节不变。其后 enter/clear 决策同上表。

**(d) `declareZombie(session, liveness, streak)`(R1 #4/#5 + R2 #4「先取证、后重证明、转态紧贴落盘」全序)**:

1. `zombieDeclaring` in-flight guard(已在 → return;finally 释放);
2. **先做慢取证**:`inspectWorktreeForUnpushedWork(session.worktree_path)`(总预算 10s)——放在任何 mutation 之前(INV-9);
3. **重证明 = 完整重跑**(R3 #3):fresh `store.getSession(execId)` 仍 `running` + **`probeSessionLiveness(freshSession)` 全量重跑(含 fresh CommDB lookup)verdict 仍 `dead`**(救援期间换窗 → fresh lookup 指到新活窗 → alive → abort)+ 紧邻复探 `probeTmuxServer()` 仍 `"up"`——任一不成立 → 放弃(清 streak 从头计,保留本 cycle zombieHeld suppression),return;后续 `last_error`/payload 一律采用 **fresh** target/probedAt;
4. **投递准备 = 两阶段 notifier 合同的 prepare 半程**(R4 #1 + R5 #2 + R6 #4):`prepared = notifier.prepareSessionZombieDetected(freshSession, evidence, inspection)`(**用第 3 步重证明的 freshSession**,不用陈旧入参),其中 `evidence: { kind:"verified", liveness, streak } | { kind:"unparseable", rawLastError }`(初次宣告永远传 verified;union 是 backfill malformed 分支的诚实表达——unparseable 生成降级 context、**无** liveness_probe/target/probed_at);**同步**,notifier 内部完成 labels/`resolveLeadForIssue`/`getForLead`(可 undefined)/chat_thread/EventFilter classify/`buildSessionKey`/HookPayload/确定性 `event_id = "zombie-<execId>"` 全部读取与封装;lead 不可解析 → null(**此处只返回,不写任何持久层**,R5 #1);
5. **同步转态**(prepare 与转态之间零 await):`applyTransition(..., "failed", { trigger:"zombie_reap" }, { last_activity_at: now, last_error: formatZombieLastError(freshTarget, streak, freshProbedAt) })`——`last_activity_at: now` 是 backfill 的时间锚(R4 #2,镜像 reapOrphans 字段);**检查 `result.ok`**——`!ok` → 响亮 error log、不发事件、**绝不 forceStatus 覆盖**(forceStatus 仅留无 transitionOpts 的 legacy test seam),return;
6. **转态后第一条持久动作**(INV-9 + R5 #1):非 null → `persisted = await notifier.persistPreparedZombieDetected(prepared)`(第一条同步 store mutation 就是 appendLeadEvent,之后才 await transport;转态→append 之间零 resolve/零二次 store 读,repo fake 与 M3 断言);null → 响亮 error log + `store.insertEvent` 确定性审计行(`event_id = "zombie-alert-unroutable-<execId>"`,UNIQUE 天然去重,recurring 重试不重复落行)——**两条路径的持久写都严格在转态成功之后**;
7. cleanup:clearReconnecting、清 streak / notifiedMonitorLost。

**recurring 有界 backfill(R3 #4 + R4 #2/#3 + R5 #3/#4,闭 hard-crash 缺口)**:`check()` 中 retryUndelivered 旁的**独立小阶段** `reconcileZombieAlertBacklog()`——**不在 liveness guard 内**(liveness 链悬挂时 backfill 照跑,R5 #4),自带 `backfillInFlight` single-flight 与 try/catch;门控 = **同一个 per-tick 捕获的 `zombieMachineryEnabled()` 谓词**(与 liveness guard 共用一次读取,R7 #4;READOPT=0 / ZOMBIE=0 / PANE_DEAD=0 → **零查询**,INV-7 保持;首个 boot 后 tick 即覆盖旧账):
- 新 StateStore 只读查询 `getZombieAlertBacklog(afterExecutionId, limit)`:status=failed + last_error 以 zombie: 开头 + **SQL `NOT EXISTS`(lead_events 按 `'zombie-'||execution_id` 反连接,已补发行直接不可见)** + `execution_id > watermark`,**`execution_id ASC` 稳定序(非时间序)**,LIMIT 小批(R5 #3:公平性来自 watermark 轮转,parked watermark 先例——每 pass 处理 ≤1 行后推进 watermark,批尾 wrap 回空串,>N 行也最终全覆盖,poison 行不霸占 slot);
- 命中行 → 用**同一对 prepare/persist** 补发(**不再转态**;evidence 经 `parseZombieLastError` 解析进 union 输入,malformed → `{kind:"unparseable"}` 降级分支;inspection 重跑 best-effort);**prepare 返回 null → 补写确定性 `zombie-alert-unroutable-<execId>` 审计行(session 已 failed,安全)再推进 watermark**(R6 #2/R7 #4);补发失败 → loud log + watermark 照常推进(下一 wrap 重试),绝不阻塞其他行与主流程;
- 诚实边界(INV-9/R6 #3):门控 ON 且 Bridge 运行期间每 tick 推进,直至**持久入队**(lead_events 行存在)——transport 归现有 3 次有界 guardrail 重试 + FLY-83 兜底,本机制不声称 Lead 已收到;停机/OFF 暂停;永久不可路由的行每 wrap 尝试一次并 loud log(无时间淘汰,不静默)。

**(e) reestablished 通知改两步聚合(R7 #1,Lead f53f69c0 证据的可实现形态)**:zombie-ON 时 `enterReconnecting(session, liveness)` 只做 bookkeeping(heartbeat 刷新、reconnecting/title 集合),**新进 episode 时返回 notice intent(不立即发)**;`reconcileMonitorLossReadopt` 收集本 pass 全部 intents,处理完所有候选后计算最终 `k`,`k ≥ 3` → 一次 cohort loud log + 每条 notice 附同一个 `concurrent_reestablished: k`,随后统一 flush。**flush 逐条前重验 ownership(R8 #1)**:该 execId 必须**仍在** `reconnecting`(真实事件已 `clearReconnecting()` → 该 episode 已结束,**整条 notice 跳过**——既不发事件也不盖 ⚠️ 标题,避免把已恢复的标题盖回重连中);`stampReconnectTitle` 同样在 flush 时刻按 `reconnectTitleActive` 现值决定。**flush 逐条包 try/catch(R8 #2,保持现行 enterReconnecting 的 best-effort 语义)**:单条 advisory 失败只 log,不中断后续 notices、不影响 liveness 链继续、不影响 seedReconnecting 的 `string[]` 返回。测试补:intent 收集后、flush 前真实事件 clearReconnecting → 该条零事件零标题重盖;首条 flush throw → 其余照发。`seedReconnecting` **同样走聚合**(boot 恰是 cohort 最常见场景;其返回 `string[]` 合同不变——聚合发生在内部 pass 收尾)。OFF → 现行立即发射路径字节保留(M0 golden)。测试:2 vs 3 entrants(<3 无 count 字段);alive/indeterminate/dead 混合只数新进 reconnecting 者;已在 reconnecting 的成员不计数;同 cohort 每条 payload 同一最终 count;恰一次 cohort log。

**(f) `emitMonitorLostOnce(session, details?)`** 加可选二参(arity sentinel,FLY-1234 先例):readopt-indeterminate 传 `{ unverified:true }`;legacy 路径保持无 details 调用,字节不变。

**(g) 开关**:`zombieReconcileEnabled()` = `FLYWHEEL_ZOMBIE_RECONCILE !== "0" && FLYWHEEL_LIVENESS_PANE_DEAD !== "0"`(每 cycle 读)。OFF → 走现行 `isSessionTmuxAlive` boolean 分支,字节不动。

### 1.3 Notifier(R1 #1/#5 修订)

- `HeartbeatNotifier` 接口(R4 #1 两阶段合同 + R5 #2 evidence union):
  - 新必选 `prepareSessionZombieDetected(session, evidence: ZombieEvidence, inspection): PreparedZombieNotification | null`(**同步**;完成全部 store/registry/filter 读取;lead 不可解析 → null,不写持久层);`ZombieEvidence = { kind:"verified", liveness, streak } | { kind:"unparseable", rawLastError }`——只有 verified 生成 `liveness_probe`,unparseable 生成降级 context/flag 且无 target/probed_at/consecutive_probes;
  - 新必选 `persistPreparedZombieDetected(prepared): Promise<boolean>`(第一条同步 store mutation = appendLeadEvent,随后才 await transport;返回「已持久化」);
  - `PreparedZombieNotification` 携带 eventId/payload/sessionKey/lead(agentId/chatChannel)/runtime(可 undefined)——或等价 opaque persist 闭包;repo 内 fake 一并补;
  - `onSessionMonitoringLost(session, minutes, details?: { unverified?: boolean })` 加可选三参。
- **last_error codec**:`formatZombieLastError(target, streak, probedAt)` / `parseZombieLastError(s)` 单一配对(独立小模块或 notifier 同文件导出,单测覆盖 round-trip + malformed)。
- **共享投递 helper(R2 #3 + R3 #5 throw 策略参数化)**:从 `deliverHook` 抽 `appendAndDeliver(lead, runtime | undefined, session, hookPayload, opts: { onDeliverThrow: "propagate" | "record" }): Promise<boolean>`,完整承载现有生命周期——设 `chat_channel`、按 `chatThreadsEnabled` 解析 `chat_thread_id`、EventFilter classify 注 `filter_priority`(caller-context 保留)、`buildSessionKey(session)`、`appendLeadEvent`、组 envelope、`runtime.deliver`:**成功 → `markLeadEventDelivered(seq)`**;`delivered:false` → guardrail `recordDeliveryFailure` / advisory mark(现行分支);**throw** → legacy 路径(`"propagate"`)照现行**向调用者传播**(append 行留 attempt=0,不 record、不 mark——R3 #5:现行 deliverHook 无 catch,该语义逐字保留并进 M0 golden);zombie 路径(`"record"`)catch → `recordDeliveryFailure`;`runtime === undefined` → 直接 `recordDeliveryFailure(seq, "no runtime registered")`(仅 zombie 路径会传 undefined)。`deliverHook` 重构为 `resolveWithLead + appendAndDeliver(..., "propagate")`(行为字节不变,M0 golden 含 deliver-throw 的 guardrail/advisory journal+caller 语义)。
- `RegistryHeartbeatNotifier` 两阶段实现(R6 #4 统一命名,persist 与 runtime 拆开,INV-8):
  1. **`prepareSessionZombieDetected(freshSession, evidence, inspection)`**(输入用重证明后的 **freshSession**,不用陈旧入参 session):`resolveLeadForIssue(projects, project, labels)` 解析 lead——失败 → return null;组 HookPayload:`event_type:"session_zombie_detected"`、`status:"failed"`、verified 分支 `liveness_probe:{ method:"tmux_pane_probe", target, result:"absent", probed_at, consecutive_probes }`、`unpushed_work: inspection`、`notification_context`(英文:窗口死证据、已 force-fail、untracked/modified/unpushed 计数+语义、branch、worktree 路径、**文件路径清单**、"Lead decides rescue — NOT auto-committed");`runtime = getForLead(agentId)`(可 undefined)一并封装;
  2. **`persistPreparedZombieDetected(prepared)`** = `appendAndDeliverPrepared(prepared, { onDeliverThrow: "record" })`(R5 #1:接收**已封装**的 eventId/payload/sessionKey/lead/runtime,append 前**零** resolve/classify/query;与 raw 版共享 append→deliver→mark/record 状态机段)——append 即 persisted=true;runtime 缺席/transport 失败/throw 留 undelivered 行,现有 retry 每轮重 getForLead 自动补投(已核实;**打穿 MAX_DELIVERY_ATTEMPTS 后行留 undelivered,由既有 FLY-83 边界兜底**——R6 #3)。event_id 用确定性 `zombie-<execId>`(backfill 幂等键)。
- **StateStore 新增只读查询**(无 schema 变更,R6 #4 单一签名):`getZombieAlertBacklog(afterExecutionId: string, limit: number): Session[]`——status=failed + zombie 标记 + `NOT EXISTS` lead_events 反连接 + `execution_id > afterExecutionId`,`execution_id ASC` 稳定序(**非时间序**),LIMIT;不再有 `hasLeadEvent`(anti-join 覆盖其唯一用途;unroutable 审计去重靠 insertEvent UNIQUE)。配 StateStore 聚焦测试:anti-join 先于 LIMIT、严格 `>` watermark、wrap 行为。
- `onSessionMonitoringLost` 三参且 `unverified` → context 换诚实文案:"Runner <label> lost Bridge monitoring and its liveness could NOT be verified (CommDB/probe indeterminate). No heartbeat was refreshed. Please check it directly via tmux."(无 alive/working/no-action 字样);两参调用 → 现行字节。
- `onSessionMonitoringReestablished` + `details.livenessProbe` → payload `liveness_probe`(+ `details.concurrentCount`(仅 cohort ≥3 时由聚合 flush 传入)→ payload `concurrent_reestablished`);context:"Runner <label> re-adopted — heartbeat age before re-adoption was <N>m; liveness verified at <probedAt> via tmux pane probe (pane_dead=0); monitoring resumed."(**无 restart 声称**——触发条件只是 heartbeat 陈旧,restart 只是可能原因之一,2026-07-15 16:14Z 实证套话说谎;**"age was Nm" 对 boot-seed 的新鲜 heartbeat 会话也为真**——seed 遍历全部 running,不保证 stale,R7 #3;点时事实,无未来承诺);cohort ≥3 → context 追加 "NOTE: <k> sessions re-adopted in the same pass — suspect a monitoring-side interruption rather than runner-side.";缺省(OFF)→ 现行字节。测试补:fresh-heartbeat seed → context 无 restart 字样、无「stale」误断言。

### 1.4 注册

- `lead-runtime.ts`:`GUARDRAIL_EVENT_TYPES` + `"session_zombie_detected"`(FLY-1282 注释)。
- `EventFilter.ts`:新 rule `session_zombie_detected` → `{ priority:"high", reason:"zombie session — tmux window dead while status=running; check unpushed work" }`;现有 `session_monitoring_lost` rule 的 reason 文本改中性("monitoring lost — Runner liveness unverified; Lead should check via tmux")——该字符串仅进 EventFilter 审计日志与 fallback context(monitoring_lost 的 context 始终由 notifier 显式设置,fallback 不触发),声明为接受的全局注解修订,不在 INV-5 golden 范围。
- `hook-payload.ts`:`HookPayload` + 可选 `liveness_probe?` / `unpushed_work?` / `concurrent_reestablished?: number`(观察值注释:同 pass 新进 reconnecting 会话数,仅 ≥3 时出现——R7 #2;测试锁 <3 与 OFF/legacy 路径下该属性**缺席**、qualifying cohort 中每条事件的精确存在与同值)。

### 1.5 不改动(显式)

`tmux-lookup.ts`、crash-reaper、server-loss coordinator、`reconcileMonitorLossLegacy`、quiet/stuck-confirm 层、FSM/StateStore schema、plugin.ts wiring、kind-contract.ts。

## 2. TDD 里程碑(RED→GREEN→REFACTOR)

| M | 内容 | 测试文件 |
|---|---|---|
| **M0(R1 #7,先于一切重构)** | 在当前 HEAD 上固化 OFF-path golden:readopt 各分支(alive / error→true / indeterminate→true / absent→false)的 notifier 调用参数、`JSON.stringify(HookPayload)` 全文(含 notification_context 与属性缺省)、reestablished 三参 arity、heartbeat/state 副作用;**deliverHook 的 `runtime.deliver` throw 语义(guardrail+advisory:向调用者传播、行留 attempt=0 不 record 不 mark——R3 #5)**;**`seedReconnecting()` 返回 `string[]` 与 `restoreReconnectTitles(bootReconnectExecutionIds)` 消费链(R3 #1)**;覆盖 `ZOMBIE=0`、`PANE_DEAD=0`、两者同关、`READOPT=0` legacy 四种组合;**OFF 时无 liveness 链单飞 guard、零 backfill 查询;`READOPT=0` 且 zombie 开关默认 ON 时 legacy reconcile/checkStuck/reap 链重叠 tick 语义逐字保留(不被跳过/不被串行化,R6 #1)** | 新 `__tests__/HeartbeatService.zombie-offpath-golden.test.ts` |
| M1 | `worktree-inspect.ts`:NUL 解析(rename/空格/嵌套新目录)、cap、upstream-exit-code 判定、`vs_upstream` vs `not_on_any_remote` 语义、大 remote 历史+少量本地 commit 计数正确、单子查询失败保留其余字段、总预算、永不 throw | 新 `__tests__/worktree-inspect.test.ts` |
| M2 | tri-state 分派 + 清理表:alive→庆祝+续命+证据+清旧 monitor-lost;indeterminate(probe timeout 与 CommDB error 两源)→ 一次诚实 advisory、无庆祝无续命;absent×1→zombieHeld suppression(**含「非 reconnecting 且 heartbeat 已超 orphanThreshold 的 absent×1 不被 generic reap / 不发 session_stuck」**,R1 #2);absent→alive→absent 交替→计数清零;**indeterminate→dead_pin/gone 后原 owner 可接管(notifiedMonitorLost 已清)**;quarantine-indeterminate 走诚实日志分支 | 新 `__tests__/HeartbeatService.zombie-reconcile.test.ts` |
| M3 | 宣告:server 序列 `down,down,up,up` 与 `unknown,up,up` → 仅在第二个 server-up absent 后宣告(R1 #3);**单飞测试**(R3 #2 + R4 #4):zombie-ON 慢 liveness pass 跨 3 tick → 每 tick `dispatchMaintenanceTick` 照常派发、server-loss/crash reaper/staleCompleted 照常跑、liveness 三阶段不重入、原 pass 结束后下一 tick 恢复(反例序列 A:dead-等待中 B:alive 不可能交错发生);**prepare/persist 边界**(R4 #1):转态→append 之间零第二次 resolve/store 读(fake 记录调用序);**streak prune**(R3 #2):候选退出 stale∪reconnecting union 再进入 → 从 1 重计;**慢取证 server 翻转**(R2 #2):候选 A 慢取证期间 server 转 down → A 重证明紧邻 server probe 得 down → abort、清 streak、零 zombie;**重证明重查 CommDB**(R3 #3):初探窗口 A absent,取证期间 CommDB 映射换到活窗口 B → 重证明 fresh lookup 得 alive → abort、清 streak、零转态零告警;`applyTransition` 返回 `!ok` → 无事件无覆盖(R1 #4);in-flight → 单次宣告;git 慢/失败 → 降级文案照发;**投递生命周期**(R2 #3):即时成功 → undelivered 查询为空、下一 heartbeat 零重投;zombie 路径 deliver throw → 留一条可重试行;runtime 缺席 → undelivered 行 + 注册后补投(R1 #5);chat threads ON 时 payload/sessionKey/envelope 与现有 heartbeat hook parity;lead 不可解析 → session_events 审计行;**recurring backfill**(R3 #4 + R4 #2/#3 + R5 #3/#4):failed+zombie 标记+缺 `zombie-<execId>` 行 → 下一门控-ON tick 补发恰一次(幂等:NOT EXISTS 使已补行不可见、重复 pass 零重发);**公平性**(R5 #3):>N 行 backlog 经 watermark 轮转最终全覆盖;首行 poison(lead 永久不可解析/persist 持续失败)→ loud log + watermark 推进,后续行照常补发;**null 顺序**(R5 #1):prepare 返回 null → 转态仍先行,审计行在转态后写;null→crash / FSM-reject 两条顺序测试 + 重复 null 重试审计去重(UNIQUE);**null crash 恢复**(R6 #2):转态后、unroutable 审计前崩溃 → 下一 backfill 对该行(prepare 仍 null)补写恰一条审计行再推进 watermark,重复 wrap 去重,lead 后来可路由 → 照常产出 `zombie-<execId>` 行;**reestablished 文案**(Lead f53f69c0 实证):golden 断言 context 不含 restart 字样;同 pass ≥3 re-adopt → concurrent 计数进 payload + loud log(监控侧断流疑点);malformed last_error → `{kind:"unparseable"}` 降级补发(payload golden:无 liveness_probe/伪造字段,M4);**门控**(R5 #4):READOPT=0 / ZOMBIE=0 / PANE_DEAD=0 → 零 backfill 查询;liveness 链悬挂跨 3 tick → backfill 独立照跑推进;**故障注入**(R3 #4/INV-9):转态后 append 前崩溃 → 无 false running,后续 tick 补发告警 | 同上 |
| M4 | 注册面:GUARDRAIL 含新事件;EventFilter high;payload 字段(liveness_probe/unpushed_work/文件路径进 context);monitoring_lost 诚实文案(三参)+ 两参字节不变;reestablished 证据字段 + 点时文案;**文案反断言:indeterminate 各来源(CommDB error / pane timeout / quarantine)的 advisory 不得含 alive / working / no action needed**(R1 #1) | 同上 + notifier/EventFilter 既有测试处 |
| M5 | 回退哨兵 = M0 golden 在重构后原样通过 + 反事实断言:OFF 时零 `probeTmuxServer` 调用、零 worktree inspection、零新事件 | M0 文件 |
| M6 | 全仓 `pnpm test` + `pnpm lint` | — |
| M7 | 真机重演脚本 `scripts/qa-fly-1282-zombie-replay.md`:断言**精确 lead_events payload**(liveness_probe/unpushed_work 字段值),非仅 event type 存在(R1 #7) | 文档 |

## 3. 验收(对齐 issue + Lead 三点强调)

1. 真机:起 runner→写未提交文件→kill window→bridge-only restart→不发 reestablished、~2-3 cycle 内 Lead 收到 zombie 告警(lead_events 精确 payload 含文件路径清单)、/api/sessions 非 running。
2. 对照组:活 runner 同批 restart → 照常 re-adopt,reestablished 带 liveness_probe,零 zombie 噪音。
3. 常态:不重启直接 kill 窗口 → stuckThreshold(15m)+2 cycle 内宣告。
4. `FLYWHEEL_ZOMBIE_RECONCILE=0` 回退:golden 哨兵 + 真机抽查。
5. 独立 QA session 执行(FLY-1211 硬门);本 runner 交重演脚本。

## 4. 风险与缓解

- 误杀:absent 证明性消息 + 连续 2 个「absent+紧邻 server-up」cycle + 取证后重证明(running/absent/server-up 三复核)+ FSM ok 检查,五重防护;tmux 抖动只产生 indeterminate。
- 转态成功但通知 transport 失败:lead_events 已落盘,guardrail retry 补投(与 session 状态解耦,R1 #5/R2 #3 关闭)。
- 转态与 lead_events append 之间崩溃:慢 I/O 与投递准备全部前置(INV-9),窗口=同步代码 + 一次 append;hard-crash 残余由独立 recurring backfill(确定性 event_id 幂等 + watermark 轮转)补发,故障注入测试证明无 false running 且门控 ON 运行期间告警**最终持久入队**(transport 归现有有界 guardrail 重试 + FLY-83 兜底,不声称 Lead 必收)。
- in-memory streak 跨重启清零:boot 后重计 2 cycle(~2 分钟),可接受;liveness 链单飞使重入 pass 不存在,streak 无并发写者(R3 #2 竞态结构性消除);**liveness 链可因悬挂 pass 跳过任意多个 interval**(可观测:skipped 计数 + >10min 响亮 warn),其余检测阶段与 backfill 照常运行。
- 多僵尸同批(OOM 夜):每僵尸一条独立告警 = 正确行为;fleet 级 server 死由 server-up 守卫全量挡住,归 FLY-1082。

## 5. 交付物

PR(实现 + 单测 + 本文件夹 3 文档 + 重演脚本),Codex design review APPROVED(本 plan)+ code review + CI 绿 + 独立 QA 真机 PASS 后走 approve gate。

---

# Part B: delivery_unconsumed 对 parked/等待态会话误报(founder 直令折入,Lead 7b0bc331;R10 修订)

## B0. 实证(2026-07-15,生产 gap-scan 日志 + comm.db 直查)

当前探测(`detection-gap-scan.ts` `openGapReader` unconsumed probe):`to_agent=<execId> AND type='instruction' AND delivered_at IS NOT NULL AND read_at IS NULL`,最老 ≥30min → suspicion,**完全不看 session 状态**。今日 3 个现行案例逐条核实:

| execId | issue | status | 事实 |
|---|---|---|---|
| 212eca7e | FLY-1255 | awaiting_review | 3 条 RE-TEST instruction 已全部执行完,read_at 全 NULL |
| f6fb5f10 | FLY-1256 | awaiting_review | 3 条 instruction 已执行,read_at 全 NULL |
| 22094c31 | FLY-1282 | **running** | **本 runner 自身**:f53f69c0/7b0bc331 正在被执行的当下仍在报 unconsumed |

**根缺陷**:消费判据只看 `read_at`,但 mailbox 投递(`send.ts`:mailbox 写成功即 stamp `delivered_at`,PostToolUse CommDB hook 在 mailbox 模式下是 no-op,且无可靠 runner 侧 ack)从不 stamp read_at——被执行≠被"读"。诚实备注:Lead 指令原话说 "type=response";审计事实是探测只查 `type='instruction'`,修复以实际探测器为准。

## B1. 修法(R10 #1/#2 修订)

**单次快照**:`gapScanTick` 开头捕获一次 `deliveryUnconsumedV2 = process.env.FLYWHEEL_DELIVERY_UNCONSUMED_V2 !== "0"`,同一布尔按参数线程化进 `openGapReader`(选 V2/V1 SQL)与 `evaluateGapSuspicion` / `evaluatedGapConditions`(经 GapScanInput 新字段)——OFF = 整个 sweep 逐字 V1(SQL+触发+evaluated 语义),绝无「V2 SQL 配 V1 清除」的混排(R10 #2)。

1. **状态门(纯函数层,V2)**:`delivery_unconsumed` 对 `comm.declaredParked === true` 或 status ∈ {awaiting_review, approved_to_ship} 不触发;`evaluatedGapConditions` 镜像(被状态门排除仍算 evaluated——**即使 unconsumed SQL 信号不可读**,状态门本身就是完整判定,V2 下该 kind 恒 evaluated;OFF 保留今日 `unconsumedSignalReadable` 规则)→ 现存误报 episode 部署后首个 sweep absence-clear。
2. **消费证据(SQL 层,V2)——只认相关性收据(R10 #1 + R11 #1)**:排除满足「存在 `from_agent=<execId>` 且 `instr(content, q.id) > 0` 的消息」的 instruction——**不比较 delivered_at**(R12 #1:send.ts 先插行、await mailbox wake、之后才 stamp delivered_at;runner 可在 stamp 前就回执,跨秒会得到 created_at < delivered_at 的真回执;完整随机 id 在投递前 runner 不可能获知,id 本身即因果证据;外层已限定 delivered_at IS NOT NULL 的 instruction)。**配套 producer 协议落地(R11 #1)**:现行 Blueprint LEAD REPORT-BACK 模板并不要求 DONE 报文带 instruction id——本单同时修改 `Blueprint.ts` 的 REPORT-BACK 规则文本:对 lead-instruction 的 DONE 回报**必须**在报文中带完整 `[lead-instruction <id>]`(模板文本改动是 **additive 全局协议修订**、不受 V2 开关控制;因此 `V2=0` 承诺的是 **scanner sweep 的 V1 逐字回退**,不泛称 Part B 全部字节回退——OFF 测试明确断言 prompt 仍含新 producer 文本;`Blueprint.fly208-report-back.test.ts` 锁新模板合同,R12 #1)。**去掉**「任意后续 outbound 即消费」分支(mailbox 投递下时序不构成因果;A/B 反例见 M8)。未按新协议引用 id 的已执行 instruction 保持触发 = 接受的残余误报(部署后随 runner 换代收敛,诚实记录)。
3. **成本(R11 #2)**:外层候选集极小(delivered+unread 通常 0-5 行/会话);相关子查询无 `(from_agent, created_at)` 索引。单测锁**查询形状**(`EXPLAIN QUERY PLAN` 断言 + 正确性);wall-clock 阈值**不进单测**(CI 负载下必 flaky)——放进 QA benchmark 证据(1e4 行 messages、全 sweep 计时);`gapScanTick` 记录 pass duration 日志;容量假设写明(≤50 active sessions/项目、每会话 ≤5 未读行);生产实测超预算 → follow-up 走 `(from_agent, created_at)` writer 侧索引迁移(不在本单)。

覆盖矩阵:212eca7e/f6fb5f10 被①治;22094c31 型(running 已执行)由②+新 REPORT-BACK 协议治(新协议 runner 的 DONE 报文必带全 id;旧报文不带 id 仍触发=残余,随部署收敛);真·未消费仍触发。

## B2. 测试(M8)

- 纯函数(V2):parked / awaiting_review / approved_to_ship → 零 suspicion + 恒 evaluated(unconsumed SQL 不可读也 evaluated);running 无 id 引用 → 照旧触发;
- reader(真 sqlite 内存库,V2):全 id 引用 → 排除(**确定性跨秒 fixture**:runner report 12:00:00、sender 12:00:01 才 stamp delivery → 仍清除,R12 #1);**A/B 双 instruction、outbound 只引用 A → B 仍 unconsumed**;8 字符短前缀 → 不排除;**现行旧模板 DONE 报文(无 id)→ 仍触发**;**新协议模板报文(全 id)→ 清除**(R11 #1 三件套);missing schema → readable:false;EXPLAIN QUERY PLAN 形状断言(wall-clock 归 QA benchmark);
- Blueprint 模板:REPORT-BACK 文本含「DONE 必带完整 [lead-instruction <id>]」合同(fly208 测试锁);
- 快照一致性:同一 tick 内 reader 与两个纯函数同一布尔;OFF → V1 SQL + V1 触发 + V1 evaluated 逐字(今日 3 案例 fixture 锁旧行为)。

# Part C: issue 终态自动归档 thread(founder 直令折入 = FLY-1289;R10 修订)

## C0. 现状与缺口(已审计,R10 核修)

- **merged landing → 归档**:已存在(`runPostShipFinalization`,owns 清理→归档顺序)——只补回归测试;
- **close→archive 级联**:已存在(closeRunner → `maybeArchiveThreadOnClose`);tmux already-gone 的 SUCCESS 路径**已经**走级联(close-runner.ts:437-445,先 CommDB target 判 gone + finalize 成功才归档);
- **R10 #3 核修**:原草案的「session_not_found → alreadyGone 级联」**撤销**——该分支生产不可达(HTTP close 路由在 closeRunner 之前就 404,plugin.ts:1915-1919;StateStore sessions 行无删除路径,行缺失=身份错误/损坏而非"已清理"),且绕过 CommDB finalize 前置会回归 FLY-1238。真实痛点(FLY-1289:「归档级联焊死在 close_runner 上」)由下面的终态触发覆盖,无需伪造 gone 语义。若 Lead 后续给出具体可达的报错案例,按 R10 #3 的 end-to-end 清单另行设计;
- **缺口(唯一保留)**:「全段 completed」无事件驱动归档——要等下一次 close 动作或 FLY-1165 周期 sweep。

## C1. 修法(R10 #4/#5 + R11 #3/#4/#5 修订:显式 archive-only targeted mode + 队列生命周期合同)

开关 `FLYWHEEL_TERMINAL_THREAD_ARCHIVE`(default ON;每个 wiring 位点用单次捕获布尔,`=0` → 双 sink 零 enqueue)。

**① archive-only targeted mode(R11 #3——不是复用现行 reconcile 分支,是同模块新增的隔离模式)**:`done-thread-reconcile.ts` 新增 `runTargetedArchiveCheck(issueId): Promise<TargetedOutcome>`,合同:
- **只读目标 issue/thread**,不进 FLY-1185 residue union;**lifecycleCloseout / new mutators / husk finalize 一律禁止**(completion 触发的检查无权关闭或改写任何 phase——现行 sweep 的 closeout 分支会关 live runner、finalize 会把 dead design_done 改成 completed,均不属于本模式);
- **状态前置(全段 completed 的可审计定义)**:该 issue **全部 alias 行** status ∈ {completed, terminated}(terminated = Lead 主动关闭,亦是成功终态);任何 running / awaiting_review / approved_to_ship / design_done / pending / failed / blocked 行 → veto(**比现行 sweep 更严**:failed/blocked 在此模式否决而非放行,M9 与此完全一致);
- **并发安全的最终决策(R12 #2)**:经 `resolveLifecycleRootKey` 取完整 lock keys、在 plugin 现有 canonical `issueMutex` **持锁内**执行全部资格判定:状态前置 + **未兑现 launch-claim veto(R13 #1)**:`listOpenLaunchClaims(rootUuid)` 的 starting|active claim **仅在未兑现时 veto**——即该 claim 的 execution_id 尚无 alias session 行、或其行状态不在允许终态集(正常 completion 不会关闭 active claim,一律 veto 会让现代 runner 永久归档不了;claim 对应行已 {completed, terminated} = 已兑现,不 veto)+ fresh Linear Done/Canceled;pane 活性探测(异步)后**重新读取** alias rows/状态/claims(集合有变 → retryable veto 重跑,绝不用旧快照)+ archive sink 前**重做** fresh Linear 复核 → `archiveThreadAndRecord`(单 token sink、archive-once、dryRun 尊重);
- thread 查找先 canonicalize(UUID + identifier 双键),**所有 alias 都查不到才** `thread_missing`(混合键不误出队);
- 返回 typed outcome:`archived | already_archived | thread_missing | vetoed_active | vetoed_status | vetoed_claim | vetoed_linear | dry_run_would_archive | transient_error`。
**全局 sweep 语义 byte-compatible**(原「不碰 FLY-1165」改述为:sweep 本体行为不变,模块新增隔离 targeted mode)。

**② 队列由现有 scheduler 持有(R11 #4)**:`startDoneThreadReconcileScheduler` 返回 handle 从 `{stop}` 扩为 `{enqueue(issueId), stop}`;targeted 消费与 global pass **共用同一 `inFlight` 单飞**(绝不并发);outcome 驱动生命周期——`archived/already_archived/thread_missing` 终止出队;`vetoed_* / dry_run_would_archive / transient_error` **留队重试**:有上限退避(1min→2→4→…cap 30min;dry_run_would_archive 保留在队,scheduler 每 tick 重读配置,dry-run 关闭后继续,R12 #4)+ 公平轮转(重试项排队尾,poison 不饿死后项;`nextEligibleAt` 未到不消费、`inFlight.finally` 不热循环)+ **24h 后不丢弃**——降为低频重试(cap 1h)+ 每次 loud log(R12 #4:boot-only 配置下没有周期 sweep 可兜,eventual 承诺不能建立在不存在的 backstop 上);容量 cap(64,**溢出 → 拒收新项 + loud log(点名被拒 issue)**;兜底 = periodic sweep(启用时的标准后备);**boot-only 且同时 >64 issue 完成的溢出 = 文档声明的接受缺口**(loud log 点名,不假称有兜底,也不越权触发含 lifecycle mutator 的全局 pass——R14 #1:全局 pass 既不保证覆盖溢出目标又越过 archive-only 权限边界),R13 #2/R14 #1)+ shutdown drain + in-flight 结束自动继续 pending。**核心场景**:completed 事件时 pane 通常还活着(runner 正在执行完成命令)→ 首查 vetoed_active 留队 → 数分钟后 pane 消失 → 重试归档(远早于 6h sweep,M9 核心反例)。开关优先级(R12 #4:**scheduler 构造 byte-compat**——现行 plugin 无条件构造、`resolveConfig()` 每 tick 重读,动态 off→on 合同保留):`FLYWHEEL_DONE_THREAD_RECONCILE=0` → scheduler 照常构造,disabled 状态**暂停** global+targeted 消费(holder/queue 项保留,重新 enable 后无需重启继续);`FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN=0`(boot-only)不影响 targeted 消费;dryRun 对 targeted 同样生效(只报告不归档);`TERMINAL_THREAD_ARCHIVE=0` → 双 sink 不 enqueue。

**③ wiring(R10 #5 + R11 #5)**:单一 post-persist helper(fresh `store.getSession` 确认 completed 后 enqueue),接线于:event-route 的 **session_completed 主转态** 与 **FLY-324 stage_changed 转态**、以及 `DirectEventSink` 的 completion 写点——均在 phase orchestration/handoff **之后**。**post-ship 单 owner 排除按谓词收口(R12 #3)**:凡 `isPostApproveShipComplete(...) === true` 的 completion——含 W2 merged、**HTTP 主 session_completed 的 merged-success 分支**(event-route.ts:1432-1480 同样调 runPostShipFinalization)、DirectEventSink 的 merged completion——**一律零 enqueue**(post-ship owner 独占 cleanup→archive 顺序);**FLY-208 evidence-gap completion 同样排除**(HTTP 与 Direct sink 都会把无 merge 证据的 approved_to_ship 写成 completed + `fly208_evidence_gap` 标记,后续归 FLY-210/manual close 所有)——且 targeted mode 的最终 preflight **veto 任一 alias 行的未解决 evidence-gap 标记**(防兄弟 phase 的 enqueue 绕过源侧过滤)。**构造顺序**:composition root 在创建 DirectEventSink(plugin.ts:4044)与 createBridgeApp(:4195)**之前**先建 late-bound enqueue holder(单次捕获的开关快照一并注入 RunInfraOptions / createBridgeApp options);FLY-1165 scheduler(:4772)建成后绑定为 holder 的消费者;**绑定前的 enqueue 缓存在 holder 内不丢**(有界 64,同容量合同)。boot 的 FLY-324 reconciler 不接(周期 sweep 覆盖,声明)。

不碰:FLY-369 级联、`archiveThreadAndRecord`、close-runner.ts;FLY-1165 全局 sweep 行为 byte-compatible。

## C2. 测试(M9)

- enqueue 面:session_completed 主转态 / stage_changed 转态 / DirectEventSink completion → helper 恰一次入队(FSM 拒绝/终态重复 → 零入队);**W2 merged / DirectEventSink merged completion → 零入队**(post-ship 独占);双 sink parity;scheduler 绑定前 enqueue 被 holder 保留、绑定后消费;
- targeted mode:全段 {completed,terminated} + Linear Done + 全行 pane 死 → 归档恰一次;兄弟 running / awaiting_review / approved_to_ship / design_done / pending / **failed / blocked** / completed-but-live / lookup error / indeterminate → **逐一 veto fixture**(R10 #4 + R11 #3 全清单);Linear 未 Done → vetoed_linear 留队;**禁止面断言:targeted 模式零 lifecycleCloseout / 零 finalize / 零 mutator 调用**;
- 并发/排除面(R12 #2/#3):仅有 starting launch-claim、session row 未显形 → veto 留队;probe 期间插入 pending successor → retryable 重跑;首查 Linear Done、archive 前复核时 reopened → veto;identifier 入队、thread 以 UUID 存储 → 找到同一 thread;HTTP 主 session_completed merged-success → 零 enqueue;HTTP/DES evidence-gap completion → 零 enqueue;兄弟 completed 已入队但同 issue 有未解决 evidence-gap 标记 → targeted preflight veto;
- 队列生命周期(R11 #4 + R12 #4 核心反例):completed 事件时 pane alive → vetoed_active 留队 → 无第二个 completion 事件 → pane 转 absent → 退避重试在远早于 6h 处归档;两个 targeted 与 global pass 绝不并发(共享 inFlight);poison target 退避轮转不饿死后项;24h 后降为低频重试(1h cap)持续 loud log(**不丢弃、不假称交 sweep**,R13 #2);容量溢出 → 拒收 + loud log 点名(periodic sweep 为标准兜底;boot-only 溢出=声明的接受缺口,零全局 pass 触发);**已兑现 claim 不 veto**(completed 行 + 残留 active claim → 照常归档)、未兑现 claim(starting 无行)→ veto(R13 #1);
- 开关矩阵(R11 #5 + R12 #4):TERMINAL_THREAD_ARCHIVE=0 / DONE_THREAD_RECONCILE=0 / dryRun / INTERVAL_MIN=0 各自的 enqueue / targeted run / transport mutation 允许性逐格断言;dry-run outcome → 关闭 dry-run 后继续归档;boot-only 运行 >24h 低频重试仍活;disabled→enabled 无重启恢复;fake-clock 断言 nextEligibleAt 未到不热循环;
- merged landing 归档回归(现行为锁定);全局 sweep byte-compat 哨兵。

**验收补充**:真机重演附加——三段式 issue 全 phase completed + Linear Done → thread 在分钟级自动归档(不等 6h sweep);期间任一 phase 活着 → 不归档。
