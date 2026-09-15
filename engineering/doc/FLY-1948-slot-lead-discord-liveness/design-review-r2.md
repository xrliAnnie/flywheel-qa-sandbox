# Design Review — plan.md (Round 2)

Date: 2026-09-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质吸收 Round 1 的八项反馈。T1 已改成有诚实误差界的本地观察上界；T2/T3/T4 使用锚定 T0 的绝对 deadline；challenge/response、精确 `source_ref`、身份判据、0600 证据、生产日志不落 pane 原文、diagnostics 来源校验、独立 per-Lead 坐标、全 sensor 注入和 CI 显式登记等方向都正确。

但当前 v2 仍不能按文档直接实施并得到可信的全模式结论。主要阻塞是坐标 schema 没有提供 C4 已依赖的 `mode`，也没有提供 roundtable 的真实父频道；现有 `chatChannelId` 在 roundtable 房仍是 slot 私有频道。因此计划声称的 roundtable thread 路径不会被触发。另有四个需要在实现前封口的合同问题：Codex N/A 会在 C3→C4 间变成 vacuous success、`ps lstart` 还不足以支撑“不会接受上一代 ready”的强保证、canonical envelope parser 没有可供新 `.mjs` 使用的运行时导入合同、`--send-as` 没有验证 sender 属于目标 adapter 的 `allowBots`。此外，多条同代 adapter 仍会被取“第一个”而放行。

本轮核对的计划 blob 为 `83395bb3d92119b99e0eb36b69c1d58db1482edd`（计划提交 `576482acf5641ca5e3e76d9245a4a55c3477bad0`）。

## What's Good (Keep)

- 保留 `created_at` 只作 Discord 原始时间，并把 `ingestObservedAt` 明确定义为 `[0,poll]` 误差的观察上界；这关闭了 Round 1 的核心测量错误。
- challenge/response 要求 canonical bot author、exact ack nonce、正确 reply target，并把 `from_agent` 升为判据；精确 `source_ref='chat:<lead>:<messageId>'` 与 writer 一致（`packages/flywheel-comm/src/chat-delivery-envelope.ts:58-75`、`packages/flywheel-comm/src/discord-chat-ingest.ts:133-168`）。
- T0 author budget 与 SLA 分离，T2/T3/T4 都是 `T0 + timeout`，且补齐了 Lead batch ACK 才写 `delivered_at` 的合同和独立退出码（`packages/flywheel-comm/src/mailbox-queue.ts:1639-1699,1759-1794`）。
- `lead-coordinates.json` 脱离 generalized `room-info.json`，按 main/extra Lead 分开写；这保住了普通 multi-Lead smoke，也没有扩大 FLY-2211 reown 的特殊文件域。
- C5 只写 allowlisted 分类与 pane hash，raw pane 只进入 slot-local 0600 artifact；diagnostics 又只从 manifest parent 读 bounded、non-symlink liveness 文件，Round 1 的敏感信息与 provenance 风险已正确收窄。
- gateway lifecycle 采用“最新状态”而非“历史上曾 ready”，并明确 443 只是必要非充分证据；matcher 不再 source destructive reaper 库，所有观察都有注入 seam，测试表也逐名列出 reason。

## Issues & Recommendations

