# FLY-2072 病根 Epic 待办盘点 — 交付物

由 FLY-2915 产出(2026-09-25,数据截至 2026-09-26T03:00Z)。方法与口径见 `engineering/doc/FLY-2915-epic-backlog-triage/`。

| 文件 | 内容 |
|---|---|
| `tickets.json` | 166 张待办逐张结论:`verdict`(已修未关 / 重复 / 一次性记录 / 仍有效)、`evidence`(PR# / sha / canonical / 最近实例)、`occurrences`、`last_seen`、`root`(四病根 1–4,0=环境杂项)、`fix_class`(所属类) |
| `fixclasses.json` | 「仍有效」118 张归并成的 16 类,按合计次数排序:张数、合计次数、最近一次、删状态/删路径式修法方向、改动面 |
| `founder-report.html` | 给 founder 拍板的页面(每类 修 / 先不修 / 要讨论 + 评论 + 复制全部) |

⛔ 本目录只是盘点结论;关单、改状态由 Lead 复核后执行。
