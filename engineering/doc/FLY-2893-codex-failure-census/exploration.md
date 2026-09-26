# FLY-2893 Codex 体为什么老出事 — 探索
Issue: FLY-2893 (https://linear.app/geoforge3d/issue/FLY-2893/调研修-codex-体为什么老出事近两周每次-codex-体死掉-换体-被判死按原因分类计数-各类浪费的时长与额度-前三类修掉)
日期: 2026-09-25
基于: 无

## 问题

founder（2026-09-25 15:19 PDT，FLY-2889 thread）注意到 Codex 节点出事多、重派多，要求查清原因并修掉。
FLY-2889 的实测：Sol 实现片段 202 段里有 122 段碰到过判死或换体。
本单第一步只做**只读调研**：给出近 14 天 Codex 体的「非正常结束」全量清单，按根因归类，算出每类浪费的时长和额度，
和 Claude 同口径对比，最后对排名前三的类各给一个修法建议。修复单由 Lead 另开。

## 已确认的事实（探索阶段只读查询）

窗口暂定为 `[2026-09-11T22:00Z, 2026-09-25T22:00Z)`，按 `workflow_execution_runtime.created_at` 圈执行体。

| 事实 | 数字 | 来源 |
|---|---|---|
| 窗口内 Codex 执行体 | 694（implement 为主） | `workflow_execution_runtime.vendor='codex'` |
| 窗口内 Claude 执行体 | 约 320（qa 为主） | 同上 |
| Codex `execution_dead_rolled_back`（引擎判死并回滚） | 390 | `workflow_run_event` |
| Claude 同类 | 23 | 同上 |
| Codex `session_failed`，failureKind 分布 | usageLimited 243 / 空 80 / reown_exhausted 46 / worktree_takeover_failed 45 / goal_blocked 38 | `session_events` |
| Claude `session_failed` | 7（worktree_takeover_failed 5） | 同上 |
| 能找到 rollout 的 Codex 执行体 | 613 / 694 | `~/.flywheel/state/codex-sessions/<exec>/session.json` → threadId → `rollout-*.jsonl` |

初步看到的现象：

1. **usageLimited 是成批出现的。** 按小时聚合，09-18 02Z 一小时 35 次、09-18 21Z 一小时 25 次、09-19 01Z 一小时 26 次、09-21 02Z 一小时 24 次。
   形状与 FLY-2371 一致：账号额度打满后，所有在飞的体同时死掉，引擎再盲换替身，替身起跑就死。
2. **Bridge 重启后 reown 失败**（reown_exhausted、「Codex recovery owner failed after commit」、turn reconciliation、keyed_home_reown_arm_mismatch 等）
   对应 FLY-2586 / FLY-2505 / FLY-2558 / FLY-2462 这一族。
3. **worktree_takeover_failed**：替身接不了前任留下的脏 worktree，对应 FLY-2510 / FLY-2463。Claude 也有 5 次，所以这一类不是 Codex 独有。
4. **goal_blocked** 的 lastError 里又能拆出几个子类：上游「Selected model is at capacity」（FLY-2630）、refresh token 失效、cyber 400（FLY-2743），
   其余是体自己报 blocked（可能对应 FLY-2344 / FLY-2507 这类）。
5. **failureKind 为空的 80 次**里能看到：`~/.codex/auth.json` ENOENT（16）、「Codex recovery owner failed after commit」（16）、
   「Child stdio did not close within 250ms」（12）、unknown Codex account identity（6）、codex agent home lease missing（4，FLY-2689）、
   GitResultChecker git 错误（6）。
6. **`actor_session_terminal:completed`（Codex 41 / Claude 12）不是体死了。** 抽样看到的都是：体已经正常交卷，
   ship 时 land 撞上合并冲突，引擎要重新激活 implement 节点，旧体已经是终态，只能换新体。它算「换体」，但不是故障，要单列出来，不能算进 Codex 出事率。
7. **FLY-2814（关掉后被 goal runtime 自动复活）在数据库里没有状态痕迹。** 复活的证据只在 Bridge 日志
   （`daemon died mid-goal — restart n/5`）里，而 `/tmp/flywheel-bridge.log*` 只保留大约 8 小时。
   14 天范围内只能用「终态之后 rollout 还在消耗 token」来间接检测。
8. 评审子进程（`codex_review_job`）失败的大多是 superseded / head_moved（正常作废）；真正算基础设施失败的是 nonzero_exit 8 次、no_verdict 6 次。

## 已知的病根子单（FLY-2072 下，Linear 只读查询）

与本单相关的子单：FLY-2371（额度满后盲换三具）、FLY-2521（自动切号从未部署完成）、FLY-2572（usageLimited 判死但 goal 自续）、
FLY-2586 / FLY-2505 / FLY-2558 / FLY-2352 / FLY-2462（重启后 reown）、FLY-2510 / FLY-2463（worktree 接管）、FLY-2630（模型满载）、
FLY-2743（cyber 400）、FLY-2814（关后复活）、FLY-2344（409 后自报 blocked）、FLY-2507（交接逾期后自报 blocked）、FLY-2477（park stale_boundary 杀体）、
FLY-2689（agent home lease missing）、FLY-2512（failed 体 TUI 仍挂 pane）、FLY-2618（僵尸探测误杀）、FLY-2537 / FLY-2710（停驻体 pane 消失）。

## 待定的口径问题（在 research / plan 里定）

- 「出事」的单位：按执行体算（每个体最多记一个主因），还是按事件算。计划按执行体算，事件放在明细里。
- 「浪费时长」的终点，也就是「下一个体真正接上」怎么判定。
- 「浪费额度」算什么：死体的全部消耗只能当上界，零产出体的消耗才是纯浪费，终态后的消耗算复活成本。
- 非故障的换体（land 冲突再激活）怎么和故障分开。
- Lead 手工终结卡住的体，怎么判定为「出事」。

## 约束

全程只读。数据库一律用 `sqlite3 file:...?mode=ro` 打开，Linear 只做 GraphQL 查询，不改任何生产数据，本机只跑调研脚本。
