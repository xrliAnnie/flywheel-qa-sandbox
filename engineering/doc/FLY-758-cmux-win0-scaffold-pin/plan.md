# FLY-758 cmux workspace 钉在 win0 空壳 — 实施计划

Issue: FLY-758 (https://linear.app/geoforge3d/issue/FLY-758/cmux-workspace-钉在-win0-空壳没跟-runner-的真-window-geo-436-空-pane关掉又重生cass)
日期: 2026-07-02
基于: research.md

## 1. 目标

runner spawn 后,base session `runner-<project>` 里不再残留从没用过的 win0 空壳
window。cmux/cmux-sync 结构性地不可能再把 workspace pin 到空 win0 → Annie 点
workspace 直接看到 runner 内容,不再空 pane、不再关掉又重生空的。

Lead(Tadashi)已批方向 2、方向 1 转 backlog。

## 2. 改动清单(修订 — 采纳 Codex design review R1)

**Codex R1 抓到两点**(全采纳):
- **HIGH**:`CodexTmuxAdapter` 是独立 `implements IAdapter`(非 subclass `TmuxAdapter`),
  有自己的 `execute()`/`ensureSession()`/`new-window`,同样留空 win0 → 只改
  `TmuxAdapter.execute()` 覆盖不到 codex backend。⇒ 提取**共享导出函数**,claude/agy/kimi
  (继承 TmuxAdapter.execute())与 codex 两条路径都调用。
- **MEDIUM**:`TmuxAdapter` 默认 sessionName=`"flywheel"`,legacy `TmuxRunner` + e2e 脚本会
  建非 `runner-*` session;"只碰 runner-*" 只是生产约定、没有代码 guard。⇒ 方法内加显式
  `runner-` 前缀 guard,把 blast-radius 声明在 API 边界坐实。

改动:1 个共享函数 + 2 个调用点 + 单测(TmuxAdapter + CodexTmuxAdapter)。

### 2.1 `packages/claude-runner/src/TmuxAdapter.ts` — 新增共享导出函数

放在文件底部(`defaultExecFile` 附近,已是本文件的导出工具函数)。签名用 `ExecFileFn`
(本文件已定义并被 CodexTmuxAdapter import),`keepWindowId` = 刚创建的 runner window,
显式排除(防御纵深:即便某窗被误命名成裸 shell 名,也绝不杀刚建的这个)。

```ts
/**
 * FLY-758: shell names that identify the never-used default scaffold window
 * tmux forces onto a `new-session`-created base session. Runner windows are
 * created with `-n <issueId>-claude-…` (→ tmux disables automatic-rename for
 * them), so they never match.
 *
 * EXACTLY `zsh` + `bash` — the same set cmux-sync's inventory + window-unlinked
 * cleanup paths already treat as default scaffolds
 * (scripts/flywheel-cmux-sync.sh:316-317, :2293-2301). Kept in lockstep so this
 * new `kill-window` source can never fire a window-unlinked event for a name
 * cmux-sync doesn't recognize as a shell (which would let it enqueue cleanup for
 * an unmanaged title — Codex design review R2 MEDIUM). tmux's automatic-rename
 * uses `#{pane_current_command}` (leading login-shell dash stripped), so the
 * macOS/Linux scaffold surfaces as `zsh`/`bash`, never `-zsh`/`-sh`; a non-zsh
 * /bash login shell simply no-ops (no regression).
 */
const SCAFFOLD_SHELL_NAMES = new Set(["zsh", "bash"]);

/**
 * FLY-758: remove the never-used default-shell scaffold window from a runner
 * base session so cmux can never pin an empty workspace at it. Shared by
 * TmuxAdapter (claude/agy/kimi) and CodexTmuxAdapter — both create the same
 * scaffold via `new-session -d` and both launch runners in separate windows.
 *
 * Call AFTER the caller's runner `new-window` succeeded (session then has ≥1
 * real runner window). Safety invariants:
 *  - runner-session scoped: no-op unless sessionName starts with "runner-"
 *    (Lead `flywheel` / legacy / e2e sessions untouched — Codex R1 MEDIUM);
 *  - never kills `keepWindowId` (the runner window we just created);
 *  - only kills a bare default-shell-named window; runner windows never match;
 *  - ≥2 windows required → never kills the session's last window;
 *  - idempotent (scaffold gone → no bare-shell window → no-op);
 *  - best-effort: any failure swallowed; never blocks/fails a spawn.
 */
export function pruneScaffoldWindow(
  execFileFn: ExecFileFn,
  sessionName: string,
  keepWindowId: string,
): void {
  if (!sessionName.startsWith("runner-")) return;
  try {
    const result = execFileFn("tmux", [
      "list-windows",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{window_id}|#{window_name}",
    ]);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return; // never kill the session's last window
    for (const line of lines) {
      const sep = line.indexOf("|");
      if (sep < 0) continue;
      const windowId = line.slice(0, sep);
      const windowName = line.slice(sep + 1);
      if (windowId === keepWindowId) continue; // never the just-created runner window
      if (!SCAFFOLD_SHELL_NAMES.has(windowName)) continue;
      execFileFn("tmux", ["kill-window", "-t", windowId]);
      return; // at most one scaffold
    }
  } catch {
    // best-effort — never block or fail a spawn on scaffold pruning.
  }
}
```

**调用点 A — `TmuxAdapter.execute()`**:FLY-245 durable-commit 块之后(约 L510)、
`// GEO-206 Phase 2: Register session`(约 L511)之前:

```ts
// FLY-758: drop the never-used default-shell scaffold (win0) so cmux can't pin
// an empty workspace at it (safe now that this runner's window exists).
pruneScaffoldWindow(this.execFileFn, this.sessionName, windowId);
```

选此位点:runner window 已创建成功(`windowId` 已拿到)且 launch 未 abort
(FLY-245 commit-write 失败会 throw,不会走到这里)。

### 2.2 `packages/claude-runner/src/CodexTmuxAdapter.ts` — 同样调用

import:`import { pruneScaffoldWindow } from "./TmuxAdapter.js";`(已 import 该文件的
`ExecFileFn`/`defaultExecFile`)。

**调用点 B — `CodexTmuxAdapter.execute()`**:`const windowId = launch.stdout.trim();`
(L307)之后、CommDB `registerSession`(L317-)之前:

```ts
// FLY-758: same win0 scaffold prune as TmuxAdapter (codex has its own execute()).
pruneScaffoldWindow(this.execFileFn, this.sessionName, windowId);
```

注:codex 的 FLY-245 durable commit 在**首次注入点**(injectAtIdlePrompt),比这里晚 —
此处 codex runner window 已是活的裸 shell 注入宿主,但其窗名 = `-n windowName`(label,
automatic-rename 关)绝非裸 shell 名 → 不被 prune 误杀;`keepWindowId=windowId` 再兜一层。

### 2.3 测试

> **重要**:prune-positive 用例**必须**用 `runner-*` session 名(`new
> TmuxAdapter("runner-test", fn)`),否则新加的 `runner-` guard 会 suppress 掉被测行为
> (Codex R2 提醒;现有 fixture 默认 "flywheel"/"testsess" 会 no-op)。

**`packages/claude-runner/test/TmuxAdapter.test.ts`**:`makeMockExec` options 加
`listWindows?: string`,`list-windows` 分支返回它(默认 `""` = 字节兼容)。新增用例:
1. `prunes the win0 zsh scaffold` — `new TmuxAdapter("runner-test")`,listWindows=
   `@0|zsh\n@42|GEO-TEST-claude-fix`(windowId=`@42`)→ 断言 calls 含 `kill-window -t @0`,
   **不含** `kill-window -t @42`。
2. `never prunes when only the runner window exists` — `runner-test`,listWindows=
   `@42|GEO-TEST-claude-fix` → 无 `kill-window -t @42`(避免杀成空 session)。
3. `never prunes a runner-named window` — `runner-test`,listWindows=
   `@1|GEO-A-claude-a\n@2|GEO-B-claude-b` → 无 kill-window。
4. `runner- scope guard: TmuxAdapter("flywheel") never prunes` — `new TmuxAdapter("flywheel")`
   + listWindows 含 `@0|zsh` + runner 窗 → 无 kill-window(护 Lead/base session)。
5. `never kills the just-created windowId even if shell-named` — `runner-test`,listWindows=
   `@42|zsh\n@7|GEO-…-claude`(windowId=`@42`)→ `@42` 被 keepWindowId 排除、`@7` 非
   zsh/bash → 无 kill-window(防御纵深)。
6. `only prunes zsh/bash, not sh/-zsh` — `runner-test`,listWindows=`@0|sh\n@42|GEO-…-claude`
   → 无 kill-window(证 predicate 与 cmux-sync 对齐,不引入 unmanaged cleanup 事件)。
7. `best-effort: list-windows throw never fails execute()` — list-windows 抛错 → execute()
   仍 resolve 成功。
8. 字节兼容(隐式):默认 listWindows="" → 无额外 kill-window,护现有断言。

**`packages/claude-runner/test/CodexTmuxAdapter.test.ts`**:比照其现有 mock 加一个
codex-path 用例,session 名用 `runner-codex-test`:listWindows 含 `@0|zsh` + codex runner
窗 → 断言 codex `execute()` 也发出 `kill-window -t @0`(证 HIGH 修复:codex backend 被覆盖)。
现有 codex fixture 默认 `"testsess"`(非 runner-)→ 新 guard 下天然 no-op、不破坏现有断言。

> 注:kill-window target 断言用**具体 window_id**(如 `@0`),与 FLY-86 timeout 清理路径的
> `kill-window -t <windowId>`(仅 `sessionStatus==="timeout"` 触发,正常完成不触发)天然区分。
> 用例走 `paneDead:true` 正常完成路径。

## 3. 不做的事(scope 边界)

- 不改 cmux-sync(方向 1 → backlog)。
- 不动 GEO-436 活 runner(纯代码,只影响未来 spawn)。
- 不改 ensureSession 的 new-session(scaffold 在建 session 时无法避免,只能事后清)。
- 不加 env 开关 / 配置项(行为对所有 runner 一致、且天然字节兼容 —— 无 scaffold 时
  no-op)。

## 4. 验证

1. `pnpm --filter flywheel-claude-runner test`(TmuxAdapter 单测全绿,新用例 RED→GREEN)。
2. 全仓 `pnpm lint`(biome format,防 CI 第一轮挂)。
3. Codex design review(本文件)→ Codex code review(PR)。
4. **QA(真机,Bridge auto-QA 或独立 runner)**:spawn 一个真 runner → `tmux
   list-windows -t =runner-<proj>` 确认无裸 shell win0 → cmux 点该 workspace 直接见
   runner 内容(非空 pane)。这是产品级验收(cmux 展示对不对),不是纯技术断言。

## 5. 风险与回滚

- **风险**:极低。best-effort + 严守卫(runner- 前缀 + keepWindowId 排除 + 裸 shell 名
  + ≥2 窗);失败 no-op;字节兼容(无 scaffold / 非 runner session → no-op)。
- **回滚**:revert 共享函数 + 两个调用点。行为退回"留 win0 空壳"(= 现状),不引入新失败模式。

## 6. 修订 — QA(FLY-758)抓出时序竞态,补 ensureRunnerSession 改名

**QA 真机 FAIL(commit 1deeac10)**:name-only `{zsh,bash}` prune 在**主事故场景**里
静默 no-op。真机 tmux 3.5a 实测:fresh base session 的 scaffold 窗初始名是 **"tmux"**
(automatic-rename 异步,要等 zsh 加载完 rc 出 prompt ~8s 才翻 "zsh"),而
`ensureSession→new-window→prune` 是毫秒级 → `{zsh,bash}` 不匹配 "tmux" → prune 漏掉
→ win0 存活。这正是 GEO-436 场景(base session 新建 + 首个 runner,每次 reboot/tmux
重启后每项目必经)。单测 mock 直喂 `@0|zsh` 掩盖了竞态。

**独立复现确认**(真 tmux):
- `pane_current_command` **不可靠**:scaffold 与 runner 窗每个时刻相同(t=0 都 zsh、
  t=2s 都 bash、t=8s 都 zsh)→ QA 建议 #1(pane_current_command 双判)会**误杀 codex
  裸 shell runner 窗**,否决。
- 可靠判别只有 window_name:runner 窗 `-n` 建 → automatic-rename **关** → 名字永不变
  (实测 runner 窗全程保持 label);scaffold 无 `-n` → auto-rename 开 → "tmux"→"zsh"。

**修法(Option X,最小增量,pruneScaffoldWindow 逻辑不变)**:新增导出 helper
`ensureRunnerSession(execFileFn, sessionName)`,两 adapter 的 `ensureSession()` 委托它。
建 session 时 `new-session -d -P -F "#{window_id}"` 捕获 scaffold 窗 id,立刻
`rename-window <id> zsh`。手动 rename **同时**设名 + **禁用** automatic-rename(tmux 3.5a
实测:此后恒 "zsh" 不翻回)→ `pruneScaffoldWindow` 的 name predicate 在毫秒时可靠命中。
改名成 "zsh"(非自定义 sentinel)让后续 kill-window→window-unlinked 事件的名字仍在
cmux-sync 已 skip 的默认 shell 集里 → **不引入 unmanaged cmux cleanup,不用碰 cmux-sync**。
runner- 前缀 scoped + best-effort(rename 失败退回老化清理路径,不阻塞 spawn)。

**测试补强(QA 明确要求真 tmux 集成用例)**:
- 单测:`ensureRunnerSession` 建+改名(runner-)/复用不改名/非 runner 不改名/-P-F 失败
  回退 plain create 不抛。
- 新 `scaffold-prune.real-tmux.test.ts`(真 tmux,无 tmux 自动 skip):确定性复现
  "tmux" 名 scaffold 证 name-only 会 miss + `ensureRunnerSession` 强制 "zsh" 后 prune
  真删 + keepWindowId 保护 zsh 名窗 + ≥2 窗 guard 真机验证。
- 全套 278/278;真 tmux 4 用例 3 次连跑确定性绿。
