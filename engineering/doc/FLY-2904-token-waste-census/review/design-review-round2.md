# Design Review — plan.md (Round 2)

Date / Author: 2026-09-25 / Codex / Status: CHANGES REQUESTED

## Summary

大部分修正已闭合。本轮还剩 **2 项 (a)**：轮询集合仍被过强地称为“整条命令就是等待”；前缀建议的页面仍称“全是缓存读”。均为上一轮问题的残留，不要求扩大研究范围或开展生产试验。

Reviewed head: `a48949c0abcba6967d6c269e1e9640347aa610e1`。
Reviewed plan blob: `9ba570bc9ddfe1e375ed12ab6f10865528806ba9`。
下文路径相对 `engineering/doc/FLY-2904-token-waste-census/`，另有注明者除外。

只读复核了 plan、research、统计/构建脚本、全部 derived JSON、对应 CSV 和上一轮反例的 transcript。在内存中移除脚本写入语句后复算，未调用原脚本的写入入口。核验命令均 exit 0；仅创建本反馈文件。没有生产配置变更、发布、完整测试套件或线上布局验收。

## What's Good

- **复算一致**：`summary.json` 全字段一致；`recommendations.json` 全字段一致；内存生成的 HTML 与已提交 `report.html` 字节内容一致。排序确实按 12 条情景中值 × 系数执行，r13 不排序，无总可省合计。
- **R1 #1 关闭**：40.5 亿已降为未分离参考，终态残留独立对应 FLY-2814 / FLY-2892；FLY-2893 SHA 已固定，不再声称修前三类可省 52 亿。
- **R1 #3 及窗口计数修正关闭**：151 字符反例现为 unknown；已知输出全部满足新 cap。直接执行归因函数确认窗口外请求不增加重读次数、被标记为有外部输入的增长不归因。大输出集合复算为 Claude **1,534,546,257** + Codex **1,498,076,208** = **3,032,622,465 token**。这是声明了分摊/cap 规则的估算，仍不等于精确识别了可删内容。
- **R1 #4 关闭**：Monitor **317 回合、504,402,520 token**；后台 **384 回合、1,593,730,851**，按回合关联后闭合，不再以通知条数占比推 token。
- **R1 #5 的范围修正关闭**：runner + review + qa_env 基数 **3,368,679,232**，30–50% 情景正确为 **10.11–16.84 亿**，已排除 Lead；最小上下文代理限制已写明。权重文案还有下述残留。
- **R1 #6 和模拟单位修正关闭**：baseline、身份匹配、余量、CLI 探针和试点审批均已说明，好做改为 M。40 万模拟复算为 **9,137,104,085 token、909 次**；25 万为 **11,374,610,532、2,049 次**。工程 Lead 占 40 万模拟节省 **82.83%**。这些是条件模拟，非试点已取得的收益。
- **R1 #7/#8 的核心修正关闭**：情景假设与观测量分开；ack 后继续调用工具的部分排除，收尾集合复算为 **5,457 请求、2,582,466,787 token**。上一轮两个外部输入反例均含 `(external)` 标记而被排除。情景值不再被整体承诺为证据下限，排名也与公式一致。

## Issues & Recommendations

