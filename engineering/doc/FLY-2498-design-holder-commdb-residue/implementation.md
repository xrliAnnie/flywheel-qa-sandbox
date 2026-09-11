# FLY-2498 设计持有者注册残留 — 实施记录
Issue: FLY-2498 (https://linear.app/geoforge3d/issue/FLY-2498/病根-eng-design-交接后-bridge-会话已-completedcommdb-sessions-行仍-statusrunning)
日期: 2026-09-11
基于: plan.md

实现两条已批准路径：close-tmux 在杀窗成功、daemon 已收或缺席、StateStore 可删终态时调用既有 `finalizePaneLossResidue`；boot/hourly 与 fast-path reconcile 为 parked 体增加独立执行缺席证明。精确目标 CAS 和 TURN 否决仍在原子事务内；不改交接时的 running/phase-keep-alive 合同、不改巡检过滤、不改 schema。

Lead 裁定 `7a98f7c2-7624-43e8-be2d-70f99d8f0b84` 确认：generic recovery 的 discovered-marker dead-pane 分支缺少 host 检查，因此新探针独立要求 daemon absent、marker missing、host absent；generic recovery 不改。marker found（包括 dead pane）与任何不确定/错误都返回 unknown。复用 reconcile 常量的直接循环依赖在真实路由测试复现 `AUTO_CLOSE_STATES is not iterable`，采用裁定允许的无依赖 `commdb-deletable-states.ts`，reconcile 原出口保留。

TDD 证据（本机 `/tmp/fly2498-*.log`）：

- decision：16 个新用例先因导出不存在失败；实现后 46/46 通过。
- finalize：5 个新用例先因导出不存在失败；实现后 51/51 通过。验证 aged ask 退账、目标漂移、TURN、事务回滚、无库、重放。既有 ask 15 分钟保护期不改。
- real close-tmux route：5 红、2 既有守卫绿；接线后 7/7 通过，使用真实 StateStore、真实临时 CommDB、真实 HTTP handler，仅 mock 宿主销毁动作。审计异常不抹掉成功清理结果。
- parked reconcile：新增缺席覆盖先红；通过后覆盖 alive/unknown/throw、目标/TURN 竞争、lookup 错误、preserve/orphan 边界、重开库和 replay。
- absence probe：12 红后 12 绿；实际 marker/host/daemon 依赖均注入，不能据此宣称生产宿主验收。
- 方案集中回归：8 个文件，124 tests PASS。计划中 `commdb-fsm-reconcile.test.ts` 实际位于 `src/__tests__/`，按实际路径运行。
- `pnpm lint` PASS（既有 warnings）；`pnpm -r build` PASS。

完整 `pnpm test:packages:run` 与 patrol shell 回归另行运行；最终退出码和 exact-head CI / 评审由 PR 与 Lead 报告记录，不以集中回归替代。无新增 shell 测试。A1–A6 的实际宿主/phase wake/巡检验收归 QA 节点，当前测试不宣称已覆盖生产。无生产数据库修改、无服务重启、无合并部署。

无 schema 迁移；部署后沿既有 boot/hourly 清扫节奏处理存量。回滚本 PR 恢复旧逻辑，已被原有事务原语清理的行无需恢复。
