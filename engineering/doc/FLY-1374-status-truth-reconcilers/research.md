# FLY-1374 状态真相双对账器 — 调研

Issue: FLY-1374 (https://linear.app/geoforge3d/issue/FLY-1374/状态真相-discord-显示与-session-现实对齐-双对账器进程db-dbdiscord-幂等重渲染)
日期: 2026-07-23
基于: exploration.md

---

## 0. 调研结论(一句话)

对账器 2 的骨架(FLY-907)已在生产 → 本单重心 = **新建对账器 1(SessionRealityReconciler,全量枚举 + 直连探针 + 分派校正)** + **WAKE 复用分支补「再水合」**(治复用病族的因)+ **显示/告警面的六个定点补洞**;新建组件坚持「探针复用既有原语、校正委托既有机制」,不造第 10 个平行收割者。

## 1. 对账器 1 架构选型

### 1.1 备选与决策

| 方案 | 说明 | 判定 |
|---|---|---|
| A. 新建独立 5min setInterval reconciler | 第 4 条周期 timer | ❌ 违反零新 timer 纪律 |
| B. 扩展 HeartbeatService 现有活性链 | monitor-loss/crash-reaper/reapOrphans 都在这,5min tick | ⚠️ 备选。缺点:活性链已是五连环单飞(FLY-1282),再塞一环加深耦合;且其机制全是**阈值门控**(heartbeat 陈旧/orphan 龄),与「全量即时核对」语义不合 |
| **C. GatePoller cadence-gated tick(选定)** | 与 FLY-907 display sweep 同构:`onSessionRealityReconcileTick`,默认每 60 tick(~3min,可 env 调),自带 try/catch 隔离 + `(tickCount-1)%N` 模式 | ✅ 零新 timer、既有惯例、cadence 独立可调、与 display sweep 天然错峰(不同 tick 相位) |

### 1.2 判定引擎:探针复用 + 校正分派(不新造收割者)

**候选集** = `listNonTerminalSessions()`(每轮 keyset 分页,limit 可配,默认 25 —— 生产 open session 通常 <40,一到两轮扫完)。

**每个候选的判定链(全部直连,FLY-1369 判据)**:

1. **窗口身份核验(新原语,治「串位」)** `verifyWindowIdentity(session)`:
   - 取 CommDB `tmux_window` → `tmux display -p -t <win> '#{pane_pid}'` 拿 pane_pid;
   - **身份锚 = worktree**:pane 进程树的 cwd(`lsof -a -p <pid> -d cwd` / `ps`)必须落在该 session 的 `worktree_path` 下 —— 每个 exec 的 worktree 唯一,是比窗口号可靠得多的身份证据(FLY-1369 的「pgrep 锚真实签名」在本仓的落地形态;spawn 路径没有字面 `--agent-id` flag,已核实,不硬编码);
   - 不匹配 → 该窗口**不属于**此 session(串位)→ 视同 `absent`,且**绝不**据此窗口判定别的 session。
2. **存在+健康**:`probeRunnerProcessLiveness`(现成 4 态;`indeterminate` 视为活,GEO-374 纪律保留)。
3. **活性(仅作证据,不作死刑判据)**:CPU delta 取自 fleet-data 批量面;**零增量≠死**(idle/parked 合法零 CPU)。
4. **park 三源合并**:`ship_parked` status / CommDB declared `parked` / TURN holder(`three_stage_turn`)任一命中 → 安静合法,只核对不收割。

**判定 → 校正分派表(委托优先)**:

| 判定 | 校正动作 | 执行者 |
|---|---|---|
| 死(dead_pin)+ running | 既有 crash-reaper 语义(拆窗→terminated) | **委托**:直接调 crash-reaper 的认领入口(其已有 claim 防双吃) |
| 死(absent / 串位视同 absent)+ running | 先查 complete-marker(有 → 走 marker-reconciler 重放真实终态);无 marker → `applyTransition → terminated`(reason=`reality_reconcile:process_absent`),FSM 拒绝时 `forceStatus` fail-closed 旁路 | 对账器自身(该场景今天要等 60min orphan 龄,是主要提速点) |
| 死 + awaiting_review / approved_to_ship 等 park 态 | **不动 status**(gate 语义归 FLY-1448);只发一次 episode 级 advisory | 对账器(只报) |
| 活 + 带 `⚠️重连中` 标题 / monitoring_lost advisory 残留 | re-adopt(刷 heartbeat、清标题)——复用 `reconcileMonitorLoss` 的 re-adopt 动作 | **委托** |
| 活 + CommDB 行缺失(TURN holder) | 复用病族修复:重建 CommDB 行(§3) | 对账器 → re-hydrate 原语 |
| 活 + StateStore 终态(done-but-alive 残留窗) | 既有 stale-terminal-close(FLY-867)负责,跳过 | 无动作 |

**防抖与安全**:
- 每 session 每 episode 只校正一次(`lifecycle_revision` CAS:读判定时记 revision,写前重验,变了就放弃本轮 —— 与在途事件竞态时事件赢);
- 校正必发一条审计事件(`session_reality_corrected`,入 lead_events 审计镜像),且 `applyTransition` 的 onTransition hook 会**自动触发 display refresh** —— 两个对账器由此天然打通,无需显式接线;
- kill-switch:`FLYWHEEL_SESSION_REALITY_RECONCILE=0`(默认 ON;OFF sentinel 断言回退到逐字现状)。

### 1.3 与既有 9 件机制的关系(逐件申明,防重复建设)

- crash-reaper / marker-reconciler / monitor-loss re-adopt:**被委托**,不改其逻辑,只新增可编程调用入口(若现在只有 tick 内部入口,抽方法即可)。
- reapOrphans(60min→failed):保留为最后兜底;对账器把大多数死会话在 3-5min 内先处理掉,orphan 腿自然萎缩,**不删除**(先并行 soak,删腿另开单)。
- statestore-ghost / commdb-fsm / zombie-scan / stale patrols:方向不同(镜像清理/只检测),不动。
- RunnerIdleWatchdog / stuck-detector:语义是「活但卡」,与「死活对账」正交,不动。

## 2. 对账器 2:FLY-907 refresher 补洞清单(不重建)

| # | 洞 | 修法 |
|---|---|---|
| D1 | **映射残余错位(560/626 的代码现状重数)**:`MAIN_BLOCKED_STATUSES`(`issue-display.ts:125-129`)漏 `rejected`;终态 `deferred/shelved/approved/timeout` 在单 session 面落到「沿用旧 stage badge」——终态却显示 🔨实现中/🧪QA 这类进行时 badge | 补全单 session badge 派生:`rejected/deferred/shelved` → blocked 语义(或独立 badge,plan 定);`approved` → completed;`timeout` → blocked。逐行 sentinel 测试钉死全 status×stage 组合表(现有 issue-display.test.ts 模式扩表) |
| D2 | wake_failed 指纹跑步机(exploration §2.3/2.3a) | ① `runner-receipt-patrol`:target 终态 → **处置积压 wake(dispose)而非升级报警**(终态会话的 pending wake 是垃圾不是事故);② episode 指纹改 `(execution_id, kind)`(去 message_id / first_detected_at_ms 分量);③ 保留一条低频 advisory 供审计。**边界**:park/wake 投递合同与 durable park 归 FLY-1448,实现前核对其落地范围 |
| D3 | 终态 issue 被外部改错标题不再自愈(layer 1 只看 sessions fingerprint) | **接受为诚实边界**(closed thread 无人再看,修它要为全部终态单持续烧 Discord GET);文档写明。活跃单已由 layer-2 轮转 GET+PATCH 覆盖(验收 ② 的对象) |
| D4 | 重启 archive 级联锁死活单(#117 实证;门已存在但有洞) | ① 活跃判定用 **FLY-270 别名集**(issueId/linear id/identifier 三键)查 session,单键漏活修掉;② Linear 查询失败 = **fail-closed 不 archive**(现状核实后如已 fail-closed 则只补别名);③ 新增自愈:refresher 写入时遇 `deferred(archived)` 且 issue 非终态 → 主动 un-archive 再写(`PATCH archived:false`);404/403 locked 记录 `discord_missing_at`/告警一次。lock 来源现场取证归实现期(archive 代码不设 locked,已核实) |
| D5 | chat-threads/send 长文「缺口」重定位 | 分片 helper 已存在(`splitDiscordMessage` 1900 界);实现期 `rg` 全量枚举 Discord message POST 调用点,未走 helper 的逐点归并;`remainingText` 失败尾巴接入既有重试(或至少告警) |
| D6 | lead_inbox 双命名空间收据(chat:/founder_msg: 同 msgId 双开重投) | 类级修:**跨命名空间结算联动** —— settle 任一命名空间时,按外部 msgId 联动结算同 Lead 同 msgId 的另一命名空间行(单向 helper,幂等);不合并两道(FLY-1373 的 lead_inbox 结构不动) |
| D7 | 路由守卫钝化 | `evaluateReplyGuard` 的 thread 内他单 token 已是软遥测(已核实);硬拦在顶层分支或 plugin fork 执法点。修法:顶层分支从「含任意 issue token 即拒」钝化为「**主内容判定**:仅当消息以他单号开头/明显以他单为主题时才拒,正文顺带引用放行」;实现期先取真实被拦样本定位执法点再动刀(不凭猜改) |

## 3. 复用病族:WAKE 再水合(治因)+ 对账兜底(治果)

### 3.1 治因 —— `rehydrateHolder(execId)`(挂 wake 分支,grantTurn 之前)

1. **CommDB 行**:`registerSession` upsert(幂等 ON CONFLICT DO UPDATE,带当前 lead_id/issue/tmux_window)→ 症状①③同根同修。
2. **StateStore 行**:woken holder 回 `running`(rework 语义);FSM 缺边的补边(如 `design_done → running`,现状无此边,需 FSM 变更 + 审计理由 `wake_rework`);同 issue+role 的**前任残留 running 行**交对账器 1 正常处理(死→终态)后,progress 的 latest-active-writer 门自然放行。
3. **env 冻结问题(症状④)**:tmux 无法向已存在窗口重注 env → 结构修在**读端**:`lead-inbox-nudge` 收到 401 时从 `~/.flywheel/.env`(现行 token 权威文件)重读 token 重试一次;仍失败才 warn。彻底根治(token 不进 env)不在本单。
4. **prune 保护**:`commdb-session-prune` 增加 **TURN-holder veto**(execId 是 `three_stage_turn.holder_exec_id` → 绝不 finalize)+ 窗口身份核验(§1.2 原语复用):tmux_window 串位不再让活 holder 的行被误删。

### 3.2 治果 —— reconcileTurnBelt 从「只检」到「检+修」

`reconcileOneTurn` 已检出 holder-row-missing;补动作:检出即调 `rehydrateHolder`(同一原语),修完记审计。两层用同一原语,无第二套逻辑。

## 4. 验收对照(能力级 → 机制)

| 验收 | 机制 |
|---|---|
| ① kill runner → ≤5min sessions 落终态 + 标题跟上 | 对账器 1(~3min cadence)→ applyTransition → display hook 即时重渲染 |
| ② 人为改错标题 → 下轮纠正 | 既有 layer-2 轮转(GET+PATCH);D1 修完映射后断言 badge 正确 |
| ③ 抽查 10 open thread 零脱节 | ①+② 的合成效果;真机抽查 |
| ④ 引用他单号不再被拦 | D7 |
| ⑤ 重启后无活单被锁死 | D4 |
| ⑥ 复用 holder 三通(turn/ledger/信箱) | §3 再水合 + 对账器清残留 |

## 5. 风险与开放点(带入 plan)

1. **对账器 1 与 crash-reaper 的认领竞争**:委托入口必须走其既有 claim(`deadPinOwned`),不得双吃。
2. **FSM 补边**(`design_done→running` 等)动的是核心状态机 —— 必须逐边列举 + sentinel 测试 + Codex review 重点。
3. **`terminated` vs `failed` 语义**:对账器统一用 `terminated`(无错误证据的进程消失)并带 reason;`failed` 保留给有错误证据的路径(reapOrphans 现语义不动)。
4. **529 房能否跑 PhaseOrchestrator wake 分支**:验收 ⑥ 需真 DAG park/wake;若房内不可行,退真机受控 issue(与 FLY-1441 房测模式同)。
5. **FLY-1448 并行在跑**(同晚三段式):实现前核对其 PR 范围,wake_failed/park 相关按边界表收缩,避免同文件撞车。
6. **D7 需真实被拦样本**:实现期从 Discord/misroute archive 取当晚 5+ 次被拦实例定位执法点 —— 修在错的层等于没修。
