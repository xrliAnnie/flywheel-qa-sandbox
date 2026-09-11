# FLY-1942 通信层防线三件套 — 探索
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: 无

## 0. 一句话

三个缺陷共享同一个病根:**判定发生在离真相很远的地方,而失败的结果没有回到做决定的人手里。** `send` 不看收件人是否存在;Codex Lead 的动态订阅只活在一个进程的内存 Set 里;routing guard 把一次 1.5 秒超时当成「Bridge 不健康」并对所有频道一刀切。本单把三处判定拉回可核的事实源,并让每一次拒绝/死信都带着读数回到发信方。

## 1. 问题与成功标准

| # | 缺陷 | 验收(issue 原文) | 本单成功标准(可证) |
|---|---|---|---|
| 一 | `flywheel-comm send --to <8 位短 ID>` 打印 message id 后静默死信 | 短 ID send 当场报错;turn-wait 问题可正常关闭 | ① 短 ID 要么当场拒收要么补全为唯一全 UUID 并回显;查无此人 / 已终结当场 exit 非 0;② 引擎侧「收件人不存在」与「已终结」分成两个死因,且死信通知在找不到 owning Lead 时回落到发信方;③ `runner-messaging-rules.md` 增加「全 ID + 发后验 ACKED」公共段;④ turn-wait 冒号 ID 的 `respond` 已由 FLY-2014 修复,本单只补一条回归断言,不重做 |
| 二 | Codex Lead 被 @ 一次后永久收听该话题线程 | 重放「驱动一次回话」,订阅 TTL 后自动消失;清单可查 | ① 动态订阅有 TTL、上限、落盘账本与审计行;② 订阅只能由**显式声明**的 roundtable 父频道铸造,不再回退到「第一个跨部门频道」;③ `list` / `unsubscribe` 两个操作入口;④ 进程重启不再是唯一的清理手段 |
| 三 | routing guard 以 `guard_unavailable` 拦跨 Lead 消息,而 Bridge 毫秒级健康 | 「Bridge 健康 + guard 拦」形态不再发生;guard 拒发时给出可核的探针读数 | ① 本地兜底镜像 Bridge 的分类:只有**自己聊天频道顶层**才 fail-closed,跨 Lead / founder 频道与 Bridge 健康路径一致放行;② 401/403 与超时/网络错分成不同 reason;③ 拒绝文本携带 url / 尝试次数 / 超时 / 状态或错误 / 延迟 / 时间戳 / 本地分类;④ 每次 unavailable / deny 落一行审计到插件 state dir |

## 2. 已确认事实

### 2.1 第一件:短 ID 静默死信

**现场证据(生产快照 `flywheel-comm-20260911T004811Z-87199.db`,只读)**

- 近 30 天 `mailbox` 里 `dead_reason='recipient_terminal'` 共 206 条;其中 `to_agent` 长度为 8 的 24 条,**全部** `from_agent='flywheel-eng-lead'`、`type='instruction'`,最近一条 2026-09-10T19:30Z。
- 这 24 条里每一个短 ID 在 StateStore(`teamlead.db`)都能唯一命中一个**当时正在运行**的全 UUID 会话(例:`32e42494` → `32e42494-3606-4ab5-98cf-15e91b5b7fe2`,FLY-2456 implement,19:26:59 起、22:05:03 终结;信发于 19:27:47)。内容是给替身 runner 的 rework#6 返工清单——即「你说做了结果什么都没做」的那一类。
- StateStore 3256 个 execution_id(排除 `exec-qa-` 夹具)8 位前缀零碰撞;但这是经验事实,不是保证(`path-helpers.ts:158-161` 自己注明 8 位是 32-bit 命名空间)。
- 从 created_at 到 dead_at 中位约 18.6 秒 = 一个 runner-mailbox tick。
- 同期 `from_agent='bridge-land'` 的 recipient_terminal 死信 141 条(引擎给自己刚标 terminal 的节点发清理指令,Linear 8-22 评论第三例)——**不在本单修**,见 §5。

**代码路径**

