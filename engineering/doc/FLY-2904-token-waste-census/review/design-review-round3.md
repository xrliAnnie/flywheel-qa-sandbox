# Design Review — plan.md (Round 3)

Date / Author: 2026-09-25 / Codex / Status: APPROVED

## Summary

Round 2 的两项 (a) 和相关 (b) 修正均已核实关闭，没有剩余 BLOCKING finding。批准本只读研究计划及当前证据口径；情景节省仍是带假设的决策材料，不是实测收益或生产变更授权。

Reviewed head: `cc95840317a9da498aa0d1a940d167c890f79632`。
Reviewed plan blob: `cfa37b2c3374ecabb32c98dd38c84a401073d4bb`。

本轮限定复核等待代理集合、r11 权重文案、对应生成产物和引用/编号修正，未重开此前已关闭事项。只读检查实际 diff、源文件、CSV、JSON、原始反例及固定提交的外部引用。在内存中移除写入语句后复算，未改动仓库文件或生产配置；仅写本反馈文件。

## What's Good

- **等待集合修正关闭。** [verified by reading code / verified by executing] 从原 transcript 重新取出两个反例并执行当前分类器：`2026-09-22T19:21:57Z` 为 `bash:mixed-with-wait`，`2026-09-23T00:25:24Z` 为 `bash:test`；当前 CSV 一致。Node 写文件后 sleep 的字符串反例也归为 mixed，验证中未执行该命令。
- **代理口径已传播。** plan、research、构建脚本、推荐 JSON 和 HTML 均说明有限黑名单不能证明调用纯等待，可能包含复合工作。复算等待集合 **8,726 请求、1,461,358,961 token**；命中工作标记的 **10,627 请求、2,424,741,948 token** 未计入该集合。70–90% 明示为情景假设，不再作为已证明的删除比例。
- **r11 权重修正关闭。** 生成器、推荐 JSON、HTML 和 research 均改为“上下文前缀代理；缓存读为主，但未拆分缓存读 / 写构成”，不再声称全部为缓存读。原始 token 基数及其代理限制保持一致。
- **生成与排序闭合。** [verified by executing] 重新计算的 `summary.json` 全字段一致，`recommendations.json` 全字段一致，内存生成 HTML 与提交的 `report.html` 内容一致。12 个情景按分数降序排列，r4 为 **第 10、分数 5.8454**；r13 不排序，不提供总可省合计。
- **上一轮文案及引用细节关闭。** “情景低值”替代旧“下限”措辞；r5/r13 使用稳定 key；known/unknown/total 计数与 CSV 一致。构建脚本读取 `external_refs.json`。从固定提交 `4fc15a46e53a8b384b64eb00834ef73bc5ba6733` 的 `classes.csv` 汇总 Codex 非 K0 类，得到接班首回合 **4,048,946,998**、终态残留 **1,207,045,528 token**，与引用 JSON 一致；接班首回合仍仅供参考，不参与节省或排名。

验证状态：最终复算与反例核验均 exit **0**。一次审阅辅助脚本因列名筛选过宽，将百分比列误作整数解析而 exit 1；改为显式选择两个 token 列后，完整复算通过。这不是被评审脚本的异常。未执行发布、线上 HTTP/390px 验收或生产试验。

## Issues & Recommendations

无剩余 **(a) BLOCKING**，无新增 **(b) implementation detail**。Round 2 的两项阻塞及文案/引用修正全部关闭。发布验收继续按现有 plan §5 执行，无额外前置要求。

## Verdict

APPROVED
