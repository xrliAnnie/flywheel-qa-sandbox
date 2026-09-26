# FLY-2802 设计交付证据 — 调研
Issue: FLY-2802 (https://linear.app/geoforge3d/issue/FLY-2802/runner测试纪律-本机只跑相关测试写进-promptfly-2753后-runner-仍跑整包全量把-prompt-写到不留口子-在)
日期: 2026-09-23
基于: plan.md

## 设计边界

只产生 design docs/HTML，没有实现代码、生产变更、529 派发、ship authority 或 merge。

## HTML 与图形

- `design.html` 约 12 KB，Apple-light、无外部依赖；7 个可编辑意见区（包括整体意见），每区 localStorage key 包含 location.pathname，存取捕获异常。
- 一个 nonced inline script，`__CSP_NONCE__` 占位符；没有自设 CSP 或 inline event 属性。用户内容只进入 value/textContent。
- 评论按 section title 汇总；分段内容以 `【页面意见汇总】FLY-2802` 起始；每段小于 1,800 字符；复制 API 不存在或 promise 拒绝时回退 execCommand。
- Node VM DOM 控制器验证通过：路径 key、7 个输入、原样文本非 HTML、长文分段、复制成功/拒绝/缺失、storage exceptions。语法检查通过。它不是浏览器渲染 QA。
- `flow.mmd` 与 `evidence.mmd` 为真实 Mermaid 源码。两幅均首次执行与标准参数重试各一次失败，命令：`mmdc -i <source> -o <svg> -w 1000 -b white --svgId FLY-2802-d1|d2`。
- 失败原因：Chromium `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`。按注入规则采用显著 `DIAGRAM PENDING LOCAL RENDER` placeholder，保留源码。不远程渲染，不制作 CSS 假图。尚无图形/浏览器 QA 通过证据。

## 显式评审

- 初稿 commit：`4af42695a`，已 push。
- Gate：`357805e3-38bb-4316-ae81-c3ae1f4b640b`。
- Request：`250e5470-74d3-4e59-a41d-d8a1ea47acbf`；request-review 返回 accepted=true、skipped=false。
- R1 effective reviewVerdict=CHANGES_REQUESTED；三个 HIGH 与四个 advisory 均已接受处理，见 review-round1.md。
- 修订 commit `2fbc1c3bb` 已 push。
- R2 gate `e7e84e2a-eaa0-4e73-bf75-a8924603ace2` / request `8ac3ec1e-e662-481d-b66b-a697ea432f66` accepted=true、skipped=false；effective reviewVerdict=APPROVED、reviewerVerdict=APPROVED；五项非阻断建议记录在 review-approved.md 并已报告 Lead。
- Lead 经 question b3cec582-787d-425f-8f4c-6d8fde426ca6 确认观察型方案和下游 real PASS 边界；6b075408-be4e-43ba-8ecc-0e8214c08984 确认可按渲染例外处理，并要求图位置的文字兜底，已落实。

## 发布与交接前核验

- effective APPROVED 已取得，计划在批准后保持原字节。
- HTML 已提交并推送，再经 publish-report --publish-only 发布。
- URL：https://fw-reports-356a6d.vercel.app/r/0a3d8b60c38fd6f11b5b822b340d7524/
- publishOnly=true、messageId=null、delivered=false 是本次要求的静默发布结果。
- 托管页 HTTP 200；nonce placeholder 残留=0；单 script nonce 与 CSP 匹配；脚本与本地一致；7 个评论输入；没有外部资源。详见 hosted-verification.json。没有浏览器视觉 PASS。
- DESIGN-HTML ready 已通过 ask --report 送 Lead，report id `5d5444ec-784a-4a39-b075-24e1f0edb200`。
- 学习 closeout：按当前记忆写入约束，仅在 native memories/extensions/ad_hoc/notes/2026-09-23T0548-runner-test-discipline.md 追加 update note；不直接改共享 MEMORY。role MEMORY 预检 92 行、19,995 bytes，保持 unchanged。
- 下一步精确执行 complete --route phase_design_complete，再 park。最终控制面回执为完成依据，本文不能自行证明该动作已发生。
- 真实 529 行为 PASS、提示词/脚本实现与完整 CI 仍是下游必要交付，当前不存在；本阶段未触发实现、部署或 merge。
