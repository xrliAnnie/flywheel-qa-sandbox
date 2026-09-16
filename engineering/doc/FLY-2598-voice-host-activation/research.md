# FLY-2598 主机语音激活与设计更正 — 调研
Issue: FLY-2598 (https://linear.app/geoforge3d/issue/FLY-2598/语音激活-主机激活-2446-通用语音进程会议模式-随身模式注册表-huddle-块-lead-voicemodes-voice)
日期: 2026-09-15
基于: exploration.md, design-correction.md

## 结论
当前实现仍是独立编排 bot，不能只改主机 JSON 即兑现 founder 的 per-Lead bot 决定。必要工作：独立房间配置、会话固化 Lead bot 身份、所有 token 消费者同源、保留同 bot 防回声、平台 API 认证接线、受管首次安装入口。会话状态机与交付/朗读协议沿用 2446。
本调研已按注入的设计 mandate 收敛到 plan；不另开 brainstorm/founder-review gate，正式设计审阅使用明确 request-review。

## 1. 当前观察与证据分级
- 工作树分支 `flywheel-FLY-2598` 开工干净；宿主 7 个项目 17 个 Lead 无语音字段；voice-host/codex-home 不存在；新旧两个 Flywheel voice 单元均未加载。
- `prechange-http-evidence.json` 是 2026-09-16 00:24:44Z 的现网只读边界观察：401/400/404 已观察；ingest 凭据该环境未设置，因此 403 未执行；master 已配置，因此 unset 503 未执行。没有 start 合法会话、进房、服务变更或 DB 复制。
- `OPENAI_API_KEY` 只验证存在性；未读出密钥到工具输出，未验余额/模型权限，未发计费请求。
- 已安装插件源码证明存在 self-id 守卫，不等于每个运行中的插件已加载那些字节。源码本身不足以准入；R1 后要求运行时探测，见 self-filter-contract.md。
- Linear FLY-2566 当前内容确认故障配对是 projects.json 与 `state/summary-registry/migration-receipt.json`；不是猜测的 identity.json。

## 2. 消费者与必须覆盖的接缝
| 源码锚点 | 当前事实 | 设计动作 |
|---|---|---|
| `packages/teamlead/src/ProjectConfig.ts:287-302,1139-1217` | huddle 要求 orchestrator 与 ears env，orchestrator ID 可选 | 新增严格 voiceRoom 房间字段；保留旧 huddle 仅兼容，不用于通用语音 |
| `packages/teamlead/src/bridge/voice-session-start.ts:65-121,189-217` | meeting 必须 existing absolute evidenceDir；meeting 缺模式默认允许，RG 必须 true；还读双 token | room + exact Lead token；边界拒缺 token/id，reservation 固化 bot |
| `voice-session-preflight.ts:59-162`（同目录） | 双身份 GET 和双组权限 | 合成同一个 Lead 身份核对，语音+文字权限取并集 |
| `voice-session-preflight.ts:165-214` | capabilities/allowBots 的编排 bot 排除预检 | 替换成运行中的自身作者过滤探测，不改 allowBots |
| `packages/teamlead/scripts/codex-lead.sh:124-135` | 从 huddle 生成额外忽略 ID | 删除编排投影，保留通用可选忽略机制与 self-id 守卫 |
| `lead-backends/codex/CodexDiscordGateway.ts:274-280` | 自身 bot 消息默认丢弃 | 不改；新增/保留同 bot 用例 |
| 已安装 Discord plugin `0.0.7/server.ts:1597-1605` | self-id 早于 allowBots | 需要 fork 固定自身 ID、未知拒收和运行探测；见 R1 更正 |
| `voice-session-services.ts:36-40,52-96,117-159` | projects/host 启动快照；projection/poll/status 重新取 Lead | 固化 bot ID；各外部动作严格匹配会话；终态 status 不依赖 registry 仍存在 |
| `packages/teamlead/src/StateStore.ts:2569-2629,3242-3260,6881-6911` | 两表与 reservation 没有 bot 身份列 | 增 nullable voice_bot_user_id，新行必填，历史终态不回填 |
| `packages/voice-codex/src/config.ts:133-155` | token 仅 project+huddle，未匹配 Lead | 精确 project+lead+room+expected ID，失败不回退 |
| `packages/voice-codex/src/cli.ts:63-64,101-114,167,210,264` | 启动一次加载 registry，进房/镜像/恢复共享 tokenFor | 全部使用新解析；恢复发送前同样验 token id |
| `packages/voice-codex/src/discord-room.ts:123-131` | login 后直接 join | ready 后核 `client.user.id === expectedBotUserId`，再 join |
| `packages/voice-codex/src/session-state.ts:73-80` | saved projection 只校验为 object | 验身份字段；旧/坏记录进入无副作用失败清理，不静默补身份 |
| `voice-session-poller.ts:35-43` | 排除 root、🗣️/📻/🤖，游标跨过滤行前进 | 保留并测同 bot 混页/全过滤页；author 使用 pinned ID |
| `packages/voice-codex/src/delivery.ts:139-143,173-203` | 镜像总加 🗣️；显式 ingest author=founder，重放对照 envelope | 身份保持不变，镜像消息作者改 Lead bot，不把 founder 改为 bot |
| `packages/flywheel-comm/src/commands/voice-session.ts:108-135,207-212` | status 需 session/meeting id；meeting start 需 evidence-dir | runbook 补齐，不增加无目标 status 假命令 |

## 3. 为什么用 voiceRoom
旧 `huddle` 的存在会被 `scripts/lib/restart-voice-bridge.sh:21-25` 当作启用；`restart-services.sh:3210-3214` 在部署路径调用它。legacy loader 还包括 `packages/voice-bridge/src/config.ts`、`assistant/config.ts`、`eleven/config.ts`。把 huddle 缺 bot 字段写进去既过不了校验，又可能启动错误进程。
选择新 `voiceRoom`，主机 legacy huddle 保持 absent/null。两者不是镜像：旧字段只服务 legacy，通用功能只认 voiceRoom；同时配置两者时对通用开场拒绝 `legacy_voice_conflict`，避免双进程同房。另一方案是 huddle discriminated union，要改四个 legacy raw selectors，增加无关行为面，本单不选。

## 4. API key 证据与选择
`voiceCodexEnv` 当前只允许 12 个系统/代理环境变量，不含 OPENAI_API_KEY；wrapper source 环境并不代表子进程收到。
本机 `codex --version` 为 0.153.2。已下载官方同 tag 源码（不执行）核对：
- [codex rust-v0.153.2 realtime_conversation.rs](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/core/src/realtime_conversation.rs) L1193 强制 API provider；L1262 WebSocket 使用 API key；L1704-1727 优先 provider/key auth、末尾 OPENAI_API_KEY fallback，否则明确 `realtime conversation requires API key auth`。
- 默认 realtime 模型 L108 为 gpt-realtime-1.5；本次保留已有 v2 协议和模型，不借此次激活升级模型。生产开场需确认该模型可访问，失败不能改用订阅静默兜底。
- [官方认证文档](https://learn.chatgpt.com/docs/auth) 区分 ChatGPT 订阅与 API key 的平台计费；[官方 WebSockets 文档](https://developers.openai.com/api/docs/guides/voice-websockets) 展示服务器持有 key 的连接。公共文档不证明这台主机的余额或运行认证。

R1 核验补齐第二层清洗：`codex-lead-runtime.ts:1348` 默认调用 `washActionSecretEnv`，`secret-broker.ts:35` 的 KEY 模式会删去 key。因此明确不用子进程 env 通道，保持正向白名单和默认洗环境；daemon 父进程读取 wrapper 实际 source 的 key，启动后仅通过 app-server 私有 stdin 的 `account/login/start {type:'apiKey',apiKey}` 明确建立当次 API auth，并核 account/read 类型，再建 thread；voice home 用 ephemeral credentials store，不借全局/Lead 订阅登录。密钥仅受控进程内存，不进命令行、日志、projection、证据、报告；认证响应仅记 type/成功布尔。缺 key 本地拒绝，不查 subscription quota、不切 Codex 账号。测试必须覆盖洗环境和 JSON-RPC 不泄漏。

## 5. 安装路径与 manifest 真意
- `scripts/lib/restart-voice.sh:14-18` 未加载则 no-op；不能首次安装。
- `scripts/flywheel-daemon.sh` 只安装 Lead 目标，不是 voice 服务安装器。
- `scripts/lib/supervisor.sh:247-264` Darwin install 默认 no-op；opt-in renderer 写 bool KeepAlive=true（L212），不满足 voice 的 SuccessfulExit=false。
- `scripts/lib/converge-nonlead-daemons.sh:783-807` 已有 `_cnd_install_plist`：源检查、同目录暂存、硬链接 create-if-absent，保留提交 plist 字节。
- manifest `hold` 跳过收敛自动安装、漂移检查和 bootout 后恢复（L994-998）；`managed` 会把域内已加载单元视为错误（L979-991）。因此本单保留 hold，绝不照抄旧 plan 的“QA 后 managed”。
- 窄增 `scripts/install-voice-launchd.sh`，复用 committed plist publication/helper 和 supervisor probes，精确目标 voice。操作由 Lead 上线窗调用；不让 updater 自动激活。
- wrapper 的 exit0 是正常退出/拒绝（配置、锁、tmux gate），exit1 是运行崩溃；launchd on-failure 才拉起。安装退出0仍须核运行 PID/日志，不能当可用。

## 6. 注册表成对保护
FLY-2566 记录：注册 Raya 后恢复 projects.json 却未恢复 summary receipt，使 summary_registry_projection_mismatch 拒部署。
`packages/flywheel-comm/src/commands/lead-registry.ts:509-519,634-659,713+` 维护成对备份与恢复意图；但 lead-registry add 只添加/续同一 identity，不可拿 register 伪造 voice 修改。
本次不得改变 Lead identity/summary assignment，voice-only 编辑前后用同一个 `summary-registry verify-activation` 收据核验；共享 projects-config lock 下读取和原子替换，记录两文件 hash，并备份两份。若 receipt/hash 在操作中被别人改动，停止，不能盲目恢复旧文件覆盖新注册。voice-only 正常无需重铸 receipt。

## 7. 验证范围
测试用 fixtures 证明新身份链、错误 token、同 bot 防回环、API auth、旧数据恢复、首次安装与 idempotency；受管构建与现网预检另留证据。只有 founder 真进 General 说话，镜像/唯一 mailbox delivery/Lead 回帖/房内声音/同 session 行相互对应，才证明首场。
RG 条件独立：Raya 载体就绪、voiceModes.rg=true、一次耳机实际对话与退出，不能用 meeting 成功代替。
不为覆盖 master-unset 503 清生产 master；不为测权限拒绝启动真实 Lead 会话；合法 start 本身会发 Discord 根卡并创建会话，没有 dry-run。

## 8. R1 后证据
`r1-env-evidence.json` 记录 clean Bash（只继承 HOME/PATH、不读 zshrc）source `.flywheel/.env` 后 key 非空，文件0600。原审阅 `^OPENAI_API_KEY=` 未匹配 `export OPENAI_API_KEY=`；不能据此判断缺 key。仍在 runbook 增加缺失时配置与实际启动来源验证，不打印 key。
同 token 第二 Gateway 的限制依据 [Discord 官方 Gateway 文档](https://docs.discord.com/developers/events/gateway)：GET /gateway/bot 返回 session_start_limit，IDENTIFY 与恢复有各自约束。文档不证明本机两 client 共存成功，故只列明确假设、隔离测试和首场观察，不把它写成已验证事实。
