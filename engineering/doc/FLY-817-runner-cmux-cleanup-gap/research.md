# FLY-817 收口 runner/cmux 清理缺口 — 调研(代码触点)

Issue: FLY-817 (https://linear.app/geoforge3d/issue/FLY-817/infracleanup-收口-runnercmux-清理缺口-验证已上线的-crash-reaper-真在工作-清现存-100-僵尸记录)
日期: 2026-07-03
基于: exploration.md

---

## 1. 目标(brainstorm gate 已批的方案)

选项 A:新增 `reconcileCommDbRunningAgainstFsm` —— 删 CommDB `status='running'` 且 FSM ∈ 终态集的行。boot sweep(清 backlog)+ heartbeat tick(防复发)双接。全生产项目通用。复用 `CLOSE_ELIGIBLE_STATES` + `deleteCommDbSession` 原语。restart-gated,kill-switch env。外加 FLY-724 式 reaper QA + 一次性 cmux 787-class 死 pin 清理(ops,非代码)。

---

## 2. 复用的现有原语

### 2.1 CommDB API(`packages/flywheel-comm/src/db.ts`)
- `new CommDB(dbPath)` —— 构造(commdb-session-prune.ts 已这么用)。
- `listSessions(projectName, ["running"])` (`db.ts:684`) —— 拿某项目所有 running 行。
- `deleteSession(executionId): number` (`db.ts:663`) —— `DELETE ... WHERE execution_id=?`,返回 changes。
- `close()`。

### 2.2 终态集(`packages/teamlead/src/bridge/close-runner.ts`)
- `CLOSE_ELIGIBLE_STATES` (`close-runner.ts:78`) = `AUTO_CLOSE_STATES` {completed,rejected,deferred,shelved,terminated} ∪ `CRASH_PRESERVE_STATES` {failed,blocked} —— **权威终态集,直接 import,不手搓**。
- 注:reconcile 删的是 **CommDB 行**(纯注册表清理),不改 FSM、不撤 tmux,所以 failed/blocked 的「保留 tmux 供 Annie 看」语义**不受影响**(那是 tmux window 的事)。CommDB 里一个 failed 行是纯僵尸,删它无损。

### 2.3 StateStore(`packages/teamlead/src/StateStore.ts`)
- `getSession(executionId): Session | undefined` (`:2032`) —— PK 查,快。取 `.status` 判终态。
- reconcile 只依赖一个 lookup fn `(execId) => status | undefined`(解耦 StateStore 类型,便于单测),plugin 侧传 `id => store.getSession(id)?.status`。

### 2.4 现有 sweep 参照(`packages/teamlead/src/bridge/commdb-session-prune.ts`)
- `pruneDeadTerminalCommDbSessions(project)` —— FLY-638 boot sweep,**只扫 CommDB status∈{completed,timeout}** + per-row tmux 探活。我的 reconcile 是它的**兄弟**:扫 CommDB status='running',cross-ref FSM 终态,**无 tmux 探活**(纯 SQLite,快)。
- `resolveCommDbPath(project)`、`deleteCommDbSession(execId, project, dbPath?)` —— 可复用/参照(路径解析已带 traversal 防护 `/[/\\]|\.\./`)。

---

## 3. 接线点

### 3.1 boot sweep(`packages/teamlead/src/bridge/plugin.ts` ~3319-3352)
FLY-638 boot sweep 是 fire-and-forget per-project async 块(因它有 tmux 探活会慢)。我的 reconcile **无探活**,可在**同一块**里、每 project **先跑 reconcile(快)再跑 638 prune**。那时 `store`(StateStore)与 `projects` 都在作用域内。两者候选集不相交(running vs completed/timeout),无交互。

### 3.2 heartbeat tick(`packages/teamlead/src/HeartbeatService.ts` check() ~214-243)
- `check()` 已按 `monitorReconcile` / `crashReaperConfig` 的「wired 才 await」范式挂了多个 pass。
- 新增可选注入 `reconcileCommDb?: () => Promise<CommDbFsmReconcileTotals>`,在 check() 里(crash-reaper 之后)best-effort 调用;**未注入(legacy/test)→ skip**,保 fake-timer 测试时序 + 字节兼容。
- plugin 侧闭包 `() => reconcileAllProjectsCommDbAgainstFsm(projects, store, log)`,与 boot 共用同一个「遍历所有 project 跑 reconcile」函数(DRY)。无新 timer(复用 heartbeat,FLY-169/172 范式),无 tmux 探活 → 近零成本。

### 3.3 kill-switch env
`FLYWHEEL_COMMDB_FSM_RECONCILE !== "0"`(默认 ON,镜像 `FLYWHEEL_CRASH_REAPER` 形态)。boot + tick 两侧都读同一开关。

---

## 4. task 4(cmux 死 tab)—— 为何是 ops 一次性、不是代码

- `terminal-tab-reaper.ts` 只关 **Terminal.app 标签页**(AppleScript),**不杀 tmux window/cmux dead-pin**。
- `crash-reaper.ts` 只 reap **FSM=running** dead-pin(killCmuxLinkedSession + killTmuxWindow)。
- **没有任何现存 sweep 处理「FSM 终态 + cmux dead-pin」**。而 787 两个死窗口(window 4/12,名字都是 `FLY-787-claude-...`)分别对应 completed + failed 两个 execId,**从窗名无法可靠区分**;failed 是 CRASH_PRESERVE(Annie 可能要看 scrollback)→ 安全的**自动化** cmux-terminal-dead-pin sweep 做不到无误伤。
- 故本 issue:task 4 = **deploy 期一次性 ops 清理**(人工逐窗 inspect 后清 AUTO_CLOSE 类死 pin,保 failed/blocked、保 806 awaiting_review),**不进代码**。持续性 cmux-terminal-dead-pin reaper(含 window→execId 映射 + PRESERVE 处理)= **follow-up issue**(Lead 已批 806 留 follow-up,cmux 自动 sweep 一并归入)。

---

## 5. 测试范式

- `packages/teamlead/src/__tests__/commdb-fsm-reconcile.test.ts`(新)—— 参照 `crash-reaper.test.ts` / 现有 commdb-prune 测试:用**真临时 sqlite CommDB**(`new CommDB(tmpPath)` 写 running/completed/... 行)+ 注入 `fsmStatusOf` map,断言:
  1. FSM 终态(7 态逐个)→ 删。
  2. FSM 非终态(running/awaiting_review/approved_to_ship/pending/reconnecting)→ 保留。
  3. FSM 缺失(map 无此 execId)→ 保留(测试 scratch 豁免)。
  4. CommDB 非 running(completed/timeout)→ 不在候选、不动。
  5. 计数 `{scanned, reconciled, kept}` 正确。
  6. 坏 dbPath / 抛错 → 吞掉不抛(best-effort)。
- 多项目聚合函数测试:`reconcileAllProjectsCommDbAgainstFsm` 遍历、per-project 失败不影响其他。
- HeartbeatService:注入 reconcile 回调 → check() 调它;未注入 → 不调(字节兼容 + fake-timer 时序)。

---

## 6. 风险与边界

- **只读 FSM、只删 CommDB 行**:不碰 FSM、不撤 tmux、不动 Discord thread → 回归面极小。
- **按 execId 删**:终态不可逆转 running;retry successor 是不同 execId → 永不误伤活 runner。
- **8 真活天然豁免**(FSM 非终态);测试 scratch(TestProject 4849/proj 912,无 FSM 行)天然豁免(无终态证据)。
- **幂等**:与 `deleteCommDbSession` 删同一行,早删一步无害。
- **best-effort**:任何一步抛错 log warn 吞掉,绝不阻塞 boot / 不 crash heartbeat(对齐 638/720 形态)。
