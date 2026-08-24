# FLY-2014 turn-wait 回信假失败 — 探索
Issue: FLY-2014 (https://linear.app/geoforge3d/issue/FLY-2014/flywheel-commbug-respond-对引擎自铸的-turn-wait-冒号-id-必报错答案已落库仍-exit-1safe)
日期: 2026-08-24
基于: 无

## 1. 问题与成功标准

`flywheel-comm respond` 回答引擎自铸的
`turn-wait:<waiter>:<holder>:<epoch>` 问题时，`CommDB.insertGuardedResponse`
已经把 response durable 写入 `mailbox`，随后 marker 收尾却把同一个 ID 当成
gate-marker 文件名校验。`SAFE_QUESTION_ID=/^[a-zA-Z0-9_-]{1,128}$/` 不接受冒号，
因此 CLI 报 `gate-marker: invalid questionId` 并 exit 1。

本单成功必须同时证明：

1. `respond` 对真实形状的 `turn-wait:` ID exit 0；
2. waiter 经 `check`/`getResponse` 读到同一答案；
3. gate/ask marker 的写路径仍拒绝 `../`、`/`、冒号等非 marker-domain ID；
4. UUID gate marker 的 answered 收尾与 UUID ask marker 的删除行为不退化。

## 2. 已确认事实

- 临时 CommDB 重现稳定：`respond()` 抛
  `gate-marker: invalid questionId "turn-wait:waiter:holder:1"`，同时
  `getResponse()` 已返回刚写入的答案与 response UUID。
- 只读生产账本截至 2026-08-24：flywheel shard 有 94 条 `turn-wait:` question，
  其中 35 条已有 response。FLY-1999 的两条 question 分别在
  `2026-08-23T22:05:34.384Z` 与 `.535Z` 获得 response。
- `turn-wait:` 的确定性 ID 是 FLY-1614 的单次播报不变量：同一
  `(waiter, holder, epoch)` 在并发、crash 和 replay 后仍只产生一条 Lead message。
- `gate-marker.ts` 的正则同时承担 marker 文件命名域和路径穿越防护；普通 CommDB
  question ID 并没有被设计为都属于该文件命名域。
- `respond.ts::retireMarker` 在所有普通 response durable 写入后都会先调用
  `readGateMarker`，无论该 question 是否由 gate/ask marker 机制产生。
- 同样由引擎自铸的 `turn-wake-alert:<wake_id>` 具有相同潜在失败形状；本单不改其
  业务语义，但 marker lookup 的通用边界应避免复制同一事故。

## 3. 方案比较

### A. 严格写、温和读（推荐）

保留 `markerPath()` 的严格校验给 `writeGateMarker`/`writeAskMarker`；在
`readGateMarker` 与 `readAskMarker` 的 lookup 边界先判断 ID 是否属于 marker
命名域，不属于就返回 `undefined`，等价于“该 CommDB question 没有 marker”。

优点：保持路径穿越防护；不改变 FLY-1614 的确定性 ID；把“不属于 marker 域”表达
在 marker 模块自身；所有当前及未来 engine-owned 非 marker question 都得到相同语义。
代价：需要用正负测试明确 read 与 write 的非对称合同。

### B. 只在 `respond.ts::retireMarker` 跳过非安全 ID

导出/复制一个 ID 谓词，`retireMarker` 在 lookup 前提前返回。

优点：改动最局部。缺点：`respond` 被迫知道 gate-marker 的文件名规则；其他调用者仍会
把“没有 marker”的普通 question 当异常；复制正则会产生漂移风险。

### C. 改铸 UUID 或把任意 ID 编码成 marker 文件名

可把 `turn-wait` question 改为随机 UUID，或用 hash/base64 映射任意 question ID。

优点：所有 ID 可进入 marker 文件域。缺点：随机 UUID 会破坏 FLY-1614 的 durable
幂等身份；确定性 hash 仍要迁移可观察 ID、账本与测试；实际并不存在 turn-wait marker，
为不存在的文件建立编码层是额外复杂度。

## 4. 推荐设计

采用方案 A。marker 模块维持两个清晰边界：

- mutation：调用严格 `markerPath`，非法 ID fail-closed；
- lookup：非法/外域 ID与缺文件、损坏文件一样，返回 `undefined`。

`respond` 的数据流不变：先完成 guarded response 写入，再 best-effort 收尾；当 ID 不属于
marker 域时，gate lookup 返回不存在，ask-marker 删除继续是无异常的 best-effort no-op，
最终 CLI 正常输出 `Responded to ...` 并 exit 0。

## 5. 边界与不做

- 不改变 `turn-wait:` 或 `turn-wake-alert:` 的 ID 格式。
- 不放宽 marker 文件名允许字符，不创建冒号文件，不吞掉 marker 写失败。
- 不改 CommDB response 幂等、Lead 鉴权、TURN ledger 或 mailbox delivery。
- 不把 post-write marker 收尾改成大范围 catch；真实 UUID marker 的写盘错误仍应可见。

## 6. 会过期的结论

| 结论 | as-of | 重核命令 |
|---|---|---|
| `turn-wait:` 仍由 `db.ts` 确定性铸造 | 2026-08-24 / `533adc64f` | `git log -S 'turn-wait:' -- packages/flywheel-comm/src/db.ts` |
| `respond` durable 写后调用 `retireMarker` | 2026-08-24 / `533adc64f` | `rg -n 'insertGuardedResponse|retireMarker' packages/flywheel-comm/src/commands/respond.ts` |
| marker 命名域不含冒号 | 2026-08-24 / `533adc64f` | `rg -n 'SAFE_QUESTION_ID' packages/flywheel-comm/src/gate-marker.ts` |
| FLY-1999 两条 response 已落 production shard | 2026-08-24 只读查询 | `sqlite3 -readonly ~/.flywheel/comm/flywheel/comm.db "SELECT id,ref_id,created_at FROM mailbox WHERE ref_id LIKE 'turn-wait:%' AND type='response' ORDER BY created_at DESC;"` |
