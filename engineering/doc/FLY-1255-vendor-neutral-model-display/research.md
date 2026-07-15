# FLY-1255 厂商无关的标题与窗口模型显示 — 调研
Issue: FLY-1255 (https://linear.app/geoforge3d/issue/FLY-1255/fix-标题窗口模型名显示解除-anthropic-绑死-厂商无关渲染codexkimi-后端也要显示)
日期: 2026-07-14
基于: exploration.md

## Summary

代码里不存在“模型信息拿不到”的问题；问题是 display consumer 仍只接受
Anthropic-era 的 F/O/S/H。最终 dispatch 在 `RunDispatcher` 进入 `Blueprint` 前已经
解析出 `runnerBackend + runnerModel`，session 开始后也持久化为
`adapter_type + runner_model`。三段式 pending fallback 还有更强的
`resolvePhaseDispatch(role)`，能随两个 Codex kill-switch 变化。

因此实现不需要 schema/migration，也不应读 CLI runtime。正确切口是：新增共享纯
renderer，再把 thread title 和 window label 两条 consumer 接到同一 descriptor。

## Current Data Flow

### 1. Dispatch plan 已经包含厂商和模型

`packages/config/src/three-stage-phases.ts`：

- `PhaseDispatchSpec = { vendor, model, effort? }`；
- `resolvePhaseDispatch(phase, env)` 是 kill-switch-aware 单一真相；
- 当前 implement 默认 `{vendor:"codex", model:"gpt-5.6-sol", effort:"xhigh"}`；
- Design 开关开启时复用同一 Codex standard dispatch；QA 保持 Claude Opus。

`packages/teamlead/src/bridge/role-adapter-resolver.ts` 把 label / dispatch plan /
project roles / env 按优先级解析为 `ResolvedRoleAdapter`，其中 executor backend 和
model 已确定。`packages/teamlead/src/bridge/run-dispatcher.ts::buildRunnerSpawnFields()`
把它投影为 `BlueprintContext.runnerBackend` 与 `runnerModel`。

关键区别：`vendor` 字段是 Agent-Team transport vendor，Kimi/Antigravity 因
transport=`none` 会为空；显示必须使用 executor backend/family，不能用 transport
vendor 判断厂商。`adapterTypeToFamily()` 已提供
`claude-tmux→claude`、`codex-tmux→codex`、`kimi-tmux→kimi` 的通用映射。

### 2. Actual session 事实已经持久化

`packages/edge-worker/src/Blueprint.ts` 的 `EventEnvelope` 携带：

- `runnerBackend`（resolved executor）；
- `runnerModel`（resolved model）；
- `chatThreadRole`（main 或 design/implement/qa）。

两条 started sink 都保持一致：

- `packages/teamlead/src/DirectEventSink.ts`；
- `packages/teamlead/src/bridge/event-route.ts`。

它们把 executor/model 写到 `sessions.adapter_type` 与 `sessions.runner_model`。
`sessions.dispatch_model` 则只保存 sorter/retry input；它可能与 label/project override
后的最终 model 不同，不能在 actual model 存在时覆盖它。

### 3. Discord thread title 仍是 Claude-only

`packages/config/src/model-tiers.ts::modelShortCode()` 的返回类型固定为
`"F" | "O" | "S" | "H" | undefined`。GPT/Kimi/Antigravity 都返回
`undefined`。`modelDisplayName()` 已能把 `gpt-5.6-sol` 显示成 `GPT-5.6`，但
thread title 没使用它。

标题创建/刷新 caller 都在做相同的 Claude-only 投影：

| Caller | 当前行为 |
|---|---|
| `DirectEventSink.emitStarted()` | `modelShortCode(env.runnerModel) ?? null` |
| `event-route` started/refresh | session 写入后仍由旧 title path 取 short code |
| `issue-display-refresher.ts` | create/legacy stamp/aggregate refresh 均取 `modelShortCode(session.runner_model)` |
| `HeartbeatService.ts` | reconnect title 取 short code |
| `auto-qa-effects.ts` | QA title 取 short code |

`null` 是 authoritative CLEAR，因此 Codex/Kimi 不是“暂时不显示”，而是会主动清除
旧 marker。

`ChatThreadCreator.ts::ChatThreadContext.modelCode` 和
`stage-utils.ts::{stripModelMarker, modelMarkerCode, applyModelMarker}` 也把类型/正则
写死为 F/O/S/H。它们同时承载一条重要历史合同：

- concrete value = set/replace；
- `null` = clear；
- absent = preserve；
- 识别与插入都锚定 `[FLY-XX]` issue key；
- 仍能剥掉旧 ` ·F` tail suffix，存量自然迁移。

这条合同必须泛化，不能删除。

### 4. cmux/tmux window 完全没接模型

`run-dispatcher.ts::runnerDisplayName()` 只接收 `(sessionRole,
shareParentBranch)`：三段式输出 `design/implement/qa`，其他 run 固定输出
`claude`。`Blueprint.ts` 再调用：

```ts
buildWindowLabel(displayId, ctx.runnerName, hydrated.issueTitle)
```

`TmuxAdapter` 与 `CodexTmuxAdapter` 对 `ctx.label` 调
`sanitizeTmuxName(..., maxLen=50)`。因此 window 在 spawn 时已经拿到
`ctx.runnerModel`，却没有把它放进 label。

这也说明修复点应在 dispatch/Blueprint label composition 之前，而不是在各 adapter
内部 sniff 模型。各 adapter 继续消费一个完成的 label，保持 vendor-neutral。

还有一个不能漏掉的跨语言 consumer：`scripts/flywheel-cmux-sync.sh` 的
`is_managed_runner_title()` 用 `claude|design|implement|qa` 窄 allowlist 判断哪些
workspace pin 可由 close request/reaper 安全回收。其注释明确要求
`runnerDisplayName()` 新增任何可产出 prefix 时与 `scripts/test-cmux-sync.sh` 同步。
如果直接产出 `codex-*`/`kimi-*` 而不改 gate，close marker 与 periodic reaper 都会
fail-close 跳过，形成永久 orphan pin。修复采用单一新增 managed prefix `runner-`：
非 phase 的真实 family/model 放在它后面；phase 继续以 phase 为首段。这样 gate 不需
接受开放式 vendor 集合，未来 backend 仍在同一个可证明的 producer namespace 内。

## Proposed Interfaces

### Pure renderer（`flywheel-config`）

建议新增 `packages/config/src/model-display.ts`：

```ts
export interface RunnerModelDisplayInput {
  vendor: string | null | undefined; // executor family, not transport vendor
  model: string | null | undefined;
}

export interface RunnerModelDisplay {
  threadMarker: string;
  windowLabel: string; // executor family + model, tmux-safe
}

export function renderRunnerModelDisplay(
  input: RunnerModelDisplayInput,
): RunnerModelDisplay | undefined;
```

规则：

1. 空 model → `undefined`，不谎报 account-default 的具体型号；
2. Claude 已知 family：`threadMarker` 保持 F/O/S/H，`windowLabel` 用
   `claude-Fable/Opus/Sonnet/Haiku`；
3. Codex/GPT：复用 `modelDisplayName()`，`gpt-5.6-sol` 得到 display name
   `GPT-5.6`，thread marker 加人类可读 namespace 后为 `Model GPT-5.6`；
4. 其他厂商（Kimi/Antigravity/未来 backend）：保留经过 trim、允许字符过滤和
   固定上限截断的原始 model id，不做 Anthropic enum；thread marker 同样加
   `Model `；
5. `windowLabel` 从 executor family + 最终 display name 确定性派生 tmux-safe
   形式，例如 `codex-GPT-5-6` / `kimi-kimi-for-coding`；不得在 window caller
   再实现第二套 vendor/model 映射；
6. vendor/model 不匹配时显示安全化后的原始 model id，不把 Kimi model 误翻译成
   Claude/GPT family 名。

建议 budget：thread marker 的 payload 最多 24 个字符（`Model ` 不计入 payload）；
model payload 最多 24 个字符；完整 `windowLabel` 再受 32-char 上限约束。
Discord 总标题仍由 `composeThreadTitle()` 在 100 字符预算内裁切 base；tmux 最终仍
由现有 50 字符 sanitizer 裁切全名。

### Session source resolver（`flywheel-teamlead`）

建议新增 `packages/teamlead/src/bridge/runner-model-display.ts`：

```ts
export function sessionModelDisplay(
  session: Pick<Session,
    "adapter_type" | "runner_model" | "dispatch_model" | "chat_thread_role"
  >,
): RunnerModelDisplay | undefined;
```

source precedence：

1. `runner_model` present：有 `adapter_type` 时映射 executor family；缺失时先复用
   `modelShortCode()` 识别 Claude canonical/bare aliases，再按 GPT/Kimi prefix 推导，
   未知则用中性的 `unknown`，绝不把未知 model 默认成 Claude；
2. phase role 且 actual 缺失：使用 `resolvePhaseDispatch(role)` 的完整
   `{vendor,model}`；
3. 非 phase 且 `dispatch_model` present：vendor 从 `adapter_type` 推导，作为旧/
   pending row fallback；
4. 都没有：不显示 marker。

这个 helper 让 reconnect、refresh、auto-QA 等 session caller 不再各自猜 fallback。
DirectEventSink 的 fresh event 与 window spawn 尚未形成 Session，直接把 resolved
`runnerBackend + runnerModel` 喂给纯 renderer。

## Thread Marker Generalization

`ChatThreadContext.modelCode` 应改为 `modelMarker?: string | null`，保留 tri-state。
`composeThreadTitle()` 继续把 marker 放在 status/phase badge 后、issue key 前。

`stage-utils` 的新 marker grammar 必须满足：

- Claude 只接受 legacy `F/O/S/H`；非 Claude 必须是 `Model ` namespace，payload 只
  接受 renderer 可能产出的受限字符（字母、数字、点、连字符、下划线、加号）和
  24-char 上限；
- 必须紧跟 bracketed Linear issue key；
- legacy F/O/S/H front marker 与 ` ·F` tail suffix 都继续识别；
- set/replace/clear/preserve 幂等；
- keyless/manual curated title 不插 marker；
- 长/恶意 model id 不得注入 `]`、emoji、控制字符或突破 Discord 100-char budget。

Lead 在 correction brainstorm gate
`df42d371-8056-475e-a35a-a0916c4f4c0f` 批准非 Claude marker 使用人类可读的
明确 namespace，例如 `[Model GPT-5.6]`、`[Model kimi-for-coding]`。这使
`[infra] [FLY-XX]` 等人工标题不可能被当成模型 marker；也不把内部缩写泄漏给
Annie。不得为了缩短实现而退回裸 `[GPT-5.6]` 或任意方括号通配正则。

## Window Composition

不修改 `buildWindowLabel()` 或 adapter。扩展
`runnerDisplayName(sessionRole, shareParentBranch, modelDisplay?)`：

- 三段式：阶段 + 完整 window label，例如 `implement-codex-GPT-5-6`、
  `design-codex-GPT-5-6`、`qa-claude-Opus`；
- 非三段式：固定 managed prefix + resolved window label，例如
  `runner-codex-GPT-5-6`、`runner-kimi-kimi-for-coding`、
  `runner-claude-Fable`，不再把 Kimi/Codex 写在 `claude-` 后；
- model absent：逐字返回当前 `design/implement/qa/claude`，逆向兼容；
- `buildWindowLabel()` 与最终 sanitizer 继续拥有 issue/title 与 50-char 边界。

`RunDispatcher.start()` 与 retry 路径都已拥有同一个 `runnerSpawn`，因此两处必须把
同一个 display descriptor 传给 `runnerDisplayName()`；不能只修 fresh start。
`scripts/flywheel-cmux-sync.sh` 同时把 `runner` 加入 managed prefix allowlist，
`scripts/test-cmux-sync.sh` 增加正/反 sentinels；直接 `codex-*`/`kimi-*` 仍保持
non-managed，避免把用户 tab 纳入 reaper。`close-runner.ts` 的 backstop 注释也要
写明它依赖这个同步 gate。

## File Map

| 文件 | 责任/预计改动 |
|---|---|
| `packages/config/src/model-display.ts` | 新增 vendor-neutral pure renderer + input/output type |
| `packages/config/src/index.ts` | 导出 renderer/types |
| `packages/config/src/__tests__/model-display.test.ts` | Claude byte-compat、`Model GPT-5.6`、Kimi human-readable namespace、unsafe/long id、empty/mismatch |
| `packages/teamlead/src/bridge/runner-model-display.ts` | Session actual→phase plan→dispatch fallback resolver |
| `packages/teamlead/src/bridge/stage-utils.ts` | 泛化 marker parser/apply/strip，保留 legacy/tri-state 安全 |
| `packages/teamlead/src/bridge/ChatThreadCreator.ts` | `modelCode`→vendor-neutral marker，预算/创建/backfill/refresh 共用 |
| `packages/teamlead/src/DirectEventSink.ts` | fresh start 使用 resolved event backend+model |
| `packages/teamlead/src/bridge/issue-display-refresher.ts` | 所有 session title path 使用 session resolver |
| `packages/teamlead/src/HeartbeatService.ts` | reconnect stamp 使用 session resolver |
| `packages/teamlead/src/bridge/auto-qa-effects.ts` | QA stamp 使用 session resolver |
| `packages/teamlead/src/bridge/run-dispatcher.ts` | fresh+retry window runner name 追加同一 window segment |
| `packages/teamlead/src/bridge/close-runner.ts` | 修正 pin-reaper backstop 与 managed-title gate 的合同注释 |
| `scripts/flywheel-cmux-sync.sh` | `runner` managed prefix 与 producer lockstep |
| `scripts/test-cmux-sync.sh` | 新 prefix 正例、direct-vendor/near-miss 反例、orphan cleanup regression |
| `packages/core/test/tmux-naming.test.ts` | 50-char 下 identifier/model 优先、issue title 确定性裁切 |
| 相关 tests | marker、create/refresh/reconnect、fresh/retry window、Codex/Kimi regression |

`event-route.ts` 当前没有独立调用 `modelShortCode()`，因此不列入 production edit；
保留其 stage-event regression test，确保它最终汇入的 aggregate refresh 与直接
started path 输出一致。实施结束再用
`rg "modelShortCode\\(" packages/teamlead/src` 做零遗漏审计。完成标准不是“主路径
测试绿”，而是 production title callsite 已全部迁移。

## Test Matrix

| 维度 | 必测断言 |
|---|---|
| Pure renderer | Claude F/O/S/H 不变；Codex `gpt-5.6-sol→Model GPT-5.6/GPT-5-6`；Kimi model id 以 `Model ` 可见；unsafe/长 id 有界 |
| Source precedence | actual `runner_model` 赢；NULL backend + bare `opus` 仍为 Claude O，GPT/Kimi 不生成 false `claude-*`；phase missing actual 回落 kill-switch-aware plan；非 phase dispatch fallback；全空不显示 |
| Marker lifecycle | create、set、replace、null clear、absent preserve、legacy tail migrate、无双盖、长标题 ≤100 |
| Managed surfaces | DirectEventSink、issue refresher、reconnect、auto-QA 都显示同一 marker |
| Window | phase Codex 含 `implement-codex-GPT-5-6`；非 phase Codex/Kimi 含 `runner-codex-*`/`runner-kimi-*`；retry 同值；cmux gate/reaper 接受 `runner-*`；50-char exact tests 覆盖 phase GPT、realistic Kimi、32-char cap（cap 可吃掉全部 trailing title）；model absent 旧名不变 |
| Compatibility boundary | Claude thread 标题仍 `[F]/[O]/[S]/[H]`；model-absent window 旧输出逐字不变；model-present Claude window 会由 `claude` 变为 `runner-claude-<tier>`，这是有意新增的可见信息；message tags 不变 |

## Verification Commands

实施阶段按 RED→GREEN→REFACTOR 分批运行：

```bash
pnpm --filter flywheel-config test -- model-display
pnpm --filter flywheel-teamlead test -- stage-status-emoji ChatThreadCreator issue-display-refresher run-dispatcher
pnpm --filter flywheel-edge-worker test -- Blueprint
pnpm --filter flywheel-core test -- tmux-naming
bash scripts/test-cmux-sync.sh
pnpm --filter flywheel-config typecheck
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-edge-worker typecheck
pnpm lint
pnpm build
```

最终 QA 还需 dispatch 真 Codex runner，观察 Discord thread 标题出现
目标 marker，并读取 live
`tmux display-message -p -t <target> '#{window_name}'` 证明 window 名也来自
同一模型；Kimi 至少走 dispatcher/adapter integration regression，若环境已有 auth 则
补真机窗口验证。

## Risks

1. **Marker 误剥**：最大风险；用受限 renderer validator + issue-key anchor，必要时
   namespace，不允许通配正则。
2. **title churn/rate limit**：仍搭现有一次 status rename，不新增独立 Discord PATCH。
3. **fresh/retry 漂移**：两条 RunDispatcher context 构造必须调用同一 helper。
4. **kill-switch 漂移**：planned fallback 只调用 `resolvePhaseDispatch()`。
5. **transport/vendor 混淆**：Kimi transport=`none`，显示从 executor
   `adapter_type/runnerBackend` 推 family，绝不读 `ctx.vendor`。
6. **过长 window 挤掉 issue title**：这是有意 tradeoff，不描述成 byte-compatible。
   模型段最多 24 字符，最终仍服从现有 50-char truncate；identifier 与完整
   `runner-codex-GPT-5-6` 位于 title 前，优先保留；realistic Kimi 只余约 12–13
   个 title 字符，32-char windowLabel cap 可让 title 归零并留下 slice 后的末尾 `-`。
   exact tests 锁住现状，本票不顺带重写 shared sanitizer。
7. **cmux cleanup gate 漂移**：producer、`is_managed_runner_title()` 与 shell
   sentinels 同提交更新；只放宽单一 `runner` prefix，不开放任意 vendor。

## Research Conclusion

推荐设计无需数据迁移、无跨进程探测、无 adapter 特判。它把已存在的 resolved
dispatch 真相投影成一个共享 display descriptor，再由 thread/window 选择各自安全
格式。这个边界能直接修复 Codex GPT-5.6，同时覆盖 Kimi，并保留 Claude 老 UX 与
FLY-560/755 的 rate-limit、tri-state、自然迁移合同。
