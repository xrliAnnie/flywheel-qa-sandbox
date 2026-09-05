# FLY-2339 三段有界维护 — 设计修正

Issue: FLY-2339 (https://linear.app/geoforge3d/issue/FLY-2339/引擎urgent-2331-之后-eventloopguard-第二层凶手维护-tick-里同步跑的-delivery)
日期: 2026-09-04
基于: plan.md

## 新证据

原计划送审后，生产 loop guard 在 `2026-09-04T20:13:27.496Z` 首次记录
`last_sync_op=delivery-contract:projector`，`stall_age_ms=64303`；随后
`2026-09-04T20:29:17.228Z` 又记录 projector stall `63041ms`。这证明同一
maintenance tick 的 projector 与 watch 都会单段跨过 60s 阈值，不能把
修复或验收缩到 watch。

## 对 plan.md 的锁定增量

`plan.md` 已要求 projector/watch/operations 三段分别按最多 64 个对象分页，
每页 marker 后 `yieldToEventLoop()`。本修正把性能验收进一步锁死：

- 三段分别测试；任何一段都不能再以一次 marker 包住无界历史扫描。
- 每个同步页目标为数百毫秒；三段各自在生产快照上的完整 drain `<1s` 是优化
  目标，不是本单阻塞判据。阻塞判据是最大同步页为数百毫秒、页间真 yield、cursor
  严格前进、总页数有硬上限。
- 除 4,271-row watch fixture 的 `<1s` 回归外，projector 与 operations 也各有
  大于一页的 fixture、逐页 `<=64`、完整 drain `<1s` 与不丢语义断言。
- production snapshot 记录三段各自的最大页、完整 drain、处理行数与前后耗时；
  projector 前值补记 loop-guard 的 64.303s/63.041s 直接证据。
- `COUNT(DISTINCT batch_id)` 仍必须从逐 attempt 的历史扫描降为 recipient-indexed
  O(1) lookup；不得用扩大 tick、提高 guard 阈值或新增告警代替。

其余实施边界、状态机语义、TDD 顺序和交付流程完全沿用 `plan.md`。

## 设计审查第 1 轮修正

第 1 轮审查指出“每页返回 64 行”本身不足以证明 SQL 有界。计划因此改为：

- live attempt 用 `root_id` keyset，open episode 用 `(root_id, family)` keyset，
  pending operation 用 `operation_id` keyset；三者分别由只含待处理行的 partial index
  支撑，并加入 StateStore EQP 门。
- drain 同时检查 cursor 严格前进与 10,000 页硬上限，违约即终止本轮并走现有 warning。
- operations 前置 lane 异常时仍执行一次 capped stalled scan；open episode 用真库
  超页 fixture 验证 cursor 与排序一致。
- projector continuation 明确携带 `activeSources`；watch 的 point getter 继续应用
  72 小时终态 cutoff，保持现有观察语义。
- CommDB EQP 门改钉生产实际 point projection SQL；部署观察补记首次建索引期间
  不出现 `SQLITE_BUSY`。

第 2 轮审查进一步把 `activeSources` 收敛为 projector 实例内的一轮 drain 缓存：cursor
只保留位置，首次无 cursor 调用清空缓存，既不放大 cursor，也不把上一轮活动状态泄漏到
下一轮。

## Lead 性能验收裁定

Lead 对生产快照结果裁定：projector 的完整异步 drain 2.509s 不阻塞本单，不再为凑
`<1s` 增加机制。验收以 projector/watch/operations 最大同步页分别 181.6ms / 97.7ms /
201.3ms，加上页间真 yield、cursor 严格前进和 10,000 页硬上限为准。

projector 页数不是常数：候选对象为 `N` 时约为 `ceil(N / 64)`（另有 lane 边界的空余预算
转移），当前 3,662 行对应 59 页；10,000 页上限把单轮最多工作量限制在 640,000 个
对象以内，超限会 fail closed，绝不无限占用 maintenance tick。
