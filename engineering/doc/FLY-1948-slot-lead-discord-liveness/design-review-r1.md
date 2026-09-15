# Design Review — plan.md (Round 1)

Date: 2026-09-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确：把 Discord adapter 进程、当前 TCP 连接和 gateway 生命周期证据并入 529 Lead readiness，明显强于现有只看 inbox lease 的门；同时保留生产启动行为、把主动发 founder 消息留在人类侧，也符合本单边界。

但 v1 还不能实施。整圈探针目前会生成不可信的时延与成功结论：`mailbox.created_at` 就是 Discord 消息时间而不是入箱时间，T4 可被任意无关 bot 消息满足，roundtable 的真实回复又在 thread 而不是原频道。独立探针的坐标合同也无法服务它被要求替换的普通 multi-Lead smoke。最后，C5 会把生产 Lead pane 原文写入现有 startup log，而这些日志并没有统一的 0600 保证；仅按 `token` 单词脱敏不足以承担这项新增敏感数据面。

## What's Good (Keep)

- 保留“三件证据缺一不可”的 fail-closed 方向；现有 lease 只证明 inbox-mcp 活着，计划正确地没有把它继续当 Discord readiness。
- channel timeout 与 lease timeout 分开，失败复用 registry stop / lock retention 的现有清理路径，职责边界清楚。
- 不改 Discord 插件、不自动使用 founder 凭据、CommDB 只读，这些 scope cuts 合理。
- 对 Codex carrier 明示 N/A 而不是伪造 adapter 绿灯；对 room-info 采用加字段而非改 schemaVersion 也与现有宽松读者一致（`scripts/lib/qa-generalized-e2e-lib.mjs:140-174`、`scripts/qa/fly2446-two-lead-run.mjs:239-258`）。
- 离线 sensor/fetch fixture、失败 reason、轮转日志、超限与脱敏用例的总体测试方向是对的。

## Issues & Recommendations

1. **T1 的数据源定义错误，计划无法测量 adapter→mailbox 时延。** **Severity: HIGH**

   **Issue:** C4 把 mailbox 行的 `created_at` 当 T1，并要求计算 `T1−T0`。实际 ingest 明确把 Discord envelope 的 `ts` 传成 `createdAt`（`packages/flywheel-comm/src/discord-chat-ingest.ts:133-168`）；schema 只原样保存该值（`packages/flywheel-comm/src/mailbox-schema.ts:192-225`）。也就是说，T0 与 `created_at` 是同一时间戳，所谓 `T1−T0` 会天然接近 0，与消息什么时候真正写入 SQLite 无关。

   **Why it matters:** 这是本计划声称要建立的首个“N 秒进会话”基线之一。按当前设计，adapter 卡 9 秒后才落库仍会被报告为 0 秒，产出的核心测量不可用。

   **Suggested fix:** 在不改 schema 的边界下，把首次只读查询观察到该行的本机 UTC 时间记录为 `T1ObservedAt`，明确它是“入箱完成的轮询上界”，并报告 `[0, pollInterval]` 观察误差；不要把 `created_at` 重命名为 T1。若必须要持久、精确的真实入箱时刻，就需要新增已有 writer 能原子写入的字段/receipt，并明确调整“不改 CommDB schema”的非目标。测试必须注入一个与 T0 不同的观察时钟，断言实现不会再从 `created_at` 派生 T1。

