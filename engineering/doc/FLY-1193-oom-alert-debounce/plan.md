# FLY-1193 OOM 告警 debounce — 实施计划

Issue: FLY-1193 (https://linear.app/geoforge3d/issue/FLY-1193/stabilitynoise-oom-pressure-hold-告警在瞬时-spike-上误触发-pagere-deliver-需)
日期: 2026-07-12
基于: research.md

---

## 0. 决策记录

**brainstorm gate(Tadashi 已批,2026-07-12)**:
1. **方案 A 形状**:hold 与 page 解耦 —— trigger 时 sensor 直接置 hold(静默、比现状经 alert→RepairBot 绕一圈更早),page 才 debounce。
2. **debounce 按 episode(OR 两分支)持续 ≥ N 秒**,不按 issue 字面的「free% 持续低」(审计事实:真实扳机是 swapout-delta 分支;根因更正已写回 Linear issue 描述)。
3. **N 默认 120s**,新 env `FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC`。
4. **MIN 重校准并入本单**,implement 阶段繁忙窗口实测定值。
5. **硬约束:FLY-1142 restart-safety 状态机(`MemoryPressureMonitor`)逐字不动**;边界:FLY-1139 / FLY-1183 / FLY-517 不碰。

**N=0 口径变更(gate owner 已确认)**:`N=0` 语义从原批的「回退旧行为(byte-exact)」修正为「**只关 page 延迟**(trigger tick 即 page),hold 前置 / 新文案 / 广播闩等新语义保留」。**Tadashi 明确批准 (b)**——`flywheel-comm` question `11f7e3b8-70d3-4fb7-b081-46a37d7cadbc`,答复原文「(b) 确认,按你走的继续…hold 前置这类保护增强不该随逃生口一起消失,真 legacy 双路径还会复活旧 bug + 双倍测试面 —— 不值。」不做真 legacy 双路径(会撤掉 hold 前置保护、复活 `!placed` 吞广播旧 bug)。reverse-compat 哨兵按新口径 = 时序等价(N=0 → trigger tick 恰 1 page/episode)。

**Codex design review R1(7 项全采纳)+ R2(5 项:1-4 采纳,5=N=0 gate 已由 Tadashi 上批解决)**:
- R2-1 跨重启「不重不漏」不能靠 ACTIVE ticket 再水化(Hub root-first:duplicate/queued/thread-create-fail 都可能无 ACTIVE row;有 row 也只证明线程落库、repair 可能还没跑就崩)。**改用 durable episode identity**:eventId 锚 `getFleetPressureHold().set_at`(hold 首置即固定、跨重启稳定)→ 根 page 的跨重启 dedup 交给现有 claims/Hub 层(同 eventId → `skipped:"duplicate"` / Hub 认出同 episode 不重开);Lead 降载广播用 `notifyLead` 的 deterministic `dedupeId=swap-broadcast:${holdSetAt}:${leadId}`(镜像 `server-loss.ts` 模式,CommDB `INSERT OR IGNORE` sink 去重 → 重启后安全补发未发的、不重刷已发的)。**移除所有 ACTIVE-ticket 再水化逻辑**;in-memory 闩降级为纯「单进程内别每 tick 重发」的性能优化,正确性由 dedup 层兜底。
- R2-2 hold-failure fail-loud 的两个断口:(a) 用独立 eventId 让 hold-failure page 不被正常 page 的 claims 挡住;移除再水化后 `episodePagedAt` 重启即 null,不会挡住 fail-loud;(b) 测试只 mock `setFleetPressureHold` 抛错(其余 alert store 健康),全库故障坦诚 best-effort(不声称 Discord 必达)。
- R2-3 title/prefix 四类分渲染(不固定「持续 X 秒」);`ensureSensorHold` 返回 hold 归属(`placed_by_sensor | existing_sensor | existing_manual | unconfirmed`),文案据此区分(manual hold 时不得说「sensor 已置、恢复后自动解除」——`liftSensorHold` 不清 manual hold)。
- R2-4 MIN「留 0」出口补成完整 ship gate:选定 MIN(含 0)下完整 busy trace 必须**零 page** 才可继续;若 0 会 page 且无安全可分离的更高 MIN → 回 Tadashi 重开 N/信号设计,不合入。正样本标注真实压力区间,断言该区间内绝不提前 clear/lift。

**Codex design review R3(3 项全采纳,都是真 bug 非过度设计)**:
- R3-1 broadcast 只有稳定 dedupeId、没有保证补发的调用者:原设计把广播挂在 `swapPressureRepair`(AutoRepairBot 路径),但重启后同 eventId 命中 claims → `AlertChannelHub.handle()` 在 `skipped:"duplicate"` 处直接 return,**不进 AutoRepairBot** → `swapPressureRepair` 不再执行 → crash 中断的 Lead 永远漏发。**改**:把广播抽成 `broadcastLoadShed(episodeId, holdState)` helper,由 sensor 在 `maybePage` 到期 tick **直接调用**(与 page 同一到期点,不等 Hub 回调);`swapPressureRepair` 也调同一 helper(保留「repair 动作」叙事,dedupeId 兜重复)。**且 in-memory 优化闩必须在 side-effect 已落 durable 处理(alert 返回 `sent|queued|skipped:"duplicate"|deadLettered`;broadcast 逐 Lead `notifyLead` 返回 true)之后才置**——原设计在 `await alert()` **之前**写闩,alert 在 durable claim 前 throw 会让本进程后续 tick 被永久挡住,与「正确性不靠内存闩」自相矛盾;throw → 下 tick 重试。
- R3-2 manual hold 的 `set_at` 不是 sensor episode identity:`liftSensorHold` 不删 `set_by!=="swap-sensor"` 的 manual row → episode A clear 后 manual hold 仍在 → episode B 的锚仍是同一个 manual `set_at` → claims/CommDB 永久 dedup **吞掉 B 及以后所有真实 page/广播**。「episode 间隔 clear 所以 set_at 变」**只对 sensor-owned hold 成立**。**改(取 Codex 选项 b,诚实降级,不加 durable schema)**:episode identity 按 hold owner 分级——`placed_by_sensor|existing_sensor` → 锚 `hold.set_at`(durable、跨重启稳定,dedup 完整);`existing_manual|unconfirmed` → 锚 `String(episodeStart)`(内存,每个物理 episode 由 `MemoryPressureMonitor` 新 trigger 保证不同 → 后续 episode **绝不被永久静默**,但跨重启 dedup 不保证=best-effort)。manual-hold 是运维罕见叠加场景,此降级在 §1/§3 诚实标注,不为它加 durable 表(scope discipline)。
- R3-3 `ensureSensorHold` catch 分支把存活的 sensor hold 错标 manual + 应返回 snapshot:catch 只判「有没有 hold」就写 `existing_manual`,但 set 抛错而上轮 durable **sensor** hold 仍在时应是 `existing_sensor`(会自动解除),文案不能说「人工 hold、不自动解除」。**改**:catch 也判 `hold.set_by`;`ensureSensorHold` 返回单一 `{state, setAt}` snapshot,`maybePage` 直接用它,不再二次 `getFleetPressureHold()` + `String(start)` 静默 fallback——owner/文案/identity 全来自同一次已确认读数。

**Codex design review R4(2 项全采纳,用现成机制、不加 durable schema)**:
- R4-1 sensor-owned「跨重启不漏广播」缺 page-after-restart-quick-recovery 路径:page + 广播到一半崩溃 → 新进程有 durable sensor hold,但机器在 fresh monitor 重新确认+计满 N **之前**恢复 → restart-safety 直接 lift/resolve → 缺失 Lead 永无第二个广播调用点。**改**:给 `FleetSensorsDeps` 加只读 `isAlertClaimed?(eventId)`(plugin 已持有 claimsReader),用 **claims 作 page 的 durable 证据**(比 ACTIVE ticket / 内存闩可靠);新增 `settleClaimedBroadcast`——在恢复 lift 之前 + maybePage inPressure 时,若 `swap-pressure:${setAt}` 已 claimed 则立即补齐广播(dedupeId 兜已发);查询失败 fail-toward-current。这才让 §1「不漏广播」真成立。见 §2.1(h)。
- R4-2 delayed queue drain 在 episode 恢复后重新置 hold + 发过时广播:queued alert 稍后 `attachThreadForDelivered` 才进 AutoRepairBot,原 sensor 可能早已 clear 删 hold,`swapPressureRepair` 无条件 `setFleetPressureHold` 会在**健康机器上误暂停派发**+ 从新 hold set_at 重建 identity 发第二轮过时广播。**改**:`swapPressureRepair` 消费 payload 的**原** episodeId、绝不重建;仅当「当前 sensor hold set_at === payload episodeId」或 monitor 仍在该 episode 才 ensure+broadcast;否则 no-op detail「episode 已恢复,不重新暂停派发」。见 §2.1(f)。

**Codex design review R5(scope 判断——收敛而非继续加机制)**:
- R5-1 揭示 R4 采纳的 claims-reader 方案实现前提站不住:实际 `ClaimsReader = () => Promise<Set<string>>`(异步、只读最近 1h、DB 失败转空集不返回 null),且 notifier 在 shared claim 失败时走 Bridge `lead_events` 继续——「claims 证明 page」在 API 形状与证据语义上都不成立。继续修需引入 `isAlertDurablyHandled`(claims OR lead_events)+ recovery-aware 文案(R5-3)+ durable retry/outbox(R5-2),分布式系统级复杂度。
- **scope 决策(Runner 定、已 ask 知会 Tadashi)**:R4-1/R5-1/2/3 针对的「page + 广播到一半 + 崩溃 + 快速恢复」极窄 crash 边缘,危害极小(硬保护 pressure-hold durable 不受影响;漏的是即将恢复 episode 的降载软通知,R5-3 指出恢复后补发文案本身还是误导的)。**issue 验收并未要求跨重启广播补发**。故按 Codex R5-2 自己给的选项,把「跨重启不漏广播」**降级为 best-effort + 诚实标注**(同 manual-hold),**砍掉 R4-1 的 `settleClaimedBroadcast`/`isAlertClaimed` 整套机制**——符合 CLAUDE.md「enforce simplicity / scope discipline」。
- R5-4 保留并精确化(**真有危害,必须修**):`swapPressureRepair` 前缀感知(`swap-pressure:` vs `swap-holdfail:`,未知前缀 fail-closed)+ 精确匹配「当前 episode」(sensor hold `set_at===payloadEpisodeId`,或 manual/unconfirmed 的 `episodeStart===payloadEpisodeId`),防 payload A 在 live episode B 时把 A 的 identity/广播误用到 B。见 §2.1(f) + 测试 8e。

**Codex design review R6(明确同意 best-effort scope,不需升级 Lead、不建议 durable outbox;剩 2 项纯表述一致性收尾)**:
- R6-1 操作性章节(字段注释 / `broadcastLoadShed` 注释 / 测试 8 / §4 验收 / 风险表 / §1 硬保证②)全部对齐 §1/§3 的 best-effort 合同,删除被 R5 撤回的「跨重启不重不漏」绝对措辞(历史 R4 决策记录保留作 superseded 记录)。测试 8 收窄为 identity 稳定性(需「fresh instance 持续压力到重新到达到期点」),跨重启不补齐的例外交叉引用测试 8d。
- R6-2 未知/畸形前缀定唯一合同:`{outcome:"needs_human", action:"none"}` + 零副作用(未识别 identity=内部合同违反,升级人工而非静默 no-op),测试 8e(v) 精确断言。

## 1. 目标

繁忙机器上自恢复的瞬时内存脉冲不再惊扰人(零 page、零 Lead inbox 广播、零工单);只有持续 ≥ N 秒的 pressure episode 才 page 一次。

**保证级不变量**(硬):① spike(任一 danger 分支)N 秒内自愈 → 不 page、不广播;② 单个 Bridge 进程内,持续 ≥ N 的 episode → page 恰一次(跨重启的严格「一次」属 best-effort,见下段);③ pressure-hold 保护在 trigger 时即刻静默生效、durable 跨重启不丢、自愈后静默解除、置位失败绝不静默(独立 fail-loud page)。

**best-effort 级**(诚实标注,不为极窄边缘引入 durable outbox / claims 补发机制):跨重启的**去重**——根 page 的 eventId 锚 durable `hold.set_at`(sensor-owned),在现有 alert dedup 层(claims/lead_events)有效窗口内不重发(比 FLY-1142 现状改善;超窗口/DB 失败时最多重发一次,危害=工单重开一次,与现有 alert 管道同构);降载广播同进程内 partial failure 下个到期 tick 补齐(测试 8b),但跨 Bridge 崩溃 + episode 在重新确认前即恢复的极窄窗口,少数 Lead 的降载软通知可能漏发——**硬保护(hold)durable 不受影响,且该 episode 已恢复、降载软通知已无实际意义**。manual-hold 叠加路径(运维罕见)同为 best-effort:每个物理 episode 仍各自 page、绝不永久静默,跨重启 dedup 不保证。

## 2. 改动清单(逐文件)

### 2.1 `packages/teamlead/src/bridge/fleet-sensors.ts`(主改动)

#### (a) debounce env 解析(R1-6:不动 machine-watermark.ts)

```ts
/**
 * FLY-1193: page debounce 秒数。显式有限非负数 → 采纳(显式 "0" = 关 page
 * 延迟,trigger tick 即 page;hold 前置等新语义不回退——plan §0 N=0 口径);
 * 未设 / 空串 / 空白 / 负 / NaN / Infinity / 非数 → 默认 120。
 * 独立 validator——Number("") === 0 的坑必须显式挡掉。
 */
export function pageDebounceSecFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC?.trim();
  if (!raw) return 120;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 120;
}
```

#### (b) episode 状态字段(全部 in-memory,纯性能闩)

```ts
/** FLY-1193: 单进程内的 page/广播/fail-loud 优化闩——防同一进程每 tick 重发。
 *  这些是进程内闩,不是跨重启的正确性来源(§1 合同):deterministic eventId/
 *  dedupeId 让「有调用者时的重复调用」幂等;跨重启根 page 去重由现有 alert
 *  dedup 层在其有效窗口内兜底(超窗口最多重开一次);广播跨重启补发为
 *  best-effort。重启后闩归零,不做 durable 再水化。用 episodeId(非 bool)存,
 *  天生正确处理「clear 后新 episode」:新 id ≠ 旧值 → 自动重新可 page/广播。
 *  R3-1:这些闩只在对应 side-effect 已落 durable 处理之后才置(见 (e)/(f)),
 *  alert 在 durable 前 throw 时下 tick 重试。 */
private episodePagedFor: string | null = null;
private episodeBroadcastFor: string | null = null;
private holdFailurePagedFor: string | null = null;
```

#### (c) `swapTick()` 重排

```ts
private async swapTick(): Promise<void> {
  if (!sensorOn(this.env, "SWAP")) return;
  const reading = await (this.deps.readPressure ?? (() => readMemoryPressure(this.env)))();
  this.lastPressure = reading;
  const now = this.now();
  const ev = this.memMonitor.tick(reading, now);
  const debounceSec = pageDebounceSecFromEnv(this.env);

  let hold: HoldSnapshot | null = null;
  if (ev.event === "trigger" || this.memMonitor.inPressure) {
    hold = this.ensureSensorHold();     // 静默置位;返回 {state,setAt} snapshot(见 (d))
  }
  if (ev.event === "clear") {
    this.liftSensorHold();
    // 无条件 resolve:未 page 过 = hub.resolve 安全 no-op(AlertChannelHub.ts:677-679);
    // 也收掉跨部署/跨重启遗留的 ACTIVE 工单。
    await this.deps.resolveTicket?.(fleetCorrelationKey("swap", "swap_pressure_high"));
  } else if (!this.memMonitor.inPressure && ev.healthy === true) {
    this.liftSensorHold();              // FLY-1142 restart-safety,原样保留
  }

  if (this.memMonitor.inPressure && hold) {
    await this.maybePage(now, debounceSec, ev, hold);   // 见 (e)——page + broadcast 同到期点
  }
}
```

注:`ensureSensorHold` 在 trigger 与每个 in-pressure tick 都调(R1-1 幂等重试自愈置位失败),返回本 tick 已确认的 hold snapshot 供 maybePage 复用(R3-3:owner/文案/identity 同源,不二次 get)。**广播跨重启补发 = best-effort**(R5 scope 判断,见 §0 R5 决策):同进程内 partial failure 下 tick 补齐(测试 8b);跨 Bridge 崩溃 + episode 在重新确认前即恢复的极窄窗口可能漏少数 Lead 的降载软通知——**不为此引入 claims/durable-outbox 补发机制**(硬保护 pressure-hold durable 不受影响、且该 episode 已恢复、降载软通知已无意义;§1/§3 诚实标注)。

#### (d) `ensureSensorHold()` → 返回 snapshot(R1-1 fail-loud + R2-3 归属 + R3-3 catch 判 owner)

```ts
type HoldState = "placed_by_sensor" | "existing_sensor" | "existing_manual" | "unconfirmed";
interface HoldSnapshot { state: HoldState; setAt: string | null; }

/**
 * 置位/确认 hold,任何异常绝不逃出本方法(swapTick 外层 catch 会吞掉整个
 * tick 含 page)。返回本次已确认读数的 {state, setAt} snapshot——owner/文案/
 * identity 全来自同一次读,不让调用方二次 get。无法确认任何 hold 在生效
 * → state="unconfirmed",由 maybePage fail-loud。
 */
private ensureSensorHold(): HoldSnapshot {
  const classify = (hold: {set_by: string; set_at: string} | undefined, placed: boolean): HoldSnapshot => {
    if (!hold) return { state: "unconfirmed", setAt: null };
    if (hold.set_by === "swap-sensor")
      return { state: placed ? "placed_by_sensor" : "existing_sensor", setAt: hold.set_at };
    return { state: "existing_manual", setAt: hold.set_at };   // R3-3:catch 也走这条,按 owner 判
  };
  try {
    const placed = this.deps.store.setFleetPressureHold({
      setBy: "swap-sensor", watermark: this.lastWatermark ?? "unknown",
    });
    const snap = classify(this.deps.store.getFleetPressureHold(), placed);
    if (snap.state === "placed_by_sensor") this.log(`pressure-hold placed on trigger (silent)`);
    return snap;
  } catch (err) {
    let snap: HoldSnapshot;
    try { snap = classify(this.deps.store.getFleetPressureHold(), false); }  // R3-3:存活 sensor hold 标 existing_sensor,不误标 manual
    catch { snap = { state: "unconfirmed", setAt: null }; }
    this.log(`pressure-hold placement FAILED (${(err as Error).message}) — holdState=${snap.state}`);
    return snap;
  }
}
```

- `liftSensorHold`(`set_by==="swap-sensor"` 守卫)与 FLY-1142 restart-safety 分支零改动。
- set_at 列精度:`fleet_pressure_hold.set_at` 为 DB 默认时间戳;sensor-owned episode 之间隔着 clear(自愈)、现实不同秒;implement 阶段确认列定义,记录于 PR。

#### (e) `maybePage()` —— debounce + durable dedup + broadcast 同到期点(R2-1 + R3-1/2)

```ts
private async maybePage(now: number, debounceSec: number, ev: MemoryEvaluation, hold: HoldSnapshot): Promise<void> {
  const start = this.memMonitor.episodeStart;
  if (start == null) return;
  const elapsedMs = now - start;
  // R3-2:episode identity 按 hold owner 分级。
  //  sensor-owned(placed_by_sensor/existing_sensor)→ 锚 durable hold.set_at
  //    (identity 跨重启稳定;实际去重受现有 alert dedup 有效窗口约束——§1 best-effort)。
  //  manual/unconfirmed → 锚内存 episodeStart(每个物理 episode 由 monitor 新
  //    trigger 保证不同 id → 后续 episode 绝不被永久静默;跨重启 dedup 不保证
  //    = best-effort,§1/§3 诚实标注)。
  const sensorOwned = hold.state === "placed_by_sensor" || hold.state === "existing_sensor";
  const episodeId = sensorOwned && hold.setAt ? hold.setAt : String(start);

  // ── hold-failure fail-loud:独立 eventId,不被正常 page 的 claims 挡住 ──
  if (hold.state === "unconfirmed") {
    if (this.holdFailurePagedFor === episodeId) return;   // 单进程内不重刷
    const r = await this.deps.alert(this.buildAlert({ kind: "hold_failure", episodeId, elapsedMs, ev, hold }));
    if (isDurablyHandled(r)) this.holdFailurePagedFor = episodeId;   // R3-1:落 durable 后才置闩
    return;
  }

  // ── 正常 page:episode 持续 ≥ N 秒(N=0 → trigger tick 即达)──
  if (elapsedMs >= debounceSec * 1000 && this.episodePagedFor !== episodeId) {
    // eventId 锚 episodeId:sensor-owned 时 identity 跨重启稳定;同 eventId 的
    // 重复根 page 由现有 alert dedup 层在其有效窗口内去重(§1 best-effort,非绝对)。
    // in-memory 闩只省单进程内重复 alert 调用。
    const r = await this.deps.alert(this.buildAlert({ kind: "sustained", episodeId, elapsedMs, ev, hold }));
    if (isDurablyHandled(r)) this.episodePagedFor = episodeId;       // R3-1:落 durable 后才置
  }
  // ── 降载广播:与 page 同一到期点,独立 best-effort(R3-1:不等 Hub→AutoRepairBot 回调)──
  if (elapsedMs >= debounceSec * 1000 && this.episodeBroadcastFor !== episodeId) {
    await this.broadcastLoadShed(episodeId, hold);      // 见 (f)
  }
}

/** alert 结果是否已落 durable 处理(可安全置闩);throw 不进这里 → 下 tick 重试。 */
function isDurablyHandled(r: AlertResult): boolean {
  return !!(r.sent || r.queued || r.deadLettered || r.skipped === "duplicate");
}
```

**撤回 research 两处错误声明**:不再声称「Hub 复用线程」(实为 eventId 相等的 same-episode 短路)、不再声称「T2 reconcile 重入」(`policyForKind("swap_pressure_high").retryOnReconcile===false`,sentinel 锚定)。

#### (f) `broadcastLoadShed()` helper + `swapPressureRepair()`(R3-1:两处调用、同一幂等 helper)

```ts
/** 逐 Lead 降载广播,deterministic dedupeId 让「有调用者时的重复调用」幂等
 *  (CommDB INSERT OR IGNORE)。只有全部 Lead 已落 CommDB(notifyLead 返回 true,
 *  含 IGNORE 命中)才置进程内闩;任一失败 → 不置闩,**同进程下个到期 tick** 重试
 *  缺失的那几个。跨 Bridge 重启后是否补发取决于是否还有到期调用者(§1:best-effort,
 *  不引入 durable outbox)。 */
private async broadcastLoadShed(episodeId: string, hold: HoldSnapshot): Promise<void> {
  const leadIds = this.deps.listLeadIds?.() ?? [];
  let allOk = true;
  for (const leadId of leadIds) {
    try {
      const ok = await this.deps.notifyLead?.(leadId, this.loadShedText(hold),
        `swap-broadcast:${episodeId}:${leadId}`);   // CommDB INSERT OR IGNORE → 幂等
      if (!ok) allOk = false;
    } catch { allOk = false; }
  }
  if (allOk && leadIds.length > 0) this.episodeBroadcastFor = episodeId;
}
```

- **两个调用点,同一 helper**:(1) `maybePage` 到期时直接调(主路径——重启后即使 alert 走 duplicate、不进 AutoRepairBot,广播仍独立补发);(2) `swapPressureRepair`(AutoRepairBot 首次 alert 触发的 repair 回调)也调它,保留「repair 动作」叙事——dedupeId 兜重复,两来源不会重发。
- **`swapPressureRepair` 消费 payload 的原 episode identity,绝不重建/无条件置 hold**(R4-2:queued alert 稍后 `attachThreadForDelivered` 才进 AutoRepairBot,此时 sensor 可能早已 clear 删 hold——无条件 `setFleetPressureHold` 会在**健康机器上误暂停派发**,重建 identity 还会发第二轮过时广播)。**R5-4:前缀感知 + 精确匹配当前 episode(不是任意当前 pressure episode)**:
  - 解析 payload eventId 前缀:
    - `swap-pressure:${episodeId}` → 正常 repair;
    - `swap-holdfail:${anchor}` → hold-failure 重试策略:仅当「monitor 仍 inPressure 且 `String(memMonitor.episodeStart) === anchor`(同一当前 episode)且当前 hold 仍 unconfirmed」才重试置 hold;否则 no-op detail「该 hold-failure episode 已过去」。
    - 未知/畸形前缀 → **fail-closed,唯一合同**(R6-2):返回 `{outcome:"needs_human", action:"none"}`、**零 hold/广播副作用**——未识别 identity 是内部合同违反、无法证明安全,升级人工(Hub 会加 founder-escalation 框架)而非静默 no-op。
  - 正常 repair 的**精确谓词**(防 payload A 在 live B 时误动作):
    - sensor-owned 路径要求「当前有 sensor hold 且 `set_at === payloadEpisodeId`」;
    - manual/unconfirmed 路径要求「`memMonitor.inPressure && String(memMonitor.episodeStart) === payloadEpisodeId`」;
    - 满足 → ensure hold(仅 sensor 路径,幂等)+ `broadcastLoadShed(payloadEpisodeId, ...)`(用 payload 原 identity,不重建);
    - 不满足(payload 对应 episode 已恢复 / 已是不同 episode B)→ 返回 `attempted`/no-op detail「该 pressure episode 已恢复或已切换,不重新暂停派发/不广播」,**绝不 `setFleetPressureHold`、绝不广播**。
  - 异常不逃出(try/catch → needs_human 文案)。
- FleetSensorsDeps.notifyLead 签名 `(leadId, content) => Promise<boolean>` 扩为 `(leadId, content, dedupeId?) => Promise<boolean>`;plugin.ts `notifyLeadInstruction` 已支持 dedupeId 第三参(server-loss 已这么用),wiring 直接传。

#### (g) 告警 payload 渲染 `buildAlert()`(R1-2 + R2-3:四类,不说假话)

- eventId=`swap-pressure:${episodeId}`(正常)/ `swap-holdfail:${episodeId}`(hold-failure,独立不被 dedup 挡);`severity:"severe"`、`leadId:"swap"`、`projectName` 不变。
- **title 四类**:
  - `sustained` + N>0 + 当前 `ev.danger` → 「内存压力持续越阈(OOM 预警)」;
  - `sustained` + 迟滞带/unknown(`ev.danger===false`)→ 「内存压力事件持续中(尚未满足恢复条件)」;
  - `sustained` + N=0(elapsed≈0)→ 「内存压力已确认(page 延迟已关闭)」;
  - `hold_failure` → 「⚠️ 内存保护未能启用(pressure-hold 置位失败)」。
- **body** 按当前 tick `MemoryEvaluation` 三分支如实渲染:danger=true 点名实际分支(swapout X 页/tick 或 free P% < LOW%);迟滞带→「压力尚未回到恢复线(需 free ≥ HIGH% 且 swapout 增量 ≤ MIN)」;`healthy===null`→「最近采样失败/不可判,无法证明恢复」。
- **prefix**:elapsed 秒数仅在 >0 时说「已持续 X 秒(自 <trigger 时刻>起)」;=0 不说「持续」。
- `buildAlert` 接收本 tick 的 `hold: HoldSnapshot`,**hold 文案按 `hold.state`**(与广播 `loadShedText(hold)` 共用同一分支,文案一致):`placed_by_sensor|existing_sensor`→「pressure-hold 已于压力确认时刻置位(新 runner 派发已暂停),free 回到 HIGH% 且 swapout 增量回到校准噪声线(≤ MIN 页/tick)后自动解除并安静 resolve」;`existing_manual`→「已有人工 pressure-hold 生效(非本传感器置,不会自动解除)」;`unconfirmed`(hold_failure)→「⚠️ 保护动作置位失败,派发未被暂停 —— 需要人工关注(注:若 StateStore 整体故障,本告警可能也无法送达,best-effort)」。
- founder 面人话、无 tick/cause/kind 等实现词(测试对四类中文文案精确断言)。

### 2.2 `packages/teamlead/src/bridge/machine-watermark.ts`

- **主 commit 零接触**(R1-6):debounce 解析在 fleet-sensors.ts;`memPressureThresholdsFromEnv` 返回形状不变 → `machine-watermark.test.ts` 零改动全绿成立。
- **MIN 校准 commit**(§5,单独一个 commit,受 §5 ship gate 约束):仅改 `swapoutMinPages` 默认常量一处 + 同步该文件 doc 注释 + `machine-watermark.test.ts` 中断言默认值的用例(仅默认值数字,truth-table 用例零改动);附分布数据入 PR。若 gate 判「维持 0」则本 commit 不存在。

### 2.3 合同文/注释同步(R1-7,同 PR)

- `product/doc/FLY-915-infra-alerts-pipeline/prd.md:80,169` 附近:SWAP 行为合同从「2 tick 确认即告警/置 hold + 通知」更新为「2 tick 确认置 hold(静默);持续 ≥ N 秒才告警 + 通知(默认 120s,env 可调)」,标注 FLY-1193。
- `AutoRepairBot.ts:76-78` fleetRepair.swapPressure 注释:「place the hold + notify Leads」→「ensure the hold (sensor places it at trigger) + notify Leads to shed load (dedup per episode+lead)」。
- `LeadAlertNotifier.ts:196-201` / `LeadWatchdog.ts:1229-1230` 及 grep 全仓其余 swap_pressure_high 相关旧措辞(「连续 2 tick 确认」「swapout 归零」)一并同步。

### 2.4 `packages/teamlead/src/bridge/__tests__/fleet-sensors.test.ts`(扩展)

沿用现有 fake-deps 基建(注入 `readPressure`/`now`/`store`/`alert`/`notifyLead`);store fake 需支持 `set/get/clearFleetPressureHold`(get 返回带稳定 `set_at`)。用例:

1. **spike < N**:trigger → `setFleetPressureHold` 被调(静默)、`alert` 零调用;clear → lift + resolveTicket、全程零 alert。
2. **持续 ≥ N**:推进 fake now 过 N → alert 恰一次(eventId=`swap-pressure:${holdSetAt}`);再推进 → 不重复。
3. **N=0(env 显式 "0")**:trigger tick 同 tick page 恰 1 次/episode(新口径哨兵,§0);title=「已确认(page 延迟已关闭)」不含「持续」。
4. **page 后 clear**:lift + resolve。
5. **广播 dedupeId + 主路径直调**(R3-1):page 到期 `maybePage` **直接**调 `broadcastLoadShed` → 每 Lead 一条 `notifyLead(_, _, "swap-broadcast:"+holdSetAt+":"+leadId)`;同 episode 重入(下 tick)→ in-memory 闩挡(零新调用);`swapPressureRepair` 也调同一 helper → dedupeId 同,不重发。断言 dedupeId 稳定=holdSetAt 锚。
6. **sensor 已置 hold 时 repair 仍广播**(防 `!placed` 吞广播回归锚点)。
7. **重启 mid-debounce**(store 预置 durable sensor-hold 行、无 ACTIVE 工单)→ fresh instance 再 trigger:幂等不炸、不立即 page、debounce 从新内存 episodeStart 计;到点 page 时 eventId 仍=`swap-pressure:${holdSetAt}`(**跨重启 eventId 稳定**,靠 durable set_at)。
8. **crash-boundary identity 稳定性四场景**(R2-1,进程 identity 层):对每种,fresh instance **在压力持续足够久、重新到达到期点**时,断言「根 page 的 eventId 恒=`swap-pressure:${holdSetAt}`」+「广播 dedupeId 恒=`swap-broadcast:${holdSetAt}:${leadId}`」(durable set_at 锚使 identity 跨重启稳定 → 有调用者时的重复调用幂等):(a) 根已发但线程未建;(b) ACTIVE row 已写但 repair 未开始;(c) 广播到一半;(d) 广播完成但 repair status 未写。本测试验的是 **identity 稳定性**(不依赖 ACTIVE row),不是「跨重启一定补齐」——「机器在重新到达到期点前即恢复」的例外由测试 8d 覆盖(best-effort,§1)。
8a. **manual-hold 跨 episode 不永久静默**(R3-2):store 预置 manual hold(`set_by!=="swap-sensor"`,不被 `liftSensorHold` 清)→ episode A trigger→page→clear→ episode B trigger:B 的 episodeId=`String(episodeStart_B)`≠A 的 `String(episodeStart_A)`(内存 monitor 新 trigger)→ **B 再次 page + 广播**(断言 A/B eventId/dedupeId 不同,B 未被吞)。诚实标注:manual-hold 路径跨重启 dedup 不保证(本测试只验单进程内不永久静默)。
8b. **broadcast 到第 K 个 Lead crash → 补发**(R3-1):`notifyLead` 在第 K 个 Lead 抛错 → `episodeBroadcastFor` **不置**(allOk=false);下个到期 tick 重跑 `broadcastLoadShed` → 前 K-1 个 dedupeId 命中(CommDB IGNORE、不重复)、第 K 起补发 → 最终每 Lead 恰一条。
8c. **alert 在 durable 前 throw → 闩不置、下 tick 重试**(R3-1):`deps.alert` 首次 throw → `episodePagedFor` 保持 null;下 tick alert 正常返回 `sent` → 置闩、恰一次成功 page。断言「优化闩绝不在 alert throw 后永久挡住 page」。
8d. **跨重启广播 best-effort 诚实边界**(R5-2):page + 广播到一半崩溃 → fresh instance,首个健康样本即恢复(未重新 trigger、N 未到)→ 断言 **hold 被安全 lift(不为 CommDB 不可用而保留健康机器上的 hold)**、工单 resolve;记录:此极窄窗口的缺失 Lead 降载软通知不补发(best-effort,§1)——不引入 durable outbox。同进程内 partial failure 由测试 8b 覆盖(下 tick 补齐)。
8e. **delayed queue drain 不重置 hold / 不发过时广播 + 前缀感知精确匹配**(R4-2 + R5-4):
    (i) page 被 `queued` → sensor clear/lift(hold 删)→ 稍后 `swapPressureRepair` 用**原 payload eventId** 调:当前无匹配 hold + monitor normal → 断言**不 `setFleetPressureHold`**(hold 仍空)、**CommDB 零第二轮广播**、no-op detail「episode 已恢复」;工单随后安静 resolve。
    (ii) **payload A 在 live episode B 时 drain**:payload eventId=`swap-pressure:${A}`,当前 hold set_at=B≠A → 断言 repair 不把 A 的 identity/广播用到 B(no-op,不动 B 的 hold/广播)。
    (iii) 对照:同 episode 仍活(hold set_at===payload episodeId)→ repair 正常 ensure+broadcast(dedupeId 不重发)。
    (iv) **`swap-holdfail:` 前缀**:AutoRepairBot 按 `eventType==="swap_pressure_high"` 路由到本方法;payload eventId=`swap-holdfail:${anchor}` → 仅当 monitor 仍 inPressure 且 `episodeStart===anchor` 且 hold 仍 unconfirmed 才重试,否则 no-op「hold-failure episode 已过去」。
    (v) **未知/畸形前缀** → 断言精确返回 `{outcome:"needs_human", action:"none"}`、**零 hold/广播副作用**(R6-2 唯一合同)。
9. **hold 写入失败 fail-loud**(R2-2):只 mock `setFleetPressureHold` 抛错、`getFleetPressureHold` 返回 null → 同 tick 立即 `alert`(eventId=`swap-holdfail:...`,独立不被正常 page dedup 挡),title=「保护未能启用」;下一 tick set 恢复 → holdState 转 placed、正常 debounce 恢复。断言 fail-loud 用**独立 eventId**、单进程内不重刷(`holdFailurePagedFor` 闩)。
10. **hold 写入失败但已有 manual hold**:set 抛错、get 返回 manual 行 → holdState=existing_manual,不走 fail-loud;文案说「人工 hold 生效、不自动解除」,**不**说「sensor 已置/自动解除」(R2-3 manual 文案 bug 锚点)。
11. **文案四类精确中文断言**(R1-2/R2-3):sustained-danger(swapout)/ sustained-迟滞带 / N=0 / hold_failure —— 分别断言 title + body 关键短语,且迟滞带 body **不得**含「free P% < LOW」类不实语句。
12. **MIN>0 健康解除**(R1-2):thresholds MIN=50、delta=30 样本 healthy=true → clear/lift(公开行为断言,`MemoryPressureMonitor` 源码不动)。
13. **env validator**(R1-6):未设=120 / `"0"`=0 / `""`=120 / `"  "`=120 / `"-5"`=120 / `"abc"`=120 / `"Infinity"`=120 / `"300"`=300。
14. **swap kind no-reconcile-retry sentinel**:`policyForKind("swap_pressure_high").retryOnReconcile===false`。
15. 现有用例:除「trigger 即 alert」形状者(改为 env 注 `"0"` 保留断言并注释旧行为锚点)外零改动全绿;`machine-watermark.test.ts` 主 commit 零改动全绿。

### 2.5 `scripts/qa-fly-1193-debounce-e2e.mjs`(真机 E2E,implement 阶段)

**复用 FLY-1082 harness 形态(`scripts/qa-fly-1082-fleet-alerts-e2e.mjs`)走真 dist 全链**:真 `routedAlertSink → AlertChannelHub → AutoRepairBot → 同一 FleetSensors 实例`(holder 指向接受 tick 的 fresh instance),隔离 DB + 隔离 CommDB + 隔离告警队列(FLY-529 Room 规范),`FLYWHEEL_SWAP_SENSOR_CMD` 喂假 vm_stat 序列(零真实内存压力)。

- 场景①(spike):2 tick danger → 恢复;断言零新 `alert_threads` 行、隔离 CommDB 零广播、**hold 时间线证据**(逐 tick 轮询 `fleet_pressure_hold` 记录 `置位→存在→清除` 序列,非只查最终空行)。
- 场景②(持续):danger 维持 > N;断言恰 1 工单、隔离 CommDB 恰 1 轮广播(条数=Lead 数)、恢复后工单 RESOLVED。
- 场景③(N=0 对照):trigger tick 即 page,恰 1 工单。
- 场景④(重启 mid-debounce):场景②进行到 N/2 时重建 FleetSensors(保留 durable DB)→ 不立即 page、重新计后恰 1 工单。
- 场景⑤(重启 after-page):场景②page 后重建 → 持续压力下**零第二根 page**(claims dedup,同 eventId)、**零第二轮广播**(CommDB dedupeId);恢复 → 工单 RESOLVED。
- 场景⑥(hold 置位失败,R2-2b):**只让 `setFleetPressureHold` 抛错、其余 alert store 健康** → 同 tick fail-loud page(独立 eventId,文案「保护未能启用」);记录:全 StateStore 故障时只承诺「尝试 page + 记录外层错误」,不声称 Discord 必达。

## 3. 不变量(reverse-compat 哨兵)

| 不变量 | 证明方式 |
|---|---|
| `MemoryPressureMonitor` 状态机逐字不动 | `machine-watermark.test.ts` 主 commit 零改动全绿 + diff 审查(MIN 校准 commit 仅默认常量数字) |
| N=0 → trigger tick 即 page、每 episode 恰 1 次(新口径,§0) | 测试 3 + E2E 场景③ |
| hold 消费端零感知 | runner-admission 零改动;probe 只读 store |
| 手动 hold 永不误清 + manual 文案不谎报 | `liftSensorHold` 的 `set_by` 检查不动;测试 10 |
| 保证:eventId 锚 durable holdSetAt → 跨重启在 dedup 窗口内不重根 page(超窗口最多重开一次,同现有管道) | 测试 7/8 + E2E 场景⑤ |
| 保证:广播同进程内不重、partial failure 下 tick 补齐 | 测试 5/8/8b |
| best-effort:跨重启广播漏发极窄窗口 → hold 仍安全 lift、不引入 durable outbox(硬保护不受影响) | 测试 8d + §1 诚实标注 |
| 保证:delayed queue drain 不在健康机器误置 hold / 不发过时广播 / 不跨 episode 误动作 | 测试 8e(R4-2/R5-4:前缀感知 + 精确匹配当前 episode + fail-closed) |
| best-effort:manual-hold 叠加后续 episode 绝不永久静默(跨重启不保证 dedup) | 测试 8a + §1 诚实标注 |
| 保证:优化闩绝不在 side-effect throw 后永久挡住 page/广播 | 测试 8b/8c |
| hold 置位失败绝不静默(独立 eventId,best-effort) | 测试 9 + E2E 场景⑥ |
| swap kind `retryOnReconcile:false` | 测试 14 sentinel |
| BOT/ZOMBIE sensor 零变化 | 其 tick 路径零 diff |

## 4. 验收(对齐 issue,真机)

1. 繁忙机器瞬时 dip(任一 danger 分支)N 秒内自愈 → 不 page、不 re-deliver、不广播;hold 置/撤全静默且有时间线证据(E2E 场景①)。
2. 持续 ≥ N 秒 episode → 单进程内 page 恰一次;跨重启在现有 alert dedup 有效窗口内不重复(超窗口最多重开一次,与现有 alert 管道同构)(E2E 场景②④⑤)。
3. throttle-hold 行为不受影响:trigger 即置(比现状更早)、PROVEN-health 自动解除、置位失败 fail-loud(现有测试 + E2E ①⑥)。
4. 部署后观察:繁忙窗口(20+ runner 常态)≥ 1 天,`alert_threads` 零新增 30s-级 spike 工单;对照 7-12 晨 09:04 形态只留下 hold 置/撤痕迹。

## 5. MIN 重校准(并入本单;R1-5 + R2-4 强化的 ship gate)

> **判定(implement 阶段,2026-07-12):维持 MIN=0,不新增 MIN 校准 commit。** 繁忙窗口(load 62.9、~166 进程)soak + 离线 replay 显示 **MIN=0 + N=120 下 busy trace 零 page**(4 danger ticks → 1 个 30 秒即自愈的 episode → 0 page),旧行为(N=0)在同一 episode 上会 page 1 次。故 §5-4 gate 以 MIN=0 通过;无正样本(不合成真 OOM)下不安全调大 MIN(§5-6 提前 lift 风险)。完整证据见 `min-calibration.md` + `evidence-soak-collect.mjs` + `evidence-replay-gate.mjs`。machine-watermark.ts 默认常量因此**零改动**,reverse-compat 哨兵(machine-watermark.test.ts 31/31)成立。


1. **负样本**:繁忙窗口(生产常态 20+ runner)soak ≥ 2h(复用 `evidence-soak-script.mjs` 形态,只读 vm_stat 零侵入;**不做合成内存压力** —— 生产 host 真 OOM 风险,7-09 事故先例),记录完整 `{ts, freePct, swapoutDelta}`。
2. **正样本**:已知真实压力 trace —— 优先从历史事故记录/监控数据重建(7-09、7-10 14:27);若无可用正样本 → 见 gate。
3. **分离验证(离线 replay)**:候选 MIN 下用**同一 detector**(`MemoryPressureMonitor` + `maybePage` 判定,经注入缝喂 trace)离线回放。
4. **ship gate(R2-4,硬)**:
   - **只有「选定 MIN(含 0)下完整 busy trace 零达到 N 的 page episode」才可继续** ship;
   - 若 MIN=0 会 page 且找不到安全可分离的更高 MIN(繁忙天花板贴近真 thrash 水位)→ **停 ship,回 Tadashi 重开 N/信号设计**,不合入;
   - 有正样本时:断言真实压力区间内 detector 始终 trigger、维持 hold、**绝不提前 clear/lift**,且最终 page;无正样本 → 只在「MIN=0 下 busy trace 已零 page」时才允许留 0(否则同上回 Tadashi)。
5. 通过 → 单独 commit 改默认常量(§2.2),分布 + replay 结果入 PR;env 覆盖保留。
6. 正交性(review 锚点):MIN 同作用 danger(`>MIN`)与 healthy(`≤MIN`)——正样本 replay 必含正区间「不提前 lift」断言,正是防「调大 MIN 让 healthy 过易成立、真 thrash 过早解除」。

## 6. 交付与顺序(implement 阶段;R1-5 重排)

1. TDD:先写 §2.4 测试(RED)→ §2.1 实现(GREEN)→ refactor;
2. 合同文同步(§2.3);
3. **校准数据收集前置**(soak 后台并行收数)→ 分离验证 → §5 ship gate 判定 → MIN commit(或书面「留 0/回 Tadashi」判定);
4. **最终默认值定格后**:全仓 lint + 全测试套 + E2E 全场景(§2.5)—— 保证最终 ship 形态被完整验证;
5. PR(单 PR,含 docs;Codex code review xhigh);
6. ship:纯 Bridge 侧改动 → 单次 Bridge 重启激活(攒批规范,与其他待 ship PR 协调);部署后验收 §4-4 观察窗。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| N=120 太长,真 OOM 晚报 ~2 分钟 | 真 OOM 是分钟级螺旋,hold 已在 trigger(~60s)生效挡新派发;page 只通知人。env 可调;hold 置位失败绕过 debounce 立即 fail-loud page(R1-1/R2-2) |
| 繁忙 episode 因 MIN=0 迟迟证不了 healthy → 拖过 N 误 page | 实证 episode 30-60s 内 clear;§5 ship gate 用离线 replay 在合入前就挡掉「MIN=0 仍会 page」的情形 |
| 重启丢 in-memory 闩 | deterministic eventId/dedupeId 锚 durable holdSetAt → 有调用者时的重复调用幂等;根 page 跨重启由现有 alert dedup 层在有效窗口内去重;durable hold 不丢 → 硬保护无缺口。广播跨重启补发 = best-effort(§1),不引入 durable outbox |
| MIN 调大 → healthy 过易 → 真 thrash 过早解除 hold | §5-4/6 正样本区间「不提前 lift」replay 是硬 gate;无正样本且 0 会 page → 回 Tadashi |
| 文案与实况脱节(N=0/迟滞带/unknown/manual/hold-fail) | R2-3 四类 title + 三分支 body + holdState 文案;测试 9/10/11 精确中文断言 |
| set_at 秒级精度极端同秒 re-trigger 撞 id | episode 间隔 clear,现实不同秒;implement 确认列定义,记录于 PR |
