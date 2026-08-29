# FLY-927 告警频道 → bot 工单队列 + 路由 + @-target 门禁 — 探索

Issue: FLY-927 (https://linear.app/geoforge3d/issue/FLY-927/infra-alerts-告警频道-bot-工单队列-路由-target-门禁-fly-915)
日期: 2026-07-07
基于: 无(上游输入 = product/doc/FLY-915-infra-alerts-pipeline/prd.md §2/§3/§4/§10.0 + FLY-927 Linear 三条追加评论)

---

## 1. 任务是什么

FLY-915 PRD 拆出的 eng issue ①(= W1 + W2 + W-B 并入),外加 Annie 2026-07-06 追加并入的 **Watchdog v2 generic spec**(原 FLY-936,标 Duplicate 并入):

| 块 | 内容 | PRD 依据 |
|---|---|---|
| 路由 | 有专属 [FLY-XX] thread 的错误 → 进 thread;没有 → #flywheel-alerts 工单队列;非紧急 → #flywheel-notify | §2/§3.1 |
| @-target | 每条工单只 @ 一个 owner bot;默认 Claude Infra Bot;账号/auth 按「谁都不救自己」交叉 | §10.0 CH-1 ① |
| 发送方门禁 | 只有 infra bot(+ auto-repair)能写 #flywheel-alerts;lead-alert.sh 也要认统一频道 + 门禁 | §3.4 |
| 速率兜底 | 20 条/分钟(T1),超了攒批 | §3.4/CH-1 ③ |
| 消息 schema | project + lead/runner id + kind + first-seen ts + owner + 状态(NEW/ACK/修复中/已修/已升级) | §3.3 |
| 工单生命周期 | 进 → @ owner → ACK → ARC(修不掉判定 = 2 次 / 5 分钟,T2)→ 安静 resolve / @Annie 升级;幂等复用 claims.db/episode-latch | §4.3/CH-1 ④ |
| 告警≠通知 spec | FLY-523/818 铁律正式固化成 spec 文档(W2) | §3.3/1.3 |
| 治假冻结 | idle 1h ≠ 冻结(确认现有覆盖);529 runner 真停要报,健康瞬时 529 压掉(W-B) | §4.2 |
| **Watchdog v2** | 按真实 stage 报(不猜)、park 元组〈stage, 球在谁, owner, waiting_since〉、时效 1h、首响应人 = owner(动态责任 Lead / Runner),修不掉才升级 founder | Linear 三条评论(FLY-912 事故) |

**铁律**:默认不 @Annie、修不掉才 @;一条工单只有一个 owner;谁都不救自己。
**边界**:bot 部署 = FLY-928;profile 切换启用 + 通知迁移 = FLY-929;quick-fix env = FLY-925;ship founder-gated。

## 2. 现状审计(codebase ground truth,file:line 已核)

### 2.1 告警发射面(单漏斗 + 一条 shell 旁路)

- **`LeadAlertNotifier.ts`** = Bridge 侧唯一告警出口。kind 全集(union `AlertEventType`):`rate_limit / usage_limit / login_expired / permission_blocked / crash_loop / pane_hash_stuck / runner_stuck_unhandled / auto_qa_stuck / codex_gate_blocked / three_stage_stuck / runner_lead_pending_unhandled / founder_milestone_undelivered / runner_login_expired / tui_window_lost / restart_guard_bypass / bridge_boot_stale_checkout`。
- **`formatContent()`(:943-951)**:`${sev} **${title}** (${leadId} / ${eventType})` —— **无 projectName、无 first-seen、无 owner、无状态**。schema 缺口全在这。
- **频道解析**:统一 env `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`(生产 = #flywheel-alerts `…661254`)覆盖 per-lead。
- **发送身份 = own-bot 归属链**(FLY-368 v1.56 已 ship):坏掉 agent 自己的 bot → Cass(`FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV` 默认 `CASS_BOT_TOKEN`)→ 字母序全 fleet(`alert-bot-chain.ts`)。即今天**每个 Lead 的 bot 都会往告警频道发**(有意设计:归属显示)。
- **`scripts/lead-alert.sh`**(Bridge-down 兜底):**不读统一频道 env**,按 projects.json per-lead `alertChannel` 解析(生产靠把它配成同一 id 才收敛);同一 claims.db 原子去重(eventId 字节一致);无速率上限。
- **速率**:**全链路没有频道级速率上限、没有攒批**。防刷屏 = 三层去重(claims.db 跨进程 + `lead_events` UNIQUE 同进程 + episode-latch/cooldown)+ shell 侧按日签名。
- **谁在往频道写(全集)**:① notifier root 告警 ② `AlertChannelHub` thread 操作(ack/结果/resolve/archive,Cass 链)③ account-switch 结果贴(plugin.ts:4901-4918/5389,self-heal 开时)④ lead-alert.sh ⑤ 两个 Discord agent(Codex InfraBot + Cass)作为 mention-gated 参与者。**无任何代码级门禁**;唯一约束 = Discord 频道权限(手工)。
- **旁路缺口**:`three_stage_stuck`(plugin.ts:4474)和 auto-QA 告警(auto-qa-effects.ts:388/462)直调 `leadAlertNotifier.alert()` 不走 Hub → 同频道但无 threading/无 auto-repair。

### 2.2 工单化已有的地基(FLY-368 三步演进已全部 ship)

- **`AlertChannelHub`**:统一频道 root 告警 → 开 per-error thread → Cass ack(按 kind 诚实措辞)→ `AutoRepairBot.attempt()` → attempted/needs_human → reconcile/onRecovery 确认恢复 → resolve(带「几点坏→几点修好」时间线)+ archive。StateStore `alert_threads`(active-mapping,correlation_key PK + event_id 辨 stale)。
- **`AutoRepairBot`**(actor `aunt-cass`,`FLYWHEEL_AUTO_REPAIR` 门):只做 runner `continue` nudge(5 道闸 + audit-before-send)+ resume-menu 单 Enter + `usage_limit` 时 enqueue 账号切换(FLY-696 建好待启用);其余 needs_human。**唯一真 @Annie** = Hub needs_human 行(`FLYWHEEL_FOUNDER_DISCORD_USER_ID`)。
- **@-target 先例已存在一种**:`AlertChannelHub.infraBotId()`(:351-360)—— `account_switch` 结果贴用 `allowed_mentions.users=[FLYWHEEL_INFRA_BOT_USER_ID]` @ Codex InfraBot,唤它认领。FLY-927 = 把这个模式泛化成「每工单一 owner」。
- **owner bot 怎么被唤醒**:FLY-871 Codex InfraBot = windowed Codex TUI Lead,把告警频道配成 cross-dept(`FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS`)→ **mention-gate(FLY-267)只在被 `<@botId>` 点名时才动**,天然满足「没被 @ 的 bot 不动手」。动作走 Bearer HTTP:`POST /api/account-switch`(原子 claimPending,`actorBackend!==provider` 强制「不救自己」已在 server 端)/ `POST /api/rescue`。
- **状态原地更新的原语已有**:`editDiscordMessageInChannel`(discord-utils.ts:192,PATCH,404 区分)—— FLY-887 已用于 founder 可见状态行。Hub 的 DiscordOps 目前只 create/post/archive,无 edit。
- **bot 池**:pool-03 = Codex Infra Bot(`CODEX_INFRA_BOT_TOKEN`,代码 merged、部署=FLY-928 W4);pool-04/05/06 = Claude Infra Bot 预留(完全没建,FLY-928 W5;T3 命名占位)。

### 2.3 issue thread 路由已有的地基

- **`chat_threads`**(StateStore:1265-1284):`UNIQUE(issue_id, channel_id)`,FLY-270 canonical-key(identifier,拒裸 UUID)。读:`getChatThreadByIssue(issue_id, lead.chatChannel)`。
- **founder-thread-notifier.ts** = FLY-523/818 铁律的实现:gate(brainstorm/approve_to_ship)/ milestone / **runner-stuck founder page**(FLY-818 M3)三个入口全都发进 issue 自己的 thread(绝不进告警频道),`allowed_mentions.users=[founder]`,审计进 `session_events`,transient 重试 45min 预算,预算烧完 → `escalateFounderThreadUndelivered` 落告警频道(绝不静默)。
- **事件 → thread 绑定链**:`execution_id → sessions(issue_id, project_name, issue_labels) → resolveLeadForIssue → getChatThreadByIssue(issue_id, lead.chatChannel)`。runner 级事件都可绑;Lead 级事件(session 冻结/额度/auth)无 issue 可绑。

### 2.4 Watchdog 家族现状(v2 要统的对象)

| 机制 | 管什么 | 现状 |
|---|---|---|
| `sessions.session_stage` + `stage_updated_at` | **权威 stage**(`flywheel-comm stage set` → POST /events → `patchSessionMetadata`) | 已有,但**没有任何看门狗读它来措辞** |
| CommDB `messages.checkpoint` + `created_at` | gate 等待身份 + waiting_since(brainstorm/approve_to_ship/question) | 已有 |
| `sessions.awaiting_review_entered_at` | 审批等待锚点 | 已有(HeartbeatService 48h 级 `gate_timed_out` 巡检) |
| FLY-605 founder-relay(gate-poller:1401) | founder-facing gate 超 grace(10min)→ @founder 贴 issue thread | 已 ship;**FLY-912 当天因 Bridge 短暂 down 投递失败**,无 1h 级「还没送达」reconcile |
| FLY-637-ext lead-pending(gate-poller:1176) | 阻塞 `question` gate → 指数退避催 Lead(20min 起 ×2)→ K=3 轮页 Annie(`runner_lead_pending_unhandled`) | 已 ship(代码在),裸 ask 不催 |
| FLY-195/253 StuckRunnerDetector | 画面冻死(无 pending gate)→ 升 Lead → Q7 页 Annie | 已 ship,pending_gate 硬豁免 |
| FLY-626 quiet classifier + `runner_declared_states`(park/busy CLI) | 有意停泊不报 | 已 ship(核心切片) |
| `three_stage_stuck`(plugin.ts:4449-4481) | 三段式 phase 卡死 | **靠 orchestrator 侧信号,不读 session_stage → FLY-912「Code Review 卡 3h」错措辞的来源家族** |
| FLY-193/218/220 | 假冻结/529 误判/回声风暴 | 已根治(idle suppressor default-ON;`isTransientThrottlePane`;echo immunity) |

**缺口(v2 的靶)**:① 措辞不从 `session_stage`/checkpoint 取 → 猜错(912 根因);② 「球在谁」只是隐式派生,没有统一元组 + 统一模板;③ founder-facing 通知失败后**无 1h 级重验兜底**(605 有 45min 重试预算,烧完只报告警频道);④ ci 一方无一等建模(只有 land-status.json / auto_qa_record);⑤ 529 runner 真停无专属 kind(会落进泛化 stagnation 或被压)。

## 3. 缺口汇总(PRD 目标 vs 现状)

| # | PRD 要求 | 现状 | 要建 |
|---|---|---|---|
| G1 | 路由三分(thread / 队列 / notify) | 错误全进统一频道;thread 只走 founder 通知 | 发射侧 Router(分类 + 绑定检查) |
| G2 | 每工单 @ 唯一 owner bot | 仅 account_switch 一种 @ Codex InfraBot | kind→owner 映射 + owner 注册(bot user id 配置)+ root 消息 @ |
| G3 | 发送方门禁 | 无代码门禁;own-bot 链 = 全 fleet token 都发 | 收口发送身份 + Bridge /send 拒发告警频道 + Discord 权限(ops)+ lead-alert.sh 认统一频道/身份 |
| G4 | 20/分钟 + 攒批 | 无 | 发射漏斗令牌桶 + 溢出攒批(复用 queue 机制)+ shell 侧近似 |
| G5 | 消息 schema(project/owner/状态…) | formatContent 缺 project/owner/状态/first-seen | 新工单头模板(⚠️ 必须同步改 LeadWatchdog echo-immunity 的模板签名,FLY-220) |
| G6 | 生命周期 NEW→ACK→修复中→已修/已升级 + T2 | Hub 有 ack/attempted/needs_human/resolve 叙事,无状态字段外显、无 2次/5分判定、无 ACK 超时兜底 | alert_threads 扩状态列 + root 消息 edit-in-place + T2 判定 + 无人认领兜底 |
| G7 | 告警≠通知写进 spec | 铁律只活在 revert commit 里 | 新 spec 文档(随 PR 合入) |
| G8 | idle≠冻结确认 + 529 真停要报 | suppressor 已 default-ON;529 真停无 kind | 覆盖确认(fixture 测试)+ 新 kind `runner_throttle_stalled`(暂名) |
| G9 | Watchdog v2(stage 真相 + 球在谁 + 1h + owner 首响应) | §2.4 五套各自为战,措辞靠猜 | 统一「checkpoint-park 元组」派生 + 诚实模板 + 1h 巡检 + 既有升级梯子(605/637-ext)对齐措辞 |

## 4. 设计方向(推荐 + 备选)

### 4.1 两条真的产品语义决策(gate 要 Tadashi 拍)

**Q-A. 「有 thread 的错误进 thread」的边界怎么划?**
PRD §3.1 规则 1 是机械绑定检查(事件绑 issue → 进 thread),但 §4.1/CH-1 工单白名单又把「runner 卡死/超时/529 真停」(全都绑 issue)列为**队列工单** @ Claude bot。两处字面冲突。
**推荐解读(按响应者划,而非按可绑定性划)**:
- **infra 进程健康类**(白名单 kind:runner 卡死/超时/529 真停/auth/额度/Lead 冻结)→ **一律进队列工单 @ owner bot**(bot 才修得了;进 thread 只会把 infra 噪音刷给 Annie,还饿死 bot 队列)。
- **issue 进展类**(checkpoint 停等、milestone、founder 通知、三段式 phase 卡)→ **进 [FLY-XX] thread @ 责任方**,绝不进告警频道(CH-3 ⑤)。
- **两者的接缝** = 升级:队列工单修不掉且绑 issue → **founder page 进那条 issue thread**(复用 FLY-818 M3,Annie 在上下文被 @)+ 工单标「已升级」;不绑 issue → 工单 thread 里 @Annie(现状 Hub needs_human)。CH-3 ② 明文把「stuck page」列进 thread 内容,与此吻合。

**Q-B. 发送身份:单一 infra-bot 收口 vs 保留 own-bot 归属链?**
PRD §3.4「告警发射统一收口到 infra-bot 身份」 vs FLY-368 v1.56(Annie 2026-06-22 拍的「坏掉 agent 自己的 bot 发 = 归属正确」,已 ship)。新 PRD(2026-07-06 lgtm)在后。
**推荐**:按 PRD 收口 —— 新 env `FLYWHEEL_ALERT_SENDER_TOKEN_ENV`(唯一发送身份;T3 命名落定前先配 Cass,FLY-928 后切 Claude Infra Bot),归属信息改由 schema 头的 `project + lead/runner id` 承载(比认头像更明确);**不设该 env = 保留现状 own-bot 链(字节兼容)**。门禁的硬执行 = Discord 频道权限(ops 步骤,只给 infra bot + 发射身份 Send);代码侧 = Bridge `/send`/`/chat-threads` 工具拒绝目标为告警频道的 Lead 发送 + lead-alert.sh 认统一 env。

### 4.2 架构总览(推荐形态)

```mermaid
flowchart TD
    SRC[watchdogs / detectors / gate-poller<br/>全部发射源] --> RT{InfraEventRouter<br/>发射侧分类}
    RT -->|issue 进展类 且绑 thread| TH["[FLY-XX] issue thread<br/>@ 责任方(founder/Lead)<br/>复用 founder-thread-notifier"]
    RT -->|非紧急通知类| NF["#flywheel-notify<br/>(FLY-927 只留 hook,迁移=FLY-929)"]
    RT -->|infra 工单类| LAN[LeadAlertNotifier<br/>+schema头 +单一发送身份 +20/min 令牌桶]
    LAN --> AL[(#flywheel-alerts<br/>工单队列)]
    AL --> HUB[AlertChannelHub<br/>+owner @-target +状态机 NEW→ACK→…<br/>+root edit-in-place +T2 判定]
    HUB --> ARC[interim ARC = AutoRepairBot/Cass<br/>目标态 = owner bot 认领(FLY-928)]
    ARC -->|修掉| RES[安静 resolve 已修]
    ARC -->|2次/5分 修不掉| ESC{绑 issue?}
    ESC -->|是| TH2[founder page 进 issue thread<br/>工单标 已升级]
    ESC -->|否| ANN[工单 thread @Annie]
    WD2[Watchdog v2<br/>checkpoint-park 元组巡检 1h] --> RT
```

### 4.3 各块要点

- **Router**:纯函数 `classifyInfraEvent(payload) → thread | ticket | notify`,按 kind 分类表 + issue 绑定检查;落在 alertSink 前(plugin.ts 接线层),不重写 notifier。默认(功能 env 未设)= 现状直通,字节兼容。
- **@-target 映射**(纯函数 + env 注册表):默认 owner = Claude Infra Bot;`usage_limit/login_expired`(Claude 侧)→ Codex bot;Codex 侧账号/auth → Claude bot;provider 无关(runner 卡死/超时/529)→ Claude bot;**watchdog v2 的「等 Lead 响应」类 → owner = 动态责任 Lead**(Linear 评论追加的第三类 owner)。owner bot user id 来自 env(`FLYWHEEL_INFRA_BOT_USER_ID` 已有 = Codex;新增 Claude 位)。owner 未配置 → 不 @、走现状 Cass 行为(FLY-928 前无回归)。
- **生命周期**:`alert_threads` 扩 `ticket_status`(NEW/ACK/REPAIRING/RESOLVED/ESCALATED)+ `owner` + `attempt_count` + `first_seen`;root 消息 edit-in-place 展示状态;ACK 来源 = ① Bridge 内 ARC 开跑(Cass)② owner bot 调 action 路由(account-switch/rescue 已有原子 claim)→ 顺手打 ACK;T2 = 2 次尝试或 5 分钟超时 → 升级;**无人认领兜底**:owner 已配置但 N 分钟无 ACK → 升级(owner 未配置则直接走现状)。
- **速率**:令牌桶(20/min,env 可调)包住 root post + drainQueue;溢出 → 入既有 queue + 每窗口一条聚合摘要(「N 条已攒批:kind×m…」);thread 内操作不占额度(工单上限语义 = root)。shell 路径:按分钟计数文件近似,超限写 queue 由 Bridge 代发。
- **schema 模板**(root):`🎫 [<project>] <kind> · <leadId/execId 短> · 首见 HH:MM · owner @<bot> · 状态 <NEW>` + body。**同 PR 内更新 LeadWatchdog `ownStateRegion` 的告警模板签名**(FLY-220 echo-immunity,不然新模板回声会重新触发风暴家族)。
- **Watchdog v2**:新 `checkpoint-park` 派生器(纯函数):〈stage = `session_stage`,球在谁 = checkpoint/status 派生(brainstorm/approve_to_ship→founder;question→lead;awaiting_review→founder;auto-QA 在跑→ci(尽力);其余 runner)、owner = `resolveLeadForIssue`、waiting_since = gate `created_at` / `awaiting_review_entered_at` / `stage_updated_at`〉。1h(env)巡检 piggyback GatePoller/Heartbeat 现有 tick(FLY-169 不加 timer);发射走 Router(issue 进展类 → thread);措辞统一模板 `[FLY-XXX] [Runner] 停在<真实stage>已<N>h,球在<party>,owner=<Lead>,下一步=<…>`;首响应 = owner(Lead 走 lead_events 催单/Runner 走 mailbox wake),再超一窗才 founder page。**不重建 605/637-ext/195**:它们保留为快路径,v2 是「1h 真相兜底 + 措辞校正」——把 `three_stage_stuck` 等发射点的 kind/文案改从元组取。
- **W-B**:idle suppressor(FLY-193)+ `isTransientThrottlePane`(FLY-218)覆盖确认 = 用真 fixture 补验收测试;新 kind「529 runner 真停」= stuck-candidate/quiet-classifier 识别 throttle-stall 形态(pane 有 529/限流残留 + 无进展)→ 独立 kind 进白名单 @ Claude bot。
- **spec 文档(W2)**:新 `doc/architecture/infra-alerts-spec.md` —— 三频道合同、铁律(告警≠通知/默认不 @Annie/单 owner/谁都不救自己)、工单白名单 + owner 表、schema、生命周期。随本 issue PR 合入。

### 4.4 备选(为何不选)

- **B1 机械绑定路由**(凡绑 issue 全进 thread):runner 卡死/nudge/修复噪音全刷进 Annie 看的 thread,bot 队列空转,白名单表成空文。弃。
- **B2 双贴(thread + 队列都发)**:违反 CH-3 ⑤「绝不埋进全局告警频道」的对偶(thread 错误不进频道)且制造双份状态同步。弃。
- **B3 owner bot 自己扫频道认领(无 @)**:两 bot 竞争同一工单,违反「无双 bot 竞争」;mention-gate 现成机制就是为点名设计。弃。
- **B4 Watchdog v2 重写五套看门狗为一个引擎**:半径巨大、回归风险高(195/605/637 都带 Codex 多轮 review 的安全闸);v1 用「元组派生 + 措辞收口 + 1h 兜底」达成 Annie 的四点要求即可。弃(留 follow-up)。

## 5. 依赖与部署顺序

- FLY-927 全部机制 **default-off / 未配置 = 现状字节兼容**(项目纪律)。
- @-target 的 Claude Infra Bot 位在 FLY-928 建好前为占位:owner 未配置 → 不 @ + Cass 现状;Codex bot 位(pool-03)已可配。
- 发送身份收口的目标 token = Claude Infra Bot(FLY-928 后);过渡可先配 Cass。
- Discord 频道权限收紧 = ops 步骤(Annie/Tadashi 执行),写进部署清单。

## 6. 带到 brainstorm gate 的确认点

1. **Q-A 路由语义**(§4.1):按「响应者」划(infra 健康→队列;issue 进展→thread;升级时 founder page 进 thread)—— 对 PRD 两处字面冲突的裁定。
2. **Q-B 发送身份**(§4.1):单一 infra 发送身份收口(env 未设=现状),归属走 schema 头 —— 明确取代 FLY-368 v1.56 own-bot 链的既有决定。
3. **Watchdog v2 形态**:不重写既有五套,做「stage-真相元组 + 措辞收口 + 1h 兜底巡检」;ci 一方 v1 尽力建模(auto-QA/land-status),不做一等状态机。
4. **scope 确认**:FLY-927 只建队列机制/路由/门禁/schema/生命周期 + watchdog v2;interim ARC 沿用 Cass;bot 本体与部署 = FLY-928。
