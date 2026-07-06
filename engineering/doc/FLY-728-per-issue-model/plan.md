# FLY-728 per-issue 模型路由 — 实施计划

Issue: FLY-728 (https://linear.app/geoforge3d/issue/FLY-728/model-per-issue-模型路由-按-issue任务定模型heavyfable-smallopussonnet覆盖项目默认)
日期: 2026-06-30
基于: research.md

## Scope（Annie 定案 2026-07-01 — 完整 per-issue 模型系统、一个 PR #405、不拆 phase）

- **A（done）**: `fable` 进 label 解析器（唯一卡 heavy→Fable 的点）。
- **B（done）**: 模型可见性 —— `runner_model` 列 + dashboard「Model」列。
- **C（new）**: `/api/runs/start` 的 `model` body 参数 = 分拣器的输出通道（Lead 判断后传模型）。**un-defer**。
- **分拣器（new）**: = Lead(LM)在 dispatch 时 signal-informed holistic 判难易 → 选模型 → 走 C 传。**非 server 死规则**、非另调 LLM。实现 = lead-rules 指南(`model-routing.md`)。
- **D（new）**: `[FLY-XX]` thread 标题 F/O/S/H 短码。
- **Follow-up（documented）**: 校准例子 + eval-tuning（Annie approved defer,写进 issue）。

完整 resolve ladder（dispatch 时）:`issue 手动标签(含 fable)` > `dispatch model 参数(分拣器)` > `项目默认(FLY-671 roles.runner.model)` > `account(omit --model=Opus)`。下两层已有、不重造。字节兼容:不打标签/不传 model/不加列查询 = 现状零变化。

## Part A — `fable` label → `claude-fable-5`

**文件**: `packages/config/src/runner-label.ts`

1. `resolveModelFromLabels`（现识别 opus/sonnet/haiku）在 Claude 系里加：
   ```ts
   if (labels.includes("fable")) return "claude-fable-5";
   ```
   放在 `opus` 之前/附近。返回**显式 id** `claude-fable-5`（全库统一:`fleet-capabilities.ts:58`、`token-usage/pricing.ts`、`render-html.ts`；`--model` 直传 `packages/claude-runner/src/TmuxAdapter.ts:683`;token-usage 已认→"Fable 5" 自动对齐)。

2. **不动** `inferRunnerFromModel`（Codex R1 #4）：`resolveModelFromLabels(["fable"])` 返回 `claude-fable-5`，`inferRunnerFromModel` 收到的是 `claude-fable-5`（`startsWith("claude")` 已归 claude）——裸 `fable` 分支在 label 路径**不可达=死代码**，`inferRunnerFromModel` 是 runner-label.ts 模块私有函数（RunnerSelectionService 里同名的是另一个独立函数），故省略以守简单。→ **Part A = 只加 1 行**。

**行为验证**（无需改 resolveRoleAdapter / inferRunnerFromModel）:
- `parseRunnerLabels(["fable"])` → `{runnerType:"claude", modelOverride:"claude-fable-5"}`（`inferRunnerFromModel("claude-fable-5")`→claude）。
- `resolveRoleAdapter({role:"runner", issueLabels:["fable"]})` → `{backend:"claude-tmux", model:"claude-fable-5", transport:"claude-code", vendor:"claude-code"}` → `--model claude-fable-5`，**覆盖项目 roles.model**（layer-1 设 backend 后跳过 layer-2）。
- 组合 `["codex","fable"]`:agent label 赢 → codex-tmux、model override 丢弃（现有 guard，不改）。

## Part B — 可见性:持久化 `runner_model` + dashboard 显示

镜像 `adapter_type`（FLY-493）整套现成模式。

### B1. Event envelope 带上 model
- `packages/edge-worker/src/ExecutionEventEmitter.ts`
  - `EventEnvelope` 加 `runnerModel?: string`（紧挨 `runnerBackend`，~L23）。
  - `emitStarted` payload 加 `runnerModel: env.runnerModel`（~L82，紧挨 `runnerBackend`）。
- `packages/edge-worker/src/Blueprint.ts`（envelope 构造 ~L559）
  - 加 `...(ctx.runnerModel && { runnerModel: ctx.runnerModel })`（紧挨 runnerBackend 那行）。`ctx.runnerModel` 已由 `buildRunnerSpawnFields` 注入。

