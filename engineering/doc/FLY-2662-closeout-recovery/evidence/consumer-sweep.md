# FLY-2662 重收尾入口 — 消费面扫描证据
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662/land收尾死结-已合入的卡收尾永远停在半路thread-不归档linear-不-doneworktree-不清window)
日期: 2026-09-17
基于: plan.md

最终扫描时刻：`2026-09-18T00:28:51Z`。扫描头：`b4863130d360b61e392f837339c3e1decc9ac1af`。该头已合并 `origin/main` 的 `f01754584`，随后用 `git merge-tree --write-tree HEAD origin/main` 得到无冲突结果；最终 milestone 只追加交付说明，不改变消费面。

## 查询

对每个可用根目录分别执行精确字符串扫描：

- `flywheel-comm land reclose`
- `/api/lifecycle/land/`

扫描范围与处置：

| 范围 | 状态 | 结果与处置 |
|---|---|---|
| 主仓 `scripts/` | 已扫描 | 无 reclose CLI 或 lifecycle land resume 消费者。新增 sandbox replay 脚本只运行夹具测试，不调用 Bridge。 |
| 主仓 `packages/` | 已扫描 | 7 个命中文件全部属于 CLI、Bridge 的持久告警/dispatcher 及其测试；`flywheel-comm` CLI 是唯一 closeout-only 客户端，按 Claude native peer / Codex carrier 分流。Lifecycle route 是服务端入口。 |
| `workflow-engine-dispatcher.ts` | 已扫描 | closeout-only 告警已经给出 `flywheel-comm land reclose` 完整命令；full resume 告警保留 POST，因为它不是本单收紧的 closeout-only 能力。 |
| `StateStore.ts` 持久告警 | 已修正 | closeout held 文案不再指导直接 POST；要求读取精确 generation/head 后走 `flywheel-comm land reclose`。非 closeout held 的 full resume 文案保留。 |
| `/Users/xiaorongli/Dev/claude-plugins-official/external_plugins` | 根目录不存在 | 本机没有该插件 fork，无法扫描；未据此声称兼容。 |
| `/Users/xiaorongli/.claude/plugins/cache` | 已扫描 | 两个精确字符串均零命中，无需改动缓存副本。 |

## 结论

closeout-only 的外部恢复合同只有一个受支持正门：`flywheel-comm land reclose`。共享 master bearer 单独调用 HTTP resume 会被拒绝；保留的直接 POST 文案仅对应未改变的 full resume 合同。
