# FLY-2922 房间 tmux 探活隔离 — 探索
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: 无

## 问题

本轮不重新设计 FLY-2922 的产品恢复行为，也不修改统一恢复口、派发账本、complete 顺序或 carrier-close 边界。QA@3 已证明产品链路走到 generalized 529 driver 的 step 4，房内实现体也已经进入正确的 `ship_parked + rework_reachable_wait` 状态，QA 节点已经派出；停滞发生在测试台架自己的 pane 探活。

529 房间（隔离运行 Flywheel 的测试环境）把 tmux server 放在 `TMUX_TMPDIR=/tmp/flywheel-test-slot-N` 对应的 socket 命名空间。driver 清除了继承的 `TMUX` 与 `TMUX_PANE`，却没有选择房间的 `TMUX_TMPDIR`，于是 `tmux display-message` 查的是宿主 server。房内活着的 pane `@5` 被读成 dead，`classifyImplementPark` 因 liveness 不满足而永远不返回 `rework_reachable_wait`。

成功定义：所有由 generalized driver 发起的 runner pane 探活都显式进入当前房间的 tmux 命名空间；step 4 能把「实现体已 ship-parked、QA 已派出、房内 pane 仍活」分类为 `rework_reachable_wait`。错误房间、错误 execution、dead pane、畸形 target 或缺失 slot 路径仍不得被放行。

## 约束

- 只改 QA harness、定点测试和必要的里程碑说明；不改产品 `StateStore`、workflow dispatcher、恢复合同或 runner adapter。
- 先 merge `origin/main`，不 rebase；`scripts/test-deploy.sh` 的冲突必须保留两边已经批准的 CLI 合同。
- 房间坐标只来自 driver 已验证的绝对 `slotDir`，不能从宿主 ambient `TMUX_TMPDIR` 推断。
- 探活仍须同时绑定 exact tmux object、`pane_dead=0` 与 `@flywheel_exec_id`；修 socket 选择不能削弱身份校验。
- 本机只跑发现出的具体相关测试文件、lint 和受影响 build；不跑全仓或全包测试。
- 真房从 step 1 到 held → unified recovery → new dispatch 的完整证据仍属于 QA@4，不由设计或定点单测冒充。

## 方案

### A. 集中的 room-scoped probe helper（推荐）

把 tmux 调用从 driver 内联函数移到 `scripts/lib/qa-generalized-e2e-lib.mjs` 的单一 helper。helper 接收 `target`、`executionId`、绝对 `slotDir`、host env 与可注入的 spawn；复制 env 后设置 `TMUX_TMPDIR=slotDir`，删除 `TMUX` / `TMUX_PANE`，再运行原有 `display-message` 观测。driver 的 `probeExecution` 只能调用该 helper。

优点：socket 选择与观测校验在一个可单测边界；所有 driver 消费者（step 2、step 4、step 9、A3 终结、prior-run drain）共享同一语义；生产代码零改。缺点：helper 知道 slot 的 tmux 目录合同，但该合同本来就是装房的稳定输入。

### B. 用 `tmux -S` 直接拼出 socket

由 driver 计算 `/tmp/flywheel-test-slot-N/tmux-<uid>/default` 并给每次调用传 `-S`。

优点：命中的 socket 最显式。缺点：把 tmux 的 uid 子目录和默认 socket 名复制到 driver，形成第二套房间布局合同；跨平台和定制 socket 更脆。若 `TMUX_TMPDIR` 已是装房 source of truth，这一层拼接没有必要。

### C. 改变整个 driver 或 Bridge 的 ambient tmux 环境

在进程启动边界全局导出房间 `TMUX_TMPDIR`，让所有后续 tmux 调用自然命中房间。

优点：改动行数少。缺点：作用域过宽，容易让 teardown、宿主诊断或未来新增调用误用房间 server；也无法通过 helper API 强制每个探活调用携带房间坐标。拒绝。

## 选择

采用 A。`probeRoomPaneAlive` 是唯一 tmux 探活口：先验证 `slotDir` 是非空绝对路径，再验证 target 是 exact `session:@window` 或 `session:%pane` 形态；之后在复制的 env 中钉死 `TMUX_TMPDIR=slotDir`，清掉当前-client 坐标，调用 tmux，并复用 `tmuxObservationIsAlive` 校验 object id、dead bit 与 execution id。

`probeExecution` 继续把 stub pid 与 tmux pane 视为两种独立的活性证据；本轮只修正 pane 证据来自哪个 server，不改变 `pidAlive || tmuxAlive` 的聚合规则，也不改 `classifyImplementPark` 的状态判据。

## 负向守卫

1. 宿主和房间各有独立 tmux server 时，旧的宿主命名空间 probe 必须 miss，房间 probe 必须命中。
2. `slotDir` 缺失、空字符串或相对路径时抛错，不能回退到 ambient server。
3. target 不是 exact `@<digits>` / `%<digits>` 形态时返回 false，且不能 spawn tmux。
4. tmux 非零退出、pane dead、object id 不同或 execution id 不同都返回 false。
5. helper 不得修改调用方传入的 env。
6. driver 中不再直接 spawn `tmux`，防止未来绕开房间选择。
7. step 4 只有在 run node done、session ship-parked、park reason 正确、liveness alive 且 lifecycle flag 匹配时通过；「QA 已派出」不能单独替代这些证据。
8. merge main 时同时保留本单 `--qa-stub-runner` 与 main 新增的独立 CLI 选项；不得借解冲突删除任何一侧行为。

## 诚实边界

本设计修的是 QA driver 对房内 pane 的观测坐标，不是产品恢复状态机。定点测试可以证明隔离 socket 下的真假对照和 step-4 分类，但不能证明真实房间后续 step 5–9、held → unified recovery → new dispatch、真实 Claude 设计评审或两个 Lead 的拓扑全部成功；这些必须在 exact head、full CI 绿且 PR mergeable 后由 QA@4 真房运行给出。