1. **(a) BLOCKING — R1 #2 未完全关闭：纯等待分类仍接受复合工作和非执行文本，上一轮一个实测反例仍在 20.2 亿里。**

   位置：`evidence/scripts/census.py:180-201`、`analyze.py:488-501`；`research.md:84-86`；`plan.md:55`；`build_report.py:58,243`。

   [verified by reading code / verified by executing] 新规则仍是对完整参数字符串搜索 wait，再用有限 WORK_RE 排除；没有命中工作标记不等于已证明整个调用只有等待。WORK_RE 没有排除任意 Node 脚本，并显式放行 `git rev-parse/status/fetch`。

   重新执行上一轮两个实际输入的分类：

   - session `6ab081b3-29b7-4cec-8a85-30f59133928a`，`2026-09-22T19:21:57Z`：仍为 **`wait:inbox`**。当前 CSV `file_id=745` 同样记录该标签，**162,844 token** 仍进入 poll。实际调用同时读取 CI、Git HEAD、工作区状态和 inbox。
   - 同 session，`2026-09-23T00:25:24Z`：测试注释里的 `while` 现为旧标签 **`bash:sleep/poll-loop`**，因此不再进入新的 wait 集合，误计已消除；但它也没有归入 mixed。

   因此 research 的“两个误判在新规则下都归到这一类”不成立。另以只传字符串、不执行 shell 的反例核验：`node -e` 写文件再接 `sleep 1`，以及只 echo 一段含 `sleep 60` 的文字，都被判为 `wait:sleep-loop`。这说明“排除脚本/文件写入、整条命令就是等待”的保证没有实现，而不只是某一数字的舍入问题。

   建议二选一：

   - 将无法确认仅等待的调用归为 mixed/unknown，复算集合、情景及排名；至少让上述真实反例从纯等待集合退出。
   - 保留有限启发式，但将该集合明确命名为“命中等待模式且未命中工作黑名单的调用”，承认仍可能含复合工作，撤回已排除所有其它工作的表述，并将收益保留为这一代理集合的条件情景。

   不要求为此实现通用 shell/JavaScript 解析器，也不要求生产实验；需要使数字的名称与证据强度一致。

2. **(a) BLOCKING — R1 #5 的“全是缓存读”仍从生成器传播到推荐 JSON 和页面。**

   位置：`evidence/scripts/build_report.py:92-96`；`derived/recommendations.json` 的 `key=r11` / `w`；生成页面第 9 条。

   范围和 33.7 亿基数已修好，但 `w="全是缓存读，加权后约 1/10"` 未改。`analyze.py:515-525` 仍按 `max(min_ctx - 45000, 0) × requests` 计算，并未按逐请求 cache_read 切分。

   [verified by executing] 在本次纳入的角色/文件中，**1,549 个请求**的单请求前缀贡献大于其全部 cache_read，合计超出 **30,087,970 token**。例如 CSV `file_id=83`、`2026-09-15T02:20:40Z`：该项贡献 **45,459**，但 cache_read **0**，cache_creation **155,969**。故不能断言整个集合全为缓存读。这不是要求推翻原始 token 情景；是修正已经指出过的绝对化权重结论。

   建议：改成“上下文前缀代理；缓存读为主，但未拆分其缓存读/写构成”，去掉该项全部按 1/10 折算的暗示；若需精确加权，则另按逐请求字段计算。重生成 recommendations 和 HTML 即可。

3. **(b) implementation detail — 统一剩余说明文字、编号和输入来源，避免下一次生成又带回旧口径。**

   - `build_report.py:244` 和 HTML 口径段仍写“下限打了 2/3 折”，改成“情景低值”。其它位置已明确不是保底，故此处按文案残留处理，不重新打开已接受的情景方法。
   - `plan.md:65` 的“第 5 条只算终态残留”是旧编号；排序后终态残留是第 **11** 条。建议使用稳定 key / 方案名引用。
   - `research.md:106` 的输出计数需标清 known/unknown：CSV 中 Claude 总计 **158,038 = 156,391 known + 1,647 unknown**；Codex **150,317 = 133,039 known + 17,278 unknown**。现写法容易把 known 数看成总分母。
   - `plan.md:82` 写“只从 derived JSON 读数”，但 `build_report.py:19` 的 FLY-2893 未分离参考值仍是常量。它已不参与收益/排名，不构成此轮数值阻塞；实现时可移入带来源 SHA 的输入 JSON，或明确这一条是固定引用例外。

## Verdict

CHANGES REQUESTED

剩余阻塞仅为上述 2 项 (a)。其余已核实的修正不重新打开；下一轮可限定检查纯等待口径与 r11 权重文案及其生成产物。
