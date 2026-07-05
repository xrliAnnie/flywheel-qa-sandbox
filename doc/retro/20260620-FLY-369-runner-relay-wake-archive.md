# Retro: Lead 没把 runner 状态回传 founder + parked runner 不被驱动 — FLY-369

**Date**: 2026-06-20
**Issue**: FLY-369 (Urgent)
**Related**: FLY-368 (auto-repair Bot, Cass) · FLY-271 (检测/恢复引擎) · FLY-163 (Bridge 不自动 post runner 状态) · FLY-324 (lingering-completed) · FLY-362 (双向通信 surface)
**触发**: Annie 2026-06-20 —— 从昨天到今天,Runner 跑完 / 卡住的信息没及时回传给她;runner 静静躺着不干活、Lead 也没管 → 她完全不知道发生了什么。「非常严重,必须快点解决」。

---

## 1. 背景:founder 看不见 = 以为系统死了

Flywheel 的可见性契约是:**Bridge 不自动把 runner 状态 post 到 Discord(FLY-163 的设计决定),Lead 是把 runner 状态 surface 给 founder 的唯一通道**。当 Lead 这个通道漏了一拍,founder 的体验就是「派下去的活石沉大海」——哪怕 runner 其实在跑、或早已跑完。本次事故是这条唯一通道在多个环节同时失灵的叠加结果。

按「founder 体验」而非「技术状态」复盘:Annie 的 ground-truth 是 **[FLY-XX] thread 里有没有新消息**。thread 静默 = 她认为没动,与 runner 进程实际状态无关。

---

## 2. Incident 复盘(逐个归类)

| # | 现象 | 实例 | 归因根因 |
|---|------|------|---------|
| I-1 | Lead 回了 runner 的批准,但 founder thread 没有任何进度 → Annie 不知道发生了什么 | 多个 runner | RC-1 回传断层 |
| I-2 | Lead 用 `respond` 回 diff-approval,runner 一直 parked 等一个永远到不了的唤醒 | FLY-351 S2/S3 diff approval | RC-2 respond 不唤醒 |
| I-3 | runner idle / parked / done-lingering,没人主动发现,等 Annie 来催才知道 | 多个 runner | RC-3 无主动巡检 |
| I-4 | runner self-完成但 FSM=running,session+worktree linger,需手动 terminate | 续 FLY-324 | RC-4 lingering-completed |
| I-5 | Done-但-没-ship 的 issue,Discord thread 永不归档、issue 卡 Backlog,Annie 反复手动 archive | FLY-359 / 365 / 366 / 332 | RC-5 archive 只在 ship 触发 |
| I-6 | 续/handoff runner 没读 committed plan,重新 derive 了被 supersede 的方向 | FLY-350(fresh runner 重走 TUI per-thread-config) | RC-6 handoff 丢上下文 |

---

## 3. 根因分析(带代码证据)

### RC-1 回传断层 —— Lead 把状态回给 runner,没 relay 到 founder thread
- **现象**:Lead 用 `flywheel-comm respond` / SendMessage 把批准/状态回给 runner,却没调用 `POST /api/chat-threads/send` 把进度同步进 [FLY-XX] thread。
- **机制**:Bridge 在 runner running / awaiting_review 期间**不自动 relay 到 Discord**(FLY-163)。runner lifecycle 事件(`session_completed` / `session_failed` / `runner_question` / `runner_idle_detected` 等)经 `event-route.ts` 打包成 `LeadEventEnvelope` → 只投到 **Lead 的 inbox**(`mailbox-lead-runtime.ts`),不进 thread。
  - 唯一会自动落 thread 的 runner 消息是「🏁 Runner 完工可关闭」,且**只在 `runPostShipFinalization` 触发**(`runner-ready-to-close-notifier.ts`,见 RC-5)。
- **规则现状**:`lead-rules-base/department-lead-rules.md` 已写「每条绑定 issue 的 Lead 回复必须走 `POST /api/chat-threads/send`」,但执行没到位 —— 这是**纪律执行**而非缺规则。
- **归类**:Lead 行为 / 纪律(规则已存在但没强约束 lifecycle 事件必 relay)。

