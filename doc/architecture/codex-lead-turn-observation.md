# FLY-2362 Codex Lead turn 观测边界 — 调研
Issue: FLY-2362 (https://linear.app/geoforge3d/issue/FLY-2362)
日期: 2026-09-13
基于: ../../engineering/doc/FLY-2239-codex-lead-cutover/research.md

TUI 是界面载体，不等同于所有 turn 都由 `/goal` 发起。现有 router/executor 路径有 turn 级观测，不能删除它的 stall 判定。

| 路径 | 现有信号 | 巡逻覆盖 |
|---|---|---|
| `LeadInputRouter.pump → CodexTurnExecutor.startTurn`（包括 legacy gateway、xdept、inbox submitBatch） | executor 调用 `turnStarted` / `turnFinished`；observer 写 `turn_started` / `turn_completed` / `turn_failed`，更新 `activeTurn` / `lastTurn` | `turn_stalled` 保留，默认30分钟；通过既有连败门和身份守卫才可恢复 |
| TUI 自主 `/goal` 发起、未由 sidecar 注册的 turn | demux 将未注册 turn 交给 `toObserver`，完成时可记 founder journal observation；不会调用 residency lifecycle hook | 没有 residency turn 级 stall 观测；正常 poll/heartbeat 不能证明这条 turn 正常 |
| gateway poll / observer heartbeat | poll attempt/result、heartbeat updatedAt | `poll_loop_stalled` / `heartbeat_stalled` 保留；不是 `/goal` turn 的替代判据 |

## 只读反证

2026-09-13 读取 `/Users/xiaorongli/.flywheel/state/codex-lead/mufasa-lead/brain/lifecycle.jsonl`，只统计事件名及时间，不读取或发布消息内容：

- `turn_started`: 106；最早2026-09-03T07:07:02.954Z，最近2026-09-13T18:00:56.005Z。
- `turn_completed`: 15；`turn_failed`: 91。
- 这些计数证明 observer 实际有 turn 生产者；没有证明 `/goal` 的 turn 已接入，亦不是本 PR 的生产验证。

FLY-2239 的零命中样本不能推广为整个 TUI runtime 的结构性不可达。本单最初删除方案由 Lead 在 `e896e105-af0a-44d5-8a7b-9bce4b96f893` 撤回；运行时代码、字段、阈值及配置恢复原样。读写两端不改 schema，原删除方案的升级偏斜问题随恢复消失。

## 为什么不直接补现有 hook

`CodexTurnExecutor.startTurn` 只在它主动发起的 RPC 返回 turnId 后调用 start hook；自主 `/goal` turn 不经过该方法。`TurnDemux` 刻意将未注册 turn 与 executor 隔离，防止错误认领与 Discord outbound。现有 foreign callback 只处理完成观察，不能作为可靠的开始/结束配对。

可靠接入需要独立被动观测：核实通知/rollout 可用性、thread/generation 归属、attach 时已经运行的 turn，以及重复/迟到事件不能覆盖或清除 executor turn。不能仅复用一个 start hook 就声称完成这些边界；超过本单授权的小改范围。

后续单：[FLY-2540 — TUI 自主 /goal turn 被动生命周期与 stall 对照](https://linear.app/geoforge3d/issue/FLY-2540)。它要求人为阻断 `/goal` turn 后在阈值内变红一次、正常 turn 零误报，并保留 executor 覆盖与所有权隔离。本单不自动派发、不操作生产 turn。

## 可执行对照

现有 `resident-codex-lead-patrol.test.ts` 的 stale activeTurn 用例必须判 `turn_stalled`；poll/heartbeat 故障分别变红。`CodexTurnExecutor.test.ts` 验证 start/finish hook，`codex-lead-tui-runtime.test.ts` 验证 foreign turn 不进入 executor facade。这些证明当前边界，不能作为 `/goal` 已覆盖的验收。
