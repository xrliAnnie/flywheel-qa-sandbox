# FLY-1082 fleet 级故障告警 + ARC 真修 — 调研

Issue: FLY-1082 (https://linear.app/geoforge3d/issue/FLY-1082/infra-alerts-fleet-级故障oom-tmux-server-死-跨-lead-僵尸无人认领-arc-真修那一环没生效)
日期: 2026-07-09
基于: exploration.md(brainstorm gate 已过,含 Tadashi 补充的外部心跳兜底)

---

## 1. 调研目标

把 exploration §3 的每个机制落到**已核实的代码接缝**上,并修正探索阶段的两处技术假设(wrapper 观察死亡的方式、dispatch-pause 的落点)。

## 2. 逐接缝核实结果

### 2.1 kind 白名单与工单管线(扩展点)

| 接缝 | 位置 | 结论 |
|---|---|---|
| kind 联合类型 | `packages/teamlead/src/LeadAlertNotifier.ts:62-164`(`ALERT_EVENT_TYPES` as const → `AlertEventType`) | 新 kind 加进数组即入类型;shell 侧 `scripts/lead-alert.sh:105` 的 kind allowlist 需同步(两处 kind face 有漂移风险 —— kind-contract 注册表把它变成受测契约) |
| owner 路由 | `bridge/ticket-owner-map.ts:52-88`(`ACCOUNT_AUTH_KINDS` 交叉集 / `NO_OWNER_KINDS` / 默认 Claude bot) | fleet kind 大多走默认 Claude bot;`infra_bot_down` 需要新的「按 provider 交叉」条目(现有交叉集按工单 provider 派生,可复用模式) |
| 工单行 schema | `StateStore.ts:1404-1407`(幂等 ADD COLUMN:`ticket_status/owner_ref/attempt_count/first_seen_at` + `acked_at`,upsert `StateStore.ts:4478-4493`) | **§8.1 前置已满足**:kind/owner/状态/first-seen 字段真的在写;本单只需保证新 kind 走同一 upsert 路径,N1 即可算。digest 聚合本体不在本单 |
| 生命周期 reconcile | `bridge/plugin.ts:6168` `onPollComplete`(watchdog tick 顺风车,零新 timer)→ AlertChannelHub reconcile;T2 判定 `bridge/ticket-escalation.ts:26-77` | 新传感器(swap 水位 / tmux 探针 / bot 探活)全部挂这个 tick,遵循「零新 timer」家规 |
| ARC 执行 | `bridge/AutoRepairBot.ts:80-84`(`AUTO_ATTEMPT_EVENT_TYPES`)+ `canAttempt/attempt` 分发 | 扩展点明确:新 kind 加集合 + attempt 分支 + deps 注入新动作(现有 accountSwitch 可选依赖注入是模板,`AutoRepairBot.ts:63-71`) |
| Bridge 独立告警腿 | `scripts/lead-alert.sh`(claims.db 去重 `:286`、queue dir `:342`,kind allowlist `:105`) | 先例:`tui_window_lost` / `restart_guard_bypass` / `bridge_wrapper_fail` 都走此腿。`bridge_abnormal_exit` 的 wrapper 腿照抄此模式 |

### 2.2 修正一:wrapper 是 exec 语义,「死亡瞬间」抓不到,改抓「下一次启动时发现死过」

`scripts/flywheel-bridge-wrapper.sh` 最后一行是 **`exec npx tsx scripts/run-bridge.ts`** —— wrapper 进程被 Bridge 替换(注释明确:launchd 直接管 Bridge 的 PID/信号/KeepAlive)。**wrapper 没有机会观察 Bridge 退出**;把 exec 改成 wait 会破坏 launchd 语义,不做。

替代(更顺现有结构):
- **dirty-exit marker 检查放进 wrapper preflight**(`scripts/lib/bridge-port.sh` 的 `bp_launcher_preflight`,它已用 `~/.flywheel/state/bridge-wrapper-starts` marker 做 crash-loop 计数):Bridge 启动时写 `bridge-running` marker(含 PID + boot ts),clean shutdown(SIGTERM 处理器,`/health` 已有 `shuttingDown` 状态可挂)时改写成 clean;**下一次 wrapper 跑 preflight 时发现上一枚 marker 是 dirty → 在 exec 之前用 lead-alert.sh 直发 `bridge_abnormal_exit`**(Bridge-independent,launchd respawn 秒级触发 = 事实上的快路径)。
- **Bridge boot 自检腿**保留:复活后的 Bridge 读同一 marker,给自己开**工单**(带生命周期,wrapper 腿只是直发告警),ACK → 复活对账跑完 → 安静 resolve。两腿用同一 signature 前缀 + claims.db 分钟级签名去重(`flywheel-bridge-wrapper.sh:89-101` 先例),不会双响。
- crash-loop:`bridge-port.sh` 已有 starts-in-window 计数,dirty-marker 连续 N 次 = crash-loop → 直接升级(不再安静 resolve)。

### 2.3 修正二:dispatch「暂停派活」不新造 flag 体系,挂进现有 runner-admission

`bridge/runner-admission.ts`(FLY-123,已 merged)是现成的**派活准入控制器**:load-per-core 常开(默认 8.0/core,`FLYWHEEL_RUNNER_LOAD_PER_CORE`)+ 可选 available-memory floor(默认 OFF,`FLYWHEEL_RUNNER_MIN_FREE_MEM_MB`,平台感知 `availableMemBytes()`;macOS 用 vm_stat 保守口径)。**它今天不感知 swap,也不做持续监控/告警**(只在 `/api/runs` 派活瞬间查一次)。

与 FLY-1072 的分界(照 gate 认可的口径落地):
- **本单**:swap 水位**传感器**(tick 顺风车,`sysctl vm.swapusage` 解析 + 阈值 80% + 滞回)+ `swap_pressure_high` 工单链 + ARC 动作 = 置**可逆 pressure-hold flag**(状态文件或 StateStore 单行),runner-admission 加一条检查:hold 在 → `AdmissionDeferredError`(新增 typed reason `pressure_hold`,沿用 429 映射);水位回落(滞回下界)→ 自动撤 hold + 工单安静 resolve。
- **FLY-1072**:真正的水位派活门槛(admission 内建 swap/RAM 阈值、排队、并发上限)。它可以直接消费本单的传感器模块(单独文件,如 `bridge/machine-watermark.ts`,导出读数函数)。
- 传感器只放一份;1072 落地后 hold flag 与其门槛并存不冲突(hold = ARC 的显式手刹;门槛 = 常态准入)。

### 2.4 tmux server 死亡检测

- runner 全部住**默认 tmux server**(FLY-1072 事故记录);Bridge 侧已有封装 `bridge/tmux-lookup.ts:92,224`(`tmux has-session`)。
- **tick 腿**:`onPollComplete` 上,若 StateStore 存在 `status=running` 的 tmux-adapter session ≥1 且 `tmux list-sessions` 返回「no server running」类错误 → `tmux_server_lost`(与单个 session 死亡显式区分:server 级 = socket/进程没了)。
- **boot 腿**:Bridge 复活对账时,若上一世代 running session 数 ≥ 阈(默认 3)且探测发现 tmux server 全新/为空 → 同 kind(聚合判定,防止被 crash-reaper 的逐个收尸掩盖)。
- ARC 动作 = 批量标记(复用 crash-reaper 的收尸腿 `bridge/crash-reaper.ts`,它已有 scrollback 取证 + terminated 迁移)+ **按 Lead 分组通知**(现有 Lead 通知路径:mailbox / issue thread;通知带各自阵亡清单 + resume 指针 + 当前内存水位)。**respawn 一律 Lead 驱动** —— 与「Lead 管 runner lifecycle」铁律和 FLY-175 reserved actions 一致;防 stampede 靠通知里的水位提示 + hold flag(若 swap 仍高,hold 本来就在,Lead 派活会被 admission 挡)。

### 2.5 infra_bot_down 与外部心跳(gate 补充)

- 双 bot 是 windowed TUI Lead(launchd job:W4 codex-infra / W5 claude-infra,FLY-1071)。Bridge tick 可探:lead session 注册 + pane 存活(LeadWatchdog 已看 Lead pane)+ `launchctl print` job 状态兜底。死 → `infra_bot_down`,owner 交叉(死的是 Claude bot → @Codex bot,反之亦然)。ARC = `launchctl kickstart -k`(可逆);两次失败 → @Annie。
- **外部心跳(Tadashi 硬性补充)**:Codex Infra Bot 承担「Bridge 还没活过来」的进程外兜底 —— 定期 `curl /health`,**连续 down > N 分钟(默认 5,可配)→ 直接升级 @Annie**(Discord 直发,走它自己的 bot token;不依赖 Bridge、不依赖 wrapper 那一发)。本单交付物 = 职责写进 PRD §4.1/§4.3 + 心跳脚本/runbook 条目 + 触发判据;**bot 本体部署/enable 归 FLY-1071/928**。实现形态建议:bot 的 launchd home 里加一个独立 interval 探针脚本(不塞进 LLM session loop —— 心跳必须是确定性代码,不能指望 bot 的对话循环记得做),探针脚本挂在 bot 的 launchd 域下随 bot 部署。
- 注意闭环诚实性:若 Codex bot 自己也死了(`infra_bot_down` 的 owner 是 Claude bot,但 Claude bot 的检测面在 Bridge 里)→ 最坏情形「Bridge + Codex bot 同时死」只剩 wrapper dirty-marker 腿。三腿(wrapper/boot/外部心跳)+ 交叉探活覆盖到 N-1 组合;全灭情形(整机死)超出本单(那是「机器都没了」,任何本机告警都发不出)。**此边界写进 plan 的 Non-goals。**

### 2.6 跨 Lead 僵尸检测(v1 = 检测 + 升级,无 ARC)

- Bridge 已广泛读 CommDB(`bridge/actions.ts`、`auto-qa-coordinator.ts` 等先例)→ 低频对账扫描(tick 顺风车,节流到 ~15min 一次)可实现 FLY-1066 取证的三形态口径:① CommDB `status=running` 但 StateStore 无 row;② StateStore 终态但 CommDB registration 仍 running;③ 加一条「running 且 tmux target 不存在 ≥24h」。积压 ≥N(默认 3)→ `zombie_session_backlog` 工单(带样本清单),(b) 型直接升级。
- **收割不做**(FLY-1066 的活);它落地后本 kind remediation 从 (b) 升 (a)(调 scope-free 清理入口),kind-contract 里留 `remediationRef: "FLY-1066"`。

### 2.7 反复升级 → 自动立 eng 单

- Linear issue 创建先例:`bridge/auto-qa-effects.ts:50,283`(`client.createIssue`,FLY-643 auto-QA 独立 issue)—— 直接复用其 client 构造 + team/project 解析。
- 计数源:StateStore 工单行(`ticket_status=ESCALATED` + kind + 时间窗查询)。escalate 路径(AlertChannelHub)上触发检查:同 kind 7 天 ≥N(默认 3,env 可配)→ 建单「补 <kind> 的 runbook」(FLY team / Flywheel project / label Flywheel)。
- 去重:StateStore 记录 per-kind 的 open runbook-issue id;建单前查该 id 对应 issue 状态(open 则跳过)。founder 面文案规则:标题人话、不带 PRD 号。

### 2.8 QA Room 注入(验收机制)

FLY-529 隔离设施两侧齐备:Bridge 侧 `resolveAlertDirsFromEnv`(`plugin.ts:4586`,`FLYWHEEL_ALERT_QUEUE_DIR/_DEADLETTER_DIR`)+ shell 侧 `lead-alert.sh:286,342`(`FLYWHEEL_CLAIMS_DB` / `FLYWHEEL_ALERT_QUEUE_DIR`)+ 隔离测试频道。注入设计:
1. `swap_pressure_high`:传感器模块留注入 seam(`FLYWHEEL_SWAP_SENSOR_CMD` 覆盖真实 sysctl,QA 喂假读数)→ 验 工单→ACK→hold 置位→读数回落→hold 撤销→安静 resolve。
2. `tmux_server_lost`:QA bridge 指到隔离 tmux socket(`tmux -L qa-fly1082`)+ 注册假 running session → `tmux -L qa-fly1082 kill-server` → 验 聚合判定→分组通知→resolve/escalate。
3. `bridge_abnormal_exit`:`kill -9` QA bridge → 验 wrapper dirty-marker 直发(下一次启动前置)+ 复活后 boot 工单 + 去重(两腿只算一个 episode)。
4. `infra_bot_down` + 外部心跳:QA 域 launchd job 停掉 → 验交叉工单 + kickstart;心跳脚本对停掉的 QA bridge 连续探测 N 分钟 → 验直发升级。
5. `zombie_session_backlog`:CommDB 手工插孤儿 row ×3 → 验清单式升级工单。
证据 = 测试频道全生命周期截图/消息记录(NEW→ACK→修复中→已修/已升级),不接受只有测试代码绿。

## 3. 调研结论(进 plan 的定稿口径)

1. exploration §3.1 的 5 kind 集合**成立**,两处技术修正:`bridge_abnormal_exit` 快路径 = wrapper **preflight dirty-marker**(非 wrapper 常驻观察);dispatch 暂停 = **pressure-hold + runner-admission 新 typed reason**(非新 flag 体系)。
2. 外部心跳落为**确定性探针脚本**(随 Codex bot 的 launchd 域部署),本单出脚本 + runbook 判据,部署窗归 1071。
3. kind-contract 注册表同时治「TS 与 lead-alert.sh 两处 kind face 漂移」:allowlist 生成或契约测试二选一(plan 里定,倾向契约测试 —— 不动 shell 生成逻辑,风险小)。
4. §8.1 数据前置已满足(工单字段真的在写),本单零额外工作,digest 聚合明确 out-of-scope。
5. 全部传感器挂 `onPollComplete` 顺风车,零新 timer;全部新动作可逆,§4.4 五条立刻升级在 AutoRepairBot 分发层落死(不可逆动作类 kind 直接 needs_human)。
