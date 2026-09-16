# FLY-2619 Raya 汇报合同 · 设计节点验收清单 — 调研
Issue: FLY-2619 (https://linear.app/geoforge3d/issue/FLY-2619)
日期: 2026-09-15
基于: plan.md

## 设计节点验收清单

| 要求 | 设计证据 | 当前结论 |
|---|---|---|
| E-1 空轮可静默，账本完整 | plan §§1–3、6 三轮 0/3 矩阵 | 已定义，待实现/QA |
| E-2 所有可见面无统计、缺交、内部 ID、英文报错 | plan §§4–5 与污染输入验收 | 已定义，待实现/QA |
| 取消六小时主频道汇总、保留后台节奏 | research 六小时机制，Lead c8fc90fd 裁定 | 已定义，待实现/QA |
| E-4 两轮合一，负向有内容仍发 | plan §§3、6，跨 batch + 重启 | 已定义，待实现/QA |
| 历史队列与恢复不重放旧合同 | plan §5、旧身份合同取证 | 已定义，待实现/QA |
| 不做 E-3/E-5、不动生产 | 仅 engineering/doc 变更；plan §7 | 设计范围符合 |
| 合入不等于生效 | 三份文档、HTML，部署/重启与版本核对 | 已明确 |
| exploration/research/plan 正确路径与元信息 | 本文件夹三份文档 | 已提交 |
| 有效 APPROVED reviewVerdict | R3 gate 34670f50-5577-45bc-a2df-7991ac5fb1f5 / request e6df50c6-e482-4ba0-94b0-6ce36f3e2bba | 有效 APPROVED，1 LOW advisory |
| HTML 五类内容与逐段意见 | design.html；render-evidence.md | 已提交；DOM harness 通过 |
| Mermaid 本地渲染 | 两次失败记录 + flow.mmd + 显式占位 | 合同允许降级；无视觉 QA 通过声明 |
| 提交、推送、托管、Lead URL 报告 | delivery-evidence.json；Lead HTML report 4f73a2b1-4bed-45ad-a7a3-cfe7d008d3f2 | 已推送、静默发布、HTTP/CSP/nonce/源码一致性验证、URL 已报告 |
| 完成回执与 park | phase_design_complete | 尚未调用 |

这里的“已定义”只证明设计覆盖，不是功能、精确 head CI 或隔离真机验收通过。该节点不会替实施/QA 编造运行证据。

角色记忆收尾：本次复用判断已按当前记忆写入限制提交到允许的 extensions/ad_hoc/notes/2026-09-16T060100Z-raya-presentation-recovery.md，未直接改共享 role MEMORY.md（当前 81 行 / 19697 字节）。没有存入凭据。
