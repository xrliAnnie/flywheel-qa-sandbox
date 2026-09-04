# FLY-2284 slot Bridge 环境隔离 — 探索
Issue: FLY-2284 (https://linear.app/geoforge3d/issue/FLY-2284/529-房隔离-test-deploysh-起的-slot-bridge-继承调用-shell-全部-env包括生产-flywheel)
日期: 2026-09-04
基于: 无

## 问题

FLY-2248 的真实 529 房审计发现，`scripts/test-deploy.sh` 启动 slot Bridge 时只用
`env -u ...` 删除少数已知变量，没有建立正向白名单。随后
`scripts/lib/qa-slot-bridge-spec.mjs` 把 `process.env` 的剩余内容全部写入可重放的
`bridge-launch.json`。因此调用 shell 中任何未被逐个列出的变量都会成为 Bridge 及其派生进程的环境。

已观测的危险实例是生产
`FLYWHEEL_COMM_DB=~/.flywheel/comm/flywheel/comm.db` 被带进 slot 2。Bridge 本身当前按
`projectName=test-slot-2` 解析自己的 CommDB，所以该次运行没有直接写错库；但是任何直接读取
`FLYWHEEL_COMM_DB` 的派生进程都会得到生产坐标。既有 FLY-2174 修复只逐项 scrub ingest token 与
Codex inventory，无法阻止下一项未知 `FLYWHEEL_*` 变量再漏入。

## 根因证据

1. `test-deploy.sh` 的 generalized、reply-by-issue、default 三条 launch branch 都调用普通
   `env`，没有 `-i`。
2. `qa-slot-bridge-spec.mjs` 明确执行 `const normalized = { ...process.env, PWD: cwd }`，再把
   所有 key 分类为 `environment` 或 `secretEnvironment`；capture helper 没有业务白名单。
3. `scripts/__tests__/test-deploy-fly1389.test.sh` 当前主动注入
   `FLYWHEEL_NOVEL_WEBHOOK_TOKEN`，并要求它出现在 secret snapshot。这个既有期望证明未知变量会穿透，
   同时给本 issue 提供可判别的负控。
4. 现有显式 slot 坐标已经覆盖 `FLYWHEEL_STATE_DIR`、delivery secret、complete marker、reports、
   Codex homes/session/socket 和 tmux root；缺的是 launch boundary 的总白名单与显式 slot CommDB。

## 方案比较

### A. 三条 launch branch 使用 `env -i`，只重建安全基座与显式业务坐标（选定）

- 优点：未知普通变量、秘密及未来新增的 `FLYWHEEL_*` 默认全部拒绝；launch spec 继续忠实记录最终
  child env；mode-specific token 与功能 flag 仍由现有数组显式加入。
- 代价：必须列清 Bridge 真正需要的 `HOME`、`PATH` 和 mode-specific 坐标；测试要把过去的
  “完整继承 snapshot”改成“完整白名单 snapshot”。

### B. 在 `qa-slot-bridge-spec.mjs` 内过滤 `process.env`

- 优点：capture 点集中。
- 缺点：helper 不知道 generalized/reply/default 的动态 token env 与功能开关；在 capture 后静默过滤会
  隐藏 launcher 漏配，职责边界错误。

### C. 继续扩充 `env -u FLYWHEEL_...`

- 优点：改动小。
- 缺点：黑名单必然随新变量再次失效，也保留非 `FLYWHEEL_*` 的未知秘密；不能满足“任何派生进程”
  的隔离性质。

## 锁定设计

- 三条 Bridge capture branch 都从空环境启动。
- 只允许安全 OS 基座（至少 `HOME`、`PATH`）与代码中逐项声明的 slot/mode 坐标进入 capture。
- `FLYWHEEL_COMM_DB` 必须显式改写为 `test-slot-N` 自己的 CommDB，不得沿用调用 shell 的值；
  `FLYWHEEL_STATE_DIR`、`FLYWHEEL_DELIVERY_SECRET_PATH` 等现有坐标保持指向 slot 资源。
- 不新增开关，不改变 mode 选择、Bridge 命令、launch spec replay 或 teardown 协议。
- 回归在真实 `test-deploy.sh` subject execution 中给父环境注入 production sentinel，并验证初始 live
  Bridge 与 replay spec 都没有未知变量/生产值，显式坐标仍齐全。

## 明示假设

1. `${HOME}/.flywheel/comm/test-slot-N/comm.db` 是现有 Lead/Bridge 共同使用且由
   `test-teardown.sh` 按 slot 清理的 CommDB；它是 slot-owned 路径，不等同于
   `${HOME}/.flywheel/comm/flywheel/comm.db` 生产库。
2. Bridge 需要继承的 host-level 非业务变量只有安全 OS 基座；认证、Discord、Linear、runner mode 与
   QA 控制变量必须继续显式列出。
3. `qa-slot-bridge-spec.mjs` 应继续 capture 最终 child env；本 issue 修 launcher 输入，不改变 replay
   schema 或 secret-at-rest 逻辑。

## 成功判据

- 三条 launch branch 均使用正向白名单，未知环境变量不进入 spec/live Bridge。
- 父环境中的 production `FLYWHEEL_COMM_DB` 被替换为 `test-slot-N` CommDB。
- 父环境中的未知 `FLYWHEEL_*` production-path sentinel 在 spec、secret sidecar 和 live env 中均不存在。
- 现有 restart/replay full-env equality、mode-specific auth、state/secret/Codex/tmux isolation 断言继续通过。
- 无开关、无 deploy/merge、无范围外生产行为变更。