- CLI 入口 `packages/flywheel-comm/src/index.ts:876-912` `runSend`:对 `--to` 的唯一检查是非空(`:893`);成功只打印 id(`:909-913`)。命令体 `commands/send.ts:18-38` 只授权发信方,不查收件人;入队 `db.ts:4300-4336` `insertInstructionWithId` 只用 `to_agent` 猜 recipient_kind(`:4327`:以 `-lead` 结尾为 lead,否则 runner)。
- 死信判定不在 CommDB,而在 Bridge 的 runner-mailbox lane:`mailbox-queue.ts:1948-1978` 对 QUEUED 行调 `recipientState(to_agent)`;`"unknown"` 被拒绝终结并写 `terminalizationRefused` 警告,`"terminal_or_missing"` 直接 `UPDATE … DEAD, dead_reason='recipient_terminal'`。
- `recipientState` 的真相源是 StateStore:`StateStore.ts:11615-11629` `resolveRunnerRecipientState`——`getSession` 精确匹配(`:1540`),**查不到行直接返回 `terminal_or_missing`**。「不存在」与「已终结」被合并成一个状态,这就是短 ID 秒死的机制。
- 为什么零报错:死信通知 `scanAndInsertDeadLetterNotices`(`mailbox-queue.ts:2190-2320`)靠 `resolveOwningLead(recipient)` 找 Lead;该函数(`lead-inbox-runtime.ts:271-294`)从**收件人自己的 session 行**取 projectName,收件人不存在 ⇒ `undefined` ⇒ `result.unroutable`(`:2264-2268`)⇒ 不写任何通知。对比:`terminalizationRefused` 警告有 `resolveOwningLead ?? fallbackLeadId ?? warning.fromAgent` 三级回落(`runner-mailbox-lane.ts:269-271`),死信通知没有——这是不对称,也是最便宜的修点。
- 8 位短 ID 的来源:`agent-team-transport/src/path-helpers.ts:163-168` `deriveRunnerMailboxIdentity` = `runner-${execId.slice(0,8)}`(Lead 的 `SendMessage` MCP 走这个地址域);Lead 可见的展示面 `issue-display-refresher.ts:381,915`、`StateStore.ts:12275`(`execution_id8`)、`epic-page/signals.ts:71,91` 都打 8 位。**两条 Lead 发信通路用两个地址域**,`flywheel-comm send --to` 要全 UUID,`SendMessage` 要 8 位——短 ID 不是笔误,是被系统教出来的。
- 仓内没有任何按前缀解析 execution_id 的 helper(grep `LIKE`、`resolveSession`、`ByPrefix` 均无)。
- **CLI 本地可用的事实源**(runner 进程只有 `FLYWHEEL_INGEST_TOKEN`,没有 `TEAMLEAD_API_TOKEN`,`TmuxAdapter.ts:692-695`,所以校验不能依赖 Bridge `/api/sessions/:id`):
  - `session_receipt_lineage(execution_id PK, project_name, issue_id, lead_id)`:1523 行,`registerSession` 同事务写入(`db.ts:7849`),run-dispatcher 在 spawn 前预注册(`run-dispatcher.ts:1244`),**永不删除**。这是「这个 ID 曾经是一个真实会话」的持久证据,可做前缀展开。
  - `sessions`(CommDB,14 行):spawn 时注册为 running;终结时 `markSessionTerminalStatus` 改 status + ended_at;只有拿到**死亡证明**的 `finalizeSession*`(`db.ts:8220-8262`,FLY-2313)才删除行(调用方 `commdb-session-prune.ts:120,170,381`、`commdb-fsm-reconcile.ts:172`)。因此:lineage 有 + sessions 无 ⇒ 已 finalize ⇒ terminal;sessions 有 + status ∈ {completed,failed,timeout,blocked} + ended_at ⇒ terminal;sessions 有 + running ⇒ 活着或崩溃残留(快照里有 4 条 8-25~9-8 的 running 残留)。parked / awaiting_review 体在 CommDB 仍是 running(memory:CommDB 词表没有 ship_parked),不会被误判。
