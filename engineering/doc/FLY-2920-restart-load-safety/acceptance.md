# FLY-2920 重启与负载恢复 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

## 权威与范围

实现执行 `87e9d9d9-04a6-418e-888c-c40b4e931aaa`，run `44d7b165-f570-4b98-9bb4-6e820193bef7`，开工 TURN implement epoch 6。已通过 CLI 重读 gate `cdb373cb-c3e9-41cc-b9fb-fd829094d0a5`：有效 APPROVED；当前计划 blob `da53ca9012d3c9894d14df4f70e15ead060d55c6` 与送审内容一致。原稿页首 pending 是历史状态，不改写已批准 blob。

Lead 注入的实现裁定优先于原计划的三处 advisory：启动/过期未知窗口须关闭或有界，默认不放行；CI 用短真实采样定时器，30 秒实测留 QA；纳入 kill-path/census 与 test/QA/非 macOS 开关回归。

下表是待完成清单，不是完成声明。没有 full CI、QA、生产或 ship 证据。

| 组 / 原单 | 状态 | 决定性证据要求 |
| --- | --- | --- |
| B / FLY-2133 | 进行中 | 真实非 testMode 子进程两次 stall，存活、每事件一次取证、退出不误归因 |
| C / FLY-2617 | 源码核对 | 600ms 尾输出成功；总 deadline 与负例；两 vendor；admitted/claim 收口 |
| D / FLY-2328 | 未实现 | 原门 open、退休零 spawn、持久通知真实唤醒 parked 作者、同 request 重发一次得结论 |
| E / FLY-2323 | 未实现 | home 缺失与 home 存在/旧 PGID 空两支一次退休；换代/unknown 负例 |
| F / FLY-2620 | 未实现 | 当前快照准入/展示一致，无 sensor latch，过期/重启/失败边界与恢复通知 |
| G / FLY-2084 | 未实现 | stopped/节点绑定/本地 tip/description/ledger 连续性及真实 boot 负控 |
| 联合验证 / 交卷 | 未开始 | 相关消费者、lint/build/typecheck、有效 code review、PR、needs_review 收据 |

## C 调用方源码核对

`defaultAsyncExecFile` 当前在 exit 后另设 250ms drain timer，而成功仍要求 exit+close。下列调用方整体 deadline 必须保留；没有配置 deadline 的 helper 将使用计划规定的 90,000ms。超时不能伪称进程不存在。

| 调用方 | 当前整体 timeout | 输出合同 |
| --- | --- | --- |
| TmuxAdapter ensureRunnerSession | 单次上限90s、整轮210s，剩余预算约束 | helper JSON action/createStdout/reachablePid |
| TmuxAdapter spawn identity git | 5s | trim stdout；失败 null |
| CodexTmuxAdapter tmux/codex/gh/preflight helper | 10s | version/token/helper 输出；保留错误 |
| CodexTmuxAdapter spawn identity git | 5s | trim stdout；失败 null |
| edge-worker Blueprint 插件 readiness | 20s | exit 成功；只缓存 positive |
| edge-worker WorktreeManager | 默认120s，单次可覆盖 | stdout，错误传播 |
| teamlead ActionExecutor | 120s | stdout，错误传播 |
| teamlead fleet-console recover | 120s、16MiB | 异步退出结果，错误日志 |
| teamlead phase-branch-tip | 20s | found/missing/indeterminate，空 stdout 不能成功 |
| teamlead run-infra evidence/shell | 120s | stdout；shell 保留非零 exitCode |
| teamlead run-infra resume git | 20s、64MiB | stdout 或 null |
| teamlead workflow-docs-git | 本地30s、网络默认10s | GitResult，保留 stdout/stderr/error |

源码发现待验证：`runs-route.ts` dispatcher.start catch 直接使用 absent；`RunDispatcher.start` 的异步 blueprint promise 则走 launchOutcome unknown。须追踪同步 throw 是否可能发生在实际起体后，再以红/绿用例决定最小修改，不凭异常一律回滚。

## 本地环境

- 已执行 `pnpm install --frozen-lockfile`，成功；初次无 dist 的 workspace bin 警告属于构建前置条件。
- 开工基线 `pnpm --filter "flywheel-teamlead..." build` 成功。修改后的构建另行记录，不能继承基线结果。
- 本机仅具体相关测试文件；真实负载用受控延迟夹具，不制造宿主高负载，不操作生产数据库/服务。

B and C local evidence is recorded separately in acceptance-B.md / acceptance-C.md. D-G remain incomplete; no full-suite, QA, PR or handoff claim.
