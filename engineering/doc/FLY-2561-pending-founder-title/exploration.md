# FLY-2561 待批标题 — 探索
Issue: FLY-2561 (https://linear.app/geoforge3d/issue/FLY-2561/thread标题-dag-流程下-ship-卡开着时-thread-标题不变待批仍显示-qaissue-display-只在-session)
日期: 2026-09-14
基于: 无

Founder 看见 ship 卡却仍是 QA。Lead 2026-09-14 更正原始根因假设，要求先区分 (a) 漏 enqueue、(b) 重连占用、(c) Discord 写失败。现有 FLY-2408 derive 已有 gate overlay，不应新增 pendingFounderGate。

按 20:47:09 受管生产副本回放，FLY-2553/2554/2555 全部 approve、attention=true、reviewHeld=false。三种 park 输入均一致。问题在刷新触发链。
