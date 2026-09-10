# FLY-2465 Codex 舰队自动切号 — 调研
Issue: FLY-2465 (https://linear.app/geoforge3d/issue/FLY-2465/2371-根治-codex-舰队级自动切号限额信号-按最早重置挑号-切-codex-重起被收的体全池打满才发-founder)
日期: 2026-09-09
基于: exploration.md

## 结论

采用 Bridge 内专用 Codex quota coordinator，消费结构化 goal 终态与一次性审查 CLI 的真实额度错误。先持久化暂停条件，再异步读取候选额度、挑号、隔离真探针、原子安装凭据，最后走现有 run 管理接口恢复。Claude 状态机、410 retired route、全局 wrapper 的自主换号退役保持原状。

Lead 已确认问题 `7bac2cb7-e969-486e-86a4-094c62088a71`：仅 registry 三号；最早 reset，同 reset 最多 remaining；失败探针零切换/零重起/一条告警。此范围已反映在 exploration.md。

## 证据基线

源码 HEAD `227058c73`，2026-09-09。Bridge /health 可读，运行 `7aec15367`，本次仅检查健康，不操作生产账号、任务或服务。旧账号切换route已退役；凭据传播是新建链接/旧家仍复制的混合形态，题面拷贝语义对旧家仍成立。

| 消费面 | 实际位置 | 本次确认的行为与设计含义 |
| --- | --- | --- |
| goal 终态分类 | packages/claude-runner/src/codex-daemon-adapter-helpers.ts:170 | usageLimited 生成失败文本；不是成功，不可改成 complete |
| adapter 返回 | packages/claude-runner/src/CodexTmuxAdapter.ts:1888 | failure 目前只有 blocked 分支附带；usageLimited 必须增加明确 failure 数据，否则下游丢失原因 |
| 核心跨包类型 | packages/core/src/adapter-types.ts:451 | TerminalFailureKind 是三值联合；新增配额失败须同时修改 normalizer 和事件传播 |
| worker 传播 | packages/edge-worker/src/Blueprint.ts:3154；ExecutionEventEmitter.ts:233,428 | failure 可沿 direct/HTTP 两路传播；两条都必须测试 |
| normalizer | packages/teamlead/src/terminal-failure-info.ts:24 | 只认现有三种 kind，environment 只认 codex:unauthorized；不能只在 adapter 增字段 |
| 直接事件 | packages/teamlead/src/DirectEventSink.ts:1332 | generalized 分支 recordEnrolledTerminalSignal 后早 return；quota 信号要在这条实际分支处理 |
| HTTP 事件 | packages/teamlead/src/bridge/event-route.ts:1333,2602,3159 | 非 generalized/generalized 多分支；统一下沉到持久化服务，不能只挂最后通知分支 |
| 终态持久化 | packages/teamlead/src/StateStore.ts:36674 | 事务写 session_events 与 session，当前 failure whitelist 会过滤新分类；需要同事务建事故/暂停记录 |
| 盲换入口 | StateStore.ts:47042 rollbackDeadWorkflowNodeExecution | 计算重试和 retry_limit_escalated，须在计数/插入新 execution 前检查 quota pause |
| 物理派发 | packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:2035 | 调用 rollbackDeadWorkflowNodeExecution；晚到的旧 dispatch intent 仍需在 claim 和物理 launch fence 再查 |
| 旧 runner 扫描 | packages/teamlead/src/bridge/runner-quota-scan.ts:29,88 | 60 分钟 cadence、Claude 识别；留作 Claude，不靠它满足 10 分钟 |
| 旧切号 route | packages/teamlead/src/bridge/account-switch-route.ts:1 | 固定 410 quota_daemon_cutover；不复活这个端点 |
| 告警消费 | packages/teamlead/src/bridge/AutoRepairBot.ts:199；infra-alert-wiring.ts | usage_limit 无可用 repair 会 needs_human；Codex 必须专用处理，避免逐具 founder 告警 |
| 告警类型 | packages/teamlead/src/LeadAlertNotifier.ts:492 | accountLimit 有 provider 和非空 scope/reset，属于 Claude 既有合同；Codex 使用独立 metadata.codexQuota，显式 vendor=codex |
| 账号真源 | packages/claude-runner/bin/codex-account-core.mjs:19,103,193 | 固定三号、JWT 身份校验；账号 label 与身份分开，未知号/符号链接不可信 |
| 现有台账 | 同文件:268+；src/codex-account-ledger.ts | 无额度字段，仅身份 observation，strict keys；不向旧 snapshot 塞新字段 |
| 手动写入 | packages/claude-runner/bin/flywheel-codex-profile.mjs:309 | 原子 use/save，0600 + fsync + rename；无真探针，无全舰队协调锁，需共享短安装临界区 |
| 统一凭据 | packages/claude-runner/src/codex-home.ts:699,790,1792,1898 | 新home建canonical链接，已有普通文件在1919继续复制并打marker；必须引用FLY-2404 drain/lease迁移作为启用前置，对真实目标home再验证 |
| resident launcher | packages/claude-runner/bin/flywheel-codex-with-fallback | exec codex 直通，无期限、无自动换号；保持 |
| 一次性审查调用 | scripts/codex-with-fallback.sh:121,161 | capture stdout/stderr，有宽泛 rate-limit 文本匹配，当前只提示手动切号；这里要加严格信号报告，不能用宽泛正则直接切号 |
| wrapper 打包 | scripts/install-codex-guard.sh:19,117,172 | 使用稳定 vendored release，新增 helper 必须纳入安装与测试，否则源码修了生产仍没接线 |
| 审查路径辨别 | bridge/review-request-coordinator.ts:4,697；review-quota-retry.ts:109 | codex_review_job 名称误导：此 coordinator 是 Codex 作者 → Claude 审查；其 429 parser 也只认 Claude，不在此修改 Codex 限额 |
| Codex 审查结果 | bridge/codex-review-ingest.ts；flywheel-comm/src/commands/codex-review-result.ts | 只 ingest APPROVED；额度失败必须是独立事件，绝不伪造 verdict 或消耗 review round |
| run 恢复 | bridge/runs-route.ts:539,595,1692,2767 | terminate 为 master-only、检查 quiescence；start 有 idempotencyKey、template/work kind/recovery 约束。必须共享已有授权和校验，不直接改 SQL 把 run 变 active |
| 巡检 | scripts/lead-patrol-snapshot.sh:310,535,1727 | STEP 2 为 pane/continuity 证据；追加 Codex 切号摘要，不能覆盖现有 degraded/FINDING |

## 本地协议与官方资料

本机 `codex --version` = `codex-cli 0.153.2`。只运行 `app-server generate-json-schema --out /private/tmp/fly2465-protocol` 导出协议，未启动账号探针。`v2/GetAccountRateLimitsResponse.json` 包含 rateLimits/primary/secondary、usedPercent、windowDurationMins、resetsAt；`v2/ErrorNotification.json` 区分 usageLimitExceeded 与 rateLimitExceeded。本机 `exec --help` 支持 --sandbox read-only、--skip-git-repo-check、--output-last-message。

官方 [Codex authentication](https://learn.chatgpt.com/docs/auth) 说明 file 凭据位于 CODEX_HOME/auth.json，且正常使用可能刷新凭据；因此隔离 home 必须显式 file store，成功后回存探针刷新过的内容，而非原始过期副本。管理员强制认证设置不能绕过。

官方 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 说明 account/rateLimits/read 获取额度，resetsAt 是秒级 Unix 时间、usedPercent 是使用比例，rateLimitsByLimitId 可携带多个额度桶。计划只使用部署协议确认的字段；不把额度窗口名称当身份，也不自动兑换 credit 或发 provider 邮件。

这些来源支持协议和认证边界，不能证明当前三个账号可用，也不能证明真实恢复已通过。设计阶段不读取/展示 auth 内容；真实正向探针由后续隔离台架提供受控证据。

## 持久化和故障分析

- 只有启动时绑定的账号身份/生成号才可归属该进程的额度错误。迟到的 business 信号不能给已切入的 school 记限额；仅加入原事故的受影响集合。
- SQLite 事务与文件 rename 不可能成为一个跨资源事务。需要 prepared/installing/committed 记录、文件身份与摘要核对，以及重启恢复；不能用「try/catch rollback」掩盖中途崩溃。
- 三个账号共享全局凭据，因此锁按 canonical credential root，不能只按 project；QA root 必须完全隔离。Bridge 有一个生产协调 writer；不新增独立常驻 daemon。
- 同账号 token 刷新不等于换号；生成号只在选择变化或新额度恢复周期上推进，token 字节变化不产生新 founder 告警。
- 普通网络/429/权限错误不证明全池耗尽。只有每个可登记账号都存在有效耗尽证据才可发「全池打满」；有失效号时由 Lead 接到「无可用凭据」的不同诊断。
- API 响应丢失时，terminate 重放相同 clientRequestId，start 重放相同 idempotencyKey。不可直接重建 intent，也不可把健康 run、人工 held、取消或已 ship 的 run 纳入自动恢复。
- 旧 FLY-2371 held 需要受控 backfill：同一 run/node/attempt 的持久化终态明确为 usageLimited，且 hold 原因为 retry_limit_escalated、无后来人工操作。缺身份只恢复可证明的历史绑定，不能从当前 active 账号倒推。

## 后续验证应覆盖

两个信号入口真实入库；一事故六具并发；事件重放与换号后迟到；所有 replacement/dispatch fence；不同 reset/remaining 排序；失效 refresh token；probe 非零/超时/假 ok/身份不符；rename 各崩溃点；手动 use 和 token refresh 竞态；terminate/start 响应丢失；review job 单独恢复；全池耗尽消息实际路由及计数；STEP 2 包含最新审计；Claude 原行为完整回归。详见 plan.md 的逐任务红绿与台架矩阵。

## R1补充审计与修订（2026-09-09）

接受两个HIGH和全部六条advisory。只读取文件形状，实测878旧execution auth=878 regular/0link，两个flywheel keyed home中eng_design=link、implement=regular。FLY-2404已明确旋转刷新链副本会互相作废，且其最终plan A4/A5保留旧家复制直到排空迁移；R1原假设不成立。计划现明确生产readiness/逐目标home守卫/迁移后跨刷新边界测试。

`account/read refreshToken:true`本地0.153.2 schema声明请求主动刷新，但仅返回身份不能证明旋转链已刷新；隔离旧副本刷新还可能使活跃真源失效。因此R2选择自动路径零outgoing回存：旧profile原字节保留，不新增有竞争残余的证明协议。旧profile若已经落后，之后需显式save/login补充，不能自动拿quarantine字节冒充可用凭据。

`workflow-dispatch-resolution.ts`提供dispatch.vendor，runs-route在admit之前可用；已创建的append-only reservation由新admission waiter记录明确承接，而非删除/悬空。巡检helper需同步converge两套FILES、first adoption、onboard whitelist、packaged seam；review helper需同步installer四套列表和flattened路径。review quota wait与重跑预算独立。完整finding→修复映射见design-verification.md。
