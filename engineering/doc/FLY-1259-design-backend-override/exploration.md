# FLY-1259 派单级 Design 后端覆盖 — 探索
Issue: FLY-1259 (https://linear.app/geoforge3d/issue/FLY-1259/feat-派单级-design-后端选择-apirunsstart-加-designbackend-参数覆盖全局开关codexfable)
日期: 2026-07-14
基于: 无

## Context

FLY-1245 用全局环境变量 `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 在 Claude Fable 与 Codex 之间切换三阶段流水线的 design 后端。这个开关能验证后端可行性，但粒度是整个 Bridge：不同任务无法同时选择不同 design 后端，切换还需要重启 Bridge。

本单提供一个过渡层能力：调用方在每次 `POST /api/runs/start` 时，可用可选参数 `designBackend` 指定该次三阶段派发的 design 后端。它只覆盖 design phase，不改变 implement、QA，也不提前实现 FLY-1135 的完整 per-node `{vendor, model, effort}` DAG 配置。

参数值按 runner vendor 命名：

- `"codex"` 表示使用当前标准 Codex design 配置；
- `"claude"` 表示使用当前标准 Claude Fable design 配置；
- 缺省表示仍由 `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 决定首次 design 派发。

## Problem

今天的选择发生在运行时环境，而不是派单数据中，因此存在四个问题：

1. 无法在同一个 Bridge 上并发派发“一单 Codex、一单 Fable”。
2. 切换需要 bridge-only restart，操作成本高且会影响其他任务。
3. 后端选择没有作为本次运行的锁定事实保存，retry、respawn、rescue 容易重新读取已变化的全局开关。
4. 派单回执与 `[DESIGN]` 会话事件没有明确展示实际后端，排障时只能从模型名或 adapter 间接推断。

## Goals

- `/api/runs/start` 接受可选 `designBackend: "codex" | "claude"`。
- 显式派单值优先于全局开关；缺省请求保持当前入口行为和响应形状。
- 在 design 首次派发时解析并锁定有效 backend，保存到 session/run phase 元数据。
- 后续 handoff、retry、respawn、rescue 继承同一值，不因环境变量变化而漂移。
- 显式 override 的 start 回执展示实际 backend；所有 design `session_started` 通知展示实际 backend。
- thread title 继续复用 FLY-1255 的统一模型渲染器。
- 用默认路径、两个反向 override 和真实 runner 验证证明兼容性。

## Non-goals

- 不开放任意 `model`、`effort` 或 implement/QA 的 per-dispatch 配置。
- 不引入通用 `phaseDispatch` JSON 或 DAG schema；这属于 FLY-1135/FLY-1244。
- 不改变 FLY-1257 的 retry TURN、resume start point 或 zombie gate 修复。
- 不复制 FLY-1255 的 thread title 解析/渲染逻辑。
- 不将 `designBackend` 塞入现有 `dispatch_model` 字段。
- 不在本设计阶段写实现代码、创建 PR 或执行真实 runner 验证。

## Invariants

### Precedence

Design dispatch 的优先级固定为：

1. 本次派单显式 `designBackend`；
2. 本次 run 已锁定的 `sessions.design_backend`；
3. 仅对 legacy/null 记录，读取当前全局 `FLYWHEEL_THREE_STAGE_CODEX_DESIGN`；
4. 现有 design 默认值 Claude Fable。

首次 `/api/runs/start` 只有第 1、3、4 层；后续 phase 动作优先使用第 2 层。

### Compatibility

- 未传 `designBackend` 的 start request 继续按全局开关选择 design。
- 未传该字段时，HTTP success response 不增加新 key，保持现有 JSON 形状。
- 缺省请求的非三阶段派发保持原路径；若显式传入 `designBackend` 但 request role 不是 `main` 或策略不能进入三阶段，则在启动 runner 前返回 `400 DESIGN_BACKEND_NOT_APPLICABLE` 与 bounded reason code，不静默吞掉选择，也不泄露 channel allowlist。
- 历史 session 没有 `design_backend` 时仍按当前全局解析，避免迁移后无法 retry。
- implement 与 QA 的 `{vendor, model, effort}` 完全不受此字段影响。

### Locked metadata

锁定的是有效 backend，而不是“override 是否出现”：即使请求没有显式字段，三阶段 design 入场时也把全局开关解析结果保存为 `codex` 或 `claude`。这样同一 run 的后续动作具有稳定事实来源。

Codex/Claude 对应的具体 `model` 与 `effort` 仍由 `resolvePhaseDispatch` 的标准配置给出。本单不把它们复制到新的 API 参数，但现有 `dispatch_model`、adapter/runner metadata 继续记录实际派发结果。

这个选择有一个明确的 ops tradeoff：全局 `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 从 live retry lever 收窄为新 admission fallback。已锁定 run 即使在 Bridge restart 后也不会因 env 改动换 vendor；这是“dispatch 时锁定、retry 继承同值”的直接结果。若锁定 vendor 因 quota/服务故障无法继续，sanctioned recovery 是结束失败 run，并针对同一 issue 用显式相反 `designBackend` 新开 run；新 run 不继承旧 context/worktree。过渡版不提供 retry-time mutation，也不允许直接改 SQLite 绕过锁定；原地换 vendor 留给完整 per-node dispatch 控制面。

## Design questions

### 1. API 应该暴露 backend 还是完整模型配置？

当前需求只有 Codex/Fable 二选一，且明确是完整 DAG 之前的轻量过渡。选择 `designBackend` 能保持接口小而清晰；内部则使用 `{vendor}` override object 接入 `resolvePhaseDispatch`，为以后扩展 `{vendor, model, effort}` 留出形状兼容点。

### 2. 保存请求值还是有效值？

保存有效值。只保存“是否 override”会让缺省请求的 retry 继续受全局环境漂移影响，与“dispatch 时锁定”矛盾。有效值也最适合作为事件与审计字段。

### 3. 使用哪个持久化字段？

新增专用 `sessions.design_backend`。`dispatch_model` 表示当前 phase 的实际模型，不能同时承担整个 run 的 design backend 继承意图。专用字段能在 implement/QA session 上继续携带，供未来 design respawn 或 run 级排障使用。

### 4. 回执怎样兼顾可观测与字节兼容？

当请求显式携带合法 override 且实际进入三阶段 design 时，success response 增加 `designBackend`，值为实际有效 backend。字段缺省时保持旧 response shape。所有 design `session_started` 事件都展示持久化的实际 backend，因此默认路径仍具备事件侧可观测性。

### 5. 非三阶段请求传入该字段怎么办？

先做语法校验。显式字段与非 `main` request role 组合立即以 `reason: "non_main_role"` 失败；`main` request 再完成服务端三阶段策略判定，若未进入 design，则返回 `400 DESIGN_BACKEND_NOT_APPLICABLE`，携带 request value 与 bounded reason code，详细 policy string 只写 server log。这样参数不会把非三阶段请求强制转换为三阶段，不会让 Lead 误以为选择已生效，也不会把 `three_stage_channels` allowlist 暴露到 HTTP。未传字段的非三阶段请求仍完全不变。

## Options

### Option A — Dedicated locked backend metadata

在入口校验 `designBackend`，以 `{vendor}` override 交给 phase resolver；把解析后的有效 backend 写入 `sessions.design_backend`，通过现有 request/context/event/session 链路传播；retry/rescue 优先读取该字段。

优点：

- 直接表达需求，审计来源清楚；
- 与 FLY-1135 的 `{vendor, model, effort}` 方向兼容；
- retry 与全局环境解耦；
- 对 `dispatch_model` 与 adapter 语义零污染。

代价：

- 需要跨 API、state、event、orchestrator 多层传递一个字段；
- 要同时覆盖 DirectEventSink 与 loopback event route 的持久化路径。

### Option B — Reuse `dispatch_model`

把 Codex/Fable 的模型名当作继承依据，retry 时由模型名反推 vendor。

优点：字段较少。

缺点：模型与 vendor/意图混为一谈；模型升级会破坏判断；implement/QA 的 `dispatch_model` 会覆盖 design 信息；与未来 DAG schema 相冲突。

结论：拒绝。

### Option C — Only override the first dispatch

入口显式值只影响初次 design，retry/rescue 继续调用当前 resolver 并读取全局开关。

优点：改动最小。

缺点：无法满足 dispatch-time locked；全局开关变化后同一 run 会切换后端；正是本单要消除的 retry 缺陷。

结论：拒绝。

### Option D — Implement generic per-phase dispatch JSON now

让 `/api/runs/start` 直接接受每个 DAG node 的 `{vendor, model, effort}`。

优点：一步到达长期目标。

缺点：越过当前轻量范围，需要定义模板、验证、授权、持久化与 UI 契约；会与 FLY-1135/FLY-1244 重叠并显著增加上线风险。

结论：留给关联项目。

## Recommended design

采用 Option A，数据生命周期如下：

| Boundary | Input | Resolution / storage | Output |
|---|---|---|---|
| `/api/runs/start` | optional `designBackend` | validate enum; require actual three-stage entry when explicit | applied override receipt includes `designBackend`; non-applicable request returns 400 |
| Three-stage entry | request override + env | `resolvePhaseDispatch("design", env, override)` | full `{vendor, model, effort}` + locked effective vendor |
| Runner start | locked vendor | thread through `StartRequest` → `BlueprintContext` → event envelope | `session_started.design_backend` |
| State | event metadata | persist `sessions.design_backend` | source of truth for later phases |
| Handoff / retry / rescue | previous session | copy locked vendor; design resolver uses it before env | stable backend after env changes |
| Lead notification | design session start | render `Design Backend: codex|claude` | explicit `[DESIGN]` observability |
| Thread title | actual runner/model + locked fallback | reuse FLY-1255 `sessionModelDisplay` | existing `[Model …]` / `[F]` rendering |

## Validation behavior

- `designBackend` missing or `null`: treat as absent.
- `designBackend` equal to `"codex"` or `"claude"`: valid.
- wrong type or unknown string: return HTTP 400 with stable code such as `INVALID_DESIGN_BACKEND` and allowed values; do not create or dispatch a runner.
- valid explicit value with a non-main role or a request that does not enter three-stage: return HTTP 400 `DESIGN_BACKEND_NOT_APPLICABLE` with one bounded reason code (`non_main_role`, `no_three_stage_label`, `global_disabled`, `channel_not_allowed`, `policy_disabled`); log detail server-side only; do not create or dispatch a runner.
- enum validation is exact and lowercase; aliases such as `fable`, `Codex` or raw model names are invalid。

## Test strategy

### Automated

- Resolver unit tests cover explicit override precedence in both directions and unchanged default/env cases.
- Start route tests cover validation, effective policy input, conditional receipt field and absent-field response equality.
- StateStore tests cover create/migrate/read round trip and first-non-null immutability through both `upsertSession` and `persistTransition`.
- Event pipeline tests cover context propagation and both persistence sinks.
- Orchestrator, retry and rescue tests change the global env after first dispatch and prove the locked value wins.
- Lead formatter tests assert `Design Backend` appears only where intended.
- FLY-1255 renderer integration test proves design fallback uses locked backend without duplicating title logic.
- `phaseMessageTag` 与 issue display 两处 planned-model fallback tests 在相反全局值下仍显示 locked backend；所有 session-backed founder messages 显式传递 `design_backend`。

### Real runners

1. 全局 `0` 或 unset，start request 指定 `designBackend: "codex"`，确认 Codex runner、标准 Codex design model/effort、回执、`[DESIGN]` 事件和 FLY-1255 title。
2. 全局 `1`，start request 指定 `designBackend: "claude"`，确认 Claude Fable runner、回执、事件和 title。
3. 在每个 run 首次派发后改变全局开关，触发受控 retry/rescue，确认后端仍等于锁定值。
4. 不传字段运行默认路径，确认 response JSON 形状和当前全局行为未变。

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| FLY-1257 同时修改 retry 路径 | 本单只增加 metadata 传递和 resolver override，不修改 TURN/startPoint/gate 语义；实现时按最新主干重放小 hunk |
| FLY-1255 当前未在本分支、临时 stack 已 revert | 先独立完成事件/phase tag/header；title integration 等正式 FLY-1255 helper 出现后单独实现并作为 release blocker，不创建第二套 mapping。依赖永不落地时，现有 `ChatThreadCreator` 仍用实际 `runner_model` 渲染正常 started title，但本单不能宣称完成 locked fallback |
| 一个 event sink 漏写字段 | DirectEventSink 与 loopback route 使用同一 contract，并分别测试 |
| 只在初始 design session 保存，后续丢失 | orchestrator 每个 successor 都复制 `design_backend`；StateStore round-trip 测试覆盖 |
| legacy row 为空导致 retry 失败 | null/undefined 明确回退现有 env resolver |
| 已锁定 run 失去 flip env + retry 的旧逃生方式 | 在 operator 文案中明确 env 仅作用于新 admission；需要换 vendor 时结束旧 run，以显式 `designBackend` 新开 run，并接受 context/worktree 不继承的过渡期代价 |
| response 增 key 破坏旧调用方 | 只有显式 override 请求增加字段；缺省请求保持精确旧形状 |

## Approval

Flywheel brainstorm gate `303e498a-5f1b-4c55-bc10-e8abf3934681` 已由 Lead 批准。Lead 确认以下决策：显式 override 优先于 env、使用专用 `sessions.design_backend` 锁定并跨 handoff/retry/rescue 传播、不复用 `dispatch_model`、legacy 行保持 env fallback、回执与 `[DESIGN]` 事件可观测、thread title 复用 FLY-1255 渲染器，以及两个方向各一条真机验证。
