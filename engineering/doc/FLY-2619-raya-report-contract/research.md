# FLY-2619 Raya 汇报合同 — 调研
Issue: FLY-2619 (https://linear.app/geoforge3d/issue/FLY-2619/raya汇报合同-文字模式不再每轮强制发言恢复-1846-63没内容可跳过-她可见面去统计头缺交名单roundid英文报错取消-6h)
日期: 2026-09-15
基于: exploration.md

## 代码证据及消费者

| 位置 | 当前行为 | 实施处置 |
|---|---|---|
| `packages/teamlead/src/bridge/summary-absorption-rider.ts:219–258` | 每轮 append + enqueue；notification_context 强制每轮发、逐字统计 | 保留 eventId/逐轮 payload；删除发言义务，添加版本化后台合同 |
| 同文件 `:375–423` | 同一 pass 处理当前与上一 slot，重放既有行 | 两轮先结算后形成同一呈现组；原轮次不合并、不丢弃 |
| `summary-absorption-rider.ts:349–362` → `LeadAlertNotifier.ts` → `UnifiedAlertConfig` | result.report_line 和英文标题实际发到统一 Discord 告警频道 | 这是 founder 可见面；本单同样去诊断文本，内部保留、旧告警重放也经投影 |
| `summary-round-classify.ts` | frozen producers/absent/undelivered/report_line | 仍作为后台对账单一来源；不要删字段或改变 absent 判据 |
| `bridge/{mailbox-lead-runtime,commdb-lead-runtime,hook-payload}.ts` | notification_context 进入模型字符串 | 新旧事件统一投影到新版内部合同，禁止重放旧强制话术 |
| `bridge/protocol-ingress.ts:60–103`, `StateStore.ts:21936` | ack_batch 对每个 summary event 镜像 ACK | 保留逐条 source_ref/seq/lead/deliveryId 校验；ACK 不等于业务或呈现完成 |
| `lead-backends/codex/lead-actions/lead-actions-main.ts` | discord_send 可带 eventId | 汇报通过专用完成入口生成一次冻结出站，普通对话不改 |
| `discord-send-core.ts`, `CodexOutboundSender.ts` | alias 校验、durable outbox、业务 idempotencyKey | 复用真实出站与已有异常处理，不新造 Discord transport |
| `CodexLeadOutboundHandler.ts`, `SqliteOutboundDedupStore.ts` | sent 去重、in-flight/ambiguous 不盲重发 | 呈现组绑定到唯一发送键，不能每轮改键重发 |
| `lead-rules-base/summary-inflow.md:37` | 缺交将在 Raya report 中可见 | 改成后台对账可追踪；生产者义务、唯一 cadence 不变 |
| `__tests__/summary-due-render.test.ts:102` | 测试明确保护旧强制文本原样传播 | 改为后台统计保留、旧指令不得进入有效呈现合同 |
| `bridge/__tests__/summary-absorption-rider.test.ts` | 冻结、重放、两轮与送达分类回归 | 保留并新增空轮/分组/重启断点断言 |
| `bin/raya-migration-proof*.ts` | summary_round_id + delivery 证据 | 继续逐轮证据；不得以静默误判无业务，独立验证呈现结果 |

外仓只读证据：`/Users/xiaorongli/.flywheel/raya/code` HEAD `0f77e9772176c973eb1e09548b00c05ae550ef32`，tracked `IDENTITY.md:50–104`：roundId 进入 visible report、活动轮必报、缺 report 补发、真正空轮可静默。`packages/cos` 在该 checkout 只有 dist，HEAD 无源码；不得把已批准的 FLY-2447 设计当成已部署业务源码。实现应以当时实际源码和加载清单再核定 persona 的受管发布源，不直接改部署目录。

只读样本 `raya-lead-workspace/state/round-2026-09-16T00/report.txt` 确有 roundId 和 4/11 缺交名单；它证明候选文本污染，不独立证明成功投递。旧 ledger 的 report_attempt 保留作审计，不转换成 sent。

## 六小时机制的精确含义

rider 由 `plugin.ts:11113` 创建并接 GatePoller `onSummaryAbsorptionTick`；cadence 控制 producer due + Raya settlement，不是一个独立 Discord timer。审计范围内没有发现第二个直接每六小时 POST Discord 的计时器。因此取消「6h 汇总定时触发」的验收是：推进六小时后台轮次仍发生，但没有自动创建 founder 汇报。不能删 GatePoller hook 或把 cadence 设为 0。实现开工再次扫实际 persona / business wake / startup recovery，若存在额外调度发送者，纳入同一呈现合同，不能只改 rider 后声称完成。

## 安全与诚实性

这是一条产品行为约束，不是对拥有 shell 的模型建立新的 OS 安全隔离。模型判断「有无实质内容」需真机样本验收，单靠字段名不能证明。稳定身份来自 registry/project+lead，显示名只渲染；既有 merge authority、summary verify-pr、reply/voice 路由原样保留。不运行生产 DB 查询或复制；隔离 QA 自建数据。

R1 补充：新工具 exact allowlist/config gate 消费者位于 `lead-actions/mcp-config.ts` 与 `__tests__/{mcp-config,runner-mcp-config}.test.ts`。共享 bearer + project/lead/channel 校验仅是请求完整性，不构成 per-Lead 调用方鉴权。

R2 补充：只读旧 ledger 的三个 report_attempt（2026-09-16 00:11/00:14/00:34Z）均有 `eventId=summary-absorption:<ISO>:report`。这是请求意图的证据，不是最终出站回执；不能据此假定所有旧轮报均使用此键。未带 eventId 的通用发送会分配 UUID，legacy 键拒绝只作纵深防御，真机必须验证 persona/投影迁移后实际无重复。
