# FLY-1687 Bridge 派发式 Lead 巡检(patrol_tick) — 调研

Issue: FLY-1687 (https://linear.app/geoforge3d/issue/FLY-1687/机制-bridge-派发式-lead-巡检patrol-tick-纯闹钟名册声明清单与判断全在-lead-侧独立核founder)
日期: 2026-08-13
基于: exploration.md

本文是代码事实核查(两轮并行只读审计的归档),为 plan.md 的每个选型提供 file:line 依据。

---

## 1. 触发载体:Bridge 现存定时器盘点

FLY-1570 物理拆除了 21 个「追人型 watchdog」模块(守卫测试 `bridge/__tests__/fly1570-watchdog-teardown.test.ts` 断言文件已删)。幸存的周期机制里,与本单相关的候选挂载点:

| 候选 | 位置 | 节奏 | 判 |
|---|---|---|---|
| **GatePoller 子节拍**(选定) | `gate-poller.ts:490` start / `:496` setInterval 3s / `:530` poll();子节拍 `(tickCount-1) % N === 0`,`DEFAULT_PATROL_EVERY_N_TICKS = 20`(`:316`)≈ 60s | 60s | ✓ 三个同构先例:FLY-725 milestone patrol(`:1810`)、FLY-208 A2 inbox 巡检(`:922`)、FLY-1614 turn-wake drain(`onReconcilePatrolTick`,`plugin.ts:7480`)。poll 内已有 `for (project) → for (lead)` 双层循环(`:653` 起),`this.polling` guard 单飞 |
| LeadWatchdog `onPollComplete` | `LeadWatchdog.ts:275-288`;`plugin.ts:10612-10689` 已挂 6 个 rider | 10min 全舰一圈 | ✗ 粒度 10min:若 founder 把 interval 调到 15min,due 判断误差最高 +10min(67%),不满足「下一个 tick 即按新频率」的体感 |
| 新建 setInterval | — | — | ✗ FLY-1570 后「零新 timer」是纪律(FLY-1169/1172/1614 代码注释反复强调) |
| 外部 cron 打 HTTP | `plugin.ts:2737` `POST /api/patrol/scan-stale`(GEO-270) | 外部 | ✗ 多一个外部依赖;「新 Lead 零配置」要再接线 |

60s 子节拍上做 per-(project, lead) 的 due 判断,due 判断每次现读配置 → **动态热调是选型的自然结果,不是额外机制**。

## 2. 注入路径:Bridge → Lead 信箱

### 2.1 生产主路(唯一)

FLY-1373 后,Bridge→Lead 的生产投递统一为 **comm.db `mailbox` 表 + per-Lead 1s `LeadInboxLoop`**:

- mailbox schema:`packages/flywheel-comm/src/mailbox-schema.ts:41`(`delivery_id UNIQUE / recipient_kind / msg_class / state QUEUED|LEASED|ACKED|DEAD / priority / collapse_key`);
- 装配:`bridge/lead-inbox-runtime.ts:150`(per-project MailboxQueue)+ `:204-221`(per-Lead loop);
- 投递适配器 vendor-neutral:`bridge/lead-delivery-adapter.ts:55`(Claude → 团队 inbox 文件 + sidecar)/ `:88`(Codex → unix socket)。**一条注入代码同时覆盖 Claude/Codex Lead**;
- Lead 侧消费:Claude Lead 由 claude-code 自带 inbox poller 注入会话;`flywheel-inbox` MCP 1s 轮询推送(`packages/inbox-mcp/src/index.ts:193`)。

### 2.2 标准注入样板(选定)

`bridge/actions.ts:179-194`(`sendActionHook`)是最小样板,三步:

```ts
const seq = store.appendLeadEvent(leadId, eventId, eventType, payload, sessionKey); // 审计+去重
const envelope: LeadEventEnvelope = { seq, eventId, event, sessionKey, leadId, timestamp };
await registry.dispatchLeadEvent(envelope); // → mailbox 入队 + 自动 nudge
```

链路:`runtime-registry.ts:108 dispatchLeadEvent` → `lead-event-queue.ts:15 enqueueEvent`(`delivery_id = lead_event:<leadId>:<eventId>`,`from_agent="bridge"`,`msg_class="model"`)→ `lead-inbox-runtime.ts:365 nudge` → LeadInboxLoop 立即拉一次。

**幂等**:`lead_events` UNIQUE `(lead_id, event_id)`(`StateStore.ts:3013` `idx_lead_events_dedup`)——同一 eventId 全生命周期最多一条,重启/并发/replay 都兜住(与 FLY-1614 `turn-wait:<...>` 幂等键同一手法)。

### 2.3 渲染与 kind 登记

- 新 `event_type` 需在共享 renderer 加分支:`bridge/mailbox-lead-runtime.ts::formatEnvelope`(`:206` 起;不加分支会落进 `:307` 的通用 formatter,渲染不出两句模板);
- FLY-1082 kind-contract(`plugin.ts:4090`,`bridge/kind-contract.ts`):**alert kind** 必须登记 owner+ARC 姿态否则 Bridge 拒启动。patrol_tick 走 lead_events(非 LeadAlertNotifier alert),实现时核实是否命中该校验面,命中则登记;
- LeadAlertNotifier(`LeadAlertNotifier.ts:837`)只到 Discord 不进 Lead 会话 → 不是本单通道。

### 2.4 lastTickAt 账本:lead_events 即账本(零新表)

lead_events 每行带 seq(单调)+ 时间戳。due 判断 = 查该 (lead, project) 最近一条 `event_type='patrol_tick'` 的行:

- 无行 → 到期(首 tick);
- 有行且 `delivered_at IS NULL` → 上一条还没送达(Lead 忙/卡),**跳过本轮**(防堆积:每 Lead 至多一条未送达 tick);
- 有行且已送达且 `now - created >= interval` → 到期,发新 tick。

`delivered_at` 由 LeadInboxLoop 投递后回写(`store.markLeadEventDelivered(seq)`,`StateStore.ts:10853`)。重启后账本仍在 → 无 boot 风暴、无节奏丢失。需新增一个 StateStore 只读查询(`getLatestLeadEventByType` 之类),无 schema 迁移。

## 3. 「active runner sessions > 0」口径

### 3.1 status 词表(canonical: `packages/core/src/workflow-fsm.ts:150-191`)

全集:`pending / running / awaiting_review / ship_parked / approved_to_ship / design_done / completed / approved(legacy) / blocked / failed / rejected / deferred / shelved / terminated`。

现存分组:
- `getActiveSessions()`(`StateStore.ts:5629`)= `running, ship_parked, awaiting_review, approved_to_ship` — **不含 `design_done`**(FLY-1319 事故注释在 `:5600-5612`);
- 保护集(`StateStore.ts:6061`)= 上述 + `pending, design_done` — **本单名册口径选这个**:巡检对象恰是「Bridge 认为还活着的一切」,parked design 正是易被遗忘形态;
- `TERMINAL_STATUSES`(`:371`)、`OUTCOME_STATUSES`(`:357`)为终态参照。

### 3.2 session → Lead 归属

sessions 表**没有 lead 列**(`StateStore.ts:2540` DDL;TS 类型 `:913`),归属靠推导:

- 权威函数 `resolveLeadForIssue(projects, projectName, issueLabels)`(`ProjectConfig.ts:1009`):label 交集 first-match,无匹配回落 `project.leads[0]`;
- 包装 `matchesLead` / `filterSessionsByLead`(`bridge/lead-scope.ts:51/:66`);
- ⚠️ 陷阱(`StateStore.ts:6709` 注释):`matchesLead` 不是 project 边界,两 project 可复用同一 lead id → **必须先按 `project_name` 过滤**;
- 现成同构写法:`lead-inbox-runtime.ts:236` `hasLiveSession`:`store.getActiveSessions().some(s => matchesLead(s, lead.agentId, projects))`(它就是「该 Lead 有没有活 runner」的现役判断,用于 1s/30s 节奏切换)。

### 3.3 零 tick 面

cos(`canSpawnRunners:false`,`ProjectConfig.ts:49`)、companion(`:75`)、external(`:81`)不加载 patrol rules；实现须显式排除 `canSpawnRunners:false`，不能依赖 `resolveLeadForIssue()` 的首 Lead fallback 天然为空；若活跃 session 落到该 fallback，以 30min bucket 进入既有 severe 告警面而非静默从 roster 消失；项目若无 patrol-capable Lead，告警归 fleet 而不污染 companion channel。

## 4. Lead 侧:rules 文件与巡检工具

### 4.1 落点:扩展 `runner-patrol-rules.md`(FLY-369)

- 已在 dept 分支**双路径**接线:`claude-lead.sh:2273-2277` + `lead-rules-bundle.sh:365`(mailbox 与 commdb 回退双 backend 都加载);
- companion/external/cos 均不加载(与零 tick 面一致);
- 内容契约守卫:`fly369-patrol-rule.test.ts` 锁定锚点(runner_terminal_list / parked-alive / FLY-271 / FLY-368 / discipline-not-guarantee / /api/chat-threads/send / FLY-576 等)——扩展必须保留全部既有锚点,并为 patrol_tick 节新增锚点;
- 现文件明确「natural cadence — no new timer」(`:20-22`):定时器落在 Bridge 侧后,Lead 侧措辞需更新为「tick 是定时主触发,natural cadence 保留为事件驱动补充」,Lead 自身仍不建 timer;
- 若新建文件则需四处接线(两脚本+README+pinned array),且 resolver parity 测试是单向的(`lead-rules-bundle.test.ts:267-277` 只断言 resolver ⊆ claude-lead.sh),漏接不红——现存漂移先例:`default-enable-policy.md`/`discord-reply-contract.md` 在 resolver dept 分支缺失 → **扩展现有文件规避整类风险**。

### 4.2 名册核对的地面真相(清单第 1 条的可执行性)

- runner tmux session 名:`sanitizeTmuxName("runner-<projectName>")`(`run-infra.ts:996`)→ 如 `runner-flywheel`;
- window 名:`<identifier>-<runnerName>-<cleanedTitle>`(≤50 字符,`packages/core/src/tmux-naming.ts:36`,`Blueprint.ts:2754`,identifier 优先,FLY-272)→ 巡检时窗名前缀即 Linear identifier,与 tick 名册的 identifier 直接可对;
- 反查:window option `@flywheel_exec_id`(`bridge/tmux-lookup.ts:75-86` `list-windows -a -F ...`);
- 已知观察噪声:脚手架窗被改名 `zsh` 后 prune(`TmuxAdapter.ts:1728`)、cmux 镜像 session `cmux-<window>`(`tmux-lookup.ts:31-36`,同一 window_id 双名)、Codex Lead TUI 窗 `<project>-<leadId>`;**Claude Lead 本体在私有 socket,共享 server 上看不到**(`LeadWindowLocator.ts:31-36`)——清单里要写明这些「正常存在的非 runner 窗」,防误报;
- `runner_terminal_list`(现清单起点)分类=CommDB status + tmux 探针,**部分独立**于 StateStore 账本,但仍是系统内部工具;FLY-1687 清单要求的地面真相是 `TMUX= tmux` 直查——二者并列使用,互为交叉。

### 4.3 交接/交卷账与外部真相(清单第 3-5 条)

- engine 节点表 vs TURN belt:`workflow-turn-ledger-validator.ts`(FLY-921 belt)+ engine 节点由 dashboard/HTTP `GET /sessions?leadId=`(`bridge/tools.ts:197-378`)可查;
- 外部真相:`gh pr view <n> --json headRefOid,state,isDraft` 问 GitHub;Discord thread 状态问 Discord 本体——清单条目注明「不采信内部账本转述」。

## 5. 配置:层级、热读、合规

### 5.1 「不加新 flag」铁律的边界

`CLAUDE.md:138`(FLY-1466);守卫 `feature-flags-drift.test.ts:23-72`:抓 `process.env.FLYWHEEL_*` 全部 + 注入式 `env.X` 仅当布尔比较。**flag(on/off 门)禁;tuning knob(数值参数)允许**,先例:`truth.ts:243-247` `FLYWHEEL_FOUNDER_MILESTONE_PATROL_TICKS: "tuning knob: ..."`。`patrol.interval` 是数值参数,合规;**绝不进 `feature-flags/registry.ts`**,机制无 on/off 开关(无条件启用,靠「零 runner 零 tick」自然静默)。

### 5.2 热读参照:models.json 模式

`packages/config/src/model-config.ts:120-149`:snapshot cache,cache key = `path:dev:ino:mtimeMs:size`(`fileCacheKey`,`:136-149`),每次读取 statSync 对比,变了才重新解析;文件缺失时 key 带 `unavailable:<errcode>` 也参与缓存(不反复报错)。env `FLYWHEEL_MODELS_CONFIG` 仅覆盖**路径**(测试注入用),不承载数值。

### 5.3 现存 config-source 模式为什么不能直接用

`founder-milestone-config-source.ts:22-43` 等 4 个同构文件都是 **Bridge boot 预加载成 Map**——FLY-205 ship 教训「补装 config 后必须再重启一次 Bridge」即此形态,正是 founder 2026-08-12 追加点名要避免的。本单必须换成 per-due-check 热读(5.2 模式)。其**安全红线注释必须继承**(`founder-milestone-config-source.ts:1-12`):读 `<projectRoot>/.flywheel/config.yaml` 一律指 mainline checkout,绝不指 PR worktree(防 runner 改自己 PR 的 config 影响 Bridge 行为);malformed config 记日志按缺省处理,单项目坏配置不拖垮整体。

### 5.4 项目级 schema 与校验先例

- schema:`types.ts:625 FlywheelConfig` 加 `patrol?: PatrolConfig`;
- 校验:`ConfigLoader.ts::validate`,floor warn+抬升先例 `:220-241`(FLY-159 gate timeout:低于 floor 不 throw,warn+抬到 floor,保 boot 连续性);
- 默认常量:`constants.ts:24/35` 模式(`DEFAULT_PATROL_INTERVAL_MS` + `MIN_PATROL_INTERVAL_MS`);
- ConfigLoader 单测模板:`packages/config/src/__tests__/ConfigLoader.{roles,xiaohongshu,proofshot}.test.ts`。

### 5.5 全舰一处配置的载体

现存全局载体盘点:`~/.flywheel/projects.json`(boot 读,非热)、`~/.flywheel/.env`(进程启动定格,改需重启,违反热调)、`~/.flywheel/models.json`(热读,但语义是模型注册表,塞巡检参数是语义污染)。⇒ 需新建**全局热读文件 `~/.flywheel/patrol.json`**,完全复刻 models.json 读取模式。优先级:项目 `.flywheel/config.yaml` `patrol.interval_minutes` > `~/.flywheel/patrol.json` `interval_minutes` > 代码默认 60。三层全热(前两层 mtime 热读,第三层常量)。

## 6. FLY-1614 边界(已互认,无冲突)

FLY-1614 侧三处把本单划出:`engineering/doc/FLY-1614-turn-handoff-deadline/exploration.md:76`(「Lead 独立巡检兜底 = FLY-1687,不在本单」)、`plan.md:64`、`plan.md:96`(「§2.3 是引擎自检,不替代 1687 独立巡检」)。其「单次播报硬合同」(幂等键 + CommDB 事务 insert-or-verify)与本单 2.4 的 lead_events UNIQUE 手法同源。

## 7. 结论:选型定案(供 plan)

| 决策点 | 定案 | 依据 |
|---|---|---|
| 触发 | GatePoller 60s 子节拍 + per-(project,lead) due 判断 | §1 |
| 注入 | appendLeadEvent + dispatchLeadEvent,event_type=`patrol_tick` | §2.2 |
| 幂等/账本 | lead_events 即账本(UNIQUE 去重 + 最近行做 lastTickAt),零新表 | §2.4 |
| 防堆积 | 上一条 tick 未送达则跳过本轮 | §2.4 |
| 名册口径 | 非终态 6-status 集(含 pending/design_done) | §3.1 |
| 归属 | project_name 过滤 + matchesLead | §3.2 |
| 配置 | 项目 YAML(热)> `~/.flywheel/patrol.json`(热)> 默认 60min;floor 抬升;非 flag | §5 |
| Lead 清单 | 扩展 runner-patrol-rules.md + 扩展 guard test | §4.1 |
| tick 内容 | 固定两句模板,renderer 加 `patrol_tick` 分支 | §2.3 + exploration §4.4 |

## 8. 实现时需现场核实的点(plan 里标注)

1. `formatEnvelope` 分支与 `hook-payload.ts` 共享 renderer 的精确接缝;
2. kind-contract 校验(`plugin.ts:4090`)是否覆盖 lead_events 的 event_type 面;
3. `fly369-patrol-rule.test.ts` 全量锚点清单(审计只读了前 60 行);
4. lead_events 查询是否需补 (lead_id, event_type) 索引(表小,可能不需要);
5. mailbox `collapse_key` 语义(若 enqueue 层已有 coalesce,可作防堆积的第二道保险);
6. `FLYWHEEL_PATROL_CONFIG`(路径覆盖 env,仅测试)是否会被 `feature-flags-drift` 抓到(models.json 的 bracket-access 读法在扫描盲区,照抄即可;若红则按 `truth.ts` 加 `tuning knob` 理由行)。
