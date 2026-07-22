# FLY-1417 dead-exec sweep 测试时钟解耦 — 实施计划

Issue: FLY-1417 (https://linear.app/geoforge3d/issue/FLY-1417/testflaky-workflow-engine-dispatchertestts-8-测试-envtz-敏感-ci-时红时绿本地-la)
日期: 2026-07-21
基于: research.md

方向已过 brainstorm gate:**纯测试侧修复,不动产品码**。Lead 已按 CI 时间线复核确认(绿 run 23:37Z 在 2026-07-22T00:00Z 边界前,红 run 01:07Z/01:41Z 在边界后)。

## 唯一改动文件

`packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts`(产品码零改动)

## 变更 1:顶部加共享 helper(带 FLY-1417 time-bomb 警示注释)

在文件顶部常量区(`HEAD`/`WORKFLOW_ON` 附近)加:

```ts
// FLY-1417: the dead-exec sweep's replacement backoff
// (workflow-engine-dispatcher §reconcileDeadExecutions) spaces retries by comparing
// the injected engine clock against workflow_side_effect_ledger.created_at — which
// SQLite fills with `datetime('now')` (the REAL UTC wall clock) at insert time and
// exposes no injectable seam. A hard-coded calendar date for the engine clock is
// therefore a time bomb: once the real wall clock passes it, `now - created_at` goes
// negative, the ladder wrongly holds, and the dead-exec replacement never fires
// (started: 0). Anchor the engine clock to the real clock plus a wide margin (well
// beyond the 15-minute top ladder tier) so the elapsed always clears the ladder,
// deterministically, in any zone or on any calendar day — mirroring the retry-ladder
// test in this file, which already anchors to `Date.now()` for the same reason.
const DEAD_EXEC_ENGINE_CLOCK_MARGIN_MS = 6 * 60 * 60 * 1000; // 6h ≫ 15-min top tier
function deadExecEngineClockBaseMs(): number {
	return Date.now() + DEAD_EXEC_ENGINE_CLOCK_MARGIN_MS;
}
```

## 变更 2:8 个测试各自把「写死日历日期」换成 base 参照

每个测试在构造 dispatcher 前加 `const base = deadExecEngineClockBaseMs();`,并按下表替换:

| # | 行 | 前 | 后 |
|---|----|----|----|
| 1 | 883 | `now: () => new Date("2026-07-22T00:00:00.000Z")` | `now: () => new Date(base)` |
| 2 | 921 | 同上 | `now: () => new Date(base)` |
| 3 | 964 | 同上 | `now: () => new Date(base)` |
| 4 | 1077 / 1104 | `…00:00` / `…00:01` | `new Date(base)` / `new Date(base + 60_000)` |
| 5 | 1160 / 1188 | `…00:00` / `…00:01` | `new Date(base)` / `new Date(base + 60_000)` |
| 6 | 1219 / 1251 | `…00:00` / `07-23 00:00` | `new Date(base)` / `new Date(base + 24 * 60 * 60_000)` |
| 7 | 1271 | `…00:00` | `now: () => new Date(base)` |
| 8 | 1325 / 1347 | `let now = new Date("…00:00")` / `now = new Date("…00:02")` | `let now = new Date(base)` / `now = new Date(base + 120_000)` |

对多 dispatcher 的测试(4/5/6),同一个 `base` 供两个 dispatcher 共享,保证相对 delta 精确。

## 不变量保证(为何安全)

1. `base = Date.now()+6h` 在测试构造时算一次;created_at 在 reconcile 时写(真实时刻 ≈ Date.now()),故 `base − created_at ≈ 6h ≫ 15min` 任何时间任何 TZ 恒成立。
2. 相对 delta 原样保留 → 依赖 delta 的断言(+1min tripwire 探测、+24h TTL prune、+2min 三探针 unknown)行为字节不变。
3. 无任何断言比较「注入 now 派生的时间戳字符串」(research.md §4 已逐个核对)→ 换 base 不破坏断言。
4. `now: () => new Date(base)` 每次返回相同瞬时 → 单次 reconcile 内 now 稳定,不引入微秒漂移。

## 验证(verification-before-completion)

1. `cd packages/teamlead && TZ=UTC npx vitest run src/__tests__/workflow-engine-dispatcher.test.ts` → 36/36。
2. 同上 `TZ=America/Los_Angeles` → 36/36。
3. 同上 `TZ=Asia/Tokyo` → 36/36。
4. 全 teamlead 套件回归无新红。
5. 全仓 `pnpm lint` + `pnpm -r build` 绿。
6. codex code review(mandatory,xhigh)。

## 回归护栏

修好后这 8 个测试本身即护栏:任何人再把注入引擎时钟改回「写死的过去日历日期」都会重新变红,且它们现在在任何真实时间/TZ 下都确定性通过。额外补的 helper 注释明确警示 time-bomb 模式,防止后来者再踩。

## 风险 / 明确不做

- **不动产品码**(Lead 已批;产品用 parseSqliteUtcMs 无恙)。
- **不加 TZ-pinned 重复测试**:已证 TZ 无关(UTC/LA 字节相同),再加一个 TZ 钉的重复用例是 vacuous;真正护栏是这 8 个解耦后的测试。
- **不碰其它带固定日期 now 的测试**(research.md §2 已证它们不触发该 backoff,非 time-bomb)。
