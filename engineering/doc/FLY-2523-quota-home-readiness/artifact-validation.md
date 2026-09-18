# FLY-2523 自动收尾与额度就绪 — 交付验证
Issue: FLY-2523 (https://linear.app/geoforge3d/issue/FLY-2523/部署-codex-额度自动切号子系统在宿主上收尾生成-readiness-receiptjsonapproved-homes-清单)
日期: 2026-09-17
基于: plan.md

设计阶段证据，仅验证文档与报告，不代表实现或生产验收。

- 两张Mermaid源：flow.mmd、model.mmd。每张首次命令与规定的标准参数重试均失败；mmdc Chromium报MachPortRendezvousServer bootstrap_check_in Permission denied(1100)。未远程渲染，HTML两处明确DIAGRAM PENDING LOCAL RENDER。
- HTML 13740 bytes，8 sections/8 comment inputs，无重复DOM id，无外部资源，无inline handler，无自带CSP meta，单一script带精确__CSP_NONCE__。
- Node VM加载最终script并运行模拟DOM验证：路径隔离localStorage key；指定汇总marker；section标题前缀；5000字符反馈生成3个<1800字符chunk，每块重复marker；clipboard promise reject和API absent均触发execCommand fallback；localStorage写入异常不阻断汇总。
- 无真实浏览器视觉QA：本机Chromium启动被沙箱系统权限拒绝，不把VM称为浏览器证据。
- hosted URL、HTTP/CSP nonce/source核验在发布后追加。
- 生产home：仅readlink/lstat/marker/注册authority只读核查；未运行迁移、账号登录、flag写入或重启。
