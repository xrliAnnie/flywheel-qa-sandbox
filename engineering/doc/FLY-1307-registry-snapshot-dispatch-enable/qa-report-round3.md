# FLY-1307 — QA 验证报告 Round 3（PR-8 切片，head `9ccf47335`）

Issue: FLY-1307
日期: 2026-07-16
基于: plan.md (v1.35 §4) · qa-report-round2.md (PR-7 = PASS) · PR #626

## 0. 结论 — **FAIL（kickback）**

PR-8 的 5 道硬 gate 里 **4 道真实成立、1 道空过**。空过的那道恰是 plan §4.3
**首条具名硬 gate**「eng 等价 harness」——plan 原文钉死「**PR-8 没有它不过 gate**」。

| 硬 gate | 裁决 | 依据 |
|---|---|---|
| **eng 等价 harness（具名）** | ❌ **空过** | §2 突变铁证 |
| source outbox（不许投影降级） | ✅ 真 | §3.1 突变验证 |
| flag 矩阵 v1/v2 逐旗分型 | ✅ 真 | §3.2 突变验证 |
| 真机 E2E | ✅ 真 | §3.3 **独立重跑** 13/13 |
| default-off 字节兼容 | ✅ 真 | E2E OFF 对照 + registry 测试 |

其余回归全绿（定向 13 文件 **200/200**）。**这不是「测试写少了」，是交付物在名字和
sentinel-matrix 里声称了它并不具备的性质** —— 属「拿标签冒充事实」，必须 kickback。

## 1. 空过的是什么

`phase-orchestrator.test.ts` 新增 233 行，测试名：
「engine-owned v1 **is event-equivalent to the live legacy phase belt**」；
`sentinel-matrix.md` 据此声称「engine v1 与 legacy belt 的交接顺序、一次 QA 回环、
PASS 入 founder gate、第四次超限 escalate **逐事件一致**」。

**实际实现**：legacy 侧的 trace 是测试**自己手写 push 的字符串字面量**：

```js
await belt.onPhaseComplete(session({ session_role: "design", status: "design_done" }));
legacyTrace.push("design_done:design->implement");   // ← 手写，不是从 belt 读出来的
```

belt 被调用了，但**它的行为从未被观测**（`legacy.start` mock 的调用、refuse/escalate
路径都没有任何断言读取）。超限那条腿同样是
`legacyLimitTrace.push(round <= 3 ? "…implement" : "…escalate")` 硬编码。

于是这条测试真正断言的只有「engine 的 trace == 我手写的期望数组」——
**是一条 engine 单侧单元测试，披着差分 harness 的外衣**。belt 的调用是装饰。

## 2. 突变铁证（两刀，皆决定性）

基线：`phase-orchestrator.test.ts` **74/74 绿**。

| # | 突变（改的是 **legacy 生产代码**） | 真等价 harness 应有的反应 | 实测 |
|---|---|---|---|
| A | `DEFAULT_MAX_FIX_ROUNDS` 3 → 1（legacy 改为**第 2 轮**就 escalate，engine 仍第 4 轮 = **真分歧**）| 变红 | ❌ **仍绿 ✓**（只有一条无关老测试 `FAIL cap boundary` 抓到）|
| B | `onPhaseComplete` 顶部直接 `return`（legacy **完全不交接**）| 变红 | ❌ **仍绿 ✓**（1 passed）|

**B 的含义**：legacy belt 可以什么都不做，这条「等价」测试照样 PASS。
两次突变后均**逐字还原**，`git status --porcelain` 空。

**尺子有效性（阳性对照）**：突变 A 打红了 `FAIL cap boundary` 那条老测试 →
证明我的突变确实注入到了生产路径、vitest 确实在跑它；「等价测试仍绿」不是坏尺子的产物。

