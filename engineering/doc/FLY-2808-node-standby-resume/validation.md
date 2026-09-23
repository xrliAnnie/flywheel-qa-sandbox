# FLY-2808 设计交付验证 — 调研
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-22
基于: plan.md

## 已完成的本地检查

- `git diff --check`：通过（纯文档/HTML，未修改生产代码）。
- 已安装 happy-dom 20.10.6 执行本页真实 inline script：每节含评论、单 nonce script、无外部资产/事件属性、pathname 命名空间、存储恢复、存储拒绝时仍能汇总、恶意文本只显示为文字、长评论按 Unicode 字符切到每段最多1800并重复精确首行、clipboard 成功/Promise 拒绝/API 缺失回退均 PASS。
- 浏览器内实际 CSP 执行、视觉布局、真实模型恢复与生产性能：未验证。DOM 逻辑检查不能冒充浏览器 QA。

## 本机图形渲染降级

lifecycle.mmd / identity.mmd 各执行一次 mmdc 并按用户指定标准 flags 重试一次：

`mmdc -i <source.mmd> -o <output.svg> -w 1000 -b white --svgId FLY-2808-d1`（第二张 d2）。

四次均在本地 Chromium 启动前失败：`bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer … Permission denied (1100)`。未生成 SVG，未请求远程渲染。HTML 两处明确标记 `DIAGRAM PENDING LOCAL RENDER`，保存原始 Mermaid 源码，已通过 ask --report 告知 Lead（question d284d36b-b7a0-44a4-9bdc-2dbcb8414281）。遵循本单允许的降级，不宣称图形已完成。

## 门禁与交付游标

- R1 gate：8b0a14ec-0f02-4e07-bf7c-62e4e194fe64；request：460e8036-ac1b-4029-9893-6bda991f0d39；初稿 commit 14442c875。
- R1 后台状态 verified failed：reviewed_plan_moved，2026-09-23 05:54:55 UTC；原因是评审期间纳入 Lead 对建单范围的最新决定，不能算批准。冻结最终 plan 后开新 gate。
- R2 gate d0cf1a21-fa94-4d23-9663-63df581f0d15 / request 1f35923f-ea52-4f3b-8e4b-53650e105e75：reviewVerdict=APPROVED、reviewerVerdict=APPROVED。当前 plan 摘要已记 review-receipt.json；3 MEDIUM + 2 LOW 全为非阻塞，逐项保留 follow-ups.md 并上报 Lead。已批准计划保持原字节；其待评审状态句是冻结时的历史状态，以此有效回执为准。
- Lead 的默认值确认及建议一张实现单已记录 plan.md §11；没有独立 ship/部署授权。