### B2. 两条 started 落库路径都持久化（不能只改一条）
- `packages/teamlead/src/bridge/event-route.ts`（HTTP `/events` loopback，session_started handler ~L664）
  - `const eventRunnerModel = asString(payload.runnerModel);`
  - applyTransition 分支 + upsertSession 分支各加 `...(eventRunnerModel && { runner_model: eventRunnerModel })`（紧挨 adapter_type）。
- `packages/teamlead/src/DirectEventSink.ts`（生产 in-process started 路径 ~L123）
  - 加 `runner_model: env.runnerModel,`（紧挨 `adapter_type: env.runnerBackend`）。

### B3. StateStore 加列 + 读写（`packages/teamlead/src/StateStore.ts`）
- 迁移:try/catch `ALTER TABLE sessions ADD COLUMN runner_model TEXT`（镜像 adapter_type ~L762）。
- `SessionRow`(insert type ~L253) + `Session`(read type ~L332) 各加 `runner_model?: string;`。
- upsertSession INSERT（block1 ~L1250）:列表加 `runner_model`、VALUES 加一个 `?`、ON CONFLICT 加 `runner_model = COALESCE(excluded.runner_model, runner_model)`、values 加 `session.runner_model ?? null`。
- applyTransition INSERT（block2 ~L1395）:同上，values 用 `fields.runner_model ?? null`。
- patchSessionMetadata 白名单（~L1568）加 `runner_model: "runner_model",`。
- row→Session getter（~L2784）加 `runner_model: (row.runner_model as string) ?? undefined,`。

### B4. Dashboard 显示
- `packages/teamlead/src/bridge/dashboard-data.ts`
  - `DashboardSession` 接口加 `runner_model?: string;`。
  - `toDashboardSession` 加 `runner_model: s.runner_model,`。
- `packages/teamlead/src/bridge/dashboard-html.ts`（active-sessions 表 ~L305）
  - 表头 `<thead>` 加 `<th>Model</th>`（在 Branch/Tmux 附近）。
  - `renderActive` 行加 `<td>` 显示 `s.runner_model || '—'`（NULL=account 默认→显示破折号）。
  - 若列数变化影响其它渲染/测试断言，同步 `dashboard.test.ts`。

**语义**:model override 时 dashboard 显示实际模型（如 `claude-fable-5`）;无 override（account 默认）显示 `—`。runner 表本就只列 runner session（main/qa），正好满足「runner 上看得到用哪个模型」。retry 走同一 started 事件重新解析+重落，天然一致。

## TDD 测试计划（RED→GREEN）

