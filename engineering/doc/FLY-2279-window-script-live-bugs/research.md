# FLY-2279 窗口脚本真机竞态修复 — 调研
Issue: FLY-2279 (https://linear.app/geoforge3d/issue/FLY-2279/2274-followup-窗口脚本三处真机-bugupdater-loaded-前置与预卸冲突-卸载后零等待判定竞态-verify-的)
日期: 2026-09-02
基于: exploration.md

## 权威输入

- 仓库基线：`63154c214a82ace4c2273c24e6e66cf0157af392`（FLY-2274 合入 main 的 merge commit）。
- 真机 checklist：`~/.flywheel/state/FLY-2264-window/operator-checklist.md`，明确记录 updater 在
  11:42 PT 已卸，并在 §5.5 restore 之后、§6 发票之前才重新 bootstrap。
- 真机临时修补：`~/.flywheel/state/FLY-2264-window/artifacts/bootout-supervisors.sh` 将 19 次
  bootout 与最多 60 秒逐项等待分成两轮；同目录 verifier 对四个 `lstart` 读取点补了尾空格去除。
- 真机 seat workaround：`~/.flywheel/state/FLY-2264-window/window-step-7-seat.sh` 明记
  `pgrep -P` 会隐藏调用者祖先，因此从临时 native tmux 中立座位执行。中立座位产出的
  `05-lead-health.json` 为 pass，16 个 Lead 与其代表 child 都有 native 证据。
- 写侧合同：`scripts/flywheel-cmux-sync.sh::_process_incarnation` 已用
  `sed 's/^[[:space:]]*//;s/[[:space:]]*$//'` 规范化 owner 的 start identity。
- 真机 verifier artifact：临时补丁脚本 mtime 为 18:17:12，随后 18:17:42 产生的 `06-cmux.json`
  仍是 `status=fail, exitCode=1, error=""`；因此尾空格补丁只能证明一个根因，不是 cmux producer
  整体通过的阳性证据。本次只读复查 `flywheel-cmux-sync.sh --verify-sidebar --json` 返回
  `sidebar-snapshot-unavailable: first snapshot could not be proven`，说明下游已有可用原因，但上层裸
  `return 1` 会丢失它。
- macOS 本机 `pgrep(1)` 明确说明默认排除当前进程及全部祖先，`-a` 才包含祖先。该规则同时影响
  `pgrep -P` 的 Lead child discovery 与 `inventory_tmux_servers` 的 `pgrep -x tmux`。

## updater 两态安全合同

### 当前行为

`scripts/cutover/FLY-2264/lib/launchd-window.sh::fly2264_assert_updater_safe` 直接执行
`launchctl print gui/UID/com.flywheel.updater`；非零一律报 `updater is not loaded`。只有 loaded 后才读取
`print-disabled` 并要求 enabled。`bootout-supervisors.sh` 在 live census 后、首个 mutation 前、最终
census 后调用该函数；`restore-supervisors.sh` 在 bootstrap 前后也调用它。

因此只改 `bootout-supervisors.sh` 的第一处检查不完整：最后一处仍会拒绝 absent，§5.5 restore 也仍会
拒绝 checklist 的合法状态。正确修复边界在共享 source-only library。

### 队列来源

现行 updater 的 QueueDirectories 只观察 `~/.flywheel/self-ship-urgent.d`，`request-restart.sh` 向该目录
原子发布 `*.urgent.json`。工单同时点名 legacy `self-ship-pending.d`；即使当前生产触发策略不再消费它，
窗口也必须证明两处都空，避免把遗留待部署请求误判为安静。

安全谓词应先验证两个固定 queue path 均为空，再用既有 `fly2264_launchd_state` 区分 `loaded`、明确
`absent` 与 unknown：

- queue path：不存在视为空；存在时必须是 non-symlink directory，且
  `find -mindepth 1 -maxdepth 1 -print -quit` 为空；该条件对 loaded 与 absent 都成立；
- `loaded`：继续要求 `print-disabled` 可读且不是 disabled；
- `absent`：queue 已证空后直接接受；
- unknown、文件/symlink、遍历失败或任何 entry：失败。

不创建目录、不删除 entry，也不读取 token 内容。

## bootout 异步退出

当前循环为：

```text
for label: launchctl bootout → launchctl print → require absent
```

这把“mutation 请求已受理”和“job 已从查询面消失”错误地合成一个原子动作。第一个慢退出 label 会在其余
18 项尚未收到 bootout 时令脚本退出，既不满足“先全卸”也浪费同一 120 秒外层预算。

现场修补证明“先全卸、后收敛”的形状正确；仓库版再把轮询次数语义收紧为 wall-clock deadline：

```text
for label: launchctl bootout
for label: until epoch deadline (+60s) { classify state; absent → next; loaded → bounded sleep }
```

unknown 状态立即失败；deadline 后仍 loaded 点名该 label 与 `60-second convergence deadline`，不把轮询
次数误报成精确 elapsed。外层仍由 `host-terminal-cutover.sh run-step --timeout 120` 提供单次
`launchctl print` 卡住时的硬预算。19 个 label 理论上若串行各耗 60 秒会超外层，
但所有退出已在第一轮并行启动；第二轮只是在同一墙钟上逐项确认，不为每项制造新的退出起点。

现有 `fly2264-supervisor-window.test.sh` 的 launchctl stub 在 bootout 时立即删除 loaded marker，所以完全
看不到竞态。新增慢退出桩应让第一项 Bridge 在若干次 print 后才删除，并在首次 poll 时记录是否已经看到
19 条 bootout call；另加 fake epoch + 永不退出模式，断言 deadline 到达后停止且不误报 pass。测试里的
sleep 与 date 都用 ledger/state stub 替代真实等待。

## `lstart` 规范化

verifier 有四个直接读取点：

1. `fly2264_verify_process_native` 的 `start_before`；
2. 同函数的 `start_after`；
3. `fly2264_verify_cmux` 的 `actual_start`；
4. 同函数结束时的 watcher identity recheck。

四处都使用 `sed 's/^ *//'`，只删除 ASCII leading spaces。写侧 owner 已删除两端任意空白。因此读侧应
集中为一个 source-safe helper，使用 `[[:space:]]` 只删除两端，不用 `awk '{$1=$1}'`，因为后者会把
`Sep  2` 内部有意义的双空格折叠成单空格。helper 对 `ps` 非零或规范化后为空 fail closed。

测试需同时覆盖 process-native 两次夹取与 cmux owner 比较：stub 返回带尾空格的 start，JSON 中的
`startIdentity` 和 owner 均保持无尾空格。

## cmux producer 可归因失败

现场 `06-cmux.json.error` 为空，不是因为下游没有原因，而是 `fly2264_verify_cmux` 从 launchd PID、owner、
heartbeat、sidebar verdict、owner recheck 到 final process identity 的每个失败点都直接 `return 1`。
producer wrapper 只会采集 stderr；因此函数必须为每个阶段打印固定前缀诊断。sidebar 命令要先捕获 rc 与
stdout，再验证 stdout 是 JSON；非零或非 pass verdict 时，把经 `fly2264_bound_text` 限长的 JSON/输出写到
stderr。这样不会改变 fail-closed 判定，但能在窗口末端直接区分：snapshot authority 不可用、sidebar
真实 fail、owner 在验证中换代、heartbeat stale，或 PID incarnation drift。

隔离测试不能只把 sidebar fixture 固定成 pass：至少逐项触发 owner mismatch、heartbeat stale、sidebar
非零带 reasons、sidebar pass-shape 错误和 owner-after drift，断言 producer artifact 为 fail 且 `error`
包含对应阶段名；正向仍需覆盖带尾空格的 owner identity。

## Lead child census 与调用座位

当前 `fly2264_verify_lead_health` 用：

```text
pgrep -P LEAD_PID | sort -n | head -1
ps -o ppid= -p CHILD
```

第二行能重证 parent，但第一行受 macOS `pgrep` 的 ancestor suppression 影响。换成
`ps -axo pid=,ppid=` 的完整 snapshot 后，以第二列 exact 匹配 parent、第一列 numeric sort 取最小 child，
再保留现有单 PID `ps -o ppid` recheck，可消除座位依赖而不改变选择语义。

测试 stub 需为 `ps -axo pid=,ppid=` 输出 fixture `children` map，并让 `pgrep -P` 对某个 Lead 模拟
ancestor 隐藏。旧代码因此 05 红，新代码完全不调用 `pgrep -P` 且 16/16 绿。

exact tmux inventory 仍适合用名称匹配，但必须改成 macOS `pgrep -a -x tmux`。`-a` 只改变祖先排除，
不改变 exact process-name 选择语义。stop-old/verifier 共用该 library，所以一个测试要让 stub 仅在 `-a`
存在时返回“当前座位” server，并证明 union/04 artifact 包含它；无 `-a` 的旧实现应红。

## stop-old 的操作前置

`stop-old-tmux-servers.sh::classify_row` 对 tmux server 只接纳受审 server shape，对 attach client 只接纳
受审 attach shape，其余返回 `tmux command/socket shape is unreviewed`。这个 fail-closed 设计必须保留。

runbook §0/§1 应明确：窗口所有命令从不处于任何 Lead tree 的普通 macOS Terminal shell 执行；开始
authoritative census 前关闭 operator 自己创建的任何 `tmux new -s ...`/临时 tmux 会话，并用独立 census
确认没有该 PID/start tuple。verifier 与 exact inventory 修复后不再因祖先过滤漏行，但普通 Terminal
仍是 stop-old 命令形状合同，不能用“verifier seat-independent”推翻该前置。

## updater 生命周期与窗口 artifacts 换代

runbook 目前既没有产生 updater absent 状态的步骤，又把手工 launchd mutation 排除在授权外。完整闭环应为：

1. §0 只授权两个 updater-specific mutation：准备完成后对 exact label bootout；唯一票前从 exact plist
   bootstrap。其它手工 kickstart/bootstrap 仍禁止。
2. 新 §3.3 在 bootout 前后都调用受审 queue helper，先证明两队列空，再 bootout updater，并在 60 秒
   deadline 内证明 absent。
3. §4/§5.5 允许并重证 absent+queues-empty；restore 仍只管理 19 个 supervisor。
4. §6 在 bootstrap 前再次证明双队列空，bootstrap exact updater plist，证明 loaded+enabled，再发全窗
   唯一 `request-restart.sh` 票。

旧 `~/.flywheel/state/FLY-2264-window/artifacts` 含上一轮 runtime recovery/evidence 且源码字节被现场修补，
installer 正确地拒绝覆盖 drifted populated destination。不能删旧目录或弱化 guard；更新后的 runbook 使用
新的 `~/.flywheel/state/FLY-2264-window-FLY-2279`，使 FLY-2279 字节首次原子安装，同时保留上一轮
`supervisor-recovery.json`、`tmux-union.json` 与 verification artifacts。相同新字节仍可在新目录幂等重验。

## 文件与测试映射

| 文件 | 修改责任 | 回归证据 |
| --- | --- | --- |
| `scripts/cutover/FLY-2264/lib/launchd-window.sh` | updater loaded/absent 两态安全与全状态双队列空验证 | supervisor window suite 的 loaded/absent queue matrix |
| `scripts/cutover/FLY-2264/bootout-supervisors.sh` | 全部 bootout 后逐项 60s deadline 收敛 | 慢退出、fake-epoch timeout、unknown stub |
| `scripts/cutover/FLY-2264/lib/tmux-process-inventory.sh` | exact tmux census 显式包含调用者祖先 | stop-old/verifier ancestor-seat stub |
| `scripts/cutover/FLY-2264/verify-native-tmux-cutover.sh` | `lstart` helper；`ps pid,ppid` child census；cmux 具名诊断 | trailing-space、Lead-seat 与 06 failure-stage stub |
| `engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md` | updater 预卸/重装闭环、普通 Terminal、无自建 tmux、新 window dir | 文本结构断言 + 人工审读 |
| `scripts/__tests__/fly2264-supervisor-window.test.sh` | updater 与慢退出 TDD | 自身 rc=0、慢退出 ledger 顺序 |
| `scripts/__tests__/fly2264-verify-native-cutover.test.sh` | trailing lstart、Lead/tmux seat 与 cmux diagnostics TDD | 04/05/06 producer 绿且负向具名红 |

## 不扩展范围

- 不修改 updater plist、班车时间、request token schema 或 restart 行为。
- 不放宽 stop-old 命令形状、atlas exemption、PID/start/socket 重证或 kill 逻辑。
- 不修 tmux inventory 里其它 startIdentity 的字节形状；它们没有本次 owner 写读不一致。
- 不覆盖或删除上一轮 window artifacts；用新目录保全历史证据。
- 不执行窗口 mutation，不替 DAG orchestrator 派 QA、merge 或 deploy。
