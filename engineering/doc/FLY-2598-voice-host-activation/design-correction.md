# FLY-2598 更正 FLY-2446 语音身份与计费 — 探索
Issue: FLY-2598 (https://linear.app/geoforge3d/issue/FLY-2598/语音激活-主机激活-2446-通用语音进程会议模式-随身模式注册表-huddle-块-lead-voicemodes-voice)
日期: 2026-09-15
基于: exploration.md

## 权威与适用范围
本附录更正 `engineering/doc/FLY-2446-generic-voice-process/plan.md`，保留原 R4 APPROVED 历史不改写。当前 issue 的“founder 已定”比其仍保留的旧“设计约束/步骤”更新，冲突时以本附录为准。
来源：Linear FLY-2598，updatedAt `2026-09-16T00:19:26.450Z`；Lead 指令 `[lead-instruction 5f6ece94-97b1-4223-9d30-3c755f407596]`（2026-09-16 00:19:48Z）。founder 决定时间：2026-09-15 23:51Z / 2026-09-16 00:11Z。

founder 原话：
> 支持每个 lead 用他自己的 bot 进来对话，并不会带来很多 extra 的 technical 工作的话，那我建议我们还是走这个路线，而不是搞一个专门的语音 bot 去当嘴替

## 废除概念
- 通用语音不再有编排 bot、独立耳朵 bot、不再依赖 `huddle.orchestratorBot*` / `earsBotTokenEnv`。
- 不再要求 Lead bot 留在房外；当前会话所属 Lead 的 bot 同时负责进房、镜像、根卡/thread 和回复身份。
- 废除为编排 bot 添加的 ignoredAuthorIds 投影、voiceMirrorIgnoredAuthorIds 能力预检及 Claude allowBots 排除检查；普通自身消息过滤和通用其他调用方的忽略列表保留。
- 废除 voice-test-1 首场、alerts-dispatcher bot 选择；直接使用 General `1485787273193853170`，guild `1485787271192907816`。
- 废除“Codex 订阅有额度才可开场”。Codex 是这里调用实时语音接口的本地客户端；Realtime WebSocket 使用 `OPENAI_API_KEY`，平台余额由 founder 查看，不能用订阅额度推断。

## 保留器官
一房一场、partial UNIQUE 单活动会话、lease（有期限的唯一控制权）、本地失权停流、先留会话行再发根卡、镜像 nonce 去重、founder 的身份到 mailbox、普通 Lead 回帖、朗读回执、journals、脱敏、失败明报、host 0600、两模式开关、launchd 失败重启守卫均继承 2446。
同 bot 镜像仍用 `🗣️`，前台自言用 `🤖`，状态用 `📻`；只允许正常 Lead 回复进入朗读队列，禁止把自己发的镜像再次当口述或回复。

## 新设计落点
- `project.voiceRoom={guildId,voiceChannelId}` 是通用语音唯一房间配置。旧 `huddle` 留给旧 voice-bridge 兼容代码，但本次主机保持未配置，通用语音不回退读取它。避免一个 huddle 对象把旧语音进程也启动。字段命名已获 Lead 明确同意（问题 `38f0add8-7db1-4e24-9e1e-bcb96edd50ea`）：新 voiceRoom 是唯一房间权威，不沿用 huddle 名称。
- bot 身份唯一源是 `(projectName, lead.agentId)` 对应的 `botUserId` / `botTokenEnv`；开场核实 Discord 后把 botUserId 固化进 session。显示名不是 authority。
- 只窄改 voice 调用点、平台登录、受管首次安装入口与所需测试；R1 后补同 bot 运行过滤证明，Lead aa87aab0 批准 Claude fork 小补丁单独 PR/部署回执；不重做 Lead 架构，不迁移旧 Gemini/Raya voice。
- 设计节点交付设计和测试计划。实现节点改代码与测试；合入且独立 updater 部署后，Lead 执行 host runbook，founder 配 General 角色 Connect/Speak 并参加首场。
