# Design Review — plan.md (Round 1)
Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向可行，但当前计划还不能进入实现：F1 的首次身份判定可能让一次启动期探针永久关闭文字入站；F2 的 inode 复核仍能删除其他进程正在监听的 socket；QA 的 slot 预检入口和 resume 判据也不足以完成所承诺的验收。以下 1–4 项为必须修正的问题，5–6 项为文档一致性建议。

评审基线：主仓 HEAD `7687c925b8a04b944e8512a183796b68497956b8`，计划 blob `d990f1d6f6a01806bd402f16acf4f8727721247d`；工作树计划与 HEAD 字节一致。核对了完整 exploration/research/plan、FLY-2598 两份合同、FLY-2655 milestone、主仓调用链、fork `main e122f46b44aef48e90539fa249e5e59e0403545e..pr28 07fffea10f5ddf723a7e7c45e473dbebe0004af0` 的全部差异，以及安装目录中的 discord.js 14.25.1 源码。生产插件登记仍为 `0.0.7 @ e122f46`。

本文证据为 `[verified by reading code]`，反例是依照计划算法与现有源码推导的交错，未声称执行了尚未实现的修复。只运行了只读源码/Git/哈希核验；没有运行测试、故障注入、部署或生产探针。唯一写入为本反馈文件。

引用约定：下文 `plan.md` 指 FLY-2711 计划；`fork:` 指上述 PR #28 commit 中 `external_plugins/discord/`；`installed:` 指 `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/`，其依赖路径均为实际安装字节。

## What's Good (Keep)

- **根因和范围判断正确。** 主仓 Claude client 已实现换行分帧、不半关闭，路径按 Lead 的 `discordStateDir` 解析；请求/响应 MAC 顺序、nonce、UUID、4 KiB 和 2 秒边界与 fork 一致。采用现有运行中探针，而不增加绕过 preflight 的配置，是合适的最小修复。
- **入站与探针分离本身满足“同一函数”。** `allowsIntake` 和 `observe` 调用同一个注入 guard；当 probe ready=true 时，`identityValid()` 必然为 true，因此两者的真实作者判定参数相同。unknown/not-ready 是同一 guard 的负向测试向量。保留接线级 mutation 测试即可，不需要强制文字入站也读取连接状态。主仓参照为 `voice-self-filter-contract.ts:30–53`、`CodexDiscordGateway.ts:208–213,298–303`。
- **PR #28 的 resume 丢消息诊断成立。** installed `node_modules/discord.js/src/client/websocket/WebSocketManager.js:246–287,336–353,375–403` 在重连时改变 shard 状态，manager 仍 Ready；重放消息可直接进入 handler。`handlers/RESUMED.js:5–13` 最后才发 `shardResume`。这也符合 Discord 对“按序补发事件、最后 RESUMED”的规定。[Discord Gateway — Resuming](https://docs.discord.com/developers/events/gateway#resuming)
- **FLY-2712 已修的结论正确。** 本地 `origin/main=637752fccec52779728dedab9ad1423d63ea55c4` 包含 `58693d28c`（PR #1243）；该 main 的 `mcp-config.ts:104–121` 已仅接受 darwin 的 `/tmp/` 与 `/private/tmp/` 固定别名，测试 `lead-actions/__tests__/mcp-config.test.ts:216–250` 覆盖真实 slot 目录及拒绝任意 symlink。FLY-2655 milestone:51,55 另有 attempt 6 收音和路径验证记录。无需再次实现此修复；这些历史记录不等于本轮重新执行 QA。
- **发布与隔离基础可复用。** 0.0.8 bump、fork merge 前完成 QA、不改生产缓存、主仓生产代码零 diff 均应保留。`test-deploy.sh:1032–1040` 确实支持隔离 Claude config 并自动补 expected-path 哨兵。Q5 的 mailbox 字段正确（`discord-chat-ingest.ts:189–201`）。Q7 对 Claude child 发 TERM 后由 launchd 重生的方向也成立（`claude-lead.sh:2669–2683,3777–3812`；`scripts/lib/qa-launchd-lead.sh:224–230`）。

## Issues & Recommendations

