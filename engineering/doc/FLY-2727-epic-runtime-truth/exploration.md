# FLY-2727 Epic 页运行态可信 — 探索
Issue: FLY-2727 (https://linear.app/geoforge3d/issue/FLY-2727/epic-页可信-在跑不许照抄-linear-started按机器会话真相判活linear-状态单独显示-discord-链接改)
日期: 2026-09-17
基于: 无

## 问题边界

本单只修 Epic 页内容的真实性：子单的 Linear 状态仍原样显示在既有 `st-linear` 位置，但“在跑”必须来自现成的机器执行账本。投递频率、托管、发布、Lead note、Linear 状态写回均不属于本单。

Discord 部分只把三处 thread URL 构造统一到 FLY-2639 已落地的 app/web link 合同；不创造第二种 deeplink 形态，也不改变其它页面布局。

## 当前病根

1. `packages/teamlead/src/epic-page/rules.ts` 的 `classifyItem()` 直接把 Linear `state.type === "started"` 分类为 `live`。
2. `computeRootCounts()` 和 founder view 都复用该分类，因此子单 badge、进度文案和 `N 在跑` 同时把 Linear 状态冒充机器运行态。
3. 页面其实已经携带可复用的机器事实：
   - `session`: 最近会话与会话账本计数；
   - `run` + `attempt`: 当前工作流和当前节点 attempt 状态；
   - `signals`: blocked、held、runner stopped 等卡住事实。
4. `attention-sources.ts`、`attention.ts` 和 `attention-presentation.ts` 各自拼接 `https://discord.com/channels/...`，没有共用 FLY-2639 的 canonical app/web pair 构造。

## 锁定语义

### 机器“在跑”

一张子单只有满足以下任一条件才可显示“在跑”，且两种条件都必须绑定到未超过 Bridge `TEAMLEAD_STUCK_THRESHOLD`（默认 15 分钟）的 `heartbeat_at`：

- 该 issue 在现有 session 账本中至少有一个 `status = running` 且 heartbeat 新鲜的会话；
- 当前 workflow run 为 `active`，当前 node attempt 的 `state = running`，且该 node 绑定的 session heartbeat 新鲜。

`awaiting_review`、`design_done`、`ship_parked`、`approved_to_ship`、stale/null heartbeat、Linear `started` 本身都不能证明机器正在工作。不得用 `last_activity_at` 替代 heartbeat：2026-09-18 05:00Z 的 11 具健康在跑体 heartbeat 年龄均为 0 分钟，而 `last_activity_at` 已老化 99–275 分钟。

### Linear started 但机器未运行

- 最近执行已经正常完成或停在 review/验收态，且没有卡住信号：显示“停着·等验收”。
- 没有执行体、最近执行失败/阻塞/被终止、workflow held，或执行事实不足以证明正常等待：显示“停着·卡住”。
- 账面 session/node 仍为 running 但 heartbeat 过期或缺失：显示“心跳过期/缺失·说不准”，不得把不确定性计为“停着”或断言成“卡住”。
- current attempt 为 pending/admitted 且启动时间仍在同一个 `stuckThresholdMinutes` 宽限内：显示“刚起跑·等第一次心跳·说不准”，不计为“在跑”或“停着”；超过该阈值仍无首次心跳才显示“停着·卡住（起跑后无心跳）”。

两种状态都保留 Linear `In Progress` 单独展示，不得出现“在跑”。

### 计数

同一 Epic 的 `N 在跑` 必须由上述机器活跃判据逐张计算；Linear `started` 的数量不能进入该数字。计数行保持原位置，不改卡片布局。

### Discord

沿用 FLY-2639 / commit `d9db7310a75d01d406765d2b1a858e29533efbaa`：

- canonical app 形态：`discord://-/channels/{guild}/{thread}`；
- canonical web fallback：`https://discord.com/channels/{guild}/{thread}`；
- 三处 ID→URL 构造必须调用同一个 helper；渲染继续使用既有 app/web 双链与渐进增强合同。

## TDD 公共接缝

用户已用硬红验收确认两个公共接缝：

1. 从 Linear snapshot + machine facts 生成并渲染 Epic HTML，断言 started+零运行与 started+运行的可见文案及计数。
2. 从 canonical guild/thread ID 构造 Discord app/web pair，并通过 attention 三条路径观察同一结果。

测试用固定字面量作为预期，不复算实现逻辑；把分类改回 `started => live` 时，started+零运行用例必须失败。

## 明确不做

- 不改 FLY-2720 的两小时投页节奏。
- 不修改任何 Linear issue 状态。
- 不改 lead-note、托管、发布、刷新触发逻辑。
- 不把新的执行真相复制进第三份账本。
