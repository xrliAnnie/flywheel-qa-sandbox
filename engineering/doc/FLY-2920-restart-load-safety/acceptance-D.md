# FLY-2920 审查尝试退休 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

D 仍进行中；下列是已完成子批证据，不能代替完整端到端、不丢结果、当前头构建、有效评审或 QA。

## 持久化子批

StateStore additive migration 增加 attempt_generation/retired_at、复用绑定退休原因与来源代数、codex_review_attempt、review_recovery_notice。认领 CAS 加代数，所有异步写入口可带代数 fence；退休不答门、不自动排队，原预算与身份不可因重启续期。通知 delivery 与 acted 分开。缺原预算/身份的 legacy 一次转 operator_required，不编造新预算。现有 session-not-found fallback 的窄身份更换保留原预算。

子批 RED 7/7 缺功能失败；初始 GREEN 7退休 +49既有review +11稀疏迁移=67通过。加强后12退休通过，另保留 FLY1560 teardown7通过。子批 typecheck 曾通过（在最终 fallback 与后续修订前）；最终联合检查另行运行。

规格复核发现 follower 退休通知 (own R,source generation,stage) 与后续 own lane 初代冲突。新增回归在旧实现红（期望2，收到1），release 事务现在从已有 own-R 通知最高代数开始，下一认领不会重用旧键。修后13/13通过：`/tmp/fly2920-D-{follower-generation-red,store-final}.log`。

扫描排序保留原预算到期优先，未到期按 next_probe_at/request_id 推进持久游标。新增慢项公平性回归最终旧查询红、修后绿：`/tmp/fly2920-D-cursor-{red-final,green-final}.log`。此前 cursor-red/green 的夹具用了真实退休时间却查询更早时间，均失败，不能算该修复证据；最终夹具固定 retiredAt 后已重做。规格 blocker 已关闭，存储质量复核通过。

## 正在接线的上层

- coordinator boot/stop 两条原实现行为红，基本退休/停止 fence 两条绿：`/tmp/fly2920-D-coordinator-red-original.log`、`/tmp/fly2920-D-coordinator-green-initial.log`。最初 red 日志混入尚未完成的存储 API，已另用原始 StateStore 副本重做，不能将前者当全部行为红证据。
- CLI 新 checkWithReviewRecovery 保留同步 check 兼容；只有原 owner 的 pending review gate 查询认证 status，其他 gate 零 HTTP；网络/数据库失败仍 pending。真实隔离 HTTP +临时 CommDB 测试及既有 commands/completion-obligations 合计3文件59通过：`/tmp/fly2920-D-check-{red,green,regression}.log`。
- status 方法门绑定用例红/绿：`/tmp/fly2920-D-status-{red,green}.log`。生产 endpoint 已写，实际生产组合根 HTTP 接线验收仍待完成。
- 作者 gate-hold 通知消费、恢复 pass、身份探测与预算终止、同 R/Q 显式重发、端到端持久化证明及 prompt/snapshot 接线仍须全部完成。不得将本子批称为 D 完成。
