# FLY-2654 后续裁定对齐 — 设计更正
Issue: FLY-2654 (https://linear.app/geoforge3d/issue/FLY-2654/规则放权-founder-2026-09-16-2249z以后怎么样可以避免我来授权你就自己做决定把raya)
日期: 2026-09-20
基于: exploration.md、research.md

## 当前有效裁定与完成面

Lead 对问题 5ac555cf-0161-4373-a403-2d7a35238017 的回复及指令 [lead-instruction cd826c6b-b695-44cf-82fb-4fd5a9c2f706] 覆盖本轮第一稿：保留“不再逐次授权”目标，删除条件消息授权解释，以新增 standing carve-out 作为权限来源。Raya 下一班车自动更新；收尾 a/b/c + 播报 + 审计 + activation 满足时 Lead 自决，只有前提不满足才问 founder。

问题 f116e8d1-9a7a-44f4-923a-44c4825297c7 确认固定独立确认的执行产物，机制更新通过既有部署交接自动取得独立确认；确认者指定 flywheel-cos-lead（Aunt Cass），排除作者/实现者。Claude/Codex 均需真实规则加载。所有必要 activation/verifier 集成与“无逐次授权”的正向验收属于 FLY-2654 本单 Done 前置，不拆成可选后继单。

旧 Part B 仍关闭，现有代码与 b554c478e 血缘保留。39143d02d 口径被 Lead 裁定 5ac555cf 取代；旧请求 da775f5b-44ce-4004-88a3-8fdb32b88f32 自然结束，不打断，其判决对新计划无效。当前实施规范只有 plan.md；旧计划完整保留在 design-history.md。

设计阶段只产出文档、复审与页面交接，无代码/生产操作。本轮新版 Mermaid 两次本地渲染均 Permission denied 1100；依合同保留源文件和清晰待渲染标记，不使用远程服务。

## 历史核对日志（非当前规范，后续裁定如上）

`````text

本轮 execution `481af938-0103-46ae-a568-dc2acb457ea2`，run `82f0f3a5-8564-471f-8dcf-209fbf04793e`，design epoch 15。继承干净头 758823879，原进度 implement 44/46。仅同步文档，不改代码或重做 QA 返工。

## 已核验裁定

2026-09-20 对 CommDB mailbox/mailbox_archive 使用只读连接、参数化 exact-id 查询并关闭句柄：

- 回复 `ef6ea727-b86a-4525-9394-b8beea5c7e54`，Lead → 原实现体，2026-09-19 05:53:44Z，ref `485cc07c-a00f-4ef0-8cd5-f768bb4d3aee`：禁用条件接受路径；未来/推迟/转交/等后续同意均非授权，只认当前无条件指令。
- 回复 `c1ef7561-42b8-4174-9d11-43f9383d9f2b`，06:05:54Z，ref `e8151533-edc9-4761-ae44-53f701264e5e`：不 overrule 两项 HIGH；采用完整允许语法，规则与 runbook 同步；条件句只触发到时再问。
- QA 问题 `93c92bc7-3b0b-4200-970f-b9a659277275`，05:13:26Z：head 1f07d020c 与 main 487799b80 在规则 receipt、updater 测试冲突；是路由 FAIL。workflow claim 1339 于 05:14:16Z 为 qa_failed。Lead 指令 `97106922-7f8d-488a-8b81-bcd22d22cbb0` 明确只合 main 解冲突、定向验证。

当前 R4 与最后两条裁定相符。旧 plan/HTML 仍允许未来条件自动执行；故旧设计批准不能覆盖当前语义。原 plan 完整存 design-history.md，只作历史，不是实施输入。旧日期的 implementation/validation 作为原始执行记录保留，不把它们的日期与测试数字改造成今天的结果。

原 Part B 关闭仍沿 handoff 所记录的 ec106d4d 裁定与 FLY-2679；没有当前恢复指令。范围复核问题 `ea6e0b4f-acfb-415f-b755-ab17a9e52827` 已发 Lead；不据旧 issue 标题重新开 Part B。

## 诚实边界

受管 snapshot 本地入口报 snapshot_helper_missing，生产入口报 snapshot_owner_unavailable；未复制数据库，也未绕过快照创建限制，改用短只读查询原库。旧设计 question 的 check 返回 not yet；它不证明旧请求仍在跑，也不作为新节点复审批准。必须按当前 execution 注册新有界设计复审。

原始“无需逐次授权”产品目标未达成；当前获授权工作是安全边界收口与文档对齐。没有生产 ticket、部署、重启、activation、QA dispatch、ship 或 merge。

## 本轮 Lead 确认

问题 ea6e0b4f-acfb-415f-b755-ab17a9e52827 已回复：确认保留关闭的 Part B 与现有代码，审计 design/QA 证据、刷新有界 design handoff 后 complete；实现节点继续处理 WIP/QA 返工，只跑定向测试。

本轮 Mermaid 标准本地渲染两次均失败：MachPortRendezvousServer bootstrap_check_in Permission denied (1100)。保留 flow.mmd 和页面 DIAGRAM PENDING LOCAL RENDER；没有远程图服务。

## 最新裁定覆盖前述解释（当前有效）

Lead 对问题 5ac555cf-0161-4373-a403-2d7a35238017 明确：9-19 两条裁定只禁止条件消息被解析为授权，正确替代是新增 standing carve-out，不能改成每次都问 founder。Raya 随 main 下一班车自动带上；收尾按 a/b/c + 播报 + 审计 + activation 自决，只有前提不满足才回原授权路径。本轮第一稿 39143d02d 及其 request da775f5b-44ce-4004-88a3-8fdb32b88f32 已被替代，不能作为当前设计批准。

当前 plan.md 按这一新裁定修正，原 Part B 继续关闭且历史完整保留，现有代码不改。新的机制固定与独立确认安排已用问题 f116e8d1-9a7a-44f4-923a-44c4825297c7 提请 Lead 校准；未收到不同身份指定前，flywheel-cos-lead 仅为候选，不冒充已确认。

## 当前身份与完成面确认

问题 f116e8d1-9a7a-44f4-923a-44c4825297c7 已获 Lead 同意：固定已确认执行产物，独立确认通过既有部署交接自动取得；独立确认者定 flywheel-cos-lead（Aunt Cass），排除作者与实现者。Claude/Codex 均须真实规则加载证据。activation/verifier 等必要集成属于本单 Done 条件，由本单后续实施/QA 阶段完成，不转为可选后继单。

指令 [lead-instruction cd826c6b-b695-44cf-82fb-4fd5a9c2f706] 再次要求按 standing a/b/c 更新 plan/HTML/correction 后新开设计复审，旧请求结果不作数。
`````
