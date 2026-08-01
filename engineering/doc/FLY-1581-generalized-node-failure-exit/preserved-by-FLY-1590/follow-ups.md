# FLY-1581 衍生的四张 follow-up — 可直接建单的草稿

Issue: FLY-1581 (https://linear.app/geoforge3d/issue/GEO/issue/FLY-1581)
日期: 2026-07-31
基于: research.md / plan.md §6

> 每条都在本仓源码核实过,带 `file:list`。标题/正文可直接粘进 `create-issue`。
> **F1/F2 是 FLY-1581 调查途中撞到的独立缺陷;F3/F4 是同根或范围收回拆出来的。**

---

## F1 — `flywheel-comm ask` 的门铃失败信号会把人引向错误补救

**Team**: FLY · **Priority**: Medium · **Label**: `Flywheel`

### 症状

```
flywheel-comm ask --lead <x> ...
→ [flywheel-comm] lead inbox nudge returned 401; durable queue row retained
→ [flywheel-comm] lead inbox nudge failed: This operation was aborted; durable queue row retained
```

### 真相与信号是反的

`packages/flywheel-comm/src/lead-inbox-nudge.ts:30-33` 的函数自述:

> Best-effort doorbell for the durable Lead inbox queue. **The queue row is the authority**; this request only shortens the next adaptive poll interval.

**消息真的进队了。失败的只是「门铃」。** 但调用方看到的是 `401` / `failed` —— 一个会被读成「我的消息没送到」的信号,引诱重发 → 产生重复。文案后半句 `durable queue row retained` 说了真话,但 `401` 三个字符的权重压过了它。

真实后果不是数据丢失,是 **Lead 的通知从「门铃即时」降级成「下一次自适应轮询」** —— 这是运维级事实(**每一条** Runner→Lead 通知都在降级),现在却只是一行 stderr。

### 已知触发面(两种,都在 FLY-1581 期间实测到)

| 形态 | 位置 | 说明 |
|---|---|---|
| `returned 401` | `:69-79` 已有一次 token 刷新重试(从 `~/.flywheel/.env` 读 `TEAMLEAD_API_TOKEN`);两次都 401 才打印 | env 与文件 token 都过期时,每条 ask 都会刷这行 |
| `failed: This operation was aborted` | `:39` `timeoutMs = args.timeoutMs ?? 200` | **200ms** 超时,本机负载稍高就 abort |

### 建议修法

1. **改文案,让它不可能被读成「没存下」** —— 把「消息已入队」放到句首、把失败降格为括注。例:`message queued (id=<x>); doorbell not delivered (401), Lead will pick it up on next poll`。
2. **连续 nudge 认证失败要作为运维信号浮出来**,而不是每次打一行 stderr 就算了 —— 它意味着整条 Runner→Lead 通知链在降级。
3. 200ms 超时是否偏紧,可一并评估(本机高负载下实测会 abort)。

---

## F2 — progress lock 的报错掩盖了「路径不存在」这个真实原因

**Team**: FLY · **Priority**: Medium · **Label**: `Flywheel`

### 症状

`flywheel-comm progress` 报 `could not acquire progress lock ... (another writer holds it)`,**但该 doc 目录当时并不存在**。排查的人会去查锁,而问题在路径。

### 根因(`packages/flywheel-comm/src/commands/progress.ts:387-406`)

```ts
const lockPath = `${absPath}.lock`;
for (let attempt = 0; attempt < 50 && fd === undefined; attempt++) {
    try { fd = openSync(lockPath, "wx"); }
    catch {                       // ← 不看 err.code
        try { const age = ...; if (age > 30_000) rmSync(lockPath, { force: true }); } catch {}
        sleepMs(100);
    }
}
if (fd === undefined) throw new Error(`could not acquire progress lock ${lockPath} after bounded retry (another writer holds it)`);
```

父目录不存在时 `openSync` 抛 `ENOENT`,被同一个**瞎 catch** 吞掉 → 自旋 50×100ms = 5 秒 → 报「另一个 writer 占着锁」。**`EEXIST`(真被占)与 `ENOENT`/`EACCES`(结构性错误)被合并成同一个错误面**,而后者重试一万次也不会好。

### 建议修法

`catch (err)` 按 `err.code` 分流:`EEXIST` → 才算被占(进重试);其它一律**立即**按真实 errno 失败,错误信息里带上真实原因与路径。

---

## F3 — no-write generalized 节点的 PROGRESS LEDGER 与 no-commit 规则自相矛盾

**Team**: FLY · **Priority**: High · **Label**: `Flywheel`

> **与 FLY-1581 / FLY-1584 同根。建议优先。**

### 矛盾

同一份注入提示词里:

| 来源 | 要求 |
|---|---|
| baseline-rules **PROGRESS LEDGER** 段 | 「每个有意义的步骤后」都跑 `flywheel-comm progress` |
| `progress.ts:186-209` | 该命令会 `git add` + `git commit --only -- <progress.md>` |
| generalized 段 `Blueprint.ts:1602-1604` | `This is a no-write node: do not modify the shared branch, **create commits**, push, or open a PR.` |

**对 `gate` / `land` / `generic` / `review` 四种 no-write 节点全部成立** —— 它们被同时要求「每步提交」和「不准提交」。

### 根因(与 FLY-1581、FLY-1584 是同一个)

**baseline-rules 与 DAG 契约都是按 legacy runner 写就的,注入 generalized 节点时从没按该节点钉死的 capabilities 对过账。** 三个症状:

- **FLY-1581**:失败出不去 —— 模板教的 `complete --route blocked` 被引擎恒拒 409;
- **FLY-1584**:成功了产出留不下 —— `no_code` 被 DAG 当成可以跳过落地节点;
- **F3(本条)**:连记进度都自相矛盾。

### 建议修法

**治本是让 baseline-rules 的注入按 node capabilities 分流**,而不是逐条打补丁。最小形态:no-write 节点注入一个不提交的 ledger 变体(写文件不 commit),或明确豁免该段。

---

## F4 — FLY-869 merge-block 对 generalized execution 覆盖不全

**Team**: FLY · **Priority**: Medium · **Label**: `Flywheel`

> **FLY-1581 调查中发现,并在设计评审 R7 主动做了范围收回**(继续折进去会把契约修复做成 merge-block 生命周期重构)。
> **若将来要放开「非-approved merged 失败声明」,F4 是前置。**

### 缺口(逐条已核实)

1. **没有 per-source-event 结算证据**:`complete-marker-reconciler.ts:600-620` 的 FLY-869 preflight 调 `parkMergeBlock` 后就删 marker,而 `setMergeBlock`(`StateStore.ts:6831-6853`)**只写可变的、head-bound 的 session 列** —— 无 receipt。
2. **preflight 闸门会自我失效**:`!currentSession.merge_block_reason` 一旦被首次写入满足,就**不再能证明「本事件已被结算」**;响应丢失后重放会按后来的状态重新分类。
3. **running 的 generalized 节点会搁浅**:只做 `setMergeBlock` 就消费 marker,run 停在 `active`;而 dead-exec sweep 跳过仍 `running`/无 teardown 的 session(`workflow-engine-dispatcher.ts:1157-1199`)→ **live 与 marker 看起来「对称」,DAG 却搁浅**。
4. **没有 generalized 排除**:该 preflight 的门只有 `markerLanding === "merged"` ∧ 无 `merge_block_reason` ∧ 非 no-out terminal,**不含** `!generalizedBinding`。
5. **恢复路径冲突**:真修需要原子 fence,但既有 same-head 批准恢复(`merge-ship-gate.ts:493-535`)会调 `runPostShipFinalization` → `claimWorkflowPrFinalization`,其契约**拒绝一切非 `active` 的 run**(`StateStore.ts:24534-24538`),且 workflow-run 管理路径里**没有**通用的 `held → active`。

### 建议修法(三件缺一不可)

1. immutable per-source-event settlement receipt,纳入准入的 exact-receipt 前置查找集;
2. 保留 merge-without-approval 的 **durable 告警义务**(现路径是先删 marker、再发一个不 await 的可选告警,`:649-660`,而 `alertMergeWithoutApproval` 会吞投递失败,`auto-qa-coordinator.ts:912-935`);
3. **原子 fence + 明确的恢复状态机**(窄授权的 `held → active`,绑死 incident receipt + same-head + question + owner/activation,让既有 finalization 原样跑完)。

### FLY-1581 侧当前的兜底(已实现在 plan 里)

非-approved 的 merged 失败声明 **fail closed**:CLI 层拒配 + 两 sink 一致 409 → `settlement_conflict` 终态(零 mutation、不进 legacy `applyQuarantineFallback`)。**明确不声称**跨 tick 永久零变更/无替换 —— 那需要 F4 的 fence,已作为已知残留风险写进 plan.md §2 A4c 与风险表。