2. **T4 没有因果关联，且 roundtable 模式会查错频道；整圈既会假绿也会假红。** **Severity: HIGH**

   **Issue:** 计划把“T0 后第一条作者为 slot bot 的消息”当 T4。它不要求回复包含 nonce，也不要求 `message_reference` 指向 T0；频道内任意无关 Lead 消息都能让探针通过。反向地，roundtable 顶层入站会被插件改路由到 `threadId == sourceMessageId`，并把交给 Lead 的 `chat_id` 改成 thread（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1630-1669`），而计划仍查询原 `<channelId>/messages?after=<T0>`，真实回复不会出现在那个集合。watch 模式还把 `from_agent == founder` 降为非判据，尽管 writer 已提供可精确验证的 `founder` / `discord:<authorId>` 身份（`packages/flywheel-comm/src/discord-chat-ingest.ts:133-168`）。此外，当前 room-info writer没有 bot identity（`scripts/test-deploy.sh:2322-2340`），计划 C2 的 `lead` 字段清单也未承诺 `botUserId`，但 C4 已依赖它并允许 ambient `DISCORD_EXPECTED_BOT_USER_ID` 回退。

   **Why it matters:** 该 artifact 不能证明“founder→这个 Lead→针对这条 probe 的回复”，也无法覆盖它明示支持的 roundtable 自动模式。ambient bot ID 还可能把生产身份错误带入 slot 判据。

   **Suggested fix:** 把协议改成 challenge/response：入站正文要求 Lead 在回复中原样携带随机 nonce，T4 同时验证 exact nonce、canonical slot `botUserId`、正确回复 channel/thread，最好再验证 message reference。正确回复坐标应从已匹配 mailbox row 的 delivery envelope (`chatId` / `replyRoute`)解析，而不是继续假定 T0 所在父频道。watch 必须要求 `from_agent='founder'`；send-as 必须先用 `/users/@me` 验证 exact sender ID、`sender != slot bot`，并要求 mailbox 的 `from_agent` 与它一致。`botUserId` 必须来自 slot projects/受控 room metadata，不得信 ambient env。加入“同频道无关 bot 消息不得通过”和“roundtable thread 回复通过”的测试。

3. **T3 与各阶段 deadline 没有闭合，`exit 0 全通过` 目前没有可实现的确定语义。** **Severity: HIGH**

   **Issue:** 对 Lead lane，Bridge transport 成功只写 `notified_at`；`recordLeadBatchDelivered` 明确不写 Lead 的 `delivered_at`（`packages/flywheel-comm/src/mailbox-queue.ts:1639-1699`）。后者要等 Lead 的 batch ACK 经 protocol ingress 后才写（`packages/flywheel-comm/src/mailbox-queue.ts:1759-1794`、`packages/teamlead/src/bridge/protocol-ingress.ts:53-75`）。计划却没有 T3 timeout/exit code，只列 T1、T2、T4 三种 timeout（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:165-181`）。默认 watch 在等人发 T0 时也没有单独预算；且未说明 session/reply deadline 是从 T0 的绝对 deadline，还是前一阶段结束后重新计时。

   **Why it matters:** 实现要么无限等 T3，要么忽略 ACK 仍报全通过；若每阶段重新给 60/180 秒，还会让 `T4−T0` 超过宣称阈值仍通过。

   **Suggested fix:** 增加独立且有退出码的 ACK deadline（或明确规定 T3 必须在同一个、锚定 T0 的 session deadline 内出现）；所有 SLA deadline 都用 `T0 + timeout` 的绝对时刻。给人工 T0 增加单独的 `--author-timeout`，不计入 T1/T2/T4 SLA。测试覆盖 T2 已有但 T3 永不出现、T4 先于 T3、以及前序阶段耗尽大部分总预算的情况。

