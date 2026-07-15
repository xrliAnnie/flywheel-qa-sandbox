# FLY-914 progress ledger

Issue: FLY-914 (https://linear.app/geoforge3d/issue/FLY-914/interactive-html-review-artifact-google-doc-style-inline-comments)
日期: 2026-07-06
模式: Mode A 产品共创 (PM / product-designer-executor)

## 当前位置
- phase: design (PRD v4 收敛完成)
- cursor: 可跑 demo 已上公网+QA 过,Honey 发 914 thread;等 Annie 真机手感 verdict
- 状态: build issues 已 file(FLY-930/931/932/933);等 Annie 真机手感 verdict 后按需微调 filed issue(Honey 指示,避免反复)。

## 已定(收敛)
- 块1 批注创作 = **A**(点段落→底部评论条)+ 批量统一发送。Annie 真机翻案(B 划词手机别扭)。B→backlog。
- 块2 回流 = **剪贴板复制**(Annie 2026-07-06 拍板改简:『复制全部批注』= 段落原文全文+评论 配对复制到剪贴板,她粘给发起方)。v1 **不做** serverless relay / 自动 POST 回 Discord(自动回流 = FLY-931 backlog)。
- 块4 托管 = **留 Vercel + 放开交互页 CSP(nonce)**;不选 Claude Artifacts(登录摩擦)。
- 竞品研究 Codex Artifact 已做。

## 关键实证
- fw-reports 注入 CSP default-src none 无 script-src → 内联 JS 被拒 → 交互 artifact 现有托管死页(= Annie「导出拿不到/点了没反应」真根因)。Annie 真机点 v2 无反应=用户侧复现。
- A 原型端到端 QA 全过(本地 + 公网 URL https://fly914-review-demo.vercel.app/ 均实测 jsRan 非死页)。
- demo=一次性 no-CSP Vercel(印证留 Vercel 放开 CSP 方向);VERCEL_TOKEN 在 runner env,CSP 仅 report-registry 注入。

## 交付物(随分支)
- prd.md (v4 收敛)
- mockups/authoring-v1.html (A/B 静态对比)
- mockups/authoring-v2-interactive.html (B 真机原型,本地验)
- mockups/authoring-A-interactive.html (A 真机原型,self-QA)
- research-codex-artifact.md (竞品)

## 下一步
- Honey 绿灯 → create-issue 拆 4 build issues 给 Tadashi(#1 CSP nonce 阻塞其余)。
- build#1 CSP 放开后 → A 原型发 Vercel → 914 thread → Annie 真机终验手感。
- PM 验收 = FLY-830(不在本 issue)。
