# FLY-2170 Codex TUI pane 出生后秒死病根 — 实施计划
Issue: FLY-2170 (https://linear.app/geoforge3d/issue/FLY-2170/病根-codex-实现体的-tui-pane-出生后秒死fly-1239-race注册停-pending窗口消失app-server-却活着)
日期: 2026-09-03(rev 4:按 Lead 2026-09-03 裁定拆单,本单只做 WS-D;吸收 Codex R1/R2 中属于 WS-D 的条目与 R3 全部 6 条)
基于: research.md

行号绑定 `3bdbd7cbc`。

## 0. 摘要与范围裁定

**本单 = WS-D「一个 runner 一个窗口」。** Codex runner 的 tmux 窗口名只能有一个来源(出生 label);Bridge 重启后的 re-own 不再自己拼名;`@flywheel_exec_id` 升为窗口归属的唯一权威并在开窗链内前置保证;purge 增加 exec-id 轴。同 PR 删掉 re-own 的拼名分支。

| 改动面 | 一句话 |
|---|---|
| codex-session-reown.ts | **删** `[issue_identifier, issue_title].join("-")` 拼名;`label` 改为显式入参 |
| plugin.ts `revive` | 异步解析 label:快照 → 本 execution 活窗自带名 → 不开窗(告警一次,daemon 照常恢复) |
| CodexTmuxAdapter.ts | 快照 `label` 字段 + 严格 parser round-trip;删 `codex-<exec8>` 自造回落;recovery-only 选项 `founderWindow`;删 `publishWindowExecutionIdentity`(职责并入开窗链) |
| codex-runner-tui-window.ts | 开窗链:标记发布 + 读回成为「成功」前置;purge 两轴(同名轴限基会话,exec-id 轴**全局**);`RunnerTuiWindowSpec.executionId` 改为必填 |
| tmux-lookup.ts | 只读去重候选清单 `listTmuxWindowsByExecutionId`(`ok | indeterminate`);旧 `discoverTmuxTargetByExecutionId` 成为其 wrapper |
| 告警 | `tui_window_lost.trigger` 增 `label-unavailable`,文案分支 |

**拆出去的(Lead 裁定,另开一单)**:WS-A 视图自愈、WS-B 进程真相接缝、WS-C `:pending` 收窄。Codex R1/R2 中属于它们的 16 条评审原文与 rev 2 设计稿已原样收进 `handoff-probe-axis.md`;本单不实现。Lead 硬约束原句随交接同去:「daemon 探不到永远不得直接翻译成『窗口死了、删注册行』——终态只能由接缝给,删行必须走既有 cleanup 并验证 target 真的消失,任何绕过都算越权。」

**事实边界(Lead ①)**:issue 点名的 FLY-1239 出生 race,research §2 证明它在 FLY-2168 + codex ≥ 0.151 上从机理消失、今日 0/13。本单不修它,也不把「它不再复现」当验收目标。既有 `window_died` 重试与 `tui_window_lost` 告警保留为回归哨兵。

**分期与回滚点(Lead ③)**:本单只有一期、一个可回滚点:单 commit `git revert` 回到「重启一次多一窗」,无数据损坏、无 schema 变更;老快照无 `label` 字段可继续读。

## 1. 非目标

压缩 43.5 s 开窗;改 attach fail-closed(FLY-923);改 orphan reaper;`execution-mismatch` / `window-id-mismatch` 残留形态;FLY-2296;launchd / Bridge 重启 / deploy;探活轴与删行守卫(交接);注册后窗口死亡的自愈(交接);新 flag / config / 告警类型 / health 计数。

## 2. 稳定身份与显示标签

| 身份 | 定义 | 唯一写者 |
|---|---|---|
| `execution_id` | 运行身份,贯穿 StateStore / comm.db / session.json / 窗口选项 | dispatcher |
| 窗口选项 `@flywheel_exec_id` | 窗口归属的**唯一权威**;开窗链内发布并读回后窗口才算存在 | adapter 开窗链 |
| 出生 label | `buildWindowLabel(issueId, runnerDisplayName(...), title)`(core/tmux-naming.ts:36-42;run-dispatcher.ts:239-256);持久化到 `CodexLaunchSnapshot.label` | dispatcher 生成,adapter 落盘 |
| `sessions.tmux_window` | `<session>:pending`(无可路由 founder 视图)或已验活且已带标记的 `<session>:@N` | `@N` 只由 adapter 在开窗链成功后写 |
| `CodexRecoveryExecution.founderWindow` | `"open" | "suppressed"`,recovery-only 内部指令(不是 flag) | plugin.ts `revive` |

显示/告警:`RunnerTuiWindowLostEvidence.trigger` 联合类型(CodexTmuxAdapter.ts:127-135)增 `"label-unavailable"`;plugin.ts:9808-9822 文案按 trigger 分支:`label-unavailable` → 「恢复时无法证明出生窗口名,未开窗;工人仍在运行」;其余保留「never acquired」原文。`eventId` 沿用 `tui-window-lost:<exec>:<episodeStartedAt>`。

`:pending` 的语义在本单内明确为「无可路由 founder 视图」;`label-unavailable` 会留下一条**已告警**的长期 `:pending` 行,这是有意的(不猜名字),验收口径见 §6。

## 3. 设计

### 3.1 快照 `label`(Codex R1 H4 / R3 L6)
- `CodexLaunchSnapshot.label?: string`(schemaVersion 保持 1)。**真实写入点**是 `persistLaunchSnapshot({...})`(CodexTmuxAdapter.ts:912-935)——在那里加 `label: ctx.label`;:344-359 是严格 parser 的返回对象,同样要携带该字段。round-trip 测试锚到 :912-935 这个 writer。
- `parseCodexLaunchSnapshot`(:240-300)是严格重建,不显式加就丢字段:显式接受 `label`(缺省 / 非空字符串合法,其他 throw)并在重建对象时携带。round-trip 测试(缺省 / 合法 / 非法)。

### 3.2 只读候选清单(Codex R1 H4 / R2 H4)
tmux-lookup.ts 新增:
```ts
export async function listTmuxWindowsByExecutionId(executionId, runTmux = defaultTmuxRunner):
  Promise<{ kind: "ok"; windows: Array<{ windowId: string; windowName: string; sessions: string[] }> }
        | { kind: "indeterminate"; reason: string }>
```
一次 `list-windows -a -F '#{session_name}|#{window_id}|#{window_name}|#{@flywheel_exec_id}'`,按 `window_id` 去重(linked cmux session 是同一身份);tmux 抛错、字段数不为 4、`@id` 非法、executionId 含分隔符 → `indeterminate`。既有 `discoverTmuxTargetByExecutionId`(:92-154)改为 wrapper:`indeterminate` 透传;0 → `missing`;1 → `found`(base session 优先,沿用现有排序);>1 → `ambiguous`。现有契约与测试不变。

### 3.3 recovery-only 选项穿线(Codex R2 H4)
`CodexRecoveryRuntime.resume(context, hooks, options?: { founderWindow: "open" | "suppressed" })`(run-infra.ts:128-151)→ `runCodexRecoveryOwner`(:188-200)→ `CodexTmuxAdapter.resumeExistingExecution(context, hooks, options?)`(:673-700)→ 私有 `CodexRecoveryExecution.founderWindow`(:230-234)。缺省 `"open"`。

### 3.4 label 在 `revive` 内异步解析(Codex R1 H4)
plugin.ts:7149-7199 `revive` 为 async;`buildCodexRecoveryContext`(codex-session-reown.ts:100-135)同步不动。在其之前:
- (i) `snapshot.label` 非空 → 用之,`founderWindow:"open"`;
- (ii) 否则 `listTmuxWindowsByExecutionId`:`ok` 且候选恰 1 或多个**同名** → 该名;多个**异名** → 读 comm.db 当前 `tmux_window`(经既有 `lookupTmuxTarget`,它把 DB 打开/解析失败表示为 `kind:"error"` 而不是抛出,tmux-lookup.ts:319-349)所指 `@id` 那条的名字;comm 指向不在候选内、`lookupTmuxTarget` 为 `error`/`gone`、清单 `indeterminate`、0 候选 → (iii);
- (iii) `label: undefined`,`founderWindow:"suppressed"`,`console.warn("[codex-session-reown] label unavailable for <exec>: <reason>")`,`reason` 含 `commdb_lookup_error` / `candidates_indeterminate` / `no_candidates` / `commdb_pointer_not_in_candidates` 之一。
- **任何**解析步骤抛出的异常(R3 M5)都在 `revive` 内捕获并归入 (iii):label 不可证只压视图,**不得**让异常逃出 `revive` 中断 daemon 恢复。测试:comm.db 读取抛错 → `runtime.resume` 仍被调用、`label-unavailable` 告警恰一次。
codex-session-reown.ts:117-122 拼名分支**删除**;`buildCodexRecoveryContext` 增加显式 `label?: string` 入参。

### 3.5 adapter 对 suppressed 的处置(Codex R1 H4 / R2 H7 label 半边)
- `windowName = sanitizeTmuxName(ctx.label ?? \`codex-${…}\`)`(:784-786)删自造回落:非 recovery 路径 `ctx.label` 缺失 → throw(dispatcher 契约违反,今日 dispatcher 恒提供);recovery 路径允许 undefined。
- `founderWindow === "suppressed"` 时 `onThreadReady` **不**调用 `startOpenChain`,改为:`pinCommDbSessionWindow(ctx, "<session>:pending")`(注册时已是 pending,此处幂等)→ `emitTuiLost("label-unavailable")` 恰一次(此路径 `tuiOpened` 恒 false,`emitTuiLost` 的早退不触发;`tuiTerminalReported` 守卫保证恰一次)→ daemon 照常恢复。`restarts > 0` 时不再尝试开窗(label 仍不可证)。
- 测试:tmux 抛错 / 畸形行 / 0 候选三种 → daemon 仍恢复、无 `new-window` 调用、callback 恰 1 次、comm 行 `:pending`、warn 一条。

### 3.6 标记发布成为开窗成功前置(Codex R1 H5)
`ensureRunnerTuiWindow`(codex-runner-tui-window.ts:860-1053)在 settle 验活(:995-1014)之后、返回 `created` 之前:
1. `set-option -w -t =<session>:<@id> @flywheel_exec_id <execution>`(异步,10 s);
2. `display-message -p -t =<session>:<@id> '#{@flywheel_exec_id}'` 读回;
3. 读回 !== `<execution>`(含写失败、读回空、超时)→ 按 `@id` `kill-window`、`display-message` 核实消失,返回 `retryable-transient-ipc/marker_unproven`(消耗一次尝试,走既有 5 s / 15 s 重试)。
`RunnerTuiWindowSpec.executionId`(codex-runner-tui-window.ts:66-81)从可选改为**必填**(R3 M4),调用方与测试 fixture(codex-runner-tui-window.test.ts:20-28)同步;`buildRunnerTuiCommand` 的 `FLYWHEEL_EXEC_ID` 随之恒导出;无 execution 的 `created` 在类型上不可表达。`wireCreated`(CodexTmuxAdapter.ts:1059-1069)删除 `publishWindowExecutionIdentity` 调用,删除该私有方法(:2265-2290);`tuiOpened` 与 pin 只在开窗链成功后发生。不变量:**任何被 pin 的 `@N` 都带本 execution 的标记**。

### 3.7 purge 两轴(Codex R1 M9 / R3 H2,精确表述)
`purgeSameNameWindowsAsync`(:800-846)改为两轴、两种范围:
- **同名轴(既有 FLY-1239 语义,范围限 `spec.tmuxSession` 基会话)**:`list-windows -t =<session> -F '#{window_id} #{window_name}'`,`name === spec.windowName` → 按 `@id` kill;**有意**清掉同 issue 被 supersede 的旧 execution 残窗。
- **exec-id 轴(新增,范围全局)**:`list-windows -a -F '#{session_name}|#{window_id}|#{@flywheel_exec_id}'`,按 `window_id` 去重(linked cmux 行是同一身份),`execId === spec.executionId` → 按 `@id` kill;这才能支撑「全局 distinct 标记窗 ≤ 1」的不变量与 §6 的全局计数口径。
- verify:两轴各自重列并要求零残留,才 `new-window`;任一轴不可证 → `stale_window_unproven`(既有语义,不消耗尝试)。
- 不触碰:异名 **且** 异 exec-id 的窗(任何会话);其他基会话里异 exec-id 的同名窗。
测试:四象限(同名异 exec 同会话 → 清;异名同 exec 同会话 → 清;异名异 exec → 留;其他基会话同名异 exec → 留)+ **跨基会话同 exec 真 tmux 用例 → 清**。

### 3.8 删除面
- codex-session-reown.ts:117-122 拼名分支。
- CodexTmuxAdapter.ts:784-786 `codex-<exec8>` 自造回落。
- `publishWindowExecutionIdentity`(:2265-2290)。
- 今日 4 对残留双窗(FLY-2145/2147/2270/2301):在该 execution **下一次真实 revive / 开窗链执行**时由 exec-id 轴 purge 收敛,不写一次性脚本。**更正(R3 H1)**:rev 3 原句「部署后下一次 Bridge 重启由 exec-id 轴 purge 自动收掉」**不成立**,已撤回——Bridge 重启对健康活跃、无 gate、非 parked 的 daemon 只装 watch、不 revive(codex-session-reown.ts:283-347);只有 daemon 缺席或 parked/gate-held 需要 recycle 的体才走 revive。今日 4 对正是 parked/gate-held 体被 recycle 时产生的,同类场景下会被收敛;健康活跃体丢失视图后的恢复属 FLY-2303。

## 4. 负向守卫
- 候选清单只读,不 attach、不 kill;kill 只在 purge-and-verify 与 §3.6-3 失败回滚内,按不可变 `@id`。
- purge 不触碰异名且异 exec-id 的窗(任何会话);同名轴不出基会话。
- 老快照 + 无活窗 / 不确定 → 不猜名字:告警一次、daemon 照常恢复(FLY-2211「缺失或漂移 fail closed」同一原则)。
- 窗口失败永不影响 run(FLY-1239 不变量):suppressed 与 `marker_unproven` 都不改变 goal 循环。
- 不新增 flag / config;`founderWindow` 是 recovery 内部指令,dispatcher 路径不可设。

## 5. 迁移与回滚
- 无 DB schema、无数据迁移。`label` 可选,老快照可读。
- 单 commit,`git revert` 即回滚,回到「重启一次多一窗」。
- 依赖:无(不依赖交接单)。交接单反过来可依赖本单的标记不变量。

## 6. 测试证据(实现节点必须交付)

单测(vitest):
1. 快照 `label` round-trip:缺省 / 合法 / 非法(throw)。
2. `listTmuxWindowsByExecutionId`:去重(同 `@id` 多 linked session 计 1)、畸形行 / 抛错 / 非法 id → `indeterminate`;wrapper 四态与现有 `discoverTmuxTargetByExecutionId` 测试全绿不改。
3. 选项穿线:`resume(..., {founderWindow:"suppressed"})` 到达 `resumeExistingExecution` 并进入私有 recovery 对象;缺省为 `"open"`。
4. `revive` 三级解析:新快照 / 老快照+单活窗 / 多同名 / 多异名取 comm 所指 / comm 指向不在候选 / `indeterminate` / 0 候选(后三者 → suppressed)。
5. §3.5:三种 suppressed 场景 → daemon 恢复、无 `new-window`、`label-unavailable` callback 恰 1、comm `:pending`、warn 1 条;非 recovery 缺 label → throw。
6. §3.6:`set-option` 失败、读回不符、读回超时 → 新窗被杀且核实消失、`marker_unproven`、走既有重试;成功路径 pin 前标记已读回。
7. §3.7 四象限;变异体对照:把 (ii) 改回拼名 → real-tmux 用例出现第二扇窗(先证明变异体改变了产物字节)。
8. 告警:`label-unavailable` 的 trigger 联合、文案分支、eventId 断言。

真 tmux(现有 real-tmux 套件同风格):
9. 起真窗后模拟 re-own(老快照无 label)→ 不产生第二扇窗、名字等于出生名、新窗带标记。
10. 真失败注入(R3 M3):经既有异步命令 seam(`deps.exec` / `deps.execOut`)在生产 `set-option` **成功之后、读回之前**对该精确 `@id` 再 `set-option -w @flywheel_exec_id <错误值>`(仍是真 tmux,只是插一步)→ 读回不符 → 生产回滚杀该窗并验证消失、`marker_unproven`、重试后成功。
11. 两扇异名活窗(模拟今日残留)+ 老快照 → 重开后该 execution 恰 1 窗、名字取 comm 所指那扇;**跨基会话**变体:另一基会话里放一扇带本 exec 标记的窗 → 也被清,全局恰 1。

QA 演练(只读 SQL + tmux;截图命令一律 `%pane` 或 `=<session>:` 形式,见 research §8):
12. **founder 可见验收(Lead ③;R3 H1 修正)**:新起一个 Codex runner → 截图 cmux 对应 tab 显示 TUI 内容;`tmux list-windows -a -F '#{session_name}|#{window_id}|#{window_name}|#{@flywheel_exec_id}'` 给出原始行 + 按 `window_id` 去重:该 execution 恰 1 个 `window_id`、名 = 出生 label、基会话恰 1 行、cmux linked 恰 1 行;comm.db `tmux_window` 指向它。**重启验收必须用 reowner 真会 revive 的状态**:把该 runner 置于 parked / gate-held(例如让它走到 phase hold),再 `scripts/test-cycle-bridge.sh` slot-only 重启(不碰生产 launchd)→ revive 后仍恰 1 窗、同名、同指向,cmux 仍只有一个同名 workspace;若无法构造 parked 态,则在真 tmux 集成测试里直接调用 plugin `revive` 路径证明同样断言(§6-9/11)。对健康活跃体做 slot 重启只证明「reown_watch_started、不开第二窗」。**不做**「kill-window 后重启会收敛」的断言:健康体丢视图的恢复属 FLY-2303。截图与 SQL 输出随 QA 结果提交。
13. 24 h 生产窗口:codex running 行中「`:pending` 超 10 min **且**无对应 `label-unavailable` 告警」= 0;每个 execution 的 `@flywheel_exec_id` 窗 ≤ 1(去重后);cmux workspace 每个 codex runner ≤ 1。回归哨兵(非验收目标):`founder TUI DIED` / `no rollout found` 出现即报 Lead。
14. 对照:claude 体一枚,重启前后行为与修前逐字一致(本单不触碰 claude 路径)。

## 7. 实施步骤
1. 快照 `label` + parser → 单测 1。
2. 候选清单 + wrapper → 单测 2。
3. 选项穿线 → 单测 3。
4. `revive` 异步解析 + 删拼名 → 单测 4。
5. adapter suppressed 处置 + 删自造回落 → 单测 5。
6. 标记前置 + 删 `publishWindowExecutionIdentity` → 单测 6、真 tmux 10。
7. purge 两轴 → 单测 7、真 tmux 9/11。
8. 告警 trigger/文案 → 单测 8。
9. `pnpm lint && pnpm -r build && 定向测试`;PR body 附删除面清单(§3.8)与 §6 QA 命令;code review;独立 QA 在真机执行 §6 12–14,第 12 条截图随 QA 结果提交。

## 8. 风险

| 风险 | 处置 |
|---|---|
| (ii) 多异名候选选错扇 | 以 comm.db 当前指向为准;仍恰 1 窗 |
| purge 同名轴清掉同 issue 旧 execution 的窗 | 既有 FLY-1239 语义,限定基会话;四象限测试钉死 |
| exec-id 轴全局 kill 误伤 | 过滤键是本 execution 的 `@flywheel_exec_id`,按 `@id` 去重后 kill;异 exec-id 任何会话都不碰;跨会话用例钉死 |
| 今日残留双窗不会因「重启」自动收敛 | 如实写明只在真实 revive/开窗链执行时收敛;健康体的视图恢复归 FLY-2303 |
| 标记前置让开窗多两次 tmux 往返 | 各 10 s 超时,与 settle 同量级(<100 ms 实测);失败走既有重试 |
| 老快照 + 全部窗口丢失 | suppressed + 告警,daemon 照常;founder 视图由交接单的自愈或下次 dispatch 恢复 |
| `registerSession` 重置 `started_at`(research §8 顺带发现) | 不在本单修;QA 时间基线用 StateStore;报 Lead 另立 |
| FLY-2296 / FLY-2302 并行改 CodexTmuxAdapter | 实现前 rebase,行号重核 |
