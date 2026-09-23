# FLY-2789 节点成绩记录 — 调研
Issue: FLY-2789 (https://linear.app/geoforge3d/issue/FLY-2789/2787-b成绩记录-每张单每个节点记下用的模型组别并记-qa-是否一次过founder-打回次数额度花费耗时按组汇总每张一次过-qa)
日期: 2026-09-22
基于: plan.md

## 设计产物检查
- 只改本目录设计文档与 HTML/图源，未实现计量功能、改生产配置或重启。
- 源码审计验证 activation / runtime / assignment / QA claim / founder verdict 与原生来源接点；指标 A-D fixture 是手算设计，不是已运行工作流。
- 设计评审 question=c6d857a2-98e4-45fb-a973-ed99213d9d92，request=da696fe5-5496-47ef-8472-2a727e6d300e，已 accepted；首轮已返回 CHANGES_REQUESTED，8项均已修订，详见 review-history.md；最终批准必须来自覆盖新范围的下一轮。

## 本地 Mermaid 渲染失败（允许的降级）
flow.mmd 与 identity.mmd 各按以下标准参数执行两次：
`mmdc -i <source> -o <svg> -w 1000 -b white --svgId fly2789-d1|fly2789-d2`。
四次均在 Chromium 启动前失败：`MachPortRendezvousServer ... bootstrap_check_in ... Permission denied (1100)`。
未生成 SVG；HTML 两处明确显示 `DIAGRAM PENDING LOCAL RENDER` 并提供转义后的 Mermaid 源。
未用远程渲染或 CSS 假图，未声称完成真实浏览器视觉 QA。

## 评论层行为检查
用已安装的 happy-dom 20.10.6 在隔离 DOM 中执行唯一 inline script；本 worktree 未安装依赖，复用主仓已安装模块，没有安装/修改依赖。
通过项目：9 个 section 全有意见输入；输入按 pathname key 保存；localStorage 拒绝时仍可汇总；来源文字通过 value/textContent 写入，literal script 字样不变成 HTML；长意见分段均以 `【页面意见汇总】FLY-2789` 开头；clipboard 成功、promise 拒绝、API 缺失三条路径；拒绝/缺失时 execCommand fallback。
静态检查：仅一个带 `__CSP_NONCE__` 的 script，无 inline handler，无自带 CSP meta，无外部脚本/样式/图片/字体资源。
这只是 DOM 逻辑检查，不证明真实浏览器布局或托管 CSP 执行。

## 发布后的独立验证
待有效设计批准后 publish-only，并以 verify-report 检查 HTTP 200、nonce 占位符替换、CSP/script nonce 一致与预期文本。结果与 URL 将补在这里；发布前不得宣称已托管验证。

## R2 HTML 更新
已同步三维分组、degraded单独集合、分配未兑现异常及跨供应商不可等价提示；评论层DOM检查再次通过。flow.mmd 因新范围改文案又按标准参数执行两次，仍为同一 Permission denied (1100)；继续使用允许的明示降级。

## R3 真CLI研究与已知缺口
review R2 CHANGES_REQUESTED。新增hook-merge-evidence.md记录真实CLI三组实验与阴性baseline；具体未覆盖边界完整保留。Lead将既有StopFailure问题限定为PR Follow-ups，失败额度无法证明完整时missing，不填零。HTML加每组降级移出数率说明且DOM检查再次通过。实验脚本只在临时目录启动独立tmux和本地假provider，已清理，无生产账号/配置/服务变更。

## 托管验证与最终门槛
R3 reviewVerdict=APPROVED / reviewerVerdict=APPROVED。HTML于commit61dc6eeec发布（publishOnly=true，messageId=null，delivered=false，符合静默发布要求）。
URL: https://fw-reports-356a6d.vercel.app/r/4f15ee5840c366ba2c60173c4dbcb0f6/
`verify-report --expect FLY-2789`返回ok=true、HTTP200，noncePlaceholder/scriptCsp/scriptNonce/expect全部pass，warnings=[]；hasInlineSvg=false与已接受的本地渲染降级相符。无浏览器截图/视觉QA声明。
Lead要求的三项advisory文案现已在plan收尾修正，handoff明确实现/QA必须落实相应用例。角色记忆索引未直接写（19995字节，限额内）；已按允许的memory更新机制留一条本次真实CLI基线实验判断供归档。

托管内容二次核对：三维分组、降级移出说明、APPROVED状态与失败轮次缺账文本均存在；inline交互script内容与本地逐字相同，未残留nonce占位符。本地HTML SHA256=87e9e5a1c954cc4c85d874115e6a89bc8a1880f9f337534e9ee7301b24b28c26。DESIGN-HTML ready 已经 ask --report 发送，report question id=4f027032-a65e-4e36-bcda-a07f665034a7。
