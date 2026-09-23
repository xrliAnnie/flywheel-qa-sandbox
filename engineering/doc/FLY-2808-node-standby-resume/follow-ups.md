# FLY-2808 非阻塞评审建议 — 调研
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-22
基于: plan.md、review-receipt.json

有效 verdict=APPROVED（R2）。以下均是 reviewer 的非阻塞建议，完整 findingKey 和理由见 review-receipt.json。保留已批准 plan，不借收尾重开设计；交 FLY-2809 实现规划与独立 QA 处理，Lead 报告 receipt a9f3bf1e-748b-4106-9cd0-c8ba18015c95。

| 优先级 | findingKey | 后续建议 / 验收关注 |
|---|---|---|
| MEDIUM | sweep-scope-misses-core-and-claude-runner | 普查 root 扩至 packages/ + scripts/；包括 core/workflow-fsm、claude-runner/codex-home、keepalive_park、design_done 与 active/readopt 查询，逐消费者处置 |
| MEDIUM | stale-worktree-context-after-head-advance | 首轮工作前向恢复会话注入 lastObservedHead 到当前 HEAD 的提交/文件变化与 dirty 差异；验收其实际收到，而非只检查允许 HEAD 前移 |
| MEDIUM | single-issue-scope-vs-incremental-pr-landing | 一张 issue 不要求一个巨大 PR；可按工作包分默认关闭的 PR 落地，最终统一启用，遵循既有 ship/独立 updater 门禁 |
| LOW | pane-loss-reconcile-missing-from-closure-list | 纳入 pane-loss-reconcile，验收正常待命不产生 pane-loss / monitor-lost 提示 |
| LOW | carrier-term-collides-with-existing-ship-gate-carrier | 术语明确“进程载体”与 gate carrier 不同，避免读串；无需为命名扩展抽象 |

这些建议尚未实现、未做生产验证，不表示已被源代码修复。
