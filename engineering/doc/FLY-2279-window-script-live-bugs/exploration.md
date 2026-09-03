# FLY-2279 窗口脚本真机竞态修复 — 探索
Issue: FLY-2279 (https://linear.app/geoforge3d/issue/FLY-2279/2274-followup-窗口脚本三处真机-bugupdater-loaded-前置与预卸冲突-卸载后零等待判定竞态-verify-的)
日期: 2026-09-02
基于: 无

## 问题与现场证据

FLY-2264 的真机窗口在执行 FLY-2274 交付的受审脚本时暴露了四个同一类问题：脚本把
进程管理工具的一次输出当成稳定事实，却没有把窗口实际操作顺序、异步退出和调用座位纳入合同。

1. `operator-checklist.md` 记录 updater 已在 11:42 PT 预卸，避免 12:00 自动班车；但
   `bootout-supervisors.sh` 在首个 supervisor mutation 前后都调用
   `fly2264_assert_updater_safe`，该函数只接受 updater loaded+enabled。于是 checklist 的安全前置会让
   §4.1 在第一行直接失败。相同谓词也被 §5.5 的 `restore-supervisors.sh` 使用，而 checklist 明确到
   §6 才重新 bootstrap updater。
2. 仓库版 `bootout-supervisors.sh` 每个 label 执行 `launchctl bootout` 后立即调用
   `launchctl print` 并要求 absent。Bridge/Lead 在真机需要数秒退出，`bootout` 返回不代表 job 已从
   launchd 查询面消失，因此第一个慢退出 label 会中断循环，剩余 label 根本没有先收到 bootout。
   窗口 artifacts 里的临时修正版已验证正确方向：先向 19 项全部发 bootout，再逐项最多 60 秒轮询
   absent。
3. `flywheel-cmux-sync.sh::_process_incarnation` 写 owner 时会去掉 `ps -o lstart=` 的头尾空白；
   `verify-native-tmux-cutover.sh` 四个读取点只去掉开头空格。macOS `ps` 会在 `lstart` 尾部补空格，
   因而同一个 PID 的 watcher owner 也会被误判为不同 incarnation。窗口 artifacts 已临时修补四处读取，
   证明仓库读写规则存在字节不一致；但该轮 `06-cmux.json` 仍然失败，不能把补丁本身当成整体阳性对照。
   现有函数的每个失败分支都是无 stderr 的裸 `return 1`，导致 artifact 的 `error` 为空，必须同时补上
   可归因、受限长度的诊断。
4. `fly2264_verify_lead_health` 用 `pgrep -P LEAD_PID` 选代表性直接子进程。macOS `pgrep` 默认不返回
   调用者自身及祖先；从某个 Lead 座位执行 verifier 时，该 Lead 的真实 child 可能正是 verifier 的
   祖先，导致该行空结果。现场用临时中立 tmux 座位绕开后 `05-lead-health.json` 转绿，证明失败来自
   调用座位而非 Lead 健康。同一个默认规则也影响 exact tmux inventory 的 `pgrep -x tmux`：临时座位的
   tmux server 是调用者祖先，可能被 census 静默漏掉并让旧 server 检查假绿。
5. `stop-old-tmux-servers.sh` 正确地拒绝无法分类的 tmux 命令形状。founder 若为了执行窗口命令临时
   `tmux new -s NAME`，该会话本身会进入 exact inventory，但不属于受审 server/attach 形状，于是以
   `unreviewed` 中断。这里不应放宽清理器；runbook 必须把“从普通 Terminal 执行且不遗留自建 tmux
   会话”写成开窗前置。

## 边界与假设

- 保留 supervisor manifest、recovery schema、窗口顺序、超时预算和 updater 不在 manifest 的既有合同。
- updater 允许两种且仅两种安全状态：`loaded+enabled`；或 launchd 明确 `absent`。无论哪种状态，
  `~/.flywheel/self-ship-pending.d`、`~/.flywheel/self-ship-urgent.d` 都必须不存在或为空；否则 loaded
  updater 可能因 `QueueDirectories` 立即触发，absent updater 也不能在带积压 token 时被 bootstrap。
- updater 查询不确定、禁用、队列路径不可检查、队列非目录或任一队列非空仍 fail closed；不增加
  production 环境开关。
- bootout 必须先完成全部 19 次成功 mutation，再轮询状态；任一 bootout 调用失败仍立即停止，且不把
  未成功请求的 label 报成已卸。
- 每个 label 使用基于 epoch 的 60 秒 convergence deadline；轮询未知状态不是“仍 loaded”，必须立即失败。
  外层 120 秒 run-step 仍负责约束单次卡住的 `launchctl` 调用。
- `lstart` 只规范化两端空白，不折叠日期内部的双空格。
- child 选择保持“直接子进程中 PID 最小者”的现有语义，只把发现来源从 `pgrep` 换为完整
  `ps pid,ppid` 表并用第二次 `ps -o ppid` 重证；tmux exact inventory 保留名称匹配，但使用 macOS
  `pgrep -a -x tmux` 显式包含祖先。
- 不修改 `stop-old-tmux-servers.sh` 的分类白名单或 kill 范围；仅修 runbook 的操作座位前置。
- 受审 runbook 必须完整产生并收敛 updater absent 状态：在 supervisor mutation 前显式验证双队列空、
  bootout updater 并等待 absent；唯一票前再次验证队列空、bootstrap updater 并证明 loaded+enabled。
- 下一轮使用新的 FLY-2279 专属 `WINDOW_DIR`，保留上一轮含 recovery/verification 的旧目录，避免新字节
  被 installer 的 drift guard 拒绝，也禁止为了重装删除历史证据。
- 本 implement 节点只改仓库源码、文档与隔离测试，不执行生产 launchctl bootout、tmux kill、Homebrew
  link 或部署。

## 方案比较

### 方案 A：取消 checklist 的 updater 预卸

改动最小，但会重新暴露 00:00/12:00 QueueDirectories/日历班车风险，也不能解释 §5.5 restore 在 §6 前
为何要求 updater loaded。与现场已经采用的安全流程冲突，不采用。

### 方案 B：把 updater 安全谓词扩为“两态安全”，并修复各读写边界（采用）

在 source-only launchd library 中集中判定“双队列空 + updater loaded+enabled/absent”；bootout 使用
“全发后等”；verifier 集中规范化 `lstart`、为 cmux 分支补诊断、从 `ps` census 选 child，并让 tmux
inventory 显式包含调用者祖先；runbook 明确普通 Terminal 座位与 updater 的预卸/重装闭环。
这保留已有 fail-closed 边界，且每个现场 bug 都有独立的红绿测试。

### 方案 C：加入窗口专用环境变量绕过检查

可以快速越过 updater/seat 问题，但 production 行为会依赖未受审开关，隔离测试也无法证明默认路径。
它把矛盾藏起来而不是修复合同，不采用。

## 成功定义

- 隔离测试证明 updater absent+双队列空可执行 bootout/restore，任一队列有 entry 时首个 mutation 前红。
- 慢退出桩证明 19 项先全部收到 bootout，再在各自 60 秒预算内收敛；超时与未知状态仍红。
- 带尾随空格的 `ps lstart` 桩能与规范 owner 比对，四个读取点使用同一规范化规则；每个 cmux 失败阶段
  都在 `06-cmux.json.error` 留下具名诊断，sidebar 非零时保留受限 JSON 原因。
- Lead 座位桩让 `pgrep -P` 看不到 ancestor，同时让 `ps pid,ppid` 看得到，`05-lead-health` 仍通过；
  tmux-seat 桩证明 `pgrep -a -x tmux` 不漏当前座位的 server。
- runbook 明确从普通 Terminal 执行、开窗前关闭 founder 自建 tmux session，完整预卸/重装 updater，
  并为修订字节使用新窗口目录、保全上一轮证据。
- 三个相关 shell suite、所有新增 `scripts/__tests__/*.test.sh` 与全仓 lint/build/package tests 通过。
