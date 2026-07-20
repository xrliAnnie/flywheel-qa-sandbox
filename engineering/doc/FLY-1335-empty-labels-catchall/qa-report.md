# FLY-1335 空 labels 不是 wildcard — QA 验证报告

Issue: FLY-1335 (URL 不可得,只写 issue 号)
日期: 2026-07-20
基于: plan.md, research.md, exploration.md(同文件夹)

**结论: PASS** — 修法真的修好了报告的 bug,且我用突变测试证明了「测试不是空过的」。
零 blocking 缺陷,2 条 LOW(非阻塞,已量化,建议 follow-up)。

审的 head: `40a54013a1b5a02bcef65a7f9b7b150bb49036ab` (PR #646)

---

## 1. 修法是什么(先说清楚,因为它不在 issue 预设的 A/B/C 里,而是 B+C)

issue 提了三个候选修法。实现选的是 **B + C 的组合**,而且**没有改
`AgentDispatcher.labelsMatch`**(issue 里点名的那段代码原样保留):

- **不改语义**:空数组照旧永不匹配 —— 空**就不是** wildcard,这条被明确写成合同。
- **改接线**:`.flywheel/config.yaml` 新增 `default_agent: general`,让「label 一个都没命中」
  的 issue 走 dispatcher 早就存在但从没被这个项目用上的 **Step 3a** 落到项目自己的
  `general-executor.md`。
- **fail-loud**:ConfigLoader 新增告警 —— 某个 agent 是空 labels **且不是** `default_agent`
  时打 warn(不 throw,保 boot 连续性)。这是防止同一个坑再被写第二遍。

我核过这个选择本身是站得住的:改 `labelsMatch` 返回 true(候选 A)会让**任何**空 labels 的
agent 变成隐式 wildcard,而 dispatcher 是按声明顺序遍历的 —— 那样一个无意写空的 agent 会
悄悄吃掉所有 issue。B/C 的边界更窄、更明确。

---

## 2. 最关键的一步:突变测试(证明修复真的在起作用)

绿测本身不证明任何事 —— 我先证明这些测试**能红**。

**突变 1:把 `default_agent: general` 从真 config.yaml 里删掉**

```
Expected: "general"
Received: "generic"        ← 一字不差就是 issue 报告的症状
Tests  4 failed | 4 passed (8)
```

这一条同时是 **bug 复现证据** 和 **修复有效证据**:删掉这行,未命中 label 的 issue 立刻掉回
shipped generic(那个 Superpowers RPC 文件);加回去,落到项目自己的 general。config 已还原,
`git status` 干净。

**突变 2:把候选修法 A 注入 `labelsMatch`(空数组 → return true)**

我自己新写的合同测试 `4 failed | 4 passed` —— 说明我的测试真的钉住了「空 ≠ wildcard」这条语义,
不是摆设。`AgentDispatcher.ts` 已逐字还原。

**ConfigLoader 告警的阳性对照**:实现方自己带了 fixture 证明告警**能**打出来(一条阳性 + 两条
阴性)。所以 general-catchall 那条 `expect([])` 的负向断言不是空过的 —— 尺子先被证明没坏。

---

## 3. 我独立跑的验证(不只是重跑别人的测试)

### 3.1 生产接线是真的(不是只在测试里成立)

测试自称「mirrors run-infra 的接线」。我去查了真代码,不是信它的注释:

- `packages/teamlead/src/bridge/run-infra.ts:780` → `defaultAgentName = flywheelConfig?.default_agent`
- 同文件 `:862` → `new AgentDispatcher(agentsConfig ?? {}, defaultAgentName, flywheelRepoRoot)`
- `scripts/lib/setup.ts:477` 同款

**生产真走这条路**,config 里的 `default_agent` 确实会到达 dispatcher。

### 3.2 全机 6 个真项目 config 扫描(boot 连续性 + 影响面)

新 ConfigLoader 对着**真的**生产 config 跑(不是 fixture):

| 项目 | 加载 | default_agent | 空 labels agent | FLY-1335 告警 |
|---|---|---|---|---|
| GeoForge3D | OK | (无) | `general` | ⚠️ 打了 |
| joycon-typeless | OK | (无) | `general` | ⚠️ 打了 |
| growth | OK | (无) | — | — |
| flywheel(生产 checkout,main) | OK | **(无)** | `general` | ⚠️ 打了 |
| tidal-echo | OK | `content` | — | — |
| personal-assistant | 无 config | — | — | — |

三个结论:

1. **没有一个真 config 因为新增的告警循环而崩** —— boot 连续性在真配置上验过,不是靠 fixture 推断。
2. **告警恰好打在真有 bug 的地方**:GeoForge3D 和 joycon-typeless **今天仍然带着同一个坑**
   (空 labels 的 `general` + 没有 `default_agent` → 它们的未命中 issue 依旧静默流向 shipped
   generic)。这不是本 PR 的缺陷(本单 scope 就是 flywheel 自己 + 机制),但它是个**已验证的事实**:
   这个 bug 在另外两个生产项目里还活着,本 PR 让它们从「静默」变成「boot 时会喊」。建议开 follow-up。
3. `~/Dev/flywheel`(生产 checkout,在 main 上)显示 `default_agent=(无)` —— **修复还没上线**,
   这是预期的,也是下面部署说明的依据。

### 3.3 没有连带损伤(我主动去找的回归面)

- **doc-flow**:`Blueprint.ts:1404` 的 `resolveDocFlowDepartment` 吃的是 `ctx.owningDept`,
  **不是** dispatch 结果里的 department。所以 general(top-level、无部门)不会让 doc 路径塌成
  怪路径 —— `resolveDocFlowDepartment(undefined, "engineering")` → `engineering`。不受影响。
- **三段式**:`three-stage-policy.ts` 只看 labels + channel + kill-switch,不看 agentName/
  matchMethod。不受影响。
- **影响面收敛**:本 PR 只改了 `.flywheel/config.yaml` 这**一个** config,其他项目零改动。
- **逃生口没被吃掉**:`agentName:"generic"` 依旧拿到 shipped generic;显式 `agentName:"general"`
  依旧是 `override` 路径。两条都有测试钉住(实现方 + 我各一份)。

### 3.4 测试执行(真跑,不是引用)

| 套件 | 结果 |
|---|---|
| edge-worker 全量 | **1160 passed / 5 skipped (95 files)** |
| flywheel-config 全量 | **487 passed (29 files)** |
| `scripts/qa-fly-901-real-config-dispatch-e2e.mjs`(真 config + 真编译 dispatcher) | **ALL PASS** |
| 我新增 `empty-labels-not-wildcard.qa.test.ts` | **8 passed** |
| PR #646 CI(9 jobs @ 当前 head) | **全绿** |

---

## 4. 我补的测试

`packages/edge-worker/src/__tests__/empty-labels-not-wildcard.qa.test.ts`(8 例)

实现方的 `general-catchall-dispatch.test.ts` 打的是**真 config.yaml** —— 好,但它只保护
flywheel 这一个项目的当前配置形态。我补的这份是**合成的、不依赖 config**,钉的是语义合同本身:

- 复现原始 bug 形态(空 labels catch-all + 无 default_agent → shipped-generic)
- 空 labels 在 **step 2a(本部门)** 和 **step 2b(顶层)** 都永不胜出 —— 原测试只覆盖了顶层
- `default_agent` 才是让它可达的那把钥匙
- `default_agent` 不遮蔽真 label 命中(step 2 优先于 step 3a)
- `default_agent` 指向**非**空 labels 的 agent 也照样工作(机制与 labels 无关)

其中 2 例是**回归 pin,不是新增保证** —— 独立复审(见 §5)点出来的,我接受并已在测试里标注:

- 悬空 `default_agent` 退化成 shipped-generic 而不是抛异常 —— `AgentDispatcher.test.ts:242` 已覆盖
- `agentName:"generic"` 逃生口仍走 shipped-generic —— `AgentDispatcher.test.ts:327` 已覆盖。**更正**:我原先把它写成「不被 default_agent 捕获」,暗示验证了一个交互;实际 `dispatchByName` 在读 `this.defaultAgent` **之前**就对保留名短路了(`AgentDispatcher.ts:277`),两者结构上独立,这条测试换任何 `defaultAgent` 值都会过。它记录逃生口在 FLY-1335 之后仍在,但**不**证明交互。

如果将来有人想改成候选 A(空=wildcard),这份测试会红 —— 那是**故意**的:那是个语义决策,
必须被显式重做一遍,不能顺手滑过去。

---

## 5. 非阻塞发现(LOW × 2)

**LOW-1:告警是 per-load,不是 per-boot —— 我量化了它。**
实现方自己的 review 记了「per-load warn noise」这条,但没给量级。我实测:同一个 config 连载 3 次
→ **3 条告警**(无缓存/无去重)。而 `ConfigLoader.load` 在 Bridge 里有 **7 个调用点**
(run-infra 引导 + runs-route 的 `loadFounderUxExemptLabels` + three-stage / auto-qa /
feature-flag / detection / founder-milestone 六个 config-source),其中**部分是每次 run 启动都调**。

实际影响: **对 flywheel 本项目是 0 条**(general 就是 default_agent,不触发)。只有 GeoForge3D /
joycon-typeless 会反复打。落点是 Bridge stdout,不是 Discord 告警通道,不会污染 #flywheel-alerts。
**不阻塞 ship**;真要治,顺手的做法是把它挪进 3.2 那条 follow-up(把那两个项目的 config 补上
`default_agent`),告警自然归零 —— 比给告警加去重更对症。

**LOW-2:告警文案里的 agent 名来自 config key,会原样打进日志。**
这是 config 作者自己写的名字,不是外部输入,无注入面。仅记录,无需动作。

**LOW-3(独立复审提出,我已采纳并更正):8 例里有 2 例是回归 pin 而非新增保证**,我原先的 commit message 和本报告 §4 把它们和真正新增的不变量并列,轻微夸大了「净新增」。已在测试注释和 §4 里逐条标注更正,特别是 `agentName:"generic"` 那条 —— 它不证明与 `default_agent` 的交互(代码里两者结构独立)。真正**之前没覆盖过**的是 step-2a 本部门路径、空-labels-agent-作-default_agent、以及 default_agent 不遮蔽真 label 命中这几条。

**独立复审的其他结论(APPROVED)**:复审方**自己重跑了两个突变实验**(没只信我的叙述),数字逐字对上;并逐条核了本报告的 run-infra / doc-flow / three-stage / boot-时读取 四个代码断言,以及 1160/487 两个测试数 —— 全部与源码相符,未发现夸大。

**明确不算发现的**:仓库根跑 `biome check` 报 644 errors —— 全部来自未跟踪的运行时产物
(`.flywheel/runs/**/*.json`),不是源码。本分支改动的 **7 个文件全部 lint 干净**,CI 的
Quick Gate(build+typecheck+lint)也是绿的。

---

## 6. 部署说明(ship 时必须知道的一件事)

**这个修复不会在 merge 的瞬间生效。**

`default_agent` 是在 **Bridge 启动时**、`setupRunInfrastructure` 里逐项目读进 dispatcher 的
(run-infra.ts:772-780 → :862),不是每次 run 现读。所以生效要两步:

1. merge → 生产 checkout(`~/Dev/flywheel`)`git pull`(3.2 已实测确认它现在还是 `default_agent=(无)`)
2. **重启一次 Bridge**

这正是 CLAUDE.md 里 FLY-205 那条 ship 教训的同款形状(「补装项目 config 落地后必须再重启一次
Bridge」)。只 merge 不重启 = 未命中 label 的 issue 继续流向 shipped generic,而且从表面完全看不出来。

---

## 7. 与 FLY-1326 的排程

issue 里的排程约束(本单先行,FLY-1326 的 B/C 臂跟本单结论走)在本次 QA 范围内**已被遵守**:
本分支**没有碰** `agents/generic-executor.md`,也没碰 `AgentDispatcher.ts`。我逐一核过 diff 确认。

供 1326 参考的本单结论:**shipped generic 依然是绝对兜底**(step 3b),只是对声明了
`default_agent` 的项目不再是「label 没命中」的那个落点。Superpowers 耦合仍然真实存在于
`agents/generic-executor.md`,只是 flywheel 自己的 issue 不再默认撞上它。
