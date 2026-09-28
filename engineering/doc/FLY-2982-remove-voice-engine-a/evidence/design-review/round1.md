# Design Review — plan.md (Round 1)

Date: 2026-09-27 / Author: Codex / Status: CHANGES REQUESTED

## Summary

删除方向可行，A 的现有主要入口、配置、投影消费者和直接 WebSocket 依赖均已覆盖；但当前计划有两处会使其规定的验证闸失败，需要先修订。

评审固定于分支 `flywheel-FLY-2982`、HEAD `93945882462f3989ebffa6d1e5a1eb8a815e41d1`；`plan.md` blob 为 `8b7102190bf6dd92b0a5fcd2add7fdab113c6d0d`。同时核对本地 `origin/main` (`55eab0862103202357fe461cba4920b70a5d5ea8`) 与 `origin/flywheel-FLY-2886` (`6ed39eb4bb9691d33adc09f09fa25f8dcfc77c86`)。这是设计评审，未实施删除或修改仓库文件。

## What's Good (Keep)

- T1 先放松 daemon 投影校验，T3 再让 Bridge 停发字段，顺序正确。`projection.ts:32` 目前确实要求 v2 声线；解析器返回原对象、不拒绝额外键，因此旧 saved projection 可以继续恢复。保留 `liveVoice` 可选与 `cove` 默认值符合 B 的现有契约。
- `ProjectConfig.ts:566` 附近已有原地剥离弃用字段的模式。静默移除旧键、取消旧值校验能避免旧配置阻断 Bridge；host configure 的后续写入同样删除旧键，范围合理。
- 保留 `RealtimeAudioOwner` 可避免修改四个共享消费者。已核实 B 的 Opus 路径和 PCM 拒绝逻辑，以及 2886 的 `close_snapshot` journal 使用。E1/E2 和生产不可用窗口均已有明确裁定，本轮不重开这些决策。
- `remove-retired-dist.mjs` 支持计划中的 manifest，且会处理四种产物扩展名；先清理、后 tsc 的接法符合 voice-core/voice-bridge 的现有模式。同一检出先旧树构建、再新树构建的证明有必要。
- 五个包名均正确；`ws@8.19.0` 与 `@types/ws@8.18.1` 在 lockfile 中仍有其他引用，限制本次 lockfile diff 为 voice-codex importer 是合理目标。未发现 CI 点名执行计划删除的 A 测试或认证脚本。
- wrapper 已有隔离 HOME、假 node、订阅凭据形状及钉版二进制夹具，足以承接 N7/N8。转换为 B 默认夹具时，应把目前第 272–288 行的凭据/二进制准备移到第一个 wrapper 调用之前，保留现有失败路径断言。

## Issues & Recommendations

1. **[HIGH] 残留检查会拒绝计划自身要求保留的清理代码和负向测试。**

   **位置：** `engineering/doc/FLY-2982-remove-voice-engine-a/plan.md:92–99`，关联 `:68`、`:82`、`:120–128`。

   **为什么：** T6 扫描所有非历史文档，包括生产代码和测试，并且只允许 `retired-outputs.json` 的墓碑行。然而 T3 必须新增 `delete (lead as Record<string, unknown>).realtimeVoice`，T5 必须保留 `delete lead.realtimeVoice`；N1/N3/N4/N5/N6/N7/N9 也必须显式输入或断言旧字段/标识。它们全部匹配 T6 的 PATTERN，无法同时满足这些要求和“任何其他命中 exit 1”。已用计划中的原始 ERE 验证两处 delete、N1、N3、N6 的代表行，均命中。即使 A 实现完全删除，§5 最后一道验收仍会失败。

   **修复：** 采用 FLY-2860 已有的“精确文件路径 + 受限行模式 + 类别/理由”白名单：除墓碑外，逐条放行旧键剥离和确切的负向夹具/断言；不得豁免整个测试目录或混合文件。自测同时证明合法清理/负向测试可通过，以及同一个已放行文件中新注入 A 入口/读取仍失败。同步修正 §0、research 合并指南中“仅一条白名单/零命中”的描述为“零未允许命中”。T6 的 API-key 残留表也需与已批准保留项一致，例如 T5 明确不改的 `install-voice-launchd.test.mjs:68` 占位夹具，不能一边保留、一边排除在允许类别之外。

2. **[HIGH] T4 在 T5 之前移除登记，必然破坏 T4 自己要求运行的漂移测试。**

   **位置：** `engineering/doc/FLY-2982-remove-voice-engine-a/plan.md:74–85`。

   **为什么：** commit 4 删除 `NON_FLAG_ALLOWLIST.FLYWHEEL_VOICE_BACKEND` 并要求 `feature-flags-drift.test.ts` 通过，但删除 QA 脚本读取被排到 commit 5。该中间版本仍包含 `scripts/qa/fly2655-voice-room.mjs:726`、`:735` 的 `process.env.FLYWHEEL_VOICE_BACKEND`。扫描器会收集根目录生产脚本（`packages/config/src/__tests__/drift-scan/index.ts:124–145`），识别属性读取（`:340–344`），并把失去登记/豁免的名字报告为 accounting violation（`:609–620`）；`feature-flags-drift.test.ts:710–727` 要求该列表为空。因此当前提交顺序无法通过其明确列出的测试闸。这是源码推导的中间提交失败，未声称运行了尚不存在的 commit 4。

   **修复：** 最简单是将 T4 登记删除并入 T5，与 wrapper/QA 的最后读取点在同一 commit 清除，然后运行两个 config 测试及脚本测试；也可先完成 T5 再删除登记。无需新增过渡选择器或修改 CI。更新提交表，明确最后一个消费者删除与登记收口的先后。

## Verdict

CHANGES REQUESTED。修正以上两项即可继续实施；无需扩大到 E1/E2、真房 QA、线上配置写入或 Linear 操作。

本轮独立验证：

- 执行计划原样 `git grep`：42 个文件、152 处命中，与盘点基线一致；补查导出符号、dist 动态路径、CLI 调用方和 CI 引用。
- `node --test scripts/__tests__/remove-retired-dist.test.mjs`：8/8 通过，exit 0。这验证现有清理器，尚不包含未来 voice-codex manifest。
- `bash scripts/__tests__/flywheel-voice-wrapper.test.sh`：40/40 通过，exit 0。这验证当前 A/B wrapper 基线，尚未验证 B-only 改动。
- 未运行 pnpm install、包 build、tsc、Vitest、full CI、未来 residue-check.sh 或新旧树 dist 实验。当前检出未安装 node_modules，且本轮没有实现代码；这些实施验收仍待执行。
- 未读取实际凭据、未调用真实语音服务、未修改 Linear、未重启或合并。仓库工作区保持干净；唯一交付文件为本反馈。
