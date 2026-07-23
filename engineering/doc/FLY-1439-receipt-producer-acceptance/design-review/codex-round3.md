# Design Review — FLY-1439 plan.md (Round 3)

Date: 2026-07-23
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 正确关闭了 Round 2 中的配置源、companion allowlist、S2b supervisor 控制、barrier deadline 与 m2 靶点问题，计划已经接近可执行。仍不能批准，因为 S2c 的 MCP crash 不会自行让 tmux window 退出，S4 的同 project/agentId 启动会复用固定 session-id，多条 delivered-but-unprocessed 收据会继续被 patrol 合法重发，且 m3 尚未把测试确定地路由到重建后的 mutated CLI。

## What's Good (Keep)

- 保留 S4 直接替换 `FLYWHEEL_PROJECTS` 的做法；`ProjectConfig.loadProjects()` 的真实优先级及 `_companion_query()` 调用链现在引用正确。
- 保留 companion 专属 state dir 的最小 `access.json`、driver `allowBots` 与 pre/post hash 证据；这关闭了 bot 消息被静默丢弃的问题。
- 保留 S4 通过 supervisor PID 做 SIGTERM、等待 supervisor/window 双消失的“真停”协议；这正确区别于会被自动拉起的 `tmux kill-window`。
- 保留 barrier-to-kill 的 monotonic `<2s` 硬门、start-without-end/PID/callId 一致性及网络取证后移；`HARNESS INVALID` 与产品 verdict 的分流清楚。
- 保留 m2 对 `chat-receipt-recorder.ts` stock 常量的定向 mutation，以及 m3 选择 `INSERT OR IGNORE → INSERT` 主键冲突的破坏形态；概念上的红测 oracle 是正确的。
- 保留精确 172/0/411、零 loud-skip、head/clean/archive 三查、生产内容快照与无 token 进程证据。

## Issues & Recommendations

1. **HIGH — S2c 杀 MCP 不会触发 launcher supervisor 重启，而且会留下悬挂 shim。** Supervisor 只观察 tmux window（`claude-lead.sh:1654-1678,3077-3104`）；`kill -9 <MCP pid>` 本身不会令 Claude pane 退出。更重要的是，MCP 被 SIGKILL 后，其正在 sleep 的 shim 子进程不会随父进程级联死亡，runtime 的 5 秒 timer 也已随 MCP 消失，因此当前 `plan.md:68,100` 的“让 window 退出”与零 orphan 收尾没有执行机制。**建议修复：**冻结完整顺序：barrier gate 内恢复 passthrough并 SIGKILL MCP、证明旧 MCP 已死；随后显式 `tmux kill-window` 触发同 supervisor 重建；证据保存后按 barrier 中的 exact shimPid 校验 command/slot path 与父进程死亡，再主动 TERM/KILL 并 wait，最后才删 barrier。S2b 也应采用同一 exact-PID orphan reap 合同，不能只断言 `pgrep` 为零。

2. **HIGH — S4 所谓“专属 session-id”没有真实 seam；同 projectName/agentId 会复用标准 Lead 会话。** `SESSION_ID_FILE` 固定为 `~/.flywheel/claude-sessions/${PROJECT_NAME}-${LEAD_ID}.session-id`，不受 workspace、state dir 或 `CLAUDE_CONFIG_DIR` 控制（`claude-lead.sh:190,466-468`）。标准 Lead 已写入该文件后，companion launcher 会走 `--resume`（`:3001-3016`），而 v3 又冻结相同 project/agentId 和不同 workspace；`test-deploy.sh:1080-1086` 已明确这种旧 workspace session-id 会造成确定性 resume crash。**建议修复：**S4 真停标准 supervisor 后，先把固定 session-id（以及同 exact key 的 manifest，如需恢复标准 Lead）原子移到 slot backup 并注册 trap；断言 companion 日志为 `Fresh start` 而非 `Resuming`。收尾停 companion 后删除 companion session-id，再恢复标准备份或明确不再重启标准 Lead。不要把“专属 session-id”描述成一个不存在的 env 配置项。

