# FLY-2608 Raya 线程双向对话 — 探索
Issue: FLY-2608 (https://linear.app/geoforge3d/issue/FLY-2608/raya工程修复-discord-thread-中的-founder-提问必须送达-raya并在原线程回复)
日期: 2026-09-15
基于: 无

## 目标与边界
Annie 在 Raya 创建的 issue thread（Discord 的独立讨论串）直接提问，不必 @，Raya 通过标准 mailbox（持久化收件队列）收到并在同一线程回复。设计阶段只调查、定义修复及验收，不实现、不重启、不恢复历史消息、不发送验证消息。

本单工程 Epic 为 FLY-2611；题面明确原生 parent 尚未迁移，本文不声称已迁移或 Tadashi 已接收。FLY-2603 summary 业务缺口、FLY-2609/2610 产品工作不纳入。受控线上验收与两条历史输入恢复由后续实施/QA完成，设计批准不代表双向对话已可用。

## 已知对象
- Raya 主频道 1542079099928059987。
- 2131 thread 1549573426547658793；2382 thread 1549573438937767977。
- 用户提供的主频道消息 1549575749210738759、1549580592532693126、1549583490092245055；新分流决定 1549588838748393493。这些不是线程原始提问的 message id。
- 题面报告 by-thread 显示 projectName=flywheel，而发送用 raya/raya。必须分开 issue 所属项目与通信收件身份。

## 初步证据与问题
基线 557d2b00e。Bridge /health 返回同一 build SHA，服务可达；本 Runner 的 by-thread 查询返回401，不能当成 thread 不存在。跨 raya 的受管快照拒绝 runner_snapshot_context_invalid；不改变执行身份或取用其他凭据。

当前读取 Raya inbound-cursor.json 仅含主频道和 1512578695468941333；roundtable-subscriptions.json entries=[]。这说明持久化文件里没有两条 thread 的游标/订阅，不单凭文件宣称模型从未收到。

已向 Lead 提交非阻塞问题 f65445d7-a479-4cd5-8a6c-5ae6c79a54ad，请其提供原始 thread 消息与标准投递/消费证据。该问题已答并提供两条真实源 message id；见末尾证据补记。精确 live/archive 收件证明仍请求补充，不要求 Annie 重述问题。

## 候选方案与选择
1. 要求额外 @ 或回主频道重问：不满足期望，排除。
2. 把 by-thread.projectName 改成 raya：该字段是 issue session 的项目展示，改它不能增加收件覆盖，排除。
3. 扩 Codex 原生线程订阅：需要同时处理发现、允许进入、初始化游标和回帖路由，现有 roundtable 订阅有主动参与预算，不能混用。
4. **选择：补齐现有 Bridge thread 扫描的注册表覆盖及回帖目的地。** 已有 StateStore 注册表、定时扫描、持久化游标、Discord读取、mailbox 去重及 Codex 送达链路；复用这些组件，补 sessionless（没有该通信身份下运行任务）的线程扫描即可。新增覆盖只做原文收件，不赋予门审批语义。

## 完成判据
每条受控源消息都有 source messageId → chat:raya:messageId → mailbox batch/消费记录 → Raya 同 thread 回帖 messageId；主频道仍可用，无其他 Lead 收件，无重复回答。两条历史线程逐条给出真实源消息和最终处置，不以静态测试或出站成功替代这些证据。


## 2026-09-15 20:22 PDT 证据补记（Lead 提供）
问题 f65445d7-a479-4cd5-8a6c-5ae6c79a54ad 已回答。Lead 在约03:2xZ读取的证据如下；Runner无直接Lead读取权限，没有借用token。

| 线程 | founder 原消息 | 时间（UTC 2026-09-16） | 正文 | Lead 查询结论 |
|---|---|---|---|---|
| 1549573426547658793 / FLY-2131 | 1549573491060244602 | 00:11:49 | 这是什么东西呀？ | Raya mailbox未见；后续机器人帖无对应回答 |
| 1549573438937767977 / FLY-2382 | 1549573499914297409 | 00:11:52 | 这是什么东西呀？ | Raya mailbox未见；后续机器人帖无对应回答 |

Lead 的 by-thread 读取确认 issue session 项目为 flywheel；lead_events 没有引用这两个id的任一Lead记录。Raya mailbox该分钟只有主频道投递，正文检索也未命中。Lead将此判为入站未送达；本设计把它作为Lead提供的事故证据，精确live/archive计数与登记owner仍请求补充。原先“原消息id未知”仅是早期取证状态，现在已定位；实施必须用上述真实id核对、恢复并补实际同线程回答。不可把后续机器人普通消息当作回答。


### 登记行补证与查询边界（Lead，约03:3xZ）
问题 ee3d76ac-8f88-40d9-aaf7-858808009f2c 返回：两条 chat_threads 的 channel_id 都为1542079099928059987、lead_id=raya、archived_at=NULL、discord_missing_at=NULL；created_at 分别为2026-09-16 00:11:34/00:11:37。满足本方案按父频道与lead确定通信owner的前提。

Lead 的 content LIKE 源id计数：raya.mailbox各0，flywheel.mailbox各2；但调查ask/report本身含源id，不能把substring命中当实际discord_chat投递。mailbox_log.content查询失败（no such column），不能判archive为空；实际表列表还含mailbox_terminal_archive、mailbox_identity，flywheel另有mailbox_archive。已请求问题22c03203-c166-475d-9f94-ccf720a63c36按精确deliveryId/source kind查询。上述失败与不确定性保留，不声称误送另一个Lead。
