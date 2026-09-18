# FLY-2523 自动收尾与额度就绪 — 交付验证
Issue: FLY-2523 (https://linear.app/geoforge3d/issue/FLY-2523/部署-codex-额度自动切号子系统在宿主上收尾生成-readiness-receiptjsonapproved-homes-清单)
日期: 2026-09-17
基于: plan.md

设计阶段证据，仅验证文档与报告，不代表实现或生产验收。

- 两张Mermaid源：flow.mmd、model.mmd。每张首次命令与规定的标准参数重试均失败；mmdc Chromium报MachPortRendezvousServer bootstrap_check_in Permission denied(1100)。未远程渲染，HTML两处明确DIAGRAM PENDING LOCAL RENDER。
- R2最终HTML 14763 bytes，8 sections/8 comment inputs，无重复DOM id，无外部资源，无inline handler，无自带CSP meta，单一script带精确__CSP_NONCE__。
- Node VM加载最终script并运行模拟DOM验证：路径隔离localStorage key；指定汇总marker；section标题前缀；5000字符反馈生成3个<1800字符chunk，每块重复marker；clipboard promise reject和API absent均触发execCommand fallback；localStorage写入异常不阻断汇总。
- 无真实浏览器视觉QA：本机Chromium启动被沙箱系统权限拒绝，不把VM称为浏览器证据。
- hosted URL、HTTP/CSP nonce/source核验在发布后追加。
- 生产home：仅readlink/lstat/marker/注册authority只读核查；未运行迁移、账号登录、flag写入或重启。

R1修订后再次运行同一Node VM校验，8区域、路径隔离存储、长意见分段、clipboard拒绝/缺失回退均PASS。仅更新Mermaid源码以匹配“已满足可只读留证”；遵守Lead指令未再尝试渲染。

## R2范围同步核验

Lead aa341d63裁定已同步plan、exploration、research、HTML和两个Mermaid源。2026-09-18 UTC重跑HTML静态/VM交互验证：8个section、单nonced script、路径隔离存储、storage拒绝、1800字符分段、两类clipboard fallback均pass。git diff --check通过。图仍使用已报告的本地渲染失败占位，遵照Lead不再重试；没有浏览器视觉QA证明。

## 托管发布核验（2026-09-18 UTC）

- URL: https://fw-reports-42fba7.vercel.app/r/6f025a3d6f35ac79e67b2e72a8f7d5d2/
- reportId=6f025a3d6f35ac79e67b2e72a8f7d5d2；publishOnly=true、messageId=null、delivered=false；按任务要求静默发布，无频道消息。
- 实际GET HTTP200；__CSP_NONCE__已替换；单script nonce与托管CSP匹配；script正文与提交文件逐字一致；8个评论输入；无外部资源或inline handler。
- local HTML SHA256=c207d2657c0c59b89645eb2a0653261df0ad808053d3cda54802da133b3ebaa8
- hosted HTML SHA256=7c382d564951dd5d7a281e2075d1ad4b7ec37bb5c15edf55d2bbbf584cd82f99（nonce/CSP注入造成预期差异）。
- 页面明确本单不开开关、全局仍有未知项、两处DIAGRAM PENDING LOCAL RENDER；未宣称浏览器视觉QA。
- URL与核验结果已通过指定DESIGN-HTML ready报告送Lead。
