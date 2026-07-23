# Design Review — FLY-1439 plan.md (Round 2)

Date: 2026-07-23
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 已实质关闭 Round 1 的大部分问题：生产插件缓存有事前阻断与内容快照，运行字节有三路证明，shim 有可恢复协议，S2/S3 oracle 与 S5 数字门也明显更严。仍不能批准实施，因为当前 S4 配方不会把 launcher 切到 companion 配置，`tmux kill-window` 又会被 Lead supervisor 自动拉起；此外 5 秒 crash window 与两个 mutation 探针仍缺少能保证 oracle 成立的冻结协议。

## What's Good (Keep)

- 保留 E3/E4b/G0.1/G0.4 的组合：隔离配置绝对路径 rewrite、launcher 事前跳过生产 fork check、运行目录 manifest 对 pinned archive 零 diff、生产内容前后快照，已经把“标签证明”升级成“实际加载字节证明”。
- 保留禁止 `ps eww`、只记录 command 与 pane 内白名单变量的证据纪律；这正确处理了 bot token 泄漏风险。
- 保留独占 deploy worktree、`mv`/hash/trap 恢复、两阶段 ledger、barrier 与 orphan 清场合同；这些修订解决了 dist 被 gitignore 后无法可靠恢复的问题。
- 保留 S2a 的双 oracle。`spool → settle → pending` 恢复顺序及 pending 对 processed 行的排除，使“模型意外回复后零 redelivery”成为正确而非放宽的结论。
- 保留 S3 的不可自愈 spool-path 文件故障、M6 无自愈要求及 M7 健康阳性对照；这比 `chmod 500` 故障模型准确。
- 保留 S1 的两路 patrol 阳性证据，以及把 lease-sensitive ack 降为 best-effort；ack 不再污染核心验收 verdict。
- 保留 S5 的精确 `172 pass / 0 fail / 411 assertions`、零 loud-skip、disposable mutation copy 与 verdict 前 clean 三查。
- PASS/FAIL 不可逆纪律、head 双钉死、每场景清场和产品缺陷/harness 缺陷分流仍然是可靠的 QA 方法。

## Issues & Recommendations

1. **HIGH — S4 指定的配置源不会被 launcher 读取，且新的 state dir 没有 driver-bot allowlist。** 计划 `plan.md:109` 给同一 launcher 传 `FLYWHEEL_PROJECTS_FILE`，但 `ProjectConfig.loadProjects()` 只读取 `FLYWHEEL_PROJECTS`，否则直接回落到 `~/.flywheel/projects.json`（`packages/teamlead/src/ProjectConfig.ts:279-305`）；`_companion_query()` 正是调用该函数（`packages/teamlead/scripts/claude-lead.sh:340-351`）。标准 slot env 又显式携带原来的非 companion `FLYWHEEL_PROJECTS`（`scripts/test-deploy.sh:1123`），所以 companion 文件必然被忽略。另一个独立问题是 companion 专属 `DISCORD_STATE_DIR` 没有 E7 的 `access.json`；缺失 `allowBots` 时，插件会直接丢弃 driver bot 消息（pinned `server.ts:1505-1511`）。**建议修复：**手动 launcher 命令必须把 companion JSON 本身设置为 `FLYWHEEL_PROJECTS`，不得依赖不存在的 file seam；JSON 中冻结 projectName、agentId、bot/channel 与 `companion:true` 的完整值。启动前在 companion state dir 种一份最小、脱敏、包含 driver bot ID 的 `access.json`，并把其 hash/allowBots 摘要纳入 pre/post 证据。