1. **HIGH — F1 会把“尚未固定身份”误判为“身份变化”，使启动期只读探针永久关闭文字入站。**

   **位置/证据：** `plan.md:47,55–58`。`noteCurrent` 的条件只有“id 存在且不等于 botId”；`observe` 先调用它，`pin` 又在 invalid 时永久忽略。相比之下，fork `self-author-filter.ts:28` 明确要求 `id && this.botId && id !== this.botId`。

   **为什么重要：** 真实初始化存在 `client.user.id=A`、filter 尚未 pin 的窗口：installed `node_modules/discord.js/src/client/websocket/handlers/READY.js:7–12,26` 先设置 user，再检查 shard readiness；`WebSocketShard.js:165–209` 等待 guild 到齐或默认 15 秒超时，随后 `WebSocketManager.js:189–198` 才发 `shardReady`。fork `server.ts:1837–1844` 在 login 前已经开放 socket，F2 也保留这种可提前探测的生命周期。此时一个合法 probe 会把 `A !== undefined` 判成身份变化；后续 ready(A) 无法解除 invalid，所有 founder 文字持续被丢弃。计划“同 token 不会变 ID，因此按构造不可达”的说明不能排除此路径。

   **建议修正：** 明确 `noteCurrent` 只有在 **botId 已固定、当前 id 存在且不同** 时才进入永久 invalid；首次 pin 前的探针仅返回未就绪。增加 `client.user=A → probe（尚未 ready）→ ready(A) → founder/self` 用例，断言 probe 不触发 onInvalid，随后 founder 正常进入、自身仍被过滤。保留 pin 后真实 ID 改变的永久拒绝测试。

2. **HIGH — F2 的 lstat→unlink 仍有竞争窗口，违反“有活主人绝不抢占”。**

   **位置/证据：** `plan.md:74–81,87,148–149`；fork `voice-self-filter-socket.ts:38,41–55`。最后一次 inode 检查与按路径删除不是一个原子操作；同步 JavaScript 调用也不能排除另一进程在两次系统调用之间运行。

   **为什么重要：** 合法交错为：A、B 都探测陈旧 inode S；A 最后一次 lstat 看见 S 后暂停；B 删除 S、启动私有 socket N 并把 N 链接到公共名；A 恢复执行 unlink(public)，删除 B 的活 socket 公共入口。旧实例 close 也有同型交错：A 关闭监听后检查公共 S；B 回收 S 并发布 N；A 的 close 再 unlink 掉 N。独占 link 只保护发布当下，不能防随后删除。计划:149 明确接受“双 adapter 互删公共名”，与 I5 相冲突。30 秒自愈不能补偿这一安全要求，期间 Bridge 的周期复验会调用 `failVoiceSessionAdmission`（`voice-session-runtime.ts:53–78`），可终止活动语音会话。

   **建议修正：** 为同一 Lead 的回收、发布、关闭删除提供共同的跨进程互斥/所有权保障，并说明崩溃后的释放与恢复方式；不能用再加一次 stat 或靠重试来证明安全。F2-T4 的交错点必须放在 **最终 inode 复核之后、unlink 之前**；另覆盖 close 与新 owner 发布的竞争，断言新 owner 的公共名仍存在且能应答。恢复轮询可保留，但只能作为可用性措施。

3. **HIGH — Q3/Q7 缺少能生成 slot 探针证据的实际入口；Q4 还缺 live 的执行前提。**

   **位置/证据：** `plan.md:125–131`。`scripts/qa/fly2598-voice-preflight.mjs:91–114` 的 CLI 只接受 `--project/--lead/--out`，固定读取 `homedir()/.flywheel/{projects.json,voice-host.json,.env}`；它不是“经 slot Bridge”的入口，也不消费 slot registry/env 覆盖。另一选项 `fly2655-voice-room.mjs:743–782` 的 prepare 只构建、校验拓扑/权限和 `--check-config`；`verifyRemote:687–727` 没有 self-filter 调用，返回的 `status:"READY"` 不含 `stage`、`selfFilter` 或 `runtimeId`。

   **为什么重要：** 两条命令都无法按原文产生 Q3 所需的 slot `selfFilter.runtimeId`，因此 Q7 的前后 incarnation 比较也没有依据。误用生产 helper 还会检查错误的 Lead。此外，工装 `waitForClaim:525–539` 在 claimed/warming 即可返回；`packages/voice-codex/src/daemon.ts:600–627` 必须检测到 founder 在房内才进入 live，否则以 no_human 结束。Q4 不能把工装 start 成功当 live。

   **建议修正：** 在计划中写定可直接执行的 slot-only 配方，例如导入已导出的 `runPreflight`，显式传入经校验的 slot projects、slot env、project/lead 与被测 SHA，保留真实 probe，不注入 mock；记录 `checks.stage` 和 `checks.selfFilter`，在 Q7 重启后重复同一配方。此方式可只增加文档，不必扩主仓生产代码。Q4 明确提前约 founder 进房，并有界轮询 exact session tuple 到 live；说话仍可选。不要用 prepare 的 READY 或 claimed/warming 替代准入及 live 证据。

