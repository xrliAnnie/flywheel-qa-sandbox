# FLY-2553 v5 — 审查后续项
Issue: FLY-2553 (https://linear.app/geoforge3d/issue/FLY-2553)
日期: 2026-09-15
基于: implementation-evidence.md

Lead回执1fa0dc82裁定本轮仅修HIGH，以下MEDIUM/LOW仅记后续，不进入当前实现。来源：gate d1c9e34b，round2，reviewedHead5f1a1a72d。

- MEDIUM `gate-count-before-node-filter`：reads.gates.count在node_id过滤前计数；若模板使用其他gate节点名，candidate数量与schema计数可能不一致。后续以包含两种节点的生成级测试验证，再决定保留后计数或按manifest权威处理。
- MEDIUM `founder-named-under-waiting-lead`：Linear founder-review标签事项被放进“在等Lead的”附录，标题可能误表受众；附录诊断和标题还缺分隔。后续调整附录标签/行排版，维持本轮首屏去噪约束。
- LOW `undefined-red-css-var`：urgent边线使用未定义的--red，且零事项仍绘制urgent边框。后续补主题变量并核对零态浏览器视觉。
