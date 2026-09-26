# FLY-2711 语音载体对齐 — 调研
Issue: FLY-2711 (https://linear.app/geoforge3d/issue/FLY-2711/语音载体-语音只能在-raya-上起claude-载体-lead-与-529-slot-的-codex-载体都起不来合并-fly-2712)
日期: 2026-09-24
基于: exploration.md

## R1. 合同两端逐字对照（主仓客户端 ↔ fork PR #28 服务端）

| 项 | 主仓（`voice-self-filter-contract.ts` / `voice-self-filter-probe.ts`） | fork PR #28（`voice-self-filter-socket.ts` @ `07fffea1`） | 一致? |
|---|---|---|---|
| 分帧 | claude：`socket.write(json+"\n")`，不半关；等对端 `end` | 读到 `\n` 即应答，`peer.end(reply)`；也接受 EOF | 一致 |
| 请求字段 | `{version:1,method:"probeVoiceSelfFilter",leadId,expectedBotUserId,nonce,auth}`（claude 不加 `contractVersion`） | 同 6 键白名单，`version===1` | 一致 |
| 请求 MAC | HMAC-SHA256(token, `JSON.stringify([1,"voice-self-filter-v1",leadId,expectedBotUserId,nonce])`) | 同式，`timingSafeEqual` | 一致 |
| 响应 MAC | `[version,leadId,botUserId,runtimeId,nonce,ready,selfDropped,unknownDropped,otherPassed]` | 同序 | 一致 |
| runtimeId | 校验 UUID v4 | `randomUUID()`（v4） | 一致 |
| 限长 / 时限 | 4096 B / 2 s | 4096 B / 2 s | 一致 |
| socket 路径 | `discordStateDir ?? ~/.claude/channels/discord-<agentId>` + `voice-self-filter.sock` | `join(STATE_DIR,'voice-self-filter.sock')`，`STATE_DIR = DISCORD_STATE_DIR ?? …` | 一致（launcher 同式导出，`claude-lead.sh:275`） |
| 就绪前提 | — | 仅 `RECORDER_MODE.kind==='enabled'` 才创建 socket；`observe()` 的 ready 还与 enabled 相与 | 符合 FLY-2598 合同 |

结论：线协议无需改动；缺陷只在 fork 的入站判定与 socket 生命周期。现在两端只靠人工对照保持一致，没有跨仓 drift 守卫 → 计划加一组「黄金向量」（固定输入 → 固定 MAC hex），两仓测试各自断言同一字面值。

## R2. discord.js 14.25.1 resume 时的事件顺序（丢消息的证据链）

- fork `external_plugins/discord/package.json` 精确钉 `"discord.js": "14.25.1"`，`@discordjs/ws` 1.2.3。
- `WebSocketManager.js:375-401 triggerClientReady()` 是 manager 级 `status = Ready` 的唯一写点；shard 断开 `Closed` 处理（`:246-268`）只写 `shard.status = Connecting` 并 emit `shardReconnecting`；`Resumed`（`:280-287`）只写 shard 级 status。
- `handlePacket`（`:336-350`）仅在 **manager** 非 Ready 时排队 → 启动后单 shard 重连期间到达的 dispatch 直接处理。
- `handlers/RESUMED.js`：`replayed = shard.sessionInfo.sequence - shard.closeSequence` 后才 emit `shardResume` —— 计数只能在被重放的事件都已到达之后得出，与 Discord 协议「先按序重放错过的事件，最后发 RESUMED」一致。
- 所以序列是：`shardReconnecting` → （重放）`messageCreate`×N → `shardResume`。PR #28 在第一步把 `ready=false`，第二步全部丢弃。现有 fork 测试 `rejects unknown/disconnected identity…` 甚至把「断线期间 founder 消息被丢」写成了期望行为。
- 同一问题对 `invalidated` / 重新 IDENTIFY 不适用：重新 IDENTIFY 时 Discord 不重放，丢失是既有行为（本单不改）。

## R3. Codex 侧的对应做法（对齐目标）

- `CodexDiscordGateway.ts:301` 入站：`selfAuthorAllowed(this.botUserId, true, msg.authorId)` —— bot ID 在 `start()` 里经 `assertAuthenticatedBotUser` 认证后固定，入站判定不看连接态。
- `CodexDiscordGateway.ts:208-214` 探针：`observeVoiceSelfFilter(this.botUserId, this.started, selfAuthorAllowed)` —— 只有探针才用「当前在跑」作为 ready。
- 这正是 Claude 插件应当采用的形状：入站 = `guard(固定ID, 身份有效, author)`；探针 = `guard(固定ID, 连接中 && 身份有效 && recorder enabled, …)`。当探针 ready=true 时它调用的就是入站同一个 guard、同一组参数 → 仍满足 FLY-2598「探测与实际 handler 使用同一函数」的要求。

## R4. 残留 socket 的回收语义（macOS / Bun）

- Unix socket 文件在监听进程死后仍留在文件系统；对它 `connect()` 得到 `ECONNREFUSED`（不是 `ENOENT`）。活着的监听者则连接成功。这是区分「可证明陈旧」与「有活主人」的标准做法，也是 FLY-2598 合同原话「遇已有可连接 owner 不抢占，遇 symlink/无法证明 stale 不删除」的可执行版本。
- PR #28 的双名绑定（私有 `.v<12hex>` + 硬链接到公共名）意味着崩溃后会同时残留两个指向同一 inode 的名字；回收时两者都应清理，但只清理「文件名严格匹配、是 socket、属主是本进程 uid、connect 得 ECONNREFUSED」的项。
- 竞态：两个同 Lead 的插件进程同时回收时，可能一个删掉另一个刚链上的公共名。同 Lead 双 adapter 本身已是异常（FLY-183 ppid 看门狗会让旧的退出）；结果仍是「恰有一个公共名主人」，且 `close()` 只按 inode 删自己的名字，不会误删别人的。计划用「失败后退避重试」收敛，不引入锁。
- 路径长度：macOS `sun_path` 上限 104 字节。生产最长形如 `/Users/xiaorongli/.claude/channels/discord-flywheel-eng-lead/voice-self-filter.sock`（≈80 B）；slot `/tmp/flywheel-test-slot-N/discord-state/voice-self-filter.sock`（≈62 B）；私有名更短。无需改路径。

> **v2 修订（Codex R1 #2）**：上面的 ECONNREFUSED + inode 复核方案仍有「最后复核与 unlink 之间」的跨进程竞态，plan v2 已改为 darwin 内核文件锁（`O_EXLOCK`，Bun 1.3.11 实测第二者 `EAGAIN`、close/SIGKILL 后自动释放）决定唯一主人，本节「计划用失败后退避重试收敛，不引入锁」一句作废。

## R5. 插件发布与上线机制（不由本单执行）

- 生产检测：`scripts/discord-plugin/check-discord-plugin.sh` 以 `installed_plugins.json` 的 `gitCommitSha` 对比 `git ls-remote` fork `main` → `OUTDATED`。
- 安装：`update-discord-plugin.sh` 走 `claude plugin update`，**版本号不更新就不装**（FLY-1676 R-2、FLY-1730 §D3）→ 必须 `0.0.7 → 0.0.8`。
- 受管上线 = `restart-services.sh` 的 `check_discord_plugin_fork`（在 `restart.lock.d` 内检测→更新→复检→Lead 重启波次）。runner 不跑、不重启任何 Lead（Lead 裁定）。
- 回滚：revert 除 `plugin.json` 外的全部改动，`plugin.json` 再 bump（0.0.9）。FLY-2598 规则：回滚插件前先结束该 Lead 的语音会话；回滚后该 Claude Lead 语音回到 503（fail closed），文字入站回到 0.0.7 行为。
- fork CI：`.github/workflows/validate-discord-runtime.yml` 在 `external_plugins/discord/**` 变更时跑 `bun install --frozen-lockfile && bun test`（ubuntu）。macOS 专属行为（ECONNREFUSED 语义与 Linux 相同；Bun Linux close 时 unlink 行为已由 PR 的私有名方案覆盖）两平台都要能测。

## R6. slot 真机验证的既有工装

- 钉插件字节：FLY-1439 配方 —— `TEST_LEAD_CLAUDE_CONFIG_DIR=$SLOT_DIR/claude-config` + `TEST_SKIP_PLUGIN_FORK_CHECK=1`（`test-deploy.sh:1036-1041` 自动补 expected 哨兵），在隔离配置里把 marketplace/cache 目录替换为 fork 指定 commit 的 `external_plugins/discord` 并 `bun install`；G0.1 三件合一证明运行字节 = 被测 commit；G0.4 前后快照证明生产 `~/.claude/plugins/` 零变化。
- 语音房：`scripts/qa/fly2655-voice-room.mjs` + `scripts/lib/fly2655-voice-fixture.mjs`，要求 `voiceModes.rg/meeting=true` 且 `codexVoiceActions !== true`，与载体无关；attempt 3 在 claude-code slot 2 上已跑到 `start`。
- 只读预检：`scripts/qa/fly2598-voice-preflight.mjs --project <p> --lead <l> --out <json>` 调同一 `preflightVoiceSession`，只做 Discord GET + 已认证只读探针 —— 可用于上线后的生产只读核验。
- 触发一次真实 resume：对插件 bun 进程 `SIGSTOP` 约 45–60 s（停心跳，Discord 关连接但会话仍可 resume），期间由 founder（或 QA 以 founder 身份经 claude-in-chrome）在 Lead 频道发一条消息，`SIGCONT` 后 discord.js 以 resume 重连并重放。证据：`discord-state/gateway-health.log` 的 resume 记录、`shardResume` replayed>0（若计划中的 stderr 行可见）、该 messageId 在 slot comm.db mailbox 恰好一行。若 Discord 选择了重新 IDENTIFY（无重放），该轮判为「未触发 resume，重做」而不是通过。
- slot 房间事实（FLY-1948 记忆）：开 Lead 约 90 s 到 room-info；拆房前先把 gateway-health.log、launchd json、pane capture、startup log 复制出来；slot 模式不能用其他 bot 代替 founder 发消息（allowBots=[self]、其他 slot bot 403）。

## R7. 不需要改的主仓生产代码

- Bridge 探针客户端、preflight、services 周期复验、StateStore 错误枚举均已为 Claude 载体就绪；Codex 路径由 `effectiveLeadBackend(...).backend === "codex-app-server"` 分派，不受 fork 变更影响。
- 因此主仓 PR 只加测试（黄金向量、Claude 分帧正向用例）与运维文档；「生产 Codex 路径行为不变」由「`packages/*/src` 非测试文件零 diff」+ 既有语音测试全绿直接证明。