4. **HIGH — Q6 即使使用仍有丢消息缺陷的 PR #28，也可能判 PASS。**

   **位置/证据：** `plan.md:130`；fork `self-author-filter.ts:25–30,49–61`；installed `gateway-health.ts:65–90`；主仓 `discord-chat-ingest.ts:201`。

   **为什么重要：** SIGSTOP 只暂停进程，不立即关闭旧 TCP 连接。founder 消息可能先进入旧连接的接收缓冲；SIGCONT 后先处理该消息，此时尚未触发 shardReconnecting，旧 guard 仍 ready=true。之后才断线并 resume。这样旧代码也能满足“看到 resume 日志、该 messageId 入库一次、Lead 看见短语”，却没有经过真正会丢消息的重放窗口。仅增加 replayed>0 仍不足，因为计数可能来自其他 dispatch；mailbox createdAt 又来自消息 envelope.ts，不能证明 handler 执行顺序。

   **建议修正：** 将 PASS 绑定到同一 adapter incarnation 中可取证的 **shardReconnecting → messageCreate(目标 messageId) → shardResume**，再检查该 ID 恰好一次入库并被 Lead 接收。计划须说明如何取得这个顺序：可使用只记录目标 ID、生命周期和序号的有界诊断，或等价的确定性断线/恢复屏障；不要记录正文或 token。没有证明目标消息经过此窗口时标 HARNESS INVALID/未完成，不能判 PASS。保留最多三次、仍未触发则报 Lead 的边界，以及先红后绿单测。

5. **MEDIUM — 建议同步标注 FLY-2598 的旧入站语义已被本计划修订。**

   **位置/证据：** FLY-2711 `plan.md:23–24,34–65,102–106` 与 `engineering/doc/FLY-2598-voice-host-activation/self-filter-contract.md:9,23,28`、同目录 `plan.md:75`。旧合同仍要求未 ready/重连时拒收，并称“重连期间 probe 失败与事件丢弃一致”；M3 当前只更新 host-runbook。

   **为什么重要：** F1 的改向是必要的，并未破坏同函数证明；但保留两个相反的规范会让后续评审或维护再次把“断线丢 founder”恢复成预期行为。

   **建议修正：** 在旧合同相关条款加明确的 FLY-2711 修订说明/链接，写清身份有效性决定入站、连接状态额外决定语音探针 ready；同步对应测试文字。I1 的允许丢弃集合也应注明其与“已检测身份漂移后永久拒绝”的关系。这是文档一致性建议，不要求重开批准的架构。

6. **LOW — 上线说明应列出 Lead 自然重生也会更新插件。**

   **位置/证据：** `plan.md:137–141`；`packages/teamlead/scripts/claude-lead.sh:1129–1139` 在每次 Lead birth 执行 checker→updater→recheck；`scripts/discord-plugin/check-discord-plugin.sh:121–123` 比较 fork main，`update-discord-plugin.sh:117–118` 直接调用 Claude CLI 更新。

   **为什么重要：** fork 合入后，不必等下一次 restart-services 窗口，任一 Lead 的自动重生就可能更新共享插件指针。计划已正确把 merge 本身当 ship，故这不是新的发布阻断，但不应让操作者误以为 merge 后仍有确定的等待窗口。

   **建议修正：** 将窗口协调和 fork-main 冻结明确放到 merge 之前，并在上线说明中列出两条现有触发路径。无需新增发布机制。

## Verdict

CHANGES REQUESTED

修正 1–4 后复审；5–6 可随文档同步处理。保留路线 A、同 guard 的入站/探针分离、0.0.8 bump、跨仓黄金向量、主仓生产代码零 diff，以及 fork merge 前完成隔离 QA 的顺序。FLY-2712 无需重做，Q7 的 launchd 恢复方式无需替换。
