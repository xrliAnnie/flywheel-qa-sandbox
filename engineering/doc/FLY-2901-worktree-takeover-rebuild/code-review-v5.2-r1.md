# FLY-2901 v5.2 当前头代码评审 — 实现复核
Issue: FLY-2901 (https://linear.app/geoforge3d/issue/FLY-2901/codex接管-替身接管工作目录失败worktree-takeover-failed-worktree-not-found)
日期: 2026-09-26
基于: plan.md、verification-v5.2.md

## 有效结论

- 执行体：`2935c975-32bb-4d97-b863-8010df5b9991`。
- 被评审 HEAD：`90798367ce9b08982ef95f2bd06ec0a01ce5a82f`。
- Gate：`3b9f62a0-5d78-4037-8fa4-2a03e1ae977b`。
- Request：`dbe55356-acb1-460c-8ca5-f49419fe65bd`，round 1。
- 服务端于 2026-09-26 09:23:32 UTC 投递：`reviewVerdict=CHANGES_REQUESTED`，`reviewerVerdict=CHANGES_REQUESTED`；1 HIGH、4 MEDIUM、2 LOW，无 settled finding。

这是当前实现执行体登记的跨模型正式评审，与旧执行体的历史代码评审轮次分开。旧头的评审不能证明后续修复头获批。

## HIGH：snapshot-status-stale-vs-fingerprint

根因位于 `registeredPresent()`：分类、嵌套仓检测和 `host.snapshot()` 使用入口时的 HEAD/status，但首次指纹在远端探测及忽略内容门之后才开始。此前窗口出现的新路径不在快照输入中；三次较晚的指纹仍可全部相等，随后 reset/clean 删除未保全的内容。

用真实 bare origin + linked worktree 在第一次 `ls-remote --heads` 时注入三种改动：原先干净的 tracked 文件变脏、新增 untracked 文件、HEAD 前移且保持原 status 路径列表。原源码 blob `e528134e040c52e94ca0649ab66c3cb607d713da` 对三例均错误返回 `rescued`，RED 3 failed / 1 positive passed，18.31 s。

最小修复提交 `5ee94bc5c`：首次指纹额外接收分类使用的 `{head, status}`，在该次指纹自己的读取结果与基线不同时返回 `worktree_unstable / classification_state_changed`，不生成快照、不推救援、不写事件、不清理。HEAD 的校验覆盖同一陈旧基线窗口，避免只比较路径列表而漏掉新提交。后两次指纹、manifest 格式、重入合同不变。

GREEN 4/4，13.40 s：三个拒绝用例逐项检查原 HEAD、index/worktree/untracked 字节仍在，且没有救援 ref 或事件；正向用例在探测期间改写一个已知脏路径，恢复救援快照后确认为最新字节。后者证明稳定性检查仍允许被快照与三次指纹完整覆盖的内容。

日志：`/tmp/fly2901-review-r1-red.log`、`/tmp/fly2901-review-r1-green.log`。更大范围的相关验证记录见 `verification-v5.2.md`。

## 非阻断建议

已通过 `ask --report` 向 Lead 报告，报告 ID `16589d1a-aa3f-44e8-b417-8653a496f72f`；未把建议自行扩为本轮实现范围。

| findingKey | 等级 | 内容与处置 |
|---|---|---|
| `entry-guards-regress-non-engine-callers` | MEDIUM | 非引擎调用者可能传分支名或缺 runId；交 Lead 决定后续兼容范围 |
| `fingerprint-unbounded-sync-reads` | MEDIUM | 指纹同步读取脏文件早于快照限额检查；交 Lead 决定资源边界修复 |
| `permit-same-run-only` | MEDIUM | 许可证只枚举同 run，但路径按 issue 共享；交 Lead 决定跨 run 普查范围 |
| `resume-no-branch-tip-recheck` | MEDIUM | missing/unregistered 崩溃重入未重新证明最新本地分支尖已覆盖；交 Lead 决定后续收紧 |
| `rescue-push-publishes-untracked` | LOW | 已批准的救援会发布所有非忽略 untracked 文件；交 Lead 决定后续文档或拒绝规则 |
| `tests_incomplete` | LOW | 评审者因 285 s 截止分组运行，v5.2 只跑完 29 条；作者原 related 运行已覆盖接管文件 89/89，本次修复再次运行相关验证 |

本轮结论仍是 CHANGES_REQUESTED；修复推送后必须对新的最终 HEAD 登记新 gate/request，取得有效通过结论后再交卷。
