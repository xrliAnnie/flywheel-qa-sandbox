# FLY-1417 dead-exec sweep 测试时钟耦合 flaky — 探索

Issue: FLY-1417 (https://linear.app/geoforge3d/issue/FLY-1417/testflaky-workflow-engine-dispatchertestts-8-测试-envtz-敏感-ci-时红时绿本地-la)
日期: 2026-07-21
基于: 无

## 症状复现(已确认)

`packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts` 36 测中 8 挂,本地连跑确定性红。失败断言(代表)在 line 897:

```
"replaces a started execution whose terminal session and liveness prove it dead"
→ expected { started: 1 } got { started: 0 }   (dead-exec 替换没触发)
```

8 个失败测试的共同点:都注入固定引擎时钟 `now: () => new Date("2026-07-22T00:00:00.000Z")`(或以它为基点 + 相对 delta),且都走 dead-exec sweep 替换路径。

## 决定性实验:不是 TZ,是 wall-clock

| 条件 | 结果 |
|------|------|
| `TZ=America/Los_Angeles` | 8 failed |
| `TZ=UTC` | **8 failed(完全相同)** |
| 真实 UTC now | `2026-07-22T01:56Z`(已越过注入的 `2026-07-22T00:00:00Z`) |
| 「retry ladder」测试(line 374,把 `now` 锚在真实 `Date.now()`) | **PASS(即使 LA)** |

结论:**不是产品侧 backoff-TZ 遗漏**。UTC 与 LA 结果字节相同 → TZ 无关。产品码本身正确。

## 根因:测试 fixture 的时钟耦合(time-bomb)

产品码 `workflow-engine-dispatcher.ts:482-496`(dead-exec 替换的 retry backoff):

```ts
const retryDelaysMs = [60_000, 5 * 60_000, 15 * 60_000];
if (!resourceFailure && !approvedDesignFallback && launches.length < 4) {
  const delay = retryDelaysMs[Math.max(0, launches.length - 1)]!;
  const launchedAt = parseSqliteUtcMs(latest.created_at); // ← 已用 UTC 解析(1385 R2 修的那处)
  if (launchedAt !== null && this.now().getTime() - launchedAt < delay) {
    continue; // 还没到重试时间 → 不替换
  }
}
```

- `latest.created_at` = `workflow_side_effect_ledger.created_at`,schema 是 `DEFAULT (datetime('now'))`(`StateStore.ts:19318`),由 SQLite 写**真实 UTC wall-clock**,**没有可注入的 seam**(dispatch/materialize 两处 INSERT 都不传 created_at)。
- `this.now()` = 测试注入的**固定**引擎时钟 `2026-07-22T00:00:00Z`。
- `parseSqliteUtcMs` 正确按 UTC 解析 created_at(所以 TZ 无关)。

耦合的后果:`elapsed = injectedNow − realCreatedAt`。测试作者当初把固定日期定成「未来」以让 backoff 恒为 no-op;但真实时钟已走到 `2026-07-22T01:56Z`,越过了 `2026-07-22T00:00:00Z` → elapsed 变**负** `< delay` → dead-exec 替换被误判为「还没到重试时间」→ held → `started: 0`。

## 这也精确解释了 issue 观察到的现象

- **CI 时红时绿**:真实 UTC 在 `2026-07-22T00:00:00Z` 之前跑 → elapsed 正、很大 → 绿;之后跑 → elapsed 负 → 红。1385/1393 merge 的 CI run 恰在边界前,1392 PR 的 run 在边界后。
- **本地 LA 确定性红**:LA 傍晚 = UTC 次日,真实 UTC 已过边界 → 每次都红。「TZ 敏感」是巧合表象(LA local 更早把真实 UTC 推过午夜),真正驱动是 wall-clock 越过那个写死的日期。

## 分类结论

**测试侧 fixture 问题(time-bomb),非产品隐患。** 生产环境 `now` 与 `created_at` 是同一真实时钟 → backoff 正确,dead-exec 替换不会被延迟。retry-ladder 测试(锚真实 `Date.now()`,LA 下 PASS)就是产品侧正确的活证据。

## 候选修法

把 8 个测试的注入引擎时钟从「写死的日历日期」改为「锚在真实 `Date.now()` + 一个远大于最大 ladder 档(15min)的 margin」,并保留各测试原有的相对 delta(+1min / +2min / +24h)。这样 `injectedNow − realCreatedAt ≈ margin`,恒 `>> delay`,在任何真实时间/任何 TZ 下都确定性通过。这正是本文件里 retry-ladder 测试已经在用的既有惯用法(`launchedAt = Date.now()`),不动产品码。