**唯一性核查**（zsh 曾把 `--include=*.test.ts` 当 glob 吞掉、返回假 0，加引号重扫）：
`engine_owned` 命中 4 文件（阳性对照 = 尺子有效）；同时含 `PhaseOrchestrator` +
`commitWorkflowTransitionTx` 的测试文件**仅** `phase-orchestrator.test.ts` 一个 →
**别处没有第二个等价 harness 兜底**。

## 3. 其余 4 道 gate — 逐条真实（不采信自报，全部独立验证）

### 3.1 source outbox（派单点名「不许选便宜的投影降级冒充合规」）— ✅ 真
测试用**真 CommDB**（`grantTurn` → `listWorkflowSourceEventsAfter` /
`listTurnSourceHistory`）→ 真 `drainWorkflowSourceEvents` projector → 断言 cursor 对账、
稳定 event_uid、伪造行进 deadletter 且**不计成功**，并显式声明未调用
`applyWorkflowSourceEvent` 制造过路行。

- 突变 1：只去掉 `turnBinding.run_id !== targetRunId` 一条腿 → **仍绿**
  （非空过：伪造行被同 message 的另一条腿 `context.node.type !== toRole` 拦下）。
- 突变 2（决定性）：整个归属守卫 → `if (false)` → **变红**
  （`applied: 2` ≠ 期望 `1`，伪造行被投影）。→ 守卫真被钉住。

### 3.2 flag 矩阵 — ✅ 真
共用谓词 `workflowTemplateDispatchBlockReason` 去掉 `claims_read` 检查 →
selection / materialize / admission / dispatcher **4 个 seam 文件共 8 条红**。

### 3.3 真机 E2E — ✅ 真（**独立重跑，非采信提交的 JSON**）
我亲跑 `scripts/qa-fly-1307-template-dispatch-e2e.mjs`：exit 0、**13/13 PASS、0 FAIL、
8 次真 TmuxAdapter fresh spawn**（日志留档 `qa/independent-e2e-rerun.txt`，
`generated_at=2026-07-17T05:06:59Z` = 我这次的运行）。跑完把实现者的
`qa/template-dispatch-e2e.json` **`git checkout` 还原，不篡改其证据**。

> 留痕：证据日志初次落地为 `.log`，被 `.gitignore:20 *.log` **静默吞掉**（`git status` 空）。
> 改 `.txt` 后才真进版本库 —— 「文件写了」不等于「文件进了 PR」。

### 3.4 回归 — ✅
PR-8 定向 13 个测试文件 **200/200 绿**。

## 4. 修复建议（给实现者，非重设计）

不必动生产代码，只需让 legacy 侧的 trace **来自观测**而非手写：

- **交接腿**：从 `legacy.start` mock 的实参读出 belt 实际启动了哪个 phase，
  据此构造 `legacyTrace`（既有 legacy 测试已用 `expect(start).toHaveBeenCalledOnce()`
  这一可观测点，直接复用）。
- **超限腿**：从 `alertLeadPipelineError` 是否被调用（既有测试第 318/333 行的用法）
  判定该轮是 handoff 还是 escalate，据此构造 `legacyLimitTrace`。
- **自检**：改完必须用本报告 §2 的突变 A / B **各跑一次，确认它们现在会变红**
  —— 否则仍是空过（负向/等价断言不做突变验证 = 不算数）。

修好后需对新 head 重跑 Codex code review + 本轮全部 gate 复验（head 纪律 FLY-945）。

## 5. 范围与非缺陷记录

- 与 FLY-1306 零耦合：确认未触碰 detection 路径。
- 未翻任何生产 flag：`workflow_template_dispatch` 注册为 `governance_gate` / default-off。
- `enable-decision.md` 已按 plan §4.3 末条备齐（杆/组合谓词/claims_read 硬前置/回退），
  内容与 Annie 的 default-enable 偏好对齐且明确建议**先不拉杆** —— 该项**不阻塞**，
  待 harness 补齐后随 ship gate 呈她定夺。
