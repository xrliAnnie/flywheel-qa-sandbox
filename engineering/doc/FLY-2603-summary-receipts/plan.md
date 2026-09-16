# FLY-2603 标准 Codex Lead summary 回执 — 实施计划
Issue: FLY-2603 (https://linear.app/geoforge3d/issue/FLY-2603)
日期: 2026-09-15
基于: research.md

## 锁定范围
依 Lead instruction 5178a42e-fb92-44c4-9424-71d4576f4941：
1. 在既有正向 allowlist 追加非秘密 summary 身份投影，覆盖 app-server/TUI 过滤边界；MCP 转发相同身份值，沿用既有 registry 频道 literal 和秘密过滤。
2. 给现有 batch ACK ingress 增加 summary_absorption_round 的 lead_events 回写。只采信已 ACKED、bridge 生产、lead_event 来源、匹配收件人与事件的 canonical rows。重复 receipt 可修复跨库中途失败，时间戳不覆盖；错误收件人、未 ACK、普通消息、其它事件不得签收 summary。
3. 测试先红后绿：子进程身份/频道透传、秘密过滤阴性；真实队列→batch receipt→StateStore ack、重复/重放及负例。无需 schema migration。
4. 依最新 Lead 指令做一次 serial targeted green verification，push 一次，exact-head code review 期间不 push。代码审查通过后 needs_review 交接；无 merge、部署、重启或 QA dispatch。
5. rollback=回退本 PR；不回填生产历史 ACK。生产一张 summary 合并与记忆远端修复不由局部测试冒充。

Lead 对问题 d87cc50f-7ef0-41f3-bc13-73e43b56235d 明确回复：交接与一手评论为权威，无需单独设计门，写 plan 后直接实施；code review 走正常 gate。已提前注册的 design request 不构成实施前置。

## R2 权威修订
Lead 对 bb00e16e-619f-4b2f-b733-c51f715b7c05 批准补齐过期清理路径及两条 shell 期待；对 f984250f-f662-474d-b16f-1b449b66e65e 禁止全局频道 fallback，并已自行修复 registry 数据。
- 过期清理仍完成 mailbox ACK，但不终结 ack_batch protocol receipt；仅由既有 ingress 在完成 mirror 后终结。
- 新测试 keeps an expiry-settled receipt claimable for the journal mirror after restart：真实 queue expiry、关闭重开、claimBridgeProtocol、ingress、最终 receipt ACK，journal 时间戳匹配原 mailbox ACK。
- 延续队列 restart/rollback/late 测试，rollback 在 member ACK 写入点注入异常，确认事务回滚且 receipt 可重试。
- 更新两条 shell 精确 env_vars 期待，不放宽秘密断言。
- 接受标准：指定回归与 shell 全绿、构建通过、新 head code review 有效通过、新 head CI 成功、needs_review 结构化完成回执。Lead 配置生效与生产 roundtable 恢复在本节点之外。
- 回退代码不撤销已经写入的 acked_at；不以人工擦除或伪造 ACK 作为 rollback。
