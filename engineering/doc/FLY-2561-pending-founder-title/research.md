# FLY-2561 待批标题 — 调研
Issue: FLY-2561 (https://linear.app/geoforge3d/issue/FLY-2561/thread标题-dag-流程下-ship-卡开着时-thread-标题不变待批仍显示-qaissue-display-只在-session)
日期: 2026-09-14
基于: exploration.md

证据：Lead 提供受管 StateStore 副本 FLY-2561__teamlead-global__2026-09-14T20:47:09.369Z__5feb89d7-b3de-4d0b-87ab-37e22f754fe9.db。源代码回放结果见 snapshot-replay.json。

| Issue | 卡完成 UTC | 成功刷新 UTC | 延迟 |
|---|---|---|---|
| FLY-2553 | 20:19:49.841 | 20:34:23.069 | 14m33s |
| FLY-2554 | 20:36:10.323 | 20:46:07.997 | 9m58s |
| FLY-2555 | 20:28:37.623 | 20:34:23.398 | 5m46s |

StateStore gate_opened/holder 事务与 plugin materializeQuestion 都未 enqueue，绕过 applyTransition。layer-2 池有 337 条，60 个 3s tick 才轮转 10 条，兜底无法及时反映 gate。成功 fingerprint 排除三单持续 reconnect deferral/写失败；/tmp/flywheel-bridge.log 有无 issue 标识的 404/timeout，不能归因于三单。启动 restore 和 runtime 无标题占用路径也反对永久重连假设。

Lead 已接受 (a)，response dd53344f-8d83-471b-b695-716b795a6969 要求仅补开/关门刷新，禁止改变 cadence 或 derive。
