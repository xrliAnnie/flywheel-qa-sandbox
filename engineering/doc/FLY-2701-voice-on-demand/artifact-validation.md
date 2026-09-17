# FLY-2701 语音按需启动 — 调研
Issue: FLY-2701 (https://linear.app/geoforge3d/issue/FLY-2701/语音按需启动-语音进程平时不常驻开耳机模式-会议到点时才由系统启动空闲后自行退出founder-2026-09-17)
日期: 2026-09-17
基于: plan.md

## 本地HTML检查

构建命令：`python3 engineering/doc/FLY-2701-voice-on-demand/build-report.py`。
用本机已安装happy-dom运行实际inline script（临时验证脚本 `/tmp/FLY-2701-verify-report.mjs`）：10个section、10个意见框；长意见切成3段，逐段≤1800字符且首行精确`【页面意见汇总】FLY-2701`；pathname隔离的localStorage写入成功；拒绝存储时不抛出；clipboard成功、缺失fallback、promise拒绝fallback均通过；用户意见中的HTML字符串只进入value/textContent。

静态校验：一个script，nonce为__CSP_NONCE__；无inline事件handler、无CSP meta、无外部资源URL。此检查证明DOM逻辑，不证明真实浏览器视觉布局/宿主CSP执行。

## Mermaid本地渲染未成功

flow.mmd与model.mmd各自尝试本地mmdc，并各用标准参数重试一次：
`mmdc -i <source> -o <output.svg> -w 1000 -b white --svgId FLY-2701-d1|d2`。
两张图均被宿主权限拒绝：`MachPortRendezvousServer ... bootstrap_check_in ... Permission denied (1100)`，不能启动Chromium。没有SVG产物。HTML明确显示`DIAGRAM PENDING LOCAL RENDER`并保留两份源码；没有远程渲染或伪造CSS图。实际浏览器截图同样未验证，不把DOM测试说成视觉QA。

## 发布验证

待有效APPROVED后静默发布，再记录实际HTTP、CSP nonce匹配和托管内容验证。尚未发布时此段不是完成凭据。
