# FLY-2598 主机语音激活 — 探索
Issue: FLY-2598 (https://linear.app/geoforge3d/issue/FLY-2598/语音激活-主机激活-2446-通用语音进程会议模式-随身模式注册表-huddle-块-lead-voicemodes-voice)
日期: 2026-09-15
基于: 无

## 目标与阶段
把已合入的 FLY-2446 通用语音进程变成主机可执行的激活清单：一间房、每场使用该 Lead 自己的 bot、所有注册 Lead 可开会议、RG（耳机随身模式）先 Raya。首场由 founder 进房说一句，留下 thread 镜像、Lead 回复和声音、同一 session 的持久行。
本节点只调研、设计、审阅、提交并发布 HTML；安装、改主机配置、账号准备、启动与实测由后续具备权限的执行者完成。本节点不能把“设计通过”写成“已激活”。不实现、不部署、不重启、不要求 ship、不派下游。

## 现行决定（覆盖下方开工时旧前提）
Lead 指令 `5f6ece94-97b1-4223-9d30-3c755f407596` 与 Linear `updatedAt=2026-09-16T00:19:26.450Z` 已确认：每 Lead 自己的 bot、General、OPENAI_API_KEY 平台计费。详见 design-correction.md；下文编排 bot/测试房/订阅额度内容只保留为已作废的起点。选定方案相应改为修复必要身份/认证/安装接缝后激活，不再是纯配置操作。

## 当前事实
- design TURN epoch=1，run=cffda7d2-1c69-4ea3-8b48-6177304295e6，execution=93e1ef68-1afa-459a-a0d1-d52eb4ad7a2e。
- 2026-09-16 00:20Z 左右只读检查：7 个项目、17 个 Lead 的 huddle / voiceModes / realtimeVoice 均未配置；voice-host.json 与 voice/codex-home 不存在；com.flywheel.voice 与旧 com.flywheel.voice-bridge 均未加载。
- 2446 plan 已 R4 APPROVED；继承它的进程/会话/消息身份设计，不重做架构。2446 的完整两种 Lead + Raya adapter 验收，与本单第一场运维会议验收分别记录。
- 源码要求 huddle.earsBotTokenEnv（旧 schema），Bridge start 还要求该 env 非空；通用 daemon 实际只选择 orchestrator token。需查明如何兼容且保证一个 bot。
- meeting 运维入口必须传 evidenceDir；题面简写命令不是可直接执行的完整命令。
- 生产密钥不入文档；只记 env 名、公开 Discord ID、权限结果及摘要哈希。

## 方案比较
| 方案 | 好处 | 代价 / 结论 |
|---|---|---|
| 复用 2446，顺序准备配置→身份/权限检查→受管安装→首场→RG | 改动最少，能对照已有失败语义与回滚 | 推荐；未满足的运行条件明确阻止相应步骤 |
| 借旧 voice-bridge / 每 Lead 进房 | 表面像能复用已有 bot | 违反一个编排 bot及通用进程边界，拒绝 |
| 先重构 schema / 做新安装器 / 增安全隔离层 | 可清理旧债 | 超出激活范围；只有已验证无既有可用路径的阻断才请求窄修复 |

## 研究问题
1. 现有安装器是否支持 com.flywheel.voice；manifest hold 的真实含义？旧 voice-bridge 会否因新增 huddle 自动启动？
2. Bridge 与 daemon 如何加载注册表及 host 配置；Codex ignoredAuthorIds 是否热更新？
3. earsBotTokenEnv 能否引用同一个编排 token；所有消费者及旧进程守卫？
4. 现网可无副作用验证哪些鉴权阶梯；不能制造 master 未配置、生产会话、权限错配来凑覆盖。
5. projects.json 与 identity 文件的配对写入/恢复；FLY-2566 现状。
6. 账号额度、首场、RG 的证据门，以及完整回滚顺序。

## 开工时待定记录（已被上述决定废除）
Lead 问题 f04d7111-c8f3-4253-97db-a4c7145607eb 请求 23:16Z 后 founder bot/房间决定及 FLY-2566 处置。建议值：guild 1485787271192907816；bot 1524831623164596265 / FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN；voice-test-1 1542708566417211423，General 1485787273193853170 留到首场后。未收到确认不声称已获最终选择；设计可继续，实际激活以前置核对为门。
