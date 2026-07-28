# FLY-1505 Runner ship 轮询窗口与假报 blocked — 探索
Issue: FLY-1505 (https://linear.app/geoforge3d/issue/FLY-1505/基建卡点-runner-ship-轮询窗口-10-分钟-ship-job-实际-20-分钟-假报-blocked-并作废活批准)
日期: 2026-07-27
基于: 无

## 1. 问题(FLY-1497 实证 2026-07-27)

Runner 拿到 founder 批准后发 `:cool:` 触发 ship workflow,随后按协议轮询 PR 是否合入,**最多等 10 分钟**;而 ship job(串行跑全套测试)正常就需要 ~20 分钟(FLY-1504 刚把 job 超时从 10 提到 30 分钟)。于是 job 还在健康地跑,runner 已经按协议判定"未合入"、跑 `complete --route blocked` ——会话状态翻成 `blocked`,而 `verify-approval` 硬性要求会话状态是 `approved_to_ship`,**还活着的 founder 批准(未撤回、绑定还在、head 未漂)就此作废**。PR 往往还会在服务端继续合入,状态进一步撕裂。

## 2. 实证根因链(逐行核实)

1. **协议文本**:`packages/edge-worker/src/Blueprint.ts:2307-2308` —— "poll … every 30s until MERGED, max 10 min";超时则令 runner 跑 `complete --route blocked --summary "ship workflow did not merge in the poll window"`。全仓**唯一**一份协议文本副本(另一处引用是 FLY-1504 的 exploration 文档,正是本单的出处)。
2. **job 实际耗时**:`.github/workflows/ship-on-comment.yml:29` `timeout-minutes: 30`(FLY-1504);注释里实测 setup+build+typecheck+lint 3m08s + 全量 `pnpm test:packages:run` 估 ~18-20 分钟。
3. **PR #713 时间线复现了第二时钟的破坏性**:founder 02:26 批准 → runner 02:49 假报 `blocked` → workflow 仍健康运行并于 02:56 自行合入;对应 GitHub Actions run `30323697177`。批准到合入约 30 分钟,中间的假 `blocked` 只来自 runner 自己的较短轮询窗,不是 workflow 的终态。
4. **三个 completion sink 无条件翻状态**(sink 三处必须一致,这是既有约定):
   - HTTP `/events`:`packages/teamlead/src/bridge/event-route.ts:1601-1606` —— `route === "blocked"` → `status = "blocked"`,注释明说"Even for sessions that were previously approved_to_ship"。
   - 进程内:`packages/teamlead/src/DirectEventSink.ts:749` —— 同映射。
   - 崩溃重放:`packages/teamlead/src/bridge/complete-marker-reconciler.ts:295-296` —— 同映射。
5. **FSM 有去无回**:`packages/core/src/workflow-fsm.ts:175-182` —— `approved_to_ship → blocked` 边是 FLY-208 5a 特意加的("ship failed after approval → blocked");但 `blocked` 的出口只有 `deferred / shelved / terminated` + action `retry → running`(整圈重跑)。**没有回 `approved_to_ship` 的边**——假报一旦发生,恢复只能整圈重跑或人工修库。
6. **verify-approval 的安全不变量**:`packages/flywheel-comm/src/commands/verify-approval.ts:560` —— 第 4 步 `row.status !== "approved_to_ship"` → `status_not_approved_to_ship` 拒绝。批准的其余绑定(问题绑定、结构化响应、founder 归因、head 一致)全都还成立,仅状态一项被假报污染。

**一句话**:错的不是 runner(它忠实执行了文本),是文本里的窗口常数错了 + 善后动作把"ship 尝试失败"错误地编码成了"工作被阻塞"这个会话终态。

## 3. 问题空间分解

本质上是三个缺陷叠加:

- **缺陷 A(窗口太短)**:10 分钟 < 实际 ~20 分钟(上限 30 分钟)。两个写死的数各过各的——workflow 预算改了,协议文本没人同步(founder 今晚原话痛点)。
- **缺陷 B(善后语义错)**:「本次 ship 尝试没完成」被编码成会话终态 `blocked`。批准有效性应只由「是否绑当前 head + 是否被撤回」决定(FLY-1498 已把这条记为 v2 设计条款);ship 尝试失败是一次**动作**失败,不是会话性质的改变。
- **缺陷 C(无恢复路)**:FSM 从 `blocked` 无回 `approved_to_ship` 的边,假报不可自愈。

修 A 而不修 B,窗口再宽也只是把炸弹引线加长(job 排队异常、runner 时钟误差、未来预算再调都会复发);修 B 而不修 A,则每次 ship 都要 Lead 人工介入一次。两个都要修;C 通过修 B 消除(状态根本不翻,就不需要回边)。

## 4. 方案选项与取舍

### 4.1 协议侧(runner 行为)

| 选项 | 内容 | 取舍 |
|---|---|---|
| A1 只放宽窗口 | 10 → 35+ 分钟 | 必要但不充分:窗口耗尽后的善后仍是毒药 |
| **A2(选)窗口放宽 + 善后改向** | 窗口 10 → **40 分钟**(30 分钟 job 上限 + 排队/启动余量,满足 issue 的 ≥35);poll 间隔 30s → 60s;新增**显式失败早停**(ship workflow 会在 PR 上留机器可读 receipt 注释 `flywheel-ship-receipt … status=failure` + "❌ Ship failed" 评论,轮询时一并检查,失败即停止等待);窗口耗尽或显式失败都**不再** `complete --route blocked`,改为 `ask --report` 报 Lead(SHIP-STALLED / SHIP-FAILED)并**留在 checkpoint 等唤醒**,会话保持 `approved_to_ship`、批准保活 | 把现行 Lead 临时硬指令("ship 后未合入不许走 blocked,必须先报 Lead")固化进协议;显式失败早停避免白等 40 分钟 |

### 4.2 服务端(防协议再被违反)

| 选项 | 内容 | 取舍 |
|---|---|---|
| B1 放宽 verify-approval(blocked 也可 ship) | issue 给的括号备选 | **否**:status 检查是安全不变量,`blocked` 是个大杂烩状态(真阻塞、被 Lead 挂起…都在里面),放宽等于扩大 ship 授权面 |
| B2 加 FSM 回边 blocked → approved_to_ship | 事后可恢复 | **否**:治标——假报还是发生、告警还是会响、Linear/thread 状态还是先错后对;且这条回边对真 blocked 会话是危险的 |
| **B3(选)三 sink 一致的 deflection 硬闸** | `approved_to_ship` 会话收到 `route=blocked` 的 session_completed:**不翻状态**,写 `session_params` 的 `ship_attempt_failed` 标记(仿 FLY-208 evidence-gap 标记的既有形态)+ 升级 Lead 一条告警,HTTP 回 `ok+warning`(仿既有 invalid-route skip 形态) | 「ship 尝试失败」从此有自己的表达方式(标记+告警),不再借用会话终态;三 sink(event-route / DirectEventSink / marker-reconciler)同步改,维持 sink-agreement 既有约定 |

**verify-approval 一行不动。**

### 4.3 防漂移(Lead brainstorm gate 加固 ①)

窗口从 10 改 40 之后,40 仍是第二个孤立常数。加**跨文件一致性回归测试**:测试解析 `.github/workflows/ship-on-comment.yml` 的 `timeout-minutes`,断言协议窗口常数 ≥ 该值 + 余量。谁再调 workflow 预算,CI 立刻红。为此把窗口/间隔从内嵌字面量提为 Blueprint 导出常数,测试直接 import,不 regex 提示词。

## 5. Lead 裁决(brainstorm gate,2026-07-27)

方向四件套(A2 + B3 + 防漂移 + 回归)**已批准**,附加两条:

1. **跨文件一致性回归测试**必须做(见 4.3)——结构性防"两个写死的数各过各的"。
2. **B3 服务端硬闸按 founder 反 over-reaction 规则,在 plan 里单列保护性机制表单**供 founder 裁:场景 = 今晚两次实发(在飞的旧协议 runner / 未来文本再漂移);为何根治(1)(2)不够 = 改提示词管不住已经在飞的会话。

另:founder 设计 HTML 按 FLY-1508 新合同交付(可互动评论层 + 本地渲染的真 Mermaid 图 + 零黑话)。

## 6. 边界与关联

- **FLY-1448(held PR,pending ship)**:大改 event-route / wake / park / founder-approval 链路。实现期 rebase 冲突风险高,plan 里注明接缝;「merged-while-stalled 的全自动对账」(GitHub MERGED 外部权威 recheck)属它的范畴,本单不做,靠 Lead 升级兜住。
- **FLY-1498**:「ship 失败不得影响批准有效性」已记为 v2 门与派发模型的设计条款;本单是该条款在现行(legacy runner ship 路径)上的近期落地。generalized-workflow 的服务端 ship(`land-executor.ts`,自己驱动 :cool: 并读 receipt)不受本单影响。
- **FLY-1504**:job 超时 10 → 30 已 ship(b010aa3f);本单窗口值以它为锚。
- 本单落地后,Lead 可撤销临时硬指令。

## 7. 开放问题(带默认答案进 research/plan)

1. 窗口值:40 分钟(默认)——30 分钟 job 上限 + ~10 分钟排队/启动/评论传播余量。
2. Lead 告警机制选型:deflection 时服务端用哪条既有告警管道(仿 FLY-869 merge_without_approval 的 Discord 告警 vs lead-inbox)——research 里核对后定。
3. 显式失败早停的具体探测命令(receipt 注释 vs gh run)——plan 里给 LLM 可靠执行的最简形态。
