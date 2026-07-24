---
issue: FLY-1412
phase: implement
phaseCursor: 5/5
updated: 2026-07-23T06:40:00.000Z
nextStep: v23 = Annie 08:28 拆分落地。留登记强制(B0a/B0b 升必做+补严)+ 砍退役申报 + 每周扫描做退役出口。
  登记强制不卡 1150=ship-now;只有 B3 卡 1150。待 Lead review → Annie 过目 → Tadashi 拆。
  仍:不 ship/不 merge/不定稿/不开 gate。
chunks: []
pointers: {}
---

# FLY-1412 progress

**phase**: implement (5/5)

**next**: **v23 = Annie 08:28 拆分落地**(她澄清我之前砍多了)。两道 CI 分清:**登记强制留+补严**(B0a/B0b 从可选升为必做主 deliverable;B2′ 登记断言)· **退役申报砍** · 退役出口交每周扫描。longTermKeep = 扫描问、答留时写入的状态位。

**交付顺序**:登记强制(B0a/B0b/B2′/B1/B4)**不卡 1150 = ship-now**(恰好是 Annie 最担心的防野建);只有 **B3 卡 FLY-1150 + OQ-9**。

**等**:Lead review → Annie 过目 → Tadashi 拆。**仍:不 ship / 不 merge / 不定稿 / 不开 gate。**

## 决策状态(别再往回问)

| 项 | 状态 |
|---|---|
| OQ-1 / OQ-2 / OQ-3 / OQ-7 | ✅ **Annie 已拍** |
| OQ-4 | ✅ **Tadashi 已拍**(git 派生 + 两层责任链) |
| OQ-8 | ✅ **HL 已拍**(摆出来一张批量单;执行按动作性质拆) |
| OQ-5 / OQ-6 | 开着,**不阻塞本单**(CLI 入口 / 活读兜底,后者属 FLY-1150) |
| OQ-9 | 开着,**工程口径**(「有效值变迁」记录由谁产出 + 6 条产出方语义未定),**硬阻塞 B3**,不占 Annie 预算 |

> ⚠️ 本文件曾经停留在「等 Annie 拍 OQ-3/OQ-7/OQ-8」——**那三条早已拍完**。
> Codex code review R1 抓到这处不一致:一个过期的 progress 游标会**把已决事项重新路由回 founder**,
> 正是 PRD §8.3 明令要避免的失效模式。
