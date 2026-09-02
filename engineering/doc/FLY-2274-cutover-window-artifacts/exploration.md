# FLY-2274 切换窗口脚本与恢复件 — 探索
Issue: FLY-2274 (https://linear.app/geoforge3d/issue/FLY-2274/cutover窗口件-fly-2264-手册要求的-5-个窗口脚本-supervisor-恢复件审过hash-固定可演练)
日期: 2026-09-02
基于: 无

## 问题

FLY-2264 的 `cutover-runbook.md` 已经锁定破坏性窗口的顺序、预算和停止线，但 §4、§5 与 §7
引用的窗口脚本尚不存在。窗口合同又明确禁止现场改脚本，所以仅有文字步骤不能合规开窗：

- supervisor 清单、bootout 与恢复没有受审实现，无法证明 updater 未被触碰；
- 旧 tmux server 清理没有逐 tuple/socket 的重证与闭合，数百个非默认 socket 容易漏掉；
- link/pin 的六项合同没有 30 秒内 fail-closed 的固定载体；
- 自动验收没有逐项 JSON artifact，单条终端输出无法支撑 §7.1 的全量结论；
- 没有把受审源码以 0700 安装并生成 sha256 manifest 的原子入口。

本单只交付源码、隔离测试、受审 hash 安装器与 supervisor 恢复件。本实现节点不 bootout 生产
launchd label、不 link/unlink Homebrew、不发重启票、不触碰生产 tmux socket，也不改
FLY-2264 的 gate、`host-terminal-cutover.sh` CLI 合同或 runbook 顺序。

## 已有权威事实

1. 当前宿主 `~/Library/LaunchAgents` 有固定 Bridge、Bridge liveness probe、
   `com.flywheel.cmux-watcher`、16 个 `com.flywheel.lead.*` plist 与 `com.flywheel.updater`；另外还有
   不属于本窗口 supervisor 集合的 auxiliary jobs。窗口清单应只包含 Bridge、liveness probe、
   watcher 与所有 Lead，且必须显式拒绝 updater并在人读诊断中列出全部排除项。
2. `host-terminal-cutover.sh` 的 `preflight.processInventory` 会枚举 tmux server 与 attach client，并把每个进程表示为
   `{pid,startIdentity,image,architecture,sockets,supervisor}`，其中 image 由 `lsof -d txt` 精确提取，
   start identity 由 `TZ=UTC LC_ALL=C ps -o lstart` 取得。
3. `host-tmux-selection-gate.sh census` 已有完整 loaded Lead carrier census 和稳定输出
   `census pass plists=… generic=… codex-*=…`；`lead-restart-lifecycle.sh` 已有 loaded plist 候选收集器。
4. restart 的 durable 终态在 `~/.flywheel/leads-restart-status.json` 与
   `~/.flywheel/deployed-sha`，Bridge `/health` 暴露 `buildSha/artifactBuildSha`。当前 restart status
   缺 `total`，自动验收若要证明 skipped/failed/total 均可读，需要把既有 total 同步持久化。
5. cmux 已有只读 `flywheel-cmux-sync.sh --verify-sidebar --json` 验收面；生产 verifier 应调用既有
   judge，而不是复制 cmux attach/sidebar 的复杂判断。

## 锁定边界与假设

- supervisor labels 从 plist 文件名与 plist 内 `Label` 双重取得；任何 symlink、parse mismatch、
  duplicate、缺 Bridge/watcher、零 Lead 都失败。
- `launchctl print` 的非零不能自动解释为 absent；只有已知的 not-found 诊断才算 absent，其余
  transport/parse 状态一律失败。
- updater 在所有 supervisor 操作前后都必须 `loaded`，且 `print-disabled` 不能显示 disabled。
- 窗口进入 bootout 前 19 个 in-scope labels 必须全部 loaded；任何 pre-existing unloaded drift 在首个
  mutation 前失败。recovery 仍保存 observed loaded 字段，以便 malformed/manual fixture fail-closed。
- recovery JSON 只记录窗口前的 plist path 与 loaded 状态；restore 只对原先 loaded 的 exact plist
  执行 `bootstrap`，原先 unloaded 的条目必须仍 absent，不调用安装器或 kickstart。正向窗口路径在
  link/pin 后、updater发票前调用同一 restore，Bridge必须最先恢复，其余 fixed supervisors再到16 Leads；
  old code + new tmux 下的 fail-closed KeepAlive循环是预期过渡态。
- tmux union 是允许观察的 tuple 集合；按命令行与 socket probe 区分 server/client，再以
  `launchctl print pid/PID` 的 resource-coalition name 做归属。唯一受审豁免是
  `com.xiaorongli.atlas-growth` server及连接该server的client；除此之外所有old-image tmux均在mutation/
  native-verification范围内，client继承socket对端server范围，不看自身cmux coalition。无法解析归属的
  unknown仍在首次kill前失败；PID reuse、image/socket漂移或角色不确定同样失败并列出。
- stop 脚本只接受 absolute executable `OLD_TMUX`，逐 socket 调用该 client 的 `kill-server`；禁止
  `pkill`、默认 socket 特判或按名字白名单遗漏 QA/散装 socket。
- verifier 每个验收项单独落 JSON，最后汇总；任一 producer 输出不可解析时不生成绿色替代值。
- Lead/child 的实际翻译状态只由 live PID 的 macOS `ps flags` P_TRANSLATED bit 判定；另取 `lsof -d txt`
  第一条main image并要求 `file -b` 含arm64 slice，证明binary具备native能力。universal同时含x86_64不失败，
  `file`结果也绝不替代P_TRANSLATED实际执行证据。
- verifier 对唯一atlas exemption以外的全部tmux process要求NATIVE_TMUX；atlas server/client带coalition
  label/socket/image单列informational，unknown ownership仍红。
- 为了 hermetic QA，不新增能改变生产判断的 env 开关。常规命令通过隔离 `PATH` stub；必须逐字
  保留绝对路径的 phase-b 六行由测试复制到临时目录后仅重定向绝对 fixture 路径执行。

## 方案比较

### A. 每个脚本独立复制探测逻辑

优点是文件自包含；缺点是 stop 与 host preflight 的 extractor 会立即形成两份实现，未来 image、
socket 或 start tuple 规则漂移后，“同一 exact extractor”无法证明，不采用。

### B. stop 脚本运行完整 `preflight-receipt`

可复用现有入口，但每次重证都会额外要求两套 brew/bottle closure 并启动 extractor positive-control
server，既超出 stop 的职责也增加窗口时延和失败面，不采用。

### C. 抽出 source-only exact inventory library（采用）

把 `extract_tmux_image` 与 `inventory_tmux_servers` 移到无顶层副作用的 source-only library，
`host-terminal-cutover.sh` 与 stop 脚本都调用它。host tool 的命令、receipt schema、输出与顺序不变；
stop 可在每个 kill 前后复用同一实现。其它脚本保持各自边界小、以 JSON/文本文件通信。

## 交付形状

`scripts/cutover/FLY-2264/` 放置：

- `generate-supervisor-labels.sh` 与当前 19-label `supervisor-labels.txt` 样本；
- `bootout-supervisors.sh`、`restore-supervisors.sh`；
- `stop-old-tmux-servers.sh` 与 source-only tmux inventory library；
- `phase-b-link.sh`；
- `verify-native-tmux-cutover.sh`；
- `install-window-artifacts.sh`。

测试按行为拆为新的 `scripts/__tests__/fly2264-*.test.sh`，每个生产脚本至少有正向、parse/transport/
assertion 负向与红色阳性对照。真实 tmux 演练只在 `mktemp -d` 私有 socket 启动 3 个
`/usr/local/Cellar/tmux/3.5a/bin/tmux` server，并同时启动一个隔离对照 socket证明不受影响。

## 成功定义

- 受审脚本与样本能由 installer 原子安装为 0700，并以 sha256 manifest 逐字复核；
- supervisor bootout/recovery round trip、updater不变量与 uncertain branches 全部可执行测试覆盖；
- 手册 §5.5 用 recovery 正向恢复全部原 loaded supervisors，Bridge-first，随后 §6 updater票可达；
- 三个真实私有旧 server 的 PID/start/socket tuple 被逐一闭合，对照 socket 存活；
- phase-b 六个 logical commands（忽略 shell continuation 的物理换行）逐字存在，且每个断言的故意破坏
  都会非零并点名失败项；
- verifier 的每个 §7.1 项写 JSON、完整绿才返回 0，任一红返回非零；
- `bash -n`、所有新增 shell tests、用户指定全仓门、独立 code review 与 PR 流程均有回执；
- diff 与测试日志证明零生产 launchd/Homebrew/restart/tmux mutation。
