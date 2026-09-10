# FLY-2485 Lead 判断格 — 调研
Issue: FLY-2485 (https://linear.app/geoforge3d/issue/FLY-2485/进度页e4-lead-判断格lead-note-新表-flywheel-comm-lead-note)
日期: 2026-09-09
基于: plan.md

## 设计产物验证

- `node engineering/doc/FLY-2485-lead-judgment-cell/verify-html.mjs`：PASS。验证 HTML 结构、10 节各自的留言入口、单 nonce script、无自写 CSP/表格/外部依赖，以及 VM 中的恢复、路径隔离、存储拒绝、Clipboard 成功/缺失/拒绝回退、Unicode 分段与清空留言。
- `git diff --check`：PASS。
- VM 使用最小 DOM stand-ins，证明脚本分支与数据行为；不证明真实浏览器布局、剪贴板权限或 CSP 下的运行。
- 两张 Mermaid 使用本地 mmdc，各自初次及规定标准参数重试均失败。命令形状：`mmdc -i <flow|model>.mmd -o <flow|model>.svg -w 1000 -b white --svgId fly2485-d<1|2>`。
- 共同失败：Chromium `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`。没有生成 SVG，HTML 明示 `DIAGRAM PENDING LOCAL RENDER`，旁存 flow.mmd/model.mmd；没有使用远程渲染。
- Chrome DevTools 独立页面预览返回 `MCP tool call requires approval, but approval policy is never`。未请求不可用审批，未假称已看过桌面/手机截图。
- live Linear issue GET 为 HTTP 401，未将其算成实时 issue 内容核验。

## Lead 裁定采用

问题 `913a8ccb-7321-43d1-8953-034c00ecb876` 的答复同时覆盖 `2cb86bbf-53b8-4f1d-b281-3d8ffc6abc1b`：StateStore 新表、每 project+issue+role 最新一句、角色共存、canonical roots、项目绑定范围、配置角色、默认 3 天及 S3 边界。文档、图源和 HTML 已一致更新。clear 显式指定 role，不清除其他角色。

## 后续节点仍需执行

plan.md T1–T5 是实现与 QA 的实际验收合同，目前没有应用代码变更，也没有产品测试、生产写入、迁移、合并、部署或 ship 批准。

## 有效设计评审

R2 gate `b384b37c-2462-48a2-93f5-332c37346e1b`、request `e172fabe-61e0-440a-ba1c-6c5158fbed9d` 返回有效与原始 APPROVED。六条非阻塞建议已报 Lead，逐条保留于 review-round-2.md。最终状态标注只记录该事实，没有在通过后变更实施契约。

## 最终托管交付

- 最终 HTML 提交：`52ec7ca6d`，已推送；发布方式为 `publish-report --publish-only`，没有频道消息或截图发送。
- 托管地址：https://fw-reports-a53de2.vercel.app/r/f0bb9c81005ff725aff961fc82486530/ 。Report ID：`f0bb9c81005ff725aff961fc82486530`。
- HTTP GET：200，17692 字节；页面批准标识、两处待本地渲染说明及反馈标记均存在。
- 托管文档只有一个带 nonce 的脚本；`__CSP_NONCE__` 已全部替换，CSP 含匹配的 nonce；无内联事件属性、无外部资源依赖。此项验证响应内容，不证明真实浏览器的运行与布局。
- `DESIGN-HTML ready` 已向实际 Lead 汇报，回执 `45daed78-fbaa-4050-811d-1718e8c8604c`。

设计产物和发布核对已完成；随后执行阶段完成命令与 park，由控制器保存交接事件。本文件不预写尚未取得的完成回执。
