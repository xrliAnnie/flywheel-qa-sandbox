# Design Review — FLY-1439 plan.md (Round 5)

Date: 2026-07-23
Author: Codex
Status: APPROVED

## Summary

v5 已关闭 Round 4 的三项问题：S4 手启环境满足 E4b 的 fail-closed 前提，receipt 清场已下沉到每个会武装 patrol 的 case/sub-window，m3 也形成了 source → emitted module → 显式 CLI 路由 → 预期红测的完整证据链。复核 launcher、tmux env、`lead_inbox` 状态迁移和 pinned fork 测试后，未发现阻止实施或削弱 verdict 可信度的新问题。

## What's Good (Keep)

- S4 现在显式传入 `TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR=$SLOT_DIR/claude-config`，启动前要求与 `CLAUDE_CONFIG_DIR` byte-equal，并保留 E4b 的 mismatch fail-closed；手启路径不再因绕过 test-deploy 而在到达 companion oracle 前退出。
- companion 配方仍保持单 listener、同 launcher、真实 `FLYWHEEL_PROJECTS` 配置源、独立 state/workspace、driver `allowBots`、固定 session-id 备份事务与 `Fresh start` 证明，能够验证真实 launcher 产出的 legal-disabled 形态。
- 通用收尾合同明确以“每个武装 receipt 的 case/sub-window”为粒度，并点名 G0、S2a、S2b、M7 和 S3 变体的执行边界；这与 `markExternalDelivered()` 武装 `next_unprocessed_at` 及 patrol 对 delivered/unprocessed 根的选择条件一致。
- `handle-receipt ack` 的角色现在自洽：不作为产品 acceptance item，但作为 lease-backed harness cleanup 时是强制动作，失败归类为 `HARNESS INVALID`，不会把未关账根带入后续 oracle。
- m3 正确把 mutation 证据锚到 `dist/lead-inbox-queue.js`，同时保留 `dist/index.js` 作为 CLI 路由证据；显式 `FLYWHEEL_COMM_CLI`、零 loud-skip 和第二次 `runtime.begin()` 断言共同防止探针误测原 CLI 或空过绿。
- S2 barrier、exact-PID orphan reap、supervisor 重建、G0.1 runtime-byte manifest、生产内容前后快照、head pin 和两阶段 teardown/verdict 仍构成完整的安全与证据闭环。

## Issues & Recommendations

1. **NON-BLOCKING — Q1 的“守卫测试四态”是一个计数措辞残留。** §2 与 §7 已明确 E4a 两态、E4b 三态，操作合同本身没有歧义；实施时应以这两个明确矩阵为准。可在落地时把 §8 的“四态”改成“E4a 两态 + E4b 三态”，避免报告测试数时产生口径疑问，但不需要因此再开一轮 design review。

## Verdict

APPROVED — ready to implement
