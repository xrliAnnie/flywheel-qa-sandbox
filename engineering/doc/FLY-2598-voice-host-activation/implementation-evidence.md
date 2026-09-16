# FLY-2598 每个 Lead 自己进房 — 实施记录
Issue: FLY-2598 (https://linear.app/geoforge3d/issue/FLY-2598/语音激活-主机激活-2446-通用语音进程会议模式-随身模式注册表-huddle-块-lead-voicemodes-voice)
日期: 2026-09-15
基于: plan.md, self-filter-contract.md

## 当前边界

实现进行中，未请求 code review、未创建 PR、未完成实现交接，未激活主机或执行首场/RG。当前实现 TURN epoch=2，execution=fabd68a3-0b4c-4315-83b6-83a26d7a9046。
设计 gate 5ebee204-02f9-47e9-9c64-af1c92e1e9d1 已通过 CLI 实时核对 effective APPROVED；沿用原设计与三条非阻断 Follow-ups。

## A：room schema

- 提交 dbb62b309：独立 voiceRoom 仅接受两个 snowflake 字符串；缺席/null 原样保留；旧 huddle 不改。
- 首次测试未收集：缺 flywheel-config dist。完成 frozen install 与首次 `pnpm -r build`（exit 0）后重跑。
- 红侧：huddle-config 9 failed / 25 passed；九个失败均为新 room 输入本应拒绝却未拒绝。
- 绿侧：huddle-config + voice-session-config 两文件 37 passed。
- registry 不检查跨项目房间冲突；该限制属于 voice start 准入。

## B1：持久身份与 start resolver

- 新 reservation 必填 voiceBotUserId；SQL 参数化写入，重启读回。历史 migration 加 nullable 列，不回填身份。
- 同 meeting intent 增加 guild/room/bot 三项一致性检查。
- start 只用 exact Lead.botTokenEnv 对应凭据；拒绝 legacy huddle、无 room、跨项目异房、缺 Lead token/身份；请求体不能覆盖 bot ID。
- 红侧：新增 StateStore.voice-identity 9 failed；start resolver 更新夹具后 9 failed / 5 passed。
- 首轮绿侧：identity/schema/session/start 四文件 45 passed；增加三个 start 边界用例后，扩展 identity/schema/session/start/poller/provisioner/runtime/services 八文件 88 passed，TeamLead build exit 0。
- B 尚未完成：服务层持久 tuple 校验、claim 前投影校验、旧活动行/漂移行清理与出站结算、status 和运行时恢复守卫仍待实现。

## 后续批次

按 plan §7 完成 B 剩余项及 C-G；Claude fork 独立 PR 与受管加载依赖不省略。最终执行 lint/full build/package gate/shell inventory/retention/code review/exact-head CI/PR/milestone/needs_review。主机配置、安装、首场和 RG 由后续授权阶段执行；当前测试不证明生产激活。

## B2：服务层、claim 与恢复巡检

- resolver 精确核对持久 project/Lead/guild/room/bot tuple 与唯一 registry 绑定；每次使用 exact Lead env token，允许同 bot ID 的凭据轮换。
- claim 先校验再投影，之后才 CAS 领取；renew 先核有效 lease 再重新准入；status 仅读持久行，终态不依赖 registry。
- runtime 每轮对所有活动状态核准入，历史空身份/registry 漂移转 failed；同一事务把 queued 置 dropped、claimed 置 ambiguous，保留原身份和证据。C 将接入同一 validator 的运行 socket 探测。
- 红侧：routes 4 failed / 5 passed，services 12 failed / 2 passed，identity 1 failed / 9 passed（缺清理接口）。绿侧四文件43 passed；TeamLead build通过。一次新增断言把既有 renew 拒绝值误写 null，按现有接口更正为 undefined；一次构建发现 Lead 未显式判空与未用变量，已修正并重建通过。

## C1：主仓 per-Lead 预检与运行过滤证明

- 新增有界、nonce/HMAC 绑定的运行 probe client；Codex inbox v2 增 contractVersion=1 分派，仍走原 canonicalRequest/auth 验证，回应由 gateway 实际 self guard 计算。两种运行入口均接同一 gateway closure。
- 开场只用目标 Lead token 执行一次 /users/@me、同一 member 的声房/文字权限，以及 Gateway IDENTIFY 剩余额度。GET/JSON/timeout/缺字段有明确失败；频道403保留阶段、HTTP状态和未知权限 null。证据只保留白名单字段。
- start/provision/claim/renew/活动巡检/状态发送使用实时 probe；不读旧 allowBots 作为就绪证明。codex-lead.sh 不再从 huddle 注入编排 bot 忽略列表，通用 ignoredAuthorIds 能力保留。
- preflight 红侧15 failed；活动载体缺 probe 红侧6 failed；主仓8文件131 passed、poller3 passed、socket变更后2文件34 passed。TeamLead build 和修改文件 biome 检查通过。
- Bun 与 Node 的 EOF 行为不同，Claude 使用单行请求且不提前 half-close；Codex 保留既有 EOF framing。跨进程 Node→Bun 实测归叉仓测试，不能只用 Node mock 冒充。
- Claude fork 已在 paired/claude-plugins 隔离 checkout 实现，未改安装缓存；242项完整 Bun 测试通过，server Bun bundle通过。叉仓 PR/commit 在后续收据中固定；尚未部署。

### 配套 fork 交付定位（尚未合入/载入）

- 嵌套路径：`paired/claude-plugins`，独立仓 `xrliAnnie/claude-plugins-official`。
- Draft PR： https://github.com/xrliAnnie/claude-plugins-official/pull/28
- 当前 fork HEAD：`393d70e143d5148510a85f4e8cc8389af3a0eac6`。
- 实现完成命令必须声明 `--declare-pr paired/claude-plugins:28`，代码审阅要包含该真实嵌套 HEAD；不得只审主仓而把 fork 当已通过。
- 243项本地 Bun 测试、server bundle已通过；当前 fork HEAD 的 Discord Runtime CI通过（run 35045962754）。代码审阅、合入、受管载入和生产 runtime 收据分别待核，不把草稿 PR 当激活证据。

### 跨平台 CI 更正

首次 fork HEAD 0997361 在本地 macOS 242测试通过，但 Linux CI 35045787974 发现 Bun close 自动 unlink 公共路径，令替换文件丢失。未跳过测试；改为私有 socket 名称 + exclusive hard-link 发布，并显式清理仍匹配 inode 的两条路径。新增无残留测试，243测试通过；393d70e 的 Linux CI 35045962754通过。此差异说明本地平台绿不能替代 exact-head CI。

## D1：daemon 首次连接身份

- daemon resolver 仅从唯一 project/agentId、voiceRoom 和 pinned bot ID 解析 exact Lead.botTokenEnv；无编排 bot 或 cached token fallback。允许同 ID 的 token 轮换。
- claim projection 类型加入 sessionId/voiceBotUserId；普通构造核 sessionId 一致并在租约检查之间做 /users/@me，有界 2秒（含 body parse）、禁止 redirect、错误不含 token/原始响应。
- Discord registry ready 后核 expectedBotUserId，缺失或失配则 stop/destroy，零 join/audio/status。异步身份拒绝沿既有 failed/清理路径处理。
- 红侧 resolver7失败，ready身份2失败，异步构造1失败；helper缺模块失败后实现。绿侧 config/bot-identity/discord-room/daemon 四文件49测试通过，voice-codex build通过，修改文件biome通过。
- D仍未完成：saved projection严格验证/旧坏记录隔离、恢复前REST核验与本地abandoned、ready前回调守卫；E-G和全仓交付门禁待做。当前主机未激活。

## D2：恢复隔离与 ready 前副作用守卫

- 新 projection parser 在保存及恢复发送前严格核 sessionId、bot/房间/频道/用户 ID、模式和 IO 所需字段；磁盘 projection 以 unknown 承载，不借当前 registry 填旧身份。
- 只有原 lease 仍有效、tuple 匹配且 /users/@me 核 pin 成功，才能 replay captured/mirrored journal。缺身份、漂移、REST失败或 lease失效只写本地 abandoned，保留原证据。发送使用实际验证过的同一个 token。
- malformed JSON/外层 authority 无效：本地 abandoned 并将原文件原字节 rename 为 session.quarantined-UUID.json。其他恢复记录先尝试有效 lease 的 failed 上报，再隔离 active record；网络/HTTP receipt失败不再无限卡启动，由 Bridge 精确行过期处理。不得伪造 lease 发请求。
- 回调读取/上报失败也继续下一记录和 idle。GenericVoiceSession 在 ready 身份核验完成前丢弃 frontend transcript/audio/status；异步身份核验期间收到 shutdown 不会再启动房间。
- 红侧：state-store新增4失败、daemon恢复8失败、ready前状态镜像1失败、异步shutdown1失败；recovery模块先缺模块失败后实现。
- 绿侧：voice-codex完整包21文件158测试通过；随后新增下一记录/idle与shutdown用例并调整token复用，受影响4文件51测试通过、voice-codex build通过。最终全仓 aggregate/exact-head CI尚未执行。

## E：平台 API 认证与私有 voice home

- daemon parent config要求非空OPENAI_API_KEY，私有 realtimeApiKey只交RealtimeFrontend。voiceCodexEnv正向白名单不增key；spawn保留默认washSecrets。wrapper缺key时exit0并发voice_api_key_unset有界告警。
- initialize之后、任何thread前调用account/login/start(apiKey)，再核account/read(refreshToken=false)返回account.type=apiKey；失败固定realtime_api_auth，不降级订阅。login/read等待期间stop不会继续建thread。
- 启动与每次spawn均核home本人0700、config普通非symlink本人0600、固定api/ephemeral两行，无额外provider/MCP/profile；已有auth.json拒绝且不读取、不删除。准备仍归Lead后续授权动作。
- RPC认证/朗读/启动异常和关闭reason不保留原始响应；voice进程协议logger不转存上下文，stderr buffer为0。
- 红侧：认证8失败、config4失败、wrapper缺key1失败、原始RPC错误泄漏2次分别失败；home新模块先缺模块失败。绿侧：voice-codex22文件184测试通过，build通过；wrapper32 passed/0 failed。
- `node scripts/check-voice-api-auth-local.mjs` 使用本机codex-cli0.153.2、隔离临时home、无效fixture key和不可用loopback代理；复用真实RealtimeFrontend与CodexLeadProcess，在真正thread请求前拦截，零thread/realtime/Discord。实际child环境无credential；API回执通过，重启account=null，auth.json与任何临时home文件均无fixture key。证据：local-api-auth-evidence.json。脚本可复跑；不声称余额或真实模型可用。
- 官方API合同参考：https://learn.chatgpt.com/docs/app-server 。当前本机版本的实际RPC结果优先于泛化文档。
- E本地证明完成；F安装/事务配置、G预检driver、全仓门禁与有效review/PR交付仍待做。

## F1：显式 voice launchd 首装入口

- 新 install-voice-launchd.sh 仅接受生产repo、Darwin/UID501实际user domain；核源普通plist、固定wrapper/RunAtLoad/on-failure/ThrottleInterval、host/env/已构建CLI/voice-host/voice home、旧voice-bridge冲突和disabled override。launchctl均经既有bounded-run限时。
- --check只读；完整临时home目录前后内容/mtime/mode一致。普通安装先预检，再用独立kernel文件锁重新检查；复用_cnd_copy_plist_preflight/_cnd_install_plist做create-if-absent，不覆盖异内容/符号链接。
- loaded服务须证明plist path、program/arguments、running/PID及on-failure策略；不restart。新bootstrap后观察running；wrapper拒绝退出0仍安装失败。回滚只bootout本次bootstrap且身份/目标fingerprint仍匹配的job，确认missing后才条件移除本次创建plist；预存同字节plist和被替换目标均保留。
- 红侧缺入口时positive与拒绝后回滚2测试失败；最终9个行为测试通过，覆盖安装/重复/disabled/异内容/symlink/退出0/保留旧文件/未知loaded身份/替换目标/并发。shell语法、diff检查与CI结构合同通过，测试已加入强制launchd脚本清单。
- 未在真实主机执行安装命令；测试使用临时repo和模拟launchctl/node。F2配置事务工具尚未实现，F批不计完成；G和全仓交付门禁仍待做。

## F2：受锁保护的双文件配置事务

- voice-host-configure.mjs 提供 prepare/apply/restore；通过既有 kernel config lock 下的私有 stdin 模块执行，无内部绕锁命令或 env 锁声明。prepare 先验证原注册表及 summary authority，再生成固定 General、全 Lead meeting、仅 raya/raya RG 的候选；保留合法 voice 和原有 host 内容。
- 私有目录0700、备份0600；原文件 bytes/mode/hash、候选哈希和 UUID receipt 绑定。summary receipt 始终只读且每次核一致；拒绝 pending intent、第三方修改和 legacy huddle。每次 publish 前后记录步骤，fsync 原子 rename；只恢复已知 before/after 图像，冲突显式 rollback_failed。
- 新工具红侧缺模块；umask077 丢原mode、symlink parent将backup放入repo、无效receipt ID均先失败再修复。最终23项行为测试全部通过，含真实 schema/summary roundtrip、全部步骤及rename后中断恢复、restore再中断、锁阻塞、发布后验证失败回滚。biome、diff与CI结构检查通过。
- 实际主机配置未改，安装未执行；F本地实现完成。G预检消费者及全仓、review、PR门禁未完成。

## G：预检入口与旧QA消费者

- 新 fly2598-voice-preflight.mjs 从本机 owner 普通 registry、0600 voice-host/env 读取，env静态解析不执行shell。严格唯一project/Lead和meeting opt-in，exact botTokenEnv解析后调用生产 preflightVoiceSession，只有Discord GET及运行self-filter只读探测。输出白名单ID/stage/status/boolean/runtime proof/codeSHA；新证据文件0600独占创建，异常无raw配置/响应。
- 旧2446两harness driver改用voiceRoom，取消独立voiceBot拓扑要求；recorder逐场订阅所选Lead，live和ended证据核voice_bot_user_id，收据保留bot ID。原Raya adapter/两种harness真实验收要求保留，不伪造QA结论。
- 红侧：旧driver3项失败，新预检缺模块；绿侧driver21项、预检10项通过（GET-only、错token/ID、角色权限、member overwrite、频道403保留null、timeout、缺运行probe），实际recorder订阅逐Lead核验。CI清单加入预检，CI结构通过。
- A-G本地功能已实现；全仓lint/build/package gates正在进行，code review、main PR/exact-head CI/里程碑及handoff尚未完成。生产运行、Bridge鉴权阶梯、首场会议和RG均未执行。

## 交付前核对

- `pnpm -r build` 全workspace通过；`pnpm lint` 修复本单数字负例字面量和路由格式后通过（已有warnings保留）。retention consumer gate `ok:true`。wrapper32/0、CI结构通过。package gate运行中，不能把focused green写成aggregate green。
- 安装测试负载下首次9项出现3失败：外层15秒截断安装/rollback，以及并发锁等待返回75。仅将测试外层期限放宽60秒，并明确一方必须成功、另一方可有界75、重试复用同job、总bootstrap恰一次；生产期限未改。复跑9/9通过。
- 真实CLI fixture发现预检.env路径拼错，红→修正→绿；另修fixture的required summaryRole。证明只读原配置、输出0600、现有收据拒绝覆盖且不含无关secret。共享helper10项和CLI独立1项通过。
- 新同token双client组合测试使用实际DiscordVoiceRoom与CodexDiscordGateway、模拟Discord transport。核voice没有messageCreate处理器、carrier stop/start前后重复镜像零router.submit、普通文字一次；测试1/1通过。不是实际gateway双连接、线上重连或房内声音证明。
- 配套PR28重新查询：HEAD393d70e143d5148510a85f4e8cc8389af3a0eac6，Validate Discord Runtime/test成功（run35045962754）。尚未合并或装入生产插件缓存。
- 对当前origin/main只读merge-tree无冲突；未merge main，未改变部署。

### Legacy引用审计

已对packages/scripts（排除dist/node_modules）逐条扫描`orchestratorBot|earsBot|voiceMirrorIgnoredAuthorIds|HUDDLE_ORCHESTRATOR`，41处均落在下列保留范围；generic voice-codex/新预检/旧2446 driver无编排凭据读取：

| 保留路径 | 分类及原因 |
|---|---|
| packages/voice-bridge/src/config.ts；scripts/run-voice-bridge.ts | legacy-only /glaw旧进程配置；本单不启用，安装器拒绝其已加载job |
| voice-bridge的brain-config/config/gemini-command-and-config/qa-fly545-r23测试 | legacy-only回归夹具 |
| packages/teamlead/src/ProjectConfig.ts；huddle-config.test.ts | legacy-only schema兼容及新voiceRoom拒绝旧字段的负例 |
| codex-lead-core-mention-env.test.ts；voice-session-start.test.ts | legacy输入不得注入忽略作者/不得激活generic的负例 |
| CodexLeadInboxSocket.ts及其测试 | 通用ignoredAuthorIds诊断兼容字段；本单不从huddle赋值，运行self-filter证明单独认证 |

生产激活、Bridge鉴权阶梯、首场会议、RG、平台余额与线上双连接健康均未执行，须由授权Lead/updater/QA依host-runbook收据继续。

- 主PR1219首个head7c521fd6d的Quick Gate在shell/Node枚举门禁失败：install-voice-launchd.test.mjs仅经shell wrapper间接执行，没有ci.yml literal node命令。现补显式Node枚举，保持wrapper测试不删；本地枚举324 shell/68 Node及CI结构均通过。其他CI仍运行，不把被skip的Quick Gate子项记通过。launchd-units-manifest shell检查通过。主review旧head问题f922f1ae-9645-47c3-999e-86f53b18c628需新head重审；paired问题672ae80f-5a13-4bd0-87e5-24d34f787fe2独立绑定393d70e不变。

## 当前CI发现的旧夹具合同修正

- HEAD865fe0a53的Quick Gate/light/NPM分发通过，但TeamLead shard1暴露StateStore.voice-session恢复夹具未随严格projection更新：缺sessionId且guild/channel/thread/founder仍是占位字符串。本地复现1失败/17通过；改为同一reservation tuple的合法ID，并将失效lease终态请求预期从1改0（批准计划要求零外部副作用）。18/18通过，生产守卫未放宽。
- shard4暴露codex-lead-core-mention-env旧断言仍要求huddle派生忽略名单。本地复现1失败/3通过；测试改为legacy huddle不派生、无显式配置时unset、显式通用过滤配置原样保留。5/5通过，生产launcher未改。
- 当前观察性能job有单个tail181ms（CPU11ms）超过50ms；Script Tests3有未改动PTY EOF/exit回收竞态，44ms报告30秒timeout。保存完整日志并向Lead报告；不删断言、不改门限。整体CI未结束时GitHub拒绝单job复跑，尚不能记重试通过。
- 本地package gate仍运行；claude-runner第一包receipt failed=12并含onTaskUpdate RPC错误，日志显示async-exec-file/kill-path-inventory/两个real-tmux测试超时。因此该收据不满足RPC-only豁免，不标aggregate通过。后续需完整有效验证。