4. **C3 的 room-info-only 坐标合同与 C6 的现有 smoke、extra Lead、自动 mirror/roundtable 用途不兼容。** **Severity: HIGH**

   **Issue:** `room-info.json` 只在 `GENERALIZED=1` 时设置/发布（`scripts/test-deploy.sh:910-943`、`scripts/test-deploy.sh:2322-2345`），但 C6 要改造的 `qa-fly-1189-room-smoke.sh` 起的是普通房，没有 `--generalized`（`scripts/qa-fly-1189-room-smoke.sh:86-107`）。所以按 C3 规定读取 room-info 会直接走坐标错误。该 smoke 当前逐个检查两条 Lead（`scripts/qa-fly-1189-room-smoke.sh:125-144`），而 extra Lead 的 state dir 是独立的 `${SLOT_DIR}/extra-leads/slot-N/discord-state`（`scripts/test-deploy.sh:1901-1925`）；单个 `room-info.lead` 也没有足够坐标来保持这份双 Lead 覆盖。C4 声称用于 mirror/roundtable 的 `--send-as` 同样无法用于现有普通 mirror/roundtable 房。

   **Why it matters:** 计划指定的 smoke 接线落地后必红；若只探 main Lead 则会悄悄降低已有 multi-Lead coverage。简单地给所有普通房补 `room-info.json` 也不安全，因为该文件的存在本身参与 FLY-2211 reown 排除（`doc/qa/framework/529-room-playbook.md:320-327`）。

   **Suggested fix:** 不要扩大现有 `room-info.json` 的发布域。为 liveness 定义一个与 generalized/reown 无关的 slot-local coordinates artifact（包含每条 Lead 的 agentId、carrier、startedAt/current generation、discordStateDir、socket、chatChannelId、botUserId、livenessPath），或让 C3 接受 `test-deploy` stdout/现有 projects + campaign manifest。C6 必须逐条调用并断言所有 Claude extra Leads；Codex carrier返回明确 N/A，而不是 `claude_process_missing`。为 ordinary slot、ordinary two-Lead、mirror/roundtable、Codex 与 `--no-lead` 各加坐标测试。