- `flywheel-comm sessions list`(`index.ts:1163-1167`)打印的是**全** ID。
- `respond` 的收件人是 `question.from_agent`(`commands/respond.ts:87,96,100,109`);Linear 8-22 评论的变种(节点 terminal 后 respond 报成功再死信)走同一条 `insertGuardedResponse` 入队,同一层校验可覆盖。
- **turn-wait 冒号 ID**:`db.ts:7048` 铸 `turn-wait:<waiter>:<holder>:<epoch>`;`gate-marker.ts:119-141` `SAFE_QUESTION_ID=/^[a-zA-Z0-9_-]{1,128}$/`。FLY-2014(`88c3df6b9`,2026-08-24)已把读路径改成 `markerPathIfSafe` 软失败,`respond` 对 turn-wait ID exit 0;回归测试在 `__tests__/gate-marker.test.ts:88-92`、`cli.test.ts:655-657`。快照里 `ref_id LIKE 'turn-wait:%'` 的 response 均 ACKED。**本单不重做**,只在 plan 里保留一条「跑现有断言」的验证项。
- 规则文件 `packages/teamlead/lead-rules-base/runner-messaging-rules.md`(104 行,9 个标题);wake matrix `:70` 写着 `flywheel-comm send` 是「✅ unconditional mailbox write — the driver path」,这句被本缺陷证伪,要一并改。装配:`claude-lead.sh:2698-2704`、`lead-rules-bundle.sh:337-370`(`FLYWHEEL_COMM_BACKEND=commdb` 时跳过此文件),Codex 全权限 Lead 走 `assemble_full_access_governance`(`:408+`)同一 bundle。膜拜顺序由 `lead-rules-bundle.test.ts:187-204` 钉死——加段落不动顺序不需改测试。
- 发后验证面已经存在:`flywheel-comm message-status <id>`(`commands/message-status.ts:73-138`)打印 `<live|archived> <STATE> <id> | dead_reason=… | …`,exit 0/1/2/3。缺的只是「send 让你知道要去查」和「规则要求你查」。

### 2.2 第二件:Codex Lead 动态订阅

