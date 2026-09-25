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

## 评审与托管验证

- effective reviewVerdict=APPROVED，R3 request `6d3956ba-c2a6-45d2-9590-9a433a693fd5`，见 review-resolution.md。
- Hosted URL: https://fw-reports-356a6d.vercel.app/r/bc3e88b7c3a862517888edabb711db23/
- publishOnly=true、messageId=null、delivered=false：按要求静默发布成功，不代表发了频道消息。
- 托管 HTTP 200；12351 bytes；SHA-256 `1b94fd16e2ac33057d8a17a681bd96166d5ccb948d7b9be1b172c9625c57bbd7`。
- nonce placeholder 残留零、唯一 nonced script 与托管 CSP 匹配；script 字节与提交源码完全一致；七个章节/评论 marker/图待渲染标记均在；外部 assets 零。
- 本机 Chromium 启动被权限阻止，因此未声称浏览器视觉 QA。

## 设计完成审计

| 要求 | 当前证据 |
|---|---|
| full doc-flow 三文档与前置合同 | exploration.md / research.md / plan.md，规定 title/Issue/日期/基于齐全 |
| scope G1/G2 与 V1、旧 Raya 找回 | plan §1–§7 + research 基线/消费者表，第二批明确排除 |
| RoomIO、两旧命令兼容与 V6 identity | plan §3、§8；真实兼容列为实现后 QA 门，未冒称已通过 |
| durable inbox、完整转写、handoff 回执/恢复 | plan §4/§6/§7；含九项 A 消费需求 |
| Lead 新分工与事件游标 | plan §7.1a，指令消费 DONE 已报告 |
| effective design review | R3 APPROVED，两 advisories 保留 Follow-ups 并已 report |
| founder HTML、评论与本地图 | founder-design.html；本地两次渲染失败按明确许可 fallback；flow.mmd/data.mmd 保留 |
| commit/push | 最终设计记录 b2638be68，审核正文 8bea212a0；HTML 初次提交 0d6fdc56c |
| hosted fetch/CSP/source 检查 | 上述当前 HTTP 验证 |
| 阶段完成 | 待 exact complete 命令返回持久回执；此表不提前证明完成 |

产品实现、产品单元测试、真房测试均不属于本 design 阶段的已完成证据，留后续实施/QA。没有合并、部署、重启或派后继。
