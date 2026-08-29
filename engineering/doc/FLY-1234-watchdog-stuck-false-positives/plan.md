# FLY-1234 watchdog stuck 误报根治 — 实施计划

Issue: FLY-1234 (https://linear.app/geoforge3d/issue/FLY-1234/bug-watchdog-的-pane-judge-判定层在场却没挡住-5-次-stuck-误报-审计今天-5-个真实案例定位漏拦点)
日期: 2026-07-13
基于: research.md
版本: v5（Codex design review R1 6+4、R2 4+3、R3 4、R4 2 项缓存身份修正已全部折入）

## 0. 一句话

给 `session_stuck` 心跳管道加一道「pane/进程证据确认层」（liveness 探针 → 双帧比较 → judge 裁决，全部复用现有件），默认 ON（`FLYWHEEL_STUCK_PANE_CONFIRM=0` 才关），同时通电 judge（生产 env 加 `FLYWHEEL_WATCHDOG_JUDGE=1`）并给 judge prompt 加今天 5 案例的 few-shot —— 目标：5 案例复现形态 0 误报，真 stuck 仍准时告警。

## 1. 背景速览（详见 exploration.md / research.md）

今天 5/5 误报全走 HeartbeatService 心跳静默路径（`getStuckSessions`：running + `last_activity_at` 停更>15min，纯 DB），发射前抑制链（FLY-626 quiet 分类）无任何 pane/进程证据环节；watchdog-judge 只挂在 detection-suspicious 管道且 `FLYWHEEL_WATCHDOG_JUDGE` 未设，全天 0 调用。pane 层（StuckDetector/gap-scan）今天判定正确。BRAINSTORM GATE 已批方案：内联 checkStuck 确认层 + 借道 `routeSuspiciousReport`；新开关**默认 ON**。

## 2. 硬合同（Codex R1 折入后的设计不变量）

- **INV-1 真 stuck 不漏报（fail-open 谱系）**：确认层任何一步失败/超时/预算外/holder 未绑定 → **照发**（legacy emit）。确认层只可能因**明确的健康证据**（帧在动 / judge a_working / b_parked+机械佐证）抑制，绝不因为异常而静默。
- **INV-2 不饿死**：per-tick 预算外的候选走 legacy emit（不是顺延）—— 宁可偶发误报也不让排在后面的 dead_pin 永远轮不上（Codex R1 #1 方案 (a)）。
- **INV-3 快照新鲜**：任何 await（帧间隔/judge 队列）之后、发射之前，必须重读 session 复核；已恢复 → 本 tick **零通知、零 dedup**。（R3 #3 合同抉择：judge 审计行是「证据-裁决轨迹」，在 routeSuspiciousReport 返回前已落库，而恢复只能在其后被发现 —— 审计行**允许残留**（真实记录当时证据下的裁决）；INV-3 只承诺零通知+零 dedup，不承诺零审计行。deadline 迟到审计同此契约。测试按此口径断言。）
- **INV-4 单发射权**：确认层的 judge 路由**只做审计 + 回传裁决**，绝不触发 `notifyDetectionEpisode`（那是 suspicious 管道的私有侧效应）—— 一次确认恰好 ≤1 条 Lead 通知（Codex R1 #6）。
- **INV-5 逐字节回退**：`FLYWHEEL_STUCK_PANE_CONFIRM=0` 或 holder 未注入时，`onSessionStuck` 保持**二参调用**（sentinel 断言 arity），行为与改动前逐字节一致。
- **INV-6 pane-alive ≠ 子进程活**：liveness 探针只当**死亡检测器**用（dead → 发射）；`alive` 单独永远不构成抑制理由（Codex R1 #3）。

## 3. 交付物

| # | 交付物 | 文件 |
|---|--------|------|
| D0 | env flag 注册（**第一个里程碑**,Codex R1 #8） | `packages/config/src/feature-flags/registry.ts` + drift-test 数值 allowlist |
| D1 | 确认层纯逻辑模块 | 新 `packages/teamlead/src/bridge/stuck-pane-confirm.ts` |
| D2 | checkStuck 接入 + 并发/新鲜度守卫 + annotation 通路 | `packages/teamlead/src/HeartbeatService.ts` + `bridge/hook-payload.ts` + 两个 lead-runtime formatter |
| D3 | late-bound holder 组装 + judge deps 工厂拆分 | `packages/teamlead/src/bridge/plugin.ts` |
| D4 | judge prompt few-shot（带佐证要求） + 缓存键升级 | `packages/teamlead/src/bridge/watchdog-judge.ts` |
| D5 | 测试全套（含 R1 #9 新失败模式） | `packages/teamlead/src/__tests__/` |
| D6 | ship 运维步骤 | `~/.flywheel/.env` + Bridge 重启（攒批） |

## 4. 任务分解（TDD；顺序即依赖序，Codex R1 #10）

### T0 — env 注册与解析（D0，先行）

- `FLYWHEEL_STUCK_PANE_CONFIRM`：feature-flags registry 注册为 `default_on`，read-site = HeartbeatService（call-time 读）。
- `FLYWHEEL_STUCK_FRAME_GAP_MS`（默认 15000,**上限 60000**）、`FLYWHEEL_STUCK_CONFIRM_PER_TICK`（默认 3,**上限 20**）、`FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS`（默认 90000,**上限 300000**,见 T2）：数值 knob,进 drift-test 非布尔 allowlist。解析合同（R2 #6）：正整数且 ≤ 上限;非法/0/负/超上限 → 回默认值（**绝不**解析成 0 而禁用确认或制造饿死;超大值不得击穿延迟护栏）。**跨字段合同**：解析后若 `frameGapMs >= deadlineMs` → 两者同时回默认值 + 启动 warn（单字段各自合法但组合矛盾 = 配置错误,不静默取舍）。
- 现有 `watchdog_judge` flag 的 read-site 元数据补记新调用点（确认层路由）。
- 测试：registry drift 测试绿;解析边界（空/垃圾/0/负/超大）。

### T1 — `stuck-pane-confirm.ts`：纯决策模块（D1）

接口（较 v1 简化为单函数注入,Codex R1 #4 尾注;时钟注入,R1 #7 尾注）：

```ts
export type StuckConfirmReason =
  | "dead_pin" | "target_absent" | "target_gone" | "lookup_indeterminate"
  | "capture_failed" | "repeated_error_signature"                    // R2 #5:双帧同签名=高置信 C,直发不可被 judge 降级
  | "frames_static_judge_c_stuck" | "judge_suspicious"
  | "judge_unavailable" | "deadline_exceeded" | "confirm_error"
  | "confirm_budget_exhausted" | "confirm_unbound";                  // R2 #6:预算外/holder 断线也有界注解
  // 全部有界 enum,永不含 pane 文本或模型 rationale(R1 #5 / R2 #2)

// R2 #2 + R3 #1:每次调用一个结构化返回值;判别联合让非法 outcome/decision 组合在类型层不可构造
export type JudgeDecision =
  | { outcome: "suppressed"; decision: "a_working" | "b_parked" }
  | { outcome: "delivered"; decision: "c_stuck" | "suspicious" | "unavailable" };

export interface StuckConfirmDeps {
  probeLiveness(session: Session): Promise<"alive" | "dead_pin" | "absent" | "gone" | "indeterminate">;
    // 组装层映射:lookupTmuxTarget found→probe / gone→"gone" / error→"indeterminate"(R1 #7)
  captureFrame(session: Session): Promise<{ text: string; capturedAtMs: number } | null>;
    // capturedAtMs 由 I/O 层打点,纯模块不摸 Date.now()(R1 #7)
  frameGapMs: number;
  deadlineMs: number;                      // 端到端截止;超时 → emit(deadline_exceeded)(R1 #2)
  sleep(ms: number): Promise<void>;
  /** kind 感知的签名扫描(error-signatures.scanErrorSignatures 原样) —— 返回命中 kinds。 */
  scanErrorSignatures(text: string): Array<{ signature: string; kind: string }>;
  /** R2 #2 + R3 #1:PER-CALL 结构化 judge 路由。适配层每次调用构造全新 deps 闭包(deliver/onDecision
   *  写入本地变量),用毕即弃 —— 结构上不存在跨候选可变共享状态;不解析 annotated prose,
   *  rationale 只留在审计行;confirmNote 一律用固定 reason code。
   *  实现前提(R3 #1):`SuspiciousJudgeRoutingDeps` 本体新增可选 `onDecision?: (d: JudgeDecision) => void`,
   *  routeSuspiciousReport 内部所有终结路径(env 关/无输入/a/b/c/suspicious/null/catch)收敛到
   *  exactly-once 的 finish(decision) 单点触发 —— 工厂不得从 deliver/audit 回调反推 decision。 */
  routeToJudge(report: SuspiciousReport, ctx: { errorSignatureKinds: string[] }): Promise<JudgeDecision>;
  logger?(msg: string): void;
}

export interface StuckConfirmResult {
  action: "emit" | "suppress";
  reason: StuckConfirmReason | "frames_changing" | "judge_a_working" | "judge_b_parked";
  confirmNote?: string;                    // emit 时给 wake 的注解 = reason code 文案
}

export async function confirmStuckCandidate(session: Session, deps: StuckConfirmDeps): Promise<StuckConfirmResult>;
```

决策表（单测逐行;整体包在 deadlineMs 内,任何 throw/超时 → emit）：

| 步 | 条件 | → | reason |
|---|---|---|---|
| ① liveness | dead_pin | emit | dead_pin |
| ① | absent | emit | target_absent |
| ① | gone(lookup 无目标) | emit | target_gone（**注解不得写「进程死」**,只写目标不可解析,R1 #7） |
| ① | indeterminate | emit | lookup_indeterminate |
| ① | alive | 进② | —（alive 单独不抑制,INV-6） |
| ② 双帧 | 任一帧 capture 失败 | emit | capture_failed |
| ② | **两帧命中共同 normalized (kind, signature)**（R2 #5 / R3 #2） | emit | repeated_error_signature（高置信 C 语义,**不进 judge、不可被降级** —— 对齐 A3「C never missed」） |
| ② | 两帧 raw 不同,**双帧均无签名** | suppress | frames_changing |
| ② | 两帧 raw 不同,**单侧有签名或两侧签名不匹配** | 进③,kinds 取并集传入 buildJudgeInput | —（瞬态/单侧签名 = 不确定,交 judge;R3 #2 指名测试:单侧签名必须进 judge） |
| ② | 两帧 raw 相同,无签名 | 进③ | —（注:raw 相同则签名集必相同 —— 「相同帧仅单帧有签名」是确定性扫描器的不可达分支,已从表中移除,R3 #2） |
| ③ judge | {suppressed, a_working} | suppress | judge_a_working |
| ③ | {suppressed, b_parked} | suppress | judge_b_parked |
| ③ | {delivered, c_stuck} | emit | frames_static_judge_c_stuck |
| ③ | {delivered, suspicious} | emit | judge_suspicious |
| ③ | {delivered, unavailable}（env 关/失败/null/无帧） | emit | judge_unavailable |
| 任意 | deps throw / 截止超时 | emit | confirm_error / deadline_exceeded |

**deadline 取消语义（R2 #3）**：超时判定用注入的 deadline 调度器 + per-call closed-token —— 超时后本次调用的 deliver/onDecision 回调对 token 检查一律 no-op（迟到结果**隔离**,不得改写已完成的心跳决定、不得发第二条通知、不得污染任何后续候选）;routeSuspiciousReport 内部的审计行**允许迟到落库**（真实记录,显式选择并测试）。judge 子进程若不可中止任其自然结束（单飞队列自会排空）。

SuspiciousReport 构造同 v1（`targetKey` **保持 execId**,缓存键另走 T4 seam;frames=[帧1,帧2] 用 captureFrame 回传的 capturedAtMs）。

测试：`__tests__/stuck-pane-confirm.test.ts` —— 决策表全行、throw、deadline（fake 调度器:超时后迟到 a_working / 迟到 c_stuck 均被 token 隔离,零第二通知、零跨候选污染、审计计数符合显式选择）、重复签名不可被 fake a_working 抑制、gone 注解措辞。

### T2 — HeartbeatService 接入（D2）

1. **注入形态**：构造器尾部追加可选 `stuckConfirmHolder?: { current: ((s: Session) => Promise<StuckConfirmResult>) | null }`（late-bound holder,项目现成模式;R1 #4）。未注入或 `current === null` → 走 legacy emit（fail-open,**打一行 log**,绝非静默旁路;INV-1）。
2. **checkStuck 插入**（isStuckWakeSuppressed 之后）：

```ts
// 三态语义(R2 #6):
//   holder === undefined            → 构造方没接确认层(legacy/测试构造):走旧路径,零新日志,arity 不变
//   holder.current === null         → 生产接线故障:fail-open emit + confirm_unbound 注解 + 告警日志
//   holder.current 已绑定           → 确认层生效
if (this.stuckConfirmHolder !== undefined && this.stuckConfirmEnabled()) {
  if (this.stuckConfirmHolder.current === null) {
    confirmNote = "confirm_unbound";                             // 进发射段(fail-open,带注解)
    console.warn(`[HeartbeatService] FLY-1234 confirm holder UNBOUND — fail-open emit for ${session.execution_id}`);
  } else if (confirmBudget <= 0) {
    confirmNote = "confirm_budget_exhausted";                    // 进发射段(INV-2:预算外=legacy emit,带注解)
    console.log(`[HeartbeatService] FLY-1234 confirm budget exhausted — legacy emit for ${session.execution_id}`);
  } else {
    confirmBudget -= 1;
    const snapshot = { status: session.status, lastActivityAt: session.last_activity_at };
    const r = await this.stuckConfirmHolder.current(session);
    // INV-3 + R2 #7:确认后重读 + 全量廉价闸重放 —— 快照相等性判恢复(字符串等值,不做 JS 时间解析),
    // 再依次重放 isMonitorSuppressed / alreadyNotifiedStuck / isStuckWakeSuppressed;任一不过 → continue(静默,不 dedup)
    const fresh = this.store.getSession(session.execution_id);
    if (!fresh || fresh.status !== "running" || fresh.last_activity_at !== snapshot.lastActivityAt) continue;
    if (this.isMonitorSuppressed(session.execution_id)) continue;
    if (this.alreadyNotifiedStuck(fresh)) continue;
    if (this.isStuckWakeSuppressed(fresh)) continue;
    if (r.action === "suppress") { log(...); continue; }        // 不落 dedup → 下 tick 重估
    confirmNote = r.confirmNote;                                 // 进发射段
  }
}
```

3. **重入守卫**（R1 #2）：`checkStuck` 加 `stuckCheckRunning` in-flight flag（parkedSweepRunning 同款）——上一轮未完成时本 tick 跳过（log 一行）。`check()` 对 `checkStuck` 的 await 保持现状（后续 phase 延后是既有语义,重入守卫已断放大链）。
4. **annotation 通路**（R1 #5,三件套缺一不可）：
   - `HeartbeatNotifier.onSessionStuck(session, minutes, details?: { confirmNote?: string })` —— 可选第三参。
   - `HookPayload` 加可选 `confirm_note?: string`（hook-payload.ts）。
   - 共享 `formatSessionStuck(payload)` 渲染函数,`commdb-lead-runtime.ts` 与 `mailbox-lead-runtime.ts` 的 session_stuck 分支都改用它（否则 formatter 丢未知字段,注解落库不可见 —— R1 #5 核心）。
   - kill-switch 关/holder 空时**保持二参调用**（sentinel 断 arity,INV-5）。
5. `stuckConfirmEnabled()`：`process.env.FLYWHEEL_STUCK_PANE_CONFIRM !== "0"`,call-time 读。

测试（R1 #2/#1 + R2 #6/#7 指名场景全覆盖）：suppress 不调 notifier 不落 dedup;emit 带 confirmNote 三参;`holder===undefined` → 二参 legacy 零新日志;`current===null` → 三参 emit 带 confirm_unbound + warn;env=0 → 二参 legacy;**饿死回归**（5 会话,前 3 个每 tick 被抑制,第 4 个必须以 `confirm_budget_exhausted` 注解 legacy emit 立即告警 —— 断言的是预算注解,不是 dead_pin:预算外会话按设计未被探测,R2 #6）;**并发**（两次 check() 重叠 → 第二次跳过）;**帧睡眠期间恢复**（await 中 last_activity_at 刷新 → 不发射不 dedup;快照字符串等值判定,不做 JS 时间解析）;**await 后闸重放**（await 期间出现 pending_gate/declared busy/monitor-lost/他路 dedup → 不发射,R2 #7）;**exactly-once**（judge 慢队列下同 episode 只落一次 dedup+一条 lead event）。

### T3 — plugin.ts 组装（D3）

1. **holder 声明 + start 顺序修正**（R1 #4 / R2 #4）：`const stuckConfirmHolder = { current: null }` 在 HeartbeatService 构造（~:4000）前声明并传入。**关键事实（R2 #4 核实）**：现源码 `heartbeatService.start()` 在 ~:4385,而 judge 接线在 ~:4804,两者之间有多个 `await`（transport 动态 import、milestone-config 加载）—— 「同一同步启动段」**不成立**。修正：**把 `heartbeatService.start()` 移到 judge 接线 + `stuckConfirmHolder.current` 绑定之后**（保留 `seedReconnecting()` 在 start 前的既有顺序);boot 测试用**故意缩短的 interval** 证明任何 tick 都观察不到未绑定瞬态（仅断言「createBridgeApp 返回时已绑定」不够,R2 #4 原话）。
2. **judge deps 工厂拆分**（R1 #6 / R2 #2）：提炼 `buildJudgeRoutingDeps({ deliver, onConfirmedStuck, onDecision?, judgeCacheKey? })` —— 共享部分 = judgeEnabled / judge 实例 / auditSuppression / **audit-only** 的 confirmed-stuck 事件插入 / mechanicalParkEvidence / buildJudgeInput;**`notifyDetectionEpisode` 只属于 suspicious 管道的 `onConfirmedStuck` 注入**,确认层注入 no-op（单发射权,INV-4）。`onDecision` 每次调用回传 `JudgeDecision` 结构化结果（心跳适配层 per-call 闭包接收,R2 #2）。现有 `deliverSuspicious` 重构为用同一工厂（不传 onDecision/judgeCacheKey → 行为不变,回归测试兜底）。
3. `probeLiveness` 映射（R1 #7）：`lookupTmuxTarget` `found`→probe / `gone`→"gone" / `error`→"indeterminate"。
4. `captureFrame`：`defaultCaptureSession(execId, projectName, 200)` + I/O 层打 capturedAtMs。
5. 集成断言（R1 #6）：确认层 judge c_stuck → 恰好 1 条 lead event（session_stuck）+ 1 条 `watchdog_judge_confirmed_stuck` 审计行,**0 次** notifyDetectionEpisode。

### T4 — judge prompt few-shot + 缓存键升级（D4）

1. **few-shot（带佐证要求,R1 #3）**：

```
Known healthy-but-quiet formations (real production cases, 2026-07-13). IMPORTANT: these
downgrades require corroboration from the runtime context — static pane text ALONE is never
sufficient:
- External code/design review wait: review-driver output at tail AND a recent comm/stage event
  indicates the review started → a_working. No such corroboration → suspicious.
- Long thinking turn: a LIVE spinner line ("esc to interrupt", "✻ … Ns") in the CURRENT frame → a_working.
- Test suite / long build: runner/build output at tail AND no error signature AND recent comm/stage
  corroboration → a_working. Stale-looking test output with no corroboration → suspicious.
```

2. **缓存键 seam**（R1 #3 → R2 #1 → R3 #4 三轮收敛后的最终合同）：`routeSuspiciousReport` 的 deps 加可选 `judgeCacheKey?: (report, input) => string`,默认 = `report.targetKey`（suspicious 管道零变化）。**`report.targetKey` 始终保持 execId** —— owner 解析、getSession、mechanicalParkEvidence、审计 execution_id 全依赖真实 execId,不得污染（R2 #1）。心跳路径注入的键 = **带版本号的规范化序列化再哈希**（R3 #4,消灭字符串拼接的边界碰撞）：

```ts
const canonical = JSON.stringify({
  v: "heartbeat-v1",                          // 命名空间版本(R4 #1):与 suspicious 管道的裸 targetKey 键空间隔离
  targetKey: report.targetKey,                // R4 #1:执行身份进键 —— 不同 runner 即使证据投影全同也绝不共享裁决
  evidence: {
    frames: frames.map((f) => f.text),        // RAW 文本(非 quietFingerprint —— 它洗掉 spinner/计时器会让 raw 不同的画面同键,R2 #1)
    stage: input.stage ?? null,
    fsm: input.fsmStatus ?? null,
    park: input.park ?? null,
    // R4 #2:ageMs 是决策证据(few-shot 佐证要求"recent") —— 编码为与佐证策略对齐的有界 recency 桶,
    // 事件从"新鲜"老化跨过阈值 → 键变 → 重新裁决;绝对毫秒仍不进键(墙钟每 tick 都变会废掉缓存)。
    comm: (input.commEvents ?? []).map((e) => ({
      kind: e.kind, summary: e.summary,
      recent: e.ageMs < commCorroborationMs,     // R5 非阻塞备注:直接取 stuckCommActivityMs(env) 的生效值,不引入第二个 30min 字面量;override 测试含 0 与 60000(0 = 佐证桶恒 false,与 quiet 分类器豁免同步失效,两处永不漂移)
    })),
    sigKinds: [...errorSignatureKinds].sort(),
  },
});
const key = sha256hex(canonical).slice(0, 32);
```

   **时间字段合同（R3 #4 + R4 #2 收敛）**：`frames[].capturedAtMs` 排除（纯墙钟元数据）;`commEvents[].ageMs` **以 recency 桶入键**（它是佐证性证据 —— 排除会让「佐证已过期但 a_working 还被 10min 缓存续命」）。真实 ageMs 仍照常进 judge prompt（judge 看精确年龄,缓存看证据身份+recency 桶）。
3. 测试：prompt 断言三形态+佐证文案;缓存键 —— **同 exec+同证据(仅时钟变、桶未跨) → 命中;同 exec+任一证据分量变 → 重判;不同 exec+证据投影全同 → 不共享裁决（R4 #1 指名）;comm 事件身份/内容不变但从佐证桶老化到过期桶 → 必须触发新 judge 调用（R4 #2 指名回归）**;边界碰撞（frames=["ab","c"] vs ["a","bc"] 必须不同键,JSON 数组天然防拼接碰撞,测试钉死）;interop:同实例共享单飞队列,不同键不串缓存。

### T5 — 测试全套补强（D5,R1 #9）

在 T1-T4 各自用例之上：
1. **sentinel**：`FLYWHEEL_STUCK_PANE_CONFIRM=0` → 行为+调用 arity 逐字节旧;holder 未注入同断言。
2. **fixture 化 5 案例**：用真实形态 pane fixture（codex review driver 尾 / spinner 帧 / bash 输出帧 / 静止+活进程 / dead_pin）走**真 buildJudgeInput**,断言喂给 judge 的 stage/comm 上下文真实（不是决策表同义反复）;judge 用 fake 返回各 verdict。
3. **真机段**（gated,implement/QA 阶段;R2 #7 校准）：真 judge（FLYWHEEL_WATCHDOG_JUDGE=1）——(a) 静止 sleep pane **且播种了真实佐证上下文**（近期 stage/comm 事件表明长任务在跑）→ 期望 a_working suppress;(b) **反例**:同样静止 pane、pane 进程活、但无任何佐证上下文 → 按新 prompt 期望 suspicious → emit（钉死「pane 活+静止输出单独不够」）;(c) kill 后 remain-on-exit 尸体（dead_pin）→ emit。断言「仅 pane 活」不足以被描述成「build/review 子进程活」（R1 #9 尾）。
4. R1 指名新增：饿死、重入、await 后恢复、lookup error、annotation 端到端渲染（两 runtime formatter 出文案）、双通知回归（notifyDetectionEpisode 0 次）、缓存键换帧重判。

### T6 — ship 运维（D6,只剩运维,代码注册已前移 T0）

① 生产 `~/.flywheel/.env` 加 `FLYWHEEL_WATCHDOG_JUDGE=1`;② Bridge 重启（与在途 PR 攒批;config 先落再重启,FLY-205 教训）;③ 部署后观察合同:次日起 session_stuck 告警必须携带 confirm_note —— 无注解裸告警=确认层被绕过,视为回归。报告附 declare-state busy 纪律建议（不进本 PR）。

## 4.5 收敛守则（Lead 关键输入：别造第四个不一致的检测器）

现存三个 pane 检测积木：FLY-92 RunnerIdleWatchdog（capture + `waitingThresholdCycles=2` 两轮确认）、#576/FLY-720 `probeRunnerProcessLiveness` 四态探针、FLY-1048 stuck-candidate/judge。本确认层**不引入任何新检测语义** —— 探针原样调用、帧比较用 FLY-195 `fingerprintOutput` raw 判据、「看两次」即 FLY-92 两轮思想（tick 内双帧）、错误签名复用 error-signatures、裁决借道 FLY-1048 `routeSuspiciousReport`（共享 judge 实例与单飞队列）。新文件只含**顺序编排**,无自有阈值/指纹算法/告警通道。彻底合流成单一「现实核查」原语 = 后续 issue（BRAINSTORM GATE 裁决①）。

## 5. 验收（issue 原文口径 + R1 #3 措辞校准）

1. 5 案例复现形态（**静止 pane + 佐证性运行时上下文** —— 本 PR 不采集子进程信号,措辞按 R2 #7 校准;issue 原文的「活跃子进程」由「佐证上下文 + judge」等价覆盖）回归：**0 误报**（fixture 段 + 真机段）。
2. 真 stuck：dead_pin / target absent / 静止帧+judge c_stuck / 确认层任何异常 —— **全部照发**（决策表 emit 行 + 饿死回归 + deadline 测试）。措辞校准：本 PR 保证的是「**确认层绝不因异常而吞报**（fail-open 谱系,INV-1）+ 已建模形态的准确分类」;「任意形态真 stuck 零漏报」是整个检测族（含管道 B 错误签名路径）的系统性质,不由本 PR 单独宣称（Codex R1 #3）。
3. `FLYWHEEL_STUCK_PANE_CONFIRM=0`：行为+arity 逐字节回退（sentinel）。
4. 全仓 `pnpm lint` + teamlead 全测 + feature-flag drift 测试绿;CI 绿。
5. 部署后观察合同见 T6 ③。

## 6. 风险登记

预算外=legacy emit（误报回旧不劣化,真 stuck 不饿死）· 重入守卫断放大链 · 快照重读关过期告警 · capture 只读无扰 · suppress 不落 dedup+死亡探针兜底 · judge 单飞+per-episode 缓存键限成本又消 stale · 纯 Bridge 侧单次重启生效（攒批）。

## 7. 里程碑顺序（R1 #10）

T0（env registry+解析）→ T1（纯模块）→ T2（Heartbeat 注入+并发/新鲜度+annotation 通路）→ T3（holder 组装+工厂拆分+单发射集成）→ T4（prompt+缓存键）→ T5（sentinel/fixture/interop/真机 QA）→ PR → Codex code review → 独立 QA → founder gate → T6 ship。
