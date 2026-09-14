# FLY-2505 恢复失败留因与分类重试 — 调研
Issue: FLY-2505 (https://linear.app/geoforge3d/issue/FLY-2505/病根-重启后-reown-的-recovery-owner-在-commit-前失败且不留原因resulttext-空-只剩通用文案两次即)
日期: 2026-09-10
基于: exploration.md

## 结论

当前失败链的确丢失已经算出的错误说明。分类重试必须同时处理四个接缝：产生点的结构化错误、恢复结果的原样透传、预算和凭据轮换的持久化身份、通用 zombie 判死竞争。改日志一处无法完成本单。历史 R2 的底层错误仍未知；任何实质性快照修正须由新增证据支持。

研究基于 checkout `d964e9fca`，未读取实时数据库、未启动/重启/拆除任何 slot。Linear 连接器未提供；任务正文作为完整 issue 输入，交叉核对已提交 FLY-2456 证据。

## 调用链与源码锚点

| 位置 | 当前行为 | 设计影响 |
|---|---|---|
| `packages/teamlead/src/bridge/plugin.ts:8144` | 构建 CodexSessionReowner，使用 StateStore、进程 owner registry、CommDB TURN | 保留真实 binding/TURN/owner 校验 |
| 同文件 `:8191` | revive 解析 immutable snapshot/current activation，准备 home，调用 runtime.resume | 这里的同步/异步 throw 也必须归一化 |
| `bridge/codex-session-reown.ts:550` | preflight→claim(maxAttempts=2)→reap→prepare capabilities→revive | claim 是实际启动前的持久化暂占；不能改成纯内存后扣数 |
| 同文件 `:688` | failPrecommit abort 后写 event/alert，忽略 abort 返回值 | 新结算必须据 CAS 成功才能退款、计次和发唯一事件 |
| 同文件 `:710` | receipt→commit→reconcile→succeeded | reconcile 抛错发生于 DB commit 后，不能退回预算 |
| 同文件 `:755` | resultText 缺失即 generic；reject 走 String(error) | 增加稳定、非空、清洗后的诊断，success-without-receipt 也失败 |
| `bridge/run-infra.ts:219,266` | 创建 recovery runtime，提交前不 emitFailed，提交后 DirectEventSink 收口 | 保存这条终态边界；统一 commit 事实，避免 wrapper 等 callback resolve 才认定已提交 |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:1050` | 比较 cwd/model/effort/framework/phase/loop target/digest/writable roots | 报 mismatch 字段名，不输出原始 prompt/凭据/路径集合，不放宽比较 |
| 同文件 `:1686,1917-1965` | caughtError→classifyGoalOutcome；失败原因只 console.error | 修复错误说明回传；cleanup 异常不能盖掉第一原因 |
| `codex-daemon-adapter-helpers.ts:175` | 异常映射 failureReason，resultText 表示 agent 文字 | 不应把 agent 最后一段文字当机器错误类别 |
| `codex-daemon-runtime.ts:596,917,961` | spawn/socket wait/cleanupAndThrow；仅确认 child+socket 已死才放锁 | 在 readiness 产生点带 code；cleanup 未确认时不免计数 |
| `codex-daemon-goal-runtime.ts:381,408` | failClose 排空后重抛 connect 错误 | 保留系统错误 code 与排空证据，不按 message 正则猜瞬态 |
| `packages/core/src/adapter-types.ts:466,518` | TerminalFailureInfo 已承载 quota/blocked/reown_exhausted | 恢复诊断用可选新字段，不扩张终态 failureKind 来表示未提交重试 |

## 持久化和消费者

`StateStore.ts:5653` 的 recovery_claim 同时承载 recovery episode 与 TURN writer mutation lease。

- `claimCodexRecovery:10577` 在 IMMEDIATE 事务里暂占次数，lease 60 秒，open episode 跨 Bridge 重启保留。
- `abortCodexRecovery:10728` 用 execution+claim_token 条件释放；releaseAttempt 可以减一，原本只用于尚未准备凭据的 fence 丢失。
- `prepareCodexRecoveryCapabilities:10850` 用 `execution:episode:episode_attempts` 构造唯一事件；同 key 再次 prepare 返回 capabilities_already_prepared。因此不能把这个字段减一后复用作凭据轮换身份。
- `commitCodexRecovery:10993` 复核 lifecycle revision、retry_successor、lease expiry、TURN；成功才增 revision 并关闭 episode。
- `claimExecutionMutationLease:10400` / `commitExecutionMutationLease:10499` 也读写这张表；后者当前关闭 episode 并清零。新预算字段不能被 TURN reconciliation 顺手清空，readiness cooldown 也不能阻挡真正的 TURN writer。
- `plugin.ts:8372` 把 reown 事件写入 events；只有 watch/succeeded 事件启动 resident receiver。失败不得伪装成功来保活。
- `run-infra.ts:230` exhausted 的失败文本目前只含“2 attempts”；需要携带 episode、最后诊断和耗尽类型。
- `plugin.ts:8918` 的 daemon orphan sweep 采用 reown candidate snapshot 与 owner registry；邻接 reap 有信号前复查，保留。
- `HeartbeatService.ts:912,1119,2044` 的 zombie/generic orphan 判死不读恢复预算。maintenance detached 运行，必须在判死前加入只读恢复 deferral；异步 forensics 后还要再检查。不得刷 heartbeat、伪造 alive 或发成功事件。
- `scripts/lib/qa-fly-2456-observe.mjs`、`qa-fly-2456-verdict.mjs` 读取既有事件和 attempt。保留旧 key 的可读性及 `reason=episode_exhausted`（计费预算耗尽）；新 reservationSeq 与 chargedAttempts 必须分开呈现。

## 独立审计得到的强约束

1. 只允许 code+stage+cleanup 证明免计，不接受模型结果文字、任意 JSON 对象或 Error.message 当授权。
2. 迟到 receipt/terminal、重复 reject、旧 token、Bridge 断电后接管均不得重复退款、重复 rotate、重开已关闭 episode。
3. 一条未确认的旧 claim 过期后按已占失败预算保守处理，不能把 crash 当已证实瞬态；新 policy 必须留下 owner_result_missing 诊断。
4. stable identity 是 executionId / episodeId / reservationSeq / lifecycleRevision；中文标签、窗口名称、自由错误文字均不是 identity。
5. task stop、人工 close、superseded、TURN 非 holder、权限拒绝路径不受免计保护；可用的停止路径不被 cooldown 阻塞。
6. SQL 参数化；诊断采用白名单字段和长度上限；错误不能泄漏 prompt、环境、token、socket 全路径或完整启动快照。

## 测试基础

- `packages/claude-runner/test/CodexTmuxAdapter.test.ts:2790` 已有 resume snapshot 和 hard receipt 测试，`:2894` 有失败 commit 排空；`:3169` 有 thrown error，但未要求回传说明。
- `packages/claude-runner/test/codex-daemon-runtime.test.ts` 可注入 spawn/socket/clock，避免真实信号。
- `packages/teamlead/src/__tests__/StateStore.codex-recovery.test.ts` 使用真实隔离 SQLite，适合原子计数、restart、凭据轮换验证。
- `bridge/__tests__/codex-session-reown.test.ts` 有 TURN/fence/exhaustion 负向测试。
- `bridge/__tests__/run-infra-codex-recovery.test.ts` 覆盖提交前不终态与提交后 DirectEventSink。
- Heartbeat 测试须使用 fake clock/probe；不能跑真实 tmux/macOS suite 来证明设计。
- 设计期依赖初始为空；offline 安装缺 @linear/sdk tarball，改用锁文件正常安装；实际检查结果单列 validation.md，不能把计划中的新测试写成已通过。

## Lead 决策

问题 `0eee842b-eb25-429d-8c67-293e0aa629e2` 已答复：同意结构化留因、3 次/15 分钟 readiness 独立持久化上限，到界 `readiness_retry_exhausted` 走现有失败收口并带结构化原因告警；不新增“等人工介入”停驻态；未知/快照/权限错误照计；reservation 单调序号同意。

本设计按已授权问题范围进入计划和正式 design review。角色注入的 DOC-FLOW 路径、review request 和 phase completion 合同优先于旧 workflow skills 中的目录搬迁、版本号修改和再次要求 brainstorm 批准的通用模板。
