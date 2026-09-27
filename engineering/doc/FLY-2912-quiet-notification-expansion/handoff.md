# FLY-2912 设计交接 — 实施计划
Issue: FLY-2912 (https://linear.app/geoforge3d/issue/FLY-2912)
日期: 2026-09-25
基于: plan.md

设计节点交付已备齐，等待下列精确completion命令取得服务端回执。没有实现、派后继、部署、重启、ship或merge。

- 采用计划：plan.md revision2（f69453bcc；文件字节保持评审快照不变，开头review-pending为提交时标记）。当前有效结论见evidence/review-approved.json。
- 有效reviewVerdict/reviewerVerdict均APPROVED；R2 request=52e0e9a4-a162-442d-a558-705bd631eef4，question=aaceefb4-073f-4544-a93f-12c52fda24c4。R1 HIGH真实producer遗漏已修。
- 7条非阻塞advisories见review-followups.md；已向Lead报告，report id=8740a540-01ec-4f46-b2a9-69b68e917f97。附件依赖路径项已修复，其余由Lead/实施节点裁定落实；不假装已解决、不重新开设计。
- 正式HTML：https://fw-reports-6da062.vercel.app/r/6337c7b8cc78142ca5ae7162c3366e6c/。静默发布publishOnly=true/messageId=null；源提交256d43738。DESIGN-HTML ready报告id=74b4f324-9014-4b1c-b79b-9ae08f95fce2；核验/限制报告id=aa09f437-09b7-4182-b68d-73ac695394a6。
- 托管HTTP200、nonce/CSP匹配、body/script与提交源一致、零外部资源；evidence/hosted-verification.json。下载托管字节的评论控制器复测见hosted-controller.json。
- 两图本地mmdc及标准重试均失败，按合同使用DIAGRAM PENDING LOCAL RENDER并保留源；浏览器新页面被approval policy never拒绝。结构/控制器测试不是视觉或真实CSP浏览器验收。
- 回放窗口固定为2026-09-26T01:30:00Z–04:00:00Z（9-25 18:30–21:00 PDT），project flywheel / lead flywheel-eng-lead。257原Lead账、206mailbox、80匹配原session输入完整保留；另补21条DirectEventSink原启动、派发/绑定/工作流历史，见v2/v3 manifest。
- 原始私有输入位于/Users/xiaorongli/.flywheel/artifacts/FLY-2912，仅仓库清单存SHA和来源。现存库缺purpose列、部分派发表字段是当前状态；不得用迁移默认值或本分支SHA替代当晚历史证据。完整原序列必须保留，缺证保守分类并报告，不缩样本。
- 实施/QA：按T1–T6及§11实际producer验证，不以HTTP started替代DirectEventSink；两载体next-wake汇总、真实待办/失败路径、ON/OFF、原账与真实唤醒次数均按计划验收。本节点未跑实现测试或主张节省已实现。

完成命令：`node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete --route phase_design_complete`。成功后`park`，将TURN交给控制器，保留同一resident goal等待合法phase wake；不主动派发后继。
