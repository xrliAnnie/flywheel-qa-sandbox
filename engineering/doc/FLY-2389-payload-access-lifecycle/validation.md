# FLY-2389 私有下载与保留期 — 调研
Issue: FLY-2389 (https://linear.app/geoforge3d/issue/FLY-2389/1143b2-r2-payload-托管-端点私有-bucket-验-key-薄端点entitlement-分级-presigned-get)
日期: 2026-09-09
基于: plan.md

## 设计产物验证记录

- 基线 `node --test packages/payload-endpoint/__tests__/handler-customer.test.mjs packages/payload-endpoint/__tests__/lifecycle.test.mjs`：28 PASS / 0 FAIL / 0 SKIP。只证明已有行为；没有执行计划中的新增测试、真实 R2 或发布。
- `git diff --check`：通过；所有改动限定本 issue DOC-FLOW 文件夹。
- HTML parser：8 个 section、8 个带标题评论输入、1 个脚本且 nonce 为精确占位符 `__CSP_NONCE__`；0 外部资源、0 内联事件属性、0 自定义 CSP meta、0 innerHTML。
- 提取 HTML 单脚本后 `node --check`：通过。
- Node DOM 模拟交互检查：8 个区块输入；pathname 隔离保存与刷新恢复；localStorage 抛错仍可输入/汇总；用户输入作为纯文字；汇总精确首行 marker；长意见每段 <=1800 字符并重复 marker/区块标题；clipboard 成功、缺失、promise rejection 后 execCommand fallback；fallback 失败给出手动复制提示。全部通过。此检查不是浏览器视觉/CSP 执行证明。
- `download.mmd` 与 `retention.mmd` 均使用 `mmdc -i <source> -o <svg> -w 1000 -b white --svgId fly2389-d1|fly2389-d2`，每张两次均失败：Chromium `bootstrap_check_in ... Permission denied (1100)`。没有生成 SVG，HTML 按任务 h 显示 `DIAGRAM PENDING LOCAL RENDER`；保留源码；没有远端渲染或伪造图。
- Chrome DevTools 新页面预览被工具拒绝：`MCP tool call requires approval, but approval policy is never`。未重试或申请扩大权限；视觉浏览器验证未完成。

## 审核与发布

首轮审核绑定提交 `d541139d0` 的 plan：question `24197080-096a-4965-a57f-645a6fdd84f1`，request `378ae9e4-5e7e-4160-8e11-2332862d8e84`，Bridge accepted=true。有效 verdict 与最终发布结果在 closeout.md 记录；仅注册成功不等于评审通过。

托管 HTTP/CSP/nonce 检查在有效 APPROVED 后执行，再记录实际结果。最终页面只 publish-only，不发送频道消息。
