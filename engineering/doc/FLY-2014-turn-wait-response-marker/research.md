# FLY-2014 marker 命名域与 respond 收尾 — 调研
Issue: FLY-2014 (https://linear.app/geoforge3d/issue/FLY-2014/flywheel-commbug-respond-对引擎自铸的-turn-wait-冒号-id-必报错答案已落库仍-exit-1safe)
日期: 2026-08-24
基于: exploration.md

## 1. 审计范围与基线

逐行审计：

- `packages/flywheel-comm/src/db.ts::insertQuestion/observeTurnWait`
- `packages/flywheel-comm/src/commands/respond.ts::respond/retireMarker`
- `packages/flywheel-comm/src/gate-marker.ts`
- `gate-marker.test.ts`、`respond-mailbox.test.ts`、`cli.test.ts`
- FLY-1614 的 `exploration.md/research.md/plan.md/design-correction.md`
- `git log -S`、`git blame` 与只读 production CommDB 查询

在无源代码改动的 `533adc64f` 上，依赖安装后
`pnpm --filter flywheel-comm... build` 通过；误用包脚本参数后实际跑出的完整
flywheel-comm baseline 为 **112 files / 1,614 passed / 2 skipped**。现有 suite 全绿，
说明缺口是没有覆盖“非 marker-domain 的确定性 question ID 经 CLI respond”这一交叉边界。

## 2. 精确故障链

```text
CommDB.observeTurnWait
  └─ questionId = turn-wait:<waiter>:<holder>:<epoch>
     └─ insertQuestion(..., { id: questionId })       durable question

flywheel-comm respond
  ├─ getMessageById(questionId)
  ├─ authorizeLeadWrite(...)
  ├─ insertGuardedResponse(...)                       durable response
  └─ retireMarker(questionId, waiter, env)
     └─ readGateMarker(markerDir, questionId)
        └─ markerPath(...)
           └─ SAFE_QUESTION_ID.test(questionId) === false
              └─ throw gate-marker: invalid questionId

CLI main().catch
  └─ stderr Error: ...; process.exit(1)
```

故障不在 CommDB 写入、Lead 鉴权或 TURN ledger。错误由两个各自正确但未建立边界的
合同相撞产生：

1. engine question ID 允许冒号，并依赖可读确定性 ID完成 replay 去重；
2. marker 文件名只允许 `[a-zA-Z0-9_-]`，用同一校验阻止路径穿越；
3. `respond` 把所有 question 都送进 marker lookup，错误地把 CommDB ID 域当成 marker
   文件 ID 域的子集。

## 3. 变更历史定位

| 时间/commit | 变化 | 与本 bug 的关系 |
|---|---|---|
| 2026-06-05 `581f9e8a1` | 引入 `SAFE_QUESTION_ID` 与 `markerPath` | 对真正 marker 的 fail-closed 写入是正确安全边界 |
| 2026-08-05 `754541aa2` | FLY-1572 把 response 收尾收敛为 `retireMarker` | 普通 question 也统一先查 gate marker |
| 2026-08-11 `e8c1df3b5` | FLY-1614 引入确定性 `turn-wait:<...>` | 第一个明确不属于 marker 文件域、又会由 Lead respond 的主路径 |

FLY-1614 设计修正明确要求同一 `(waiter, holder, epoch)` 全生命周期最多一条 Lead
message。把该 question 改为随机 UUID 会倒退这个已审核不变量；即使改为确定性 hash，
也会无收益地改变可观察账本身份。

## 4. working 与 broken pattern 对比

| 路径 | question ID 来源 | 是否写 marker | respond 收尾现状 |
|---|---|---|---|
| `gate --no-block` | 默认 UUID（可选显式 ID，但 marker 写入会严格校验） | gate marker | UUID lookup → 标 answered |
| `ask` | 默认 UUID | ask marker（Codex env 下） | gate lookup miss → 删除 ask marker |
| blocking gate / markerless UUID ask | UUID | 无 | 两次 lookup/no-op 后成功 |
| `turn-wait` | `turn-wait:<waiter>:<holder>:<epoch>` | 无 | gate lookup 在“是否存在”之前抛错 |
| `turn-wake-alert` | `turn-wake-alert:<wake_id>` | 无 | 同形潜在错误 |
| Bridge workflow gate | `workflow-gate:<submission-digest>` | 无本地 marker | Bridge 已提交决策后，同形 lookup 抛错 |

差异只有 ID 是否属于 marker 文件命名域，而非 response 数据语义。由此可得边界：
marker lookup 对外域 ID 应表示“没有 marker”；marker mutation 对外域 ID仍必须拒绝。

## 5. production 与可重复证据

只读查询 `~/.flywheel/comm/flywheel/comm.db`：

- `workflow-gate` question 共 157 条，130 条已有 response；`turn-wait` 共 95 条、36 条
  已有 response；`turn-wake-alert` 共 7 条、尚无 response（as-of 2026-08-24
  设计评审复核时刻）；
- FLY-1999 两条 response ID 为
  `f6af3d48-4e37-497a-99df-531279b011d9` 与
  `019597f8-96e6-4305-8cec-e0ba0d0982c4`，写入时刻分别为
  `2026-08-23T22:05:34.384Z` 与 `.535Z`；
- production DB只能证明 durable response 已写，不能单独证明对应进程退出码；退出码由
  临时库稳定复现与 `main().catch → process.exit(1)` 代码链证明。

临时库复现输出：

```json
{"error":"gate-marker: invalid questionId \"turn-wait:waiter:holder:1\"","responsePersisted":true}
```

## 6. 单一假设与最小验证

**假设**：若 marker 的 read-only lookup 在正则不匹配时返回 `undefined`，
`retireMarker` 就会把 engine-owned question 当作 markerless question继续 best-effort
ask cleanup；既有 guarded response 保持不变，CLI 正常 exit 0。原因是故障链唯一 throw
位点位于 `readGateMarker → markerPath`，后续 `removeAskMarker` 已自带 catch/no-op。

最小 TDD 验证分三层：

1. `gate-marker.test.ts`：先用安全 UUID证明 gate/ask marker 仍可读、gate 仍可标 answered，
   再证明 `readGateMarker`/`readAskMarker` 对 `turn-wait:` 与路径穿越形状返回
   `undefined`；两个 write API继续拒绝冒号 ID。
2. `cli.test.ts`：直接插入真实形状的确定性 question，运行 built CLI `respond`，同一次
   断言 `exitCode=0`、stdout 确认，再运行 `check` 读回答案。
3. `respond.gate.test.ts`：用 `workflow-gate:` ID走成功的 Bridge `approve_to_ship` 路由，
   证明 Bridge side effect 后的 marker 收尾同样不抛错。

先在当前实现上看到上述新测试因 invalid questionId/exit 1 正确变红，再改生产代码。

## 7. 实现边界

建议在 `gate-marker.ts` 内增加只读路径解析 helper：安全 ID返回现有 `markerPath`，
外域 ID返回 `undefined`。两个 read API 使用该 helper；所有 write API继续直接调用严格
`markerPath`。不在 `respond` 添加正则，不包裹宽泛 catch，不改变数据库或 ID 铸造。

## 8. 会过期的结论

| 结论 | as-of | 重核命令 |
|---|---|---|
| 完整 package baseline 1,614 pass / 2 skip | 2026-08-24 / `533adc64f` | `pnpm --filter flywheel-comm test:run` |
| 已知会进入 `respond` 收尾的冒号 ID至少含 `workflow-gate`、`turn-wait`、`turn-wake-alert` | 2026-08-24 / `533adc64f` | `rg -n 'workflow-gate:|turn-wait:|turn-wake-alert:' packages --glob '!**/__tests__/**'` |
| response 先写、marker 后收尾 | 2026-08-24 / `533adc64f` | `sed -n '115,215p' packages/flywheel-comm/src/commands/respond.ts` |
| production workflow-gate 157/130、turn-wait 95/36、turn-wake-alert 7/0（question/answered） | 2026-08-24 设计评审复核时刻 | `sqlite3 -readonly ~/.flywheel/comm/flywheel/comm.db "SELECT CASE WHEN id LIKE 'workflow-gate:%' THEN 'workflow-gate' WHEN id LIKE 'turn-wait:%' THEN 'turn-wait' WHEN id LIKE 'turn-wake-alert:%' THEN 'turn-wake-alert' END class,COUNT(*),SUM(EXISTS(SELECT 1 FROM mailbox r WHERE r.type='response' AND r.ref_id=q.id)) FROM mailbox q WHERE q.type='question' AND (q.id LIKE 'workflow-gate:%' OR q.id LIKE 'turn-wait:%' OR q.id LIKE 'turn-wake-alert:%') GROUP BY class;"` |
