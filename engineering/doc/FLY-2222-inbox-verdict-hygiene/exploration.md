# FLY-2222 inbox 判据卫生 — 探索
Issue: FLY-2222 (https://linear.app/geoforge3d/issue/FLY-2222/判据卫生-runner-的-inbox-查询看不到已注入的-lead-指令no-instructions被当成没有新指令的假阴性两名-qa)
日期: 2026-09-03
基于: 无

## 问题定义

Runner 在提交判决或报告前按规则执行 `flywheel-comm inbox --exec-id <self>`。命令输出
`No instructions.` 后，runner 把它解释成“没有新的 Lead 消息”。生产证据说明这里混用了两条
不同的轴：

1. 已经注入/消费的 instruction 会离开 unread 集合；空 inbox 不能证明历史上没有收到指令。
2. Lead 对 runner question 的答复以 `type=response` 进入同一 runner mailbox；即使它仍是
   `QUEUED` 或 `LEASED`，现有 inbox 的 `type='instruction'` 过滤也让它完全不可见。

第二类更严重：消息并非历史记录，而是仍待投递/消费的活队列项。活跃 runner 据此自行推进，
停驻 runner 据此把“我看不到”写成“队里没有”，都会制造假事实。

## 已确认约束与假设

- 本单只修 runner 自查时的可见性和判据，不改投递、租约、重试、batch、告警或 ACK 语义。
- response 正文仍由 `flywheel-comm check <question-id>` 读取；`inbox` 只显示 backlog 摘要，
  不旁路 response/gate 的权威校验。
- `--json` 的既有 `Message[]` 形状保持兼容。
- mailbox 真正没有未消费 live item 时，默认文本必须继续逐字输出 `No instructions.`，不追加常驻
  caveat；已 ACK/已注入历史的主动查询属于后续问题。
- 已 ACK/已注入的历史不能从 live backlog 推断；确认它必须回看最近会话轮次中的
  `[lead-instruction <id>]`。
- 这是 CLI/提示文本的后端修复，无 rendered surface，不需要视觉验证。

## 方案比较

### A. 只为 `No instructions.` 加免责声明

能修正“已注入历史”的错误推论，但仍会把正在 `QUEUED` 的 response 说成没有消息。Lead 的
2026-09-04 新鲜快照已证明这不是边角：四个 exec 合计 14 条 QUEUED，部分滞留 1–2 小时。
因此仅改措辞不足以满足“队里有信时 runner 可见”。

### B. 把 instruction 与 response 都作为 inbox 正文消费

能够让 response 可见，但会绕过 `check` 的 gate/question 绑定和读取合同，也改变现有一次性
消费、batch settlement 与权限边界。这个方向把可见性 bug 扩张成消息状态机改造，违反锁定范围。

### C. 只读 live backlog 摘要 + runner 判据规则（推荐）

在 `inbox` 完成既有 unread instruction 消费后，对同一 exec 的 runner mailbox 做一次只读快照：

- `QUEUED` 数；
- `LEASED` 数；
- pending response 的 distinct question id，供 runner 直接执行 `check`；
- 只限定实际 delivery lane 会处理的 `runner + inbox + instruction|response + QUEUED|LEASED`，不另加
  expiry 或 supersede 判据，避免观察面比 claim 面更窄。

如果统计非零，输出 `Runner mailbox pending: N queued, M leased.`，明确这些项可能包含 outstanding
question 的 answer，并逐条打印实际 `flywheel-comm check <question-id>`。不展示 response 正文、
不 ACK response、不更改队列。如果统计为零且没有 instruction，完整输出保留原字节
`No instructions.`；JSON 也保持原数组合同。

同时在 Blueprint 的公共 runner prompt 中固定 pending 新输出的动作规则：

1. pending 摘要不是“没有消息”；
2. 必须对摘要列出的每个 outstanding question id 执行既有 `check`。

## 数据流

```text
runner question → Lead respond → runner mailbox response (QUEUED/LEASED)
                                      ├─ delivery lane（原样）
                                      └─ inbox live backlog count（新增只读观察面）

Lead send → runner mailbox instruction → inbox 正常取正文并 ACK（原样）
                                        └─ ACK 后历史只在会话轮次核验（规则加固）
```

统计必须在既有 instruction 消费之后执行，避免把刚刚已经展示并 ACK 的 instruction 再计入 pending。

## 错误与兼容边界

- DB 不存在：`instructions=[]`、backlog `0/0`，输出仍逐字为 `No instructions.`。
- 非空 instruction：原有 id/来源/时间/正文格式不变；若同时存在 response backlog，在其后追加摘要。
- `--json`：仍只输出 instruction 数组，避免破坏调用方；本单 runner 规则使用默认文本接口。
- backlog 查询失败：命令显式失败，不把未知状态降级成 `No instructions.`。
- `LEASED` 只表述为 leased/in-flight-or-awaiting-consumption，不声称一定尚未触达模型。
- `DEAD` 与 `ACKED` 不属于 pending 摘要；本单不新增历史查询或常驻提示层。

## 已知未覆盖

已投递且 ACKED 的 instruction 已经进入 runner 会话，不再是待投队列项；若后续因为压缩、换体或
人工误读而忘记它，当前 inbox 无法主动回放历史。本单不在每次空轮询上追加永久 caveat：空轮询是
高频正常路径，常驻噪音会被跳过，也会稀释“有待投行/没有待投行”的区分力。正确后续方向是提供
显式的历史查询命令，按需返回已注入 instruction，而不是改变真空 inbox 输出。

## 验收标准

1. 构造一个 `QUEUED response` 且没有 unread instruction 的 exec，`inbox` 必须输出 backlog 摘要和
   实际 question id，且不得包含 `No instructions.`。
2. 摘要查询不得 ACK/消费 response；重复查询在状态未变化时仍能看到同一计数。
3. 即使 `expires_at` 已过，仍为 `QUEUED` 的 response 也必须可见，因为实际 claim 路径未用 expiry
   过滤；不得产生观察面假阴性。
4. 已注入并 ACKED instruction 后再次运行 inbox，完整输出仍逐字为 `No instructions.`。
5. 摘要 SQL 自然使用现有 `mailbox_live` 索引，不能依赖 `INDEXED BY` 强制索引或裸扫生产大表。
6. Claude 与 Codex prompt 都必须包含 pending 摘要的具体 question-id `check` 动作。
7. 非空 instruction 格式、`--json` 数组、delivery/lease/ACK 行为保持兼容。