- 订阅铸造点唯一:`roundtable-reply-in-thread-wiring.ts:118-134` `resolveReplyRoute` 在**路由解析**时对 `r.replyRoute` 触发 `void subscribeImmediate(threadId)`(不 await、在 journal 去重之前、重投递也触发)。`replyRoute` 只由 `roundtable-reply-route.ts:99-108` 的 1b 分支产生:roundtable **父频道**里一条过了 mention gate 的顶层非回复非噪音消息,`threadId === msg.id`。
- `subscribeImmediate`(`:136-146`):有 `guildId` ⇒ `discovery.subscribe`;否则直接 `registry.add + source.addChannel`。Mufasa 的 launcher 不设 `FLYWHEEL_ROUNDTABLE_GUILD_ID`,`flywheel-lead.sh:139-154` `sanitize_codex_child_env` 也把它 unset ⇒ 生产走的是 else 分支 ⇒ **无 reconcile、无归档回收、无上限**(cap=50 只在 discovery 路径 `RoundtableThreadDiscovery.ts:174-185`)。
- 数据结构全在内存:`RoundtableThreadRegistry.threads: Set<string>`(`RoundtableThreadRegistry.ts:21`,无时间戳无序列化无日志)、`RestPollDiscordInboundSource.dynamicChannels: Set<string>`(`:114`)。四个消费者共用 registry:RestPoll 轮询、`CodexDiscordGateway.passesFilters` 白名单(`:282-287`,`registry.has` 与静态频道**同权**)、mention gate、回复路由。
- 为什么变成「抢答 founder」:`mention-gate.ts:149-163`(FLY-576)——动态线程里**任何非 bot 作者的消息无需 @ 直接处理**,并重播种 bot 预算;`autoContinue` 自 FLY-676 起硬编码 true(`codex-lead-runtime.ts:686`)。所以「被 @ 一次」= 从此该线程里 founder 说什么都回。
- roundtable 父频道的解析有治理漏洞:`codex-lead-runtime.ts:664-668` `parentChannelId = FLYWHEEL_ROUNDTABLE_CHANNEL_ID || crossDeptChannelIds[0]`。launcher 只导出 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=<registry .roundtableChannel>`(`flywheel-lead.sh:152-154`),不导出 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID`;Mufasa 专用 launcher 的 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="${…:-<roundtable>}"`(`run-codex-lead-mufasa-tui-fullaccess.sh:62`)可被环境覆盖。⇒ operator 调试时给进程塞一个别的频道到跨部门列表首位,那个频道就成了「roundtable」,能铸订阅。这与 issue「在 #flywheel-engineer 回过话后永久收听」的形态一致。
- 退订原语存在但没有任何 operator 可达的调用者:`registry.remove()`、`source.removeChannel()` 只被 cap 驱逐与归档 reconcile 调用;`registry.list()` 只有测试调用;没有 HTTP / socket / CLI 面。
- 磁盘残留:`<stateDir>/inbound-cursor.json`(`InboundCursorStore.ts:41-60`)会为动态线程写 `{channelId: messageId}` 游标,永不清理、无时间戳无原因——是取证残留不是账本;issue 说「磁盘全净」在这一点上不完全准确,但它确实**不能**回答「现在订着谁、为什么、到期没有」。
- 宿主进程:订阅 Set 在 **Node runtime 进程**(`codex-lead-runtime.js` / `codex-lead-tui-runtime.js`)里,不在 codex 模型子进程,也不在 `gateway/` 动作子进程;两种 runtime 的接线相同(`codex-lead-runtime.ts:1733-1741`、`codex-lead-tui-runtime.ts:713-727`)。生产 plist 走 `~/.flywheel/bin/flywheel-codex-lead-wrapper-*.sh`(generic carrier,FLY-2444)。
- 该进程已有一条认证的 Unix socket:`CodexLeadInboxSocket.ts`(v2,方法 `submitBatch` / `capabilities`,HMAC-SHA256,secret = Lead bot token,只有 Bridge 与 TUI 进程持有)——「查清单 / 手动退订」可挂在这条既有通道上,不新开监听。
- 状态目录 `FLYWHEEL_CODEX_LEAD_STATE_DIR`(`codex-lead.sh:145-159`,`~/.flywheel/state/codex-lead/<safe>-<hex>/`,chmod 700),已有 `journal.db / outbox.db / inbound-cursor.json / lead-actions-audit.jsonl / gateway-*-audit.jsonl`;审计行前例 `discord-send-core.ts:86-97`(`appendRotatedLogSync`,best-effort、metadata-only、永不让动作失败)。
- Bridge 侧 `bridge/roundtable/RoundtableThreadManager.ts` 没有动态订阅(它是 thread 创建/装饰 + 游标持久化),issue 里「疑 Bridge 层同款」查无实据。Claude 插件侧 `rtMemberThreads`(`server.ts:150,278-298`)是 Discord thread-members API 的**成员资格缓存**,收听范围由 `access.json` 与 Discord 成员关系决定,不是本单意义上的动态订阅。
- 现状:2026-09-11 本机没有 Codex lead runtime 进程在跑(Mufasa 当前由 Claude carrier 承载,`ps` 可见 `--channels plugin:discord@claude-plugins-official`;Codex 账号池 9-04 全灭,memory)。⇒ 本单的验收「重放驱动一次回话」在实现阶段只能靠单测 + fake source 证明;生产回放要等 Codex lead 重新上线,这是诚实边界。

### 2.3 第三件:routing guard 误拦

- **代码不在本仓**。`guard_unavailable` 唯一产地是插件 fork `xrliAnnie/claude-plugins-official` `external_plugins/discord/server.ts`(本地 checkout `~/.flywheel/repos/claude-plugins-official` 落后 origin/main 8 个提交;origin/main `e122f46` 的 `server.ts` 与装机 `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts` **逐字节一致**,`installed_plugins.json` 记录同一 SHA)。以下行号按 origin/main。
- `callReplyGuard`(`server.ts:362-455`):**没有健康探针**。它就是一次 `POST ${BRIDGE_URL}/api/discord/reply-guard`,`setTimeout(abort, 1500)` 字面量(`:377`),无重试无缓存;404 fail-open(路由未部署);**任何其他非 2xx(401/403/429/5xx)都 `throw`**(`:396`)进 catch;catch 里的兜底顺序:core 频道放行(FLY-173)→ roundtable 线程放行(FLY-314)→ `localHasIssueToken(text)` 为真则 `{allow:false, reason:'guard_unavailable'}` → 否则放行。
- 因此 unavailable 模式的判据确实是「正文有没有 `FLY-|GEO-` 单号」(`GUARD_TOKEN_RE`,`:329-338`),与频道是谁的无关——8-22 评论 Honey Lemon 的推断被代码证实。而 Bridge 健康路径(`tools.ts:1276-1356` + `reply-guard.ts:87-126`)把「不是自己 chatChannel、不是登记的 issue thread」的目标分类为 `"other"` ⇒ **允许**。⇒ 跨 Lead 频道在 Bridge 健康时允许、Bridge 抖动时拒绝——这就是「fail-closed 过宽」的精确含义。
- 拒绝文本(`guardDenyResult`,`:457-468`):`BLOCKED by routing guard (guard_unavailable). Issues: . Bridge routing guard unavailable; do not post issue content at the chat-channel top level — use POST /api/chat-threads/send when the Bridge is healthy.`——`issues` 在此路径为 undefined 所以打出空列表;**零探针读数**;错误原文只写到 MCP 子进程 stderr,不落盘,事后不可核。建议的替代通路 `chat-threads/send` 投的是发信 Lead 自己频道下的 issue thread,对跨 Lead 场景是空建议(8-22 评论已指出)。
- 「Bridge 毫秒级健康仍拦」的最可能机制:Bridge 事件循环成段卡顿(FLY-2008 exploration `:15,44`:`/health` 8.32s/33.75s 成段发作,HL 被 guard 拦的时刻正落在发作段内;gate-poller 定时器堆积自我延续 5–12 秒)。guard 采样 1.5 秒窗口,operator 三次 curl 采样另一个窗口。`/api/sessions` 是同步 store 读(`tools.ts:152-250`),与 `/health` 的 `shuttingDown / admissionPause / liveness` 无关,所以「/api/sessions 200」也不能反证 guard 那一刻的 1.5 秒内 Bridge 有响应。
- 另一条被合并进「不健康」的路:`TEAMLEAD_API_TOKEN` 在 pane 启动时经 `env -i` 冻结(`claude-lead.sh:2098-2099`),token 轮换后 401 ⇒ 永久拦。今天没有证据说这发生过,但代码上 401 与超时同 reason,发生了也分不出。
- 插件已知的本地事实:`DISCORD_CORE_CHANNEL`(core 豁免,由 `claude-lead.sh:2111` 从 `LEAD_CORE_CHANNEL` 注入)、`TEAMLEAD_ISSUE_PREFIXES`、`DISCORD_STATE_DIR`(`:74`)。**插件不知道自己的 chatChannel**——Bridge 分类里最关键的那个量没有被注入。`buildAuthorizeLeadChannel`(`codexLeadBridgeWiring.ts:65-102`)已从 projects.json 派生 `{chatChannel, generalChannel, roundtableChannel}`,是同一数据源。
- 插件 fork 有 `bun:test` 测试族(`reply-send.test.ts`、`roundtable-*.test.ts` 等),CI `sync-upstream.yml` 外另有「run runtime tests on plugin changes」提交(`3c72cd9`)。guard 客户端至今**没有测试**(FLY-162 plan §12.9 (b) 要求过,未写)。
- 上线合同(memory `discord-plugin-rollout-paths-and-rollback-contract`):受管上线 = `restart-services.sh` 在 `restart.lock.d` 内跑 `check_discord_plugin_fork` → 更新到 fork main → 重检 → Lead wave;回滚 = 除 `.claude-plugin/plugin.json` 外全部 revert + 版本 patch+1(updater 忽略非更新版本)。fork main 是一条**冻结窗口**:合入即对下一次受管重启生效。

## 3. 方案比较

### 3.1 第一件

| 方案 | 内容 | 优点 | 代价 / 风险 |
|---|---|---|---|
| A. 只在 CLI 加格式门 | `send/respond` 拒绝非 36 位 UUID | 最小 | 只堵一个入口;不能区分「笔误」与「刚终结」;Lead 仍得自己去查全 ID |
| B. 在 `insertInstructionWithId` 加存在性检查 | 覆盖所有写入者 | 一处修 | `send-mailbox.test.ts:57` 钉死「Runner session 行存在之前 mailbox 行必须可入队」;引擎自身的写入者(design-review-manifest、codex-instruction…)也会被误伤;它们的问题是另一族(§5) |
| C. StateStore 把 `!session` 拆成 `unknown` | 队列对 unknown 拒绝终结并写 refused 警告(已有回落到 fromAgent) | 立刻从「静默杀」变「有警告」 | 行永远 QUEUED 卡在信箱;每 tick 一条 refused 警告(有 identity 去重,`:791-797`,同一 sourceId 只一次)——但「不存在的收件人」的行永远不会被清理,这是新的泄漏 |
| **D(推荐)= CLI 三层本地校验 + 引擎侧拆死因 + 死信通知回落发信方 + 规则段** | 见 §4.1 | 每层各堵一种失败;全部用本地事实源(runner 无 API token 也能跑);不改 `insertInstructionWithId` 的持久性合同 | 新增一个前缀解析 helper(net-new);要在 `send` 与 `respond` 两处接线;文案要同步到 rules + wake matrix |

否决 B:引擎内部写入者的合法用例(预注册后立即入队)会被误伤,而且 8-22 的「引擎给 terminal 节点发指令」是 §5 边界。否决 C 单独用:把静默丢变成静默堵。

### 3.2 第二件

| 方案 | 内容 | 优点 | 代价 / 风险 |
|---|---|---|---|
| A. 只加 cap | 把 discovery 的 cap=50 搬到 else 分支 | 一行 | 50 个线程仍然永久;不解决「为什么订」「订到何时」「怎么退」 |
| B. 只靠 Discord 归档 reconcile | 让 launcher 设 `FLYWHEEL_ROUNDTABLE_GUILD_ID` | 复用既有 discovery | 依赖 Discord 端归档(默认 24h~3d 由频道设置决定);仍无账本无审计无手动退订;operator 塞频道的漏洞不变 |
| **C(推荐)= 带元数据的订阅账本 + TTL/上限 + 显式 roundtable 父频道 + socket `listSubscriptions`/`unsubscribeThread` + CLI** | 见 §4.2 | 订阅变成有来源、有到期、可查可撤的一等对象;重启不再是清理手段;域收紧在 launcher+runtime 两层 | registry 从 `Set<string>` 变成 `Map<string, Entry>`,四个消费者的 `has()` 语义不变但要加过期判断;新增一个 TS CLI;需要 fake clock 的测试 |
| D. 把订阅搬到 Bridge 集中管理 | Bridge 持有所有 Lead 的订阅表 | 一处可查 | 违反 FLY-1373 的设计:durable accept 与 pump 必须在同一进程;Bridge 挂了 Lead 就不能读线程;工程量大 |

### 3.3 第三件

| 方案 | 内容 | 优点 | 代价 / 风险 |
|---|---|---|---|
| A. 只把 1500 改大 + 重试 | timeout 5s、重试 1 次 | 一行 | Bridge 5–12 秒卡顿段仍会拦;跨 Lead 频道被拦的**根因(分类缺失)**未动 |
| B. unavailable 时全部 fail-open | catch 里直接放行 | 不再误拦 | 放弃 FLY-162 的设计目的(TC-02:issue 内容漏到自己频道顶层);Codex 会问「那 guard 还守什么」 |
| **C(推荐)= 本地分类镜像 + 分级 reason + 读数 + 审计 + 超时/重试可配** | 见 §4.3 | 只在 Bridge 健康时也会拦的那一种情形(自己频道顶层 + 单号)才 fail-closed;拒绝可核;401 可见 | 插件要多知道一个 env(`DISCORD_OWN_CHAT_CHANNEL`);两仓两 PR;rollout 走冻结窗口 |
| D. guard 改走 `/health` 探针 + 缓存 | 先探 health 再决定 | 「探针读数」字面满足 | `/health` 与 reply-guard 同一事件循环,卡顿时一起聋(FLY-2008);缓存上一次 allow 等于在卡顿时盲放,与 B 同病 |

## 4. 推荐设计(供 research/plan 展开)

### 4.1 第一件

1. **`send` / `respond` 收件人校验层(CommDB 本地,新 helper `resolveRunnerRecipient(db, raw)`)**
   - 形态:`lead` / `*-lead` ⇒ 原样(lead 收件人不在本单);36 位 UUID ⇒ 精确;`^[0-9a-f]{8,35}$`(允许含 `-` 的前缀)⇒ 按前缀在 `session_receipt_lineage` 找;其他 ⇒ `recipient_malformed` exit 2。
   - 存在性:lineage 0 命中 ⇒ `recipient_not_found` exit 1;≥2 ⇒ `recipient_ambiguous`(列出候选)exit 1;1 ⇒ 展开并在 stderr 回显 `resolved <prefix> → <uuid>`。
   - 终结:`sessions` 无行(lineage 有)或 status ∈ terminal 且 ended_at 非空 ⇒ `recipient_terminal` exit 1,文案指向 `flywheel-comm sessions list` / 换体。`running` ⇒ 放行(崩溃残留由引擎侧兜底)。
   - `--allow-terminal` 明确旁路(为引擎 / 特殊协议保留;默认关)。
   - 成功输出增加第二行:`state=QUEUED · verify: flywheel-comm message-status <id>`;`--json` 增加 `resolved_to` 与 `verify_command` 字段。
   - `respond`:对 `question.from_agent` 做同一终结检查(修 8-22 变种);gate 类问题(`workflow-gate:` / `turn-wait:` 前缀,marker-bearing)不做终结检查,因为 gate 义务本就允许对 completed 节点投递(Linear 8-21 评论第三例)。
2. **引擎侧拆死因**:`resolveRunnerRecipientState` 返回三态 `alive | terminal | missing`(`RunnerRecipientState.state` 新增 `missing`);队列对 `missing` 仍标 DEAD 但 `dead_reason='recipient_missing'`;`terminal_or_missing` 保留为兼容别名一版后删。
3. **死信通知回落发信方**:`scanAndInsertDeadLetterNotices` 的 `resolveOwningLead` 为空时,若 `from_agent` 是本项目 projects.json 里的 Lead ⇒ 通知发给 `from_agent`;否则维持 unroutable。与 refused 警告的回落链对齐。
4. **规则段**:`runner-messaging-rules.md` 新增 `## Recipient ID + post-send verification (FLY-1942)`:全 UUID 或 ≥8 位前缀、CLI 会当场报错的三种 reason、发后保留 message id、下一次巡检 tick 用 `message-status` 核 ACKED、DEAD ⇒ 重发到正确收件人;wake matrix `send` 行改为「✅ 收件人存在且未终结时」。Codex 全权限 bundle 同文件同段。
5. **turn-wait**:只在 plan 的验证清单里跑 `cli.test.ts` 的 turn-wait 断言,不改代码。

