# FLY-2174 QA 房环境尾账 — 调研
Issue: FLY-2174 (https://linear.app/geoforge3d/issue/FLY-2174/fly-2165-尾账-3-条缺终态戳裁决-slot-membership-conflict-test-deploy-alerts-env)
日期: 2026-08-31
基于: exploration.md

## 1. 证据与基线

### FLY-2165 QA 证据

`~/.flywheel/artifacts/FLY-2165-qa/qa-notes.md` 绑定 PR #991 head `c2c972a6b75a350f1d3d539d180adc78c10c80ff`，并记录 exact-head CI 11/11 green。repair 收据显示：

- candidates: 63,914
- repairable / repaired: 63,911
- unrepairable missingTerminalAt: 3
- remainingTorn: 3
- apply wall time: 19:18.37

这证明三条缺 terminal 时间戳不是工具漏修，而是工具按设计 fail-closed；也证明生产修复必须安排维护窗，不能夹带进本实现节点。

### 当前聚焦测试基线

修改前运行：

- `bash scripts/__tests__/test-deploy-qa-room.test.sh`：18/18 PASS。
- `bash scripts/__tests__/test-deploy-fly1389.test.sh`：12/12 PASS。
- `bash scripts/__tests__/test-deploy-generalized.test.sh`：大部分检查 PASS，但 Codex stub health preflight 因当前 worktree 依赖缺少 `ws` 而有 1 个既存失败。失败发生在任何 FLY-2174 修改前，需在完整依赖安装后复验，不能把它当作本修复造成或已解决。

前两套全绿但真实 `--alerts` 仍起不来，说明测试合同有缺口，而非生产 wrapper 行为不明确。

## 2. `--alerts` identity 数据流

### 历史与漂移

alerts env 追加来自旧 commit `6a02c2555`（FLY-529）。当时 Lead 直接需要 projects file 与 bot token。

launchd-v2 carrier 后由 commit `dfc8848ba` 引入 `qa_slot_start_lead`：

- canonical projects file：`${SLOT_DIR}/q/${carrier_slot}/projects.json`
- canonical token source：`${SLOT_DIR}/q/${carrier_slot}/.env`，mode `0600`
- manifest 只应携带非 identity 的 server env，identity 项必须匹配 carrier 计算值或被拒。

旧 alerts 追加没有随 carrier 迁移删除，形成两个时代合同的叠加。

### wrapper-v2 的真实判据

`scripts/flywheel-lead-wrapper-v2.sh` 对 `launchEnvironment` 逐 key 审核：

- `FLYWHEEL_PROJECTS_FILE` 必须等于 manifest 顶层 `projectsFile` 指向的 canonical registry；旧 alerts 值指向 `${SLOT_DIR}/flywheel-projects.json`，与 `${SLOT_DIR}/q/<slot>/projects.json` 不同，所以 fail-closed。
- canonical `BOT_TOKEN_ENV` 不允许由 manifest 提供；token 只能来自 wrapper env file。

因此最小正确修复必须同时删除 alerts 对这两个 `LEAD_EXTRA_ENV` entry 的追加。只删 QA 报错中先出现的 projects-file entry 会留下下一跳 bot-token 冲突。

### alerts 行为不会丢失

alerts 分支仍会：

- 通过 `qa_room_inject_alert_into_projects` 把 `alertChannel` 与 `alertBotTokenEnv` 写进 canonical `FLYWHEEL_PROJECTS` 数据，`qa_slot_start_lead` 再写入自己的 projects file。
- 把 slot bot token 作为 `token_env/token_value` 参数传给 `qa_slot_start_lead`，由 wrapper env file 注入。
- 保留 claims、queue、dead-letter、unified alert channel 和 repair-bot Bridge env 隔离项。

删除 duplicate carrier input 不会删除 shell-side alert 所需的信息，只会恢复单一来源。

## 3. generalized ingest 数据流

### Bridge 与 Runner 的既有合同

`packages/teamlead/src/config.ts` 分别读取：

- `TEAMLEAD_API_TOKEN`：master `/api` surface
- `TEAMLEAD_INGEST_TOKEN`：`/events`、`/design-review-validation`、`/review-requests` 等 runner-facing surface

两者若 normalize 后相等，Bridge 拒绝启动。这个分权合同不能在 QA 房降级。

`packages/edge-worker/src/Blueprint.ts` 从 Bridge process env 读取 `TEAMLEAD_INGEST_TOKEN`，normalize 后作为 `bridgeIngestToken` 传入 adapter。Claude 与 Codex tmux adapter 都已经正确地只在值存在时写入 Runner 的 `FLYWHEEL_INGEST_TOKEN`。所以根因不在 adapters，修复点应在 test-deploy 的 Bridge 启动边界。

### 生成策略

generalized 房已为 master token 生成 slot-local 随机值。本修复新增独立 ingest 值：

- 仅 generalized 模式生成；普通房维持现状。
- 测试可用 `TEST_INGEST_TOKEN` 显式覆盖，默认使用与 master 不同前缀的 UUID/时间戳随机值。
- 生成后显式比较 normalized bytes；与 master 相同则在启动前拒绝。
- 日志只写 present/length，不写任何 token bytes。
- 只在 generalized Bridge launch branch 投影为 `TEAMLEAD_INGEST_TOKEN`；不放入 Lead manifest，也不写入仓库。

这会沿现有 Blueprint → adapter 路径自然生成 Runner `FLYWHEEL_INGEST_TOKEN`，无需修改 TypeScript runtime。

## 4. 测试策略

### RED 1：carrier identity ownership

扩展 `scripts/__tests__/test-deploy-fly1389.test.sh` 的 wrapper stub，使它模拟真实 wrapper 对以下项的判据：

- `FLYWHEEL_PROJECTS_FILE` 必须等于 manifest 顶层 `projectsFile`。
- `BOT_TOKEN_ENV` 不得出现在 `launchEnvironment`。

新增 hermetic `--alerts` deploy 用例：stub Discord GET/POST/DELETE，启动真实 test-deploy composition，断言 Lead 越过 carrier、manifest 不含 bot token、projects file 是 canonical `q/<slot>/projects.json`，且 Lead runtime 最终仍能看到 projects file 与 bot token。

该用例在生产代码修复前应因 `identity_launch_env_conflict` 失败。

### RED 2：generalized ingest split

在 generalized test surface 增加断言：

- generalized token setup 生成独立 ingest token，并在相同 override 时 fail-fast。
- generalized Bridge branch 显式携带 `TEAMLEAD_INGEST_TOKEN`。
- test-deploy 的 live Bridge env 断言该 token 存在且与 master 不同；诊断不包含 token bytes。

优先复用 `test-deploy-fly1389` 的 live `bridge-env.txt`，若 generalized fixture 的其他 readiness 依赖过重，则用现有 `test-deploy-generalized.test.sh` 的 shell seam 直接执行 token setup/launch composition，而不是只 grep 一行源码。

### 既有回归

- 更新 `test-deploy-qa-room.test.sh`：Lead alerts env 仍含 alert isolation vars，但不再声称 projects-file/token 必须由 `LEAD_EXTRA_ENV` 注入；改为断言这些 identity key 不在 extra env，同时 canonical projects JSON 仍引用正确 token env。
- 运行 fly1389、qa-room、generalized 全套。
- full repo gates 按节点合同执行。

## 5. 明确不采用的方案

- 不放宽 wrapper-v2 identity 检查：那会把测试脚本漂移变成生产 identity ambiguity。
- 不让 ingest token 复用 master token：Bridge 配置本来就拒绝，且会破坏最小权限。
- 不直接修改 adapters：它们已按正确合同投影凭据，修改会掩盖 Bridge 启动 env 缺口。
- 不把 slot ingest token 落进 room-info 或普通日志：Runner 由 Bridge 投影即可，额外载体扩大 secret 表面。
- 不在本 PR 执行生产 repair、伪造三条 terminal 时间戳或调度停服窗。