1. **坐标 schema 无法驱动 roundtable，且连 `--send-as` 的 `mode` 判据都没有数据源。** **Severity: HIGH**

   **Issue:** `lead-coordinates.json` 的规范字段只有 `chatChannelId`，没有 `mode` 或 `roundtableChannelId`（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:124-139`），但 C4 随后读取 `coords.mode`，并始终向 `chatChannelId` POST/轮询 T0（同文件 `:218-227`）。实际启动链只在 mirror 模式把 `CHAT_CHANNEL_ID` 改成共享频道（`scripts/test-deploy.sh:754-762`）；roundtable 使用独立的 `ROUNDTABLE_CHANNEL_ID`，仅作为 cross-dept channel 注入（`scripts/test-deploy.sh:1010-1052`），而 projects 的主 `chatChannel` 仍来自未改写的 `CHAT_CHANNEL_ID`（`scripts/test-deploy.sh:1473-1477`）。

   **Why it matters:** roundtable 探针会把 challenge 发进 slot 私有频道，envelope 不会得到 roundtable thread route；“roundtable thread 回复通过”的离线测试即使绿，也不代表真实房间走到了这条路径。`coords.mode` 未定义还会使 `--send-as` 的准入判断依赖实现者自行猜测或 ambient 状态。

   **Suggested fix:** 坐标 v1 明确增加 `mode` 和 canonical `roundtripChannelId`（slot=`chatChannelId`、mirror=`mirrorChannelId`、roundtable=`roundtableChannelId`），或分别保存 `primaryChatChannelId`/`roundtableChannelId` 并定义选择函数。writer 必须从 `test-deploy.sh` 已解析的值显式传入，不能从 ambient env 推断。六类坐标 fixture 除 shape 外，要断言每种 mode 的 exact probe target；真实 roundtable 测试应以 roundtable parent 的 T0 证明 envelope 最终给出 thread reply target。

2. **Codex 的 `not_applicable` 在 C3→C4 组合中被折叠成成功。** **Severity: MED**

   **Issue:** 底层 probe 对 Codex 定义 `rc=3, live:null, reason=not_applicable`（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:75-87`），但 C3 又规定 Codex “不影响退出码”，所以只选一条 Codex Lead 时可返回 0（同文件 `:180-189`）。C4 允许显式 `--agent`，并只把 liveness CLI 的非零当失败（同文件 `:218-220`）；因此 `--agent <codex>` 会把 N/A 当作 channel-live 前置条件通过，然后进入 Discord/CommDB 流程。

   **Why it matters:** 这违反计划已经接受的“Codex 明示 N/A，绝不伪装成 Claude adapter 绿灯”合同；最终会把不适用误报成 ingest/reply timeout，或者测到另一 carrier 路径却标成 Discord plugin roundtrip。

   **Suggested fix:** C4 在调用 C3 前强校验 `coords.carrier === 'claude-code'`，否则以独立 `not_applicable` 退出码和 evidence 结束。C3 的聚合输出也应区分 `applicableCount=0`，不要用裸 0 表示 vacuous “all live”。新增“显式选择 Codex Lead 不启动 REST/SQLite poll”的负例。

3. **`lstart` 仍不足以支持“默认探针绝不接受上一代 ready”的代际保证。** **Severity: MED**

   **Issue:** 计划默认 seam 是裸 `/bin/ps ... -o lstart=`，然后把它转换成 UTC ISO 并与毫秒级 gateway log 比较（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:61-69,84-100`）。现有 repo 的 canonical incarnation helper 特意使用 `TZ=UTC LC_ALL=C ps -o lstart=`（`scripts/lib/qa-launchd-lead.sh:970-979`）；裸 `lstart` 已有同一 PID 在不同时区被渲染成不同时刻的现场记录（`engineering/doc/FLY-1482-teardown-lease-deadlock/research.md:49-58`）。更重要的是，该格式只到秒，而 gateway 行带毫秒：上一代在同一秒末写出的 ready 可以满足新进程被截到整秒的 `readyAt >= effectiveSince`。计划的“kill 后不传 `--since` 也不会接受上一代 ready”及现有负例没有覆盖这个碰撞（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:260-270`）。

   **Why it matters:** 这是 fail-closed readiness 的核心代际栅栏。快速 KeepAlive 重启时，新 adapter 只要已有任意 443 连接，上一代同秒 ready 就可能补齐第三件证据，造成短窗口假绿。

   **Suggested fix:** 至少把默认 sensor 固定为 `TZ=UTC LC_ALL=C`，并为“同秒无法排序”定义 fail-closed 语义；不要把 second-resolution `lstart` 单独当毫秒日志的精确 cutoff。可复用 generation-bound `body-status.json.startedAt` 的毫秒记录作为额外下界，或把同秒 lifecycle 判为 generation-ambiguous 并要求新的 ready/resumed/显式高精度 `--since`。补一条“old ready 与 new lstart 同秒但 ready 实际更早”负例，而不只测跨秒旧日志。

