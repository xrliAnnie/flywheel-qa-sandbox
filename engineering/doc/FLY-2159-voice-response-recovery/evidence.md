# FLY-2159 真上游相关性 — 验证证据
Issue: FLY-2159 (https://linear.app/geoforge3d/issue/FLY-2159/raya语音上游-打断后-attributed-user-final-间歇性等不到-assistant-final装机-schema-无)
日期: 2026-08-31
基于: plan.md

## I5: true-upstream response.create correlation

- 结果: **PASS**
- 模型: `gpt-realtime-1.5`
- 稳定探针名: `realtime_recovery_rejection_event_id_probe`
- 唯一一次执行即命中;未使用重跑。
- 第一条请求在收到 `response.created` 前不做第二次发送;收到后立即发送第二条带唯一客户端 event id 的 `response.create`。
- 上游返回 `conversation_already_has_active_response`,且嵌套 `error.event_id` 精确等于第二条请求的客户端 event id。

执行命令(密钥仅由 `RAYA_OPENAI_API_KEY` 注入为进程内 `OPENAI_API_KEY`,未写入证据):

```sh
cargo test -p codex-api realtime_recovery_rejection_event_id_probe -- --ignored --nocapture
```

三态规程:

- PASS:观测到 active-response 拒绝,且嵌套 `error.event_id` 精确命中被拒请求。
- FAIL-and-redesign:观测到拒绝但 id 缺失/不匹配;停止实施并重新设计。
- INCONCLUSIVE:第一响应过快完成、未观测到拒绝;只允许在手动探针中以更长首响应有界重跑。

归档:

- `evidence/i5-true-upstream-frames.jsonl`:仅含按线序排列的原始请求/响应 WebSocket 帧;SHA-256 `d74c4b7f9ae1b076bf4fc0aa95e4900fffd9e7a9f4ca816ff911283040960b92`。

## I1/I2: true app-server binary shapes

探针使用真实 `codex app-server` 进程,完成 experimental initialize 与真实
`thread/start`,随后在未启动 realtime 的 thread 上发送
`thread/realtime/createResponse`。为避开当前 runner 的嵌套
`sandbox-exec` 限制,probe 显式传 `environments: []`;该 thread 不执行模型调用、工具或
Realtime 连接。

- I1 **PASS**:补丁 aarch64 0.151.0 先以 id=3 返回 `result: {}`,随后发出无 id 的
  `error` 通知,消息为 `conversation is not running`。
- I2 **PASS**:装机官方 0.151.0 对同一方法以 id=3 返回
  `-32600 Invalid request: unknown variant thread/realtime/createResponse`。
- 补丁 binary:
  `codex-rs/target/aarch64-apple-darwin/release/codex`;Mach-O arm64;SHA-256
  `20127648b0eb79e8a62f8282d762724c9ef2f5ba7dab32ed32050d077a5ef8ce`。
- 可复现 harness: `evidence/run-i1-i2.mjs`。
- I1 trace: `evidence/i1-patched-binary.jsonl`;SHA-256
  `bf3149acc92453344250412216a9cd76d07e8c1541f3695c3d3cd8721f1b6e49`。
- I2 trace: `evidence/i2-official-binary.jsonl`;SHA-256
  `7c77a5e3a116569bf4fd85b4426fd8fb4c88c98c6a737351be9766749bb4a8e6`。

## I3/I4: isolated Raya voice room

- 结果: **PASS**
- round: `bot-experience-20260831-r23-fly2159`
- final bootId: `9d407707-4d09-42f6-992e-c3a1edc5bc7f`
- Raya dist commit: `d3d5f9b`
- Codex binary commit: `ca3bcfa6`

证据边界:I3/I4 是正常回答路径与 65 秒无迟发恢复的**回归证据**,不是补丁能力已
加载的正向控制。归档事件没有记录 Codex binary SHA,因此不能只凭该轮证明运行进程
使用了上述补丁;补丁方法的存在、官方二进制的 fail-open 差异和真上游相关性分别由
带 binary SHA 的 I1、I2 与 I5 证明。后续重跑应先增加进程级 build provenance 或
显式正向控制,再把隔离房轮次用于补丁加载证明。

当前 Raya 对 `needsDecision=false` report 按产品设计只走文字 fallback,所以旧 R16
runner 的 no-cutoff item 不能再作为 spoken readback。最终取证 harness
`evidence/run-i3-i4.mjs` 不改产品代码:先等待新 boot 的
`voice-session.lastLiveAt` 证明 realtime live,再注入 QA-only
`needsDecision=true` spoken item,完成念读后播放 QA bot 固定音频。

结果:

- spoken readback: `ackHow=spoken`;84 个 audible frame;持续 2,680ms;最大静音间隔
  297ms。
- attributed QA user final:
  `u-9d407707-4d09-42f6-992e-c3a1edc5bc7f-2`。
- assistant final:
  `a-9d407707-4d09-42f6-992e-c3a1edc5bc7f-3`;延迟 1,808ms。
- text mirror:4 条新消息,包含 user、thinking、assistant 精确镜像。
- 正常轮 `response_recovery_attempted/result/suppressed/unavailable` 均为 0。
- assistant final 后静默窗口 65 秒;无迟发 recovery。
- clean exit:`last-human-left`,code 0。
- audio counters:`sent=4122`,`voice=1202`,`silence=6284`。

归档:

- `evidence/i3-i4-r23-events.jsonl`;SHA-256
  `4ca816231ff8cfeea3bd5c5e6c47d45d8703dd6a457d0513cdb18cf5b72ab1a6`。
- `evidence/i3-i4-r23-result.jsonl`;SHA-256
  `dec13d371bc8fef7e0a9b366b3df54e537dbd5d325eda5fe6161c00e4094f066`。

## 交付对象

- Flywheel 锚 PR:[xrliAnnie/flywheel#1004](https://github.com/xrliAnnie/flywheel/pull/1004)。
- Raya 伴生 PR:[xrliAnnie/raya#10](https://github.com/xrliAnnie/raya/pull/10),head `d3d5f9b`。
- Codex fork 伴生 PR:[xrliAnnie/codex#1](https://github.com/xrliAnnie/codex/pull/1),draft head `ca3bcfa6`,fork-only base `fly-2159-rust-v0.151.0-base`(钉在 `78c29080`;真实 diff 19 文件);只供内部补丁审阅,merge 需 founder 单独授权,未经明确决策不得向 `openai/codex` 提交上游 PR。
- Codex 构建 provenance:tag object `d8673cb68e349c208659b986697773d3145dbb14`,peeled source commit `78c290807ce710180111df227df3b7a4fe845452`。

## 实施门禁

### Raya

- `pnpm lint`:PASS。
- `pnpm build`:PASS。
- `pnpm test`:PASS(62 contracts + 342 voice + 125 brain)。
- `pnpm test:qa`:PASS(94)。
- `pnpm typecheck`:PASS。

### Codex fork

- `cargo fmt --all -- --check`:PASS。
- `just fix -p codex-app-server-protocol -p codex-api -p codex-core -p codex-app-server`:PASS。
- `cargo test -p codex-app-server-protocol`:PASS(296;1 ignored)。
- `cargo test -p codex-api`:PASS(168 unit;1 ignored,另含集成套件)。
- recovery core 目标测试:PASS(7)。
- app-server create-response 目标测试:PASS(5,串行)。
- `just test`:全 workspace 编译完成;随后本机 `cargo nextest` inventory 阶段无输出且不返回,独立 `cargo nextest list` 可复现。该环境限制不伪报为 full-suite PASS;目标套件与真实 I1/I2/I5 证据均已通过。

### Flywheel 锚仓

- `pnpm lint`:PASS(只有基线 Biome warning)。
- `pnpm -r build`:PASS。
- `pnpm test:packages:run`:执行完成;高并发轮出现与 FLY-2159 无关的 macOS Terminal automation sandbox 失败及 TeamLead 5 秒超时。按包降并发复跑得 747 files / 9,879 tests PASS,仅 3 个同类超时;3 个失败用精确文件隔离复跑 26/26 PASS。该分支只改流程文档、证据和 harness,没有 Flywheel runtime 代码。
- `node --test evidence/readers.test.mjs`:PASS(4),覆盖 torn JSON、torn JSONL tail、完整坏行与缺失文件。
- `git diff origin/main --name-only` 没有新增 `scripts/__tests__/*.test.sh`,因此无新增 shell test 待执行。

## Review 运行时说明

按实现节点合同调用 `codex:rescue` 同源 `codex-companion` 只读 review;当前托管 Codex runner 在初始化内层 macOS sandbox 时被 `sandbox-exec: sandbox_apply: Operation not permitted` 拒绝,尚未读仓库即退出。此项不记为 review PASS;独立跨模型 code-review gate 另行登记并以其结构化 verdict 为准。

正式 code-review gate `7310f70f-115f-47ac-91dc-da18d39c8d0e` 对 head
`aae3802a5` 的结构化 verdict 为 **APPROVED**,无 HIGH/阻断发现。收口时已处理可在
批准范围内直接修正的 advisories:founder artifact 最终规模与命名、I1/I2 最小权限与
进程/临时目录清理、I3/I4 torn-read 与失败落盘、I3 正向控制证据边界。两项协议建议
(成功响应后回收 server recovery id、按稳定 `error.code` 而非 message prefix 判拒绝)
会改变已批准的相关性语义,保留为后续设计项,本轮不暗改。
