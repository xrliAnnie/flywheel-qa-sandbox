# FLY-2696 人设投影 — 设计验证记录
Issue: FLY-2696 (https://linear.app/geoforge3d/issue/FLY-2696/raya-并仓s4-persona-投影p1人设留-raya-仓显式-opt-in-contract-启动屏障fail-open)
日期: 2026-09-17
基于: plan.md

## 设计阶段证据

- 阅读已合入母方案 §7/§7.3/§7A.2/§10.2/§12/§14.1①；P1′ 保留，分阶段回退纳入本 plan。
- 只读名册：fleet-inventory.json，共 17 个 Lead、16 个非 Raya、13 个非 Raya identity tracked；不是投影零写测试结果。
- Lead 对问题 605a759d-15cd-482c-b2de-6f965d2560c1 指定 S4 为 M0/fence 合同权威方，FLY-2697 对齐本 plan §4.3。
- 本节点未实施任何运行时代码，也未运行计划中尚不存在的测试。

## HTML 检查

- 完整文档，单一 script，nonce 精确为 __CSP_NONCE__；无 CSP meta，无内联事件属性，无外部 script/style/font 依赖。
- 八个 section 均有留言区。VM 控制器检查：pathname 隔离、重载保存、storage 抛错仍工作、4100 字留言拆为三段且每段带指定 marker、clipboard 缺失与 promise reject 均走 execCommand fallback，全部通过。
- 这只是静态和控制器证据，不是浏览器/CSP 运行证据。
- Chrome DevTools new_page 被自动审批拒绝：`MCP tool call requires approval, but approval policy is never`。未完成浏览器截图或交互验证。
- flow.mmd / model.mmd 均调用本地 mmdc，首次及标准参数重试均失败：`MachPortRendezvousServer ... bootstrap_check_in ... Permission denied (1100)`。保留源码，HTML 显示 DIAGRAM PENDING LOCAL RENDER，无伪图、无远程渲染。
- R3 有效 APPROVED 后，HTML 已在 6fe7a152f 提交推送并 publish-only。托管 HTTP 200、CSP/script nonce 一致、placeholder=0、脚本字节一致、8 个留言区、零外部资产，均通过。详见 delivery-receipt.json；publishOnly=true/messageId=null/delivered=false 是要求的静默结果。
- Hosted URL: https://fw-reports-42fba7.vercel.app/r/e2bbcd19ed412fb94059e0c9bf045a20/
- DESIGN-HTML report receipt: 81bc3736-e34f-4ce5-aa05-03d30e2dd258；限制报告 receipt: 87bf43fd-8788-4dc6-856c-a9b1695eca44。
- 浏览器交互/CSP 执行仍未验证；本次 HTTP 与源码检查不冒充 browser QA。

## 实现阶段私仓 exact-SHA 取源证据

宿主授权 `gh` 账户在临时裸仓对 Raya 私仓执行 exact-SHA fetch；未写生产 workspace，未记录 token，裸仓在取证后已清理。按 plan T3 仅记录：

- commit: `90e433e87a68287ed59ba64f2584e3a6bc0da151`
- `.lead/raya/identity.md` sha256: `ca1240f12fbbe868ec3fa117f4882ecfcb78d20a51a0ffa7ad9f37babbcd78f5`
- fetch success code: `0`
