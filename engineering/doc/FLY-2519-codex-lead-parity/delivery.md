# FLY-2519 Codex Lead 能力对等 — 实施计划
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-13
基于: plan.md

## 设计阶段交付

- 设计范围：17 组完整能力差集、C1–C5 实施块、secret broker/profile 边界、原生 Chrome 强制隔离/只读管理台、R1–R5 负例、同 Honey Lemon activation 的真实 issue 验收证据合同。
- R2 有效 `reviewVerdict=APPROVED` / `reviewerVerdict=APPROVED`；question `c2a10f39-eec6-4ee4-8db1-895dee044167`，request `03da9402-6dc7-48a2-b755-3fd58c17e4c8`，reviewed head `0e8318be2`。R1 的 HIGH 已修订；R2 1 MEDIUM/4 LOW 仅留档，已向 Lead 回报，receipt `5c57d3b0-9877-4e55-91a7-64b55f174170`。
- 主要提交：`2fe093328` 初稿；`0e8318be2` R1 HIGH 修订；`acd71b996` 批准与 advisory 记录。最后两个 administrative commits 不改变已审阅 HTML。

## Founder HTML

- repo：`engineering/doc/FLY-2519-codex-lead-parity/founder-design.html`。
- hosted：[FLY-2519 Codex Lead 能力对等](https://fw-reports-624a39.vercel.app/r/79a8b2955ccc023e9f72632394d6c8f2/)。
- reportId：`79a8b2955ccc023e9f72632394d6c8f2`；publishOnly=true，messageId=null，delivered=false 是无频道消息发布的预期结果。
- Lead `DESIGN-HTML ready` report receipt：`a4878cf0-b29f-414e-a66d-8b0b0c3ee643`。
- 最终源 HTML SHA256：`f3bb8ed2045668c7e1c08cf1ba0cc7568ee90b6e12f017e46545be9b608bdae2`；与 R2 审阅版本一致。
- `verify-report --url <hosted> --expect "【页面意见汇总】FLY-2519"`：ok=true，HTTP200；http、noncePlaceholder、scriptCsp、scriptNonce、expect 全 pass；warnings=[]；hasInlineSvg=false，screenshot=null。
- 本地评论层验证通过。Mermaid 两次本地尝试均被 OS 拒绝，页面明确两个 pending 标记，源文件在同目录。当前 runner 原生 Chrome 工具因审批策略不可用，未取得实际浏览器交互/截图证据；不是 Honey Lemon 真机验收。

## 后续执行所需的诚实边界

这是已批准的设计阶段交接，未实施、未迁移、未重启、未运行生产 drill、未合并/部署、未派 successor。#1162 合并有证据，生产依赖部署仍须后续核对。

R2 MEDIUM 指出外层 Seatbelt 与 Chrome 自身沙箱兼容性可能阻止启动：后续先在非嵌套宿主验证，不能把 APPROVED 当浏览器可用，也不能擅自改为 --no-sandbox。其余 Follow-ups 见 plan.md §12/review-r2.json。

最终 route 为 `phase_design_complete`，之后 design runner park、保留 resident goal 等待后续合法 TURN。阶段执行结果由 comm/controller 的实时回执证明，不由本文件先行宣告。