| # | 文件 | 断言 |
|---|------|------|
| A1 | `packages/config/src/__tests__/runner-label.test.ts` | `parseRunnerLabels(["fable"])` = `{runnerType:"claude", modelOverride:"claude-fable-5"}`；`["FABLE"]` 大小写归一；`["codex","fable"]` → codex、无 modelOverride；**`["antigravity","fable"]` / `["kimi","fable"]` → no-transport vendor 赢、无 Claude model 挂上**（Codex R1 #6 回归）；opus/sonnet/haiku 回归不变 |
| A2 | `packages/teamlead/src/bridge/__tests__/role-adapter-resolver.test.ts` | `{role:"runner",issueLabels:["fable"]}` → backend claude-tmux + model `claude-fable-5`；label `fable` 覆盖 `projectRoles.runner.model="sonnet"`；非 runner role 不受影响 |
| B1 | `packages/teamlead/src/__tests__/StateStore.test.ts` | upsert 带 `runner_model` 可读回；缺列旧库迁移后可写；patchSessionMetadata 改 `runner_model`；COALESCE 不抹已存值；不传 = NULL（byte-compat） |
| B2 | `packages/teamlead/src/__tests__/event-route.test.ts` | session_started payload 带 `runnerModel` → 落 `runner_model`；不带 = NULL |
| B3 | `packages/teamlead/src/__tests__/DirectEventSink.test.ts` | env.runnerModel → 落 `runner_model`（生产路径） |
| B4 | `packages/teamlead/src/bridge/__tests__/dashboard.test.ts` | `toDashboardSession` 带 `runner_model`；payload active 行含该字段；缺值 undefined 不破坏 shape |
| B5 | `packages/edge-worker/src/__tests__/ExecutionEventEmitter.test.ts` | **（Codex R1 #3 emission-side）** `TeamLeadClient.emitStarted(envelope{runnerModel})` 发出 `payload.runnerModel`；Blueprint 把 `ctx.runnerModel` 拷进 envelope（若 Blueprint 有对应测试则同处断言，否则在 emitter 测试覆盖 envelope→payload） |
| C1 | `packages/config/src/__tests__/model-tiers.test.ts` | `normalizeDispatchModel` 认 4 档 id + 裸别名(大小写/trim)、拒未知/空/非档(含 sonnet-4-6)；`modelShortCode` id+别名→F/O/S/H、account 默认/非 Claude→undefined |
| C2 | `packages/teamlead/src/bridge/__tests__/role-adapter-resolver.test.ts` | dispatchModel 无标签→claude-tmux+model；盖过项目默认;model 标签/vendor 标签(codex)赢;非 runner role 忽略;缺→byte-compat |
| C3 | `packages/teamlead/src/__tests__/start-e2e.test.ts` | `/api/runs/start` `model`:有效档→dispatchModel;裸别名归一;未知→400 INVALID_MODEL 不 dispatch;缺→undefined |
| C4 | `packages/teamlead/src/__tests__/retry-doc-tier.test.ts` | retry 从 runner_model 重导 dispatchModel(档 id→保);无/非档 runner_model→undefined |
| D1 | `packages/teamlead/src/__tests__/stage-status-emoji.test.ts` | `applyModelSuffix`/`stripModelSuffix`:加/幂等/换/清;与 stage-emoji 前缀共存(splitStatusEmoji 保后缀) |
| D2 | `packages/teamlead/src/__tests__/ChatThreadCreator.test.ts` | stampStageEmoji 带 modelCode→标题后缀 `·F`;无 modelCode 的 re-stamp 保留已有后缀;emoji+后缀都命中→no-op |

## 风险 / 边界

- **字节兼容**:所有新列 nullable + COALESCE upsert;不打 label→resolved.model undefined→runner_model NULL→dashboard `—`;dashboard payload 新字段 optional。零现状回归。
- **两条 started 路径**（DirectEventSink 生产 + event-route loopback）必须都改，否则生产落不了 model（FLY-493 adapter_type 同样两处，参照）。
- **fable id 一致性**:显式 `claude-fable-5` 与 fleet/pricing/token-usage 对齐,避免裸 `fable` 在某些 surface 认不出。
- **不改**:resolveRoleAdapter 优先级结构、RunnerSelectionService(legacy EdgeWorker 路径,非 Bridge dispatch)、C(dispatch 参数)。RunnerSelectionService 若也要 fable 归 phase-1b/C 一并处理(本 issue 走 Bridge dispatch 路径)。

## Part C — dispatch `model` 参数（分拣器的输出通道）【Annie 定案 2026-07-01】

**Annie 定案**:分拣器 = **Lead 本身(一个 LM、一直跟项目)在 dispatch 时用它的理解 + 那套信号(labels/标题/描述)做 holistic 判难易 → 选模型**。**不是** server 端死规则阈值、**不是**另调贵 LLM(Lead 本就在派发这步、零额外调用)。真拿不准 → Lead 问 founder。

→ 所以**代码侧 = C:`/api/runs/start` 加 `model` body 参数**(Lead 判断后从 dispatch 传模型)。**不建 server 端 heuristic 分类器**(Annie 明确要 LM 判断、不要死阈值)。

### C1. resolve ladder(最终)
`issue 手动模型标签(含 fable)` > **`dispatch model 参数(=分拣器输出)`** > `项目默认(FLY-671 roles.runner.model)` > `account(omit --model = Opus 默认)`。Annie 确认分拣器盖过项目静态默认。

### C2. `/api/runs/start` `model` 参数(镜像 ponytail/docTier 边界校验)
- 语义:`undefined/null/缺` → 无 dispatch 覆盖(走 label/项目/account);非法/未知值 → 400 `INVALID_MODEL`(机读、FLY-127 shape);合法 → 覆盖(在 label 之下、项目之上)。
- 允许集(728 内置、FLY-709 后配置化):4 档模型 id + 裸别名。归一 `fable→claude-fable-5`。
  | 档 | 模型 id | 别名 |
  |----|---------|------|
  | 难 | `claude-fable-5` | `fable` |
  | 中 | `claude-opus-4-8[1m]` | `opus`(1M 窗口选择器,标准价) |
  | 简单 | `claude-sonnet-5` | `sonnet` |
  | 很简单 | `claude-haiku-4-5-20251001` | `haiku` |
  (简单档=`claude-sonnet-5`:Annie 纠正 —— fleet 现在是 Sonnet 5、4.6 过时。id 从 pricing catalog + render-html + 系统 model-id 上下文三处核实。fleet-capabilities registry 也补了 Sonnet 5。tier→模型 709 可配。)

