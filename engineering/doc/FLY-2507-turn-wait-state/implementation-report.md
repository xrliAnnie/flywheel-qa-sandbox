# FLY-2507 TURN 等待状态 — 实施验证
Issue: FLY-2507 (https://linear.app/geoforge3d/issue/FLY-2507)
日期: 2026-09-10
基于: plan-v3.md（含 Lead 修正）

实现：TURN 正式自查通过只读 StateStore 查询当前节点最新 attempt 的指定 execution。pending/admitted/running/review 且未结束的指定行动者仍会在超时后问 Lead；无当前行动责任的等待体将原因写入 turn_wait_ledger.suppressed_reason，不生成新问题。未知来源保留原告警。读取发生在 CommDB 写事务前，连接关闭后才更新 ledger。

CLI 复用现有路径解析并支持 --state-db；默认生产 CommDB 路径允许既有默认 StateStore，非默认组合须显式指定 StateStore。patrol 读取同一可选列，仅排除 aged redWaiters，blockedExecutionIds 和持有者异常判据保持。旧 readonly 库缺列以 NULL 读取；writer 幂等迁移，旧问题不撤回。无新表或依赖、无生产数据变更、无新增 shell 测试。

## 设计批准与范围

R2 request 098a7a65-8787-45cc-afdf-172aaae3ff78 APPROVED。R3 对 Lead 指定的 actor 方案指出遗漏 pending；Lead 问题 716044bd-f0cf-4fee-bc12-cf170331b7b5 明确授权以 R2 批准 + plan-v3 三条修正为实施基线，不开 R4。三条为 pending 纳入 acting、只过滤 redWaiters、suppressed_reason 可选列兼容。

## 验证回执

- TDD：非行动者仍问 Lead 的 ledger 测试 RED → GREEN；真实临时 SQLite + 命令链 RED → GREEN；patrol/投影 RED → GREEN；真实 CLI --state-db 从 unknown-option RED 到 GREEN。
- 最终相关测试 106 PASS：TURN 30，状态/CLI 24，CommDB patrol 4，patrol 判读 48。覆盖 pending 真交接、多 attempt、跨 run、unknown/缺行/读失败、founder_gate/land actor、completed/held/terminated、ended_at、重开数据库、恢复告警、debug override、路径隔离、迁移、旧 readonly 列兼容和 fingerprint 变化。
- pnpm lint exit 0（原有 warnings）；pnpm -r build exit 0。
- 第一次 pnpm test:packages:run exit 1：flywheel-comm 155 文件 PASS / 2 FAIL，2208 tests PASS / 45 FAIL / 2 skipped。44 visual-capture 共享锁失败，1 dependency 超时。日志 /tmp/FLY-2507-packages.log。
- 第二次相同全量命令 exit 1：同包 155 文件 PASS / 2 FAIL，2205 PASS / 48 FAIL / 2 skipped，仍为 visual-capture/依赖用例。日志 /tmp/FLY-2507-packages-rerun.log。全量命令在该包失败后退出，后续包不算已验证。
- 单独复核 visual-capture 65/65 PASS、dependency 42/42 PASS；失败文件相对基线零 diff，未改超时、断言，未删除共享锁或停止其它进程。日志 /tmp/FLY-2507-visual-recheck.log 与 /tmp/FLY-2507-dependency-recheck.log。

Lead 问题 c09fa970-3443-4ab3-8724-5bc1f2eed4bb / e51b82c7-233d-46cf-9ea0-4df7d2fb66f8 裁定宿主并发争用，停止任何本地包级重跑，保留完整红与单独绿，直接 PR/精确头代码审查。**精确头 CI 全绿才可 needs_review**。本地完整门未变绿。

codex:rescue companion 只读审查启动失败：sandbox helper exit 71，sandbox-exec sandbox_apply Operation not permitted；无审查 verdict。按 runner contract 使用 Bridge cross-family request-review，待 PR 头冻结后登记。

## 回退与剩余门

旧程序忽略可选列，可回退代码而无需删列；保持既有 ledger/问题历史。纯后台变更，未做生产部署或真实 host 巡检证明；独立 QA 尚未执行。此报告不代表 code review/CI/QA 已通过。
