# FLY-1282 真机重演脚本(独立 QA 用)

Issue: FLY-1282 (https://linear.app/geoforge3d/issue/FLY-1282)
范围: Part A(僵尸探真)+ Part B(delivery_unconsumed V2)+ Part C(终态自动归档)+ Part D(处置回执)+ INV-10(Lead-only 路由)
执行者: **独立 QA session**(FLY-1211 硬门——实现 runner 不自验)。
前置: 本 PR 已 merge + 生产 Bridge 已用新 dist 重启(与 Lead 协调重启窗口,勿与其他 agent 撞)。

## 场景 1 — 僵尸宣告(issue 原文的核心重演)

1. 用测试 issue 起一个真 runner(529 Room 或隔离项目),等它进入 running 且 tmux 窗口存在。
2. 在 runner 的 worktree 里写一个未提交文件(如 `echo x > UNPUSHED.txt`),制造 unpushed work。
3. `tmux kill-window -t <runner window>`(窗口死,session 仍 running)。
4. **bridge-only restart**(杀 Bridge 进程,launchd/手动重启,不动其他 runner)。
5. 断言(硬):
   - **不出现** `session_monitoring_reestablished`(该 session);绝无 "was re-adopted after a Flywheel restart" 文案。
   - ~2-3 个 heartbeat cycle 内 `lead_events` 出现 `event_id = zombie-<execId>` 的 `session_zombie_detected` 行,**精确 payload**:
     - `last_error` 形如 `zombie: tmux window <target> dead (pane probe absent x2, server up, at <ISO>)`;
     - `unpushed_work` 携带 `UNPUSHED.txt` 路径清单(只读列举,无任何抢救动作);
     - `liveness_probe` 带 `pane_dead` 证据与 probedAt。
   - `/api/sessions` 该 exec 状态 = `failed`(非 running)。
6. **对照组**:同批再起一个健康 runner,同一次 bridge-only restart → 它照常 re-adopt,`session_monitoring_reestablished` 携带 `liveness_probe` 字段、文案为「点时证据」措辞(含 heartbeat age + pane probe),**不含** restart 归因、不含 forever 承诺;零 zombie 噪音。
7. 常态路径:不重启,直接 kill 另一个 runner 的窗口 → stuckThreshold(15m)+2 cycle 内宣告(同 5 的断言)。

## 场景 2 — 回退开关逐字节

1. `FLYWHEEL_ZOMBIE_RECONCILE=0` 重启 Bridge,重复场景 1 步骤 1-4。
2. 断言:行为回到旧世界(候选沉默落入 orphan 路径;零 zombie 事件;零 pane probe 日志)。M0 golden 套件是代码级哨兵,这里做真机抽查即可。

## 场景 3 — Part B(delivery_unconsumed V2)

1. 让一个 runner 进入 `awaiting_review`(正常跑完一单到 gate),给它发一条 lead instruction(mailbox),**不让它标 read_at**。
2. 等超过 unconsumed 阈值(默认 30min,可调 `FLYWHEEL_GAP_UNCONSUMED_MS` 缩短)。
3. 断言:**零** `delivery_unconsumed` 检测事件(parked/等待态永不触发)。
4. 对一个 running runner 发指令、由它在回报里引用完整 `[lead-instruction <id>]` → 同样零触发(全 id 回执 = 消费证明);不引用 id 的旧式回报 → 照常触发(诚实残余)。

## 场景 4 — Part C(终态分钟级归档)

1. 选一个测试 issue,让其全部 session 到 `completed`(含三段式:design/implement/QA 各 phase 全 completed)+ Linear 置 Done。
2. runner 完成命令跑完后窗口自然消失(或手动 kill)。
3. 断言:issue thread 在**分钟级**(首查 vetoed_active 留队 → pane 消失后退避重试)自动归档——不等 6h sweep;归档动作只有 archive(无 closeout/finalize 副作用)。
4. 反例:期间任一 phase 还活着(pane 在)→ 不归档,队列留驻重试。
5. 开关:`FLYWHEEL_TERMINAL_THREAD_ARCHIVE=0` 重启 → 双 sink 零入队(仅 6h sweep 兜底)。

## 场景 5 — Part D(处置回执)+ INV-10 路由验收

1. 场景 1 的 zombie 告警进 Lead 队列后,以 Lead 身份调:
   `POST /api/sessions/<execId>/detection-ack` body `{leadId, kind: "session_zombie_detected"…}`(或对 case-c episode 用 stuck-disposition / recovery-nudge)。
2. 断言:下一个 **disposition-receipt tick(默认约 60 秒)**内,对应 issue thread 出现恰一条
   `🧾 处置回执:<lead> 已处理「…」— 判定:…`;无 @、无 pane 文本。
3. 对照(R19 #3):`FLYWHEEL_DETECTION_RECONCILE_EVERY_N_TICKS=0` 时回执照发(独立 stage);`FLYWHEEL_DISPOSITION_RECEIPT=0` 时零回执、重开后 7 天窗口内补投。
4. 同一 episode 第二次处置 → 零第二条回执。
5. **INV-10 总验收(founder 直令)**:全程翻查 founder 可见的 issue thread 与 @提及——**0 条原始检测事件**(zombie/reestablished/stuck/unconsumed 均只进 Lead 队列);founder 面只允许出现 Lead 的处置回执与 Lead-first 超时升级链的 page。

## 证据留存

- `lead_events` / `session_events` / `disposition_receipts` 的相关行 dump;
- Bridge log 关键行(zombie 宣告、targeted archive outcome、receipt post);
- Discord 截图(对照组 reestablished、归档后的 thread、回执消息);
- 证据保留到 Annie 验收完毕(feedback_qa_evidence_survives_until_annie)。
