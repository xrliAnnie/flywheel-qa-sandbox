# FLY-2216 Raya 脑常驻体制 — 探索
Issue: FLY-2216 (https://linear.app/geoforge3d/issue/FLY-2216/raya驻场-raya-脑常驻体制与-codex-lead-同级的常驻-pane-假活自愈-可观察日志8-31我下线了僵尸一天无人知)
日期: 2026-08-31
基于: 无

## 1. 问题不是“进程没拉起”，而是三层真相互相脱节

2026-08-31 病案已经证明，`launchd`、进程表与 TCP 连接只能回答“载体还在”，不能回答 Raya 是否仍在消费 `#raya` 消息、能否完成一次 Codex turn、或是否已经由自己的 assistant 输出宣告下线。现状把三个不同对象混成一个“brain alive”：

1. `com.xrli.raya.brain`：Raya 产品仓里的 Discord voice/meeting gateway 与资源采样进程；`KeepAlive.Crashed=true`，进程不退就不会被 launchd 拉回。
2. Raya Codex conversation：`~/.flywheel/raya/codex-home` 内的 thread/rollout，实际承载自然语言脑回路。
3. 观察窗：`raya-brain-watch` 只是对整个共享 CODEX_HOME 做 `ls -t .../rollout-* | head -1` 后 `tail -f`，会跳到任意 QA/runner 的最新 rollout，既不绑定 Raya 的 canonical thread，也不证明消息消费或可答。

因此本单必须同时给出：固定身份的真 TUI 面、业务级心跳与有栅栏恢复、以及可 tail 的结构化生命周期面。只补 `pgrep`、TCP 或 stderr tail 都会重演本案。

## 2. 仓库里已有的承重积木

### 2.1 真会话 pane 已有 80%，缺的是生产载体闭包

`packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh` 已经把 Raya 组装成 windowed full-access Codex Lead：固定 `raya/raya` registry identity、固定 `~/.flywheel/raya/codex-home`、固定外置 workspace、固定 `thread-id`，并由 `codex-lead-tui-runtime.ts` 用 `codex resume --remote` 打开同一个真实 thread。runtime 内已有 15 秒窗口 liveness cadence，窗口死后重建但健康窗不 flap。

缺口在生产载体闭包：

- `materialize-lead-manifests.sh` 会把 Raya 的 `backend=codex-app-server` 写入 manifest；
- 通用 `flywheel-lead-wrapper-v2.sh` 明确只接受 `claude-code`，因此 Raya 不能靠通用路径启动；
- `flywheel-daemon.sh` 当前只会生成 v2 wrapper plist；
- `host-tmux-selection-gate.sh`、`converge-flywheel-bin.sh`、`lead-restart-lifecycle.sh` 与 `flywheel-cmux-sync.sh` 的闭合 carrier 集也都不认识 Raya launcher。

这解释了为什么 FLY-2131 已有 launcher/activation preflight，却仍没有 `com.flywheel.lead.raya-raya` 常驻服务与正式 pane。

### 2.2 FLY-2207 已提供唯一 watcher/rider 形状

FLY-2207 刚合入的 `cmux-watcher-patrol.ts` 已经提供：现有 GatePoller cadence、单飞、按 episode 去重、分类安全矩阵、canonical recovery helper、既有 `LeadPendingAlert` 投递层。`flywheel-cmux-sync.sh` 也已有 authoritative Lead roster、exact plist/manifest 互核、窗口缺失 episode 与自动 cmux workspace 对齐。

本单不再造 timer 或告警系统：Raya 业务健康 rider 应挂到同一个 GatePoller/alert sink；pane 应通过同一 roster/watcher 自动创建与修复。

### 2.3 FLY-1955 与 FLY-2211 仍是未合入依赖

- FLY-1955 分支定义了“具体失败分类 + 所有失败共享连败兜底 + 健康清零”的骨架，并继续使用 `lead-alert.sh`/既有 claims 去重；其代码当前只落在 Codex Lead `ensure-daemon` shell。
- FLY-2211 分支定义了所有杀伤先落 ledger、recovery claim/identity fence，以及“不按进程名做 blanket exemption；必须用 pid+lstart+argv/home 绑定”的约束。

本分支不能假装两者已经在 main。设计默认基于 `origin/main` 实现最小独立闭包，但 stable identifiers、failure category、连续失败语义、kill 前身份三元组与受控重启波豁免必须和两分支兼容；若 Lead 要求 stack，再调整 base，不复制其机制。

## 3. 业务级健康信号

单一“rollout mtime 新鲜”仍会误判：空闲时 rollout 正常不动；反过来，Discord poll 活着而 Codex turn 卡死也是假活。可判定的复合面应来自同一 runtime 的真实业务边界：

- `gateway_poll_ok`：REST poll 完成，证明消息消费循环仍在推进；
- `message_consumed`：只落 channel/message id、时间与结果，不落用户正文；
- `turn_started` / `turn_completed|failed`：证明可答链路从 intake 走到模型终态；
- `assistant_declared_offline`：只检查 assistant 完整输出的窄、锚定宣告，不扫描用户输入，也不把原文写入告警；
- `online` / `generation_lost` / `shutdown`：载体与 session generation 生命周期。

这些事件同时写进可 tail 的 JSONL 与一个原子更新的 current heartbeat。外部 rider 读取 heartbeat：poll 新鲜且无超时 turn 为健康；连续采样失败达到阈值才恢复；明确的 assistant offline 宣告可直接进入已分类故障。

## 4. 恢复边界

恢复目标是 exact `com.flywheel.lead.raya-raya` launchd job，不是裸杀 `node`/`codex`/`app-server`。恢复前与真正 mutation 前各验证：label、plist wrapper、launchd pid、pid lstart、argv 中的 canonical Raya wrapper/CODEX_HOME；任一不确定就只告警、不动手。受控全舰重启窗口只对同一 exact identity 免计，不允许按进程名豁免。

恢复通过 canonical helper 原地 kickstart 同一 job，沿 launcher 的固定 thread id 恢复同一对话，不生成第二个 Raya 身份/第二条常驻 timer。episode 内失败封顶，随后只告警，避免自愈自身成为重启风暴。

## 5. 明确不做

- 不改 Raya voice/meeting 产品命令、回复、calendar 或 `RAYA_MEETING_SHARED_CHANNEL_ID`；2032 lane 保持独立。
- 不把临时 `raya-brain-watch` 收编为正式面；正式面必须是 canonical TUI thread。
- 不通过定时向 founder channel 发探针消息制造噪音；使用 poll/consume/turn 的内生业务信号。
- 不新建独立 watchdog LaunchAgent、独立告警队列或泛化所有 Lead 的新重启权。
- 本 implement 节点不执行生产注册、重启或部署；只交付可经 updater/既有 operator checklist 激活的代码与验证。

## 6. 待设计评审确认的假设

1. 正式可见标题沿既有 Lead 标准使用 canonical `raya-raya`，而不是保留应急标题 `Raya-brain`；cmux workspace 跟随同名窗口自动对齐。
2. `com.xrli.raya.brain` 继续负责 voice/meeting 产品面；本单的“Raya 脑常驻”指新注册的 canonical Codex Lead conversation runtime。产品进程本身的 gateway 生命周期只作为辅助证据，不在 Flywheel PR 内改 Raya 仓字节。
3. FLY-1955/2211 未合入时不 stack；只遵守它们已稳定的分类、连败、身份栅栏与 kill-ledger 兼容合同。

