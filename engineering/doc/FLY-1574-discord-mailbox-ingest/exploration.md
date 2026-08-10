# FLY-1574 Discord 收编:不再直推,统一走 mailbox — 探索

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10
基于: 无(本文件夹首篇;上游权威文档为 `doc/messaging-rework/design.md`,FLY-1569)

---

## 1. 问题是什么

消息层四条流里,唯独 **Discord 入站两条流(founder → Lead、Lead → Lead)不走队列**:

- Discord 适配器收到消息后**直推**进 Lead 上下文(Claude Lead:插件 MCP notification;Codex Lead:runtime 直接注入 turn);
- mailbox 里只写一条 **`carrier='external'` 的影子收据行**(`type='external_delivery'`),事后靠 `complete`(markExternalDelivered)/`settle` 记账;
- 因为信箱不是投递路径,队列的所有保护(租约、重投、合批、死信、in-flight 上限)对 founder 的消息**一项都不生效**;
- 「两个地方都要看」:投递真相在直推链路,账在 external 影子行,两边靠事后 reconcile 缝合 —— FLY-1646 重投风暴(2026-08-06 全舰队)正是这条缝的裂开。

本单(E)把 Discord 入站收编进唯一入口:**适配器只写一行 mailbox(`QUEUED`),内容由现有投递循环按统一规则送**。

## 2. 审计后必须先亮出来的两处口径修正

开工审计(见同文件夹 research.md)发现 issue 正文有两处与合入代码不符,设计按实际代码走:

1. **「carrier 这个概念 C 单已从 schema 删」—— 不成立。** 合入的 `mailbox` 表(`packages/flywheel-comm/src/mailbox-schema.ts`)**仍有 `carrier TEXT CHECK(carrier IN ('inbox','external'))` 列**,而且它是现行影子收据机制的载体(生产 flywheel shard 实测 452 行 external)。C 单保留它正是因为 E 还没落地、直推流还活着。⇒ 删 carrier 是 **E 完成之后**才可能的事;又因 founder 的 flag 硬要求(OFF = 旧流照旧可用),**删除动作整体顺延到全家族清理单**,本单只负责让它「易删」。
2. **验收标准 2(60 秒内 3 条一次收到)依赖 D 单(FLY-1573),而 D 现在还在 Backlog。** E 与 D 并行开发;E 自身不实现合批窗口/租约到期/死信(那是 D 的地盘)。E 落地后、D 未合前,走的是 C 期投递环的「每 tick 把当下可投的行打成一批」语义 —— 碰巧同 tick 到达的多条会合并,但没有 60s 时间窗合批语义。验收 2 的完整验证要等 D 合入。

## 3. 目标形态(一句话)

**flag ON 时:Discord 消息过完 gate 之后,唯一动作是往 mailbox 写一行 `carrier='inbox'` 的普通信,然后(尽力而为地)按一下 Bridge 门铃;之后发生的一切 —— 打批、投递、durable-accept、(D 单后的)租约与重投 —— 与 Runner → Lead 的信走同一条流水线,一行都不特殊。**

## 4. 关键选择点与判断

### 选择点 A:收编动作放在哪一层?

| 选项 | 说明 | 判断 |
| -- | -- | -- |
| **A1 适配器内改(选定)** | Claude:插件 `handleInbound` 里 gate 之后分叉;Codex:`codex-lead-tui-runtime` 入站处理里同位置分叉 | ✅ gate/allowlist/roundtable 路由/permission 拦截/typing/反应 emoji 全部不动;改动面 = 「投递动作」一个点 |
| A2 新建独立 ingest 进程(Bridge 拉 Discord) | Bridge 自己连 Discord Gateway 收消息 | ❌ 重复建一套 bot 连接与 gate 逻辑;违背「适配器不变」总纲;改动面爆炸 |
| A3 插件照旧直推,Bridge 收到后转写 mailbox | 在 Lead 侧加 hook 把直推内容回写队列 | ❌ 还是两条真相链;等于把影子行反过来做一遍,病根没除 |

### 选择点 B:flag 怎么做到「运行时可切,不重新部署」?

| 选项 | 说明 | 判断 |
| -- | -- | -- |
| **B1 每条消息现读 `~/.flywheel/.env`(选定)** | 适配器处理每条入站时重读 flag 文件(FLY-709 registry 的 `dotenv_live` 时序类) | ✅ 改 `.env` 一行即全舰队即时切换,无需重启插件/Lead/Bridge;每条消息一次 stat+parse,成本可忽略 |
| B2 进程 env(启动时捕获) | `process.env` 读一次 | ❌ 回切要重启每个 Lead 会话 —— 不满足 founder「运行时可切」 |
| B3 问 Bridge 要 flag(HTTP) | 每条消息查询 Bridge | ❌ 引入 Bridge 可用性依赖到入站热路径;Bridge 重启窗口内 flag 不可判,还得再定 fail 方向 |

### 选择点 C:mailbox 信里的内容长什么样?

