# FLY-2216 Raya 脑常驻体制 — 调研
Issue: FLY-2216 (https://linear.app/geoforge3d/issue/FLY-2216/raya驻场-raya-脑常驻体制与-codex-lead-同级的常驻-pane-假活自愈-可观察日志8-31我下线了僵尸一天无人知)
日期: 2026-08-31
基于: exploration.md

## 1. 实证与代码地图

| 层 | 当前事实 | 可复用入口 | 本单结论 |
| --- | --- | --- | --- |
| 产品 LaunchAgent | `com.xrli.raya.brain` 以 `KeepAlive.Crashed=true` 运行 voice/meeting gateway；stdout 为空，stderr 只有 2032 lane 的配置噪音 | Raya 产品仓 launchd plist | 不修改产品行为，也不能把它当作自然语言脑的健康真相 |
| Codex conversation | `run-codex-lead-raya-tui-fullaccess.sh` 已固定 `raya/raya`、CODEX_HOME、workspace 和 thread id | `codex-lead-tui-runtime.ts` 的 fixed-thread `resume --remote` 与 window liveness | 正式 pane 应启动这个真会话，不 tail 猜测的 rollout |
| 临时观察窗 | `bin-raya-watch.sh` 从共享 CODEX_HOME 选择最新 rollout；抽样可落到 QA/runner session | 无可靠 identity 绑定 | 不收编；正式化后由 operator 清理，不在本 PR 操作线上临时窗 |
| 常驻载体 | manifest 可以表达 `codex-app-server`，但 bespoke Codex carrier 由模板/operator 激活；`flywheel-daemon.sh` 明确只安装 Claude v2 | Mufasa bespoke wrapper/plist template、converger、path hygiene、restart lifecycle | 为 exact `raya/raya` 增加闭合的 bespoke carrier；保留 daemon/fleet 对 bespoke carrier 的 `external-confirmed` 边界 |
| pane/watcher | FLY-2207 已有 authoritative roster、exact plist/manifest 检查、cmux workspace 对齐和 GatePoller patrol | `flywheel-cmux-sync.sh`, `cmux-watcher-patrol.ts`, `gate-poller.ts` | 扩 roster/carrier 分类；健康 rider 复用相同 cadence、single-flight、episode latch 与 alert sink |
| 输入业务边界 | REST poll 每 3 秒推进，持久 cursor 只在 handler 接受后前移 | `RestPollDiscordInboundSource.pollOnce` | 增加可选 observer，记录成功/失败/接受事件，不改变 cursor 语义 |
| turn 业务边界 | executor 已有 started/active/completed/failed 明确边界 | `CodexTurnExecutor` | 增加可选 observer，不改变 demux、cancel、reconcile 与返回值 |
| assistant 输出 | router 在 journal entry completed 后已有 callback | `LeadInputRouter.onEntryCompleted` | 只对 assistant 完整输出做窄匹配，避免用户消息注入死亡信号 |

## 2. 常驻 carrier 的闭包范围

Mufasa 是最接近的生产样板，但不能把“所有 `codex-app-server` 都走同一个 full-access TUI”泛化：Codex infra bot 与 companion lead 的权限、workspace 和 launcher 都不同。FLY-350 还明确规定 full-access 是 Claude-equal write tier，不能同时声明 `companion:true`。Raya carrier 的选择条件必须同时满足：

```text
projectName == raya
leadId == raya
backend == codex-app-server
codexProfile == full-access
canSpawnRunners == false
companion != true
```

命中后 plist 只执行仓内固定的 Raya wrapper；manifest 不允许传入任意 launcher 路径。FLY-2131 的 `raya-activation-preflight.sh` 是激活前权威，还要继续校验 role、bot identity、model/effort/context、summary role、workspace、memory 与 launcher。未命中的 Codex lead 继续走已有 bespoke 路径或 fail-close，避免配置面变成命令注入面。

闭包不是只多一个 shell 文件，还包括：

- 仓内 fixed plist template + activation preflight 给出 exact `com.flywheel.lead.raya-raya` operator 路径；`flywheel-daemon.sh` 继续跳过 bespoke Codex，不扩大其 staged destructive transaction；
- manifest materialization 只负责产生 `leadBackend.backendId=codex-app-server` 的 Raya manifest；wrapper 权威来自 projects + plist + fixed template；
- converge、package-onboard、path-hygiene 与 provision allowlist 发布该 wrapper；
- host tmux census 将它纳入受控 carrier 集；
- cmux sync 从 loaded plist + manifest 识别 Raya，并只对 exact wrapper 建立 `raya-raya` TUI/workspace；
- 测试证明 generic lead 不能借 Raya identity 的一部分误入 full-access launcher。

这条路径把 Raya 变成与 Codex Lead 同级的 launchd → canonical tmux window → cmux workspace，而不是再起一套 watcher daemon。

## 3. 心跳与日志协议

### 3.1 文件布局

仅对 canonical Raya runtime 启用 observer，状态目录使用现有 lead state 根下的固定子目录，不接受消息内容拼路径：

```text
~/.flywheel/state/codex-lead/raya/brain/lifecycle.jsonl
~/.flywheel/state/codex-lead/raya/brain/heartbeat.json
```

`lifecycle.jsonl` 追加结构化事件，可被 `tail -f`；`heartbeat.json` 通过同目录临时文件 + rename 原子替换，供 patrol 做单快照读取。事件只包含 schema、generation、thread、channel/message id、时间、状态和分类，不记录 Discord 正文、assistant 正文、token 或 secret。

### 3.2 事件与快照状态

| 事件 | 触发点 | 健康意义 |
| --- | --- | --- |
| `online` | runtime 与 fixed thread 初始化完成 | 新 generation 开始，清掉上代瞬态字段 |
| `gateway_poll_attempt` / `gateway_poll_ok` / `gateway_poll_failed` | baseline 与 ready-channel delivery 的每次 REST fetch 尝试与结果 | attempt freshness 证明 loop 在推进；结构化结果区分 loop stall 与 Discord/auth/rate-limit/server/network/unknown 上游失败 |
| `message_consumed` | handler 接受消息、cursor 即将推进 | 最近真实业务输入的 id/时间 |
| `turn_started` | executor 接受 prompt | 设置 active turn 与 deadline 起点 |
| `turn_completed` / `turn_failed` | executor 终态 | 清 active turn，保留最近结果 |
| `assistant_declared_offline` | completed assistant 输出命中锚定宣告 | 高价值异常信号，但它同时证明刚完成 turn+delivery；单独只告警，必须由之后的独立 stall 佐证才可恢复 |
| `generation_lost` / `shutdown` | process/session 失联或正常停止 | 可解释最后退出状态 |

写日志失败不能递归触发 turn 或让业务主循环崩掉；observer 要 fail-open 到 stderr，但 patrol 会因 heartbeat 停更把长期不可观察归类为故障。

### 3.3 “我下线了”匹配边界

检测只看完成后的 assistant output，不扫描 prompt、Discord 用户正文、历史 transcript 或 stderr。规则采用规范化空白后的整段/独立行锚定短语集合，例如 `我下线了`、`我已下线`；`用户说“我下线了”`、`我没有下线`、代码块、引用块和包含该字符串的长解释均不得命中。命中日志只写分类与摘要哈希/长度，不复制正文。

相比往 `#raya` 主动发 ping，这一方案没有频道噪音，也不改变对话上下文；相比只看 rollout mtime，它能区分正常空闲、intake 卡死和 turn 卡死。

## 4. 判活、连败与恢复状态机

一次 patrol 快照按优先级分类；“可检测”与“可 destructive recovery”分开：

1. exact job/carrier identity 不确定：`uncertain_identity`，只告警不恢复；
2. 当前 pid+lstart 从未出现过 valid heartbeat：`observer_missing`，只告警不恢复，避免 Bridge 先升级时重启旧 build；
3. poll attempt 在推进但结果是 401/403、429、5xx/network：`upstream_unavailable`，只告警不恢复；重启不能修 Discord/auth/rate-limit；
4. 最近 generation 有 `assistant_declared_offline`，但 attempt/turn 仍健康：`declared_offline_unconfirmed`，立即告警但不恢复；
5. active turn 超过上限：`turn_stalled`，恢复候选；
6. 最后一次 poll **attempt** 超过 freshness 上限：`poll_loop_stalled`，恢复候选；若它发生在 offline 宣告之后，分类为 `declared_offline_correlated_stall`，但仍遵守连败与 identity gate；
7. 曾观察过当前 pid+lstart 的 heartbeat，随后 snapshot stale/missing/malformed：`heartbeat_stalled`，恢复候选；
8. 其余为 healthy，清当前连续失败计数与 episode latch。

所有恢复候选都需要连续 N 次同一 pid+lstart/generation 的独立失败快照；offline 宣告只增加诊断关联，不绕过阈值。计数按 identity+generation 共享，而不是每个 category 各自绕过兜底：分类决定告警文案，连败决定 recovery 资格，这与 FLY-1955 的“分类 + 共享连败”骨架一致。

恢复动作受以下双栅栏约束：

- 快照时验证 plist label、固定 wrapper、launchd pid、pid lstart、argv/CODEX_HOME；
- mutation 前重新读取并验证同一 pid+lstart+argv/home，防止 PID reuse/TOCTOU；
- 只调用 canonical restart helper 重启 `com.flywheel.lead.raya-raya`，不 `pkill`/`killall`；
- 受控 restart wave 只凭 exact identity marker 暂停计败，禁止 `node`/`codex` 名称豁免；
- 每 episode 至多自动恢复一次，失败后保持告警并等待人工/下一 generation；
- recovery 在落 mutation 之前提供结构化 ledger/claim seam，以便 FLY-2211 合入后无语义冲突地接管。

## 5. 失败策略与告警复用

不新建 alert daemon 或 Discord webhook。Raya patrol 使用 GatePoller 同一 60 秒 cadence 的独立 optional hook（不依赖 `flywheel` project row），复用当前 `LeadPendingAlert` sink。脑健康事件统一使用新登记的 `raya_brain_stalled` kind，route 固定为 fleet sentinel `{projectName:"machine", leadId:"raya-brain"}`，由 unified alert chain 投递，绝不寄给可能已经死亡的 Raya 自己：

- 首次进入 failure episode 发一条带 category、last-good-at、generation 的告警；
- recovery 成功/失败各最多一条 episode 事件；
- healthy 恢复后关闭 latch，下一次新 episode 才再告警；
- 若 sink 或 helper 出错，由现有 patrol 错误隔离处理，不能阻塞 GatePoller 其他职责。

pane loss 不进入 Bridge 脑健康 classifier：扩现有 runtime `tui-window-alert.ts` 的 exact allowlist，让 Raya 复用已有 `tui_window_lost` 连败/episode/alert；Raya launcher 必须像 infra-bot 一样显式投影 `FLYWHEEL_ROOT`，否则 guard 会因找不到 `lead-alert.sh` 而 fail-soft 禁用。runtime 自己的 20 秒 `ensureTuiHealthy` 负责重建 tmux window，`flywheel-cmux-sync.sh` 只做 roster 观测、告警与 cmux workspace 对齐。shell 侧需要 restart-storm gate 时继续复用已有 helper；不另造一个告警命令层。2032 的 missing env stderr 不作为本单 health category。

## 6. 备选方案与否决原因

| 方案 | 结果 | 原因 |
| --- | --- | --- |
| 正式化 `tail 最新 rollout` | 否决 | identity 不稳定，会显示无关 QA/runner；mtime 不是可答性 |
| 只探进程/TCP/launchctl | 否决 | 已被本案证明会把 session 环死判健康 |
| 定时向 `#raya` 发 ping | 否决 | 污染 founder channel 与模型上下文，且恢复逻辑会制造更多输入 |
| 新建独立 watchdog LaunchAgent | 否决 | 与 FLY-2207 重复 cadence、告警、恢复 episode，形成双重重启者 |
| 泛化所有 Codex lead 使用 Raya wrapper | 否决 | full-access/workspace/identity 不同，扩大权限与 blast radius |
| 在 Flywheel PR 修改 `com.xrli.raya.brain` | 否决 | 那是产品 voice/meeting 面，越过本单“不改 Raya 产品行为”边界 |

## 7. 验证矩阵

实现阶段应按 TDD 分批证明：

1. carrier 选择：exact Raya 三元组命中；相近 project/lead/backend 均 fail-close；plist、census、converge 与 path allowlist 闭合；
2. lifecycle observer：原子 heartbeat、append-only JSONL、generation reset、redaction、写失败不打断主流程；
3. runtime hooks：poll/consume/turn 的成功与失败事件不改变既有 cursor/reconcile 语义；
4. declaration detector：正例为独立 assistant 宣告；用户内容、引用、否定、代码与解释性文本均为负例；
5. patrol classifier：空闲但 poll attempt 新鲜为健康；fresh failed attempt/upstream outage、unconfirmed offline、never-observed heartbeat 只告警；poll-loop stale、turn stale、observed-then-missing heartbeat 与 correlated offline 分类正确；
6. recovery guard：连续失败阈值、健康清零、episode 单次恢复、pre-mutation identity recheck、PID reuse、wave marker、helper failure 全覆盖；
7. watcher integration：脑 patrol 使用 GatePoller 独立 hook 与现有 alert sink；runtime 恢复 window，cmux sync 观测 authoritative roster 并恢复 workspace；两者不重复 pager；
8. operator proof：临时测试 home 中 activation preflight → manifest + fixed plist template → fake launch → canonical `raya-raya` tmux window → cmux sync → heartbeat/log tail → 注入 stale fixture → exact job recovery，全程不触碰生产 Raya。

除定向测试外，完成前运行 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` 与所有本单新增 `scripts/__tests__/*.test.sh`。
