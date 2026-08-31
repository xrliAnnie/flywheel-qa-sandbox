# FLY-1926 updater 收尾误报 — 调研
Issue: FLY-1926 (https://linear.app/geoforge3d/issue/FLY-1926/bug误报-updater-收尾-bridge-复测在-lead-重启波峰上跑-22-次部署都误判-degradedbridge-实际健康)
日期: 2026-08-31
基于: exploration.md

## 调研方法

本调研把生产日志、当前源码、引入变更和现有测试四条证据链对齐：

- 读取 `/tmp/flywheel-updater.log` 的真实 2026-08-27 至 08-31 部署记录。
- 从 `restart-services.sh` 追踪 Bridge 主检查、Lead 波、统计捕获、收尾探针、renderer 和 alert 的数据流。
- 对 `git blame` 与 FLY-2190 合并提交 `93a3d87ef` 做差异核对。
- 阅读 `scripts/lib/restart-notify.sh`、`scripts/test-restart-services.sh` 与 host-tmux 挂载测试，确认现有合同与缺口。

## 根因一：统计合同的 stdout 被新 gate 诊断污染

### 生产证据

2026-08-31 12:05:13 的日志完整记录了被捕获的值：

```text
ERROR: Lead restart stdout contract is unreadable:
host-tmux-selection-gate: pass ...
host-tmux-selection-gate: verified ...
host-tmux-selection-gate: census pass ...
skipped:0 failed:0 total:16
```

同轮 16 个 Lead 在此前逐个报告重启成功；最终却被播报为统计合同解析失败和 `degraded`。

### 源码数据流

1. `deploy()` 用 `lead_result=$(do_restart_all_leads stagger)` 捕获该函数的全部 stdout。
2. `do_restart_all_leads()` 自身声明“stdout is machine-readable only”，终点输出一行 `skipped:N failed:M total:K`。
3. FLY-2190 新增的 `restart_host_tmux_gate` 和 `restart_host_tmux_census` 直接运行 `host-tmux-selection-gate.sh`；该脚本的成功诊断写 stdout。
4. 两个调用点位于 `do_restart_all_leads()` 内，但没有 `>&2`，所以诊断一起进入 `lead_result`。
5. `rn_parse_count` 有意要求输入是完整单行，拒绝多行污染；消费者行为正确。

### 变更定位

提交 `93a3d87ef` 同时新增了两个 host-tmux 调用和测试 stub。stub 只 `return 0` / `exit 0`，没有模拟真实 helper 的 stdout，因此回归测试没覆盖生产者/消费者边界。

### 结论

根因不是 parser 版本不兼容，而是新生产者违反了既有 stdout 通道合同。修复应在调用边界把诊断送往 stderr，严格 parser 不变。

## 根因二：观测探针被错误提升为健康判决

### 生产证据

- 2026-08-28：00:02:36 Bridge 主检查通过；16 个 Lead 重启后，00:07:16 收尾探针失败并告警。
- 2026-08-29：00:01:56 Bridge 主检查通过；16 个 Lead 重启后，00:06:52 收尾探针失败并告警。
- issue 原始 08-19、08-20 记录同样显示主检查通过，随后 Lead bootstrap 把 load1 推到 120–264，5 秒探针间歇超时。

### 源码时序

```text
start Bridge
  → 主健康循环（最长 15 分钟，成功才继续）
  → build SHA identity 验证（失败则停止）
  → 16 Lead restart/bootstrap
  → watcher + cmux refresh
  → deployed-sha 推进
  → non-Lead converge + launchd census
  → rn_probe_bridge_health（单次、max-time=5s）
  → fail 被 renderer 写成“Bridge 复测异常”
  → tail 发 deploy_degraded
```

所有合法调用在 FLY-1434 后都强制 `restart_bridge=true` 和 `restart_all_leads=true`，所以收尾阶段必然已经拥有两份更强的 Bridge 正向证据：主健康检查和当前 build SHA identity。末尾探针只测得“这个 5 秒窗口有没有取得响应”，不能推翻前面的部署事实。

### 结论

根因包含两层耦合：

1. 时序耦合：观测安排在 updater 自己制造的 Lead 负载峰值。
2. 语义耦合：观测超时被当作服务 degraded，而不是 observation unavailable。

只加 timeout/retry 仍保留第二层错误；只改措辞仍保留不必要的峰值采样。两层都要拆开。

### 波中真实死亡的补偿控制

前移探针不能成为 Bridge 在 Lead 波中真实死亡的盲区。仓库已有独立于 Bridge 进程和部署脚本的 `scripts/bridge-liveness-probe.sh`：launchd 每 60 秒运行一次，默认连续 5 次 down 才发一次 founder page，并在恢复后发 all-clear。它天然把单次高负载尖峰与持续不可用区分开。

2026-08-31 实机只读核验 `launchctl print gui/501/com.flywheel.bridge-liveness-probe`：job 已加载，`run interval = 60 seconds`，累计运行 6505 次，`last exit code = 0`；当前 `state = not running` / `active count = 0` 是 interval job 两次执行之间的正常静止态，不是未加载。生产 plist 的 `StartInterval=60`，ProgramArguments 指向主仓脚本。当前 launchd census 报的 byte drift 不等于检测面缺失，但仍由既有 census/convergence 告警独立跟踪。

因此职责拆分为：部署主健康 + build identity 决定本次新 Bridge 是否可进入 Lead 波；波前短探针只提供延迟观测；波中或波后持续死亡由外部 liveness probe 在 5 分钟去抖后报警。收尾短探针不再承担存活判决。

## 选定设计

采用 exploration 方案 A：

- host-tmux gate/census 在 `do_restart_all_leads` 内统一 `>&2`，保护机器合同。
- 保留 `rn_probe_bridge_health` 的一次 5 秒有界观测，但在主健康与 identity 已通过后、Lead 波之前执行；最终消息明确为“Lead 波前”。
- 波前 probe 失败归一化为 `unavailable`。当显式 startup-health=`passed`、Lead clean、watcher healthy 时，完成消息仍为成功；Bridge 行显示启动检查事实与延迟观测未知，不产生 `deploy_degraded`。
- renderer 新增独立的 startup-health 事实入参，不能从 observation 状态反推“healthy”。
- Lead/watcher/候选/统计合同的现有故障语义不变。

## 测试策略

### 统计合同回归

在 `scripts/test-restart-services.sh` 的真实 `do_restart_all_leads` 提取测试里，让 gate 与 census stub 像生产脚本一样向 stdout 写成功诊断。先证明捕获值包含污染并导致测试失败；修复后只得到 `skipped:0 failed:0 total:1`，诊断仍可从 stderr 观察。

### Bridge 语义回归

在 `restart-notify.sh` 单元测试中新增/改写两类断言：

- clean Leads + healthy watcher + `unavailable` Bridge observation：首行成功，Bridge 行明确“启动检查已通过 / Lead 波前观测未取得”，没有 `degraded`。
- Lead 或 watcher 真故障 + `unavailable` Bridge observation：仍是 degraded，证明没有放宽其他失败条件。

### Bridge 时序与告警回归

在 restart 集成 harness 中：

- 记录 completion probe 与 Lead wave 的调用顺序，断言 probe 先于 `do_restart_all_leads`。
- 让 Lead-wave preflight observation 失败，断言 routine completion 不再说 Bridge degraded，也没有 `bridge-completion-probe-failed` alert。
- 保留现有真实 Lead failure 用例，断言 `deploy_degraded` 仍发。

### 验证范围

聚焦红绿命令为 `bash scripts/test-restart-services.sh`。实现后还需运行所有新建 `scripts/__tests__/*.test.sh`（本设计不要求新增独立脚本）、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`，并核对 diff 与 shell 语法。
