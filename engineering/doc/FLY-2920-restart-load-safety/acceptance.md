# FLY-2920 重启与负载恢复 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

## 权威与范围

实现执行 `87e9d9d9-04a6-418e-888c-c40b4e931aaa`，run `44d7b165-f570-4b98-9bb4-6e820193bef7`，开工 TURN implement epoch 6。已通过 CLI 重读 gate `cdb373cb-c3e9-41cc-b9fb-fd829094d0a5`：有效 APPROVED；当前计划 blob `da53ca9012d3c9894d14df4f70e15ead060d55c6` 与送审内容一致。原稿页首 pending 是历史状态，不改写已批准 blob。

Lead 注入的实现裁定优先于原计划的三处 advisory：启动/过期未知窗口须关闭或有界，默认不放行；CI 用短真实采样定时器，30 秒实测留 QA；纳入 kill-path/census 与 test/QA/非 macOS 开关回归。

下表记录各组当前本地进度；局部完成不等于整个实现完成。没有 full CI、QA、生产或 ship 证据。

| 组 / 原单 | 状态 | 决定性证据要求 |
| --- | --- | --- |
| B / FLY-2133 | 本地完成 `426c5ddf0` | 见 acceptance-B.md；真实两次 stall 存活与 liveness 告警/恢复，宿主进程归因未验证 |
| C / FLY-2617 | 本地完成 `3efa4ba6d` | 见 acceptance-C.md；600ms 尾输出/总 deadline、两 vendor、admitted/claim 正负例 |
| D / FLY-2328 | 本地完成 `8e4598710`；留存补核 `b538e0638` | 见 acceptance-D.md；持久真实恢复链 8 项、同原门得结论、嵌套 repo、保护性留存 guard |
| E / FLY-2323 | 本地完成 `8ed70dc09` | 见 acceptance-E.md；A/B 一次退休、换代/race/unknown；两项 ps EPERM 与一项环境 skip 留 QA |
| F / FLY-2620 | 本地完成，待提交 | 见 acceptance-F.md 与 verification-F.json；三条 Lead 裁定、采样/缓存/短真实接线/通知均有相关证据 |
| G / FLY-2084 | 未实现 | stopped/节点绑定/本地 tip/description/ledger 连续性及真实 boot 负控 |
| 联合验证 / 交卷 | 未开始 | 相关消费者、lint/build/typecheck、有效 code review、PR、needs_review 收据 |

## C 开工时调用方源码核对（历史）

开工时 `defaultAsyncExecFile` 在 exit 后另设 250ms drain timer，而成功仍要求 exit+close。下列调用方整体 deadline 必须保留；没有配置 deadline 的 helper 将使用计划规定的 90,000ms。超时不能伪称进程不存在。

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

B–F 的检查证据分别记录在 acceptance-B.md 至 acceptance-F.md。G 与联合验证/正式代码评审/PR/交卷尚未完成。
