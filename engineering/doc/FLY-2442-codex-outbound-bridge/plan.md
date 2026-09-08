# FLY-2442 Codex Lead 出站改走 Bridge + mailbox→适配器合同 — 实施计划
Issue: FLY-2442 (https://linear.app/geoforge3d/issue/FLY-2442/通路codex-codex-lead-出站改走-bridgelauncher-配置-mailbox-harness)
日期: 2026-09-08
基于: research.md(以及 exploration.md、mailbox-adapter-contract.md)

## 0. 一句话

让 Mufasa 的回复经 Bridge 代发:Bridge 只授权该 Lead 在 projects.json 里声明的 roundtable 频道及其子线程;runtime 的「bridge+跨部门 → throw」改为启动期向 Bridge 探测,403 仍 fail-loud、绝不静默回落 direct;然后把 launcher 默认翻到 bridge。合同页随本 PR 合入。

## 1. 目标、验收、红线

**验收(issue 原文 + Lead 裁定 2026-09-08,question `c135988f`)**
1. Mufasa 一条回复落 Discord 的路径 = Bridge 出站,三处证据互证(§6)。
2. direct 路径不再被 launcher 默认打开(仅作显式回滚)。
3. 合同页进 `engineering/doc/`,含「journal 为何砍不掉」原注释;Epic FLY-2441 引用(Lead 补链接,本机 Linear 401)。
4. 不动 journal、不动 Claude 侧、不动 Raya。

**Lead 红线**
- R1 Bridge 只授权该 Lead 在 projects.json **已声明**的 roundtable 频道及其子线程;⛔ 不许通配、不许「所有共享频道」、不从 Bridge 全局 env 推断。
- R2 必须有阴性对照测试:未声明频道 → 403。
- R3 启动期探测遇 deterministic 403 必须 fail-loud;⛔ 不许静默回落 direct。
- R4 若发现必须动 Claude 侧 reply-guard 或收据机制 → 停下报 Lead。本计划**不**触碰 `reply-guard.ts`、插件、`ClaudeLeadDeliveryAdapter`、`ExternalReceiptSaga`。

## 2. 改动总览

```mermaid
flowchart LR
  PJ[projects.json<br/>lead.roundtableChannel] --> AUTH[Bridge 授权集<br/>chat ∪ core ∪ roundtable ∪ 其线程]
  AUTH --> H[/api/lead-outbound/send<br/>+ probe 分支 + 审计日志]
  L[launcher 默认 bridge<br/>API token 别名] --> RT[runtime 启动探测<br/>403 → throw]
  RT --> H
```

| # | 文件 | 改动 | 行为变化 |
|---|---|---|---|
| C1 | `packages/teamlead/src/ProjectConfig.ts` | `LeadConfig.roundtableChannel?: string` + 非空字符串校验(与 `alertChannel` 同一段 `:575-590`) | 无(可选字段,今天的 Bridge 已容忍未知键) |
| C2 | `packages/teamlead/src/bridge/thread-validator.ts` | 新增 `lookupThreadParent(channelId, botToken, deps)` | 无(纯新增) |
| C2 | `packages/teamlead/src/lead-backends/codexLeadBridgeWiring.ts` | `buildAuthorizeLeadChannel(projects, deps)` 返回 `(p,l,c) => Promise<boolean>`;授权集 = `{chatChannel, generalChannel, roundtableChannel}` ∪ 父频道 ∈ 该集合的线程 | 声明了 roundtable 的 Lead 可在圆桌及其线程发言;其余 403 不变 |
| C2 | `packages/teamlead/src/lead-backends/codex/CodexLeadOutboundHandler.ts` | `authorizeLeadChannel` 允许返回 `boolean \| Promise<boolean>`,`await` | 无 |
| C3 | 同上 | body 加 `probe?: boolean`;`validateBody` 在 probe 下只要求 project/lead/channel;新状态 `"authorized"`;probe 不碰 store/send | 新增只读探测 |
| C3 | `codexLeadBridgeWiring.ts` `buildLeadOutboundExpressHandler(handler, logger?)` | 每次响应一行 `[lead-outbound] …`(只含标识符) | Bridge 日志可证 |
| C3 | `packages/teamlead/src/bridge/plugin.ts:3059-3084` | 传 `console` 作 logger;`buildAuthorizeLeadChannel(projects, { resolveBotToken })` | 无 |
| C4 | `CodexOutboundSender.ts` | 构造参数加 `leadId`、`probeTimeoutMs`(默认 5 s);`probeAuthorization(channelId): Promise<ProbeResult>`(`{state, status?, reason?}` 对象 union,见 §3 C4);probe transport 加 `AbortSignal.timeout` | 新增 |
| C4 | 新文件 `packages/teamlead/src/lead-backends/codex/outbound-preflight.ts` | `runOutboundPreflight({ probe, channelIds, attempts=4, delayMs=10_000, sleep, log })`,每轮并发探测全部频道 | `unauthorized`/`incompatible` → throw;`unavailable` → 有界重试后 warn + `"skipped"`;总预算 = 4×5 s + 3×10 s = 50 s(与频道数无关) |
| C4 | `codex-lead-tui-runtime.ts:457` `buildTuiGeneration` | 导出并加第三参 `deps`(connectDaemon / createSender / preflight,缺省生产实现) | 纯测试缝,零行为变化 |
| C4 | `codex-lead-runtime.ts:619-633` | 删 throw;config 增 `outboundProbeChannelIds`(bridge 模式 = `[chat, ...crossDept]`,direct 模式 = `[]`) | bridge+跨部门不再在解析期 throw |
| C4 | `codex-lead-runtime.ts:1632` 与 `codex-lead-tui-runtime.ts:601` 的 `startProcess` 步骤 | `startProcess: async () => { …既有 p.start()…; if (bridge) await runOutboundPreflight(...); }`——**先起进程、再探测**(Codex R3 方案 c) | 探测失败 → `startProcess` 自己 `await p.stop()` 再 rethrow(child 已接管 transport,WS 真的 `close/terminate`);外层 generation `stop()`(TUI,经 `supervisor.stop()`)再关 sender,`runtime.stop()` 幂等 |
| C5 | `packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh:101-104` | 默认 `bridge`;`FLYWHEEL_API_TOKEN=${FLYWHEEL_API_TOKEN:-${TEAMLEAD_API_TOKEN:-}}`;bridge 缺 URL/token → exit 1;`direct` 打 WARNING;其他值 → exit 1 | Mufasa 下次重启走 bridge |
| C6 | `engineering/doc/FLY-2442-codex-outbound-bridge/*` | 合同页(已提交);founder HTML 由本设计节点在评审 APPROVED 后产出、提交、发布(设计节点完成合同),不属于 implement 节点 | — |

**不改**:`run-codex-infra-bot-tui.sh`、`lead-actions/*`、`discord-send-core.ts`、`reply-guard.ts`、插件、`LeadJournal`、`CodexLeadInboxSocket`、Raya。

## 3. 各块细节(实施顺序即编号;每块 TDD:先红后绿)

### C1 projects.json 声明

```ts
/** FLY-2442: the ONE cross-department (roundtable) channel this Lead may reply into
 * through Bridge outbound. Threads whose parent is this channel inherit it. Absent ⇒
 * the Lead is NOT authorized on any shared channel (fail-closed; no wildcard). */
roundtableChannel?: string;
```
校验:`undefined` 或非空字符串,否则 throw(沿用 `:575-590` 的循环,把 `"roundtableChannel"` 加进字段数组)。
测试:`ProjectConfig.test.ts` 加「合法字符串通过 / 空串 throw / 非字符串 throw」。
生产数据变更(不在代码里):`~/.flywheel/projects.json` growth → mufasa-lead 加 `"roundtableChannel": "1512578695468941333"`。由 Lead/founder 在合并前完成(§7 步骤 0)。

### C2 Bridge 授权集

`thread-validator.ts` 新增(复用 `classifyThreadExistence` 的 fetch/timeout 形状,`:56-85`):
```ts
export type ThreadParentLookup =
  | { state: "resolved"; parentId: string }   // type ∈ {10,11,12} 且有 parent_id
  | { state: "not_thread" } | { state: "absent" } | { state: "transient"; status?: number } | { state: "denied"; status: 401|403 };
export async function lookupThreadParent(channelId: string, botToken: string, deps: DiscordExistenceDeps = {}): Promise<ThreadParentLookup>
```

`codexLeadBridgeWiring.ts`:
```ts
export interface AuthorizeLeadChannelDeps {
  resolveBotToken: (projectName: string, leadId: string) => string | undefined;
  lookupThreadParent?: typeof lookupThreadParent;   // 测试注入
  cache?: Map<string, string>;                       // channelId → parentId,只缓存 resolved
}
export function buildAuthorizeLeadChannel(projects: ProjectEntry[], deps: AuthorizeLeadChannelDeps):
  (projectName: string, leadId: string, channelId: string) => Promise<boolean>
```
逻辑:
1. `direct = {chatChannel, generalChannel, roundtableChannel}`(缺哪个跳哪个);`channelId ∈ direct` → `true`(零网络,今天的快路径)。
2. 否则 `token = resolveBotToken(p,l)`;无 token → `false`。
3. `parent = cache.get(channelId) ?? await lookupThreadParent(channelId, token)`;仅 `resolved` 写缓存;`parent ∈ direct` → `true`;其他一律 `false`。
4. 未知 `(project, lead)` → `false`(不变)。

handler:`authorizeLeadChannel?: (...) => boolean | Promise<boolean>`,第 3 步 `if (this.authorizeLeadChannel && !(await this.authorizeLeadChannel(...)))`。

测试(`codexLeadBridgeWiring.test.ts`),两层:

纯授权函数层(缓存/查找语义):
- 声明了 `roundtableChannel` 的 Lead → 该频道 `true`。
- 线程:lookup 返回 `resolved(parent=roundtable)` → `true`;`resolved(parent=其他)` → `false`;`transient` → `false` 且第二次仍调 lookup(不缓存否定);`resolved` 后第二次不再调 lookup(缓存)。
- 无 token → `false`,且 lookup 未被调用。
- 同名 agentId 在另一项目 → `false`(既有)。

**端到端 403 层(R2 阴性对照,真实 `buildAuthorizeLeadChannel` + 真实 `CodexLeadOutboundHandler` + `buildLeadOutboundExpressHandler`,断言 HTTP 状态与 body)**:
- Lead **未声明** roundtable,POST 到圆桌 → `403 {status:"rejected", reason:"lead_channel_unauthorized"}`。
- 声明了 A 的 Lead POST 到频道 B → 403。
- 线程父频道不在集合 → 403;lookup `transient` → 403。
- 每条都断言 dedup store 无写入、`send` 未被调用。
- 正向对照:声明了圆桌的 Lead POST 到圆桌 → 200 sent(证明 403 不是因为别的原因)。

### C3 probe 分支 + 审计日志

`OutboundSendBody.probe?: unknown`;`validateBody(body)` 返回联合:`{ ok, probe: true, value: {projectName, leadId, channelId} } | { ok, probe: false, value: {…全字段} }`。`handle()`:probe 走完 1–3 步后 `return { httpStatus: 200, status: "authorized" }`。`OutboundSendStatus` 加 `"authorized"`。

express 包装:`buildLeadOutboundExpressHandler(handler, logger?: { info(msg) })`,响应后
```
[lead-outbound] project=<p> lead=<l> channel=<c> probe=<0|1> status=<s> reason=<r|-> messageId=<m|-> idempotencyKey=<k|->
```
校验失败(400)时 project/lead 可能缺失,打 `-`。**永不打印 text**。

测试(`CodexLeadOutboundHandler.test.ts`):probe 授权通过 → 200 authorized,store 无写、send 未调;probe 未授权 → 403;probe 无 token → 401;probe 缺 text 也 200;非 probe 缺 text 仍 400。`codexLeadBridgeWiring.test.ts`:日志行含 status 与 key、不含 text。

### C4 sender 探测 + 启动 preflight

`CodexOutboundSender`:
- 构造参数加 `leadId: string`(两处调用点都有 `config.leadId`)与 `probeTimeoutMs = 5_000`。
- 默认 transport `defaultPost` 改为接受可选 `signal`;`probeAuthorization` 用 `AbortSignal.timeout(probeTimeoutMs)`,超时/中止按 transport error 处理。真实发送 `deliver` **不改**超时语义(范围外)。
- `probeAuthorization(channelId)`:POST 同 route,body `{projectName, leadId, channelId, probe: true}`,**不写 outbox**。四态映射(Codex R1 HIGH-1):

| Bridge 响应 | 结果 | 含义 |
|---|---|---|
| 200 且 body `status === "authorized"` | `authorized` | 新 Bridge 授权通过 |
| 403 | `unauthorized` | 确定性:频道未声明 |
| 400 / 401 / 404 / 其他非重试 4xx / 200 但 body 不是 `authorized` | `incompatible` | 确定性:旧 Bridge(400 `text_required`)、错 token(401)、route 缺失(404)、响应形状不对 |
| 408 / 429 / 5xx / transport error / timeout | `unavailable` | 瞬时,可重试 |

`outbound-preflight.ts`:
```ts
export type ProbeResult =
  | { state: "authorized" }
  | { state: "unauthorized"; status: 403; reason?: string }
  | { state: "incompatible"; status?: number; reason: string }   // 400 text_required / 401 / 404 / bad-200-body
  | { state: "unavailable"; status?: number; reason: string };   // 408 / 429 / 5xx / transport / timeout
export async function runOutboundPreflight(opts: {
  probe: (channelId: string) => Promise<ProbeResult>;
  channelIds: string[]; attempts?: number /*4*/; delayMs?: number /*10_000*/;
  sleep?: (ms: number) => Promise<void>; log: { info(m: string): void; warn(m: string): void };
}): Promise<"authorized" | "skipped">
```
- 每一轮 attempt 对**去重后的频道集合并发**探测(`Promise.all`),等该轮全部结果回来再判定(Codex R2 HIGH-1)。
- 该轮任一 `unauthorized` → `throw new Error("codex-lead-runtime: Bridge refused outbound to channel <id> (403 lead_channel_unauthorized). Declare it as roundtableChannel for this Lead in projects.json, or remove it from FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS. Outbound mode stays bridge; no fallback to direct.")`。
- 该轮任一 `incompatible` → `throw new Error("codex-lead-runtime: Bridge outbound probe incompatible for channel <id> (HTTP <status> <reason>) — Bridge is older than FLY-2442, the API token is wrong, or the route is missing. Outbound mode stays bridge; no fallback to direct.")`,`<status>/<reason>` 来自 `ProbeResult`(Codex R2 MED-3)。确定性失败优先于同轮的 `unavailable`。
- 该轮只剩 `unavailable` → 重试至 `attempts`,耗尽 → `warn` + 返回 `"skipped"`。
- **总预算**:每轮 ≤ probeTimeoutMs(并发,与频道数无关);最坏 = attempts × probeTimeoutMs + (attempts−1) × delayMs = 4×5 s + 3×10 s = **50 s**,runbook 保守写 ≤60 s。
- 全部 authorized → `info("lead-outbound preflight: authorized <ids>")`。
- **R3 保证**:preflight 不接触 sender 选择;sender 在它之前按 `config.outboundMode` 已构造完毕,函数签名里没有任何「换 sender」的通道;两种确定性失败都是 throw。

**插入点 = `CodexLeadRuntime` 的 `startProcess` 步骤,进程先起、探测在后**(Codex R1 HIGH-2 + R3 HIGH-1 方案 c):
- headless `codex-lead-runtime.ts:1632` `startProcess: async () => { if (broker) await broker.listen(); await proc.start(); if (bridge) { try { await runOutboundPreflight(...) } catch (e) { await proc.stop(); throw e } } }`。
- TUI `codex-lead-tui-runtime.ts:601` `startProcess: async () => { await p.start(); if (bridge) { try { await runOutboundPreflight(...) } catch (e) { await p.stop(); throw e } } }`。
- 为什么是「先 `p.start()` 再探测、失败自己 `p.stop()`」:TUI generation 在 `start()` 开头就 `connectDaemonWs()` 并建好 `WsTransport`/`CodexLeadProcess`(`:539-541`),但 `CodexLeadProcess` 只有进入 `start()` 才 `spawnChild()` 并接管 `this.child`(`CodexLeadProcess.ts:276-280`);`stop()` 在 `child` 为空时直接返回(`:296-300`)。若探测先于 `p.start()` 失败,`p.stop()` 关不掉那条已打开的 WS。而 `CodexLeadRuntime.start` 只在 `startProcess` **整体成功后**才置 `processUp=true`(`CodexLeadRuntime.ts:71-72`),所以它的 catch 不会替 `startProcess` 内部的失败收拾进程——清理必须由 `startProcess` 自己做:`p.stop()` → `child.endStdin()`/`kill` → `WsTransport.close()/terminate()`(`WsTransport.ts:83-90`),WS 真的关闭。之后 generation `stop()` 再调 `runtime.stop()` → `shutdownProcess()` 是幂等 no-op(`closed=true` 早退),并 `sender.close()`。探测仍在 `ensureThread`/`wire`/`startGateway` 之前:不开 gateway、不碰线程。这样 headless(没有 generation 层)与 TUI 走同一条自清理路径。
- 代价:探测前多一次 daemon `initialize` 握手(既有开销,毫秒级)。

**TUI 下确定性失败的两种形态(Codex R2 HIGH-2,按 supervisor 语义分开写)**:
- **初启**:`startProcess` 内 preflight 抛错 → 自己 `p.stop()`(WS 已关)→ `CodexLeadRuntime.start` catch(`processUp=false`,不重复 shutdown)rethrow → generation `start()` reject → `DaemonConnectionSupervisor.start()` 只传播错误、**不**自动 stop 当前 generation(`DaemonConnectionSupervisor.ts:95-108`)→ `main()` catch:`supervisor.stop()`(停掉当前 generation → `runtime.stop()` 幂等 + `sender.close()`)+ `killTuiWindow` + rethrow(`codex-lead-tui-runtime.ts:1093-1107`)→ `process.exit(1)`(`:1112-1117`)→ launchd KeepAlive 按其节流重拉。这就是翻默认后最可能走到的路径:进程退出 1、日志一行明示原因、**没有 direct 回落**。
- headless 初启失败:`await runtime.start()`(`codex-lead-runtime.ts:1997`)无 catch → 进程退出;child 已由 `startProcess` 自己的 `proc.stop()` 关闭,outbox SQLite 句柄随进程退出回收(headless 没有 generation 层的 `sender.close()`,如实写明,不在本单补)。
- **已启动后 WS 丢失的 rebuild**:`onLoss()` 循环里 bring-up 失败 → `half.stop()` → 退避重试并逐次打 `rebuild attempt failed`(`:215-257`);进程活着但 gateway 不开。
- headless 形态:throw 直接出 `main()` → 退出。

**测试缝(不允许降级跳过)**:把 `buildTuiGeneration(config, logger)` 改为 `export function buildTuiGeneration(config, logger, deps: TuiGenerationDeps = {})`,`deps = { connectDaemon?: typeof connectDaemonWs; createSender?: (cfg) => OutboundSender; preflight?: typeof runOutboundPreflight }`,缺省为生产实现(纯注入,不改行为)。`codex-lead-tui-runtime.test.ts` 用**假 WS(记录 `close`/`terminate` 次数)**、假 sender、假 preflight;断言的是 socket 结果,不是 `p.stop` 调用次数(Codex R3 HIGH-1):
- 初启 + preflight 抛 unauthorized:`gen.start()` reject;`p.start` 1 次(进程先起)、`gateway.start` 0 次、`ensureThread` 未调;**此刻假 WS 的 `close`+`terminate` 合计 ≥1**(由 `startProcess` 自己的 `p.stop()` 关闭);随后 `gen.stop()` → `sender.close` 1 次,WS 不再重复关闭(幂等)。
- 同一夹具走 `DaemonConnectionSupervisor`,复现 `main()` 顺序:先断言 `supervisor.start()` reject;再 `await supervisor.stop()`;之后断言假 WS 关闭 ≥1、`sender.close` 恰 1 次、`gateway.start` 0 次。rebuild 形态复用 `DaemonConnectionSupervisor.test.ts` 的 half-stop 覆盖,不加新状态机。

runtime:`parseCodexLeadRuntimeConfig` 删除 `:619-633` 的 throw,加 `outboundProbeChannelIds`。

测试:
- `outbound-preflight.test.ts`:authorized;unauthorized → throw 且文案含频道 id 与「no fallback to direct」;incompatible → throw 且文案含 `HTTP 400 text_required`;同轮 incompatible 优先于 unavailable;unavailable×N → skipped 且 `sleep` 被调 N-1 次;**两个频道都耗尽 deadline 的假时钟测试**:总 elapsed ≤ 4×5 s + 3×10 s,且各轮 probe 并发(两次 probe 的起始时间相同)。
- `CodexOutboundSender.test.ts`:四态映射逐条(200+authorized / 200+其他 body / 400 / 401 / 403 / 404 / 429 / 503 / 抛错),并断言 `status`/`reason` 被传出;body 含 `probe:true`;outbox 表零行;**deadline**:注入永不 resolve 的 post 且 signal 被 abort → `unavailable`,耗时 ≤ probeTimeoutMs(用假 timer)。
- `CodexLeadRuntime.test.ts` 已有 start 顺序测试(`:24-62`);新增「`startProcess` 抛错 → `ensureThread/wire/startGateway` 未调、`shutdownProcess` 未调(`processUp=false`)」,用来钉住「`startProcess` 内部失败必须自清理」这个前提。
- 两份 runtime 的 `startProcess` 自清理各一条单测:preflight 抛错 → `p.stop()` 恰 1 次且错误原样 rethrow(headless 在 `codex-lead-runtime.test.ts`,TUI 在 `codex-lead-tui-runtime.test.ts` 经 `buildTuiGeneration` deps)。
- `codex-lead-tui-runtime.test.ts`:上面的两条生命周期用例(必做)。
- `codex-lead-runtime.test.ts:230-242` 改写为「bridge+cross-dept 解析通过且 `outboundProbeChannelIds = [chat, round-1]`」,并保留「direct 模式 `outboundProbeChannelIds = []`」。

### C5 launcher

见 research §4 的片段。测试 `run-codex-lead-mufasa-tui-fullaccess.test.sh`(现有 18 条断言全部保留):
- 顶部 scrub(`:29-40`)加 `TEAMLEAD_API_TOKEN FLYWHEEL_API_TOKEN FLYWHEEL_BRIDGE_URL`,让用例不受开发机 env 污染(Codex R1 MED-4)。
- `run_dry` 前缀加 `FLYWHEEL_BRIDGE_URL=http://127.0.0.1:1 TEAMLEAD_API_TOKEN=DRY`;断言 `OUTBOUND=bridge`、`FLYWHEEL_API_TOKEN=DRY`(别名生效)。
- 现有 real-run 用例(`:138-153`,不经 `run_dry`)显式加同样两项 env,否则默认 bridge 会在 link-truth 之前退出。
- 新增:`FLYWHEEL_CODEX_LEAD_OUTBOUND=direct` 仍到 exec 且 stderr 含 `WARNING: outbound=DIRECT`;bridge 且两个 token 名都 `env -u` → 非零且 stderr 含 `requires`;`OUTBOUND=weird` → 非零。
- 头注释 `:10` 同步为 `outbound=bridge (direct = rollback only)`。

### C6 文档

合同页 `mailbox-adapter-contract.md` 已提交在本分支。founder HTML(`founder-design.html` + `diagrams/*.mmd/*.svg`)由本设计节点在评审 APPROVED **之后**产出、提交、`publish-report` 发布并向 Lead 报 URL——这是设计节点完成合同的一部分,不是 implement 节点的活。implement 节点在 PR body 链接二者。里程碑账本 `engineering/doc/milestones/FLY-2442.md` 按 README 格式在 ship 时新建(implement 节点)。

## 4. 稳定身份与显示标签

| 项 | 值 |
|---|---|
| 新配置键 | `leads[].roundtableChannel`(projects.json) |
| 新 body 字段 / 状态 | `probe: true` / `status: "authorized"` |
| 日志前缀 | `[lead-outbound]`(Bridge);`lead-outbound preflight:`(runtime) |
| env(不新增) | `FLYWHEEL_CODEX_LEAD_OUTBOUND ∈ {bridge, direct}`;`FLYWHEEL_API_TOKEN` 由 `TEAMLEAD_API_TOKEN` 别名 |
| 证据文件 | `/tmp/flywheel-bridge.log`、`/tmp/flywheel-lead-growth-mufasa-lead.log`、`~/.flywheel/codex-lead-outbound-dedup.db`、`~/.flywheel/state/codex-lead/mufasa-lead/outbox.db` |

## 5. 负向守卫(必须有测试)

| 守卫 | 测试位置 |
|---|---|
| 未声明频道 → 403(R2) | `codexLeadBridgeWiring.test.ts` |
| 线程父频道不在集合 → 403 | 同上 |
| 父频道查询失败 → 403 且不缓存 | 同上 |
| probe 不写去重库、不发送 | `CodexLeadOutboundHandler.test.ts` |
| 非 probe 请求校验不放松 | 同上 |
| preflight 403 → throw,错误文案含「no fallback to direct」(R3) | `outbound-preflight.test.ts` |
| preflight 400/401/404/坏 200 body → throw(旧 Bridge / 错 token / 缺 route 不得被当成瞬时) | `CodexOutboundSender.test.ts` + `outbound-preflight.test.ts` |
| preflight 不可达 → 有界重试后继续;单次 probe 有 deadline | 同上 |
| preflight 失败 → gateway 不开、process/sender 被关 | `CodexLeadRuntime.test.ts` / `codex-lead-tui-runtime.test.ts` |
| launcher:bridge 缺 token → exit 1;非法值 → exit 1 | `run-codex-lead-mufasa-tui-fullaccess.test.sh` |
| 审计日志不含 text | `codexLeadBridgeWiring.test.ts` |

## 6. 验收证据(QA 节点读这里)

前提:Bridge 已带 C1–C3 且 projects.json 已声明;Mufasa 已在 bridge 模式重启(§7)。

证据必须按**同一个 idempotencyKey `<K>`** 关联(Codex R1 MED-6),不能各取「最新一行」:

1. `grep 'outbound=' /tmp/flywheel-lead-growth-mufasa-lead.log | tail -1` → `outbound=bridge`;`grep 'lead-outbound preflight' … | tail -1` → `authorized 1500600400238084307,1512578695468941333`。
2. 在 #mufasa 发一句带唯一标记的话(如 `qa-2442-<ts>`),等回复。取 Bridge 日志里**这条回复**的行:`grep '\[lead-outbound\]' /tmp/flywheel-bridge.log | grep 'lead=mufasa-lead' | grep 'status=sent' | tail -1`,记下 `channel=<C> messageId=<M> idempotencyKey=<K>`。
3. `sqlite3 ~/.flywheel/codex-lead-outbound-dedup.db "select status,message_id from outbound_dedup where idempotency_key='<K>'"` → `sent|<M>`。
4. `sqlite3 ~/.flywheel/state/codex-lead/mufasa-lead/outbox.db "select status,channel_id from outbox where idempotency_key='<K>'"` → `sent|<C>`。
5. Discord REST `GET /channels/<C>/messages/<M>` → 200 且 content 含 Mufasa 对该标记的回复(证明 `<M>` 在 `<C>`)。
6. 圆桌对照:在 #leads-roundtable @Mufasa 一句带标记 → 重复 2–5,`<C>` 为圆桌或其线程 id;Bridge 日志里该 `<K>` 之前不应出现 `status=rejected`。
7. 阴性(QA 隔离房或直接对 Bridge):对一个未声明频道 POST `probe:true` → 403 `lead_channel_unauthorized`;对 probe 缺 text 的旧式 400 不应出现(证明 probe 分支已部署)。
8. 把 `<K>/<M>/<C>` 三元组写进 QA 报告。

## 7. 部署顺序(rollout runbook;implement/QA 节点不执行 2–4 的重启)

0. **合并前(merge gate)**:Lead/founder 在 `~/.flywheel/projects.json` 为 mufasa-lead 加 `roundtableChannel`(今天的 Bridge 容忍未知键,零影响)。可执行的只读检查,通过才允许合并:
   ```bash
   jq -e '.[] | select(.projectName=="growth") | .leads[] | select(.agentId=="mufasa-lead") | .roundtableChannel == "1512578695468941333"' ~/.flywheel/projects.json
   ```
   (截至 2026-09-08 该字段尚不存在,此检查当前为 false。)
1. PR 合入 main。
2. updater 窗口 `restart-services.sh`:`packages/teamlead/*` → Bridge 重启,读到 C1–C3 与步骤 0 的声明。launcher 改动**不**触发 Lead 重启(`classify_changes :1944-1956`)。
3. Mufasa 继续 direct 直到下一次重启。
4. founder/Lead 窗口重启 `com.flywheel.lead.growth-mufasa-lead` → 读新 launcher → bridge → preflight authorized。
5. 跑 §6。

异常:
- 若 4 早于 2(旧 Bridge 仍在跑)→ 旧 handler 先做完整 body 校验,probe 请求得到 **400 `text_required`** → `incompatible` → throw(不是 403)。Mufasa 不服务 Discord、日志明示「Bridge is older than FLY-2442」。处理:等 2 完成再重启。
- 整机重启:Bridge 未起 → probe transport error → `unavailable` → 最多 50 s(保守 ≤60 s)重试后继续,不炸;之后真实发送若仍失败按 journal ambiguous 处理(既有行为)。
- 初启确定性失败(400/401/403/404)在 TUI 下 = 进程退出 1 + launchd 重拉;这是有意的 fail-loud,不是崩溃循环 bug——修复动作是补 projects.json 声明或等 Bridge 更新,不是把 launcher 改回 direct。

## 8. 回滚边界

| 回滚 | 动作 | 注意 |
|---|---|---|
| 仅出站 | `~/.flywheel/.env` 加 `FLYWHEEL_CODEX_LEAD_OUTBOUND=direct` → 重启 Mufasa | banner 打 WARNING;记忆线程不受影响;`outbox.db` 的 pending 行按 journal recovery 处理(与今天一致) |
| Bridge 授权扩展 | revert C1–C3 | **必须先**把 Mufasa 切回 direct,否则其下次重启 preflight 400/403 不启动、在跑的圆桌回复 403 → ambiguous |
| 全部 PR | 同一顺序:① `.env` 设 `FLYWHEEL_CODEX_LEAD_OUTBOUND=direct`,重启 Mufasa,确认 banner `outbound=direct`;② 再 revert PR 让 updater 重启 Bridge;③ 之后可移除 `.env` override(旧 launcher 默认就是 direct) | 反过来做(先 revert Bridge)会让在跑的 bridge 模式 Mufasa 圆桌回复 403 → ambiguous,直到下一次人工重启(Codex R1 MED-5);launcher 改动不触发 Lead 自动重启 |

## 9. 风险与未验证

- Mufasa 的 token 对圆桌线程 `GET /channels/{id}` 的权限:理论有(它在里面发言),QA 用 REST 实测一次。
- preflight 最坏延迟 Mufasa 启动 50 s(4 轮并发探测 × 5 s + 3 × 10 s;Bridge 重启空窗)。
- projects.json 与 launcher env 各自声明圆桌(两处);漂移的检测手段 = preflight 403 fail-loud。合一为单一来源是「以后」(exploration §4 方案 C)。
- `enforce_nonce` 未转发到 Discord(既有,`leadDiscordSend.ts:12-15`),不动。

## 10. 范围外(honest boundary)

- `codex-infra-bot-lead` launcher(Claw 席位,cross-dept = Alerts)保持 direct。
- `lead_actions.discord_send` 主动发言保持直发(FLY-350)。
- Claude 侧 reply-guard / fail-open(②)、Raya(④)。
- Epic FLY-2441 的链接由 Lead 补(本机 Linear 401)。
- Mufasa 实际重启由 Lead/founder 窗口执行。
