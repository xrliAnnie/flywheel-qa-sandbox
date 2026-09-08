# FLY-2394 Raya 切换 Astra — 调研
Issue: FLY-2394 (https://linear.app/geoforge3d/issue/FLY-2394/raya模型-切到-gpt-6-astragpt-6-astra把写死的-raya-model-常量改为可配置默认-astra并验证)
日期: 2026-09-06
基于: exploration.md

## 结论摘要

`gpt-6-astra` 是有效的 Codex 模型 slug，并支持 `xhigh` reasoning effort；本单可以保持既有 requested window 与 effort，只替换默认模型并把三者一起配置化。官方 API 模型页列 1,050,000 context，但 Raya 使用的 Codex 0.153.2 本机 catalog 把 Astra/Sol 的请求上限列为 872,000、effective percent 为 95%，生产 telemetry 的实际窗口一致为 828,400。配置的 1,050,000 因而是 per-session request，不是 receipt 必须逐字相等的 effective 值。Astra 不支持 audio input/output，也没有官方 `gpt-6-astra-realtime` 型号；Raya voice 的音频 realtime v2 继续使用 app-server 当前 realtime 实现，voice 内部的 reasoning thread 则与 brain 共用新 Codex session 配置。

真实权限探针尚未完成：生产 Raya home 的请求先撞上已知的 refresh-token-reused 401。`codex login status` 只能看到本地 auth 文件，不能代替真实请求；必须给 Raya 同账号获得隔离的新凭据后重跑一次 `gpt-6-astra` 会话，并看到模型成功回复，才能把权限记为通过。

## 官方模型证据

| 事项 | 结论 | 来源 |
| --- | --- | --- |
| 模型 slug | `gpt-6-astra` | [OpenAI GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) |
| API 模型页 context | 1,050,000 tokens | 同上 |
| Codex 0.153.2 本机 catalog | `max_context_window=872000`、`effective_context_window_percent=95`，对应 828,400；Astra 与 Sol 相同 | `~/.codex/models_cache.json`，`fetched_at=2026-09-06T23:51Z` |
| Reasoning effort | 官方页列 `low`、`medium`、`high`、`xhigh`、`max`；本机 Codex catalog 还列 `ultra` | 官方页 + 本机 catalog |
| 音频能力 | input/output audio 均不支持 | 同上 |
| 迁移策略 | 把 model 设为 `gpt-6-astra`，已有有效 reasoning effort 可保持 | [OpenAI latest model guide](https://developers.openai.com/api/docs/guides/latest-model) |
| Realtime 音频 | 官方列为独立 `gpt-realtime-*` 模型；当前公开页为 `gpt-realtime-2.1`，128k context | [OpenAI GPT Realtime 2.1 model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) |

官方模型目录与精确 slug 搜索没有出现 `gpt-6-astra-realtime`。结合 app-server 的 `thread/realtime/start` v2 形状（无 model 字段），本单不能安全增加一个未经协议支持的 realtime model env。

## Raya 代码数据流

```text
raya.env + process env
        │
        ▼
loadRuntimeEnv（file < explicit process env）
        │
        ├── brain parseConfig ── preflight / resident thread
        │
        ├── voice parseVoiceConfig ── CodexLeg / voice preflight
        │
        └── C0 probe loadProbeConfig
                    │
                    ▼
           buildThreadStartParams
                    │
                    ▼
            app-server receipt
                    │
                    ▼
           assertThreadReceipt
```

现有 `codex-session.ts` 在 builder 与 receipt 断言内部直接读取三个模块常量；brain/voice config 没有携带 session policy。配置化必须沿上图把同一对象传到底，不能让 builder 与 receipt 分别读取可变的 `process.env`。

### 受影响调用点

- `packages/contracts/src/codex-session.ts` / tests：默认值、env 解析、thread start/resume、receipt。
- `packages/contracts/src/integration-contract.ts` / tests：三个新键作为 voice optional env contract 发布；替换旧的“model options 不存在”断言。
- `apps/brain/src/config.ts` / tests：启动期解析并保存在 `RayaConfig`。
- `apps/brain/src/preflight.ts` / tests 与 `apps/brain/src/cli.ts`：显式传 session policy；preflight 输出实际 receipt model。
- `apps/voice/src/config.ts` / tests：和 brain 共用解析器。
- `apps/voice/src/codex/CodexLeg.ts` / tests、`preflight.ts`：start 与 receipt 使用同一 policy。
- `apps/voice/src/evidence.ts` / tests：context mismatch 对比配置窗口。
- `apps/brain/src/metrics.ts` / tests：汇总函数接收期望窗口，避免默认值切换后把历史 Sol 数据解释成 Astra 运行时配置。
- `probes/c0-lib.mjs`：从合并后的 env 解析相同 policy，fresh/resume/receipt 都显式传递。
- `README.md`：删除“model/effort/context deliberately not environment options”，记录三个键、默认值、回滚和 realtime 边界。

## 环境变量合同

| Key | 默认 | 校验 | 用途 |
| --- | --- | --- | --- |
| `RAYA_CODEX_MODEL` | `gpt-6-astra` | 1–128 字符；无首尾空白/控制字符；不以 `-` 开头 | thread `model` 与 receipt expected model |
| `RAYA_CODEX_REASONING_EFFORT` | `xhigh` | `low|medium|high|xhigh|max|ultra` | per-thread `model_reasoning_effort` |
| `RAYA_CODEX_CONTEXT_WINDOW` | `1050000` | 纯十进制正安全整数 | per-thread requested `model_context_window` 与 runtime evidence upper bound |

这些 key 加入 voice 的 optional-key 数组、不加入 required-key 数组，因为它们都有默认值；voice config 直接从完整 env 读取。显式 process env 仍按现有 `loadRuntimeEnv` 优先级覆盖文件，便于一次性运维回滚。

Metrics 对 context 做两层判断：单次实际 effective window 必须为正且不超过 requested window；同一 trial 的所有非空 effective window 必须一致。这样 1,050,000 请求被 clamp 到 828,400 不会制造永久告警，而 trial 内的窗口漂移仍会让 `trialWindowValid=false`。

## 真实身份权限探针

### 已执行

使用 `~/.flywheel/raya/raya.env` 指向的生产 `RAYA_CODEX_BIN`、`RAYA_CODEX_HOME`、`RAYA_CODEX_CWD`，从非交互 stdin 真起：

```sh
CODEX_HOME=<Raya CODEX_HOME> <Raya codex bin> exec \
  --ephemeral --ignore-user-config --ignore-rules \
  --model gpt-6-astra --sandbox read-only \
  --cd <Raya cwd> --json \
  "Reply with exactly RAYA_ASTRA_OK and no other text." < /dev/null
```

结果先为 401 `refresh_token_reused`，随后本机 nested Seatbelt 还报告 `sandbox_apply: Operation not permitted`。前者发生在模型准入之前。把 sandbox 改为 danger-full-access 也不能在 resident 内绕过：管理员 requirements 拒绝 exec 的 `approval=never + danger-full-access`，app-server 的 `thread/start` 则在读取 local `AGENTS.md` 时仍调用 sandbox helper。仓内既有 QA 也记录了同一 status 71 限制。因此真实回合必须在 runner 外的非嵌套环境执行；这些 resident 失败都不是 Astra entitlement verdict。

Raya auth 文件的 `last_refresh` 为 2026-08-24。发现一个 2026-09-03 的同账号 home，但 `lsof` 证明其 Codex PID 仍打开数据库，且对应 FLY-2178 resident session；直接复制/刷新会制造 shared refresh-token 冲突，已拒绝。Lead 随后要求只使用相同账号的 canonical `codex-profile` 存档：账号 id 核对一致、原 auth 已做 owner-only 备份、替换未重启生产 brain，但 live `account/rateLimits/read` 又返回 `token_expired`，说明该存档也不健康。已注册 question gate `5e38a0b7-fb78-453d-bb61-834bcde0a491` 请求全新隔离的同账号凭据或 runner 外 canary。

### 通过标准

1. 使用与生产 Raya 相同 account id 的隔离 CODEX_HOME；不输出或提交 token。
2. 真起 `gpt-6-astra` 请求，进程成功退出并返回精确 canary 文本。
3. 记录命令形状、时间、账号 hash 前缀和模型 slug，不记录 credential。
4. 再由仓库 build 后的 app-server preflight 返回 `codex.model = gpt-6-astra`，证明真实协议 receipt 与 contract 一致。

### 失败分类

- 401/refresh-token-reused：凭据陈旧，修凭据后重试，不判模型无权限。
- unknown/unsupported model 或 entitlement/plan 明确拒绝：权限未到；立即报告 Lead，并保持代码默认值不变。
- app-server receipt model 不等于配置值：contract downgrade，preflight 必须失败，不允许静默降级。

## 测试策略

1. contracts 单测先红：默认 Astra、显式 Sol override、无效 model/effort/window、receipt 对配置值。
2. brain/voice config 单测先红：默认 policy 与 env override 一致；不把 secret 暴露到 JSON。
3. callsite 单测先红：preflight/CodexLeg 把 policy 传到 thread params，错误 receipt 被拒绝。
4. metrics/evidence 单测先红：使用注入的 window 判 mismatch。
5. build 后 C0/brain/voice preflight 回归；生产凭据修复前只运行无外部副作用的单元/合同测试。
6. 全仓：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`（若 Raya 无此 script 则记录并运行仓库等价 `pnpm test`），以及新 `scripts/__tests__/*.test.sh`。
