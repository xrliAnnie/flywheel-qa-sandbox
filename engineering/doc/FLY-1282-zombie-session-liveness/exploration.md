# FLY-1282 Bridge 会话状态说谎:僵尸 session 探真修复 — 探索

Issue: FLY-1282 (https://linear.app/geoforge3d/issue/FLY-1282/fix-bridge-会话状态说谎tmux-窗口已死仍报-running-重启后监控已重新接管是假接管-存活判定必须探真-pane2026)
日期: 2026-07-15
基于: 无

## 1. 现场重建(生产铁证,证据链修正 issue 叙述)

对 2026-07-14 夜 FLY-1260 事故,用生产数据(`~/.flywheel/teamlead.db` session_events + `/tmp/flywheel-bridge.log` + StateStore sessions 行)完整还原了时间线。**证据与 issue 叙述有一处关键出入**,但 issue 的四条「要修」全部成立且更加具体:

| 时刻 (UTC) | 事件 | 证据来源 |
|---|---|---|
| 00:37:52 | FLY-1260 runner `fe00ae3e` 起于 `runner-flywheel:@829`,写设计文档 | session_events `autocontinue_arm` |
| 01:26:14 | watchdog 判 stuck(Fable 5 额度耗尽,窗口活着) | session_events `watchdog_judge_confirmed_stuck` |
| 04:22:54 | Lead 标 `legitimate_wait`(snooze) | session_events `stuck_disposition_set` |
| 05:08:09 | runner 自己 `stage set implement` → **此刻 runner 确实还活着** | session_events `stage_changed` |
| 05:09:23 | Bridge 重启 #1 → 发 `session_monitoring_reestablished`(同批 11 个 issue 全部庆祝) | bridge.log |
| 05:15:23 | Bridge 重启 #2 → 再发一条 reestablished | bridge.log |
| **05:20:26** | **heartbeat 最后一次被刷新 → 窗口 ~05:20 真死**(readopt 循环停止续命) | sessions.heartbeat_at |
| 05:21→05:41 | **status 一直 `running`(僵尸窗口 20 分钟)**;期间系统零信号;founder 手工 capture-pane 发现 "can't find window" | sessions.status + 无任何事件行 |
| 05:41:05 | Lead 手动抢救(commit+push 4 个设计文档)后 terminate | session_events `state_transition` trigger=terminate |

出入点:两条 reestablished 发射时(05:09/05:15)窗口**还活着**,探测本身没读错;窗口是 ~05:20 死的。但这不减轻问题,反而暴露更深的缺口(见 §2.1)。若无人工干预,该僵尸要等 `orphanThreshold`(默认 60 分钟)才被 force-fail 成 `failed`,且 fail 消息只有 "Orphaned: no heartbeat",没有任何「窗口已死」的当下告警,更没有未推送工作检查。

## 2. 根因(三个,按危害排序)

### 2.1 探测到死亡的那一刻什么都不做(本次事故的直接根因)

`HeartbeatService.reconcileCandidateReadopt()`(`HeartbeatService.ts:745-748`):readopt 循环每 cycle 对 reconnecting 成员探真 pane,探到 `absent`(tmux 证明窗口不存在)时的全部动作是**静默 `clearReconnecting()`**——不转状态、不发事件、不告警。之后 session 以 `running` 挂着,等 heartbeat 老化到 orphanThreshold(60min)才被 reapOrphans force-fail。**死亡在 05:21 就被系统探知了,但没有任何人被告知**;founder 是唯一的检测器。

### 2.2 reestablished 是「时点断言 + 永续承诺」,且无证据、连叙事前提都可以是编的

事件文案:"was re-adopted after a Flywheel restart … It is alive and being watched again; **no action needed**." 三重不诚实:

1. **永续承诺**:系统对「re-adopt 之后死了」不产生任何后续信号(见 2.1),Lead 拿 22:09/22:15 的旧承诺当 22:30 的现状是必然结果;
2. **无证据**:payload 没有何时探的/怎么探的/探的哪个 target,事后无法审计;
3. **编造前提**(2026-07-15 16:14-16:19Z 新鲜实证,Tadashi 亲核):三条 reestablished(f19e7e94/48cc7075/5506dbbc)都声称 "after a Flywheel restart",但 Bridge pid 27099 uptime ~7.9h——**期间根本没有重启**。真相是三个 runner 的心跳**同时**陈旧 20 分钟(监控侧断流,非 runner 侧;两个 pane 人工验证活着在干活)。文案里的 "restart" 是硬编码套话:触发条件其实只是「heartbeat 陈旧」,与重启无关。且三会话同时 stale 本身是「监控自身出问题」的强信号,系统却逐个庆祝 runner "alive again"。

修复要求(收进 §4.4):①文案绝不声称 restart(只陈述观测:heartbeat 曾陈旧 Nm、pane 探活于 ts 证实存活);②同 pass 多会话(≥3)同时进入 reconnecting → payload 带 concurrent 计数 + 日志警示「疑似监控侧断流而非 runner 侧」。

### 2.3 无证据状态被折叠成 alive 并「庆祝+续命」(issue 第 1 点的结构性洞,本次未触发)

`isSessionTmuxAlive()`(`HeartbeatService.ts:921-946`)是 boolean,把三种截然不同的状态折叠:

- CommDB 读错误(锁/损坏) → `true`(GEO-374 alive-for-suppression)
- pane 探测 `indeterminate`(timeout/ENOENT) → `true`
- pane 探测 `alive`(真活) → `true`

前两种「无证据」状态与真 alive 走完全相同的下游:`enterReconnecting()` → **发 reestablished(声称 alive)+ 每 cycle 刷 heartbeat**。GEO-374 只要求「不误杀」(不 reap),不要求「庆祝 + 续命」。后果:CommDB 持续报错时,死 runner 的 heartbeat 被 Bridge 自己永远刷新 → 永不进 orphan 候选 → **僵尸永生,status 永远 running**。这正是 issue 标题描述的形态。

## 3. 现有机制盘点(哪些已存在、不要重复造)

- `probeRunnerProcessLiveness()`(tmux-lookup.ts,FLY-720):4 态 pane 探测(alive/dead_pin/absent/indeterminate),已是 readopt 路径的探测器。**探测器本身是好的,坏的是结果消费**。
- `probeTmuxServer()`(FLY-1082):server 级 3 态探测;server-loss coordinator 处理舰队级 tmux server 死亡(分组 episode)。僵尸宣告必须避让它:server down ≠ 单窗口死。
- crash reaper(FLY-720):claim `dead_pin`(remain-on-exit 死 pane、窗口还在)→ terminated + 取证 + teardown。**absent(窗口整个没了)不归它管**,归 reapOrphans 老化——这就是缺口。
- `session_monitoring_lost`(FLY-172 legacy):「监控中断但 runner 可能活着」的诚实 advisory,GUARDRAIL 可靠投递。readopt-ON 路径目前完全不用它。
- FLY-1279(等待态通知总线):**还在分支上未合 main**。本单告警走现有 lead_events guardrail 通道(GUARDRAIL_EVENT_TYPES + RegistryHeartbeatNotifier),1279 合并后自动获得其投递保证,无需依赖。
- 未推送工作素材:StateStore sessions 已有 `worktree_path` 列。

## 4. 修法(四条,一一对应 issue 的「要修」)

### 4.1 探活分级:tri-state 取代 boolean(修 §2.3)

新 `probeSessionLiveness(session)` 返回 `"alive" | "dead" | "indeterminate"`:

| 输入 | 输出 | readopt 路径的新行为 |
|---|---|---|
| pane probe `alive` | alive | 现行 re-adopt:刷 heartbeat + 一次性 reestablished(带证据,§4.4) |
| pane probe `indeterminate` / CommDB `error` | indeterminate | **降级为 monitor-lost 待遇**:进 suppression(不 reap、不误报 stuck),一次性 `session_monitoring_lost` advisory(诚实:监控中断、无法证实存活),**不刷 heartbeat、不发 reestablished** |
| pane probe `absent` | dead | → §4.2 僵尸处理 |
| pane probe `dead_pin` | (保持现状) | 不庆祝不续命,留给 crash reaper claim(FLY-720 既有分工) |
| CommDB `gone` | (保持现状) | 老化进 orphan(新 spawn 未注册窗口的竞态保护) |

GEO-374 不变式保持:indeterminate 永不导致 reap(suppression 集合保护);变的只是不再庆祝、不再续命。

### 4.2 僵尸宣告:探到死立即转态 + 告警(修 §2.1,issue 要修 #1/#2)

宣告条件(三个同时满足,防误杀):
1. pane 探测连续 **2 个 cycle** 返回 `absent`(per-execId 计数器,读到非 dead 清零)——防瞬时误读;
2. `probeTmuxServer() === "up"`——server down 归 FLY-1082 server-loss 分组处理,不逐个宣僵尸;
3. session status 仍为 `running`。

宣告动作:
- `applyTransition(running → failed, trigger: "zombie_reap")`,`last_error` 带探活证据(`zombie: tmux window <target> dead (probe=absent x2, at <ts>)`);
- 发新事件 `session_zombie_detected`(加入 GUARDRAIL_EVENT_TYPES + RETRYABLE + EventFilter **high** 优先级),payload 含 issueId、最后 stage/status、探活证据、未推送工作清单(§4.3)。

状态取舍(需 Lead 拍):**不新增 FSM 终态 `lost`**,复用 `failed` + 独特 trigger/error 标记。理由:新终态要动 FSM、全部 terminal 集合(TERMINAL_PHASE_STATUSES、StateStore 查询、event-route、DecisionLayer、dashboard、清理链),风险/收益不成比;`failed` 已有完整下游(retry/告警/清理)。「zombie」语义由 trigger + last_error + 专用事件承载,founder/Lead 可见的是「不再谎报 running + 收到高优告警」。

覆盖两条进入路径(issue 要修 #1 + #2 天然同源):
- **重启 re-adoption**(seedReconnecting → reconcileCandidateReadopt):boot 时窗口已死 → 2 cycle 内宣告,绝不发 reestablished;
- **常态对账**(每 heartbeat cycle 的 reconcileMonitorLoss):运行中窗口死 → 事件流停 → heartbeat 15 分钟(stuckThreshold)后进候选集 → 探测 → 2 cycle 宣告。已 re-adopt 成员在 union pass 里每 cycle 被重新处理,死亡 ≤3 分钟内宣告(FLY-1260 场景从「60 分钟/永远」缩到 ~3 分钟)。

### 4.3 未推送工作保护(issue 要修 #3)

宣告僵尸时对 `session.worktree_path` 做只读检查(best-effort,git 失败 → "unknown" 照样告警):
- `git status --porcelain` → untracked/modified 计数;
- `git log @{u}..HEAD --oneline` → 未推送 commit 数(无 upstream → 全部本地 commit 数);
- 当前 branch 名 + worktree 路径。

结果进 `session_zombie_detected` 的 notification_context,例:「⚠️ worktree 有未保存工作:4 untracked, 2 modified, 1 unpushed commit @ flywheel-FLY-1260 (<path>)。Lead 决定是否抢救。」杜绝 1260 式差点丢工作。**不自动 commit/push**(动作权在 Lead,与 feedback_lead_drives_runner_lifecycle 一致)。

### 4.4 reestablished 带证据 + 只在 positive alive 发(issue 要修 #4,修 §2.2)

- 只有 pane 探测返回真 `alive` 才发(§4.1 已保证);
- payload 加 `liveness_probe: { method: "tmux_pane_probe", target: "<session:@id>", result: "alive", probed_at: "<ISO ts>" }`;
- 文案去掉永续承诺:「探活于 <ts> 证实存活(list-panes pane_dead=0),已恢复监控;若后续死亡将另发 zombie 告警」——后半句现在是真话,因为 §4.2 存在。

## 5. 兼容与回退

- 全部新行为挂 `FLYWHEEL_ZOMBIE_RECONCILE`(default ON,`=0` 回退到当前行为,byte-compat);
- readopt OFF(`FLYWHEEL_HEARTBEAT_READOPT=0`)legacy 路径不动;
- `FLYWHEEL_LIVENESS_PANE_DEAD=0` 既有逃生口不动;
- 不触碰:crash reaper、server-loss coordinator、stuck confirm 层、FLY-1264 标题机制(只共享 clearReconnecting 时机)。

## 6. 验收(真机重演,对齐 issue)

1. 起一个真 runner(529 Room 或隔离项目)→ 写点未提交文件 → `tmux kill-window` 其窗口 → bridge-only restart → **断言**:不发 reestablished;~2-3 个 cycle 内 `session_zombie_detected` 到 Lead(含未推送清单);`/api/sessions` 该 session 不再是 running。
2. 对照组:活 runner 同一次 restart → 照常 re-adopt,reestablished 带 `liveness_probe` 证据,无 zombie 噪音。
3. 常态路径:不重启 Bridge,直接 kill 窗口 → stuckThreshold+2 cycle 内同样宣告。
4. 回退:`FLYWHEEL_ZOMBIE_RECONCILE=0` → 行为与现行 byte 一致(单测哨兵)。

## 7. 显式假设

1. FLY-1279 未合 main → 告警走现有 guardrail lead_events 通道(其合并后自动继承投递保证)。
2. 不新增 FSM 状态 `lost`(§4.2 取舍,gate 里请 Lead 确认)。
3. 「立刻标 zombie」解释为「探测确认(2 cycle ≈ 2 分钟)后立即」,而非单次探测即宣告(防瞬时误读/误杀,GEO-374 精神)。
4. 未推送检查只读不动 git(抢救动作权在 Lead)。