2. **HIGH — `tmux kill-window` 不是“停 Lead”，现有 supervisor 会自动重启；这同时破坏 S2 与 S4 的单 listener 假设。** `_wait_tmux_window()` 发现窗口死亡后返回（`claude-lead.sh:1654-1678`），外层 recovery loop 随后继续重启 Claude（`:2893-2897`, `:3077-3104`, `:3166-3167`）。因此 S2b 可能在 shim mode 恢复前自行重启，S4 的标准 Lead 则会回来并与 companion 同时监听。计划所说“重跑部署脚本 Lead 段”也不是当前 `test-deploy.sh` 暴露的独立入口。**建议修复：**冻结一种真实存在的生命周期协议。S2 可显式利用原 supervisor：barrier 后先原子恢复 passthrough，再 kill window，随后以同一 supervisor PID 的新 window/MCP PID、ready lease 和 restart log 证明重启；S2c 在杀 MCP 取得 crash 证据后，还需明确如何让 Lead window 退出并由 supervisor 重建 MCP。S4 必须按 `test-teardown.sh:440-462` 的模式 SIGTERM supervisor PID、等待 supervisor 与 window 均消失，再手启并记录 companion supervisor PID；结束时对该 PID 做同等清理。不要把 `kill-window` 当作 supervisor stop。

3. **HIGH — barrier 自动化消除了人工反应时间，但并未消除 runtime 的 5 秒 deadline。** pinned runtime 固定 `COMMAND_TIMEOUT_MS = 5_000`，超时后主动 kill shim（`chat-receipt-runtime.ts:83,654-665`）；计划 `plan.md:63` 却声明时序“与 5s 窗无关”。若 barrier 后先做 Discord REST 与多项取证，原调用可能已经超时结束，残留 barrier 仍会让 driver 误判为 in-flight crash。**建议修复：**把 barrier-to-kill 变成硬 harness gate：记录 monotonic barrierSeen/kill 时间，先做最小本地快照并恢复 shim mode，然后立即 kill；要求原 callId 在 kill 时仍为 start-without-end，且 elapsed 明确小于保守预算（例如 2 秒）。Discord reference 检查可在 kill 后按消息时间与 kill 时间回查。错过预算、call 已结束或 barrier PID/callId 不匹配时，应判 `HARNESS INVALID`、清场后重做，不能计产品 PASS/FAIL。

4. **HIGH — S5 的 m2 指向错误文件，m3 也没有一个必然被现有测试捕获的具体 mutation。** 三个 stock 常量位于 pinned `chat-receipt-recorder.ts:64-69`，对应快照断言在 `chat-receipt-recorder.test.ts:268-277`；修改 `server.ts` 不会让该测试变红。m3 所称“重放造第二行”同样不充分：当前集成测试只查询 canonical ID 的 count（`chat-receipt-runtime.test.ts:102-106`）；同 ID 受主键及 `INSERT OR IGNORE` 约束，而另一个 ID 的额外行未必会使这个 count 失败。**建议修复：**m2 改 recorder 中一个 stock 常量并冻结运行 `chat-receipt-recorder.test.ts` 的具体 test name/expected diff。m3 改成现有集成测试必抓的确定性破坏，例如在 CLI 副本把 `lead-inbox-queue` 的 `INSERT OR IGNORE` 改为 `INSERT`，冻结预期为第二次 `runtime.begin()` 不再是 `ok`、测试在第二个 begin 断言处失败；或另选同等明确的 mutation。计划中要写出实际文件/语句、测试命令、测试名与失败断言，不能把“每针冻结”留到 implement 节点临场设计。

5. **MEDIUM — E4b 的伪代码只记录 skip，并没有表达如何跳过整个生产检查块。** `plan.md:51` 的 `[[ flag == 1 ]] && log skip` 若照抄不会阻止后续 check/update；虽然预期守卫测试应能发现此错，但计划同时要求 implement 节点照抄。**建议修复：**在计划中冻结完整 `if/else` 边界：只有 `TEST_SKIP_PLUGIN_FORK_CHECK=1` 且非空隔离 `CLAUDE_CONFIG_DIR` 同时成立才进入 skip 分支，否则原检查块逐字节执行；flag=1 但缺隔离 config 时 fail closed。守卫测试覆盖 unset、仅 flag、flag+isolated-config 三态。

## Verdict

CHANGES REQUESTED — address items above
