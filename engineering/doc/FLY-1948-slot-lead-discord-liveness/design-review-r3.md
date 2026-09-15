# Design Review — plan.md (Round 3)

Date: 2026-09-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 已逐项落实 Round 2 的六条反馈：per-mode `roundtripChannelId` 与精确夹具、Codex 非空集语义、UTC/同秒 fail-closed fence、canonical envelope parser 的可执行导入与 fresh build、`--send-as` 的目标 allowlist 准入、以及同一 Claude 下多 adapter 的歧义失败，都已进入规范和测试表。Round 1 已关闭的八项也没有回退。

但当前计划仍有两个能让“当前 adapter 的 gateway 活连接”假绿的缺口。第一，gateway cutoff 只绑定 Claude/body 代际，没有绑定最终被判定的 adapter 代际；同一 Claude 下 adapter 重启后，可以用前一 adapter 的 ready 补齐当前 PID 的 socket。第二，轮转的 `.log.1` 与当前 log 没有规定合并顺序，错误的自然实现会让旧生命周期覆盖新生命周期。另有一个实现合同缺口：采用 `body-status.startedAt` 前要求的 launchd PID 观测没有进入“全部可注入”的 seam 或测试。

本轮核对的计划 blob 为 `06294a21de4aa2f3e8d333a9316be8d35203ff97`（由计划提交 `654160c951c7fa98d96c575da37514c4fa11d5ba` 引入；当前 HEAD 后续只更新了 progress 文件）。

## What's Good (Keep)

- 保留 writer 显式接收已解析 mode/channel 坐标，并由 writer 选择 `roundtripChannelId`；这与 mirror 只改写 `CHAT_CHANNEL_ID`、roundtable 使用独立 `ROUNDTABLE_CHANNEL_ID` 的实际启动链一致（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:133-155`；`scripts/test-deploy.sh:754-762,1010-1052`）。
- 保留 C4 在任何 REST/SQLite 前拒绝 Codex，并让 C3 用 `applicableCount == 0` 的 exit 5 表示 N/A；不再存在空集全绿（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:196-205,234-237`）。
- 保留 `TZ=UTC LC_ALL=C`、同秒 lifecycle 忽略、adapter 唯一性要求和相应负例；它们分别关闭了时区漂移、秒精度碰撞和重复 gateway 进程竞争（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:65-101,274-283`）。
- 保留公开 re-export canonical parser、先 build `flywheel-comm`、fresh-dist 真实 import 的合同；现有 package 确实只公开 `./discord-chat-ingest`，而 parser 当前位于内部模块（`packages/flywheel-comm/package.json:8-58`；`packages/flywheel-comm/src/discord-chat-ingest.ts:1-15`；`packages/flywheel-comm/src/chat-delivery-envelope.ts:201-223`）。
- 保留 `--send-as` 对 `/users/@me`、slots `botAppId`、目标 `allowBots` 和目标 group 的预检。插件确实会在 ingest 前丢弃不在 `allowBots` 的 bot 作者（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:238-245`；`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1597-1607`）。
- 保留 exact nonce/ack、canonical bot author、envelope-derived reply target、绝对 deadline 和独立 T3；这些判据已经把“相关回复”与频道噪声分开，并覆盖 roundtable thread（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:207-247`）。

## Issues & Recommendations

1. **gateway ready 仍未绑定到当前 adapter 代际。** **Severity: HIGH**

   **Issue:** 有效 cutoff 只取 `max(requested since, claude.startedAt, body.startedAt)`（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:92-96`）。计划随后读取 adapter 的 `lstart`，却只验证它不早于 Claude；没有把它纳入 gateway cutoff（同文件 `:97-103`）。实际插件按 `DISCORD_STATE_DIR` 使用共享的 `gateway-health.log`（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:90,509`），该文件由各 adapter 进程持续 append、不会在新 adapter 启动时清空（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/gateway-health-files.ts:31-33,43-60`），而 ready 正是 adapter 收到 shard ready 时写入（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/gateway-health.ts:84-91`）。

   **Why it matters:** 同一 Claude 不重启、adapter A 已写 ready 后退出、adapter B 以新 PID 启动的窗口里，B 只要已有一条 443 ESTABLISHED（包括必要非充分的 REST 连接），A 的旧 ready 仍晚于 Claude/body cutoff，于是三件证据被错误拼成 `live:true`。这正违反本计划要证明“当前 adapter 活连接”的 fail-closed 目标，也使 adapter-only 故障/拉回后的独立探针不可信。

   **Suggested fix:** 选定唯一当前 adapter 并取得其 `lstart` 后，再把 gateway evidence cutoff 提升为当前 adapter 代际下界；对 adapter 的秒精度采用与 Claude 相同的同秒歧义规则（或增加更高精度的 adapter generation marker）。新增负例：Claude PID 不变，旧 adapter 已有 ready；新 adapter PID 有 443、尚无自己的 ready，必须得到 `gateway_ready_stale`/`gateway_ready_missing`，不能 live。

2. **轮转日志的生命周期折叠顺序未定义，旧状态可能覆盖新状态。** **Severity: HIGH**

   **Issue:** 计划只写“扫 `gateway-health.log + .log.1`，按顺序求最新状态”，没有定义跨文件顺序或稳定快照规则（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:103-108`）；测试表也只要求“.log.1 被扫”，没有覆盖状态跨轮转边界（同文件 `:274-283`）。实际 writer 在超限时先删除旧 backup、把当前 log rename 成 `.log.1`，再向新的当前 log append（`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/gateway-health-files.ts:51-60`），所以 `.log.1` 必然是较老段。按计划文字列出的自然顺序先读 current、再读 `.log.1`，会让较老 backup 成为“最新”。

   **Why it matters:** 若 `.log.1` 末尾是 ready、当前 log 已 reconnecting/disconnected，错误折叠会假绿；反向则会把已 resumed 的连接假红。前者直接破坏 channel gate 的 fail-closed 性质。

   **Suggested fix:** 明确一个跨轮转的 canonical merge：例如先对两个 bounded 文件取稳定快照，再按解析后的 ISO 与确定性 tie-breaker 升序折叠；若读期间 inode/size 发生轮转则重试并在无法稳定时 `probe_unavailable`。至少增加两条跨文件测试：backup ready → current reconnecting 必须 degraded；backup reconnecting → current resumed 必须 live。

