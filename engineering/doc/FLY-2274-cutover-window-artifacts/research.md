# FLY-2274 切换窗口脚本与恢复件 — 调研
Issue: FLY-2274 (https://linear.app/geoforge3d/issue/FLY-2274/cutover窗口件-fly-2264-手册要求的-5-个窗口脚本-supervisor-恢复件审过hash-固定可演练)
日期: 2026-09-02
基于: exploration.md

## FLY-2264 现成合同

### 窗口顺序与预算

`engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md` 已锁定：

1. supervisor manifest 只覆盖 Bridge、Bridge liveness probe、cmux watcher 与全部 Lead，updater 始终
   loaded+enabled；
2. 先 bootout supervisor，再用两份 `preflight.processInventory` 取 PID/start 并集；
3. stop 脚本逐 tuple/socket 清旧 server；
4. `phase-b-link` 预算 30 秒，之后才写 cmux pin 和发唯一 restart 票；
5. updater/Bridge/Lead/cmux/tmux/PATH 全绿后才 resume admission。

`host-terminal-cutover.sh` 已对这些 mutation 名称施加 30–120 秒预算，本单不改变其 CLI、step 名称、
receipt schema 或运行顺序。

### Exact tmux extractor

当前 extractor 的关键行为都在 `scripts/host-terminal-cutover.sh`：

- `pgrep -x tmux` 的 rc 只接受 0/1；
- `TZ=UTC LC_ALL=C ps -o lstart= -p PID` 是 PID reuse 边界；
- `lsof -d txt` 必须恰好找到一个已知 Cellar/rollback tmux image；
- `file -b IMAGE` 保存 architecture；
- `lsof -U` 保存全部 Unix socket path；
- parent PID/command 保存到 `supervisor` 对象；
- 任一探测不确定即非零。

把这两只函数抽到 `scripts/cutover/FLY-2264/lib/tmux-process-inventory.sh` 后，host tool 只 source 并
调用同名 wrapper；其 JSON 字段与正负例保持逐字不变。stop 脚本调用同一 library，所以“重新 census”
不是相似实现或只 grep process table。

socket 归属用传入的 absolute `OLD_TMUX` 做只读 probe：

```text
OLD_TMUX -S SOCKET display-message -p '#{pid}<TAB>#{socket_path}'
```

server/client 的 supervisor归属不用socket名称猜：对每个live server PID运行只读
`launchctl print pid/PID`，只解析唯一 `resource coalition.name`。唯一受审exemption label是
`com.xiaorongli.atlas-growth`；其它任何coalition的old-image server都in-scope，rc/parse/零或多name不确定
是`unknown`并fail。实机atlas PID 946返回该exact label，因此能稳定豁免，不需要atlas专用artifact或socket
allowlist。client范围由OLD_TMUX socket probe返回的server PID继承，不看client自身coalition；这保证cmux
coalition的attach clients仍随Flywheel server收口。local decoration不写回`preflight-receipt`，保持host tool
JSON contract不变。

每个仍存活的 union tuple 必须先用 command line 与 socket probe 分类。PID 等于 socket server PID 且 command
不是 attach verb 才是 server；PID 不等于 server PID、command 是 attach-session/attach 且 socket 指向同一
server 才是 client。除exact atlas exemption外的server都进入kill target；其client只观察、server停后自然
退出。atlas server及其socket clients写out-of-scope report（coalition label/socket/image）且不kill；role或ownership
unknown在首个kill前列出并失败。union tuple若以PID+lstart exact check证明已经消失，记
`satisfied_vanished`而非unknown；任何union外non-exempt/unknown live tuple、PID reuse、非旧image、零/多
socket同样预检失败。

为守住 120 秒预算，只做一次全量初始 census；每个 target mutation 前以该 PID 的 `ps lstart/command`、
`lsof txt/socket` 与 OLD_TMUX socket probe 重证，kill 后只轮询该 tuple 消失；全部 server stop 后，以
targeted PID+lstart 最多10秒等待已知in-scope clients自然reap，随后恰好一次全量 exact census证明所有旧
non-exempt server/client tuple消失且没有新non-exempt/unknown server。exact atlas coalition respawn只刷新
informational report。这样是 O(N) full census，不是每杀一只就 O(N) 扫舰。
default/atlas、`fly1869-*`、`fly1999-*`、`fly2118-*` 与任意私有目录都不依赖名称白名单。

## Supervisor label 与 launchctl 语义

### Manifest 枚举

当前宿主的只读 plist census 为 16 个 `com.flywheel.lead.*`，加 Bridge、Bridge liveness probe 与 cmux
watcher 共 19 个窗口 supervisor。生成器扫描 `~/Library/LaunchAgents/com.flywheel.*.plist`，但只接纳
四个范围：

- `com.flywheel.bridge`；
- `com.flywheel.bridge-liveness-probe`；
- `com.flywheel.cmux-watcher`；
- `com.flywheel.lead.*`。

`com.flywheel.updater` 无论来自 manifest、recovery 还是 plist Label mismatch 都硬拒绝；其它 auxiliary
job 不属于 supervisor 集合，生成器输出 manifest 前先把被排除的 label 清单打印到 stderr 供人核，
不把诊断混进 stdout manifest。每个接纳项必须是 non-symlink regular plist，文件名与 plist `Label`
逐字一致，最终排序去重并要求三个 fixed labels + 至少一个 Lead。

`bootout-supervisors.sh` 不信任 dated sample：首个 mutation 前调用同一 generator 生成 live census，要求
与传入 reviewed manifest逐字相等；bootout结束后再 fresh enumerate所有 in-scope plist并逐个证明known
absent。窗口前后新增/删除/改名任何 Lead都会在 mutation前失败，窗口中新增则在post closure失败。
同一 preflight 还要求 manifest内19项全部 loaded；已有unloaded drift在写完完整recovery后、首个bootout前
失败，因此 §5.5 可以有权威19/19目标，§7 verifier也不会把窗口前故障误归因给cutover。

### loaded/absent/enabled

仓内 `scripts/lib/lead-restart-lifecycle.sh` 的先例说明：`launchctl print` rc=0 是 loaded；非零只有诊断
含 `could not find service` 或 `no such process` 才能解释为 unloaded。窗口脚本采用同一 fail-closed
分类器并保存原始 rc/单行规范化诊断，未知 rc/text 是 transport/parse error。

updater enabled 判据复用 `request-restart.sh`：`launchctl print-disabled gui/UID` 成功后，updater entry
缺失或明确 `false/enabled` 为可启动，`true/disabled` 或不可解析为失败。bootout 与 restore 都在首个
mutation 前和所有 mutation 后验证 updater loaded+enabled。

### Recovery JSON

`bootout-supervisors.sh` 在首个 bootout 前原子写同目录 `supervisor-recovery.json`：

```json
{
  "schemaVersion": 1,
  "uid": 501,
  "entries": [
    {"label":"com.flywheel.bridge","plistPath":"/Users/.../com.flywheel.bridge.plist","loaded":true}
  ]
}
```

所有 entries 完整生成、校验、0600 publish 后才允许 bootout。restore 要求 current uid、exact plist path、
Label、allowed scope 与唯一 entry 全部有效；只 bootstrap `loaded=true` 的原 plist，`loaded=false` 只断言
仍 absent。它不调用 installer、kickstart 或 bootout。

## phase-b 与安装器

`phase-b-link.sh` 保留 runbook §5 的六条命令/断言原文，每项包在点名失败项的 guard 中；无 unlink、
upgrade 或其它 formula 操作。脚本本身不扩展超时机制，30 秒上限仍由
`host-terminal-cutover.sh run-step` 的外层 `bounded-run.sh` 权威执行。

`install-window-artifacts.sh WINDOW_DIR/artifacts` 要求 fixed `artifacts` 子目录的 absolute、non-symlink、
current-user-owned 0700 parent，在 parent 内临时 staging 安装所有窗口脚本、样本与 library 为 0700，
用 `shasum -a 256` 生成排序 manifest，
逐项 `shasum -c` 后再发布。manifest 不包含自己，避免自指 hash；最终文件为 0600。任何 source
symlink、额外换行路径、mode/owner/校验不确定都失败。

runbook §1 在 detached reviewed source可用后调用 installer、`shasum -c`，再运行 generator 到临时文件并
与 installed sample `cmp`；§5 后新增 §5.5 forward re-bootstrap，§8.2 保留同一 restore 的回滚命令。
这些补丁不改变 §4 stop→§5 link/pin→§6 updater票→§7 verify 的相对顺序。

## Forward re-bootstrap closure

review 证明原 runbook 先 bootout全部Lead、restart path却只 census loaded plist，导致唯一 updater票必然
在 `total=0 failed=1` 处拒绝；`restart-services.sh:2129` 还会在 Bridge 未 loaded 时拒绝 orphan fallback，
而窗口明确禁止调用 `install-bridge-launchd.sh`。Lead裁定同一受审 `restore-supervisors.sh` 既是恢复件，
也是正向路径：phase-b link/pin/env 后、§6 updater票前，按 Bridge → bridge-liveness-probe → cmux watcher
→ sorted 16 Leads 的顺序 bootstrap recovery 中原 loaded 的全部19项，并逐个 `launchctl print` 证明loaded。
old code + new tmux 可能在 KeepAlive节流下fail-closed循环，这是预期过渡态；updater随后部署新代码并执行
正常Lead wave。transport/parse/bootstrap/post-print任一不确定都在发票前失败，updater/auxiliary不受触碰。

## 自动验收的权威来源

`verify-native-tmux-cutover.sh CUTOVER_SHA` 把证据写到脚本目录下 0700
`verification-artifacts/`，每项先写临时文件、`jq -e` 验 schema 后 0600 原子 publish：

| Artifact | 权威输入与通过条件 |
| --- | --- |
| `01-updater.json` | `~/.flywheel/leads-restart-status.json` 的 reason=updater、failed=0、skipped/total 为整数、codeDeployedSha=CUTOVER_SHA；`~/.flywheel/deployed-sha` 与 Bridge `/health` 的 buildSha/artifactBuildSha 同 SHA。为此给既有 status schema additive 持久化 `total`。 |
| `02-lead-census.json` | 枚举全部 Lead plist，对每个 `launchctl print` 分类；必须 16/16 loaded。生成 census TSV 后调用现有 `host-tmux-selection-gate.sh census`，保存并解析 `census pass plists=16 generic=… codex-*=…`；另检查四个 carrier-class receipt 的 SHA/version/arch。 |
| `03-native-tmux.json` | `/opt/homebrew/bin/tmux` realpath、`-V`、Cellar `file -b`、`brew list --pinned` 四项。 |
| `04-tmux-servers.json` | shared exact inventory本地decorated ownership；exact atlas exemption以外每个process image realpath=NATIVE_TMUX，PID command/extractor无`/usr/local/bin/tmux`/`3.5a`；atlas按coalition label/socket/image informational；unknown ownership/image/socket失败。 |
| `05-lead-health.json` | 16 个 launchd PID 各有 stable UTC lstart；两次 `ps -o pid=,flags=` identity夹取值，hex p_flag 的 P_TRANSLATED `0x00020000` 必须清零；`lsof -d txt -Fn`排除AOT/Rosetta runtime/dylib后必须唯一main image，其`file -b`含arm64 slice（允许universal同时含x86_64）。每个 Lead 的实际 direct child同样检查。 |
| `06-cmux.json` | watcher launchd loaded；owner 文件是 live exact PID+lstart；heartbeat fresh；`flywheel-cmux-sync.sh --verify-sidebar --json` 返回 `status=pass`，覆盖全 tab attach/sidebar。 |
| `07-path.json` | 从 Bridge 与 16 个 Lead process 只提取 PATH 值，逐 exact segment 证明 `/opt/homebrew/bin` 在 `/usr/local/bin` 前；运行 `check-global-path-hygiene.sh --source-tree LIVE_REPO`。原始 `ps eww` 不落盘，避免泄漏其它 env。 |
| `verification-summary.json` | 七个 artifact 的 sha256、status 与总 verdict；仅七项都 pass 才 exit 0。 |

### `sysctl.proc_translated` 的证据边界

Apple 的 Rosetta 文档明确把 `sysctl.proc_translated` 定义为**调用进程自身**的查询，不能把 verifier
自身返回的 0 冒充某个任意 Lead PID 的结果：
<https://developer.apple.com/documentation/Apple-Silicon/about-the-rosetta-translation-environment>。

因此 actual PID 用macOS存在的 `ps pid/flags` 证明：stable PID+lstart两侧夹住hex p_flag，且
P_TRANSLATED `0x00020000` 未置位。`lsof -a -p PID -d txt -Fn`可返回main image加AOT/runtime/libs；按path
排除`*.aot`、`/usr/libexec/rosetta/*`、`/Library/Apple/usr/libexec/oah/*`、`*.dylib`后必须exactly one
main image，要求regular file且`file -b`含arm64 slice。universal Mach-O
同时列x86_64/arm64是pass；`file`只证明binary capability，不说明live process选择哪一slice，后者仍由
P_TRANSLATED独占。另按 Lead 裁定
`a0d90594-00ee-4875-a0a4-f88741f7163a` 只运行固定、无副作用的 `/bin/bash -c
'/usr/sbin/sysctl -n sysctl.proc_translated'` native control并要求0；它单列为host control，不冒充任一Lead
PID事实，也绝不执行child entrypoint。Darwin test另跑真实 `/bin/ps -o flags=` native positive control；
若能发现当前P_TRANSLATED进程，再把它作为negative control证明bitmask会拒绝，否则明确skip该real negative。
macOS `ps comm` 会截断到16字符，不参与identity、allowlist或prefix判断；进程identity只有PID+lstart。

## 120秒 automated-verification预算

cmux producer先在安静的只读环境完成自身双snapshot；其余六个producer再并行且互不写同一文件。
主进程使用Bash 3.2可用的 `kill -0` poll loop追踪exact child PIDs，共享110秒absolute deadline；超时向
仍存活的exact producer PID发TERM、bounded reap，并为每个未完成/invalid producer写fail artifact，summary
必红。测试用短sleep stubs比较wall time小于各producer记录duration之和，不真正串行sleep 120秒；另以短
test deadline证明timeout cleanup。production记录每项与总duration，给外层120秒留10秒清理/receipt余量。

## 锁定排除项

Lead指令固定 supervisor scope，不能把 auxiliary jobs扩进manifest。源码审计中只有
`com.flywheel.quota-monitor` 属于 gate-mounted KeepAlive auxiliary：它在 gate拒绝后、monitor binary启动前
exit 0，因此不能创建新tmux server，但可能发一条预期的fail-closed severe alert；runbook会明确这一过渡态。
其余被stderr列出的auxiliary launchd jobs不调用host tmux selection gate，也不创建carrier tmux server。
`com.xiaorongli.atlas-growth` 则由 `launchctl print pid/PID` 正向证明是唯一exempt coalition：窗口不bootout、
不kill、不动其plist；其独立atlas socket/3.5a server及连接它的client只进out-of-scope evidence。任何其它
coalition（包括cmux clients）不自动豁免。atlas迁移3.7c另立事项。

## Hermetic 测试策略

- 每个 shell test 自建 `mktemp -d` HOME/PATH/LaunchAgents/state/repo，不 source production `.env`；
- stub 必须把每次调用写 ledger，测试断言 stub 确实被命中，避免 PATH 漏桩落到真二进制；
- launchctl 覆盖 loaded、known absent、unknown error、malformed pid、disabled updater；
- tmux/file/ps/lsof/pgrep 覆盖 tuple change、socket change、新 tuple、unknown image 与 extractor failure；
- brew/file/tmux 覆盖 phase-b 与 native probe 每个失败项；
- curl/launchctl/ps/sysctl/cmux/gate/status fixtures 覆盖 verifier 七项逐一故意变红；
- 真实旧 tmux 演练只创建 3 个 target + 1 个 control 私有 socket，trap 只用 exact client/socket 清理；
- 全测试 grep 生产 label/socket，证明 mutation ledger 只含 fixture root；不运行 runbook 的 request、
  restart、link、bootout production 命令。

## 风险与收口

1. shared extractor refactor 若改变 JSON 字节形状会破坏既有 receipt；先以现有
   `host-terminal-cutover.test.sh` characterization 锁住，再抽取 library。
2. supervisor 部分成功 bootout 是可能状态；recovery 在首个 mutation 前完整落盘，使失败后仍可按
   original loaded state恢复，且错误必须点名最后一个不确定 label。
3. installer 的 hash 只证明安装时 reviewed bytes；窗口执行前还必须 `shasum -c`，runbook 外层 receipt
   继续绑定操作顺序与预算。
4. verifier 只读，但 process env 可能含秘密；只提取 PATH，禁止把 raw command/env 写 artifact 或 stderr。
5. status schema 增 `total` 是 additive；旧缺 total 的 status 必须让 verifier 非零，不能用 live census
   反推并伪装 updater 终态字段。
