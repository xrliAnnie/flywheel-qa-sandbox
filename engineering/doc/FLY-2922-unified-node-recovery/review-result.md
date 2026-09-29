# FLY-2922 QA@3 返工计划 · 设计评审结果 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: plan.md

评审对象：本轮返工计划 plan.md（driver 房间 tmux 探活 + 与最新 main 同步），不是已批准的 held 统一恢复口产品设计（gate d9ab4f85 / plan c4d40fbed）。
Bridge design manifest：request `2be60b50-8afb-48ab-878a-09d60da19e62`，首版 plan blob `d623742f4ebfb55c7d6d2ef8edd5fe87c8b4782f`，reviewer=none（Bridge 未指定评审模型）。

## Codex 通道 — 不可用（如实记录）

Round 1 在 Codex thread `01a0eb6f-93c3-7d73-bcae-b2253f5fde83`（turn `01a0eb6f-9900-7050-8e19-369bae762fa5`）启动即失败：`You've hit your usage limit … try again at Oct 3rd, 2026`。`codex-profile list` 显示全部 6 个账号本周额度打满（最早 10-03 重置）。该 turn **没有产出任何评审**，因此**没有**用它提交 `review-round` 回执（那样会伪造 Codex 证据）。已向 Lead 提问 `e2a83119-0932-4e45-96bf-53bdb1ac5464`（codex-skip / 等重置 / 其它）。

## 独立 Claude 评审（真实评审，替代证据）

### Round 1 — CHANGES_REQUESTED（high 1 / medium 1 / low 5）

评审员逐项对照 PR 头 `7d5d084cf` 与 `origin/main` 只读核实：

1. HIGH — `origin/main` 已到 `23a1d80e8`，`git merge-tree` 显示新冲突在 `run-dispatcher.ts` / `run-infra.ts`（产品文件），计划的 C1 已过期。→ Rev 2 新增 C1′（显式参数顺序 + 调用点核对 + teamlead typecheck/build/vitest）。本节点亲自复跑 `git merge-tree` 确认。
2. MEDIUM — `pnpm -r --filter teamlead build` 匹配不到包（真实包名 `flywheel-teamlead`），空跑 exit 0。→ §4 修正（已核对 package.json）。
3–7. LOW — R5 冲突来源写错；C1–C4 已在 PR 头；step 4 超时无诊断；坏 slotDir 被 waitFor 吞；风险 1 措辞弱。→ 全部处置（第 7 条的静态守卫部分拒绝，理由见 plan §7）。

### Round 2 — APPROVED（critical 0 / high 0 / medium 1 / low 2）

对 Rev 2（提交 `0e708d674`）复审：C1′ 顺序（main 的 `workflowPrefixLookup` 在前、本分支 `initialStartObserver` 追加在后）正确——唯一生产构造点是 `run-infra.ts` 的 `new Dispatcher(...)`，测试调用点均不触及尾部参数，两者函数签名互斥、错位会被 `tsc` 拦下。非阻塞 3 条已折入 Rev 3：C4b 诊断不得作为 `waitFor` 返回值（否则假通过）；调用点 rg 模式修正并移出表格；点名 4 个 initial-start / recovery 测试文件。

## 结论与边界

- 计划本身经真实评审 **APPROVED**，可作为 implement 的依据。
- **系统门禁尚未满足**：`await-codex-gate` 要求 Codex rollout 证据，当前无法产生；是否以 codex-skip + 本 Claude 评审放行，由 Lead 裁决（问题 e2a83119）。本节点不自行伪造或绕过门禁。
