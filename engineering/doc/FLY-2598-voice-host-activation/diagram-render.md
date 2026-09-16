# FLY-2598 本地图形渲染记录 — 调研
Issue: FLY-2598 (https://linear.app/geoforge3d/issue/FLY-2598/语音激活-主机激活-2446-通用语音进程会议模式-随身模式注册表-huddle-块-lead-voicemodes-voice)
日期: 2026-09-15
基于: plan.md

flow.mmd 与 identity.mmd 各尝试本地 mmdc 两次，均失败，退出1。标准命令：
`mmdc -i <source.mmd> -o <output.svg> -w 1000 -b white --svgId FLY-2598-d1|FLY-2598-d2`。
失败证据：`bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer … Permission denied (1100)`。
按任务 h) 规则交付 `DIAGRAM PENDING LOCAL RENDER` 占位并保留相邻 Mermaid 源码。未伪造 CSS 流程图，未用远程渲染，未声称完成真实浏览器视觉 QA。
有本地图形权限的后续执行者可按上述命令生成 distinct-id SVG，内联入 HTML 后重新发布；这不改变方案合同。

独立语法验证：用本机同一 Mermaid 安装的 `mermaid.parse` 解析两份源码，flow识别为sequence、identity识别为class，均成功。这只证明语法有效，没有生成SVG或完成浏览器视觉验证。
