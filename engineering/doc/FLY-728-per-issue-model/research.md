# FLY-728 per-issue 模型路由 — 技术调研

Issue: FLY-728 (https://linear.app/geoforge3d/issue/FLY-728/model-per-issue-模型路由-按-issue任务定模型heavyfable-smallopussonnet覆盖项目默认)
日期: 2026-06-30
基于: exploration.md

## 1. 权威 dispatch 路径的 model resolution 全链（file:line）

```
/api/runs/start                      packages/teamlead/src/bridge/runs-route.ts:85
  labels fetch + 归一化               runs-route.ts:271-285, 417 (normalizedIssueLabels)
  startDispatcher.start({issueLabels})runs-route.ts:500-518
    → RunDispatcher.start / Retry     run-dispatcher.ts:584-628 / 305-357
      buildRunnerSpawnFields(...)      run-dispatcher.ts:92-181 (调用 611 / 326)
        resolveRoleAdapter(...)        role-adapter-resolver.ts:147-209
          ├ 1 label(task)              :157-167  parseRunnerLabels → modelOverride
          ├ 2 项目 roles.runner.model  :170-176
          ├ 3 env FLYWHEEL_RUNNER_BACKEND :179-185 (仅 backend)
          └ 4 内置 claude-tmux         :188 (无 model → account 默认)
      ctx.runnerModel = resolved.model run-dispatcher.ts:132-140
    adapter.execute({model})           Blueprint.ts:1342-1358 (model @1355)
      TmuxAdapter --model 直传          TmuxAdapter.ts:683
```

**结论**: resolve 顺序 = label(issue) > roles.model(项目) > 省略(account) —— **正好是 issue 要的顺序，已存在**。layer-1 一旦从 label 定了 backend，layer-2 项目层被 `if(!backend)` 跳过 → **issue label 覆盖项目默认**（req 3 ✓）。

## 2. label→model 解析器（`packages/config/src/runner-label.ts`）

- `resolveModelFromLabels` :70-92 —— 现识别 `gpt-*-codex` / `gemini-2.5*` / `gemini-3*` / **opus / sonnet / haiku**。**无 fable**（= Gap A）。
- `inferRunnerFromModel` :94-112 —— `opus|sonnet|haiku|claude*`→claude；`gemini*`→gemini；`gpt-*`→codex。
- `parseRunnerLabels` :121-142 —— agent label 优先；纯 model label 用 `inferRunnerFromModel` 推 runnerType；agent 与 model 冲突时保 agent、丢 model（:137 guard）。

已验证:opus/sonnet/haiku label 现已端到端产出 `--model opus`（per-issue 覆盖**已能用**）。只缺 fable。

## 3. Fable 规范 id

全库统一 **`claude-fable-5`**:`fleet-capabilities.ts:58 {id:"claude-fable-5",label:"Fable 5"}`、`token-usage/pricing.ts:46`、`token-usage/render-html.ts:13 →"Fable 5"`、`ConfigLoader.ts:293` 注释。`--model` 直传（`TmuxAdapter.ts:683`）。→ fable label 解析成 `claude-fable-5` 与全库一致。

## 4. 可见性现状（Gap B）

- sessions 表**无 model 列**。model 只体现在 `adapter_type`(backend) + CLI flag。
- `adapter_type` 的持久化模式（要镜像的样板，FLY-493）:
  - `EventEnvelope.runnerBackend`  ExecutionEventEmitter.ts:23 → emitStarted payload :82
  - Blueprint 构造 envelope         Blueprint.ts:559 `...(ctx.runnerBackend && {runnerBackend})`
  - 生产 in-process 落库             DirectEventSink.ts:120-123 `adapter_type: env.runnerBackend`
  - loopback /events 落库            event-route.ts:662-711（applyTransition + upsert 两分支）
  - StateStore 列                    StateStore.ts:762 迁移 / 253,332 类型 / 1250-1330,1395-1475 upsert / 1568 patch 白名单 / 2784 getter
- dashboard 渲染:
  - 服务端 payload                   dashboard-data.ts:12-28 `DashboardSession` / :62-79 `toDashboardSession`
  - active-sessions 表 client        dashboard-html.ts:305-313（`renderActive` 行）
- 注:`adapter_type` **当前未在 dashboard 表渲染**（grep 零命中）——所以 model 可见性要**新加一列**，不是搭 adapter_type 便车。

## 5. 不碰的东西

- **RunnerSelectionService**（`packages/edge-worker/src/RunnerSelectionService.ts:137-338`）= legacy Linear agentSession webhook 路径，**非** Bridge `/api/runs/start` dispatch。有自己的 model 解析 + 默认（`getDefaultModelForRunner` :63-78）。本 issue 走 Bridge dispatch，故不改;若该路径也要 fable → 归 C/phase-1b。
- **edge config `~/.flywheel/config.json`**（`claudeDefaultModel` 等，`config-schemas.ts:184+`）喂 RunnerSelectionService，非 Bridge dispatcher。不碰。
- **resolveRoleAdapter 优先级结构** —— 已正确，不改（C 才会加最高层 dispatch 参数）。

## 6. 测试落点（已存在的文件）

- A: `packages/config/src/__tests__/runner-label.test.ts`、`packages/teamlead/src/bridge/__tests__/role-adapter-resolver.test.ts`
- B: `packages/teamlead/src/__tests__/StateStore.test.ts`、`DirectEventSink.test.ts`、`packages/teamlead/src/bridge/__tests__/event-route.test.ts`、`dashboard.test.ts`
