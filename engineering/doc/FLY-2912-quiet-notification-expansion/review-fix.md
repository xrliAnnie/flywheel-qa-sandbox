# FLY-2912 混合 ACK 批次修复 — 调研
Issue: FLY-2912
日期: 2026-09-26
基于: plan.md

评审 question e15008bc-08ef-4d8f-a0a5-fff8bbfeabae / request 92a917b3-d936-4262-948b-5c18df36e258 在 b5c884029 上 effective CHANGES_REQUESTED。本轮仅处理 HIGH `summary-freeze-rejects-mixed-leased-acked-batch`；历史回放结论与四类开关规则不变。

`claimQueueBatch` 为传输去重保留同一批次的 LEASED 和 ACKED 成员。异步重校验、adapter 返回前或丢失收据重试期间，单个任务可以通过合法 ACK 路径结清并清掉 claimed_by。原摘要 matcher 却要求每一行均 LEASED 且持有 owner，导致冻结失败，或传输已成功但记录收据时 lost_race。摘要准备位于 transport catch 中，使准备异常消耗实际消息的发送预算，最终普通任务 DEAD、founder 消息隔离。

修复只放宽已 ACK 成员的租约条件：仍要求当前 Bridge owner、完整成员顺序和数量、批次 attempt、Lead、model class/disposition、inbox carrier；仍 LEASED 的成员必须属于当前 owner。保留已 ACK 行及原内容，合法收据推进未结成员和摘要展示游标。若全部任务在发送过程中已 ACK，精确收据仍可原子接受已冻结摘要，返回 already_settled，不重新打开任务。

摘要准备移出传输失败计数区域。尚未调用 adapter 的冻结/owner 错误不消耗重试次数，恢复后可继续发送。已有的摘要源读取失败仍冻结空附件并发送原任务；无法安全持久化附件或失去 owner 时保持批次，不能删改此前可能送达的附件字节。真实 adapter 失败继续走原重试规则。

先红后绿：原代码的两个混合批次及全 ACK 收据用例失败；循环在重校验、adapter 返回和冻结重试三种时机失败，普通/Discord 准备失败耗尽预算。另一个首轮红是测试 fixture 使用了非法 carrier 值 direct，已纠正为 schema 合法的 external；不把该 fixture 错误计作产品缺陷。保留负向 owner、状态、attempt、class、carrier、disposition、跨 Lead、顺序、缺成员与原有 epoch/project/cursor/事务回滚守卫。准备失败测试还验证两次故障后原批次可恢复。

本轮验证命令、逐文件结果与完整输出将登记在 evidence/review-fix-verification.json 和压缩日志。消费者搜索及全部排除理由见 evidence/review-fix-selection.json；related 使用已审定相关文件白名单，不运行本机整包套件。无导出 API/type、SQL、schema 或迁移变化。

非阻断建议（原评审，尚未实现，待 Lead 选择后续）：

- MEDIUM `audit-summary-unbounded-archive-scans`：摘要生成中的归档扫描和同步查询成本。
- MEDIUM `monitoring-recovery-silenced-after-delivered-lost`：已投递 lost 之后的恢复通知可能仍被静默。
- LOW `stable-started-id-dedups-off-baseline`：稳定 started ID 在 OFF 下仍去重。
- LOW `registry-absent-on-appends-undelivered-model-row`：无 registry 的 ON 路径新增 pending model 行。
- LOW `summary-recovered-flag-sticky-and-title-missing`：recovered 标记持续及 issue_title 展示字段。

历史验收仍不完整：1,855 事件中 845 UNKNOWN（45.55%），1,010 条可重建 model→model；538 原生 turn 不是实际 idle→busy 证明，after wakes 为 null。Lead 63109e39 已确认无当日 producer 授权快照，完整来源与最小未来测量提案见 full-day-rework.md。不能用本轮摘要修复或测试通过替代该验收。

## 替身体续验（2026-09-26）

继承 Lead 原样提交的修复 `964b7e7e46ce88cda1555f3be83cc1037ef2a508`，重新取得 implement TURN，并确认 `origin/main` 已在本分支内。本轮没有重写修复或扩大产品范围。旧红灯日志仍保留；重新搜索 22 个路径/符号/新旧表达式，108 个既有测试匹配的选择不变，补记 6 个 fixture/helper 排除理由。

21 个具体测试文件逐个运行，共 336 passed。`fly2139-query-plans.test.ts` 首次遇到原有 5 秒超时；保持代码、超时、命令不变的单独复跑 2/2 通过，两份日志同时归档。lint exit 0（25 warnings），teamlead 及依赖 build exit 0；全天回放 12 个 Python 测试通过，重算结果与已提交 JSON 逐字一致。完整记录绑定源码 blob，见 `evidence/review-fix-verification.json` 及日志归档；本次没有请求 full CI 或执行本机全包测试。

受限 TypeScript related：comm 7 文件 / 124 passed；teamlead 8 文件 / 165 passed。收集检查确认配置仅包含 14 个不重复的 teamlead 候选文件；实际 related 根据改动依赖运行其中 8 个。related 与显式测试重叠，不相加。源码与测试 API/type 未变；构建覆盖受影响包及其依赖。
