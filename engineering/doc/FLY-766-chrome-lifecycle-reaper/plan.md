# FLY-766 claude-in-chrome 内存尖峰真根 — 实施计划

Issue: FLY-766 (https://linear.app/geoforge3d/issue/FLY-766/infrap0-claude-in-chrome-qa-会话是内存尖峰真根-chrome-生命周期回收-并发上限751-覆盖不到)
日期: 2026-07-02
基于: research.md

## 0. 范围

**本次交付 A + B**(治本):
- **A. 用完必关(总是 on,治本)** = per-runner `TMPDIR` 注入(确定性归属)+ 归属型 chrome reaper(会话到终态,周期 tick 内回收其 chrome)。post-fix 的所有 claude-runner chrome 都被此路径确定性回收。
- **B. 孤儿兜底** = ① **归属 no-row 孤儿**(owner-marker 证明本机、row 被 prune):boot + ppid1 + idle≥grace **自动**回收(总是 on);② **不可归属**(旧系统 `$TMPDIR` 残留,含现 39 个):**默认 log-only 不杀**(防误杀 49h 人工等待期的 live pre-fix chrome)—— 清现 39 个需 ops **一次性** opt-in `FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1` 跑一次 boot 后移除(Codex R3 LOW-NEW-1;详见 §7 runbook)。
**不做**:C(admission gate 限流)= fast-follow 单独 issue;D(共享池)= defer;codex/agy/kimi adapter 的 TMPDIR 注入 = follow-up(v1 = claude-tmux)。

## 1. 交付物一览

| # | 文件 | 改动 |
|---|------|------|
| 1 | `packages/teamlead/src/bridge/chrome-session-reaper.ts`(**新**) | reaper 核心:枚举 → 安全选择器 → 归属 → kill 规则 |
| 2 | `packages/teamlead/src/bridge/__tests__/chrome-session-reaper.test.ts`(**新**) | 单测(mock ps + mock StateStore + mock fs.stat) |
| 3 | `packages/claude-runner/src/TmuxAdapter.ts` | 构造新增 `ownerStateDbPath?`;spawn 注入 `-e TMPDIR=<runner-state>/<execId>/browser-tmp` + mkdir/chmod + 写 owner marker |
| 4 | `packages/claude-runner/test/TmuxAdapter.test.ts`(Codex R1 LOW-6 路径修正) | 断言 TMPDIR + marker(含 ownerStateDbPath)注入(两分支)+ byte-compat |
| 5 | `packages/teamlead/src/bridge/plugin.ts` | boot one-shot 挂载(viewer-reaper 旁)+ 独立周期 timer + `:memory:` guard |
| 6 | `packages/teamlead/src/StateStore.ts` | **新增** `getDbPath()` getter(返回实际 `dbPath`;Codex R2 HIGH-1)|
| 7 | `packages/teamlead/src/bridge/run-infra.ts` | `setupRunInfrastructure` 把 `store.getDbPath()` 作 `ownerStateDbPath` 传给 claude-tmux TmuxAdapter factory(Codex R3 HIGH-NEW-1)|

## 2. 模块设计:chrome-session-reaper.ts

```
export interface ChromeReapResult {
  scanned; killedAttributedTerminal; killedAttributedOrphan;
  killedUnattributedIdle; skippedActive; skippedForeign;
  skippedUnattributedFresh; racedSkipped; errors[];
}

// 纯函数:把「comm 表 + command 表(按 pid join)」的一条 → 结构
export function parseChromeProc(pid, ppid, comm, command): ParsedChrome | null
  // 命中当且仅当(Codex R1 HIGH-2:身份认 comm,不是 argv 子串):
  //   (1) 可执行身份 = OS 报告的 `comm`(basename == "Google Chrome for Testing"
  //       或 comm 绝对路径在 "~/.agent-browser/browsers/" 下)。
  //       —— runner(claude/node)进程的 comm 是 claude/node,哪怕它 argv/prompt
  //          里带着 "Google Chrome for Testing"/".agent-browser/browsers/"/
  //          "--user-data-dir=...agent-browser-chrome..." 也永不命中。
  //   (2) command(argv)有 --user-data-dir=<path> 且 <path> 含段 "agent-browser-chrome-"。
  //   (3) main 进程 —— command 无 "--type="(筛掉 renderer/gpu/utility)。
  // 返回 { pid, ppid, userDataDir, execId|null }
  // execId = userDataDir 里 "runner-state/<execId>/browser-tmp/" 的 <execId>(否则 null=不可归属)

// 主入口(boot 与 periodic 共用;mode 控制是否跑 B)
export async function reapChromeSessions(deps: {
  store; ownStateDbPath;                  // = store.getDbPath();本 Bridge 实际打开的 db 路径(所有权真相)
  runnerStateRoot;                        // ~/.flywheel/runner-state
  mode: "boot" | "periodic";
  migrateUnattributed;                    // FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1(默认 false=log-only)
  unattributedIdleGraceMinutes;           // 默认 30(Codex R1 MED-3;仅 attributed no-row + migrate 用)
  listCommByPid?; listCmdByPid?;          // 注入:两个 ps pass(测试可 mock)
  readOwnerMarker?; killProc?; statMtime?; revalidatePid?; nowMs?;
}): Promise<ChromeReapResult>
```

**所有权证明(Codex R1 HIGH-1 + R2/R3 HIGH-1 — 防误杀同机 QA slot,且默认生产必须匹配)**:多 Bridge 共享 `~/.flywheel/runner-state/`,`runnerStateRoot` 前缀**不足以**证明归属。spawn 时在 `<browser-tmp>/.flywheel-owner.json` 写 `{ execId, stateDbPath }`(见 §3)。reaper 读该 marker,只有 `marker.stateDbPath === ownStateDbPath` 才算「本 Bridge 所有」。
- **owner 真相 = 从 Bridge 组合根线程下来的实际 store 路径,不做 env 解析、不跨包(Codex R3 HIGH-NEW-1)**:
  - **不用** `ctx.stateDbPath`(它是 runner 侧 `FLYWHEEL_STATE_DB_PATH`/verify-approval 专用,规则不同)。
  - **不用** `resolveStateStoreDbPath(process.env)`:① `startBridge` 的 store 可能来自注入的 `opts.store` 或程序化 `config.dbPath`,**未必来自 env** → env 解析未必等于实际打开的 store;② `claude-runner` **不能**反向 import `teamlead/config.ts`(依赖方向反了)。故**丢弃** config.ts 共享 resolver 方案。
  - **正解**:`StateStore.getDbPath()`(**新增** getter)是唯一真相。`setupRunInfrastructure(store, …)`(run-infra:467,已持有 `store`)取 `ownerStateDbPath = store.getDbPath()`,作为**构造参数**传给 `TmuxAdapter`(新增可选第 7 位 `ownerStateDbPath?`,claude-runner 只收一个 string,无跨包 import)。TmuxAdapter 写 `marker.stateDbPath = this.ownerStateDbPath`。reaper 侧 `ownStateDbPath = store.getDbPath()`。**两侧同一 store 同一值 → byte-identical by construction**(不依赖 env / 不受注入 store 影响)。
- 默认生产两侧都 = `~/.flywheel/teamlead.db` 匹配;QA slot(`TEAMLEAD_DB_PATH` slot-local)marker = slot 路径,生产 reaper own = 默认 → 不匹配 → `skippedForeign`;注入 store(embedder)也是它自己的路径,一致。
- **仅 claude-tmux(TmuxAdapter)本次注入 TMPDIR+marker**(v1 范围 = Annie 痛点 = claude QA runner)。codex/agy/kimi adapter 的 chrome 保持不可归属 → log-only 安全不误杀、但不自动回收 → **follow-up**。

**kill 规则**:
- **归属**(execId≠null):读 owner marker →
  - marker 缺失 / `stateDbPath` 不匹配 → **skip**(记 `skippedForeign`;可能是 QA slot / 未知)。
  - marker 证明本 Bridge 所有:
    - `store.getSession(execId)` 终态(`OUTCOME_STATUSES` 去 `approved_to_ship`,复用常量)→ **kill**(`killedAttributedTerminal`,periodic + boot 都杀 = 确定性用完必关)。
    - **无 row**(row 被 prune 的真孤儿,但 owner-marker 已证明本 Bridge 所有)→ **仅 boot** 且 `ppid==1` 且 profile idle ≥ grace 才 kill(`killedAttributedOrphan`;idle 门防杀「刚 spawn、marker 已写但 row 未注册」的启动中 chrome;owner-marker 证明是本机的,故安全);periodic 一律 skip。**这是 post-fix 孤儿的自动兜底(总是 on)**。
    - 活着(running/pending/awaiting_review/approved_to_ship)→ **skip**(`skippedActive`)。
- **不可归属**(execId=null / 无 owner marker,如旧系统 `$TMPDIR` 残留 / Bridge 侧 ProofShot):**默认 log-only(Codex R2 MED-1)** —— 因为 live pre-fix chrome 在 49h 人工 gate 等待期也是 `ppid==1` + profile idle > 30min,自动杀会误伤活浏览器。默认只记 `wouldKillUnattributed` 日志、不杀;**opt-in `FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1`** 才在 `mode==="boot"` + `ppid==1` + idle ≥ grace 真杀(`killedUnattributedIdle`,给 ops 清当前 39 backlog 的一次性安全 lever)。periodic 完全不碰。
- **kill 前 PID 复验(Codex R1 MED-5 — 防 PID 复用)**:SIGTERM 前用 `revalidatePid(pid)` 重读该 pid 的 comm+command,要求仍解析为同一 `userDataDir` + 同一 chrome-main 身份;不匹配 → skip(记 `racedSkipped`)。
- kill = `process.kill(pid, "SIGTERM")`(main 挂→子进程随退);`ESRCH`(已死)当成功。best-effort,失败进 errors 不抛。
- 每次 kill 写 audit event `chrome_session_reaped`。**identity 非空(Codex R2 LOW-1;`session_events.execution_id/issue_id/project_name` 均 NOT NULL)**:归属 kill 用真 execId + session 的 issue_id/project(无 row 时 issue_id/project = "unknown");unattributed kill 用合成 `execution_id: "chrome-unattributed:<pid>"`、`issue_id/project_name: "unknown"`,真 pid/ppid/userDataDir 进 payload。

**枚举(Codex R1 HIGH-2)**:两个 `ps` pass 按 pid join —— pass1 `ps -Awwo pid=,comm=`(可执行路径,`comm` 含空格但整行「pid + 其余」可切),pass2 `ps -Awwo pid=,ppid=,command=`(argv 取 `--user-data-dir`)。`comm` 是 OS 报告的可执行、argv 骗不了它。**不用** `-E`/`-e`(泄 env)。`ps` 经 `execFile` + bounded timeout(Codex R1 MED-4)。

## 3. TMPDIR 注入 + owner marker(TmuxAdapter.ts)

- **注入 gate(Codex R4 MEDIUM)**:`TmuxAdapter.execute()` 是 agy/kimi 的**共享基类**(`AntigravityTmuxAdapter`/`KimiTmuxAdapter` extends 并继承 execute)。TMPDIR+marker 注入必须 **gate 到 `this.type === "claude-tmux"`**(v1 范围),否则 agy/kimi pane 也会被改 TMPDIR。测试断言 kimi/agy adapter **不**注入 TMPDIR。
- gate 内、在 `envArgs.push("-e", ...FLYWHEEL_RUNNER_STATE_DIR...)` 逻辑处,mailbox 与 rollback 两分支外:
  ```
  const browserTmp = join(homedir(), ".flywheel", "runner-state", ctx.executionId, "browser-tmp");
  mkdirSync(browserTmp, { recursive: true });
  chmodSync(browserTmp, 0o700);                       // Codex R1 LOW-7:chrome profile 状态,收紧权限
  // owner marker(Codex R1/R2/R3 HIGH-1):stateDbPath = 构造参数 this.ownerStateDbPath(= store.getDbPath())
  const markerPath = join(browserTmp, ".flywheel-owner.json");
  writeFileSync(markerPath,
    JSON.stringify({ execId: ctx.executionId, stateDbPath: this.ownerStateDbPath ?? null }), { mode: 0o600 });
  chmodSync(markerPath, 0o600);                        // Codex R2 LOW-7:预存 marker 的 mode 修复
  envArgs.push("-e", `TMPDIR=${browserTmp}`);
  ```
- **owner 真相 = `this.ownerStateDbPath`(TmuxAdapter 新增构造参数,由 `setupRunInfrastructure` 传 `store.getDbPath()`)**,不做 env 解析、不 import teamlead(Codex R3 HIGH-NEW-1)。`ownerStateDbPath` 未传(旧调用点/其它 adapter)→ marker 写 null → reaper 视为 foreign skip(安全默认)。
- **TMPDIR/marker 只在 claude-tmux 注入**;写 marker/TMPDIR 与 `sentinelDir`(仅 mailbox 分支)解耦、两分支都做。
- 现 `sentinelDir` 只在 mailbox 分支建;TMPDIR 的 mkdir/marker 独立(不依赖 sentinel 分支)。
- claude prompt 文件是 spawn 前解析的绝对路径 → 不受 runner TMPDIR 改变影响。
- best-effort:mkdir/marker 失败 → 记 warn 不注入(退回系统 TMPDIR,该 runner 的 chrome 变不可归属,由 B 兜底);不阻断 spawn。

## 4. plugin.ts 挂载

- **`:memory:` guard(Codex R3 MED-NEW-1)**:`store.getDbPath() === ":memory:"`(单测/embedder)→ **不挂载** boot + periodic reaper(否则测试会枚举真机进程 + 起 timer 副作用)。`chrome-session-reaper.test.ts` 用 file-backed + 全 mock 直测,不受影响。
- **boot one-shot**(viewer-session-reaper 挂载块旁,同 import() 模式):`reapChromeSessions({ store, ownStateDbPath: store.getDbPath(), runnerStateRoot, mode:"boot", ... })` → log 计数。boot 与 periodic **共享同一 `chromeReaperRunning` 单飞守卫**(Codex R2 note:防 boot 未跑完首个 periodic tick 就并发)。
- **周期 timer**(对标 `fleetReconcileTimer`/`leadAlertDrainTimer` 的独立 `setInterval`):默认 60s,`reapChromeSessions({ ..., mode:"periodic" })`。**Codex R1 MED-4**:`chromeReaperRunning` 单飞守卫 + 整个回收 `.catch()` log 不抛 + `listComm/listCmd/revalidatePid` **boot 与 periodic 都**用 `execFile` bounded timeout;`timer.unref()` 不挡退出;`close()` 里同 `leadAlertDrainTimer`/`fleetReconcileTimer` 一起 `clearInterval`。
- **env 旋钮**:
  - `FLYWHEEL_CHROME_REAPER=0` → boot + 周期都关(默认 ON)。
  - `FLYWHEEL_CHROME_REAPER_INTERVAL_MS`(默认 60000)。
  - `FLYWHEEL_CHROME_REAPER_ORPHAN_GRACE_MIN`(默认 30,attributed no-row + unattributed-migrate 的 idle-grace)。
  - `FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1`(默认关=unattributed 只 log-only;开=boot 真杀 unattributed 孤儿,清 39 backlog 的一次性 lever;Codex R2 MED-1)。

## 5. 测试

**chrome-session-reaper.test.ts**(mock listComm/listCmd/killProc/statMtime/readOwnerMarker/revalidatePid/store):
- 选择器:Chrome-for-Testing main(comm=`Google Chrome for Testing`)命中;`--type=renderer` 行被筛;无 `--user-data-dir` 不命中。
- **对抗性(Codex R1 HIGH-2)**:一条 `comm=claude`(或 node)、command 里**同时**含 `Google Chrome for Testing` + `.agent-browser/browsers/` + 伪 `--user-data-dir=...agent-browser-chrome...`(即 runner 正在评审本 plan 的形态)→ **绝不命中**(身份认 comm)。
- `/Applications/Google Chrome.app`(默认 profile,comm=`Google Chrome`,user-data-dir 无 `agent-browser-chrome-`)**不**命中。
- 归属:从 `runner-state/<execId>/browser-tmp/agent-browser-chrome-x` 解析出 execId。
- **所有权(Codex R1 HIGH-1 + R2 HIGH-1)**:marker.stateDbPath == ownStateDbPath → 本 Bridge;marker 缺失 / 不匹配(QA slot 的 db)→ `skippedForeign` 不杀。**三情形(R2 HIGH-1)**:①默认生产(无 env)marker 与 ownStateDbPath 都 = `~/.flywheel/teamlead.db` → 匹配可杀;②QA slot(`TEAMLEAD_DB_PATH` slot-local)marker=slot 路径,生产 reaper own=默认 → 不匹配 skip;③`FLYWHEEL_STATE_DB_PATH` 与 `TEAMLEAD_DB_PATH` 分叉时 marker 仍认 `TEAMLEAD_DB_PATH`(= 实际 store)不被带偏。
- kill 规则:本 Bridge 归属 + 终态→kill;running→skip;approved_to_ship→skip;本 Bridge 归属 + 无 row + boot + ppid1 + idle≥grace→kill;无 row + periodic→skip;无 row + boot + idle<grace(启动中)→skip。
- **B unattributed(Codex R2 MED-1)**:默认 `migrateUnattributed=false` → 只记 `wouldKillUnattributed` **不杀**(即便 boot+ppid1+idle≥grace);`migrateUnattributed=true` + boot + ppid1 + idle≥grace → kill;`mode:"periodic"` 不可归属**从不** kill/log-kill。
- **PID 复验(Codex R1 MED-5)**:revalidatePid 返回不同 userDataDir → `racedSkipped` 不杀。
- **audit identity(Codex R2 LOW-1)**:unattributed kill(migrate on)写 event 用合成 `execution_id: "chrome-unattributed:<pid>"` + issue/project="unknown" 不抛(NOT NULL 满足);归属 kill 用真 execId。断言两条路径都成功写 event。
- kill-switch:调用方 gate(plugin 层);killProc 抛 → 进 errors 不抛;单飞守卫(boot+periodic 共享)。

**StateStore/run-infra 测试(Codex R3/R4)**:`StateStore.getDbPath()` 返回构造时的实际 dbPath(含 `:memory:` 与 file 路径两情形);`setupRunInfrastructure` 把 `store.getDbPath()` 作 `ownerStateDbPath` 传入 claude-tmux TmuxAdapter factory(agy/kimi factory **不**传)。~~旧 `resolveStateStoreDbPath(env)` 方案已丢弃,无相关测试~~。

**adapter scope 测试(Codex R4 MEDIUM)**:claude-tmux(`type==="claude-tmux"`)注入 TMPDIR+marker;`KimiTmuxAdapter`/`AntigravityTmuxAdapter` **不**注入 TMPDIR(共享基类 execute 被 gate)。

**plugin `:memory:` guard 测试(Codex R3 MED-NEW-1)**:`store.getDbPath()===":memory:"` 时 boot+periodic reaper **不挂载**(无 ps 枚举 / 无 timer 副作用)。

**TmuxAdapter 测试**(路径修正 Codex R1 LOW-6:`packages/claude-runner/test/TmuxAdapter.test.ts`,现有 mailbox sentinel 测试在 `:1289-1373`):mailbox + rollback 两分支都 push `-e TMPDIR=<...>/browser-tmp`;mkdir + chmod 0o700 + 写 `.flywheel-owner.json`(含 stateDbPath);其余 env args byte-compat。

**QA 真机 E2E(§ research §7)**:真 runner spawn → chrome user-data-dir 落 runner-state → 终态后周期 tick 内 SIGTERM(前后计数)→ 活 runner chrome 不碰 → Annie 真 Chrome 不碰。**终验 TMPDIR 假设**。

## 6. 风险 / 决策记录

- **多-Bridge/QA-slot(Codex R1 HIGH-1 已修)**:实测 `TmuxAdapter` 的 runner-state 根**不**随 `FLYWHEEL_STATE_DIR` 隔离(恒 `homedir()/.flywheel/runner-state`),QA slot 只隔离 `TEAMLEAD_DB_PATH` → 光靠 `runnerStateRoot` 前缀会误杀同机 QA slot 的活 chrome。**修法 = owner marker**:每套 chrome 的 `browser-tmp/.flywheel-owner.json` 带 `stateDbPath`;reaper 只在 `marker.stateDbPath === ownStateDbPath` 才动它。QA slot 的 marker 带 slot-local db → 生产 reaper 认不出 → skip(`skippedForeign`)。等价 viewer-reaper 的 foreign-group 安全语义。
- **过渡期**:部署前起的 runner chrome 在系统 $TMPDIR(不可归属)→ periodic 不碰、boot 才碰且要 idle≥grace → 不误杀在用的。
- **只杀 main**:靠「无 `--type=`」;若某版本 chrome main 也带 type(极不可能)→ 最坏多杀几个同套子进程,仍限本套、不跨套。
- **磁盘残留 profile dir**:v1 不删(内存是痛点);per-runner 随 runner-state 清、系统 $TMPDIR 由 OS 清 → 可选 follow-up。

## 7. 提交 / 流程

- 分支 `flywheel-FLY-766`(已在)。TDD:先写 reaper 单测(RED)→ 实现(GREEN)→ StateStore.getDbPath → TmuxAdapter 注入 + run-infra 线程 + 测试 → plugin 挂载(含 `:memory:` guard)。
- 全仓 `pnpm lint` + 相关 `build` 后开 PR → codex code review → QA(真机 E2E)→ founder gate → ship。
- 本 plan 走 `stage set design_review` → codex design review,批准后再 implement。

**Runbook(Codex R3 LOW-NEW-1 — 默认部署 + 一次性清 39 backlog)**:
- **默认部署**:reaper 自动 on;attributed A 路径(用完必关)+ attributed no-row 孤儿自动回收;不可归属 chrome **只记 `wouldKillUnattributed` 日志、不杀**。→ 现有 39 个不可归属 backlog **默认不会被自动清**。
- **清 39 backlog(ops 一次性、有人盯)**:确认无 live pre-fix runner 在长等待后,设 `FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1` 重启 Bridge 一次(boot 会真杀 ppid1+idle≥grace 的不可归属孤儿)→ 核对 kill 计数 → **移除该 env** 再常态运行。
