# FLY-2655 语音收音恢复 — 调研
Issue: FLY-2655 (https://linear.app/geoforge3d/issue/FLY-2655/2598follow-up-raya-rg-语音会话-live-10-秒即-faileddiscord-audio)
日期: 2026-09-20
基于: exploration.md

## 范围与方法

只读源码、上游固定版本、主 checkout 已安装库的无网络控制流探针。未启动 bot、未读取凭据、未复制生产数据库、未重启服务。工作树没有安装依赖；`dependency-probe.json` 明确标识主 checkout 库位置来源及源码摘要，不代表 daemon 当前载入字节或原失败场景的复现。

## 本地调用链与消费者

| 文件 | 观察与设计含义 |
|---|---|
| packages/voice-codex/src/cli.ts:11,97,220 | import 并调用 voice-bridge createDiscordDeps，将 Room callbacks 与 EvidenceLog 接到 GenericVoiceSession |
| packages/voice-bridge/src/bots/discordWiring.ts:150–190 | 唯一 SDK glue；joinVoiceChannel 按 bot ID group，selfDeaf=false；subscribe 是 Manual；decoder 为 48k stereo Opus |
| packages/voice-bridge/src/bots/BotRegistry.ts | clientReady 后进房；身份/生命周期保留，不另造连接 |
| packages/voice-codex/src/discord-room.ts:254–310 | activeSpeaker 单人采集；两个 stream 共享 fail；closeCapture 不清 activeSpeaker/上行归属，直接忽略 onError 会留下不可恢复状态 |
| packages/voice-codex/src/session.ts:105–109 | onError → ended.resolve(failed)；必须区分接收可恢复错误与致命错误 |
| packages/voice-codex/src/daemon.ts | SessionLifetime 接收 failed 会 fence lease；独立 renew 维持会话，不能借降级绕过失权停流 |
| packages/voice-codex/src/pipeline/Uplink.ts | setMicOpen(false) 清 VAD/frames/jitter；speakingEnd 清 activeOwner。正常 endUtterance 会 drain，错误清理应 cancel 而非把残片推出 |
| packages/voice-codex/src/speaker-attribution.ts | 未消费说话归属不按超时删除，多人混合拒绝；不能因恢复清空全部 epochs 导致迟到转写归到后来的人 |
| packages/voice-codex/src/realtime.ts | done 只向会话暴露 role/text，没有可用于精确撤回的 input generation/utterance receipt。不能假设 reconnect 自动清掉已提交音频 |
| packages/voice-codex/src/evidence.ts | 0600 append-only JSONL，新增健康日志固定 reason，不记录 RTP、密钥、原异常全文 |
| packages/teamlead/src/StateStore.ts:2603,3513,6994 | session 生命周期与 lease 权威；现有 SQL 参数化、增量列迁移；新增接收健康必须独立于 state/terminal reason |
| packages/teamlead/src/bridge/voice-session-routes.ts:58,221 | GET 显式 sessionBody 投影；renew master+X-Voice-Lease。健康更新可随 renew 原子提交，不需新 daemon 写入通道 |
| packages/teamlead/src/bridge/voice-session-provisioner.ts:104 | 根卡目前只发“已请求”；健康不能只写本地日志，需根卡可重试编辑投影 |
| packages/teamlead/src/bridge/voice-session-services.ts | resolve/validateSession 核当前 registry 与 self-filter；卡片投影必须沿用这些检查 |
| packages/teamlead/src/bridge/voice-session-runtime.ts | 3 秒 poll，已有 poll failure 30→300秒节流；新增健康卡重试不得饿死 outbound poll 或 renew |
| packages/teamlead/src/bridge/voice-session-poller.ts:18 | 📻、🗣️、🤖 与 rootMessageId 都从朗读排除；新的告警必须继续用 📻 |
| packages/flywheel-comm/src/commands/voice-session.ts | 已有 start/stop/status；RG 显式 mode/project/lead；meetingId 可重放，RG 目前仅 active-room conflict |
| packages/teamlead/src/cos-ports/voice-intent.ts | 仅 meetingId start/stop，accepted 无 session receipt；不能满足直接 RG 意图 |
| packages/teamlead/src/lead-capabilities/model-env.ts | v2 模型环境不含 Bridge token 或 COMM_CLI；不能用 legacy full-access env 推断当前 Raya 有 CLI 入口 |

## 固定版本外部证据

2026-09-17 核对，不跟随 main 升级：

- [voice 0.19.2 package.json](https://raw.githubusercontent.com/discordjs/discord.js/%40discordjs%2Fvoice%400.19.2/packages/voice/package.json)：DAVE 库已作为依赖。仓库 pnpm-lock.yaml:4708 同样解析 davey 0.1.12。
- [0.19.2 DAVESession](https://raw.githubusercontent.com/discordjs/discord.js/%40discordjs%2Fvoice%400.19.2/packages/voice/src/networking/DAVESession.ts)：默认 tolerance=36，连续失败超阈值时，若 lastTransitionId truthy 则请求库内恢复，否则抛出。重置/transition 的语义归 SDK，不由应用直接操作 MLS 密钥。
- [0.19.2 VoiceReceiver](https://raw.githubusercontent.com/discordjs/discord.js/%40discordjs%2Fvoice%400.19.2/packages/voice/src/receive/VoiceReceiver.ts)：解析失败 destroy(stream)，close 才删除订阅映射；只听下次 speaking.start 无法保证同一连续发言恢复。
- [0.19.2 VoiceConnection](https://raw.githubusercontent.com/discordjs/discord.js/%40discordjs%2Fvoice%400.19.2/packages/voice/src/VoiceConnection.ts)：DAVE 默认 true，有公开 transitioned / stateChange / error；可监听，不应读取、记录或篡改内部 secretKey。
- [选项文档](https://discord.js.org/docs/packages/voice/0.19.2/CreateVoiceConnectionOptions:Interface)把 tolerance 默认写成 24，与安装字节/固定 tag 的 36 不同。本设计用源码值 36 显式配置，不照搬文档数字。
- [上游用户报告 #11445](https://github.com/discordjs/discord.js/issues/11445)说明相同错误可发生在已安装 DAVE 的环境，且提高容错不保证收音。它是旁证，不能证明本场根因，也不授权降级加密。

## 可重复控制流证据

`dependency-probe.json`：2026-09-17 主 checkout 安装库依赖报告；调用导出的 DAVESession.decrypt，内层 decrypt 用固定错误 stub，37 次依次调用：36 个 null，37 抛出。该实验只证明错误传播分支，不涉及真实 Discord、原生密码运算或有效人声。

主 checkout generateDependencyReport 显示 voice 0.19.2、davey 0.1.12、opusscript 0.0.8、AES-GCM 支持。真正 daemon 仍需启动证据记录同一个加载入口/版本与部署 SHA，不能从工作树或 package.json 外推。

## 设计必须防止的反例

1. 只把 onError 换成 log：activeSpeaker 卡住，下一次 start 被拒。
2. error 回调晚到：旧 stream 关闭刚新建的 capture。每次 capture 需要对象/代次身份，所有 data/error/close callback 先核当前身份。
3. stream destroy 后立刻重订阅：库的 close 尚未删除映射，拿回 destroyed stream；必须等 close 并确认新 stream。
4. 只等 speaking.start：人在连续说话，没有第二次 start，恢复永远不发生；保留 speaking 状态并定时 probe。
5. 全局 catch 当解密错误：token/身份/lease/连接错误被误吞；按当前接收stream的到达通道降级全部包错误，错误文字仅选标签；decoder单列，独立连接/身份/lease通道仍fatal（R1校正）。
6. 时钟静音当成功：20ms Uplink 自动发静音与 bot TTS 回环不是人声；恢复证明来自当前 capture 的有效解码帧。
7. 重试中乱清 SpeakerAttribution：旧 final 归到新用户；保留原 epoch，保持混合归属拒绝，不造授权或重放语音。
8. 健康警告重复发文：可能形成告警/朗读环；根卡原位编辑 + 📻 + 原消息 ID 排除，编辑失败只记固定错误并退避。
9. model 环境有 profile=full-access 就假设 token 可用：v2 的受保护父进程与模型环境不同；入口要查真实能力包。

## 验证分层

设计节点已有：本地源码/锁文件审计、固定版本上游检查、无网络库分支探针。未做：修复代码、fixture 集成、模型实际工具调用、生产部署、RG/meeting 真人双向验证。计划必须把每层分别列为待执行，不能将前三项抵扣后五项。

## 原场本地日志补证（评审等待期间只读核对）

original-session-evidence.json 保存精确 session 的白名单字段投影：共7事件，本地 session_live 为 23:31:59.053Z，session_interrupted 为23:32:11.514Z，错误与 issue 相同。与 issue 提供的 Bridge live 时间23:32:06不同，保留两个来源的观察时间，不能静默改写成同一时间线。

唯一 uplink_gate_utterance：framesTotal=25，framesSilenced=25，framesPassed=0，opened=false，maxProb≈0.0171。按当前 Uplink 调用链，可推断该时段有解码后帧进入人声检测，但全部被判非人声；不是“整个场从来没有任何PCM”的证据，也不是“听到了 founder”的证据。没有 transcript、DAVE transition或成员协商记录，因此原始加密异常的原因仍 unresolved；下一场还需区分客户端噪声/静音、实际人声和加密切换。没有据此放宽VAD阈值或改设计范围。

## 2026-09-17 19:42Z founder 范围追加

已重新读取Linear全文（updatedAt=2026-09-17T19:44:10.969Z），合入前529真人对话是QA PASS/ship卡硬门禁；R2批准不覆盖此追加，plan §7.2提交R3。只读核实QA voice-test-2房1542708795720081408/type2/QA Testing，测试bot slot2=1493072948683341976。当前生产voice-host只有schemaVersion，不能假设QA allowlist已配置；采用slot私有fixture，生产配置与凭据不写。源码cli.ts buildDelivery硬编码HOME下CommDB，必须新增显式slot override并验证实际--db；test-deploy当前无voice装房支持，旧2446驱动不覆盖RG/新入口。D2明确补装房、branch产物身份、进程收敛与证据矩阵，设计未起房/进房/重启。

## 2026-09-20 增量调研：直接语音传输与现有消费者

本轮源码：realtime.ts 把 thread/realtime/start 的 JSON-RPC 成功当 start 完成；appendAudio 是 notify；realtime-speech.test.ts 用自造通知验证，并未跑真实上游协议。cli.ts: createFrontend 创建 CodexLeadProcess，API key 以 login 私有请求传入；GenericVoiceSession 依次 frontend.start、room.start、ready/live，接 user final 后经 delivery.capture 到原Lead，reply poller 再调用 speak。这个完整投递与回答路径必须保留。

session.ts 当前以 assistant final 等于待念文本便 confirmed，无法单独证明音频已产生；直连改造须关联本次 response、非空音频、成功终态后才上报生成确认，播放和人耳另记。SpeakerAttribution 保留未消费的说话人epoch；异步转写不能按到达顺序消费身份，重复项必须先去重，提交顺序缺口须有界拒绝，不猜“最近说话人”。Uplink 已每20ms推送PCM24单声道和静音；保留时钟与语音门控，服务器VAD只切句，不能再自动回答。

官方来源（2026-09-20读取）：
- [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)：session.updated 回传配置；可保留VAD并关闭 create_response / interrupt_response；response.create 支持 conversation=none 与 metadata。本设计用它们隔离用户语音与Lead朗读请求。
- [模型](https://developers.openai.com/api/docs/models/gpt-realtime-1.5)：本单固定gpt-realtime-1.5，不跟随文档示例改用新模型。
- [服务器转写事件](https://platform.openai.com/docs/api-reference/realtime-server-events/input_audio_buffer/committed?lang=node)：输入转写以 item_id/content_index 关联，独立异步生成。这里只使用完整转写，不把delta当可投递话语。
- [QA attempt 2](https://fw-reports-356a6d.vercel.app/r/e1b940aee418e126570ff18984c95a98/)：原场与同key对照。已获取的报告正文摘要记录在 realtime-evidence-audit.json。

页面/API参考有时重定向到新Live协议；不要混用 session.input_audio.append 与本单 /v1/realtime 的 input_audio_buffer.append。新实现先用本协议的本地WebSocket服务器跑真实握手，再用slot独立预检确认固定模型与配置。官方文档是协议设计依据，不等于本分支适配器通过真人验收。


### 2026-09-20 启动消费者追踪（补充实读，不执行）

| 消费者 | 当前行为 | 直连处置 |
|---|---|---|
| voice-codex/src/cli.ts:74,224 | 启动/创建前台两次assertVoiceCodexHome | E3移除直连入口依赖；不删除旧home |
| voice-codex/src/config.ts:124-125 | 默认codexHome/codexBin | 保留兼容字段但不再消费为运行条件 |
| scripts/check-voice-api-auth-local.mjs | 固定Codex0.153.2，实际起两个app-server，截断于thread start的离线认证探针 | E3改为fake-key+本地ws协议/不落盘检查；保留脚本入口，移除旧版本/订阅认证断言，不把它称为真实API可用 |
| scripts/qa/fly2655-voice-room.mjs:buildVoiceProcessEnv,prepare,start | 注入slot私有voice home；prepare/start调用构建cli --check-config | 保留无害兼容env和全部slot身份隔离；check-config不再要求声音home，真实网络ready另验 |
| scripts/lib/fly2655-voice-fixture.mjs:138-218、test-deploy.sh:1580/1587 | 建空专用home/config并投影Bridge/Lead env | 兼容保留，无密钥写入；不能误删真正slot Codex Lead目录或更改其版本 |
| scripts/flywheel-voice-wrapper.sh | 从受管state/.env取key；先--check-config再exec voice CLI，另有构建/tmux/重启刹车 | 无直接Codex home依赖；只需cli生效，保留全部宿主守卫 |
| scripts/install-voice-launchd.sh | 生产定位/凭据文件权限/--check-config/launchd归属 | 保留，不为直连绕过安装与权限规则 |
| scripts/lib/restart-voice.sh | 已loaded才走supervisor restart并检查keepalive | 保留；设计/实现不执行重启 |
| FLY-2598 host-runbook §2 | 旧专用home准备、api login/read证明 | E4加新transport当前说明，旧流程标为历史；凭据取法不变，不直接改主机 |

源码搜索范围为packages/voice-codex、scripts内voice相关启动/QA/fixture/test-deploy及仓库CI/package引用。check-voice-api-auth-local在所查脚本/package/CI中未发现自动调用；仍是人工可用入口，不能留成调用已删除constructor的坏脚本。主机已安装脚本字节未在此宣称核实或更新。