5. **C5 将生产 pane 原文写入权限不稳定的全局日志，新增了未解决的 secret/PII 风险。** **Severity: HIGH**

   **Issue:** 该 poller 是生产共用代码，目标文件默认是 `~/.flywheel/logs/lead-<id>-startup.log`；writer 只创建目录并 append，从未 chmod（`packages/teamlead/scripts/claude-lead.sh:1598-1604`）。本机只读 `stat` 已验证多份现有 production startup log 为 mode 0644。90 秒时 pane 已可能进入恢复后的真实会话；记录 40 行原文会把 founder 内容、工具输出或不含字面 `token` 的凭据永久扩散到该日志。拟议 sed 也没有做到计划宣称的“整行替换”：它保留 `token` 之前的前缀（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:187-196`）。

   **Why it matters:** “只加日志”不是零行为风险；这是生产数据面变化，而且违反 repo 的 secret 边界（`CLAUDE.md:232-237`）。`channel-liveness.json` 的 0600 不能补救已经写进全局 startup log 的 pane 内容。

   **Suggested fix:** 不把 raw pane 写进生产 startup log。最小方案是在 C5 只记 allowlisted UI classification/哈希；raw pane 仅对 `flywheel-test-*` 或显式 QA 坐标写进 slot-local 0600 artifact。若仍坚持生产 raw snapshot，计划必须先定义可靠的 secret/PII redactor、原子 0600 文件、权限迁移和相应负向测试，而不是只匹配单词 `token`。

6. **E2/E3 证明的是“曾 ready + 现在有某条 443”，没有绑定当前 Claude generation 或当前 gateway 状态。** **Severity: MED**

   **Issue:** gateway log 会持续 append 同一 state dir 并轮转，而不是按 Claude generation 新建（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/gateway-health-files.ts:31-60`）。独立探针默认使用最初房间的 `lead.startedAt`；launchd 拉回后仍可接受上一代 ready。与此同时，gateway monitor 会在 ready 后继续记录 `reconnecting`、`resumed` 或永久断线（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/gateway-health.ts:65-118`），计划不看 ready 之后的状态。`:443 ESTABLISHED` 也不唯一标识 gateway WebSocket：同一 adapter 还会通过 REST 发消息（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:509-519`），入站后 typing keepalive 也会持续做 REST I/O（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1787-1790`）。

   **Why it matters:** KeepAlive 重启后的新 adapter 在真正 READY 前，或已进入 reconnecting 但仍有 REST 连接时，默认 probe 可能误报 live。初装门的窗口较窄，但 C3 作为后续 liveness 工具会长期暴露该错误。

   **Suggested fix:** evidence 中加入 Claude process start identity，并要求 gateway healthy event 晚于该 generation start（effective since = max(requested since, process start)）。判定最新相关 lifecycle 状态：`ready`/`resumed` 后若出现 `reconnecting`/permanent disconnect 且尚无后续恢复，不得 pass。至少给“旧 generation ready + 新 PID pre-ready”和“ready→reconnecting + unrelated 443”各一个负例。

7. **新增证据输入与 nonce 缺少现有 diagnostics 水平的 provenance/路径校验。** **Severity: MED**

   **Issue:** 计划让 `qa-lead-diagnostics.py` 接受任意 `--channel-liveness <path>` 并“原样嵌入”，但现有 helper 对 runtime、manifest、symlink、owner/mode 和路径归属有严格验证（`scripts/lib/qa-lead-diagnostics.py:39-65`、`scripts/lib/qa-lead-diagnostics.py:273-299`），最终 evidence 也固定写在 manifest parent（`scripts/lib/qa-lead-diagnostics.py:575-651`）。没有同级约束时，错 agent、旧 generation 或任意外部 JSON 都能被包装成可信 `channel-failure.json`。另外 `--nonce <s>` 会直接进入文件名 `discord-roundtrip-<nonce>.json`，但计划未定义字符/长度校验；这违反所有 CLI 外部输入必须在边界验证的项目规则（`CLAUDE.md:232-237`）。

   **Why it matters:** 故障 artifact 的身份可能被串线，nonce 中的 `/`, `..`, `%`, `_` 还会造成路径逃逸或 SQL LIKE 通配，破坏证据隔离与唯一匹配。

   **Suggested fix:** diagnostics 只接受 `manifest.parent/channel-liveness.json` 的 regular non-symlink bounded file，校验 schemaVersion、agentId、generation/since、live=false 和允许 reason；不合法时记录 `channel:unknown` 加明确 validation error，不嵌入任意对象。nonce 限定为短、随机、ASCII allowlist（例如 16–64 位 `[A-Za-z0-9-]+`），SQL 优先按 envelope 的 exact `messageId` 查询；不得用未转义 LIKE 作为身份锚。

8. **“全部离线、传感器注入、CI 登记”还缺三处可执行细节。** **Severity: MED**

   **Issue:**

   - root `package.json` 没有 `better-sqlite3` dependency（`package.json:39-49`）；本轮从 repo root 执行 `import('better-sqlite3')` 已得到 `ERR_MODULE_NOT_FOUND`。现有脚本通过以 `packages/teamlead/package.json` 为基准的 `createRequire` 解决（`scripts/qa-529-generalized-e2e.mjs:1338-1351`），C4 没有规定这一点。
   - `qa-room-env.test.sh` 当前不在 CI，且该 job 明说 root shell suites 必须显式枚举（`.github/workflows/ci.yml:403-409`）。计划只登记两个新 suite（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:198-213`），所以新增 timeout resolver 测试仍不会跑。
   - source 进来的 `_is_discord_adapter` 在 legacy `bun server.ts` 形状下会直接调用真实 `lsof` 取 cwd（`packages/teamlead/scripts/lib/reap-orphan-adapters.sh:144-148`、`packages/teamlead/scripts/lib/reap-orphan-adapters.sh:202-213`），绕过拟议 `FLYWHEEL_QA_LSOF_CMD`，因此“A6 所有传感器可注入”并不成立。该文件 source 时还会定义 fallback logger、写全局变量并 source kill-ledger（`packages/teamlead/scripts/lib/reap-orphan-adapters.sh:34-52`），并非计划所称“source 无副作用”。

   **Why it matters:** C4 在真机/CI 可直接启动失败；timeout parser 测试可能只在作者本机绿；legacy matcher 用例不再 hermetic，并可能观察宿主真实 PID/cwd。

   **Suggested fix:** 明写并复用现有 `createRequire(teamlead/package.json)` 模式与 `fileMustExist/busy_timeout`；把 `qa-room-env.test.sh` 显式登记到 CI；给 adapter cwd 加注入 seam（或在新库内只实现并测试当前绝对 `server.ts` 形状，同时把兼容范围写清）。对 source-time globals 做保存/恢复，或把 matcher抽成真正无副作用的小库。测试表中的 reason 也应逐名枚举：当前合同实际有 9 个 reason，不是“八种”。

## Verdict

CHANGES REQUESTED — address items above