4. **C4 没有定义 canonical `parseChatDeliveryEnvelope` 的可执行导入路径。** **Severity: MED**

   **Issue:** 计划要求新 `.mjs` 调用该函数（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:224-228`），但 `flywheel-comm` 的 package exports 没有 `chat-delivery-envelope` 子路径（`packages/flywheel-comm/package.json:8-58`），`discord-chat-ingest` 也没有 re-export 它。直接从 `src/chat-delivery-envelope.ts` 导入不是可靠路径：该源文件运行时导入 `./mailbox-queue.js`（`packages/flywheel-comm/src/chat-delivery-envelope.ts:1-5`），而 `src/` 下没有该 `.js`；本轮实际执行该 import 得到 `ERR_MODULE_NOT_FOUND`。依赖本地未跟踪的 `dist/chat-delivery-envelope.js` 也没有 fresh-build 保证：529 preflight 只 probe flywheel-comm 的 native dependency，随后构建 edge-worker/claude-runner/teamlead，没有构建 flywheel-comm（`scripts/test-deploy.sh:440-530`）。

   **Why it matters:** 离线测试可能通过自己的 fixture/parser，而真机 CLI 在 fresh checkout 直接启动失败，或读取 stale dist，正好破坏本计划强调的 envelope 路由正确性。

   **Suggested fix:** 明确一个 canonical runtime contract：优先在现有 `flywheel-comm/discord-chat-ingest` export 中 re-export parser，或新增受支持的 package subpath；C4 从该公开路径导入。把 `pnpm --filter flywheel-comm build` 加入 529 preflight/相关 CI 前置，并加“fresh dist 后真实 import + roundtable envelope parse”测试。若不愿扩大 package export，则在 C4 内实现一个严格、最小的 v1 envelope decoder，但不要声称调用了现有 parser。

5. **`--send-as` 只验“不是自己”，没有验证这个 bot 会被目标 adapter 接收。** **Severity: MED**

   **Issue:** C4 接受任意 `<TOKEN_ENV>`，只用 `/users/@me` 验证 `senderId != botUserId`（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:220-226`）。插件对 bot-authored message 还有独立 intake gate：sender 不在目标 state dir 的 `access.allowBots` 就在 ingest 前直接 return（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1597-1607`）。房间只把本 mode 的特定 peer bot IDs 加入 allowlist（`scripts/test-deploy.sh:1234-1258`）。

   **Why it matters:** 一个有效、能向频道 POST、但不属于本房参与者的 bot 会被探针看到为 T0，却永远不会生成 mailbox 行；当前设计把确定的 sender 配置错误误报成 `ingest timeout`，自动探针也没有真正做到“只用另一 slot bot 写”。

   **Suggested fix:** POST 前将 `senderId` 绑定到 slots 配置中的 exact `botAppId`，并验证它属于当前 mirror/roundtable participant set；也可额外只读核对目标 `discordStateDir/access.json` 的 `allowBots` 和 channel group。失败应使用专门的 `send_as_not_allowlisted`/坐标错误退出码，不消耗 ingest SLA。增加“可 POST 但未被目标 allowBots 接纳”的负例。

6. **同一 Claude 下多条当前 adapter 会被选“第一个”并可能通过，违背 fail-closed 污染判定。** **Severity: MED**

   **Issue:** C1 会收集全部匹配 adapter，但只要它们的 ppid 都等于当前 Claude，就取第一条为 `adapterPid`，其余只写 evidence（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:89-100,104-115`）。重复 adapter 持有同一个 token/gateway 正是现有 reaper 文档认定会产生连接竞争和入站丢失的故障面（`packages/teamlead/scripts/lib/reap-orphan-adapters.sh:4-10`）；“不是 orphan”并不能证明多实例安全。

   **Why it matters:** 一条健康、另一条异常或重复消费的 sibling adapter 可以让门变绿，随后出现重复事件、session 竞争或速率限制；这与 Claude 多进程已定义为 `claude_process_ambiguous` 的污染策略不一致。

   **Suggested fix:** 要求 `S` 中恰好一条 adapter 且其 ppid 为当前 Claude；多于一条返回新的 `adapter_process_ambiguous`（相应更新 reason 合同/diagnostics 正则与测试）。至少加入“两条同代 adapter，其中一条有 socket/ready”的负例，证明不能靠取第一个通过。

## Verdict

CHANGES REQUESTED — address items above
