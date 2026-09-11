# FLY-2507 TURN 等待状态 — 调研
Issue: FLY-2507 (https://linear.app/geoforge3d/issue/FLY-2507)
日期: 2026-09-10
基于: exploration.md

调用链：index.ts runTurn → recordTurnCommandSideEffects → recordTurnWait → CommDB.observeTurnWait。现有后者把确定性 question 和 asked_at 放在同一个 SQLite immediate transaction，保证 reopen/replay 去重，须保留。

现有 verify-approval.ts 导出 resolveStateDbPath，支持 FLYWHEEL_STATE_DB_PATH / TEAMLEAD_DB_PATH / 默认路径；better-sqlite3 已安装，支持 readonly + fileMustExist。复用此路径规则，不添加网络端点、依赖或 CommDB 状态镜像。

StateStore workflow_execution_binding 将 execution_id 绑定 run/node/attempt；workflow_run 提供 current_node_id/status。three_stage_turn 的 target_run_id 可用于核对当前 TURN 与等待体属于同一 run。缺失/不一致/读取错误不应假装确认正常停驻；保留原有等待告警，并明确诊断。

现有 worktree-turn.test.ts 覆盖阈值、重开数据库、同 tuple 去重、新 holder/epoch、no-turn 清理、debug override。新增 StateStore 夹具覆盖真实表形状；不复制生产数据库。
