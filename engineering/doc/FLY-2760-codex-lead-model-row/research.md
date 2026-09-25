# FLY-2760 Codex Lead 模型行的真源与渲染链 — 调研
Issue: FLY-2760 (https://linear.app/geoforge3d/issue/FLY-2760/dashboardlead-模型行-fleet-console-把-backendcodex-app-server-的-leadmufasa)
日期: 2026-09-24
基于: exploration.md

## 1. 调研目标

1. 确认「公司 / 型号 / effort」三栏各自应该读哪个真源，以及现有代码里每个消费者的读法。
2. 找出未钉型号的 Codex Lead 的「真实型号」在进程内的最短可得路径，并核实它能否安全地暴露给 Bridge。
3. 摸清页面 `modelControl` 的写路径耦合，避免「为显示改 current」把写语义带歪。
4. 列出必须覆盖的测试台架与既有断言。

## 2. 数据流（现状）

```mermaid
flowchart LR
  PJ[projects.json<br/>backend / model? / effort?] --> TS[management-topology-source<br/>currentLeadSelection]
  PJ --> WR[management-existing-writers<br/>selectionFromLead（镜像）]
  TS --> LV[ManagementLeadView.dispatch.current<br/>model 缺席 ⇒ null]
  FP[fleetPoller.snapshot().leads[].tuning<br/>LeadConfigView] --> TS
  LV --> HTML[fleet-console-html<br/>modelControl providerLocked]
  HTML -->|value null| P0[providers[0] = Anthropic]
  HTML -->|value null| AD[型号/effort = 账户默认]
  RT[Codex runtime<br/>NativeLeadRuntimeConfig.bootstrap] -->|thread/read 得到 pair| MM{与 projects.json 一致?}
  MM -->|否: 未钉| X[bootstrap_settings_mismatch<br/>pair 丢弃, 无 operation]
  MM -->|是| OP[LeadConfigOperation → tuning]
  OP --> FP
```

## 3. 三栏真源逐一核定

### 3.1 公司（provider）

| 候选真源 | 结论 |
|---|---|
| `dispatch.current.provider`（来自注册表 model 的 `getModelRegistryEntry().provider`） | 只在钉了型号时存在 |
| `lead.backend`（`computeLeadCapabilities().currentBackend`，已在 `ManagementLeadView.backend` 投影） | **唯一对所有 Lead 都存在的来源**。`codex-app-server` ⇒ `openai`，`claude-code` ⇒ `anthropic`。`currentLeadSelection` 里已有同样的兜底表达式（`lead.backend === "codex-app-server" ? "openai" : "anthropic"`），只是被 `if (!lead.model) return null` 挡在前面 |
| 标签文案 | `flywheel-config` 的 `MODEL_PROVIDERS = { anthropic: {label:"Anthropic"}, openai: {label:"OpenAI"} }`；页面 `policyCatalog` 里另有一份内联三元式镜像（workflow 面，本单不动） |

决定：新增服务端纯函数 `leadVendorForBackend(backend: LeadBackendId): { provider, label }`，标签取自 `MODEL_PROVIDERS`，投影到 `ManagementLeadView.vendor`。页面提供者下拉按 **id 匹配** 锁定，不再取 `providers[0]`。

### 3.2 effort

| 候选真源 | 结论 |
|---|---|
| `projects.json` `lead.effort` | 两位 Lead 都是 `high`；runtime 也是从这里投影 `FLYWHEEL_LEAD_EFFORT` → `model_reasoning_effort`（`canonical-lead-identity.sh:195`、`codex-lead-runtime.ts:781`） |
| rollout `turn_context.effort` | 实读也是 `high`，与注册表一致 |

决定：`ManagementLeadView.configured = { model: lead.model ?? null, effort: lead.effort ?? null }` 原样投影，与 model 是否钉定无关。`dispatch.current` 保持不变（写路径基准）。

### 3.3 型号（model）

| 候选真源 | 对未钉 Lead 的可得性 | 安全性 |
|---|---|---|
| `projects.json` `model` | 缺席 | — |
| `CODEX_HOME/config.toml` `model =` | 两家都无此行 | 只是配置值 |
| launchd plist `FLYWHEEL_LEAD_MODEL` | 无 | — |
| `LeadConfigView.actual`（inbox `readRuntimeConfig`） | 需 operation target；runtime `isSupported()` 为 false | 有鉴权 |
| **runtime 进程内 `CodexLeadProcess.readThreadSettings(threadId)`**（`thread/read`, includeTurns:false → `thread.model / thread.reasoningEffort`） | **已在 `bootstrap()` 里调用并拿到 gpt-6-astra/high**，随后因 mismatch 丢弃 | 由可信父进程调用，非模型可控 |
| rollout `turn_context`（`readLeadTurnEvidence`） | runtime 内可读；Bridge 缺 codexHome 与路径 | 内容含模型输出 |

决定：真实型号的**唯一新增真源**是 runtime 在 `bootstrap()` 拿到的 `thread/read` 读回，落盘为 `<stateDir>/thread-settings.json`；Bridge 只读投影为 `ManagementLeadView.runtimeSettings`。文件缺席（Lead 尚未用新 build 重启）时页面显示「Codex 默认 · 未钉型号（等待运行时证据）」，绝不显示「账户默认」也绝不猜一个型号。

> 为什么不把「codex 默认」猜成注册表别名 `codex` = gpt-5.6-sol「GPT-5.6」：实读两位都在跑 gpt-6-astra，猜会猜错；且 Codex 二进制默认随版本变。

## 4. 运行时侧可得路径核实

### 4.1 `NativeLeadRuntimeConfig` 是两种 runtime 共用的

- headless：`codex-lead-runtime.ts:1728` `new NativeLeadRuntimeConfig({config, process: proc, build, log})`（`runtimeBuildIdentity` 存在时）。
- TUI：`codex-lead-tui-runtime.ts:1205` 同样构造；`wire()` 里 `await nativeConfig?.bootstrap(threadId, bootstrapTuning)`（L1512）。
- `deps.config.stateDir` 即 Lead 的 codex-lead state dir（生产 `~/.flywheel/state/codex-lead/mufasa-lead`），`LeadRuntimeConfigHost` 已在同目录写 `runtime-config.json`（`writeAtomic`，0600）。
- `bootstrap()` 顺序：`pair = readThreadSettings(threadId)` → 若 `!tuning.model || pair != tuning` 抛 `bootstrap_settings_mismatch`（catch 后只 log）。**在 `pair` 拿到之后、比对之前**是写证据文件的自然挂点。
- `onTurn` 对 `turn/started` / `turn/completed` 的处理在 `!this.ready` 时直接 return（未钉 Lead 永远 `ready=false`），所以「每轮结束后重读线程设置」需要一个独立于 `ready` 的分支。

### 4.2 线程轮换（thread rotation）

`codex-lead-thread-rotation.ts` 会换 threadId；新线程会再次经过 `wire()` → `bootstrap()`，证据文件随之刷新。Bridge 侧用 `<stateDir>/thread-id`（36 字节，生产已存在）与证据文件里的 `threadId` 比对，不一致视为陈旧证据（不显示、记 degradation reason）。

### 4.3 founder 在 TUI 里 `/model` 手改

`thread/read` 返回的是线程当前设置，`turn/completed` 后重读一次即可捕获漂移；一次 `thread/read`（includeTurns:false）开销可忽略。

### 4.4 文件 schema（v1）

```json
{ "version": 1, "threadId": "<uuid>", "model": "gpt-6-astra", "effort": "high",
  "observedAt": "2026-09-24T09:00:00.000Z", "source": "thread_read",
  "buildSha": "<artifactBuildSha>" }
```

写：`writeAtomic(join(stateDir, "thread-settings.json"), JSON + "\n")`（复用 `flywheel-comm/lead-registry-file-io`）。
读（Bridge）：`readRegularFileNoFollow`（拒绝软链接、父目录必须是真目录）+ 4 KiB 上限 + 字段白名单校验：`version===1`；`threadId` 匹配 `^[0-9a-f-]{36}$`；`model` 匹配 `^[A-Za-z0-9._\[\]-]{1,64}$`；`effort ∈ ROLE_EFFORT_LEVELS`；`observedAt` 可被 `Date.parse`；`source==="thread_read"`。任一不合格 ⇒ 视为缺席并推 `thread-settings-invalid` 到 `degradationReasons`。

## 5. Bridge 侧接线核实

### 5.1 fleet poller（`fleet-data.ts probeFleet`）

- 逐 Lead 循环里已有 `key`、`eff.backend`、`deps.readFile/fileExists`（可注入，测试友好）。
- 目前只对 Claude v2 载体读 manifest；Codex Lead 的 state dir 由 `resolveCodexLeadStateDir(projectName, leadId, root?)`（`lead-inbox-runtime.ts:1258`）解析，`lead-config-runtime-adapter` 已在用；默认 root `~/.flywheel/state/codex-lead`，先查 legacy `<root>/<leadId>`（生产命中）。`FleetProbeDeps.stateDir()` 给的是 `~/.flywheel`，所以 root = `join(stateDir, "state", "codex-lead")`。
- `FleetLeadState` 新增可选 `runtimeSettings?: { model; effort; threadId; observedAt }`。

### 5.2 快照投影

`plugin.ts:6748` 把 `fleetPoller.snapshot().leads[].tuning` 做成 `tuningByLead` 传给 `createManagementSsotProviders` → `buildTopologyView`。同一处再挂一个 `runtimeSettingsByLead`（或把 map 值改成 `{tuning, runtimeSettings}`）；topology-source `buildLead` 投影为 `runtimeSettings`。`assertManagementSnapshot` 只校验顶层字段，`ManagementLeadView` 增字段是加性变更，`MANAGEMENT_SCHEMA_VERSION=2` 不动（先例：`ManagementDagGraphLoop.name` 加性）。

### 5.3 写能力位

`leadTuningWriteCapability(backend, codexHotConfigAvailable)` 目前对 codex 只看服务是否可用。runtime 对未钉 Lead 必然 `runtime_hot_config_unsupported`（§4.1），stage 必失败。改为三参 `leadTuningWriteCapability(backend, hot, modelPinned)`：codex 且 `!modelPinned` ⇒ `{writable:false, reason:"projects.json 未钉型号：Codex 热配置无法接管，请先按受控迁移钉型号并重启"}`。两个调用点（topology-source `buildLead`、existing-writers `resolveLeadTarget`）都传 `!!lead.model`。已向 Lead 发非阻塞问题（id `bd18dcd3-9406-4315-bfb2-4c9dd5993a23`），默认按此做。

### 5.4 镜像词表合并

`currentLeadSelection`（topology-source）与 `selectionFromLead`（existing-writers）逐字相同。抽成 `bridge/lead-dispatch-selection.ts` 导出 `leadDispatchSelection(lead)`，两处 import。行为不变（model 缺席仍返回 null）。

## 6. 页面侧耦合核实（`fleet-console-html.ts`）

- `modelControl(managed,surface,label,providerLocked,selectionNullable)` 被三处调用：Lead 行（locked+nullable）、Runner 默认（not locked+nullable）、DAG 节点（workflow，非 nullable）。加第 6 个可选参数 `lock` 不影响后两处。
- `updateDraft` 用 `managed.current` 判「是否有改动」；`handleModelChange` 在 `current` 为 null 时用 `defaultSelection(surface)` = `providers[0].models[0]` 起草稿——对锁定 provider 的行也会落到 Anthropic。设计里把 `defaultSelection(surface, lockedProviderId)` 改成按锁定 provider 取首个型号（守卫写路径，即使本单把未钉 codex 行做成只读也要修，避免 Claude 行 model 缺席 + 选 effort 时同样错）。
- effort `<select>`：`effortDisabled = !writableTarget || !model`；显示配置值需要「value 为 null 但 `configured.effort` 有值」时渲染选中项。选项来源：有 model 用 `model.efforts`；否则用锁定 provider 在 lead 面所有型号 `efforts` 的并集（注册表：openai lead 面 = ROLE_EFFORT_LEVELS 全五档），并保证配置值本身在列表中（不在则按注册表拼写原样追加，避免「已退役」式静默丢失）。
- 型号 `<select>` value 为 null 时的空值选项文案由后端 `vendor.provider` 决定：`openai` ⇒「Codex 默认 · 未钉型号」；`anthropic` ⇒「账户默认」（不变）。有 `runtimeSettings` 时改为「运行中 · <注册表标签或原 id> · 未钉」，并在下方 `help` 写「型号来源：线程读回 <observedAt>；projects.json 未钉」。
- `esc()` 已覆盖 `& < > "`；所有 runtime 字段经 `esc` 再拼接。
- 既有测试：`fleet-console-html.test.ts` 用 `runInNewContext` 抠 `renderLeadRows` 并桩 `modelControl`、`leadTuningEvidence`——签名加参不破坏它；`management-console-dom.test.ts` 用 happy-dom 执行整段脚本，fixture 的 lead catalog 只有 Anthropic ⇒ 新用例要给 catalog 加 openai provider（GPT-6 Astra）；`management-console-visual-regression.test.ts` 只断 CSS。

## 7. 既有测试台架与命名

| 目标 | 台架 | 文件 |
|---|---|---|
| topology 投影（vendor / configured / runtimeSettings / 只读能力位） | 纯函数 `buildTopologyView` | `__tests__/management-topology-source.test.ts`（已有 codex 用例可扩） |
| 能力位规则 | 纯函数 | `__tests__/fleet-capabilities.test.ts` |
| 证据文件传感器 | `collectFleetSnapshot`（`fleet-data.ts:438`）+ 注入 deps | 既有 `src/bridge/__tests__/fleet-data.test.ts` 新增 describe（勘误：Round 1 评审指出该文件已存在） |
| 页面渲染 | happy-dom `Function(script)()` | `__tests__/management-console-dom.test.ts` |
| `renderLeadRows` 静态导航 | `runInNewContext` | `__tests__/fleet-console-html.test.ts` |
| runtime 写证据文件 | fake `process`（`readThreadSettings` mock）+ 临时 stateDir | `lead-backends/codex/__tests__/NativeLeadRuntimeConfig.test.ts` |

注意事项（来自记忆库）：新增 spawn/kill/shell 测试会撞四本清册守卫——本单不新增子进程；`vitest related` 对 hub 文件是整包全量，本单只跑列出的文件；跑测试排除 `**/tmux-viewer.macos.test.ts`。

## 8. 风险与边界

1. **部署时序**：层 2 依赖 Lead 进程重启；Bridge 先升级时文件缺席 → 页面显示诚实占位；runtime 先升级（不可能：同一 PR，但 Lead 重启晚于 Bridge）。旧 Bridge + 新 runtime：多出的文件被忽略。
2. **陈旧证据**：Lead 离线时文件仍在；页面同时显示在线圆点 + `observedAt`，且顶部「实际生效以进程验收为准」句保留。threadId 与 `thread-id` 文件不一致 ⇒ 视为缺席。
3. **写路径**：未钉 codex 行只读；已钉 codex 行与所有 Claude 行的写语义零变化（`dispatch.current` 未动）。
4. **不按名字特判**：全部分支只看 `backend` / `vendor.provider` / 字段有无。
5. **`policyCatalog` 内联标签镜像**：不在本单范围。
