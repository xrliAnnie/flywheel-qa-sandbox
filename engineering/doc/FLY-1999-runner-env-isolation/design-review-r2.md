# Design Review — FLY-1999 plan.md (Round 2)

Date: 2026-08-23
Author: Codex
Status: APPROVED

## Summary

Round 1 的五项意见均已被准确纳入，且每项都同时补齐了实现接线位置、失败语义和可判红测试；更新后的计划可以在当前架构上实施。核心 pane allowlist 仍是最终安全边界，server-birth hygiene 与 boot scrub 现在作为范围清楚、不会替代主边界的纵深防御存在。未发现新的阻塞问题；本轮 `git diff --check` 通过，shell 成品形状经 `/bin/sh` 复核可展开，隔离真 tmux 探针因受管 sandbox 禁止创建 socket（`Operation not permitted`）未能执行，因此 tmux 生命周期验证仍由计划中的 S5/S6 在实现期完成。

## What's Good (Keep)

- **R1-1 已闭环。** §2.2 把 `${VAR+"VAR=$VAR"}` 固定在 shell source 内，direct 与 gated 使用各自真实可执行形状；binary/args 继续只走位置参数，三种成品形状都要求真实执行测试。该设计与当前 gated `exec "$@"` 结构（`TmuxAdapter.ts:196-208`）正确对接。
- **R1-2 已闭环。** 实际入口已改为 `execute()`，`appendPaneEnv(name, value)` 同源生成 `new-window -e` 与 allowlist name-set；`FLYWHEEL_MARKER_DIR` 从 session env 迁到每窗显式注入，并加入无 hook server + 自定义目录的真实 child/hook 测试，修复了 `TmuxAdapter.ts:451-461` 与 SessionEnd fallback 之间的 compat 缺口。
- **R1-3 已闭环。** §2.3 正确区分 rescue 控制环境与 tmux create 出生环境：只在 `create_argv`/`guarded_create` 的实际 exec 上应用 canonical env，保留 `FLYWHEEL_TMUX_RESCUE_*`，并断言 `_TMUX_RESCUE_*` 不进入 server global env。TS birth seams 也明确要求 replace-not-merge，覆盖了当前 `TmuxAdapter` env merge 和 Codex TUI async spawn 无 env 参数的现实约束。
- **R1-4 已闭环。** scrub 范围现为 global + `flywheel` + 从 projects 精确派生的全部 sanitized `runner-*` sessions（与 `run-infra.ts:975` 一致）；prefix 先匹配 `show-environment` 读出的合法名字，再逐 exact name unset，不再假设 tmux 支持 glob。PATH、`${FLYWHEEL_STATE_DIR}/.env`、最早 `startBridge()` boot 挂点和并发 `new-window` 安全地板都已写清。
- **R1-5 已闭环。** 预算基线改为实测 955 bytes，并使用生产 envArgs 构造面覆盖 direct/gated、Kimi 最大值和长合法路径；现有 `assertLaunchCommandBudgets` 及 durable commit 前 fail-loud 契约得到保留。
- S7 从已知 `FLYWHEEL_MARKER_DIR` 消费者开始三态 sweep，S8 继续使用隔离假 home 与身份阳性对照，避免“测试名单自证名单”的假绿。
- 无新 flag、无新 timer、不为本单触发即时 Bridge 重启、已开 pane 不追溯修改等项目治理边界均保持不变。

## Issues & Recommendations

1. **无阻塞问题。** 非阻塞文档修正：§2.1 第 41 行仍写“本次 `startInteractive` 实际 push 的 `-e` 名字集合”，与 §1/S3 已纠正的实际入口 `execute()` 不一致；实现前顺手改为 `execute()` 即可，不影响本轮批准。

## Verdict

APPROVED — ready to implement