### C3. 集成(plumbing,镜像 docTier)
- `runs-route.ts`:校验 `req.body.model`(同步、边界)→ 归一 → 传 `dispatchModel` 进 `startDispatcher.start()`。
- `StartRequest`/`RetryRequest` 加 `dispatchModel?`;`BlueprintContext` 加 `dispatchModel?`。
- `buildRunnerSpawnFields(..., dispatchModel)` → `resolveRoleAdapter` 新增 arg `dispatchModel?`。
- `resolveRoleAdapter`:label 层后、若 label **没解析出 model**(`backend===undefined`,即无 vendor 也无 model 标签)且 role runner 且有 `dispatchModel` → `backend=claude-tmux, model=dispatchModel`;否则继续 project 层。label 有 model → dispatch 被忽略(Annie:手动标签赢)。
- 结果 model 复用 Part B `runner_model` 持久化 → 天然可见。

### C4. 分拣器 = Lead 指南(lead-rules-base,非代码阈值)
新 `packages/teamlead/lead-rules-base/model-routing.md`(镜像 `executor-routing.md` 结构、generic voice):
- 派 runner 时若 issue **无手动模型标签** → 用你的理解 + 信号(Linear size/type 标签、标题关键词、描述规模)holistic 判难易 → 选档 → 在 curl body 带 `"model": "<id>"`。
- 档→模型表(同 C2)。裸别名可用。
- 真拿不准 → 问 founder,别瞎猜。
- 手动模型标签在 = 尊重它(founder 显式选择),不覆盖。
- 校准边界 + eval-tuning = 后续精调(见 follow-up),现阶段信你的 LM 判断、不卡死阈值。

## Part D — 可见性 F/O/S/H thread 标题短码【728 scope,Annie 确认】

`[FLY-XX]` thread 标题加模型短码,搭现有 **FLY-560** thread-title badge 机制(`stage-utils.ts` + `event-route.ts stampStageEmojiForSession` → `chatThreadCreator.stampStageEmoji`)。

- 短码映射:`claude-fable-5`→**F** / `claude-opus-4-8*`→**O** / `claude-sonnet-*`→**S** / `claude-haiku-*`→**H**;account 默认(`runner_model` NULL)→ 不加短码(= 无 per-issue 覆盖的常态)。
- **放置**:做成标题**后缀**(如 `🔨实现中 [FLY-XX] title ·F`),与 stage-emoji **前缀**解耦 —— 避免 `splitStatusEmoji` 只剥单个 status-emoji 前缀的 re-stamp 逻辑冲突。stage 重刷不动模型后缀、模型不动 stage 前缀。
- 触发:session_started(模型此时已知、`runner_model` 已由 B 持久化)stamp 一次。
- 「顶端 tmux 式显示」=runner 自己 pane 已显 `--model`(现状);FLY-562 的 lead/runner 别处显示**不在本 scope**(Annie 确认)。

## Follow-up（Annie approved defer,写进 issue,非 silent phase-split）
- **校准例子 + eval-tuning**:Annie 今晚不给校准例子(她睡 + 最好先用 eval pipeline 测各模型能力再定)。分拣器先用 Lead 的 LM 判断上;档边界校准 + eval-based 精调 = 明确记录的后续。
- **tier→模型映射配置化**:归 FLY-709 dashboard(728 先用内置默认)。
- **便宜 LLM 分类器**(可选质量增强):非 Annie 方案(她选 Lead LM 判断);若将来要,作独立 follow-up。

## 部署

纯代码 + StateStore 迁移(幂等 ADD COLUMN,启动自动跑)。生效需 Bridge 重启(dashboard/event-route/StateStore/分拣器 在 boot 读);`fable` label + 分拣器解析在 runner spawn 时现读(role-adapter-resolver),Bridge 重启后即生效。Tier-3(Bridge 重启)——攒批 ship,不单独重启。
