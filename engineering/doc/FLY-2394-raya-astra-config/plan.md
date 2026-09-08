# FLY-2394 Raya 切换 Astra — 实施计划
Issue: FLY-2394 (https://linear.app/geoforge3d/issue/FLY-2394/raya模型-切到-gpt-6-astragpt-6-astra把写死的-raya-model-常量改为可配置默认-astra并验证)
日期: 2026-09-06
基于: research.md

## 1. 交付边界

本计划在 Raya 仓实现可配置 Codex session policy，并在 Flywheel 仓提交本文件夹文档和 `engineering/doc/milestones/FLY-2394.md`。不修改已 pin 的 `config.toml` 安全规则，不新增 realtime 音频 model 字段，不改生产 `raya.env`，不重启 brain/voice，不部署、不合并。

实现默认值的前置硬条件是：用 Raya 同账号、隔离且有效的 CODEX_HOME 真起一次 `gpt-6-astra` 会话并获得成功回复。若模型明确无权限，停止 Astra 默认变更、报告 Lead；若只是 401，继续按凭据故障处理，不能把它当模型 verdict。

## 2. 仓库与分支

- 流程文档仓：当前 Flywheel worktree `/Users/xiaorongli/Dev/flywheel-FLY-2394`，分支 `flywheel-FLY-2394`。
- 实现仓：从 Raya `origin/main` 创建当前 worktree 内、已被父仓忽略的 `.claude/worktrees/raya-FLY-2394`，分支 `fly-2394-raya-astra`。
- 实现完成后开 Raya PR；文档完成后开 Flywheel PR。`engineering/doc/milestones/FLY-2394.md` 必须是 Flywheel PR 的 literal last commit。
- `complete --route needs_review --target-repo .claude/worktrees/raya-FLY-2394 --pr <Raya PR>` 以代码 PR 为主要落地证据；Lead 报告同时给出文档 PR。

## 3. 数据合同

在 `packages/contracts/src/codex-session.ts` 导出：

```ts
interface CodexSessionConfig {
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  contextWindow: number;
}

const DEFAULT_RAYA_CODEX_SESSION: Readonly<CodexSessionConfig> = {
  model: "gpt-6-astra",
  reasoningEffort: "xhigh",
  contextWindow: 1_050_000,
};

resolveCodexSessionConfig(env): CodexSessionConfig
```

环境值来自 `RAYA_CODEX_MODEL`、`RAYA_CODEX_REASONING_EFFORT`、`RAYA_CODEX_CONTEXT_WINDOW`。model 只允许安全 selector 字符且长度有限；effort 使用本机 Codex 0.153.2 catalog 对 Astra/Sol 公布的封闭枚举（含 `ultra`）；window 使用纯十进制正安全整数。任何显式空值或非法值都报包含 key 的错误，不 fallback。

`contextWindow` 表示发给 app-server 的 **requested window**。Founder 要求保留 1,050,000 per-session 请求，但本机 catalog 给 Astra/Sol 的 `max_context_window=872000`、`effective_context_window_percent=95`，现有 telemetry 的实际窗口因此是 828,400。实现不得把服务端 clamp 当 downgrade：运行期接受一个正整数 effective window，只要它不超过 request；同一 metrics trial 必须只有一个非空 effective window。这样现有 828,400 为有效，trial 内真实漂移仍会失败。

`ThreadContractInput` 增加 `session`。`buildThreadStartParams`、`buildThreadResumeParams` 和 `assertThreadReceipt` 必须使用 input 中的同一个对象；receipt 错误为 `expected <configured>, got <actual>`。`assertSessionOnlyCodexConfig` 原样保留三项 forbidden key。

## 4. TDD 执行步骤

### Step 1 — Contracts：解析与默认值

**测试文件**：`packages/contracts/src/codex-session.test.ts`

先增加失败测试：

- 空 env 解析为 Astra / xhigh / 1,050,000；
- 三个 env 显式设为 Sol / high / 200000 时完整覆盖；
- model 空白、控制字符、过长，effort 非枚举，window 为 0/负数/小数/非数字/超 safe integer 时逐项报对应 key；
- 返回对象不共享可变默认引用。

运行：`pnpm --filter @raya/contracts test codex-session.test.ts`，确认因 API 不存在而红。不要在 filter 后加额外 `--`，否则 Vitest 会忽略文件过滤并跑整个 package。

最小实现 parser/default/types；再次运行同命令至绿，再用仓库 formatter 重构。

### Step 2 — Contracts：thread 与 receipt 消费配置

**测试文件**：`packages/contracts/src/codex-session.test.ts`

先修改/增加失败测试：

- 默认 input 生成 Astra、xhigh、1M；
- Sol override 同时作用于 start 与 resume；
- receipt 只接受 input 配置的 model，配置 Sol 时拒绝 Astra、配置 Astra 时拒绝 Sol，并在错误中包含 expected/actual；
- `config.toml` 顶层/profile 三项禁止规则继续通过。

运行定向测试看到参数/类型失败；最小改 builder/resume/assertion；运行至绿。

### Step 3 — Brain 配置与 preflight

**测试文件**：`apps/brain/src/config.test.ts`、`apps/brain/src/preflight.test.ts`、必要时 `apps/brain/src/cli.test.ts`

先增加失败测试：

- `parseConfig` 暴露默认 `codexSession`；
- env override 得到 Sol/high/200000；非法值在启动边界失败；
- mocked preflight 的 `thread/start` 包含配置 policy，receipt model 不匹配时报 downgrade；
- preflight JSON 仍输出实际 receipt model。

实现：`RayaConfig.codexSession` 调共享 parser；`CodexProbeConfig` 接收 policy；`cli.ts` 传入。每次只写够让当前测试变绿的代码。

运行：

```sh
pnpm --filter @raya/brain test src/config.test.ts
pnpm --filter @raya/brain test src/preflight.test.ts
pnpm --filter @raya/brain test src/cli.test.ts
```

### Step 4 — Voice config、CodexLeg 与 preflight

**测试文件**：`apps/voice/src/config.test.ts`、`apps/voice/src/codex/CodexLeg.test.ts`、voice preflight 相关测试。

先增加失败测试：

- `packages/contracts/src/integration-contract.ts` 把三个非 secret policy key 加入 `RAYA_VOICE_OPTIONAL_ENV_KEYS`，不加入 required 数组；`integration-contract.test.ts` 把旧的“without model options”断言改成明确的 optional contract。`scripts/qa/lib/env-compose.mjs` 已复制完整 `baseEnv`，测试必须证明 override 保留且 required presence check 不把 optional 误当 required；
- `parseVoiceConfig` 与 brain 使用相同默认/override/拒绝规则；
- `CodexLeg.openThread` 用配置 policy 构造请求并按配置校验 receipt；
- voice preflight 同样传 policy，返回 receipt 的实际 model；
- `thread/realtime/start` 既有请求 snapshot 保持不含 model。

实现：`VoiceConfig.codexSession`、`CodexLegConfig.codexSession` 和所有 builder/assertion 调用显式传递。voice 的 `@raya/contracts` 指向 `dist`，所以每次 voice 定向测试前必须先运行 `pnpm --filter @raya/contracts build`，再以 `pnpm --filter @raya/voice test src/config.test.ts src/codex/CodexLeg.test.ts` 这类不含额外 `--` 的命令运行至绿；stale dist 的 green 不算证据。

### Step 5 — Metrics、evidence 与 probes

**测试文件**：`apps/voice/src/evidence.test.ts`、`apps/brain/src/metrics.test.ts`、现有 probe tests。

先增加失败测试：

- `MetricsWriter` 把 configured window 当 requested upper bound：第一个正的、不超过 request 的 effective window 建立进程内 baseline；之后 null、越过 request 或偏离 baseline 才记 mismatch。已知 1,050,000 → 828,400 clamp 不告警；
- `summarizeMetrics(dir, configuredWindow)` 返回 requested 值；`trialWindowValid` 只在有样本、零 unknown、effective window 唯一且不超过 request 时为 true。测试覆盖全 828,400 为 true、828,400/272,000 混合为 false、超过 request 为 false；
- brain metrics CLI 在有 `RAYA_ENV_FILE` 时先 `loadRuntimeEnv` 再只解析 session policy，使 env-file override 生效；无 env file 时仍使用 defaults；
- C0 `loadProbeConfig` 从合并后的 env 返回 policy，fresh/resume/receipt 共用。

实现依赖注入，移除运行路径对旧 `RAYA_CONTEXT_WINDOW` 的引用。先 build contracts，再跑不带额外 `--` 的定向测试和所有 `probes/*.test.mjs` 中涉及 C0 的测试。

### Step 6 — README/operator contract

**文件**：`README.md`

更新：

- 列出三个可选 env key、默认值与一行 Sol 回滚例子；
- 说明三者始终按 session 传给 app-server，严禁写 `config.toml`；
- 删除两处“deliberately not environment options”；
- 说明 voice reasoning thread 使用同一 policy，但 realtime audio 无 Astra 变体、仍由现有 v2 transport 处理；
- 部署验收命令期待 preflight `codex.model = gpt-6-astra`，且 receipt mismatch fail loud。

### Step 7 — 真实 Astra 与回滚探针

获得隔离的 Raya 同账号有效凭据后：

1. 用 `codex exec --model gpt-6-astra` 真请求精确 canary，记录成功但不记录 token。
2. 在 Raya build 后用 owner-private 临时 env（或安全 override）运行 brain preflight，确认 JSON `codex.model` 为 Astra；同时确认实际 828,400 effective window 不产生 mismatch、summary `trialWindowValid=true`。不得动生产 launcher。
3. 以 `RAYA_CODEX_MODEL=gpt-5.6-sol` override 运行同一 contract/preflight 路径，确认 receipt 为 Sol；恢复环境后不遗留配置文件。
4. 若真实 app-server 因 Discord 外部依赖无法完成全 preflight，至少运行独立 thread/start probe并把剩余生产 Discord 回合明确交给 Lead，不伪造验收。

## 5. 回归验证

在 Raya worktree 运行：

```sh
pnpm lint
pnpm -r build
pnpm test:packages:run
pnpm test
pnpm typecheck
```

若 `pnpm test:packages:run` 不存在，保存其失败证据并运行仓库定义的等价 `pnpm test`；新增的每个 `scripts/__tests__/*.test.sh` 单独执行。本单预计不新增 shell test。

在 Flywheel worktree 仅文档变更也按节点合同运行：

```sh
pnpm lint
pnpm -r build
pnpm test:packages:run
```

## 6. Commit 切片

Raya 小提交建议：

1. `test(contracts): specify configurable Codex session policy`（首个 red test 与最小实现可在同一最终提交中，但执行日志必须先保存 red 证据）；
2. `feat(contracts): configure Raya Codex session policy`；
3. `feat(brain): pass configured Codex policy to preflight`；
4. `feat(voice): share configured Codex session policy`；
5. `fix(metrics): validate configured context window`；
6. `docs: document Astra model configuration`。

Flywheel 文档提交：探索/调研/计划/progress；最终 milestone 单独且最后。

## 7. Review 与 PR

1. 每个 meaningful batch 后更新 `progress.md`，commit Raya 代码，push 两个分支。
2. 先对 Raya exact head 用 `pnpm codex:rescue -- ...` 运行代码审查，再按 Codex author 协议：`gate review_code --no-block` → `request-review --type code --target-repo .claude/worktrees/raya-FLY-2394`（CLI 若使用不同参数，以 `--help` 为准）→ poll verdict。
3. blocking finding 必须修复并开全新 review question；APPROVED advisories 报 Lead。
4. 创建 Raya PR 与 Flywheel 文档 PR；milestone 保持 docs branch literal last commit。
5. 不请求 ship approval、不 merge、不部署。通过 `ask --report` 报两个 PR、测试、Astra 权限证据与生产验收待办；最后 `complete --route needs_review`。

## 8. 合入后 Lead 验收（不由本节点执行）

1. 把 `RAYA_CODEX_MODEL=gpt-6-astra`、`RAYA_CODEX_REASONING_EFFORT=xhigh`、`RAYA_CODEX_CONTEXT_WINDOW=1050000` 写入生产 owner-only `raya.env`（即使与默认相同也显式记录 operator 的 requested window 意图；828,400 effective clamp 是当前预期）。
2. 更新生产 Raya checkout，重启 brain；voice 下一次按既有生命周期启动，不由实现节点提前重启。
3. `pnpm raya preflight` 显示 `codex.model = gpt-6-astra`；一轮 metrics 显示唯一 effective window 828,400 且 `trialWindowValid=true`。
4. 完成一次真实 `#raya` 文字回合和一次语音回合；语音证据区分 Astra reasoning thread 与现有 realtime audio transport。
5. 临时设置 Sol override 做一次回滚 smoke，再恢复 Astra；receipt 始终对配置值生效。
