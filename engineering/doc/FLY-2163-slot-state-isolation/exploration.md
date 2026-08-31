# FLY-2163 slot Bridge state 隔离 — 探索
Issue: FLY-2163 (https://linear.app/geoforge3d/issue/FLY-2163/529隔离漏-slot-bridge-不隔离-flywheel-state-dir测试房覆写了生产-meta-alert-文件134502)
日期: 2026-08-30
基于: 无

## 问题与边界

529 测试房承诺把 Bridge 的端口、StateStore、项目表和运行状态限制在
`/tmp/flywheel-test-slot-<N>`。当前 `scripts/test-deploy.sh` 已把
`TEAMLEAD_DB_PATH`、`FLYWHEEL_DELIVERY_SECRET_PATH`、complete marker、loop diagnostics、
tmux socket 与 founder consent audit DB 指向 slot，但 `BRIDGE_EXTRA_ENV` 没有覆盖
`FLYWHEEL_STATE_DIR`。因此启动脚本会把 runner 进程继承的生产值继续传给房内 Bridge。

这不是 meta-alert 自身的目录选择错误。`MetaAlertNotifier`、shell `meta-alert.sh` 和其他
state writer 都按 `FLYWHEEL_STATE_DIR` 工作；错误发生在租户启动边界没有注入 slot 值。
FLY-2149 的目录收敛不能替代这一隔离修复。

本单只修复 529 房的 Bridge 启动边界及其回归证明：

- Bridge 必须收到 `FLYWHEEL_STATE_DIR=${SLOT_DIR}`，无论是否传 `--alerts`、是否
  `--generalized`、是否 `--no-lead`。
- Lead 已在 launchd manifest 中收到自己的 `${SLOT_DIR}/q/<carrier-slot>`，本单不改这条
  per-Lead 隔离。
- 不改 `getStateDir()`、MetaAlertNotifier、告警路由或生产目录结构。
- 不新增开关、配置项、helper 或依赖。

## 现状证据

`scripts/test-deploy.sh` 只有三组 Bridge 启动分支，但都统一展开 `BRIDGE_EXTRA_ENV`；因此
在所有动态 helper/token 项组装完、启动 Bridge 前追加最后一项即可覆盖所有房型，并利用
`env` 的 later-wins 语义压过任何同名动态输入。仓库的主约定把 `FLYWHEEL_STATE_DIR` 当作
`~/.flywheel` 根，消费者再自行追加 `state/`、`manifests/`、`bin/` 等子目录；`SLOT_DIR`
正是房内的 `~/.flywheel` 对应物，所以不能把变量误设为 `${SLOT_DIR}/state`。

当前 `scripts/__tests__/test-deploy-generalized.test.sh` 只钉住 Lead manifest 的
`FLYWHEEL_STATE_DIR=${state}`，没有检查 Bridge 数组，也没有让真实 state writer 在
“继承生产值 + slot 覆盖值”的环境中落一次文件。因此现有测试允许本缺口长期假绿。

## 验收口径

动态阳性对照使用临时目录模拟生产 state，不触碰真实 `~/.flywheel`：先让子进程继承
`FLYWHEEL_STATE_DIR=<fake-production>`，再展开从 `test-deploy.sh` 抽取的 Bridge state
assignment，调用真实 `scripts/meta-alert.sh` 写一个唯一 reason。通过条件是：

1. `${slot}/meta-alert/<reason>.txt` 存在且正文含唯一探针内容；
2. fake production state 的文件清单和内容摘要前后完全一致；
3. Bridge state assignment 缺失时，测试在安全的 fake production 下复现旧行为并失败。

## 假设

- 529 房的所有 Bridge state writer 都应共享 `${SLOT_DIR}`；这是租户根，而不是
  只为 meta-alert 增加的专用目录。
- `BRIDGE_EXTRA_ENV` 是三条 Bridge 启动路径的单一注入点，最小修复应在这里完成。
- 回归测试应保留在已有 generalized shell suite 中，避免新建重复 harness。