3. **`body-status.startedAt` 的三方 provenance 校验缺少可执行、可注入的 launchd PID 观测合同。** **Severity: MED**

   **Issue:** v3 要求只有 `carrierPid` 同时匹配 manifest/launchd PID 时才采用毫秒 `body.startedAt`，并声称复用 `body_snapshot` 判定（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:92-95`）。现有 `body_snapshot` 的确要求 `runtime_pid == launchd_pid == carrierPid`（`scripts/lib/qa-lead-diagnostics.py:528-547`），而 launchd PID 来自 `launchctl print`（`scripts/lib/qa-launchd-lead.sh:400-412`）。但 C1 声称“全部可注入”的 seam 只有 ps/lstart/lsof/env/pane，没有 launchd PID（`engineering/doc/FLY-1948-slot-lead-discord-liveness/plan.md:63-73`）；坐标 schema 也不携带 label/manifest path，测试表没有 body status 采纳/拒绝夹具（同文件 `:133-155,274-283`）。

   **Why it matters:** 实现者只能自行猜测 label/manifest 派生与 launchctl 调用，或弱化成只比 manifest，或在 Ubuntu 离线测试中静默忽略 body timestamp。三种结果都与计划宣称的相同 provenance 判定/全部观测可注入不一致，且最关键的毫秒代际下界没有被测试证明。

   **Suggested fix:** 在合同中明确 manifest 固定为 coordinates 同目录的 `manifest.json`、launchd label 的可信来源（优先直接写入坐标），并增加 injectable launchd-PID seam（可复用现有 `FLYWHEEL_QA_LAUNCHCTL`，但要明写调用和 rc 语义）。测试至少覆盖三方一致时采用 `body.startedAt`，以及 manifest mismatch、launchd mismatch、symlink/非法 body 文件时忽略且不假绿。

## Verdict

CHANGES REQUESTED — address items above
