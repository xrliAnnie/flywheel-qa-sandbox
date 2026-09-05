# FLY-2284 slot Bridge 环境隔离 — 调研
Issue: FLY-2284 (https://linear.app/geoforge3d/issue/FLY-2284/529-房隔离-test-deploysh-起的-slot-bridge-继承调用-shell-全部-env包括生产-flywheel)
日期: 2026-09-04
基于: exploration.md

## 代码路径

### 1. 父 shell 到 launch spec

`scripts/test-deploy.sh` 先 source `${HOME}/.flywheel/.env`，因此生产配置即使没有由调用者 export，
也可能在脚本 shell 内成为变量。Bridge capture 有三条分支：

1. generalized：`qa_generalized_exec_with_ingest_token ... env ... qa-slot-bridge-spec.mjs capture`
2. reply-by-issue：`env ... qa-slot-bridge-spec.mjs capture`
3. default：`env -u ... qa-slot-bridge-spec.mjs capture`

三条都只移除一组历史已知名字，其余调用环境继续存在。

`scripts/lib/qa-slot-bridge-spec.mjs` 对路径、命令、ownership PID 与 secret-at-rest 做了严格验证；验证后
直接复制 `process.env`，只删 `_`/`SHLVL`，按名字把变量写入 `environment` 或 mode-0600
`secretEnvironment`。`scripts/lib/qa-slot-bridge.sh` 的 executor 随后从这个 snapshot 重建 Bridge
环境，所以污染不仅影响初次启动，也会被 `test-cycle-bridge.sh` 稳定重放。

### 2. 当前显式 slot 坐标

`BRIDGE_EXTRA_ENV` 已经显式组装：

- `TMPDIR`, `FLYWHEEL_REPORTS_DIR`
- `FLYWHEEL_COMPLETE_MARKER_DIR`, `FLYWHEEL_LOOP_DIAGNOSTICS_DIR`
- `FLYWHEEL_DELIVERY_SECRET_PATH`
- `FLYWHEEL_CODEX_HOMES_ROOT`, `FLYWHEEL_CODEX_SESSION_DIR`,
  `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT`
- `TMUX_TMPDIR`, `FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH`
- mode-specific alerts/roundtable/report-host values
- `FLYWHEEL_STATE_DIR`

三条 branch 还显式传入端口、Lead identity、Discord token、TeamLead DB/URL、projects registry、
Linear key、runner start point 和 bin/hooks 目录。换言之，切换 `env -i` 不需要重新发明配置模型；
launcher 已经接近正向清单，只缺安全 OS 基座与 slot CommDB 显式项。

### 3. CommDB 坐标兼容性

Bridge 的主要 per-project CommDB resolver 读取 `FLYWHEEL_COMM_ROOT` / `FLYWHEEL_COMM_DIR`，否则使用
`${HOME}/.flywheel/comm/<project>/comm.db`。529 Lead 的 `claude-lead.sh` 也把
`FLYWHEEL_COMM_DB` 设为 `${HOME}/.flywheel/comm/${PROJECT_NAME}/comm.db`；teardown 按
`${HOME}/.flywheel/comm/test-slot-N` 清理。

因此本 issue 的最小一致值是：

```text
FLYWHEEL_COMM_DB=${HOME}/.flywheel/comm/test-slot-N/comm.db
```

它与 529 房既有 Lead/Bridge/driver/teardown 的 slot-owned CommDB 相同，同时确定性覆盖调用 shell 的
`${HOME}/.flywheel/comm/flywheel/comm.db`。本实现不另开第二个 CommDB root，以免 Lead 与 Bridge
分裂到两本账。

### 4. 测试承载面

`scripts/__tests__/test-deploy-fly1389.test.sh` 是合适的 runtime regression：

- `run_deploy` 从 `env -i` fixture 父环境调用真实 `test-deploy.sh`，可精确注入 production sentinel；
- stub Bridge 在 live process 内落 `bridge-env.txt/json`；
- E arm 同时读取 `bridge-launch.json`，比较 spec 与 live env，并 cycle 后比较第一次/第二次完整 env；
- 当前 `FLYWHEEL_NOVEL_WEBHOOK_TOKEN` 正向期望可直接反转为未知变量不得进入的负控；
- 当前三个 Codex production path sentinel 已证明显式 override，可扩展到 production CommDB 与所有
  `FLYWHEEL_*` 环境项的性质断言。

`scripts/__tests__/test-deploy-launch-boundary.test.sh` 适合静态防漂移：确保三个 capture site 都带
`env -i`，并确保唯一显式 `FLYWHEEL_COMM_DB` assembly 存在。静态臂不替代 runtime arm。

## 负面与失败路径

- generalized helper 先注入 `TEAMLEAD_INGEST_TOKEN`；内层 `env -i` 会清空它，所以 generalized branch
  必须在白名单环境中再次显式写入已经校验过的 slot token。缺此项时 generalized design gate 会失去
  bearer。
- 动态 bot token env name、repair bot token 与 extra-lead tokens 不能写死在固定清单中；它们继续由
  已有 arrays 逐项赋值，因此仍属于显式输入。
- `HOME` 不能改成 `/tmp/flywheel-test-slot-N`：真实 Claude/Codex/GitHub credential lookup 依赖 host
  home。隔离目标是应用坐标白名单，不是破坏 runner 认证根。
- `qa-slot-bridge-spec.mjs` 不应承担业务 allowlist；保留它对最终 child env 的完整 capture，才能让
  restart/replay 与初次 boot 字节一致。

## 验证策略

1. RED：给 E arm 的父环境加入 production `FLYWHEEL_COMM_DB`，把未知
   `FLYWHEEL_NOVEL_WEBHOOK_TOKEN` 的旧正向期望改成 absent，并要求 spec/live 中的 CommDB 为
   `test-slot-31`。当前代码应因 production value 与 novel variable 都穿透而失败。
2. GREEN：三条 launch branch 改为 `env -i` + 安全 OS 基座；加入显式 slot CommDB；generalized
   token 在 clean env 内显式恢复。
3. 聚焦：运行 launch-boundary、generalized、qa-room、fly1389 与 cycle-bridge shell tests。
4. 按 Lead 指令只运行受影响的单 package lint/build/test，且测试固定
   `VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1`；不得运行 packages-wide 命令，也不得运行
   `packages/core/test/tmux-viewer.macos.test.ts`。

## 结论

应在 `test-deploy.sh` launcher boundary 建立 fail-closed 正向环境，而不是继续给 capture helper 加
业务知识或扩充 scrub 黑名单。这个边界一次同时保护初始 Bridge、replay Bridge 与从它派生的进程；
现有显式数组提供所有 mode-specific 例外，runtime regression 负责证明未知 production 坐标真正消失。
