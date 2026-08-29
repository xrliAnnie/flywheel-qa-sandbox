# FLY-1224 三段式 per-phase vendor — 探索

Issue: FLY-1224 (https://linear.app/geoforge3d/issue/FLY-1224/build-三段式-per-phase-vendor-designfable-implementcodex-gpt-56-solxhigh)
日期: 2026-07-13
基于: 无

## 1. 问题是什么

Annie 直令(2026-07-13):「Design 用 Fable,Implement 用 Codex 5.6,QA 用 Opus —— 调成我们默认的设置。」

三段式 pipeline(FLY-793,Design → Implement → QA,一条共享分支 B)目前**只支持每段换模型,不支持每段换厂商**。代码实证(本次逐文件复核,与 issue 描述一致):

| 位置 | 现状 |
|------|------|
| `packages/config/src/three-stage-phases.ts:86` | `DEFAULT_PHASE_TIER` 只有 Claude `ModelTier`(design=heavy/implement=heavy/qa=medium) |
| `packages/teamlead/src/bridge/phase-orchestrator.ts:1204/1365/1584` | 三个派发点只传 `dispatchModel: resolvePhaseModel(...)`,零 backend 概念 |
| `packages/teamlead/src/bridge/role-adapter-resolver.ts:192-195` | layer 1b 硬编码:带 `dispatchModel` → `backend = "claude-tmux"`(注释原文 "All 728 tiers are Claude models") |

**审计补充(issue 没数到的第 4 个派发位点)**:`runs-route.ts:566-598` 的三段式入口 `resolveThreeStageEntry`(three-stage-policy.ts:166)把 fresh `main` 请求改写成 design phase 时也回传 `dispatchModel: resolvePhaseModel("design")` —— 一共 **4 个位点**要连 vendor 一起传。

**retry 第 5 位点**:`actions.ts:885-889` phase-row retry 无条件从 phase 表重推导 `dispatchModel`(FLY-887 R2)—— backend/effort 必须同样重推导,否则 implement 段 retry 会回落 claude-tmux。

## 2. FLY-1188 已经备好了什么(不需要本票新建)

FLY-1188(Codex Runner 一等公民,已合 #568 并部署)提供了全部厂商侧基建:

1. **CodexTmuxAdapter(resident /goal daemon)** — `codex app-server --remote-control` 驻留 daemon + **founder cmux TUI 窗口**(`codex resume --remote`,raw binary 带 TTY)。FLY-398 windowed 铁律由此满足;验收要的「cmux 有真窗口」已是适配器内建行为。
2. **model 通路已通**:`ctx.model` → `CodexDaemonGoalRuntime` → `thread/start` 的 `model` 参数(codex-daemon-client.ts:348)。
3. **Blueprint isCodexRunner 三段式变体已写齐**(transitional contract,Codex M2 review HIGH-1):codex phase **不 park、END TURN**;QA-fix / re-test 指令写成条件式("if ... arrives as your input")。
4. **cross-family review 不变量**(§7.3,review-family.ts):codex 作者的 PR 必须由**非-codex 家族**(= Claude)review;`crossFamilyReviewSatisfied` 已接入 codex-gate + `verify-approval` 双侧;codex 作者走 `gate review_design|review_code --no-block` + `request-review` + `check` 轮询 lane(Blueprint:1319-1327 design lane 实证)。
5. **CommDB vendor 路由**:codex session 注册 vendor="codex",`flywheel-comm send` / `wakeRunnerMailbox` 按 adapter_type→transport 路由到 codex mailbox(run-dispatcher `preRegistrationVendor` + runner-wake.ts)。
6. **拼写 ground truth**:host `~/.codex/config.toml` 实测 `model = "gpt-5.6-sol"`、`model_reasoning_effort = "xhigh"`(Annie 的 Codex 标准配置);per-runner CODEX_HOME 从它 verbatim seed(codex-home.ts)——所以今天 codex runner 已**隐式**继承这套配置,本票把它变成**表驱动的显式契约**,不再依赖 host config 不漂移。

## 3. 审计发现的两个真缺口(issue 「要做」清单之外,但不修则验收必挂)

### 缺口 A:QA-FAIL fix-wake 对 codex implement 会确定性 stall

链路:codex implement 段按 transitional contract **END TURN**(不 park)→ daemon 终结、进程死,但 StateStore status 停在 `awaiting_review`(∈ `getAlivePhaseSession` 的 ALIVE 集,plugin.ts:6259)→ QA FAIL 时 `runFailFlowKeepAlive`(phase-orchestrator.ts:1289)**只按 status 找到它** → `assertPhaseWorktreeReady` 全过(共享 worktree 还在、clean、HEAD 就是 QA 推的头)→ `wakePhaseRunner` 走 codex mailbox —— **mailbox 写是文件写,必然 ok:true** → `fixExecId` 被落下 → onQaResult 的 resume 条件(`!existing.fixExecId`)被永久短路 → **不可重放的静默 stall**。

这不是理论:implement=codex 时**每次 QA FAIL 都会踩**(codex phase 永远不 park,进程必死)。Claude 路径今天也有同型隐患(parked implement 进程崩了同样假唤醒),只是那是异常态,codex 是常态。

**修法(最小)**:两个 wake 位点(fix-wake :1289 起、handoff wake :1504 起)在 wake 前用 deps 里**已有的** `probePhaseAlive` 探真进程:`alive` → 照旧 wake(claude 行为字节不变);`dead_pin`/`absent` → 走**既有 spawn-fallback**(fresh Implement-fix 派发,天然带上本票的 codex backend);`indeterminate` → 保持现状路径(fail-closed 交 reconcile)。

### 缺口 B:effort 没有 codex 通路

FLY-671 的 `effort` 是 claude-only(`adapter-types.ts:150` 注释原文 "Only the claude-tmux runner consumes it")。implement 段要 xhigh,需给 codex daemon spawn 加 `-c model_reasoning_effort=<effort>` argv —— 与既有 sandbox overrides(`buildDaemonSandboxArgs`,codex-daemon-runtime.ts:94)完全同机制,纯函数可单测。

## 4. 方案

### 方案 1(推荐):phase 表扩成 per-phase dispatch spec,dispatch 参数三件套下传,resolver 1b 收显式 vendor

- `three-stage-phases.ts`:新增 `DEFAULT_PHASE_DISPATCH: Record<ThreeStagePhase, {vendor, model, effort?}>`:
  - design = `{vendor:"claude", model:"claude-fable-5"}`(经 MODEL_TIERS heavy,显示/审计沿用)
  - implement = `{vendor:"codex", model:"gpt-5.6-sol", effort:"xhigh"}`
  - qa = `{vendor:"claude", model:"claude-opus-4-8"}`
  - `resolvePhaseModel` 保留原签名原语义(从新表读 model;对 claude 段返回值与今天逐字节相同);新增 `resolvePhaseDispatch(phase)`。
- 4+1 个位点(orchestrator×3、runs-route 入口、actions.ts phase-retry)统一改传 `{dispatchModel, dispatchVendor, dispatchEffort}`(StartRequest/RetryRequest 加可选字段,全 Bridge 内部,**不动 HTTP body surface**)。
- resolver layer 1b:有 `dispatchVendor` → 经**既有 `VENDOR_TO_EXECUTOR`** 映射(issue 硬约束:不新写映射,防 drift);无 → 现状 `claude-tmux`(字节兼容)。`dispatchEffort` 优先于 project roles effort。
- 缺口 A 的 probe-before-wake + 缺口 B 的 `-c model_reasoning_effort` 一并落。
- 展示小项:`phaseMessageTag` 对 gpt-5.6-sol 会 fallback 误显 tier 名(Fable)——给 modelDisplayName 加 gpt 家族识别或表带 display 名,implement 段诚实显示 `[实现·GPT-5.6]`。

### 方案 2(否):resolver 直接认识 phase(传 phase 名,resolver 查表)

resolver 是纯 role→backend 解析器,让它 import 三段式 phase 表会把 pipeline 概念漏进解析层;且 retry/入口位点还是要传东西,没省。**否**。

### 方案 3(否):做成 per-project 可配置(`pipeline.phases:` config)

issue 原话是「调成我们**默认**的设置」;DEFAULT_PHASE_TIER 的文件头明说这张表故意是 fixed, obvious mapping。可配置化属于三段式大修(1204+1221 redesign)的菜。**否,固定默认表**。

## 5. 明确不做(scope 边界)

- 不暴露 vendor 到 `/api/runs/start` HTTP body(phase 表是唯一 vendor 来源;orchestrator 直调 `startDispatcher.start`,不过 HTTP 校验,runs-route 入口在 body 校验**之后**内部改写——与今天 resolvePhaseModel 同型)。
- 不做 per-project phase 表配置。
- 不动 auto-QA(FLY-579/752)路径:`requireMailboxTransport` 只有 auto-QA 用,codex transport="codex"≠"none",互不干扰。
- 不改 claude 单 session / 不带 vendor 的一切旧路径(字节兼容;哨兵测试)。
- 三段式大修(1204+1221)另立——本票观察喂给它。

## 6. 硬约束核对(issue「硬约束」逐条)

| 约束 | 满足方式 |
|------|----------|
| implement 段 codex 必须 windowed TUI(FLY-398) | CodexTmuxAdapter 内建 founder cmux 窗口(FLY-1188 M4c-3),本票零新代码 |
| 突变测试:摘掉 resolver backend 透传 → per-phase 测试必须红 | 测试直接断言 resolveRoleAdapter({dispatchVendor:"codex",...}).backend === "codex-tmux" + orchestrator 派发集成测断言 StartRequest 携带 vendor;两层都会因透传被摘而红 |
| Codex code review + 全量测试 + founder 批准照常 | cross-family review(claude review codex 作者)已由 FLY-1188 §7.3 enforce;本票 PR 自身照常走 Codex review |
| 沿用 VENDOR_TO_EXECUTOR,别新写映射 | resolver 1b 直接查现表 |
| 字节兼容:不传 vendor 的旧路径行为一字不变 | vendor 可选参数,absent → 现状分支;reverse-compat 哨兵测试 |

## 7. 验收路径(真机,另立冒烟单)

派一单三段式 → design/qa session `adapter_type=claude-tmux`(Fable/Opus),implement 段 `adapter_type=codex-tmux`、模型 gpt-5.6-sol、cmux 真窗口;三段交接(turn belt / handoff / QA verdict)全程正常 —— 含 QA-FAIL → spawn Implement-fix(codex)→ 复验 的 fix 环(缺口 A 修复的直接验证点)。
