# FLY-2148 runner 记忆落地:写入时机 · 收口回执 · 分流归因 — 实施计划
Issue: FLY-2148 (https://linear.app/geoforge3d/issue/FLY-2148/2132b1-runner-记忆落地角色项目目录-短索引送达-写入时机与截断防护)
日期: 2026-09-04
基于: research.md

> **For agentic workers:** 在 TURN 持有的共享 worktree 内按批次 RED→GREEN 执行,每批一次 commit/push/progress。
> 本 plan 是被 pin 的设计;实现节点不得改写 plan 正文,发现偏差写 `design-correction.md` 附录。

**Goal:** 在 B0(FLY-2147,PR #1056)已合入的「按 (project, role) 挂载 + 短索引原生装载 + 读侧有界可见守卫」之上,补齐让记忆**真正落地**的三件事:① **写入时机合同**——每个 DAG 节点执行在跑终结命令之前由 runner 自写一次(Claude 走原生 auto memory,Codex 手写同形状),不阻塞;② **收口回执**——`complete` / `qa-result` 量一次索引、与 spawn 快照比对,打印一行三态回执(written / unchanged / over_budget,外加 unmeasurable),随 payload 入 `sessions` 独立列,可单独 SQL 查询(Lead 硬要求 ①);③ **分流归因**——每次 spawn 把臂(off / role / shared)、目录、spawn 快照经 Bridge-local sink 落 `sessions`,让 flag `runner_memory_mode` 的退役条件有数据。截断在 spawn 面(B0)与收口面(B1)都**可见**、不静默(Lead 硬要求 ②)。**不改 flag 默认值(`off`)、不加任何开关**;`off` / `shared` / unsupported backend 的 spawn、prompt、argv、payload 与改前 byte-identical。

**Architecture:** 纯度量函数从 `edge-worker/runner-memory.ts` **搬到** `packages/config/src/runner-memory-index.ts`(edge-worker re-export,B0 测试零改动),因为收口侧的 `flywheel-comm` 已依赖 `flywheel-config` 而**不依赖** `edge-worker`(它另依赖 `flywheel-agent-team-transport` / `flywheel-token-usage`,与本单无关;teamlead 已依赖 config + edge-worker,core 不依赖任何工作区包 ⇒ 无环)。spawn 侧:Blueprint 在选臂之后调用新的**可选** emitter 方法 `emitRunnerMemorySelection`(`DirectEventSink` 落库,`TeamLeadClient` no-op——与 `emitWorktreeReady` 丢 `binding` 同一「Bridge 权威不走 HTTP」红线),mounted 时多算一份快照,同一对象既进 adapter env `FLYWHEEL_RUNNER_MEMORY_SNAPSHOT` 也进归因。收口侧:`flywheel-comm/src/runner-memory-closeout.ts` 一个函数被 `complete` 与 `qa-result` 共用,回执进各自已有 payload;Bridge 在 `event-route.ts` `patchCompletionEvidence()` 与 `workflow-decision-routes.ts` `/decision` 接受后各落一次。`sessions` 加 5 个 nullable TEXT 列。prompt 只改 B0 `Write rule` 一行(claude)/ 加一行(codex)。

**Tech stack:** TypeScript(pnpm monorepo,vitest),既有 `patchSessionMetadata` / `ALTER TABLE … ADD COLUMN` 幂等迁移形状,既有 pane env 正向边界(FLY-1869 / FLY-1643 名单测试),Claude Code 2.1.260 原生 auto memory。

---

## 0. 不变量与文件地图

### 0.1 修改 / 新增的文件

| 文件 | 动作 | 内容 |
|---|---|---|
| `packages/config/src/runner-memory-index.ts` | 新增 | 从 edge-worker **原样搬来**:`RUNNER_MEMORY_HARD_LIMIT` `RUNNER_MEMORY_DEFAULT_BUDGET` `RUNNER_MEMORY_SCAN_CEILING_BYTES` `RunnerMemoryIndexStats` `measureIndexPrefix`;从 B0 私有 `readMemoryIndex`(`runner-memory.ts:414-438`)抽出 `readIndexPrefixBounded(indexPath): { prefix: Buffer; size: number }`(同一段 `openSync/fstatSync/readSync 循环/finally closeSync`,逐字)。**唯一的组合原语** `measureRunnerMemoryIndex(dir): { stats: Omit<RunnerMemoryIndexStats, "firstRun">; snapshot: RunnerMemorySnapshot }`:一次 `readIndexPrefixBounded(join(dir,"MEMORY.md"))`,同一个 `prefix` 既喂 `measureIndexPrefix` 又算 `sha16`,`countTopicFiles(dir)` 只调一次——B0 mount 与 B1 closeout **都只消费它**(不存在第二个读索引的函数)。另新增 `countTopicFiles`、`RUNNER_MEMORY_SNAPSHOT_ENV`、`RunnerMemorySnapshot`、`parseRunnerMemorySnapshot(value): RunnerMemorySnapshot \| undefined`(env 与 Bridge 共用的**同一个**快照校验器)、`RunnerMemoryCloseoutState`、`RunnerMemoryCloseoutReceipt`(判别联合,§0.3)、`parseRunnerMemoryCloseoutReceipt`、`formatRunnerMemoryCloseoutLine`、`resolveRunnerMemoryCloseoutState`、`sanitizeOneLine(text, max)`。**模块用 `import fs from "node:fs"` 默认导入并一律 `fs.` 调用**(B0 Codex R3 #3 的同一理由:edge-worker 的 `vi.spyOn(fs, "readSync")` 拦的是默认对象属性;Codex R1 已实测两包的默认导入是同一对象) |
| `packages/config/src/index.ts` | 改 | 在 `runner-memory-mode.js` 导出块旁 re-export 上述全部符号(config 只暴露根 index) |
| `packages/config/src/__tests__/runner-memory-index.test.ts` | 新增 | §1.1 单元 RED |
| `packages/edge-worker/src/runner-memory.ts` | 改(机械) | 删本地定义的 5 个搬走的符号,改为 `import { … } from "flywheel-config"` 并 **`export { … } from "flywheel-config"`** 同名 re-export;私有 `readMemoryIndex(indexPath)` **删除**,`prepareRunnerMemoryMount` 改调 `measureRunnerMemoryIndex(dir)`,把 `stats` 拼进 `index`(补 `firstRun`)、把 `snapshot` 放进 mounted 结果的新字段 `snapshot: RunnerMemorySnapshot`——一次读、两个视图;prompt 文案改动见 §0.4 |
| `packages/edge-worker/src/__tests__/runner-memory.test.ts` | 改(只加) | mounted 结果含 `snapshot`,且 `snapshot.lines/linesExact/bytes` 逐字等于 `index.lines/linesExact/bytes`(同一次读);既有用例零改动(re-export 保证 import 不变;`fs.readSync` 累计 ≤ 65,536 与 `closeSync` 恰一次的断言仍过——因为只读一次,`openSync` 也只被调一次,加一条 `vi.spyOn(fs,"openSync")` 计数断言锁它) |
| `packages/edge-worker/src/ExecutionEventEmitter.ts` | 改 | `interface ExecutionEventEmitter` 加可选 `emitRunnerMemorySelection?(env, sel: RunnerMemorySelectionRecord): Promise<void>`;`export type RunnerMemorySelectionRecord`;`TeamLeadClient.emitRunnerMemorySelection` 实现为 no-op(JSDoc 写明红线) |
| `packages/edge-worker/src/Blueprint.ts` | 改 | 插入点 = **`memoryMount` 已声明并打完 mount 日志之后**(`:2715-2733` 的 `if (memoryMount) { … console.info/warn(memoryLog.line) }` 块之后)、`adapter.execute({` 之前:`await this.eventEmitter?.emitRunnerMemorySelection?.(env, record)`(`env` = 本次 `EventEnvelope`,与 `emitWorktreeReady` 用的同一个;`record` 见 §0.3;**不能**放在 `:2713` 选臂日志之后——那时 `memoryMount` 尚未声明,Codex R1 #6);**await 且 try/catch**——归因失败只 `console.warn`,不阻断 spawn;`toRunnerMemoryDisposition` 透传 `snapshot` |
| `packages/edge-worker/src/__tests__/Blueprint.fly2148-runner-memory-closeout.test.ts` | 新增 | §2.1 Blueprint 装配 RED |
| `packages/core/src/adapter-types.ts` | 改 | `runnerMemory` mounted 分支加 `snapshot?: { lines: number; linesExact: boolean; bytes: number; sha16: string; topicFiles: number }`(core 不依赖 config,类型在此**内联一份结构**,并在 JSDoc 注明与 `flywheel-config` 的 `RunnerMemorySnapshot` 结构相同;edge-worker 的 `toRunnerMemoryDisposition` 是唯一装配点,由 §2.1(9) 的类型相容测试锁住) |
| `packages/claude-runner/src/TmuxAdapter.ts` | 改 | `:719` 旁:`if (ctx.runnerMemory?.status === "mounted" && ctx.runnerMemory.snapshot) appendPaneEnv("FLYWHEEL_RUNNER_MEMORY_SNAPSHOT", JSON.stringify(ctx.runnerMemory.snapshot))` |
| `packages/claude-runner/src/CodexTmuxAdapter.ts` | 改 | `:2203` 旁同形 `env.FLYWHEEL_RUNNER_MEMORY_SNAPSHOT = …` |
| `packages/claude-runner/test/TmuxAdapter.test.ts` / `CodexTmuxAdapter.test.ts` | 改 | §2.1(10)-(12):env 断言;FLY-1869 allowlist 与 FLY-1643 逐字名单各加 `FLYWHEEL_RUNNER_MEMORY_SNAPSHOT` |
| `packages/flywheel-comm/src/runner-memory-closeout.ts` | 新增 | `collectRunnerMemoryCloseout(env, opts: { prefix; now?; log? })`(签名以 §0.3「收口函数」行为准)+ 私有 `safeLog` / `safeIsoNow` / `isReceiptSafeDir` |
| `packages/flywheel-comm/src/__tests__/runner-memory-closeout.test.ts` | 新增 | §3.1 RED |
| `packages/flywheel-comm/src/commands/complete.ts` | 改 | `type Payload` 加 `runnerMemoryCloseout?`;组 payload 前在 try/catch 里调 `collectRunnerMemoryCloseout(process.env, { prefix: "[complete]" })`(§3.2 逐字),有回执 ⇒ `console.error(formatRunnerMemoryCloseoutLine("[complete]", r))` + `payload.runnerMemoryCloseout = r`;**在任何 route 校验之后、POST 之前**;`--route blocked` 同样带(blocked 的 runner 也可能写过) |
| `packages/flywheel-comm/src/commands/qa-result.ts` | 改 | `/decision` body 加 `runner_memory_closeout`;同一行 stderr(prefix `[qa-result]`);recoverable marker **不**含它 |
| `packages/flywheel-comm/src/__tests__/complete.test.ts` / `packages/flywheel-comm/src/commands/__tests__/qa-result.test.ts`(既有,路径不同,别新建重复套件) | 改(只加) | §3.1 |
| `packages/teamlead/src/StateStore.ts` | 改 | `SessionUpsert`(`:1055+`)与 `Session`(`:1183+`)加 5 字段;**`rowToSession`(`:14281-14369`)加 5 项映射**——`runner_memory_arm` 经闭合枚举读(非 off/role/shared ⇒ undefined)、`runner_memory_closeout` 经闭合枚举读(非四态 ⇒ undefined)、其余三列原样字符串(Codex R1 #4:`getSession` 不是裸 cast,漏了映射列就永远读不到);`upsertSession` 两处 INSERT 列表 + `COALESCE` 行(`:7562/7598/7646`、`:8631/8666/8714`)与 `patchSessionMetadata.fieldMap`(`:8828` 旁)各加 5 项;**新增专用方法** `patchRunnerMemorySelection(executionId, { arm, dir: string \| null, spawn: string \| null }): boolean`——三列**一起**写(`null` 真写 NULL,不是跳过),返回 `this.db.getRowsModified() > 0`(既有 `getRowsModified()` 形状,`:502`);归因走它,不走 `patchSessionMetadata`(后者跳过 undefined、返回 void,既清不掉旧值也报不了「影响 0 行」);回执两列仍走 `patchSessionMetadata`(只增不清);迁移:照 `:3731-3745` 形状加一个 `for (const col of [5 列])` 幂等循环 |
| `packages/teamlead/src/DirectEventSink.ts` | 改 | 实现 `emitRunnerMemorySelection`:`const hit = this.store.patchRunnerMemorySelection(env.executionId, { arm: sel.arm, dir: sel.dir ?? null, spawn: sel.spawn ? JSON.stringify(sel.spawn) : null })`;`hit === false`(行不存在,emitStarted 尚未落)⇒ `console.warn` 一行 `dropped`,不抛;`hit === true` ⇒ `console.info` 一行 `persisted`。三列一起写 ⇒ 同一 execution 先 `role+dir+spawn` 后 `off`(重放 / 重派)时旧 dir/spawn 被清空,不会残留 |
| `packages/teamlead/src/bridge/event-route.ts` | 改 | `patchCompletionEvidence()`(`:1950`)里加:`const receipt = parseRunnerMemoryCloseoutReceipt(payload.runnerMemoryCloseout)`;有 ⇒ 加 `runner_memory_closeout: receipt.state, runner_memory_receipt: JSON.stringify(receipt)` 并 `console.info(formatRunnerMemoryCloseoutLine("[event-route]", receipt) + " exec=" + id)`;payload 里有该字段但解析失败 ⇒ `console.warn("[event-route] runner-memory closeout receipt rejected exec=… reason=malformed")`,两列不写。**session_started 的 HTTP 路径不接受** `runner_memory_arm/dir/spawn`(不加白名单,负向测试锁) |
| `packages/teamlead/src/bridge/workflow-decision-routes.ts` | 改 | `WorkflowDecisionBody` 加 `runner_memory_closeout?: unknown`;新增**不抛**的模块级辅助 `persistRunnerMemoryCloseout(store, executionId, raw: unknown, logPrefix)`:`raw === undefined` ⇒ **静默 no-op**(旧版 runner CLI 不带字段,前后向兼容合同);`raw` 存在但 `parseRunnerMemoryCloseoutReceipt` 失败 ⇒ warn `rejected`;合形 ⇒ `patchSessionMetadata` 两列 + info 行;store 抛 ⇒ warn `persist failed`。**`/decision` 恰有两个已接受响应点**(Codex R2 #1,handler 范围 `:660-895`):engine-canonical 分支的 `res.json` `:775-782` 与 durable-QA 分支的 `:888-895`;首次接受与 `idempotentReplay=true` 重放都经这两个点返回——每个点之前调用辅助**恰一次**,共两处。`:1013` / `:1121` 属于 `/gate-carrier-rebind` 与 `/loop-reentry`,与本单无关,**不动**。执行 id 取 `credentialRow.execution_id` |
| `packages/teamlead/src/__tests__/StateStore.test.ts` / `DirectEventSink.test.ts` / `event-route.test.ts` / `workflow-decision-routes.test.ts`(既有,`packages/teamlead/src/__tests__/`;含 `:399-440` 普通 QA 重放与 `:875-954` engine-canonical 重放两套 fixture) | 改(只加) | §4.1 RED |
| `engineering/doc/milestones/FLY-2148.md` | 新增(PR 内,**字面上最后一个 commit**) | 按 README 单写者合同;不碰 CLAUDE.md |

### 0.2 明确不改

- 不改 `runner_memory_mode` 的默认值、枚举、`readSites`、退役条件;不加 env / flag / CLI 开关。`FLYWHEEL_RUNNER_MEMORY_SNAPSHOT` 是数据管道(只在 mounted 时存在),与 `FLYWHEEL_RUNNER_MEMORY_DIR` 同族;§7 审计用 grep 锁「仓里没有新的 `FLYWHEEL_RUNNER_MEMORY_*` 读作开关」。
- 不改 B0 的挂载判定、编码、policy 探测、读侧守卫、fail-closed 处置、日志四种形状、`## Runner Memory` 段的其它行、FLY-1188 快照。
- 不做 Codex 原生挂载(C1)、跨角色访问、记忆迁移、远端备份、质量审计;不给 Lead 新增通知面;不做 founder 对比页(后续单,§6)。
- 不阻塞完成:任何三态都不改变 `complete` / `qa-result` 的退出码与路由(Lead 裁定「非阻塞是对的」)。
- 不复量:Bridge 不读 runner 的记忆目录;回执是 runner 自报的证据(与 `summary` / `diffSummary` 同级),Bridge 只校验形状。

### 0.3 稳定标识(identifier contract)

| 标识 | 形态 | 归属 | 说明 |
|---|---|---|---|
| 臂 | `runner_memory_arm ∈ {"off","role","shared"}` | 既有词表(`RunnerMemorySelection`,`packages/config/src/runner-memory-mode.ts`) | 不新造;`NULL` = 本单没碰的 backend(antigravity / kimi)或 HTTP 模式 Bridge——与 `off` 严格区分 |
| 归因记录 | `RunnerMemorySelectionRecord = { arm; dir?: string; spawn?: RunnerMemorySnapshot }` | 新(edge-worker) | `dir`/`spawn` 只在 `arm==="role" && mount.status==="mounted"` 时有;`role` 臂但 skipped/failed ⇒ `arm="role"`、`dir`/`spawn` 缺席(fail-closed 的痕迹已在 B0 日志与 prompt) |
| 快照 | `RunnerMemorySnapshot = { lines: number; linesExact: boolean; bytes: number; sha16: string; topicFiles: number }` | 新(config) | `sha16` = `sha256(prefix).digest("hex").slice(0,16)`,prefix 是有界读到的 ≤64KB 前缀(超上限的索引只哈希前缀——够判「变没变」,且与 B0 的有界读同一口径);`topicFiles` = `countTopicFiles(dir)`(常规文件、`.md` 结尾、≠ `MEMORY.md`;`readdirSync` 抛错 ⇒ `-1` 表示「数不到」;**饱和**:数到 10,000 即停,返回 10,000 且视为不精确)。**校验器 `parseRunnerMemorySnapshot`**(env 与 Bridge 共用):闭合键集恰为这 5 个;`lines`/`bytes` 为 ≥0 整数;`topicFiles` 为 ≥ -1 整数;`linesExact` 布尔;`sha16` 匹配 `/^[0-9a-f]{16}$/`;否则 undefined |
| 快照 env | `FLYWHEEL_RUNNER_MEMORY_SNAPSHOT` = `JSON.stringify(snapshot)`(≈90 字节) | 新 | 只在 mounted 且 snapshot 存在时设;Claude 与 Codex 都有;**与 `runner_memory_spawn` 列是同一对象序列化**(不二次度量) |
| 三态 | `RunnerMemoryCloseoutState ∈ {"written","unchanged","over_budget","unmeasurable"}` | 新(config) | 判定顺序写死(§0.6):① 索引量不到(fs 异常)⇒ `unmeasurable`;② `closeout.overBudget \|\| overHard` ⇒ `over_budget`(索引本身证明,不看 topic 计数);③ 无 spawn 快照 ⇒ `unmeasurable`(`error=snapshot_missing`);④ `spawn.topicFiles === -1 \|\| closeout.topicFiles === -1` ⇒ `unmeasurable`(`error=topic_count_unavailable`,**不做算术 Δ**——Codex R1 #2:`N → -1` 不是写入证据);⑤ `sha16` 不同或 `topicFiles` 不同 ⇒ `written`;⑥ 否则 `unchanged` |
| 回执 | 判别联合(Codex R1 #1):`RunnerMemoryCloseoutReceipt = { v: 1; dir: string; measuredAt: string } & ( { state: "written" \| "unchanged" \| "over_budget"; spawn?: RunnerMemorySnapshot; closeout: RunnerMemorySnapshot & { overBudget: boolean; overHard: boolean; firstDroppedLine?: number }; delta?: { indexChanged: boolean; lines: number; topicFiles: number } } \| { state: "unmeasurable"; spawn?: RunnerMemorySnapshot; closeout?: (同上); error: string } )` | 新(config) | 可量态**必须**有真实 `closeout`;fs 失败的 `unmeasurable` **没有** `closeout`、必须有一行式 `error`(经 `sanitizeOneLine(msg, 200)`:去控制字符与换行、截 200 字符、无堆栈);`snapshot_missing` / `topic_count_unavailable` 两种 `unmeasurable` 带 `closeout`。**`parseRunnerMemoryCloseoutReceipt` 逐字段**:`v===1`;`state` ∈ 四态;`dir` 绝对路径且 ≤ 1,024 字符、无控制字符;`measuredAt` 为可解析的 ISO-8601 且 `toISOString()` 往返相等;`spawn`/`closeout` 经 `parseRunnerMemorySnapshot`(闭合键集)+ `overBudget`/`overHard` 布尔 + `firstDroppedLine` 缺席或 ≥1 整数;`delta` 闭合键集 `{indexChanged: boolean, lines: 有符号整数, topicFiles: 有符号整数}`(**没有 -1 下限**,整理后为负合法);`error` 存在时 ≤ 200 字符单行;顶层与每个嵌套对象都是闭合键集;整段序列化 ≤ 4,096 字节;**状态不变量(双向,Codex R2 #3)**:可量态 `closeout` 必须存在;`over_budget` ⇔ `closeout.overBudget===true`(有 `closeout` 且 `overBudget` 为真时 state 只能是 `over_budget`;反之亦然);`written` / `unchanged` ⇒ `spawn` 存在、`closeout.overBudget===false`、两侧 `topicFiles ≥ 0`;`overHard===true` ⇔ `firstDroppedLine` 存在;`delta` 存在 ⇔ (`spawn` 存在且两侧 `topicFiles ≥ 0` 且 state ≠ `unmeasurable`),且存在时三个字段**必须逐一等于**由两张快照重算的值(`indexChanged === (spawn.sha16 !== closeout.sha16)`、`lines === closeout.lines - spawn.lines`、`topicFiles === closeout.topicFiles - spawn.topicFiles`);`unchanged` ⇒ `delta` 全零且 `indexChanged=false`;`written` ⇒ `delta.indexChanged` 或 `delta.topicFiles!==0`;`unmeasurable` ⇒ `error` ∈ {`snapshot_missing`(无 spawn,有 closeout)、`topic_count_unavailable`(有 closeout,任一 topicFiles=-1)、其它一行式 fs 错误(无 closeout)、`self_check_failed`}。任一不满足 ⇒ undefined |
| payload 字段名 | `complete` payload:`runnerMemoryCloseout`(camel,与 `designHtmlEvidence` 同风格);`/decision` body:`runner_memory_closeout`(snake,与 `client_request_id` 同风格) | 新 | 两处各随所在 body 的既有命名风格;Bridge 两处都经同一 `parseRunnerMemoryCloseoutReceipt` |
| `sessions` 列 | `runner_memory_arm TEXT` `runner_memory_dir TEXT` `runner_memory_spawn TEXT`(JSON)`runner_memory_closeout TEXT`(三态)`runner_memory_receipt TEXT`(JSON) | 新 | 全 nullable、无默认;`runner_memory_closeout` 独立列 = Lead 硬要求 ①(`WHERE runner_memory_closeout='over_budget'` 可直接查) |
| emitter 方法 | `emitRunnerMemorySelection?(env, sel)` | 新 | **可选**方法;DirectEventSink 实现,TeamLeadClient no-op,既有 mock 不必实现 |
| 收口函数 | `collectRunnerMemoryCloseout(env, opts: { prefix: "[complete]" \| "[qa-result]"; now?: () => Date; log?: (line: string) => void }): RunnerMemoryCloseoutReceipt \| undefined`(`log` 默认 `console.error`;`prefix` 是日志行前缀,由调用方传) | 新(flywheel-comm) | **全函数,永不抛**(Codex R2 #4 / R3 #2)。**env 值逐字读取,不 trim、不归一化**(Codex R3 #1:改写会换掉目录身份,回执 / 归因 / 挂载三处必须指同一路径):`FLYWHEEL_RUNNER_MEMORY_DIR` 为 `undefined` 或字面空串 `""` ⇒ 静默 undefined(= 本次没有角色记忆,不打行);其它任何值先过 `isReceiptSafeDir`(`path.isAbsolute` 且无控制字符且 ≤1,024 字符,与解析器同一规则)——纯空白 `"  "`、相对路径、含 `\n`、超长 ⇒ undefined + stderr 一行 `{prefix} runner-memory closeout skipped: invalid FLYWHEEL_RUNNER_MEMORY_DIR`;末尾带空格的绝对路径是**合法**的并按原样使用。合法 dir ⇒ **一定**返回一个过解析器的回执:`measuredAt` 经 `safeIsoNow(now)` 取一次(`now` 抛错或返回 Invalid Date ⇒ 退回 `new Date()`;仍无效 ⇒ 视为整体失败:undefined + `skipped: clock unavailable` 行),整个函数只用这一个值;只调 `measureRunnerMemoryIndex(dir)` 一次;fs 异常 ⇒ 无 `closeout` 的 `unmeasurable`,`error` 经 `sanitizeOneLine(…,200)`;`delta` 只在 spawn 存在且两侧 `topicFiles ≥ 0` 时计算;函数尾部 `parseRunnerMemoryCloseoutReceipt(r)` 自检,失败 ⇒ 改返回由**已校验原语**(同一 `dir`、同一 `measuredAt`、`error:"self_check_failed"`,无 spawn/closeout/delta)构造的 `unmeasurable`,并对它**再自检一次**;若连它都不过(理论上不可能,因为 dir 已按解析器规则校验)⇒ undefined + stderr 一行。任何路径都不向 `complete` / `qa-result` 抛 |
| 预算 / 硬上限 / 扫描上限 | B0 常量,搬家不改值 | 既有 | 160L/20,000B;200L/25,000B;65,536B |

### 0.4 显示标签(逐字;测试 grep 这些串)

**回执行**(runner 终端 stderr 与 Bridge 日志同形;`{p}` = `[complete]` / `[qa-result]` / `[event-route]` / `[workflow-decision]`,Bridge 两处末尾追加 ` exec=<id>`):
```
{p} runner-memory closeout state=written dir=<abs> index=<L|>=L>L/<B>B delta=+<n>L/+<m>files budget=160L/20000B hard=200L/25000B
{p} runner-memory closeout state=unchanged dir=<abs> index=<L>L/<B>B delta=+0L/+0files — nothing new was written this execution; if you learned a durable, reusable judgment, write it now (one topic file + one pointer line) before you park or exit.
{p} runner-memory closeout state=over_budget dir=<abs> index=<L>L/<B>B delta=<+n|?>L/<+m|?>files first_dropped_line=<K|none> — MEMORY.md is over budget; consolidate topic files and replace or drop superseded pointers before you finish.
{p} runner-memory closeout state=over_budget … first_dropped_line=<K> — MEMORY.md is over budget; consolidate topic files and replace or drop superseded pointers before you finish (the next runner will NOT load entries from about line <K> onward).
{p} runner-memory closeout state=unmeasurable dir=<abs> error=<msg>
```
- `delta` 无快照时写 `?L/?files`;`<n>` 可为负(整理后变短),负数不带 `+`。
- 第 4 行(带括号句)只在 `overHard` 时;只超软预算用第 3 行,`first_dropped_line=none`。
- Bridge 拒收形状:`[event-route] runner-memory closeout receipt rejected exec=<id> reason=malformed`(`[workflow-decision]` 同形)。
- DirectEventSink 归因落库:`[DirectEventSink] runner-memory selection persisted exec=<id> arm=<a> dir=<abs|->`;行不存在:`[DirectEventSink] runner-memory selection dropped exec=<id>: session row missing`。

**prompt 改动**(edge-worker `buildRunnerMemoryPromptSection`;其余行逐字不动):
- claude 形态原 `- Write rule: …Prefer writing at the end of your work…` 整行替换为 research §3.5 的 claude 句(以 `- Write rule (closeout contract, FLY-2148):` 开头,以 `Never store tokens, keys or secrets.` 结尾)。
- codex 形态在首行之后插入 research §3.5 的 codex 句(以 `- Closeout contract (FLY-2148):` 开头)。
- 负向:skipped / failed 形态(fail-closed 段)与 unsupported backend 不含以上任一句 ⇒ FLY-1188 快照不变,unsupported 金样本不变。

### 0.5 迁移与回滚边界

- **迁移**:5 列 `ALTER TABLE sessions ADD COLUMN … TEXT`,幂等(`try/catch` 「exists」),存量行全 NULL;无回填。`PRAGMA table_info(sessions)` 测试锁列名。
- **回滚**:代码回滚(revert PR + 重启 Bridge)。列留着(nullable,与 `skill_framework_mode` 策略相同);旧代码不读不写它们。env `FLYWHEEL_RUNNER_MEMORY_SNAPSHOT` 随 adapter 回滚消失;runner 侧旧 `flywheel-comm` 不认识回执字段 ⇒ 不发;新 Bridge 收到无字段 payload ⇒ 两列 NULL。**前后向都不需要同时部署**:Bridge 与 runner CLI 任一方是旧版,结果只是回执缺席,不报错。
- **行为删除**:无。`off` / `shared` / unsupported 路径 byte-identical(§2.1(5)、§2.1(10)、§3.1(9) 三处锁)。
- **前向**:founder 对比页 / `feature-flags report` 加 tally 只需读这 5 列;若 Lead 日后裁定阻塞式收口,只改 `complete.ts` 一处(用同一个 receipt)。

### 0.6 负向守卫

| 情形 | 行为 | 可见性 |
|---|---|---|
| backend 非 claude/codex | 不发归因、不设 env、无回执 | 列全 NULL;prompt/argv/payload byte-identical(B0 金样本继续锁) |
| 臂 `off` / `shared` | 发归因 `arm` 只此一项;不挂载、不设 env;`complete` 无 `FLYWHEEL_RUNNER_MEMORY_DIR` ⇒ 回执 undefined ⇒ payload 无字段 | `runner_memory_arm` 有值,其余 4 列 NULL |
| 臂 `role` 但 skipped / failed(fail-closed) | 归因 `arm="role"`,无 dir/spawn;env 不设;无回执 | 同上;B0 的 `NOT mounted` 行与日志仍在 |
| `emitRunnerMemorySelection` 抛错 / 行不存在 | 捕获、warn、spawn 继续 | `[DirectEventSink] … dropped …` |
| runner 侧 `MEMORY.md` 被删 / 变目录 / 不可读 | 回执 `unmeasurable` + error(无堆栈);完成照常 | 列 `runner_memory_closeout='unmeasurable'` |
| env 快照缺席 / 坏 JSON / 不合形 | `spawn` 缺席;未超预算 ⇒ `unmeasurable`(error=`snapshot_missing`);超预算仍 `over_budget` | 行里 `delta=?L/?files` |
| 索引超软预算(即使本次写了) | `over_budget` 优先于 `written`;`delta` 只在「有 spawn 快照且两侧 `topicFiles ≥ 0`」时才算(与状态无关);任一侧 -1 ⇒ 无 `delta`,行里 `?L/?files` | 回执行第 3/4 形态;列可直接 WHERE |
| 索引超硬上限 | 同上 + `first_dropped_line=K` + 「next runner will NOT load …」句 | 截断可见(Lead 硬要求 ②) |
| 回执 JSON > 4,096 字节 / 未知顶层键 / v≠1 / state 不在枚举 / dir 相对路径 | Bridge 拒收,两列不写,决策/完成照常 | `… receipt rejected … reason=malformed` |
| HTTP `/events` session_started payload 里塞 `runner_memory_arm/dir/spawn` | 忽略 | 三列 NULL(负向测试) |
| HTTP `/events` session_completed 里塞**合形**回执但该 session 是 unsupported backend | 照收(Bridge 不知道 backend 与回执的关系,也不该猜) | 记录;§6 边界写明「回执可信度 = runner 自报」 |
| `qa-result` 重放(idempotentReplay=true) | 回执照写(幂等覆盖,内容相同) | — |
| `/decision` 落列失败(store 抛) | warn,决策响应不变 | `[workflow-decision] runner-memory closeout persist failed exec=… <msg>` |
| `complete --route blocked` | 回执照量照带(blocked 前可能写过);不影响 blocked 语义 | — |
| 并发同角色 runner | 各自相对自己的快照;`written` 可能来自对方 | §6 边界;不加锁(B0 已声明) |
| `countTopicFiles` readdir 抛错(spawn 或 closeout 任一侧) | `topicFiles=-1`;预算内 ⇒ `unmeasurable`(`topic_count_unavailable`);超预算 ⇒ 仍 `over_budget`;**两种情况都不产生 `delta`**(Codex R2 #2:I/O 失败不能变成写入证据);解析器拒收「任一参与 topicFiles 为 -1 却带 `delta`」的回执 | 回执可见,列可查 |
| 整理后索引变短(`delta.lines` 为负) | 合法 `written`;Bridge 解析器接受有符号整数 | 回执行 `delta=-20L/+1files` |
| 回执 `error` / `dir` 含换行或控制字符、超长 | runner 侧 `sanitizeOneLine` 先截;Bridge 解析器拒收含控制字符的 `dir`,`error` >200 ⇒ malformed | 日志行永远单行 |
| topic 文件数 ≥ 10,000 | 计数饱和在 10,000,`written/unchanged` 判定按饱和值比(两侧同为 10,000 视为相同) | §6 边界写明 |

### 0.7 fail-loud 的三个可见面

| 面 | 载体 | 内容 |
|---|---|---|
| runner 终端 | `complete` / `qa-result` 的 stderr 回执行(POST 之前) | 三态 + Δ + 超预算指令;`unchanged` 附「write it now」提示 |
| Bridge 日志 | `[event-route]` / `[workflow-decision]` 回执行;`[DirectEventSink]` 归因行 | 同形 + exec id |
| 数据 | `sessions.runner_memory_closeout`(三态列)+ `runner_memory_receipt`(JSON)+ `runner_memory_arm/dir/spawn` | research §3.7 的两条 SQL 可直接跑 |

### 0.8 安全与边界

- 回执与归因不含记忆**内容**,只含路径、计数、哈希前缀;prompt 段不二次注入索引内容(B0 原则不变)。
- `runner_memory_dir` 是机器本地绝对路径,进 `sessions` 与 B0 已入库的 `worktree_path` 同级敏感度。
- Bridge 侧解析器对 runner 自报 JSON 做形状与大小校验(≤4KB、闭合键集、枚举、绝对路径),不 `eval`、不拼 SQL(`patchSessionMetadata` 参数化)。
- `/decision` 与 `/events` 的鉴权不变(凭证 / ingest token);回执不带任何权威语义。
- `emitRunnerMemorySelection` 只在 Bridge 进程内 sink 写库;HTTP 客户端结构上没有通道(no-op),`/events` 不接受同名字段——与 FLY-1372 / FLY-1185 的红线一致。

---

## 0.9 第零批:金样本基线(在任何生产代码改动之前,单独一个 commit)

在 `packages/` 树仍与实现前基线**逐字节相同**时捕获(Codex R2 #5:批次内「先捕获」不算来源证明,要有可机械核验的不可变基线):先断言 `git diff --stat ee3349456 HEAD -- packages/` 为空(`ee3349456` = 本 plan 评审时的实现前头;若实现节点起跑时 main 已前进,以 `git merge-base HEAD origin/main` 为基线并把该 sha 写进金样本目录的 `BASELINE` 文件),再用**基线代码**跑捕获脚本,commit 为本单第一个实现 commit:`test(fly2148): pin pre-change goldens (baseline <sha>)`。之后所有批次不得改这些文件(§7 审计 grep 它们的 blob 与第零批 commit 一致)。

捕获内容(全部经既有归一化:execution UUID、临时路径、`flywheel-comm` 路径):
- `packages/edge-worker/src/__tests__/fixtures/fly2148-prompt-off.txt` / `-shared.txt`:claude-tmux 在 `off` / `shared` 臂的完整 `appendSystemPrompt`(B0 的 unsupported 金样本继续沿用)。
- `packages/claude-runner/test/fixtures/fly2148-adapter-{off,shared,unsupported}.json`:`{ argv, paneEnv(FLYWHEEL_* 名单及值), settingsJson }` 投影。
- `packages/flywheel-comm/src/__tests__/fixtures/fly2148-complete-payload-no-memory.json`、`packages/flywheel-comm/src/commands/__tests__/fixtures/fly2148-decision-body-no-memory.json`。
- `BASELINE` 文件:基线 sha 一行。

## 1. 第一批:`flywheel-config` 度量模块(搬家 + 新函数,RED → GREEN)

### 1.1 RED:`packages/config/src/__tests__/runner-memory-index.test.ts`

用 `mkdtempSync` 造目录;真 fs。每条一个 `it`:

1. 搬家等价:`RUNNER_MEMORY_HARD_LIMIT` / `DEFAULT_BUDGET` / `SCAN_CEILING_BYTES` 值逐字等于 B0(160/20000、200/25000、65536);`RUNNER_MEMORY_DEFAULT_BUDGET` 两维严格小于硬上限(B0 #1 原样搬来)。
2. `measureIndexPrefix`:B0 §1.1(5) 的五个 fixture 原样搬来并全绿(空文件、3 行、218 行 ⇒ K=201、153 行 ~210B ⇒ K=首超 25,000 行、`size>65_536` ⇒ `linesExact=false`)。
3. `readIndexPrefixBounded`:8MB 稀疏文件(前 1KB 300 行)⇒ `size=8_388_608`、`prefix.length=65_536`;`vi.spyOn(fs,"readSync")` 断言累计请求 ≤ 65_536、`closeSync` 恰一次;短读桩(第一次 100B、第二次 0)⇒ 桩被调两次、`prefix.length=100`、`size` 仍精确;`fstatSync` 抛 ⇒ `closeSync` 仍被调且异常向上抛(由调用方归为 unmeasurable)。
4. `countTopicFiles`:空目录 0;`a.md b.md MEMORY.md notes.txt sub/`(sub 是目录,内含 c.md)⇒ 2;目录不存在 ⇒ -1;10,001 个 `.md` ⇒ 10_000(饱和,`readdirSync` 仍只调一次)。
5. `measureRunnerMemoryIndex(dir)`(唯一组合原语):`MEMORY.md` 3 行 + 2 个 topic ⇒ `snapshot={lines:3, linesExact:true, bytes:<真>, sha16:/^[0-9a-f]{16}$/, topicFiles:2}` 且 `stats.lines/linesExact/bytes` 逐字等于 snapshot 的同名字段、`stats.overBudget=false`;改一个字节 ⇒ `sha16` 变;只加 topic 文件不动索引 ⇒ `sha16` 不变、`topicFiles` +1;218 行 ⇒ `stats.overHard=true, firstDroppedLine=201` 且 `snapshot.lines=218`;`MEMORY.md` 不存在 / 是目录 ⇒ 抛(调用方归为 unmeasurable);**一次读证明**:`vi.spyOn(fs,"openSync")` 恰 1 次、`readSync` 累计 ≤ 65_536、`closeSync` 恰 1 次、`readdirSync` 恰 1 次——两个视图来自同一个 prefix。
6. `resolveRunnerMemoryCloseoutState({spawn, closeout})` 顺序(§0.3 ①-⑥ 逐条一个 `it`):超软预算且 sha 变 ⇒ `over_budget`(不是 written);超硬 ⇒ `over_budget`;spawn undefined 且预算内 ⇒ `unmeasurable`(snapshot_missing);spawn undefined 且超预算 ⇒ `over_budget`;`spawn.topicFiles=-1` 或 `closeout.topicFiles=-1` 且预算内 ⇒ `unmeasurable`(topic_count_unavailable);`closeout.topicFiles=-1` 且超预算 ⇒ `over_budget`;sha 同、files 同 ⇒ `unchanged`;sha 同、files +1 ⇒ `written`;sha 变、files -3 ⇒ `written`(负 Δ 合法);两侧 topicFiles 都是 10,000 且 sha 同 ⇒ `unchanged`。
7. `formatRunnerMemoryCloseoutLine`:四种形状各一条正则逐字锁(§0.4);`delta` 负数不带 `+`;无快照 `?L/?files`;`overHard` 才有 `first_dropped_line=<K>` 与括号句;只超软 ⇒ `first_dropped_line=none` 无括号句;`>=` 行数形态 `index=>=300L`。
8. `parseRunnerMemoryCloseoutReceipt`(§0.3 逐字段,每条一个 `it`):合形 written / unchanged / over_budget / 三种 unmeasurable 各往返 `parse(JSON.parse(JSON.stringify(r)))` 深等于 r(含**无 `closeout` 的 fs-unmeasurable**);`v:2` ⇒ undefined;`state:"done"` ⇒ undefined;`dir:"rel/x"` / 含 `\n` / 1,025 字符 ⇒ undefined;多一个顶层键 `extra` 或 `closeout.extra` 或 `delta.extra` ⇒ undefined;`closeout.bytes: NaN` / `-2` / `1.5` ⇒ undefined(`topicFiles:-1` 合法);`delta.lines:-20` **合法**;`sha16` 15 位或含大写 ⇒ undefined;`measuredAt:"yesterday"` ⇒ undefined;`overHard:true` 无 `firstDroppedLine` ⇒ undefined;`state:"unchanged"` 但 `delta.lines:1` ⇒ undefined;`state:"over_budget"` 但 `closeout.overBudget:false` ⇒ undefined;`state:"written"` 但 `closeout.overBudget:true` ⇒ undefined(反向);两张快照相同却 `state:"written", delta:{indexChanged:true,lines:0,topicFiles:0}` ⇒ undefined(delta 必须等于重算值);`delta.lines` 与 `closeout.lines - spawn.lines` 不等 ⇒ undefined;`spawn.topicFiles:-1` 却带 `delta` ⇒ undefined;`state:"written"` 无 `spawn` ⇒ undefined;`state:"written"` 无 `closeout` ⇒ undefined;`state:"unmeasurable"` 无 `error` ⇒ undefined;`error` 201 字符或含 `\n` ⇒ undefined;序列化 4,097 字节 ⇒ undefined;非对象 / null / 数组 ⇒ undefined。`parseRunnerMemorySnapshot` 同样逐字段一组。
9. 默认导入锁:`import fs from "node:fs"` 且源码里无 `import { … } from "node:fs"` 具名导入(读源文件 grep;B0 同规则)。
10. `sanitizeOneLine`:`"a\nb\tc\x07d"` ⇒ `"a b c d"`;300 字符 ⇒ 200 字符;空串 ⇒ `"unknown"`。

### 1.2 GREEN

`packages/config/src/runner-memory-index.ts` 按 §0.3 签名实现;`index.ts` re-export;`edge-worker/runner-memory.ts` 机械改引用并 re-export,删私有 `readMemoryIndex`,`prepareRunnerMemoryMount` 改调 `measureRunnerMemoryIndex(dir)` 并把 `snapshot` 放进 mounted 结果(同一次读,两个视图)。跑 `pnpm --filter flywheel-config test -- runner-memory-index` 与 `pnpm --filter flywheel-edge-worker test -- runner-memory`(B0 两个测试文件零改动全绿 = 搬家无损的证据)。

提交:`refactor(config): move runner-memory index measurement to flywheel-config and add closeout receipt types (FLY-2148)`。

## 2. 第二批:spawn 侧归因 + 快照 env(RED → GREEN)

### 2.1 RED:`Blueprint.fly2148-runner-memory-closeout.test.ts` + adapter 测试

照 `Blueprint.fly2147-runner-memory.test.ts` 台架(mock adapter 捕 ctx / prompt;`HOME` 与 `FLYWHEEL_RUNNER_MEMORY_ROOT` 指向 `mkdtempSync`;`runnerMemoryPreparer` 注入不存在的 managed 路径),再注入 `eventEmitter = { emitStarted: vi.fn(), emitWorktreeReady: vi.fn(), emitCompleted: vi.fn(), emitFailed: vi.fn(), emitHeartbeat: vi.fn(), flush: vi.fn(), emitRunnerMemorySelection: vi.fn() }`,`runnerMemoryMode` 注入 `{hasOverride:true, raw:"role"|"shared"|"off"}`:
0. **金样本来自第零批**(§0.9,已在实现前基线上 commit):§2.1(2)(3)(5) 与 §2.1(10) 的 byte-identical 断言**比对那些文件**,不比对「新输出剔除段」的派生值;归因副作用(`emitRunnerMemorySelection` 被调)明确**不在** byte 合同内,单独断言。

1. `role` + claude-tmux + `qa` + `flywheel` ⇒ `emitRunnerMemorySelection` 被调恰一次,参数 `{arm:"role", dir: join(root,"flywheel","qa"), spawn:{lines:3, linesExact:true, bytes:<真>, sha16:/^[0-9a-f]{16}$/, topicFiles:0}}`;adapter ctx `runnerMemory.snapshot` 深等于同一对象;**调用发生在 `adapter.execute` 之前**(用 `mock.invocationCallOrder` 断言)。
2. `shared` ⇒ 被调一次 `{arm:"shared"}`(无 dir/spawn);`runnerMemory` 为 undefined(B0 语义不变);prompt 无 `## Runner Memory`。
3. `off` ⇒ 被调一次 `{arm:"off"}`;其余与 B0 `off` 路径一致。
4. `role` 但 `projectName` 缺 ⇒ `{arm:"role"}` 无 dir/spawn;adapter 收 `{status:"disabled", reason:"no_project"}`(B0 不变)。
5. unsupported backend(`antigravity-tmux`)⇒ **不调用** `emitRunnerMemorySelection`;prompt 与 B0 金样本 `fly2147-prompt-golden-unsupported-backend.txt` 逐字相同(继续锁 byte-identical)。
6. `emitRunnerMemorySelection` 抛错 ⇒ `console.warn` 收到含 `runner-memory selection` 的行,`adapter.execute` 仍被调,prompt 仍含 `## Runner Memory`。
7. emitter 没有该方法(旧 mock,`emitRunnerMemorySelection` 未定义)⇒ 不抛、正常 spawn(可选方法合同)。
8. prompt:claude mounted ⇒ 含 `- Write rule (closeout contract, FLY-2148):`、`BEFORE you run your completion command`、`written / unchanged / over_budget`,**不含** `Prefer writing at the end`;codex mounted ⇒ 含 `- Closeout contract (FLY-2148):` 与 `Codex has no native index guard`,不含 `Write rule (closeout contract`;claude skipped(`no_project`)与 codex skipped ⇒ 两句都不含;FLY-1188 快照测试零改动全绿。
9. 类型相容:`toRunnerMemoryDisposition(mountedWithSnapshot).snapshot` 满足 `AdapterExecutionContext["runnerMemory"]` mounted 分支(编译期;另加运行时深等于断言)。

adapter(`TmuxAdapter.test.ts` / `CodexTmuxAdapter.test.ts`):
10. mounted + snapshot ⇒ pane env / codex env 含 `FLYWHEEL_RUNNER_MEMORY_SNAPSHOT=<JSON>`,`JSON.parse` 后深等于 snapshot;mounted 无 snapshot ⇒ 不含;disabled / undefined ⇒ 不含。
11. FLY-1869 allowlist 与 FLY-1643 逐字名单加 `FLYWHEEL_RUNNER_MEMORY_SNAPSHOT`;最坏路径形状(B0 §3.1(4) 的 446 字符 dir)+ 快照 JSON 仍在 tmux 命令预算内。
12. argv 负向:claude `--settings` JSON **不含**快照(快照只走 env);codex argv 不含 `autoMemory*`(B0 不变)。

### 2.2 GREEN

- `ExecutionEventEmitter.ts`:接口加可选方法与 `RunnerMemorySelectionRecord`;`TeamLeadClient.emitRunnerMemorySelection = async () => {}` + JSDoc 红线。
- `Blueprint.ts` 在 `if (memoryMount) { … mount 日志 … }` 块(`:2729-2733`)之后、`const home = …` 之前(Codex R1 #6:`memoryMount` 在 `:2715` 才声明):
```ts
if (backend === "claude-tmux" || backend === "codex-tmux") {   // unsupported backend:一切不变,不发归因(§0.3 NULL 语义)
  const memoryRecord: RunnerMemorySelectionRecord =
    memoryMount?.status === "mounted"
      ? { arm: memorySelection, dir: memoryMount.dir, spawn: memoryMount.snapshot }
      : { arm: memorySelection };
  try { await this.eventEmitter?.emitRunnerMemorySelection?.(env, memoryRecord); }
  catch (err) { console.warn(`[Blueprint] runner-memory selection attribution failed exec=${env.executionId}: ${msgOnly(err)}`); }
}
```
  (B0 今天对 unsupported backend 也会打 `runner-memory selection` 日志行——那一行不动;归因只对两种受支持 backend 发,§2.1(5) 锁结果。)
- `toRunnerMemoryDisposition`:mounted ⇒ `{status:"mounted", dir, snapshot}`。
- 两个 adapter 各一行 env。

提交:`feat(edge-worker): persist runner-memory arm attribution and pass spawn snapshot to runners (FLY-2148)`。

## 3. 第三批:收口回执(flywheel-comm,RED → GREEN)

### 3.1 RED:`runner-memory-closeout.test.ts` + `complete.test.ts` + `qa-result.test.ts`

`runner-memory-closeout.test.ts`(真 fs,`mkdtempSync`):
1. `FLYWHEEL_RUNNER_MEMORY_DIR` 缺席 / 空串 / `"rel/dir"` ⇒ undefined。
2. dir 存在、`MEMORY.md` 3 行、env 快照 = 当前 ⇒ `state:"unchanged"`,`delta:{indexChanged:false, lines:0, topicFiles:0}`,`measuredAt` 为注入的 `now()`。
3. 追加 1 行指针 + 1 个 topic 文件 ⇒ `written`,`delta:{indexChanged:true, lines:1, topicFiles:1}`。
4. 只加 topic 文件、索引不动 ⇒ `written`(`topicFiles` 变即算写)。
5. 索引 170 行(超软)⇒ `over_budget`,`closeout.overBudget=true, overHard=false, firstDroppedLine` 缺席;218 行 ⇒ `over_budget`,`overHard=true, firstDroppedLine=201`。
6. 快照 env 缺席 ⇒ `unmeasurable`,`error:"snapshot_missing"`,`spawn` 缺席,`delta` 缺席;快照坏 JSON / 不合形(缺 `sha16`)⇒ 同上;快照缺席但索引超预算 ⇒ `over_budget`。
7. `MEMORY.md` 不存在 / 是目录 / dir 不存在 ⇒ `unmeasurable`,`error` 以 fs 错误 message 开头、不含 `\n    at `(无堆栈)。
8. 回执经 `parseRunnerMemoryCloseoutReceipt` 往返深等于自身(runner 侧产物必须过 Bridge 侧校验——两端合同一致的证据)。

`complete.test.ts`(既有台架,只加):
9. env 无 `FLYWHEEL_RUNNER_MEMORY_DIR` ⇒ `mockFetch` 收到的 body 经归一化(只替换 `event_id` 与 `timestamp` 类非确定性字段)后**逐字节等于**金样本 `packages/flywheel-comm/src/__tests__/fixtures/fly2148-complete-payload-no-memory.json`(§0.9 第零批在实现前基线上捕获并 commit;Codex R1 #5:既有测试只查部分字段,不算 byte 合同),且 `"runnerMemoryCloseout" in payload === false`。
10. 有 dir + 快照 + 写了一行 ⇒ payload.runnerMemoryCloseout.state === "written";`errorSpy` 收到匹配 `/^\[complete\] runner-memory closeout state=written dir=/` 的一行,且**该行在 `mockFetch` 首次调用之前**(invocationCallOrder)。
11. `--route blocked` + dir ⇒ 同样带回执。
12. dir 指向不存在路径 ⇒ `state:"unmeasurable"`,exit code 不变(完成不因回执失败而失败)。

`qa-result.test.ts`(既有台架,只加):
13. 有 dir ⇒ `/decision` body 含 `runner_memory_closeout`(深等于 `collectRunnerMemoryCloseout` 的结果),stderr 有 `[qa-result] runner-memory closeout …` 行;无 dir ⇒ body 归一化后**逐字节等于**金样本 `packages/flywheel-comm/src/commands/__tests__/fixtures/fly2148-decision-body-no-memory.json`(§0.9 第零批捕获;既有 `toMatchObject` 不算)。
14. recoverable marker(fail-close 落盘)**不含** `runner_memory_closeout`。
15. `MEMORY.md` 正常但 `countTopicFiles` 被桩成抛错(`vi.spyOn(fs,"readdirSync")`)⇒ `state:"unmeasurable"`、`error:"topic_count_unavailable"`、`closeout.topicFiles=-1`、**`"delta" in r === false`**;同桩 + 218 行索引 ⇒ `over_budget` 且 **无 `delta`**、回执行含 `delta=?L/?files`;反向:env 快照 `topicFiles:-1`、closeout 正常 ⇒ 同样无 `delta`(`unmeasurable` 或 `over_budget`);三种都过 `parseRunnerMemoryCloseoutReceipt` 往返。
16. 整理后索引从 50 行缩到 30 行 + 删 2 个 topic ⇒ `written`,`delta:{lines:-20, topicFiles:-2}`,回执行含 `delta=-20L/-2files`,且过 `parseRunnerMemoryCloseoutReceipt`。
17. 收口函数是全函数(Codex R2 #4 / R3):`FLYWHEEL_RUNNER_MEMORY_DIR` 含 `\n` / 1,025 字符 / 相对路径 / **纯空白 `"  "`** ⇒ 返回 undefined 且注入的 `log` 恰收到一行 `[complete] runner-memory closeout skipped: invalid FLYWHEEL_RUNNER_MEMORY_DIR`;`undefined` 或 `""` ⇒ undefined 且无行;**末尾带空格的绝对目录**(`mkdtemp` 后 `rename` 成 `…/dir `)⇒ 正常度量且 `receipt.dir` 逐字等于 env 值(含尾空格,证明没有 trim);`now` 抛错 ⇒ 仍返回回执且 `measuredAt` 为有效 ISO;`now` 返回 `new Date(NaN)` ⇒ 同上;`now` 与 `Date` 都被桩成无效 ⇒ undefined + `skipped: clock unavailable` 行;注入 `log: () => { throw new Error("x") }` 且 dir 非法 ⇒ 返回 undefined **不抛**;同样的抛错 logger + 合法 dir ⇒ 仍返回正常回执;fs 错误 message 含换行与 300 字符 ⇒ `error` 单行 ≤200;把 `parseRunnerMemoryCloseoutReceipt` 桩成先 false 后 true ⇒ 返回 `error:"self_check_failed"` 的 unmeasurable 且**不抛**;桩成恒 false ⇒ 返回 undefined + `skipped: receipt self-check failed` 行;`measureRunnerMemoryIndex` 抛非 Error 值(`throw "x"`)⇒ 仍返回回执。`complete` / `qa-result` 层:把收口函数桩成抛错 ⇒ 完成命令**仍成功**且 payload 无回执(双保险:调用处也包 try/catch)。

### 3.2 GREEN

`runner-memory-closeout.ts`:
```ts
export function collectRunnerMemoryCloseout(
  env: NodeJS.ProcessEnv,
  opts: { prefix: "[complete]" | "[qa-result]"; now?: () => Date; log?: (line: string) => void },
): RunnerMemoryCloseoutReceipt | undefined {
  const prefix = opts.prefix;
  const safeLog = (line: string): void => { try { (opts.log ?? console.error)(line); } catch { /* logger must never break closeout */ } };
  try {
    const raw = env.FLYWHEEL_RUNNER_MEMORY_DIR;                                         // 逐字,不 trim(Codex R3 #1)
    if (raw === undefined || raw === "") return undefined;                              // 没有角色记忆:静默
    if (!isReceiptSafeDir(raw)) {                                                       // 绝对 / 无控制字符 / ≤1024,与解析器同一规则;纯空白也走这里
      safeLog(`${prefix} runner-memory closeout skipped: invalid FLYWHEEL_RUNNER_MEMORY_DIR`);
      return undefined;
    }
    const dir = raw;
    const measuredAt = safeIsoNow(opts.now);                                            // 唯一一次取时间;now 抛 / Invalid Date ⇒ new Date();仍无效 ⇒ undefined
    if (!measuredAt) { safeLog(`${prefix} runner-memory closeout skipped: clock unavailable`); return undefined; }
    let spawn: RunnerMemorySnapshot | undefined;
    try { spawn = parseRunnerMemorySnapshot(JSON.parse(env.FLYWHEEL_RUNNER_MEMORY_SNAPSHOT ?? "null")); } catch { spawn = undefined; }   // 不合形 ⇒ undefined
    let measured: ReturnType<typeof measureRunnerMemoryIndex> | undefined;
    let fsError: string | undefined;
    try { measured = measureRunnerMemoryIndex(dir); }                                   // 唯一一次读
    catch (err) { fsError = sanitizeOneLine(msgOnly(err), 200); }
    let candidate: unknown;                                                              // 有意 unknown:四态联合用条件展开拼不出可缩窄的判别联合(Codex R5),由解析器缩窄
    if (!measured) {
      candidate = { v: 1, state: "unmeasurable", dir, measuredAt, ...(spawn ? { spawn } : {}), error: fsError ?? "unknown" };   // 无 closeout
    } else {
      const closeout = {
        ...measured.snapshot,
        overBudget: measured.stats.overBudget,
        overHard: measured.stats.overHard,
        ...(measured.stats.overHard ? { firstDroppedLine: measured.stats.firstDroppedLine } : {}),
      };
      const state = resolveRunnerMemoryCloseoutState({ spawn, closeout });             // §0.3 ①-⑥
      const canDelta = spawn !== undefined && spawn.topicFiles >= 0 && closeout.topicFiles >= 0 && state !== "unmeasurable";   // 与 state 无关的独立条件(Codex R2 #2)
      const delta = canDelta && spawn
        ? { indexChanged: spawn.sha16 !== closeout.sha16, lines: closeout.lines - spawn.lines, topicFiles: closeout.topicFiles - spawn.topicFiles }
        : undefined;
      const error = state !== "unmeasurable" ? undefined : !spawn ? "snapshot_missing" : "topic_count_unavailable";
      candidate = { v: 1, state, dir, measuredAt, ...(spawn ? { spawn } : {}), closeout, ...(delta ? { delta } : {}), ...(error ? { error } : {}) };
    }
    const parsed = parseRunnerMemoryCloseoutReceipt(candidate);                        // 自检 = 真缩窄:返回解析器产物,不返回未缩窄的输入
    if (parsed) return parsed;
    const fallback: unknown = { v: 1, state: "unmeasurable", dir, measuredAt, error: "self_check_failed" };   // 只用已校验原语
    const fallbackParsed = parseRunnerMemoryCloseoutReceipt(fallback);
    if (fallbackParsed) return fallbackParsed;
    safeLog(`${prefix} runner-memory closeout skipped: receipt self-check failed`);      // 理论不可达,但不抛
    return undefined;
  } catch (err) {                                                                       // 最外层:任何漏网异常都不出函数
    safeLog(`${prefix} runner-memory closeout skipped: ${sanitizeOneLine(msgOnly(err), 200)}`);
    return undefined;
  }
}
```
`complete.ts`(payload 组装前;调用处再包一层 try/catch = 非阻塞边界的第二道,Codex R3 #2):
```ts
let memoryReceipt: RunnerMemoryCloseoutReceipt | undefined;
try {
  memoryReceipt = collectRunnerMemoryCloseout(process.env, { prefix: "[complete]" });
  if (memoryReceipt) console.error(formatRunnerMemoryCloseoutLine("[complete]", memoryReceipt));
} catch (err) {
  console.error(`[complete] runner-memory closeout skipped: ${sanitizeOneLine(msgOnly(err), 200)}`);   // 收口回执永远不能让完成失败
  memoryReceipt = undefined;
}
if (memoryReceipt) payload.runnerMemoryCloseout = memoryReceipt;
```
`qa-result.ts`:同形(prefix `[qa-result]`),回执进 `/decision` body 的 `runner_memory_closeout`。

提交:`feat(comm): emit runner-memory closeout receipt from complete and qa-result (FLY-2148)`。

## 4. 第四批:Bridge 落库(teamlead,RED → GREEN)

### 4.1 RED

`StateStore`:
1. 新库与旧库(先用不含 5 列的 schema 建表再 open)`PRAGMA table_info(sessions)` 都含 5 列;两次 open 不抛(幂等)。
2. `patchRunnerMemorySelection(id, {arm:"role", dir:"/x", spawn:"{}"})` 返回 `true` 且 `getSession` 经 `rowToSession` 回读三字段(不是裸 SQL);不存在的 id ⇒ 返回 `false`;再 `patchRunnerMemorySelection(id, {arm:"off", dir:null, spawn:null})` ⇒ `runner_memory_dir`/`runner_memory_spawn` 回读为 undefined(**真清空**,Codex R1 #4);`patchSessionMetadata(id, {runner_memory_closeout:"written", runner_memory_receipt:"{}"})` 后 `getSession` 两字段回读;`rowToSession` 对库里非法值(`runner_memory_arm='x'`、`runner_memory_closeout='done'`)读出 undefined(闭合枚举读);`upsertSession` 带五字段回读;`COALESCE` 语义:再 upsert 不带这些字段 ⇒ 保留。
3. 直接 SQL `SELECT COUNT(*) FROM sessions WHERE runner_memory_closeout='over_budget'` 能命中(Lead 硬要求 ① 的机械证据)。

`DirectEventSink.test.ts`:
4. `emitStarted` 后 `emitRunnerMemorySelection(env, {arm:"role", dir, spawn})` ⇒ 行里 `runner_memory_arm="role"`、`runner_memory_dir=dir`、`runner_memory_spawn` JSON.parse 深等于 spawn,`console.info` 含 `persisted`;同 execution 再 `{arm:"off"}` ⇒ `arm="off"` 且 dir/spawn 回读 undefined(重放清旧值);行不存在(未 emitStarted)⇒ 不抛、`console.warn` 含 `dropped`。

`event-route.test.ts`:
5. HTTP `session_started` payload 带 `runner_memory_arm:"role", runner_memory_dir:"/evil"` ⇒ 行里三列 NULL(白名单锁)。
6. HTTP `session_completed` payload 带合形 `runnerMemoryCloseout`(state written)⇒ `runner_memory_closeout="written"`、`runner_memory_receipt` JSON 往返深等于;`console.info` 收到 `/^\[event-route\] runner-memory closeout state=written .* exec=<id>$/`。
7. 带不合形回执(`v:2`)⇒ 两列 NULL、`console.warn` 收到 `receipt rejected … reason=malformed`;其余 `patchCompletionEvidence` 字段(summary 等)照常写入(回执坏不拖累别的证据)。
8. 无回执字段 ⇒ 两列 NULL 且既有 session_completed 测试零改动全绿。

`workflow-decision-routes`(照既有测试台架;若无则 `fly2148-decision-closeout.test.ts`):
9. `/decision` body 带合形 `runner_memory_closeout` ⇒ 决策响应与不带时**逐字节相同**(`claimId/serverSeq/idempotentReplay`),且 `credentialRow.execution_id` 的行两列已写;`console.info` 有 `[workflow-decision] runner-memory closeout … exec=`。**两条已接受分支各一套**(Codex R1 #3):普通 durable-QA 路径(照 `workflow-decision-routes.test.ts:399-440` fixture)与 engine-canonical 路径(照 `:875-954` fixture),每条都断言首次接受 + `idempotentReplay=true` 重放两次都落列。
10. 不合形 ⇒ 响应不变、两列 NULL、warn `rejected`(两条分支各一条)。
11. `patchSessionMetadata` 被桩成抛错 ⇒ 响应仍 `ok:true`,warn `persist failed`(两条分支各一条)。
12. idempotentReplay 重放同 body ⇒ 两列值不变(幂等);两条分支的既有 fixture 各断言「首次接受落列」与「重放仍落列」——**不用全局 grep 计数**(它会把函数定义也数进去,Codex R2 #1);若保留静态断言,只数 `/decision` handler 源码区间内的调用表达式且排除定义行,期望恰为 2。另加:body 不带 `runner_memory_closeout` ⇒ 无任何 `runner-memory` 日志行(旧客户端静默)。

### 4.2 GREEN

按 §0.1 表逐处落;`patchCompletionEvidence` 与 `/decision` 都经 `parseRunnerMemoryCloseoutReceipt`(从 `flywheel-config` 引入——teamlead 已依赖 config)。

提交:`feat(teamlead): persist runner-memory arm attribution and closeout receipt on sessions (FLY-2148)`。

## 5. 聚焦与全仓 verification

```
pnpm --filter flywheel-config test -- runner-memory
pnpm --filter flywheel-edge-worker test -- runner-memory Blueprint.fly2147 Blueprint.fly2148 Blueprint.fly1188
pnpm --filter flywheel-claude-runner test -- TmuxAdapter CodexTmuxAdapter
pnpm --filter flywheel-comm test -- runner-memory-closeout complete qa-result
pnpm --filter flywheel-teamlead test -- StateStore DirectEventSink event-route decision
pnpm lint && pnpm -r build && pnpm test:packages:run
```
- 全绿后 push,以**该头**的 CI 结论为准([[feedback_local_green_is_not_that_head_ci_green]])。

### 5.1 真机 E2E(QA 节点执行;实现节点先跑一遍留证)——PRD B 四条 + Lead 两条硬要求

全在隔离 slot 里(`scripts/test-deploy.sh <slot> --from-branch flywheel-FLY-2148`,`FLYWHEEL_RUNNER_MEMORY_ROOT=<slot 专用根>`,`FLYWHEEL_DELIVERY_SECRET_PATH` 等隔离四件套照 QA 记忆),生产零触碰:
1. `flywheel-comm feature-flags set --name runner_memory_mode --to role --reason "FLY-2148 e2e" --bridge-url <slot>`。
2. 注入 issue A(`scripts/inject-linear-issue.sh <slot> <issue-A>`),等到 qa 节点 runner 起来;在它的 pane 里 `env | grep FLYWHEEL_RUNNER_MEMORY_`(两项都在)、prompt 里有 `Write rule (closeout contract, FLY-2148)`;让它按合同写 1 条带 nonce 的记忆并收口 ⇒ pane 上出现 `[qa-result] runner-memory closeout state=written …`;slot Bridge 日志有 `[workflow-decision] runner-memory closeout state=written … exec=<id>`;`sqlite3 <slot state.db> "select runner_memory_arm, runner_memory_closeout from sessions where execution_id='<id>'"` = `role|written`(**验收:三态可单独查询**)。
3. 注入 issue B(同 project,会经过同一 `qa` 角色)⇒ 第二个 qa runner 的 `## Runner Memory` 段报 `4 lines`(3 行头 + 1 指针),且用 B0 往返脚本的 RECALL prompt 让它复述 nonce,逐字匹配(**验收:第二次读得到第一次写的;换 issue 换工作目录同一份**);两个 session 行 `runner_memory_dir` 相等。
4. 删掉 issue A 的 worktree ⇒ `runner_memory_dir` 下文件仍在,`sha256sum MEMORY.md` 前 16 位 == issue A 回执 `closeout.sha16`(**验收:工作目录清掉后还在**)。
5. 截断可见:往该目录 `MEMORY.md` 灌 218 行短指针,注入 issue C ⇒ spawn 面 prompt 第 3 行 `OVER BUDGET … from about line 201 onward were NOT loaded`(B0)+ Bridge `OVER BUDGET` 日志;让 runner 直接收口不整理 ⇒ 收口面 `state=over_budget … first_dropped_line=201 … the next runner will NOT load entries from about line 201 onward`,列 = `over_budget`(**验收:截断可见,不静默**)。
6. 阴性对照:flag 设回 `off` 注入 issue D ⇒ pane 无 `FLYWHEEL_RUNNER_MEMORY_*`、prompt 无 `## Runner Memory`、payload 无回执、行 `arm=off` 其余 NULL(**验收:off 逐字节不变 + 归因仍落**)。
7. 证据:pane 截图/文本、Bridge 日志行、SQL 输出,一并贴进 QA 报告;每条判据先证明会红(灌 218 行前先拍一张预算内的)。

## 6. 诚实边界(本设计做什么、不做什么)

**做**:写入时机合同(每节点收口前 runner 自写一次;prompt 逐字合同);收口回执三态 + Δ + 超预算指令,三面可见(终端、日志、独立列);分流臂 + 目录 + spawn 快照入库;Codex 收口面的写侧截断守卫;`off`/`shared`/unsupported 逐字节不变;5 列幂等迁移;E2E 覆盖 PRD B 四条与 Lead 两条硬要求。

**不做 / 不能保证**:
- **写不写仍由 runner 遵守 prompt 决定**:非阻塞(Lead 裁定)。回执让「没写」可见、可统计;要升级成阻塞只改 `complete.ts` 一处,但那是 Lead 看过数据后的另一次裁定。
- **回执是 runner 自报**:Bridge 校验形状、不复量;一个 runner 可以谎报。这与 `summary` / `diffSummary` 同级,不在本单加权威。
- **回执记的是收口那一刻**:收口后 park 前再写的不进回执(`unchanged` 提示句就是给这个窗口的);重启续跑按 attempt 各算各的;同角色并发 runner 的 `written` 不区分作者(B0 不加锁不变)。
- **`shared` 臂没有目录、没有回执**,列只有 `arm`;founder 对比的是 role 臂的写入率与内容,不是两臂对称指标。
- **首跑「不是空的」从第二次起成立**:第一次 (project, role) 读到的是 3 行头;不预置种子。
- **不改 flag 默认值**:合入后生产仍是 `off`;要让记忆真的开始攒,Lead 得设 `role` / `split`。B1 保证的是「设了之后落得下、看得见、能归因」。
- **founder 对比页 / `feature-flags report` 的 tally**:后续单,数据已在 5 列里。
- **HTTP 模式 Bridge**(`TeamLeadClient`)不落归因(no-op);生产是进程内 sink。
- **topic 文件计数在 10,000 饱和**:超过后 `written/unchanged` 只能靠索引指纹判;`readdir` 失败一侧为 -1 时判 `unmeasurable` 而不是 `written`。
- **`sha16` 只覆盖索引前 64KB**:超扫描上限的索引在末尾改动不会翻转 `sha16`——但那种索引已经 `over_budget`,三态不受影响。
- 不改 Claude Code 装载侧行为;K 仍是 B0 的近似值;不做记忆质量审计;不做跨角色策略(留 founder)。

## 7. 逐项完成审计(实现节点收工前逐条打勾)

- [ ] 5 个搬家符号在 config 有唯一定义,edge-worker 是 re-export;B0 `runner-memory.test.ts` / `.encoding.test.ts` / `Blueprint.fly2147-*.test.ts` / FLY-1188 快照**零改动**全绿。
- [ ] `readIndexPrefixBounded` 与 B0 `readMemoryIndex` 的 fd/循环/finally 逐字同形;`grep -rn "readFileSync" packages/config/src/runner-memory-index.ts` 为 0;两个模块都是 `import fs from "node:fs"`。
- [ ] mounted 快照与 `index` 来自**同一次读**(测试:`fs.readSync` 累计仍 ≤ 65,536;`snapshot.bytes === index.bytes`)。
- [ ] `emitRunnerMemorySelection` 可选;TeamLeadClient no-op 带 JSDoc 红线;Blueprint 调用 await + try/catch;unsupported backend 不调用;金样本 byte-identical 测试继续通过。
- [ ] `FLYWHEEL_RUNNER_MEMORY_SNAPSHOT` 只在 mounted+snapshot 时设;FLY-1869 / FLY-1643 名单各加一项;`grep -rn "FLYWHEEL_RUNNER_MEMORY_" packages/ | grep -v "_DIR\|_ROOT\|_SNAPSHOT\|_MODE"` 为 0(没有新开关)。
- [ ] `collectRunnerMemoryCloseout` 是 `complete` 与 `qa-result` 唯一的回执来源;回执行在 POST 之前打印(invocationCallOrder 断言在);无 dir 时两处 payload/body 与第零批金样本逐字节相同。
- [ ] `measureRunnerMemoryIndex` 是仓里唯一读 `MEMORY.md` 的函数(`grep -rn "MEMORY.md" packages/*/src --include='*.ts' | grep -v __tests__ | grep -v runner-memory-index.ts` 只剩字面文案);`openSync` 计数断言在。
- [ ] `parseRunnerMemoryCloseoutReceipt` / `parseRunnerMemorySnapshot` 是 env 解析、runner 自检、Bridge 两处入口的同一把尺子(grep 四处调用);双向状态不变量与 delta 重算相等测试在;负 Δ 合法测试在;`topicFiles=-1` ⇒ 无 delta 测试在;收口函数全函数测试(§3.1(17))在。
- [ ] `rowToSession` 五项映射在;`patchRunnerMemorySelection` 返回布尔且 null 真清空的测试在;`/decision` 的两个已接受响应点(`:775-782`、`:888-895`)前各有一处 `persistRunnerMemoryCloseout(`,handler 外没有;`raw === undefined` 静默 no-op 测试在。
- [ ] 三组金样本文件(prompt off/shared、adapter 投影 off/shared/unsupported、complete payload 与 decision body no-memory)+ `BASELINE` 在第零批 commit(`packages/` 树与基线 sha 逐字节相同时捕获),之后零改动(`git log --oneline -- <fixtures>` 只有第零批那一个 commit)。
- [ ] 三态判定顺序测试(over_budget 优先于 written;snapshot 缺席 ⇒ unmeasurable/over_budget)通过;四种回执行正则逐字锁在。
- [ ] Bridge 两处都经 `parseRunnerMemoryCloseoutReceipt`;malformed ⇒ 拒收 + warn + 其它字段照写;`/decision` 响应与不带回执逐字节相同;persist 失败不改响应。
- [ ] `PRAGMA table_info(sessions)` 5 列;旧库幂等升级测试在;`WHERE runner_memory_closeout='over_budget'` SQL 测试在。
- [ ] HTTP `session_started` 塞归因字段被忽略的负向测试在。
- [ ] prompt 两句逐字与 research §3.5 一致;skipped/failed/unsupported 不含。
- [ ] `engineering/doc/milestones/FLY-2148.md` 是 PR 最后一个 commit;PR body 含变更摘要、§5 命令输出、§5.1 E2E 证据(或明确写「E2E 由 QA 节点执行,实现节点已跑 1-2 步留证」)、`## Linear Issue`、§6 边界复述。
- [ ] PRD B 四条 + Lead 硬要求两条,逐条对应到某个测试或 E2E 步骤(在 PR body 列表)。
