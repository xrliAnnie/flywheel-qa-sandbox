# Plan: FLY-1239 Codex founder TUI 撞 rollout 落盘 race — bounded retry-on-death

**Version**: v1.56.0（暂定，ship 取实际空号）
**Issue**: FLY-1239 (https://linear.app/geoforge3d/issue/FLY-1239/bug-codex-founder-tui-开窗撞-rollout-落盘-race-threadresume-no-rollout)
**日期**: 2026-07-13
**基于**: engineering/doc/FLY-1239-tui-rollout-race/exploration.md, research.md
**Status**: codex-approved（Codex design review R3 APPROVED；R1 7 条 + R2 3 条全并入）

## 0. 一句话

founder TUI 在 `onThreadReady`（rollout 落盘前）开窗 → `codex resume --remote` 读不到 rollout 秒死。加**非阻塞 bounded retry-on-death**：每次死了在事件循环空隙重开，直到 attach 成功或用尽（fail-loud），全程不阻塞 goal 循环；每次重开前**按 window_id 证明性清掉旧窗**（≤1 窗口，不堆尸）。

## 1. 改动清单

| 文件 | 改动 |
|------|------|
| `packages/claude-runner/src/codex-runner-tui-window.ts` | 返回 `boolean`→`RunnerTuiWindowOutcome`；step 3 换成 **ID-based purge-and-verify**（可证清空才建窗） |
| `packages/claude-runner/src/CodexTmuxAdapter.ts` | retry（首击也走 scheduler）+ `scheduleReopen` dep + `threadReadySeen` + no-throw 边界 + `runEnded` cancel；导出常量 |
| `packages/claude-runner/src/index.ts` | 补 re-export `type RunnerTuiWindowOutcome` |
| `packages/claude-runner/test/codex-runner-tui-window.test.ts` | 断言更新 + **multiset(keyed by window_id)** no-pile-up 测试 |
| `packages/claude-runner/test/CodexTmuxAdapter.test.ts` | **队列式 scheduler** + 顺序断言 + retry 行为 |
| `scripts/qa-fly-1188-e2e.mjs` | 一行 `.created` |
| `scripts/qa-fly-1239-e2e.mjs` | **新增**真机 harness（真 daemon + 真 tmux → TUI 活着显示 thread） |

## 2. `codex-runner-tui-window.ts` — 返回值细化 + 证明性 stale 清理

### 2.1 返回类型
```ts
export type RunnerTuiWindowOutcome =
  | { created: true }
  | { created: false; reason: "tmux-absent" | "create-failed" | "died" };
```

### 2.2 ⭐ ID-based purge-and-verify（Codex R1 HIGH-1：tmux 允许同名窗口）

**根因**：tmux **允许重复 window name**；现 `kill-window -t =sess:=name`（结果被忽略）在已有重复时 `can't find window` 退 1，两个窗都留下 → 后续同名 kill 恒歧义失败 → 堆尸。固定名 + kill-before-create **必要但不充分**。

**改** `ensureRunnerTuiWindow` 步骤（`execOut` 已有 `defaultExecOut`）：
1. `tmux -V` 缺失 → `{created:false, reason:"tmux-absent"}`。
2. `new-session -Ad -s <sess>`（幂等 ensure）。
3. **purge**：`execOut tmux list-windows -t =<sess> -F "#{window_id} #{window_name}"`；
   - 列举失败（execOut undefined）→ **无法证明干净** → `{created:false, reason:"create-failed"}`（不建窗；fail-open，run 继续）。
   - 逐行解析 `<@id> <name...>`，对 `name === windowName` 的每个，用**不可变 id** `kill-window -t <@id>`（无歧义）。
4. **⭐ re-ensure（Codex R2 MED-1）**：再 `new-session -Ad -s <sess>`。tmux 会话不能有 0 窗口——若同名窗是会话仅有的窗、step 3 全杀会**销毁会话**（repo 先例 `TmuxAdapter.ts:1259` 拒杀最后一窗）；re-ensure 若被销毁则重建空壳（含一个**异名** scaffold 窗，不撞 windowName），未销毁则 no-op。
5. **verify**：再 `list-windows` 复查；若仍有 `name === windowName` 残留（或复查列举失败）→ `{created:false, reason:"create-failed"}`（不建窗）。
6. `new-window -d -t =<sess> -n <windowName> <buildRunnerTuiCommand>`；`!ok` → `{created:false, reason:"create-failed"}`。
7. settle(默认 800ms) 后 `isRunnerTuiWindowAlive`：死 → `{created:false, reason:"died"}`（保留「DIED immediately」fail-loud 日志）；活 → `{created:true}`（保留「up」日志）。
8. `catch (err)` → `{created:false, reason:"create-failed"}`（fail-open 日志保留）。

**不变量**：`assertShellSafe`（配置错→throw fail-loud）保留在函数内既有位置；settle/liveness 逻辑不动。**新增保证**：任意时刻 `new-window` 只在「已证明无同名残留」后调用 → 结构上 ≤1 **同名**窗（re-ensure 的异名 scaffold 不计入 windowName 计数，不弱化 Lead 不变量）。

## 3. `CodexTmuxAdapter.ts` — 非阻塞 bounded retry（首击也 async）

### 3.1 常量（模块级导出）
```ts
export const TUI_OPEN_MAX_ATTEMPTS = 8;      // 每条 chain 的上限（含首击）
export const TUI_OPEN_RETRY_GAP_MS = 900;    // 重试间隔
```

### 3.2 dep + 默认 + safeErr
```ts
scheduleReopen?: (fn: () => void, ms: number) => () => void; // 返回 cancel
// 默认：unref'd setTimeout
this.scheduleReopen = deps.scheduleReopen ??
  ((fn, ms) => { const t = setTimeout(fn, ms); (t as {unref?:()=>void}).unref?.(); return () => clearTimeout(t); });
```
`safeErr(err)`（R2 LOW-3）：模块内不抛的错误格式化（同 codex-runner-tui-window 的 `errMessage` —— `instanceof`/`.message`/`String()` 全包 try，恶意 message getter 也不再抛），用于所有异步 no-throw catch。

### 3.3 execute() scope 改造
局部：`tuiOpened`(留)、`tuiOpening`、`runEnded`、`threadReadySeen`、`cancelReopen?: () => void`、`attemptN = 0`。

```ts
const buildSpec = (threadId: string) => ({ tmuxSession: this.sessionName, windowName,
  codexHome, socketPath, cwd: sandboxCwd, threadId, codexBin: rawCodexBin() });

const wireCreated = (): void => {
  tuiOpened = true;
  const windowId = this.resolveWindowId(windowName);
  if (windowId) tmuxWindow = `${this.sessionName}:${windowId}`;
  if (ctx.onTmuxWindowCreated) {
    try { ctx.onTmuxWindowCreated({ baseSessionName: this.sessionName, windowId: windowId ?? windowName }); }
    catch (err) { console.warn(`[CodexTmuxAdapter] onTmuxWindowCreated failed: ${(err as Error).message}`); }
  }
};

// R1 MED-4：整个尝试放 no-throw 边界（异步回调抛错绝不崩进程 / 破坏 fail-open）。
const attemptOpen = (threadId: string, n: number): void => {
  try {
    if (runEnded || tuiOpened) { tuiOpening = false; return; }
    attemptN = n;
    const outcome = this.ensureWindow(buildSpec(threadId), { log: (m) => this.log(m) });
    if (outcome.created) { wireCreated(); tuiOpening = false; return; }
    // died-only 可重试；tmux-absent / create-failed 一击即止。
    if (outcome.reason === "died" && n < TUI_OPEN_MAX_ATTEMPTS && !runEnded) {
      cancelReopen = this.scheduleReopen(() => attemptOpen(threadId, n + 1), TUI_OPEN_RETRY_GAP_MS);
      return; // 仍 opening
    }
    if (outcome.reason === "died") {
      // R1 LOW-7 / R2 LOW-3：只报次数；died 只证「settle 期即时退出」不证 no-rollout，故措辞为
      // 「反复即时退出，rollout race 为预期主因，详见前面 runner-tui-window 日志/命令」。fail-loud：run 继续。
      this.log(`runner-tui-window: founder TUI exited immediately on every attempt (${n}) — most likely the rollout-landing race, but could be an auth/binary/TTY bootstrap failure; see the preceding runner-tui-window log for the exact command. The run continues (machine client drives the goal); the founder cannot watch the pane.`);
    }
    tuiOpening = false;
  } catch (err) {
    // R2 LOW-3：用不抛的 safeErr（同 codex-runner-tui-window 的 errMessage 形态），防恶意 message getter 再抛破坏边界。
    this.log(`runner-tui-window: attempt threw (non-fatal, fail-open): ${safeErr(err)}`);
    tuiOpening = false; // 停这条 chain；窗口失败永不中断 run
  }
};

// hook-driven：单飞 + **首击也经 scheduler**（R1 MED-2：让 onThreadReady 先返回、setGoal 先发，再有任何 settle 阻塞）。
const startOpenChain = (threadId: string): void => {
  if (tuiOpened || tuiOpening || runEnded) return;
  tuiOpening = true;
  try { cancelReopen = this.scheduleReopen(() => attemptOpen(threadId, 1), 0); }
  catch (err) { tuiOpening = false; this.log(`runner-tui-window: schedule threw (non-fatal): ${safeErr(err)}`); }
};

const onThreadReady = (threadId: string, restarts: number): void => {
  threadReadySeen = true;                       // R1 MED-3
  this.persistSessionState(ctx, threadId, windowName, latestDaemonPid);
  if (restarts > 0 && tuiOpened && !this.isWindowAlive(windowName)) tuiOpened = false; // pane 随旧 socket 死 → 重开
  startOpenChain(threadId);
};
```

fallback（`runGoal` 后）—— **仅在 hook 从未触发时、同步一击、不重试**（R1 MED-3），且**自带 no-throw 边界**（R2 MED-2：否则 fallback 抛错落进 execute() 外层 catch → `classifyGoalOutcome` 让 `caughtError` 盖过成功 goal → 可见性失败把成功 run 变失败）：
```ts
if (!threadReadySeen && !tuiOpened && outcome?.threadId) {
  try {
    const o = this.ensureWindow(buildSpec(outcome.threadId), { log: (m) => this.log(m) });
    if (o.created) wireCreated();
  } catch (err) {
    this.log(`runner-tui-window: fallback open threw (non-fatal, fail-open): ${safeErr(err)}`);
  }
}
```
（run 已结束、rollout 已在、finally 随即 killWindow，故 fallback 一次足矣、无需重试链。`safeErr` = 不抛的 errMessage 形态。）

### 3.4 finally cancel（最前，先于 killWindow / drained await）—— Codex R1 认可
```ts
} finally {
  runEnded = true;
  cancelReopen?.();          // 防 teardown 期/后再 spawn 指向死 socket 的窗口
  stopGateWatcher();
  // ...其余 finally 原样（killWindow / runtime.stop / drained / commDb / scrub）
```

## 4. 「不堆尸 ≤1 窗口」保证（Lead 硬要求，Codex R1 HIGH-1 收紧）

- windowName 每 attempt **恒定**。
- `ensureRunnerTuiWindow` 每次建窗前 **按 window_id 清掉所有同名窗 + 复查零残留**；无法证明干净 → 不建窗（`create-failed`）。
- ⇒ 连败 N 次：任意时刻该 runner 在 cmux 里 ≤1 同名窗，且**永不**在有同名残留时 `new-window`。

## 5. 测试计划（TDD：先红后绿）

### 5.1 `codex-runner-tui-window.test.ts`
- 现有 `toBe(true/false)` → `.created` / `.reason`；verb 序列断言更新为 `[new-session, list-windows, kill-window*(per id), new-session(re-ensure), list-windows(verify), new-window]`。
- 分类：`tmux-absent` / `create-failed`(new-window 非 0) / `died`(settle 后死) / throw→`create-failed`。
- **⭐ no-pile-up（multiset keyed by window_id，非 Set-by-name）**：有状态 fake tmux 维护 `Map<id,name>` + `sessionExists` 布尔，并**建模 tmux「杀最后一窗→销毁会话」**（R2 MED-1）：`new-session -Ad` 置 `sessionExists=true`（若原不存在则加一个异名 scaffold 窗）；`new-window` 生成新 id 加入（需 session 存在）；`kill-window -t <@id>` 删该 id，**若删后 session 内 0 窗 → `sessionExists=false` 清空**；`list-windows -F` 在 session 不存在时返回 undefined(模拟 `no server`)、否则输出全部 `<id> <name>`。用例：
  1. 一个 stale 同名窗（会话另有异名窗）→ kill-by-id、复查零残留、才 new-window；同名计数从干净起 ≤1。
  2. **预置两个同名重复窗** → 都被 kill-by-id、复查零、才 new-window（按 id 清歧义）。
  3. **⭐ 同名窗是会话唯一窗** → step 3 全杀销毁会话 → **step 4 re-ensure 重建会话** → verify 零同名残留 → new-window 成功（证明 last-window 边界不再误判 create-failed）。
  4. **kill 后仍残留同名**（模拟 kill 无效）→ verify 发现残留 → `create-failed`、**断言 `new-window` 从未被调**。
  5. `list-windows`（verify）失败且 re-ensure 未恢复 → `create-failed`、`new-window` 未调。
  - 全程断言：只要有同名残留就绝不 `new-window`；从干净起同名计数不超 1。

### 5.2 `CodexTmuxAdapter.test.ts`
- `ensureWindow` 注入返回 `RunnerTuiWindowOutcome` 序列（依次弹出、末值粘滞）。
- **队列式 scheduler**（R1 MED-5）：`scheduleReopen: (fn,ms) => { queue.push({fn,ms}); return () => {…cancel…}; }`；测试手动 `drain()`。
- **顺序断言**：FakeRuntime 在 onThreadReady 后记录 `goalProgress` marker；断言：onThreadReady 返回时 attempt **尚未跑**（仅入队）→ goalProgress 后手动 drain → attempt 才跑（证明「hook 返回→goal 推进→retry」次序，而非同步阻塞）。
- 用例：① died×2→created：drain 3 次 → attempt=3、latch、onTmuxWindowCreated。② died×MAX：**恰 MAX** 次、fail-loud 日志、无第 MAX+1。③ `tmux-absent`/`create-failed`：**恰 1** 次（不重试）。④ 每 attempt spec.windowName 恒定。⑤ 非重试 outcome + hook 已触发 → fallback **不**再开（threadReadySeen）；hook 从未触发 → fallback 同步一击。⑤b **⭐ fallback fail-open**（R2 MED-2）：hook 从未触发 + outcome 成功 + fallback `ensureWindow` **抛错** → 断言 adapter 结果**仍 success**（caughtError 未被污染）+ teardown 照跑。⑥ finally cancel 次序：断言 cancel 先于 killWindow/stop/drained；cancel 后调捕获的 fn → `runEnded` 保证不再建窗。⑦ throwing `ensureWindow`/`scheduleReopen` → fail-open 不崩、tuiOpening 清、chain 停。⑧ restart-while-opening → 只剩一条 chain。⑨ 保留 MEDIUM-1 latch-only-on-success / restart reopen。

### 5.3 真机 `scripts/qa-fly-1239-e2e.mjs`（复用 1236 A3 形态）
真 `codex app-server` + 真 worktree + 真 tmux：起 runtime → onThreadReady 早开 →（首击可能 died）→ bounded retry → `isRunnerTuiWindowAlive` + `capture-pane` 断言 **pane 活着且显示 thread 内容**（非空、非 `no rollout found`）+ **仅一个该 runner 窗口**。证据落 `engineering/doc/FLY-1239-tui-rollout-race/qa/`。exit 0 = PASS。

## 6. 非目标 / 保留不变

- 不碰 lead-side `tui-window.ts`（sidecar 持续驱动、rollout 早在，不撞此 race）。
- 不碰 setGoal / objective-4000（1236 已修，正交）。
- fail-open 总纲不变（窗口失败永不中断 run）；`assertShellSafe` 的 fail-loud throw 保留（配置错，正常不触发）。
- 字节兼容不涉及（纯 runner 侧行为修复；无 config/env 开关）。

## 7. 风险

- **事件循环冻结**：每 attempt 的 800ms 同步 settle 冻结事件循环；bounded（≤8）+ 900ms 间隙让出；首击改 async 后 setGoal 帧先发，风险降低。RPC 超时 30s、daemon 独立进程 → 不致破坏 goal setup。真机 harness 兜底验证 socket/goal 健康。异步 settle 列为**后续**（本 PR 不做，保简单）。
- **rollout 极慢**（若可 resume 依赖首轮完整输出、数十秒）：~13s 天花板可能不够 → fail-loud 日志、run 不受影响。codex SessionMeta 于 thread/start 即写、实测亚秒级，风险低；真机验证。
