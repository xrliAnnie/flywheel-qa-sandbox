# FLY-2553 固定 Epic 页减噪 — 探索
Issue: FLY-2553 (https://linear.app/geoforge3d/issue/FLY-2553)
日期: 2026-09-14
基于: 无

任务依据：实时 Linear 描述（2026-09-14 读取）含第6项/C6；Lead instruction 41e1f78f-2ea7-4f20-9df1-fda27a16e883。第6项明确扩展原“仅渲染层”范围到 attention 查询过滤，不改数据库 schema、不修改生产数据库。

目标：首屏仅真正需要 founder 的事项；Epic 默认收起；六段固定顺序；四段旧总览删除，可开始事项折叠到页尾；Epic 无 Lead note 显示明确占位。报告前缀、终态 ask 不能进入 attention。Lead 待答折叠。

当前 HEAD f31b75af9。TURN implement epoch1 已取得。仓内没有 FLY-2553 设计或进度文档。实现节点依注入 DOC-FLOW 补齐文档并请求设计审查，不自行绕过批准。
