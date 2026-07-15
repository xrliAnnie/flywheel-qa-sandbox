# FLY-1225 thread 状态前缀错标「✅完成」 — 实施计划

Issue: FLY-1225 (https://linear.app/geoforge3d/issue/FLY-1225/fix-thread-状态前缀错标完成-awaiting-reviewgate-open-被显示成已完成codex-三段式冒烟单)
日期: 2026-07-13
基于: research.md

> 本计划写给 **Implement 段（Codex gpt-5.6-sol, windowed）** 直接照做。
> 分支：`flywheel-FLY-1225`（三段共用，设计文档已在本分支）。TDD：先 RED 后 GREEN。
> Lead（Tadashi）已在 brainstorm gate 确认方向；Codex design review R1 的四项
> 反馈已全部采纳（ship-gate 持有者是 **QA** 非 implement、post-merge 短窗可达
> → 引入正向发货事实 `post_ship_finalization_claim`、HeartbeatService
> reconnect-clear 第二写入者、验证命令修正）。

## 0. 改动范围（三文件 + 三测试位点，全在 `packages/teamlead`）

| 文件 | 动作 |
|---|---|
| `src/bridge/issue-display.ts` | 改 `deriveIssueTitleBadge`（主病灶） |
| `src/bridge/issue-display-refresher.ts` | 调用点补传 raw status map + ship claim 布尔 |
| `src/HeartbeatService.ts` + `src/bridge/plugin.ts`（wiring 一行） | reconnect-clear 改走 refresher（第二写入者堵口） |
| `src/bridge/__tests__/issue-display.test.ts` | 重写 all-done pinned 用例 + 新增回归 |
| `src/bridge/__tests__/issue-display-refresher.test.ts` | **有意识改写 :342-373**（它把本 bug 钉成了预期）+ 新形态 |
| HeartbeatService 现有测试位点 | reconnect-clear 回归 |

**明确不碰**：`derivePhaseDisplayState`、faces B/C 渲染（pipeline header /
状态行——per-phase ✅=「该段活交接完」语义保留）、`stage-utils.ts` 词表、
`auto-qa-coordinator`/`auto-qa-effects` 的 stamp、legacy escape-hatch path
（`FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` 全链现行为字节兼容）。
无新 env flag、无 schema 改动（复用既有事件表 + 既有查询方法）。

## 1. `issue-display.ts` — `deriveIssueTitleBadge`

### 1.1 签名（新增两个必填输入）

```ts
export function deriveIssueTitleBadge(args: {
	phaseStates: ReadonlyMap<ThreeStagePhase, PhaseDisplayState>;
	/** FLY-1225: per-phase RAW session status（与 phaseStates 同 key 集合）。
	 *  display-state "done" 把 ship-gate boundary 也标成 done（本段活交接完），
	 *  聚合层必须回看 raw status 才能区分「交接完」和「真发货」。 */
	phaseStatuses: ReadonlyMap<ThreeStagePhase, string>;
	/** FLY-1225: 正向发货事实 —— issue 已有 post_ship_finalization_claim 事件
	 *  （= 一条经过校验的 post-ship finalization 流程已被认领；校验在其调用方：
	 *  标准路径的 merged+ship-eligible 谓词，或 external-merge 恢复路径的
	 *  head-bound trusted-approval 校验）。true 时 stale 的 awaiting_review 行
	 *  （finalization 清场前的 implement）不再挡 ✅。 */
	shipFinalizationClaimed: boolean;
	mainSessionStage?: string;
	mainSessionStatus?: string;
}): IssueTitleBadge
```

两个新参数**必填**（不给默认值）：生产调用点只有 refresher 一处，
`tsc --noEmit` 编译期强制所有调用点提供事实输入；测试同步更新。

### 1.2 all-done 分支（issue-display.ts 现 157-162 行）

```ts
const allExistingDone = [...phaseStates.values()].every((s) => s === "done");
const lastPhase =
	THREE_STAGE_PHASE_SEQUENCE[THREE_STAGE_PHASE_SEQUENCE.length - 1]!;
if (allExistingDone && phaseStates.get(lastPhase) === "done") {
	// FLY-1225: all-done by DISPLAY state is NOT proof of ship — display "done"
	// includes rows parked at a ship-gate boundary. ✅完成 requires a POSITIVE
	// ship fact: either the durable post_ship_finalization_claim (a validated
	// post-ship finalization pipeline was claimed — validation lives in its
	// callers), or every row at a terminal status. In the post-merge window the
	// parked implement row legitimately still reads awaiting_review until
	// finalization converts it — the claim covers it.
	if (args.shipFinalizationClaimed) return { kind: "completed" };
	const statuses = [...args.phaseStatuses.values()];
	if (statuses.includes("approved_to_ship")) {
		return { kind: "stage", stage: "ship" };     // 🚀ship：已批，ship 中/待执行
	}
	if (statuses.includes("awaiting_review")) {
		return { kind: "stage", stage: "approve" };  // ⏳待批：gate open 等 founder
	}
	if (statuses.every((s) => PHASE_DONE_STATUSES.has(s))) {
		return { kind: "completed" };                // 全行 terminal → ✅
	}
	// display-done 但既无发货事实也无 gate status（如 parked-running 组合）——
	// 不给 ✅，落到下方 handoff-gap 逻辑渲染 phase badge（保守、无谎言）。
}
```

要点：

- 判定顺序 **claim → 🚀 → ⏳ → 全-terminal ✅ → fall-through**（Codex R1 #1）。
- `PHASE_DONE_STATUSES`（`completed`/`merged`）已在本文件定义，直接复用。
- fall-through 落到函数既有的「no active phase → phase before first pending /
  最终 lastPhase」逻辑，渲染 phase badge —— **没有正向事实绝不 ✅**。
- `design_done` 不进 gate guard（design park 在 design_done 是常态，claim /
  全-terminal 两条 ✅ 通道已覆盖诚实收尾窗口）。
- **禁止**「任一 status=completed → ✅ 优先」（research §4 末段；qa=completed 与
  implement gated 共存可构造，会重新引入本 bug；测试 T5 钉死）。

### 1.3 单 session 分支防御 clamp（issue-display.ts 现 146-151 行）

```ts
if (phaseStates.size === 0) {
	const status = args.mainSessionStatus;
	if (status && MAIN_BLOCKED_STATUSES.has(status)) return { kind: "blocked" };
	if (status === "completed") return { kind: "completed" };
	// FLY-1225 defensive clamp: a runner-SELF-REPORTED stage=completed must not
	// render ✅ while the recorded status still waits at the ship gate
	// (label-substituting-for-fact guard; recorded status is the fact).
	if (args.mainSessionStage === "completed") {
		if (status === "awaiting_review") return { kind: "stage", stage: "approve" };
		if (status === "approved_to_ship") return { kind: "stage", stage: "ship" };
	}
	return { kind: "stage", stage: args.mainSessionStage };
}
```

只 clamp `completed` 这个撒谎值；其他自报 stage（📬PR已开 等等待态）原样保留
（相邻毛病不扩 scope，exploration §6）。refresher 的 `isQaHeld` 覆盖在 clamp
之后仍生效（条件 `badge.kind === "stage"` 不变）——QA 在跑仍显示 🧪QA。

## 2. `issue-display-refresher.ts` — 调用点（现 636-652 行）

在构建 `phaseStates` 的同一循环里并行收集 raw status，并读一次发货事实：

```ts
const phaseStates = new Map<ThreeStagePhase, PhaseDisplayState>();
const phaseStatuses = new Map<ThreeStagePhase, string>();   // FLY-1225
const phaseSessionByRole = new Map<ThreeStagePhase, Session>();
for (const s of latestPhase) {
	const role = s.chat_thread_role as ThreeStagePhase;
	phaseSessionByRole.set(role, s);
	phaseStatuses.set(role, s.status);                       // FLY-1225
	phaseStates.set(
		role,
		derivePhaseDisplayState({ role, status: s.status, park: parkFor(s) }),
	);
}

// FLY-1225: positive ship fact — post_ship_finalization_claim marks that a
// VALIDATED post-ship finalization pipeline was claimed (validation lives in
// its callers); inserted atomically via a stable event_id.
const shipFinalizationClaimed =
	isThreeStage &&
	store.countEventsByIssueAndType(issueId, "post_ship_finalization_claim") > 0;

let badge = deriveIssueTitleBadge({
	phaseStates,
	phaseStatuses,                                           // FLY-1225
	shipFinalizationClaimed,                                 // FLY-1225
	mainSessionStage: anySession.session_stage,
	mainSessionStatus: anySession.status,
});
```

- `countEventsByIssueAndType`（StateStore.ts:3117）已存在，同步 SQLite COUNT，
  与本函数其他 store 读同级开销；非三段式跳过（布尔恒 false）。

### 2.1 claim 必须进 FLY-907 reconcile fingerprint（Codex R2 #1）

推导多了一个独立 StateStore 输入，fingerprint 的定义是「统一推导所用**全部**
输入的稳定序列化」；若不进 fingerprint，sweep layer-1 只比对
`computeSessionsFingerprint`，当 claim 已插入而 phase 行 status 尚未被
finalization 改动（finalization 是 best-effort、可能 crash / 未 await
refresh）时，layer-1 会误判「显示已最新」而永不重渲 ⏳→✅。改法：

- 扩展 `computeSessionsFingerprint`（issue-display-refresher.ts:375-394）：
  其 `Pick<StateStore, …>` 依赖加上 `"countEventsByIssueAndType"`，返回的
  JSON 增加 issue 级 claim 字段（如 `fc: claimCount > 0`）。写入侧
  （refreshOnce 的 fingerprint 持久化）与比对侧（runSweep layer-1）用的是
  **同一个函数**，扩展一处即两侧一致；更新函数注释。
- **保留三段式短路**（Codex R3 #2）：函数内部从 phase 行推出 isThreeStage，
  只在三段式形态才发 claim COUNT——与推导侧「非三段式恒 false / 不查询」
  的成本口径一致。
- 推导用的布尔与 fingerprint 用的 claim 语义必须同源（同一
  `countEventsByIssueAndType(issueId, "post_ship_finalization_claim")`）。
- 回归测试：只插入 claim 事件（不动任何 session 行）→ fingerprint 变化 →
  sweep **layer-1** 将该 issue 重新入队。测试必须把 layer-1 单独隔离证明
  （stub/禁用 layer-2 或 spy layer-1 的入队条件）——gate status 非 terminal，
  普通 `runSweep()` 会经 layer-2 也入队，layer-1 断言可能被顺带蒙混过关
  （Codex R3 #3）。

其余（isQaHeld 覆盖、faces B/C）零改动。

## 3. `HeartbeatService.ts` — reconnect-clear 改走推导权威（Codex R1 #2）

`RegistryHeartbeatNotifier.stampReconnect(session, "clear")`
（HeartbeatService.ts:1775-1790）现按**单个 session** 恢复 badge：
`status==="completed"` → 直接写 ✅ 到共享 issue thread——一个 completed 的
phase 行（如非 keep-alive QA）reconnect-clear 就能在 implement 还 gated 的
issue 标题盖 ✅，与 refresher 无先后保证。改法：

1. `RegistryHeartbeatNotifier` 的构造器是**位置参数**（HeartbeatService.ts:1605-
   1621，无 `deps` 对象）——新增可选的**第七个位置参数**
   `private issueDisplayRefresh?: IssueDisplayRefreshHolder`（类型从
   `./bridge/issue-display-refresher.js` 导入；holder 是 late-bound 既有模式，
   fire 时读 `.current`）。**不做构造器改形**（Codex R2 #2）。
2. `stampReconnect` 的 `mode === "clear"` 分支开头：
   ```ts
   if (mode === "clear" && this.issueDisplayRefresh?.current) {
       // FLY-1225: the unified refresher is the title authority — a per-session
       // restore here can stamp a completed PHASE's ✅ onto a still-gated issue.
       this.issueDisplayRefresh.current.enqueue(session.issue_id);
       return;
   }
   ```
   `enter` 模式（⚠️重连中 直写）不动——refresher 的 `isReconnecting` guard
   本来就为它让路；clear 前 reconnecting 标志已被移除，enqueue 后 refresher
   出全量真值。
3. `plugin.ts`：构造 `RegistryHeartbeatNotifier` 处把已存在的
   `issueDisplayRefreshHolder` 作为第七个实参传入（holder 在 plugin.ts:3316
   已创建，早于 notifier 构造；`FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` 时
   `.current` 永不设置 → 走原 per-session 恢复分支，escape hatch 字节兼容）。

## 4. 测试（先写，RED → GREEN）

### 4.1 `issue-display.test.ts`（纯函数层）

所有现有 `deriveIssueTitleBadge` 用例补新参数。核心矩阵（display 全 done
除非注明；`claim` = `shipFinalizationClaimed`）：

| # | 形态（statuses, claim） | 期望 |
|---|---|---|
| T1 | **活体 gate-open（FLY-1224 冒烟形态）**：design=`design_done`、implement=`awaiting_review`、qa=`awaiting_review`（QA 持 gate）、claim=false | `{kind:"stage",stage:"approve"}` |
| T2 | founder 已批：同 T1 但 qa=`approved_to_ship`、claim=false | `{kind:"stage",stage:"ship"}` |
| T3 | **post-merge 短窗（Tadashi 补充用例，可达）**：qa=`completed`、implement=`awaiting_review`、design=`design_done`、claim=**true** | `{kind:"completed"}` |
| T4 | 同 T3 但 claim=**false**（含 merge_block / 未记录 merge 形态） | `{kind:"stage",stage:"approve"}` |
| T5 | completed 不得全局压 gate：design=`design_done`、implement=`awaiting_review`、qa=`completed`、claim=false | `{kind:"stage",stage:"approve"}` |
| T6 | 全行 terminal：三行均 `completed`、claim=false | `{kind:"completed"}` |
| T7 | 🚀>⏳：implement=`awaiting_review` 且 qa=`approved_to_ship`（=T2 真实序）+ 构造双 gate 组合 | `{kind:"stage",stage:"ship"}` |
| T8 | 保守 fall-through：statuses={`design_done`,`running`,`running`}（全 parked→done）、无 gate、claim=false | 非 completed——落到 phase badge（lastPhase 🧪QA） |
| T9 | claim 压过 stale gate：同 T1 但 claim=true | `{kind:"completed"}` |
| T10 | active-wins 不受影响：implement=`awaiting_review` 但 display=active（not_parked wake-rework） | `{kind:"phase",phase:"implement"}`（FLY-543 现状） |
| T11 | 单 session clamp：status=`awaiting_review`+stage=`completed` → approve；status=`approved_to_ship`+stage=`completed` → ship |
| T12 | 单 session 不误伤：status=`awaiting_review`+stage=`pr_created` → 原样；status=`completed` → completed（原 :142 用例不变） |

### 4.2 `issue-display-refresher.test.ts`（集成层）

- **有意识改写 :342-373**（原名「qa PASS … → QA✅」——它钉的正是本 bug）：
  同一形态断言标题 `{via:"stage", stage:"approve"}`；header 三行 ✅ 断言**保留**
  （faces B/C 语义不变的回归锚）。
- 新增：同形态 + store 里插入 `post_ship_finalization_claim` 事件 → 标题
  `stage:"completed"`。
- 新增：merge_block 形态（qa=`awaiting_review`+merged-unapproved，无 claim）
  → `stage:"approve"`，绝不 completed。
- 现有其他用例随签名透传（fake store 已带 status）。

### 4.3 HeartbeatService reconnect-clear 回归（放
`packages/teamlead/src/__tests__/HeartbeatService.test.ts`）

- completed QA 行 + implement `awaiting_review` + holder `.current` 已设 →
  `clear` 只调 `enqueue(issue_id)`，**绝不**调 `stampStatusBadge(completed)`。
- holder `.current` 已设时 **enter 非回归**：reconnect enter 仍直写 ⚠️重连中、
  **不** enqueue——只有 clear 换所有权（Codex R2 #2）。
- holder 缺席（escape hatch）→ 原 per-session 恢复行为不变（字节兼容锚）。

### 4.3b fingerprint 回归（§2.1）

- 只插入 `post_ship_finalization_claim` 事件（session 行不动）→
  `computeSessionsFingerprint` 输出变化 → `runSweep` layer-1 将该 issue 入队。

### 4.4 预期不动

`stage-utils-badge.test.ts` / `stage-status-emoji.test.ts`（词表零改动）。

## 5. 验证与交付（Codex R1 #4 修正命令）

1. `pnpm --filter flywheel-teamlead test` + `pnpm --filter flywheel-teamlead
   typecheck`（必填参数的编译期保证靠它）+ 全仓 `pnpm lint`。
2. PR（英文 commit/PR 文案）→ `stage set pr_created` → Codex code review（xhigh）
   → approve gate 流程（Implement 段协议既有步骤）。
3. **真机验收**（QA 段执行；本 issue 自己走三段式就会经过该形态）：
   - park 在 `awaiting_review` + gate open 的三段式 issue，标题 = ⏳待批（非 ✅完成）；
   - founder 批准 + ship 落地（claim 写入）后，标题 = ✅完成（finalization 清场
     前的短窗也 ✅）；
   - QA 进行中标题仍 🧪QA（QA-gated 语义不破）。
   - FLY-1224 冒烟验收（流程侧）：Annie 在 cmux 看到 implement 段是真 Codex
     窗口、三段交接正常。
4. **生效条件**：Bridge 侧代码 → merge 后需 Bridge 重启才生效；按「多 PR 攒一次
   重启」政策并入下一次批量重启，不为本单单独重启。

## 6. 风险与回滚

- 纯函数 + 显示层 + 一处 fire-and-forget 改道，无状态迁移；gate/merge 权威
  （verify-approval 链）零接触。回滚 = revert 单 commit。
- 新参数必填 → 遗漏调用点 `typecheck` 编译期暴露（生产仅 refresher 一处）。
- `countEventsByIssueAndType` 每次 refresh 多一条 COUNT——与既有同步读同级，
  且仅三段式 issue 执行。
- 已知不修（记录归档）：单 session 等 founder 时标题显示自报 stage（通常
  📬PR已开）而非 ⏳待批——coordinator 的 ⏳ stamp 会被 sweep 按推导覆盖；
  推导层要诚实需要 codex-gate/QA 探针进 refresher，另立 issue。
