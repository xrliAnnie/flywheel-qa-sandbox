# FLY-2803 额度页页面改版 — 调研
Issue: FLY-2803 (https://linear.app/geoforge3d/issue/FLY-2803/额度页页面-页面一张单改完spec-e1-e19呈现改版分组排序在用号染绿进度条时间格式-订阅到期显示与手填记确认人时间-e19)
日期: 2026-09-23
基于: plan.md

## 本地图形渲染

flow.mmd / data.mmd 分别首次尝试及一次标准参数重试均失败。
命令：`mmdc -i <source> -o <output.svg> -w 1000 -b white --svgId FLY-2803-d1|FLY-2803-d2`。
失败：`MachPortRendezvousServer ... bootstrap_check_in ... Permission denied (1100)`。
按注入合同保留 Mermaid 源码，并使用明确的 DIAGRAM PENDING LOCAL RENDER 占位。
未使用远程渲染、伪图或外部依赖；未声称图像/浏览器QA通过。

## HTML 静态与控制器验证

2026-09-23 初版14850 bytes；第一轮审查修订后重跑同一检查通过；8个section对应8个评论输入；单script、精确nonce占位符、无自定义CSP meta、无外部资源、无inline handler、无innerHTML。
Node vm DOM stub执行真实内联控制器：短评论汇总；4200字评论拆为3段，每段≤1800字符且首行marker正确；clipboard成功/Promise拒绝/API缺失均覆盖，拒绝与缺失均调用execCommand；localStorage禁用不阻断汇总；路径前缀包含location.pathname。
这只是静态及控制器验证，不是浏览器视觉QA；本地Chromium被系统权限拒绝。

## 最终静默发布与托管验证

设计第二轮effective APPROVED后发布，reportId=`f2b5282a8923e8f399dc4e81839aed52`。
Hosted URL: https://fw-reports-356a6d.vercel.app/r/f2b5282a8923e8f399dc4e81839aed52/
publishOnly=true、messageId=null、delivered=false，符合本任务不发频道消息的合同。

2026-09-23实取验证：HTTP 200；无__CSP_NONCE__残留；唯一script的nonce与注入CSP一致；script内容及完整main正文与已提交文件完全一致；无外部资源与inline handler。

- source SHA256: `f7138a630310aa540bd41796dd4ba614dede767c9c63cd8171ae856b15400f91`
- hosted SHA256: `450aab1add541136d7db70aee1b924776c920d662a79bfd51a0a757f3fd8b92b`

已通过指定ask --report向flywheel-eng-lead发送DESIGN-HTML ready回报，附图形渲染失败及浏览器QA未做的边界。没有声称图已渲染或产品已实现。
