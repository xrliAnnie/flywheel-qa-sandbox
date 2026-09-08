# FLY-2442 Codex Lead 出站改走 Bridge + mailbox→适配器合同 — 调研
Issue: FLY-2442 (https://linear.app/geoforge3d/issue/FLY-2442/通路codex-codex-lead-出站改走-bridgelauncher-配置-mailbox-harness)
日期: 2026-09-08
基于: exploration.md

## 1. 调研目标

exploration.md §4 选了方案 B。本文回答四个实现问题:
1. Bridge 授权集怎么扩到 roundtable 与线程,复用什么、新写什么。
2. runtime 的硬门怎么改成「向 Bridge 探测」,探测走哪条 route。
3. launcher 翻默认需要哪些 env 别名,现有 launcher 测试要改哪几行。
4. 验收证据从哪三个地方读;部署顺序与回滚边界。

## 2. Bridge 授权集扩展

### 2.1 现状接口(不变)

```ts
// codexLeadBridgeWiring.ts:49-66
buildAuthorizeLeadChannel(projects): (projectName, leadId, channelId) => boolean
// CodexLeadOutboundHandler.ts:84-93  authorizeLeadChannel?: (projectName, leadId, channelId) => boolean
```

`handle()` 在第 3 步同步调用它(`:139-153`)。线程父频道要查 Discord,是异步的 → 授权函数签名要改成可返回 `Promise<boolean>`(handler `await` 它;同步实现照样能用)。这是唯一的接口签名变化,handler 的两处调用方(plugin.ts 挂载、单测)都在本仓。

### 2.2 授权集的三层来源

| 层 | 来源 | 为什么是它 |
|---|---|---|
| L1 自有频道 | `projects.json`:`lead.chatChannel` + `project.generalChannel`(今天已有) | 不变 |
| L2 共享频道 | `projects.json` 新增 **per-Lead** `leads[].roundtableChannel`(Mufasa 声明 `1512578695468941333`) | Lead 裁定:只认该 Lead 已声明的那一个圆桌频道,不通配、不从 Bridge 全局 env 推断。字段是可选字符串,`loadProjects` 对 lead 未知键本就容忍(`ProjectConfig.ts:922` 注释「unknown keys stay tolerated」),所以可以在代码合入**之前**先写进生产 projects.json;`compileLeadIdentityRegistry` 的 lead 行是 `Record<string, unknown>`(`flywheel-comm/lead-identity.ts:74`),Bridge 也不校验 `projectsDigest`(teamlead 源码零引用),改 projects.json 不会让在跑的 Lead 失效 |
| L3 线程 | `channelId` 的 `parent_id ∈ L1 ∪ L2` | roundtable 话题线程、chat 频道内的 issue 线程都能覆盖 |

**被否决的来源**:Bridge 自己的 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID`(`roundtable-config.ts:76`)——它是全局值,等于「所有 Lead 都可发圆桌」,Lead 明确不许通配。L2 校验放在 `ProjectConfig.ts:575-590` 那个可选字段循环里(非空字符串),与 `alertChannel` 同款。

### 2.2b 两处声明与漂移检测

launcher 仍用 env `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` 决定 Lead **轮询**哪些频道;projects.json 的 `roundtableChannel` 决定 Bridge **放行**哪些回复。两处不一致时:Lead 轮询了 Bridge 不放行的频道 → 启动 preflight 403 → fail-loud(§3);Bridge 放行了 Lead 不轮询的频道 → 无害。合一为单一来源(让 launcher 从 registry 派生 env)要动 `lead-identity resolve` 的输出,即 `packages/flywheel-comm/*` → 触发全体 Lead 重启且触及 Claude 侧消费者,不在本单(exploration §4 方案 C)。

### 2.3 线程父频道解析:复用 `thread-validator.ts` 的形状

`classifyThreadExistence(threadId, expectedParentId, botToken)`(`bridge/thread-validator.ts:56-85`)已经做了 `GET /channels/{id}`、`type ∈ {10,11,12}`、`parent_id` 比对、超时 5s、`fetchImpl` 可注入。授权需要的是「给我 parent_id」而不是「等于某个父」,所以新增一个小函数(同文件或新文件 `discord-channel-parent.ts`):

```ts
export type ChannelParentLookup =
  | { state: "resolved"; parentId: string }
  | { state: "not_thread" }
  | { state: "absent" }
  | { state: "transient" }
  | { state: "denied" };
export async function lookupThreadParent(channelId, botToken, deps?): Promise<ChannelParentLookup>
```

授权函数的组合:

```
allowed(project, lead, channelId):
  if channelId ∈ L1(project,lead) ∪ L2 → true            // 零网络,今天的快路径
  token = resolveBotToken(project, lead); if !token → false
  r = cache.get(channelId) ?? await lookupThreadParent(channelId, token)
  if r.state === "resolved": cache.set(channelId, r);  return r.parentId ∈ L1 ∪ L2
  else → false                                            // fail-closed;transient 不缓存
```

- 缓存:进程内 `Map<channelId, parentId>`,只缓存 `resolved`(线程的父频道不会变);不缓存否定结果。
- 用该 Lead 自己的 token 查(`buildResolveBotToken`),与发送用的是同一把,权限一致。
- 失败一律 403 `lead_channel_unauthorized`;再加一个 `reason` 细分 `channel_parent_unresolved`(仅日志/响应,不改状态机)。router 侧本来就把非 2xx 记 ambiguous(`CodexOutboundSender.ts:200-203` throw → `LeadInputRouter.ts:313-320`),和今天 direct 模式 Discord 5xx 的处理一致。

### 2.4 handler 的 `probe` 分支

`OutboundSendBody` 加可选 `probe?: boolean`。`validateBody` 在 `probe === true` 时只要求 `projectName/leadId/channelId`(不要求 `text/idempotencyKey/nonce`),handler 走完第 1–3 步后返回 `{ httpStatus: 200, status: "authorized" }`,**不碰去重库、不发送**。`OutboundSendStatus` 加 `"authorized"`。选择复用同一 route 的理由:同一 `tokenAuthMiddleware`、同一授权函数,探测结果和真实发送**必然一致**;不新增 route 也不新增 express 挂载。

### 2.5 审计日志

`buildLeadOutboundExpressHandler(handler, logger?)`:每次响应打一行

```
[lead-outbound] project=<p> lead=<l> channel=<c> status=<sent|deduped|ambiguous|rejected|authorized> reason=<r|-> messageId=<id|-> idempotencyKey=<k|-> probe=<0|1>
```

只含标识符,**永不含 text**。plugin.ts 传 `console`(与 `:7652` `[Bridge]` 前缀日志同风格)。Bridge stdout → `/tmp/flywheel-bridge.log`(plist StandardOutPath),这就是验收「日志可证」的读取点。

## 3. runtime 硬门 → 启动探测

### 3.1 改动点

- `codex-lead-runtime.ts:619-633`:删除 throw,改为在 config 上记录 `outboundProbeChannelIds = [chatChannelId, ...crossDeptChannelIds]`(bridge 模式才有意义)。
- `CodexOutboundSender` 新增 `probeAuthorization(channelId): Promise<ProbeResult>`(`ProbeResult = {state: "authorized"} | {state: "unauthorized", status: 403} | {state: "incompatible", status?, reason} | {state: "unavailable", status?, reason}`):POST 同一 route,body `{projectName, leadId, channelId, probe: true}`,单次请求带 `AbortSignal.timeout(5 s)`;200 且 body `status==="authorized"` → authorized;403 → unauthorized;400/401/404/其他非重试 4xx/坏 200 body → incompatible(旧 Bridge、错 token、缺 route 都是**确定性**失败,Codex R1 HIGH-1);408/429/5xx/网络错误/超时 → unavailable。复用注入的 `HttpPost`,单测无需真网络。
- 新增纯函数 `runOutboundPreflight({ probe, channelIds, attempts, delayMs, sleep, log })`(独立小模块,便于测):
  - 任一频道 `unauthorized` 或 `incompatible` → **throw**(措辞:哪个频道、原因、如何处理、「no fallback to direct」)。
  - `unavailable` → 重试(每轮对全部频道**并发**探测,默认 4 轮:4 × 5 s 超时 + 3 × 10 s 间隔 = 最坏 50 s,与频道数无关);耗尽后 `warn` 并返回 `"skipped"`,**不 throw**。
  - 插入点是 `CodexLeadRuntime` 的 `startProcess` 步骤内部、**在 `p.start()` 之后**(两份 runtime 各一处):`CodexLeadProcess` 只有 `start()` 后才接管 transport,`stop()` 在此之前是 no-op(`CodexLeadProcess.ts:276-300`),所以探测必须在进程起来之后;且 `CodexLeadRuntime.start` 只在 `startProcess` 整体成功后才置 `processUp`,它的 catch 不会替 `startProcess` 内部失败收拾进程,因此 `startProcess` 自己 `try/catch → p.stop() → rethrow`(Codex R1 HIGH-2 + R3 HIGH-1)。
  - 全部 `authorized` → `info` 一行。
- **绝不回落 direct**(Lead 红线 R3):sender 在 preflight 之前已按 `config.outboundMode` 构造,preflight 的返回值只有 `"authorized" | "skipped"`,没有任何「换 sender」的通道;403 的错误文案明写 *Outbound mode stays bridge; no fallback to direct*。
- 调用点:headless `codex-lead-runtime.ts:1632` 与 TUI `codex-lead-tui-runtime.ts:601` 的 `startProcess`。direct 模式跳过。

### 3.2 为什么 unavailable 不 throw

Mufasa 由 launchd KeepAlive 拉起;Bridge 在 updater 窗口会停 → 启 (`restart-services.sh:2883-2889`)。如果 Mufasa 恰在这个空窗重启且探测 throw,就是 FLY-1597 那种 205 次崩溃循环的形状。真实发送失败本来就有落点:journal `ambiguous` + `processEntry failed → ambiguous` error 日志(`LeadInputRouter.ts:313-320`)。探测的目的是把**确定性的配置错误**(403)提前到启动期,而不是把瞬时不可达也变成致命。

### 3.3 测试要改的地方

- `codex-lead-runtime.test.ts:230-242`「REFUSES bridge outbound mode + cross-dept」→ 改为「bridge + cross-dept **不再**在解析期 throw,`outboundProbeChannelIds` 包含 chat + cross-dept」。
- 新增 `runOutboundPreflight` 单测:authorized / unauthorized-throw / incompatible-throw(文案含 HTTP status+reason)/ unavailable-retry-then-skip / 多频道并发且总时长 ≤ 4×5 s + 3×10 s,注入 sleep 与假时钟。
- `CodexOutboundSender.test.ts`:`probeAuthorization` 四态(`{state, status?, reason?}`)逐条,断言 body 含 `probe: true`、不写 outbox 行、永不 resolve 的 post 被 5 s deadline 中止为 unavailable。
- `codex-lead-tui-runtime.test.ts`:通过导出的 `buildTuiGeneration(config, logger, deps)` 注入假 WS(记录 close/terminate)/ 假 sender / 假 preflight,断言初启 preflight 失败时 `p.start` 1 次(进程先起)、`gateway.start` 0 次、`gen.start()` reject 当场假 WS 已 close/terminate ≥1(由 `startProcess` 自己的 `p.stop()`),随后 `gen.stop()` 后 `sender.close` 恰 1 次;并复现 `main()` 顺序经 `DaemonConnectionSupervisor.start()` reject → `supervisor.stop()` 复证同样计数。
- `CodexLeadOutboundHandler.test.ts`:probe 分支不写 dedup、不调 send;probe 缺 text 也 200;非 probe 缺 text 仍 400。
- `codexLeadBridgeWiring.test.ts`:roundtable 频道进授权集;线程按 parent 授权(注入 lookup);transient → 拒绝且不缓存;resolved 缓存后不再查;无 token → 拒绝。

## 4. launcher 改动

`run-codex-lead-mufasa-tui-fullaccess.sh:101-104` 替换为:

```bash
# Outbound: BRIDGE (FLY-2442) — replies go through POST /api/lead-outbound/send
# (Bridge authorizes chat + core + roundtable(+threads), resolves the token server-
# side, dedups durably). DIRECT is the documented ROLLBACK only.
export FLYWHEEL_CODEX_LEAD_OUTBOUND="${FLYWHEEL_CODEX_LEAD_OUTBOUND:-bridge}"
case "$FLYWHEEL_CODEX_LEAD_OUTBOUND" in
  bridge)
    export FLYWHEEL_API_TOKEN="${FLYWHEEL_API_TOKEN:-${TEAMLEAD_API_TOKEN:-}}"
    [ -n "${FLYWHEEL_BRIDGE_URL:-}" ] && [ -n "${FLYWHEEL_API_TOKEN}" ] || { echo "... outbound=bridge requires FLYWHEEL_BRIDGE_URL and TEAMLEAD_API_TOKEN (or FLYWHEEL_API_TOKEN)" >&2; exit 1; } ;;
  direct)
    echo "[run-codex-lead-mufasa-tui-fullaccess] WARNING: outbound=DIRECT (rollback mode) — bypasses Bridge outbound authorization" >&2 ;;
  *) echo "... invalid FLYWHEEL_CODEX_LEAD_OUTBOUND='$FLYWHEEL_CODEX_LEAD_OUTBOUND' — must be bridge|direct" >&2; exit 1 ;;
esac
```

要点:
- 别名方向 `TEAMLEAD_API_TOKEN → FLYWHEEL_API_TOKEN`,与 Bridge 读的 `config.ts:57` 同一把 token;`.env` 不用新增键。
- dry-run 也走这段(测试用 `FLYWHEEL_LEAD_DRY_RUN=1` 捕获 env),所以测试里需要提供 `FLYWHEEL_BRIDGE_URL` + `TEAMLEAD_API_TOKEN`。
- 启动 banner `:139` 已打印 `outbound=…`,不用改。

`__tests__/run-codex-lead-mufasa-tui-fullaccess.test.sh`:
- `:10` 与 `:98` 的 `outbound=direct` 断言改为 `bridge`,并断言 `FLYWHEEL_API_TOKEN` 从 `TEAMLEAD_API_TOKEN` 别名而来。
- 新增三条:显式 `direct` 仍可启动(回滚);bridge 缺 token → 非零退出;非法值 → 非零退出。
- `run_dry` 的 env 前缀加 `FLYWHEEL_BRIDGE_URL=http://127.0.0.1:1 TEAMLEAD_API_TOKEN=DRY`。

`run-codex-infra-bot-tui.sh:89-92` **不改**(exploration §5)。

## 5. 验收证据(三处,互相印证)

| 证据 | 位置 | 期望 |
|---|---|---|
| Mufasa 进程日志 | `/tmp/flywheel-lead-growth-mufasa-lead.log` | banner `outbound=bridge`;runtime `outbound mode: bridge`;preflight 一行 `authorized: <chat>,<roundtable>` |
| Bridge 日志 | `/tmp/flywheel-bridge.log` | `[lead-outbound] project=growth lead=mufasa-lead channel=… status=sent messageId=…` |
| 持久去重库 | `~/.flywheel/codex-lead-outbound-dedup.db` 表 `outbound_dedup` | 从 0 行变为 ≥1 行,`idempotency_key` 形如 `<journal-id>:out`,`status='sent'`,`message_id` = Discord 消息 id |
| Mufasa outbox | `~/.flywheel/state/codex-lead/mufasa-lead/outbox.db` 表 `outbox` | 同 key 的行 `status='sent'` |

Discord 侧核对:用 REST 按 `message_id` 查该消息存在于目标频道(memory:证明投递去了哪个频道用 REST 查 id,别信日志字段)。

「direct 路径不再被 launcher 打开」:`grep -n 'OUTBOUND' run-codex-lead-mufasa-tui-fullaccess.sh` 默认值为 `bridge`;dry-run env dump 里 `FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge`。

## 6. 部署顺序与回滚

### 6.1 顺序(由现有机制自然保证)

1. PR 合入 main → updater 窗口 `restart-services.sh`:`packages/teamlead/*` 变更 → **Bridge 重启**(`classify_changes` `:1953`),带上新授权集与 probe 分支。launcher 改动**不**触发 Lead 重启(`:1944-1950` 只列 claude-lead.sh / post-compact / lead-rules-base / flywheel-comm)。
2. Mufasa 继续以 direct 跑,直到下一次重启。**切换生效 = Lead/founder 窗口重启 `com.flywheel.lead.growth-mufasa-lead`**(implement/QA 节点不自作)。
3. 若顺序反了(Mufasa 先于新 Bridge 重启):旧 handler 先做完整 body 校验,probe 请求得到 **400 `text_required`** → `incompatible` → throw(不是 403)。这是**旧 Bridge 版本 + 新 launcher** 的组合,只会发生在 Bridge 尚未部署新版本时;既然 launcher 和 Bridge 在同一 PR,合入后 Bridge 必然先更新(updater 先于任何 Mufasa 重启读到新 launcher,因为 Mufasa 读的是同一主仓 checkout)。TUI 初启失败 = `supervisor.start()` reject → `main()` 清理 → 进程退出 1 → launchd 重拉;已启动后的 WS 重建失败才是进程内退避循环。整机重启场景:两者都读新代码,Bridge 未起 → probe `unavailable` → 有界重试后继续,不炸。

### 6.2 回滚边界

| 层 | 回滚动作 | 影响 |
|---|---|---|
| 只回滚 Mufasa 出站 | `~/.flywheel/.env` 加 `FLYWHEEL_CODEX_LEAD_OUTBOUND=direct` → 重启 Mufasa job | 立刻回到今天的直发;记忆线程不受影响(state dir 硬钉 `:66`);outbox.db 里 pending 行会由 direct sender 忽略(它不读 outbox.db;journal `output_pending` 行按 recovery 规则处理,与今天 direct 的重启边界一致) |
| 回滚 Bridge 授权扩展 | revert PR 的 Bridge 部分 | Mufasa 若仍在 bridge 模式,下次重启 probe 403 → 不启动(fail-loud),提示改 direct;正在跑的 Mufasa 圆桌回复 403 → ambiguous。所以回滚 Bridge 必须**先**把 Mufasa 切回 direct |
| 回滚整个 PR | revert + updater | Bridge 回旧版;Mufasa 下次重启读旧 launcher(direct) |

## 7. 合同页的落点与形态

- 路径:`engineering/doc/FLY-2442-codex-outbound-bridge/mailbox-adapter-contract.md`(与本折叠同处,随 PR 合入 main)。
- 一页,五段:① ingest ② mailbox ③ 泵 ④ 最后一跳 ⑤ 回程;每段给「接口(TS 签名)/ 不变量 / Claude 实现 / Codex 实现 / 新 harness 要提供什么」。
- 「为什么砍不掉」引原注释四处(exploration §2)。
- Epic FLY-2441 引用:本机 Linear key 与 MCP 均 401,由 Lead 补;合同页顶部写明 Epic 与 ①②④ 的关系。

## 8. 风险与未验证项

- **未验证**:Bridge 用 Mufasa 的 token 对 roundtable 线程做 `GET /channels/{id}` 是否总有权限——Mufasa 自己在这些线程里发言,理论上有;QA 用 REST 实测一次。
- **未验证**:`enforce_nonce` 未转发到 Discord(`leadDiscordSend.ts:12-15` 原注释),Bridge 崩溃空窗的 exactly-once 仍靠 `outbound_dedup`;本单不动。
- 探测时机在 `startProcess` 内、gateway 启动前;若 Bridge 恰好正在重启,最多延迟 Mufasa 启动 50 s(4 轮并发探测 × 5 s 超时 + 3 × 10 s 间隔,与频道数无关)。
- `codex-infra-bot-lead` 若有人把它的 env 也改成 bridge,会因 Alerts 频道不在授权集而在启动期 fail-loud——这是设计的预期行为,不是隐患。
