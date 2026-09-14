# FLY-2548 sleep 子进程归因 — 探索
Issue: FLY-2548 (https://linear.app/geoforge3d/issue/FLY-2548/flake-bridge-event-loop-guardtestts540-sigkill-子进程归因在-ci-teamlead3)
日期: 2026-09-14
基于: 无

范围仅 packages/teamlead/src/__tests__/bridge-event-loop-guard.test.ts 及其测试夹具/清理逻辑；不改生产代码、不放宽断言、不新增 skip。注入任务中的 bridge/__tests__ 路径有误，当前真实路径如上。

当前基线 14866f7e5：工作树干净，无上游 FLY-2548 文档。TURN implement epoch=1 已获得。原文件隔离 17/17 PASS，命令 `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/bridge-event-loop-guard.test.ts`，原始回执 /tmp/FLY-2548-baseline.log。

验收：本地先红后绿与连续 20 次；最终同一 HEAD 相关 CI 分片连续两次绿色；全仓 lint/build/test gates 留真实回执；台账及里程碑与最后代码同推，review 后不推文档。
