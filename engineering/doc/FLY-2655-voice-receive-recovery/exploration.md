# FLY-2655 语音收音恢复 — 探索
Issue: FLY-2655 (https://linear.app/geoforge3d/issue/FLY-2655/2598follow-up-raya-rg-语音会话-live-10-秒即-faileddiscord-audio)
日期: 2026-09-20
基于: 无

## 目标与阶段

Founder 在 #raya 说「语音」，Raya 自己开 RG；她进 General 后能说一句、听到一句真实回复。meeting 独立通过同样的双向验证。收音解密异常不能把仍可播报的会话杀掉，也不能把“连接活着”展示成“已经听见”。本节点只设计、送审、发布说明并交接；实现、生产部署和真房验证属于后续节点/Lead。

当前 dispatch 明确授权本设计工作，issue 里的旧“只记账/不开新活”不是本轮停止指令。沿用 FLY-2598 design-correction：当场 Lead 自己的 bot，voiceRoom 唯一房间源，平台 API 认证，两模式与 lease 契约。不复活旧 Raya/Gemini/huddle 业务，不扩大模型权限。

## 故障证据分级

| 判断 | 结论 | 依据 |
|---|---|---|
| 首场进房后 failed | issue 提供的真实失败，未在本节点重演 | session 5142f2ab-16ed-48f6-bef5-c08d3740dd23，live 23:32:06 → failed 23:32:11.604Z；不能记为首场通过 |
| 新包没有 DAVE 支持 | 当前源码反证，不采用为根因 | cli.ts 使用 voice-bridge createDiscordDeps；锁文件的 voice 0.19.2 自带 davey 0.1.12；主 checkout 安装库的依赖报告一致 |
| 接收错误升级为整场终结 | 已确认 | discord-room.ts 同一 fail 回调接 Opus/decoder error，session.ts onError 无条件 finish(failed) |
| 没设 tolerance 就零容错 | 已反证 | 已安装 0.19.2 默认 36；隔离探针前 36 次返回 null，第 37 次抛错 |
| 具体坏包/协议切换根因 | 未解决 | 原场无 RTP/transition 关联记录；可能是持续解密异常，不能仅由错误名确定是哪种包或 DAVE epoch |
| 新包完全没复用旧收音基础 | 过度概括 | 已复用连接、订阅、解码工厂，但另建 DiscordVoiceRoom 和终结策略；旧 huddle 能对话不能证明今天的协议状态 |
| Raya 自主入口缺失 | 当前标准 Lead 接线缺口，生产 activation 尚需证明 | 旧 meetingId port 无生产调用，标准 lead_actions 无 voice tool；不能把导出函数当作可用入口 |

## 方案比较

1. **只加 davey / 放大容错**：改动少，但依赖已在、默认已容错，仍可能永久无声。拒绝作为修复。
2. **关闭 DAVE / 永久明文透传**：可能掩盖错误，却削弱隐私并绕过协议状态。拒绝。
3. **选定：沿用既有 DAVE，隔离接收故障、有限恢复、独立健康投影、补齐标准 Lead 入口**：范围跨接收器、会话状态展示和入口，但每处有明确消费者与验收。不改变成功路径的语音引擎、bot 身份或播放队列。

## 产品约束

- RG 是耳机随身模式；meeting 是一次会议。各自独立 sessionId、证据和停止回执。
- DAVE 是 Discord 的端到端音频加密协议；保留加密，坏包丢弃，不把未解密数据送往识别器。
- “live”只说明会话运行。新卡片另显示“等待你说话 / 已接收音频 / 收音暂不可用，文字回复仍可播报 / 收音恢复待验证”。“已接收音频”也不等于转写、Lead 消费或 founder 听见。
- 持续失败时保留会话与下行播放；有界重试仍失败则停止自动密集尝试，保留文字 stop。lease 失效、身份漂移、进程退出仍是终结条件。
- 不要求 founder 找工程 Lead 手工开场。标准 Lead 自己调用实际可用的入口，得到 sessionId / threadId 回执后再邀请她入房。

## 必须交给实现与 QA 的证据

安装解析路径与版本 → DAVE 开关和容错 → 接收异常与恢复代次 → 有效人声 → 转写镜像 → mailbox 消费 → 正常 Lead 回复 → 播放回执 → founder 实际听到 → 精确 stop 与离房。单个错误包测试、依赖报告、状态绿、输出波形或 confirmed 均不能单独代替这条链。

具体主机坏包原因若仍未定位，报告必须写未解决；隔离恢复完成不等于 FLY-2655 真房可用性验收完成。不得为了把测试变绿而取消自主入口或任一模式的真实双向测试。

## 2026-09-17 19:42Z founder 范围追加

已重新读取Linear全文（updatedAt=2026-09-17T19:44:10.969Z），合入前529真人对话是QA PASS/ship卡硬门禁；R2批准不覆盖此追加，plan §7.2提交R3。只读核实QA voice-test-2房1542708795720081408/type2/QA Testing，测试bot slot2=1493072948683341976。当前生产voice-host只有schemaVersion，不能假设QA allowlist已配置；采用slot私有fixture，生产配置与凭据不写。源码cli.ts buildDelivery硬编码HOME下CommDB，必须新增显式slot override并验证实际--db；test-deploy当前无voice装房支持，旧2446驱动不覆盖RG/新入口。D2明确补装房、branch产物身份、进程收敛与证据矩阵，设计未起房/进房/重启。

## 2026-09-20 增量探索：收到声音，但没有回答

保留基线 177c539ea617714fc45d10d89f57fed5af77a0be / PR #1243 全部收音修复。9/19 QA attempt 2 为 FAIL；FLY-2756 已并回本单并取消，旧 QA 报告中“另一个缺陷可单独合入”的建议被 9/20 重派指令覆盖，不能据此缩小验收。

本轮亲自读取 slot 2 原始 events（摘要及 hash 见 realtime-evidence-audit.json）：三条 uplink_gate_utterance 的 framesPassed 为 98/105/77，总和280；DAVE transitioned 一次；0 条转写、镜像和投递，live 37.823 秒。verify 收据显示 framesPassed=0 是工装读取 receiveHealth 中不存在的字段造成，不能反驳原始事件。280 帧也仅证明本地语音门控放行，不能证明服务器消费。

Lead 提供并本轮 HTTP 200 读取的 QA 报告记录：979 条真人 appendAudio 已被 app-server 收到；session.update 后无服务器事件，session.created 被标记 unsupported realtime v2；同 key/同3.91秒合成音直连 gpt-realtime-1.5 后6.7秒有转写和44条音频delta。该对照是既有QA证据，本design没有新跑付费探针或真人测试。精确的上游内部缺陷仍未独立定位；证据足以将本单当前断点定位到 app-server 适配链。

三条路：A 修 app-server 调用方式，修改小但无已证可用参数；B pin/升级 Codex，影响全舰共享载体且无已验版本；C voice前台直连官方 Realtime，只换声音适配层，风险是自己承担协议就绪、响应关联、超时清理和输出授权。推荐C。已先 ask Lead f13f1be8-815b-4214-b2f4-cf40e4b395a1，Lead 明确批准C、固定模型、不改Codex版本；A/B记为本轮被拒替代。详细约束和交接见 design-correction.md / plan §11。
