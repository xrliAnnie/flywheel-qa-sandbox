# FLY-1426 入站消息 generic 收据 — 实施计划
Issue: FLY-1426 (https://linear.app/geoforge3d/issue/FLY-1426/infrabug3-founderlead-discord-chat-零-durable-收据-入站消息-generic-收据)
日期: 2026-07-22
基于: research.md

**Status**: codex-approved（design review 4 轮:R1 8H + R2 3H/4M + R3 1H/2M 全部采纳,R4 APPROVED;R4 非阻塞图注已同步）

## 0. 一句话

把 Claude Lead 的 Discord chat 入站（founder / 其他 lead / DM）接进 FLY-1392 已建成的 generic 收据机器：插件在 accept 边界写 pending 行 → 投递后标 delivered → Lead 办结/显式回复关账 → 逾期由现成 patrol 重发、再逾期升级 founder —— **零新收据机器，只新增一个 producer 和一条 lane 限定的升级 venue 补丁**。

## 1. 目标与非目标

### 目标（= issue 验收）

1. founder 在 chat 交代任务 → comm.db `lead_inbox` 有 canonical 行（先落账，再进对话）。
2. Lead 未处理 → P0 窗口（30min）到期 → patrol 重发提醒进 Lead 收件箱 → 重发耗尽 → detection-escalation 升级 founder。
3. Lead 处理 → 收据关闭（带 `reply_to` 的显式回复 auto-settle,或 `handle-receipt` 显式办结）。
4. 覆盖矩阵（R1#8 修正 —— 不再笼统说「全覆盖」,逐格诚实）：

| Lead 形态 | chat 入站收据 | 依据 |
|---|---|---|
| Claude 标准 dept lead（Tadashi/Peter/…） | ✅ 本单交付 | env 三件套在（research §2.1 活进程实证） |
| Codex lead（Mufasa full-access 等） | ✅ 已有 journal.db at-least-once durable（FLY-224）;chase 对齐 = follow-up 注记 | 非本单改动 |
| Claude **companion/external 角色**（launcher 刻意清空 `FLYWHEEL_COMM_DB`/`FLYWHEEL_COMM_CLI`,`claude-lead.sh:1417-1430`） | ❌ **显式剩余 gap** —— 隔离设计使其无 comm.db 可写;不静默冒充覆盖,写进 founder HTML 诚实边界,follow-up 单独立项（受限 broker 或独立 spool producer） | R1#8 |

5. 真机验证一条真实 founder 消息全链。

### 非目标（诚实边界，写进 founder HTML 第 5 节）

- **不解决 Lead session/插件 down 期间的 gateway 消息丢失**（该窗口内消息到不了 accept 边界;Codex 式 durable cursor + REST 回捞 = follow-up）。
- **companion/external 角色的 chat 收据**（见覆盖矩阵,显式 gap）。
- **不改 Bridge 事件腿**;**不动 permission-reply**（结构化审批,有 ✅/❌ reaction 回执,非 chat 投递）。
- **不给「已处理」做质量判定**（同 FLY-1392 §6.2）。
- Bridge down 期间追办停摆（FLY-1392 既有边界;但**记账不停** —— 直写 comm.db）。

## 2. 总体设计

```mermaid
sequenceDiagram
    participant F as founder/lead (Discord)
    participant P as discord 插件 (bun, fork)
    participant SP as recovery spool (DISCORD_STATE_DIR)
    participant C as flywheel-comm CLI (node)
    participant DB as comm.db lead_inbox
    participant L as Lead 模型
    participant PT as Bridge patrol (现成)

    F->>P: messageCreate
    P->>P: gate() 通过 (accept 判定,零漂移)
    P->>C: spawn chat-receipt begin (blocking, ≤5s)
    alt begin 失败/超时
        P->>SP: 原子落 spool 意图 (fail-open 投递照走)
        P-->>SP: ready/新消息时有界重试 drain;积压→一次可见 advisory
    end
    C->>DB: enqueue(id=chat:lead:msg, carrier=external, pending)
    P->>L: mcp.notification (channel 注入, meta 带 receipt_id)
    P->>C: spawn chat-receipt complete (bounded await ≤5s)
    C->>DB: markExternalDelivered (开 P0/P1 追办窗)
    alt Lead 显式回复且 reply_to 真正上线 (非 roundtable 剥除)
        L->>P: reply 工具 (reply_to=入站 msgId)
        P-->>C: spawn chat-receipt settle
        C->>DB: markProcessed (证据①: discord_explicit_reply)
    else Lead 显式办结
        L->>C: handle-receipt ack (现成 CLI)
    else 逾期
        PT->>DB: advanceDue → resend child (进 Lead 收件箱)
        PT->>F: 重发耗尽 → detection-escalation → founder page (chat lane 限定 venue)
    end
```

复用面（全部现成,零改动）：enqueue/markExternalDelivered/markProcessed、episode 收养、advanceDue 重发、resendCap、`handle-receipt`、detection-escalation 状态机（Lead-first → 30min grace → founder page,每 episode 一次）。

## 3. 数据设计

| 字段 | 取值 | 依据 |
|---|---|---|
| `id` | `chat:<leadId>:<discordMsgId>`（幂等键,可反解 msgId） | 镜像 `xdept:` 惯例 |
| `carrier` | `external`（插件承运,行只是收据;永不被 queue 承运面选中） | FLY-1392 §2.1 |
| `msgClass` | `model`（enqueue 必填,R1#7 补） | `lead-inbox-queue.ts:75-95` |
| `source` / `type` | `discord_chat` / `external_delivery` | type 与 Codex saga 对齐 |
| `priority` | 插件显式传:author == `DISCORD_OWNER_USER_ID` → **P0**;其余过 gate 者 → **P1** | FLY-1392 T7 |
| `refMessageId` | **NULL** | `idx_lead_inbox_ref` 全局 UNIQUE（`lead-inbox-queue.ts:191-192`）;避开与 founder lane（ref=裸 discord id）双投递撞车 |
| `content` | **versioned 可 round-trip 信封（R1#7 冻结）**:首行 `[discord-chat-receipt v1] {compact JSON}`,JSON 字段=`{v:1, receiptId, leadId, chatId(路由后), originChannelId(路由前), messageId, authorId, authorName, ts, priority, msgKind:"dm"\|"guild"\|"roundtable", attachments:[{name,type,sizeKb}], text}`;第二行起 `<authorName>: <原文>`（人读,resend child 展示用）。reconcile 仅解析首行 JSON,重投所需 meta 全部自足,**不需要 Discord REST** | R1#7 |

收据 id 呈现给 Lead：notification `meta.receipt_id` + Lead 规则写明推导公式 `chat:<自己的 leadId>:<message_id>`（公式为权威）。

## 4. 切片

### S1（本仓,PR-1）：`flywheel-comm chat-receipt` 子命令 + queue 选择器

新文件 `packages/flywheel-comm/src/commands/chat-receipt.ts` + `index.ts` dispatch：

| 子命令 | 行为 | 幂等/错误 |
|---|---|---|
| `begin --lead L --chat-id C --origin-channel-id O --message-id M --author-id U --author-name N --priority 0\|1 --ts ISO --msg-kind dm\|guild\|roundtable [--attachments-json J] --content-stdin` | 组 v1 信封 → `enqueue{id, carrier:external, msgClass:"model", priority, content}` | 同 id 重放 = no-op 成功;同 id 异字段 = 现有「reused with different field」抛错;缺参/非法值 exit≠0 |
| `complete --lead L --message-id M` | `markExternalDelivered(id,{now,receiptWindowsMs})`,窗口沿用 env `FLYWHEEL_RECEIPT_WINDOW_P<n>_MIN`（抽公共 env 解析 helper） | 已 delivered 重放成功;行不存在 exit≠0 |
| `settle --lead L --message-id M --reply-id R` | `markProcessed(id,{evidence:{v:1,kind:"discord_explicit_reply",ref:R,actor:L,actor_kind:"lead",fence:{leadId:L,chatReplyTo:M},basis:["discord_reply_reference"]}})` | 行不存在/已终态 exit≠0(插件仅 log);同证据重放幂等 |
| `pending --lead L --json [--cursor SEQ] [--limit N]` | **新 DB 选择器**（下）输出 JSON `{rows:[{seq,id,envelope…,createdAt}], nextCursor}`;信封解析失败行带 `parse_error` 标记不吞 | — |
| `quarantine --lead L --message-id M` | `quarantineExternalDelivery`,**reason 固定为稳定值 `chat_delivery_unconfirmed`**（R2#7:现 API 在 reason 变化重放时提交状态却返回 false —— 两个调用方统一 stable reason;wrapper 成功判定 = 「行已 quarantine 且 one-shot alert 已存在」,补异 reason 重放测试）。quarantine 是**附加**动作:之后仍必须 redeliver+complete,不替代重投 | 幂等（统一 reason + alert INSERT OR IGNORE） |

**R1#1 采纳 —— 删除按年龄 abort**：chat lane 无 journal、无 absence watermark,`markExternalAborted` 的 `basis:["journal_absent","retention_watermark"]` 对本 lane 是虚假终态证据,违反 FLY-1392 R3#3（TTL 只触发 reconcile,不是 disposal authority）。超龄 pending 行**保持非终态**:quarantine + advisory + 仍可重投补 complete。`abort` 子命令**不提供**（未来若有权威 absence proof 再立项）。

**新 DB 选择器（R1#7 + R3#2）**：`LeadInboxQueue.listExternalPendingForLane({toLead, idPrefix, cursorSeq?, limit, createdBefore?, excludeQuarantined?})` —— SQL 级 `WHERE carrier='external' AND delivered_at IS NULL AND disposed_at IS NULL AND processed_at IS NULL AND to_lead=? AND id LIKE ?||'%' AND seq>? [AND created_at<=?] [AND disposition IS DISTINCT FROM 'delivery_quarantined'] ORDER BY seq LIMIT ?`：
- **`processed_at IS NULL`**：排除 settle-before-complete 行,重启不重投已办结消息（R1#1 尾注）;
- lane 前缀过滤下沉 SQL,不再被其他 Lead/xdept 的更早 pending 行遮蔽;
- **`createdBefore`/`excludeQuarantined` 谓词下沉 SQL**（R3#2:候选筛选不留在 JS 层,scan budget 不被非候选行重复消耗）;
- seq cursor 稳定分页;
- 同时挂 `CommDB` wrapper（`listChatReceiptPending`/`quarantineChatReceipt`）给 S2 patrol 当 seam。

约束：db 路径 = `FLYWHEEL_COMM_DB`;content 一律 stdin;单事务、无网络。

### S2（本仓,PR-1）：升级链补丁（lane 限定,R1#6）

1. **owner 解析修复**：`plugin.ts` `notifyUnprocessed`（:7831）在 `payload.projectName === "unknown"` 时用 patrol 供值（回调签名已带真 projectName）重建 `projectName`/`targetKey` 再进状态机。负测:双 unknown 仍 false。
2. **founder page venue（严格 lane 限定）**：`createFounderPager` 中,fallback 仅当 `row.kind === "receipt_unprocessed"` **且** `row.episode_fingerprint`（= 该 lane 的 rootId,持久可测）前缀为 `chat:` 且无 issue thread 且 `target.chatChannel` 存在 → 用该 Lead 的 bot token 在 **Lead 的 chat channel 顶层 @founder**;发送失败回落现有 `onUndeliverable` ticket lane（**先试 chat venue,失败才 ticket,不先建 ticket**）。**非 chat 行为字节不变**:补「非 chat kind + 无 thread → 仍走原 onUndeliverable」反向测试（R1#6）。founder-page ledger 去重原样。
3. **patrol 兜底 quarantine（R2#6 + R3#2 补 seam/公平性合同）**：`LeadReceiptPatrolOptions` 扩展注入 per-project Lead ids（来源 = `projects` registry,patrol 现只有 `projectNames`,`lead-receipt-patrol.ts:9-29`）;pass 内**逐 Lead** 调 S1 seam,谓词全下沉 SQL（`createdBefore=now-60min` + `excludeQuarantined`,返回即候选,零 JS 层筛）。**公平性（R3#2）**:cap 按 **per-Lead 份额**（如 20 行/Lead/pass,而非 project 总额）;**per-Lead cursor 跨 pass 持久化**（存 comm.db 侧 kv 或 patrol 内存 + wrap-around:到尾回 0）,首 Lead 持续 backlog 不饿死后序 Lead,深页候选跨 pass 必达。测试:跨 ≥2 个 pass 候选位于 cap 之后仍被处理;首 Lead 持续 backlog 下次 Lead 仍获份额;一项目多 Lead。quarantine 非终态,插件回来 reconcile 仍可重投补 complete。

### S3（fork 仓,PR-2）：插件 accept 边界记账

新模块 `chat-receipt-recorder.ts`（纯逻辑:启用判定/信封组装/头解析/spool 编解码）+ `server.ts` 接线：

1. **启用判定（R1#2 + R2#1 修正 —— 按真实 launcher env shape）**：判定顺序:
   ① `FLYWHEEL_LEAD_COMPANION === "1" || FLYWHEEL_LEAD_EXTERNAL === "1"`（launcher 现成 role marker,`claude-lead.sh:1491-1499`）→ **legal-disabled,零行为零告警**（隔离角色本就无 comm.db;launcher 清 COMM 两项但仍传 `FLYWHEEL_LEAD_ID`,`:1425-1438` —— 不能按「缺件」误判为破损）;
   ② 三件套 `FLYWHEEL_COMM_CLI && FLYWHEEL_COMM_DB && FLYWHEEL_LEAD_ID` 全缺 → **stock 环境,零行为**（byte-compat）;
   ③ 全在且 `FLYWHEEL_CHAT_RECEIPTS !== "0"` → 启用;
   ④ 非隔离角色且**部分在** → Flywheel-managed 配置破损,fail-loud:启动 stderr 大写告警 + 首条消息向该 chat 发一次可见 advisory。
   测试用真实 launcher env shape 正反各测（companion 形态 = LEAD_ID 在 + COMM 两项空 + marker 在 → 零告警）。
2. **spawn 合同（R1#3 修正,按 Bun 1.3.11 实测）**：`Bun.spawn([...], {stdin:"pipe", stdout:"pipe", stderr:"pipe"})`（**绝不 inherit —— MCP stdout 神圣**）;`proc.stdin.write(content); proc.stdin.end()`;`await proc.exited` 带 5s 超时,超时 `proc.kill()`;stdout/stderr drain 后再判 exit code。集成测试必须是**真实 Bun spawn 真实 build 后 CLI + 临时 comm.db**（mock seam 抓不到 stdio 合同错误）。
3. **begin**（gate deliver + permMatch 之后、typing 之前）：blocking spawn ≤5s。**失败/超时（R1#2 + R2#2/#4 修正）**:fail-open 照常投递,并把 begin 意图**原子落盘**到 `${DISCORD_STATE_DIR}/chat-receipt-spool/`（`<msgId>.json`,内容 = v1 信封 + **durable 控制字段 `{attempts, advisedAt}`**,write-tmp-then-rename;目录 0700、文件 0600 —— 内含 founder 原文）。
   **spool drain 状态机（R2#2 —— 绝不制造假 delivered）**:drain（① gateway ready ② 每条新消息尾部 piggyback,单次最多 5 个,ready 与 piggyback **串行化**互斥）只做**幂等补 `begin`**;begin 成功 → 删 intent 文件 → 该行此后以 pending 形态由**本进程 pending reconciler** 走标准 `[redelivery]` notify → await 成功 → 才 `complete`。**任何路径都不允许未经本进程确认 notify 成功就 complete**（external carrier 的 accept/deliver 边界）。
   可见性（R2#4）:`attempts`/`advisedAt` 持久在 intent 文件里,重启不清零、不重复提醒;spool 深度 > 10 或单文件 attempts > 5 → 向该 Lead 的 chat channel 发**一次**可见 advisory（durable latch = advisedAt）;**spool 落盘本身失败 → 立即一次可见 advisory**（不允许 stderr-only 兜底态）。
4. **complete（R3#3 修正 —— 有界 await,不再纯 fire-and-forget）**：`mcp.notification` resolve 后 spawn complete 并 **await（≤5s 超时）**;成功/失败结果记入进程内 per-msgId 状态。**统一 recovery worker**:ready drain、spool drain、pending reconcile 三者收敛为**单个串行 worker**;消息尾部 piggyback 只是「踢一下 worker」。顺序合同:worker 的 pending snapshot **显式排除本轮刚 notify 且 complete 结果未定的 receipt**（per-msgId in-flight 集合）;当前消息 complete 成功 → 不进本轮 snapshot;失败 → 进入重投路径。**健康路径恰一次 notification**。notification meta 增加 `receipt_id`。并发测试:健康路径恰一次;complete 失败 → 后续 `[redelivery]` → 最终 delivered。
5. **settle（R1#4 + R2#5 修正 —— 只认真实上线的 Discord reference）**：settle 谓词 = **至少一个成功发送的实际 payload 含 `reply.messageReference === <入站 msgId>`**（判定点在发送 payload 构造之后,非任何入参/中间变量）。三个已知会让 reference 不上线的路径都不 settle:① roundtable 剥除 `reply_to`;② `replyToMode === 'off'`（`sendReplyChunks` 此时不构造 `payload.reply`,fork `reply-send.ts:33-40`）;③ 发送失败。正/负测试:普通频道 reply_to settle;roundtable 剥除不 settle;`replyToMode=off` 不 settle;latest-message 无 reply_to 不 settle。不 settle 的场景 Lead 用 `handle-receipt ack` 关账,规则写明。
6. **MCP instructions/工具描述更新（R1#4）**：现指令「最新消息普通回复省略 reply_to」与 auto-settle 前提相反 —— 改为:**回复带收据的 chat 消息时,显式传 `reply_to=<message_id>`**（roundtable 场景除外,那里用 handle-receipt ack）。
7. **启动 reconcile（R1#1/#7 + R2#7 修正）**：ready 后（spool drain 之后串行执行）spawn `pending --json --cursor`,分页 drain（每页 20,页间 1s,直到空或累计 100 行/次上限,余量下轮 ready 或 piggyback 继续）;每行:以 `[redelivery]` 前缀重发 mcp.notification（信封自足）→ **await notify 成功** → spawn complete。**无按年龄 abort**;超过 48h 的行**额外** spawn `quarantine`（stable reason,非终态 advisory）,但**仍然重投 + complete**（quarantine 是可见性动作,不是处置,R2#7）。

### S4（本仓,PR-1）：Lead 规则接线（R1#5 修正）

- **不新建裸文件** —— launcher 是逐文件显式 `rules_bundle_add`（`claude-lead.sh:2172-2489`）,目录扫描不存在。落点:**扩展已加载的 `discord-reply-contract.md`**（收据关账本质是 reply 纪律的孪生面）+ 更新对应 bundle truth tests。
- 规则内容:收据 id 公式;三种关账方式 —— ① 普通 chat 回复**显式带 `reply_to=<message_id>`** = 自动关账;② roundtable 或无需回复 → 完整可执行命令（R2#3:`--lead` 为 CLI 必填,`index.ts:627-629`）:
  `node "$FLYWHEEL_COMM_CLI" handle-receipt --lead "$FLYWHEEL_LEAD_ID" --receipt <收据id> --request-id <唯一id> --action ack`
  ③ `relay/respond` **仅**用于回既有 Runner question（需仍 pending 的 `--to-question` + content）—— **founder 新任务先完成真实派发副作用再 ack,不得用 relay 冒充**（R1#5）。
- bundle truth/integration test **实际执行**该 ack 命令（临时 comm.db + 一条 chat 收据行）,不只断言文字存在（R2#3）。
- 提醒消息长相与「重发 N 次」语义说明。

### S5（本仓,PR-1 内）：launcher/发布门（R1#8）

- `claude-lead.sh` tmux env allowlist（`:1432-1474`）补传 `FLYWHEEL_CHAT_RECEIPTS` **及 `FLYWHEEL_RECEIPT_WINDOW_P0_MIN`–`P3_MIN` 四个窗口变量**（R3#1:`tmux new-window -e` 不继承未列入 env;不传则插件 `complete` 用默认窗、Bridge patrol 用 override 窗,SLA 漂移且 episode 收养的 COALESCE 不纠正;§6 真机验收的 `P0=2` 也靠它生效）。launcher launch-plan 测试断言四变量在;真机断言同一行 `next_unprocessed_at - delivered_at` = 收窄后的 2 分钟。
- companion/external 角色:真实 env shape = `FLYWHEEL_LEAD_ID` 仍在 + COMM 两项空 + `FLYWHEEL_LEAD_COMPANION/EXTERNAL=1` marker（R2#1）→ 插件按 marker 判 legal-disabled,**不误报 fail-loud**;launcher 侧零改动。
- PR-1 部署说明:merge 后生产 `git pull && pnpm -r build` 重建 `flywheel-comm/dist`;PR-2 rollout 前逐 Lead preflight:`node "$FLYWHEEL_COMM_CLI" chat-receipt pending --lead <L> --json` 退出码 0（capability gate）+ kill-switch env 检查。

## 5. 崩溃窗口表（saga 语义）

| crash 点 | 账面状态 | 恢复 | 语义 |
|---|---|---|---|
| begin 前 | 无行 | 无 | 与现状同（gateway 丢失面,非目标 §1） |
| begin spawn 失败 | 无行 + **spool 意图**（含 durable attempts/advisedAt） | drain 幂等补 begin → pending → **本进程 reconciler 重投确认后才 complete**;积压→可见 advisory | **不再有静默零收据形态**;**drain 绝不直接 complete**（R2#2） |
| spool 落盘后、notify 前 crash | spool 意图 | 重启 drain 补 begin → 重投确认 → complete;两条 crash 测试锚定（rename 后/notify 前 kill;notify reject 后重启）→ **重投成功前不得出现 delivered_at** | R2#2 |
| begin 后、notify 前 | pending | 插件重启 reconcile 重投+complete;插件长期不在 → patrol 60min quarantine → advisory | 消息不再静默丢 —— 核心收益 |
| notify 后、complete 前 | pending（Lead 已见） | reconcile `[redelivery]` 重投（at-least-once） | 双投可见、标记明确 |
| settle 先于 complete + 重启 | processed（pending 形态） | pending 选择器排除 processed 行 → **不重投** | R1#1 尾注 |
| complete 后 | delivered,窗口跑 | 正常追办 | — |
| settle spawn 失败 | delivered 未 processed | 窗口到期重发提醒,Lead 手动 ack | 落到「多催一次」,不落到「漏」 |

## 6. 测试计划

### S1 单测（flywheel-comm,真 CommDB 临时库）
- begin/complete/settle/quarantine 各幂等重放 + 异字段冲突;
- 双 lane 不撞:同 discordMsgId 先 `founder_msg:`(ref=裸id) 后 `chat:`(ref=NULL) 双行共存;
- priority 0/1 → `next_unprocessed_at` = 对应窗;
- **新选择器**:lane 前缀 SQL 过滤(他 Lead/xdept 行不遮蔽)、processed 排除、seq cursor 分页 roundtrip;
- v1 信封 roundtrip(含 attachments/roundtable 双 channel 字段) + 损坏首行 `parse_error`;
- settle 证据形状断言 + settle 后 advanceDue 不选中;
- **全链集成**:begin→complete→(不办)→advanceDue 物化 resend child(carrier=inbox)→耗尽 resendCap→`receipt_unprocessed` alert;episode 收养断言。

### S2 单测（teamlead）
- notifyUnprocessed unknown-projectName 回填 → owner 解析成功;双 unknown → false;
- pager fallback:`receipt_unprocessed` + `chat:` fingerprint + 无 thread → chat channel 顶层(断言 venue/token);**非 chat kind + 无 thread → 原 onUndeliverable 不变（反向测试,R1#6）**;chat venue 发送失败 → 回落 ticket;
- patrol quarantine 步:阈值/前缀/不重复 alert/quarantine 后补 complete 仍可达 delivered;**一项目多 Lead 逐 Lead 分页 + 前页 fresh/已 quarantine 不遮蔽后页旧行**（R2#6）;
- 反向兼容哨兵:无 chat 行时三处补丁对既有升级路径无扰。

### S3 fork 测试
- 纯逻辑(bun test):启用判定矩阵（**真实 launcher env shape**:companion/external marker=legal-disabled 零告警;全缺=零行为;非隔离部分缺=fail-loud;kill switch）、信封组装/解析、spool 编解码(含 durable attempts/advisedAt roundtrip + 0600/0700 权限)、settle 谓词(**实际发送 payload 的 reply.messageReference**,含 replyToMode=off 负测);
- **真实集成(bun test,不 mock)**:真 Bun spawn 真 build 后 CLI + 临时 comm.db —— begin/complete/settle/pending 全链 + stdio 合同(stdin pipe 写入、stdout 捕获、超时 kill)（R1#3）;
- begin 失败 → 投递照走 + spool 落盘 + drain 幂等补 begin(**不直接 complete**) + advisory durable latch(重启不清零/不重复);spool 落盘失败 → 立即一次 advisory;
- **两条 crash 测试（R2#2）**:spool rename 后/notify 前 kill;notify reject 后重启 —— 均断言重投成功前无 delivered_at;
- reconcile:分页 drain、`[redelivery]` 前缀、await notify 成功才 complete、48h+ → quarantine(stable reason,**且仍重投+complete**);
- quarantine 异 reason 重放语义测试（R2#7）;
- **并发测试（R3#3）**:健康路径恰一次 notification(pending snapshot 排除 in-flight);complete 失败 → 后续 redelivery → 最终 delivered;
- stock 环境(零 env)行为与改前逐字一致(byte-compat 断言)。

### 真机验收（issue 验收原文,529 QA 房或生产影子）
1. env 收窄窗口(`FLYWHEEL_RECEIPT_WINDOW_P0_MIN=2`);
2. founder 在 Lead chat 发任务 → comm.db `chat:` 行 pending→delivered;
3. Lead 不动 → 重发提醒可见 → 耗尽 → escalation 行 + founder page 落 **chat channel**;
4. Lead `reply_to` 回复 → processed 证据①;`handle-receipt ack` 关另一条;
5. 插件 kill -9 于 begin 后 → 重启 → `[redelivery]` + complete;
6. begin 人为致败(改 CLI 路径) → 投递照走 + spool 文件在 → 恢复后 drain 入账。

## 7. 合入与发布顺序

1. **PR-1（本仓）**:S1+S2+S4+S5 + 全部单测。
2. 生产 dist 重建 + 逐 Lead capability preflight（S5）。
3. **PR-2（fork `xrliAnnie/claude-plugins-official`）**:S3。merge → `update-discord-plugin.sh` 分发 → `check-discord-plugin.sh` preflight → **插件随 Lead session 重启生效**（先 Tadashi 验证再全队滚动）。
4. 真机验收(§6)全绿 → 报 Lead。

回退：fork 侧 `FLYWHEEL_CHAT_RECEIPTS=0`（launcher allowlist 已传,S5）;S2 补丁 lane 限定,无 chat 行即静默;S1 子命令无人调则零行为。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| begin 阻塞投递 ~200ms/条 | founder chat 低频;5s 硬超时;超时 fail-open + spool |
| bun spawn stdio 合同 | R1#3 修正合同 + 真实集成测试(不 mock) |
| meta.receipt_id 渲染未证实 | 公式为权威;真机验收确认 |
| 双投递(complete 前 crash) | `[redelivery]` 前缀显式;频率≈插件 crash 频率 |
| fork 与本仓版本错位 | 顺序合同 + capability preflight(§7/S5) + fork 调用失败 fail-open+spool |
| Lead 不养成 reply_to/ack 习惯 → 重发噪音 | MCP 指令+规则双改(S3#6/S4);resendCap=2 有界;founder P0 场景本就该显式回 |
| spool 积压静默 | 深度/重试阈值 → 一次可见 advisory(latch) |
