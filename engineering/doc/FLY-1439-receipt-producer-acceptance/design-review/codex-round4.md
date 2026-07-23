# Design Review — FLY-1439 plan.md (Round 4)

Date: 2026-07-23
Author: Codex
Status: CHANGES REQUESTED

## Summary

v4 已正确关闭 Round 3 的六个主要问题：S2c/reap 全序、S4 session 文件事务、强制 receipt cleanup、m3 路由、三分支 skip seam 和两阶段 teardown 都有了可核验合同。仍有两个会阻止或污染真机执行的组合问题，以及一个 mutation 证据目标错误，因此本轮仍需小范围修改。

## What's Good (Keep)

- 保留 S2c 的 `SIGKILL MCP → 证明死亡 → 显式 kill-window → 同 supervisor 重建` 全序，以及按 barrier exact shimPid 主动收割的合同。
- 保留 S4 固定 session-id/manifest 的备份事务与 `Fresh start` 硬断言；这与 launcher 的固定 exact-key 文件路径一致。
- 保留 E4b 的三分支 fail-closed 语义和 expected-config equality；错误配置不会再落回生产 check/update。
- 保留 delivered-but-unprocessed 不是稳态的判断，以及用真实 reply 或 lease-backed ack 关闭 receipt family 的 harness-cleanup 机制。
- 保留 m3 的 disposable main-repo build、显式 `FLYWHEEL_COMM_CLI` 路由、零 loud-skip 与第二次 begin 红测断言。
- 保留 teardown 后才写定最终 verdict 的两阶段提交，以及 destructive rename 前预装 restore trap。
- 生产内容快照、运行字节 manifest、head pin、证据脱敏和产品失败/HARNESS INVALID 分流仍然完整。

## Issues & Recommendations

1. **HIGH — S4 手动 companion launcher 没有传 E4b 新要求的 expected-config env，因此会按设计 fail-closed。** E4b 在 `plan.md:51` 要求 flag=1 时 `CLAUDE_CONFIG_DIR` 必须与 `TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR` 逐字相等；但 S4 的手启 env（`:116`）只明确传了隔离 `CLAUDE_CONFIG_DIR` 和 `TEST_SKIP_PLUGIN_FORK_CHECK=1`。该手启不再经过 `test-deploy.sh`，所以 test-deploy 内部构造的 expected env 不会自动出现在调用者 shell。**建议修复：**在 S4 冻结命令中显式加入 `TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR=$SLOT_DIR/claude-config`，并在启动前断言它与 `CLAUDE_CONFIG_DIR` byte-equal；把这项也列入 pane/launcher 白名单证据。否则 S4 在到达 companion role assertion 前就会退出。

2. **HIGH — receipt cleanup 的规则正确，但执行点仍太晚，S2/S3 子窗及 G0.3 会互相污染。** 当前通用合同写的是“进下一场景前”（`plan.md:84-87`），S2 又只在三个 crash 窗全部结束后统一关账（`:106`）。若 S2a 走 α 或 S2b 完成到 delivered，它们在进入下一子窗两分钟后就会被 patrol 合法重发；源码确实在 complete 时设置 `next_unprocessed_at`（`lead-inbox-queue.ts:685-712`），patrol 也选择这些 delivered/unprocessed 根（`db.ts:3916-3928`）。同样，S3 M7 的 processed 仍写成可选（`plan.md:111`），随后却运行 15 分钟变体；G0.3 的真插件消息也未纳入任何收尾合同。**建议修复：**把合同改成“每个会武装 receipt 的 test case/sub-window 后、下一个 case 前”执行：G0.3 后先 processed；S2a 后先关闭 M3 再进 S2b，S2b 后关闭 M4 再进 S2c；M7 在 S3 变体前必须 processed；变体恢复/drain 后也须关闭其根。同步把 §1 `plan.md:16` 的“best-effort 收尾”改为“ack 非产品验收项，但作为 harness cleanup 时强制，失败即 HARNESS INVALID”，消除与 §5 的冲突。

3. **MEDIUM — m3 记录的 `dist/index.js` hash 不是被 mutation 改变的编译产物。** `flywheel-comm` 的 build 是普通 `tsc`、输出独立模块（`packages/flywheel-comm/tsconfig.json`）；`chat-receipt.ts`/`db.ts` 从 `lead-inbox-queue.js` 导入实现。把 enqueue 的 SQL 改掉后，变化落在 `dist/lead-inbox-queue.js`，入口 `dist/index.js` 通常字节不变。**建议修复：**保留 index.js 作为 CLI 路由证明，但 mutation 证据必须记录 patched source 与 emitted `dist/lead-inbox-queue.js` 的 before/after hash（或整个 dist manifest diff），并断言 emitted SQL 已从 `INSERT OR IGNORE` 变成目标 `INSERT`；随后再运行现有红测。

## Verdict

CHANGES REQUESTED — address items above
