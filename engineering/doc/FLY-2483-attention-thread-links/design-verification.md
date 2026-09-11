# FLY-2483 现在要你看 — 调研
Issue: FLY-2483 (https://linear.app/geoforge3d/issue/FLY-2483/进度页e2-现在要你看attention-三路合并-固定四段格式-跳-discord-threaddiscordguild-id)
日期: 2026-09-09
基于: plan.md

## 一句话结论

完成可实施设计与可逐节留言的 HTML。此处记录设计产物验证，不是产品 ship 或 QA 通过报告。

## 改了什么

文档明确项目级三路来源、逐单合并和完整来源保留、固定四段、唯一 attention.v1 词表、guild 单行持久化、canonical chat_threads 绑定、v2 严格模型与 v1 读取、三处接线、无 Epic 时的独立首屏和 residual unavailable 边界。没有改产品代码。

## 怎么验证

- `python3 engineering/doc/FLY-2483-attention-thread-links/build-founder-html.py` 成功，生成 HTML 16580 bytes，11 个可留言 section。
- `node engineering/doc/FLY-2483-attention-thread-links/verify-founder-html.mjs` PASS：每节评论、单个 nonce script、没有表格/外部资源/inline handler，pathname 隔离存储、存储拒绝仍可复制、刷新/清空、实时汇总、1800 字符 Unicode 分段和每段 marker、clipboard 成功/不存在/拒绝/双失败。
- `git diff --check` 通过；新增内容只在本 issue 文档目录。
- 两张 Mermaid 图各执行配置参数一次和任务指定标准参数重试一次，均 exit 1。错误：`Failed to launch the browser process` / `bootstrap_check_in ... Permission denied (1100)`。未生成 SVG。HTML 有两处 `DIAGRAM PENDING LOCAL RENDER`，旁存 d1-flow.mmd、d2-model.mmd；未用远程渲染、未画 CSS 假图。
- 报告/HTML 固定文案人名扫描为零。外部 Linear 标题按 Lead 本轮裁定保留并转义。

## 已知边界与未通过项

隔离 DOM 脚本验证不等于浏览器视觉/真实 CSP 执行。当前没有真实 Discord thread 点击截图；plan §10 明确 QA 必须由 Claude-in-Chrome 真点生成入口、核对落点并截图，否则不能宣称 QA PASS。没有执行产品实现、生产服务操作、live DB copy、merge 或 deploy。

## 风险与回退

图形尚未本地渲染，按任务明确允许的降级交付；有本地浏览器权限后可从保留源码重渲染。发布、有效设计评审与阶段完成必须另取实际回执，不能从此静态检查推定成功。

## R1 修订验证

- R1 有效 CHANGES_REQUESTED，唯一 HIGH 为 dependency show 消费者；plan 已加显式 active_scope_not_found 处理与真实新版文档接线回归。其余12条 finding 均在 review-response.md 记录处置和边界。
- HTML 同步说明角色收件提示、身份/体积不完整与依赖命令的可诊断错误；重新生成16841 bytes。
- 评论脚本与artifact shape复验 PASS，git diff --check PASS。Mermaid源含义未变，没有重试已明确受限的渲染；真实browser/Discord QA仍未验证。
- 该修订需新门新request评审，不以作者自查替代有效APPROVED。

## 最终评审状态

R3 effective/reviewer 均APPROVED，request 8b2d8942-505b-427f-9d16-5078bc3bf48b。唯一MEDIUM身份健康度计数建议已转交Lead，保留在review-response.md；没有阻断finding。最终HTML仍是16841 bytes，内容与已通过的评论检查一致。两图待本地渲染、Discord实际点击待QA的边界不变。

## 最终托管验证与交付

- 已提交HTML通过publish-only发布，reportId=4aebb2142deb4426b16c4aa6268b2198；没有频道消息。
- URL：https://fw-reports-a53de2.vercel.app/r/4aebb2142deb4426b16c4aa6268b2198/ 。已通过规定DESIGN-HTML ready报告交给实际Lead。
- 2026-09-10T05:35:29Z curl检查HTTP200；__CSP_NONCE__残留0；唯一script真实nonce与注入CSP匹配；script正文与已提交HTML完全一致；11节评论、2处明确待渲染提示仍在。托管HTML17068 bytes。
- 该检查证明托管字节与权限声明正确，不声称真实浏览器执行或Discord点击成功。产品点击证据仍归QA；图未渲染仍按任务允许fallback明示。
- 接下来执行phase_design_complete并park；以命令返回的控制器完成回执为阶段交接事实，不把本文件意图当作已交接。
