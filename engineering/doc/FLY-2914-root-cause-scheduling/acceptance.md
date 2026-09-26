# FLY-2914 病根排修闭环 — 实施验收
Issue: FLY-2914 (https://linear.app/geoforge3d/issue/FLY-2914/巡检闭环-6-巡检每轮自动列出病根类别出现-3-次且没有修复单在跑-lead-必须呈报-founder-排修让巡检发现的问题变成自动机制)
日期: 2026-09-26
基于: plan.md

## 真实数据一次运行（只读）
- 观测 2026-09-26T07:15:09Z：FLY-2072 直接子单 221 张、3 页完整分页（含 archived）；12 张非类别管理单。
- 待排修候选 59 个（按次数降序；52 个计数可读 ≥3，7 个计数不可读仍列出）。明细见 `acceptance-live.json`。
- **FLY-2373 当前有 active run `110e738b-87ff-4332-91a4-a29be96018be`，按验收条件「直到它有 run」被排除**，
  以 `ROOT_CAUSE_EXCLUDED reason=active_run` 可见，标题 34 / 描述 31 的差异照样保留。无 run 时入选且取 34
  由单测 `patrol-root-causes.test.ts` 在去敏的同批真实数据上证明。FLY-2906 同样因 active run 排除。
- 计数差异（取大值并报告）：FLY-2371 14/13、FLY-2344 8/7、FLY-2098 3/2，与设计盘点一致。
- 读取方式：生产 Bridge 尚未部署新路由，所以本次用同一 collector（编译产物）+ 只读 GraphQL + `teamlead.db`
  只读句柄的两条参数化 SELECT，再经 `--root-cause-facts` 喂给真实 `lead-patrol-snapshot.sh`（隔离 state 目录，
  不写 Lead 真实报告目录）。部署后 QA 应以 `flywheel-patrol-snapshot --project flywheel --lead flywheel-eng-lead`
  经 Bridge 路由复跑一次。

## 完成门（同一份真实报告）
| 场景 | 结果 |
|---|---|
| 59 个候选、零处置 | `root_cause_disposition_missing`，门不过 |
| 59 个全部写合规 `scheduled` | 通过（结构 + fresh 复核） |
| 删掉一个候选及其处置 | `root_cause_digest_mismatch`，门不过 |
| 快照后 fresh 数据出现新类别 | `root_cause_snapshot_stale`，门不过 |
| 自述 askId/messageId 冒充 `reported` | `root_cause_ask_unbound`，门不过 |

## 与设计的差异（实施中发现，已写进 runbook）
- 真实数据里出现 10 张 founder 9-25 拍板后新建的「[病根·修复 #N]」修复单（FLY-2919…2928），无计数、无 class_key。
  按计划字面规则它们会被当成「计数不可读的类别」列成待排修，属误报；实现改为 `ROOT_CAUSE_EXCLUDED reason=repair_ticket`，
  可见、不静默丢弃。「[病根→修复]」等带计数或 class_key 的单仍按类别处理。
- 采纳的 advisory（已报 Lead，未获相反裁定）：OFF 规则源同步、并发采集不挤占 helper 预算、alias 感知 active run、
  数据源不可用时 STEP 6 以 `root_cause_source_unavailable` 定稿且不走 `[patrol-unavailable]` 建单、
  waiting_founder 自动预填、scheduled 最长 7 天且未过期自动沿用。未实现（留 follow-up）：每轮呈报预算/聚合消息、
  Bridge judgment 传输分批、修复单关联展示、unknown 预留行的终态恢复。
