# FLY-2551 小红书逐次批准门 — 调研
Issue: FLY-2551 (https://linear.app/geoforge3d/issue/FLY-2551/2441follow-up-小红书-publishcommentlikefavorite-的机器可验-founder-门今天)
日期: 2026-09-14
基于: exploration.md

## 结论

需要一条独立于 ship 的可信批准链，及同时约束 Claude/Codex 的 provider（真正操作小红书的服务）出口。只在 2519 broker 插入一个 approved 布尔值不满足本单。当前本地 provider 缺乏真实账号 ID、认证入口与消费约束，因此 **Flywheel + 现有 xiaohongshu-mcp fork 两仓协同是必要实施范围**。本阶段未改两仓运行时代码、未执行小红书工具、未访问账号凭证。

## 可重现源码坐标

基线 A：Flywheel `579c79ed662e49e7799b5d61ccd6d11a00fce3f2`。基线 B：2519 只读参考 `8e182b224316c2ae1ba3ac19f370db474677d08f`。基线 C：`xrliAnnie/xiaohongshu-mcp` 本地 HEAD `cf707922a748713f86cda729b1108bf98c951640`，checkout 在 `/Users/xiaorongli/Dev/xiaohongshu-mcp`；有他人未追踪 `docs/solutions/`，未触动。C 是源码快照，不是运行二进制一致性证明。

| 源码 | 已观察行为 | 设计含义 |
|---|---|---|
| B `lead-capabilities/upstream-inputs.ts:342-507` | 六写固定拒绝；`unlike/unfavorite`、schedule、visibility、original、products 都影响结果 | 明确完整字段指纹及反向操作 |
| B `handlers/upstream-write-denials.ts` | 注释引用 3a78eb55；无 provider I/O | 无门时保留原拒绝码 |
| B `handlers/upstream-read.ts:13-30,65-172` | 2.0.0 schema pin；parent token projection | 提取共享 token 服务，不复制到写端或模型 |
| B `upstream-http-session.ts:17-24` | 直连固定 `127.0.0.1:18060/mcp` | 新写协议必须受保护，不能只隐藏工具名 |
| B `xiaohongshu-tokens.ts:4-26` | activation 内 handle→ID/token | 扩展 project/account/epoch/session 作用域；只存父进程内存 |
| B `artifacts.ts:18-44,85-135,144-179` | O_NOFOLLOW、inode/hash 校验；单文件25MiB；activation内 map；无 video MIME | 增加持久冻结媒体 store 与流式视频路径 |
| B `broker.ts:165-175,245+` | unconditionalDenial 在 handler 前；通用 receipt 与 requestId 去重 | 仅健康新服务才能替换六写的拒绝；通用 receipt 是结果缓存，不是 founder 授权 |
| A `bridge/approval-signal/canonical-founder-id.ts:22-32` | canonical founder 配置缺失/分歧返回 null | 复用动态解析，不接受模型指定身份 |
| A `bridge/auto-narrow-control-route.ts:256-338` | 用 bot credential 重取原消息，校验作者、编辑、时间与精确指令 | 可复用确定性验原文模式 |
| A `bridge/discord-utils.ts:75-179` | 现 decoder 未包含 guild/reply/webhook/type | 新 decoder 必须补齐，不能声称现 helper 已覆盖 |
| A `bridge/founder-reply-deliverer.ts:37-65,200-240` | 原文消息、reply type 19、排除 forward；已有 ship 专用入口 | 新 XHS consumer 独立路由，禁止进入 ship classifier |
| A `bridge/approval-signal/founder-reaction-approval-handler.ts:92-205` | 绑定 PR head 与 ship 状态 | 不复用批准结果或 ship schema |
| A `bridge/founder-consent/evaluator.ts:367-398` | bypass labels 与 LLM 判别 | 不能做 XHS 确定性授权 |
| A `StateStore.ts:4147-4160` | better-sqlite3 / WAL / synchronous=NORMAL | 新 receipt writer 用 FULL，同步落盘成功后才发送 |
| A `StateStore.ts:4819-4836` | `.transaction(...).immediate()` + 条件更新 + 回执 | 原子消费的既有模式；所有入参 prepared params |
| A `scripts/claude-lead.sh:2418-2465,2547-2549,2591-2592` | 继承 user MCP、插件可独立加载、bypassPermissions | 名称 blacklist 不构成写边界，须硬隔离与入口迁移 |
| A `scripts/lib/mcp-inherit.sh:158-188` | 按 server name 排除 | 别名/插件/终端仍需覆盖 |
| C `service.go:130-151` | login 返回 configs.Username；没有真实 user ID | “已登录”与用户名不能证明批准账号 |
| C `service.go:645-697`、`xiaohongshu/user_profile.go:108+` | 每操作新 browser；sidebar有自有主页流程 | 复用已登录同一 page 提取自己的稳定 ID，并在同一会话内执行 |
| C `routes.go:24-53`、`app_server.go:38-48` | 无认证 `/mcp` 和 REST publish/comment，HTTP ListenAndServe | 对所有写入口封闭，私有新协议不可留兼容免门路径 |

上表 A/B 的 `lead-capabilities` 路径前缀均为 `packages/teamlead/src/`；A `bridge`/`StateStore` 同前缀；A `scripts/claude-lead.sh` 等前缀为 `packages/teamlead/`。路径定位按对应 SHA 使用 `git show SHA:path`，不可把 B 文件说成当前分支已实现。

## schema 证据及外部核查

2519 保存的 `upstream-xiaohongshu-mcp-schema.json` 观测于 `2026-09-14T11:12:14.425Z`：16 tools、server version 2.0.0、工具指纹 `6136bc3de6c1ffa20fb3951e19ebc426d3d5a7e51b6a95bdd89ae1f0f08b605f`。该输入 schema 不证明响应真实账号，也不证明当前生产二进制匹配。它显示 products 是“搜索并选首个匹配”，reply 可缺 comment ID，二者不能按普通文本直接承诺确定目标。

- [Discord Message API](https://docs.discord.com/developers/resources/message#get-channel-message)：可按消息 ID 重取消息；采用精确 reply reference + 当前真实作者，API 错误无授权。需要阅读权限，不把转述、webhook payload 或客户端 actorId 当原始证据。
- [Discord interaction 文档](https://docs.discord.com/developers/interactions/receiving-and-responding)：按钮需独立 interaction 验证；本设计选择现有消息通道的精确回复，减少新入站协议。没有声称按钮已实现。
- [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)：WAL + FULL 增加每次提交同步；新 writer 验证实际 pragma。macOS 开启并验证 fullfsync；底层存储谎报落盘、恢复旧备份不能仅靠 SQLite 保证，必须恢复后关闭能力并轮换 generation。
- [上游 service.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/service.go)：2026-09-14 在线主线已含可选 user_id，但这不是本地 C 的实现，也不保证与后续写共用同一会话。禁止据此把账号约束标为已具备。

## 建议与交接

选择 Bridge 专用 XHS 请求/决定/尝试账本 + fork 的私有、带账号租约的执行协议。批准只能由精确原文消息写入；消费后的不透明内部许可只在可信父进程与受控 provider 间使用，并在 provider 再落一次性墓碑。两层分别防重入与网络重复交付，不共享 ship 权限。

研究未取得生产能力：无实际 founder 批准、无 live provider 写、无浏览器 QA。实施阶段必须先证明两个 runtime 都不可读取凭证/直连原服务/复用已登录浏览器，再允许测试账号写。读类迁到结果投影服务后全部保留；登录二维码是账号变化路径，受账号独占锁和 epoch 变更约束；delete_cookies 继续拒绝。

有用测试模式：`__tests__/StateStore.fly663-migration.test.ts:154-206` 回滚与 reopen；`__tests__/auto-narrow-control-route.test.ts:235-423` 错作者/编辑/时间；`bridge/__tests__/reaction-approval-source.test.ts:31-88` 错 binding/403/429；`scripts/__tests__/mcp-inherit.test.sh:60-80,114-121` 原始 XHS 继承 fixture 需更新。

## 研究边界

不重新设计 2519 其他能力；不改变保留 ref 或 stash；不采用 native memory/Linear HTML 文本当权限证据。html-report-style 独立文件未找到，沿用本仓 FLY-2453 的 Apple-light 系统字体与浅底卡片；图遵循本任务的 Mermaid→本地 mmdc，而非 diagram-design 的手工重绘偏好。工程实现与两仓部署均等待 founder 排期。

## R1后补充核查

本地fork `main.go:17`已有headless开关且默认true；R2选择专用UID下的headless provider，保留Lead可见TUI，不再假设非GUI账号能使用founder Aqua。Apple官方[launchd说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)与本机`launchd.plist(5)`的UserName/GroupName条目支持system launchd降权方案；这是机制依据，仍需计划§2.2.1的真实系统启动探针。

[Discord API文件上传限制](https://docs.discord.com/developers/reference#uploading-files)与当前bot/guild实际限制必须一同验证；R2保守取min(10MiB,实际已验证上限)，大视频在prepare立即拒绝，不生成无法完整审阅的卡。原研究的Bridge账本建议被R1纠正：最终采用专用UID的独立write-ledger.db，StateStore只保存非授权投影。

R2发现不同UID仍不能阻止模型连接Chromium的loopback调试端口，因此T5明确改匿名CDP pipe。rod v0.116.2现有`cdp.WebSocketable.Send/Read`、`cdp.New().Start`及`rod.Browser.Client`可承载自定义传输；需要新增NUL帧pipe适配及browser生命周期测试，不假称当前headless_browser已支持。
