# FLY-2799 Codex 语音容器 — 探索
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799/语音v5-引擎-bcodex-语音容器-每次开一个新-codex-实时语音-session装进当前-lead-的-memory)
日期: 2026-09-23
基于: research.md

## 选择已定：每场新容器，装指定 Lead 的内容

Founder 2026-09-23 04:54Z 的「容器 + memory」是产品方向；本轮是恢复设计，不重开方案选择。进耳机或会议时新建 Codex 临时会话，将选中 Lead 的身份、记忆、当前事项装进去；闲聊和事实问答由容器回答，要动手则经模式层转给 Lead 本体。结束后关闭容器，转写和纪要留给本体。Lead 是稳定业务身份，与她用 Opus 或 Codex 无关。

接口权威固定在 FLY-2795 `313befcfa3a7039dca2fc7eb1178803d47699026` 的 research.md §4、plan.md K1–K6 / G1–G2。后续合同修订只接受 Lead 增量指令，不跟随浮动分支。2026-09-23 放行替代旧暂停令；本轮 instruction `ae70febe-3b69-4c5e-b11e-48d4692d72d7` 要求接着做设计、不重跑实测。

## 证据改变了什么

- Step1 与 A 路 GPT Live 交接已完成，保留原始文件。0.156.1 V2 实际返回音频并接受外部输入；V3 被拒。这里的 V2/V3 是 Codex 协议版本，不是 FLY-2796 耳机 / FLY-2797 会议两个工作包。
- B 使用 API key、按用量计费，不是 ChatGPT 订阅。语音模型配置默认 `gpt-realtime-2.1`，backend 稳定 id 为 `codex-realtime`。
- 单句成功不是逐句保证；进程成功不是进房成功；发送回执不是本体消费或业务提交。`verbatim/attribution/bargeIn` 初始全 false。
- 旧探针的 appendText 是 `role=user`；developer 角色仍未验。旧探针还关闭了 `includeStartupContext`，因此没有证明 Lead memory 已进入语音回答。
- `clientManagedHandoffs=true` 仍曾触发 background_agent；提示词不能充当权限隔离。容器不得持有业务凭据、工具或写根。

## 方案与取舍

| 方案 | 结果 |
|---|---|
| 扩现有 CodexLeadProcess，增加临时只读 voice profile；恢复 CodexLeg / RealtimeTransport 的协议规则 | **选择**。单一进程客户端所有权、每场独立身份、便于关停；需要补热路径背压、退出等待与隔离测试 |
| 每个 Lead 保持常驻分身、复用其 thread | 拒绝。违背用完即关，也容易跨场带入旧授权和他人记忆 |
| 整搬 Raya AppServerClient / runtime / Discord 层 | 拒绝。产生第二套进程客户端、第三套房间层和额外会话状态机 |
| 在 B 内直连 GPT Live | 拒绝。公开 Live 属于 A（FLY-2798），不能把 B 的失败静默切到 A |
| 只设置提示词“不要动手” | 拒绝。已存在后台 turn 反例；必须在进程能力和父进程路由两处封住 |

## 边界和依赖

当前设计不实施、不部署、不升级舰队，不声称两场真人房间 QA 已通过。接现有 RoomIO（统一收音与放音接口），不重写进房/编码/播放。实际会话状态仍归 `voice_sessions`；引擎的 generation 只是迟到事件隔离编号，不是新调度状态机。

Lead 问题 `50a4b17b-0669-479b-969b-1d677324432b` 的回复已确认：G1 RoomIO owner/版本和 G2 跨单对账回执**都未关闭**，保留为集成准入依赖，设计无需等待；developer 注入留给实现验收；K2 允许复用 CodexLeadProcess 新开临时只读会话，不允许复制旧 AppServerClient。原始 acceptance criteria 全部保留，不用未关闭的能力格缩减目标。

交付顺序：当前探索与调研 → 实施计划 → 显式设计评审 → 最终浅色 HTML 发布与 Lead 回执 → `phase_design_complete` → park。设计评审通过不代表实现或生产准入通过。
