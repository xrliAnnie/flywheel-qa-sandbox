# FLY-2553 固定 Epic 页清晰度 — 实施计划
Issue: FLY-2553 (https://linear.app/geoforge3d/issue/FLY-2553)
日期: 2026-09-14
基于: research.md

## 当前授权与锁定范围
Lead instruction `1f730e22-cb8c-46b1-8465-8733f922aa47` (23:03Z) 按 founder 指令覆盖原六段布局及旧 C7。继续既有设计与 PR #1194，不重新 brainstorm。参照 `product/doc/FLY-2457-founder-progress-page/mock2.html`、`build-mock.py` 和 [Lead v5](https://fw-reports-624a39.vercel.app/r/152e60dc3a53a20c463927a44d02076d/)。

1. inset mock、锁行、单一标题和默认折叠提示；紧凑“现在要你看”，随后默认收起 Epic 卡。取消重复标题、评论框、机器标签和旧底部四段。原始审计保留在折叠附录及 sidecar。
2. Epic summary 使用 Linear 原状态、编号、短标题及在跑/未开始/总计；展开显示真实判断、角色、时间，无值为“还没有人写过”。活动子单列 badge/id/title 和引擎进度；完成/取消仅尾部计数。未起跑不得显示成已经在跑。
3. 每个 attention/活动子单使用真实 guild + chat_threads.thread_id；缺失或冲突明确缺失，不猜链接。Linear href 去标题 slug。增加可选子单链接 Cell，不迁移数据库；复用已有只读解析器。
4. 保持报告前缀、终态发送者和重复真问题过滤。只有当前 workflow founder_gate、明确的 founder_review/brainstorm 开放轮次和明确 @founder 真问题进首屏；普通 Lead 待答进入折叠附录。标签本身、旧 mailbox ship 和代码/设计 review checkpoint 不提供当前 founder gate 权威。
5. 已验证 Epic 范围内的子单可继承根范围，无需重复根标签。attention 复用同一次 scope snapshot 的元数据，但必须匹配 team/project/label；身份解析失败或冲突仍保持未知。
6. 保留 CSP nonce、固定 token 和事件/巡检刷新，不修改 tick.*。源标题保留原句（已有 Lead F13 裁定），href 不携带标题。共享 render/generate/status 模板。

## 验证与数据授权
- TDD：新版式、真实链接及缺失/冲突、founder gate 来源、同范围元数据与跨范围拒绝；保留转义、审计完整性、容量和失败可见性测试。
- E1 容量 fixture 与固定页目标 ≤80KiB；独立托管完整 HTML ≤512KiB。记录实际字节和 founder 卡来源，不能用小 fixture 代替真实样本。
- 问题回执 `1140c9ab-cb4d-4dc8-abc0-4743cd175ee4` 授权使用 Lead 管理的只读 StateStore/CommDB 快照（路径和 SHA256 见实施证据）。此裁定替代旧直接读生产库安排；脚本只打开明确传入的只读副本，不复制或打开生产库。
- 快照时间不同，Linear 是读取时现值，报告必须注明组合视图并非原子快照。
- 按 founder-html-delivery 发布完整同模板 HTML，`--publish-only`，不发 Discord；curl 验证 HTTP 200、CSP 真 nonce 和零占位符。附逐块对照。浏览器 MCP 被权限策略拒绝、独立 Chrome 启动失败；Lead 上述回执明确将宿主浏览器和手机展开对照交给 QA/Lead。
- pnpm lint、pnpm -r build、pnpm test:packages:run，以及相关 Epic/CLI/route tests。aggregate 只有完整 green 或符合注入条件的 PACKAGE_GATE_RECEIPT 才可通过；定向恢复不涂绿原始红回执。

## 交接
更新证据与进度，提交代码；milestone 为 PR handoff 的 literal last commit。推送 PR #1194；通过注入 gate + request-review 获得当前代码有效审查，修复阻塞项重新审查，核实精确头 CI。报告必须引用完整 Lead instruction id；`complete --route needs_review --pr 1194` 后 park。不得 dispatch QA、合主分支、部署或重启服务。

## 分块
1/4 设计与基线已完成；2/4 v5 渲染和来源 TDD；3/4 全仓、只读快照及托管；4/4 当前头审查/CI及交接。
