# FLY-2796 耳机模式最小集 — 调研
Issue: FLY-2796 (https://linear.app/geoforge3d/issue/FLY-2796/语音v2-耳机模式最小集引擎无关一进来主动播报现在什么情况-哪些要你决定会话中有新消息主动念长时间无话报平安-从-9-月初)
日期: 2026-09-23
基于: plan.md

## 本地产物验证

- HTML 单一 nonce placeholder script；无 CSP meta、inline handler、外部 script/style/font/image。
- 通过临时 Node VM DOM harness 验证：pathname 隔离 localStorage；长意见分块 ≤1800 code points 且每块都有精确 marker；分段无丢字；clipboard promise rejection 和 API unavailable 两种路径都回退 execCommand；storage 拒绝不破坏汇总。
- 这是脚本行为测试，不是浏览器视觉 QA；当前没有声称真实浏览器通过。

## Mermaid 本地渲染失败记录

2026-09-23，mmdc 11.12.0：flow.mmd 与 data.mmd 分别采用唯一 `-I FLY-2796-d1` / `-I FLY-2796-d2`；两者各失败后，均按指定标准参数重试一次：

```
mmdc -i <source.mmd> -o <output.svg> -w 1000 -b white --svgId <unique-id>
```

四次均在启动 Chromium 时失败：`MachPortRendezvousServer … bootstrap_check_in … Permission denied (1100)`。因此按任务许可使用明确的 `DIAGRAM PENDING LOCAL RENDER` 占位，保留两份图源及 HTML 中可展开源文；无伪图、无远程渲染、无后改 SVG id。

## 尚待证明

effective design review verdict、最终托管 HTTP 200 / nonce + CSP / 内容一致、completion receipt。产品实现、单元测试与真房测试均未在设计阶段执行。