3. **HIGH — 通用收尾只清 spool，不清活跃的 delivered-but-unprocessed 根；后续 patrol 会合法重发并污染场景。** `complete` 会为未处理行设置 `next_unprocessed_at`（`lead-inbox-queue.ts:685-712`），patrol 正会选择 `delivered_at IS NOT NULL AND processed_at IS NULL AND next_unprocessed_at <= now` 的根（`db.ts:3916-3928`）。因此 M2 ack 若 best-effort 失败、S2a α/S2b 只到 delivered、S3 M7 的 processed 又是可选时，这些根都会在后续 S2/S4 产生 resend/advisory；`plan.md:102` 把 “processed/delivered” 都当成可等待一窗的稳态也是错误的。**建议修复：**扩展每场景收尾为“所有本场景 test root 均已 processed，且 family 的 next_unprocessed/outbox 已关闭”。优先用真实 explicit reply；否则在真实 Lead pane 用 `handle-receipt ack` 做**强制 harness cleanup**。ack 仍不属于产品验收项，但清理失败必须判 `HARNESS INVALID/停止推进`，不能“留给 teardown”。S2 的零误重发等待只能在所有相关根 processed 后开始。

4. **HIGH — m3 仍未冻结 mutated CLI 的构建与环境路由，可能测试原 CLI 或 loud-skip。** Fork 集成测试只从 `process.env.FLYWHEEL_COMM_CLI` 取 CLI，缺失时 loud-skip（pinned `chat-receipt-runtime.test.ts:81-86`）。`plan.md:124` 写了修改 CLI 副本和 `bun test`，但没有规定修改 source 后重建 dist，也没有在命令中把 `FLYWHEEL_COMM_CLI` 指向该副本；继承 E1 原 CLI 时 mutation 会错误地保持绿色。**建议修复：**冻结两份 disposable copy 的关系：在 main-repo copy 修改 enqueue 语句，运行 `pnpm --filter flywheel-comm build`，记录 mutated `dist/index.js` hash；随后在 fork copy 执行 `FLYWHEEL_COMM_CLI=<mutated-copy>/packages/flywheel-comm/dist/index.js bun test chat-receipt-runtime.test.ts`。同时断言无 loud-skip，且失败 test name/第二个 begin 断言与预期一致。

5. **MEDIUM — E4b 展示的 if/else 仍未实现文中承诺的 flag-only fail-closed，也没有证明 config 真是隔离目录。** 当前 `if flag==1 && config非空; then skip; else 原检查; fi` 在 flag=1/config空时会进入原检查，而非 `ERROR + exit`；在任意非空 config 时又直接把它称作 isolated（`plan.md:51`）。这会让配置错误的 QA launcher 再次进入硬编码 `$HOME` 的生产 check/update。**建议修复：**写成明确三分支：flag=1 且 config 与 test-deploy 传入的 expected isolated path 相等才 skip；flag=1 但缺失/不匹配时 exit；flag 未设才执行原块。同步把交付物 `plan.md:143` 的“各自两态”改成 E4a 两态、E4b 三态，避免 Q1 测试数量歧义。

6. **MEDIUM — teardown 与最终 verdict/证据提交顺序仍需两阶段化。** `plan.md:135` 要求证据 commit 后才 teardown，交付物又要求 G0.4 后快照入 evidence（`:142`），Q6 却先 commit 报告/verdict 再 teardown（`:155`）。若 shim hash 恢复或生产后快照在 teardown 阶段失败，已落笔的最终 verdict 就不再真实。E5 也应在第一次 `mv` 之前注册可条件执行的 restore trap，而不是写完 shim 后才注册（`:52`）。**建议修复：**先做 evidence checkpoint commit；再 teardown、shim hash 恢复与最终 G0.4 快照；最后更新 qa-report/verdict 并做第二个 final commit。restore trap 在任何破坏性 rename 前安装。

## Verdict

CHANGES REQUESTED — address items above
