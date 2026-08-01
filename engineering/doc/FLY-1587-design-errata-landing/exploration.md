# FLY-1587 承接 1580 落地 design.md 两处更正 — 探索

Issue: FLY-1587 (https://linear.app/geoforge3d/issue/FLY-1587/承接-1580-落地-designmd-两处更正-同步回-1569-正文patch-已逐字写好)
日期: 2026-07-31
基于: 无(上游探索见 `upstream-FLY-1580/exploration.md`)

## 1. 这单为什么存在

**方案不是本单做的,FLY-1580 已经做完了。** 本单存在的唯一原因是 FLY-1580 的 run 搁浅了:

```
2026-08-01 02:04:53  no-write 设计节点 complete --route no_code
                     → DAG 跳过落地节点直奔 approve_to_ship gate
                     → 分支零提交 · 无 PR · design.md 未修改
2026-08-01 02:05:21  gate 无人回答,27 秒后 terminal_disposed
重派                 → STALE_START_RESPONSE(永久卡死)
```

FLY-1580 的 runner **行为是正确的** —— 它的节点被标为 no-write,plan.md 开头就写明「本节点是 no-write … 所以下面的 patch 没有落地。执行节点照 §1→§5 顺序走即可」。问题在于那个执行节点从来没有运行。

⇒ **FLY-1580 留着当证据不动。本单只做一件事:把它已经写好的 patch 搬进 main。**

## 2. 本单的范围边界(极窄)

| 做 | 不做 |
| -- | -- |
| 改 `doc/messaging-rework/design.md` 两处 | ❌ 改设计的任何其他部分 |
| PR 合入 main **之后**同步 FLY-1569 正文 | ❌ 动代码 / 建表 / 改 schema / 加 feature flag |
| 实跑「恰好三个 hunk」不变量复核 | ❌ 「顺手优化」措辞 —— 两侧必须字节级可核验 |
| 过程文档随 PR 进 main | ❌ 重跑设计评审(FLY-1580 已过 Codex design review) |
| | ❌ 碰 FLY-1573 —— Lead 本人已改(上游 §3.3) |

## 3. 措辞判断已经拍完,本单不重判

上游 `exploration.md §5` 已经拍板了两个判断,并经 Codex 设计评审:

* **判断 A(更正② 放哪)** —— 选 **§3 开头**,不选 §4 末尾。理由:§4 最后一个子节是 `### in-flight 上限为什么是 3 不是 1`,块贴过去会在视觉上落进那个 `###` 子节内部,读成「在讲 in-flight」,而这块是统管 §3/§4 的总则。
* **判断 B(排版)** —— 两块都用围栏代码块逐字照抄。散文会把单换行折成一段,`⇒ 既不会…` 会被并进上一行,结构就丢了;补 `<br>` 又是加字符。围栏还保证与 FLY-1569 正文逐字节同形。

⇒ 本单**执行,不重新设计**。

## 4. 本单自己撞上的同一个约束冲突(已上报 Lead)

本节点的 Agent Role 预置文本里同样写着 **no-write node**:不许改分支 / 提交 / push / 开 PR,完事走 `complete --route no_code`。

但 FLY-1587 的 dispatch 正文把这条明确推翻了:

* 验收标准要求 **PR MERGED** + **main 上可复现的 diff**
* 明写「本单不接受任何形式的完成声明」「早提交、早 push、早开 PR」
* 并点名:上一次搁浅的根因**正是** no-write 节点走 `no_code` 让 DAG 跳过落地节点

⇒ 按 dispatch 明文执行(改文件 + commit + push + 开 PR),已用非阻塞 `ask`(`88b2fa7d`)报给 Lead 知会。**merge 仍然是 founder-gated,本节点不自行 merge。**

## 5. 明确不做

* ❌ README.md —— 无口径冲突(上游 research §2 半径核过,本单复跑 `grep -rn "最多产生一封死信" doc/` 确认唯一命中在 design.md)
* ❌ 文末附录 —— 两边同步改 ⇒ 改动不进 diff ⇒ 附录一个字都不用动
* ❌ 中文标点规范化 —— 附录明写「未做任何中文标点规范化」,继续保持
* ❌ FLY-1573 —— Lead 本人改,碰它就是撞车
