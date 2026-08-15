# Design Review — FLY-1771 plan.md (Round 1)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确且改动面足够小：slot 判据可以消除 settlement latency 的逐轮相位累积，并保住 FLY-1687 的 mailbox 三态、单条在途封顶和 late-settlement 不双发合同。源码核验发现 Bridge 重启语义与计划矩阵不一致，且单测与生产验收都还不能证明“N 个连续 slot 没有漏拍”；这些属于 founder 直令验收面的缺口，需先补计划。本 worktree 缺少可用的 `vitest` 命令，因此本轮未把测试执行当作通过证据。

## What's Good (Keep)

- 根因与调用链核对无误：唯一 producer 在 `packages/teamlead/src/bridge/patrol-tick.ts:120-254`，由 `gate-poller.ts:676-687` 的现有 20 × 3s rider 驱动，`plugin.ts:7379-7430` 完成生产接线；没有理由新增 timer、flag、schema 或配置旋钮。
- `prevSlotStart < currentSlotStart && anchorMs < currentSlotStart` 在稳态会于下一墙钟 slot 触发；对 FLY-1687 的关键场景也正确：02:00 tick 到 05:37 才结算时，05:38 被 settlement 否决，06:00 恢复，不会一分钟内双发。
- 计划保持了真实的投递合同：`absent_identity` 继续重投 durable winner，live `QUEUED/LEASED` 继续封顶一条在途，live/archived `ACKED/DEAD` 继续按已结算处理。新解析明确放在这些早退之后，不会破坏 crash-gap redrive 或 in-flight cap。
- `scheduled_at?: string` 是 `HookPayload` 的兼容扩展；既有 `generated_at` 可作为 actual fire time，`formatPatrolTick()` 不消费这两个字段，因此正文和两条 runtime 的共享 renderer 可以保持字节不变。
- legacy `generated_at` fallback、genesis、60→30 / 60→120 热调、坏 payload fail-loud 和 RED→GREEN 顺序均有明确落点，整体 blast radius 与简单性铁律一致。

## Issues & Recommendations

1. **Bridge 重启合同与所提公式矛盾。** `plan.md:94` 写“重启后下一 slot 边界发一拍”，但公式对“上一拍 scheduled 02:00、02:03 已结算、Bridge 05:30 重启”会立即判 due：`prevSlot=02:00 < currentSlot=05:00` 且 `02:03 < 05:00`，于是生成 `scheduled_at=05:00 / generated_at=05:30` 的离锚 tick。相同形状也会发生在 roster 长时间为空后于 slot 中途重新出现，以及某些 legacy 升级/interval 缩短场景；所以当前行为更准确地说是“每 slot 至多一次，并在首次观察到未服务的当前 slot 时 catch up”，不是严格的 cron edge trigger。建议先做一个明确裁定并锁测：若接受一次性 mid-slot catch-up，就修正矩阵 #12、scope/风险和生产观察窗，并新增 05:30 重启与 roster re-entry 用例；若要求只在边界发，则需修改 due 门而不能宣称现公式已满足。优先采用前者以避免新增 timer/状态机，但必须诚实记录例外。

2. **12 小时漂移测试可能在漏拍时仍然通过，尚未满足“N 个连续 ticks”直令。** `plan.md:101-106` 只对实际发出的行检查 modulo、slot 对齐和 `actual-scheduled`；一个每两小时才发一次、甚至只发一拍的错误实现仍可让所有这些断言为绿。建议明确 `N`（例如排除 genesis 后恰好 12 拍），并同时断言：发出数量等于 N、相邻 `scheduled_at` 恰差一个 `intervalMs`、每拍 `generated_at - scheduled_at ∈ [0, 60_000]`。这样既证明相位不漂，也证明没有跳 slot/重复 slot；RED 阶段还应确认现行 settlement-anchor 公式因相位累积而红，而非因数量/harness 错误而红。

3. **生产 6 小时验收查询不足以形成连续链证据。** `research.md:97-104` 的全局 `ORDER BY seq DESC LIMIT 20` 在约 14 个 Lead 同时于整点发拍时可能只覆盖不到两小时，也没有按 `(lead_id, session_key)` 排序验证 slot 连续性；它还未说明 genesis、mid-slot restart catch-up 或热调拍是否属于观察窗。建议在 plan 中给出可执行的 per-chain/partitioned SQL（或明确选定一个连续有 roster 的 Lead），验证至少 6 个相邻 `scheduled_at` 每次正好 +1h，且每行 `generated_at - scheduled_at` 在 0..60s；同时规定验收窗从首次重新锚定的正常拍开始、期间 interval 固定且无 Bridge restart，或明确要求这些扰动也必须计入。

## Verdict

CHANGES REQUESTED — address items above
