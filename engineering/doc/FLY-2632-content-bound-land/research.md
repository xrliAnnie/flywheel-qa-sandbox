# FLY-2632 批准绑内容 — 调研
Issue: FLY-2632 (https://linear.app/geoforge3d/issue/FLY-2632/land批准绑内容-founder-按卡后引擎自动-rebase-到最新-mainci复审通过且非冲突-hunk-逐字不变即沿用原批准直接)
日期: 2026-09-16
基于: exploration.md

## 结论
采用既有 carryover 权威链的第二版内容证明；把并行准备、精确头验证与最终写 main 分开。现有代码不是从零开始：已有不可变沿用凭据、隔离 Git 证明、出发前 founder 输入截点、冲突返工和仓库 admission。必须同步更新这些消费者，不能只加一个哈希字段。

## 已核对的源代码（基线 b2f0c3e61）
| 位置 | 已证实行为 | 设计影响 |
|---|---|---|
| packages/teamlead/src/bridge/land-head-refresh-proof.ts:45–208 | clean_base_merge_tree_identity 校验双亲、受控 merge-tree 及完整 tree OID；自建 bare clone 隔离工作区配置 | 扩展为逐字内容证明；保留 clean proof 与完整树保护 |
| packages/teamlead/src/StateStore.ts:27874 | carryover receipt schema 对 proof kind 有 CHECK | additive v2 migration 不能只改 TS union |
| packages/teamlead/src/StateStore.ts:43646 | 当前 engine conflict cycle limit 为 3 | 新自动同步轮次共用上限，不因重启或新 operation 清零 |
| packages/teamlead/src/StateStore.ts:43700 | already_open 以 run_id 查 delivery / verification path | 保留同 run 防重，跨 run 不共享该锁 |
| packages/teamlead/src/StateStore.ts:43802 | 当前返工 revoke claims、supersede gate/ship binding、回 implement | 新冲突专用准备不能先毁掉要沿用的 founder 根；失败才走旧路径 |
| packages/teamlead/src/StateStore.ts:63799 | resolveEngineWorkflowShipClaims 的 carryover ship prerequisites 当前回查原头 | v2 review 必须新头，QA 分 carry/rerun，不能全部回根 |
| packages/teamlead/src/StateStore.ts:73549 | claimLandOperation 同时获得 project/__main__ admission | 拆 operation lease 与 merge admission |
| packages/teamlead/src/bridge/land-executor.ts:963 | 所有动作前 claim operation | 并行准备不能被仓库 admission 阻塞 |
| packages/teamlead/src/bridge/land-executor.ts:615 | cycle limit 直接 release held | 改为同事务写 outbox escalation、再 held |
| packages/teamlead/src/bridge/plugin.ts:11055 | land tick 已 Promise.all | 不重写通用调度；引入有界准备任务及每 PR lease |
| .github/workflows/ship-on-comment.yml:14,112,123 | workflow 并发组按 PR；内部等 CI，再用 sha 做 squash merge | 最终合入要 repo 级串行，CI 不占该锁；workflow 也必须持有可校验 ticket |
| packages/teamlead/lead-rules-base/founder-only-authority.md:72 | founder 当前、issue-bound 授权 | 沿用只证明她原来的授权，不铸新 founder 身份 |

## 证据模型
A=原 founder 批准头，M=批准时 merge-base，B=本轮 main，P=本轮准备前头，C=准备后头。新头内容比较使用 B..C，原指纹 M..A。任何新头 head CI/review/QA evidence 都绑定 C，不可把 A 的 review 改标成 C。
文件名、文件模式、增删状态属于批准内容；换行、空白、EOF 无换行也属于字节内容。行号与上下文位移不属于内容。仅 hunk hash 的集合不够：重复 hunk、交换位置、同样字节移到另一函数必须靠受控三方合并结果的保护区映射拦住。

## 冲突区研究与取舍
Git merge-tree 提供冲突文件和 stage objects，但“冲突文件”不是可信的 hunk 白名单。对普通文本，需要在受控三方合并中生成精确冲突片段和保护片段，冻结后交返工体。比较最终完整树：无冲突文件必须等于机械合并结果，冲突文件中保护片段必须逐字保持且匹配唯一；只有服务器预先冻结的槽位可替换。不同位置的同样片段若不能唯一映射，不能猜。
结构性冲突（rename/delete、目录/文件、binary、symlink/submodule）、外部 merge driver、多个 merge-base、超限输入、无法唯一映射等不能证明时回现有流程。普通文本 plugin.ts 冲突必须支持，不能以“不支持冲突”替代本单。
每轮从原批准 A 与新 B 重新计算许可冲突面；不接受返工体提供的 mask，不用上轮改动扩大例外。

## 外部一手依据
- Git merge-tree 文档：https://git-scm.com/docs/git-merge-tree 。冲突状态仍返回树与 stage 信息；错误与冲突必须区分；不能把非零退出全部当成有冲突。
- Git patch-id 文档：https://git-scm.com/docs/git-patch-id 。stable 会忽略空白，verbatim 才保留；本任务采用明确版本的 SHA-256 hunk 字节格式和文件结构，避免默认值含糊。
以上是工具语义依据，不是本任务完成或生产安全证明。

## 测试落点
沿用 StateStore.land-carryover.test.ts、StateStore.land-lifecycle.test.ts、StateStore.land-recovery.test.ts、bridge/__tests__/land-head-refresh-proof.test.ts、land-executor.test.ts、land-merge-driver.test.ts；新增内容证明、准备并发、最终 merge ticket、事故重放 fixture。临时 bare Git fixture 提供真正对象与恶意 tree，不只 stub 一个 true。

## 未验证与下游责任
本轮仅静态审计和设计，不声称 2519/2606/2616 生产重放或新功能跑通。下游 QA 在隔离副本复现提供的三张形状，记录每个 PR 的原批准、准备时间、新头 CI/review/QA、merge 互斥区间及零重按。七组具体回归在 plan.md，逐项红→绿。已向 Lead 报告互斥的 run/repo 区别。

## 复审后的外部语义核验（2026-09-16）
GitHub 当前文档区分默认 `queue: single`（只有一个 pending，新任务替换旧 pending）与显式 `queue: max`（最多 100 个 pending，溢出仍会取消）。本计划尚未指定 queue，所以 reviewer 对默认队列的反例成立；不能把它推广为 GitHub 永远不支持多条等待。实施可显式选 queue:max + cancel-in-progress:false 减少取消，但 Bridge 持久排队、cancelled 对账及最终版本/授权校验仍需完成。文档中的排队按进入等待时间排序，不承诺按最初 dispatch 次序。
一手依据：[GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)；[2026-05-07 larger queues changelog](https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/)。这是文档核验，不是本项目 workflow 实测。