### RC-2 `respond` 对非-gate(ASK 类)问题不唤醒 parked runner —— 真·代码 footgun
- **现象**:Lead 用 `respond` 回一个 runner 的 ASK(如 diff-approval),runner 一直 parked。
- **代码证据**:`packages/flywheel-comm/src/commands/respond.ts`
  - 非-gate checkpoint 只 `db.insertResponse(...)`(写 CommDB),随后调 `wakeNoBlockGateRunnerBestEffort()`。
  - 该函数读 gate marker:`if (!marker || marker.answeredAt) return;` —— **ASK 类问题没有 marker**(marker 只由 `gate --no-block` 写,且只在设了 `FLYWHEEL_GATE_MARKER_DIR` 的 Codex runner 上),所以直接 return、**不写 mailbox、不唤醒**。
  - 对照 `send.ts`:无条件调 `wakeRunnerMailbox()`(写 mailbox + CommDB 双写,FLY-168)→ **总能唤醒**。
  - 测试坐实:`respond-wake.test.ts` 有断言 *"non-gated checkpoint respond does NOT send a wake"* + `expect(existsSync(inboxPath())).toBe(false)`。
- **唤醒矩阵**:

  | 路径 | 唤醒 parked runner? | 原因 |
  |------|------|------|
  | `send` | ✅ | 无条件 `wakeRunnerMailbox()` |
  | `respond` ASK / 非-gate | ❌ | 跳过 mailbox,只写 CommDB |
  | `respond` `gate --no-block`(Claude runner) | ❌ | 无 marker(Claude 无 `FLYWHEEL_GATE_MARKER_DIR`) |
  | `respond` `gate --no-block`(Codex runner) | ✅ | marker 在 → 走 mailbox |
  | `respond` `approve_to_ship`(Bridge / bypass) | ✅ | Bridge `approveExecution` 或 bypass 路径写 mailbox |

- **归类**:① 真·代码 footgun(`respond` 静默不唤醒,无报错);② Lead 行为(应对 parked runner 用会唤醒的通道)。`runner-messaging-rules.md` 已说「日常对话用 SendMessage(走 mailbox 唤醒),`respond` 只用于 hard gate」,但 footgun 仍在 —— Lead 一旦用错就静默失败。

### RC-3 没有主动巡检 —— Lead 被动等催
- **现象**:idle / parked-awaiting-lead / done-lingering 的 runner 无人主动发现。
- **机制现状**:Bridge 侧有**反应式**检测(都是 emit 事件给 Lead inbox,不主动驱动收尾):
  - `RunnerIdleWatchdog`(FLY-92,~90s)→ `runner_idle_detected`
  - `StuckRunnerDetector`(FLY-195,搭 idle watchdog 便车)→ `runner_stuck_escalation`,Q7 fallback 5min 直 page Annie
  - `HeartbeatService` → `session_stuck` / `session_orphaned` / `session_monitoring_lost`(FLY-172)
  - `GatePoller`(~3-5s + 每 20 tick misroute 巡检,FLY-208)
- **缺口**:**Lead 没有「主动周期扫一遍自己所有 runner 的健康(idle/parked/done)→ 驱动或回传/收尾」的规则或工具**。所有机制都是 Bridge 探到异常才推给 Lead,Lead 自身不主动盘点。
- **归类**:Lead 行为 + 机制缺口。与 FLY-271(检测/恢复引擎)、FLY-368(auto-repair Bot)有重叠 —— 本 issue 管 Lead 侧行为,自动化引擎归那两个 issue。

### RC-4 lingering-completed —— runner self-完成但 FSM=running
- **现象**:runner 干完但 status 卡 running,session+worktree linger 到手动 terminate。
- **机制现状**:FLY-324 的 `done-running-reconciler.ts` 已处理一部分(`stage_changed=completed` 时把 running→completed,+ boot sweep)。但仍有残留场景。
- **归类**:已部分修复(FLY-324),残留与 RC-3 巡检 / RC-5 收尾交叉。本 Retro 记录,不在本 PR 重啃(避免与 FLY-324 重叠)。