| 选项 | 说明 | 判断 |
| -- | -- | -- |
| **C1 复刻直推格式(选定)** | content 渲染成与今天 MCP notification 注入等价的 `<channel source="discord" chat_id=... message_id=... user=...>` 文本(含附件清单) | ✅ Lead 的回复纪律(reply 工具带 chat_id / reply_to、download_attachment)零改动;lead-rules 文档零改动;回归面最小 |
| C2 新设计一种信格式 | 结构化 JSON 信封 | ❌ 所有 Lead 的 Discord 行为规则要跟着改写,回归面失控;信息一样,只是皮不同 |

投递环已有的 `[receipt:<delivery_id>]` 头继续保留 —— 它同时就是「硬检查」的载体(见 §6)。

### 选择点 D:旧机制(影子行 + complete/settle + 重投 worker)删不删?

| 选项 | 说明 | 判断 |
| -- | -- | -- |
| **D1 本单不删,清理单删(选定)** | OFF 路径字节等价保留;本单交付「易删性」:单一分叉点 + 旧流边界注释 + 清理清单 | ✅ founder 2026-08-05 flag 硬要求明令覆盖原 scope 3/4 的删除时机;新流真跑几天后全家族统一删 |
| D2 本单直接删 | 按原 scope 3/4 执行 | ❌ 与 flag 要求直接矛盾 —— OFF 就没有可回的旧流了 |

### 选择点 E:「Lead 面前每条内容都带 mailbox id」的硬检查怎么落?

| 选项 | 说明 | 判断 |
| -- | -- | -- |
| **E1 审计口径 + 旁路日志(选定)** | ① ON 路径投递内容天然带 `[receipt:<delivery_id>]`;② 提供一个只读对账查询:Lead 收件箱 sidecar 里的 flywheelId ↔ mailbox.delivery_id 连接,查出「出现在 Lead 眼前但 mailbox 无账」的内容;③ ON 状态下适配器若走了直推分支,写一条 loud stderr 日志 | ✅ 满足 issue「至少留一条日志/一个可查询的口径」;不给热路径加硬闸 |
| E2 transport 层硬拦(无 id 拒写) | 在 `writeMailboxBatch` / MCP notify 处强制校验 | ❌ Bridge 事件、bootstrap、permission 通知等合法非信内容也会撞闸;会把「审计」做成「新的单点故障」 |

## 5. 明确不做(本单边界)

- ❌ 不动 Discord **出站**(Lead 回复 founder 的 reply 工具链路,一行不改)
- ❌ 不动最后一公里(inbox.json + sidecar / unix socket / 官方 poller)
- ❌ 不实现租约到期重投 / 60s 合批窗 / 死信闸(D 单,FLY-1573,并行开发中)
- ❌ 不删 carrier / external_delivery / chat-receipt 机制(全家族清理单;本单交付易删边界)
- ❌ 不动 permission-reply 拦截、pairing、typing keepalive、ack reaction(它们不是「信」,是通道控制面)
- ❌ 不动 founder 批准链(:cool: / verify-approval / founder receipt,FLY-1448 领域)

## 6. 直觉上最大的三个风险(research.md 展开)

1. **延迟劣化**(验收 5):直推是亚秒级;mailbox 路径 = enqueue → nudge → 投递环 tick → inbox.json → Lead 官方 poller。已有同链路实测(FLY-208:Runner 报告 2~3.5s 到 Lead 眼前)。靠 nudge(已有 `/api/lead-inbox/nudge` 端点 + 插件已持有 `TEAMLEAD_API_TOKEN`)压掉 30s 空闲 tick 的最坏情况;typing indicator 在 UX 上盖住剩余间隙。
2. **翻转窗口的双轨一致性**:flag 从 OFF→ON 的瞬间,已存在的 external 影子行(旧账)仍由旧机制(重投 worker/complete)收尾;ON 后新消息只走 inbox 道。两道互不认账,靠 id 前缀(`chat:` 同前缀但 carrier 不同)区分。需要一条明确规则:**重投 worker 只服务 external 行,永不碰 inbox 行**(现状已如此,谓词按 carrier 隔离)。
3. **Codex Lead 的对等性**:Mufasa(TUI full-access)入站是另一条代码路径(RestPoll → mention-gate → 注入 turn + ExternalReceiptSaga)。E 必须两个后端同刀,否则「统一走 mailbox」只统一了一半。Codex 最后一公里(CodexLeadInboxServer socket)已在 TUI runtime 里活着,可直接复用。

## 7. 为什么这个方向是对的(收益复述)

- **founder 消息第一次获得队列保护**:Lead 会话死了/Bridge 重启窗口,消息躺在 `QUEUED` 等投,不再是「直推撞墙即蒸发」(2026-08-05 03:57 消息丢失事故的病根);
- **FLY-1646 那一类风暴在 ON 路径上结构性消失**:没有影子行就没有「pending external 谓词」可错;
- **一条真相链**:投递状态 = mailbox 状态机,不再有「直推成功但账没销」「账销了但没人看见」的双账本分叉;
- **D/F/G 的能力自动覆盖 founder 消息**:租约、合批、死信、task 表 —— E 把 Discord 流接上总线之后,后续批次不需要再为它做任何特殊化。
