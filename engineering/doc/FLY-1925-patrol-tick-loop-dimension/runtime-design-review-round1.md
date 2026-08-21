# FLY-1925 patrol_tick 名册加「圈」维度 — 运行时设计审查 R1
Issue: FLY-1925 (https://linear.app/geoforge3d/issue/FLY-1925/巡检tick-patrol-tick-名册加圈维度每-run-附当前节点棒持有者开圈状态-让有人在等不存在的圈直接印成红灯founder)
日期: 2026-08-20
基于: plan.md

## 结论

`CHANGES_REQUESTED`。阻塞项是采集位置:GatePoller 约每 60 秒调用
`runLeadPatrolTickPass`,若在 project 顶层预采集,会在约 59/60 次不 mint tick
的 pass 中同步扫库。

## 处置

| finding | 级别 | 处置 |
|---|---|---|
| patrol-loop-collection-runs-every-60s | HIGH | 已修 plan/research:采集下沉到每个 Lead 越过 roster-empty、due、settlement 等提前退出后、确定 mint 的分支;仅按该 Lead roster 查询;测试非 mint reader=0 |
| zero-run-red-no-terminal-run-exemption | MEDIUM | 保留 v1 无 run 红灯:这是「等待账存在但圈不存在」的账面不自洽;渲染明确写记录账龄与「账面自检,非 live 结论」 |
| wait-ledger-has-no-recency-signal | MEDIUM | 接纳:`first_seen_at` 只称记录账龄,不再表述为持续 live 等待时长 |
| rework-current-revision-filter-superfluous | MEDIUM | 接纳:delivery→request 按 run_id + 非 completed;不按 MAX revision 过滤;route 展示按 delivery.route_revision join |
| s1-suppresses-stale-activation-self-deadlock | MEDIUM | 接纳:新增 `W_self`;自指 wait 不独立触发红灯,但从 S1 actor 候选排除 |
| render-allowlist-constant-module-graph | LOW | 接纳:状态常量下沉 dependency-light leaf module,StateStore re-export,renderer 只 import leaf |
| per-lead-roster-vs-project-wide-waiters | LOW | 接纳:每次采集仅使用当前 Lead roster,不同 Lead waiter 不共享 |

修订后必须开新 design gate/request-review;旧 question 不复用。
