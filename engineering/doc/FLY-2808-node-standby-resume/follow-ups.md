# FLY-2808 非阻塞评审建议 — 调研
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-22
基于: plan.md、review-receipt.json

有效设计 verdict=APPROVED（R2）。Lead 后续授权本单直接实现；以下 disposition 只说明当前代码是否覆盖建议，完整 findingKey 和理由仍见 review-receipt.json。生产与真实 QA 证据仍未执行。

| 优先级 | findingKey | 后续建议 / 验收关注 |
|---|---|---|
| MEDIUM | sweep-scope-misses-core-and-claude-runner | 已覆盖 core adapter contract、Claude/Codex adapter、completion/rework、Heartbeat、pane loss、auto reowner、expiry、recipient 与 fault budget；validation 记录消费者搜索及排除项 |
| MEDIUM | stale-worktree-context-after-head-advance | 已实现 lastObservedHead/current HEAD/dirty 比对，并在恢复首轮 prompt 前注入重读提示；真实模型收到提示待独立 QA |
| MEDIUM | single-issue-scope-vs-incremental-pr-landing | Lead 明确要求当前一张 PR 完成完整默认关闭实现；仍保留小提交、独立 code review/QA，未获得 ship 权限 |
| LOW | pane-loss-reconcile-missing-from-closure-list | 已接线：confirmed standby 跳过 pane-loss/monitor-lost 误报，并有定向测试 |
| LOW | carrier-term-collides-with-existing-ship-gate-carrier | 实现采用 `process_body` / process lifecycle 命名，未引入新的裸 `carrier` 类型 |

以上“已覆盖”只指当前分支源代码和定向本地证明，不表示生产启用或 QA 通过。

## 实现 code review R2 disposition

旧 head `3f03ea22` 的 gate `0afda40e-8a35-4302-bbb2-7e6687293f06` 为 `CHANGES_REQUESTED`。三个 HIGH（共享工作树被重建、失败后孤儿进程、无 lease 的永久 resuming）与 substantive MEDIUM 已在后续代码提交修正，并由当前 code-head focused/related/build/typecheck 复核；必须对新的 exact head 再请求 review，旧 verdict 不可复用。

仍保留两项 LOW，避免为默认关闭路径提前引入新的 scheduler 抽象：

- 同 worktree 串行、跨 worktree 最大 2 的 admission/queue limiter 尚未实现；设计默认值保留给后续实现单。
- `queueMs` 仍是占位，`totalMs` 当前止于身份确认而非首个模型消费回执；需要后续定义并接入可审计 receipt。
