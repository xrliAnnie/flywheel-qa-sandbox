# FLY-2749 纯通知停止唤醒 — 设计交接
Issue: FLY-2749 (https://linear.app/geoforge3d/issue/FLY-2749/额度lead-成本-lead-会话占-fable-额度-92percent每个小事件都唤醒-lead每轮重读-50-60-万-token)
日期: 2026-09-18
基于: plan.md

## 已完成的设计交付
- exploration.md、research.md、plan.md 已提交；仅修既有 lead_token_savings 的纯通知覆盖，不做上下文/模型窗口/规则记忆瘦身、用量 UI 或新合批队列。
- review-receipt.json：question a89021c5-8393-4d3c-b180-b2a2b908616d，request c6c482ed-dade-453d-acc7-13825179194e，effective reviewVerdict=APPROVED。11 条非阻断建议及最新 Lead 处置见 review-followups.md。
- founder-report.html 已提交推送；9 段评论、pathname 隔离保存、分块 marker、剪贴板失败回退等定向控制器检查 PASS。基线脚本同 manifest 重放逐字节一致。
- Mermaid 两图本地渲染及标准参数重试失败，保留源文件与错误日志；页面明确标记 DIAGRAM PENDING LOCAL RENDER。未声称视觉验证或生产验收。

## 托管故障的明确交接裁定
DESIGN-HTML publish-failed: 两次 publish-only 均返回 502 report publishing failed，url/reportId 为 null；无托管 URL、无托管 HTTP/CSP 验证、无送达声明。
Lead 对问题 8625df09-5855-458f-b670-ed8d3a7a3017 和 af142d38-f0df-4b14-a5b9-8259c2946e4d 明确裁定：宿主 Vercel Blob store limits-exceeded-suspended；停止重试，HTML 已提交推送即可，记录失败后照常 phase_design_complete 并 park。故障原因是 Lead 提供的诊断，本节点未访问或修改供应商账户。
完整回复保存在 evidence/lead-closeout-decisions.json。此裁定明确豁免本次交接前托管成功要求，不冒充成功发布。恢复后由 Lead 单独唤醒执行 publish-only + 报告，不写分支。

## 实现者承接
Lead 对问题 0f01abd7-c1ce-4907-8c0e-9cdafb0df32d 的裁定优先于计划第 6 节新建 relay 机制提案：复用 disposition-receipt，不另起 relay；所有 11 条建议进入后续 PR Follow-ups，其余留记录，不单独开单。不得把 review APPROVED 当作这些建议已落实。
实现与 QA 仍须按计划逐类正负例、canonical/legacy 入口、ACK、review 所有权和紧急事件延迟验证；同脚本统计部署前后 24h，60% 为 Lead 已确认的监测目标。设计节点没有实现、部署、派发后继、请求 ship 或 merge。

## 阶段边界
完成命令成功后 park，由控制器管理下一阶段；不将设计阶段完成当作 issue 终态，不结束 resident goal。托管恢复仅按新的 Lead 指令补交付。
本次接续未产生新的可复用角色经验；沿用既有发布失败诚实报告和明确 Lead 处置原则，不新增 memory 条目。
