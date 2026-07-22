# FLY-1417 dead-exec sweep 测试时钟耦合 — 调研

Issue: FLY-1417 (https://linear.app/geoforge3d/issue/FLY-1417/testflaky-workflow-engine-dispatchertestts-8-测试-envtz-敏感-ci-时红时绿本地-la)
日期: 2026-07-21
基于: exploration.md

## 1. 8 个失败测试 × 注入引擎时钟 catalog

| # | 测试名(缩) | 行 | 注入 now | 需要的相对 delta |
|---|-----------|----|---------|-----------------|
| 1 | replaces a started execution … dead | 883 | 固定 `2026-07-22T00:00:00Z` | 无(单 now) |
| 2 | observes the dead-exec sweep kill switch | 921 | 固定 `…T00:00:00Z` | 无 |
| 3 | keeps the dead execution … tripwire baseline cannot be captured | 964 | 固定 `…T00:00:00Z` | 无 |
| 4 | keeps a durable tripwire … after restart | 1077 / 1104 | `…T00:00:00Z` → `…T00:01:00Z` | **+1min** |
| 5 | logs tmux-only activity | 1160 / 1188 | `…T00:00:00Z` → `…T00:01:00Z` | **+1min** |
| 6 | prunes a 24-hour dead-execution watch | 1219 / 1251 | `2026-07-22T00:00Z` → `2026-07-23T00:00Z` | **+24h** |
| 7 | alerts when the same node needs a second dead-execution replacement | 1271 | 固定 `…T00:00:00Z` | 无 |
| 8 | keeps an unknown-liveness terminal … alerts on the third probe | 1325 / 1347 | `let now=…T00:00Z` → `…T00:02:00Z` | **+2min** |

共同点:都走 dead-exec sweep 且触发 `dispatcher.ts:482-496` 的 backoff(`launches.length < 4`,非 resourceFailure,非 designFallback)。backoff 比较 `injectedNow − parseSqliteUtcMs(latest.created_at) < delay`。

## 2. 为何只有这 8 个?(边界排除)

其它带固定日期 now 的测试之所以**不**是 time-bomb,是因为它们**不触发这个 backoff 分支**:

- resource/quota-auth death(1375「holds quota/auth」、1470「holds a design Fable quota/auth」)→ `resourceFailure=true` 跳过 backoff。
- design Fable→GPT fallback(1426)→ `approvedDesignFallback=true` 跳过 backoff。
- sweep 关(995「rotates a bounded tripwire patrol」用 `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP:"0"`)→ 不进 `reconcileDeadExecutions`。
- launch-repair 路径(786「repairs a committed launch」等)走的是另一条,不比 `latest.created_at` 对固定 now。

→ 修复范围**精确锁定这 8 个**,不外溢(scope discipline)。

## 3. created_at 无注入 seam(为何不能纯合成时钟)

`workflow_side_effect_ledger.created_at` schema = `DEFAULT (datetime('now'))`(`StateStore.ts:19318`)。dispatch/materialize 两处 INSERT(`StateStore.ts:20328` / `19523`)都不显式传 created_at → 一律真实 UTC。给 StateStore 加可注入时钟只为测试 = 产品改动过度工程(Lead 已确认不动产品码)。因此测试侧只能让**注入的引擎时钟**恒在 created_at 之后足够远。

## 4. 断言安全核查(改 base 会不会破坏别的断言?)

逐个核对 8 测试的断言对象:started/held 计数、`fake.requests` 长度、`getWorkflowRunNode` 的 state/execution_id、watch 的 state/evidence/baseline、alert outbox 的 eventType/disposition/severity/sessionKey、log 字符串包含。**没有任何一个断言比较「由注入 now 派生出来的时间戳字符串」**。→ 把固定日期换成 `Date.now()+margin` base 不影响任何断言(watch observed_at / TTL / delta 全部在同一 base 参照系内自洽)。

## 5. margin 取值

backoff 的最大档 = `retryDelaysMs[2] = 15min`。margin 只需 `≫ 15min`。取 **6h**(24× 头顶档),既远超任一档、又不与 prune 测试的 24h TTL 视觉撞车。base 在测试构造时算一次(`Date.now()+6h`),之后返回 `new Date(base)` 保持单次 reconcile 内 now 稳定(避免每次 `now()` 调用漂移微秒破坏时间戳等值不变量)。

## 6. 既有惯用法对齐

本文件 line 374「spaces replacement launches by the 1/5-minute retry ladder in a non-UTC zone」测试已用 `launchedAt = Date.now(); let now = new Date(launchedAt)` 锚真实时钟(且它 LA 下 PASS)。本修复用同一惯用法,风格一致。

## 7. 决定性验证计划

- 修后:`TZ=UTC`、`TZ=America/Los_Angeles`、`TZ=Asia/Tokyo`(东 UTC)三区各跑 → 期望 36/36 全绿。
- 全 teamlead 套件回归 → 不引入新红。
- 全仓 `pnpm lint` + `pnpm -r build`。
