# FLY-2394 Raya 切换 Astra — 探索
Issue: FLY-2394 (https://linear.app/geoforge3d/issue/FLY-2394/raya模型-切到-gpt-6-astragpt-6-astra把写死的-raya-model-常量改为可配置默认-astra并验证)
日期: 2026-09-06
基于: 无

## 目标与锁定范围

Founder 要求 Raya 的 Codex 模型切到 `gpt-6-astra`。本单同时消除模型策略写死：operator 可在 owner-only `raya.env` 中覆盖模型、reasoning effort 与 context window；不配置时分别使用 Astra、`xhigh`、1,050,000。所有 thread start/resume 与 receipt 校验必须消费同一份启动期配置，实际模型不等于配置模型时 fail loud。

保留现有安全边界：模型、effort、context 仍是每个 session 的参数，`config.toml` 顶层和 profile 中出现这三项继续报错。部署、brain/voice 重启与真实 Discord 验收由 Lead 在合入后执行；实施节点只交付代码、测试、preflight 能力与独立身份权限探针证据。

## 已确认现状

- `packages/contracts/src/codex-session.ts` 把 `gpt-5.6-sol`、`xhigh`、1,050,000 写成模块常量；`buildThreadStartParams` 和 `assertThreadReceipt` 因而只能认这一组值。
- brain preflight、voice preflight、voice `CodexLeg`、C0 probe 都直接调用共享 builder；metrics/evidence 又单独 import 写死的 context window，存在配置后漂移风险。
- brain 与 voice 都先通过 `loadRuntimeEnv` 合并 `raya.env` 和显式进程环境；这是唯一适合解析新字段的边界。
- voice 的 `thread/realtime/start` v2 请求只有 thread、voice、output modality、prompt/version/transport，没有独立 model 参数。官方 Astra 模型不支持音频输入输出；官方实时音频仍是独立 `gpt-realtime-*` 产品线，没有 `gpt-6-astra-realtime`。
- 2026-09-06 用生产 Raya `CODEX_HOME` 真起 `codex exec --model gpt-6-astra`，请求在模型准入之前因 `refresh_token_reused` 401 失败；这只能证明文件凭据陈旧，不能证明 Astra 无权限。另一个同账号新凭据仍被活跃 Codex 进程占用，不能安全借用。

## 方案比较

### A. 共享解析器 + 显式 session contract（采用）

在 contracts 中定义默认值、合法值解析器和 `CodexSessionConfig`。brain、voice、probe 在读取完整 runtime env 后解析一次，再把该对象显式传给 thread builder、resume、receipt、metrics/evidence。

优点：单一真相源；默认值和 operator override 都可测试；receipt 精确对比本次配置；不依赖 import 时的全局环境；测试可以并行且不会互相污染。代价是修改调用点较多，但每处都是编译器可追踪的显式依赖。

### B. 模块加载时直接读取 `process.env`

把 `RAYA_MODEL` 改成 `process.env.RAYA_CODEX_MODEL ?? "gpt-6-astra"`。

优点是改动少。缺点是测试缓存、CLI 加载顺序和 `raya.env` 读取时机都可能让模块拿到错误值；receipt 与实际启动参数仍容易各读一次而漂移。拒绝。

### C. 只在 brain/voice 各自解析

两个 app 各自定义相同默认值和校验，再传给 contracts。

优点是局部。缺点是默认值、允许的 effort 与错误语义会复制，C0 probe/metrics 容易遗漏。拒绝。

## 推荐设计

1. 新增环境键 `RAYA_CODEX_MODEL`、`RAYA_CODEX_REASONING_EFFORT`、`RAYA_CODEX_CONTEXT_WINDOW`；均为可选，默认 `gpt-6-astra`、`xhigh`、`1050000`。
2. model 必须是非空、无首尾空白、无控制字符且不以 `-` 开头的安全 selector；effort 接受本机 Codex catalog 对 Astra/Sol 公布的 `low|medium|high|xhigh|max|ultra`；context 必须是正的十进制安全整数。错误在进程启动/preflight 前暴露。
3. `ThreadContractInput` 携带 `session`，所有 start/resume 参数由它生成；receipt 用同一个 input 的 `session.model` 校验，错误同时显示 expected 与 actual。
4. brain/voice config 都保存同一结构。preflight JSON 继续输出 receipt 的实际 `codex.model`；配置错误直接失败，绝不 fallback 到 Sol。
5. metrics/evidence 接收配置的 requested context window，不再 import 全局写死值。服务端会把 1,050,000 请求 clamp 为 catalog 允许的 828,400 effective window；监控接受正且不超过 request 的稳定 effective 值，只在 unknown、越界或同一 trial 漂移时报错，避免永久假告警。
6. realtime v2 不新增虚构 model 配置。README 明确：语音 session 的 reasoning thread 使用 `RAYA_CODEX_MODEL`，音频 realtime transport 仍由 Codex app-server v2 选择现有实时模型。

## 风险与关口

- **身份权限尚未证实**：在账号凭据修复并完成真实 Astra 回复前，不写 Astra 默认实现。已通过非阻塞 question gate 请求隔离的 Raya 同账号凭据。
- **环境回滚**：测试和文档必须证明设置 `RAYA_CODEX_MODEL=gpt-5.6-sol` 会生成 Sol thread 参数，receipt 也只接受 Sol。
- **生产配置不入 Git**：`~/.flywheel/raya/raya.env` 由 operator 修改；仓库只记录键名与示例，不记录 token 或生产值。
- **跨仓交付**：实现落 Raya 仓独立分支/PR；流程文档和 milestone 落 Flywheel 当前分支/PR。两个 head 分别接受验证和 code review，完成路由以 Raya PR 为主要实现证据并在报告列出文档 PR。
