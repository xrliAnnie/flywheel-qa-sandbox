# FLY-1643 Codex 凭据投递改型 — 设计修正
Issue: FLY-1643 (https://linear.app/geoforge3d/issue/FLY-1643/引擎bug高优-codex-适配器不向-runner-投递-output-credential-vendorcodex-的-produces)
日期: 2026-08-05
基于: plan.md

## 修正 authority

本附录是 founder 反馈后的增量 authority。它只覆盖 `plan.md` 中「精确
`FLYWHEEL_*` 白名单 + 对构造结果二次 wash」的环境投递模型;原计划的故障归因、
三个 workflow 能力必须到达 runner、execution-context provenance、launch fail-loud、
失败沿 Blueprint 形成具名 `session_failed`、Claude carrier 不变等结论继续有效。

Founder 原话:

> 「不要搞什么会过期的钥匙!谁加的?!埋这么多雷!系统要简单!」

> 「白名单拿掉!」

> 「系统设计简单!简单!简单!所有繁复埋雷的东西全删除掉!」

## 被废除的概念

- `RUNNER_ALLOWED_FLYWHEEL_ENV`:删除整张 `FLYWHEEL_*` 精确名白名单,不再要求每加
  一个显式 runner 变量就同步登记另一处。
- `spawnCodexDaemon()` 对 `buildDaemonEnv()` 构造结果再次调用
  `stripInheritedSecretEnv()`:删除这次二次 wash。调用方明确构造的值不再被下游
  重新解释、过滤或静默丢弃。
- launch 自检的「变量是否登记白名单」语义:改成检查本 execution 声明需要的
  workflow 能力是否以原值存在于最终构造环境。
- 测试不假设 credential 在一小时或任意固定 TTL 内完成;本单也不修改既有 TTL
  生成、过期、撤销或消费机制。

## 保留的器官

- **零继承原则**:`buildDaemonEnv()` 先从 host env 只提取 shell/locale/无凭据 proxy
  等安全基础变量;任何继承来的 `FLYWHEEL_*` 一律不进入 base。这是本次有意引入的
  authority 收紧,不是既有行为的延续。
- **显式构造**:runner 所需的每个 `FLYWHEEL_*` 都在 `buildDaemonEnv()` 内从常量、
  当前 `AdapterExecutionContext`、路径解析器或 Codex transport 明确写入。spawn 只加
  `CODEX_HOME`,不再二次清洗这份构造结果。
- **provenance 防污染**:三个 workflow 名在构造前无条件删除,随后只从当前 ctx
  写入;父 Bridge、嵌套 runner、测试进程或操作员 shell 的陈旧值都不能跨 execution。
- **launch fail-loud**:进入 GitHub credential/CODEX_HOME/runtime 副作用前,自检当前
  ctx 需要的 output/submission/expected 能力是否在最终 env 中且值一致;缺失或被
  transport 覆写时抛错并点名变量,由 Blueprint 形成 `session_failed`。
- OS 安全基础环境仍采用既有 allow-by-construction 集合,proxy 仍移除 userinfo,
  GitHub/Discord/Linear/DB/cloud/SSH-agent 等 host 凭据或句柄仍不继承。
- spawn 边界继续无条件移除 GitHub token 四个精确名;`buildDaemonEnv()` 的显式字段
  集合由测试锁定,替代被删除的二次 wash chokepoint。

## 修正后的单向构造

```text
process.env
  -> 仅提取安全 OS/shell/locale/proxy base(所有继承 FLYWHEEL_* 丢弃)
  -> buildDaemonEnv 显式写入当前 execution 的 runner 字段
  -> launch 自检 workflow 能力存在且值一致
  -> spawn env = 构造结果 + CODEX_HOME(不再 wash)
```

## `buildDaemonEnv` 显式字段审计

| 来源 | 字段 | 敏感性与结论 |
|---|---|---|
| 常量/本机路径 | `GATE_MARKER_DIR`, `COMPLETE_MARKER_DIR`, backend/vendor id, `COMM_CLI` | runner 控制面路径/身份;预期持有 |
| 当前 ctx 标识/路径 | `COMM_DB`, `EXEC_ID`, `ISSUE_ID`, `STATE_DB_PATH`, `PROGRESS_PATH`, `PROJECT_NAME`, `LEAD_ID`, `LAND_STATUS_PATH` | execution 范围控制面元数据;预期持有 |
| 当前 ctx Bridge 通路 | `BRIDGE_URL`, `INGEST_TOKEN` | ingest token 是 runner 本就需要的 scoped bearer;只从当前 ctx 明确写入 |
| 当前 ctx workflow 能力 | `WORKFLOW_OUTPUT_CREDENTIAL`, `WORKFLOW_SUBMISSION_CREDENTIAL`, `WORKFLOW_SUBMISSION_EXPECTED` | 本单修复对象;只从当前 ctx 写入并在 launch 自检 |
| Codex transport | `AGENT_TEAM_NAME`, `AGENT_NAME`, `RUNNER_VENDOR_ID` | mailbox 路由/可诊断身份;当前 transport 只提供这三项 |

`buildDaemonEnv()` 不显式写入 alert bot token、Linear token、GitHub token、Keychain
坐标、wrapper secret env 路径、broker socket、SSH agent 或 cloud credential pointer。
GitHub 凭据继续只落进 runner 自有 `CODEX_HOME`/git credential helper,不进进程 env。

零继承也意味着 ctx 缺少 `commDbPath`、`bridgeUrl`、`projectName`、`leadId` 等可选字段时,
不再从 parent env 补旧值;对应变量保持缺席。这个行为差异是接受的 authority 收紧:
需要这些控制面能力的路径应由当前 execution ctx 提供,缺失时由 `flywheel-comm` 等调用点
按现有机制 fail loud。`FLYWHEEL_COMM_CLI` 解析失败仍保留既有 manual fallback。

Codex 的 `shell_environment_policy` 是 process env 之后的下一跳。三个 workflow 名不命中
默认的 `*KEY*`、`*TOKEN*`、`*SECRET*` 排除模式;`FLYWHEEL_INGEST_TOKEN` 则会命中
`*TOKEN*`,所以本单不声称它能进入 model shell。process-env 单测只证明 daemon launch
这一跳;launch 自检也只是防代码 drift。真机 `consumed_at` 非空且 `node_output` 落行才是
workflow capability 的端到端证明。

## 增量实施与验收

1. 删除 `RUNNER_ALLOWED_FLYWHEEL_ENV`;让 inherited-env sanitizer 对全部
   `FLYWHEEL_*` 返回 false,保留 safe base / locale / sanitized proxy 行为。
2. `spawnCodexDaemon()` 对已传入 `opts.env` 只移除 GitHub token 四个精确名,再叠
   `CODEX_HOME`;只有调用方未传 env 的防御性路径才从 host 构造安全 base,同样零继承
   `FLYWHEEL_*`。
3. launch 自检改为 ctx→最终 env 的 workflow capability 等值校验;保留副作用前位置。
   output/submission credential 原值映射;`workflowSubmissionExpected=true` 精确映射为
   `"1"`,false/undefined 精确映射为变量缺席。
4. 测试证明:继承的任意 `FLYWHEEL_*` 全丢、显式构造的三个能力抵达最终 child env、
   transport 覆写能力会在 runtime 创建前具名拒绝、stale provenance 仍被清除、
   Blueprint 保留拒绝原文、Claude adapter 代码零改动。

## 被删除或反转的旧测试

- `KEEPS the allowlisted ingest token + non-secret FLYWHEEL_ dirs/urls/ids` 反转为
  `FLY-1643: drops every inherited FLYWHEEL_ var and keeps the safe OS base`。
- `STRIPS non-allowlisted FLYWHEEL_ secrets`、`R4: DROPS auth-capable FLYWHEEL_ vars not on
  the exact allowlist`、`R5: keeps the transport-injected Agent Team identity` 删除;它们
  都在维护已废除的继承白名单语义。
- adapter 侧不再测试「显式字段能穿过 spawn wash」;改为锁定
  `FLY-1643: authors only the reviewed runner FLYWHEEL_ environment` 的单一构造边界。
- runtime 测试直接证明显式 workflow 字段抵达 child env、GitHub token 仍被删除,并证明
  `opts.env` 缺席时不会从 parent 继承任意 `FLYWHEEL_*`。
