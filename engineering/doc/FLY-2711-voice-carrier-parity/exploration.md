# FLY-2711 语音载体对齐 — 探索
Issue: FLY-2711 (https://linear.app/geoforge3d/issue/FLY-2711/语音载体-语音只能在-raya-上起claude-载体-lead-与-529-slot-的-codex-载体都起不来合并-fly-2712)
日期: 2026-09-24
基于: 无

## 1. 问题一句话

除了 Raya（生产 Codex 载体），语音在别的载体上都起不来：Claude 载体 Lead 在 `start` 被 Bridge 以 503 `voice_unavailable reason=self_filter_unverified` 拒绝；529 slot 里的 Codex full-access Lead 曾因 `/tmp` ↔ `/private/tmp` 路径别名触发 `ConfigGateError`（原 FLY-2712，已并入本单）。

## 2. 审计结论（main = 637752fcc，2026-09-24）

### 2.1 FLY-2712 半边：已经在 main 上修好

- `packages/teamlead/src/lead-backends/codex/lead-actions/mcp-config.ts:104-121` 的 `assertFullAccessSandboxConfig` 已接受 darwin 上 `/tmp/X` 与 `/private/tmp/X` 两种拼写（只接受这一个固定前缀，不接受任意 symlink）。
- 来源：FLY-2655 PR #1243（`58693d28c`，2026-09-22 合入）。其 plan §「实现期范围登记（Lead 2026-09-18 授权）」明确把这处收紧写入范围；测试 `mcp-config.test.ts:216` 「accepts /tmp and /private/tmp spellings of the same QA slot workspace」用真实 `mkdtemp("/tmp/flywheel-test-slot-")` 目录。
- 同一 PR 的 milestone 记录 QA attempt 6 在 Codex/full-access slot 上 DAVE 收音链通、founder 三段音频进入 voice 进程——即 Codex slot Lead 已能起、能进房。
- 结论：这一半**不再写新代码**，只在 QA 判据里保留一行回归（Codex slot `start` 到 live 行为不变）。

### 2.2 Claude 半边：实现早就写好了，只是从没合入、从没上线

- 主仓的探针客户端早已为 Claude 载体准备好：`bridge/voice-self-filter-probe.ts` 对 `backend === "claude"` 使用换行分帧（写一行 JSON、不半关连接），socket 路径 = `lead.discordStateDir ?? ~/.claude/channels/discord-<agentId>` + `/voice-self-filter.sock`，HMAC 密钥 = 该 Lead 的 bot token。
- 服务端在 Claude 插件 fork `xrliAnnie/claude-plugins-official` 的 **PR #28**（`flywheel-FLY-2598-self-filter`，head `07fffea1`，2026-09-16 创建，CI `test` 绿，`MERGEABLE/CLEAN`，0 review）。它新增 `self-author-filter.ts`、`voice-self-filter-socket.ts` 并改 `server.ts`，完全按 FLY-2598 `self-filter-contract.md` 的合同实现。
- PR #28 **从未合入**：fork `main` 仍是 `e122f46`（FLY-2443），本机 `installed_plugins.json` 的 `discord@flywheel-plugins` 也是 `0.0.7 @ e122f46`。所以生产和 slot 上的 Claude Lead 都没有这个 socket → 探针 `self_filter_unreachable` → 统一折叠成 `self_filter_unverified` → 503。
- 这是本单的真正根因：不是「插件侧从未交付」，而是「交付物卡在 fork PR 里无人推进」。

### 2.3 PR #28 不能原样合入的三个缺陷

1. **会让所有 Claude Lead 在网关断线恢复时丢 founder 消息（最严重）。**
   - PR 的 `attachSelfAuthorFilter` 在 `shardReconnecting/shardDisconnect/invalidated` 把 `ready=false`，只在 `ready/clientReady/shardResume/shardReady` 置回 true；而 `messageCreate` 的入站判定用的就是这个连接态 `ready`，`false` 时一律丢弃。
   - discord.js 14.25.1（fork `package.json` 精确钉住）的 `WebSocketManager` 只在启动时把 manager 级 `status` 置为 Ready（`WebSocketManager.js:376`），单个 shard 重连只改 shard 级 status；`handlePacket` 只在 manager 非 Ready 时排队。Discord 协议规定 RESUME 成功后先**按序重放**断线期间错过的事件，最后才发 `RESUMED`。因此重放的 `MESSAGE_CREATE` 会在 `shardResume` 之前被派发 → PR #28 把它们全部丢掉。
   - 后果：每一次正常的网关 resume，断线窗口里 founder 发给任一 Claude Lead 的消息都被静默吞掉。这比语音起不来严重得多。
   - Codex 侧没有这个问题：`CodexDiscordGateway.passesFilters`（`CodexDiscordGateway.ts:301`）真正入站时用 `selfAuthorAllowed(this.botUserId, true, msg.authorId)`——bot ID 是认证后的固定值，入站不看连接态；只有探针 `probeVoiceSelfFilter()` 才用 `this.started` 表达「当前连着」。
2. **残留 socket 让语音永久不可用。** `VoiceSelfFilterSocket.listen()` 发现公共路径已存在就抛 `voice_self_filter_path_exists`，`server.ts` 只打一行 stderr，之后**再不重试**。插件被 SIGKILL / 机器掉电 / Claude Code 崩溃时，公共路径与私有 `.v<hex>` 硬链接都会残留；下一个插件进程永远绑不上 → 该 Lead 语音一直 503，直到有人手工 `rm`。重启竞态（旧 adapter 尚未退出）也会让新进程一次失败后永不重试。
3. **没有 bump `plugin.json`。** fork `main` 已是 `0.0.7`，PR #28 未改版本；受管更新器 `claude plugin update` 遇到「版本不更新」会回报 already at latest（见 FLY-1676 / FLY-1730 §D3）→ 合入后生产也装不上。

### 2.4 其他已核事实

- 插件的 socket 只在 `RECORDER_MODE.kind === 'enabled'` 时创建（三件 env `FLYWHEEL_COMM_CLI/COMM_DB/LEAD_ID` 齐全）。slot 与生产 Claude Lead 都由 `claude-lead.sh` 注入这三件（`:697`、`:1550`，`FLYWHEEL_COMM_DB` 来自 test-deploy/launcher env）。
- `claude-lead.sh:275` 的 `DISCORD_STATE_DIR` 默认值与 Bridge 探针的默认路径同式；slot 主 Lead 的 registry `discordStateDir` = `${SLOT_DIR}/discord-state`，与 test-deploy 写 `.env/access.json` 的目录一致。
- 密钥对称：Bridge 用 `env[lead.botTokenEnv].trim()`；插件用它登录 Discord 的同一个 `TOKEN`（`STATE_DIR/.env` 的 `DISCORD_BOT_TOKEN`）。token 不一致只会让 MAC 不过 → 继续 fail closed，不会误放行。
- slot 上验证「未上线的插件字节」已有成熟配方：FLY-1439 的 `TEST_LEAD_CLAUDE_CONFIG_DIR` + `TEST_SKIP_PLUGIN_FORK_CHECK` 隔离 Claude 配置、钉住 fork 某 commit，全程不写 `~/.claude/plugins/`（`test-deploy.sh:1030-1041`，`FLY-1439-receipt-producer-acceptance/plan.md` E3/E4/G0.1/G0.4）。
- FLY-2655 的 529 语音房 QA 工装 `scripts/qa/fly2655-voice-room.mjs` 对载体无假设（要求 `codexVoiceActions !== true`，即由 QA 从运维 API 起会话），attempt 3 正是在 claude-code slot 2 上跑到 `start` 被 503 的。
- `~/.flywheel/test-slots.json` 当前 slot 2 = `codex-app-server/full-access`（QA 临时切换后未还原；Lead 已接手核对），slot 3/4 = claude-code。开 claude-code 槽做 QA 需先问 Lead（cmux 维护标记在位）。

## 3. 两条路怎么选

Issue 给了二选一：(A) Claude 插件补 self-filter socket 服务端；(B) preflight 对 Claude 载体给「明确、可配置的替代验证路径」。

- **选 A**。它就是 FLY-2598 已批准的合同，服务端代码已写好 90%，主仓客户端已就绪；缺的是修三处缺陷 + 合入 + 上线。
- **拒 B**：替代验证只能是「不问运行进程、改看源码版本/安装指针/配置开关」，FLY-2598 合同明确禁止（「源码版本、安装指针、mtime、单独 capability 字符串均不能替代此结果」）。它会让「回环防护是否真的在跑」重新变成猜测；并且可配置开关意味着一个能把门打开的旋钮——违背 fail closed。

## 4. 待定问题（已由 Lead 裁定）

Lead 2026-09-24 回复（ask `3c33dd1c`）：按上述计划做；硬要求 (a) 任何 Claude Lead 不得因本改动丢 founder 消息，resume 重放场景要先红后绿用例，QA 在 slot 上实测一次断线重连不丢；(b) 残留 sock 自动回收并有用例；(c) 插件 0.0.8 bump。生产上线走 updater / 班车，不自己重启任何 Lead；开 claude-code 槽前 ask Lead；test-slots.json 由 Lead 核。
