# FLY-2104 周扫描改投通知频道 — 探索
Issue: FLY-2104 (https://linear.app/geoforge3d/issue/FLY-2104/flage扫描-周扫描裁决页改发-discordflywheel-notification不再建-linear-单)
日期: 2026-08-27
基于: 无

## 问题重述

现有周扫描已经有 Sunday 08:00 `America/Los_Angeles` 调度、持久化 run/leg、Apple-light 裁决页和人工裁决合同，但三处实现与当前产品意图不一致：

1. `POST /api/flag-scan/run` 在 `startBridge()` 中追加，而 `createBridgeApp()` 已先追加兜底 404；Express 按注册顺序匹配，所以请求永远先得到 404。
2. 扫描把 `linear/report/discord` 三条腿冻进 run：先建 `flag 周扫描 · N 个候选` Linear issue，再把链接和报告 URL 发到 Flywheel Core。Annie 已明确不看 Linear；新落点是 `#flywheel-notification`。
3. FLY-1778 已把 `value_last_changed` 放进 `FlagView`，但 `computeFlagScan()` 只看相邻周快照和 `streak_started_at`，因此精确翻转时钟没有成为候选判据。

## 目标体验

- 人工 `POST` 能到达真实 scanner：非 dry-run 立即跑一轮；dry-run 仍零写；周日定时仍走原来的 due 判断。
- 有候选：一张浅色 HTML 裁决页通过既有 `publish-report` 管线投到 `#flywheel-notification`；频道里不再出现对应 Linear issue。
- 零候选：同频道只有一行“本周 0 候选”，不再静默。
- 页面继续逐 flag 留/清、批注、localStorage 与一键复制；扫描永不自动删 flag。
- 稳定天数优先来自 store 的值时钟；没有实际翻转时钟时，从首次登记时刻计算。项目值按 `(flag, scope)` 读取，当前单行 store 映射到 `scope='*'`，未来出现项目 scope 行后无需再改 scanner。

## 已核事实

| 事实 | 代码证据 | 结论 |
| --- | --- | --- |
| catch-all 先于 flag route | `plugin.ts` 的 catch-all 在 `createBridgeApp()` 尾部；flag route 在 `startBridge()` scanner 装配后 | 必须用 late-bound holder 在 catch-all 前挂路由 |
| 手动非 dry-run 只恢复 pending | handler 调 `recoverPending()` | “真跑一轮”需要独立 `runNow()`，不可复用 due-only/repair-only 语义 |
| 候选 run 固定欠 Linear | `owedLegs()` 总是返回 `linear/report/discord` | 新 run 必须只欠通知投递与必要的 Lead clock-debt 通知 |
| HTML 已有交互 | `renderFlagScanReport()` 含 textarea、localStorage、clipboard fallback | 保留并补真浏览器成功/失败路径验证 |
| publish-report 是 client-side 三段式 | publish → optional ProofShot → deliver | 周扫描运行时用 canonical CLI 的 `--no-screenshot` 模式，避免 Bridge 拥有浏览器生命周期；真浏览器截图作为 QA 证据单独产出 |
| store 时钟已在 view | `enrichFlagViewsWithStore()` 写 `valueLastChanged` / `clockReadiness` | scan pure logic 需要消费，而不是再造第二套值来源 |
| 当前 store 只按 flag 一行 | `flag_values(flag_name PRIMARY KEY, ...)` | 读时投影成 `scope='*'`；通过 schema capability 读取兼容未来 scoped rows |

## 明示假设

1. `FLYWHEEL_NOTIFY_CHANNEL` 是 FLY-2051 已建立的 notification channel 配置真相；代码不硬编码生产 channel id。缺失/非法时 fail loud，不回退 Core/Linear。
2. “通过 publish-report”指运行 canonical `flywheel-comm publish-report --channel ... --no-screenshot` 管线：仍由同一命令完成 hosted URL 与 `/api/reports/deliver`，但 Bridge 周任务不启动 ProofShot。验收所需浅色全页截图在 QA 阶段用真浏览器独立获取并附报告。
3. “逐项目按 `(flag, scope)`”的清理裁决仍以 flag 为一张卡；候选资格要求该 flag 的全部当前 scope 都稳定满 7 天，展示稳定时长取最短者。这样不会因为一个项目刚翻转就建议删除全局 flag。
4. 当前 schema 没有 `scope` 时，`*` 行适用于该 flag 的全部解析值；若未来 schema 有 `scope` 列，精确行优先，缺某个项目行时只允许显式 `*` fallback，不猜时钟。
5. `value_last_changed IS NULL` 仅在 store clock `ready` 时代表“自登记后未发生有效值变化”，稳定起点取该 row 的首次 changelog `seed`。`no_clock` 不信任 seed 单独证明稳定：沿用 scanner 两次采样，并取 `max(firstRegisteredAt, streakStartedAt)`，避免昨天翻转的 bypass/unmanaged 值继承陈旧 seed。
6. 历史 pending run 可能仍带 `linear/report` 腿。新 binary 不再调用 Linear create；旧腿只做本地 degraded settlement，随后在 notification channel 重新完成唯一 founder surface。
7. 裁决仍需回到工程消费链：候选 report 消息下创建 thread，@Engineering Lead 并等待既有 mailbox ACK；页面明确要求把复制结果贴回该 thread。零候选无需 thread。这里不再依赖 Flywheel Core。
8. notification sender 在每次 effect/reconcile 调用时使用 `resolveInfraNotifyIdentity()` 解析 `CLAUDE_INFRA_BOT_TOKEN + FLYWHEEL_NOTIFY_CHANNEL` 原子配置；缺任一项都通过既有 `alertFailure` fail loud，不回退 legacy Discord token，也不因 Bridge boot 时序永久休眠。
9. Engineering handoff 的 readiness 同时要求：Lead access `groups[notifyChannel]`、`allowBots` 含实际 infra sender、以及在 notification channel 真实完成 root→thread→in-thread probe后清理。mailbox ACK不替代 Discord channel membership。
10. 生产 access 配置由 Tadashi/值班 operator 在本单 QA/ship 前完成：Engineering Lead `access.json` 加 notification group与 Claude Infra Bot sender id。Engineer Runner只实现 fail-loud验证并回报 prerequisite，不越权修改 live channel config。

若后续代码证据推翻以上任一假设，先修订 plan 并重新走 design review，不在实现里静默换语义。

## 不做

- 不自动删除、retire 或改 registry flag。
- 不新增告警层；配置/投递失败继续走已有 `flag_scan_failed` / pending recovery。
- 不修改 production `.env`、不部署、不重启、不 merge。
- 不把裁决结果自动回传；页面仍明确要求复制后贴回 Discord。
- 不恢复或保留 Linear 裁决台账的新建路径。

## 探索结论

最小而完整的切片是：late-bound 路由 + 保留 kill switch 的 forced manual run；把候选 founder surface 收敛成一个 `discord` durable leg，由该腿异步执行 canonical publish-report、在消息下建立 Engineering handoff thread并等 ACK；零候选同腿发一行；历史 Linear/report 腿只退场；在 resolver→scan join 上增加 scope-aware store clock DTO，ready clock按最晚 stable-since、no-clock按安全的 legacy 两采样计算。定时入口、人工删除合同和现有失败告警不变。
