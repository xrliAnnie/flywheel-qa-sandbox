# FLY-2619 Raya 汇报合同 · 渲染验证 — 调研
Issue: FLY-2619 (https://linear.app/geoforge3d/issue/FLY-2619)
日期: 2026-09-15
基于: plan.md

两次本地命令均失败：`mmdc -i engineering/doc/FLY-2619-raya-report-contract/flow.mmd -o engineering/doc/FLY-2619-raya-report-contract/flow.svg -w 1000 -b white --svgId FLY-2619-d1`。

错误：`bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer ... Permission denied (1100)`。
依注入合同保留 Mermaid 源和 DIAGRAM PENDING LOCAL RENDER 占位；没有伪造 SVG，没有使用远程渲染。未声称浏览器视觉 QA 通过。

留言层验证：Node VM DOM harness 检查通过：脚本语法、单 nonced script、无 CSP meta/inline handler/外部资产、每 section 留言、pathname 隔离与恢复、每块最多 1750 字、clipboard 不存在或拒绝均回退 execCommand。修复初次检查发现的换行转义错误。此为 DOM harness 检查，不是浏览器视觉 QA。
