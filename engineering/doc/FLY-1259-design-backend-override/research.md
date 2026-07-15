# FLY-1259 派单级 Design 后端覆盖 — 调研
Issue: FLY-1259 (https://linear.app/geoforge3d/issue/FLY-1259/feat-派单级-design-后端选择-apirunsstart-加-designbackend-参数覆盖全局开关codexfable)
日期: 2026-07-14
基于: exploration.md

## Research scope

本调研沿真实生产链路检查五件事：

1. `/api/runs/start` 在哪里校验参数、决定三阶段入口并生成回执；
2. design phase 的 `{vendor, model, effort}` 在哪里解析；
3. runner start metadata 如何进入 session state 与 Lead event；
4. handoff、retry、respawn、rescue 分别从哪里重建 phase dispatch；
5. FLY-1255、FLY-1257、FLY-1135 对接口形状和合并顺序有哪些约束。

调研只形成设计与实施顺序，不改生产代码。

## Executive findings

- 现有 `resolvePhaseDispatch` 已经是全量 phase triple 的单一事实源，最小扩展是增加 optional `{vendor}` override，而不是在 API route 复制 Codex/Fable mapping。
- `resolveThreeStageEntry` 是唯一合适的首次锁定点：它同时掌握“是否进入三阶段”、env 和 design dispatch 结果。
- 当前 `dispatchVendor` 只在内存请求链传递，`dispatch_model` 只保存当前 phase/排序器模型；两者都不能表示“这条 run 的 design backend 锁定值”。需要专用 `sessions.design_backend`。
- `BlueprintContext → EventEnvelope → DirectEventSink/event-route` 已是 runner create-time metadata 的标准管道；沿这条管道加入字段，能在 session 首次 upsert 时原子可见，避免 route 启动后再 patch 的竞态。
- 三阶段 handoff、普通 retry 与 rescue 分属不同代码路径，三条都需要显式继承；仅修改 `PhaseOrchestrator` 会漏掉手工 retry 和 stranded-run rescue。
- FLY-1255 的目标分支已抽出统一 `sessionModelDisplay`，但当前 FLY-1259 分支已 revert 临时 stack，helper 不存在；事件/phase tag/header 可独立完成，title integration 必须等正式 FLY-1255 基线并作为 release blocker。实际 `runner_model` 仍具有最高展示优先级。
- FLY-1257 修改 retry TURN/startPoint，但没有定义新的 `RetryRequest.startPoint` public field。本单只在同一 request/context seam 增加 metadata，不改它的恢复机制。
- admission 锁定有效 backend 会把全局 design toggle 从 live retry lever 收窄为新-run fallback。这个行为符合“dispatch 时锁定、retry 继承同值”，但 operator 文案与恢复流程必须明确：已锁定 run 换 vendor 只能结束旧 run 后用显式 `designBackend` 新开 run，过渡版不支持原地 mutation。
- 每个 non-cos department Lead 都加载 `lead-rules-base/model-routing.md`；若不更新这份派单契约，Lead 不会稳定使用新参数，能力仍会退化成手工 curl。

## Current architecture

### Phase resolver

`packages/config/src/three-stage-phases.ts` 定义：

- `PhaseDispatchVendor = "claude" | "codex"`；
- `PhaseDispatchSpec = { vendor, model, effort? }`；
- design 默认 `{claude, claude-fable-5}`；
- Codex 标准配置 `{codex, gpt-5.6-sol, xhigh}`；
- `resolvePhaseDispatch(phase, env)` 在 design 且 `FLYWHEEL_THREE_STAGE_CODEX_DESIGN === "1"` 时返回 Codex，否则返回默认 Fable。

相关测试集中在 `packages/config/src/__tests__/three-stage-phases.test.ts`，已经锁定：

- 只有精确字符串 `"1"` 开启 design Codex；
- `"0"`、`"true"` 和缺省保持 Fable；
- design toggle 不影响 implement/QA；
- implement 的对称 kill switch 维持自己的行为。

结论：resolver 已具备标准 model/effort mapping，override 应在这里按优先级解析，以防 route、retry、rescue 各自漂移。

### Start route and entry policy

`packages/teamlead/src/bridge/runs-route.ts` 当前按以下顺序工作：

1. 解析并校验 `docTier`、`model` 等 request body 字段；
2. 获取 Linear issue/labels，计算三阶段策略；
3. 调用 `resolveThreeStageEntry`；
4. 若进入三阶段，把 entry 的 design `dispatchModel`、`dispatchVendor`、`dispatchEffort` 和 `sessionRole=design` 传给 `startDispatcher.start`；
5. 等待 session row 后 patch `doc_tier`、`issue_url`、`dispatch_model`；
6. 返回固定 success JSON：`success`、`executionId`、`issueId`、`chatThreadId`、`message`。

`packages/teamlead/src/bridge/three-stage-policy.ts` 的 `resolveThreeStageEntry` 已是三阶段入场判定与 design dispatch 相交的位置。它目前只接收 env 并调用 `resolvePhaseDispatch("design", input.env)`。

结论：

- body enum validation 放在 `runs-route.ts`，与 `docTier`/`model` 的边界校验一致；
- `designBackend` 传入 `resolveThreeStageEntry`，但只有 `enteredThreeStage=true` 才成为有效锁定值；
- 显式 override 与非-main role 组合或未进入三阶段时，route 在 dispatch 前以 `DESIGN_BACKEND_NOT_APPLICABLE` 失败并返回 bounded reason code；内部详细 policy reason 只写 server log；
- success response 在显式 override 且进入三阶段时增加 `designBackend`；缺省请求保留旧 JSON key 集合。

### Dispatcher contracts

`packages/teamlead/src/bridge/retry-dispatcher.ts` 的 `StartRequest` 与 `RetryRequest` 已包含：

- `dispatchModel`；
- `dispatchVendor`；
- `dispatchEffort`；
- `shareParentBranch`；
- `ignoreRunnerLabelSelection`。

`StartRequest` 被 `/api/runs/start` 与 phase orchestrator 使用；`RetryRequest` 被 `actions.ts` 与 `RunDispatcher.dispatch()` 使用。它们最终构造 `BlueprintContext`，后者已经传递 `runnerBackend`、`runnerModel`、`runnerEffort` 等 create-time metadata。

结论：增加可选 `designBackend` 到两个 request contract 与 `BlueprintContext`，可以统一首次 start、phase handoff 与 retry；这个字段是 run/phase metadata，不参与 adapter 选择，adapter 仍只消费 resolver 给出的 `dispatchVendor/model/effort`。

### Event and state pipeline

`packages/edge-worker/src/Blueprint.ts` 在执行开始时构建 `EventEnvelope`；`packages/edge-worker/src/ExecutionEventEmitter.ts` 提供两条 started sink：

- `DirectEventSink`：Bridge 内进程生产路径；
- `TeamLeadClient` → `/events`：HTTP/loopback 路径。

两条路径都在 `session_started` 时保存 `adapter_type` 与 `runner_model`：

- `packages/teamlead/src/DirectEventSink.ts::emitStarted` 直接 `upsertSession`；
- `packages/teamlead/src/bridge/event-route.ts` 从 payload 读取并在 transition/upsert 两个分支保存。

`packages/teamlead/src/StateStore.ts` 的 session column 必须同时出现在以下结构与 SQL seam：

1. `SessionUpsert`；
2. `Session`；
3. initial `CREATE TABLE sessions`；
4. additive `ALTER TABLE` migration；
5. `upsertSession` 与 `persistTransition` 两条手写 insert/upsert SQL 的 column/value/update lists；
6. row-to-session mapping。

`dispatch_model` 当前已完整经过类似 seam，并有 `StateStore.test.ts` round-trip precedent。新字段需要在两条 SQL 都采用 `COALESCE(existing, excluded)` 的 first-non-null 写法，避免 replay 覆盖 admission 时锁定的值；不进入通用、可覆盖的 `patchSessionMetadata` whitelist。测试必须分别直达 `upsertSession` 与 `persistTransition`，并在每条路径上重放相反值，防止两份 39-column SQL 出现环境相关漂移。

结论：`session_started` upsert 应直接保存 `design_backend`。不使用 `runs-route` 的通用后置 patch 改写该字段；两条 started sink 和 StateStore first-non-null upsert 共同处理 placeholder/replay，同时保持锁定语义。

## Inheritance audit

### Phase handoff and respawn

`packages/teamlead/src/bridge/phase-orchestrator.ts` 的 `PhaseOrchestratorDeps.startDispatcher.start` 明确接收 phase triple。以下路径分别调用它：

- 正常 `dispatchNextPhase`；
- QA fail 后 implement-fix；
- dead QA respawn/re-drive。

当前每次都按目标 phase 重新调用 `resolvePhaseDispatch(next)`。因此 `design_backend` 需要成为 `PhaseSession` 的可读字段，并在每次 successor start 中原样复制。目标 phase 不是 design 时，它不覆盖 implement/QA 的 triple，只作为 run-level locked metadata 随 session 传播。

### Manual/action retry

`packages/teamlead/src/bridge/actions.ts` 用持久化 `chat_thread_role` 判断 phase row，再无条件调用 `resolvePhaseDispatch(phaseRole)`。这条逻辑刻意不信任旧 `dispatch_model`，以防排序器模型污染 phase table。

新增后的正确行为是：

- design phase 且 `session.design_backend` 非空：调用 resolver with `{vendor: locked}`；
- design phase legacy/null：保持当前 resolver/env 行为；
- implement/QA：保持现有 phase table 行为；
- `RetryRequest.designBackend` 携带原值，让 successor started event 直接保存；
- retry request/context 把该值带到 successor 的 `session_started`，使 retry-of-retry 直接从新 session row 再读取；不通过可覆盖 patch 改写。

这不会恢复使用 `dispatch_model` 推断 design backend。

### Rescue successor

`packages/teamlead/src/bridge/rescue-runtime.ts::buildRescueSuccessorDispatchFields` 是第六条 phase dispatch lane。它目前只读取 `chat_thread_role`、`session_role`、`dispatch_model`，并对 phase row 重新调用 resolver。

必须把 `design_backend` 加入 Pick/return contract：design rescue 用 locked override；其它 phase 保持原 resolver；非 phase row 原样 passthrough 且不产生新字段。

### Retry/respawn interpretation

需求中的“respawn/retry 继承”应解释为所有会新建 phase session 的生产路径，而不是只覆盖 HTTP retry。完成标准至少包括：

- orchestrator normal handoff；
- implement-fix 与 QA respawn；
- actions retry；
- rescue successor；
- retry-of-retry 从 successor row 再读取。

## Observability audit

### Dispatch receipt

现有 start response 没有 backend 字段。为同时满足显式 override 可观测与缺省字节兼容，采用条件字段：

```ts
{
  success: true,
  executionId,
  issueId: result.issueId,
  chatThreadId,
  message,
  ...(explicitThreeStageOverride ? { designBackend: effectiveBackend } : {}),
}
```

错误输入在 dispatch 前返回 400，建议稳定 payload：

```json
{
  "success": false,
  "code": "INVALID_DESIGN_BACKEND",
  "reason": "unknown_backend",
  "allowed": ["codex", "claude"],
  "silent": false
}
```

合法显式值若 request role 不是 `main` 或不能进入三阶段，返回 `400 DESIGN_BACKEND_NOT_APPLICABLE`，包含 `requested` 与 bounded `reason` code，且不调用 dispatcher。channel mismatch 的内部 reason 可能含 allowlist，绝不回显；只写 server log。具体字段顺序按现有 route 测试快照固定；缺省 success response 用 exact equality 锁定。

### Lead dispatch contract

`packages/teamlead/lead-rules-base/model-routing.md` 已随 non-cos department Lead 的 rule bundle 装载，是说明 `/api/runs/start` 模型参数的现有单一位置。应在该文件增加一个独立小节，明确：

- `designBackend` 只影响三阶段 design，不等同于通用 `model` 参数；
- `"codex"` 与 `"claude"` 是仅有合法值，后者对应当前 Fable design；
- founder/issue/Lead 的本单选择需要以该字段随派单发送，不再改全局开关；
- 没有明确 per-run 选择时省略，继续使用全局默认；
- Bridge 回执会回显已应用的显式选择；无效 enum 的 400 会列合法值，不能进入三阶段的 400 会给 bounded reason code，详细配置不出 HTTP。

`lead-rules-bundle.test.ts` 增加内容 sentinel，证明真实 bundle 引用的 shipped rule 含这个契约；不新增 rule 文件或改变 bundle 顺序。

### `[DESIGN] session_started`

`DirectEventSink.pushNotification` 与 event route 最终生成 `HookPayload`，`MailboxLeadRuntime`、`CommDBLeadRuntime` 各有 generic envelope formatter。角色前缀已经由 `session_role` 渲染成 `[DESIGN]`。

最小扩展：

- `HookPayload.design_backend?: "codex" | "claude"`；
- started notification 从锁定 metadata 填入该字段；
- 两个 runtime 的 generic formatter 在 `event_type === "session_started"` 且 role/design backend 存在时追加 `Design Backend: ...`；
- 两套 formatter 测试锁定同样输出，避免 mailbox/CommDB 漂移。

实际显示值使用持久化/事件中的有效 backend，不由 `runner_model` 反推。

### Thread title

FLY-1255 分支新增 `packages/teamlead/src/bridge/runner-model-display.ts::sessionModelDisplay`，优先级为：

1. `runner_model` 实际值；
2. phase role resolver fallback；
3. `dispatch_model`；
4. undefined。

当前分支中的临时 FLY-1255 stack 已 revert，因此上述 helper 和测试都不存在。本单不新建 title helper：先独立完成事件/phase tag/header，再等正式 FLY-1255 基线后扩展 `DisplaySession` 读取 `design_backend`，并在第 2 层对 design 调用带 override 的 `resolvePhaseDispatch`。started session 通常已有 `runner_model`，且 pre-FLY-1255 `ChatThreadCreator` 会从实际 `runner_model` 生成 marker，所以正常路径仍展示实际模型；缺的是 metadata 不完整/刷新场景的 locked fallback。若 FLY-1255 不落地，本单不得宣称完成 title acceptance。

### Planned model and founder-message fallbacks

FLY-1224 的 display honesty 不只在 thread title。当前还有三类调用会在 `runner_model` 为空时直接读取全局 phase table：

- `packages/teamlead/src/bridge/issue-display-refresher.ts` 两处 pending-row `plannedModel`；
- `packages/config/src/three-stage-phases.ts::phaseMessageTag`；
- `phaseMessageTag` 的 session-backed founder notifications：post-ship、stuck、auto-QA、gate/milestone 等。

如果 global=Claude 而 run locked=Codex，这些 fallback 会显示 Fable。修复策略：

- `phaseMessageTag` 的 `runnerModel` 与新增 `designBackend` 都改为显式必传的 nullable/undefined 参数，design fallback 将 backend 转成 resolver override；必传类型迫使所有 caller 明确选择 session values 或 legacy `(undefined, undefined)`；
- 所有拿到 session 的生产 caller 都传 `session.design_backend`；非 session/pending-empty caller 显式传 `undefined`；
- issue display 先取得对应 phase session，再让两处 `plannedModel` 与 label 同时读取 `ps?.design_backend`；没有 session 时才使用全局默认；
- `fly892-phase-tag.test.ts` 与 `issue-display-refresher.test.ts` 在相反 global 下验证 locked 值，类型检查确保其它 caller 不遗漏第三参。

### Feature flag catalog

`feature-flags/registry.ts::three_stage_codex_design_toggle` 当前描述全局开关决定 design backend，并声称 display fallback 与它一致。加入 per-dispatch override 后，准确语义变为“仅在新 run admission 且没有显式选择时的全局 fallback；一旦锁定，retry/rescue 不再读取”。需要同步 comment、description 与 note，并在 `feature-flags-drift.test.ts` 增加语义 sentinel；现有 drift scanner 只证明 env 仍被读取，无法发现描述过时。

## Type and schema design

建议在 `flywheel-config` 导出：

```ts
/** Preserve the existing FLY-1224 transported-vendor rationale here. */
export type PhaseDispatchVendor = "claude" | "codex";
export type DesignBackend = PhaseDispatchVendor;
export const DESIGN_BACKENDS = ["codex", "claude"] as const satisfies readonly DesignBackend[];

export interface PhaseDispatchOverride {
  vendor: PhaseDispatchVendor;
}

export function resolvePhaseDispatch(
  phase: ThreeStagePhase,
  env?: Record<string, string | undefined>,
  override?: PhaseDispatchOverride,
): PhaseDispatchSpec;
```

Resolver 只在 `phase === "design"` 时消费 override：

- `{vendor:"codex"}` → 现有 Codex standard triple；
- `{vendor:"claude"}` → 现有 Fable design triple；
- undefined → 现有 env/default 分支；
- implement/QA 传入 override 也应保持原 triple，防止未来误调用扩大语义。

`PhaseDispatchVendor` 继续是永久、跨 phase 的 authoritative transported-vendor invariant，并保留 FLY-1224 关于排除 no-transport backend 的注释。过渡 `DesignBackend` 从它派生，`DESIGN_BACKENDS` 用 `satisfies` 拒绝非 transported value；不要反向让 phase vendor union 依赖可回滚的 public array。

对外 API 使用 `designBackend` camelCase；event wire/state 使用 `design_backend` snake_case；内部 request/context 使用 `designBackend`。转换只发生在 event/state boundary。

## Related work alignment

### FLY-1255 — thread model rendering

FLY-1255 的目标分支已抽出 `sessionModelDisplay` 并修改 thread/display path，但当前 FLY-1259 分支没有该 helper。潜在冲突文件是该 helper 及调用它的 issue display refresher。合并策略：先提交不依赖 helper 的 display honesty；正式 FLY-1255 合入后，以它的 helper 为基线小幅增加 locked design override，并用显式 file-exists preflight 防止 Vitest 零匹配。绝不把 title mapping 放入 FLY-1259 独立代码；依赖未到位时 release fail-close。

### FLY-1257 — retry runtime defects

FLY-1257 计划修改 `RunDispatcher.dispatch()` 的 phase retry TURN seam 与 startPoint 恢复。它明确把 startPoint 作为 Bridge 内部恢复计算，而不是新增 `RetryRequest.startPoint`。

FLY-1259 只做：

- `RetryRequest`/context metadata 增加 `designBackend`；
- `actions.ts` resolver 读取 locked backend；
- successor session 继承。

不改变 TURN grant、worktree takeover、resume start point 或 gate lifetime。实现时先把 FLY-1257 最新结果作为基线，再落独立字段 hunk。

### FLY-1135 / FLY-1244 — DAG per-node dispatch

FLY-1135 规定 admission 时应用 per-run override 并物化不可变 snapshot，后续 dispatch/retry/reconcile 只读 pinned snapshot；节点 schema 是 `{vendor, model, effort}`。

本单与其对齐的部分：

- API 参数在 admission 时解析；
- 内部 resolver override 使用 object，而非额外 scalar signature；
- 保存解析后的有效 vendor，而非只保存原始请求；
- retry/reconcile-like paths 不再重新读取可变全局配置。

未来迁移时，`sessions.design_backend` 可作为旧三阶段 run 的兼容投影，新的 DAG run 则读取 materialized node snapshot。

## Test inventory

| Concern | Existing test seam | New assertion |
|---|---|---|
| resolver precedence | `packages/config/src/__tests__/three-stage-phases.test.ts` | env 0 + codex override；env 1 + claude override；other phases ignore override |
| entry policy | `packages/teamlead/src/bridge/__tests__/three-stage-policy.test.ts` | `enteredThreeStage` result returns full triple + effective backend；non-entry returns bounded code + internal detail |
| public API | `packages/teamlead/src/__tests__/start-e2e.test.ts` | validation；applied receipt；non-main/non-applicable explicit request fails before dispatch；channel allowlist never appears；absent exact response |
| Lead usage contract | `model-routing.md`, `lead-rules-bundle.test.ts` | 参数与 `model` 区别；显式选择/缺省规则进入真实 bundle |
| state | `packages/teamlead/src/__tests__/StateStore.test.ts` | migration/read + `upsertSession`/`persistTransition` first-non-null replay immutability |
| context/event | edge-worker Blueprint/ExecutionEventEmitter tests | request→envelope→HTTP payload field |
| direct persistence | `packages/teamlead/src/__tests__/DirectEventSink.test.ts` | production started path stores backend and notifies it |
| loopback persistence | event-route tests | transition and direct-upsert variants store backend |
| normal handoff/respawn | phase orchestrator tests | every successor copies locked backend |
| retry | `actions-retry-route.test.ts`, `retry-e2e.test.ts` | global flips but stored design backend wins；legacy null uses env |
| rescue | `packages/teamlead/src/__tests__/rescue-runtime.test.ts` | design locked override + legacy fallback |
| lead event | mailbox/CommDB runtime tests | `[DESIGN] session_started` includes backend with parity |
| title | FLY-1255 renderer tests | actual model first；locked design fallback second |
| planned/message display | `fly892-phase-tag.test.ts`, `issue-display-refresher.test.ts` | locked backend beats opposite global in phase tags and both pending header paths |
| feature catalog | `feature-flags-drift.test.ts` | global flag documented as fallback below per-run lock |

## Verification commands for implementation phase

实施时先按测试文件运行定向 Vitest，再跑受影响 package checks。命令应以实际 package scripts 为准，预计核心集合：

```bash
pnpm --filter flywheel-config test -- three-stage-phases.test.ts
pnpm --filter flywheel-teamlead test -- start-e2e.test.ts three-stage-policy.test.ts StateStore.test.ts
pnpm --filter flywheel-teamlead test -- DirectEventSink.test.ts actions-retry-route.test.ts rescue-runtime.test.ts phase-orchestrator.test.ts
pnpm --filter flywheel-teamlead test -- mailbox-lead-runtime.test.ts commdb-lead-runtime.test.ts
pnpm --filter flywheel-edge-worker test -- ExecutionEventEmitter.test.ts
pnpm typecheck
```

实现者必须先从各 package 的 `package.json` 确认准确 script/name；本文不把未执行的命令宣称为已验证。

## Open risks

1. FLY-1255 当前未在本分支且临时 stack 已 revert；事件/phase tag/header 先独立实现，title integration 必须等正式 helper，并通过 file-exists + named-suite non-zero coverage 后才能 release。
2. FLY-1257 可能先合并并改变同一调用点；实现者必须按最新 branch/main 调整，不覆盖其 TURN/startPoint 语义。
3. `StateStore` 有 transition 与 raw upsert 两条 started path，遗漏任一处会产生环境相关 bug。
4. 如果只把 backend 放进通知而不落库，重启后 retry 仍会漂移；state round-trip 是 release blocker。
5. 如果只在 design session 保存而不向 implement/QA successor 传播，run 当前 session 上会丢失继承来源；orchestrator successor copy 是 release blocker。
6. 锁定所有新 run 会失去“flip env + retry 原地换 vendor”的旧逃生方式。文案必须把 env 定义为 new-admission fallback；sanctioned recovery 是结束失败 run，以显式相反 backend 新开 run，并接受 context/worktree 不继承的过渡期代价。
7. 真实 runner 验证需要两个不同全局基线，必须在隔离 Bridge 环境执行，不能靠生产重启互相干扰。

## Recommendation

按“resolver → admission lock → create-time state/event → all successor lanes → observability → related integration”的顺序实施。每一步先写失败测试，再加最小代码。不要先改 public route 后补持久化；否则中间状态会提供看似可用但 retry 不稳定的半能力。
