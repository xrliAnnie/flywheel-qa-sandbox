# FLY-2606 模板与 Lead 参数热生效 — 探索
Issue: FLY-2606 (https://linear.app/geoforge3d/issue/FLY-2606/热生效-founder-2026-09-16-0038z改模板effort-要等重启才生效本来就有问题-工作流模板从仓库种子发布到)
日期: 2026-09-15
基于: 无

## 问题与边界

Founder 2026-09-16 00:38Z：改模板、改思考力度不应等待服务重启。目标是给操作员一个受管发布入口，明确告诉她哪次新派工、哪一轮 Lead 已使用新值。设计阶段只交付文档、评审及 HTML；不改生产配置、不实现、不重启、不派后继。

本次包含 workflow-template publish、现有模板存储与启动迁移的衔接、常驻 Lead model/effort 热更新、审计与回滚、operator.md。凭据、身份、权限、工作目录、后端切换、上下文窗口参数不属于热更新字段。生产改动仍由 Lead 在 founder 放行后执行；部署这项能力与以后使用能力是两回事。

## 已核反例

基线 HEAD `6556b0751`，TURN `design epoch=1`，exec `dd57b466-0a26-4d51-b32f-726ae6e3d311`。

1. 模板不是完全没有写接口：StateStore 已有 `createAndPublishWorkflowTemplateRevision`，管理台 `management-dag-writer.ts` 在用。新 CLI 应复用事务和审计，不能另建 DB 写入口。
2. 现有读路由为 `/api/workflow/templates/:templateId`；验收写的 `/api/workflow-templates/:id` 目前不存在。计划保留旧路由并增加同服务的别名。
3. 当前 materializer 给节点写 `dispatchPinned:true`；历史未带此字段的快照仍有 `live_template` 行为。既要证当前 run 不变，也必须防止热发布改动旧兼容 run，不能只比较快照字节。
4. FLY-2602 最新可见设计 `c5ea7a5f1` 已纠正整文件收据前提：`verifySummaryRegistryActivation` 比较 summary assignment projection，而非 projects 全文件 SHA；model/effort 也不在 v1 identity digest 中。不可为这两个字段重新签发身份或 summary authority。
5. Claude launcher 已在每次物理 launch 解析 registry；这不等于正在运行的 Claude 会话每 turn 重读。Codex 的 thread/start/resume 仅启动时接收 env；router、TUI 手动 turn、自主 goal continuation 必须分别覆盖。

## 选择

| 选项 | 判断 |
|---|---|
| 改种子后重启，继续靠启动迁移 | 拒绝：没有解决 founder 的问题 |
| CLI 直接打开生产 DB | 拒绝：绕过单写者、认证及事务服务 |
| CLI 调受管 Bridge 发布，复用 immutable revision + CAS | 选择：新派工立即读新发布，旧 run 保持启动时选择 |
| 仅在 router 的 turn/start 附 model/effort | 拒绝：自主 goal 与手动 TUI 可绕过 |
| 更新 runtime 的会话设置，等实际应用回执后报告生效 | 优先：需验证本机协议及原生 turn 行为，不能把请求 ACK 当应用 |
| 发一条自然语言要求 Lead 自行重载 | 拒绝：模型可能忽略，不是运行时边界 |

## 要解答的研究问题

- 复用哪条管理写入 authority；发布审计是否能在同一事务内完整记录 actor/reason/digest/CAS？
- 新 CLI 的 retry、rollback、旧版本种子重启如何保持人工发布？
- 是否可在不重建 thread、不重启进程下更新 Codex 自主 goal 的下一 turn？
- Claude 原生设置 watcher 是否覆盖 model 与 effort，以及启动 flag 是否遮盖热设置？
- 怎样区分 desired、applied、observed，处理离线、并发编辑和更新过程中崩溃？

非阻塞咨询已登记 `85b26eff-69c9-4986-966b-12148f4381dc`，请求 Lead 提供晚于 FLY-2602 的裁定。后续方案以当前证据和新指令为准。