### 4.2 第二件

1. **registry 升级为账本**:`RoundtableThreadRegistry` 内部 `Map<threadId, {parentChannelId, source:'mention'|'discovery'|'restore', subscribedAt, lastActivityAt, expiresAt}>`;`has()` 对过期条目返回 false(读时惰性判定);`add()` 接受 entry;新增 `touch(threadId, now)`、`sweepExpired(now)`、`snapshot()`。
2. **TTL 与上限**:`FLYWHEEL_ROUNDTABLE_SUBSCRIPTION_TTL_MS`(默认 24h,以最后一次**被接受的**入站消息刷新)、`FLYWHEEL_ROUNDTABLE_REPLY_CAP`(既有,默认 50,对两条路径都生效)。sweep 定时器 60s,复用 `setTimer` 注入。
3. **域收紧**:`flywheel-lead.sh` 同时导出 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID=<registry .roundtableChannel>`;runtime 删除 `crossDeptChannelIds[0]` 回退——无显式父频道 ⇒ reply-in-thread 关闭 ⇒ 不铸任何动态订阅;`subscribeImmediate` 只接受 `route.parentChannelId === parentChannelId` 的路由(防御性断言)。
4. **落盘**:`<stateDir>/roundtable-subscriptions.json`(整表原子重写,`{version:1, leadId, entries:[…]}`)+ `<stateDir>/roundtable-subscriptions-audit.jsonl`(`{ts, op: add|remove|expire|evict|restore|reject, threadId, parentChannelId, reason, actor}`,`appendRotatedLogSync`)。启动时恢复未过期条目并 `source.addChannel`(游标已在 cursor store)。
5. **查询 / 退订**:socket v2 新增 `listSubscriptions` 与 `unsubscribeThread {threadId, reason}`(HMAC 同 `capabilities`);新 CLI `packages/teamlead/src/codex-lead-subscriptions-cli.ts`(`list | unsubscribe --thread <id> [--reason]`,`--lead <id> --project <name>` 定位 state dir,`list` 直接读账本文件、`unsubscribe` 走 socket,socket 不在则拒绝并提示 runtime 未运行)。
6. **不做**:不给 Claude 插件加同款(它没有动态收听);不把订阅集中到 Bridge;不改 FLY-576「人类在已订线程里无需 @」的语义(TTL 让它有边界即可)。

### 4.3 第三件

1. **插件 fork**:把 guard 客户端抽成 `reply-guard-client.ts`(可注入 fetch/clock/env),`server.ts` 只调用。行为:
   - 请求:timeout `TEAMLEAD_REPLY_GUARD_TIMEOUT_MS`(默认 4000,上限 10000),abort/网络错重试 1 次(退避 250ms);HTTP 4xx/5xx 不重试。
   - 结果分类:`allow` / `deny`(Bridge 判)/ `not_deployed`(404 ⇒ 放行)/ `unauthorized`(401/403)/ `unavailable`(abort、网络错、429、5xx)。
   - 本地兜底(`unauthorized` 与 `unavailable` 共用):core ⇒ 放行;roundtable 线程 ⇒ 放行;`chatId === DISCORD_OWN_CHAT_CHANNEL` 且有单号 ⇒ 拒绝(reason 分别 `guard_unauthorized` / `guard_unavailable`);其他频道 ⇒ 放行并写审计 `local_classification=other`。`DISCORD_OWN_CHAT_CHANNEL` 未注入(旧 launcher)⇒ 维持今天的宽 fail-closed,但 reason 标 `guard_unavailable_legacy_broad` 并带读数。
   - 拒绝文本追加 `probe={url, attempts, timeout_ms, outcome, http_status|error, latency_ms, at, local_classification}`,`Issues:` 为空时不打。
   - 审计:`<DISCORD_STATE_DIR>/reply-guard-audit.jsonl`,每次非 `allow` 结果一行(deny 也记),best-effort 轮转。
2. **本仓**:`claude-lead.sh` 在 `DISCORD_CORE_CHANNEL` 同一 `env -i` 屏障处注入 `DISCORD_OWN_CHAT_CHANNEL=<lead.chatChannel>`(无条件设置,空则为空);Bridge 路由不改。
3. **顺序**:本仓 PR 先合(多一个未被消费的 env 无害),插件 PR 后合;plugin.json 0.0.7 → 0.0.8;受管上线走 `restart-services.sh`;回滚按 memory 合同。
4. **诚实边界**:Bridge 真卡顿 >(timeout×2+退避)时,Lead **自己频道顶层**带单号的消息仍会被拒——这是 FLY-162 设计的保留行为,只是现在拒绝带读数并可事后核。跨 Lead / founder 频道在任何 Bridge 状态下都不再被本地兜底拦。

## 5. 边界(评论区追加项的处置)

以下四项在 Linear 评论里被并入本单主题,但各自是独立机制,本单**不修**,已向 Lead 发非阻塞确认(question `ee7bbdf5`,默认按此切):

| 项 | 为什么不在本单 | 建议 |
|---|---|---|
| bridge-land 给刚 terminal 的节点发清理指令(近 14 天 141 条死信 + 「未签收」告警噪音) | 发信方是引擎,收件人真的 terminal;修点在 land-cleanup 的发信时机/是否需要发,不是收件人校验 | 另开单;本单的 `recipient_missing` 拆分能让报表把它与短 ID 类区分开 |
| MAILBOX_STALE 假阴性 / 死信不进巡检 STEP 4 | 巡检指标定义问题 | 另开单;本单的「死信通知回落发信方」会让这类死信至少到达一个 Lead |
| `lead-alert.sh` claims.db 不可用时 fail-open;drain 不回写 alert_deliveries | 告警投递层 | 另开单(FLY-2452 家族) |
| FLY-913 护栏按词误拦(launchd 动词 + label 前缀;文档正文也拦) | 是 restart-guard hook,不是 routing guard;同名「guard」不同物 | 另开单;9-11 评论已给方向(按 plist 内容判 + 文本类工具豁免) |

另:gate/manifest 类投递对「completed 但仍持 gate 义务」节点的可达性(8-21 评论第三例)属于引擎终态判定,已由 `isTerminalDeliveryObligation` 保护协议行;本单 `respond` 对 gate 类问题不做终结检查,以免再造一个拒收面。

## 6. 开放问题

1. 8 位前缀展开是否要求 **≥ 8 位**还是允许更短?建议 ≥ 8(与展示面一致),更短一律 `recipient_malformed`。
2. `recipient_terminal` 的本地判定把 CommDB `running` 残留视为活——可接受(引擎兜底 + 通知回落);是否值得在 CLI 有 `TEAMLEAD_API_TOKEN` 时多问一次 Bridge?倾向不做,保持一套判据。
3. 订阅 TTL 默认 24h 是否过长?founder 视角「驱动一次 = 永久」的对立面是「一天后自动消失」,可接受;可用 env 调。
4. 插件 `DISCORD_OWN_CHAT_CHANNEL` 未注入时保留宽 fail-closed 还是直接按 `other` 放行?倾向保留(byte-compat),因为 launcher 与插件不同步上线时不能悄悄放宽。
