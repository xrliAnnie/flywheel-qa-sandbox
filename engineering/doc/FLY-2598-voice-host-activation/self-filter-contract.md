# FLY-2598 运行中的自身作者过滤证明 — 实施计划
Issue: FLY-2598 (https://linear.app/geoforge3d/issue/FLY-2598/语音激活-主机激活-2446-通用语音进程会议模式-随身模式注册表-huddle-块-lead-voicemodes-voice)
日期: 2026-09-16
基于: plan.md, research.md

R1 HIGH `mirror-echo-guard-loses-its-only-fail-closed-preflight` 的必要修订。Lead 回答 `aa87aab0-b2f7-47eb-bee6-34e1d1976901` 已批准：Claude Discord fork 小补丁单独 PR、部署回执；主仓只接探测与准入，不复制插件实现、不改 allowBots、不恢复编排忽略名单。本文是实现要求，不是已运行能力。

## 1. 不允许回环的实际执行点
Claude fork `xrliAnnie/claude-plugins-official` 的 Discord plugin（当前安装相对文件 server.ts）增加 `self-author-filter.ts`，导出不做 I/O 的自身作者判定。输入为已验证的固定 bot ID、当前连接 ready 布尔及 incoming authorId。首次 ready 捕获 client.user.id，后续 ready 必须仍相等；ID 变化、ID 未知或未 ready 一律拒收。断线时先把 ready 置 false；固定 ID 不因 client.user 暂时 undefined 而消失。
messageCreate 回调第一道判断调用这个函数，先于 allowBots、路由、回执、reaction 和 legacy notification；self echo 的 health 记录可以保留，但不得 ingest。函数只回答“可否进入下一道过滤”，不能自行授权 founder 或绕过现有 access。当前 enabled/broken/legacy delivery 模式都先经过它，堵住 legacy notification 绕路。
Codex 的自身 ID 已是认证后固定值（CodexDiscordGateway.passesFilters），保持该行为；提取等价无 I/O 的判定供实际 callback 与探测共用。不能用额外 ignoredAuthorIds 代替 self guard。

## 2. 从正在处理消息的进程探测
新能力名 `voice_self_filter_v1`。Codex 复用 CodexLeadInboxSocket 的认证 Unix socket，增加只读 `probeVoiceSelfFilter` method；server 通过 gateway 提供的闭包执行上述真实函数，不填硬编码 true。Claude fork 在当前 STATE_DIR 下增加 `voice-self-filter.sock`，0600，仅 owner 可读写；仅 RECORDER_MODE=enabled 且已知 leadId 时对 voice 返回 ready。该 socket 随插件生命周期启停，关闭时仅 unlink 自己 bind 的 inode；遇已有可连接 owner 不抢占，遇 symlink/无法证明 stale 不删除。
Claude STATE_DIR 解析复用现有 preflight 的 Lead Discord state-dir 规则，不接受请求方随意给路径。主仓新增 `bridge/voice-self-filter-probe.ts` 作为 client/校验器；Claude server 放 fork 内，不在主仓镜像或直接改安装缓存。

请求为单行 JSON：`{version:1,method:'probeVoiceSelfFilter',leadId,expectedBotUserId,nonce,auth}`，nonce 为每次新生成的随机 32 字节 hex。使用该 Lead bot token 为 HMAC-SHA256 key，对固定有序数组 `[1,'voice-self-filter-v1',leadId,expectedBotUserId,nonce]` 的 JSON UTF-8 字节签名，恒时比较。Codex 外层保持 inbox transport version=2，此处 version=1 是 self-filter 子合同版本（字段 contractVersion）；其请求结构在既有 canonicalRequest/auth 分派中显式新增，不绕开原请求鉴权。Claude 独立 socket 直接使用上述 version=1 结构。无 token 值进消息、日志或收据。
响应只含 `{version:1,leadId,botUserId,runtimeId,nonce,ready,selfDropped,unknownDropped,otherPassed,auth}`。runtimeId 是进程启动随机 UUID；每次 probe 对固定自己的作者执行真实函数，对 unknown/not-ready 状态执行同函数，对一个不同的有效测试作者执行同函数，最后一项仅表示能进入后续过滤。响应 HMAC 覆盖固定顺序的全部字段，绑定请求 nonce；不能回放磁盘结果冒充运行进程。最大请求/响应 4KiB、单连接单请求、2 秒总期限，坏结构、坏 MAC、错 ID、过时版本、timeout 都拒绝。探测绝不调用 messageCreate、入站 handler、数据库或 Discord API。
通过条件为 exact Lead ID / /users/@me 已核的 bot ID / nonce / 合法 runtimeId / ready=true / 三个布尔全 true / 有效 MAC。源码版本、安装指针、mtime、单独 capability 字符串均不能替代此结果。探测与实际 handler 使用同一函数的接线由行为测试证明；不声称抵抗同 UID 恶意进程持有 token，本单没有重开 OS 隔离。

## 3. 准入与恢复边界
start 在 reserve 前调用探测；缺能力统一 503 `voice_unavailable/self_filter_unverified`，细分检查原因只用枚举。claim/resume/recovery 首次允许发送前同样在 Bridge 侧重验；daemon 不持有任意插件 socket 路径。Bridge 的活动会话周期检查也复用探测，runtimeId 变化允许新进程重新证明，失败则走已有 failed/停流/离房清理；不得靠磁盘缓存继续。这不是“只开场检查后永久相信”的门。
插件自身 guard 在每一条事件中独立 fail closed，重连期间 probe 失败与事件丢弃一致。部署或回滚 carrier/fork 前必须先结束 voice session；禁止活动会话期间回滚到没有 guard 的旧插件。此运行规则不自动获得重启生产 Lead 的权限。

## 4. 配套提交与验证
实现节点创建 fork 独立 PR，固定 commit SHA 与 guard/probe tests；主仓 PR 引用此依赖并新增 client、Codex probe 接线及 preflight/恢复门。都按各仓现有 review/ship 流程走，不能直接写 main 或修改缓存。部署由既有独立 updater/插件受管流程负责，需收据记录 fork sha、目标 carrier incarnation、运行 probe runtimeId、主仓部署 sha。尚未载入的 Lead 只标未就绪。
必要测试：
- Claude 真实注册的 messageCreate callback 遇 own author + allowBots 含自身仍零 ingest/notification；client.user undefined/断线/首次 ready 前同样零副作用；正常 founder 仍进入原 access 流程。
- mock emitter 连续两次 ready 的 ID 不同拒绝；同 ID 重连恢复后 self 仍丢弃。probe 直接调用同函数，用 mutation/依赖替换让 guard 返回错误，probe 必须失败，不能常量绿。
- 两 backend 运行中的 socket 真实请求验证 nonce/MAC/版本/Lead/bot/runtimeId、限长/timeout；失败零 reserve/根卡，恢复失败零 mirror/ingest。旧 server 不支持方法拒绝。
- 同 bot `🗣️/📻/🤖` 混页全被 poller 过滤，正常回复一次，cursor 前进；显式 founder voice ingest 不被误丢，原重放 identity 不变。
- host runbook 的只读 helper 输出当前运行 probe 收据；不为了这个测试让生产 Lead 进房。真实房内无回环仍属首场验收，不能由探测替代。

新增/更新主仓测试：`bridge/__tests__/voice-self-filter-probe.test.ts`、既有 preflight/services/runtime、CodexDiscordGateway/CodexLeadInboxSocket tests。fork 测试在其既有 bun test 环境跑 self-author-filter、server callback 和 socket 生命周期；实际 package/test 入口由实现节点核 fork checkout，禁止执行安装缓存测试来代替 PR。
