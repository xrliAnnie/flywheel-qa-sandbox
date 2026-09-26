# FLY-2914 病根排修闭环 — 调研
Issue: FLY-2914 (https://linear.app/geoforge3d/issue/FLY-2914/巡检闭环-6-巡检每轮自动列出病根类别出现-3-次且没有修复单在跑-lead-必须呈报-founder-排修让巡检发现的问题变成自动机制)
日期: 2026-09-25
基于: plan.md

## 设计阶段验证记录
- 已只读读取 Linear 全量 3 页、210 子单，限定 SQL 读取 active runs 并关闭连接。盘点保存在 live-census.json；不是新巡检实现验收。
- 正式设计 review gate：856887c9-671e-4488-8b5b-f54a48cb4d48；requestId：880598c9-20d5-4baf-9daf-3d2d6d9392d9；服务端 accepted=true/skipped=false。有效 reviewVerdict=APPROVED，reviewerVerdict=APPROVED；10 个非阻断建议保留为开放 Follow-ups，见 review-advisories.md。
- Mermaid 本地 mmdc 两次均失败：Chromium MachPortRendezvousServer bootstrap_check_in Permission denied (1100)。第二次使用标准 -w 1000 -b white --svgId FLY-2914-d1。原稿 flow.mmd、失败日志 diagram-render.txt；HTML 明确 DIAGRAM PENDING LOCAL RENDER。未调用远程渲染或用 CSS 假图替代。
- HTML 静态检查：9 个 section 均有评论 textarea；唯一 inline script nonce=__CSP_NONCE__；无内联事件、无自置 CSP meta、无外部资源。
- inline JavaScript `node --check` 通过。临时 vm + mock DOM 验证自动保存 key 含 pathname、blocked localStorage 不抛出、长意见各片段≤1800 字且重复正确标记、clipboard 不存在及 promise rejection 均走 execCommand fallback。
- 上项为脚本/模拟 DOM 验证，不是实际浏览器视觉或交互 QA。发布后还需 hosted HTTP/CSP/源内容核验。
- 未实现任何产品代码，未运行全仓测试、未写 Linear、未发 founder 实际排修消息。
