# FLY-2148 runner 记忆落地:写入时机 · 收口回执 · 分流归因 — 调研
Issue: FLY-2148 (https://linear.app/geoforge3d/issue/FLY-2148/2132b1-runner-记忆落地角色项目目录-短索引送达-写入时机与截断防护)
日期: 2026-09-04
基于: exploration.md

> 本文是 exploration §4 推荐路(A)落到代码上的锚点、签名、数据流与测试台架事实。全部来自本分支(head e25771ed3,含 B0 PR #1056)读代码 + 本机实测;没有一条是「文档说」。
> Lead 裁定(ask `7a0aa474`,2026-09-04):四条默认全部认可;硬要求 ① 回执三态必须**可单独查询**(不只在日志);② 截断必须**可见**。

---

## 1. 五条数据流(改前 → 改后)

```
                 spawn                                            closeout
Blueprint ──selection──► mount ──► prompt 段 ──► adapter env ──► runner ──► complete / qa-result ──► Bridge ──► sessions
   │           (B0)      (B0)        (B0)          (B0)                       │                          │
   │                                                                          │                          │
   └─[B1-a] emitRunnerMemorySelection ─────────────────────────────────────── │ ──────────────────► sessions.runner_memory_arm / _dir / _spawn
                                                  [B1-b] +FLYWHEEL_RUNNER_MEMORY_SNAPSHOT env          │
                                                                              └─[B1-c] 量索引、比快照、打回执行、塞 payload
                                                                                                        └─[B1-d] 落 sessions.runner_memory_closeout / _receipt
                                                                     [B1-e] prompt 「Write rule」改成收口合同(Claude / Codex 两形态)
```

## 2. 锚点(文件:行,head e25771ed3)

### 2.1 spawn 侧(edge-worker)

| 锚点 | 现状 | B1 动作 |
|---|---|---|
| `packages/edge-worker/src/Blueprint.ts:853` `private eventEmitter?: ExecutionEventEmitter` | 构造注入;生产走 `DirectEventSink`(Bridge 进程内),HTTP 模式走 `TeamLeadClient` | 不动 |
| `Blueprint.ts:1006` `this.eventEmitter?.emitStarted(env)` | **在 worktree 创建之前**发出(DirectEventSink `:288-291` 注释证实) | 不动;臂/目录/快照**不能**搭这班车 |
| `Blueprint.ts:1448` `emitWorktreeReady(...)` | worktree 建好后发出,DirectEventSink 侧做 `bindWorktreeOnce`;`TeamLeadClient.emitWorktreeReady` 显式**丢弃** `binding` 参数(`ExecutionEventEmitter.ts:252-266`)= 「Bridge 权威只走进程内 sink」的既有先例 | 先例照抄 |
| `Blueprint.ts:2703-2714` 选臂 + `console.info("[Blueprint] runner-memory selection …")` | 只打日志 | 之后紧接 **`this.eventEmitter?.emitRunnerMemorySelection?.(env, {...})`**(新可选方法,见 §3.1) |
| `Blueprint.ts:2715-2727` `memoryMount = this.runnerMemoryPreparer({...})` | 返回 `RunnerMemoryMount`(mounted 含 `index: RunnerMemoryIndexStats`) | mounted 时再算快照 `sha16 + topicFiles`(§3.3 的 `snapshotRunnerMemoryIndex(dir)`),随 selection 一起发、随 `runnerMemory` 一起交 adapter |
| `Blueprint.ts:2869-2870` `runnerMemory: toRunnerMemoryDisposition(memoryMount)` | `{status:"mounted", dir}` / `{status:"disabled", reason}` / undefined | mounted 加 `snapshot: RunnerMemorySnapshot`(§3.2 类型) |
| `packages/core/src/adapter-types.ts` `AdapterExecutionContext.runnerMemory` | 判别联合 | mounted 分支加可选 `snapshot` |
| `packages/claude-runner/src/TmuxAdapter.ts:719` `appendPaneEnv("FLYWHEEL_RUNNER_MEMORY_DIR", …)` | 只在 mounted 时 | 旁边加 `appendPaneEnv("FLYWHEEL_RUNNER_MEMORY_SNAPSHOT", JSON.stringify(snapshot))`(mounted 且 snapshot 存在时) |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:2203` `env.FLYWHEEL_RUNNER_MEMORY_DIR = …` | 同上 | 同上加 `env.FLYWHEEL_RUNNER_MEMORY_SNAPSHOT` |
| `packages/claude-runner/test/TmuxAdapter.test.ts:285-300` FLY-1869 「完整生产 allowlist」名单 | 逐字数组,含 `FLYWHEEL_RUNNER_MEMORY_DIR` | 加 `FLYWHEEL_RUNNER_MEMORY_SNAPSHOT`(不加则该测试红——这是有意的名单锁) |
| `packages/claude-runner/test/CodexTmuxAdapter.test.ts:1199` FLY-1643 逐字 `FLYWHEEL_*` env 名单 | 同上 | 同上加一项 |
| `packages/edge-worker/src/runner-memory.ts:604-606` `- Write rule: … Prefer writing at the end of your work …` | claude 形态第 4 行 | 改为收口合同(§3.5 逐字) |
| `runner-memory.ts:586` codex 形态首行 `… write new lessons there in the same shape …` | codex 形态 | 追加收口合同句(§3.5) |
| `runner-memory.ts:186-286` `measureIndexPrefix` + 常量;`:417-436` 内联的 `openSync/fstatSync/readSync/closeSync` 有界读 | 全在 edge-worker | **搬到** `packages/config/src/runner-memory-index.ts`,edge-worker 从 config re-export 同名符号(B0 的 `runner-memory.test.ts` / `.encoding.test.ts` import 路径与字面全部不变) |

### 2.2 收口侧(flywheel-comm,runner 进程内)

| 锚点 | 现状 | B1 动作 |
|---|---|---|
| `packages/flywheel-comm/package.json` deps | `flywheel-config` ✓、**无** `flywheel-edge-worker` | 度量函数必须住在 `flywheel-config`(§2.1 最后一行) |
| `packages/flywheel-comm/src/commands/complete.ts:113-132` `type Payload` | `decision / evidence / sessionRole / summary / exitReason / issueIdentifier / reviewQuestionId / designHtmlEvidence / workflowActivation` | 加 `runnerMemoryCloseout?: RunnerMemoryCloseoutReceipt` |
| `complete.ts:385-420` 组 `payload` 的位置(`const payload: Payload = {...}`;`if (designHtmlEvidence) payload.designHtmlEvidence = …`) | — | 之前调用 `collectRunnerMemoryCloseout(process.env)`(§3.4);非 undefined 时 `payload.runnerMemoryCloseout = receipt` 并 `console.error(formatRunnerMemoryCloseoutLine(receipt))`(stderr,与其它 `[complete]` 行同通道;**在 POST 之前打印**,runner 还活着能补写) |
| `complete.ts:288-320` `requireEnv("FLYWHEEL_EXEC_ID")` 等 | 四个必需 env | `FLYWHEEL_RUNNER_MEMORY_DIR` / `_SNAPSHOT` **不是必需**:缺席 ⇒ 回执 undefined ⇒ payload 无字段 ⇒ 与改前 byte-identical(`off` / `shared` / unsupported backend 都走这条) |
| `packages/flywheel-comm/src/commands/qa-result.ts:582-591` 读 `FLYWHEEL_EXEC_ID/ISSUE_ID/PROJECT_NAME/BRIDGE_URL` | 同形 | 同上,在组 `/decision` body(`:662-663` `credential / client_request_id`)时加 `runner_memory_closeout` 字段 + 同一行 stderr |
| `qa-result.ts:1445-1470` `recoverable_verdict` 的 body 摘要 | 只保留 status / summary | 不改(回执不进 recoverable marker——重放时由 Bridge 已存的列为准;不重复承载) |
| `packages/flywheel-comm/src/__tests__/complete.test.ts` | `vi.mock("node:child_process")` 控 git;`mockFetch` 捕 payload;`tmpHome` 临时目录;`activateCompletion()` 造 CommDB 激活 | RED 用同一套:设 `FLYWHEEL_RUNNER_MEMORY_DIR=<tmp>`、`_SNAPSHOT=<json>` 后断言 `mockFetch` 收到的 payload |

### 2.3 Bridge 侧(teamlead)

| 锚点 | 现状 | B1 动作 |
|---|---|---|
| `packages/teamlead/src/DirectEventSink.ts:207` `emitStarted` 落 Bridge-trusted 字段(`skill_framework_mode` `doc_tier` `codex_skip` …,`:273-283`) | 只有 sink 写 | 新增 `emitRunnerMemorySelection(env, sel)`:`this.store.patchSessionMetadata(env.executionId, { runner_memory_arm, runner_memory_dir, runner_memory_spawn })` |
| `packages/edge-worker/src/ExecutionEventEmitter.ts:101-134` `interface ExecutionEventEmitter` | 6 个方法 | 加**可选**方法 `emitRunnerMemorySelection?(env, sel): Promise<void>`——可选是为了不逼所有测试 mock 实现它;`TeamLeadClient` 实现为 **no-op**(JSDoc 写明:HTTP `/events` token runner 可见,不带 Bridge 权威,与 `emitWorktreeReady` 丢 `binding` 同一红线) |
| `packages/teamlead/src/bridge/event-route.ts:1290-1315` HTTP `session_started` 落库,`skill_framework_mode` 经闭合枚举守卫 | `/events` 只接受白名单字段 | **不加** `runner_memory_arm/dir/spawn` 的 HTTP 接受路径;负向测试:payload 里塞这三个字段,行里仍为 NULL |
| `event-route.ts:1950-1970` `patchCompletionEvidence()`(session_completed → `store.patchSessionMetadata`) | 写 `decision_route / summary / diff_summary / commit_* / pr_number` | 加 `runner_memory_closeout`(三态)与 `runner_memory_receipt`(JSON);来源 `payload.runnerMemoryCloseout`,经 §3.4 的解析器校验(不合形 ⇒ 两列都不写 + 一行 warn),再 `console.info("[event-route] runner-memory closeout …")` |
| `packages/teamlead/src/bridge/workflow-decision-routes.ts:45-51` `interface WorkflowDecisionBody` | `credential / client_request_id / status / summary / client_pr_head_sha` | 加 `runner_memory_closeout?: unknown` |
| `workflow-decision-routes.ts:650+` `router.post("/decision")`:凭证 → `resolveEngineDecisionCanonical` → 提交 → `res.json({ok:true, claimId, serverSeq, idempotentReplay})` | 决策落 workflow 表,不碰 sessions | 决策**被接受后**(非 idempotentReplay 也可重写,幂等)`deps.store.patchSessionMetadata(credentialRow.execution_id, { runner_memory_closeout, runner_memory_receipt })`;失败不影响决策结果(try/catch + warn,决策是主事务,回执是附注) |
| `packages/teamlead/src/StateStore.ts:1055-1095` `SessionUpsert` 字段;`:1183` `Session` 行类型;`:7562/7598/7646` `upsertSession` INSERT/UPSERT 列;`:8792-8845` `patchSessionMetadata` 的 `fieldMap` | 三处字段映射 | 四列各加一处:`runner_memory_arm TEXT`、`runner_memory_dir TEXT`、`runner_memory_spawn TEXT`、`runner_memory_closeout TEXT`、`runner_memory_receipt TEXT`(共 5 列——三态单独一列是 Lead 硬要求 ①) |
| `StateStore.ts:3731-3745` `for (const col of [...]) { try { ALTER TABLE sessions ADD COLUMN ${col} TEXT } catch { /* exists */ } }` | 幂等加列的既有形状 | 照抄一个 B1 循环(5 列) |
| `StateStore.ts:9019` `SELECT skill_framework_mode FROM sessions WHERE issue_id = ? …` | 按 issue 查上一次的臂(sticky) | 不需要:`runner_memory_mode=split` 的臂由 issueId 哈希确定,天然 sticky,不查库 |
| `packages/teamlead/src/__tests__/DirectEventSink.test.ts` / `event-route.test.ts` / `StateStore.test.ts`(`PRAGMA table_info`) | 既有台架 | RED 各加用例(plan §2/§3) |

### 2.4 flag(不改)

- `packages/config/src/feature-flags/registry.ts:576-601` `runner_memory_mode`:`default: "off"`,`readSites` 只有 `run-infra.ts:setupRunInfrastructure:storeRunnerMemoryMode`,`retireWhen` 写明由 founder 定论后删 split。B1 **不新增 readSite**(仍只有 Blueprint 经 `runnerMemoryMode()` 读);`feature-flags-drift.test.ts` 不需要动。
- 设法:`flywheel-comm feature-flags set --name runner_memory_mode --to role --reason "<…>" --bridge-url <slot>`(`feature-flags.ts:52`),直接 toggle、不重启。E2E 用它在隔离 slot 上开 `role`。

## 3. 合同(签名与逐字文案;plan 直接引用)

### 3.1 新 emitter 方法

```ts
// packages/edge-worker/src/ExecutionEventEmitter.ts
export type RunnerMemorySelectionRecord = {
  arm: "off" | "role" | "shared";
  /** only when arm==="role" && mount.status==="mounted" */
  dir?: string;
  spawn?: RunnerMemorySnapshot;
};
interface ExecutionEventEmitter {
  …
  /** FLY-2148: Bridge-trusted attribution; DirectEventSink persists, TeamLeadClient is a no-op. Optional so existing mocks need not implement it. */
  emitRunnerMemorySelection?(env: EventEnvelope, sel: RunnerMemorySelectionRecord): Promise<void>;
}
```
`unsupported_backend`(antigravity / kimi)**不发**(Blueprint 在 selection 之前就知道 backend;B0 对它们的合同是「一切不变」,归因列也保持 NULL——NULL 的含义 = 「本单没碰的 backend」,与 `arm=off` 区分)。

### 3.2 快照与回执类型(住 `flywheel-config`,两侧共用)

```ts
// packages/config/src/runner-memory-index.ts
export const RUNNER_MEMORY_HARD_LIMIT / RUNNER_MEMORY_DEFAULT_BUDGET / RUNNER_MEMORY_SCAN_CEILING_BYTES   // 从 edge-worker 原样搬来
export type RunnerMemoryIndexStats = { lines; linesExact; bytes; firstRun; overBudget; overHard; firstDroppedLine }  // 原样搬来
export function measureIndexPrefix(input: { prefix: Buffer; size: number }): Omit<RunnerMemoryIndexStats, "firstRun">  // 原样搬来
export function readIndexPrefixBounded(indexPath: string): { prefix: Buffer; size: number }   // 从 prepareRunnerMemoryMount :417-436 抽出,逐字同一段 openSync/fstat/readSync 循环/finally close
export type RunnerMemorySnapshot = { lines: number; linesExact: boolean; bytes: number; sha16: string; topicFiles: number };
export function snapshotRunnerMemoryIndex(dir: string): RunnerMemorySnapshot;   // = readIndexPrefixBounded + measureIndexPrefix + sha256(prefix).slice(0,16) + countTopicFiles(dir)
export function countTopicFiles(dir: string): number;   // readdirSync(dir, {withFileTypes:true}) 里「常规文件且以 .md 结尾且 !== MEMORY.md」的个数;上限 10_000 截断;readdir 抛错 ⇒ -1(回执里可见,不抛)
export const RUNNER_MEMORY_SNAPSHOT_ENV = "FLYWHEEL_RUNNER_MEMORY_SNAPSHOT";
export type RunnerMemoryCloseoutState = "written" | "unchanged" | "over_budget" | "unmeasurable";
export type RunnerMemoryCloseoutReceipt = {
  v: 1;
  state: RunnerMemoryCloseoutState;
  dir: string;
  spawn?: RunnerMemorySnapshot;          // env 快照缺席 / 坏 JSON ⇒ undefined(state 仍能算:无快照时 written/unchanged 不可判 ⇒ "unmeasurable",除非 over_budget)
  closeout: RunnerMemorySnapshot & { overBudget: boolean; overHard: boolean; firstDroppedLine?: number };
  delta?: { indexChanged: boolean; lines: number; topicFiles: number };   // 有快照时才有
  measuredAt: string;                    // ISO
  error?: string;                        // unmeasurable 的原因(fs 错误 message,无堆栈)
};
export function parseRunnerMemoryCloseoutReceipt(value: unknown): RunnerMemoryCloseoutReceipt | undefined;   // Bridge 侧入口校验:v===1、state ∈ 枚举、dir 为绝对路径、数字为有限非负、JSON ≤ 4KB;不合形 ⇒ undefined
export function formatRunnerMemoryCloseoutLine(prefix: string, r: RunnerMemoryCloseoutReceipt): string;      // §3.6 逐字
```

三态判定(**顺序即优先级**,写进测试):
1. 量不到(dir 不存在 / `MEMORY.md` 不是常规文件 / fs 抛错)⇒ `unmeasurable`(+error)。
2. `closeout.overBudget || closeout.overHard` ⇒ `over_budget`(即使也写了——超预算比写没写更要紧;`delta` 照带,Lead 仍能看到 Δ)。
3. 有快照且 `sha16 !== spawn.sha16 || topicFiles !== spawn.topicFiles` ⇒ `written`。
4. 有快照且两者都相等 ⇒ `unchanged`。
5. 无快照(env 缺席 / 坏)且未超预算 ⇒ `unmeasurable`(error=`snapshot_missing`)。

`over_budget` 里的 `firstDroppedLine`(K)沿用 B0 的算法(`measureIndexPrefix`),不另造。

### 3.3 快照怎么传(env)

`FLYWHEEL_RUNNER_MEMORY_SNAPSHOT` = `JSON.stringify(snapshot)`,形如 `{"lines":3,"linesExact":true,"bytes":112,"sha16":"9f86d081884c7d65","topicFiles":0}`(≈90 字节;FLY-1869 tmux 命令预算 16-20KB,§2.1 名单测试顺带锁预算)。只在 `runnerMemory.status==="mounted"` 且 snapshot 存在时设;`disabled` / undefined 不设。**同一份对象**既进 env 也进 `emitRunnerMemorySelection`——不是两次度量(两次度量之间文件可能变,回执会算错 Δ)。

### 3.4 收口侧函数(flywheel-comm)

```ts
// packages/flywheel-comm/src/runner-memory-closeout.ts
export function collectRunnerMemoryCloseout(env: NodeJS.ProcessEnv, now = () => new Date()): RunnerMemoryCloseoutReceipt | undefined;
// env.FLYWHEEL_RUNNER_MEMORY_DIR 缺席/空/非绝对路径 ⇒ undefined(= 本次执行没有角色记忆,payload 不带字段)
// 否则一定返回一个回执(哪怕 unmeasurable)——「挂载了但量不到」必须可见,不能退化成 undefined
```
`complete.ts` 与 `qa-result.ts` 都只调这一个函数;打印行用 `formatRunnerMemoryCloseoutLine("[complete]" | "[qa-result]", r)`。

### 3.5 prompt 收口合同(替换 B0 `Write rule` 行,逐字)

claude 形态第 4 行改为:
```
- Write rule (closeout contract, FLY-2148): one fact per topic file with frontmatter (name/description/type), one pointer line in MEMORY.md. BEFORE you run your completion command (`complete` / `qa-result`), write what this role learned in this execution — at most ~5 durable, reusable judgments; if you learned nothing durable, write nothing and say so in your final report. The completion command measures MEMORY.md, prints a `runner-memory closeout` receipt line (written / unchanged / over_budget) and records it for your Lead. Never store tokens, keys or secrets.
```
codex 形态在首行之后加第二行(首行不变):
```
- Closeout contract (FLY-2148): BEFORE you run your completion command (`complete` / `qa-result`), write what this role learned in this execution into {dir} — at most ~5 durable, reusable judgments, one topic file each plus one pointer line in MEMORY.md; if you learned nothing durable, write nothing and say so in your final report. Keep MEMORY.md under 160 lines / 20,000 bytes: Codex has no native index guard, so the completion command measures it for you and prints a `runner-memory closeout` receipt (written / unchanged / over_budget) — an over_budget receipt means consolidate before you finish. Never store tokens, keys or secrets.
```
B0 的其它行(目录、索引状态、只读指针、fail-closed 段)逐字不动。FLY-1188 快照与 fail-closed 段不含 Write rule 行(它们是 skipped/failed 形态)⇒ **不需要更新快照**;`Blueprint.fly2147-runner-memory.test.ts` 里断言 `within budget` 等的用例不受影响,但若有用例逐字断言旧的 `Prefer writing at the end` 句,改为新句(实现时 grep 确认)。

### 3.6 回执行(逐字模板;测试正则锁字段顺序)

```
{prefix} runner-memory closeout state=written dir=<abs> index=<L|>=L>L/<B>B delta=+<n>L/+<m>files budget=160L/20000B hard=200L/25000B
{prefix} runner-memory closeout state=unchanged dir=<abs> index=<L>L/<B>B delta=+0L/+0files — nothing new was written this execution; if you learned a durable, reusable judgment, write it now (one topic file + one pointer line) before you park or exit.
{prefix} runner-memory closeout state=over_budget dir=<abs> index=<L>L/<B>B delta=… first_dropped_line=<K|none> — MEMORY.md is over budget; consolidate topic files and replace or drop superseded pointers before you finish (the next runner will NOT load entries from about line <K> onward).
{prefix} runner-memory closeout state=unmeasurable dir=<abs> error=<msg>
```
- `first_dropped_line` 与「the next runner will NOT load …」只在 `overHard` 时出现;只超软预算时该括号句省略,`first_dropped_line=none`。
- Bridge 落库时的日志行同形,`prefix` = `[event-route]` / `[workflow-decision]`,末尾多 `exec=<id>`。
- 这条行是 Lead 硬要求 ②「截断可见」在收口面的载体;spawn 面的载体是 B0 的 `OVER BUDGET` 行与 prompt 第 3 行,不动。

### 3.7 三态列的查询合同(Lead 硬要求 ①)

```sql
-- 每臂写没写(founder 对比 role 臂的写入率;shared 臂没有目录,closeout 恒 NULL)
SELECT runner_memory_arm, runner_memory_closeout, COUNT(*) FROM sessions
 WHERE runner_memory_arm IS NOT NULL GROUP BY 1, 2;
-- 哪些 session 超预算(截断风险清单)
SELECT execution_id, issue_identifier, runner_memory_dir FROM sessions WHERE runner_memory_closeout = 'over_budget';
```
`runner_memory_closeout` 是独立 TEXT 列、值 ∈ {written, unchanged, over_budget, unmeasurable},不是从 JSON 里抠;`runner_memory_receipt` 存整段 JSON 供细看。

## 4. 台架与验证事实

| 事实 | 出处 | 对 plan 的影响 |
|---|---|---|
| `complete.test.ts` 用 `vi.mock("node:child_process")` + `mockFetch` + `tmpHome`,已有 `activateCompletion()` 造激活 | `packages/flywheel-comm/src/__tests__/complete.test.ts:1-70` | 回执测试直接加 `it`,不新建台架 |
| `qa-result` 有自己的 fetch 台架与 recoverable marker 逻辑 | `qa-result.ts:1427-1470` | 回执只进 `/decision` body,不进 marker |
| B0 的 Blueprint 测试用 mock adapter 捕 `ctx` 与 `appendSystemPrompt`,`HOME` / `FLYWHEEL_RUNNER_MEMORY_ROOT` 指向 `mkdtempSync`,`runnerMemoryPreparer` 注入不存在的 managed 路径 | `Blueprint.fly2147-runner-memory.test.ts`;`test/setup.ts` | B1 的 Blueprint 用例加 `eventEmitter` mock(`emitRunnerMemorySelection: vi.fn()`),沿用同一台架 |
| `StateStore` 列存在性测试用 `PRAGMA table_info(sessions)` | `StateStore.test.ts` 等 | 5 列断言照抄 |
| DirectEventSink 测试直接 `new StateStore(":memory:")` + `sink.emitStarted(env)` 后 `store.getSession` | `DirectEventSink.test.ts` | `emitRunnerMemorySelection` 用例同形 |
| `event-route.test.ts` 已有 `session_started` 白名单负向测试(`skill_framework_mode` 闭合枚举) | `event-route.test.ts` | 「HTTP 塞归因字段被忽略」用例照抄形状 |
| 真 CLI 往返脚本(三次 `claude -p`,nonce 写索引 → 跨 cwd 复述 → 删 cwd 复述) | B0 plan §4 + `~/.flywheel/artifacts/fly2147/qa-2147-roundtrip.sh` | B1 E2E 第一次写由真实 DAG runner 在收口时做,第二、三次仍可用脚本(同 `--settings` 形态) |
| 隔离 slot:`scripts/test-deploy.sh <slot>` 起 Bridge+Lead,`scripts/inject-linear-issue.sh <slot> <issue>` 注入 issue;flag 用 `feature-flags set … --bridge-url <slot>` | `.flywheel/agents/nodes/qa.md`;`feature-flags.ts:52` | 验收 E2E 全在 slot 里做,生产零触碰;`FLYWHEEL_RUNNER_MEMORY_ROOT` 指向 slot 专用根(B0 的隔离缝) |
| FLY-2147 QA 留下的探针(`criteria.mjs` 24 项、`probe-selection-ledger.sh`) | `~/.flywheel/artifacts/fly2147/README.md` | `probe-selection-ledger.sh` 读 bridge.log 判臂归属——B1 之后可改成查 `sessions.runner_memory_arm`(QA 节点自选) |
| Claude Code 2.1.260 本机;官方:写 `MEMORY.md` 后 CLI 量一次,超限「write still succeeds, but returns an error telling Claude to rewrite the index」 | `claude --version`;code.claude.com/docs/en/memory | Claude 有原生写侧守卫,B1 的收口守卫对 Claude 是第二道、对 Codex 是唯一一道 |

## 5. 风险与边界(进 plan §7)

- **回执是 runner 自报**(与 `summary` / `diffSummary` 同级),Bridge 只校验形状不复量。要复量得 Bridge 自己读文件,那是另一条路(exploration §4.2 已否)。
- **收口后再写**:runner 在 `complete` 之后、park 之前仍可写;回执记的是收口那一刻。「unchanged」提示句正是为这个窗口写的。
- **快照按 attempt**:重启续跑的新 attempt 拿新快照,上一 attempt 写的算「已在」。回执回答的是「这次 attempt 写没写」。
- **并发同角色**:两个同 (project, role) runner 同时收口,各自的 Δ 都相对自己的快照;`written` 可能来自对方——回执不区分作者(B0 §7 已声明不加锁)。
- **`shared` 臂**:没有目录、没有回执;三列 NULL,`arm=shared`。founder 对比的是「role 臂写入率 + 质量」vs「shared 臂什么都不留」。
- **HTTP 模式 Bridge**(`TeamLeadClient`):归因 no-op ⇒ 三列 NULL;生产是进程内 sink,不受影响。
- **列只增不删**:回滚 = 代码回滚,5 列留着(nullable),与 `skill_framework_mode` 同策略。