### RC-5 archive 只在 ship 触发,不在 Done —— Done-但-没-ship 的 thread 永不归档
- **现象**:pilot / QA / design-only 的 issue 做完(Done)但不 ship → thread 永不归档、issue 卡非-Done,Annie 反复手动收(FLY-359/365/366/332)。
- **代码证据**:
  - `archiveChatThread()`(`chat-thread-utils.ts`,FLY-292 已硬化:bounded retry + verify + 404→missing,never throws,返回结构化结果)**只被 `runPostShipFinalization` 调用**(`post-ship-finalization.ts:226`)。
  - `runPostShipFinalization` 被 `isPostApproveShipComplete()` 门控,而该谓词 **硬性要求 `landingStatus?.status === "merged"`**(`post-ship-finalization.ts:76`,FLY-208 5a)→ 没 merge 证据一律 return false。
  - 路由层:`tools.ts` 的 `createQueryRouter` 注册了 `/chat-threads/{register,create,send,by-thread/:threadId}` + GET `/chat-threads`,**没有 `/chat-threads/archive`** → `POST /api/chat-threads/archive` 实测 404(印证 issue 评论)。
- **结论**:不存在「issue Done 但没 ship 时归档 thread」的任何路径(代码 + endpoint 都没有)。
- **归类**:真·机制缺口。**这是本 PR 的代码修复对象**(对齐 team-lead task #20)。

### RC-6 续/handoff runner 丢上下文 → re-derive 错方向
- **现象**:把活 handoff 给 fresh runner,fresh runner 没读 committed plan + 分支 commits,重新 derive 了被 supersede 的旧路(FLY-350:fresh runner 重走已废弃的 TUI per-thread-config)。Lead 读它第一个 brainstorm 才发现、re-anchor。
- **归类**:Lead 纪律(dispatch 续-runner 时显式命令先读 committed plan + 核对第一个 brainstorm 与既定设计对齐再 greenlight,别 rubber-stamp)。无代码 surface。

---

## 4. 修法 + 责任边界

> **本 PR scope(team-lead archive-first + Codex R1 #7 拆分建议)**:本 PR 只做 **RC-5 archive 机制**(代码)+ 本 Retro + 极简 Lead endpoint 用法说明。RC-1/2/3/6 的 Lead 行为规则 + RC-2 的 respond-wake 代码改 = **follow-up PR**(直接服务 issue 验收 #1/#2/#3,但与 archive 解耦,避免拖慢 urgent 修复)。

| 根因 | 修法 | 类型 | 归属 |
|------|------|------|------|
| RC-1 回传断层 | Lead 规则:**每次 runner lifecycle 事件(completed/failed/stuck/question)强制 relay 到 [FLY-XX] thread**(走 `/api/chat-threads/send`) | Lead 行为规则 | **follow-up PR** |
| RC-2 respond 不唤醒 | (a) Lead 规则:对 parked runner 的批准/驱动一律用会唤醒的通道(`send`/SendMessage),不用 `respond` 回非-gate;(b) 代码:让 `respond` 非-gate 也唤醒(改 footgun) | Lead 行为规则 + 代码 | **follow-up PR**(代码改谨慎:安全敏感 CLI + 有现存断言测试) |
| RC-3 无主动巡检 | (a) Lead 规则:周期性 sweep 自己所有 runner(idle/parked/done)→ 驱动或回传/收尾;(b) 自动化引擎 | Lead 行为 + 机制 | **follow-up PR**(规则)· **FLY-271/FLY-368(引擎/Bot)** |
| RC-4 lingering-completed | 已部分修(FLY-324),残留并入巡检/收尾 | — | FLY-324 / FLY-271 |
| RC-5 archive 只在 ship | **新增 `POST /api/chat-threads/archive` Bridge endpoint**(复用 `archiveChatThread`)+ **archive-on-Done 自动**(HeartbeatService piggyback poll Linear Done)+ **boot 回填** + Lead endpoint 用法说明 | 代码 | **本 PR(代码核心)** |
| RC-6 handoff 丢上下文 | Lead 规则:dispatch 续-runner 显式命令读 committed plan + 核对 brainstorm 对齐 | Lead 纪律 | **follow-up PR** |

**与 FLY-368 / FLY-271 的边界**:本 issue 管 **Lead 侧行为 + 回传 + Lead 主动巡检规则 + archive endpoint**;FLY-368 管统一 Alert Channel + auto-repair Bot(nudge/fix/报告);FLY-271 管 stuck 感知 + 自动恢复引擎(529/模型不可用/pane 冻结)。三者不重叠:本 issue 给 Lead **能力 + 纪律**,那两个给**自动化兜底**。

---

## 5. 本 PR 交付范围(已定稿 — team-lead archive-first + Codex 2 轮 APPROVED)

**本 PR(RC-5,TDD)**:
1. 本 Retro 文档(6 根因复盘 + 修法责任边界)。
2. **代码**:
   - `POST /api/chat-threads/archive`(复用已硬化 `archiveChatThread`,canonicalize identifier→issue_id,token 优先 chat_threads.lead_id,apiToken 未配置 fail-closed 503)—— Lead 按需归档 + 逐个 backfill。
   - **archive 由中央 close 级联驱动(Annie approved 最终设计)**:archive 绑「真收尾」——挂在 Bridge 的 `closeRunner`(所有 Lead 的 runner-close 汇聚的单一 chokepoint)里,任何 Lead close runner 时 Bridge 统一判断并归档,**零绑定具体 Lead**(Peter/Oliver/谁 close 都生效);**去掉 standalone auto-poll-on-Linear-Done**(一看 Linear-Done 就归档过早,如 FLY-351 Done 但还在聊)。
   - **归档条件守卫(不过早)**:仅当 (a) done-cleanup(`session.status === "completed"`,非 terminate/abandon/reject)+ (b) 该 issue 无其它活跃 runner。中途 terminate/abandon 不归。ship 路径仍自动归档。
   - **安全网 = Discord auto-unarchive**(误归档后有人发消息自动重开)+ **archive-once**(`archived_at`:close 级联走 archiveChatThread 幂等 PATCH,已归档=Discord no-op、重开后再 close=重 PATCH 重归;manual endpoint 见 archived 即 no-op);404 由 archiveChatThread 内置 markChatThreadMissing 处理。
   - **endpoint 保留作底层能力**:close 路径内部复用同一 sink;endpoint 留给 backlog 逐个回填。
   - **触发设计四版演进**:auto-poll+24h inactivity →「Done 即归档」→「Lead 各调 endpoint」→「中央 close 级联」(Annie approved 最终)。教训:体验/交互类决策必须 founder 拍准且会多轮迭代,工程不要替她定「什么时候算真收尾、谁来触发」;每版都走 codex re-confirm 守住质量。
   - **boot 回填**:启动时跑同一 reconciler 清存量 backlog。
   - `chat_threads.archived_at`(archive-once,不与 Annie 重开对抗)+ ship 路径也标 archived。
   - env:`FLYWHEEL_ARCHIVE_ON_DONE=0` 关 ②③;`FLYWHEEL_ARCHIVE_SWEEP_EVERY_N_TICKS` 调 cadence。
3. **极简 Lead 用法说明**(department-lead-rules.md):thread 自动归档 + 手动 endpoint。

**follow-up PR(已记入 §4)**:RC-1 lifecycle 必 relay + RC-2 parked runner 用唤醒通道 + RC-2 respond-wake 代码改 + RC-3 主动巡检规则 + RC-6 续-runner 读 plan;RC-3 自动巡检引擎对齐 FLY-271/FLY-368。

---

## 6. 预防 / 教训

- **founder 可见性是 Lead 的一等职责,不是副作用**:Bridge 故意不自动 post(FLY-163),所以 Lead 漏一拍 = founder 直接瞎。lifecycle 事件必 relay 应成硬规则,不靠自觉。
- **静默失败的工具是事故放大器**:`respond` 对 ASK 不唤醒且不报错 —— 用错通道没有任何反馈。这类「错了也不吭声」的 API 要么修成会吭声/会唤醒,要么用规则把人挡在坑外。
- **收尾(archive)不能只挂在 ship 这一条路上**:不 ship 的 issue(pilot/QA/design)同样需要收尾。任何「只在 happy path 触发」的清理逻辑都要问一句「非 happy path 谁来收」。
- **巡检要主动**:反应式检测(Bridge 探到才推)不够,Lead 要有主动盘点自己 runner 的纪律 —— 否则「没异常事件」被默认成「一切正常」,而 parked/done-lingering 恰恰不产生新事件。
