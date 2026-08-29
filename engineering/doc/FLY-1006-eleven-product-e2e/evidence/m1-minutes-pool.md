# FLY-1006 dashboard 分钟池核查（P4）— 取证

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-08
基于: plan.md §S4；FLY-980 v10-cost-and-runbook.md §1

## 执行情况

- Claude-in-Chrome 只读打开 elevenlabs.io usage 页 →
  `/app/usage` 重定向到 Sign In（本机 Chrome 未登录 elevenlabs.io）。
- 按 plan §S4 fallback：**dashboard 视觉核查转请 Annie 本人瞥一眼**
  （只需看 usage/subscription 页有没有独立的「Agents 分钟」计数器，截图即可）。
  未做任何登录/账户操作（只读纪律）。

## API 侧证据（本单新增，与 980 结论一致）

本单全部 `usage.mjs` 快照（fly1006-before-all / after-operator / after-annie-s1，
raw 留档 `~/fly1006-eleven/usage-*.json`）：

- `convai_characters_per_minute` 恒为 **null**——subscription API 无任何
  Agents 分钟池字段；
- `character_count` 随 Agents 会话实时增长（7,451 → 8,100 → 8,705，全部
  归因于会话，见 credits-ledger.md）——会话直接扣 character（credits）池。

## 当前结论（待 Annie dashboard 一瞥定稿）

API 可见范围内**只有单一 credits 池**：坐实 980 的「credits 单池」判断。
「275 分钟/月」若作为独立池存在，只可能在 dashboard 上可见——两种结果都有
价值（有计数器 = 980 报告更正；没有 = 单池结论定稿），等 Annie 截图后补记。
