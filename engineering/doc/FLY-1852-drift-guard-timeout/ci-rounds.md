# FLY-1852 — CI 稳定性 5 轮记账（两层账）

**Head**: `2e108b6f6`（合 `origin/main` `2b7a09d87` 后）
**Run**: `32094255495`，attempt 1–5（`gh run rerun` 整轮）
**合并后三门重跑**: `pnpm lint` 0 error / 8 warning（= baseline，零新增）· `pnpm -r build` rc=0 · `flywheel-config` 647/647 · typecheck rc=0 · 守卫本地 **242ms**
**红线遵守**: 未改测试 · 未加 skip · 未动分片 · 5 轮窗口内**零推送**（唯一一次是开跑前合 main 的 `6a83a2934..2e108b6f6`）

## 两层定义

- **我的层**（本单要证的）: `Unit (light)` 里 `feature-flags-drift` 的
  「validates every declared readSite with pattern-aware code evidence」**零超时**
  （原病：`Error: Test timed out in 5000ms`）
- **污染层**（FLY-1863 的病，不属本单）: `Unit (teamlead 2 of 3)` 的
  `post-ship-finalization` 两条

## 轮次

| 轮 | attempt | `Unit (light)` | 我的层 | 污染层 |
|---|---|---|---|---|
| 1 | 1 | success | ✅ 零超时 | ❌ FLY-1863 |
| 2 | 2 | success | ✅ 零超时 | ❌ FLY-1863 |
| 3 | 3 | success | ✅ 零超时 | ❌ FLY-1863 |
| 4 | 4 | success | ✅ 零超时 | ❌ FLY-1863 |
| 5 | 5 | success | ✅ 零超时 | ❌ FLY-1863 |

## 两层结论

- **我的层：5/5 零超时。** `Unit (light)` 五轮全 success，`feature-flags-drift` 一次都没超时。
  对照原始故障：同 head 一红一绿（n=2）、且失败时 639 测试只挂这一条。
- **污染层：5/5 必现。** 五轮**全部**挂在 `post-ship-finalization` 同样两条 —— 这本身是证据：
  它是**确定性的既有失败**，不是随机抖动。判决性归因见 PR #873 评论区
  （干净 `origin/main` worktree 里同样 2 failed，我的代码不在其中）。

## 判据纪律

- 每轮同时记 `run_attempt`，不拿某一次 attempt 的绿冒充整轮的绿。
- `Unit (light)` 若失败会**去日志确认是否 `feature-flags-drift`**，不是它则标
  `drift NOT implicated` —— 既不把别人的红算进我的账，也不拿它冒充我的绿。
- run 未跑完 / 拿不到 job payload 一律输出 `ROUND INCONCLUSIVE — NOT a pass`。

## 收口（FLY-1863 落地后）

`#878 fix(teamlead): defuse post-ship fixture clock` 合入 main 后，再合一次 main
（head `1182c84dc`），**本地实测验证而非采信**：`post-ship-finalization` **41/41 通过**，
污染源消失。三门复跑：lint 0 error / 8 warning（baseline）· `pnpm -r build` rc=0 ·
`flywheel-config` 647/647 · typecheck rc=0 · 守卫 **265ms**。

原计数口径的结构问题（污染轮不计入 ⇒ 5 轮永远攒不齐）随污染源消失而**自然消解**，
无需再拍甲/乙。5 轮记录保留为「我的层在污染期间仍 5/5 零超时」的证据。
