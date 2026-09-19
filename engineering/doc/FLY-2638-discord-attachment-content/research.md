# FLY-2638 Discord 附件内容可达 — 调研
Issue: FLY-2638 (https://linear.app/geoforge3d/issue/FLY-2638/raya附件收件-discord-图片文本仅到达yuan数据lead-无法读取内容)
日期: 2026-09-18
基于: exploration.md

> R2 更正（2026-09-18）：以下初轮研究中可复用 v2 parent/artifact 路径的建议已撤销。Raya 实际为 v1，persona gate 拒绝 v2；有效方案为 plan.md R2 的 lead_actions 原生 MCP image/TXT，Lead 已批准有界修正。初轮证据保留作设计沿革，不是实施指令。
## 结论
当前标准收件数据结构有意只保留元数据。完整修复同时需要：附件身份、入站收件授权、模型可消费内容、显式失败。现有 Bridge 下载器和 parent-owned artifact 目录可以复用，不需要新 bot 或旁路。

研究按注入 full 设计任务推进；独立只读审计分别覆盖 inbound_flow 与 content_capability，未读取原始私人附件。下述均是当前源码证据，除单独标识外不是现场验证。

## 消费者与实际流向（基线 bd2fc7dfe）
| 文件与锚点 | 事实 / 处置 |
|---|---|
| `packages/teamlead/src/lead-backends/codex/RestPollDiscordInboundSource.ts:36,507` | REST metadata projection 丢弃 id；需携带 attachmentId，保留无效条目失败描述，不能默默 filter |
| `packages/teamlead/src/lead-backends/codex/CodexDiscordGateway.ts:48,308` | metadata-only 接口；附件-only 消息已有接收分支，不必新建收件器 |
| `packages/teamlead/src/lead-backends/codex/CodexDiscordMailboxStrategy.ts:73` | 保留原 message/channel，转交标准 ingest |
| `packages/teamlead/src/bridge/founder-reply-deliverer.ts:58,565` | 第二处既有 producer，同样补附件身份 |
| `packages/flywheel-comm/src/chat-delivery-envelope.ts:9,94` | attachment 类型与 normalize 都只保留 name/type/sizeKb；只改 producer 不够 |
| `packages/flywheel-comm/src/discord-chat-ingest.ts:101,171` | Lead 渲染 metadata；first-delivery immutable，重放不升级旧行 |
| `packages/teamlead/src/bridge/lead-inbox-loop.ts:459` | 直接采用 delivery_content；不自动下载或生成多模态块 |
| `packages/teamlead/src/bridge/lead-delivery-adapter.ts:65,155` | Claude mailbox / Codex payload 均传文字；本设计保持 mailbox 文字协议 |
| `packages/teamlead/src/lead-capabilities/catalog.ts:259` | attachments.get 要 threadId/messageId/attachmentId，只输出 artifactHandle+bytes |
| `packages/teamlead/src/bridge/lead-capability-discord.ts:531,592` | 旧 GET 使用 canonical issue thread guard；父频道无法直接通过 |
| `packages/teamlead/src/lead-capabilities/handlers/discord.ts:190` | readTarget 必须 lookup 到 issue thread，不能为本任务放宽所有 thread.read |
| `packages/teamlead/src/lead-capabilities/discord-attachments.ts:33` | 下载器重取当前 message，检查 message/channel/attachment 与 CDN host/path；25 MiB、15 秒、拒绝跳转、CDN 不带 bot credential |
| `packages/teamlead/src/lead-capabilities/handlers/bridge-attachments.ts:157` | 受信 parent 存储字节，返回 opaque handle；catch 丢失具体失败原因 |
| `packages/teamlead/src/lead-capabilities/artifacts.ts:149,198` | 随机文件名，O_NOFOLLOW、inode/sha 验证，激活实例内 registry；可复用路径与 hash |
| `packages/teamlead/src/lead-capabilities/permission-profile.ts:85` | artifactRoot 对 model 为 read，维持不可写 |
| `packages/teamlead/src/lead-capabilities/browser-output.ts:128` | 浏览器截图已有 relativePath+MIME+SHA 输出先例 |
| `packages/teamlead/src/lead-backends/codex/lead-capability-proxy.ts:213` | JSON 文本输出，262144-byte 上限，不可把 base64 文本误称图片 |
| `packages/teamlead/src/lead-capabilities/broker.ts:410,491`、`broker-socket.ts:80`、`packages/flywheel-comm/src/lead-operation-client.ts:167` | 四处结果边界约 256 KiB；本设计保持上限，用图片路径与最多 32 KiB TXT，最坏 JSON escaping 也有余量 |
| `packages/teamlead/src/lead-backends/codexLeadBridgeWiring.ts:71` | buildAuthorizeLeadChannel 允许配置父频道/子线程；必须 fresh projects + 新 parent cache，且 transient != true |
| `packages/teamlead/src/lead-capabilities/resolve.ts`、`runtime-factory.ts:324`、`deployment.ts` | 能力清单、实际 handler、部署闭包均需一致；清单出现不是可用性证据 |

## 当前现场只读观察
2026-09-18：Bridge health ok、buildSha=bd2fc7dfe。注册配置只投影非敏感字段：project=raya，lead=raya，chatChannel=1542079099928059987，backend=codex-app-server，projectRoot=/Users/xiaorongli/Dev/raya-lead-workspace。配置值不证明实际进程已消费，QA 必须绑定有效 activation、manifest 和载体。没有读取凭据或原附件。

## 现有测试与缺口
- `packages/teamlead/src/bridge/__tests__/raya-standard-migration.test.ts:131` 只断言 metadata tag。
- `packages/flywheel-comm/src/__tests__/discord-chat-ingest.test.ts:42,80` 同上。
- `packages/teamlead/src/lead-backends/codex/__tests__/CodexDiscordMailboxStrategy.test.ts:95` 验证 reply identity，不证明内容。
- `packages/teamlead/src/lead-capabilities/__tests__/bridge-attachments.test.ts:13` 用 store.read 检查 hello；不是模型读取。
- `packages/teamlead/src/bridge/__tests__/lead-capability-discord.test.ts:421` 证明 Bridge byte response，不覆盖普通 #raya。

## 外部协议依据
- Discord 官方 API Reference 的 [Signed Attachment CDN URLs](https://github.com/discord/discord-api-docs/blob/main/developers/reference.mdx)：附件链接带时效；重新读取消息取得当前 URL。故 durable mailbox 存身份，不存 URL 为长期读取能力。
- MCP 官方 [tool content schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/schema.mdx)：text 和 image 是不同内容块。原生 view_image 工具必须实际产出 image result；路径/JSON/base64 不算已经看见。

## 规划决策
选用现有 artifact 只读路径，避免为图片全局放大 broker/socket 限额。新 mailbox-bound read 和旧 thread GET 分开授权；下载基础设施复用。TXT 正文随 bounded JSON 返回，图片提供 parent 产生的 absolute artifactPath，Lead 调原生 view_image。技能提示明确「content readable handle != content consumed」。

如有效 Raya runtime 未接入 capability bundle 或缺原生图片工具，属于实现/QA 的真实阻断，不能回退为成功 metadata。需完成该标准 runtime 接线或返回 carrier_unavailable，且正向验收仍未达标。其他 backend 不宣称已支持，保留旧 mailbox 兼容并明确不可用。

## 风险
- mailbox 的 to_agent 身份必须连同项目 DB 路径与当前 registry/activation 校验，不能只信客户端 leadId 或文件名。
- 原频道是 fetch 坐标，replyRoute 仅回复路由；不能拿新回复线程去取父频道旧消息附件。
- 旧 mailbox 行不会自动获得附件 ID；旧消息仅作 repro refs，使用新良性样本验收。
- 文件读取是把外部数据提供给模型，不授予附件内文字执行指令的权限；不得执行 HTML、脚本或自动解释私人内容。

## R2：真实 v1 载体纠正与重新审计
- 初轮仅投影 backend，遗漏 codexCapabilityBundleVersion；R1 独立审查指出此点，本轮读取源验证。
- `lead-backends/codex/persona-startup-gate.ts:186` 明确拒绝 Raya v2；`bridge/lead-capability-scope.ts:44` 只接v2，不能给v1调用。
- `lead-backends/codex/lead-actions/lead-actions-main.ts:145` 为既有 stdio MCP server，可增加原生image/text工具结果，不经256KiB v2 broker。
- `flywheel-comm/src/lead-lease.ts:1554,2836` 提供bundle无关的canonical carrier验证；1381附近检查claim hash、PID/start与90秒freshness。
- TUI `codex-lead-tui-runtime.ts:1756` 在v2分支前mint carrier claim；`buildTuiDaemonEnv:283` 已能传claim；headless `codex-lead-runtime.ts:1658` 同样发布assertion。
- `lead-actions/mcp-config.ts:171–206` 当前仅runnerContext才转发identity/carrier；本任务新增attachment context独立接线，不能偷偷启用Runner工具。
- `lead-actions-main.ts:317` summary仅shared token+names不是足够收件读取授权；新端点仍须carrier+mailbox binding。
- 当前v1 full-access并非v2隔离模型；复用身份并不宣称同UID秘密隔离升级。不把claim写入配置/日志/模型工具结果。
- CLI入口 `flywheel-comm/src/index.ts:907` 亦接attachments-json；本单不改外部Claude插件，只保证无ID时准确producer_identity_missing，插件增强留Follow-up。
- Lead批准 question 32ac9a29-d9e9-48de-adbe-7b3f0715f16c；只改Flywheel，Raya仓/persona冻结，不迁v2。
