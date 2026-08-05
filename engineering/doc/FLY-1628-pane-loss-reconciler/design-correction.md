# FLY-1628 pane-loss reconciler — 设计修正
Issue: FLY-1628 (https://linear.app/geoforge3d/issue/FLY-1628/pane-loss-reconcilertmux-体已灭但-commdb-仍-runningparked-全量重启会成批制造现无任何)
日期: 2026-08-04
基于: plan.md

## Founder 原话

> “我们为什么会有十来个守护机制?画个图给我看看?这个听起来已经是个问题了”

> “你确定出生时间是UTC吼 不要又搞出换了时区就gg这种设计”

> “OK 确定不要把系统搞得太复杂”

## 本轮修正结论

不新增 watchdog、timer、daemon 或独立调度循环。pane-loss 只是现有 `ResidueHarvester` 的一个 face；DAG 卡死恢复只是扩充现有 `WorkflowEngineDispatcher` 的 dead-exec / rework 谓词。机制数量不增加。

### 已弃用的概念

1. **“每个事故再加一个守护进程”**：弃用。FLY-1628 不创建新 service、interval 或 scheduler。
2. **“`running|parked` 且 target missing 就一律改 `orphaned`”**：弃用。target 缺失本身不是死亡证明；Codex、legacy row、同代 tmux server 都 fail-closed。
3. **“用 Bridge 墙钟/ISO 日期判断 tmux 是否重生”**：弃用。任何 locale、时区或夏令时格式都不进入 generation 比较。
4. **“重启后自动重派全部失联 session”**：弃用。普通 session 只落状态、说明和恢复提案；重派仍需 Founder/Lead 动作。唯一自动 successor 是已经由 DAG engine 拥有、且旧 actor 已有不可逆终态证据的既有 workflow 恢复职责。
5. **“给 restart-services.sh 塞一套第二账本 reconciler”**：弃用。重启脚本不复制 Bridge 的状态机和事务逻辑。

### 保留的器官

- `ServerLossCoordinator`：先判定整服事故/hold，避免 server down 时批量误杀。
- `ResidueHarvester`：复用现有 boot debt + 周期巡检调度；pane-loss 是 face，不是新 loop。
- `pane-loss-reconcile.ts`：只负责 generation-fenced 证据判定、既有 FSM 转换、通知债务。
- `WorkflowEngineDispatcher`：复用现有 dead-exec rollback 和 rework replacement，恢复 engine-owned DAG 节点。
- `TmuxAdapter` launch fence：在 runner 真正 `exec` 前持久化物理 tmux generation。
- issue-thread notification + existing alert fallback：Founder 能看见发生了什么；不创建第二通知系统。
- existing wake terminal guard：已转出的 dead body 不再进入 `wake_failed` 噪音循环。

## tmux 出生时间：字段、格式与比较证明

generation key 是以下两个 tmux 原生字段的 tuple：

| 阶段 | 命令/字段 | 持久化格式 |
| --- | --- | --- |
| window 创建 | `tmux new-window -P -F '#{window_id}|#{socket_path}|#{start_time}'` | `window_id=@<digits>`；`socket_path` 非空原始路径；`start_time=^[0-9]+$` |
| StateStore | `session_params.pane_loss_generation` | `{"socket_path":"…","server_start_time":"<decimal epoch seconds>"}` |
| reconcile 重读 | `tmux -S <socket_path> display-message -p '#{start_time}'` | `trim()` 后必须仍为 `^[0-9]+$`，否则 `indeterminate` |
| 比较 | `current.startTime === recorded.server_start_time` | 同一 tmux format variable 的十进制字符串逐字节相等 |

`#{start_time}` 是 tmux 3.5a 暴露的 server start time（POSIX `time_t` 的 Unix epoch 秒数）。它是 kernel clock 提供的绝对数值，不含时区、locale、日期字符串或 DST。代码两边读取同一个 tmux format variable，不经过 `Date`、ISO 格式化或本地时区转换。2026-08-04 本机只读核验得到 `#{start_time}=1785861462`，值为纯十进制；`man tmux` 将该字段定义为 `Server start time`。

因此切换 `TZ`、机器时区或夏令时不会改变 tuple。若任一字段缺失、非十进制、socket 无法读取，结论是 `indeterminate`，不会终态化 session。

## 两个生产验收锚点

### FLY-1572 / run `d0bc75a4…`

- 节点：`implement@1`，账面 `running`
- actor：`11e95f4a-9458-4d34-9d0c-c0f0957d103d`，StateStore 已 `terminated`
- 现场：CommDB target missing、execution marker missing、host process missing
- 修正：现有 generalized dead-exec probe 在 terminal-session 调用域内把三重 absence 判为 `dead`；原有 rollback 事务 mint successor attempt。任何 CommDB read error、marker ambiguity 或 host process presence 都保持 `unknown`。

### FLY-1596 / run `9c785ed9…`

- 节点：`implement@2`，`pending` 且仍 pin 到旧 actor
- actor：`695938e5-7284-4fcb-9a7c-b0e05580c94b`，StateStore 已 `terminated`
- delivery：run `held`，`last_error=persisted_target_missing`
- 修正：现有 workflow rework pass 只对这一个精确 held shape 做 liveness proof；`dead` 后在一个 StateStore transaction 内把 run 解冻、delivery 转 `replacement_pending`、route 改为 fresh execution，再走原有 fenced dispatch。`alive|unknown` 零 mutation。

## 简化后的验收

1. 重启后一个现有 residue/workflow reconcile 周期内，证据充分的 dead actor 离开 `running|pending|parked` 卡态。
2. live、同 generation、indeterminate、Codex daemon-uncertain 四类都不被误转。
3. 普通 runner 只说明 + 恢复提案，不自动重派；engine-owned DAG 只沿既有 successor 事务恢复。
4. 已终态 body 不再被 wake，`wake_failed` 不重复制造。
5. 新增独立守护机制数量：**0**。
