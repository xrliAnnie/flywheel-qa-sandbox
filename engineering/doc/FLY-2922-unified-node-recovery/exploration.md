# FLY-2922 重开后同头收口与 QA@4 — 探索
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-29
基于: 无

## 1. 这轮设计面对的事实

本节点是 DAG 的 `eng_design`，只负责把当前重开轮变成可执行、可验收的合同；不合 main、不改产品或 harness、不起 QA 房、不请求 ship。

注入指令记录的起点是 PR #1374 头 `7d5d084cf` 与 `origin/main` 冲突，需要保留统一恢复口、真实派发、FLY-2913 role prefix 和 QA 房间隔离语义。但开工时的权威外部状态已经继续前进：

- 生产分支 `flywheel-FLY-2922` 与 GitHub PR #1374 都在 `6e21a123d34bb53ee29b8536503133d714f46435`。
- 最新 `main` 是 `b165d649013d6b52899f395865e68d948c2f4831`，已由 merge `7b5bc1520` 纳入该分支；GitHub 报告 `MERGEABLE/CLEAN`。
- PR 精确头 CI run `36544821509` 的 `CI OK` 与所有展开 job 已通过。
- 生产 progress 仍写着 `implement 3/4`，下一步是同头复审与交卷；当前提交证据没有证明 `6e21a123d` 已取得有效的同头代码复审 verdict。
- QA@4 的真实双 Lead 房与完整 driver 证据仍缺失；Lead 先前使用 Codex→Claude fallback 的宿主实测已明确作废。

因此不能照抄旧 SHA 再合一次，也不能因为 PR clean/CI 绿就越过同头复审或 QA。设计必须把“状态已经前进”作为一等输入。

## 2. 方案比较

| 方案 | 优点 | 致命问题 | 结论 |
|---|---|---|---|
| 按注入文本固定重放 `7d5d084cf → merge main` | 最接近旧步骤字面 | 会对已推进到 `6e21a123d` 的分支做陈旧写入，可能重复 merge、移动已绿 CI 的头 | 拒绝 |
| 把 `CLEAN + CI OK` 当作实现已完成，直接让 QA 起房 | 最快 | 缺少当前精确头代码复审；后续任何 push 又会让 CI 证据失效 | 拒绝 |
| **证据驱动的同头收口**：先冻结远端 PR head/main；仅在 main 未被包含时 merge；每次头变化都重做同头复审和精确头 CI；完成后再由 QA 自己起双房 | 不重复旧操作，且保留所有硬门；可以从当前状态自然继续 | 要把每种证据绑定到同一 SHA，合同更严格 | **采用** |

## 3. 一句话设计

实现节点只把 PR #1374 收敛成一个“main 已包含、复审 APPROVED、精确头 CI OK”的冻结头；QA 节点随后以这个完整 SHA 自己占两个空房，跑完真实 Claude 设计评审与九步 driver，并用持久账本证明 held/rework 之后确实出现新的当前节点执行与派发。

## 4. 不变量

1. **头身份唯一**：PR head、分支远端、复审对象、CI commit、`--expect-head` 与 QA evidence 的 `expectedHead` 必须是同一 40 位 SHA。
2. **merge 按需而非按记忆**：只有最新 main 不是 PR head 祖先时才 merge；永不 rebase、永不 force-push。
3. **两边语义都保留**：冲突只做加法合并。统一恢复的 initial-start authority、真实 dispatch ledger 与 parked-body 协调器路径不能丢；main 的 role prefix、Codex guard 与新生命周期逻辑不能丢。
4. **本机测试只定点**：严格遵守 local-test-policy；不运行本机全仓或全包测试，不用目录、glob、`-t` 或 bare vitest 冒充文件选择。
5. **QA 自己起房**：implement/design 不替 QA 起房。QA 先查 room service ledger 与宿主目录，只用两个同时空闲的显式槽位；禁止 `auto`。
6. **真评审、受限 stub**：`--qa-stub-runner` 只截获 QA execution；设计评审必须落到真实 Claude，Codex implement 不得 fallback 成 Claude 来冒充目标拓扑。
7. **放行要有体**：状态字段变化、`node_dispatched` 展示事件或 gate 文本都不能单独证明恢复；必须同时有新 execution、launch ordinal、dispatch ledger/receipt 与 driver 消费证据。
8. **关体不关 run**：QA 的故障/park 场景中，旧执行体可以终结或停驻，但 workflow run 必须保持可继续，直到后继节点真实推进。

## 5. 明确边界

本设计不重新设计已批准的统一恢复事务，不扩大 PR #1374 的产品范围，也不把当前 CI 绿当作 QA PASS。它只规定：实现轮如何从权威远端状态安全收口，以及 QA@4 如何用隔离双房验证 held/rework → 统一恢复 → 新派发的真实链路。
