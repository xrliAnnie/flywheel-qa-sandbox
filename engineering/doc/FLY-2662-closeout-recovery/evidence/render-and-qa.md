# FLY-2662 HTML 验证记录 — 调研
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662)
日期: 2026-09-17
基于: ../plan.md

两张图都用本机 `/opt/homebrew/bin/mmdc`，没有远端渲染。
- flow 第一次 2026-09-17 19:22:27Z；标准重试 19:22:46Z。
- model 第一次 19:22:46Z；标准重试同秒。
- 标准命令形状：`mmdc -i engineering/doc/FLY-2662-closeout-recovery/<flow|model>.mmd -o engineering/doc/FLY-2662-closeout-recovery/<flow|model>.svg -w 1000 -b white --svgId FLY-2662-d<1|2>`。
- 每次退出1，原始关键错误：`FATAL:mach_port_rendezvous.cc(399) Check failed: kr == KERN_SUCCESS. bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>: Permission denied (1100)`。
- 按动态合同保留 Mermaid 源，HTML 显式 `DIAGRAM PENDING LOCAL RENDER`，没有伪造CSS流程图。

Chrome DevTools new_page 返回 `MCP tool call requires approval, but approval policy is never`。没有请求越权或修改系统权限。真实浏览器视觉/CSP执行 QA 未完成。

`node evidence/validate-report.mjs` 从本目录执行；脚本使用主checkout已安装happy-dom，VM验证single inline nonce script、无外部资源/inline handler、9节均有批注、pathname存储隔离、reload恢复、XSS只入textContent、长批注3段各<=1800、每段精确marker、copy正常/缺API/Promise拒绝回退、localStorage拒绝时安全。结果见 report-validation.json。这不是浏览器QA；托管HTTP/CSP由发布后的verify-report另记。
